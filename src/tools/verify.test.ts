/**
 * fin_verify 인용 추출 회귀 테스트 (순수 함수 — CI 상시)
 * Codex 코드 리뷰 중요 1의 오탐 케이스를 박제한다.
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import { extractCitations, extractCitationsWithTotal, handleFinVerify } from "./verify.js"
import { LawApiClient } from "../lib/api-client.js"

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

describe("사전 최장 일치 어절 경계 (Opus B-3 재검증 회귀 — 꼬리 일치 오검증)", () => {
  it("'국가배상법'이 사전의 「상법」으로 절단되지 않는다 (절단되면 무관한 법 조문에 ✓)", () => {
    const cites = extractCitations("국가배상법 제2조에 따라 국가는 손해를 배상할 책임이 있다.")
    expect(cites).toHaveLength(1)
    expect(cites[0].lawName).toBe("국가배상법")
    expect(cites[0].raw).toContain("국가배상법") // "상법 제2조"로 변조되면 회귀
  })

  it("'난민법'→민법, '군형법'→형법 절단도 일어나지 않는다", () => {
    const cites = extractCitations("난민법 제99조와 군형법 제41조를 본다.")
    expect(cites.map((c) => c.lawName)).toEqual(["난민법", "군형법"])
  })

  it("시행령 표기도 오염되지 않는다 ('난민법 시행령'이 '민법 시행령'이 되면 회귀)", () => {
    const cites = extractCitations("난민법 시행령 제2조를 본다.")
    expect(cites[0].lawName).toBe("난민법 시행령")
  })

  it("어절 경계에서 시작하는 사전명은 계속 최장 일치로 잡힌다 (문맥 어절 뒤 상법)", () => {
    const cites = extractCitations("손해배상 청구는 상법 제2조를 본다.")
    expect(cites[0].lawName).toBe("상법")
  })
})

describe("'구 ○○법' 연혁 인용 (Opus 공개전 리뷰 중요 2 회귀)", () => {
  it("raw에 '구'가 보존된다 (지워지면 어느 인용이 검증됐는지 알 수 없다)", () => {
    const cites = extractCitations("구 법인세법 제26조에 따라 손금불산입한다.")
    expect(cites).toHaveLength(1)
    expect(cites[0].raw).toBe("구 법인세법 제26조")
    expect(cites[0].historical).toBe(true)
  })

  it("'구'가 없는 인용에는 연혁 표지가 붙지 않는다", () => {
    const cites = extractCitations("법인세법 제26조에 따른다.")
    expect(cites[0].historical).toBeUndefined()
  })
})

describe("규칙·규정 선행사 분리 (Opus B-0③ 재검증 회귀)", () => {
  it("'같은 규칙'은 「…규정」을 선행사로 삼지 않는다 (규칙·규정 혼재 문장)", () => {
    const cites = extractCitations(
      "「산업안전보건기준에 관한 규칙」 제32조와 「공무원보수규정」 제31조를 보면, 같은 규칙 제33조에 따라야 한다."
    )
    expect(cites).toHaveLength(3)
    expect(cites[1].lawName).toBe("공무원보수규정")
    expect(cites[2].lawName).toBe("산업안전보건기준에 관한 규칙") // 「공무원보수규정」이면 회귀
  })

  it("「…규정」만 있는 문장의 '같은 규칙'은 넘겨짚지 않고 ⚠ 경로로 간다", () => {
    const cites = extractCitations("「공무원보수규정」 제31조를 본다. 같은 규칙 제32조를 본다.")
    expect(cites).toHaveLength(2)
    expect(cites[1].lawName).toBe("")
  })
})

// ── 「…규정」 법령 DB 0건 → 행정규칙 폴백 (Opus B-0① 재검증 회귀 — fixture) ──

const EMPTY_LAW_XML = '<?xml version="1.0"?><LawSearch><totalCnt>0</totalCnt></LawSearch>'
const ADMRUL_HIT_XML =
  '<?xml version="1.0"?><AdmRulSearch><totalCnt>1</totalCnt><admrul>' +
  "<행정규칙명>조사사무처리규정</행정규칙명><행정규칙종류>훈령</행정규칙종류>" +
  "<소관부처명>국세청</소관부처명><발령일자>20240101</발령일자></admrul></AdmRulSearch>"
const ADMRUL_EMPTY_XML = '<?xml version="1.0"?><AdmRulSearch><totalCnt>0</totalCnt></AdmRulSearch>'

function stubFetchByUrl(routes: Array<{ match: string; body: string }>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input)
      const hit = routes.find((r) => url.includes(r.match))
      return new Response(hit ? hit.body : EMPTY_LAW_XML, { status: 200 })
    })
  )
}

describe("「…규정」 법령 DB 0건 → 행정규칙 폴백 (Opus B-0① 재검증 회귀)", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("실존 행정규칙(훈령)이 ✗ 환각 의심이 아니라 ✓ 명칭 실존으로 판정된다", async () => {
    stubFetchByUrl([{ match: "target=admrul", body: ADMRUL_HIT_XML }])
    const res = await handleFinVerify(new LawApiClient({ apiKey: "testkey" }), {
      text: "「조사사무처리규정」 제23조에 따라 세무조사를 실시한다.",
    })
    const text = res.content[0].text
    expect(text).toContain("✓")
    expect(text).toContain("행정규칙 「조사사무처리규정」 실존")
    expect(text).toContain("명칭 실존만") // 검증범위 정직 표기 유지
    expect(text).not.toContain("환각 의심")
  })

  it("법령·행정규칙·연혁 DB 모두 0건이면 확인 범위를 밝히고 ✗", async () => {
    stubFetchByUrl([{ match: "target=admrul", body: ADMRUL_EMPTY_XML }])
    const res = await handleFinVerify(new LawApiClient({ apiKey: "testkey" }), {
      text: "「가공무역거래처리규정」 제5조를 준수한다.",
    })
    const text = res.content[0].text
    expect(text).toContain("✗")
    expect(text).toContain("법령·행정규칙·연혁 DB 모두 0건")
  })
})

describe("현행 0건 → 폐지·연혁 확인 (Opus 재검증 개선 — findRepealedLaw 배선)", () => {
  afterEach(() => vi.unstubAllGlobals())

  const REPEALED_XML =
    '<?xml version="1.0"?><LawSearch><totalCnt>1</totalCnt><law id="1">' +
    "<법령명한글>택지소유상한에 관한 법률</법령명한글><법령ID>1</법령ID>" +
    "<법령일련번호>222</법령일련번호><법령구분명>법률</법령구분명>" +
    "<현행연혁코드>연혁</현행연혁코드><시행일자>19980925</시행일자></law></LawSearch>"

  it("폐지 법령 인용은 ✗ 환각 의심이 아니라 ⚠ 폐지 추정으로 판정된다", async () => {
    stubFetchByUrl([{ match: "target=eflaw", body: REPEALED_XML }])
    const res = await handleFinVerify(new LawApiClient({ apiKey: "testkey" }), {
      text: "택지소유상한에 관한 법률 제5조에 따라 부담금을 부과한다.",
    })
    const text = res.content[0].text
    expect(text).toContain("⚠")
    expect(text).toContain("폐지·연혁 법령")
    expect(text).toContain("basis_date")
    expect(text).not.toContain("환각 의심")
  })

  it("연혁에도 없는 환각 약칭은 ⚠이되 요약 헤더로 사용 보류를 요구한다", async () => {
    stubFetchByUrl([]) // 전 경로 0건
    const res = await handleFinVerify(new LawApiClient({ apiKey: "testkey" }), {
      text: "탄소세법 제5조를 적용한다.",
    })
    const text = res.content[0].text
    expect(text).toContain("⚠")
    expect(text).toContain("미확인 약칭 인용 있음") // 요약 헤더 (조용한 통과 금지)
    expect(text).toContain("사용을 보류")
    expect(text).toContain("현행·연혁 법령 DB 어디에도 없습니다")
  })

  it("정식 명칭 형태(7자+)의 순수 환각은 연혁 확인 후에도 ✗를 유지한다", async () => {
    stubFetchByUrl([]) // 전 경로 0건
    const res = await handleFinVerify(new LawApiClient({ apiKey: "testkey" }), {
      text: "가상자산투기억제법 제3조를 검토한다.",
    })
    const text = res.content[0].text
    expect(text).toContain("✗")
    expect(text).toContain("현행·연혁 모두 0건")
  })
})

/**
 * Codex 공개 전 리뷰 중요 6 회귀 — 따옴표 없는 「…규정」·「…규칙」 + 조문 인용.
 *
 * 행정규칙 조문 추출 정규식이 고시·훈령·예규·통칙·기준·지침만 받아,
 * "외국환거래규정 제23조"는 추출조차 되지 않았다. 판정이 ✗도 ⚠도 아니라
 * **"추출된 인용 0건"** 이었다 — 환각 인용("탄소배출권거래규정 제77조")이
 * 검증 없이 통과하는 조용한 누락이다 (verify-file 훅의 마지막 관문이 열려 있었다).
 */
