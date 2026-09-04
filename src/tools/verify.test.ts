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
/** 본문 조회 ID(행정규칙일련번호)가 함께 오는 응답 — 조문 대조 경로를 탄다 */
const ADMRUL_HIT_WITH_SEQ_XML = ADMRUL_HIT_XML.replace(
  "<발령일자>20240101</발령일자>",
  "<발령일자>20240101</발령일자><행정규칙일련번호>2100000277992</행정규칙일련번호>"
)
/** 조문 형식(조문형식여부=Y) 본문 — 제23조는 있고 제99조는 없다 */
const ADMRUL_BODY_XML =
  '<?xml version="1.0"?><AdmRulService><행정규칙기본정보><행정규칙명>조사사무처리규정</행정규칙명>' +
  "<조문형식여부>Y</조문형식여부></행정규칙기본정보><조문내용>제1조(목적) 이 규정은 …</조문내용>" +
  "<조문내용>제23조(조사의 개시) 조사공무원은 … 제99조에 따라 …</조문내용>" +
  "<조문내용>제24조(조사의 연기) …</조문내용></AdmRulService>"
/** 통짜 본문(조문형식여부=N) — 조문 단위 판정 불가 */
const ADMRUL_BODY_FLAT_XML =
  '<?xml version="1.0"?><AdmRulService><행정규칙기본정보><행정규칙명>조사사무처리규정</행정규칙명>' +
  "<조문형식여부>N</조문형식여부></행정규칙기본정보><조문내용>제1-1조 … 제10-2조 …</조문내용></AdmRulService>"
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

  it("실존 행정규칙(훈령)이 ✗ 환각 의심으로 판정되지 않는다 (본문 조회 ID 없음 → ⚠)", async () => {
    stubFetchByUrl([{ match: "target=admrul", body: ADMRUL_HIT_XML }])
    const res = await handleFinVerify(new LawApiClient({ apiKey: "testkey" }), {
      text: "「조사사무처리규정」 제23조에 따라 세무조사를 실시한다.",
    })
    const text = res.content[0].text
    expect(text).toContain("행정규칙 「조사사무처리규정」 실존")
    // 조문이 붙었는데 대조를 못 했으면 ✓가 아니다 — 미검증 조문이 "통과"로 읽히면 안 된다
    expect(text).toContain("제23조는 미확인")
    expect(text).not.toContain("환각 의심")
  })

  /**
   * 행정규칙 조문 대조 (2026-09-01 실측으로 가능해진 검증).
   * `lawService.do?target=admrul&ID=…`이 본문을 주고, 조문형식여부=Y면 <조문내용>이
   * "제N조(제목) …"로 구조화되어 온다 — 그 경우에만 ✓/✗를 낸다.
   */
  it("조문 형식 규칙이면 조문 존재까지 대조해 ✓", async () => {
    stubFetchByUrl([
      { match: "lawService.do", body: ADMRUL_BODY_XML },
      { match: "target=admrul", body: ADMRUL_HIT_WITH_SEQ_XML },
    ])
    const res = await handleFinVerify(new LawApiClient({ apiKey: "testkey" }), {
      text: "「조사사무처리규정」 제23조에 따라 세무조사를 실시한다.",
    })
    const text = res.content[0].text
    expect(text).toContain("✓")
    expect(text).toContain("제23조 확인")
    expect(text).toContain("본문 조문 3개와 대조함")
  })

  it("없는 조문은 ✗ — 본문 중간의 참조('제99조에 따라')를 조문으로 세지 않는다", async () => {
    stubFetchByUrl([
      { match: "lawService.do", body: ADMRUL_BODY_XML },
      { match: "target=admrul", body: ADMRUL_HIT_WITH_SEQ_XML },
    ])
    const res = await handleFinVerify(new LawApiClient({ apiKey: "testkey" }), {
      text: "「조사사무처리규정」 제99조에 따라 세무조사를 실시한다.",
    })
    const text = res.content[0].text
    expect(text).toContain("✗")
    expect(text).toContain("제99조가 없음")
  })

  it("조문 형식이 아닌 규칙(통짜 본문)은 종전대로 ⚠ — 조문 단위 판정을 하지 않는다", async () => {
    stubFetchByUrl([
      { match: "lawService.do", body: ADMRUL_BODY_FLAT_XML },
      { match: "target=admrul", body: ADMRUL_HIT_WITH_SEQ_XML },
    ])
    const res = await handleFinVerify(new LawApiClient({ apiKey: "testkey" }), {
      text: "「조사사무처리규정」 제23조에 따라 세무조사를 실시한다.",
    })
    const text = res.content[0].text
    expect(text).toContain("⚠")
    expect(text).toContain("조문 형식이 아니어서")
    expect(text).toContain("✗0") // 요약 헤더 기준 — ✗ 판정이 하나도 없다
  })

  it("본문 조회가 실패하면 '조문 없음'이 아니라 ⚠ (조용한 실패 금지)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input)
        if (url.includes("lawService.do")) return new Response("서버 오류", { status: 500 })
        if (url.includes("target=admrul")) return new Response(ADMRUL_HIT_WITH_SEQ_XML, { status: 200 })
        return new Response(EMPTY_LAW_XML, { status: 200 })
      })
    )
    const res = await handleFinVerify(new LawApiClient({ apiKey: "testkey" }), {
      text: "「조사사무처리규정」 제23조에 따라 세무조사를 실시한다.",
    })
    const text = res.content[0].text
    expect(text).toContain("⚠")
    expect(text).toContain("확인 실패로 판정 불가")
    expect(text).toContain("✗0") // 조회 실패를 "없음"으로 바꾸지 않는다
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

/**
 * Codex 2차 회귀 — soft(사내 문서 가능) 속성이 조응에 상속되지 않던 문제.
 * "내부 관리규정 제5조와 같은 규정 제6조"에서 앞은 ⚠인데 뒤만 ✗가 되면
 * 같은 문서를 가리키는 연쇄 인용의 절반만 환각으로 낙인찍힌다.
 */
