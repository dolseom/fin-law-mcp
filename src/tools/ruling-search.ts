/**
 * fin_ruling_search — 예규·심판례·해석례·판례 통합 검색 (목록 전용)
 *
 * 기존은 18개 도메인 중 하나를 골라 따로 검색해야 했다 (도메인 선택 부담이 LLM에 전가).
 * 여기서는 재무 실무 1순위 도메인 4곳을 병렬로 한 번에 검색한다.
 * - 법제처 기본 정렬은 제목 가나다순(판례만 선고일 내림차순)이라 최신 자료가 10건 창 밖에 묻힌다 →
 *   요청에 sort=ddes(일자 내림차순)를 싣고, 받은 순서가 실제로 내림차순일 때만 "최신순"이라 적는다
 * - 문서번호(법인세과-352 형식)를 복사 가능한 형태로 표기
 * - 본문은 동봉하지 않는다 (목록 전용 — 예산 4,000자). 예규 본문은 fin_nts_ruling.
 */

import { z } from "zod"
import type { LawApiClient } from "../lib/api-client.js"
import {
  parseTaxTribunalXML,
  parseInterpretationXML,
  parsePrecedentXML,
  extractTag,
} from "../lib/xml-parser.js"
import {
  type SectionResult,
  failed,
  parseNtsRulings,
  truncateWithHint,
  AUTHORITY_FOOTER,
  RULING_STOPWORDS,
  SOURCE_FOOTER,
  isCalendarBasisDate,
  BASIS_DATE_CALENDAR_MESSAGE,
} from "../lib/fin-common.js"
import { maskSensitiveUrl } from "../lib/fetch-with-retry.js"
import { getLawSiteBaseUrl } from "../lib/law-url-config.js"

const DOMAINS = ["nts", "tax_tribunal", "interpretation", "precedent"] as const
type Domain = (typeof DOMAINS)[number]

const DOMAIN_LABEL: Record<Domain, string> = {
  nts: "국세청 예규",
  tax_tribunal: "조세심판원 재결례",
  interpretation: "법제처 해석례",
  // 법제처 판례 DB는 대법원만이 아니라 전 심급(고법·지법 포함)을 준다 — "대법원 판례"로
  // 라벨하면 하급심이 최상위 전거로 읽힌다 (실사용 시뮬레이션 ④: 5건 중 대법원 1건 실측)
  precedent: "법원 판례",
}

// 전거 서열 주석 — 각 자료의 법적 성격을 명시해 오용(예규를 확정 근거로 인용 등)을 막는다
const DOMAIN_AUTHORITY: Record<Domain, string> = {
  nts: "행정해석 — 과세실무 기준이나 법원 구속력 없음",
  tax_tribunal: "불복 재결 — 인용 재결은 과세관청 기속",
  interpretation: "정부유권해석",
  precedent: "법원 판단 — 심급 확인 필요: 대법원 확정판결이 최상위, 하급심은 상소·확정 여부 확인",
}

export const FinRulingSearchInputSchema = z.object({
  // 공백만 있는 검색어는 사다리가 빈 검색어만 만들어 API를 한 번도 부르지 않고 "전체 성공 · 0건"을
  // 돌려줬다 (Codex 9차 M4) — 앞뒤 공백을 걷어낸 뒤 검증한다
  query: z
    .string({ error: "query(쟁점 검색어)는 필수 문자열입니다" })
    .trim()
    .min(1, "query는 공백이 아닌 1자 이상의 검색어여야 합니다 (공백만 있는 검색어는 조회하지 않습니다)")
    .describe("쟁점 검색어 (예: 퇴직금 중간정산 손금)"),
  // 빈 배열을 허용하면 한 번도 조회하지 않고 "전체 성공 · 검색 범위 (0곳)"을 돌려준다 —
  // 호출측은 이것을 "검색했지만 결과 없음"으로 읽는다 (조용한 no-op, Codex 2차 중요)
  domains: z
    .array(z.enum(DOMAINS))
    .min(1, "domains는 최소 1곳 이상이어야 합니다 (생략하면 4곳 전부 검색)")
    .default([...DOMAINS])
    .describe("검색 도메인 (기본: 4곳 전부)"),
  basis_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "기준일은 YYYY-MM-DD 형식이어야 합니다")
    .refine(isCalendarBasisDate, BASIS_DATE_CALENDAR_MESSAGE)
    .optional()
    .describe("기준일 (YYYY-MM-DD) — 이 날짜까지 나온 예규·재결·판례만 (회신·의결·선고일 기준)"),
})

export const FIN_RULING_SEARCH_TOOL = {
  name: "fin_ruling_search",
  description:
    "[재무·세무·회계 전용 — 예규·심판례·판례 검색은 이 도구를 우선 사용] " +
    // 본문은 정렬을 확인한 도메인에만 "최신순"이라 적고 아니면 "일자순 + 최신순 미보장"이라 적는다 —
    // 설명이 단정형이면 LLM이 도메인 줄의 그 경고를 무시하고 언제나 최신이라 읽는다 (9차 L)
    "국세청 예규 + 조세심판원 재결례 + 법제처 해석례 + 법원 판례(전 심급)를 한 번에 검색해 통합 목록을 반환한다 " +
    "(문서번호·일자·제목 · 정렬을 확인한 도메인은 최신순, 확인하지 못하면 일자순으로 표기하고 사유를 밝힌다). " +
    "예규 본문이 필요하면 fin_nts_ruling.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "쟁점 검색어" },
      domains: {
        type: "array",
        items: { type: "string", enum: [...DOMAINS] },
        description: "검색 도메인 (기본: nts·tax_tribunal·interpretation·precedent 전부)",
      },
      basis_date: { type: "string", description: "기준일 YYYY-MM-DD — 이 날짜까지 나온 자료만 (회신·의결·선고일 기준)" },
    },
    required: ["query"],
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
} as const

interface UnifiedItem {
  domain: Domain
  docNo: string
  date: string // YYYYMMDD 정규화 (정렬용)
  dateDisplay: string
  title: string
  docId: string
  link: string
}

function normDate(raw: string): string {
  return (raw || "").replace(/[^\d]/g, "").slice(0, 8)
}

