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
import { findLaws, findRepealedLaw, resolvedLawMatches, INTERPUNCT_CHARS, type LawInfo } from "../lib/law-search.js"
import { resolveLawAlias, LAW_ALIAS_CANONICALS } from "../lib/search-normalizer.js"
import { buildJO } from "../lib/law-parser.js"
import { toArray } from "../lib/xml-parser.js"
import { isAdminRuleName, isAdminRuleLikeName, verifyAdminRuleCitation, tryVerifyAdminRuleCitation } from "./admin-rule-citation.js"
import { SOURCE_FOOTER, truncateWithHint, FIN_LAW_NAMES } from "../lib/fin-common.js"
import { resolveVersionAt } from "../lib/historical-utils.js"

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
  /** 어절 컷으로 잘라내기 전의 이름 — 컷이 정식 법령명을 잘랐을 때의 복구·고지용 */
  uncut?: string
  /** "구 ○○법" 연혁 인용 — 현행 기준으로 판정하면 개정 전 조문에 ✓가 찍힌다 */
  historical?: boolean
  /**
   * 따옴표 없는 「…규정」·「…규칙」 — 사내 규정·사규일 수 있어 미발견 시 ✗가 아닌 ⚠.
   * ("당사 취업규칙 제12조"는 정당한 인용이지 환각이 아니다)
   */
  soft?: boolean
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
// "같은 규정"·"동 규정"이 빠져 있으면 규정·규칙 추출 확장과 만나 최악의 조합이 된다:
// "외국환거래규정 제23조와 같은 규정 제24조"에서 "와 같은 규정"이 **법령명으로** 캡처되어
// lawName이 "규정"이 되고, 법제처 LIKE 검색에 무관한 법령이 걸려 ✓가 나갈 수 있다 (실측)
const ANAPHOR_ARTICLE_RE = new RegExp(
  `(?<![가-힣])(같은\\s*법|동법|동\\s*시행령|같은\\s*영|동\\s*시행규칙|같은\\s*규칙|같은\\s*규정|동\\s*규정)${SUFFIX_PART}\\s*(${ARTICLE_PART})`,
  "g"
)
// 명시 법령명 + 제N조(의M)
const LAW_ARTICLE_RE = new RegExp(`(${LAW_NAME_CHARS}{1,40}?(?:법률|법))${SUFFIX_PART}\\s*(${ARTICLE_PART})`, "g")
// 「…」 + 제N조 — 표준 표기. 이 결합 패턴이 없으면 「」 인용은 명칭 실존만 확인하고
// 조문 검증을 우회한다 (Opus B2: 「법인세법」 제26조가 조문 확인 없이 통과)
const QUOTED_ARTICLE_RE = new RegExp(`「([^」]{2,40})」\\s*(${ARTICLE_PART})`, "g")
// 「」 인용에서 법령으로 받아들일 접미사. 「산업안전보건기준에 관한 규칙」처럼 본법이
// 아닌 '규칙·규정'류가 빠져 있으면 그 인용이 통째로 사라지고, 뒤따르는 "같은 규칙"이
// 두 칸 앞 본법을 선행사로 삼아 엉뚱한 시행규칙에 ✓를 준다 (Opus B-0)
const LAW_LIKE_SUFFIX_RE = /(법률|법|시행령|시행규칙|규칙|규정)$/
// 「…」 단독 인용 (행정규칙 포함)
const QUOTED_RE = /「([^」]{2,40})」/g
// 기본통칙 인용: "법인세법 기본통칙 19-19…46" 류
const TONGCHIK_RE = new RegExp(`(${LAW_NAME_CHARS}{1,20}?법)\\s*(기본통칙|집행기준)\\s*([\\d\\-~의.]+)?`, "g")

// 어절 컷 — 이 형태로 끝나는 어절은 실제 법령명 내부에 나타나지 않으므로, 그보다
// 앞은 문맥 흡수로 보고 잘라낸다. 조사 '의/에/과/와'는 법령명 내부에 흔해
// ("산업재해보상보험의 보험료징수 등에 관한 법률") 컷 대상이 아니다.
const CUT_ENDING_RE = /(?:은|는|을|를|이며|하며|이고|하고|에서|부터|까지|로써)$/
// 단독 어절 "와"·"과"는 앞 인용이 "제99조와"처럼 조사를 남기고 끝났을 때의 고아 조사다 —
// 법령명 내부의 단독 접속은 "및"뿐이므로 컷해도 정식 명칭이 잘리지 않는다 (Opus B-3 재검증).
// "및"은 넣으면 안 된다 ("고용보험 및 산업재해보상보험의 …"이 잘린다)
const CUT_WORDS = new Set(["따라", "따른", "의한", "의해", "의하여", "위한", "위하여", "정한", "바와", "와", "과"])
// 조문 참조 어절("제26조", "제1항")도 문맥 — "「법인세법」 제26조 및 지방세법 제1조"에서
// 앞 인용의 조문이 다음 법령명("제26조 및 지방세법")에 흡수되는 것 방지
const CUT_REF_RE = /^제?\d+(?:조|항|호|목)(?:의\d+)?[.,]?$/
const ANAPHOR_WORDS = new Set(["같은법", "동법", "동시행령", "같은영", "동시행규칙", "같은규칙", "같은규정", "동규정"])