describe("extractCitations — 따옴표 없는 규정·규칙 조문 (Codex 리뷰 중요 6)", () => {
  it("「」 없는 「…규정」 + 조문을 인용으로 잡는다", () => {
    const cites = extractCitations("외국환거래규정 제23조에 따라 신고한다.")
    expect(cites).toHaveLength(1)
    expect(cites[0].lawName).toBe("외국환거래규정")
    expect(cites[0].article).toBe("제23조")
  })

  it("환각 규정 인용도 0건으로 통과시키지 않는다", () => {
    const cites = extractCitations("탄소배출권거래규정 제77조에 따라 신고한다.")
    expect(cites.length).toBeGreaterThan(0)
    expect(cites[0].article).toBe("제77조")
  })

  it("「…규정」·「…규칙」은 법령조문 경로로 보낸다 (법령 DB → 행정규칙 폴백이 배선돼 있다)", () => {
    const cites = extractCitations("조사사무처리규정 제23조에 따라 처리한다.")
    expect(cites[0].kind).toBe("법령조문")
  })

  it("시행규칙 조문은 기존 법령 경로가 처리한다 (행정규칙으로 강등 금지)", () => {
    const cites = extractCitations("법인세법 시행규칙 제15조에서 정한 바에 따른다.")
    expect(cites).toHaveLength(1)
    expect(cites[0].kind).toBe("법령조문")
    expect(cites[0].lawName).toContain("법인세법")
    expect(cites[0].article).toBe("제15조")
  })

  it("고시·훈령류는 종전대로 행정규칙 경로다", () => {
    const cites = extractCitations("식품등의 표시기준 제3조에 따른다.")
    expect(cites[0].kind).toBe("행정규칙")
  })

  it("같은 조문을 두 경로가 중복 추출하지 않는다", () => {
    const cites = extractCitations("「외국환거래규정」 제23조에 따라 신고한다.")
    expect(cites).toHaveLength(1)
  })
})