describe("extractCitations — soft 속성의 조응 상속 (Codex 2차 중요)", () => {
  it('"같은 규정"이 soft 선행사를 이어받는다', () => {
    const cites = extractCitations("내부 관리규정 제5조와 같은 규정 제6조를 따른다.")
    expect(cites).toHaveLength(2)
    expect(cites[0].soft).toBe(true)
    expect(cites[1].soft).toBe(true)
  })

  it('"같은 규칙"도 soft 선행사를 이어받는다', () => {
    const cites = extractCitations("당사 취업규칙 제12조와 같은 규칙 제13조에 따른다.")
    expect(cites[0].soft).toBe(true)
    expect(cites[1].soft).toBe(true)
  })

  it("「」 선행사(법령 의도)는 soft를 물려주지 않는다", () => {
    const cites = extractCitations("「외국환거래규정」 제23조와 같은 규정 제24조를 본다.")
    expect(cites[0].soft).toBeFalsy()
    expect(cites[1].soft).toBeFalsy()
  })
})

/**
 * Codex 2차 회귀 — 연혁 조회 **실패**를 "연혁에도 없음"으로 바꾸던 조용한 실패.
 * 현행 0건 + 연혁 조회 timeout이면 폐지된 실존 법령이 ✗(환각 의심)로 판정된다.
 */
describe("연혁 조회 실패는 부존재가 아니다 (Codex 2차 중요)", () => {
  const EMPTY_LAW = '<?xml version="1.0"?><LawSearch><totalCnt>0</totalCnt></LawSearch>'

  it("폐지·연혁 DB 조회가 실패하면 ✗ 대신 ⚠", async () => {
    let call = 0
    const client = {
      // 1회차: 현행 검색 0건 / 2회차 이후(eflaw 연혁): 실패
      searchLaw: async (_q: string, _k: unknown, _d: unknown, target?: string) => {
        call++
        if (target === "eflaw") throw new Error("요청 시간 초과 (3000ms)")
        return EMPTY_LAW
      },
      fetchApi: async () => EMPTY_LAW,
      searchAdminRule: async () => '<?xml version="1.0"?><AdmRulSearch><totalCnt>0</totalCnt></AdmRulSearch>',
    } as unknown as LawApiClient
    const r = await handleFinVerify(client, { text: "택지소유상한에 관한 법률 제10조에 따른다." })
    const text = r.content[0].text
    expect(text).toContain("⚠")
    expect(text).not.toContain("✗ ")
    expect(text).toContain("실패")
    expect(call).toBeGreaterThan(1)
  })
})

describe("cleanLawName — 문장 접속 부사 제거 (자체 점검)", () => {
  it('"그리고"가 법령명에 흡수되지 않는다', () => {
    const cites = extractCitations("당사 취업규칙을 본다. 그리고 탄소배출권거래규정 제77조에 따른다.")
    const last = cites[cites.length - 1]
    expect(last.lawName).toBe("탄소배출권거래규정")
  })

  it("다른 접속 부사도 제거한다", () => {
    for (const conj of ["또한", "따라서", "한편", "다만"]) {
      const cites = extractCitations(`앞 문장이다. ${conj} 탄소배출권거래규정 제77조에 따른다.`)
      expect(cites[cites.length - 1].lawName).toBe("탄소배출권거래규정")
    }
  })

  it("법령명 자체는 자르지 않는다 (과잉 제거 방지)", () => {
    const cites = extractCitations("고용보험 및 산업재해보상보험의 보험료징수 등에 관한 법률 제13조에 따른다.")
    expect(cites[0].lawName).toContain("고용보험")
    expect(cites[0].lawName).toContain("보험료징수")
  })
})

/**
 * Codex 3차 차단 회귀 — 괄호가 붙은 행정규칙 인용이 **추출조차 되지 않던** 문제.
 * 「식품등의 표시기준(2024. 1. 15.)」은 이름이 ')'로 끝나 고시·규정 화이트리스트를
 * 통과하지 못해 "인용 0건"으로 넘어갔다 — 실존이든 환각이든 검증을 통째로 우회한다.
 */
describe("extractCitations — 괄호가 붙은 행정규칙 인용 (Codex 3차 차단)", () => {
  it("「」 안의 발령일 괄호가 붙어도 추출한다", () => {
    const cites = extractCitations("「식품등의 표시기준(2024. 1. 15.)」 제1조에 따른다.")
    expect(cites).toHaveLength(1)
    expect(cites[0].article).toBe("제1조")
    // 표시는 원문 그대로 (판(版) 정보를 임의로 지우지 않는다)
    expect(cites[0].lawName).toContain("2024")
  })

  it("따옴표 없는 형태도 추출한다", () => {
    const cites = extractCitations("식품등의 표시기준(2024. 1. 15.) 제1조에 따른다.")
    expect(cites).toHaveLength(1)
    expect(cites[0].article).toBe("제1조")
  })

  it("발령번호 괄호도 추출한다", () => {
    const cites = extractCitations("「외국환거래규정(기재부 고시 제2026-1호)」 제23조에 따른다.")
    expect(cites).toHaveLength(1)
    expect(cites[0].article).toBe("제23조")
  })

  it("괄호가 없던 기존 인용은 그대로다 (회귀 없음)", () => {
    const cites = extractCitations("「법인세법」 제26조에 따른다.")
    expect(cites).toHaveLength(1)
    expect(cites[0].lawName).toBe("법인세법")
  })
})

/**
 * Claude(Fable) 리뷰 차단 1 회귀 — 법령명 추출이 **개행을 넘어** 문서 제목·직전 줄을 흡수.
 * 흡수된 raw의 개행이 verify-file 훅의 라인 단위 집계를 깨뜨려 hold 인용이 있는
 * 문서가 "인용 검증 통과"로 둔갑했다 (제목이 흡수된 규정류는 어절 컷 복구도 없다).
 */
