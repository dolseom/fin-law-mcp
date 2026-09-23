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
import {
  isAdminRuleName,
  isAdminRuleLikeName,
  stripTrailingParen,
  verifyAdminRuleCitation,
  tryVerifyAdminRuleCitation,
  ntsGuideKind,
  NTS_GUIDE_UNLISTED_NOTE,
  parseDeletedArticle,
} from "./admin-rule-citation.js"
import {
  SOURCE_FOOTER,
  truncateWithHint,
  FIN_LAW_NAMES,
  isCalendarBasisDate,
  BASIS_DATE_CALENDAR_MESSAGE,
} from "../lib/fin-common.js"
import { resolveVersionAt } from "../lib/historical-utils.js"

const MAX_CITATIONS = 15
// 전체 시간 상한 — 순차 검증(15건 × 조회 2~3회)이 무한정 길어지지 않게 (Codex 리뷰).
// 초과분은 ⚠ 미검증으로 정직하게 표기한다 (조용한 실패 금지)
const VERIFY_DEADLINE_MS = 20_000
/** 응답 전체 문자 예산 — 판정 라인 상한은 여기서 헤더·푸터를 뺀 나머지로 계산한다 (handleFinVerify) */
const VERIFY_OUTPUT_BUDGET = 8000

export const FinVerifyInputSchema = z.object({
  text: z.string().min(1).describe("검증할 초안 텍스트 (법령·조문·고시·예규 인용 포함)"),
  basis_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "기준일은 YYYY-MM-DD 형식이어야 합니다")
    .refine(isCalendarBasisDate, BASIS_DATE_CALENDAR_MESSAGE)
    .optional()
    .describe("기준일 (YYYY-MM-DD) — 해당 시점 시행 법령으로 검증"),
})

export const FIN_VERIFY_TOOL = {
  name: "fin_verify",
  description:
    "[재무·세무·회계 전용 — 검토서·답변 초안의 인용 검증에 이 도구를 우선 사용] " +
    "텍스트에 인용된 법령·조문·행정규칙(고시·훈령·예규)의 실존을 법제처 DB와 대조해 " +
    "✓있음/✗없음/⚠판정불가 3값으로 반환한다. 오류를 '없음'으로 위장하지 않는다. " +
    // 기본통칙·집행기준은 법제처 DB에 없다 (2026-09-16 실측) — "통칙도 대조한다"고 쓰면 계약이 거짓이 된다
    "국세청 기본통칙·집행기준은 법제처 DB 미수록이라 번호를 검증하지 않고 ⚠로 표시하며, 삭제된 조문은 ✓가 아닌 ⚠(사용 보류)다. " +
    // 헤더 고지(응답 2번째 줄, counts["✓"] > 0)와 같은 사실이어야 한다 — 한쪽만 바뀌면
    // 도구 설명과 응답이 어긋난다. ✓5/✗0/⚠0을 "초안이 옳다"로 읽던 실측 오해가 근거다
    "✓는 법령·조문 번호의 실존만 뜻하며 항·호·내용의 옳고 그름은 검증하지 않는다 — 내용 확인은 fin_article로 본문을 대조할 것.",
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
  /**
   * 줄바꿈이 낱말 **안쪽**을 끊은 것으로 보고 공백 없이 이어 붙여 복원한 인용
   * ("법인세법 시\n행령 제88조"). 이 복원은 추정이므로 미발견 시 ✗가 아닌 ⚠다 —
   * 어절 경계를 낱말 안쪽으로 오인하면 없는 법령명이 만들어질 수 있다 (Codex 6차 차단)
   */
  joinRestored?: boolean
}

const IP = INTERPUNCT_CHARS // 가운뎃점 5종 — 추출 정규식과 정규화가 같은 집합을 봐야 한다
// 40자: "고용보험 및 산업재해보상보험의 보험료징수 등에 관한 법률" 같은 장명 법령 수용 (Codex 리뷰)
// 공백은 가로 공백만 — \s는 \n을 포함해 제목·직전 줄이 법령명에 통째로 흡수된다
// ("## 검토 메모\n\n당사 내부 회계관리규정 제5조"의 lawName이 "검토 메모 당사 …"가 되고,
//  raw의 개행이 훅의 라인 단위 판정 집계를 깨뜨려 hold가 "통과"로 둔갑한다 — Claude 리뷰 차단 1)
const LAW_NAME_CHARS = `[가-힣0-9${IP} \\t]`
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
// 명시 법령명 + 제N조(의M). 법령명과 조문 사이의 괄호를 선택적으로 받는다 —
// 판결문식 구법 표기 "구 법인세법(2018. 12. 24. 법률 제16008호로 개정되기 전의 것) 제26조의2"가
// 어느 패턴에도 걸리지 않아 환각 조문까지 "추출 0건"으로 조용히 통과했다 (Claude 리뷰 차단 2).
// 괄호는 행정규칙 경로(3ac07ed)에만 넣고 더 빈번한 법률·시행령 쪽을 빠뜨렸던 자리다
const LAW_ARTICLE_RE = new RegExp(
  `(${LAW_NAME_CHARS}{1,40}?(?:법률|법))${SUFFIX_PART}(\\s*[(（][^)）]{0,60}[)）])?\\s*(${ARTICLE_PART})`,
  "g"
)
// 괄호 내용이 "…로 개정되기 전의 것"류면 그 자체로 연혁 인용이다 ("구 " 접두가 없어도).
// "개정 전"·"전부개정 전"·"일부개정 전"·"폐지 전"도 연혁 표지다 — "되기"를 필수로 두면
// 이 변형들이 현행 ✓를 받는다 (Codex 4차 중요). 세부 (Codex 5차 중요 — 양방향):
//  · "전의"로 이어지는 표기("개정 전의 법령")도 표지다 — "전의 것"만 허용하면 놓친다
//  · "전" 뒤에 한글이 이어지면("개정 전제로") 표지가 아니다
//  · "전·후 비교"류 대조 표현은 연혁 인용이 아니다 — 구두점 뒤의 "후"를 배제.
//    구두점만 배제하면 "개정 전 및 후", "개정 전, 후", "개정 전 또는 후"가 연혁으로
//    오인돼 기준일 조회 경로로 새는다 (Codex 6차 개선) — 접속 표현도 함께 배제
const HISTORICAL_PAREN_RE =
  /(?:개정|폐지)\s*(?:되기\s*)?전의?(?:\s*것)?(?![가-힣])(?!\s*(?:[·ㆍ/／\-~〜,，]|및|또는)\s*후)/
// 「…」 + 제N조 — 표준 표기. 이 결합 패턴이 없으면 「」 인용은 명칭 실존만 확인하고
// 조문 검증을 우회한다 (Opus B2: 「법인세법」 제26조가 조문 확인 없이 통과)
const QUOTED_ARTICLE_RE = new RegExp(`「([^」]{2,40})」\\s*(${ARTICLE_PART})`, "g")
// 「」 인용에서 법령으로 받아들일 접미사. 「산업안전보건기준에 관한 규칙」처럼 본법이
// 아닌 '규칙·규정'류가 빠져 있으면 그 인용이 통째로 사라지고, 뒤따르는 "같은 규칙"이
// 두 칸 앞 본법을 선행사로 삼아 엉뚱한 시행규칙에 ✓를 준다 (Opus B-0)
const LAW_LIKE_SUFFIX_RE = /(법률|법|시행령|시행규칙|규칙|규정)$/
// 「…」 단독 인용 (행정규칙 포함)
const QUOTED_RE = /「([^」]{2,40})」/g
// 기본통칙 인용: "법인세법 기본통칙 19-19…46" 류.
// 번호에 말줄임표(…, U+2026)를 받는다 — 기본통칙 번호의 표준 표기인데 빠져 있어 raw가
// "법인세법 기본통칙 19-19"로 잘렸다 (9차 리뷰 차단 B2). 세 점(...)은 '.'로 이미 받는다
// 이름부는 LAW_ARTICLE_RE와 같은 {1,40}·(법률|법) — 20자·'법'만이면 "…등에 관한 법률 집행기준"처럼
// 긴 정식 명칭이 추출조차 되지 않았다. 이름부가 공백을 받으므로 앞 문장이 흡수된다
// ("업무무관 가지급금 판단은 법인세법 기본통칙 …") — 추출부에서 trimToLawName 기준으로 raw를
// 재구성해 잘라낸다 (R3 라이브 D2, 경로 1과 같은 방식)
const TONGCHIK_RE = new RegExp(`(${LAW_NAME_CHARS}{1,40}?(?:법률|법))\\s*(기본통칙|집행기준)\\s*([\\d\\-~의.…]+)?`, "g")

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
//
// 조사가 붙은 형태("제12조의2와", "제23조와", "제3조와")까지 받는다. 이게 빠져 있으면
// "소득세법 시행령 제12조의2와 국세청 조사사무처리규정 제41조"에서 앞 인용이 통째로
// 행정규칙명에 흡수되어 없는 이름이 만들어지고, **진짜 규정 인용은 검증 대상에서 사라진다**
// (퍼즈 차단). 은/는/을/를/에서/부터/까지는 CUT_ENDING_RE가 어절 종류와 무관하게 이미
// 잡아 주므로 실제 공백은 와/과/의/에/이/가/도/만/로/으로였다. 목록에 함께 적어 규칙을
// 한자리에서 읽히게 둔다. 정식 법령명에는 "제N조+조사" 어절이 없으므로 과잉 컷이 생기지 않는다
const CUT_REF_RE = /^제?\d+(?:조|항|호|목)(?:의\d+)?(?:와|과|의|에|이|가|도|만|으로|로|은|는|을|를)?[.,]?$/
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
    // 문장 접속 부사도 제거한다 — "그리고 탄소배출권거래규정 제77조"에서
    // 법령명이 "그리고 탄소배출권거래규정"으로 잡히던 실측 (규정·규칙 추출 확장 후
    // 드러났다. 「」나 '법' 접미사 경로에서는 어절 컷이 걸러 주던 자리다)
    .replace(/^(?:(?:그|이|위|해당|관련|및|또는|같은|각|본|동|이하|바와|그리고|그러나|또한|따라서|한편|아울러|다만)\s+)+/, "")
    .replace(/^(?:에\s*(?:따른|의한)|위한)\s+/, "")
}