/**
 * 미등재 약칭으로 보이는가 — 짧고 법/령/규칙으로 끝나는 형태("조특법", "근퇴법").
 * 이런 이름에 검색 0건이 나오면 부존재가 아니라 별칭 사전의 공백일 가능성이 높다.
 * 정식 명칭 형태(공백 포함·장문)는 대상이 아니다 — 그건 진짜 0건일 수 있다.
 */
function looksLikeAbbreviation(name: string): boolean {
  const n = name.replace(/\s+/g, "")
  return n.length <= 6 && /(법|령|규칙)$/.test(n) && !/시행(령|규칙)$/.test(n)
}

/**
 * 「…규칙」·「…규정」처럼 그 자체가 규칙·규정류인 이름인가 (본법·시행규칙과 구분).
 * 이런 이름은 "같은 법"의 선행사가 아니고, 법령 DB 0건이어도 행정규칙(고시·훈령)일 수 있다.
 */
function isRuleLikeName(name: string): boolean {
  const n = name.replace(/\s+/g, "")
  return /(규칙|규정)$/.test(n) && !/시행규칙$/.test(n)
}

/**
 * "같은 규칙"의 선행사가 될 수 있는 이름 — 규칙만. 규정을 포함하면
 * 「…규칙」과 「…규정」이 섞인 문장에서 "같은 규칙"이 규정 쪽으로 해소된다 (Opus B-0③ 재검증)
 */
function isRuleAntecedentName(name: string): boolean {
  const n = name.replace(/\s+/g, "")
  return /규칙$/.test(n) && !/시행규칙$/.test(n)
}

/**
 * "같은 규정"의 선행사가 될 수 있는 이름 — 규정류만 (규칙과 별도 추적).
 */
function isRegAntecedentName(name: string): boolean {
  return /규정$/.test(name.replace(/\s+/g, ""))
}

// 알려진 정식 법령명 — 어절 컷보다 **먼저** 최장 일치를 시도한다.
// "국가를 당사자로 하는 계약에 관한 법률"의 '하는'이 컷 규칙(는$)에 걸려
// "계약에 관한 법률"로 잘리던 문제 방지 (Opus B-3). 재무 사전 + 별칭 canonical 합집합.
const KNOWN_LAW_NAMES: string[] = (() => {
  const set = new Set<string>(FIN_LAW_NAMES)
  for (const n of LAW_ALIAS_CANONICALS) set.add(n)
  // 긴 이름부터 매칭해야 부분 일치에 먼저 걸리지 않는다
  return [...set].sort((a, b) => b.length - a.length)
})()
const compact = (s: string) => s.replace(/\s+/g, "")

/**
 * normalized(공백 정규화됨)에서 앞쪽 비공백 문자 skip개를 지난 지점이
 * 어절 시작(문두 또는 공백 바로 뒤)인가 — 압축 비교로 잃은 어절 경계를 원문에서 복원
 */
function startsAtWordBoundary(normalized: string, skip: number): boolean {
  if (skip === 0) return true
  let count = 0
  for (let i = 0; i < normalized.length; i++) {
    if (normalized[i] === " ") continue
    if (count === skip) return normalized[i - 1] === " "
    count++
  }
  return false
}

/**
 * namePart에서 법령명만 남긴다.
 * ① 알려진 정식 법령명이 끝에 붙어 있으면 그대로 사용 (어절 컷보다 우선)
 * ② 없으면 가장 오른쪽 종결 어절까지를 문맥으로 보고 제거
 */
