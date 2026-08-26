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

export const FinCalcInputSchema = z.discriminatedUnion("calc_type", [
  z.object({
    calc_type: z.literal("임원퇴직금한도"),
    annual_salary: z.number().positive("annual_salary(총급여액)는 0보다 커야 합니다").describe("퇴직 직전 1년 총급여액 (원) — 손금불산입 상여·비과세소득 제외액"),
    years: z.number().int("years(근속 연수)는 정수여야 합니다").min(0, "years(근속 연수)는 0 이상이어야 합니다").describe("근속 연수 (년 단위 정수)"),
    months: z.number().int("months(잔여 개월)는 정수여야 합니다").min(0, "months(잔여 개월)는 0 이상이어야 합니다").max(11, "months(잔여 개월)는 11 이하여야 합니다").default(0).describe("1년 미만 잔여 개월 수 (1개월 미만 절사)"),
  }),
  z.object({
    calc_type: z.literal("기업업무추진비한도"),
    revenue: z.number().min(0, "revenue(수입금액)는 0 이상이어야 합니다").describe("일반 수입금액 (원)"),
    related_party_revenue: z.number().min(0, "related_party_revenue(특수관계인 수입금액)는 0 이상이어야 합니다").default(0).describe("특수관계인 거래 수입금액 (원)"),
    is_sme: z.boolean().default(false).describe("중소기업 여부"),
    business_months: z.number().int("business_months(월수)는 정수여야 합니다").min(1, "business_months(월수)는 1 이상이어야 합니다").max(12, "business_months(월수)는 12 이하여야 합니다").default(12).describe("사업연도 월수 (기본 12)"),
  }),
  z.object({
    calc_type: z.literal("감가상각비"),
    acquisition_cost: z.number().positive("acquisition_cost(취득가액)는 0보다 커야 합니다").describe("취득가액 (원) — 법인세법 시행령 §72의 취득가액"),
    useful_life: z.number().int("useful_life(내용연수)는 정수여야 합니다").min(2, "useful_life(내용연수)는 2년 이상이어야 합니다 (별표 4 수록 범위)").max(60, "useful_life(내용연수)는 60년 이하여야 합니다 (별표 4 수록 범위)").describe("내용연수 (년) — 별표 4 수록 범위는 2~60년"),
    method: z.enum(["정액법", "정률법"]).describe("상각방법"),
    remaining_value: z.number().min(0, "remaining_value(기초 미상각잔액)는 0 이상이어야 합니다").optional().describe("[정률법 필수] 기초 미상각잔액 (원) = 취득가액 − 감가상각누계액"),
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
    balance_days: z.number().min(0, "balance_days(적수)는 0 이상이어야 합니다").optional().describe("가지급금 적수 (원×일) — principal·days 대신 직접 입력"),
    principal: z.number().min(0, "principal(가지급금 잔액)은 0 이상이어야 합니다").optional().describe("가지급금 잔액 (원) — days와 함께 쓰면 적수를 계산한다"),
    days: z.number().int("days(대여 일수)는 정수여야 합니다").min(0, "days(대여 일수)는 0 이상이어야 합니다").optional().describe("대여 일수 (일) — 발생 초일 산입, 회수일 제외"),
    // 기본값을 두면 안 된다: 법인세법 시행령 §89③ 본문은 **가중평균차입이자율이 시가**이고
    // 당좌대출이자율은 단서 3호(적용 불가 사유·5년 초과 대여·신고 선택)의 예외다.
    // 예외를 기본값으로 두면 사용자가 생략했을 때 법정 원칙과 반대인 4.6%로 확정 금액이
    // 나가고, weighted_average_rate를 줘도 무시된다 (Codex 리뷰 차단 1)
    rate_type: z.enum(["당좌대출이자율", "가중평균차입이자율"]).optional().describe("적용 이자율 종류 (필수) — 원칙은 가중평균차입이자율(시행령 §89③ 본문)"),
    weighted_average_rate: z.number().min(0, "weighted_average_rate(이자율)는 0 이상이어야 합니다").max(100, "weighted_average_rate(이자율)는 100 이하로, %단위로 입력하세요 (예: 9 = 연 9%)").optional().describe("[가중평균차입이자율 선택 시 필수] 연 이자율을 %로 (예: 9 = 연 9%)"),
    paid_interest: z.number().min(0, "paid_interest(수령 약정이자)는 0 이상이어야 합니다").default(0).describe("실제 수령한 약정이자 (원, 기본 0)"),
    is_leap_year: z.boolean().default(false).describe("윤년 여부 — true면 366일로 나눈다 (기본 false=365일)"),
  }),
  z.object({
    calc_type: z.literal("퇴직소득세"),
    severance_pay: z.number().min(0, "severance_pay(퇴직소득금액)는 0 이상이어야 합니다").describe("퇴직소득금액 (원) = 퇴직급여액 − 비과세 퇴직소득"),
    service_years: z.number().positive("service_years(근속연수)는 0보다 커야 합니다").describe("근속연수 (년) — 1년 미만은 1년으로 올림한다 (소득세법 §48①)"),
  }),
])

