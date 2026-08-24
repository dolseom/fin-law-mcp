/**
 * fin_verify 인용 추출 회귀 테스트 (순수 함수 — CI 상시)
 * Codex 코드 리뷰 중요 1의 오탐 케이스를 박제한다.
 */

import { describe, it, expect } from "vitest"
import { extractCitations, extractCitationsWithTotal } from "./verify.js"

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

describe("extractCitations — 문맥 흡수·조응 오인·「」 우회 (Opus 리뷰 B2 회귀 — 6문장)", () => {
  it("1. '…바와 같은'이 조응으로 오인되지 않고 명시 법령명을 추출한다", () => {
    const cites = extractCitations("법인세법 제26조 제1항에서 정하는 바와 같은 법인세법 시행령 제43조")
    expect(cites.map((c) => c.lawName)).toEqual(["법인세법", "법인세법 시행령"])
  })

  it("2. 주제격 조사 어절('상여금은')이 법령명에 흡수되지 않는다", () => {
    const cites = extractCitations("임원 상여금은 부가가치세법 제1조 및 근로기준법 제2조에 따라 판단한다")
    expect(cites.map((c) => c.lawName)).toEqual(["부가가치세법", "근로기준법"])
  })

  it("3. 연결어미 어절('비과세소득이며')이 법령명에 흡수되지 않는다", () => {
    const cites = extractCitations("소득세법 제12조 규정에 의한 비과세소득이며 상법 제169조도 참고한다")
    expect(cites.map((c) => c.lawName)).toEqual(["소득세법", "상법"])
  })

  it("4. 지시어('이는')·'취지이며' 문맥이 잘려나간다", () => {
    const cites = extractCitations(
      "이는 국세기본법 제14조 실질과세 원칙과 같은 취지이며 법인세법 제52조 부당행위계산부인이 적용된다"
    )
    expect(cites.map((c) => c.lawName)).toEqual(["국세기본법", "법인세법"])
  })

  it("5. '산정하고 동법'의 동법이 조응으로 해소된다 (문맥 흡수 없이)", () => {
    const cites = extractCitations("관세법 제30조 과세가격 결정 원칙에 따라 산정하고 동법 제31조를 보충 적용한다")
    expect(cites.map((c) => c.lawName)).toEqual(["관세법", "관세법"])
    expect(cites[1].article).toBe("제31조")
  })

  it("6. 실존하지 않는 법령명('부동산 관련법')은 문맥 없이 그대로 추출되어 ✗ 경로로 간다", () => {
    const cites = extractCitations("지방세법 제105조 취득세 과세대상이며 부동산 관련법 제3조도 검토한다")
    expect(cites.map((c) => c.lawName)).toEqual(["지방세법", "부동산 관련법"])
  })

  it("'노동법'의 '동법'이 조응으로 오인되지 않는다 (룩비하인드)", () => {
    // 오인되면 직전 법령(지방세법)의 제5조로 검증되어 틀린 인용에 ✓가 나온다
    const cites = extractCitations("지방세법 제1조. 노동법 제5조.")
    expect(cites.map((c) => c.lawName)).toEqual(["지방세법", "노동법"])
  })

  it("문장 시작의 '노동법'도 명시 법령명으로 추출된다", () => {
    const cites = extractCitations("노동법 제5조에 따른다.")
    expect(cites).toHaveLength(1)
    expect(cites[0].lawName).toBe("노동법")
  })

  it("「법인세법」 제26조 표준 표기가 조문 검증 경로(법령조문)로 추출된다", () => {
    const cites = extractCitations("「법인세법」 제26조에 따라 손금불산입한다.")
    expect(cites).toHaveLength(1)
    expect(cites[0].kind).toBe("법령조문")
    expect(cites[0].lawName).toBe("법인세법")
    expect(cites[0].article).toBe("제26조")
  })

  it("「법인세법 시행령」 제43조도 조문 포함 추출된다", () => {
    const cites = extractCitations("「법인세법 시행령」 제43조 제2항")
    expect(cites).toHaveLength(1)
    expect(cites[0].kind).toBe("법령조문")
    expect(cites[0].lawName).toBe("법인세법 시행령")
    expect(cites[0].article).toBe("제43조")
  })

  it("앞 인용의 조문 어절이 다음 법령명에 흡수되지 않는다 (「법인세법」 제26조 및 지방세법 제1조)", () => {
    const cites = extractCitations("「법인세법」 제26조 및 지방세법 제1조를 검토한다.")
    expect(cites.map((c) => c.lawName)).toEqual(["법인세법", "지방세법"])
    expect(cites[1].raw).toBe("지방세법 제1조")
  })

  it("「」 인용이 조응('같은 법')의 선행사가 된다", () => {
    const cites = extractCitations("「소득세법」 제12조를 본다. 같은 법 시행령 제11조도 확인한다.")
    expect(cites.map((c) => c.lawName)).toEqual(["소득세법", "소득세법 시행령"])
  })

  it("행정규칙 인용은 조응 선행사를 갱신하지 않는다 (기존 회귀 유지)", () => {
    const cites = extractCitations(
      "법인세법 제26조를 본다. 법인세법 기본통칙 19-19…46을 참고한다. 같은 법 시행령 제43조를 적용한다."
    )
    const anaphor = cites[cites.length - 1]
    expect(anaphor.lawName).toBe("법인세법 시행령")
  })
})