/**
 * 도메인별 법제처 검색 설정 (2026-09-16 라이브 실측 — .release-scratch/probes/fix-ruling-sort.log·misc.log).
 * - sort=ddes: 4곳 모두 일자 내림차순이다. 정렬 없이 전체 목록(최대 163건)을 받아 뽑은 최신 10건과
 *   sort=ddes 1쪽 10건이 일치했다. 생략하면 예규·재결례·해석례는 제목 가나다순이라 "퇴직금 중간정산"
 *   예규 163건 중 2021년 건이 "최신"으로 나오고 2023~2025년 5건이 목록에서 빠졌다 (Codex 9차 [차단] L)
 * - dateRange: `19000101~YYYYMMDD` 범위 문법의 회신·의결·선고일 검색. totalCnt가 기준일 이하 실제 건수와
 *   같아졌고(163→153, 20→8, 73→32, 16→5) 경계일 당일도 포함됐다. 상위 10건이 전부 기준일 이후라
 *   필터 후 0건이 되던 경로가 API 단계에서 막힌다
 * ⚠ 법제처는 모르는 파라미터를 조용히 무시한다(lawSearch efYd 단일값 전례) — 받은 일자·순서를
 *   searchDomain에서 다시 대조한다
 */
const DOMAIN_SEARCH: Record<Domain, { target: string; root: string; dateRange: string }> = {
  nts: { target: "ntsCgmExpc", root: "CgmExpc", dateRange: "explYd" },
  tax_tribunal: { target: "ttSpecialDecc", root: "Decc", dateRange: "rslYd" },
  interpretation: { target: "expc", root: "Expc", dateRange: "explYd" },
  precedent: { target: "prec", root: "PrecSearch", dateRange: "prncYd" },
}

/** 법제처 lawSearch의 일자 내림차순 정렬값 — fin_nts_ruling도 같은 값을 쓴다 */
export const LATEST_FIRST_SORT = "ddes"

/**
 * 정렬 판정에 쓸 수 있는 일자인가 — 8자리이면서 달력에 실재하는 날짜.
 *
 * 문자열 비교만 하면 "20251345" 같은 값도 내림차순 판정에 끼어든다. 그런 값이 왔다는 것은 일자
 * 태그를 잘못 읽었다는 뜻이라(응답 형식 변경·다른 태그 혼입) 최신순 주장의 근거가 될 수 없다.
 * 공용 isFutureDate(fin-common)는 8자리 검사만 하지만 그쪽은 "미래인가"라 오판의 방향이 다르다.
 */
function isSortableDate(ymd: string): boolean {
  if (!/^\d{8}$/.test(ymd)) return false
  const y = Number(ymd.slice(0, 4))
  const m = Number(ymd.slice(4, 6))
  const d = Number(ymd.slice(6, 8))
  const probe = new Date(Date.UTC(y, m - 1, d))
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d
}

/**
 * 받은 순서가 일자 내림차순인가 — sort=ddes가 실제로 적용됐는지 응답으로 확인한다.
 * 법제처가 정렬 파라미터를 무시하면 가나다순 목록이 와서 여기서 걸리고, 호출부는 받은 10건 안의
 * 재정렬을 "최신순"이라 부르지 않는다.
 *
 * 판정 근거는 **받은 목록 전체**다. 종전에는 일자를 못 읽은 항목을 걸러낸 뒤 비교해서
 * 빈 배열(`[].every`)과 1건짜리 목록이 무조건 true였다 — 일자를 하나도 못 읽은 응답이
 * "최신순"으로 나갔고, 비교 쌍이 없는 1건이 "전체에서 가장 최신"의 증거로 쓰였다.
 * - 일자를 못 읽은 항목이 하나라도 있으면 그 항목의 위치를 확인할 수 없으므로 false
 * - 비교 쌍이 없는 0·1건도 false (전부 받았다는 사실은 totalCnt로 따로 확인한다 — assessLatestFirst)
 * ⚠ true는 "받은 순서가 내림차순"이라는 사실일 뿐 "목록 밖보다 최신"과 같은 말이 아니다.
 *   목록 밖까지 포함한 최신 보장은 sort=ddes 계약과 전체 수신(totalCnt) 쪽에서 온다.
 */
export function isLatestFirst(dates: string[]): boolean {
  const ymd = dates.map(normDate)
  if (ymd.length < 2 || !ymd.every(isSortableDate)) return false
  return ymd.every((d, i) => i === 0 || ymd[i - 1] >= d)
}

/** "최신순" 표기의 근거 — 호출부는 이 사실들로 사유가 다른 문구를 갈라 쓴다 */
export interface LatestFirstAssessment {
  /** 표시 목록을 "최신순"이라 적어도 되는가 */
  latestFirst: boolean
  /** 검색 총건수를 전부 받았는가 — 참이면 "더 최신 자료가 목록 밖에" 있을 수 없다 */
  allReturned: boolean
  /** 일자를 읽을 수 없어 순서·기준일 대조를 못 한 항목 수 */
  undated: number
}

/**
 * 표시 목록을 "최신순"이라 부를 수 있는가 — 두 근거 중 하나가 서야 한다.
 * ① 검색 총건수를 전부 받았고 **일자를 전부 읽었다** → 로컬 정렬이 곧 최신순
 * ② 받은 순서가 일자 내림차순이다 (sort=ddes가 실제로 적용됨)
 *
 * ①에서 일자 검증을 빼면 안 된다 — 전부 받아도 일자를 못 읽은 항목은 로컬 정렬이 끝으로 밀어낼
 * 뿐 실제 위치를 모른다. 종전 `totalCnt <= 받은 건수` 우회에는 이 검증이 없었다.
 * totalCnt가 받은 건수보다 **작은** 응답은 그 자체로 모순이라 "전부 받았다"의 근거로 쓰지 않는다.
 */
export function assessLatestFirst(dates: string[], totalCnt: number | undefined): LatestFirstAssessment {
  const undated = dates.filter((d) => !isSortableDate(normDate(d))).length
  const allReturned = totalCnt !== undefined && dates.length > 0 && totalCnt === dates.length
  return { latestFirst: (allReturned && undated === 0) || isLatestFirst(dates), allReturned, undated }
}

