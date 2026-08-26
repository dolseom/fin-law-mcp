/**
 * fin_calc 골든 테스트 — 법정 산식의 회귀 기준 (순수 함수, CI 상시 실행)
 * 세법 개정으로 산식이 바뀌면 이 테스트와 calc.ts의 FORMULA_BASIS를 함께 갱신한다.
 */

import { describe, it, expect } from "vitest"
import {
  calcExecutiveSeveranceLimit,
  calcEntertainmentLimit,
  calcDepreciationLimit,
  calcDeemedInterest,
  calcRetirementIncomeTax,
  serviceYearsDeduction,
  convertedPayDeduction,
  basicIncomeTax,
  handleFinCalc,
  FIN_CALC_TOOL,
} from "./calc.js"

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

describe("감가상각비 상각범위액 (법인세법 시행령 §26 + 시행규칙 별표 4)", () => {
  // 상각률 대조 출처: 법제처 원문 HWP [별표 4] 감가상각자산의상각률표(제15조제2항관련),
  // flSeq=168515323 (2026-07-01 시행) 직접 파싱 · 확인 2026-08-25.
  // 교차 확인: 26년 0.039/0.109, 29년 0.035/0.099 (웹 검색 독립 출처와 일치)
  it("별표 4 상각률이 표대로 적용된다 — 구간별 표본", () => {
    const rateOf = (life: number, method: "정액법" | "정률법") =>
      calcDepreciationLimit(1_000_000_000, life, method, 1_000_000_000, 12).rate
    expect(rateOf(2, "정액법")).toBeCloseTo(0.5, 10)
    expect(rateOf(2, "정률법")).toBeCloseTo(0.777, 10)
    expect(rateOf(5, "정률법")).toBeCloseTo(0.451, 10)
    expect(rateOf(10, "정률법")).toBeCloseTo(0.259, 10)
    expect(rateOf(20, "정률법")).toBeCloseTo(0.14, 10)
    expect(rateOf(60, "정액법")).toBeCloseTo(0.017, 10)
    expect(rateOf(60, "정률법")).toBeCloseTo(0.049, 10)
  })

  it("별표 값은 1/내용연수 계산과 다르다 — 계산으로 대체하면 틀린다 (회귀 박제)", () => {
    // 26년: 1/26 = 0.03846 이지만 별표는 0.039 / 29년: 1/29 = 0.03448 이지만 별표는 0.035
    const r26 = calcDepreciationLimit(1_000_000_000, 26, "정액법", 0, 12).rate
    const r29 = calcDepreciationLimit(1_000_000_000, 29, "정액법", 0, 12).rate
    expect(r26).toBeCloseTo(0.039, 10)
    expect(r29).toBeCloseTo(0.035, 10)
    expect(r26).not.toBeCloseTo(1 / 26, 5)
    expect(r29).not.toBeCloseTo(1 / 29, 5)
    // 정률법도 1-0.05^(1/n) 근사와 어긋난다 (4년: 근사 0.527, 별표 0.528)
    const d4 = calcDepreciationLimit(1_000_000_000, 4, "정률법", 1_000_000_000, 12).rate
    expect(d4).toBeCloseTo(0.528, 10)
    expect(d4).not.toBeCloseTo(1 - Math.pow(0.05, 1 / 4), 5)
  })

  // 대조 출처: 정률법 표준 계산 예시 (취득가액 1억·내용연수 5년·상각률 0.451)
  // 1년차 45,100,000원 / 2년차 24,759,900원 — 웹 검색 독립 출처와 일치
  it("정률법 1년차 — 취득 1억·5년 → 45,100,000원", () => {
    const { limit } = calcDepreciationLimit(100_000_000, 5, "정률법", 100_000_000, 12)
    expect(limit).toBeCloseTo(45_100_000, 6)
  })

  it("정률법 2년차 — 미상각잔액 54,900,000 → 24,759,900원", () => {
    const { limit, isFinalYear } = calcDepreciationLimit(100_000_000, 5, "정률법", 54_900_000, 12)
    expect(limit).toBeCloseTo(24_759_900, 6)
    expect(isFinalYear).toBe(false)
  })

  it("정액법은 미상각잔액이 아니라 취득가액 기준 (§26②1)", () => {
    const { base, limit } = calcDepreciationLimit(100_000_000, 5, "정액법", 10_000_000, 12)
    expect(base).toBe(100_000_000)
    expect(limit).toBeCloseTo(20_000_000, 6) // 1억 × 0.200
  })

  it("기중 취득·사업연도 변경은 월할계산한다 (§26⑧⑨)", () => {
    const { limit, converted } = calcDepreciationLimit(100_000_000, 5, "정액법", 0, 6, "기중취득")
    expect(limit).toBeCloseTo(10_000_000, 6) // 2,000만 × 6/12
    expect(converted).toBe(false)
  })

  describe("사업연도 자체가 1년 미만 — 환산내용연수 (§28②, Opus 리뷰 차단 회귀)", () => {
    // 월할(§26⑧⑨)과 환산내용연수(§28②)는 적용 영역이 다르다. 정률법에서 월할을 쓰면
    // 최대 -22.8% 틀린 값이 확신형으로 나갔다 (실측)
    it("정률법 6개월 사업연도 — 환산 10년(0.259) 상각률을 쓴다", () => {
      const { limit, rate, converted, effectiveLife } = calcDepreciationLimit(
        100_000_000, 5, "정률법", 100_000_000, 6, "사업연도1년미만"
      )
      expect(converted).toBe(true)
      expect(effectiveLife).toBe(10)
      expect(rate).toBeCloseTo(0.259, 6) // 별표 4의 10년 정률 상각률
      expect(limit).toBeCloseTo(25_900_000, 6) // 월할이면 22,550,000 (틀림)
    })

    it("6개월 사업연도 2회 = 1년 상각률과 일치한다 (환산내용연수 방식의 정합성)", () => {
      const y1 = calcDepreciationLimit(100_000_000, 5, "정률법", 100_000_000, 6, "사업연도1년미만")
      const y2 = calcDepreciationLimit(100_000_000, 5, "정률법", 100_000_000 - y1.limit, 6, "사업연도1년미만")
      // 1 - (1-0.259)² = 0.450919 ≈ 0.451 = 별표 4의 5년 정률 상각률
      // (별표 값이 소수 3자리 반올림이라 완전 일치가 아니라 근사 일치가 정답이다.
      //  월할 방식이면 1-(1-0.2255)² = 0.400으로 크게 어긋난다)
      expect((y1.limit + y2.limit) / 100_000_000).toBeCloseTo(0.451, 3)
    })

    it("환산내용연수가 정수가 아니면 추측하지 않고 던진다", () => {
      // 5년 × 12 ÷ 7개월 = 8.57년 — 별표 4는 정수만 수록
      expect(() => calcDepreciationLimit(100_000_000, 5, "정률법", 100_000_000, 7, "사업연도1년미만")).toThrow(/환산내용연수/)
    })

    it("환산내용연수가 60년을 넘으면 던진다", () => {
      expect(() => calcDepreciationLimit(100_000_000, 40, "정률법", 100_000_000, 6, "사업연도1년미만")).toThrow(/별표 4|범위/)
    })
  })

  it("정률법 마무리 연도 — 5% 가산 후 비망가액 1천원만 남긴다 (§26⑥ 단서·§26⑦)", () => {
    // 취득 100만·5년(0.451) 5년차: 기초 미상각 90,843 → 통상상각 40,970 → 잔액 49,873 ≤ 5%(50,000)
    const { isFinalYear, residual, memoValue, limit } = calcDepreciationLimit(1_000_000, 5, "정률법", 90_843, 12)
    expect(isFinalYear).toBe(true)
    expect(residual).toBe(50_000)
    expect(memoValue).toBe(1_000) // 취득가액의 5%(5만원)와 1천원 중 적은 금액
    expect(limit).toBeCloseTo(89_843, 6) // 미상각잔액 90,843 − 비망 1,000
  })

  it("마무리 연도 상각범위액은 미상각잔액을 넘지 않는다", () => {
    const { limit } = calcDepreciationLimit(1_000_000, 5, "정률법", 30_000, 12)
    expect(limit).toBeLessThanOrEqual(30_000)
    expect(limit).toBeCloseTo(29_000, 6) // 30,000 − 비망 1,000
  })

  it("별표 4에 없는 내용연수는 조용히 계산하지 않고 던진다", () => {
    expect(() => calcDepreciationLimit(100_000_000, 61, "정액법", 0, 12)).toThrow(/별표 4/)
  })
})

