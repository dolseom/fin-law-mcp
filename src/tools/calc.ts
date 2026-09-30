/**
 * fin_calc — 법정 산식 결정형 계산 (LLM 산수 배제)
 *
 * 세법에 산식이 명문으로 규정된 항목만 코드로 계산한다. LLM이 산수를 하면
 * 계산 실수가 검토서에 실린다 — 결정형 코드 + 계산 과정 + 근거 조문을 함께 반환한다.
 *
 * ⚠ 산식 기준일이 명시된다. 세법은 매년 개정되므로 기준일 이후 개정 여부를
 *   fin_article로 교차 확인하도록 안내한다 (낡은 산식의 조용한 오답 방지).
 */

import { z } from "zod"
import { SOURCE_FOOTER } from "../lib/fin-common.js"

// 산식 기준 (개정 시 이 상수와 골든 테스트를 함께 갱신한다)
const FORMULA_BASIS = "2026-07-01 시행 법인세법 기준"
const BASIS_DEPRECIATION = "2026-02-27 시행 법인세법 시행령 · 2026-07-01 시행 법인세법 시행규칙 별표 4 기준"
const BASIS_DEEMED_INTEREST = "2026-02-27 시행 법인세법 시행령 · 2026-07-01 시행 법인세법 시행규칙 기준"
const BASIS_RETIREMENT_TAX = "2026-07-01 시행 소득세법 · 지방세법 기준"
const BASIS_EXEC_RETIREMENT_INCOME = "2026-07-01 시행 소득세법 기준"

/**
 * 아래 상수 전체를 조문 원문과 대조한 확인일 중 가장 이른 날.
 * 정기 세법개정은 대부분 1월 1일에 시행되므로, 이 날짜 뒤로 1월 1일이 지나면 응답에 경고를 붙인다
 * (staleConstantsNotice). 원문 대조(test/calc-constants-live)를 다시 통과시킨 뒤에만 이 날짜를 올린다.
 */
export const CONSTANTS_CHECKED_ON = "2026-08-25"

// ─────────────────────────────────────────────────────────────────────────────
// 법정 수치 상수 — 값마다 근거 조문과 확인일을 남긴다.
// 확인일 이후 개정되면 조용한 오답이 되므로, 갱신 시 이 블록과 골든 테스트를 함께 고친다.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 감가상각자산의 상각률표 — 법인세법 시행규칙 [별표 4] (제15조제2항 관련)
 * 위임 사슬: 법인세법 시행령 제28조제1항제1호 → 시행규칙 제15조제2항 → 별표 4
 *
 * 값 확인: 2026-08-25 · 법제처 원문 HWP(flSeq=168515323, 2026-07-01 시행)를 직접 파싱해 전량 대조.
 *          외부 교차 확인(26년 0.039/0.109, 29년 0.035/0.099) 일치.
 * 표기: 별표는 "할·분·리"(소수점 3자리)로 적는다 — 예: 정액법 2년 "500" = 0.500.
 *       아래 배열도 별표 지면 그대로 1/1000 단위 정수로 두어 원문과 눈으로 대조되게 한다.
 *
 * ⚠ 정액법 상각률을 1/내용연수로 계산하면 별표와 어긋난다 (26년: 1/26=0.0385 이나 별표는 0.039,
 *   29년: 1/29=0.0345 이나 별표는 0.035). 정률법도 1-0.05^(1/n) 근사와 어긋난다 (4년: 근사 0.527,
 *   별표 0.528). 어떤 경우에도 계산하지 말고 이 표의 값을 쓸 것.
 */
const DEPRECIATION_RATE_TABLE: ReadonlyArray<readonly [number, number, number]> = [
  // [내용연수(년), 정액법 상각률(리), 정률법 상각률(리)]
  [2, 500, 777], [3, 333, 632], [4, 250, 528], [5, 200, 451], [6, 166, 394],
  [7, 142, 349], [8, 125, 313], [9, 111, 284], [10, 100, 259], [11, 90, 239],
  [12, 83, 221], [13, 76, 206], [14, 71, 193], [15, 66, 182], [16, 62, 171],
  [17, 58, 162], [18, 55, 154], [19, 52, 146], [20, 50, 140], [21, 48, 133],
  [22, 46, 128], [23, 44, 123], [24, 42, 118], [25, 40, 113], [26, 39, 109],
  [27, 37, 106], [28, 36, 102], [29, 35, 99], [30, 34, 96], [31, 33, 93],
  [32, 32, 90], [33, 31, 87], [34, 30, 85], [35, 29, 83], [36, 28, 80],
  [37, 27, 78], [38, 27, 76], [39, 26, 74], [40, 25, 73], [41, 25, 71],
  [42, 24, 69], [43, 24, 68], [44, 23, 66], [45, 23, 65], [46, 22, 64],
  [47, 22, 62], [48, 21, 61], [49, 21, 60], [50, 20, 59], [51, 20, 58],
  [52, 20, 56], [53, 19, 55], [54, 19, 54], [55, 19, 54], [56, 18, 53],
  [57, 18, 52], [58, 18, 51], [59, 17, 50], [60, 17, 49],
] as const

const DEPRECIATION_RATES = new Map<number, { straight: number; declining: number }>(
  DEPRECIATION_RATE_TABLE.map(([years, straight, declining]) => [
    years,
    { straight: straight / 1000, declining: declining / 1000 },
  ])
)

/** 정률법 잔존가액 비율 — 법인세법 시행령 제26조제6항 단서 (취득가액의 100분의 5) · 확인 2026-08-25 */
const DECLINING_RESIDUAL_RATIO = 0.05
/** 상각 종료 자산의 비망가액 — 법인세법 시행령 제26조제7항 (취득가액의 5%와 1천원 중 적은 금액) · 확인 2026-08-25 */
const MEMO_VALUE = 1_000

/** 당좌대출이자율 — 법인세법 시행규칙 제43조제2항 "연간 1,000분의 46" · 확인 2026-08-25 */
const OVERDRAFT_LOAN_RATE = 0.046

/**
 * 부당행위계산부인 적용 최소기준 — 법인세법 시행령 제88조제3항 · 확인 2026-08-25
 * "시가와 거래가액의 차액이 3억원 이상이거나 시가의 100분의 5에 상당하는 금액 이상인 경우에 한하여 적용"
 * (같은 항이 제1항제6호 = 금전을 무상·저리로 대부한 경우를 포함한다)
 */
const UNFAIR_ACT_THRESHOLD_ABS = 300_000_000
const UNFAIR_ACT_THRESHOLD_RATIO = 0.05

/**
 * 근속연수공제 — 소득세법 제48조제1항제1호 · 확인 2026-08-25
 * [근속연수 상한(초과 시 다음 구간), 기본공제액, 상한 초과분에 대한 연간 가산액]
 */
const SERVICE_YEARS_DEDUCTION: ReadonlyArray<{ upTo: number; base: number; perYear: number; from: number }> = [
  { upTo: 5, base: 0, perYear: 1_000_000, from: 0 },            // 5년 이하: 100만원 × 근속연수
  { upTo: 10, base: 5_000_000, perYear: 2_000_000, from: 5 },   // 5년 초과 10년 이하: 500만원 + 200만원 × (n-5)
  { upTo: 20, base: 15_000_000, perYear: 2_500_000, from: 10 }, // 10년 초과 20년 이하: 1,500만원 + 250만원 × (n-10)
  { upTo: Infinity, base: 40_000_000, perYear: 3_000_000, from: 20 }, // 20년 초과: 4,000만원 + 300만원 × (n-20)
]

/**
 * 환산급여공제 — 소득세법 제48조제1항제2호 · 확인 2026-08-25
 * [구간 상한, 구간 시작 공제액, 구간 초과분 공제율]
 */
const CONVERTED_PAY_DEDUCTION: ReadonlyArray<{ upTo: number; base: number; rate: number; from: number }> = [
  { upTo: 8_000_000, base: 0, rate: 1.0, from: 0 },                    // 800만원 이하: 전액
  { upTo: 70_000_000, base: 8_000_000, rate: 0.6, from: 8_000_000 },   // 800만~7천만: 800만 + 초과분 60%
  { upTo: 100_000_000, base: 45_200_000, rate: 0.55, from: 70_000_000 }, // 7천만~1억: 4,520만 + 초과분 55%
  { upTo: 300_000_000, base: 61_700_000, rate: 0.45, from: 100_000_000 }, // 1억~3억: 6,170만 + 초과분 45%
  { upTo: Infinity, base: 151_700_000, rate: 0.35, from: 300_000_000 },   // 3억 초과: 1억5,170만 + 초과분 35%
]

/**
 * 종합소득 기본세율 — 소득세법 제55조제1항 · 확인 2026-08-25
 * 퇴직소득에도 같은 세율을 적용한다 (같은 조 제2항제1호).
 * [과세표준 상한, 누진공제 방식의 기본세액, 초과분 세율]
 */
const INCOME_TAX_BRACKETS: ReadonlyArray<{ upTo: number; base: number; rate: number; from: number }> = [
  { upTo: 14_000_000, base: 0, rate: 0.06, from: 0 },
  { upTo: 50_000_000, base: 840_000, rate: 0.15, from: 14_000_000 },
  { upTo: 88_000_000, base: 6_240_000, rate: 0.24, from: 50_000_000 },
  { upTo: 150_000_000, base: 15_360_000, rate: 0.35, from: 88_000_000 },
  { upTo: 300_000_000, base: 37_060_000, rate: 0.38, from: 150_000_000 },
  { upTo: 500_000_000, base: 94_060_000, rate: 0.40, from: 300_000_000 },
  { upTo: 1_000_000_000, base: 174_060_000, rate: 0.42, from: 500_000_000 },
  { upTo: Infinity, base: 384_060_000, rate: 0.45, from: 1_000_000_000 },
]

/**
 * 개인지방소득세 비율 — 지방세법 제92조제1항·제4항 · 확인 2026-08-25
 * 지방세법은 별도 세율표(1천분의 6 ~ 1천분의 45)를 같은 과세표준에 적용하는데, 그 표가
 * 소득세법 제55조제1항 세율과 누진기초세액 모두 정확히 1/10이라 결과가 산출세액의 10%와 같다.
 * ⚠ 표준세율이므로 지자체가 조례로 ±50% 범위에서 가감할 수 있다 (같은 조 제2항).
 */
const LOCAL_INCOME_TAX_RATIO = 0.1

/**
 * 소액 부징수 기준 — 소득세법 제86조제1호 · 확인 2026-09-04
 * 제127조제1항 각 호의 소득(퇴직소득은 같은 항 제7호)에 대한 원천징수세액이 1천원 미만이면
 * 징수하지 아니한다. 이자소득·일부 사업소득만 제외 대상이므로 퇴직소득에는 그대로 적용된다.
 * ⚠ 기준은 지급 시점의 **원천징수세액**(기납부세액·IRP 과세이연 조정 후 차감원천징수세액)이지
 * 산출세액이 아니다. 이 도구는 조정분을 입력받지 않으므로 부징수를 확정하지 못한다.
 */
const MINIMUM_WITHHOLDING = 1_000

/**
 * 국고금 끝수 계산 — 국고금 관리법 제47조 · 확인 2026-09-04
 *   ① 국고금의 수입·지출에서 10원 미만의 끝수는 계산하지 아니하고, 전액이 10원 미만이면 그 전액을 계산하지 아니한다
 *   ② 국세의 과세표준액을 산정할 때 1원 미만의 끝수가 있으면 이를 계산하지 아니한다
 * 개인지방소득세도 같은 규정을 준용한다 (지방세기본법 제59조 — "국고금"을 "지방자치단체의 징수금"으로 본다).
 *
 * ⚠ 부동소수점 보정: 36,000,000 − 24,800,000.000000004 처럼 정수 경계 **바로 아래**로
 * 계산된 값을 그대로 내림하면 1원이 사라진다. 단위의 정수배에 오차 범위로 붙어 있으면
 * 그 정수배로 복원한 뒤 내림한다 (상대 허용오차 1e-9 — 1경 단위에서도 0.01원 미만).
 */
function truncateToUnit(amount: number, unit: number): number {
  if (!Number.isFinite(amount)) return amount
  const quotient = amount / unit
  const nearest = Math.round(quotient)
  if (Math.abs(quotient - nearest) < 1e-9 * Math.max(1, Math.abs(nearest))) return nearest * unit
  return Math.floor(quotient) * unit
}

/** 국세 과세표준의 1원 미만 끝수 절사 — 국고금 관리법 §47② */
export function truncateTaxBase(amount: number): number {
  return truncateToUnit(amount, 1)
}

/**
 * 징수·납부 세액의 10원 미만 끝수 절사 — 국고금 관리법 §47①
 * (지방세는 지방세기본법 §59가 같은 조를 준용한다)
 * 전액이 10원 미만이면 전액을 계산하지 않으므로 결과는 0이 된다.
 */