/**
 * 검색 응답의 totalCnt — 태그가 없거나 숫자가 아니면 undefined
 * (0으로 지어내면 "전체를 다 받음"으로 오판한다).
 *
 * 자릿수가 과한 값도 undefined다. `/^\d+$/`만 보면 309자리 숫자가 `Number()`에서 Infinity가 되고
 * 16자리를 넘으면 안전 정수 범위 밖이라 비교·표시가 모두 어긋난다 — 그런 응답은 총건수를 읽은
 * 것이 아니라 **못 읽은 것**이다. 미확인 표기는 totalCntNote가 이어받는다.
 */
export function readTotalCnt(xml: string): number | undefined {
  const raw = extractTag(xml, "totalCnt").trim()
  if (!/^\d+$/.test(raw)) return undefined
  const n = Number(raw)
  return Number.isSafeInteger(n) ? n : undefined
}

/**
 * 검색 총건수를 확인하지 못한 사유 — 확인됐으면 undefined.
 *
 * 종전 두 도구는 `Math.max(totalCnt, 받은 건수)`로 모순 응답을 덮었다. totalCnt 2 / 수신 3이면
 * "검색 3건"이 되어, 받은 3건이 검색 결과 전부인 것처럼 읽혔다 — 총건수도 받은 건수도 그 수를
 * 말한 적이 없다. 어느 쪽도 믿을 수 없으므로 지어내지 않고 미확인으로 적되, 받은 건수는 따로
 * 보존해 "우리가 본 것"만 말한다 (article.ts 예규 후보와 같은 계약).
 */
export function totalCntNote(totalCnt: number | undefined, received: number): string | undefined {
  if (totalCnt === undefined) return "응답의 totalCnt를 읽지 못함"
  if (totalCnt < received) return `totalCnt ${totalCnt}건 < 받은 ${received}건`
  return undefined
}

/**
 * 도메인당 검색 호출 상한 (원 검색어 1 + 축약 3).
 * 법제처 분당 30회 한도를 도메인 4곳이 병렬로 나눠 쓰므로 4회를 넘기지 않는다.
 */
const LADDER_MAX_CALLS = 4

/** 도메인당 표시 상한 (초과분은 조용히 버리지 않고 건수를 고지한다) */
const MAX_ITEMS_PER_DOMAIN = 5

/** 응답 문자 예산 — 항목 줄에 링크가 붙으므로 표시 건수를 이 예산에 맞춰 줄인다 */
const TEXT_BUDGET = 4000

/**
 * 실무 질의의 쟁점 접미 — 5어절 이상 질의에서 핵심어 창을 고를 때만 제외하는 어절.
 *
 * 실무자 자연어는 [주체][주제어][쟁점 접미] 순으로 쌓인다. "퇴직금 중간정산 손금 산입 요건 여부"의
 * 뒤 4어절은 쟁점을 묻는 말이지 검색 키가 아니다 — 법제처·국세청 제목 색인에는 이 어절들이 흔해
 * 어느 예규에나 걸리므로 변별력이 사실상 없다.
 *
 * ⚠ 원문 검색어(사다리 1순위)와 4어절 이하 사다리에서는 어절을 빼지 않는다.
 *   "퇴직급여 충당금 손금"처럼 짧은 질의에서는 "손금"이 유일한 쟁점 키다.
 *   다만 **이 목록 어절만 남은 축약 단계**("손금 산입 요건")는 어절 수와 무관하게 통째로 건너뛴다
 *   (buildLadder ④). 붙임 표기("손금불산입")는 어절 단위 비교라 이 목록에 걸리지 않는다.
 * ⚠ 공용 fin-common에 두지 않는다 — article·law-search의 사다리는 법령·행정규칙 **명칭**을
 *   다루므로 이 목록이 해가 된다 (「…에 관한 처리 기준」 같은 공식 명칭이 깎인다).
 */
const RULING_GENERIC_TAIL = new Set([
  "손금",
  "산입",
  "불산입",
  "요건",
  "여부",
  "해당",
  "가능",
  "처리",
  "방법",
  "기준",
  // 2026-09-16 추가 (Codex 9차 M2) — 실무 질의 꼬리에 흔하고 어느 제목에나 걸리는 쟁점어.
  // 없으면 "퇴직금 한도 초과액 손금 불산입"의 핵심 창이 "퇴직금 한도", 종착점이 "한도"가 된다
  "한도",
  "초과",
  "초과액",
  "계산",
  "판단",
  "시기",
  "적용",
  "대상",
  "범위",
  "인정",
])

/**
 * 질의 앞머리의 **주체** 어절 — 핵심 창을 고를 때, 빼고도 핵심 어절이 2개 이상 남으면 건너뛴다.
 * "법인 대표이사 퇴직금 한도 초과액 손금 불산입"의 창이 "법인 대표이사"가 되어 퇴직금과 무관한
 * 대표이사 예규 5건을 줬다 (Codex 9차 M2 라이브). 임원·직원·대표이사는 넣지 않는다 —
 * "임원 퇴직금"·"대표이사 가지급금"처럼 그 어절 자체가 세무 쟁점이다.
 */
const RULING_SUBJECT = new Set(["법인", "개인", "회사", "당사", "사업자"])

const isCoreWord = (t: string): boolean => !RULING_GENERIC_TAIL.has(t)