describe("extractCitations — 개행 흡수 방지 (Claude 리뷰 차단 1)", () => {
  it("문서 제목이 개행을 넘어 규정류 법령명에 흡수되지 않는다", () => {
    const cites = extractCitations("## 검토 메모\n\n당사 내부 회계관리규정 제5조에 따라 처리한다.")
    expect(cites).toHaveLength(1)
    expect(cites[0].lawName).not.toContain("검토")
    expect(cites[0].lawName).toContain("회계관리규정")
    expect(cites[0].raw).not.toMatch(/\n/)
  })

  it("직전 줄 문장이 '법' 접미사 법령명에 흡수되지 않는다", () => {
    const cites = extractCitations("결론은 다음과 같다.\n법인세법 제26조를 적용한다.")
    expect(cites).toHaveLength(1)
    expect(cites[0].lawName).toBe("법인세법")
    expect(cites[0].raw).toBe("법인세법 제26조")
  })

  it("raw는 항상 한 줄이다 (「」 안 개행 포함 — 훅 라인 집계 불변식)", () => {
    const cites = extractCitations("「법인세법\n시행령」 제43조에 따른다.")
    expect(cites.length).toBeGreaterThanOrEqual(1)
    for (const c of cites) expect(c.raw).not.toMatch(/\n/)
  })

  it("같은 줄 안의 정상 인용은 그대로 추출된다 (과잉 차단 방지)", () => {
    const cites = extractCitations("검토 결과 법인세법 제26조 및 소득세법 제12조를 적용한다.")
    expect(cites.map((c) => c.lawName)).toEqual(["법인세법", "소득세법"])
  })
})

/**
 * Claude(Fable) 리뷰 차단 2 회귀 — 판결문식 구법 인용(법령명+개정연혁 괄호+제N조)이
 * 어느 패턴에도 걸리지 않아 **추출 0건**으로 조용히 통과했다. 환각 구법 조문이
 * 검증을 통째로 우회하는 구멍이다.
 */
describe("extractCitations — 판결문식 구법 괄호 인용 (Claude 리뷰 차단 2)", () => {
  it("'구 법인세법(…개정되기 전의 것) 제26조의2'가 추출되고 historical 표지가 붙는다", () => {
    const cites = extractCitations(
      "구 법인세법(2018. 12. 24. 법률 제16008호로 개정되기 전의 것) 제26조의2에 따라 처리한다."
    )
    expect(cites).toHaveLength(1)
    expect(cites[0].lawName).toBe("법인세법")
    expect(cites[0].article).toBe("제26조의2")
    expect(cites[0].historical).toBe(true)
    expect(cites[0].raw).toContain("구 법인세법")
  })

  it("'구' 접두 없이 괄호 문구만으로도 연혁 표지가 붙는다", () => {
    const cites = extractCitations("법인세법(법률 제16008호로 개정되기 전의 것) 제26조를 본다.")
    expect(cites).toHaveLength(1)
    expect(cites[0].historical).toBe(true)
  })

  it("'폐지되기 전' 변형도 연혁 표지다", () => {
    const cites = extractCitations("택지소유상한에 관한 법률(폐지되기 전의 것) 제5조를 본다.")
    expect(cites).toHaveLength(1)
    expect(cites[0].historical).toBe(true)
  })

  it("연혁 문구가 아닌 괄호(약칭 정의)는 연혁으로 오인하지 않는다", () => {
    const cites = extractCitations('법인세법(이하 "법"이라 한다) 제26조에 따른다.')
    expect(cites).toHaveLength(1)
    expect(cites[0].article).toBe("제26조")
    expect(cites[0].historical).toBeUndefined()
  })
})

/**
 * Claude(Fable) 리뷰 중요 6 회귀 — 구 「○○법」이 historical 미표지로 현행 ✓를 받던
 * 절반 수정 (Opus 중요 2의 수정이 무따옴표 경로에만 닿았다).
 */
describe("extractCitations — 구 「」 연혁 표지 (Claude 리뷰 중요 6)", () => {
  it("구 「법인세법」 제26조 — raw에 '구' 보존 + historical", () => {
    const cites = extractCitations("구 「법인세법」 제26조에 따라 손금불산입한다.")
    expect(cites).toHaveLength(1)
    expect(cites[0].raw).toBe("구 「법인세법」 제26조")
    expect(cites[0].historical).toBe(true)
  })

  it("조문 없는 구 「」 법령 인용에도 표지가 붙는다", () => {
    const cites = extractCitations("구 「택지소유상한에 관한 법률」에 따른 부담금이다.")
    const hit = cites.find((c) => c.lawName.includes("택지"))
    expect(hit).toBeDefined()
    expect(hit!.historical).toBe(true)
    expect(hit!.raw.startsWith("구 ")).toBe(true)
  })

  it("'친구' 등 단어 꼬리의 '구'는 연혁 표지가 아니다", () => {
    const cites = extractCitations("친구 「법인세법」 제26조 이야기를 했다.")
    expect(cites).toHaveLength(1)
    expect(cites[0].historical).toBeUndefined()
  })

  it("'구'가 없는 「」 인용에는 표지가 없다 (기존 회귀 유지)", () => {
    const cites = extractCitations("「법인세법」 제26조에 따른다.")
    expect(cites[0].historical).toBeUndefined()
  })
})

/**
 * Claude(Fable) 리뷰 중요 4 회귀 — verify만 0건 게이트로 남아, LIKE 노이즈 1건에
 * 행정규칙 폴백·폐지 연혁·soft hold가 전부 미도달이었다 ("절반 수정"의 일곱 번째).
 * "당사 취업규칙"이 「유해ㆍ위험작업의 취업 제한에 관한 규칙」류 노이즈에 가려
 * 사용 보류 없이 일반 ⚠로 빠지고 훅이 "통과"를 보고했다.
 */