export function truncateCollectedTax(amount: number): number {
  return truncateToUnit(amount, 10)
}

// 금액·기간 상한 — 개별 값이 각자 "유효"해도 곱셈(적수·환산급여)에서 부동소수점
// overflow가 나면 ∞·NaN이 isError 없이 확신형 결과로 출력된다 (Codex 4차 중요:
// principal 1e308 → "이자 시가: ∞원" + 익금산입 판정). 이 상한 안에서는 모든 산식의
// 중간·최종값이 유한하다 (최대 곱: 적수 1e16 × 36,600 ≈ 3.7e20 ≪ Number.MAX_VALUE)
const MAX_AMOUNT = 1e16 // 1경 원 — 현실 기업 규모를 넉넉히 초과
/**
 * 임원 퇴직소득 한도 — 소득세법 제22조제3항 계산식 · 확인 2026-09-30
 *   2012.1.1~2019.12.31 근무기간분: 2019.12.31부터 소급 3년 총급여 연평균환산액 × 1/10 × 근무월수/12 × 3
 *   2020.1.1 이후 근무기간분:       퇴직일부터 소급 3년 총급여 연평균환산액 × 1/10 × 근무월수/12 × 2
 * 근무기간은 개월 수, 1개월 미만은 1개월 (같은 조 제4항제1호)
 */
const EXEC_INCOME_RATIO = 0.1
const EXEC_INCOME_MULTIPLIER_2012_2019 = 3
const EXEC_INCOME_MULTIPLIER_FROM_2020 = 2
/** 2012.1.1~2019.12.31의 개월 수 — 그 구간 근무월수의 상한 */
const MONTHS_2012_2019 = 96

const MAX_DAYS = 36_600 // 100년
const amountMax = (f: string) => `${f}는 1경(1e16) 원 이하여야 합니다 — 입력 단위(원)를 확인하세요`

export const FinCalcInputSchema = z.discriminatedUnion("calc_type", [
  z.object({
    calc_type: z.literal("임원퇴직금한도"),
    annual_salary: z.number().positive("annual_salary(총급여액)는 0보다 커야 합니다").max(MAX_AMOUNT, amountMax("annual_salary(총급여액)")).describe("퇴직 직전 1년 총급여액 (원) — 손금불산입 상여·비과세소득 제외액"),
    years: z.number().int("years(근속 연수)는 정수여야 합니다").min(0, "years(근속 연수)는 0 이상이어야 합니다").max(100, "years(근속 연수)는 100 이하여야 합니다").describe("근속 연수 (년 단위 정수)"),
    months: z.number().int("months(잔여 개월)는 정수여야 합니다").min(0, "months(잔여 개월)는 0 이상이어야 합니다").max(11, "months(잔여 개월)는 11 이하여야 합니다").default(0).describe("1년 미만 잔여 개월 수 (1개월 미만 절사)"),
  }),
  z.object({
    calc_type: z.literal("임원퇴직소득한도"),
    // 두 구간 월수는 기본값을 두지 않는다 — 생략이 곧 "그 구간 근무 없음"이 되면 한도가 조용히 줄어든다
    months_2012_2019: z.number().int("months_2012_2019(근무 월수)는 정수여야 합니다").min(0, "months_2012_2019(근무 월수)는 0 이상이어야 합니다").max(MONTHS_2012_2019, "months_2012_2019(근무 월수)는 96개월(2012.1~2019.12) 이하여야 합니다").describe("2012.1.1~2019.12.31 근무 월수 (1개월 미만은 1개월)"),
    months_since_2020: z.number().int("months_since_2020(근무 월수)는 정수여야 합니다").min(0, "months_since_2020(근무 월수)는 0 이상이어야 합니다").max(1200, "months_since_2020(근무 월수)는 1,200개월(100년) 이하여야 합니다").describe("2020.1.1~퇴직일 근무 월수 (1개월 미만은 1개월)"),
    avg_salary_to_2019: z.number().min(0, "avg_salary_to_2019(연평균 총급여)는 0 이상이어야 합니다").max(MAX_AMOUNT, amountMax("avg_salary_to_2019(연평균 총급여)")).optional().describe("2019.12.31부터 소급 3년 총급여의 연평균환산액 (원)"),
    avg_salary_last3y: z.number().min(0, "avg_salary_last3y(연평균 총급여)는 0 이상이어야 합니다").max(MAX_AMOUNT, amountMax("avg_salary_last3y(연평균 총급여)")).optional().describe("퇴직일부터 소급 3년 총급여의 연평균환산액 (원)"),
    severance_income: z.number().min(0, "severance_income(퇴직소득금액)은 0 이상이어야 합니다").max(MAX_AMOUNT, amountMax("severance_income(퇴직소득금액)")).optional().describe("퇴직소득금액 (원, 비과세·공적연금 일시금 제외) — 주면 근로소득 초과분까지 계산"),
    months_before_2012: z.number().int("months_before_2012(근무 월수)는 정수여야 합니다").min(0, "months_before_2012(근무 월수)는 0 이상이어야 합니다").max(1200, "months_before_2012(근무 월수)는 1,200개월(100년) 이하여야 합니다").optional().describe("2011.12.31 이전 근무 월수 — severance_income을 주면 필수"),
    pre2012_amount: z.number().min(0, "pre2012_amount(2011년 말 퇴직 가정 금액)는 0 이상이어야 합니다").max(MAX_AMOUNT, amountMax("pre2012_amount(2011년 말 퇴직 가정 금액)")).optional().describe("2011.12.31 정관 규정에 따른 퇴직소득금액 (그 방식을 선택한 경우)"),
  }),
  z.object({
    calc_type: z.literal("기업업무추진비한도"),
    revenue: z.number().min(0, "revenue(수입금액)는 0 이상이어야 합니다").max(MAX_AMOUNT, amountMax("revenue(수입금액)")).describe("일반 수입금액 (원)"),
    related_party_revenue: z.number().min(0, "related_party_revenue(특수관계인 수입금액)는 0 이상이어야 합니다").max(MAX_AMOUNT, amountMax("related_party_revenue(특수관계인 수입금액)")).default(0).describe("특수관계인 거래 수입금액 (원)"),
    // 기본값을 두면 안 된다 (rate_type과 같은 모양의 결함): 기본한도가 1,200만원 vs 3,600만원(법 §25④1)으로
    // 3배 갈리는데, false를 기본값으로 두면 생략만으로 중소기업의 한도를 낮춘 확정 금액이 근거 조문과 함께
    // 나간다 (매출 30억: 21,000,000원 vs 45,000,000원 — Codex 9차 중요 I3). 누락은 핸들러가 한글로 잡는다
    is_sme: z.boolean().optional().describe("중소기업 여부 (필수, 기본값 없음)"),
    business_months: z.number().int("business_months(월수)는 정수여야 합니다").min(1, "business_months(월수)는 1 이상이어야 합니다").max(12, "business_months(월수)는 12 이하여야 합니다").default(12).describe("사업연도 월수 (기본 12)"),
  }),
  z.object({
    calc_type: z.literal("감가상각비"),
    acquisition_cost: z.number().positive("acquisition_cost(취득가액)는 0보다 커야 합니다").max(MAX_AMOUNT, amountMax("acquisition_cost(취득가액)")).describe("취득가액 (원) — 법인세법 시행령 §72의 취득가액"),
    useful_life: z.number().int("useful_life(내용연수)는 정수여야 합니다").min(2, "useful_life(내용연수)는 2년 이상이어야 합니다 (별표 4 수록 범위)").max(60, "useful_life(내용연수)는 60년 이하여야 합니다 (별표 4 수록 범위)").describe("내용연수 (년) — 별표 4 수록 범위는 2~60년"),
    method: z.enum(["정액법", "정률법"]).describe("상각방법"),
    remaining_value: z.number().min(0, "remaining_value(기초 미상각잔액)는 0 이상이어야 합니다").max(MAX_AMOUNT, amountMax("remaining_value(기초 미상각잔액)")).optional().describe("[정률법 필수] 장부상 기초 미상각잔액 (원) = 취득가액 − 장부상 감가상각누계액"),
    // 정률법의 미상각잔액은 "취득가액에서 이미 감가상각비로 손금에 산입한 금액을 공제한 잔액"이다
    // (시행령 §26②2). 전기까지 상각부인액이 있으면 장부 잔액에 더해야 세무상 잔액이 된다 —
    // 빠지면 상각범위액이 과소 계산된다 (2026-09-30 외부 검토 지적)
    disallowed_depreciation: z.number().min(0, "disallowed_depreciation(상각부인액 누계)는 0 이상이어야 합니다").max(MAX_AMOUNT, amountMax("disallowed_depreciation(상각부인액 누계)")).optional().describe("[정률법] 전기말 상각부인액 잔액 (원, 이후 손금 추인분 차감) — 세무상 미상각잔액 = 장부 잔액 + 이 금액"),
    business_months: z.number().int("business_months(월수)는 정수여야 합니다").min(1, "business_months(월수)는 1 이상이어야 합니다").max(12, "business_months(월수)는 12 이하여야 합니다").default(12).describe("상각 대상 월수 (기본 12). 12 미만이면 short_period_basis로 그 사유를 명시할 것"),
    short_period_basis: z
      .enum(["기중취득", "사업연도변경의제", "사업연도1년미만"])
      .optional()
      .describe(
        "[business_months < 12일 때 필수] 1년 미만 월수의 사유 — 산식이 다르다: " +
          "기중취득·사업연도변경의제(법 §7·§8)는 월할(시행령 §26⑧⑨), " +
          "사업연도1년미만(법 §6의 사업연도 자체가 1년 미만)은 환산내용연수 상각률(시행령 §28②)"
      ),
  }),
  z.object({
    calc_type: z.literal("가지급금인정이자"),
    balance_days: z.number().min(0, "balance_days(적수)는 0 이상이어야 합니다").max(MAX_AMOUNT * MAX_DAYS, "balance_days(적수)는 3.66e20(1경 원 × 100년) 이하여야 합니다 — 입력 단위(원×일)를 확인하세요").optional().describe("가지급금 적수 (원×일) — principal·days 대신 직접 입력"),
    principal: z.number().min(0, "principal(가지급금 잔액)은 0 이상이어야 합니다").max(MAX_AMOUNT, amountMax("principal(가지급금 잔액)")).optional().describe("가지급금 잔액 (원) — days와 함께 쓰면 적수를 계산한다"),
    days: z.number().int("days(대여 일수)는 정수여야 합니다").min(0, "days(대여 일수)는 0 이상이어야 합니다").max(MAX_DAYS, "days(대여 일수)는 36,600일(100년) 이하여야 합니다").optional().describe("대여 일수 (일) — 발생 초일 산입, 회수일 제외"),
    // 기본값을 두면 안 된다: 법인세법 시행령 §89③ 본문은 **가중평균차입이자율이 시가**이고
    // 당좌대출이자율은 단서 각 호(적용 불가 사유·5년 초과 대여·신고 선택)의 예외다.
    // 예외를 기본값으로 두면 사용자가 생략했을 때 법정 원칙과 반대인 4.6%로 확정 금액이
    // 나가고, weighted_average_rate를 줘도 무시된다 (Codex 리뷰 차단 1)
    rate_type: z.enum(["당좌대출이자율", "가중평균차입이자율"]).optional().describe("적용 이자율 종류 (필수) — 원칙은 가중평균차입이자율(시행령 §89③ 본문)"),
    weighted_average_rate: z.number().min(0, "weighted_average_rate(이자율)는 0 이상이어야 합니다").max(100, "weighted_average_rate(이자율)는 100 이하로, %단위로 입력하세요 (예: 9 = 연 9%)").optional().describe("[가중평균차입이자율 선택 시 필수] 연 이자율을 %로 (예: 9 = 연 9%)"),
    paid_interest: z.number().min(0, "paid_interest(수령 약정이자)는 0 이상이어야 합니다").max(MAX_AMOUNT, amountMax("paid_interest(수령 약정이자)")).default(0).describe("실제 수령한 약정이자 (원, 기본 0)"),
    is_leap_year: z.boolean().default(false).describe("윤년 여부 — true면 366일로 나눈다 (기본 false=365일)"),
  }),
  z.object({
    calc_type: z.literal("퇴직소득세"),
    severance_pay: z.number().min(0, "severance_pay(퇴직소득금액)는 0 이상이어야 합니다").max(MAX_AMOUNT, amountMax("severance_pay(퇴직소득금액)")).describe("퇴직소득금액 (원) = 퇴직급여액 − 비과세 퇴직소득"),
    service_years: z.number().positive("service_years(근속연수)는 0보다 커야 합니다").max(100, "service_years(근속연수)는 100 이하여야 합니다").describe("근속연수 (년) — 1년 미만은 1년으로 올림한다 (소득세법 §48①)"),
  }),
])

