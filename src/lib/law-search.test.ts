/**
 * resolvedLawMatches 종류(본법/시행령/시행규칙) 일치 회귀 테스트 (순수 함수 — CI 상시)
 * Opus 리뷰 I1: looseMatch의 접두 허용 때문에 "법인세법 시행령" 요청이 본법과
 * 매칭되어 본법 MST로 조문을 검증하고 ✓를 내던 결함을 박제한다.
 */

import { describe, it, expect } from "vitest"
import { lawTierOf, resolvedLawMatches, sameLawFamily, stripNonLawKeywords } from "./law-search.js"

describe("stripNonLawKeywords — 법령 종류 보존 (Codex 리뷰 중요 3 회귀)", () => {
  it("시행령·시행규칙은 부가 키워드가 아니라 법령 종류이므로 보존한다", () => {
    // 제거하면 검색이 본법으로 축약돼 I1의 종류 일치 필터가 검색 경로에서 무력해진다
    expect(stripNonLawKeywords("법인세법 시행령")).toBe("법인세법 시행령")
    expect(stripNonLawKeywords("법인세법 시행규칙")).toBe("법인세법 시행규칙")
    expect(stripNonLawKeywords("소득세법 시행령 제163조")).toContain("시행령")
  })

  it("진짜 부가 키워드는 계속 제거한다", () => {
    expect(stripNonLawKeywords("관세법 과태료 기준")).toBe("관세법")
    expect(stripNonLawKeywords("법인세법 판례 해석")).toBe("법인세법")
    expect(stripNonLawKeywords("부가가치세법 별표")).toBe("부가가치세법")
  })

  it("시행령 + 부가 키워드가 섞이면 종류만 남긴다", () => {
    expect(stripNonLawKeywords("법인세법 시행령 별표")).toBe("법인세법 시행령")
  })
})

describe("lawTierOf", () => {
  it("접미사로 본법/시행령/시행규칙을 판별한다", () => {
    expect(lawTierOf("법인세법")).toBe("본법")
    expect(lawTierOf("법인세법 시행령")).toBe("시행령")
    expect(lawTierOf("법인세법 시행규칙")).toBe("시행규칙")
    expect(lawTierOf("법인세법시행령")).toBe("시행령") // 공백 없는 표기
  })
})

describe("resolvedLawMatches — 본법/시행령 혼동 (Opus I1 회귀)", () => {
  it("시행령 요청이 본법과 매칭되지 않는다 (핵심 결함)", () => {
    expect(resolvedLawMatches("법인세법 시행령", "법인세법")).toBe(false)
  })

  it("본법 요청이 시행령과 매칭되지 않는다", () => {
    expect(resolvedLawMatches("법인세법", "법인세법 시행령")).toBe(false)
  })

  it("시행령 요청이 시행규칙과 매칭되지 않는다", () => {
    expect(resolvedLawMatches("법인세법 시행령", "법인세법 시행규칙")).toBe(false)
  })

  it("시행규칙 요청이 본법과 매칭되지 않는다", () => {
    expect(resolvedLawMatches("소득세법 시행규칙", "소득세법")).toBe(false)
  })

  it("같은 종류끼리는 매칭된다", () => {
    expect(resolvedLawMatches("법인세법", "법인세법")).toBe(true)
    expect(resolvedLawMatches("법인세법 시행령", "법인세법 시행령")).toBe(true)
    expect(resolvedLawMatches("법인세법시행령", "법인세법 시행령")).toBe(true)
  })

  it("검색 결과에서 시행령 요청은 시행령을 고른다 (verify laws.find 시뮬레이션)", () => {
    const searchResult = ["법인세법", "법인세법 시행령", "법인세법 시행규칙"]
    const picked = searchResult.find((n) => resolvedLawMatches("법인세법 시행령", n))
    expect(picked).toBe("법인세법 시행령")
  })

  it("별칭이 종류를 바꾸는 케이스도 canonical 해소 후 매칭된다 (관시령→관세법 시행령)", () => {
    expect(resolvedLawMatches("관시령", "관세법 시행령")).toBe(true)
    expect(resolvedLawMatches("관시령", "관세법")).toBe(false)
  })

  it("본법 별칭 매칭은 유지된다 (공정거래법→독점규제 및 공정거래에 관한 법률)", () => {
    expect(resolvedLawMatches("공정거래법", "독점규제 및 공정거래에 관한 법률")).toBe(true)
  })

  it("부분매칭 함정은 여전히 차단된다 (민법≠난민법, 지방세법≠지방교부세법)", () => {
    expect(resolvedLawMatches("민법", "난민법")).toBe(false)
    expect(resolvedLawMatches("지방세법", "지방교부세법")).toBe(false)
  })
})

describe("sameLawFamily — 별표 소속 대조 (하위법령 통과, 유사 법령 차단)", () => {
  it("본법 조회에 시행규칙 별표(기준내용연수표)가 통과된다 (골든셋 #1)", () => {
    expect(sameLawFamily("법인세법", "법인세법 시행규칙")).toBe(true)
    expect(sameLawFamily("법인세법", "법인세법 시행령")).toBe(true)
    expect(sameLawFamily("법인세법 시행규칙", "법인세법")).toBe(true)
  })

  it("유사 법령은 여전히 차단된다", () => {
    expect(sameLawFamily("지방세법", "지방교부세법 시행규칙")).toBe(false)
    expect(sameLawFamily("법인세법", "소득세법 시행규칙")).toBe(false)
  })
})