describe("verify — LIKE 노이즈에도 폴백·hold 도달 (Claude 리뷰 중요 4)", () => {
  afterEach(() => vi.unstubAllGlobals())

  const NOISE_LAW_XML =
    '<?xml version="1.0"?><LawSearch><totalCnt>1</totalCnt><law id="1">' +
    "<법령명한글>유해ㆍ위험작업의 취업 제한에 관한 규칙</법령명한글><법령ID>77</법령ID>" +
    "<법령일련번호>777</법령일련번호><법령구분명>고용노동부령</법령구분명>" +
    "<현행연혁코드>현행</현행연혁코드><시행일자>20240101</시행일자></law></LawSearch>"

  it("soft 인용은 유사 후보(노이즈)가 있어도 [사용 보류]로 판정된다", async () => {
    stubFetchByUrl([
      { match: "target=admrul", body: ADMRUL_EMPTY_XML },
      { match: "target=eflaw", body: EMPTY_LAW_XML },
      { match: "target=law&", body: NOISE_LAW_XML },
    ])
    const res = await handleFinVerify(new LawApiClient({ apiKey: "testkey" }), {
      text: "당사 취업규칙 제12조에 정한 바에 따른다.",
    })
    const text = res.content[0].text
    expect(text).toContain("[사용 보류]")
    expect(text).toContain("유사 명칭만 검색됨")
    expect(text).not.toMatch(/^✗ /m) // ✗ 판정 라인 없음 (헤더의 ✗0 카운트는 무관)
  })

  it("정확 일치가 있으면 종전대로 후보 검증 경로다 (과잉 강등 방지)", async () => {
    const EXACT_LAW_XML =
      '<?xml version="1.0"?><LawSearch><totalCnt>1</totalCnt><law id="1">' +
      "<법령명한글>유해ㆍ위험작업의 취업 제한에 관한 규칙</법령명한글><법령ID>77</법령ID>" +
      "<법령일련번호>777</법령일련번호><법령구분명>고용노동부령</법령구분명>" +
      "<현행연혁코드>현행</현행연혁코드><시행일자>20240101</시행일자></law></LawSearch>"
    stubFetchByUrl([
      { match: "target=admrul", body: ADMRUL_EMPTY_XML },
      { match: "target=law&", body: EXACT_LAW_XML },
    ])
    const res = await handleFinVerify(new LawApiClient({ apiKey: "testkey" }), {
      text: "「유해ㆍ위험작업의 취업 제한에 관한 규칙」에 따른다.",
    })
    const text = res.content[0].text
    expect(text).not.toContain("[사용 보류]")
  })
})

/**
 * Claude(Fable) 리뷰 개선 9 연동 — ⌛(폐지·연혁 추정 행정규칙) 판정이 tool 출력에
 * 실제로 존재해야 훅의 VERDICT_LINE 회귀 테스트가 의미를 가진다.
 */
describe("verify — 폐지 행정규칙 ⌛ 판정 (훅 집계 대상)", () => {
  afterEach(() => vi.unstubAllGlobals())

  const ABOLISHED_ADMRUL_HISTORY_XML =
    '<?xml version="1.0"?><AdmRulSearch><totalCnt>1</totalCnt><admrul id="1">' +
    "<행정규칙명>수입식품등의 표시기준</행정규칙명><행정규칙일련번호>2100000012345</행정규칙일련번호>" +
    "<행정규칙ID>9999</행정규칙ID><발령일자>20200101</발령일자><제개정구분명>폐지</제개정구분명>" +
    "<현행연혁구분>연혁</현행연혁구분><행정규칙종류>고시</행정규칙종류>" +
    "<소관부처명>식품의약품안전처</소관부처명></admrul></AdmRulSearch>"

  it("현행 0건 + 폐지 연혁 실존이면 ⌛ 마크로 판정된다", async () => {
    stubFetchByUrl([
      { match: "nw=2", body: ABOLISHED_ADMRUL_HISTORY_XML },
      { match: "target=admrul", body: ADMRUL_EMPTY_XML },
    ])
    const res = await handleFinVerify(new LawApiClient({ apiKey: "testkey" }), {
      text: "수입식품등의 표시기준 제3조에 따른다.",
    })
    const text = res.content[0].text
    expect(text).toContain("⌛")
    expect(text).toContain("폐지·개정 연혁의 행정규칙으로 추정")
  })
})

/**
 * Codex 4차 차단 회귀 — 개행 제외(차단 1 수정)의 반작용: 줄바꿈으로 감싸인 정상
 * 인용이 추출 0건이 되고, 0건이면 훅이 그대로 통과한다. 앞 줄이 구두점 없이 한글로
 * 끝나고 다음 줄이 한글로 이어지면 감싸진 문장으로 보고 한 줄로 잇는다.
 */
describe("extractCitations — 줄바꿈으로 감싸인 인용 복원 (Codex 4차 차단)", () => {
  it("법령명이 줄 중간에서 감싸여도 추출된다", () => {
    const cites = extractCitations("국가를 당사자로 하는 계약에 관한\n법률 제7조에 따라 계약한다.")
    expect(cites).toHaveLength(1)
    expect(cites[0].lawName).toBe("국가를 당사자로 하는 계약에 관한 법률")
    expect(cites[0].article).toBe("제7조")
  })

  it("법령명과 조문 사이가 감싸여도 추출된다", () => {
    const cites = extractCitations("이 계약은 법인세법\n제26조에 따라 처리한다.")
    expect(cites).toHaveLength(1)
    expect(cites[0].lawName).toBe("법인세법")
  })

  it("마크다운 제목 라인은 잇지 않는다 (빈 줄 없이 붙어도 차단 1 유지)", () => {
    const cites = extractCitations("## 검토 메모\n당사 내부 회계관리규정 제5조에 따라 처리한다.")
    expect(cites).toHaveLength(1)
    expect(cites[0].lawName).not.toContain("검토")
  })

  it("구두점으로 끝난 문장은 잇지 않는다 (차단 1 유지)", () => {
    const cites = extractCitations("결론은 다음과 같다.\n법인세법 제26조를 적용한다.")
    expect(cites).toHaveLength(1)
    expect(cites[0].raw).toBe("법인세법 제26조")
  })

  it("빈 줄(문단 경계)은 잇지 않는다", () => {
    const cites = extractCitations("검토 메모\n\n당사 내부 회계관리규정 제5조에 따라 처리한다.")
    expect(cites).toHaveLength(1)
    expect(cites[0].lawName).not.toContain("메모")
  })
})