describe("조응 시행규칙 형태 (Codex 리뷰 중요 5 회귀)", () => {
  it("'동 시행규칙 제N조'를 추출한다 (누락되면 검증 없이 넘어감)", () => {
    const cites = extractCitations("법인세법 제26조에 따라 처리하고 동 시행규칙 제3조를 본다.")
    expect(cites).toHaveLength(2)
    expect(cites[1].lawName).toBe("법인세법 시행규칙")
    expect(cites[1].article).toBe("제3조")
  })

  it("본법 뒤의 '같은 규칙'은 시행규칙으로 넘겨짚지 않는다 (Opus B-0 — 넘겨짚으면 틀린 법령에 ✓)", () => {
    // "같은 규칙"은 직전에 인용된 **규칙 자체**를 가리킨다. 규칙 선행사가 없으면
    // 본법의 시행규칙으로 단정하지 말고 ⚠(선행사 불명) 경로로 보내야 한다
    const cites = extractCitations("소득세법 제12조를 본다. 같은 규칙 제5조도 확인한다.")
    expect(cites).toHaveLength(2)
    expect(cites[1].lawName).toBe("")
  })

  it("'같은 규칙'은 직전에 인용된 「…에 관한 규칙」을 가리킨다", () => {
    const cites = extractCitations(
      "산업안전보건법 제38조 및 「산업안전보건기준에 관한 규칙」 제32조, 같은 규칙 제33조를 본다."
    )
    expect(cites).toHaveLength(3)
    expect(cites[1].lawName).toBe("산업안전보건기준에 관한 규칙") // 「」 규칙 인용이 추출된다
    expect(cites[2].lawName).toBe("산업안전보건기준에 관한 규칙") // 본법 시행규칙이 아니다
  })

  it("행정규칙(고시) 뒤의 '같은 규칙'은 두 칸 앞 본법을 끌어오지 않는다", () => {
    const cites = extractCitations("법인세법 제26조와 「전자세금계산서 발급 고시」 제3조, 같은 규칙 제5조")
    const anaphor = cites[cites.length - 1]
    expect(anaphor.lawName).toBe("") // "법인세법 시행규칙"이면 회귀
  })

  it("'동 시행령'은 시행령으로 유지된다 (회귀 없음)", () => {
    const cites = extractCitations("법인세법 제26조에 따라 처리하고 동 시행령 제43조를 본다.")
    expect(cites[1].lawName).toBe("법인세법 시행령")
  })

  it("'같은 법 시행규칙' 형태도 계속 동작한다", () => {
    const cites = extractCitations("법인세법 제26조에 따라 처리하고 같은 법 시행규칙 제3조를 본다.")
    expect(cites[1].lawName).toBe("법인세법 시행규칙")
  })
})

describe("정식 법령명 절단 방지 (Opus B-3 회귀)", () => {
  it("'하는'이 든 정식 법령명을 자르지 않는다 (사전 최장 일치)", () => {
    const cites = extractCitations("국가를 당사자로 하는 계약에 관한 법률 제7조에 따라 계약을 체결한다.")
    expect(cites[0].lawName).toBe("국가를 당사자로 하는 계약에 관한 법률")
  })

  it("'위한'이 든 긴 법령명도 유지한다", () => {
    const cites = extractCitations("자유무역협정의 이행을 위한 관세법의 특례에 관한 법률 제5조를 본다.")
    expect(cites[0].lawName).toBe("자유무역협정의 이행을 위한 관세법의 특례에 관한 법률")
  })

  it("서로 다른 두 법의 같은 조문이 병합돼 사라지지 않는다", () => {
    const { citations, total } = extractCitationsWithTotal(
      "국가를 당사자로 하는 계약에 관한 법률 제7조와 지방자치단체를 당사자로 하는 계약에 관한 법률 제7조를 비교한다."
    )
    expect(total).toBe(2)
    expect(citations).toHaveLength(2)
    expect(citations[0].lawName).not.toBe(citations[1].lawName)
  })

  it("컷이 일어난 경우 컷 전 이름을 보존한다 (검증 단계 재시도·고지용)", () => {
    const cites = extractCitations("당해 사업연도 귀속 법인세법 제26조를 적용한다.")
    expect(cites[0].lawName).toBe("법인세법")
    expect(cites[0].uncut).toContain("당해") // 원문 표기 보존
  })

  it("같은 법령명이 앞에도 나오면 raw에 문맥이 남지 않는다", () => {
    const cites = extractCitations("소득세법에 따라 소득세법 제12조를 본다")
    expect(cites[0].raw).toBe("소득세법 제12조")
  })
})

describe("extractCitationsWithTotal — 절단 고지 (Opus I4 회귀)", () => {
  it("상한(15건) 초과 시 절단 전 총수를 함께 돌려준다", () => {
    const many = Array.from({ length: 22 }, (_, i) => `법인세법 제${i + 1}조`).join(", ")
    const { citations, total } = extractCitationsWithTotal(many)
    expect(citations).toHaveLength(15)
    expect(total).toBe(22)
  })

  it("상한 이내면 total === citations.length", () => {
    const { citations, total } = extractCitationsWithTotal("법인세법 제26조 및 소득세법 제12조")
    expect(total).toBe(citations.length)
  })
})