/**
 * ruling-search·nts-ruling 공용 축약 사다리 — 어절 수에 따라 두 가지 방식을 쓴다.
 *
 * **4어절 이하: 양끝 교대 축약**
 *   원문 → 꼬리 1어절 제거 → 머리 1어절 제거 → 꼬리 제거 …
 *   "임직원 경조사비 복리후생비 손금" → "임직원 경조사비 복리후생비" → "경조사비 복리후생비" → "경조사비"
 *
 * **5어절 이상: 창 축약** (2026-09-05 Codex 제품 검토 — 한 어절씩 깎으면 예산 4회 안에 핵심어에 못 닿는다)
 *   원문 → 양끝 1어절씩 제거(n−2어절) → 핵심 2어절 창 → 핵심 1어절
 *   "퇴직금 중간정산 손금 산입 요건 여부"
 *     → "중간정산 손금 산입 요건" → "퇴직금 중간정산" → "중간정산"
 *   핵심 창은 RULING_GENERIC_TAIL을 뺀 어절(주체 어절은 가능하면 건너뜀)의 앞쪽 2개, 종착점은 그 창의
 *   **마지막** 비주체 어절이다. 결과는 일자 내림차순으로 받으므로 넓은 어절("퇴직금")로 끝내면
 *   최근 퇴직금 예규 전반에 쟁점 자료가 묻힌다 — 마지막 단계일수록 변별력이 높아야 한다.
 *   ⚠ 종착점 규칙이 모든 질의에 맞지는 않는다 — "임직원 경조사비 복리후생비 손금 여부"는 "경조사비"로,
 *   "퇴직금 중간정산 …"은 "중간정산"으로 끝나지만, [넓은 주제][세부 주제] 순서를 어긴 질의는 넓은 어절로
 *   끝날 수 있다. 그래서 축약 결과에는 ladderWarning이 항상 붙는다.
 *
 * **공통 후처리**
 *   ④ 원 질의에 주제어가 있으면, 주제어 없이 쟁점 접미만 남은 축약 단계는 버린다 — "퇴직금 손금 산입
 *      요건 여부" → "손금 산입 요건"이 대손금·주식매수선택권 예규 5건을 "전체 성공"으로 줬다 (Codex 9차 M2).
 *   ⑤ 그렇게 버린 뒤 1어절 단계가 없으면 핵심 종착점을 붙인다 ("퇴직금 손금 산입 요건" → … → "퇴직금").
 *
 * 공용 ladderQueries는 앞토막만 잘라(3→2→1어절) 마지막에 첫 어절만 남긴다. 실무자 자연어는
 * 정보가 가운데 몰려 있어 앞토막 축약은 주제어를 먼저 버린다.
 * 공용 함수를 고치면 article·law-search까지 함께 바뀌므로 예규 검색 두 도구만 이 함수를 쓰고,
 * 전처리(불용어 제거)는 공용 목록 RULING_STOPWORDS를 그대로 참조한다 (목록 복제 금지).
 */
export function buildLadder(query: string): string[] {
  const normalized = query.replace(/\s+/g, " ").trim()
  const toks = normalized.split(" ").filter((t) => t && !RULING_STOPWORDS.has(t))
  const n = toks.length
  // 핵심 창 — 접미를 다 빼면 남는 게 없는 질의("손금 산입 요건 여부 해당")는 원 어절로 되돌린다
  const core = toks.filter(isCoreWord)
  const topical = core.filter((t) => !RULING_SUBJECT.has(t))
  const coreWindow = (core.length === 0 ? toks : topical.length >= 2 ? topical : core).slice(0, 2)
  const terminal = [...coreWindow].reverse().find((t) => !RULING_SUBJECT.has(t)) ?? coreWindow[coreWindow.length - 1]
  // 원문을 반드시 1순위로 — 불용어("및"·"관한")가 공식 명칭의 일부인 경우가 있다
  const qs: string[] = [normalized]
  if (n >= 5) {
    // ① 양끝 1어절씩 제거 — 주체와 마지막 쟁점어를 한 번에 턴다
    qs.push(toks.slice(1, n - 1).join(" "))
    // ② 핵심 2어절 창
    qs.push(coreWindow.join(" "))
    // ③ 창의 종착 1어절 (창이 1어절이면 ②와 같아져 중복 제거로 사다리가 짧아진다)
    qs.push(terminal)
  } else {
    let lo = 0
    let hi = n
    let dropTail = true
    while (hi - lo > 1) {
      if (dropTail) hi--
      else lo++
      dropTail = !dropTail
      qs.push(toks.slice(lo, hi).join(" "))
    }
    // 2어절 질의는 축약 후보가 양끝 두 어절뿐이고 예산(4회)이 남는다 — 나머지 한쪽도 시도한다.
    // 3·4어절은 교대 축약만으로 주제어에 닿으므로 추가하지 않는다 (호출 예산 보존)
    if (n === 2) qs.push(toks[1])
  }
  let steps = qs.filter(Boolean)
  if (core.length > 0) {
    // ④ 주제어 없는 축약 단계 제거 (원문은 그대로 둔다)
    steps = [steps[0], ...steps.slice(1).filter((q) => q.split(" ").some(isCoreWord))]
    // ⑤ 1어절 단계가 사라졌으면 종착점을 붙인다
    if (n >= 2 && terminal && !steps.slice(1).some((q) => !q.includes(" "))) steps.push(terminal)
  }
  return [...new Set(steps)].slice(0, LADDER_MAX_CALLS)
}

/**
 * 축약 단계 결과에 붙이는 무관 가능성 경고 (Codex 9차 M2).
 *
 * 사다리는 0건을 벗어나려고 어절을 버린다. 버린 어절이 주제어면 남은 검색어가 일반어가 되어 원 질문과
 * 무관한 자료가 헤더 "전체 성공"과 함께 나갔다 ("법인 대표이사 퇴직금 한도 초과액 손금 불산입" →
 * "법인 대표이사": 차량유지비·출장비 예규). fin_article의 같은 상황 경고(article.ts ③ 예규)와 같은 취지다.
 * 법제처 검색은 제목 색인이라, 버린 주제어가 제목에 들어 있는 자료 수를 사실로만 함께 적는다
 * (제목에 없다고 무관하다고 단정하지는 않는다 — "임직원"을 버리고 "경조사비"로 찾은 "직원 경조사비" 예규).
 *
 * @param titles 실제로 표시하는 자료의 제목
 * @returns 경고 문장 (축약하지 않았으면 빈 문자열)
 */
export function ladderWarning(query: string, usedQuery: string, titles: string[]): string {
  const used = new Set(usedQuery.split(/\s+/).filter(Boolean))
  const dropped = [
    ...new Set(query.split(/\s+/).filter((t) => t && !RULING_STOPWORDS.has(t) && !used.has(t))),
  ]
  if (dropped.length === 0) return ""
  const list = dropped.map((t) => `"${t}"`).join(", ")
  const topicWords = dropped.filter((t) => isCoreWord(t) && !RULING_SUBJECT.has(t))
  if (topicWords.length === 0) {
    return `⚠ 검색어 축약으로 빠진 어절: ${list} — 쟁점이 다른 자료가 섞일 수 있습니다. 제목을 확인하세요`
  }
  const compact = (s: string) => s.replace(/\s+/g, "")
  const hit = titles.filter((title) => topicWords.some((w) => compact(title).includes(w))).length
  return (
    `⚠ 검색어 축약으로 빠진 어절: ${list} — 원 질문과 무관한 자료가 섞일 수 있습니다 ` +
    `(빠진 주제어가 제목에 있는 자료 ${hit}/${titles.length}건). 제목을 확인하고 맞는 것만 근거로 쓰세요`
  )
}