/**
 * Codex 4차 중요 회귀 — 괄호 허용(차단 2 수정)의 반작용: 바깥 매치가 괄호를 소비하면
 * 괄호 안의 별도 인용("법인세법(소득세법 제12조) 제26조"의 소득세법 제12조)이 이 패스에서
 * 영영 매칭되지 않아 검증을 우회한다.
 */
describe("extractCitations — 괄호 안의 별도 인용 (Codex 4차 중요)", () => {
  it("괄호 안의 타법 조문도 별도 인용으로 추출된다", () => {
    const cites = extractCitations("법인세법(소득세법 제12조) 제26조를 본다.")
    expect(cites).toHaveLength(2)
    expect(cites.map((c) => `${c.lawName} ${c.article}`)).toEqual([
      "법인세법 제26조",
      "소득세법 제12조",
    ])
  })

  it("연혁 괄호(조문 없는 내용)는 안쪽 인용을 만들지 않는다", () => {
    const cites = extractCitations(
      "구 법인세법(2018. 12. 24. 법률 제16008호로 개정되기 전의 것) 제26조의2를 본다."
    )
    expect(cites).toHaveLength(1)
  })
})

/**
 * Codex 4차 중요 회귀 — 연혁 표지 변형("개정 전"·"전부개정 전"·"일부개정 전")이
 * "되기" 필수 패턴을 빠져나가 현행 ✓를 받던 문제.
 */
describe("extractCitations — 연혁 괄호 변형 (Codex 4차 중요)", () => {
  it("'개정 전'·'전부개정 전'·'일부개정 전'도 연혁 표지다", () => {
    for (const paren of ["개정 전", "전부개정 전", "2011. 4. 14. 법률 제10600호로 일부개정 전", "폐지 전"]) {
      const cites = extractCitations(`상법(${paren}) 제42조를 본다.`)
      expect(cites, paren).toHaveLength(1)
      expect(cites[0].historical, paren).toBe(true)
    }
  })

  it("'전' 뒤에 한글이 이어지면 연혁 표지가 아니다 ('개정 전문 반영')", () => {
    const cites = extractCitations("상법(개정 전문 반영) 제42조를 본다.")
    expect(cites).toHaveLength(1)
    expect(cites[0].historical).toBeUndefined()
  })
})

/**
 * 법제처 lawService.do 거동 변화 (2026-08-30 게이트20 실측) — efYd 없는 eflaw 호출이
 * HTML 오류로 반환되기 시작해, 현행 조문 확인이 전 문장 ⚠(판정 불가)가 됐다.
 * article 경로만 고치고 verify를 빠뜨리는 반쪽 수정을 막는 계약 박제.
 */
describe("verify — 현행 조문 확인은 target=law (법제처 eflaw 거동 변화)", () => {
  afterEach(() => vi.unstubAllGlobals())

  const CURRENT_LAW_XML =
    '<?xml version="1.0"?><LawSearch><totalCnt>1</totalCnt><law id="1">' +
    "<법령명한글>법인세법</법령명한글><법령ID>1563</법령ID>" +
    "<법령일련번호>280349</법령일련번호><법령구분명>법률</법령구분명>" +
    "<현행연혁코드>현행</현행연혁코드><시행일자>20260701</시행일자></law></LawSearch>"
  const ARTICLE_JSON =
    '{"법령":{"조문":{"조문단위":[{"조문여부":"조문","조문번호":"26","조문제목":"손금불산입"}]}}}'

  it("efYd 없는 lawService 호출에 eflaw를 쓰지 않는다 (✓ 정상 판정 유지)", async () => {
    const urls: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input)
        urls.push(url)
        if (url.includes("lawService.do")) return new Response(ARTICLE_JSON, { status: 200 })
        if (url.includes("target=admrul"))
          return new Response(ADMRUL_EMPTY_XML, { status: 200 })
        return new Response(CURRENT_LAW_XML, { status: 200 })
      })
    )
    const res = await handleFinVerify(new LawApiClient({ apiKey: "testkey" }), {
      text: "법인세법 제26조에 따른다.",
    })
    expect(res.content[0].text).toContain("✓")
    const svc = urls.filter((u) => u.includes("lawService.do"))
    expect(svc.length).toBeGreaterThan(0)
    for (const u of svc) {
      expect(u).not.toContain("target=eflaw")
      expect(u).toContain("target=law")
    }
  })
})

/**
 * Codex 5차 차단·중요 회귀 — 줄 잇기(joinWrappedLines)의 두 결함:
 * ① CRLF 문서에서 앞 줄이 \r로 끝나 잇기 조건이 전부 실패 → 감싸인 인용이 도로 0건
 * ② 구두점 없는 평문 제목이 다음 줄 인용과 이어져 법령명이 오염 → 정상 인용이 ✗
 */