function normArticle(a: string): string {
  return a.replace(/\s+/g, "")
}

/**
 * 명칭 끝의 발령일·발령번호 괄호를 떼어 접미사 검사에 태운다.
 * 「식품등의 표시기준(2024. 1. 15.)」 제1조는 접미사가 ')'로 끝나 행정규칙·법령
 * 어느 화이트리스트도 통과하지 못해 **추출조차 되지 않았다** — 실존이든 환각이든
 * 검증을 통째로 우회한다 (Codex 3차 차단). 판단은 괄호를 뗀 이름으로 하되,
 * 표시·검색에 쓰는 이름은 원문 그대로 둔다 (판(版) 정보를 임의로 지우지 않는다).
 */
function nameForSuffixCheck(name: string): string {
  const stripped = stripTrailingParen(name)
  return stripped || name
}

/**
 * 매치 직전이 "구 "인가 — 「」 인용의 연혁 표지. path 1은 kept 슬라이스로 같은 검사를
 * 하지만 「」 경로는 접두가 매치 밖에 있어 별도로 본다. 이게 없으면 '구 「법인세법」
 * 제26조'가 raw에서 "구"를 잃고 현행 ✓를 받는다 (Claude 리뷰 중요 6 — Opus 중요 2의
 * 수정이 무따옴표 경로에만 닿았던 절반 수정)
 */
function hasHistoricalPrefix(text: string, idx: number): boolean {
  return /(?:^|[\s.,;·(（])구\s+$/.test(text.slice(Math.max(0, idx - 8), idx))
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

// 제목·목록·표·인용구 라인 — 줄 잇기(joinWrappedLines)의 경계가 된다
const MD_STRUCT_LINE_RE = /^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|\||>)/

/**
 * 줄바꿈으로 감싸인(soft-wrap) 인용 복원 — 차단 1(개행 흡수)의 반대 방향.
 *
 * 이름 문자 클래스에서 \n을 빼자 "국가를 당사자로 하는 계약에 관한\n법률 제7조"처럼
 * 법령명이 줄 중간에서 감싸진 정상 인용이 추출 0건이 됐다 (Codex 4차 차단 — 0건이면
 * 훅이 그대로 통과한다). 앞 줄이 구두점 없이 한글로 끝나고 다음 줄이 한글로 이어지면
 * 같은 문장이 감싸진 것으로 보고 한 줄로 잇는다.
 *
 * 입력은 \n으로 정규화돼 있어야 한다 — CRLF를 그대로 split("\n")하면 앞 줄이 \r로
 * 끝나 잇기 조건이 전부 실패하고, Windows 문서의 감싸인 인용이 도로 0건이 된다
 * (Codex 5차 차단 — 호출부 extractCitationsWithTotal에서 정규화).
 *
 * 제목 흡수(차단 1)가 재발하지 않는 이유: 마크다운 구조 라인(#·목록·표·인용구)은 잇지
 * 않고, 빈 줄(문단 경계)은 조건을 만족하지 못하며, 한국어 산문의 문장 끝은 거의 항상
 * 구두점으로 끝난다. 구두점 없는 평문 제목이 바로 위에 붙는 잔여 케이스를 위해
 * **이은 위치(joins)를 돌려준다** — 추출기가 법령명이 이음새를 가로지르면 이음새 뒤
 * 이름을 우선 쓰고 전체 이름을 uncut 재시도로 보존한다 (Codex 5차 중요 — 제목 오염이
 * 정상 인용을 ✗로 만드는 것 방지).
 */
function joinWrappedLines(text: string, tight = false): { text: string; joins: number[] } {
  // tight: 이음새에 공백을 넣지 않는다 — 줄바꿈이 낱말 안쪽을 끊은 경우("법인세법 시\n행령")
  // 공백을 넣으면 "시 행령"이 되어 인용이 통째로 추출되지 않는다 (Codex 6차 차단).
  // 어절 경계인지 낱말 안쪽인지는 텍스트만으로 판별할 수 없으므로 두 해석을 모두
  // 추출해 병합한다 (extractCitationsWithTotal)
  const gap = tight ? "" : " "
  const lines = text.split("\n")
  const joins: number[] = []
  let out = ""
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (i === 0) {
      out = line
      continue
    }
    const lastNl = out.lastIndexOf("\n")
    const prev = out.slice(lastNl + 1)
    if (
      /[가-힣][ \t]*$/.test(prev) &&
      /^[ \t]*[가-힣]/.test(line) &&
      !MD_STRUCT_LINE_RE.test(prev) &&
      !MD_STRUCT_LINE_RE.test(line)
    ) {
      out = out.slice(0, lastNl + 1) + prev.replace(/[ \t]+$/, "")
      joins.push(out.length) // 이은 위치 — 이 좌표가 이름을 가로지르면 이음새다
      out += `${gap}${line.replace(/^[ \t]+/, "")}`
    } else {
      out += `\n${line}`
    }
  }
  return { text: out, joins }
}

// 이음새 뒤 조각이 이름 노릇을 못 하는 경우 — 접미사 토큰 단독이면 법령명이 줄
// 중간(접미사 직전)에서 감싸진 것이므로 전체를 한 이름으로 유지해야 한다
const BARE_SUFFIX_TOKENS = new Set([
  "법", "법률", "시행령", "시행규칙", "규칙", "규정", "고시", "훈령", "예규", "지침", "기준", "통칙",
])

/**
 * 괄호 구간 목록. 「」+조문 경로는 LAW_ARTICLE_RE의 괄호 재탐색과 달리 텍스트를 통째로
 * 훑으므로 자기가 괄호 안인지 모른다 — 그대로 두면 「소득세법」이 괄호 안에 있어도
 * 선행사가 되어 뒤의 "같은 법"이 엉뚱한 법으로 해소된다 (Codex 6차 중요, 5차 수정의 미적용분)
 */
function parenRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  const stack: number[] = []
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === "(" || ch === "（") stack.push(i)
    else if (ch === ")" || ch === "）") {
      const start = stack.pop()
      if (start !== undefined) ranges.push([start, i])
    }
  }
  return ranges
}

/** 절단 전 총 발견 건수 포함 — 16번째 이후 인용이 조용히 사라지지 않게 (Opus I4) */
export function extractCitationsWithTotal(text: string): { citations: Citation[]; total: number } {
  // CRLF·CR을 \n으로 정규화한다 — 정규화 없이는 Windows 문서(\r\n)에서 잇기 조건이
  // 전부 실패해 감싸인 인용이 0건으로 돌아간다 (Codex 5차 차단)
  const normalized = text.replace(/\r\n?/g, "\n")
  const primary = extractPass(normalized, false)
  // 줄 잇기가 실제로 일어났다면, 이음새가 낱말 안쪽일 가능성(tight)도 추출해 병합한다.
  // "법인세법 시\n행령 제88조"는 공백 잇기로는 영영 추출되지 않아 훅이 "인용 없음"으로
  // 통과시켰다 (Codex 6차 차단 — PDF·워드 붙여넣기에서 흔한 형태)
  const merged = joinWrappedLines(normalized).joins.length > 0 ? mergeTightPass(primary, normalized) : primary
  return { citations: merged.slice(0, MAX_CITATIONS), total: merged.length }
}