/** 국세청 예규 상세 화면 — nts-body.ts가 본문을 받아오는 URL과 같은 형식 */
const NTS_DETAIL_URL_PREFIX = "https://taxlaw.nts.go.kr/qt/USEQTA002P.do?ntstDcmId="

/**
 * 법제처 공개 열람 URL — 상세링크의 `ID=` 값으로 조립한다.
 * - precInfoP: 판례 본문이 그대로 실려 온다 (2026-09-05 curl: precSeq=613989 → 34KB)
 * - expcInfoP: 해석례 제목까지 확인 (2026-09-05 curl: expcSeq=343221)
 * - specialDeccInfoP: 파라미터가 `specialDeccSeq` + `trbClsCd`다 (2026-09-16 curl, Codex 9차 M1).
 *   종전 `deccSeq=`는 실존 ID(947374·183014·111136)도 없는 ID와 같은 6,303B 빈 셸을 줬다 — "200"은
 *   열린다는 증거가 아니었다. 고친 URL은 세 건 모두 71~83KB에 제목이 사건명과 일치했고, 없는 ID
 *   (999999999)는 5,278B "오류페이지"로 갈린다. `trbClsCd`를 빼거나 360102로 주면 오류페이지다.
 *   360101은 열람 페이지 스크립트가 "/조세심판재결례/"로 매핑하는 심판기관 코드이고, DRF 상세 HTML
 *   (target=ttSpecialDecc)이 세 건 모두 이 값으로 열람 URL을 싣는다 — 이 도구의 재결례는 전부
 *   조세심판원(ttSpecialDecc)이라 고정값이다
 */
const LAW_VIEWER_QUERY: Record<Exclude<Domain, "nts">, string> = {
  precedent: "precInfoP.do?precSeq=",
  interpretation: "expcInfoP.do?expcSeq=",
  tax_tribunal: "specialDeccInfoP.do?trbClsCd=360101&specialDeccSeq=",
}

/**
 * 결과 항목에 실을 원문 링크. 조립할 수 없으면 빈 문자열 — 호출부가 "링크 없음(ID 미확인)"으로 적는다.
 *
 * - 국세청 예규: 상세링크가 이미 taxlaw 절대 URL이다. ntstDcmId가 있으면 fin_nts_ruling이 본문을
 *   받아오는 주소와 같은 형식으로 정규화하고, 없으면 받은 절대 URL을 그대로 쓴다.
 * - 법제처 3종(재결례·해석례·판례): 상세링크는 `/DRF/lawService.do?OC=<키>&target=…&ID=…` 형태로
 *   **인증키가 실려 온다** (2026-09-05 실측 확인). 이 링크는 어떤 형태로도 출력에 싣지 않는다 —
 *   마스킹해서 실으면 키는 막히지만 열리지 않는 링크가 남는다. `ID=` 값만 뽑아 공개 열람 URL로 바꾼다.
 *
 * ⚠ 마지막 방어로 maskSensitiveUrl을 한 번 더 통과시킨다. 조립 경로가 바뀌어도 인증키가 출력에
 *   섞이는 일만은 없어야 한다 (회귀 테스트: 출력에 `OC=` 부재).
 */
function detailUrl(item: UnifiedItem): string {
  if (item.domain === "nts") {
    if (item.docId) return `${NTS_DETAIL_URL_PREFIX}${item.docId}`
    return item.link.startsWith("http") ? maskSensitiveUrl(unescapeXmlAmp(item.link)) : ""
  }
  if (!item.link) return ""
  // &amp;를 먼저 되돌려야 `&ID=`가 파라미터 경계로 잡힌다
  const id = (unescapeXmlAmp(item.link).match(/[?&]ID=(\d+)/i) || [])[1]
  if (!id) return ""
  return maskSensitiveUrl(`${getLawSiteBaseUrl()}/LSW/${LAW_VIEWER_QUERY[item.domain]}${id}`)
}

/**
 * XML 본문의 `&amp;`를 `&`로 되돌린다.
 * 상세링크는 쿼리 파라미터가 여러 개라 XML 규격상 `&`가 `&amp;`로 실려 온다. 되돌리지 않으면
 * `ID=` 앞이 `;`가 되어 파라미터 경계로 잡히지 않고, 절대 URL을 그대로 쓰는 경로에서는
 * `amp;target`이라는 없는 파라미터가 생긴다. 이미 `&`로 온 응답에는 아무 영향이 없다.
 */
function unescapeXmlAmp(url: string): string {
  return url.replace(/&amp;/g, "&")
}

/**
 * 도메인별 검색 — 0건이면 양끝을 번갈아 깎아 단계적으로 축약한다 (최대 4회 호출).
 *
 * ⚠ 다음 단계로 넘어가는 조건은 "정상 조회 결과 0건" 하나뿐이다. 오류·타임아웃·429는
 *   throw되어 catch로 빠지며 절대 재시도하지 않는다 — 오류를 0건으로 위장하면 호출측이
 *   "그런 해석 없음"으로 단정한다 (이 저장소의 최악 결함).
 * ⚠ 기준일이 있으면 법제처 기간 검색으로 받으므로, 0건은 "기준일 이전 범위에 0건"이다.
 *   반대로 결과는 왔는데 로컬 일자 대조로 전부 걸러졌다면 기간 검색이 적용되지 않은 응답이다 —
 *   그 검색어에 자료가 있다는 사실은 확인됐으므로 사다리를 더 내려가지 않는다.
 */
