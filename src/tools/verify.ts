/**
 * fin_verify — 초안 텍스트의 법령·조문·행정규칙 인용 검증 (환각 방지 안전망)
 *
 * 판정은 3값이다 (조용한 실패 금지 — 실제 사고 3회의 교훈):
 *   ✓ 있음 / ✗ 없음(정상 조회 후 0건만) / ⚠ 판정불가(오류·부분매칭 — 절대 ✗로 위장하지 않음)
 * 검증범위를 정직하게 표기한다:
 *   법령 조문 = 실존 확인 / 행정규칙 = 명칭 실존만 (조문 단위 API 없음 — 자체 패치 #4)
 * 가운뎃점 5종·별칭·조응("같은 법")을 처리한다.
 */

import { z } from "zod"
import type { LawApiClient } from "../lib/api-client.js"
import { findLaws, resolvedLawMatches, INTERPUNCT_CHARS, type LawInfo } from "../lib/law-search.js"
import { resolveLawAlias } from "../lib/search-normalizer.js"
import { buildJO } from "../lib/law-parser.js"
import { toArray } from "../lib/xml-parser.js"
import { isAdminRuleName, verifyAdminRuleCitation } from "./admin-rule-citation.js"
import { SOURCE_FOOTER, truncateWithHint } from "../lib/fin-common.js"

const MAX_CITATIONS = 15
// 전체 시간 상한 — 순차 검증(15건 × 조회 2~3회)이 무한정 길어지지 않게 (Codex 리뷰).
// 초과분은 ⚠ 미검증으로 정직하게 표기한다 (조용한 실패 금지)
const VERIFY_DEADLINE_MS = 20_000

export const FinVerifyInputSchema = z.object({
  text: z.string().min(1).describe("검증할 초안 텍스트 (법령·조문·고시·예규 인용 포함)"),
  basis_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "기준일은 YYYY-MM-DD 형식이어야 합니다")
    .optional()
    .describe("기준일 (YYYY-MM-DD) — 해당 시점 시행 법령으로 검증"),
})

export const FIN_VERIFY_TOOL = {
  name: "fin_verify",
  description:
    "[재무·세무·회계 전용 — 검토서·답변 초안의 인용 검증에 이 도구를 우선 사용] " +
    "텍스트에 인용된 법령·조문·행정규칙(고시·훈령·통칙)의 실존을 법제처 DB와 대조해 " +
    "✓있음/✗없음/⚠판정불가 3값으로 반환한다. 오류를 '없음'으로 위장하지 않는다.",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "검증할 초안 텍스트" },
      basis_date: { type: "string", description: "기준일 YYYY-MM-DD (생략 시 현행)" },
    },
    required: ["text"],
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
} as const

// ── 인용 추출 ───────────────────────────────────────────────────────────
// 구조: 전 패턴을 위치와 함께 수집 → 정렬 → 단일 패스로 조응("같은 법") 해소.
// 조응 판별을 부분 문자열 test로 하면 "노동법"의 '동법'이 조응으로 오인되고(Opus B2),
// 법령명 문자 클래스에 공백이 있어 앞 문장 어절("임원 상여금은")이 흡수된다 —
// 조응은 룩비하인드 정규식으로 분리하고, 명시 법령명은 어절 컷으로 문맥을 잘라낸다.

interface Citation {
  raw: string // 원문 표기 (흡수된 선행 문맥은 제거)
  lawName: string // 조응 해석 후 법령명
  article?: string // 제N조(의M)
  kind: "법령조문" | "법령" | "행정규칙"
}