describe("가지급금 인정이자 (법인세법 시행령 §89③ + 시행규칙 §43②)", () => {
  // 산식 출처: 한국공인회계사회 사이버연수원 "인정이자 계산방법"
  //   이자시가 = 가지급금적수 × 적정이자율 × 1/365 (윤년 1/366), 인정이자 = 이자시가 − 약정이자
  // 이자율 출처: 법인세법 시행규칙 제43조제2항 원문 "연간 1,000분의 46" = 4.6% · 확인 2026-08-25
  it("적수 × 4.6% ÷ 365 — 1억 365일 무상대여 → 460만원", () => {
    const { marketInterest, deemedInterest } = calcDeemedInterest(100_000_000 * 365, 0.046, 0, false)
    expect(marketInterest).toBeCloseTo(4_600_000, 6)
    expect(deemedInterest).toBeCloseTo(4_600_000, 6)
  })

  it("윤년은 366일로 나눈다", () => {
    const { daysInYear, marketInterest } = calcDeemedInterest(100_000_000 * 366, 0.046, 0, true)
    expect(daysInYear).toBe(366)
    expect(marketInterest).toBeCloseTo(4_600_000, 6)
  })

  it("약정이자를 뺀 차액이 인정이자다", () => {
    const { deemedInterest } = calcDeemedInterest(100_000_000 * 365, 0.046, 1_600_000, false)
    expect(deemedInterest).toBeCloseTo(3_000_000, 6)
  })

  // 가중평균차입이자율 예시 출처: 한국공인회계사회 사이버연수원
  //   (40,000,000×18% + 60,000,000×8% + 100,000,000×6%) ÷ 200,000,000 = 9%
  it("가중평균차입이자율 9%를 적용한다", () => {
    const wacd = (40_000_000 * 0.18 + 60_000_000 * 0.08 + 100_000_000 * 0.06) / 200_000_000
    expect(wacd).toBeCloseTo(0.09, 10)
    const { marketInterest } = calcDeemedInterest(100_000_000 * 365, wacd, 0, false)
    expect(marketInterest).toBeCloseTo(9_000_000, 6)
  })

  it("무상 대여는 익금산입 요건(시가의 5%)을 항상 충족한다", () => {
    const { isTaxable, meetsRatio } = calcDeemedInterest(100_000_000 * 365, 0.046, 0, false)
    expect(meetsRatio).toBe(true)
    expect(isTaxable).toBe(true)
  })

  it("차액이 3억 미만이고 시가의 5% 미만이면 익금산입하지 않는다 (시행령 §88③)", () => {
    // 시가 460만, 약정이자 440만 → 차액 20만 < 460만×5%=23만
    const { deemedInterest, meetsAbsolute, meetsRatio, isTaxable } = calcDeemedInterest(
      100_000_000 * 365,
      0.046,
      4_400_000,
      false
    )
    expect(deemedInterest).toBeCloseTo(200_000, 6)
    expect(meetsAbsolute).toBe(false)
    expect(meetsRatio).toBe(false)
    expect(isTaxable).toBe(false)
  })

  it("차액이 3억 이상이면 비율 요건과 무관하게 충족한다", () => {
    const { meetsAbsolute, isTaxable } = calcDeemedInterest(200_000_000_000 * 365, 0.046, 8_900_000_000, false)
    expect(meetsAbsolute).toBe(true)
    expect(isTaxable).toBe(true)
  })

  it("약정이자가 시가 이상이면 익금산입 대상이 없다", async () => {
    const { deemedInterest, isTaxable } = calcDeemedInterest(100_000_000 * 365, 0.046, 5_000_000, false)
    expect(deemedInterest).toBeLessThan(0)
    expect(isTaxable).toBe(false)
    // 음수 인정이자를 그대로 보여주면 읽는 사람이 혼동한다
    const res = await handleFinCalc(null, {
      calc_type: "가지급금인정이자",
      principal: 100_000_000,
      days: 365,
      rate_type: "당좌대출이자율",
      paid_interest: 5_000_000,
    })
    const t = res.content[0].text
    expect(t).toContain("인정이자(익금산입 대상액): 없음")
    expect(t).not.toMatch(/인정이자\(익금산입 대상액\): -/)
  })
})

