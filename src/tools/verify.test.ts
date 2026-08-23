/**
 * fin_verify 인용 추출 회귀 테스트 (순수 함수 — CI 상시)
 * Codex 코드 리뷰 중요 1의 오탐 케이스를 박제한다.
 */

import { describe, it, expect } from "vitest"
import { extractCitations } from "./verify.js"

describe("extractCitations — 접속사 오탐 방지 (Codex 리뷰 회귀)", () => {
  it("'및'으로 이어진 두 법령을 각각 정확히 추출한다", () => {
    const cites = extractCitations("법인세법 제26조 및 소득세법 제12조에 따라 처리한다.")
    expect(cites).toHaveLength(2)
    expect(cites[0].lawName).toBe("법인세법")
    expect(cites[1].lawName).toBe("소득세법") // "및 소득세법"이면 회귀
  })

  it("접속사 뒤 법령이 '같은 법' 조응의 선행사를 오염시키지 않는다", () => {
    const cites = extractCitations(
      "법인세법 제26조 및 소득세법 제12조를 검토한다. 같은 법 시행령 제163조도 확인한다."
    )
    expect(cites).toHaveLength(3)
    expect(cites[2].lawName).toBe("소득세법 시행령") // 직전 명시 법령 기준
  })

  it("긴 법령명(40자 경계)도 절단 없이 추출한다", () => {
    const cites = extractCitations(
      "고용보험 및 산업재해보상보험의 보험료징수 등에 관한 법률 제13조에 따른 보험료"
    )
    expect(cites.length).toBeGreaterThanOrEqual(1)
    const hit = cites.find((c) => c.lawName.includes("보험료징수"))
    expect(hit).toBeDefined()
    expect(hit!.lawName).toContain("고용보험")
  })

  it("조응 선행사가 없는 '같은 법'은 빈 법령명으로 표시된다 (⚠ 경로)", () => {
    const cites = extractCitations("같은 법 제5조를 참고한다.")
    expect(cites).toHaveLength(1)
    expect(cites[0].lawName).toBe("")
  })

  it("기본통칙 인용을 행정규칙으로 추출한다", () => {
    const cites = extractCitations("법인세법 기본통칙 19-19…46에 따라 처리한다.")
    const tongchik = cites.find((c) => c.kind === "행정규칙")
    expect(tongchik?.lawName).toBe("법인세법 기본통칙")
  })
})
