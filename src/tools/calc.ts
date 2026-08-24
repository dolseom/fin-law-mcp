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

export const FinCalcInputSchema = z.discriminatedUnion("calc_type", [
  z.object({
    calc_type: z.literal("임원퇴직금한도"),
    annual_salary: z.number().positive().describe("퇴직 직전 1년 총급여액 (원) — 손금불산입 상여·비과세소득 제외액"),
    years: z.number().int().min(0).describe("근속 연수 (년 단위 정수)"),
    months: z.number().int().min(0).max(11).default(0).describe("1년 미만 잔여 개월 수 (1개월 미만 절사)"),
  }),
  z.object({
    calc_type: z.literal("기업업무추진비한도"),
    revenue: z.number().min(0).describe("일반 수입금액 (원)"),
    related_party_revenue: z.number().min(0).default(0).describe("특수관계인 거래 수입금액 (원)"),
    is_sme: z.boolean().default(false).describe("중소기업 여부"),
    business_months: z.number().int().min(1).max(12).default(12).describe("사업연도 월수 (기본 12)"),
  }),
])

export const FIN_CALC_TOOL = {
  name: "fin_calc",
  description:
    "[재무·세무·회계 전용 — 법정 한도 계산은 직접 계산하지 말고 이 도구를 사용] " +
    "세법에 산식이 명문화된 한도를 결정형 코드로 계산한다 (계산 과정·근거 조문 동봉). " +
    "지원: 임원퇴직금한도(법인세법 시행령 §44④2), 기업업무추진비한도(법인세법 §25④).",
  // properties(평면)와 oneOf(조건부 필수)를 함께 둔다 — 평면 목록만 보면 어떤 인자가
  // 어느 계산에 필수인지 알 수 없어 LLM이 필수 인자를 빠뜨린다. oneOf를 못 읽는
  // 클라이언트도 properties로 종전대로 동작한다 (Codex 리뷰)
  inputSchema: {
    type: "object",
    properties: {
      calc_type: { type: "string", enum: ["임원퇴직금한도", "기업업무추진비한도"], description: "계산 유형" },
      annual_salary: { type: "number", exclusiveMinimum: 0, description: "[임원퇴직금한도·필수] 퇴직 직전 1년 총급여액 (원)" },
      years: { type: "integer", minimum: 0, description: "[임원퇴직금한도·필수] 근속 연수 (년)" },
      months: { type: "integer", minimum: 0, maximum: 11, description: "[임원퇴직금한도] 1년 미만 잔여 개월 (기본 0)" },
      revenue: { type: "number", minimum: 0, description: "[기업업무추진비한도·필수] 일반 수입금액 (원)" },
      related_party_revenue: { type: "number", minimum: 0, description: "[기업업무추진비한도] 특수관계인 거래 수입금액 (원, 기본 0)" },
      is_sme: { type: "boolean", description: "[기업업무추진비한도] 중소기업 여부 (기본 false)" },
      business_months: { type: "integer", minimum: 1, maximum: 12, description: "[기업업무추진비한도] 사업연도 월수 (기본 12)" },
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
    ],
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
} as const

const won = (n: number): string => `${Math.floor(n).toLocaleString("ko-KR")}원`

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
    }
    const detail = parsed.error.issues
      .map((i) => {
        const key = String(i.path[0] ?? "")
        const label = labels[key] || key || "입력"
        if (key === "calc_type") {
          return `calc_type은 "임원퇴직금한도" 또는 "기업업무추진비한도" 중 하나여야 합니다`
        }
        return i.code === "invalid_type" && /undefined/.test(i.message)
          ? `${label}가 필요합니다`
          : `${label}: ${i.message}`
      })
      .join("; ")
    const example =
      (rawInput as { calc_type?: string } | null)?.calc_type === "기업업무추진비한도"
        ? `{ "calc_type": "기업업무추진비한도", "revenue": 15000000000, "is_sme": false }`
        : `{ "calc_type": "임원퇴직금한도", "annual_salary": 120000000, "years": 5, "months": 3 }`
    return {
      content: [{ type: "text", text: `[INVALID_PARAMETER] fin_calc: ${detail}\n💡 예: ${example}` }],
      isError: true,
    }
  }
  const input = parsed.data

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
      `  · 정관(또는 정관 위임 지급규정)에 퇴직급여액·기준이 있으면 그 금액이 한도 (§44④1호 — 이 산식 미적용)`,
      `  · 총급여에서 손금불산입 상여(시행령 §43)와 비과세소득은 제외해야 함 — 입력값 확인`,
      `  · 2012-01-01 이후 적립분 임원 퇴직소득 한도(소득세법 §22③)는 별도 판단`,
      `  · 산식 개정 여부는 fin_article("법인세법 시행령","제44조")로 교차 확인 가능`,
      ``,
      SOURCE_FOOTER,
    ].join("\n")
    return { content: [{ type: "text", text }] }
  }

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