const IP = INTERPUNCT_CHARS // 가운뎃점 5종 — 추출 정규식과 정규화가 같은 집합을 봐야 한다
// 40자: "고용보험 및 산업재해보상보험의 보험료징수 등에 관한 법률" 같은 장명 법령 수용 (Codex 리뷰)
const LAW_NAME_CHARS = `[가-힣0-9${IP}\\s]`
const ARTICLE_PART = `제\\s*\\d+\\s*조(?:의\\s*\\d+)?`
const SUFFIX_PART = `((?:\\s*시행령|\\s*시행규칙)?)`
// 조응 인용 — (?<![가-힣])가 없으면 "노동법 제5조"의 '동법'이 조응으로 매칭돼
// 직전 법령의 조문으로 검증되고, 틀린 인용이 ✓를 받는다 (Opus B2).
// 시행규칙 형태("동 시행규칙", "같은 규칙")도 포함 — 시행령만 있으면 시행규칙 인용이
// 통째로 누락돼 검증 없이 넘어간다 (Codex 리뷰 중요 5)
const ANAPHOR_ARTICLE_RE = new RegExp(
  `(?<![가-힣])(같은\\s*법|동법|동\\s*시행령|같은\\s*영|동\\s*시행규칙|같은\\s*규칙)${SUFFIX_PART}\\s*(${ARTICLE_PART})`,
  "g"
)
// 명시 법령명 + 제N조(의M)
const LAW_ARTICLE_RE = new RegExp(`(${LAW_NAME_CHARS}{1,40}?(?:법률|법))${SUFFIX_PART}\\s*(${ARTICLE_PART})`, "g")
// 「…」 + 제N조 — 표준 표기. 이 결합 패턴이 없으면 「」 인용은 명칭 실존만 확인하고
// 조문 검증을 우회한다 (Opus B2: 「법인세법」 제26조가 조문 확인 없이 통과)
const QUOTED_ARTICLE_RE = new RegExp(`「([^」]{2,40})」\\s*(${ARTICLE_PART})`, "g")
// 「…」 단독 인용 (행정규칙 포함)
const QUOTED_RE = /「([^」]{2,40})」/g
// 기본통칙 인용: "법인세법 기본통칙 19-19…46" 류
const TONGCHIK_RE = new RegExp(`(${LAW_NAME_CHARS}{1,20}?법)\\s*(기본통칙|집행기준)\\s*([\\d\\-~의.]+)?`, "g")

// 어절 컷 — 이 형태로 끝나는 어절은 실제 법령명 내부에 나타나지 않으므로, 그보다
// 앞은 문맥 흡수로 보고 잘라낸다. 조사 '의/에/과/와'는 법령명 내부에 흔해
// ("산업재해보상보험의 보험료징수 등에 관한 법률") 컷 대상이 아니다.
const CUT_ENDING_RE = /(?:은|는|을|를|이며|하며|이고|하고|에서|부터|까지|로써)$/
const CUT_WORDS = new Set(["따라", "따른", "의한", "의해", "의하여", "위한", "위하여", "정한", "바와"])
// 조문 참조 어절("제26조", "제1항")도 문맥 — "「법인세법」 제26조 및 지방세법 제1조"에서
// 앞 인용의 조문이 다음 법령명("제26조 및 지방세법")에 흡수되는 것 방지
const CUT_REF_RE = /^제?\d+(?:조|항|호|목)(?:의\d+)?[.,]?$/
const ANAPHOR_WORDS = new Set(["같은법", "동법", "동시행령", "같은영"])

/** namePart에서 가장 오른쪽 종결 어절까지를 문맥으로 보고 제거 (마지막 어절 '…법'은 유지) */
function trimToLawName(namePart: string): string {
  const words = namePart.replace(/\s+/g, " ").trim().split(" ")
  for (let i = words.length - 2; i >= 0; i--) {
    if (CUT_ENDING_RE.test(words[i]) || CUT_WORDS.has(words[i]) || CUT_REF_RE.test(words[i])) {
      return words.slice(i + 1).join(" ")
    }
  }
  return words.join(" ")
}

function cleanLawName(s: string): string {
  // 선행 접속사·지시어를 반복 제거 — "및 소득세법"이 법령명으로 캡처되어
  // 조응("같은 법")까지 오염시키던 오탐 방지 (Codex 리뷰 중요 1)
  return s
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:(?:그|이|위|해당|관련|및|또는|같은|각|본|동|이하|바와)\s+)+/, "")
    .replace(/^(?:에\s*(?:따른|의한)|위한)\s+/, "")
}

function normArticle(a: string): string {
  return a.replace(/\s+/g, "")
}

interface Hit {
  idx: number
  c: Citation
  antecedent?: string // 이 인용이 조응에 남기는 본법명 (행정규칙은 갱신하지 않음)
  anaphorSuffix?: string // 조응 인용 — 단일 패스에서 선행사 + 이 접미사로 해소
}

export function extractCitations(text: string): Citation[] {
  return extractCitationsWithTotal(text).citations
}