async function searchDomain(
  apiClient: LawApiClient,
  domain: Domain,
  query: string,
  basisYmd?: string
): Promise<
  SectionResult & {
    items?: UnifiedItem[]
    usedQuery?: string
    /** 실제로 시도할 수 있었던 축약 사다리 전체 (0건 보고용) */
    ladder?: string[]
    /** 결과를 낸(또는 마지막으로 시도한) 사다리 단계. 0 = 원 검색어 */
    ladderStep?: number
    excludedByBasis?: number
    /** 법제처 검색 총건수(totalCnt) — 받은 10건이 아니라 검색에 걸린 전체. **확인된 값만** 싣는다 */
    totalCnt?: number
    /** 총건수를 확인하지 못한 사유 — 있으면 totalCnt는 없다 (둘 중 하나만 성립한다) */
    totalCntNote?: string
    /** 이번 응답으로 받은 항목 수 (중복 제거 전) — 총건수가 미확인이어도 이 수는 우리가 센 사실이다 */
    received?: number
    /** 표시 목록을 "최신순"이라 부를 수 있는가 — 전체를 다 받았거나 받은 순서가 일자 내림차순 */
    latestFirst?: boolean
    /** 검색 총건수를 전부 받았는가 — "목록 밖" 문구를 붙일지 가른다 */
    allReturned?: boolean
    /** 받은 항목 중 일자를 읽을 수 없어 순서를 확인하지 못한 건수 */
    undated?: number
  }
> {
  const queries = buildLadder(query)
  const conf = DOMAIN_SEARCH[domain]
  try {
    for (let step = 0; step < queries.length; step++) {
      const q = queries[step]
      let items: UnifiedItem[] = []
      const xml = await apiClient.fetchApi({
        endpoint: "lawSearch.do",
        target: conf.target,
        type: "XML",
        extraParams: {
          query: q,
          display: "10",
          sort: LATEST_FIRST_SORT,
          ...(basisYmd ? { [conf.dateRange]: `19000101~${basisYmd}` } : {}),
        },
        expectedRoot: conf.root,
      })
      const totalCnt = readTotalCnt(xml)
      if (domain === "nts") {
        items = parseNtsRulings(xml, 10).map((r) => ({
          domain,
          docNo: r.docNo,
          date: normDate(r.date),
          dateDisplay: r.date,
          title: r.title,
          docId: (r.link.match(/ntstDcmId=(\d+)/) || [])[1] || "",
          link: r.link,
        }))
      } else if (domain === "tax_tribunal") {
        items = parseTaxTribunalXML(xml).items.map((r) => ({
          domain,
          docNo: r.청구번호,
          date: normDate(r.의결일자 || r.처분일자),
          dateDisplay: r.의결일자 || r.처분일자,
          title: r.사건명,
          docId: r.특별행정심판재결례일련번호,
          link: r.행정심판재결례상세링크,
        }))
      } else if (domain === "interpretation") {
        items = parseInterpretationXML(xml).items.map((r) => ({
          domain,
          docNo: r.법령해석례번호,
          date: normDate(r.회신일자),
          dateDisplay: r.회신일자,
          title: r.안건명,
          docId: r.법령해석례일련번호,
          link: r.법령해석례상세링크,
        }))
      } else {
        items = parsePrecedentXML(xml).items.map((r) => ({
          domain,
          docNo: r.사건번호,
          date: normDate(r.선고일자),
          dateDisplay: r.선고일자,
          title: `${r.판례명}${r.법원명 ? ` [${r.법원명}]` : ""}`,
          docId: r.판례일련번호,
          link: r.판례상세링크,
        }))
      }
      if (items.length > 0) {
        // "최신순"이라 부를 근거 — 전부 받았고 일자를 전부 읽었거나, 받은 순서가 일자 내림차순이다.
        // 둘 다 아니면 받은 10건 안의 재정렬일 뿐이라 더 최신 자료가 목록 밖에 있을 수 있다.
        // 판정은 **중복 제거·기준일 필터 전의 받은 순서**로 한다 — 정렬 파라미터가 먹혔는지는
        // 법제처가 준 그 순서에만 남아 있다
        const order = assessLatestFirst(items.map((i) => i.date), totalCnt)
        // 병합사건 등 문서번호 중복 제거 (베이스라인 관찰 6)
        const seen = new Set<string>()
        const deduped = items.filter((i) => {
          const key = i.docNo || i.docId || i.title
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
        // 일자 내림차순 재정렬 — 법제처가 이미 정렬해 줬으면 순서가 바뀌지 않는다
        deduped.sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0))
        // 기준일 대조는 상위 5건 자르기 **전에** 한다 — 뒤에 하면 상위가 전부 기준일 이후일 때
        // 실제로는 있는 과거 자료가 0건으로 보인다. 정상이면 기간 검색이 이미 걸러 와서 제외 0건이고,
        // 제외가 생기면 법제처가 기간 파라미터를 무시한 응답이다 (일자 미상은 남기고 아래에서 고지)
        let excludedByBasis = 0
        let filtered = deduped
        if (basisYmd) {
          filtered = deduped.filter((i) => {
            // 일자 미상·달력에 없는 일자는 버리지 않는다 — 대조 못 한 사실은 아래에서 고지한다
            // (정렬 판정과 같은 잣대를 쓴다: 믿을 수 없는 일자로 자료를 제외하지 않는다)
            if (!isSortableDate(i.date)) return true
            const keep = i.date <= basisYmd
            if (!keep) excludedByBasis++
            return keep
          })
        }
        // 표시 상한을 넘긴 분량은 조용히 버리지 않고 건수를 고지한다 (`검색 N건 중 최신 M건 표시`)
        // 총건수를 확인하지 못한 응답은 undefined로 넘긴다 — 받은 건수를 "검색 N건"이라 부르지 않는다.
        // 종전 Math.max(totalCnt, 받은 수)는 totalCnt 2 / 수신 3을 "검색 3건"으로 지어냈다
        const unconfirmed = totalCntNote(totalCnt, items.length)
        return {
          status: "성공",
          text: "",
          items: filtered.slice(0, MAX_ITEMS_PER_DOMAIN),
          usedQuery: q,
          ladder: queries,
          ladderStep: step,
          excludedByBasis,
          totalCnt: unconfirmed === undefined ? totalCnt : undefined,
          totalCntNote: unconfirmed,
          received: items.length,
          latestFirst: order.latestFirst,
          allReturned: order.allReturned,
          undated: order.undated,
        }
      }
    }
    // 사다리 전 단계가 정상 조회 0건 — 축약으로는 더 넓힐 수 없다는 사실을 그대로 넘긴다
    return {
      status: "성공",
      text: "",
      items: [],
      usedQuery: queries[queries.length - 1],
      ladder: queries,
      ladderStep: queries.length - 1,
    }
  } catch (e) {
    return failed(e instanceof Error ? e.message : String(e))
  }
}