/**
 * 낱말 안쪽 해석(tight) 패스의 결과 중 **공백 해석에서 못 잡은 인용만** 더한다.
 *
 * 두 해석은 대개 한쪽만 옳다. 어절 경계였다면 tight는 "…하는계약에 관한 법률" 같은
 * 없는 이름을 만들고, 낱말 안쪽이었다면 공백 해석이 "시 행령"으로 인용을 통째로 놓친다.
 * 그래서 (1) 같은 조문·종류이고 이름이 서로의 접미인 쌍은 공백 해석을 우선하고,
 * (2) tight에서만 나온 인용은 joinRestored로 표시해 미발견 시 ✗ 대신 ⚠로 판정한다 —
 * 추정으로 만든 이름에 "환각" 낙인을 찍지 않기 위해서다
 */
function mergeTightPass(primary: Citation[], normalized: string): Citation[] {
  const tight = extractPass(normalized, true)
  const sameCitation = (a: Citation, b: Citation): boolean => {
    if (a.kind !== b.kind || (a.article || "") !== (b.article || "")) return false
    const an = compact(a.lawName)
    const bn = compact(b.lawName)
    return an === bn || an.endsWith(bn) || bn.endsWith(an)
  }
  const tightOnly = tight.filter((t) => !primary.some((p) => sameCitation(p, t)))
  // 낱말 안쪽 해석이 인용을 더 찾지 못했으면 어절 경계 해석이 맞다 — 그대로 둔다
  if (tightOnly.length === 0) return primary

  // 조응 인용("같은 법 제3조")은 **두 패스에서 서로 다른 법령으로 해소된다**.
  // 공백 해석에서 "소득세법 시 행령 제2조"가 추출되지 않으면 선행사가 앞 문장의 다른
  // 법으로 넘어가기 때문이다. 그대로 합치면 같은 raw가 두 건이 되어 인용 수가 부풀고,
  // 두 법령이 모두 실존하면 **엉뚱한 법령에도 확신형 ✓**가 나간다 (Codex 7차 차단).
  // tight가 새 인용을 찾았다는 것은 그 줄바꿈이 낱말 안쪽이었다는 증거이므로,
  // 같은 raw에 대해서는 tight 해석을 채택한다 (복원 추정에 기대므로 joinRestored를 남긴다)
  const out = primary.map((p) => {
    const alt = tight.find((t) => t.raw === p.raw && compact(t.lawName) !== compact(p.lawName))
    return alt ? { ...alt, joinRestored: true } : p
  })
  for (const t of tightOnly) {
    if (out.some((o) => o.raw === t.raw && compact(o.lawName) === compact(t.lawName))) continue
    out.push({ ...t, joinRestored: true })
  }
  return out
}