/** 절단 전 총 발견 건수 포함 — 16번째 이후 인용이 조용히 사라지지 않게 (Opus I4) */
export function extractCitationsWithTotal(text: string): { citations: Citation[]; total: number } {
  const hits: Hit[] = []
  const articleEnds = new Set<number>() // 같은 조문 토큰의 이중 매치 방지 (명시 우선)
  const quotedStarts = new Set<number>() // 「」+조문으로 소비된 「 위치 — 단독 「」 중복 방지

  // 1) 명시 법령명 + 조문
  for (const m of text.matchAll(LAW_ARTICLE_RE)) {
    const [, namePart, suffix, article] = m
    const base = cleanLawName(trimToLawName(namePart))
    // 어절 컷 후 남은 게 조응 표현("동법")이나 외자("법")면 명시 인용이 아니다 —
    // 조응 정규식이 같은 자리를 따로 매칭한다
    if (base.length < 2 || ANAPHOR_WORDS.has(base.replace(/\s+/g, ""))) continue
    const suffixNorm = suffix ? suffix.trim() : ""
    const end = m.index! + m[0].length
    // raw는 컷으로 버린 선행 문맥을 제외해 재구성 ("임원 상여금은 부가가치세법 제1조" 방지)
    const kept = m[0].indexOf(base.split(" ")[0])
    hits.push({
      idx: m.index!,
      c: {
        raw: (kept > 0 ? m[0].slice(kept) : m[0]).trim(),
        lawName: suffixNorm ? `${base} ${suffixNorm}` : base,
        article: normArticle(article),
        kind: "법령조문",
      },
      antecedent: base,
    })
    articleEnds.add(end)
  }

  // 2) 조응 인용 — 명시 매치가 이미 차지한 조문 토큰은 건너뛴다
  for (const m of text.matchAll(ANAPHOR_ARTICLE_RE)) {
    const [, anaphorPart, suffix, article] = m
    const end = m.index! + m[0].length
    if (articleEnds.has(end)) continue
    // 조응 표현 자체가 종류를 함의하는 경우("동 시행령"→시행령, "동 시행규칙"→시행규칙)
    const impliedTier = /동\s*시행규칙|같은\s*규칙/.test(anaphorPart)
      ? "시행규칙"
      : /동\s*시행령|같은\s*영/.test(anaphorPart)
        ? "시행령"
        : ""
    const suffixNorm = suffix ? suffix.trim() : impliedTier
    hits.push({
      idx: m.index!,
      c: { raw: m[0].trim(), lawName: "", article: normArticle(article), kind: "법령조문" },
      anaphorSuffix: suffixNorm,
    })
    articleEnds.add(end)
  }

  // 3) 「…」 + 조문 (표준 표기 — 조문 검증 경로로)
  for (const m of text.matchAll(QUOTED_ARTICLE_RE)) {
    const name = cleanLawName(m[1])
    quotedStarts.add(m.index!)
    if (isAdminRuleName(name)) {
      hits.push({ idx: m.index!, c: { raw: m[0].trim(), lawName: name, article: normArticle(m[2]), kind: "행정규칙" } })
    } else if (/(법률|법|시행령|시행규칙)$/.test(name)) {
      hits.push({
        idx: m.index!,
        c: { raw: m[0].trim(), lawName: name, article: normArticle(m[2]), kind: "법령조문" },
        antecedent: name.replace(/\s*시행(?:령|규칙)$/, ""),
      })
    }
  }

  // 4) 「…」 단독 인용
  for (const m of text.matchAll(QUOTED_RE)) {
    if (quotedStarts.has(m.index!)) continue
    const name = cleanLawName(m[1])
    if (isAdminRuleName(name)) {
      hits.push({ idx: m.index!, c: { raw: m[0], lawName: name, kind: "행정규칙" } })
    } else if (/(법률|법|시행령|시행규칙)$/.test(name)) {
      hits.push({
        idx: m.index!,
        c: { raw: m[0], lawName: name, kind: "법령" },
        antecedent: name.replace(/\s*시행(?:령|규칙)$/, ""),
      })
    }
  }

  // 5) 따옴표 없는 행정규칙명 + 제N조 ("…기준 제3조" 등) — 자체 패치 #4의 접미사 확장.
  // 행정규칙은 antecedent를 남기지 않는다 — "같은 법"의 선행사가 되어
  // '판단 기준 시행령' 같은 오염이 생기던 회귀 방지
  const ADMIN_ARTICLE_RE = new RegExp(
    `([가-힣0-9${IP}\\s]{2,30}?(?:고시|훈령|예규|통칙|기준|지침))\\s*(${ARTICLE_PART})`,
    "g"
  )
  for (const m of text.matchAll(ADMIN_ARTICLE_RE)) {
    const name = cleanLawName(trimToLawName(m[1]))
    if (!isAdminRuleName(name)) continue
    hits.push({ idx: m.index!, c: { raw: m[0].trim(), lawName: name, article: normArticle(m[2]), kind: "행정규칙" } })
  }

  // 6) 기본통칙·집행기준
  for (const m of text.matchAll(TONGCHIK_RE)) {
    const name = `${cleanLawName(trimToLawName(m[1]))} ${m[2]}`
    hits.push({ idx: m.index!, c: { raw: m[0].trim(), lawName: name, kind: "행정규칙" } })
  }

  // 7) 텍스트 순서로 정렬 → 단일 패스 조응 해소 (「」 인용도 선행사가 된다)
  hits.sort((a, b) => a.idx - b.idx)
  let lastLawName = "" // 조응 선행사 — 직전에 명시된 본법명으로 제한 (선행사 오염 사고 방지)
  const out: Citation[] = []
  const seen = new Set<string>()
  for (const h of hits) {
    if (h.anaphorSuffix !== undefined) {
      if (lastLawName) {
        h.c.lawName = h.anaphorSuffix ? `${lastLawName} ${h.anaphorSuffix}` : lastLawName
      } // 선행사 없으면 lawName "" 유지 → ⚠ 판정 경로
    } else if (h.antecedent) {
      lastLawName = h.antecedent
    }
    const key = `${h.c.kind}|${h.c.lawName}|${h.c.article || ""}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(h.c)
  }
  return { citations: out.slice(0, MAX_CITATIONS), total: out.length }
}

// ── 검증 ────────────────────────────────────────────────────────────────

interface CheckResult {
  mark: "✓" | "✗" | "⚠"
  line: string
}

/**
 * 인용 법령명으로 검증 대상 법령을 찾는다. 정확 일치가 없고 이름이 여러 어절이면
 * 왼쪽 어절을 떼며 최대 2회 재시도 — 어절 컷이 못 자른 순수 명사 문맥
 * ("…를 본 뒤 소득세법")이 정상 인용을 ✗로 오판하는 것의 최후 방어선 (Opus B2).
 * 재시도가 전부 실패하면 원명 기준 결과를 돌려준다 (유사 후보 표기의 정직성).
 */
async function findVerifyTarget(
  apiClient: LawApiClient,
  lawName: string
): Promise<{ laws: LawInfo[]; best?: LawInfo; usedName: string }> {
  const firstLaws = await findLaws(apiClient, lawName, undefined, 5)
  const firstBest = firstLaws.find((l) => resolvedLawMatches(lawName, l.lawName))
  if (firstBest) return { laws: firstLaws, best: firstBest, usedName: lawName }
  let name = lawName
  for (let i = 0; i < 2; i++) {
    const words = name.split(" ")
    if (words.length < 2) break
    name = words.slice(1).join(" ")
    const laws = await findLaws(apiClient, name, undefined, 5)
    const best = laws.find((l) => resolvedLawMatches(name, l.lawName))
    if (best) return { laws, best, usedName: name }
  }
  return { laws: firstLaws, best: undefined, usedName: lawName }
}

async function verifyLawCitation(
  apiClient: LawApiClient,
  c: Citation,
  efYd?: string
): Promise<CheckResult> {
  if (!c.lawName) {
    return { mark: "⚠", line: `⚠ ${c.raw} — 조응("같은 법") 선행 법령명을 찾지 못해 판정 불가. 법령명을 명시하세요` }
  }
  let laws: LawInfo[]
  let best: LawInfo | undefined
  let usedName: string
  try {
    ;({ laws, best, usedName } = await findVerifyTarget(apiClient, c.lawName))
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { mark: "⚠", line: `⚠ ${c.raw} — 조회 실패로 판정 불가 (없음 아님): ${msg}` }
  }
  if (!best && laws.length === 0) {
    return { mark: "✗", line: `✗ ${c.raw} — 법령 「${c.lawName}」 실존하지 않음 (정상 조회 후 0건). 법령명 오기 또는 환각 의심` }
  }
  if (!best) {
    const alias = resolveLawAlias(c.lawName)
    return {
      mark: "⚠",
      line: `⚠ ${c.raw} — 정확 일치 법령 없음 (유사: ${laws.slice(0, 2).map((l) => `「${l.lawName}」`).join(", ")}${alias.canonical !== c.lawName ? ` / 별칭 해석: ${alias.canonical}` : ""}). 표기 확인 필요`,
    }
  }
  const trimNote = usedName !== c.lawName ? ` · 표기 주의: 「${c.lawName}」에서 선행 문맥을 제외한 「${usedName}」로 해석` : ""

  if (!c.article) {
    const histNote = best.status === "연혁" ? " ⚠주의: 연혁(폐지·과거본)" : ""
    return { mark: "✓", line: `✓ ${c.raw} — 법령 「${best.lawName}」 실존${histNote} · 검증범위: 명칭 실존${trimNote}` }
  }

  // 조문 실존 확인
  try {
    const extra: Record<string, string> = { MST: best.mst, JO: buildJO(c.article) }
    if (efYd) extra.efYd = efYd
    const jsonText = await apiClient.fetchApi({ endpoint: "lawService.do", target: "eflaw", type: "JSON", extraParams: extra })
    const lawData = JSON.parse(jsonText)?.법령
    const units: any[] = toArray(lawData?.조문?.조문단위)
    const article = units.find((u: any) => u.조문여부 === "조문")
    if (!article) {
      return { mark: "✗", line: `✗ ${c.raw} — 법령 「${best.lawName}」은 실존하나 ${c.article}가 없음 (정상 조회 후 0건). 조문 번호 확인` }
    }
    const title = article.조문제목 ? ` (${article.조문제목})` : ""
    const histNote = best.status === "연혁" ? " ⚠주의: 연혁(폐지·과거본) 인용" : ""
    const url = encodeURI(`https://www.law.go.kr/법령/${best.lawName}/${c.article}`)
    return { mark: "✓", line: `✓ ${c.raw} — 실존${title}${histNote} · 검증범위: 조문 실존 확인${trimNote} · ${url}` }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { mark: "⚠", line: `⚠ ${c.raw} — 조문 조회 실패로 판정 불가 (없음 아님): ${msg}` }
  }
}