/**
 * 규정·규칙 추출 확장의 **부작용** 회귀 (자체 점검에서 발견).
 *
 * 접미사를 넓히면 두 가지가 딸려온다:
 *  ① "같은 규정"이 조응으로 인식되지 않아 "와 같은 규정"이 법령명으로 캡처되고
 *     lawName이 "규정"이 되어 LIKE 검색에 무관한 법령이 걸린다 (오검증 위험)
 *  ② 사내 문서("당사 취업규칙 제12조")가 법령 인용으로 잡혀 ✗ 환각 낙인이 찍힌다
 */
describe("extractCitations — 규정·규칙 확장의 부작용 방어", () => {
  it('"같은 규정"을 조응으로 해소한다 (법령명이 "규정"이 되지 않는다)', () => {
    const cites = extractCitations("외국환거래규정 제23조와 같은 규정 제24조를 함께 본다.")
    expect(cites).toHaveLength(2)
    expect(cites[0].lawName).toBe("외국환거래규정")
    expect(cites[1].lawName).toBe("외국환거래규정")
    expect(cites[1].article).toBe("제24조")
    // 조응이 안 잡히면 lawName이 "규정"이 되어 무관 법령에 ✓가 나갈 수 있다
    expect(cites.some((c) => c.lawName === "규정")).toBe(false)
  })

  it('"같은 규정"에 규정 선행사가 없으면 넘겨짚지 않는다', () => {
    const cites = extractCitations("법인세법 제26조와 같은 규정 제24조를 본다.")
    const anaphor = cites.find((c) => c.raw.includes("같은 규정"))
    // 본법을 선행사로 삼으면 엉뚱한 법령에 ✓가 된다 — 비워서 ⚠ 경로로 보낸다
    expect(anaphor?.lawName).toBe("")
  })

  it('"같은 규칙"과 "같은 규정"은 서로의 선행사를 가져가지 않는다', () => {
    const cites = extractCitations(
      "「산업안전보건기준에 관한 규칙」 제32조와 외국환거래규정 제23조를 보고, 같은 규칙 제33조를 적용한다."
    )
    const anaphor = cites.find((c) => c.raw.includes("같은 규칙"))
    expect(anaphor?.lawName).toBe("산업안전보건기준에 관한 규칙")
  })

  it("따옴표 없는 규정·규칙은 soft로 표시한다 (사내 문서일 수 있다)", () => {
    const cites = extractCitations("당사 취업규칙 제12조에 정한 바에 따른다.")
    expect(cites[0].soft).toBe(true)
  })

  it("「」로 감싼 인용은 soft가 아니다 (법령을 의도한 표기)", () => {
    const cites = extractCitations("「외국환거래규정」 제23조에 따른다.")
    expect(cites[0].soft).toBeFalsy()
  })
})