function extractPass(src: string, tight: boolean): Citation[] {
  const joined = joinWrappedLines(src, tight)
  const text = joined.text
  const joins = joined.joins
  const hits: Hit[] = []
  const articleEnds = new Set<number>() // 같은 조문 토큰의 이중 매치 방지 (명시 우선)
  const quotedStarts = new Set<number>() // 「」+조문으로 소비된 「 위치 — 단독 「」 중복 방지

  // 1) 명시 법령명 + 조문.
  // offset: 괄호 안 재탐색 시 매치의 절대 위치 보정 / inParen: 괄호 안 인용 여부
  const processLawArticleMatch = (m: RegExpMatchArray, offset: number, inParen: boolean): void => {
    const [, namePart, suffix, paren, article] = m
    let uncutBase = cleanLawName(namePart)
    let base = cleanLawName(trimToLawName(namePart))
    // 법령명이 줄 이음새(join)를 가로지르면 이음새 앞은 평문 제목일 수 있다 —
    // "2026년 세무 검토 대상\n택지소유상한에 관한 법률 제5조"를 통으로 조회하면
    // 정상 인용이 ✗가 된다 (Codex 5차 중요). 이음새 뒤 이름을 우선 쓰되, 전체 이름은
    // uncut으로 보존해 검증 단계가 양쪽을 시도한다 (findVerifyTarget의 uncut 재시도).
    // 이음새 뒤가 접미사 단독("법률")이면 진짜 감싸인 이름이므로 전체를 유지한다
    const nameStartAbs = offset + m.index!
    const lastJoinInName = joins.filter((j) => j > nameStartAbs && j < nameStartAbs + namePart.length).pop()
    if (lastJoinInName !== undefined) {
      const afterJoin = cleanLawName(trimToLawName(namePart.slice(lastJoinInName - nameStartAbs + 1)))
      if (afterJoin.length >= 2 && !BARE_SUFFIX_TOKENS.has(afterJoin) && afterJoin.length < base.length) {
        uncutBase = cleanLawName(namePart)
        base = afterJoin
      }
    }
    // 어절 컷 후 남은 게 조응 표현("동법")이나 외자("법")면 명시 인용이 아니다 —
    // 조응 정규식이 같은 자리를 따로 매칭한다
    if (base.length < 2 || ANAPHOR_WORDS.has(base.replace(/\s+/g, ""))) return
    const suffixNorm = suffix ? suffix.trim() : ""
    const end = offset + m.index! + m[0].length
    // raw는 컷으로 버린 선행 문맥을 제외해 재구성 ("임원 상여금은 부가가치세법 제1조" 방지).
    // lastIndexOf로 컷 지점을 잡는다 — indexOf는 같은 법령명이 앞에도 나오면 엉뚱한
    // 위치를 집어 raw에 문맥이 남는다 ("소득세법에 따라 소득세법 제12조", Opus 개선).
    // 탐색은 이름·접미사 구간까지만 — 괄호 안에 같은 이름이 나오면 lastIndexOf가
    // 괄호 안쪽을 집어 raw가 괄호 중간부터 시작한다
    const nameHead = namePart + (suffix || "")
    const kept = nameHead.lastIndexOf(base.split(" ")[0])
    let raw = (kept > 0 ? m[0].slice(kept) : m[0]).trim()
    // "구 법인세법" — 연혁 인용 표지. 문맥 컷이 "구"를 지우면 어떤 인용이 검증됐는지
    // 사용자가 알 수 없고, 개정 전 조문을 가리킨 인용에 현행 ✓가 찍힌다 (Opus 리뷰 중요 2)
    let historical = false
    if (kept > 0 && /(?:^|[\s.,;·(])구\s+$/.test(m[0].slice(0, kept))) {
      raw = `구 ${raw}`
      historical = true
    }
    // "…(법률 제N호로 개정되기 전의 것)" — 괄호 내용 자체가 연혁 표지다 (구 접두 없이도)
    if (paren && HISTORICAL_PAREN_RE.test(paren)) historical = true
    // 정렬 좌표는 **문맥 컷 이후의 진짜 인용 시작 위치**여야 한다.
    // LAW_ARTICLE_RE의 이름부는 지연 매칭이라 "법"으로 끝나지 않는 조응(동 시행령·같은 영·
    // 동 시행규칙·같은 규칙·같은 규정·동 규정) 뒤에 다른 법령이 오면
    // "동 시행령 제8조 및 부가가치세법"을 통째로 캡처한다. 이름은 어절 컷으로 정리되지만
    // idx를 매치 시작점으로 두면 그 명시 인용이 텍스트 순 정렬에서 **앞선 조응보다 먼저**
    // 놓여 lastLawName을 선점하고, 조응이 **자기보다 뒤에 나오는 법령**으로 해소된다.
    // "법인세법 제26조를 적용한다. 동 시행령 제8조 및 부가가치세법 제32조를 본다."의
    // "동 시행령 제8조"가 「부가가치세법 시행령」으로 확신형 ✓를 받던 자리 (퍼즈 차단).
    // "같은 법"류는 조응 자체가 '법'으로 끝나 정규식이 그 자리를 먼저 소비하므로 이 경로를
    // 타지 않았고, 그래서 여섯 라운드의 회귀 사례에 한 번도 걸리지 않았다.
    // raw가 이미 kept로 재구성되므로 좌표도 같은 기준을 쓴다 (end·괄호 오프셋은 m.index 기준 유지)
    const idx = offset + m.index! + (kept > 0 ? kept : 0)
    hits.push({
      idx,
      c: {
        raw,
        lawName: suffixNorm ? `${base} ${suffixNorm}` : base,
        article: normArticle(article),
        kind: "법령조문",
        ...(compact(uncutBase) !== compact(base) ? { uncut: suffixNorm ? `${uncutBase} ${suffixNorm}` : uncutBase } : {}),
        ...(historical ? { historical: true } : {}),
      },
      // 괄호 안 인용은 조응("같은 법")의 선행사가 되지 않는다 — 괄호 내용은 텍스트
      // 좌표상 바깥 인용 뒤에 오므로 선행사를 덮어써서, "법인세법(소득세법 제12조)
      // 제26조 … 같은 법"의 같은 법이 소득세법으로 해소된다 (Codex 5차 중요)
      ...(inParen ? {} : { antecedent: base }),
    })
    articleEnds.add(end)
    // 괄호 안의 별도 인용 — "법인세법(소득세법 제12조) 제26조"에서 바깥 매치가 괄호를
    // 소비하면 안쪽 「소득세법 제12조」는 이 패스에서 영영 매칭되지 않는다 (Codex 4차
    // 중요 — 괄호 허용의 반작용). 괄호 내용을 재탐색해 별도 인용으로 살린다.
    // 재귀는 1단계에서 끝난다 — 괄호 내용([^)）])에는 닫는 괄호가 없어 안쪽 매치가
    // 다시 괄호 그룹을 가질 수 없다
    if (paren) {
      const parenOffset = offset + m.index! + m[0].indexOf(paren)
      for (const inner of paren.matchAll(LAW_ARTICLE_RE)) {
        processLawArticleMatch(inner, parenOffset, true)
      }
    }
  }
  for (const m of text.matchAll(LAW_ARTICLE_RE)) {
    processLawArticleMatch(m, 0, false)
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
  const pranges = parenRanges(text)
  const isInParen = (i: number): boolean => pranges.some(([s, e]) => i > s && i < e)
  for (const m of text.matchAll(QUOTED_ARTICLE_RE)) {
    const name = cleanLawName(m[1])
    const inParen = isInParen(m.index!)
    quotedStarts.add(m.index!)
    const suffixName = nameForSuffixCheck(name)
    if (isAdminRuleName(suffixName)) {
      // 고시·훈령류는 본법 선행사가 되지 않지만, "같은 규칙"의 대상도 아니다
      hits.push({ idx: m.index!, c: { raw: m[0].trim(), lawName: name, article: normArticle(m[2]), kind: "행정규칙" } })
    } else if (LAW_LIKE_SUFFIX_RE.test(suffixName)) {
      const historical = hasHistoricalPrefix(text, m.index!)
      hits.push({
        idx: m.index!,
        c: {
          raw: historical ? `구 ${m[0].trim()}` : m[0].trim(),
          lawName: name,
          article: normArticle(m[2]),
          kind: "법령조문",
          ...(historical ? { historical: true } : {}),
        },
        // 「…에 관한 규칙」은 본법이 아니므로 "같은 법"의 선행사가 되면 안 된다.
        // 대신 "같은 규칙"의 선행사가 된다. 「…규정」은 어느 쪽 선행사도 아니다.
        // 괄호 안 인용은 어느 조응의 선행사도 되지 않는다 (위 parenRanges 주석)
        ...(inParen
          ? {}
          : isRuleLikeName(name)
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
    const suffixName = nameForSuffixCheck(name)
    if (isAdminRuleName(suffixName)) {
      hits.push({ idx: m.index!, c: { raw: m[0], lawName: name, kind: "행정규칙" } })
    } else if (LAW_LIKE_SUFFIX_RE.test(suffixName)) {
      const historical = hasHistoricalPrefix(text, m.index!)
      hits.push({
        idx: m.index!,
        c: {
          raw: historical ? `구 ${m[0]}` : m[0],
          lawName: name,
          kind: "법령",
          ...(historical ? { historical: true } : {}),
        },
        // 괄호 안 인용은 선행사가 되지 않는다 (3)과 같은 이유)
        ...(isInParen(m.index!)
          ? {}
          : isRuleLikeName(name)
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
    // 접미사 뒤의 발령일·발령번호 괄호를 함께 받는다 — "식품등의 표시기준(2024. 1. 15.)
    // 제1조"가 통째로 매칭되지 않아 추출 자체가 안 되던 자리 (Codex 3차 차단).
    // 괄호는 선택이므로 기존 매칭에는 영향이 없다.
    // 이름 문자에 \n을 넣으면 안 된다 — 제목이 흡수돼 규정류는 복구 수단이 없다 (차단 1)
    `(${LAW_NAME_CHARS}{2,30}?(?:고시|훈령|예규|통칙|기준|지침|규정|규칙)(?:\\s*[(（][^)）]{0,40}[)）])?)\\s*(${ARTICLE_PART})`,
    "g"
  )
  for (const m of text.matchAll(ADMIN_ARTICLE_RE)) {
    const name = cleanLawName(trimToLawName(m[1]))
    const end = m.index! + m[0].length
    // 「」 인용과 일반 법령 경로가 이미 가져간 조문 토큰은 건너뛴다
    // ("법인세법 시행규칙 제15조"는 1번이 처리한다 — 여기서 또 잡으면 행정규칙으로
    //  판정되어 부령 조문이 "명칭만 확인"으로 강등된다)
    if (articleEnds.has(end)) continue
    // raw·좌표를 어절 컷 이후 기준으로 재구성한다 — 법령 경로(1번)에는 있는데 여기만 빠져
    // 있었다. 이름부가 30자까지 왼쪽으로 뻗으므로, 앞 인용이나 접속사를 문맥으로 잘라낸 뒤에도
    // raw는 "소득세법 시행령 제12조의2와 국세청 조사사무처리규정 제41조" 전체를 그대로 보여
    // 어느 구간이 검증됐는지 알 수 없었다 (판정은 옳고 표시만 두 인용에 걸쳐 있던 자리).
    // 좌표도 같은 기준으로 옮긴다 — raw와 idx의 기준이 어긋나 있던 것이 조응 선행사 역전의 원인이었다
    const adminKept = m[1].lastIndexOf(name.split(" ")[0])
    const adminRaw = (adminKept > 0 ? m[0].slice(adminKept) : m[0]).trim()
    const adminIdx = m.index! + (adminKept > 0 ? adminKept : 0)
    const suffixName = nameForSuffixCheck(name)
    if (isAdminRuleName(suffixName)) {
      // 고시·훈령류: 행정규칙 전용 경로 (명칭 실존만 검증)
      hits.push({ idx: adminIdx, c: { raw: adminRaw, lawName: name, article: normArticle(m[2]), kind: "행정규칙" } })
      articleEnds.add(end)
      continue
    }
    // 「…규정」·「…규칙」은 부령(법령 DB)일 수도, 고시·훈령일 수도 있다 —
    // 법령조문 경로로 보내면 법령 DB → 행정규칙 폴백 → 폐지 확인 순서가 이미 배선돼 있다.
    // 시행규칙은 isAdminRuleLikeName이 걸러 1번 경로에 맡긴다
    if (!isAdminRuleLikeName(suffixName)) continue
    hits.push({
      idx: adminIdx,
      // 따옴표 없는 규정·규칙은 사내 문서일 수 있다 — "당사 취업규칙 제12조",
      // "내부 회계처리 규칙 제3조"는 정당한 인용인데 법령 DB에는 당연히 없다.
      // 이런 이름에 ✗("환각 의심")를 찍으면 실무자의 정상 문서를 거짓말로 낙인찍는다.
      // 미발견 시 ⚠로 강등한다 — 조용히 통과시키지도, 없다고 단정하지도 않는다
      // (SOFT_ADMIN_SUFFIX의 '기준·지침'과 같은 취급). 「」로 감싼 인용은 법령을
      // 의도한 것이 명확하므로 종전대로 ✗ 판정을 유지한다
      c: { raw: adminRaw, lawName: name, article: normArticle(m[2]), kind: "법령조문", soft: true },
      // 괄호 안 인용은 "같은 규칙"·"같은 규정"의 선행사도 되지 않는다 (3)과 같은 이유).
      // 컷 이후 좌표로 본다 — 매치가 괄호 앞에서 시작하고 이름은 괄호 안인 경우
      // ("…제5조 및 (당사 취업규칙 제12조)") m.index로는 괄호 밖으로 읽혀 선행사가 된다
      ...(isInParen(adminIdx)
        ? {}
        : isRuleAntecedentName(name)
          ? { ruleAntecedent: name }
          : isRegAntecedentName(name)
            ? { regAntecedent: name }
            : {}),
    })
    articleEnds.add(end)
  }

  // 6) 기본통칙·집행기준
  for (const m of text.matchAll(TONGCHIK_RE)) {
    const base = cleanLawName(trimToLawName(m[1]))
    if (base.length < 2) continue
    const name = `${base} ${m[2]}`
    // raw(판정 줄 라벨)도 컷으로 버린 선행 문맥을 뺀다 — lawName만 자르면 모법 확인은 맞는데
    // 라벨이 "업무무관 가지급금 판단은 법인세법 기본통칙 …"이 된다 (R3 D2). 경로 1과 같이
    // lastIndexOf로 컷 지점을 잡고, 사전 표기와 원문 공백이 달라 못 찾으면 원문 그대로 둔다
    const kept = m[1].lastIndexOf(base.split(" ")[0])
    // 문장 끝 마침표는 번호가 아니다 ("…19-19…46." → "…19-19…46")
    const raw = (kept > 0 ? m[0].slice(kept) : m[0]).trim().replace(/\.+$/, "")
    hits.push({ idx: m.index! + (kept > 0 ? kept : 0), c: { raw, lawName: name, kind: "행정규칙" } })
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
    // raw는 반드시 한 줄로 — 「」 안 개행 등으로 raw에 \n이 남으면 판정 라인이 여러
    // 물리 라인으로 쪼개져 verify-file 훅의 라인 단위 집계가 깨진다 (차단 1의 두 번째 방어선)
    h.c.raw = h.c.raw.replace(/\s+/g, " ").trim()
    // dedup 키에 위치를 포함한다 — 서로 다른 법의 인용이 같은 lawName으로 절단됐을 때
    // 한 건이 조용히 증발하던 문제 방지 (Opus B-3②)
    const key = `${h.c.kind}|${h.c.lawName}|${h.c.article || ""}|${h.c.raw}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(h.c)
  }
  // 같은 법령·조문인데 raw만 다른 인용은, 한쪽 raw가 다른 쪽에 포함되면 짧은 쪽을
  // 흡수한다 — "법인세법(법인세법 제26조) 제26조"의 괄호 재탐색이 같은 인용을 두 건으로
  // 만들어 15건 상한을 소모하고 뒤쪽 인용을 미검증으로 밀어내던 것 (Codex 5차 개선).
  // raw 포함 관계를 요구하므로 B-3②(다른 원문의 같은 lawName 절단)는 흡수되지 않는다
  const absorbed = out.filter(
    (c, i) =>
      !out.some(
        (o, j) =>
          j !== i &&
          o.kind === c.kind &&
          o.lawName === c.lawName &&
          (o.article || "") === (c.article || "") &&
          // 연혁 여부가 다르면 서로 다른 인용이다 — "구 법인세법 제26조"가 뒤 문장의
          // "법인세법 제26조"를 흡수해 현행 인용이 검증 대상에서 사라지던 것 (Codex 6차 중요)
          !!o.historical === !!c.historical &&
          o.raw !== c.raw &&
          o.raw.includes(c.raw)
      )
  )
  return absorbed
}

// ── 검증 ────────────────────────────────────────────────────────────────

interface CheckResult {
  mark: "✓" | "✗" | "⚠"
  line: string
  /** 미확인 약칭 — 정식 명칭 재검증 전까지 사용 보류를 요약 헤더로 띄운다 */
  hold?: boolean
  /**
   * 삭제된 조문 — 번호만 남은 자리표시라 ✓가 아니지만 "확인 실패"도 아니다.
   * 요약 헤더를 약칭 보류·확인 실패 고지와 따로 띄운다 (9차 리뷰 차단 B1)
   */
  deleted?: boolean
}

// 행정규칙 판정 라인의 삭제 조문 표지 — tryVerifyAdminRuleCitation 문구와 짝이다
const ADMIN_DELETED_LINE_RE = /^⚠ .*? — \[사용 보류\] 삭제된 조문/

/** 행정규칙 경로의 문자열 판정을 CheckResult로 — 접두 마크를 승격하지 않는다 (⌛는 ⚠로 집계) */
function adminLineResult(line: string): CheckResult {
  const mark: CheckResult["mark"] = line.startsWith("✓") ? "✓" : line.startsWith("✗") ? "✗" : "⚠"
  return ADMIN_DELETED_LINE_RE.test(line) ? { mark, line, deleted: true } : { mark, line }
}

/**
 * 행정규칙 판정에 "기준일 미적용"을 드러낸다 (9차 리뷰 중요 I1).
 *
 * 행정규칙 경로에는 연혁 본문 대조가 없어 basis_date를 줘도 **현행** 본문으로 판정한다.
 * 헤더는 "[기준: 2019-01-01]"인데 판정은 현행이라, 기준일 이후 신설된 조문에 ✓가,
 * 기준일 이후 삭제된 조문에 ✗가 붙을 수 있었다. 둘 다 기준일 시점의 사실이 아니므로 ⚠로 낮춘다
 * — ✗의 계약은 "정상 조회 후 0건"인데 기준일 시점은 조회하지 않았고, ✓를 두면 현행 대조가
 * 기준일 검증으로 읽힌다. 규칙 자체가 현행·폐지 연혁 DB 어디에도 없는 [NOT_FOUND] ✗만
 * 유지한다 — 시점과 무관하게 DB에 없는 규칙이라 기준일 미적용 고지도 붙이지 않는다.
 * 고지는 raw 바로 뒤에 둔다 — capLine(480자)이 라인 끝을 잘라도 살아남아야 한다
 */
function withAdminBasisNote(r: CheckResult, raw: string, basisDate?: string): CheckResult {
  if (!basisDate) return r
  if (r.mark === "✗" && r.line.includes("[NOT_FOUND]")) return r
  const lead = /^([✓✗⚠⌛]) /.exec(r.line)
  const shownMark = lead?.[1] === "⌛" ? "⌛" : "⚠"
  const body = lead ? r.line.slice(lead[0].length) : r.line
  const head = `${raw} — `
  const rest = body.startsWith(head) ? body.slice(head.length) : body
  const tail =
    r.mark === "⚠" ? "" : ` → 기준일(${basisDate}) 시점의 ${r.mark === "✓" ? "존재" : "부존재"}는 미확인 (행정규칙은 연혁 본문 대조 미지원 — 현행 판정을 기준일에 옮기지 않음)`
  return { ...r, mark: "⚠", line: `${shownMark} ${head}[현행 기준 대조 — 기준일 미적용] ${rest}${tail}` }
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

const ymdToIso = (ymd: string): string => ymd.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3")

/**
 * lawService JSON 조문단위가 조 전체 삭제 자리표시인가 — 삭제 표기(<일자>)를, 아니면 null.
 * 판정은 parseDeletedArticle(행정규칙 본문 대조와 공유). 항이 딸려 있으면 살아 있는 조문으로
 * 본다 — 삭제 자리표시에는 항이 오지 않는다 (실측 캐시 삭제 조문 전부 항 없음)
 */
function deletedArticleStamp(unit: any): string | null {
  const content = unit?.조문내용
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map(String).join(" ") : ""
  if (!text) return null
  const hang = unit?.항
  if (hang !== undefined && hang !== null && hang !== "" && !(Array.isArray(hang) && hang.length === 0)) return null
  return parseDeletedArticle(text)
}

/**
 * 국세청 기본통칙·집행기준 인용 (9차 리뷰 차단 B2).
 *
 * 법제처 DB에 수록되지 않은 문서라 "행정규칙 DB 0건"은 부존재의 증거가 아니다 — 종전에는
 * 「법인세법 기본통칙 19-19…46」이 ✗ "존재하지 않는 규칙" + "사용 금지"로 단정됐다.
 * 번호는 검증하지 않고 ⚠로 두되, 모법(법인세법)의 실존은 확인한다 — 모법이 없으면
 * 통칙도 있을 수 없으므로 사용 보류를 요구한다 (없음 단정은 하지 않는다).
 * 집행기준은 DB에 동명 접미사 규칙이 실존하므로(「(계약예규)정부 입찰ㆍ계약 집행기준」) 먼저
 * 정확 일치를 찾고, 찾으면 일반 행정규칙 판정을 그대로 쓴다
 */
async function verifyNtsGuideCitation(
  apiClient: LawApiClient,
  c: Citation,
  kind: "기본통칙" | "집행기준",
  signal?: AbortSignal
): Promise<CheckResult> {
  if (kind === "집행기준") {
    const hit = await tryVerifyAdminRuleCitation(apiClient, [c.lawName], c.raw, undefined, signal, c.article)
    if (hit) return adminLineResult(hit)
  }
  const lawName = stripTrailingParen(c.lawName).replace(/\s*(?:기본통칙|집행기준)$/, "").trim()
  if (!/법률?$/.test(lawName)) {
    return { mark: "⚠", line: `⚠ ${c.raw} — ${NTS_GUIDE_UNLISTED_NOTE} · 모법 표기가 없어 법령 확인도 생략` }
  }
  try {
    const { best } = await findVerifyTarget(apiClient, lawName, signal)
    if (best) {
      return { mark: "⚠", line: `⚠ ${c.raw} — ${NTS_GUIDE_UNLISTED_NOTE} · 모법 「${best.lawName}」 실존 확인(현행 법령 DB)` }
    }
    return {
      mark: "⚠",
      hold: true,
      line: `⚠ ${c.raw} — [사용 보류] ${NTS_GUIDE_UNLISTED_NOTE} · 모법 「${lawName}」도 현행 법령 DB에서 확인되지 않음 (없음 단정 아님 — 법령명 확인 전까지 사용 보류)`,
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/취소됨/.test(msg)) throw e // deadline은 상위가 미검증으로 표기한다
    return { mark: "⚠", line: `⚠ ${c.raw} — ${NTS_GUIDE_UNLISTED_NOTE} · 모법 「${lawName}」 조회 실패로 미확인: ${msg}` }
  }
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
  // 조회·분류에는 괄호를 뗀 이름을 쓴다 — 「외국환거래규정(기재부 고시)」을 그대로
  // 조회하면 0건이 되고, 이름이 ')'로 끝나 규정·규칙 판정(isRuleLikeName)도 빗나가
  // 행정규칙 폴백을 못 타고 ✗ 환각 낙인이 찍힌다 (Codex 3차 차단의 검증 단계 대응).
  // 표시는 c.raw 원문 그대로다
  const lookupName = stripTrailingParen(c.lawName)
  let laws: LawInfo[]
  let best: LawInfo | undefined
  let usedName: string
  try {
    ;({ laws, best, usedName } = await findVerifyTarget(apiClient, lookupName, signal, c.uncut))
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { mark: "⚠", line: `⚠ ${c.raw} — 조회 실패로 판정 불가 (없음 아님): ${msg}` }
  }
  if (!best) {
    // 정확 일치가 없으면 유사 후보(LIKE 노이즈)가 있어도 아래 확인(행정규칙 폴백·폐지
    // 연혁·약칭/soft hold)을 전부 거친다 — law_search·article은 잔여②에서 "노이즈 1건에
    // 폴백이 꺼진다"며 정확 일치 게이트로 고쳤는데 verify만 0건 게이트로 남아,
    // "당사 취업규칙"이 「유해ㆍ위험작업의 취업 제한에 관한 규칙」류 노이즈에 가려
    // soft/hold 없이 일반 ⚠로 빠지고 훅이 "통과"를 보고했다 (Claude 리뷰 중요 4 —
    // 절반 수정의 일곱 번째 사례)
    const nearNote =
      laws.length > 0
        ? ` · 법령 DB에는 유사 명칭만 검색됨: ${laws.slice(0, 2).map((l) => `「${l.lawName}」`).join(", ")} (정확 일치 아님)`
        : ""
    // 「…규정」·「…규칙」은 법령(대통령령·부령)일 수도, 행정규칙(고시·훈령)일 수도 있다.
    // 법령 DB 0건만으로 ✗를 찍으면 「외국환거래규정」(기재부 고시)·「조사사무처리규정」
    // (국세청 훈령) 같은 실존 문서에 '환각 의심' 낙인이 찍힌다 — 행정규칙 DB를
    // 확인한 뒤 판정한다 (Opus B-0① 재검증)
    let adminChecked = false
    if (isRuleLikeName(lookupName)) {
      if (signal?.aborted) {
        return { mark: "⚠", line: `⚠ ${c.raw} — 법령 DB 정확 일치 0건, 시간 상한 도달로 행정규칙 DB 미확인 — 판정 불가 (없음 아님)` }
      }
      try {
        // 조문을 함께 넘겨 본문 대조까지 시킨다 — 조문 형식 규칙이면 ✓/✗, 통짜 본문이면
        // ⚠(조문 미확인)가 그대로 돌아온다. 판정 문구가 이미 조문까지 반영하므로
        // 여기서 다시 강등하지 않는다 (강등은 대조를 못 할 때 함수가 스스로 한다)
        const adminHit = await tryVerifyAdminRuleCitation(
          apiClient,
          [lookupName],
          c.raw,
          undefined,
          signal,
          c.article
        )
        if (adminHit) {
          // 접두 일치·조문 미확인은 tryVerify가 "⚠"로 시작하는 문구를 준다 — 승격하지 않는다.
          // 기준일이 있으면 현행 대조임을 밝힌다 — fin_verify의 행정규칙 경로와 같은 사실이다
          // (한쪽만 고치면 「…규정」 폴백으로 들어온 인용만 기준일에 현행 ✓를 받는다)
          return withAdminBasisNote(adminLineResult(adminHit), c.raw, efYd ? ymdToIso(efYd) : undefined)
        }
        adminChecked = true
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return { mark: "⚠", line: `⚠ ${c.raw} — 법령 DB 정확 일치 0건, 행정규칙 DB 조회 실패로 판정 불가 (없음 아님): ${msg}` }
      }
    }
    // 폐지·연혁 확인 — 현행 0건이 '지어낸 법령'인지 '폐지된 법령'인지 가른다.
    // findRepealedLaw는 이 용도로 만들어졌으나 배선이 안 돼 있었다 (Opus 재검증 개선)
    let histChecked = false
    if (!signal?.aborted) {
      const { law: repealed, lookupFailed, reason } = await findRepealedLaw(apiClient, lookupName, undefined, signal)
      if (repealed) {
        const ef = repealed.effectiveDate
          ? `(마지막 시행 ${repealed.effectiveDate.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3")})`
          : ""
        // 기준일을 이미 줬는데 "basis_date를 지정하라"고 하면 같은 요청을 되풀이하게 만든다
        // (9차 리뷰 E6). 이 경로는 현행 목록에서 법령을 찾으므로 기준일을 줘도 조문 대조까지 가지 않는다
        return {
          mark: "⚠",
          line: efYd
            ? `⚠ ${c.raw} — 현행 법령에는 없고 폐지·연혁 법령 「${repealed.lawName}」${ef}으로 추정 (환각 아님). 기준일(${ymdToIso(efYd)})을 지정했지만 현행 목록에 없는 법령은 기준일 조문 대조를 하지 않습니다 — 법제처 연혁 원문으로 확인하세요 (없음 아님)`
            : `⚠ ${c.raw} — 현행 법령에는 없고 폐지·연혁 법령 「${repealed.lawName}」${ef}으로 추정 (환각 아님). 연혁 인용이면 basis_date를 지정해 재검증하세요`,
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
    const dbNote =
      laws.length > 0
        ? `「${c.lawName}」 — 법령 DB 정확 일치 없음${adminChecked ? " · 행정규칙 DB 0건" : ""}${histChecked ? " · 폐지·연혁 DB 0건" : ""}${nearNote}`
        : adminChecked && histChecked
          ? `「${c.lawName}」 법령·행정규칙·연혁 DB 모두 0건 (정상 조회)`
          : histChecked
            ? `법령 「${c.lawName}」 실존하지 않음 — 현행·연혁 모두 0건 (정상 조회)`
            : `법령 「${c.lawName}」 실존하지 않음 (정상 조회 후 0건)`
    // 따옴표 없는 규정·규칙은 사내 문서일 수 있다 — "당사 취업규칙 제12조"는 정당한
    // 인용인데 법령 DB에는 없다. ✗로 단정하면 실무자의 정상 문서를 환각으로 낙인찍는다.
    // hold로 사용 보류는 요구하되 "없음" 단정은 하지 않는다.
    // 약칭 판정보다 먼저 본다 — "당사 취업규칙"(압축 6자)은 약칭 형태와도 겹치지만
    // 사내 문서 안내가 더 정확하다 (둘 다 hold ⚠라 판정 강도는 같다).
    // "[사용 보류]"를 앞쪽에 두는 이유: 훅은 이 문구로 hold를 식별하는데, 라인 끝에만
    // 있으면 출력 절단 시 hold가 조용히 사라진다 (Claude 리뷰 개선 10)
    if (c.soft) {
      return {
        mark: "⚠",
        hold: true,
        line: `⚠ ${c.raw} — [사용 보류] ${dbNote}. 사내 규정·사규 등 법령이 아닌 문서일 수 있어 "없음"으로 단정하지 않습니다 — 법령 인용이라면 정식 명칭을 확인하세요 (그 전까지 사용 보류)`,
      }
    }
    // 줄바꿈을 낱말 안쪽으로 보고 이어 붙여 복원한 이름은 추정이다 — 어절 경계를
    // 오인했다면 없는 법령명이 만들어지므로 ✗(환각 의심)로 단정하지 않는다.
    // 조문까지 확인되는 경로(법령 실존 + 조문 0건)는 이름이 정확히 맞은 경우라 ✗를 유지한다
    if (c.joinRestored) {
      return {
        mark: "⚠",
        hold: true,
        line: `⚠ ${c.raw} — [사용 보류] 줄바꿈으로 끊긴 법령명을 이어 붙여 「${c.lawName}」로 해석했으나 ${dbNote}. 원문에서 법령명을 확인하세요`,
      }
    }
    // 미등재 약칭("조특법")에 대한 LIKE 0건은 법령 부존재의 증거가 아니라 별칭 사전의
    // 공백일 뿐이다. ✗(환각 의심)로 단정하면 실무자가 맞는 인용을 지운다 (Opus B-2).
    // 단, ⚠로만 두면 순수 환각("탄소세법")이 '사용 금지' 경고 없이 빠져나간다 —
    // hold로 표시해 요약 헤더에서 사용 보류를 요구한다 (Opus 재검증 개선)
    if (looksLikeAbbreviation(lookupName)) {
      return {
        mark: "⚠",
        hold: true,
        line: `⚠ ${c.raw} — [사용 보류] 「${c.lawName}」은 약칭 형태이나 ${histChecked ? "현행·연혁 법령 DB 어디에도 없습니다" : "법제처 검색에 잡히지 않았습니다"}${nearNote} (미등재 약칭 또는 환각 — 없음 단정 아님). 정식 명칭으로 재검증 전까지 이 인용의 사용을 보류하세요`,
      }
    }
    if (laws.length > 0) {
      // 유사 후보만 있는 경우 — ✗(환각 의심) 단정은 하지 않되, 어느 확인을 거쳤는지 남긴다
      const alias = resolveLawAlias(lookupName)
      const cutNote = c.uncut ? ` / 원문 표기: 「${c.uncut}」 (문맥 제거 후 「${c.lawName}」로 조회)` : ""
      return {
        mark: "⚠",
        line: `⚠ ${c.raw} — 정확 일치 법령 없음 (유사: ${laws.slice(0, 2).map((l) => `「${l.lawName}」`).join(", ")}${alias.canonical !== lookupName ? ` / 별칭 해석: ${alias.canonical}` : ""}${cutNote}). 표기 확인 필요`,
      }
    }
    return { mark: "✗", line: `✗ ${c.raw} — ${dbNote}. 법령명 오기 또는 환각 의심` }
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
    // 법령명만 인용하면 시행본을 조회하지 않는다 — 현행 목록에 있다는 사실은 기준일에 그 법령이
    // 시행 중이었다는 증거가 아니다(기준일 뒤 제정일 수 있다). 기준일이 있는데 ✓를 주면 현행 대조가
    // 기준일 검증으로 읽힌다 — 행정규칙 경로(withAdminBasisNote)와 같은 고지·강등이다 (9차 검수).
    // 시행본 조회(resolveVersionAt)를 더하는 방식은 인용마다 호출이 늘어 택하지 않았다
    if (efYd) {
      return {
        mark: "⚠",
        line: `⚠ ${c.raw} — [현행 기준 대조 — 기준일 미적용] 법령 「${best.lawName}」 실존${histNote} · 검증범위: 명칭 실존${trimNote} → 기준일(${ymdToIso(efYd)}) 시점의 시행 여부는 미확인 (법령명만 인용하면 시행본을 조회하지 않음 — 조문까지 인용하면 기준일 시행본으로 대조)`,
      }
    }
    return { mark: "✓", line: `✓ ${c.raw} — 법령 「${best.lawName}」 실존${histNote} · 검증범위: 명칭 실존${trimNote}` }
  }

  // 조문 실존 확인
  try {
    // 기준일이 있으면 그 시점 시행본의 MST로 조회한다 — 현행 MST + 과거 efYd는
    // 법제처가 빈 응답을 주므로 "조문 없음(✗)"으로 오판될 수 있다 (실측)
    let mst = best.mst
    let basisNote = ""
    // 조회에 넘기는 efYd는 **그 판본의 시행일**(slice.efYd)이다 — 기준일이 아니다.
    // 과거 판본 MST에 기준일을 efYd로 주면 법제처가 "일치하는 법령이 없습니다"(XML)나
    // HTML 오류(JSON)를 돌려준다 (2026-09-16 실측: 근로기준법 MST 150421 + efYd 20180101 → 80B
    // "일치하는 법령 없음", 같은 MST + 판본 시행일 20140701 → 본문 정상). 기준일이 우연히
    // 판본 시행일과 같을 때만 통과해서, 기준일 조문 대조가 거의 전부 ⚠로 죽어 있었다 (9차 검수 확정)
    let versionEfYd: string | undefined
    if (efYd) {
      const { slice, reason } = await resolveVersionAt(apiClient, best.lawName, efYd, undefined, signal)
      if (!slice) {
        return { mark: "⚠", line: `⚠ ${c.raw} — 기준일 시행본을 확정하지 못해 판정 불가 (없음 아님): ${reason}` }
      }
      mst = slice.mst
      versionEfYd = slice.efYd
      basisNote = ` · 기준일 시행본: ${slice.efYd.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3")}`
    }
    const extra: Record<string, string> = { MST: mst, JO: buildJO(c.article) }
    if (versionEfYd) extra.efYd = versionEfYd
    // 현행 확인은 target=law — 법제처가 efYd 없는 eflaw lawService를 HTML 오류로
    // 돌려주기 시작했다 (2026-08-30 게이트20 실측: 전 문장 ⚠. article만 고치고
    // verify를 빠뜨리면 반쪽 수정의 아홉 번째가 된다). eflaw는 기준일 조회에만
    const jsonText = await apiClient.fetchApi({
      endpoint: "lawService.do",
      target: versionEfYd ? "eflaw" : "law",
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
    // 조응("같은 법"·"같은 규정")은 원문만 봐서는 무엇으로 해소됐는지 알 수 없다.
    // 선행사가 문단을 건너뛰어 잡히면 ✓가 엉뚱한 법령의 조문을 가리킬 수 있으므로
    // 해소 결과를 드러내 사용자가 즉시 확인하게 한다 (Codex 3차 중요 — 조응 자체를
    // 막으면 정상적인 장거리 인용까지 ⚠가 되므로, 막는 대신 밝힌다)
    const resolvedNote = compact(c.raw).includes(compact(best.lawName)) ? "" : ` [해소: 「${best.lawName}」]`
    // 조문단위가 왔다고 조문이 살아 있는 것은 아니다 — 법제처는 삭제된 조문도 번호를 남긴다
    // ("제39조 삭제 <2001.12.31>", 법인세법 조문 213개 중 32개). 내용을 보지 않고 ✓를 주면
    // 삭제된 조문이 확신형 ✓로 통과하고 훅도 exit 0이었다 (9차 리뷰 차단 B1 — 라이브 재현).
    // 기준일 조회도 같은 자리를 지난다 — 기준일 시행본에서 살아 있으면 ✓, 이미 삭제됐으면 ⚠다.
    // 행정규칙 본문 대조(checkAdminRuleArticle)도 같은 판정 함수를 쓴다
    const deletedStamp = deletedArticleStamp(article)
    if (deletedStamp !== null) {
      const stamp = deletedStamp ? ` (삭제 ${deletedStamp})` : ""
      return {
        mark: "⚠",
        deleted: true,
        line: efYd
          ? `⚠ ${c.raw}${resolvedNote} — [사용 보류] 기준일 시행본에서 이미 삭제된 조문${stamp}${basisNote} — 「${best.lawName}」 ${c.article}는 그 시점의 근거로 쓸 수 없음 (없음 ✗ 아님). 삭제 전 규정을 인용한 것이면 basis_date를 삭제 전 시점으로 지정해 재검증${trimNote} · ${url}`
          : `⚠ ${c.raw}${resolvedNote} — [사용 보류] 삭제된 조문${stamp} — 「${best.lawName}」에 ${c.article} 번호만 남고 본문이 없어 현행 근거로 쓸 수 없음 (없음 ✗ 아님). 연혁 인용이면 basis_date로 해당 시점을 지정해 재검증${trimNote} · ${url}`,
      }
    }
    return {
      mark: "✓",
      line: `✓ ${c.raw}${resolvedNote} — 실존${title}${histNote} · 검증범위: 조문 실존 확인${trimNote}${basisNote} · ${url}`,
    }
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
          // 국세청 기본통칙·집행기준은 법제처 DB 미수록 — 행정규칙 DB 0건을 ✗로 쓰지 않는다 (9차 B2)
          const nts = ntsGuideKind(c.lawName)
          // 조문을 함께 넘긴다 — 조문 형식(조문형식여부=Y) 규칙은 본문 조문과 대조해
          // ✓/✗로 판정하고, 통짜 본문인 규칙은 종전처럼 ⚠(조문 미확인)로 돌아온다.
          // 명칭만 확인하고 ✓를 주면 없는 조문이 "검증 통과"로 읽힌다는 원칙(Opus 리뷰
          // 중요 1)은 그대로다 — 강등 대신 실제 대조로 지킨다
          const r = nts
            ? await verifyNtsGuideCitation(apiClient, c, nts, aborter.signal)
            : adminLineResult(
                await verifyAdminRuleCitation(apiClient, [c.lawName], c.raw, c.lawName, undefined, aborter.signal, c.article)
              )
          // basis_date는 이 경로에 전달되지 않는다 — 행정규칙은 현행 본문으로만 대조하므로
          // 그 사실을 판정 줄에 밝히고 ✓·✗를 기준일 판정으로 내보내지 않는다 (9차 I1)
          results.push(withAdminBasisNote(r, c.raw, basis_date))
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
  // 검증 범위 고지 — ✓의 뜻을 헤더 두 번째 줄에 못박는다. 행 단위의 "검증범위: 조문 실존
  // 확인"은 눈에 들어오지 않아, 항 번호와 취지가 틀린 초안도 ✓5/✗0/⚠0으로 읽혔다(실측).
  // ✓가 0건이면 오해할 여지가 없으니 생략한다. 마크(✓✗⚠⌛)로 시작하지 않으므로
  // 판정 라인 파서(scripts/verify-file.mjs VERDICT_LINE, scripts/gate20.mjs)에 걸리지 않는다
  if (counts["✓"] > 0)
    out += `※ ✓는 법령·조문 번호가 법제처에 실존한다는 뜻입니다. 항·호·내용의 옳고 그름은 검증하지 않습니다 — 내용 확인은 fin_article로 본문을 대조하세요\n`
  if (counts["✗"] > 0) out += `⚠️ ✗ 항목은 초안에서 제거·수정 전까지 사용 금지\n`
  // 보류(hold)는 ⚠(없음 단정 아님)이지만 환각일 수도 있다 — 조용히 통과시키지 않는다.
  // 사유는 하나가 아니다: 미등재 약칭(:1052)·사내 문서 가능성(:1031)·줄바꿈 복원(:1041)·
  // 기본통칙 모법 미확인(:908)이 모두 이 헤더를 띄운다. 전부 "미확인 약칭"이라 부르면
  // 사내 규정이나 기본통칙에까지 "정식 명칭으로 재검증"이라는 맞지 않는 조치가 붙는다 (R2)
  // 헤더 길이는 판정 줄 상한(lineCap)을 깎는다 — 자세한 사유는 판정 줄이 말하므로 헤더는 짧게 둔다
  if (results.some((r) => r.hold))
    out += `⚠️ 사용 보류 인용 있음 — 사유는 판정 줄마다 다릅니다(미등재 약칭·사내 문서·모법 미확인 등). 그 사유 확인 전까지 사용 보류\n`
  // 삭제된 조문은 약칭 보류와 사유가 다르다 — 같은 헤더로 뭉치면 "정식 명칭 재검증"이라는 틀린 조치를 준다.
  // "현행 근거"로 못박지 않는다 — basis_date를 주면 **그 시점 시행본**에서, 행정규칙이면 현행 본문에서
  // 삭제를 확인한 것이라 대조한 판본이 서로 다르다. 대조 시점은 판정 줄이 말한다 (R2)
  if (results.some((r) => r.deleted))
    out += `⚠️ 삭제된 조문 인용 있음 — 대조한 본문에서 삭제 확인(대조 시점은 판정 줄 참조), 그 시점 근거로 사용 보류\n`
  // 삭제 조문의 ⚠는 "확인 실패"가 아니라 확인된 사실이다 — 그것만 있을 때 이 고지를 붙이면 거짓이 된다.
  // 남는 ⚠도 전부 조회 실패는 아니다: 법제처 DB 미수록(국세청 기본통칙·집행기준)·기준일 미적용
  // (행정규칙 연혁 대조 미지원, 법령명만 인용)·정확 일치 없음은 **조회가 정상으로 끝난** 결과라
  // 재시도해도 달라지지 않는다. "없음이 아니다"는 유지하고 사유는 판정 줄에서 읽게 한다 (R2)
  if (results.some((r) => r.mark === "⚠" && !r.deleted))
    out += `※ ⚠는 "없음"(부존재 확정)이 아닙니다 — 사유가 줄마다 다릅니다(조회 실패·DB 미수록·기준일 미적용·표기 확인 필요 등). 줄의 사유대로 재시도·원문 확인\n`
  // 절단은 라인 단위로 — 전체 문자 절단(truncateWithHint)만 있으면 15건 상한 안에서도
  // 뒤쪽 판정 라인(✗ 포함)이 통째로 잘려 훅에서 judged 미달 → "통과" 강등이 될 수 있다
  // (Claude 리뷰 개선 10).
  //
  // 최악 길이 — 종전 주석의 "480자 × 15건 + 헤더·푸터 < 8000"은 절단 접미사(24자)와
  // 줄바꿈을 빠뜨린 계산이었다 (9차 리뷰 E7). 실제 최악(헤더 5줄, 판정 15줄 전부 절단):
  //   헤더 ≈ 299~306(첫 줄 전체 건수 자릿수에 따라) + "\n" 1 + 판정 15 × (480 + 24) = 7,560
  //   + 줄 사이 "\n" 14 + "\n\n" 2 + 푸터 44 = 7,920~7,927 (리뷰어 실측 7,924)
  // 삭제 조문 헤더(44자)가 더해지면 7,964~7,971로, 8,000까지 여유가 30자 남짓이다.
  // 헤더 한 줄만 더 늘어도 truncateWithHint가 **뒤쪽 판정 라인**을 잘라 훅이 미검증으로
  // 오보하므로, 라인 상한을 고정값이 아니라 남은 예산으로 계산한다 — 지금 헤더 구성에서는
  // 480자 그대로이고(예산상 481~482자), 헤더가 길어지면 라인 상한이 먼저 줄어든다.
  // R2에서 보류·삭제·⚠ 고지 문구가 사유를 말하도록 길어져, 헤더 6줄 최악(E7 테스트)에서
  // 라인 상한은 476자다 — 판정 줄 15개와 8,000자 이내는 그대로 지켜진다.
  // 마크와 raw는 라인 앞쪽이라 항상 살아남는다
  const LINE_CUT_SUFFIX = " …(세부 절단 — 이 인용은 단독 재검증)"
  const fixedLen = out.length + 1 + (results.length - 1) + 2 + SOURCE_FOOTER.length
  const lineCap = Math.min(
    480,
    Math.floor((VERIFY_OUTPUT_BUDGET - fixedLen) / Math.max(results.length, 1)) - LINE_CUT_SUFFIX.length
  )
  const capLine = (s: string) => (s.length <= lineCap ? s : s.slice(0, lineCap) + LINE_CUT_SUFFIX)
  out += "\n" + results.map((r) => capLine(r.line)).join("\n")
  out += `\n\n${SOURCE_FOOTER}`

  return { content: [{ type: "text", text: truncateWithHint(out, VERIFY_OUTPUT_BUDGET, "인용을 나눠 재검증") }] }
}