export async function handleFinVerify(
  apiClient: LawApiClient,
  rawInput: unknown
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const parsed = FinVerifyInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    return {
      content: [{ type: "text", text: `[INVALID_PARAMETER] fin_verify: ${parsed.error.issues.map((i) => i.message).join("; ")}` }],
      isError: true,
    }
  }
  const { text, basis_date } = parsed.data
  const efYd = basis_date ? basis_date.replace(/-/g, "") : undefined

  const { citations, total } = extractCitationsWithTotal(text)
  if (citations.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: `[기준: ${basis_date || "현행"}] 인용 검증 — 추출된 인용 0건\n법령명+조문(예: 법인세법 제26조), 「고시명」, 기본통칙 표기가 없는 텍스트입니다. 검증 대상 표기를 확인하세요.\n\n${SOURCE_FOOTER}`,
        },
      ],
    }
  }

  // 순차 검증 (rate limit 보호 — 인용 수는 15건 상한, 전체 시간 상한 20초)
  const deadlineAt = Date.now() + VERIFY_DEADLINE_MS
  const results: CheckResult[] = []
  for (const c of citations) {
    if (Date.now() > deadlineAt) {
      results.push({
        mark: "⚠",
        line: `⚠ ${c.raw} — 전체 시간 상한(${VERIFY_DEADLINE_MS / 1000}초) 도달로 미검증 (없음 아님). 이 인용은 나눠서 재검증하세요`,
      })
      continue
    }
    if (c.kind === "행정규칙") {
      try {
        const line = await verifyAdminRuleCitation(apiClient, [c.lawName], c.raw, c.lawName)
        const mark: CheckResult["mark"] = line.startsWith("✓") ? "✓" : line.startsWith("✗") ? "✗" : "⚠"
        results.push({ mark, line })
      } catch (e) {
        results.push({ mark: "⚠", line: `⚠ ${c.raw} — 행정규칙 조회 실패로 판정 불가: ${e instanceof Error ? e.message : String(e)}` })
      }
    } else {
      results.push(await verifyLawCitation(apiClient, c, efYd))
    }
  }

  const counts = { "✓": 0, "✗": 0, "⚠": 0 }
  results.forEach((r) => counts[r.mark]++)

  const coverage =
    total > citations.length
      ? `전체 ${total}건 중 ${citations.length}건 검증 (상한 ${MAX_CITATIONS}건 — 나머지 ${total - citations.length}건은 텍스트를 나눠 재검증하세요)`
      : `${citations.length}건`
  let out = `[기준: ${basis_date || "현행"}] 인용 검증 — ${coverage}: ✓${counts["✓"]} / ✗${counts["✗"]} / ⚠${counts["⚠"]}\n`
  if (counts["✗"] > 0) out += `⚠️ ✗ 항목은 초안에서 제거·수정 전까지 사용 금지\n`
  if (counts["⚠"] > 0) out += `※ ⚠는 "없음"이 아니라 확인 실패입니다 — 재시도하거나 원문으로 확인하세요\n`
  out += "\n" + results.map((r) => r.line).join("\n")
  out += `\n\n${SOURCE_FOOTER}`

  return { content: [{ type: "text", text: truncateWithHint(out, 8000, "인용을 나눠 재검증") }] }
}