describe("extractCitations — CRLF·평문 제목 (Codex 5차)", () => {
  it("CRLF 문서의 감싸인 인용도 추출된다 [차단]", () => {
    const cites = extractCitations("국가를 당사자로 하는 계약에 관한\r\n법률 제7조에 따라 계약한다.")
    expect(cites).toHaveLength(1)
    expect(cites[0].lawName).toBe("국가를 당사자로 하는 계약에 관한 법률")
  })

  it("CR만 쓰는 문서도 동일하다", () => {
    const cites = extractCitations("결론은 다음과 같다.\r법인세법 제26조를 적용한다.")
    expect(cites).toHaveLength(1)
    expect(cites[0].lawName).toBe("법인세법")
  })

  it("평문 제목이 이어져도 이음새 뒤 이름으로 조회하고 전체는 uncut으로 보존한다 [중요]", () => {
    const cites = extractCitations("2026년 세무 검토 대상\n택지소유상한에 관한 법률 제5조에 따른 부담금")
    expect(cites).toHaveLength(1)
    expect(cites[0].lawName).toBe("택지소유상한에 관한 법률")
    expect(cites[0].uncut).toContain("2026년") // 검증 단계 재시도·고지용
    expect(cites[0].raw).toBe("택지소유상한에 관한 법률 제5조") // 제목이 raw에 남지 않는다
  })

  it("이음새 뒤가 접미사 단독('법률')이면 감싸인 이름 전체를 유지한다 (과잉 컷 방지)", () => {
    const cites = extractCitations("국가를 당사자로 하는 계약에 관한\n법률 제7조에 따라 계약한다.")
    expect(cites[0].lawName).toBe("국가를 당사자로 하는 계약에 관한 법률")
  })
})

/**
 * Codex 5차 중요 회귀 — 괄호 내부 인용이 텍스트 좌표상 바깥 인용 뒤에 삽입돼
 * "같은 법"의 선행사를 덮어쓰던 문제.
 */
describe("extractCitations — 괄호 내부 인용은 조응 선행사가 아니다 (Codex 5차 중요)", () => {
  it("'같은 법'은 괄호 안 법령이 아니라 바깥 법령으로 해소된다", () => {
    const cites = extractCitations("법인세법(소득세법 제12조) 제26조를 보고, 같은 법 제27조도 검토한다.")
    expect(cites).toHaveLength(3)
    const anaphor = cites.find((c) => c.raw.includes("같은 법"))
    expect(anaphor!.lawName).toBe("법인세법") // 소득세법이면 회귀
  })

  it("괄호 밖 인용의 조응 해소는 그대로다 (기존 회귀 유지)", () => {
    const cites = extractCitations("법인세법 제26조를 보고, 같은 법 제27조도 검토한다.")
    expect(cites[1].lawName).toBe("법인세법")
  })
})

/**
 * Codex 5차 개선 회귀 — 괄호 안팎의 동일 인용이 두 건으로 잡혀 15건 상한을 소모하던 문제.
 * raw 포함 관계일 때만 흡수한다 — 서로 다른 원문의 같은 절단(B-3②)은 유지.
 */
describe("extractCitations — 괄호 안팎 동일 인용 흡수 (Codex 5차 개선)", () => {
  it("같은 법령·조문이 괄호 안팎에 있으면 한 건이다", () => {
    const { citations, total } = extractCitationsWithTotal("법인세법(법인세법 제26조) 제26조를 본다.")
    expect(total).toBe(1)
    expect(citations).toHaveLength(1)
  })

  it("괄호 안이 다른 조문이면 흡수하지 않는다", () => {
    const { total } = extractCitationsWithTotal("법인세법(법인세법 제25조) 제26조를 본다.")
    expect(total).toBe(2)
  })
})

describe("extractCitations — 연혁 괄호 '전의' 변형 (Codex 5차 중요)", () => {
  it("'개정 전의 법령'도 연혁 표지다", () => {
    const cites = extractCitations("법인세법(개정 전의 법령) 제26조를 본다.")
    expect(cites[0].historical).toBe(true)
  })

  it("'개정 전·후 비교'는 연혁 표지가 아니다 (과잉 인식 방지)", () => {
    const cites = extractCitations("법인세법(개정 전·후 비교) 제26조를 본다.")
    expect(cites[0].historical).toBeUndefined()
  })
})

/**
 * Codex 6차 회귀 — 5차 수정(줄 잇기·괄호 조응·raw 흡수)이 연 반대 방향 구멍.
 * 전부 프로브로 실측 재현한 뒤 고쳤다.
 */
describe("extractCitations — 낱말 안쪽 줄바꿈 복원 (Codex 6차 차단)", () => {
  it("법령명이 낱말 중간에서 끊긴 인용을 복원한다 (PDF·워드 붙여넣기)", () => {
    // 공백으로 이으면 "법인세법 시 행령"이 되어 추출 0건 → 훅이 "인용 없음"으로 통과했다
    const { citations, total } = extractCitationsWithTotal("법인세법 시\n행령 제88조를 본다.")
    expect(total).toBe(1)
    expect(citations[0].lawName).toBe("법인세법 시행령")
    expect(citations[0].article).toBe("제88조")
    // 복원은 추정이므로 표시를 남긴다 — 미발견 시 ✗가 아니라 ⚠(사용 보류)로 판정된다
    expect(citations[0].joinRestored).toBe(true)
  })

  it("어절 경계 줄바꿈은 종전대로 공백 해석이 이긴다 (없는 이름 생성 방지)", () => {
    const { citations, total } = extractCitationsWithTotal(
      "국가를 당사자로 하는\n계약에 관한 법률 제5조를 본다."
    )
    expect(total).toBe(1)
    expect(citations[0].lawName).toBe("계약에 관한 법률")
    expect(citations[0].joinRestored).toBeUndefined()
  })

  it("줄바꿈이 없으면 tight 패스를 돌리지 않는다 (기존 동작 보존)", () => {
    const { citations, total } = extractCitationsWithTotal("법인세법 시행령 제88조를 본다.")
    expect(total).toBe(1)
    expect(citations[0].joinRestored).toBeUndefined()
  })

  /**
   * Codex 7차 차단 — 두 패스 병합의 반작용.
   * 조응("같은 법")은 패스마다 다른 선행사로 해소된다. 공백 해석에서 감싸인 인용이
   * 추출되지 않으면 선행사가 앞 문장의 다른 법으로 넘어가기 때문이다. 그대로 합치면
   * 같은 raw가 두 건이 되어 인용 수가 부풀고, 두 법령이 모두 실존하면 **엉뚱한 법령에도
   * 확신형 ✓**가 나간다 (프로브에서 4건 전부 ✓로 재현됐다).
   */
  it("조응 인용이 패스별로 다르게 해소돼도 한 건이다 (tight 해석 채택)", () => {
    const { citations, total } = extractCitationsWithTotal(
      "법인세법 제1조를 본다. 소득세법 시\n행령 제2조와 같은 법 제3조를 본다."
    )
    expect(total).toBe(3)
    const anaphors = citations.filter((c) => c.raw.startsWith("같은 법"))
    expect(anaphors).toHaveLength(1)
    // 낱말 안쪽 해석이 인용을 더 찾았다 = 그 줄바꿈이 낱말 안쪽이었다는 증거
    expect(anaphors[0].lawName).toBe("소득세법")
    expect(anaphors[0].joinRestored).toBe(true)
  })
})