export const FIN_CALC_TOOL = {
  name: "fin_calc",
  // 도구 정의는 매 세션 모든 대화에 실린다 — 조문 번호는 응답 본문·오류 메시지가
  // 모두 담고 있으므로 여기서는 도구 **선택**에 필요한 것만 남긴다.
  // "일반 근로자 퇴직금 미지원"은 실제 오용 사례가 있어 남긴다 (시뮬레이션 지적).
  description:
    "[재무·세무·회계 전용 — 법정 한도·세액은 직접 계산하지 말고 이 도구를 사용] " +
    "세법에 명문화된 산식을 결정형 코드로 계산한다 (계산 과정·근거 조문 동봉). " +
    "지원: 임원퇴직금한도(법인세 손금 한도 — 일반 근로자 퇴직금은 미지원), " +
    "임원퇴직소득한도(소득세 한도 — 초과분은 근로소득), " +
    "기업업무추진비한도, 감가상각비 상각범위액, 가지급금인정이자, 퇴직소득세.",
  // properties(평면)와 oneOf(조건부 필수)를 함께 둔다 — 평면 목록만 보면 어떤 인자가
  // 어느 계산에 필수인지 알 수 없어 LLM이 필수 인자를 빠뜨린다. oneOf를 못 읽는
  // 클라이언트도 properties로 종전대로 동작한다 (Codex 리뷰)
  //
  // 속성 설명은 한 줄로 제한한다: 조문 근거·산식 차이·예시는 **핸들러 오류 메시지**가 담는다.
  // 금액 상한(1경·적수 3.66e20)도 JSON Schema에서 뺐다 — 17~21자리 숫자가 그대로
  // 직렬화돼 스키마를 부풀리는데, LLM에게 주는 정보는 없고 zod가 한글 메시지로
  // 거부한다 (회귀 테스트 "severance_pay 1e308도 거부된다"). 의미 있는 정의역
  // (연수 0~100·월 1~12·내용연수 2~60·일수 0~36,600·이자율 0~100)은 그대로 둔다.
  //
  // ⚠ 축약의 예외 둘 — rate_type·short_period_basis는 **유효한 enum 값 중 무엇을 고르느냐**로
  // 결과가 갈리는데(정률법 6개월: 기중취득 22,550,000원 vs 사업연도1년미만 25,900,000원),
  // 무엇을 골라도 유효 입력이라 오류 메시지가 뜨지 않는다. 구별 기준을 스키마에 두지 않으면
  // LLM이 틀린 값을 확신형으로 고른다 (Codex 8차 중요 2). 이 둘만 한 줄 안에서 기준을 밝히고,
  // 조문 인용도 허용한다 (테스트 DISAMBIGUATING_PROPS가 나머지 속성의 축약을 계속 지킨다).
  inputSchema: {
    type: "object",
    properties: {
      calc_type: {
        type: "string",
        enum: ["임원퇴직금한도", "임원퇴직소득한도", "기업업무추진비한도", "감가상각비", "가지급금인정이자", "퇴직소득세"],
        description: "계산 유형",
      },
      annual_salary: { type: "number", exclusiveMinimum: 0, description: "[임원퇴직금한도·필수] 직전 1년 총급여액(원)" },
      years: { type: "integer", minimum: 0, maximum: 100, description: "[임원퇴직금한도·필수] 근속 연수(년)" },
      months: { type: "integer", minimum: 0, maximum: 11, description: "[임원퇴직금한도] 잔여 개월(기본 0)" },
      months_2012_2019: { type: "integer", minimum: 0, maximum: 96, description: "[임원퇴직소득한도·필수] 2012~2019 근무월수" },
      months_since_2020: { type: "integer", minimum: 0, description: "[임원퇴직소득한도·필수] 2020년 이후 근무월수" },
      avg_salary_to_2019: { type: "number", minimum: 0, description: "[임원퇴직소득한도] 2019말 소급3년 연평균급여(원)" },
      avg_salary_last3y: { type: "number", minimum: 0, description: "[임원퇴직소득한도] 퇴직일 소급3년 연평균급여(원)" },
      severance_income: { type: "number", minimum: 0, description: "[임원퇴직소득한도] 퇴직소득금액(원)" },
      months_before_2012: { type: "integer", minimum: 0, description: "[임원퇴직소득한도] 2011년 이전 근무월수" },
      pre2012_amount: { type: "number", minimum: 0, description: "[임원퇴직소득한도] 2011말 정관기준 금액(원)" },
      revenue: { type: "number", minimum: 0, description: "[기업업무추진비한도·필수] 일반 수입금액(원)" },
      related_party_revenue: { type: "number", minimum: 0, description: "[기업업무추진비한도] 특수관계인 수입금액(원, 기본 0)" },
      is_sme: { type: "boolean", description: "[기업업무추진비한도·필수, 기본값 없음] 중소기업 여부" },
      business_months: { type: "integer", minimum: 1, maximum: 12, description: "[기업업무추진비한도·감가상각비] 사업연도·상각 월수(기본 12)" },
      acquisition_cost: { type: "number", exclusiveMinimum: 0, description: "[감가상각비·필수] 취득가액(원)" },
      useful_life: { type: "integer", minimum: 2, maximum: 60, description: "[감가상각비·필수] 내용연수(년)" },
      method: { type: "string", enum: ["정액법", "정률법"], description: "[감가상각비·필수] 상각방법" },
      remaining_value: { type: "number", minimum: 0, description: "[감가상각비·정률법 필수] 장부상 기초 미상각잔액(원)" },
      disallowed_depreciation: { type: "number", minimum: 0, description: "[감가상각비·정률법] 전기말 상각부인액 잔액(원)" },
      short_period_basis: {
        type: "string",
        enum: ["기중취득", "사업연도변경의제", "사업연도1년미만"],
        description:
          "[감가상각비·business_months<12 필수] 기중취득=사업연도 중 취득(월할) · 사업연도변경의제=사업연도 변경으로 그 해만 짧음(월할) · 사업연도1년미만=정관상 사업연도 자체가 1년 미만(환산내용연수, 월할 아님)",
      },
      balance_days: { type: "number", minimum: 0, description: "[가지급금인정이자] 적수(원×일) — principal·days 대신" },
      principal: { type: "number", minimum: 0, description: "[가지급금인정이자] 잔액(원) — days와 함께" },
      days: { type: "integer", minimum: 0, maximum: 36600, description: "[가지급금인정이자] 대여 일수(일)" },
      rate_type: {
        type: "string",
        enum: ["당좌대출이자율", "가중평균차입이자율"],
        description:
          "[가지급금인정이자·필수, 기본값 없음] 가중평균차입이자율=원칙(시행령 §89③ 본문) · 당좌대출이자율=예외(가중평균 적용 불가·대여기간 5년 초과·신고 시 선택, §89③ 단서 각 호) — 근거 없이 당좌대출 선택 금지",
      },
      weighted_average_rate: { type: "number", minimum: 0, maximum: 100, description: "[가지급금인정이자·가중평균 선택 시 필수] 연 이자율(%)" },
      paid_interest: { type: "number", minimum: 0, description: "[가지급금인정이자] 수령 약정이자(원, 기본 0)" },
      is_leap_year: { type: "boolean", description: "[가지급금인정이자] 윤년 여부(기본 false)" },
      severance_pay: { type: "number", minimum: 0, description: "[퇴직소득세·필수] 퇴직소득금액(원, 비과세 제외)" },
      service_years: { type: "number", exclusiveMinimum: 0, maximum: 100, description: "[퇴직소득세·필수] 근속연수(년)" },
    },
    required: ["calc_type"],
    oneOf: [
      {
        properties: { calc_type: { const: "임원퇴직금한도" } },
        required: ["calc_type", "annual_salary", "years"],
      },
      {
        properties: { calc_type: { const: "임원퇴직소득한도" } },
        // 두 구간 월수는 기본값이 없다 — 생략이 "근무 없음"으로 읽혀 한도가 조용히 줄지 않게.
        // 구간별 연평균 급여는 그 구간 월수가 0보다 클 때만 필요해 핸들러가 한글로 잡는다
        required: ["calc_type", "months_2012_2019", "months_since_2020"],
      },
      {
        properties: { calc_type: { const: "기업업무추진비한도" } },
        // is_sme도 런타임 필수다 — rate_type과 같은 이유로 스키마와 실행 계약을 맞춘다
        required: ["calc_type", "revenue", "is_sme"],
      },
      {
        properties: { calc_type: { const: "감가상각비" } },
        required: ["calc_type", "acquisition_cost", "useful_life", "method"],
        // 정률법은 미상각잔액이 없으면 계산 자체가 불가능하다 (정액법은 취득가액 기준이라 불필요)
        anyOf: [
          { properties: { method: { const: "정액법" } }, required: ["method"] },
          { properties: { method: { const: "정률법" } }, required: ["method", "remaining_value"] },
        ],
      },
      {
        properties: { calc_type: { const: "가지급금인정이자" } },
        // rate_type은 런타임에서 필수인데 스키마에 없으면 LLM이 생략 가능하다고 읽고
        // 오류를 받는다 — 스키마와 실행 계약을 맞춘다 (Codex 2차 개선)
        required: ["calc_type", "rate_type"],
        // 적수를 직접 주거나(balance_days) 금액×일수로 주거나 — 둘 중 하나
        anyOf: [
          { required: ["balance_days"] },
          { required: ["principal", "days"] },
        ],
      },
      {
        properties: { calc_type: { const: "퇴직소득세" } },
        required: ["calc_type", "severance_pay", "service_years"],
      },
    ],
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
} as const

const won = (n: number): string => `${Math.floor(n).toLocaleString("ko-KR")}원`
/**
 * 절사 **전** 금액 표시 — 소수가 남아 있으면 두 자리까지 보여 준다.
 * won()은 내림하므로 71,538,461.54원이 71,538,461원으로 찍히고, 그 값들로 쓴 뺄셈이
 * 독자에게는 1원 틀린 식으로 보인다. 절사 근거를 적는 줄에서는 소수를 살려야 검산이 된다.
 * 1e13 이상은 ×100이 배정밀도 안전정수를 넘겨 소수가 무의미해지므로 won()으로 되돌린다.
 */
const wonExact = (n: number): string => {
  if (!Number.isFinite(n) || Number.isInteger(n) || Math.abs(n) >= 1e13) return won(n)
  const rounded = Math.round(n * 100) / 100
  if (Number.isInteger(rounded)) return won(rounded)
  return `${rounded.toLocaleString("ko-KR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}원`
}
/**
 * 이자율·상각률 표시 — 별표/조문 표기와 같은 소수 자리를 유지하되 꼬리 0은 지운다.
 * 소수점이 없을 때 꼬리 0을 지우면 40%가 4%가 되므로, 소수점이 있을 때만 자른다.
 */
const pct = (rate: number, digits = 3): string => {
  const s = (rate * 100).toFixed(digits)
  return `${s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s}%`
}

const CALC_TYPES = ["임원퇴직금한도", "임원퇴직소득한도", "기업업무추진비한도", "감가상각비", "가지급금인정이자", "퇴직소득세"] as const

const EXAMPLES: Record<string, string> = {
  임원퇴직금한도: `{ "calc_type": "임원퇴직금한도", "annual_salary": 120000000, "years": 5, "months": 3 }`,
  임원퇴직소득한도: `{ "calc_type": "임원퇴직소득한도", "months_2012_2019": 96, "months_since_2020": 69, "avg_salary_to_2019": 150000000, "avg_salary_last3y": 200000000, "severance_income": 800000000, "months_before_2012": 24 }`,
  기업업무추진비한도: `{ "calc_type": "기업업무추진비한도", "revenue": 15000000000, "is_sme": false }`,
  감가상각비: `{ "calc_type": "감가상각비", "acquisition_cost": 100000000, "useful_life": 5, "method": "정률법", "remaining_value": 54900000 }`,
  가지급금인정이자: `{ "calc_type": "가지급금인정이자", "principal": 100000000, "days": 365, "rate_type": "가중평균차입이자율", "weighted_average_rate": 5.2 }`,
  퇴직소득세: `{ "calc_type": "퇴직소득세", "severance_pay": 100000000, "service_years": 20 }`,
}

const invalidParam = (detail: string, example: string) => ({
  content: [{ type: "text" as const, text: `[INVALID_PARAMETER] fin_calc: ${detail}\n💡 예: ${example}` }],
  isError: true,
})

/** 임원 퇴직금 손금산입 한도 — 법인세법 시행령 §44④2 (정관·지급규정이 없는 경우) */
export function calcExecutiveSeveranceLimit(annualSalary: number, years: number, months: number) {
  // 근속연수: 1년 미만은 월수로 환산 (1개월 미만 절사 — 법인세법 시행규칙 §22)
  const serviceYears = years + months / 12
  const limit = annualSalary * 0.1 * serviceYears
  return { serviceYears, limit }
}

/**
 * 확인일(CONSTANTS_CHECKED_ON) 뒤로 1월 1일(정기 세법개정 시행일)이 지났으면 경고 줄을 돌려준다.
 * 날짜는 KST로 센다 — UTC 호스트에서 1월 1일 새벽에 하루 늦게 켜지지 않게 (isFutureDate와 같은 방식)
 */
export function staleConstantsNotice(now: number = Date.now()): string[] {
  const todayKst = new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const nextJan1 = `${Number(CONSTANTS_CHECKED_ON.slice(0, 4)) + 1}-01-01`
  if (todayKst < nextJan1) return []
  return [
    `⚠ 산식 상수 확인일(${CONSTANTS_CHECKED_ON}) 이후 정기 세법개정 시행일(${nextJan1})이 지났습니다 — ` +
      `이 계산의 세율·한도·배수가 그 개정을 반영했는지 확인되지 않았습니다. 금액을 쓰기 전에 아래 "근거" 조문을 fin_article로 현행 원문과 대조하세요.`,
    ``,
  ]
}

/**
 * 임원 퇴직소득 한도 — 소득세법 §22③ 계산식
 * 두 구간을 각자의 연평균환산액·배수로 계산해 더한다. 월수는 호출자가 §22④1(1개월 미만은 1개월)대로 센 값
 */
export function calcExecRetirementIncomeLimit(
  avgSalaryTo2019: number,
  months2012To2019: number,
  avgSalaryLast3y: number,
  monthsSince2020: number
) {
  const part2012 = avgSalaryTo2019 * EXEC_INCOME_RATIO * (months2012To2019 / 12) * EXEC_INCOME_MULTIPLIER_2012_2019
  const part2020 = avgSalaryLast3y * EXEC_INCOME_RATIO * (monthsSince2020 / 12) * EXEC_INCOME_MULTIPLIER_FROM_2020
  return { part2012, part2020, limit: part2012 + part2020 }
}

/**
 * 한도 초과분(근로소득으로 보는 금액) — 소득세법 §22③ 단서 + 시행령 §42의2⑥
 * 한도와 비교할 금액 = 퇴직소득금액 − 2011.12.31 퇴직 가정 금액.
 * 가정 금액은 원칙적으로 퇴직소득금액 × 2011년 이전 근무월수 ÷ 전체 근무월수이고,
 * 정관(위임 규정 포함)에 따른 금액을 선택했으면 그 금액이다 (§42의2⑥ 괄호).
 * 전체 근무월수는 세 구간 입력의 합으로 본다 — 입력 구간 밖의 근무기간은 모른다.
 */
export function calcExecRetirementIncomeExcess(
  severanceIncome: number,
  limit: number,
  monthsBefore2012: number,
  months2012To2019: number,
  monthsSince2020: number,
  pre2012Amount?: number
) {
  const totalMonths = monthsBefore2012 + months2012To2019 + monthsSince2020
  const pre2012 =
    pre2012Amount !== undefined ? pre2012Amount : totalMonths > 0 ? (severanceIncome * monthsBefore2012) / totalMonths : 0
  const subject = Math.max(severanceIncome - pre2012, 0)
  const excess = Math.max(subject - limit, 0)
  return { totalMonths, pre2012, subject, excess, retirementPortion: severanceIncome - excess }
}

/** 기업업무추진비 손금산입 한도 — 법인세법 §25④ (수입금액 구간별 누진 적용률) */
export function calcEntertainmentLimit(revenue: number, relatedPartyRevenue: number, isSme: boolean, months: number) {
  const base = (isSme ? 36_000_000 : 12_000_000) * (months / 12)

  // 수입금액 적용률: 100억 이하 0.3% / 100억 초과~500억 이하 0.2% / 500억 초과 0.03%
  const rateAmount = (r: number): number => {
    const b1 = Math.min(r, 10_000_000_000)
    const b2 = Math.min(Math.max(r - 10_000_000_000, 0), 40_000_000_000)
    const b3 = Math.max(r - 50_000_000_000, 0)
    return b1 * 0.003 + b2 * 0.002 + b3 * 0.0003
  }

  // 특수관계인 거래분은 일반분과 합산 계산 후 그 초과 산출분의 10%만 인정 (§25④2 단서)
  const generalAmount = rateAmount(revenue)
  const combinedAmount = rateAmount(revenue + relatedPartyRevenue)
  const relatedAmount = (combinedAmount - generalAmount) * 0.1

  const limit = base + generalAmount + relatedAmount
  return { base, generalAmount, combinedAmount, relatedAmount, limit }
}

/** 1년 미만 월수의 성격 — §26⑧⑨(월할)과 §28②(환산내용연수)는 산식이 다르다 */
export type ShortPeriodBasis = "기중취득" | "사업연도변경의제" | "사업연도1년미만"

/**
 * 감가상각 상각범위액 — 법인세법 시행령 §26·§28 + 시행규칙 별표 4 상각률
 *
 * 정액법(§26②1): 취득가액 × 상각률
 * 정률법(§26②2): 미상각잔액 × 상각률
 * 월할(§26⑧⑨): 사업연도 변경·의제(법 §7·§8)로 그 해만 1년 미만이거나 기중 취득이면 × 월수/12
 * 환산내용연수(§28②): **사업연도 자체(법 §6)가 1년 미만**이면 월할이 아니라
 *   환산내용연수(= 내용연수 × 12 ÷ 사업연도 월수)의 별표 상각률을 쓴다. 정률법에서 두 방식은
 *   결과가 다르다 (6개월 사업연도 2회 = 1-(1-0.259)² = 0.451로 연 상각률과 일치하는 쪽이
 *   환산내용연수 방식 — 월할이면 0.400으로 어긋난다. Opus 리뷰 차단 지적, 실측 -7.5~-22.8%)
 * 정률법 마무리(§26⑥ 단서): 미상각잔액이 최초로 취득가액의 5% 이하가 되는 사업연도에
 *   취득가액의 5%를 상각범위액에 가산한다. 그 결과 미상각잔액을 넘게 되므로 실질적으로
 *   그 해에 비망가액(§26⑦)만 남기고 전액 상각된다.
 */
export function calcDepreciationLimit(
  acquisitionCost: number,
  usefulLife: number,
  method: "정액법" | "정률법",
  remainingValue: number,
  months: number,
  shortBasis?: ShortPeriodBasis
) {
  let effectiveLife = usefulLife
  let converted = false
  let monthRatio = months / 12
  if (months < 12 && shortBasis === "사업연도1년미만") {
    const conv = (usefulLife * 12) / months
    if (!Number.isInteger(conv)) {
      throw new Error(
        `환산내용연수(${usefulLife}년 × 12 ÷ ${months}개월 = ${conv.toFixed(2)}년)가 정수가 아닙니다 — ` +
          `별표 4는 정수 내용연수만 수록하며 이 경우의 처리는 조문에 명문 규정이 없어 계산을 제공하지 않습니다 (추측 금지)`
      )
    }
    if (conv > 60) {
      throw new Error(`환산내용연수 ${conv}년이 별표 4 수록 범위(2~60년)를 벗어나 계산할 수 없습니다`)
    }
    // §28②는 상각률 자체를 바꾸는 방식이라 월할하지 않는다
    effectiveLife = conv
    converted = true
    monthRatio = 1
  }
  const rates = DEPRECIATION_RATES.get(effectiveLife)
  if (!rates) throw new Error(`내용연수 ${effectiveLife}년은 별표 4에 없습니다 (수록 범위 2~60년)`)
  const rate = method === "정액법" ? rates.straight : rates.declining

  const base = method === "정액법" ? acquisitionCost : remainingValue
  const regular = base * rate * monthRatio

  // 정률법 마무리 연도 판정: 이번 상각 후 미상각잔액이 취득가액의 5% 이하로 떨어지는가
  const residual = acquisitionCost * DECLINING_RESIDUAL_RATIO
  const isFinalYear = method === "정률법" && remainingValue - regular <= residual
  // 비망가액은 취득가액의 5%와 1천원 중 적은 금액 (§26⑦) — 실무상 사실상 1천원
  const memoValue = Math.min(residual, MEMO_VALUE)
  const cap = Math.max(remainingValue - memoValue, 0)

  // 미상각잔액이 이미 비망가액 이하면 상각할 것이 없다 — "0원까지 상각 가능" 같은
  // 무의미한 마무리 문구를 만들지 않는다 (Opus 리뷰 개선 8a)
  const alreadyDone = method === "정률법" && remainingValue <= memoValue

  let limit: number
  if (alreadyDone) {
    limit = 0
  } else if (isFinalYear) {
    // §26⑥ 단서의 5% 가산. 가산 결과가 미상각잔액을 넘으므로 비망가액을 남기고 전액 상각된다
    limit = Math.min(regular + residual, cap)
  } else {
    limit = regular
  }

  // 월할 사업연도와 정률법 마무리 연도가 겹치면 조문 해석이 갈린다 (Codex 리뷰 차단 2).
  //   ⑧⑨는 "제1항의 규정을 적용함에 있어서" 상각범위액을 월할하라 하고,
  //   ⑥은 5% 잔존가액을 "그 사업연도의 상각범위액에 가산한다"고만 한다.
  //   ⓐ 가산분은 월할하지 않는다(아래 limit) / ⓑ 가산분까지 포함해 월할한다
  // 조문이 명시하지 않으므로 확정 금액 하나만 내놓지 않는다 — ⓐ만 주면 6개월인데
  // 12개월과 같은 금액이 나오고(월할이 무의미해짐), ⓑ로 단정할 근거도 없다.
  const proratedFinal = !alreadyDone && isFinalYear && monthRatio < 1
  const limitIfAddendProrated = proratedFinal ? Math.min(regular + residual * monthRatio, cap) : undefined

  return {
    rate,
    base,
    regular,
    residual,
    isFinalYear,
    memoValue,
    limit,
    converted,
    effectiveLife,
    alreadyDone,
    proratedFinal,
    limitIfAddendProrated,
  }
}

/**
 * 가지급금 인정이자 — 법인세법 시행령 §89③ (시가) + 시행규칙 §43② (당좌대출이자율 연 4.6%)
 *
 * 이자시가 = 가지급금적수 × 이자율 ÷ 365 (윤년 366)
 * 인정이자(익금산입 대상액) = 이자시가 − 약정이자
 *
 * ⚠ 적수 ÷ 365 라는 계산 구조 자체는 조문 본문이 아니라 법인세법 시행규칙 별지 제19호서식
 *   「가지급금등의 인정이자조정명세서」의 작성 구조다 (서식 목록: 시행규칙 §82①19).
 *   조문이 명문으로 정한 것은 "시가"(= 이자율)이지 일할 계산식이 아니다.
 *   ⚠ 시행규칙 §43⑤는 이 서식을 **지정하는** 조항이 아니다 — "영 제89조제3항제2호에 따라 이자율을
 *   선택하는 경우" 그 서식(갑)의 작성·제출 의무를 정할 뿐이다 (원문 대조 2026-09-16, Codex 9차 부수 관찰)
 */
export function calcDeemedInterest(
  balanceDays: number,
  annualRate: number,
  paidInterest: number,
  isLeapYear: boolean
) {
  const daysInYear = isLeapYear ? 366 : 365
  const marketInterest = (balanceDays * annualRate) / daysInYear
  const deemedInterest = marketInterest - paidInterest

  // 부당행위계산부인 적용 최소기준 (시행령 §88③) — 둘 중 하나만 넘으면 적용된다
  const meetsAbsolute = deemedInterest >= UNFAIR_ACT_THRESHOLD_ABS
  const meetsRatio = deemedInterest >= marketInterest * UNFAIR_ACT_THRESHOLD_RATIO
  const isTaxable = deemedInterest > 0 && (meetsAbsolute || meetsRatio)

  return { daysInYear, marketInterest, deemedInterest, meetsAbsolute, meetsRatio, isTaxable }
}

/** 퇴직소득 근속연수공제 — 소득세법 §48①1 */
export function serviceYearsDeduction(years: number): number {
  const band = SERVICE_YEARS_DEDUCTION.find((b) => years <= b.upTo) ?? SERVICE_YEARS_DEDUCTION[SERVICE_YEARS_DEDUCTION.length - 1]
  return band.base + band.perYear * (years - band.from)
}

/** 환산급여공제 — 소득세법 §48①2 */
export function convertedPayDeduction(convertedPay: number): number {
  const band = CONVERTED_PAY_DEDUCTION.find((b) => convertedPay <= b.upTo) ?? CONVERTED_PAY_DEDUCTION[CONVERTED_PAY_DEDUCTION.length - 1]
  return band.base + (convertedPay - band.from) * band.rate
}

/** 기본세율 적용 — 소득세법 §55① */
export function basicIncomeTax(taxBase: number): { tax: number; rate: number } {
  const band = INCOME_TAX_BRACKETS.find((b) => taxBase <= b.upTo) ?? INCOME_TAX_BRACKETS[INCOME_TAX_BRACKETS.length - 1]
  return { tax: band.base + (taxBase - band.from) * band.rate, rate: band.rate }
}

/**
 * 퇴직소득세 — 소득세법 §48(퇴직소득공제) + §55②(산출세액) + 지방세법 §92①④(지방소득세)
 *
 * ① 근속연수: 1년 미만의 기간이 있으면 1년으로 본다 (§48①) → 올림
 * ② 근속연수공제 (퇴직소득금액에 미달하면 퇴직소득금액이 공제액 — §48②)
 * ③ 환산급여 = (퇴직소득금액 − 근속연수공제) ÷ 근속연수 × 12
 * ④ 환산급여공제 → ⑤ 과세표준 → ⑥ 환산산출세액(기본세율) → ⑦ ÷12 × 근속연수
 *
 * 끝수 처리는 조문이 정한 두 지점에만 적용한다 (국고금 관리법 §47 · 지방세기본법 §59):
 *   · 과세표준 → 1원 미만 절사 (§47②)
 *   · 소득세·개인지방소득세 산출세액 → 10원 미만 절사 (§47①)
 * 환산급여·환산급여공제·환산산출세액의 단계별 절사는 **조문 근거가 없어** 적용하지 않는다.
 * 개인지방소득세는 절사 전 소득세를 기준으로 계산한다 — 지방세법 §92④가 과세표준에서
 * 독립적으로 산출하도록 정하므로, 절사된 소득세에 10%를 곱하면 이중 절사가 된다.
 */
export function calcRetirementIncomeTax(severancePay: number, rawServiceYears: number) {
  const serviceYears = Math.ceil(rawServiceYears)

  const rawDeduction = serviceYearsDeduction(serviceYears)
  // §48② 퇴직소득금액이 근속연수공제에 미달하면 그 퇴직소득금액을 공제액으로 한다 → 환산급여 0
  const yearsDeduction = Math.min(rawDeduction, severancePay)
  const deductionCapped = rawDeduction > severancePay

  const convertedPay = ((severancePay - yearsDeduction) / serviceYears) * 12
  const payDeduction = convertedPayDeduction(convertedPay)
  const untruncatedTaxBase = Math.max(convertedPay - payDeduction, 0)
  const taxBase = truncateTaxBase(untruncatedTaxBase)

  const { tax: convertedTax, rate: appliedRate } = basicIncomeTax(taxBase)
  const untruncatedIncomeTax = (convertedTax / 12) * serviceYears
  const untruncatedLocalTax = untruncatedIncomeTax * LOCAL_INCOME_TAX_RATIO
  const incomeTax = truncateCollectedTax(untruncatedIncomeTax)
  const localTax = truncateCollectedTax(untruncatedLocalTax)

  return {
    serviceYears,
    rawDeduction,
    yearsDeduction,
    deductionCapped,
    convertedPay,
    payDeduction,
    untruncatedTaxBase,
    taxBase,
    appliedRate,
    convertedTax,
    untruncatedIncomeTax,
    incomeTax,
    untruncatedLocalTax,
    localTax,
    total: incomeTax + localTax,
    // 소득세법 제86조제1호 — 원천징수세액이 1천원 미만이면 징수하지 않는다 (세액 0은 해당 없음).
    // §86은 항 없이 호만 있다 — "§86①1"로 적지 말 것 (Codex 9차 E8).
    // ⚠ 이 플래그는 **산출세액**이 1천원 미만이라는 사실만 뜻한다. 부징수 여부의 확정이 아니다
    // — §86 제1호의 기준은 지급 시점의 차감원천징수세액이고 이 도구는 기납부·과세이연 조정분을
    // 입력받지 않는다. 표시 문구를 "징수하지 않습니다"로 되돌리지 말 것 (Codex 8차)
    belowMinimumWithholding: incomeTax > 0 && incomeTax < MINIMUM_WITHHOLDING,
  }
}

export async function handleFinCalc(
  _apiClient: unknown,
  rawInput: unknown
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const parsed = FinCalcInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    // 어떤 인자가 왜 필요한지 한글로 안내한다 — zod 기본 메시지는 영어이고
    // "expected number, received undefined"만으로는 무엇을 채울지 알기 어렵다
    const labels: Record<string, string> = {
      annual_salary: "annual_salary(퇴직 직전 1년 총급여액, 원)",
      years: "years(근속 연수, 년)",
      months: "months(1년 미만 잔여 개월, 0~11)",
      revenue: "revenue(일반 수입금액, 원)",
      related_party_revenue: "related_party_revenue(특수관계인 거래 수입금액, 원)",
      is_sme: "is_sme(중소기업 여부)",
      business_months: "business_months(사업연도 월수, 1~12)",
      acquisition_cost: "acquisition_cost(취득가액, 원)",
      useful_life: "useful_life(내용연수, 2~60년)",
      method: "method(상각방법, \"정액법\" 또는 \"정률법\")",
      remaining_value: "remaining_value(장부상 기초 미상각잔액, 원)",
      disallowed_depreciation: "disallowed_depreciation(전기말 상각부인액 잔액, 원)",
      months_2012_2019: "months_2012_2019(2012.1.1~2019.12.31 근무 월수, 0~96)",
      months_since_2020: "months_since_2020(2020.1.1~퇴직일 근무 월수)",
      avg_salary_to_2019: "avg_salary_to_2019(2019.12.31부터 소급 3년 총급여 연평균환산액, 원)",
      avg_salary_last3y: "avg_salary_last3y(퇴직일부터 소급 3년 총급여 연평균환산액, 원)",
      severance_income: "severance_income(퇴직소득금액, 원)",
      months_before_2012: "months_before_2012(2011.12.31 이전 근무 월수)",
      pre2012_amount: "pre2012_amount(2011.12.31 퇴직 가정 정관 기준 퇴직소득금액, 원)",
      balance_days: "balance_days(가지급금 적수, 원×일)",
      principal: "principal(가지급금 잔액, 원)",
      days: "days(대여 일수, 일)",
      rate_type: "rate_type(이자율 종류, \"당좌대출이자율\" 또는 \"가중평균차입이자율\")",
      weighted_average_rate: "weighted_average_rate(가중평균차입이자율, 연 %)",
      paid_interest: "paid_interest(약정이자 수령액, 원)",
      is_leap_year: "is_leap_year(윤년 여부)",
      severance_pay: "severance_pay(퇴직소득금액, 원)",
      service_years: "service_years(근속연수, 년)",
    }
    const detail = parsed.error.issues
      .map((i) => {
        const key = String(i.path[0] ?? "")
        const label = labels[key] || key || "입력"
        if (key === "calc_type") {
          return `calc_type은 ${CALC_TYPES.map((t) => `"${t}"`).join(" · ")} 중 하나여야 합니다`
        }
        // 라벨은 대부분 "…(원)"처럼 괄호로 끝나 "가"가 맞지만, 인자를 특정하지 못해
        // 폴백한 "입력"은 받침이 있어 "이"를 써야 한다 ("입력가 필요합니다" 방지)
        const josa = label === "입력" ? "이" : "가"
        return i.code === "invalid_type" && /undefined/.test(i.message)
          ? `${label}${josa} 필요합니다`
          : `${label}: ${i.message}`
      })
      .join("; ")
    const requested = (rawInput as { calc_type?: string } | null)?.calc_type
    const example = EXAMPLES[requested ?? ""] ?? EXAMPLES["임원퇴직금한도"]
    return {
      content: [{ type: "text", text: `[INVALID_PARAMETER] fin_calc: ${detail}\n💡 예: ${example}` }],
      isError: true,
    }
  }
  const input = parsed.data

  // discriminatedUnion으로는 표현할 수 없는 분기별 필수 인자 — 여기서 한글로 잡는다
  if (input.calc_type === "감가상각비" && input.method === "정률법" && input.remaining_value === undefined) {
    return invalidParam(
      "정률법은 기초 미상각잔액이 있어야 계산됩니다 — remaining_value(장부상 기초 미상각잔액, 원 = 취득가액 − 장부상 감가상각누계액)가 필요합니다. " +
        "전기말 상각부인액 잔액이 있으면 disallowed_depreciation에 함께 주세요 (세무상 미상각잔액 = 취득가액 − 이미 손금에 산입한 감가상각비, 시행령 §26②2)",
      EXAMPLES["감가상각비"]
    )
  }
  if (input.calc_type === "임원퇴직소득한도") {
    if (input.months_2012_2019 + input.months_since_2020 === 0) {
      return invalidParam(
        "2012.1.1 이후 근무 월수가 0입니다 — 소득세법 §22③ 한도는 2012년 이후 근무기간으로 계산하므로 한도가 0원이 됩니다. " +
          "2011.12.31 이전 근무분만 있는 퇴직소득이면 한도와 비교할 금액 자체가 없으니(시행령 §42의2⑥) 이 계산이 필요 없습니다. 월수를 다시 확인하세요",
        EXAMPLES["임원퇴직소득한도"]
      )
    }
    if (input.months_2012_2019 > 0 && input.avg_salary_to_2019 === undefined) {
      return invalidParam(
        "months_2012_2019가 0보다 크면 avg_salary_to_2019(2019.12.31부터 소급 3년 총급여의 연평균환산액, 원)가 필요합니다 — " +
          "그 3년(2012.1.1~2019.12.31 근무기간이 3년 미만이면 그 기간) 동안 받은 총급여로 계산합니다 (소득세법 §22③ 계산식)",
        EXAMPLES["임원퇴직소득한도"]
      )
    }
    if (input.months_since_2020 > 0 && input.avg_salary_last3y === undefined) {
      return invalidParam(
        "months_since_2020이 0보다 크면 avg_salary_last3y(퇴직일부터 소급 3년 총급여의 연평균환산액, 원)가 필요합니다 — " +
          "그 3년(2020.1.1~퇴직일 근무기간이 3년 미만이면 그 기간) 동안 받은 총급여로 계산합니다 (소득세법 §22③ 계산식)",
        EXAMPLES["임원퇴직소득한도"]
      )
    }
    // 2011년 이전분을 빼지 않으면 한도와 비교할 금액이 커져 근로소득 초과분이 과대 계산된다 —
    // 생략을 "0개월"로 읽지 않는다 (is_sme·rate_type과 같은 원칙)
    if (input.severance_income !== undefined && input.months_before_2012 === undefined && input.pre2012_amount === undefined) {
      return invalidParam(
        "severance_income을 주면 2011.12.31 이전 근무분을 빼야 합니다 — months_before_2012(2011.12.31 이전 근무 월수, 없으면 0)가 필요합니다. " +
          "정관(또는 정관 위임 지급규정)에 따라 2011.12.31 퇴직 가정 금액을 쓰기로 선택했다면 그 금액을 pre2012_amount로 주세요 (소득세법 시행령 §42의2⑥)",
        EXAMPLES["임원퇴직소득한도"]
      )
    }
    if (input.severance_income !== undefined && input.pre2012_amount !== undefined && input.pre2012_amount > input.severance_income) {
      return invalidParam(
        `pre2012_amount(${input.pre2012_amount.toLocaleString("ko-KR")}원)가 severance_income(${input.severance_income.toLocaleString("ko-KR")}원)보다 큽니다 — 입력값을 확인하세요`,
        EXAMPLES["임원퇴직소득한도"]
      )
    }
  }
  if (input.calc_type === "가지급금인정이자") {
    const hasBalanceDays = input.balance_days !== undefined
    const hasPrincipalDays = input.principal !== undefined && input.days !== undefined
    if (!hasBalanceDays && !hasPrincipalDays) {
      return invalidParam(
        "가지급금 적수가 필요합니다 — balance_days(적수, 원×일)를 직접 주거나 principal(잔액, 원)과 days(일수)를 함께 주세요",
        EXAMPLES["가지급금인정이자"]
      )
    }
    // 두 형태를 다 주면 한쪽이 조용히 무시된다 — 서로 다른 값이면 어느 쪽으로 계산됐는지
    // 알 수 없는 채 확정 금액이 나간다 (Codex 리뷰 중요 1)
    if (hasBalanceDays && (input.principal !== undefined || input.days !== undefined)) {
      const derived = (input.principal ?? 0) * (input.days ?? 0)
      return invalidParam(
        `적수 입력이 중복됩니다 — balance_days(${input.balance_days!.toLocaleString("ko-KR")})와 ` +
          `principal×days(${derived.toLocaleString("ko-KR")}) 중 하나만 주세요. ` +
          `둘을 함께 주면 어느 쪽으로 계산했는지 알 수 없습니다`,
        EXAMPLES["가지급금인정이자"]
      )
    }
    if (input.rate_type === undefined) {
      return invalidParam(
        "rate_type(적용 이자율 종류)이 필요합니다 — 법정 원칙과 예외가 달라 기본값을 두지 않습니다:\n" +
          '  · "가중평균차입이자율" — **원칙** (법인세법 시행령 §89③ 본문). weighted_average_rate(연 %)를 함께 주세요\n' +
          '  · "당좌대출이자율" — 예외 (§89③ 단서 각 호). ①가중평균차입이자율 적용이 불가능한 사유가 있는 경우 ' +
          "②대여기간 5년 초과 등 ③신고와 함께 당좌대출이자율을 시가로 **선택**한 경우(선택한 사업연도+이후 2개 사업연도)에 한합니다",
        EXAMPLES["가지급금인정이자"]
      )
    }
    if (input.rate_type === "가중평균차입이자율" && input.weighted_average_rate === undefined) {
      return invalidParam(
        "가중평균차입이자율을 선택하면 그 이자율을 직접 주어야 합니다 — weighted_average_rate(연 %, 예: 9)가 필요합니다",
        EXAMPLES["가지급금인정이자"]
      )
    }
    // 이자율 0%는 무경고로 "익금산입하지 않음"이라는 정반대 확신형 결론을 만든다 —
    // 가장 그럴듯한 오용이 무상 대여(약정이자율 0)와의 혼동인데, 무상대여야말로
    // 인정이자 과세의 전형 사안이다 (Claude 리뷰 중요 8). 계산을 거부하고 갈래를 안내한다.
    // 시행규칙 §43은 0% 자체를 금지하지 않는다 — 적격 차입금 전액이 무이자인 이례적
    // 경우 가중평균이 실제로 0일 수 있다 (Codex 4차 중요). 그 경우까지 세 갈래로 안내하되
    // 자동 계산은 하지 않는다: 차입금 범위(특수관계인 차입금 제외 등) 판단이 선행돼야 하고,
    // 이 갈래에서 당좌대출 4.6%로 우회하면 과대 산출이 된다
    if (input.rate_type === "가중평균차입이자율" && input.weighted_average_rate === 0) {
      return invalidParam(
        "weighted_average_rate가 0%입니다 — 계산을 거부합니다. 가중평균차입이자율 0%는 보통 다음 중 하나입니다:\n" +
          "  · 무상 대여(약정이자율 0%)와 혼동한 입력 — 인정이자의 이자율은 대여 약정이자율이 아니라 **법인의 차입 이자율(시가)**입니다. 무상 대여일수록 익금산입 대상이며, 수령 약정이자는 paid_interest(기본 0)에 넣습니다\n" +
          '  · 차입금이 없어 가중평균차입이자율을 계산할 수 없는 경우 — §89③ 단서 각 호의 적용 불가 사유에 해당하므로 rate_type="당좌대출이자율"로 계산하세요\n' +
          "  · 적격 차입금이 실재하고 그 가중평균이 실제로 0%인 이례적 경우(전액 무이자 차입 등) — 시가가 0이라 익금산입액이 없을 수 있으나, 시행규칙 §43의 차입금 범위(특수관계인 차입금 제외 등) 판단이 선행돼야 해 자동 계산하지 않습니다. 차입금 구성을 조문과 대조해 직접 확인하세요 (이 경우 당좌대출이자율 4.6%로 대신 계산하면 과대 산출입니다)",
        EXAMPLES["가지급금인정이자"]
      )
    }
  }

  if (input.calc_type === "임원퇴직금한도") {
    const { serviceYears, limit } = calcExecutiveSeveranceLimit(input.annual_salary, input.years, input.months)
    const text = [
      `[산식 기준: ${FORMULA_BASIS}] 임원 퇴직금 손금산입 한도 (정관·지급규정이 없는 경우)`,
      // 실사용에서 가장 헷갈린 것은 금액보다 "법인세 한도인가 소득세 한도인가"였다 (2026-09-30 외부 검토) —
      // 세목과 초과분 처리를 첫 줄에 둔다
      `※ 법인세 문제: 이 한도를 넘는 금액은 손금불산입하고 귀속자인 임원의 상여로 처분한다 (법인세법 시행령 §106①1). ` +
        `소득세법 §22③의 임원 퇴직소득 한도(넘으면 근로소득)와는 산식·기준 급여가 다른 별개 한도 — fin_calc 임원퇴직소득한도로 따로 계산한다`,
      ``,
      ...staleConstantsNotice(),
      `한도액: ${won(limit)}`,
      ``,
      `계산 과정:`,
      `  근속연수 = ${input.years}년 + ${input.months}개월/12 = ${serviceYears.toFixed(4)}년 (1개월 미만 절사 전제)`,
      `  한도 = 총급여 ${won(input.annual_salary)} × 10% × ${serviceYears.toFixed(4)}년 = ${won(limit)}`,
      ``,
      `근거: 법인세법 시행령 제44조제4항제2호 (근속연수 계산: 법인세법 시행규칙 제22조)`,
      ``,
      `⚠ 주의:`,
      `  · 이 값은 **법인세법상 임원 퇴직급여의 손금산입 한도**다 — 근로기준법·근퇴법상 일반 근로자`,
      `    퇴직금(평균임금 30일분 × 근속연수)이 아니다. 일반 퇴직금 계산은 이 도구가 지원하지 않음`,
      `  · 정관(또는 정관 위임 지급규정)에 퇴직급여액·기준이 있으면 그 금액이 한도 (§44④1호 — 이 산식 미적용)`,
      `  · 총급여에서 손금불산입 상여(시행령 §43)와 비과세소득은 제외해야 함 — 입력값 확인`,
      `  · 산식 개정 여부는 fin_article("법인세법 시행령","제44조")로 교차 확인 가능`,
      ``,
      SOURCE_FOOTER,
    ].join("\n")
    return { content: [{ type: "text", text }] }
  }

  if (input.calc_type === "임원퇴직소득한도") {
    const m1 = input.months_2012_2019
    const m2 = input.months_since_2020
    const a1 = input.avg_salary_to_2019 ?? 0
    const a2 = input.avg_salary_last3y ?? 0
    const { part2012, part2020, limit } = calcExecRetirementIncomeLimit(a1, m1, a2, m2)
    const ex =
      input.severance_income !== undefined
        ? calcExecRetirementIncomeExcess(input.severance_income, limit, input.months_before_2012 ?? 0, m1, m2, input.pre2012_amount)
        : undefined
    const usedOverride = input.pre2012_amount !== undefined
    const text = [
      `[산식 기준: ${BASIS_EXEC_RETIREMENT_INCOME}] 임원 퇴직소득 한도 (소득세법 §22③)`,
      `※ 소득세 문제: 한도를 넘는 퇴직소득은 퇴직소득이 아니라 근로소득으로 본다. ` +
        `법인세 손금 한도(법인세법 시행령 §44④ — fin_calc 임원퇴직금한도)와는 별개 — 손금으로 인정돼도 이 한도를 넘으면 근로소득으로 과세되고, 이 한도 안이라도 법인세 한도를 넘으면 손금불산입된다`,
      ``,
      ...staleConstantsNotice(),
      `한도액: ${won(limit)}`,
      ...(ex
        ? [
            `한도와 비교할 퇴직소득금액: ${wonExact(ex.subject)} (퇴직소득금액 ${won(input.severance_income!)} − 2011.12.31 이전분 ${wonExact(ex.pre2012)})`,
            ex.excess > 0
              ? `→ 한도 초과분 ${wonExact(ex.excess)}은 근로소득, 나머지 ${wonExact(ex.retirementPortion)}은 퇴직소득으로 과세`
              : `→ 한도 이내 — 퇴직소득금액 전액이 퇴직소득 (근로소득으로 보는 금액 없음)`,
          ]
        : [`(severance_income을 주면 근로소득으로 보는 초과분까지 계산합니다)`]),
      ``,
      `계산 과정:`,
      `  ① 2012.1.1~2019.12.31 구간 = 연평균 ${won(a1)} × 1/10 × ${m1}개월/12 × 3 = ${wonExact(part2012)}`,
      `  ② 2020.1.1 이후 구간 = 연평균 ${won(a2)} × 1/10 × ${m2}개월/12 × 2 = ${wonExact(part2020)}`,
      `  ③ 한도 = ① + ② = ${wonExact(limit)}`,
      ...(ex
        ? [
            usedOverride
              ? `  ④ 2011.12.31 이전분 = ${wonExact(ex.pre2012)} (입력한 정관 기준 금액 — 시행령 §42의2⑥ 괄호의 선택)` +
                (input.months_before_2012 !== undefined ? ` · months_before_2012는 이 방식에서 쓰지 않음` : ``)
              : `  ④ 2011.12.31 이전분 = ${won(input.severance_income!)} × ${input.months_before_2012}개월 ÷ 전체 ${ex.totalMonths}개월 = ${wonExact(ex.pre2012)} (시행령 §42의2⑥ — 전체 근무월수는 세 구간 입력의 합)`,
            `  ⑤ 초과분 = max(${wonExact(ex.subject)} − ${wonExact(limit)}, 0) = ${wonExact(ex.excess)}`,
          ]
        : []),
      ``,
      `근거: 소득세법 제22조제3항(계산식)·제4항(근무기간 월수·총급여), 시행령 제42조의2제5항(임원 범위)·제6항(2011년 이전분)·제7항(해외 파견 급여)`,
      ``,
      `⚠ 주의:`,
      `  · 근무 월수는 1개월 미만을 1개월로 센다 (§22④1) — 입력 전에 반영할 것`,
      `  · 총급여 = 봉급·상여 등 근로소득(§20①1·2)에서 비과세소득을 뺀 금액 (§22④2). 해외 현지법인 파견 중 국외 급여는 포함 (시행령 §42의2⑦)`,
      `  · 각 구간의 "소급 3년"은 그 구간의 근무기간이 3년 미만이면 그 근무기간으로 한다 — 연평균환산액 입력은 이 기준으로`,
      `  · 임원 = 법인세법 시행령 §40①의 직무에 종사하는 사람 (시행령 §42의2⑤). 직원 기간을 포함할지·기산일을 언제로 볼지(직원 기간 퇴직금 정산·중간정산 여부)는 이 도구가 판단하지 않는다 — 월수 입력 전에 확인`,
      `  · 공적연금 일시금(§22①1)과 비과세소득은 severance_income에서 뺀다 (§22③ 괄호)`,
      `  · 퇴직소득으로 남는 금액의 세액은 fin_calc 퇴직소득세로 계산한다`,
      `  · 산식 개정 여부는 fin_article("소득세법","제22조")로 교차 확인 가능`,
      ``,
      SOURCE_FOOTER,
    ].join("\n")
    return { content: [{ type: "text", text }] }
  }

  if (input.calc_type === "기업업무추진비한도") {
    if (input.is_sme === undefined) {
      return invalidParam(
        "is_sme(중소기업 여부)가 필요합니다 — 기본한도가 3배 달라 기본값을 두지 않습니다:\n" +
          "  · true — 「조세특례제한법」 제6조제1항에 따른 중소기업(법인세법 §13① 단서의 정의): 기본한도 연 3,600만원 (법인세법 §25④1)\n" +
          "  · false — 그 밖의 법인: 기본한도 연 1,200만원\n" +
          "  중소기업 해당 여부를 모르면 임의로 정하지 말고 사용자에게 확인하세요 (아래 예의 값은 형식 예시일 뿐입니다)",
        EXAMPLES["기업업무추진비한도"]
      )
    }
    const { base, generalAmount, combinedAmount, relatedAmount, limit } = calcEntertainmentLimit(
      input.revenue,
      input.related_party_revenue,
      input.is_sme,
      input.business_months
    )
    const hasRelated = input.related_party_revenue > 0
    const text = [
      `[산식 기준: ${FORMULA_BASIS}] 기업업무추진비 손금산입 한도`,
      ``,
      ...staleConstantsNotice(),
      `한도액: ${won(limit)}`,
      ``,
      // 입력값을 그대로 되보인다 — 중소기업 여부는 한도를 3배 가르는 전제이고, 총매출을 revenue에
      // 넣고 특수관계인분을 또 넣는 중복 입력은 출력에 입력값이 없으면 검산할 수 없다 (Codex 9차 E9)
      `입력 전제:`,
      `  · 중소기업 여부: ${input.is_sme ? "중소기업(is_sme=true)" : "중소기업 아님(is_sme=false) — 중소기업이면 기본한도가 3,600만원"}`,
      `  · 일반 수입금액(revenue): ${won(input.revenue)}`,
      `  · 특수관계인 수입금액(related_party_revenue): ${won(input.related_party_revenue)}`,
      `  · 사업연도 월수(business_months): ${input.business_months}개월`,
      ``,
      `계산 과정:`,
      `  ① 기본한도 = ${input.is_sme ? "3,600만원(중소기업)" : "1,200만원"} × ${input.business_months}/12 = ${won(base)}`,
      `  ② 수입금액분 = 일반 수입금액 ${won(input.revenue)}에 100억 이하 0.3% + 100억~500억 0.2% + 500억 초과 0.03% 적용 → ${won(generalAmount)}`,
      hasRelated
        ? `  ③ 특수관계인 거래분 = (합산 수입금액 ${won(input.revenue + input.related_party_revenue)} 기준 ${won(combinedAmount)} − ② ${won(generalAmount)}) × 10% → ${won(relatedAmount)} (§25④2 단서)`
        : `  ③ 특수관계인 거래분 = 없음`,
      `  한도 = ① + ② + ③ = ${won(limit)}`,
      ``,
      `근거: 법인세법 제25조제4항`,
      ``,
      `⚠ 주의:`,
      `  · revenue는 특수관계인과의 거래 수입금액을 **뺀** 금액이다 — 총수입금액을 그대로 넣으면 특수관계인분이 10%로 줄지 않아 한도가 과대 계산되고, related_party_revenue까지 함께 넣으면 그 금액이 이중으로 잡힌다`,
      // 조특법 §136은 추가 한도를 둘 둔다 — ③만 적으면 ⑥이 없는 것으로 읽힌다 (2026-09-30 외부 검토, 원문 대조)
      `  · 조세특례제한법의 추가 한도 둘은 이 계산에 미포함 — 각각 기업업무추진비 한도액의 20% 범위, 2028-12-31까지 지출분:`,
      `    §136③ 문화비로 지출한 기업업무추진비 / §136⑥ 전통시장 또는 지역사랑상품권으로 지출한 기업업무추진비(신용카드등사용금액 요건, 소비성서비스업 지출 제외)`,
      `  · 3만원 초과 적격증빙(신용카드 등) 미수취분은 한도 이전에 전액 손금불산입 (§25②)`,
      `  · 부동산임대업 주업 법인 등 특정법인은 한도 50% 축소 (§25⑤) — 미반영`,
      `  · 산식 개정 여부는 fin_article("법인세법","제25조")로 교차 확인 가능`,
      ``,
      SOURCE_FOOTER,
    ].join("\n")
    return { content: [{ type: "text", text }] }
  }

  if (input.calc_type === "감가상각비") {
    const isDeclining = input.method === "정률법"
    // 모순 입력 차단 — "취득가액 1억 − 누계액 = 2억" 같은 산술 모순이 확신형으로
    // 나가면 자릿수 오타가 그대로 검토서에 실린다 (Opus 리뷰 중요 3)
    // 세무상 미상각잔액 = 장부 잔액 + 상각부인액 잔액 (시행령 §26②2 "취득가액 − 이미 손금에 산입한 금액")
    const taxRemaining = (input.remaining_value ?? 0) + (input.disallowed_depreciation ?? 0)
    if (isDeclining && taxRemaining > input.acquisition_cost) {
      const withDisallowed = input.disallowed_depreciation !== undefined
      return {
        content: [
          {
            type: "text",
            text: withDisallowed
              ? `[INVALID_PARAMETER] fin_calc: 세무상 미상각잔액(장부 잔액 ${won(input.remaining_value ?? 0)} + 상각부인액 잔액 ${won(input.disallowed_depreciation ?? 0)} = ${won(taxRemaining)})이 acquisition_cost(취득가액 ${won(input.acquisition_cost)})보다 큽니다 — 세무상 미상각잔액은 취득가액에서 이미 손금에 산입한 감가상각비를 뺀 값이므로 취득가액을 넘을 수 없습니다. remaining_value에 이미 세무상 잔액을 넣었다면 상각부인액을 이중으로 더한 것입니다. 입력값을 확인하세요.`
              : `[INVALID_PARAMETER] fin_calc: remaining_value(미상각잔액 ${won(input.remaining_value ?? 0)})가 acquisition_cost(취득가액 ${won(input.acquisition_cost)})보다 큽니다 — 미상각잔액은 취득가액에서 감가상각누계액을 뺀 값이므로 취득가액을 넘을 수 없습니다. 입력값을 확인하세요.`,
          },
        ],
        isError: true,
      }
    }
    // 1년 미만 월수는 사유에 따라 산식이 다르다(§26⑧⑨ 월할 vs §28② 환산내용연수) —
    // 사유 없이 계산하면 정률법에서 최대 -22.8% 틀린 값이 확신형으로 나간다 (Opus 리뷰 차단)
    if (input.business_months < 12 && !input.short_period_basis) {
      return {
        content: [
          {
            type: "text",
            text:
              `[INVALID_PARAMETER] fin_calc: business_months가 12 미만이면 short_period_basis(사유)가 필요합니다 — 사유에 따라 법정 산식이 다릅니다:\n` +
              `  · "기중취득" — 사업연도 중 취득: 월할 (시행령 §26⑨)\n` +
              `  · "사업연도변경의제" — 사업연도 변경·의제(법 §7·§8)로 그 해만 1년 미만: 월할 (시행령 §26⑧)\n` +
              `  · "사업연도1년미만" — 정관상 사업연도(법 §6) 자체가 1년 미만: 환산내용연수 상각률 (시행령 §28②, 월할 아님)`,
          },
        ],
        isError: true,
      }
    }
    let calcResult: ReturnType<typeof calcDepreciationLimit>
    try {
      calcResult = calcDepreciationLimit(
        input.acquisition_cost,
        input.useful_life,
        input.method,
        taxRemaining,
        input.business_months,
        input.short_period_basis
      )
    } catch (e) {
      // 환산내용연수 비정수·범위 초과 — 추측 대신 정직한 계산 불가
      return {
        content: [{ type: "text", text: `[INVALID_PARAMETER] fin_calc: ${e instanceof Error ? e.message : String(e)}` }],
        isError: true,
      }
    }
    const {
      rate,
      base,
      regular,
      residual,
      isFinalYear,
      memoValue,
      limit,
      converted,
      effectiveLife,
      alreadyDone,
      proratedFinal,
      limitIfAddendProrated,
    } = calcResult
    const isProrated = input.business_months < 12 && !converted
    const monthNote = isProrated ? ` × ${input.business_months}/12` : ``
    const text = [
      `[산식 기준: ${BASIS_DEPRECIATION}] 감가상각비 상각범위액 (${input.method})`,
      ``,
      ...staleConstantsNotice(),
      // 월할 사업연도 + 마무리 연도가 겹치면 단일 확정 금액을 주지 않는다 (Codex 리뷰 차단 2)
      ...(proratedFinal
        ? [
            `상각범위액: **두 해석이 갈립니다 — 하나로 확정하지 않습니다**`,
            `  ⓐ 5% 가산분을 월할하지 않는 경우: ${won(limit)}`,
            `  ⓑ 5% 가산분도 월할하는 경우: ${won(limitIfAddendProrated ?? 0)}`,
            `  → 시행령 §26⑧⑨는 "제1항을 적용함에 있어서" 상각범위액을 월할하라 하고, §26⑥ 단서는`,
            `     5% 잔존가액을 "그 사업연도의 상각범위액에 가산한다"고만 해 가산분의 월할 여부를 정하지 않았습니다.`,
            `     ⓐ를 쓰면 ${input.business_months}개월인데 12개월과 같은 금액이 나올 수 있습니다 — 세무대리인 판단 또는 국세청 질의로 확정하세요.`,
          ]
        : [`상각범위액: ${won(limit)}`]),
      ``,
      `계산 과정:`,
      // 별표는 "0.451"처럼 적는다 — 별표와 눈으로 대조되도록 소수 표기를 먼저 보인다
      converted
        ? `  ① 상각률 = ${rate.toFixed(3)} (${pct(rate)}) — 환산내용연수 ${effectiveLife}년 ${input.method} (시행령 §28②: 내용연수 ${input.useful_life}년 × 12 ÷ 사업연도 ${input.business_months}개월. 별표 4)`
        : `  ① 상각률 = ${rate.toFixed(3)} (${pct(rate)}) — 내용연수 ${input.useful_life}년 ${input.method} (시행규칙 별표 4)`,
      ...(isDeclining
        ? [
            `  ② 세무상 미상각잔액 = 장부상 미상각잔액 ${won(input.remaining_value ?? 0)} + 상각부인액 잔액 ${won(input.disallowed_depreciation ?? 0)} = ${won(base)}`,
            `     (시행령 §26②2: 취득가액 ${won(input.acquisition_cost)} − 이미 감가상각비로 손금에 산입한 금액)`,
            // 생략을 0으로 읽되 그 전제를 숨기지 않는다 — 빠지면 상각범위액이 과소 계산된다
            ...(input.disallowed_depreciation === undefined
              ? [`     ⚠ disallowed_depreciation을 주지 않아 상각부인액 잔액 0원으로 계산했다 — 전기까지 상각부인액이 있으면 그만큼 상각범위액이 과소 계산되니 넣어서 다시 계산할 것`]
              : []),
          ]
        : [`  ② 취득가액 = ${won(base)}`]),
      `  ③ 상각범위액 = ${won(base)} × ${rate.toFixed(3)}${monthNote} = ${won(regular)}`,
      ...(alreadyDone
        ? [`  ④ 미상각잔액이 비망가액(${won(memoValue)}, §26⑦) 이하 — 추가 상각할 금액이 없어 상각범위액 0원`]
        : isFinalYear
          ? [
              `  ④ 상각 마무리 연도 — 이번 상각 후 미상각잔액이 취득가액의 5%(${won(residual)}) 이하가 됨`,
              `     시행령 §26⑥ 단서에 따라 ${won(residual)}을 상각범위액에 가산하되,`,
              `     비망가액 ${won(memoValue)}(§26⑦)을 남겨 ${won(limit)}까지 상각 가능`,
              ...(proratedFinal
                ? [
                    `     ⚠ 이 사업연도는 월할 대상(${input.business_months}/12)이라 가산분 ${won(residual)}의 월할 여부에 따라 결과가 갈린다 —`,
                    `        가산분도 월할하면 ${won(limitIfAddendProrated ?? 0)} (위 ⓑ)`,
                  ]
                : []),
            ]
          : []),
      ...(!isDeclining && input.remaining_value !== undefined
        ? [
            `  ※ 입력한 미상각잔액 ${won(taxRemaining)}${input.disallowed_depreciation !== undefined ? `(장부 잔액 + 상각부인액 잔액)` : ``}은 정액법 산식에는 쓰이지 않는다 — 실제 손금 상한은 세무상 미상각잔액 − 비망가액${
              regular > taxRemaining ? ` (이번 상각범위액이 미상각잔액을 초과하므로 상한 적용 필요)` : ``
            }`,
          ]
        : []),
      ``,
      `근거: 법인세법 시행령 제26조${isDeclining ? "제2항제2호" : "제2항제1호"}(상각방법)${
        converted
          ? "·제28조제2항(환산내용연수)"
          : isProrated
            ? input.short_period_basis === "사업연도변경의제"
              ? "·제8항(사업연도 변경·의제 월할)"
              : "·제9항(기중 취득 월할)"
            : ""
      }${isFinalYear && !alreadyDone ? "·제6항 단서(잔존가액)·제7항(비망가액)" : ""}`,
      `      상각률: 법인세법 시행령 제28조제1항제1호 → 시행규칙 제15조제2항 → 별표 4 「감가상각자산의 상각률표」`,
      ``,
      `⚠ 주의:`,
      `  · 이 금액은 "상각범위액"(손금 한도)이며 실제 손금은 결산에 계상한 감가상각비와 비교해 판단 — 초과분은 손금불산입(상각부인액), 미달분은 시인부족액 (법인세법 §23①)`,
      `  · 내용연수는 자산·업종에 따라 다르다 — 별표 5(건축물)·별표 6(업종별)의 내용연수범위에서 신고한 값을 쓸 것 (fin_annex("법인세법 시행규칙", keyword="내용연수"))`,
      `  · 상각방법을 신고하지 않으면 건축물·무형자산은 정액법, 그 밖의 유형자산은 정률법이 강제된다 (§26④)`,
      `  · 월수는 역에 따라 계산하되 1개월 미만의 일수는 1개월로 본다 (§26⑧⑨) — business_months에 반영해 입력할 것`,
      ...(isDeclining
        ? []
        : [`  · 정액법은 취득가액 기준이라 상각 말년에 미상각잔액을 넘을 수 있다 — 실제 손금은 미상각잔액에서 비망가액(취득가액의 5%와 1천원 중 적은 금액, §26⑦)을 뺀 금액이 상한`]),
      ...(isFinalYear && !alreadyDone && isProrated
        ? [`  · 마무리 연도의 5% 가산분(§26⑥ 단서)은 월할하지 않고 전액 가산했다 — 조문이 월할 여부를 정하지 않아 해석이 갈릴 수 있는 부분이니 원문 확인 권장`]
        : []),
      `  · 업무용승용차는 정액법·내용연수 5년이 강제되고 연 800만원 한도가 별도로 적용된다 (법인세법 §27의2) — 미반영`,
      `  · 상각률 개정 여부는 fin_annex("법인세법 시행규칙", keyword="상각률")로 교차 확인 가능`,
      ``,
      SOURCE_FOOTER,
    ].join("\n")
    return { content: [{ type: "text", text }] }
  }

  if (input.calc_type === "가지급금인정이자") {
    const balanceDays = input.balance_days ?? (input.principal ?? 0) * (input.days ?? 0)
    const isOverdraft = input.rate_type === "당좌대출이자율"
    const annualRate = isOverdraft ? OVERDRAFT_LOAN_RATE : (input.weighted_average_rate ?? 0) / 100
    const { daysInYear, marketInterest, deemedInterest, meetsAbsolute, meetsRatio, isTaxable } = calcDeemedInterest(
      balanceDays,
      annualRate,
      input.paid_interest,
      input.is_leap_year
    )
    // 퍼센트 단위로 받는 값을 소수(0.046)로 잘못 넣으면 1/100로 계산되고도 오류가 안 난다
    const unitWarning =
      !isOverdraft && annualRate > 0 && annualRate < 0.005
        ? [
            ``,
            `⚠ 입력한 이자율이 연 ${pct(annualRate, 4)}로 해석되었습니다.`,
            `   weighted_average_rate는 퍼센트 단위입니다 — 연 4.6%라면 0.046이 아니라 4.6을 넣으세요.`,
          ]
        : []
    const text = [
      `[산식 기준: ${BASIS_DEEMED_INTEREST}] 가지급금 인정이자`,
      ``,
      ...staleConstantsNotice(),
      `이자 시가: ${won(marketInterest)}`,
      deemedInterest > 0
        ? `인정이자(익금산입 대상액): ${won(deemedInterest)}`
        : `인정이자(익금산입 대상액): 없음 — 약정이자(${won(input.paid_interest)})가 이자 시가 이상이라 익금에 산입할 차액이 없다`,
      ``,
      `계산 과정:`,
      input.balance_days !== undefined
        ? `  ① 가지급금 적수 = ${balanceDays.toLocaleString("ko-KR")} (입력값, 원×일)`
        : `  ① 가지급금 적수 = ${won(input.principal ?? 0)} × ${input.days ?? 0}일 = ${balanceDays.toLocaleString("ko-KR")} (원×일)`,
      `  ② 적용 이자율 = 연 ${pct(annualRate)} (${input.rate_type})`,
      ...(isOverdraft
        ? [
            `     ⚠ 당좌대출이자율은 §89③ **단서 각 호의 예외**입니다 (원칙은 가중평균차입이자율) —`,
            `        ①가중평균 적용 불가 사유 ②대여기간 5년 초과 등 ③신고와 함께 선택 중 하나에 해당하는지 확인하세요`,
            `        ③(신고 시 선택, §89③2)이면 별지 제19호서식(갑)을 작성·제출해야 합니다 (시행규칙 §43⑤)`,
          ]
        : []),
      `  ③ 이자 시가 = 적수 × ${pct(annualRate)} ÷ ${daysInYear}일${input.is_leap_year ? " (윤년)" : ""} = ${won(marketInterest)}`,
      `  ④ 인정이자 = 이자 시가 ${won(marketInterest)} − 약정이자 ${won(input.paid_interest)} = ${
        deemedInterest > 0 ? won(deemedInterest) : `${won(deemedInterest)} → 차액이 없어 익금산입 대상 0원`
      }`,
      ``,
      ...(deemedInterest > 0
        ? [
            `익금산입 요건 (시행령 §88③ — 둘 중 하나만 충족하면 적용):`,
            `  · 차액 3억원 이상: ${meetsAbsolute ? "충족" : `미충족 (${won(deemedInterest)} < 3억원)`}`,
            `  · 차액이 시가의 5% 이상: ${meetsRatio ? "충족" : `미충족 (기준 ${won(marketInterest * UNFAIR_ACT_THRESHOLD_RATIO)})`}`,
            `  → ${isTaxable ? "부당행위계산부인 적용 대상 — 인정이자를 익금산입" : "요건 미충족 — 익금산입하지 않음"}`,
          ]
        : [`익금산입 요건 (시행령 §88③): 차액이 없어 판정 불요`]),
      ...(isTaxable
        ? [
            ``,
            `소득처분 (법인세법 시행령 제106조제1항제1호): 익금산입액은 귀속자에 따라 처분한다`,
            `  · 임원·직원 → 상여   · 주주(임직원 아닌) → 배당`,
            `  · 법인·사업영위 개인 → 기타사외유출   · 그 밖 → 기타소득`,
            `  · 귀속이 불분명하면 대표자 상여 (같은 호 단서)`,
          ]
        : []),
      ``,
      `근거: 법인세법 제52조(부당행위계산의 부인), 시행령 제88조제1항제6호·제3항, 제89조제3항`,
      isOverdraft
        ? `      당좌대출이자율 연 4.6%: 법인세법 시행규칙 제43조제2항 ("연간 1,000분의 46")`
        : `      가중평균차입이자율의 계산방법: 법인세법 시행규칙 제43조제1항 (입력값 사용)`,
      `      적수 ÷ ${daysInYear} 계산 구조: 조문 본문이 아니라 별지 제19호서식 「가지급금등의 인정이자조정명세서」의 작성 구조 (서식 목록: 법인세법 시행규칙 제82조제1항제19호)`,
      ...unitWarning,
      ``,
      `⚠ 주의:`,
      `  · 시가는 가중평균차입이자율이 원칙이고, 당좌대출이자율은 §89③ 단서 각 호(가중평균 적용 불가·대여기간 5년 초과·신고 시 선택)에 해당할 때만 쓴다 — 선택 시 그 사업연도와 이후 2개 사업연도에 계속 적용`,
      `  · 적수는 매일의 잔액을 합산한다 — 월말 잔액 × 경과일수의 간편법은 인정되지 않으며, 발생 초일은 산입하고 회수일은 제외한다`,
      `  · 직원 학자금·경조사비 대여, 중소기업 직원 주택자금 대여 등은 인정이자 계산에서 제외된다 (시행규칙 §44)`,
      `  · 업무무관 가지급금은 인정이자와 별개로 지급이자 손금불산입도 적용된다 (법인세법 §28①4나) — 미반영`,
      `  · 이자율 개정 여부는 fin_article("법인세법 시행규칙","제43조")로 교차 확인 가능`,
      ``,
      SOURCE_FOOTER,
    ].join("\n")
    return { content: [{ type: "text", text }] }
  }

  const r = calcRetirementIncomeTax(input.severance_pay, input.service_years)
  const roundedUp = r.serviceYears !== input.service_years
  const text = [
    `[산식 기준: ${BASIS_RETIREMENT_TAX}] 퇴직소득세`,
    ``,
    ...staleConstantsNotice(),
    `산출세액(소득세): ${won(r.incomeTax)}`,
    `개인지방소득세: ${won(r.localTax)}`,
    `합계: ${won(r.total)}`,
    `※ 끝수 계산 반영 — 과세표준은 1원 미만, 산출세액은 10원 미만을 절사했습니다 (국고금 관리법 §47②·§47① · 지방세는 지방세기본법 §59가 준용)`,
    ...(r.belowMinimumWithholding
      ? [
          `⚠ 산출세액이 1천원 미만입니다 — 소액 부징수(소득세법 제86조제1호)의 판단 기준은 지급 시점의 **원천징수세액**(기납부세액·과세이연 조정 후 차감원천징수세액)이고 이 도구는 산출세액만 계산하므로, 징수 여부는 여기서 확정하지 않습니다. 다른 조정분이 없다면 징수하지 않는 방향입니다`,
        ]
      : []),
    ``,
    `계산 과정:`,
    `  ① 퇴직소득금액 = ${won(input.severance_pay)}`,
    `  ② 근속연수 = ${r.serviceYears}년${roundedUp ? ` (입력 ${input.service_years}년 — 1년 미만은 1년으로 올림, §48①)` : ``}`,
    r.deductionCapped
      ? `  ③ 근속연수공제 = ${won(r.yearsDeduction)} — 산식상 ${won(r.rawDeduction)}이나 퇴직소득금액에 미달해 퇴직소득금액이 공제액 (§48②)`
      : `  ③ 근속연수공제 = ${won(r.yearsDeduction)} (§48①1 표)`,
    `  ④ 환산급여 = (${won(input.severance_pay)} − ${won(r.yearsDeduction)}) ÷ ${r.serviceYears}년 × 12 = ${wonExact(r.convertedPay)}`,
    `  ⑤ 환산급여공제 = ${wonExact(r.payDeduction)} (§48①2 표)`,
    `  ⑥ 퇴직소득 과세표준 = ${wonExact(r.convertedPay)} − ${wonExact(r.payDeduction)} = ${won(r.taxBase)}` +
      (r.taxBase !== r.untruncatedTaxBase ? ` (산식상 ${wonExact(r.untruncatedTaxBase)} — 1원 미만 절사, 국고금 관리법 §47②)` : ``),
    `  ⑦ 환산산출세액 = ${won(r.taxBase)} × 기본세율(적용구간 ${pct(r.appliedRate, 0)}) = ${wonExact(r.convertedTax)} (§55①)`,
    `  ⑧ 산출세액 = ${wonExact(r.convertedTax)} ÷ 12 × ${r.serviceYears}년 = ${won(r.incomeTax)} (§55②2)` +
      (r.incomeTax !== r.untruncatedIncomeTax ? ` — 산식상 ${wonExact(r.untruncatedIncomeTax)}에서 10원 미만 절사 (국고금 관리법 §47①)` : ``),
    `  ⑨ 개인지방소득세 = ${wonExact(r.untruncatedIncomeTax)}(절사 전 소득세) × 10% = ${won(r.localTax)} (지방세법 §92①④)` +
      (r.localTax !== r.untruncatedLocalTax ? ` — 산식상 ${wonExact(r.untruncatedLocalTax)}에서 10원 미만 절사 (지방세기본법 §59)` : ``),
    ``,
    `근거: 소득세법 제48조(퇴직소득공제 — 근속연수공제표·환산급여공제표), 제55조제1항·제2항(세율·산출세액)`,
    `      근속연수 계산: 소득세법 시행령 제105조 / 개인지방소득세: 지방세법 제92조제1항·제4항`,
    `      끝수 계산: 국고금 관리법 제47조제1항·제2항 / 지방세기본법 제59조(같은 조 준용)`,
    ``,
    `⚠ 주의:`,
    `  · 입력한 severance_pay는 비과세 퇴직소득(소득세법 §12)을 뺀 퇴직소득금액이어야 한다 — 퇴직급여 총액을 그대로 넣으면 과대계산된다`,
    `  · 2012-12-31 이전 근무기간이 있으면 개정 전 규정에 따른 안분계산이 필요하다 (소득세법 부칙) — 미반영`,
    `  · 임원 퇴직소득 한도(소득세법 §22③) 초과분은 근로소득으로 과세된다 — 이 계산은 한도 내 금액 전제. 한도·초과분은 fin_calc 임원퇴직소득한도로 먼저 나눌 것`,
    `  · 퇴직연금(IRP) 이전분은 과세이연되어 원천징수하지 않는다 (소득세법 §146②) — 미반영`,
    `  · 개인지방소득세는 표준세율 기준이며, 지자체가 조례로 ±50% 범위에서 가감할 수 있다 (지방세법 §92②)`,
    `  · 절사는 조문이 정한 두 지점(과세표준 1원 미만·산출세액 10원 미만)에만 적용했다 — 환산급여·환산산출세액의 단계별 절사는 조문 근거가 없어 적용하지 않았으므로, 국세청 원천징수 프로그램이 중간 단계도 절사하면 최종 세액이 10원 단위로 달라질 수 있다`,
    `  · 국고금 관리법 §47①의 절사 대상은 실제 징수·납부액이다 — 세액공제·기납부세액이 있으면 그 차감 후 금액을 기준으로 다시 절사한다`,
    `  · 세율·공제표 개정 여부는 fin_article("소득세법","제48조")·fin_article("소득세법","제55조")로 교차 확인 가능`,
    ``,
    SOURCE_FOOTER,
  ].join("\n")
  return { content: [{ type: "text", text }] }
}