export const FIN_CALC_TOOL = {
  name: "fin_calc",
  description:
    "[재무·세무·회계 전용 — 법정 한도·세액 계산은 직접 계산하지 말고 이 도구를 사용] " +
    "세법에 산식이 명문화된 항목을 결정형 코드로 계산한다 (계산 과정·근거 조문 동봉). " +
    "지원: 임원퇴직금한도(법인세법 시행령 §44④2 — 법인세 손금 한도이며, 근로기준법·근퇴법상 " +
    "일반 근로자 퇴직금 계산은 미지원), 기업업무추진비한도(법인세법 §25④), " +
    "감가상각비 상각범위액(법인세법 시행령 §26 + 시행규칙 별표 4 상각률), " +
    "가지급금인정이자(법인세법 시행령 §89③ + 시행규칙 §43②), " +
    "퇴직소득세(소득세법 §48·§55 + 지방소득세).",
  // properties(평면)와 oneOf(조건부 필수)를 함께 둔다 — 평면 목록만 보면 어떤 인자가
  // 어느 계산에 필수인지 알 수 없어 LLM이 필수 인자를 빠뜨린다. oneOf를 못 읽는
  // 클라이언트도 properties로 종전대로 동작한다 (Codex 리뷰)
  inputSchema: {
    type: "object",
    properties: {
      calc_type: {
        type: "string",
        enum: ["임원퇴직금한도", "기업업무추진비한도", "감가상각비", "가지급금인정이자", "퇴직소득세"],
        description: "계산 유형",
      },
      annual_salary: { type: "number", exclusiveMinimum: 0, description: "[임원퇴직금한도·필수] 퇴직 직전 1년 총급여액 (원)" },
      years: { type: "integer", minimum: 0, description: "[임원퇴직금한도·필수] 근속 연수 (년)" },
      months: { type: "integer", minimum: 0, maximum: 11, description: "[임원퇴직금한도] 1년 미만 잔여 개월 (기본 0)" },
      revenue: { type: "number", minimum: 0, description: "[기업업무추진비한도·필수] 일반 수입금액 (원)" },
      related_party_revenue: { type: "number", minimum: 0, description: "[기업업무추진비한도] 특수관계인 거래 수입금액 (원, 기본 0)" },
      is_sme: { type: "boolean", description: "[기업업무추진비한도] 중소기업 여부 (기본 false)" },
      business_months: { type: "integer", minimum: 1, maximum: 12, description: "[기업업무추진비한도] 사업연도 월수 (기본 12) / [감가상각비] 상각 대상 월수 (기본 12)" },
      acquisition_cost: { type: "number", exclusiveMinimum: 0, description: "[감가상각비·필수] 취득가액 (원)" },
      useful_life: { type: "integer", minimum: 2, maximum: 60, description: "[감가상각비·필수] 내용연수 (년, 별표 4 수록 범위 2~60)" },
      method: { type: "string", enum: ["정액법", "정률법"], description: "[감가상각비·필수] 상각방법" },
      remaining_value: { type: "number", minimum: 0, description: "[감가상각비·정률법일 때 필수] 기초 미상각잔액 (원) = 취득가액 − 감가상각누계액" },
      short_period_basis: {
        type: "string",
        enum: ["기중취득", "사업연도변경의제", "사업연도1년미만"],
        description:
          "[감가상각비·business_months<12일 때 필수] 1년 미만 사유 — 기중취득·사업연도변경의제는 월할(§26⑧⑨), 사업연도1년미만은 환산내용연수 상각률(§28②)로 산식이 다름",
      },
      balance_days: { type: "number", minimum: 0, description: "[가지급금인정이자] 가지급금 적수 (원×일) — principal·days 대신 직접 입력" },
      principal: { type: "number", minimum: 0, description: "[가지급금인정이자] 가지급금 잔액 (원) — days와 함께 입력" },
      days: { type: "integer", minimum: 0, description: "[가지급금인정이자] 대여 일수 (일) — principal과 함께 입력" },
      rate_type: { type: "string", enum: ["당좌대출이자율", "가중평균차입이자율"], description: "[가지급금인정이자·필수] 적용 이자율 종류. 원칙은 가중평균차입이자율(시행령 §89③ 본문), 당좌대출이자율은 단서의 예외 — 기본값 없음" },
      weighted_average_rate: { type: "number", minimum: 0, maximum: 100, description: "[가지급금인정이자·가중평균차입이자율 선택 시 필수] 연 이자율을 %로 (예: 9 = 연 9%)" },
      paid_interest: { type: "number", minimum: 0, description: "[가지급금인정이자] 실제 수령한 약정이자 (원, 기본 0)" },
      is_leap_year: { type: "boolean", description: "[가지급금인정이자] 윤년이면 true (366일로 나눔, 기본 false)" },
      severance_pay: { type: "number", minimum: 0, description: "[퇴직소득세·필수] 퇴직소득금액 (원) = 퇴직급여액 − 비과세 퇴직소득" },
      service_years: { type: "number", exclusiveMinimum: 0, description: "[퇴직소득세·필수] 근속연수 (년, 1년 미만은 1년으로 올림)" },
    },
    required: ["calc_type"],
    oneOf: [
      {
        title: "임원퇴직금한도",
        properties: { calc_type: { const: "임원퇴직금한도" } },
        required: ["calc_type", "annual_salary", "years"],
      },
      {
        title: "기업업무추진비한도",
        properties: { calc_type: { const: "기업업무추진비한도" } },
        required: ["calc_type", "revenue"],
      },
      {
        title: "감가상각비",
        properties: { calc_type: { const: "감가상각비" } },
        required: ["calc_type", "acquisition_cost", "useful_life", "method"],
        // 정률법은 미상각잔액이 없으면 계산 자체가 불가능하다 (정액법은 취득가액 기준이라 불필요)
        anyOf: [
          { properties: { method: { const: "정액법" } }, required: ["method"] },
          { properties: { method: { const: "정률법" } }, required: ["method", "remaining_value"] },
        ],
      },
      {
        title: "가지급금인정이자",
        properties: { calc_type: { const: "가지급금인정이자" } },
        // 적수를 직접 주거나(balance_days) 금액×일수로 주거나 — 둘 중 하나
        anyOf: [
          { required: ["calc_type", "balance_days"] },
          { required: ["calc_type", "principal", "days"] },
        ],
      },
      {
        title: "퇴직소득세",
        properties: { calc_type: { const: "퇴직소득세" } },
        required: ["calc_type", "severance_pay", "service_years"],
      },
    ],
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
} as const

const won = (n: number): string => `${Math.floor(n).toLocaleString("ko-KR")}원`
/**
 * 이자율·상각률 표시 — 별표/조문 표기와 같은 소수 자리를 유지하되 꼬리 0은 지운다.
 * 소수점이 없을 때 꼬리 0을 지우면 40%가 4%가 되므로, 소수점이 있을 때만 자른다.
 */
const pct = (rate: number, digits = 3): string => {
  const s = (rate * 100).toFixed(digits)
  return `${s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s}%`
}

const CALC_TYPES = ["임원퇴직금한도", "기업업무추진비한도", "감가상각비", "가지급금인정이자", "퇴직소득세"] as const

const EXAMPLES: Record<string, string> = {
  임원퇴직금한도: `{ "calc_type": "임원퇴직금한도", "annual_salary": 120000000, "years": 5, "months": 3 }`,
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
  return { base, generalAmount, relatedAmount, limit }
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
 *   「가지급금 등의 인정이자 조정명세서」의 작성 구조다 (시행규칙 §43⑤이 그 서식을 지정한다).
 *   조문이 명문으로 정한 것은 "시가"(= 이자율)이지 일할 계산식이 아니다.
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
 */
export function calcRetirementIncomeTax(severancePay: number, rawServiceYears: number) {
  const serviceYears = Math.ceil(rawServiceYears)

  const rawDeduction = serviceYearsDeduction(serviceYears)
  // §48② 퇴직소득금액이 근속연수공제에 미달하면 그 퇴직소득금액을 공제액으로 한다 → 환산급여 0
  const yearsDeduction = Math.min(rawDeduction, severancePay)
  const deductionCapped = rawDeduction > severancePay

  const convertedPay = ((severancePay - yearsDeduction) / serviceYears) * 12
  const payDeduction = convertedPayDeduction(convertedPay)
  const taxBase = Math.max(convertedPay - payDeduction, 0)

  const { tax: convertedTax, rate: appliedRate } = basicIncomeTax(taxBase)
  const incomeTax = (convertedTax / 12) * serviceYears
  const localTax = incomeTax * LOCAL_INCOME_TAX_RATIO

  return {
    serviceYears,
    rawDeduction,
    yearsDeduction,
    deductionCapped,
    convertedPay,
    payDeduction,
    taxBase,
    appliedRate,
    convertedTax,
    incomeTax,
    localTax,
    total: incomeTax + localTax,
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
      remaining_value: "remaining_value(기초 미상각잔액, 원)",
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
      "정률법은 기초 미상각잔액이 있어야 계산됩니다 — remaining_value(기초 미상각잔액, 원 = 취득가액 − 감가상각누계액)가 필요합니다",
      EXAMPLES["감가상각비"]
    )
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
          '  · "당좌대출이자율" — 예외 (§89③ 단서). ①가중평균차입이자율 적용이 불가능한 사유가 있는 경우 ' +
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
  }

  if (input.calc_type === "임원퇴직금한도") {
    const { serviceYears, limit } = calcExecutiveSeveranceLimit(input.annual_salary, input.years, input.months)
    const text = [
      `[산식 기준: ${FORMULA_BASIS}] 임원 퇴직금 손금산입 한도 (정관·지급규정이 없는 경우)`,
      ``,
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
      `  · 2012-01-01 이후 적립분 임원 퇴직소득 한도(소득세법 §22③)는 별도 판단`,
      `  · 산식 개정 여부는 fin_article("법인세법 시행령","제44조")로 교차 확인 가능`,
      ``,
      SOURCE_FOOTER,
    ].join("\n")
    return { content: [{ type: "text", text }] }
  }

  if (input.calc_type === "기업업무추진비한도") {
    const { base, generalAmount, relatedAmount, limit } = calcEntertainmentLimit(
      input.revenue,
      input.related_party_revenue,
      input.is_sme,
      input.business_months
    )
    const text = [
      `[산식 기준: ${FORMULA_BASIS}] 기업업무추진비 손금산입 한도`,
      ``,
      `한도액: ${won(limit)}`,
      ``,
      `계산 과정:`,
      `  ① 기본한도 = ${input.is_sme ? "3,600만원(중소기업)" : "1,200만원"} × ${input.business_months}/12 = ${won(base)}`,
      `  ② 수입금액분 = 100억 이하 0.3% + 100억~500억 0.2% + 500억 초과 0.03% 적용 → ${won(generalAmount)}`,
      input.related_party_revenue > 0
        ? `  ③ 특수관계인 거래분 = 합산 산출액 증가분의 10%만 인정 → ${won(relatedAmount)} (§25④2 단서)`
        : `  ③ 특수관계인 거래분 = 없음`,
      `  한도 = ① + ② + ③ = ${won(limit)}`,
      ``,
      `근거: 법인세법 제25조제4항`,
      ``,
      `⚠ 주의:`,
      `  · 문화 기업업무추진비 추가 한도(조세특례제한법 §136③)는 이 계산에 미포함`,
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
    if (isDeclining && (input.remaining_value ?? 0) > input.acquisition_cost) {
      return {
        content: [
          {
            type: "text",
            text: `[INVALID_PARAMETER] fin_calc: remaining_value(미상각잔액 ${won(input.remaining_value ?? 0)})가 acquisition_cost(취득가액 ${won(input.acquisition_cost)})보다 큽니다 — 미상각잔액은 취득가액에서 감가상각누계액을 뺀 값이므로 취득가액을 넘을 수 없습니다. 입력값을 확인하세요.`,
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
        input.remaining_value ?? 0,
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
      isDeclining
        ? `  ② 미상각잔액 = ${won(base)} (취득가액 ${won(input.acquisition_cost)} − 감가상각누계액)`
        : `  ② 취득가액 = ${won(base)}`,
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
            `  ※ 입력한 미상각잔액 ${won(input.remaining_value)}은 정액법 산식에는 쓰이지 않는다 — 실제 손금 상한은 미상각잔액 − 비망가액${
              regular > input.remaining_value ? ` (이번 상각범위액이 미상각잔액을 초과하므로 상한 적용 필요)` : ``
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
            `     ⚠ 당좌대출이자율은 §89③ **단서의 예외**입니다 (원칙은 가중평균차입이자율) —`,
            `        ①가중평균 적용 불가 사유 ②대여기간 5년 초과 등 ③신고와 함께 선택 중 하나에 해당하는지 확인하세요`,
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
      `      적수 ÷ ${daysInYear} 계산 구조: 시행규칙 제43조제5항이 지정한 별지 제19호서식 「가지급금 등의 인정이자 조정명세서」`,
      ...unitWarning,
      ``,
      `⚠ 주의:`,
      `  · 시가는 가중평균차입이자율이 원칙이고, 당좌대출이자율은 §89③ 각 호(가중평균 적용 불가·대여기간 5년 초과·신고 시 선택)에 해당할 때만 쓴다 — 선택 시 그 사업연도와 이후 2개 사업연도에 계속 적용`,
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
    `[산식 기준: ${BASIS_RETIREMENT_TAX}] 퇴직소득세 — **추정치** (원 단위 절사·반올림 미구현)`,
    ``,
    // 단계별 절사·반올림 규칙을 구현하지 않았으므로 "산출세액"이라 단정하지 않는다.
    // 원천징수 신고액으로 그대로 옮겨 적으면 실제 징수액과 어긋날 수 있다 (Codex 리뷰 개선 2)
    `산출세액(소득세) 추정: ${won(r.incomeTax)}`,
    `개인지방소득세 추정: ${won(r.localTax)}`,
    `합계 추정: ${won(r.total)}`,
    `※ 각 단계를 실수로 계산한 값입니다 — 원천징수 신고액은 국세청 「퇴직소득 원천징수영수증」 서식의 단계별 절사 규칙을 따라 확정하세요`,
    ``,
    `계산 과정:`,
    `  ① 퇴직소득금액 = ${won(input.severance_pay)}`,
    `  ② 근속연수 = ${r.serviceYears}년${roundedUp ? ` (입력 ${input.service_years}년 — 1년 미만은 1년으로 올림, §48①)` : ``}`,
    r.deductionCapped
      ? `  ③ 근속연수공제 = ${won(r.yearsDeduction)} — 산식상 ${won(r.rawDeduction)}이나 퇴직소득금액에 미달해 퇴직소득금액이 공제액 (§48②)`
      : `  ③ 근속연수공제 = ${won(r.yearsDeduction)} (§48①1 표)`,
    `  ④ 환산급여 = (${won(input.severance_pay)} − ${won(r.yearsDeduction)}) ÷ ${r.serviceYears}년 × 12 = ${won(r.convertedPay)}`,
    `  ⑤ 환산급여공제 = ${won(r.payDeduction)} (§48①2 표)`,
    `  ⑥ 퇴직소득 과세표준 = ${won(r.convertedPay)} − ${won(r.payDeduction)} = ${won(r.taxBase)}`,
    `  ⑦ 환산산출세액 = ${won(r.taxBase)} × 기본세율(적용구간 ${pct(r.appliedRate, 0)}) = ${won(r.convertedTax)} (§55①)`,
    `  ⑧ 산출세액 = ${won(r.convertedTax)} ÷ 12 × ${r.serviceYears}년 = ${won(r.incomeTax)} (§55②2)`,
    `  ⑨ 개인지방소득세 = ${won(r.incomeTax)} × 10% = ${won(r.localTax)} (지방세법 §92①④)`,
    ``,
    `근거: 소득세법 제48조(퇴직소득공제 — 근속연수공제표·환산급여공제표), 제55조제1항·제2항(세율·산출세액)`,
    `      근속연수 계산: 소득세법 시행령 제105조 / 개인지방소득세: 지방세법 제92조제1항·제4항`,
    ``,
    `⚠ 주의:`,
    `  · 입력한 severance_pay는 비과세 퇴직소득(소득세법 §12)을 뺀 퇴직소득금액이어야 한다 — 퇴직급여 총액을 그대로 넣으면 과대계산된다`,
    `  · 2012-12-31 이전 근무기간이 있으면 개정 전 규정에 따른 안분계산이 필요하다 (소득세법 부칙) — 미반영`,
    `  · 임원 퇴직소득 한도(소득세법 §22③) 초과분은 근로소득으로 과세된다 — 이 계산은 한도 내 금액 전제`,
    `  · 퇴직연금(IRP) 이전분은 과세이연되어 원천징수하지 않는다 (소득세법 §146②) — 미반영`,
    `  · 개인지방소득세는 표준세율 기준이며, 지자체가 조례로 ±50% 범위에서 가감할 수 있다 (지방세법 §92②)`,
    `  · 원 단위 미만 처리 방식 차이로 실제 원천징수액과 소액 차이가 날 수 있다`,
    `  · 세율·공제표 개정 여부는 fin_article("소득세법","제48조")·fin_article("소득세법","제55조")로 교차 확인 가능`,
    ``,
    SOURCE_FOOTER,
  ].join("\n")
  return { content: [{ type: "text", text }] }
}