export async function handleFinRulingSearch(
  apiClient: LawApiClient,
  rawInput: unknown
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const parsed = FinRulingSearchInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    return {
      content: [{ type: "text", text: `[INVALID_PARAMETER] fin_ruling_search: ${parsed.error.issues.map((i) => i.message).join("; ")}` }],
      isError: true,
    }
  }
  const { query, domains, basis_date } = parsed.data
  const basisYmd = basis_date ? basis_date.replace(/-/g, "") : undefined

  const results = await Promise.all(
    domains.map((d) => searchDomain(apiClient, d, query, basisYmd).then((r) => ({ domain: d, r })))
  )

  const failedDomains = results.filter(({ r }) => r.status !== "성공")
  const okDomains = results.filter(({ r }) => r.status === "성공")
  const totalHits = okDomains.reduce((n, { r }) => n + (r.items?.length || 0), 0)

  // 전 도메인 실패는 "부분 성공"이 아니다 — 성공한 도메인이 하나도 없는데 부분 성공으로 쓰면
  // 호출측이 나머지 도메인은 조회됐고 결과만 없었다고 읽는다 (Codex 제품 검토 2026-09-05)
  const failedList = failedDomains
    .map(({ domain, r }) => `${DOMAIN_LABEL[domain]}(${r.reason})`)
    .join(", ")
  // 조회 성공과 "원 질문에 맞는 결과"는 다르다 — 축약 검색어로 찾은 도메인이 있으면 헤더에서부터 밝힌다
  // (Codex 9차 M2: 주제어를 버린 일반어 결과가 "전체 성공" 헤더만 달고 나갔다)
  const abbreviated = okDomains.some(({ r }) => (r.items?.length ?? 0) > 0 && (r.ladderStep ?? 0) > 0)
  const overall =
    (failedDomains.length === 0
      ? "전체 성공"
      : okDomains.length === 0
        ? `전체 실패 — 실패: ${failedList}`
        : `부분 성공 — 실패: ${failedList}`) + (abbreviated ? " · ⚠ 축약 검색어 결과 포함(도메인별 경고 확인)" : "")

  /**
   * 도메인당 표시 건수(cap)를 받아 본문을 조립한다.
   *
   * 항목 줄마다 원문 링크가 붙어 4곳 × 5건이면 예산 4,000자에 근접한다. 뒤에서 통짜로 잘리면
   * 마지막 도메인이 통째로 사라지므로(조용한 절단), 예산을 넘을 때는 cap을 낮춰 **건수 고지와 함께**
   * 줄인다 — 아래 호출부에서 cap을 5→1로 내리며 예산 안에 드는 첫 결과를 쓴다.
   */
  const buildText = (cap: number): string => {
    let text = basis_date
      ? `[기준일: ${basis_date}까지] 통합 해석·결정례 검색 — "${query}" · ${overall}\n※ 법제처 기간 검색(회신·의결·선고일 ≤ 기준일)으로 조회하고 받은 일자를 다시 대조했습니다 (일자가 비어 있는 자료는 기간 검색에서 빠질 수 있음)\n`
      : `[기준: 현행] 통합 해석·결정례 검색 — "${query}" · ${overall}\n`
    // 0건 문구의 범위 — 기준일 조회의 0건은 "기준일 이전 범위에" 없다는 뜻이지 자료 자체가 없다는 뜻이 아니다
    const zeroScope = basis_date ? `기준일 이전 범위에서 ` : ""

    for (const { domain, r } of okDomains) {
      const label = DOMAIN_LABEL[domain]
      const items = r.items || []
      // 몇 단 축약했는지 밝힌다 — 2단 이상이면 원 질문과 검색어가 크게 달라져 결과 해석이 바뀐다.
      // 판정은 단계 번호로 한다 — 문자열 비교는 공백만 다른 원 질의에도 "축약"을 붙였다 (Codex 9차)
      const step = r.ladderStep ?? 0
      const ladderNote =
        step > 0 ? (step >= 2 ? ` (검색어 축약 ${step}단: "${r.usedQuery}")` : ` (검색어 축약: "${r.usedQuery}")`) : ""
      // 로컬 대조로 제외가 생겼다면 법제처가 기간 검색을 적용하지 않은 응답이다 — 받은 10건 밖에
      // 기준일 이전 자료가 더 있을 수 있다
      const basisNote = r.excludedByBasis
        ? ` · 기준일 이후 ${r.excludedByBasis}건 제외(법제처 기간 검색 미적용 응답 — 기준일 이전 자료가 목록 밖에 더 있을 수 있음)`
        : ""
      if (items.length === 0) {
        // 기준일 때문에 비었으면 "자료 없음"과 구분해 표기한다 (조용한 실패 금지)
        if (r.excludedByBasis) {
          text += `\n■ ${label} — 0건${ladderNote} (검색된 ${r.excludedByBasis}건이 모두 기준일 이후 — 법제처 기간 검색이 적용되지 않은 응답이라 기준일 이전 자료는 이 목록 밖에 있을 수 있음)\n`
          continue
        }
        // 축약 사다리를 끝까지 내려가고도 0건임을 도메인마다 표시한다.
        // 사다리 검색어 자체는 도메인 전체가 동일하므로 아래에서 한 번만 나열한다 (중복 제거)
        const ladder = r.ladder || []
        const zeroNote =
          ladder.length > 1
            ? ` (축약 ${ladder.length}단계 전부 0건 — ${zeroScope}정상 조회 결과 없음)`
            : ` (${zeroScope}정상 조회 결과 없음)`
        text += `\n■ ${label} — 0건${zeroNote}\n`
        continue
      }
      // 예산 때문에 줄인 분량도 검색 총건수(totalCnt) 대비로 고지한다 — 받은 10건이 아니라 검색에 걸린 전체.
      // 종전엔 받은 건수를 "검색 N건"이라 적어, totalCnt 163건이 "검색 10건"으로 나갔다 (Codex 9차 L)
      const shown = items.slice(0, cap)
      // 총건수를 확인하지 못했으면 받은 건수 기준으로만 말하고 사유도 함께 적는다
      // (검색 총건수로 부르지 않는다 — 누락·비숫자와 "totalCnt < 받은 건수" 모순은 다른 사실이다)
      const scope =
        r.totalCnt !== undefined
          ? `검색 ${r.totalCnt}건`
          : `받은 ${r.received ?? items.length}건(검색 총건수 미확인${r.totalCntNote ? ` — ${r.totalCntNote}` : ""})`
      const total = r.totalCnt ?? r.received ?? items.length
      let order = "최신순"
      // 총건수가 미확인이면 받은 건을 전부 표시해도 그 사실을 적는다 — 안 적으면 "최신순 3건"만
      // 남아 검색 전체를 본 것처럼 읽힌다 (모순 응답이 조용히 사라지던 자리)
      let countNote =
        total > shown.length ? ` · ${scope} 중 최신 ${shown.length}건 표시` : r.totalCnt === undefined ? ` · ${scope}` : ""
      if (r.latestFirst === false) {
        // 정렬이 확인되지 않았다 — 받은 건 안의 재정렬을 "최신"이라 부르지 않는다.
        // 사유가 둘이라 문구를 가른다: 일자를 못 읽어 순서 확인이 안 된 것과, 목록 밖에 더 최신
        // 자료가 있을 수 있는 것은 다른 사실이다 (전부 받은 응답에 "목록 밖"을 붙이면 거짓)
        order = "일자순"
        const reason = [
          r.undated ? `일자 미상 ${r.undated}건이 있어 받은 순서를 확인하지 못했습니다` : "",
          r.allReturned ? "" : "최신순 미보장(더 최신 자료가 목록 밖에 있을 수 있음)",
        ]
          .filter(Boolean)
          .join(" · ")
        countNote = ` · ${scope} 중 법제처 응답 ${r.received}건만 일자순 정렬${reason ? ` — ${reason}` : ""}`
      }
      // 일자를 못 읽은 자료는 기준일 대조를 **하지 못한 채** 목록에 남긴다 — 그 사실을 도메인 줄에 적는다.
      // 헤더의 "기간 검색에서 빠질 수 있음"은 법제처 쪽 이야기라 로컬 대조를 못 했다는 말이 아니다
      const undatedShown = shown.filter((i) => !isSortableDate(i.date)).length
      const undatedBasisNote =
        basis_date && undatedShown ? ` · 일자 미상 ${undatedShown}건은 기준일 대조를 못 해 그대로 남겼습니다` : ""
      text += `\n■ ${label} [${DOMAIN_AUTHORITY[domain]}] — ${order} ${shown.length}건${countNote}${ladderNote}${basisNote}${undatedBasisNote}\n`
      if (step > 0 && r.usedQuery) {
        const warning = ladderWarning(query, r.usedQuery, shown.map((i) => i.title))
        if (warning) text += `  ${warning}\n`
      }
      text +=
        shown
          .map((i) => {
            // 원문 링크를 항목마다 붙인다 — 없으면 실무자가 내용을 확인할 경로가 없다.
            // 조립 못 한 경우도 조용히 비우지 않고 사유를 적는다 (링크가 원래 없는 자료로 오독 방지)
            const url = detailUrl(i)
            const linkNote = url ? ` · ${url}` : " · 링크 없음(ID 미확인)"
            return `  · ${i.docNo || "(번호없음)"} (${i.dateDisplay}) ${i.title}${linkNote}`
          })
          .join("\n") + "\n"
    }
    for (const { domain, r } of failedDomains) {
      text += `\n■ ${DOMAIN_LABEL[domain]} — ⚠ 조회 실패: ${r.reason} ("없음"이 아니라 확인 불가)\n`
    }

    // 축약 사다리를 끝까지 내려가고도 0건인 도메인이 있으면 실제로 시도한 검색어를 한 줄로 밝힌다.
    // 사다리는 질의어만으로 정해지므로 도메인마다 같다 — 도메인 줄마다 반복하지 않고 여기서 한 번만.
    // 이걸 안 밝히면 실무자가 "그런 해석이 없다"로 단정한다 (실제로는 검색어를 바꿔야 하는 상황)
    const exhausted = okDomains.find(
      ({ r }) => (r.items?.length ?? 0) === 0 && !r.excludedByBasis && (r.ladder?.length ?? 0) > 1
    )
    if (exhausted) {
      const ladder = exhausted.r.ladder || []
      // 다른 도메인은 결과가 있을 수 있으므로 "0건인 도메인은"으로 한정한다
      text += `\n※ 0건인 도메인은 축약 사다리 ${ladder.map((q) => `"${q}"`).join(" → ")} ${ladder.length}단계를 모두 시도한 결과입니다 — 자료가 없다는 뜻이 아니라 검색어를 바꿔야 한다는 뜻입니다 (다른 실무 용어로 재검색${basis_date ? " · 기준일 이후 자료는 기간 검색에서 제외됨" : ""})`
    }

    if (totalHits > 0) {
      text += `\n※ 예규 본문: fin_nts_ruling · 조문 근거: fin_article`
    }
    // 커버 범위를 매번 밝힌다 — 이 4곳이 "전부"가 아님을 모르면 0건을 "그런 해석 없음"으로
    // 단정하게 된다 (법제처 해석·결정례 도메인은 18곳, 여기선 재무 실무 1순위 4곳만 검색)
    const covered = domains.map((d) => DOMAIN_LABEL[d]).join(" · ")
    text += `\n※ 검색 범위: ${covered} (${domains.length}곳). 법제처 해석·결정례 도메인 전체(18곳) 중 재무 실무 1순위만 검색하므로, 0건이 "해석 없음"을 뜻하지 않습니다`
    text += `\n${AUTHORITY_FOOTER}`
    text += `\n\n${SOURCE_FOOTER}`
    return text
  }

  let text = buildText(MAX_ITEMS_PER_DOMAIN)
  for (let cap = MAX_ITEMS_PER_DOMAIN - 1; cap >= 1 && text.length > TEXT_BUDGET; cap--) {
    text = buildText(cap)
  }

  // 전 도메인 실패는 도구 실행 실패다 — 부분 성공과 달리 isError로 표기 (Opus I5: isError 통일)
  const allFailed = okDomains.length === 0 && failedDomains.length > 0
  return {
    content: [{ type: "text", text: truncateWithHint(text, TEXT_BUDGET, "도메인을 좁혀 재검색") }],
    ...(allFailed ? { isError: true as const } : {}),
  }
}