describe("extractCitations — 괄호 안 「」 인용의 조응 오염 (Codex 6차 중요)", () => {
  it("괄호 안 따옴표 인용은 '같은 법'의 선행사가 되지 않는다", () => {
    // 5차에서 무따옴표 경로만 고쳐져 「」 경로에 같은 구멍이 남아 있었다 (절반 수정 9번째)
    const cites = extractCitations("법인세법(「소득세법」 제12조) 제26조를 보고, 같은 법 제27조도 검토한다.")
    const anaphor = cites.find((c) => c.raw.startsWith("같은 법"))
    expect(anaphor?.lawName).toBe("법인세법")
  })

  it("괄호 안 「」 단독 인용도 선행사가 되지 않는다", () => {
    const cites = extractCitations("법인세법(「소득세법」에 따른 소득) 제26조와 같은 법 제27조를 본다.")
    const anaphor = cites.find((c) => c.raw.startsWith("같은 법"))
    expect(anaphor?.lawName).toBe("법인세법")
  })
})

describe("extractCitations — 연혁·현행 인용의 raw 흡수 (Codex 6차 중요)", () => {
  it("'구 ○○법 제N조'가 같은 조문의 현행 인용을 흡수하지 않는다", () => {
    const { citations, total } = extractCitationsWithTotal("구 법인세법 제26조를 본다. 법인세법 제26조도 본다.")
    expect(total).toBe(2)
    expect(citations.filter((c) => c.historical)).toHaveLength(1)
    expect(citations.filter((c) => !c.historical)).toHaveLength(1)
  })
})

describe("extractCitations — 연혁 괄호 접속 표현 (Codex 6차 개선)", () => {
  it.each(["개정 전 및 후 비교", "개정 전, 후 비교", "개정 전 또는 후 비교"])(
    "'%s'는 연혁 표지가 아니다",
    (paren) => {
      const cites = extractCitations(`법인세법(${paren}) 제26조를 본다.`)
      expect(cites[0].historical).toBeUndefined()
    }
  )

  it("진짜 연혁 인용은 그대로 연혁이다", () => {
    const cites = extractCitations(
      "구 법인세법(2018. 12. 24. 법률 제16008호로 개정되기 전의 것) 제26조를 본다."
    )
    expect(cites[0].historical).toBe(true)
  })
})

/**
 * 퍼즈 차단 회귀 — 조응이 **자기보다 뒤에 나오는 법령**을 선행사로 삼던 결함.
 *
 * LAW_ARTICLE_RE의 이름부가 지연 매칭이라 "동 시행령 제8조 및 부가가치세법"을 통째로
 * 캡처하는데, hit.idx가 컷 이전 매치 시작점이라 그 명시 인용이 정렬에서 앞선 조응보다
 * 먼저 놓여 lastLawName을 선점했다. 실 API에서 「부가가치세법 시행령」 제8조로 확신형 ✓가
 * 나갔고, **어순만 바꾼 대조군과 출력이 완전히 같아** 사용자가 오류를 알아챌 단서가 없었다.
 *
 * "같은 법"류는 조응 자체가 '법'으로 끝나 정규식이 그 자리를 먼저 소비하므로 이 경로를
 * 타지 않는다 — 그래서 여섯 라운드의 회귀 사례에 한 번도 걸리지 않았다.
 * 아래 두 어순을 **함께** 박는다: 한쪽만 두면 수정이 반대 방향을 깨뜨려도 통과한다.
 */
describe("extractCitations — 조응 선행사 역전 (퍼즈 차단)", () => {
  it("조응이 앞 문장의 법령으로 해소된다 — 뒤따르는 법령에 흡수되지 않는다", () => {
    const cites = extractCitations("법인세법 제26조를 적용한다. 동 시행령 제8조 및 부가가치세법 제32조를 본다.")
    const anaphor = cites.find((c) => c.raw.includes("동 시행령"))
    expect(anaphor!.lawName).toBe("법인세법 시행령") // 부가가치세법 시행령이면 회귀
    expect(cites.find((c) => c.raw.startsWith("부가가치세법"))!.lawName).toBe("부가가치세법")
  })

  it("어순을 뒤집으면 선행사도 뒤집힌다 (대조군 — 두 어순이 구별되어야 한다)", () => {
    const cites = extractCitations("법인세법 제26조를 적용한다. 부가가치세법 제32조 및 동 시행령 제8조를 본다.")
    const anaphor = cites.find((c) => c.raw.includes("동 시행령"))
    expect(anaphor!.lawName).toBe("부가가치세법 시행령")
  })

  it("'같은 영'도 앞 문장의 법령으로 해소된다", () => {
    const cites = extractCitations("법인세법 제26조를 적용한다. 같은 영 제8조 및 부가가치세법 제32조를 본다.")
    expect(cites.find((c) => c.raw.includes("같은 영"))!.lawName).toBe("법인세법 시행령")
  })

  it("'동 시행규칙'도 앞 문장의 법령으로 해소된다", () => {
    const cites = extractCitations("법인세법 제26조를 적용한다. 동 시행규칙 제15조 및 부가가치세법 제32조를 본다.")
    expect(cites.find((c) => c.raw.includes("동 시행규칙"))!.lawName).toBe("법인세법 시행규칙")
  })

  it("'같은 규정'은 뒤따르는 규정에 흡수되지 않는다", () => {
    const cites = extractCitations(
      "「외국환거래규정」 제23조를 적용한다. 같은 규정 제9조 및 국세청 조사사무처리규정 제41조를 본다."
    )
    expect(cites.find((c) => c.raw.includes("같은 규정"))!.lawName).toBe("외국환거래규정")
  })

  it("선행 문맥 컷이 있어도 raw와 좌표 기준이 어긋나지 않는다 ('구' 연혁 표지 유지)", () => {
    const cites = extractCitations("구 법인세법 제26조를 적용한다. 같은 법 제3조를 본다.")
    expect(cites[0].historical).toBe(true)
    expect(cites[0].raw).toBe("구 법인세법 제26조")
  })
})