function trimToLawName(namePart: string): string {
  const normalized = namePart.replace(/\s+/g, " ").trim()
  const c = compact(normalized)
  for (const known of KNOWN_LAW_NAMES) {
    const ck = compact(known)
    // 공백 표기 흔들림을 흡수해 비교하되, 반환은 공식 표기로 통일한다.
    // 압축 꼬리 일치만으로는 부족하다 — "국가배상법"의 꼬리가 「상법」과 일치해
    // 전혀 다른 법의 조문에 경고 없는 ✓가 나간다 ("난민법"→민법, "군형법"→형법도 동일).
    // 사전명이 어절 경계에서 시작할 때만 인정한다 (Opus B-3 재검증 차단)
    if (c.endsWith(ck) && startsAtWordBoundary(normalized, c.length - ck.length)) return known
  }
  const words = normalized.split(" ")
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
  ruleAntecedent?: string // "같은 규칙"이 가리킬 규칙류 선행사 (「…에 관한 규칙」 등)
  regAntecedent?: string // "같은 규정"이 가리킬 규정류 선행사 (「외국환거래규정」 등)
  softAntecedent?: boolean // 선행사가 soft(사내 문서 가능)였는가 — 조응도 같은 취급을 받아야 한다
  anaphorSuffix?: string // 조응 인용 — 단일 패스에서 선행사 + 이 접미사로 해소
  anaphorKind?: "법" | "영" | "규칙" | "규정" // 조응이 요구하는 대상 종류
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
    const uncutBase = cleanLawName(namePart)
    const base = cleanLawName(trimToLawName(namePart))
    // 어절 컷 후 남은 게 조응 표현("동법")이나 외자("법")면 명시 인용이 아니다 —
    // 조응 정규식이 같은 자리를 따로 매칭한다
    if (base.length < 2 || ANAPHOR_WORDS.has(base.replace(/\s+/g, ""))) continue
    const suffixNorm = suffix ? suffix.trim() : ""
    const end = m.index! + m[0].length
    // raw는 컷으로 버린 선행 문맥을 제외해 재구성 ("임원 상여금은 부가가치세법 제1조" 방지).
    // lastIndexOf로 컷 지점을 잡는다 — indexOf는 같은 법령명이 앞에도 나오면 엉뚱한
    // 위치를 집어 raw에 문맥이 남는다 ("소득세법에 따라 소득세법 제12조", Opus 개선)
    const kept = m[0].lastIndexOf(base.split(" ")[0])
    let raw = (kept > 0 ? m[0].slice(kept) : m[0]).trim()
    // "구 법인세법" — 연혁 인용 표지. 문맥 컷이 "구"를 지우면 어떤 인용이 검증됐는지
    // 사용자가 알 수 없고, 개정 전 조문을 가리킨 인용에 현행 ✓가 찍힌다 (Opus 리뷰 중요 2)
    let historical = false
    if (kept > 0 && /(?:^|[\s.,;·(])구\s+$/.test(m[0].slice(0, kept))) {
      raw = `구 ${raw}`
      historical = true
    }
    hits.push({
      idx: m.index!,
      c: {
        raw,
        lawName: suffixNorm ? `${base} ${suffixNorm}` : base,
        article: normArticle(article),
        kind: "법령조문",
        ...(compact(uncutBase) !== compact(base) ? { uncut: suffixNorm ? `${uncutBase} ${suffixNorm}` : uncutBase } : {}),
        ...(historical ? { historical: true } : {}),
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
    // 조응 표현이 함의하는 종류.
    // "동 시행규칙"은 "동(같은) 법의 시행규칙"이라 본법 선행사 + 시행규칙이지만,
    // "같은 규칙"은 직전에 인용된 **규칙 그 자체**를 가리킨다 — 이를 구분하지 않으면
    // 「산업안전보건기준에 관한 규칙」 뒤의 "같은 규칙"이 본법의 시행규칙으로
    // 해소되어 전혀 다른 법령에 ✓가 나간다 (Opus B-0)
    const isRuleAnaphor = /같은\s*규칙/.test(anaphorPart)
    // "같은 규정"은 직전에 인용된 **규정 그 자체**를 가리킨다. 규칙과 한 종류로 묶으면
    // 「…규칙」과 「…규정」이 섞인 문장에서 서로의 선행사를 가져간다 (Opus B-0③과 같은 함정)
    const isRegAnaphor = /같은\s*규정|동\s*규정/.test(anaphorPart)
    const impliedTier = /동\s*시행규칙/.test(anaphorPart)
      ? "시행규칙"
      : /동\s*시행령|같은\s*영/.test(anaphorPart)
        ? "시행령"
        : ""
    const suffixNorm = suffix ? suffix.trim() : impliedTier
    hits.push({
      idx: m.index!,
      c: { raw: m[0].trim(), lawName: "", article: normArticle(article), kind: "법령조문" },
      anaphorSuffix: suffixNorm,
      anaphorKind: isRegAnaphor ? "규정" : isRuleAnaphor ? "규칙" : suffixNorm === "시행령" ? "영" : "법",
    })
    articleEnds.add(end)
  }

  // 3) 「…」 + 조문 (표준 표기 — 조문 검증 경로로)
  for (const m of text.matchAll(QUOTED_ARTICLE_RE)) {
    const name = cleanLawName(m[1])
    quotedStarts.add(m.index!)
    if (isAdminRuleName(name)) {
      // 고시·훈령류는 본법 선행사가 되지 않지만, "같은 규칙"의 대상도 아니다
      hits.push({ idx: m.index!, c: { raw: m[0].trim(), lawName: name, article: normArticle(m[2]), kind: "행정규칙" } })
    } else if (LAW_LIKE_SUFFIX_RE.test(name)) {
      hits.push({
        idx: m.index!,
        c: { raw: m[0].trim(), lawName: name, article: normArticle(m[2]), kind: "법령조문" },
        // 「…에 관한 규칙」은 본법이 아니므로 "같은 법"의 선행사가 되면 안 된다.
        // 대신 "같은 규칙"의 선행사가 된다. 「…규정」은 어느 쪽 선행사도 아니다
        ...(isRuleLikeName(name)
          ? isRuleAntecedentName(name)
            ? { ruleAntecedent: name }
            : isRegAntecedentName(name)
              ? { regAntecedent: name }
              : {}
          : { antecedent: name.replace(/\s*시행(?:령|규칙)$/, "") }),
      })
    }
  }

  // 4) 「…」 단독 인용
  for (const m of text.matchAll(QUOTED_RE)) {
    if (quotedStarts.has(m.index!)) continue
    const name = cleanLawName(m[1])
    if (isAdminRuleName(name)) {
      hits.push({ idx: m.index!, c: { raw: m[0], lawName: name, kind: "행정규칙" } })
    } else if (LAW_LIKE_SUFFIX_RE.test(name)) {
      hits.push({
        idx: m.index!,
        c: { raw: m[0], lawName: name, kind: "법령" },
        ...(isRuleLikeName(name)
          ? isRuleAntecedentName(name)
            ? { ruleAntecedent: name }
            : isRegAntecedentName(name)
              ? { regAntecedent: name }
              : {}
          : { antecedent: name.replace(/\s*시행(?:령|규칙)$/, "") }),
      })
    }
  }

  // 5) 따옴표 없는 행정규칙명 + 제N조 ("…기준 제3조" 등) — 자체 패치 #4의 접미사 확장.
  // 행정규칙은 antecedent를 남기지 않는다 — "같은 법"의 선행사가 되어
  // '판단 기준 시행령' 같은 오염이 생기던 회귀 방지
  // 접미사에 규정·규칙을 포함한다: 「」 없이 쓴 "외국환거래규정 제23조"가 추출조차
  // 되지 않아 **환각 인용("탄소배출권거래규정 제77조")까지 0건으로 조용히 통과**하고
  // 있었다 (Codex 리뷰 중요 6, 실측). 「」 인용 경로(3번)는 이미 규정·규칙을 받는다
  const ADMIN_ARTICLE_RE = new RegExp(
    `([가-힣0-9${IP}\\s]{2,30}?(?:고시|훈령|예규|통칙|기준|지침|규정|규칙))\\s*(${ARTICLE_PART})`,
    "g"
  )
  for (const m of text.matchAll(ADMIN_ARTICLE_RE)) {
    const name = cleanLawName(trimToLawName(m[1]))
    const end = m.index! + m[0].length
    // 「」 인용과 일반 법령 경로가 이미 가져간 조문 토큰은 건너뛴다
    // ("법인세법 시행규칙 제15조"는 1번이 처리한다 — 여기서 또 잡으면 행정규칙으로
    //  판정되어 부령 조문이 "명칭만 확인"으로 강등된다)
    if (articleEnds.has(end)) continue
    if (isAdminRuleName(name)) {
      // 고시·훈령류: 행정규칙 전용 경로 (명칭 실존만 검증)
      hits.push({ idx: m.index!, c: { raw: m[0].trim(), lawName: name, article: normArticle(m[2]), kind: "행정규칙" } })
      articleEnds.add(end)
      continue
    }
    // 「…규정」·「…규칙」은 부령(법령 DB)일 수도, 고시·훈령일 수도 있다 —
    // 법령조문 경로로 보내면 법령 DB → 행정규칙 폴백 → 폐지 확인 순서가 이미 배선돼 있다.
    // 시행규칙은 isAdminRuleLikeName이 걸러 1번 경로에 맡긴다
    if (!isAdminRuleLikeName(name)) continue
    hits.push({
      idx: m.index!,
      // 따옴표 없는 규정·규칙은 사내 문서일 수 있다 — "당사 취업규칙 제12조",
      // "내부 회계처리 규칙 제3조"는 정당한 인용인데 법령 DB에는 당연히 없다.
      // 이런 이름에 ✗("환각 의심")를 찍으면 실무자의 정상 문서를 거짓말로 낙인찍는다.
      // 미발견 시 ⚠로 강등한다 — 조용히 통과시키지도, 없다고 단정하지도 않는다
      // (SOFT_ADMIN_SUFFIX의 '기준·지침'과 같은 취급). 「」로 감싼 인용은 법령을
      // 의도한 것이 명확하므로 종전대로 ✗ 판정을 유지한다
      c: { raw: m[0].trim(), lawName: name, article: normArticle(m[2]), kind: "법령조문", soft: true },
      ...(isRuleAntecedentName(name)
        ? { ruleAntecedent: name }
        : isRegAntecedentName(name)
          ? { regAntecedent: name }
          : {}),
    })
    articleEnds.add(end)
  }

  // 6) 기본통칙·집행기준
  for (const m of text.matchAll(TONGCHIK_RE)) {
    const name = `${cleanLawName(trimToLawName(m[1]))} ${m[2]}`
    hits.push({ idx: m.index!, c: { raw: m[0].trim(), lawName: name, kind: "행정규칙" } })
  }

  // 7) 텍스트 순서로 정렬 → 단일 패스 조응 해소 (「」 인용도 선행사가 된다)
  hits.sort((a, b) => a.idx - b.idx)
  let lastLawName = "" // 조응 선행사 — 직전에 명시된 본법명으로 제한 (선행사 오염 사고 방지)
  let lastRuleName = "" // "같은 규칙"의 선행사 — 「…에 관한 규칙」류 (본법과 별도로 추적)
  let lastRegName = "" // "같은 규정"의 선행사 — 「…규정」류 (규칙과도 별도로 추적)
  // 선행사가 soft(사내 문서일 수 있는 따옴표 없는 규정·규칙)였는지 함께 기억한다.
  // 이게 없으면 "내부 관리규정 제5조와 같은 규정 제6조"에서 앞은 ⚠인데 뒤만 ✗가 된다 —
  // 같은 문서를 가리키는 연쇄 인용의 절반만 환각으로 낙인찍히는 셈 (Codex 2차 중요)
  let lastRuleSoft = false
  let lastRegSoft = false
  const out: Citation[] = []
  const seen = new Set<string>()
  for (const h of hits) {
    if (h.anaphorSuffix !== undefined) {
      if (h.anaphorKind === "규칙") {
        // "같은 규칙"은 직전에 인용된 규칙 자체를 가리킨다. 규칙 선행사가 없으면
        // 본법으로 넘겨짚지 않고 ⚠로 보낸다 — 넘겨짚으면 틀린 법령에 ✓가 된다
        if (lastRuleName) {
          h.c.lawName = lastRuleName
          if (lastRuleSoft) h.c.soft = true
        }
      } else if (h.anaphorKind === "규정") {
        // "같은 규정"도 마찬가지 — 규정 선행사가 없으면 비워 ⚠ 경로로 보낸다
        if (lastRegName) {
          h.c.lawName = lastRegName
          if (lastRegSoft) h.c.soft = true
        }
      } else if (lastLawName) {
        h.c.lawName = h.anaphorSuffix ? `${lastLawName} ${h.anaphorSuffix}` : lastLawName
      } // 선행사 없으면 lawName "" 유지 → ⚠ 판정 경로
    } else {
      if (h.antecedent) lastLawName = h.antecedent
      if (h.ruleAntecedent) {
        lastRuleName = h.ruleAntecedent
        lastRuleSoft = !!h.c.soft
      }
      if (h.regAntecedent) {
        lastRegName = h.regAntecedent
        lastRegSoft = !!h.c.soft
      }
    }
    // dedup 키에 위치를 포함한다 — 서로 다른 법의 인용이 같은 lawName으로 절단됐을 때
    // 한 건이 조용히 증발하던 문제 방지 (Opus B-3②)
    const key = `${h.c.kind}|${h.c.lawName}|${h.c.article || ""}|${h.c.raw}`
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
  /** 미확인 약칭 — 정식 명칭 재검증 전까지 사용 보류를 요약 헤더로 띄운다 */
  hold?: boolean
}

/**
 * 인용 법령명으로 검증 대상 법령을 찾는다. 정확 일치가 없고 이름이 여러 어절이면
 * 왼쪽 어절을 떼며 최대 2회 재시도 — 어절 컷이 못 자른 순수 명사 문맥
 * ("…를 본 뒤 소득세법")이 정상 인용을 ✗로 오판하는 것의 최후 방어선 (Opus B2).
 * 재시도가 전부 실패하면 원명 기준 결과를 돌려준다 (유사 후보 표기의 정직성).
 */
async function findVerifyTarget(
  apiClient: LawApiClient,
  lawName: string,
  signal?: AbortSignal,
  uncut?: string
): Promise<{ laws: LawInfo[]; best?: LawInfo; usedName: string }> {
  const firstLaws = await findLaws(apiClient, lawName, undefined, 5, 100, signal)
  const firstBest = firstLaws.find((l) => resolvedLawMatches(lawName, l.lawName))
  if (firstBest) return { laws: firstLaws, best: firstBest, usedName: lawName }

  // 어절 컷이 정식 법령명을 잘랐을 수 있다 — 컷 전 이름으로 먼저 확인한다
  // ("국가를 당사자로 하는 계약에 관한 법률"의 '하는'이 컷되던 문제, Opus B-3)
  if (uncut && uncut !== lawName && !signal?.aborted) {
    const laws = await findLaws(apiClient, uncut, undefined, 5, 100, signal)
    const best = laws.find((l) => resolvedLawMatches(uncut, l.lawName))
    if (best) return { laws, best, usedName: uncut }
  }

  let name = lawName
  for (let i = 0; i < 2; i++) {
    if (signal?.aborted) break // 시간 상한 도달 — 어절 제거 재시도를 더 돌지 않는다
    const words = name.split(" ")
    if (words.length < 2) break
    // 재시도 이름에도 선행 접속사 제거를 적용한다 — 없으면 "및 법인세법"이 되어
    // 한 번 더 실패한다 (Opus I-a)
    name = cleanLawName(words.slice(1).join(" "))
    if (!name) break
    const laws = await findLaws(apiClient, name, undefined, 5, 100, signal)
    const best = laws.find((l) => resolvedLawMatches(name, l.lawName))
    if (best) return { laws, best, usedName: name }
  }
  return { laws: firstLaws, best: undefined, usedName: lawName }
}

async function verifyLawCitation(
  apiClient: LawApiClient,
  c: Citation,
  efYd?: string,
  signal?: AbortSignal
): Promise<CheckResult> {
  if (!c.lawName) {
    return { mark: "⚠", line: `⚠ ${c.raw} — 조응("같은 법") 선행 법령명을 찾지 못해 판정 불가. 법령명을 명시하세요` }
  }
  let laws: LawInfo[]
  let best: LawInfo | undefined
  let usedName: string
  try {
    ;({ laws, best, usedName } = await findVerifyTarget(apiClient, c.lawName, signal, c.uncut))
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { mark: "⚠", line: `⚠ ${c.raw} — 조회 실패로 판정 불가 (없음 아님): ${msg}` }
  }
  if (!best && laws.length === 0) {
    // 「…규정」·「…규칙」은 법령(대통령령·부령)일 수도, 행정규칙(고시·훈령)일 수도 있다.
    // 법령 DB 0건만으로 ✗를 찍으면 「외국환거래규정」(기재부 고시)·「조사사무처리규정」
    // (국세청 훈령) 같은 실존 문서에 '환각 의심' 낙인이 찍힌다 — 행정규칙 DB를
    // 확인한 뒤 판정한다 (Opus B-0① 재검증)
    let adminChecked = false
    if (isRuleLikeName(c.lawName)) {
      if (signal?.aborted) {
        return { mark: "⚠", line: `⚠ ${c.raw} — 법령 DB 0건, 시간 상한 도달로 행정규칙 DB 미확인 — 판정 불가 (없음 아님)` }
      }
      try {
        const adminHit = await tryVerifyAdminRuleCitation(apiClient, [c.lawName], c.raw, undefined, signal)
        if (adminHit) {
          // 접두 일치는 tryVerify가 "⚠"로 시작하는 문구를 준다 — ✓로 승격하지 않는다
          const exactHit = adminHit.startsWith("✓")
          // 조문이 붙어 있으면 명칭만 확인된 상태 — ✓ 집계 금지 (Opus 리뷰 중요 1)
          if (c.article) {
            return {
              mark: "⚠",
              line: exactHit
                ? `⚠${adminHit.slice(1)} · ${c.article}의 존재는 미확인(행정규칙 조문 단위 API 없음) — 원문 확인 필요`
                : `${adminHit} · ${c.article}도 미확인`,
            }
          }
          return exactHit ? { mark: "✓", line: adminHit } : { mark: "⚠", line: adminHit }
        }
        adminChecked = true
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return { mark: "⚠", line: `⚠ ${c.raw} — 법령 DB 0건, 행정규칙 DB 조회 실패로 판정 불가 (없음 아님): ${msg}` }
      }
    }
    // 폐지·연혁 확인 — 현행 0건이 '지어낸 법령'인지 '폐지된 법령'인지 가른다.
    // findRepealedLaw는 이 용도로 만들어졌으나 배선이 안 돼 있었다 (Opus 재검증 개선)
    let histChecked = false
    if (!signal?.aborted) {
      const { law: repealed, lookupFailed, reason } = await findRepealedLaw(apiClient, c.lawName, undefined, signal)
      if (repealed) {
        const ef = repealed.effectiveDate
          ? `(마지막 시행 ${repealed.effectiveDate.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3")})`
          : ""
        return {
          mark: "⚠",
          line: `⚠ ${c.raw} — 현행 법령에는 없고 폐지·연혁 법령 「${repealed.lawName}」${ef}으로 추정 (환각 아님). 연혁 인용이면 basis_date를 지정해 재검증하세요`,
        }
      }
      // 연혁 조회가 **실패**했으면 "연혁에도 없다"고 말할 수 없다 — 여기서 ✗를 찍으면
      // 폐지된 실존 법령을 환각으로 판정하게 된다 (Codex 2차 중요: 조용한 실패)
      if (lookupFailed) {
        return {
          mark: "⚠",
          line: `⚠ ${c.raw} — 현행 법령 0건이고, 폐지·연혁 DB 조회는 실패했습니다 — 판정 불가 (없음 아님): ${reason ?? "사유 미상"}`,
        }
      }
      if (!signal?.aborted) histChecked = true
    }
    // 미등재 약칭("조특법")에 대한 LIKE 0건은 법령 부존재의 증거가 아니라 별칭 사전의
    // 공백일 뿐이다. ✗(환각 의심)로 단정하면 실무자가 맞는 인용을 지운다 (Opus B-2).
    // 단, ⚠로만 두면 순수 환각("탄소세법")이 '사용 금지' 경고 없이 빠져나간다 —
    // hold로 표시해 요약 헤더에서 사용 보류를 요구한다 (Opus 재검증 개선)
    if (looksLikeAbbreviation(c.lawName)) {
      return {
        mark: "⚠",
        hold: true,
        line: `⚠ ${c.raw} — 「${c.lawName}」은 약칭 형태이나 ${histChecked ? "현행·연혁 법령 DB 어디에도 없습니다" : "법제처 검색에 잡히지 않았습니다"} (미등재 약칭 또는 환각 — 없음 단정 아님). 정식 명칭으로 재검증 전까지 이 인용의 사용을 보류하세요`,
      }
    }
    const dbNote =
      adminChecked && histChecked
        ? `「${c.lawName}」 법령·행정규칙·연혁 DB 모두 0건 (정상 조회)`
        : histChecked
          ? `법령 「${c.lawName}」 실존하지 않음 — 현행·연혁 모두 0건 (정상 조회)`
          : `법령 「${c.lawName}」 실존하지 않음 (정상 조회 후 0건)`
    // 따옴표 없는 규정·규칙은 사내 문서일 수 있다 — "당사 취업규칙 제12조"는 정당한
    // 인용인데 법령 DB에는 없다. ✗로 단정하면 실무자의 정상 문서를 환각으로 낙인찍는다.
    // hold로 사용 보류는 요구하되 "없음" 단정은 하지 않는다
    if (c.soft) {
      return {
        mark: "⚠",
        hold: true,
        line: `⚠ ${c.raw} — ${dbNote}. 사내 규정·사규 등 법령이 아닌 문서일 수 있어 "없음"으로 단정하지 않습니다 — 법령 인용이라면 정식 명칭을 확인하세요 (그 전까지 사용 보류)`,
      }
    }
    return { mark: "✗", line: `✗ ${c.raw} — ${dbNote}. 법령명 오기 또는 환각 의심` }
  }
  if (!best) {
    const alias = resolveLawAlias(c.lawName)
    const cutNote = c.uncut ? ` / 원문 표기: 「${c.uncut}」 (문맥 제거 후 「${c.lawName}」로 조회)` : ""
    return {
      mark: "⚠",
      line: `⚠ ${c.raw} — 정확 일치 법령 없음 (유사: ${laws.slice(0, 2).map((l) => `「${l.lawName}」`).join(", ")}${alias.canonical !== c.lawName ? ` / 별칭 해석: ${alias.canonical}` : ""}${cutNote}). 표기 확인 필요`,
    }
  }
  const trimNote =
    usedName !== c.lawName ? ` · 표기 주의: 「${c.lawName}」에서 선행 문맥을 제외한 「${usedName}」로 해석` : ""

  // "구 ○○법"은 개정 전 조문을 가리킨다 — 현행 DB에 조문이 있다는 사실이 그 인용의
  // 정확성을 증명하지 않는다. 기준일 없이 ✓를 주면 안 된다 (Opus 리뷰 중요 2)
  if (c.historical && !efYd) {
    return {
      mark: "⚠",
      line: `⚠ ${c.raw} — "구 ○○법"은 개정 전 법령을 가리키는 연혁 인용이라 현행 기준으로는 판정할 수 없습니다 (없음 아님). 해당 시점을 basis_date로 지정해 재검증하세요${trimNote}`,
    }
  }

  if (!c.article) {
    const histNote = best.status === "연혁" ? " ⚠주의: 연혁(폐지·과거본)" : ""
    return { mark: "✓", line: `✓ ${c.raw} — 법령 「${best.lawName}」 실존${histNote} · 검증범위: 명칭 실존${trimNote}` }
  }

  // 조문 실존 확인
  try {
    // 기준일이 있으면 그 시점 시행본의 MST로 조회한다 — 현행 MST + 과거 efYd는
    // 법제처가 빈 응답을 주므로 "조문 없음(✗)"으로 오판될 수 있다 (실측)
    let mst = best.mst
    let basisNote = ""
    if (efYd) {
      const { slice, reason } = await resolveVersionAt(apiClient, best.lawName, efYd, undefined, signal)
      if (!slice) {
        return { mark: "⚠", line: `⚠ ${c.raw} — 기준일 시행본을 확정하지 못해 판정 불가 (없음 아님): ${reason}` }
      }
      mst = slice.mst
      basisNote = ` · 기준일 시행본: ${slice.efYd.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3")}`
    }
    const extra: Record<string, string> = { MST: mst, JO: buildJO(c.article) }
    if (efYd) extra.efYd = efYd
    const jsonText = await apiClient.fetchApi({
      endpoint: "lawService.do",
      target: "eflaw",
      type: "JSON",
      extraParams: extra,
      signal,
      expectedJsonKey: "법령", // 루트 키가 다른 응답을 "조문 없음(✗)"으로 위장하지 않는다
    })
    const lawData = JSON.parse(jsonText)?.법령
    const units: any[] = toArray(lawData?.조문?.조문단위)
    const article = units.find((u: any) => u.조문여부 === "조문")
    if (!article) {
      return { mark: "✗", line: `✗ ${c.raw} — 법령 「${best.lawName}」은 실존하나 ${c.article}가 없음 (정상 조회 후 0건)${basisNote}. 조문 번호 확인` }
    }
    const title = article.조문제목 ? ` (${article.조문제목})` : ""
    const histNote = best.status === "연혁" ? " ⚠주의: 연혁(폐지·과거본) 인용" : ""
    const url = encodeURI(`https://www.law.go.kr/법령/${best.lawName}/${c.article}`)
    return { mark: "✓", line: `✓ ${c.raw} — 실존${title}${histNote} · 검증범위: 조문 실존 확인${trimNote}${basisNote} · ${url}` }
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

  // 순차 검증 (rate limit 보호 — 인용 수는 15건 상한, 전체 시간 상한 20초).
  // deadline은 인용 사이 확인만으로는 부족하다 — 한 인용의 조회가 길어지면 상한을
  // 넘겨 계속 돈다. AbortController로 진행 중 호출까지 실제로 끊는다 (Codex 상세 리뷰)
  const aborter = new AbortController()
  const deadlineTimer = setTimeout(() => aborter.abort(), VERIFY_DEADLINE_MS)
  const timedOutLine = (c: Citation) => ({
    mark: "⚠" as const,
    line: `⚠ ${c.raw} — 전체 시간 상한(${VERIFY_DEADLINE_MS / 1000}초) 도달로 미검증 (없음 아님). 이 인용은 나눠서 재검증하세요`,
  })
  const results: CheckResult[] = []
  try {
    for (const c of citations) {
      if (aborter.signal.aborted) {
        results.push(timedOutLine(c))
        continue
      }
      if (c.kind === "행정규칙") {
        try {
          let line = await verifyAdminRuleCitation(apiClient, [c.lawName], c.raw, c.lawName, undefined, aborter.signal)
          // 조문이 붙은 행정규칙 인용은 명칭만 확인된 것이다 — ✓로 집계하면 검증 안 된
          // 조문이 "검증 통과"로 읽히고, verify-file 훅의 마지막 관문이 통째로 열린다
          // (Opus 리뷰 중요 1). 명칭 실존은 밝히되 판정은 ⚠(조문 미검증)로 내린다
          if (c.article && line.startsWith("✓")) {
            line = `⚠${line.slice(1)} · ${c.article}의 존재는 미확인(행정규칙 조문 단위 API 없음) — 원문 확인 필요`
          }
          const mark: CheckResult["mark"] = line.startsWith("✓") ? "✓" : line.startsWith("✗") ? "✗" : "⚠"
          results.push({ mark, line })
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          results.push(
            /취소됨/.test(msg)
              ? timedOutLine(c)
              : { mark: "⚠", line: `⚠ ${c.raw} — 행정규칙 조회 실패로 판정 불가: ${msg}` }
          )
        }
      } else {
        results.push(await verifyLawCitation(apiClient, c, efYd, aborter.signal))
      }
    }
  } finally {
    clearTimeout(deadlineTimer)
  }

  const counts = { "✓": 0, "✗": 0, "⚠": 0 }
  results.forEach((r) => counts[r.mark]++)

  const coverage =
    total > citations.length
      ? `전체 ${total}건 중 ${citations.length}건 검증 (상한 ${MAX_CITATIONS}건 — 나머지 ${total - citations.length}건은 텍스트를 나눠 재검증하세요)`
      : `${citations.length}건`
  let out = `[기준: ${basis_date || "현행"}] 인용 검증 — ${coverage}: ✓${counts["✓"]} / ✗${counts["✗"]} / ⚠${counts["⚠"]}\n`
  if (counts["✗"] > 0) out += `⚠️ ✗ 항목은 초안에서 제거·수정 전까지 사용 금지\n`
  // 미확인 약칭은 ⚠(없음 단정 아님)이지만 환각일 수도 있다 — 조용히 통과시키지 않는다
  if (results.some((r) => r.hold)) out += `⚠️ 미확인 약칭 인용 있음 — 정식 명칭으로 재검증 전까지 해당 인용 사용 보류\n`
  if (counts["⚠"] > 0) out += `※ ⚠는 "없음"이 아니라 확인 실패입니다 — 재시도하거나 원문으로 확인하세요\n`
  out += "\n" + results.map((r) => r.line).join("\n")
  out += `\n\n${SOURCE_FOOTER}`

  return { content: [{ type: "text", text: truncateWithHint(out, 8000, "인용을 나눠 재검증") }] }
}