describe("퇴직소득세 (소득세법 §48·§55 + 지방세법 §92)", () => {
  // 대조 출처: 국세청 "퇴직소득세 계산방법" 공식 계산사례
  //   https://www.nts.go.kr/nts/cm/cntnts/cntntsView.do?mi=6444&cntntsId=7880
  //   근속연수 20년 · 퇴직급여 1억원 → 근속연수공제 40,000천원 / 환산급여 36,000천원 /
  //   환산급여공제 24,800천원 / 과세표준 11,200천원 / 환산산출세액 672천원 / 산출세액 1,120천원
  it("국세청 공식 계산사례 — 근속 20년·1억원 → 산출세액 1,120,000원", () => {
    const r = calcRetirementIncomeTax(100_000_000, 20)
    expect(r.yearsDeduction).toBe(40_000_000)
    expect(r.convertedPay).toBe(36_000_000)
    expect(r.payDeduction).toBe(24_800_000)
    expect(r.taxBase).toBe(11_200_000)
    expect(r.convertedTax).toBe(672_000)
    expect(r.incomeTax).toBe(1_120_000)
    expect(r.localTax).toBeCloseTo(112_000, 6) // 지방세법 §92①④
  })

  it("근속연수는 1년 미만을 1년으로 올린다 (§48①)", () => {
    expect(calcRetirementIncomeTax(100_000_000, 10.1).serviceYears).toBe(11)
    expect(calcRetirementIncomeTax(100_000_000, 20).serviceYears).toBe(20)
    expect(calcRetirementIncomeTax(100_000_000, 0.5).serviceYears).toBe(1)
  })

  it("근속연수공제표 구간 경계 (§48①1)", () => {
    const deductionAt = (years: number) => calcRetirementIncomeTax(10_000_000_000, years).yearsDeduction
    expect(deductionAt(5)).toBe(5_000_000) // 100만 × 5
    expect(deductionAt(6)).toBe(7_000_000) // 500만 + 200만 × 1
    expect(deductionAt(10)).toBe(15_000_000) // 500만 + 200만 × 5
    expect(deductionAt(11)).toBe(17_500_000) // 1,500만 + 250만 × 1
    expect(deductionAt(20)).toBe(40_000_000) // 1,500만 + 250만 × 10
    expect(deductionAt(21)).toBe(43_000_000) // 4,000만 + 300만 × 1
    expect(deductionAt(30)).toBe(70_000_000) // 4,000만 + 300만 × 10
  })

  it("환산급여공제표 구간 경계 (§48①2)", () => {
    expect(convertedPayDeduction(8_000_000)).toBe(8_000_000) // 전액공제
    expect(convertedPayDeduction(36_000_000)).toBe(24_800_000) // 800만 + 2,800만×60% (국세청 사례)
    expect(convertedPayDeduction(70_000_000)).toBe(45_200_000)
    expect(convertedPayDeduction(100_000_000)).toBe(61_700_000)
    expect(convertedPayDeduction(300_000_000)).toBe(151_700_000)
    expect(convertedPayDeduction(400_000_000)).toBe(151_700_000 + 100_000_000 * 0.35)
  })

  it("기본세율표 구간 경계 (소득세법 §55①)", () => {
    expect(basicIncomeTax(14_000_000).tax).toBe(840_000)
    expect(basicIncomeTax(50_000_000).tax).toBe(6_240_000)
    expect(basicIncomeTax(88_000_000).tax).toBe(15_360_000)
    expect(basicIncomeTax(150_000_000).tax).toBe(37_060_000)
    expect(basicIncomeTax(300_000_000).tax).toBe(94_060_000)
    expect(basicIncomeTax(500_000_000).tax).toBe(174_060_000)
    expect(basicIncomeTax(1_000_000_000).tax).toBe(384_060_000)
    expect(basicIncomeTax(1_000_000_000).rate).toBeCloseTo(0.42, 10)
    expect(basicIncomeTax(1_000_000_001).rate).toBeCloseTo(0.45, 10)
  })

  it("세 표 모두 구간 경계에서 연속이다 — 표 전사 오류 검출", () => {
    // 각 구간의 누진기초액이 앞 구간 상한에서의 값과 같아야 한다.
    // 표를 잘못 옮겨 적으면 경계에서 금액이 튀면서 여기서 드러난다.
    const continuous = (f: (x: number) => number, boundaries: number[], maxJump: number) => {
      for (const b of boundaries) {
        const jump = f(b + 1) - f(b)
        expect(jump).toBeGreaterThanOrEqual(0)
        expect(jump).toBeLessThanOrEqual(maxJump)
      }
    }
    continuous(serviceYearsDeduction, [5, 10, 20], 3_000_000) // 연 단위 표라 최대 가산액만큼 증가
    continuous(convertedPayDeduction, [8_000_000, 70_000_000, 100_000_000, 300_000_000], 1)
    continuous((x) => basicIncomeTax(x).tax, [14_000_000, 50_000_000, 88_000_000, 150_000_000, 300_000_000, 500_000_000, 1_000_000_000], 1)
  })

  it("퇴직소득금액이 근속연수공제에 미달하면 세액이 0이다 (§48②)", () => {
    const r = calcRetirementIncomeTax(3_000_000, 5) // 공제 500만 > 퇴직소득 300만
    expect(r.deductionCapped).toBe(true)
    expect(r.yearsDeduction).toBe(3_000_000)
    expect(r.convertedPay).toBe(0)
    expect(r.incomeTax).toBe(0)
    expect(r.localTax).toBe(0)
  })

  it("고액 퇴직금은 상위 세율 구간을 탄다 — 근속 30년·10억원", () => {
    const r = calcRetirementIncomeTax(1_000_000_000, 30)
    // 근속연수공제 7,000만 → 환산급여 (10억−7,000만)/30×12 = 3억7,200만
    expect(r.yearsDeduction).toBe(70_000_000)
    expect(r.convertedPay).toBeCloseTo(372_000_000, 6)
    // 환산급여공제 3억 초과 구간: 1억5,170만 + (3억7,200만−3억)×35% = 1억7,690만
    expect(r.payDeduction).toBeCloseTo(176_900_000, 6)
    expect(r.taxBase).toBeCloseTo(195_100_000, 6)
    // 기본세율 1.5억~3억 구간: 3,706만 + (1억9,510만−1.5억)×38%
    expect(r.appliedRate).toBeCloseTo(0.38, 10)
    expect(r.convertedTax).toBeCloseTo(37_060_000 + 45_100_000 * 0.38, 6)
    expect(r.incomeTax).toBeCloseTo((r.convertedTax / 12) * 30, 6)
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

  it("감가상각비 — 상각률·근거 조문·별표 4 출처를 동봉한다", async () => {
    const res = await handleFinCalc(null, {
      calc_type: "감가상각비",
      acquisition_cost: 100_000_000,
      useful_life: 5,
      method: "정률법",
      remaining_value: 100_000_000,
    })
    const t = res.content[0].text
    expect(res.isError).toBeFalsy()
    expect(t).toContain("45,100,000원")
    expect(t).toContain("45.1%")
    expect(t).toContain("별표 4")
    expect(t).toContain("법인세법 시행령 제26조제2항제2호")
    expect(t).toContain("계산 과정")
    expect(t).toContain("상각범위액")
  })

  it("감가상각비 — 정률법에 미상각잔액이 없으면 한글로 무엇이 필요한지 알린다", async () => {
    const res = await handleFinCalc(null, {
      calc_type: "감가상각비",
      acquisition_cost: 100_000_000,
      useful_life: 5,
      method: "정률법",
    })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain("INVALID_PARAMETER")
    expect(res.content[0].text).toContain("미상각잔액")
  })

  it("감가상각비 — 1년 미만 월수에 사유가 없으면 계산하지 않고 산식 갈래를 안내한다 (Opus 차단 회귀)", async () => {
    const res = await handleFinCalc(null, {
      calc_type: "감가상각비",
      acquisition_cost: 100_000_000,
      useful_life: 5,
      method: "정률법",
      remaining_value: 100_000_000,
      business_months: 6,
    })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain("short_period_basis")
    expect(res.content[0].text).toContain("§28②") // 환산내용연수 갈래를 알린다
  })

  it("감가상각비 — 사업연도 1년 미만이면 환산내용연수 근거를 밝힌다", async () => {
    const res = await handleFinCalc(null, {
      calc_type: "감가상각비",
      acquisition_cost: 100_000_000,
      useful_life: 5,
      method: "정률법",
      remaining_value: 100_000_000,
      business_months: 6,
      short_period_basis: "사업연도1년미만",
    })
    const t = res.content[0].text
    expect(res.isError).toBeFalsy()
    expect(t).toContain("25,900,000원") // 월할(22,550,000)이면 회귀
    expect(t).toContain("환산내용연수 10년")
    expect(t).toContain("제28조제2항")
  })

  it("감가상각비 — 미상각잔액 > 취득가액인 모순 입력은 계산하지 않는다 (Opus 중요 3)", async () => {
    const res = await handleFinCalc(null, {
      calc_type: "감가상각비",
      acquisition_cost: 100_000_000,
      useful_life: 5,
      method: "정률법",
      remaining_value: 200_000_000,
      business_months: 12,
    })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain("INVALID_PARAMETER")
    expect(res.content[0].text).toContain("취득가액을 넘을 수 없습니다")
  })

  it("가지급금인정이자 — 익금산입 요건 판정과 소득처분을 동봉한다", async () => {
    const res = await handleFinCalc(null, {
      calc_type: "가지급금인정이자",
      principal: 100_000_000,
      days: 365,
      rate_type: "당좌대출이자율",
    })
    const t = res.content[0].text
    expect(res.isError).toBeFalsy()
    expect(t).toContain("4,600,000원")
    expect(t).toContain("4.6%")
    expect(t).toContain("법인세법 시행규칙 제43조제2항")
    expect(t).toContain("익금산입 요건")
    expect(t).toContain("상여") // 소득처분 안내
    expect(t).toContain("제106조")
  })

  it("가지급금인정이자 — 적수도 금액·일수도 없으면 무엇을 달라는지 알린다", async () => {
    const res = await handleFinCalc(null, { calc_type: "가지급금인정이자" })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain("적수")
    expect(res.content[0].text).toContain("balance_days")
  })

  it("가지급금인정이자 — 가중평균 선택 시 이자율이 없으면 알린다", async () => {
    const res = await handleFinCalc(null, {
      calc_type: "가지급금인정이자",
      principal: 100_000_000,
      days: 365,
      rate_type: "가중평균차입이자율",
    })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain("weighted_average_rate")
  })

  it("가지급금인정이자 — 이자율을 소수로 잘못 넣으면 조용히 계산하지 않고 경고한다", async () => {
    const res = await handleFinCalc(null, {
      calc_type: "가지급금인정이자",
      principal: 100_000_000,
      days: 365,
      rate_type: "가중평균차입이자율",
      weighted_average_rate: 0.046, // 4.6%를 소수로 넣은 흔한 실수
    })
    expect(res.isError).toBeFalsy()
    expect(res.content[0].text).toContain("퍼센트 단위")
  })

  it("퇴직소득세 — 단계별 과정과 지방소득세를 별도 표기한다", async () => {
    const res = await handleFinCalc(null, {
      calc_type: "퇴직소득세",
      severance_pay: 100_000_000,
      service_years: 20,
    })
    const t = res.content[0].text
    expect(res.isError).toBeFalsy()
    expect(t).toContain("1,120,000원") // 산출세액 (국세청 공식 사례)
    expect(t).toContain("112,000원") // 개인지방소득세
    expect(t).toContain("환산급여")
    expect(t).toContain("근속연수공제")
    expect(t).toContain("소득세법 제48조")
    expect(t).toContain("지방세법 제92조")
  })

  it("모든 계산 유형이 산식 기준일·근거·출처를 동봉한다", async () => {
    const inputs = [
      { calc_type: "임원퇴직금한도", annual_salary: 120_000_000, years: 5 },
      { calc_type: "기업업무추진비한도", revenue: 5_000_000_000 },
      { calc_type: "감가상각비", acquisition_cost: 100_000_000, useful_life: 5, method: "정액법" },
      { calc_type: "가지급금인정이자", balance_days: 36_500_000_000, rate_type: "당좌대출이자율" },
      { calc_type: "퇴직소득세", severance_pay: 100_000_000, service_years: 20 },
    ]
    for (const input of inputs) {
      const res = await handleFinCalc(null, input)
      expect(res.isError, `${input.calc_type} 실패`).toBeFalsy()
      const t = res.content[0].text
      expect(t, `${input.calc_type}: 산식 기준 없음`).toContain("산식 기준")
      expect(t, `${input.calc_type}: 계산 과정 없음`).toContain("계산 과정")
      expect(t, `${input.calc_type}: 근거 없음`).toContain("근거:")
      expect(t, `${input.calc_type}: 주의 없음`).toContain("⚠ 주의")
      expect(t, `${input.calc_type}: 출처 없음`).toContain("출처")
    }
  })
})

describe("입력 스키마 — 조건부 필수 (Codex 리뷰: oneOf)", () => {
  const branchOf = (t: string) =>
    (FIN_CALC_TOOL.inputSchema as any).oneOf.find((b: any) => b.properties.calc_type.const === t)

  it("계산 유형별 필수 인자가 스키마에 표현된다 (평면 목록만으론 알 수 없음)", () => {
    expect(branchOf("임원퇴직금한도").required).toEqual(["calc_type", "annual_salary", "years"])
    expect(branchOf("기업업무추진비한도").required).toEqual(["calc_type", "revenue"])
    expect(branchOf("감가상각비").required).toEqual(["calc_type", "acquisition_cost", "useful_life", "method"])
    expect(branchOf("퇴직소득세").required).toEqual(["calc_type", "severance_pay", "service_years"])
  })

  it("한 단계 더 들어간 조건부 필수도 스키마에 표현된다", () => {
    // 정률법은 미상각잔액이 있어야 계산된다 — method 값에 따라 필수가 달라진다
    const dep = branchOf("감가상각비").anyOf
    expect(dep.find((b: any) => b.properties.method.const === "정률법").required).toContain("remaining_value")
    expect(dep.find((b: any) => b.properties.method.const === "정액법").required).not.toContain("remaining_value")
    // 인정이자는 적수를 직접 주거나 금액×일수로 주거나 둘 중 하나
    const interest = branchOf("가지급금인정이자").anyOf
    expect(interest.map((b: any) => b.required)).toEqual([
      ["calc_type", "balance_days"],
      ["calc_type", "principal", "days"],
    ])
  })

  it("모든 계산 유형이 enum과 oneOf 양쪽에 있다 (한쪽만 늘리면 호출이 막힌다)", () => {
    const schema = FIN_CALC_TOOL.inputSchema as any
    const enumTypes: string[] = schema.properties.calc_type.enum
    const oneOfTypes = schema.oneOf.map((b: any) => b.properties.calc_type.const)
    expect(oneOfTypes.sort()).toEqual([...enumTypes].sort())
    expect(enumTypes).toHaveLength(5)
  })

  it("oneOf를 못 읽는 클라이언트도 쓸 수 있게 properties는 평면으로 남긴다", () => {
    const props = (FIN_CALC_TOOL.inputSchema as any).properties
    for (const k of [
      "calc_type", "annual_salary", "years", "months", "revenue", "related_party_revenue", "is_sme", "business_months",
      "acquisition_cost", "useful_life", "method", "remaining_value",
      "balance_days", "principal", "days", "rate_type", "weighted_average_rate", "paid_interest", "is_leap_year",
      "severance_pay", "service_years",
    ]) {
      expect(props[k], `${k} 누락`).toBeDefined()
    }
  })

  it("스키마의 필수 목록이 zod 런타임 검증과 일치한다 (문서와 구현 괴리 방지)", async () => {
    // 스키마가 요구하는 것만 채우면 실제로 통과해야 한다
    const ok1 = await handleFinCalc(null, { calc_type: "임원퇴직금한도", annual_salary: 120_000_000, years: 5 })
    expect(ok1.isError).toBeFalsy()
    const ok2 = await handleFinCalc(null, { calc_type: "기업업무추진비한도", revenue: 5_000_000_000 })
    expect(ok2.isError).toBeFalsy()
    const ok3 = await handleFinCalc(null, {
      calc_type: "감가상각비",
      acquisition_cost: 100_000_000,
      useful_life: 5,
      method: "정액법",
    })
    expect(ok3.isError).toBeFalsy()
    const ok4 = await handleFinCalc(null, { calc_type: "가지급금인정이자", balance_days: 36_500_000_000, rate_type: "당좌대출이자율" })
    expect(ok4.isError).toBeFalsy()
    const ok5 = await handleFinCalc(null, {
      calc_type: "퇴직소득세",
      severance_pay: 100_000_000,
      service_years: 20,
    })
    expect(ok5.isError).toBeFalsy()
    // 하나라도 빠지면 실패해야 한다
    const ng = await handleFinCalc(null, { calc_type: "기업업무추진비한도" })
    expect(ng.isError).toBe(true)
    const ng2 = await handleFinCalc(null, { calc_type: "퇴직소득세", severance_pay: 100_000_000 })
    expect(ng2.isError).toBe(true)
  })

  it("오류 메시지가 한글로 무엇이 필요한지 알려준다", async () => {
    const res = await handleFinCalc(null, { calc_type: "임원퇴직금한도" })
    const t = res.content[0].text
    expect(t).toContain("총급여액")
    expect(t).toContain("근속 연수")
    expect(t).not.toContain("expected number") // zod 기본 영어 메시지 노출 금지
  })

  it("계산 유형 오기는 선택지를 안내한다", async () => {
    const res = await handleFinCalc(null, { calc_type: "없는유형" })
    const t = res.content[0].text
    for (const type of (FIN_CALC_TOOL.inputSchema as any).properties.calc_type.enum) {
      expect(t, `${type}가 안내에 없음`).toContain(type)
    }
  })
})

/**
 * Codex 공개 전 리뷰 차단 1·중요 1 회귀.
 * 법인세법 시행령 제89조제3항 본문은 **가중평균차입이자율이 시가**이고,
 * 당좌대출이자율은 단서 각 호(적용 불가 사유·5년 초과 대여·신고 시 선택)의 예외다.
 * 예외를 기본값으로 두면 사용자가 생략했을 때 법정 원칙과 반대인 4.6%로
 * 확정 금액이 나가고, 함께 준 weighted_average_rate까지 무시된다.
 */
describe("가지급금 인정이자 — 이자율 원칙·예외 (Codex 리뷰 차단 1)", () => {
  it("rate_type을 생략하면 계산하지 않고 원칙·예외를 안내한다", async () => {
    const res = await handleFinCalc(null, {
      calc_type: "가지급금인정이자",
      principal: 100_000_000,
      days: 365,
      weighted_average_rate: 9,
    })
    expect(res.isError).toBe(true)
    const t = res.content[0].text
    expect(t).toContain("[INVALID_PARAMETER]")
    expect(t).toContain("rate_type")
    // 원칙이 무엇인지 밝힌다 — 4.6%로 조용히 계산하지 않는다
    expect(t).toContain("가중평균차입이자율")
    expect(t).toContain("원칙")
    expect(t).not.toContain("4,600,000원")
  })

  it("가중평균차입이자율을 주면 그 이자율로 계산한다 (4.6% 대체 금지)", async () => {
    const res = await handleFinCalc(null, {
      calc_type: "가지급금인정이자",
      principal: 100_000_000,
      days: 365,
      rate_type: "가중평균차입이자율",
      weighted_average_rate: 9,
    })
    expect(res.isError).toBeFalsy()
    const t = res.content[0].text
    expect(t).toContain("9,000,000원")
    expect(t).not.toContain("4,600,000원")
  })

  it("당좌대출이자율을 고르면 예외 사유 확인을 요구한다", async () => {
    const res = await handleFinCalc(null, {
      calc_type: "가지급금인정이자",
      principal: 100_000_000,
      days: 365,
      rate_type: "당좌대출이자율",
    })
    expect(res.isError).toBeFalsy()
    const t = res.content[0].text
    expect(t).toContain("4,600,000원")
    expect(t).toContain("단서")
    expect(t).toContain("예외")
  })

  it("적수를 두 형태로 함께 주면 조용히 한쪽을 쓰지 않고 거부한다 (Codex 중요 1)", async () => {
    const res = await handleFinCalc(null, {
      calc_type: "가지급금인정이자",
      balance_days: 36_500_000_000,
      principal: 1_000_000,
      days: 1,
      rate_type: "당좌대출이자율",
    })
    expect(res.isError).toBe(true)
    const t = res.content[0].text
    expect(t).toContain("중복")
    // 두 값을 모두 보여줘 무엇이 충돌하는지 알린다
    expect(t).toContain("36,500,000,000")
    expect(t).toContain("1,000,000")
  })
})

/**
 * Codex 공개 전 리뷰 차단 2 회귀 — 월할 사업연도 + 정률법 마무리 연도.
 * §26⑧⑨는 "제1항을 적용함에 있어서" 상각범위액을 월할하라 하고, §26⑥ 단서는
 * 5% 잔존가액을 "그 사업연도의 상각범위액에 가산한다"고만 한다. 가산분까지
 * 월할하는지는 조문이 정하지 않았다 — 가산분을 전액 더하면 6개월인데 12개월과
 * 같은 금액이 나오므로, 어느 한쪽으로 확정 금액을 내면 안 된다.
 */
describe("감가상각 — 월할 사업연도의 마무리 연도 (Codex 리뷰 차단 2)", () => {
  const shortFinal = {
    calc_type: "감가상각비" as const,
    acquisition_cost: 100_000_000,
    useful_life: 5,
    method: "정률법" as const,
    remaining_value: 5_500_000,
    business_months: 6,
    short_period_basis: "기중취득" as const,
  }

  it("확정 금액 하나로 답하지 않고 두 해석을 병기한다", async () => {
    const res = await handleFinCalc(null, shortFinal)
    expect(res.isError).toBeFalsy()
    const t = res.content[0].text
    expect(t).toContain("두 해석이 갈립니다")
    expect(t).toContain("5,499,000원") // ⓐ 가산분 월할 안 함
    expect(t).toContain("3,740,250원") // ⓑ 가산분도 월할
    expect(t).toContain("§26⑥")
  })

  it("6개월인데 12개월과 같은 금액이 될 수 있다는 사실을 밝힌다", async () => {
    const res = await handleFinCalc(null, shortFinal)
    expect(res.content[0].text).toContain("12개월과 같은 금액")
  })

  it("월할이 아닌 통상 마무리 연도는 종전대로 단일 금액이다 (불필요한 갈래 금지)", async () => {
    const res = await handleFinCalc(null, { ...shortFinal, business_months: 12, short_period_basis: undefined })
    const t = res.content[0].text
    expect(t).not.toContain("두 해석이 갈립니다")
    expect(t).toContain("상각범위액: 5,499,000원")
  })

  it("마무리 연도가 아닌 월할 사업연도도 단일 금액이다", async () => {
    const res = await handleFinCalc(null, { ...shortFinal, remaining_value: 100_000_000 })
    const t = res.content[0].text
    expect(t).not.toContain("두 해석이 갈립니다")
  })
})
