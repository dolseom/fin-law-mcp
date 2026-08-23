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

interface Citation {
  raw: string // 원문 표기
  lawName: string // 조응 해석 후 법령명
  article?: string // 제N조(의M)
  kind: "법령조문" | "법령" | "행정규칙"
}

const IP = INTERPUNCT_CHARS // 가운뎃점 5종 — 추출 정규식과 정규화가 같은 집합을 봐야 한다
const LAW_NAME_CHARS = `[가-힣0-9${IP}\\s]`
// "…법/…법률/…법 시행령/…법 시행규칙" + 제N조(의M)
const LAW_ARTICLE_RE = new RegExp(
  `(같은\\s*법|동법|동\\s*시행령|같은\\s*영|${LAW_NAME_CHARS}{1,30}?(?:법률|법))((?:\\s*시행령|\\s*시행규칙)?)\\s*(제\\s*\\d+\\s*조(?:의\\s*\\d+)?)`,
  "g"
)
// 「…」 인용 (행정규칙 포함)
const QUOTED_RE = /「([^」]{2,40})」/g
// 기본통칙 인용: "법인세법 기본통칙 19-19…46" 류
const TONGCHIK_RE = new RegExp(`(${LAW_NAME_CHARS}{1,20}?법)\\s*(기본통칙|집행기준)\\s*([\\d\\-~의.]+)?`, "g")

function cleanLawName(s: string): string {
  return s.replace(/\s+/g, " ").trim().replace(/^(그|이|위|해당|관련)\s+/, "")
}