/**
 * 퍼즈 차단 회귀 — 행정규칙명이 앞 인용을 통째로 삼키던 결함.
 *
 * ADMIN_ARTICLE_RE의 이름부는 30자까지 왼쪽으로 뻗는데, 앞 인용의 조문 토큰에 조사가 붙은
 * 형태("제12조의2와")를 어절 컷이 하나도 잡지 못했다 — CUT_REF_RE는 조문 토큰 뒤에 [.,]만
 * 허용했고 CUT_ENDING_RE에는 와/과가 없다. 결과로 없는 이름이 만들어지고 **진짜 규정 인용은
 * 검증 대상에서 사라졌다**. 실 API에서 흡수된 앞부분이 실존 법령명이면(「소득세법」)
 * 뒤 인용의 조문 번호가 앞 법령에 붙어 확신형 ✓까지 나갔다.
 */
describe("extractCitations — 행정규칙명의 앞 인용 흡수 (퍼즈 차단)", () => {
  it("조사가 붙은 조문 토큰이 두 인용을 가르는 경계가 된다", () => {
    const cites = extractCitations("소득세법 시행령 제12조의2와 국세청 조사사무처리규정 제41조를 참조한다.")
    expect(cites).toHaveLength(2)
    expect(cites.map((c) => c.lawName)).toEqual(["소득세법 시행령", "국세청 조사사무처리규정"])
    expect(cites.some((c) => /제\d+조/.test(c.lawName))).toBe(false) // 이름에 조문이 남으면 회귀
  })

  it("변형② — 흡수된 앞부분이 법령명이 아닌 경우도 갈린다", () => {
    const cites = extractCitations("「외국환거래규정」 제23조와 국세청 조사사무처리규정 제41조를 본다.")
    expect(cites).toHaveLength(2)
    expect(cites.map((c) => c.lawName)).toEqual(["외국환거래규정", "국세청 조사사무처리규정"])
  })

  it("조응 뒤에 규정이 와도 가른다", () => {
    const cites = extractCitations(
      "주식회사 등의 외부감사에 관한 법률 시행령 제5조 및 같은 법 제3조와 국세청 조사사무처리규정 제41조를 참조한다."
    )
    expect(cites.map((c) => c.lawName)).toContain("국세청 조사사무처리규정")
    expect(cites.some((c) => /제\d+조/.test(c.lawName))).toBe(false)
  })

  it("조사 없는 종전 형태도 그대로 갈린다 (기존 회귀 유지)", () => {
    const cites = extractCitations("「법인세법」 제26조 및 지방세법 제1조를 본다.")
    expect(cites.map((c) => c.lawName)).toEqual(["법인세법", "지방세법"])
  })

  it("법령명 안의 가지번호는 컷되지 않는다 (과잉 컷 방어)", () => {
    const cites = extractCitations("고용보험 및 산업재해보상보험의 보험료징수 등에 관한 법률 제16조의2를 본다.")
    expect(cites[0].lawName).toBe("고용보험 및 산업재해보상보험의 보험료징수 등에 관한 법률")
    expect(cites[0].article).toBe("제16조의2")
  })
})

/**
 * 퍼즈 차단 4단계 — 행정규칙 경로의 raw·좌표 재구성.
 *
 * 83번을 고친 뒤에도 lawName만 갈리고 **raw는 흡수 구간을 그대로 보여 주었다**
 * ("⚠ 소득세법 시행령 제12조의2와 국세청 조사사무처리규정 제41조"). 판정은 옳지만
 * 어느 구간이 검증됐는지 알 수 없어, 사용자가 앞 인용이 문제인 것으로 읽는다.
 * 법령 경로에는 있던 kept 기반 재구성이 행정규칙 경로에만 빠져 있던 자리다.
 */
describe("extractCitations — 행정규칙 경로 raw·좌표 재구성 (퍼즈 4단계)", () => {
  it("raw가 앞 인용을 포함하지 않는다", () => {
    const cites = extractCitations("소득세법 시행령 제12조의2와 국세청 조사사무처리규정 제41조를 참조한다.")
    const admin = cites.find((c) => c.lawName === "국세청 조사사무처리규정")
    expect(admin!.raw).toBe("국세청 조사사무처리규정 제41조")
  })

  it("접속사도 raw에 남지 않는다", () => {
    const cites = extractCitations("법인세법 제26조 및 국세청 조사사무처리규정 제41조를 본다.")
    const admin = cites.find((c) => c.lawName === "국세청 조사사무처리규정")
    expect(admin!.raw).toBe("국세청 조사사무처리규정 제41조")
  })

  it("컷이 없으면 raw는 종전 그대로다", () => {
    const cites = extractCitations("국세청 조사사무처리규정 제41조를 본다.")
    expect(cites[0].raw).toBe("국세청 조사사무처리규정 제41조")
  })

  it("괄호 안 규정은 조응 선행사가 되지 않는다 (좌표 기준 이동의 반대 방향)", () => {
    const cites = extractCitations(
      "「외국환거래규정」 제23조를 본다. 사내 절차는 (당사 취업규칙 제12조) 참조. 같은 규정 제9조를 본다."
    )
    expect(cites.find((c) => c.raw.includes("같은 규정"))!.lawName).toBe("외국환거래규정")
  })
})
