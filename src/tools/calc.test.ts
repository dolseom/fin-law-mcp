/**
 * fin_calc 골든 테스트 — 법정 산식의 회귀 기준 (순수 함수, CI 상시 실행)
 * 세법 개정으로 산식이 바뀌면 이 테스트와 calc.ts의 FORMULA_BASIS를 함께 갱신한다.
 */

import { describe, it, expect } from "vitest"
import { calcExecutiveSeveranceLimit, calcEntertainmentLimit, handleFinCalc } from "./calc.js"

describe("임원퇴직금한도 (법인세법 시행령 §44④2)", () => {
  it("총급여 1.2억 · 근속 5년 → 6,000만원", () => {
    const { limit } = calcExecutiveSeveranceLimit(120_000_000, 5, 0)
    expect(limit).toBe(60_000_000)
  })
  it("1년 미만 월수는 개월/12로 환산 — 1.2억 · 5년 3개월 → 6,300만원", () => {
    const { limit, serviceYears } = calcExecutiveSeveranceLimit(120_000_000, 5, 3)
    expect(serviceYears).toBeCloseTo(5.25)
    expect(limit).toBeCloseTo(63_000_000)
  })
})

describe("기업업무추진비한도 (법인세법 §25④)", () => {
  it("일반기업 · 수입 50억 → 기본 1,200만 + 50억×0.3% = 2,700만원", () => {
    const { limit } = calcEntertainmentLimit(5_000_000_000, 0, false, 12)
    expect(limit).toBe(12_000_000 + 15_000_000)
  })
  it("중소기업 · 수입 200억 → 3,600만 + 100억×0.3% + 100억×0.2% = 8,600만원", () => {
    const { base, generalAmount, limit } = calcEntertainmentLimit(20_000_000_000, 0, true, 12)
    expect(base).toBe(36_000_000)
    expect(generalAmount).toBe(30_000_000 + 20_000_000)
    expect(limit).toBe(86_000_000)
  })
  it("600억 구간 누진 — 100억×0.3% + 400억×0.2% + 100억×0.03% = 1.13억", () => {
    const { generalAmount } = calcEntertainmentLimit(60_000_000_000, 0, false, 12)
    expect(generalAmount).toBe(30_000_000 + 80_000_000 + 3_000_000)
  })
  it("특수관계인 수입분은 산출 증가분의 10%만 인정", () => {
    // 일반 50억 + 특관 50억: 합산 100억 × 0.3% = 3,000만, 일반분 1,500만 → 증가분 1,500만의 10% = 150만
    const { generalAmount, relatedAmount } = calcEntertainmentLimit(5_000_000_000, 5_000_000_000, false, 12)
    expect(generalAmount).toBe(15_000_000)
    expect(relatedAmount).toBe(1_500_000)
  })
  it("사업연도 6개월이면 기본한도 절반", () => {
    const { base } = calcEntertainmentLimit(0, 0, false, 6)
    expect(base).toBe(6_000_000)
  })
})

describe("handleFinCalc 계약", () => {
  it("계산 과정·근거 조문·산식 기준일·주의를 동봉한다", async () => {
    const res = await handleFinCalc(null, { calc_type: "임원퇴직금한도", annual_salary: 120_000_000, years: 5 })
    const t = res.content[0].text
    expect(t).toContain("60,000,000원")
    expect(t).toContain("계산 과정")
    expect(t).toContain("법인세법 시행령 제44조제4항제2호")
    expect(t).toContain("산식 기준")
    expect(t).toContain("정관")
  })
  it("잘못된 입력은 INVALID_PARAMETER", async () => {
    const res = await handleFinCalc(null, { calc_type: "임원퇴직금한도" })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain("INVALID_PARAMETER")
  })
})