export function extractCitations(text: string): Citation[] {
  const out: Citation[] = []
  const seen = new Set<string>()
  let lastLawName = "" // 조응 선행사 — 직전에 명시된 법령명으로 제한 (선행사 오염 사고 방지)

  // 순서 보존을 위해 위치 기반 수집
  const found: Array<{ idx: number; c: Citation }> = []

  for (const m of text.matchAll(LAW_ARTICLE_RE)) {
    const [raw, namePart, suffix, article] = m
    let lawName: string
    if (/같은\s*법|동법/.test(namePart)) {
      lawName = lastLawName ? lastLawName + (suffix || "").trim().replace(/^/, suffix ? " " : "") : ""
      if (lawName && suffix) lawName = `${lastLawName} ${suffix.trim()}`
      if (!lawName) {
        found.push({ idx: m.index!, c: { raw: raw.trim(), lawName: "", article: article.replace(/\s+/g, ""), kind: "법령조문" } })
        continue
      }
    } else if (/동\s*시행령|같은\s*영/.test(namePart)) {
      lawName = lastLawName ? `${lastLawName} 시행령` : ""
      if (!lawName) {
        found.push({ idx: m.index!, c: { raw: raw.trim(), lawName: "", article: article.replace(/\s+/g, ""), kind: "법령조문" } })
        continue
      }
    } else {
      const base = cleanLawName(namePart)
      lawName = suffix ? `${base} ${suffix.trim()}` : base
      lastLawName = base // 선행사는 본법 이름으로 갱신
    }
    found.push({
      idx: m.index!,
      c: { raw: raw.trim(), lawName: cleanLawName(lawName), article: article.replace(/\s+/g, ""), kind: "법령조문" },
    })
  }

  for (const m of text.matchAll(QUOTED_RE)) {
    const name = cleanLawName(m[1])
    if (isAdminRuleName(name)) {
      found.push({ idx: m.index!, c: { raw: m[0], lawName: name, kind: "행정규칙" } })
    } else if (/(법률|법|시행령|시행규칙)$/.test(name)) {
      // 조문 없는 법령 단독 인용은 위 LAW_ARTICLE_RE에 안 잡힌 경우만
      found.push({ idx: m.index!, c: { raw: m[0], lawName: name, kind: "법령" } })
    }
  }

  // 따옴표 없는 행정규칙명 + 제N조 ("…기준 제3조" 등) — 자체 패치 #4의 접미사 확장.
  // 이 캡처는 lastLawName(조응 선행사)을 갱신하지 않는다 — 행정규칙이 "같은 법"의
  // 선행사가 되어 '판단 기준 시행령' 같은 오염이 생기던 회귀 방지
  const ADMIN_ARTICLE_RE = new RegExp(
    `([가-힣0-9${IP}\\s]{2,30}?(?:고시|훈령|예규|통칙|기준|지침))\\s*(제\\s*\\d+\\s*조(?:의\\s*\\d+)?)`,
    "g"
  )
  for (const m of text.matchAll(ADMIN_ARTICLE_RE)) {
    const name = cleanLawName(m[1])
    if (!isAdminRuleName(name)) continue
    found.push({
      idx: m.index!,
      c: { raw: m[0].trim(), lawName: name, article: m[2].replace(/\s+/g, ""), kind: "행정규칙" },
    })
  }

  for (const m of text.matchAll(TONGCHIK_RE)) {
    const name = `${cleanLawName(m[1])} ${m[2]}`
    found.push({ idx: m.index!, c: { raw: m[0].trim(), lawName: name, kind: "행정규칙" } })
  }

  found.sort((a, b) => a.idx - b.idx)
  for (const { c } of found) {
    const key = `${c.kind}|${c.lawName}|${c.article || ""}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(c)
  }
  return out.slice(0, MAX_CITATIONS)
}

// ── 검증 ────────────────────────────────────────────────────────────────

interface CheckResult {
  mark: "✓" | "✗" | "⚠"
  line: string
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
  try {
    laws = await findLaws(apiClient, c.lawName, undefined, 5)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { mark: "⚠", line: `⚠ ${c.raw} — 조회 실패로 판정 불가 (없음 아님): ${msg}` }
  }
  if (laws.length === 0) {
    return { mark: "✗", line: `✗ ${c.raw} — 법령 「${c.lawName}」 실존하지 않음 (정상 조회 후 0건). 법령명 오기 또는 환각 의심` }
  }
  const best = laws.find((l) => resolvedLawMatches(c.lawName, l.lawName))
  if (!best) {
    const alias = resolveLawAlias(c.lawName)
    return {
      mark: "⚠",
      line: `⚠ ${c.raw} — 정확 일치 법령 없음 (유사: ${laws.slice(0, 2).map((l) => `「${l.lawName}」`).join(", ")}${alias.canonical !== c.lawName ? ` / 별칭 해석: ${alias.canonical}` : ""}). 표기 확인 필요`,
    }
  }

  if (!c.article) {
    const histNote = best.status === "연혁" ? " ⚠주의: 연혁(폐지·과거본)" : ""
    return { mark: "✓", line: `✓ ${c.raw} — 법령 「${best.lawName}」 실존${histNote} · 검증범위: 명칭 실존` }
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
    return { mark: "✓", line: `✓ ${c.raw} — 실존${title}${histNote} · 검증범위: 조문 실존 확인 · ${url}` }
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

  const citations = extractCitations(text)
  if (citations.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: `[기준: ${basis_date || "현행"}] 인용 검증 — 추출된 인용 0건\n법령명+조문(예: 법인세법 제26조), 「고시명」, 기본통칙 표기가 없는 텍스트입니다. 검증 대상 표기를 확인하세요.`,
        },
      ],
    }
  }

  // 순차 검증 (rate limit 보호 — 인용 수는 15건 상한)
  const results: CheckResult[] = []
  for (const c of citations) {
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

  let out = `[기준: ${basis_date || "현행"}] 인용 검증 — ${citations.length}건: ✓${counts["✓"]} / ✗${counts["✗"]} / ⚠${counts["⚠"]}\n`
  if (counts["✗"] > 0) out += `⚠️ ✗ 항목은 초안에서 제거·수정 전까지 사용 금지\n`
  if (counts["⚠"] > 0) out += `※ ⚠는 "없음"이 아니라 확인 실패입니다 — 재시도하거나 원문으로 확인하세요\n`
  out += "\n" + results.map((r) => r.line).join("\n")
  out += `\n\n${SOURCE_FOOTER}`

  return { content: [{ type: "text", text: truncateWithHint(out, 8000, "인용을 나눠 재검증") }] }
}
