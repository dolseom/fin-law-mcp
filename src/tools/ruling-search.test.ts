/**
 * fin_ruling_search 기준일 필터 회귀 테스트 (fixture 기반 — CI 상시)
 *
 * 예규·재결·판례는 "시행일"이 아니라 회신·의결·선고일 기준이라 법령과 필터 의미가
 * 다르다. 또한 기준일 필터는 상위 N건 자르기 **전에** 적용해야 한다 —
 * 뒤에 적용하면 상위가 전부 기준일 이후일 때 실제로 있는 과거 자료가 0건으로 보인다.
 */

import { describe, it, expect } from "vitest"
import { handleFinRulingSearch } from "./ruling-search.js"
import type { LawApiClient } from "../lib/api-client.js"

/** 최신 6건 + 과거 2건 — 상위 5건은 전부 기준일(2010-12-31) 이후가 되도록 구성 */
const PREC_XML = `<?xml version="1.0" encoding="UTF-8"?>
<PrecSearch><totalCnt>8</totalCnt>
  <prec><판례일련번호>1</판례일련번호><사건번호>2024누1</사건번호><사건명>최신1</사건명><선고일자>20240101</선고일자><법원명>서울고법</법원명><판례상세링크>/1</판례상세링크></prec>
  <prec><판례일련번호>2</판례일련번호><사건번호>2023누2</사건번호><사건명>최신2</사건명><선고일자>20230101</선고일자><법원명>대구고법</법원명><판례상세링크>/2</판례상세링크></prec>
  <prec><판례일련번호>3</판례일련번호><사건번호>2022구합3</사건번호><사건명>최신3</사건명><선고일자>20220101</선고일자><법원명>서울행법</법원명><판례상세링크>/3</판례상세링크></prec>
  <prec><판례일련번호>4</판례일련번호><사건번호>2021구합4</사건번호><사건명>최신4</사건명><선고일자>20210101</선고일자><법원명>서울행법</법원명><판례상세링크>/4</판례상세링크></prec>
  <prec><판례일련번호>5</판례일련번호><사건번호>2020구합5</사건번호><사건명>최신5</사건명><선고일자>20200101</선고일자><법원명>창원지법</법원명><판례상세링크>/5</판례상세링크></prec>
  <prec><판례일련번호>6</판례일련번호><사건번호>2015두6</사건번호><사건명>최신6</사건명><선고일자>20150101</선고일자><법원명>대법원</법원명><판례상세링크>/6</판례상세링크></prec>
  <prec><판례일련번호>7</판례일련번호><사건번호>2008두7</사건번호><사건명>과거1</사건명><선고일자>20081231</선고일자><법원명>대법원</법원명><판례상세링크>/7</판례상세링크></prec>
  <prec><판례일련번호>8</판례일련번호><사건번호>2005두8</사건번호><사건명>과거2</사건명><선고일자>20050101</선고일자><법원명>대법원</법원명><판례상세링크>/8</판례상세링크></prec>
</PrecSearch>`

const stub = { fetchApi: async () => PREC_XML } as unknown as LawApiClient

describe("fin_ruling_search — 기준일 필터", () => {
  it("기준일 이후 자료를 제외하고 과거 자료를 살린다 (상위 자르기 전에 필터)", async () => {
    const r = await handleFinRulingSearch(stub, {
      query: "퇴직금",
      domains: ["precedent"],
      basis_date: "2010-12-31",
    })
    const text = r.content[0].text
    // 상위 5건은 전부 기준일 이후지만, 뒤에 있던 과거 2건이 살아나야 한다
    expect(text).toContain("과거1")
    expect(text).toContain("과거2")
    expect(text).not.toContain("최신1")
    expect(text).not.toContain("최신6")
  })

  it("제외 건수를 표기한다 (조용한 절단 금지)", async () => {
    const r = await handleFinRulingSearch(stub, {
      query: "퇴직금",
      domains: ["precedent"],
      basis_date: "2010-12-31",
    })
    expect(r.content[0].text).toContain("기준일 이후 6건 제외")
  })

  it("헤더에 기준일과 필터 기준(회신·의결·선고일)을 명시한다", async () => {
    const r = await handleFinRulingSearch(stub, {
      query: "퇴직금",
      domains: ["precedent"],
      basis_date: "2010-12-31",
    })
    const text = r.content[0].text
    expect(text).toContain("[기준일: 2010-12-31까지]")
    expect(text).toContain("선고일")
  })

  it("전부 제외되면 '자료 없음'과 구분해 사유를 밝힌다", async () => {
    const r = await handleFinRulingSearch(stub, {
      query: "퇴직금",
      domains: ["precedent"],
      basis_date: "2000-01-01", // 모든 자료가 이후
    })
    const text = r.content[0].text
    expect(text).toContain("모두 기준일 이후")
    expect(text).not.toMatch(/0건.*정상 조회 결과 없음/)
  })

  it("기준일이 없으면 최신순 상위 5건 그대로 (회귀 없음)", async () => {
    const r = await handleFinRulingSearch(stub, { query: "퇴직금", domains: ["precedent"] })
    const text = r.content[0].text
    expect(text).toContain("[기준: 현행]")
    expect(text).toContain("최신1")
    expect(text).not.toContain("과거2") // 상위 5건 밖
  })

  it("잘못된 기준일 형식은 INVALID_PARAMETER", async () => {
    const r = await handleFinRulingSearch(stub, { query: "퇴직금", basis_date: "2010.12.31" })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain("INVALID_PARAMETER")
  })
})

describe("fin_ruling_search — 커버 범위·절단 고지 (조용한 실패 금지)", () => {
  it("표시 상한(5건)을 넘긴 검색 결과 건수를 밝힌다", async () => {
    const r = await handleFinRulingSearch(stub, { query: "퇴직금", domains: ["precedent"] })
    // fixture는 8건 — 5건 표시 + 3건 절단
    expect(r.content[0].text).toContain("검색 8건 중 최신 5건 표시")
  })

  it("검색한 도메인과 전체 도메인 수를 밝힌다 (0건을 '해석 없음'으로 오독 방지)", async () => {
    const r = await handleFinRulingSearch(stub, { query: "퇴직금", domains: ["precedent"] })
    const text = r.content[0].text
    expect(text).toContain("검색 범위: 법원 판례 (1곳)")
    expect(text).toContain("18곳")
    expect(text).toContain(`0건이 "해석 없음"을 뜻하지 않습니다`)
  })
})

/**
 * Codex 2차 회귀 — 빈 domains 배열의 조용한 no-op.
 * 한 번도 조회하지 않고 "전체 성공 · 검색 범위 (0곳)"을 돌려주면
 * 호출측은 이것을 "검색했지만 결과 없음"으로 읽는다.
 */
describe("domains 빈 배열 — 조용한 no-op 금지", () => {
  it("빈 배열은 성공이 아니라 INVALID_PARAMETER", async () => {
    let called = false
    const client = {
      fetchApi: async () => {
        called = true
        return "<PrecSearch><totalCnt>0</totalCnt></PrecSearch>"
      },
    } as unknown as LawApiClient
    const r = await handleFinRulingSearch(client, { query: "퇴직금", domains: [] })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain("INVALID_PARAMETER")
    expect(r.content[0].text).toContain("최소 1곳")
    expect(called).toBe(false)
  })

  it("domains를 생략하면 종전대로 4곳 전부 검색한다", async () => {
    const domains = new Set<string>()
    const client = {
      fetchApi: async (p: { target?: string }) => {
        if (p.target) domains.add(p.target)
        return "<PrecSearch><totalCnt>0</totalCnt></PrecSearch>"
      },
    } as unknown as LawApiClient
    await handleFinRulingSearch(client, { query: "퇴직금" })
    expect(domains.size).toBe(4)
  })
})

/**
 * 축약 사다리 — 실측 결함(2026-09-05): `임직원 경조사비 복리후생비 손금`이 4개 도메인
 * 전부 0건인데 사다리는 1회만 축약하고 멈췄다. 실무자는 자연어로 길게 묻기 때문에
 * 한 단계 축약으로는 0건을 벗어나지 못한다.
 *
 * 이 도구는 공용 ladderQueries(앞토막만 축약) 대신 양끝 교대 축약을 쓴다 —
 * 원문 → 꼬리 제거 → 머리 제거 → 꼬리 제거 … 로 주제어(가운데)를 마지막까지 남긴다.
 * 오류·429는 절대 재시도하지 않고(0건 위장 금지) 도메인당 4회에서 멈춘다.
 */
const EMPTY_PREC_XML = "<PrecSearch><totalCnt>0</totalCnt></PrecSearch>"
const HIT_PREC_XML = `<?xml version="1.0" encoding="UTF-8"?>
<PrecSearch><totalCnt>1</totalCnt>
  <prec><판례일련번호>91</판례일련번호><사건번호>2019두91</사건번호><사건명>경조사비 손금산입</사건명><선고일자>20190301</선고일자><법원명>대법원</법원명><판례상세링크>/91</판례상세링크></prec>
</PrecSearch>`

/** 호출된 검색어를 순서대로 기록하는 스텁 (respond가 XML을 고르거나 throw한다) */
function tracingClient(respond: (q: string, nth: number) => string): {
  client: LawApiClient
  tried: string[]
} {
  const tried: string[] = []
  const client = {
    fetchApi: async (p: { extraParams?: Record<string, string> }) => {
      const q = p.extraParams?.query ?? ""
      tried.push(q)
      return respond(q, tried.length)
    },
  } as unknown as LawApiClient
  return { client, tried }
}

describe("fin_ruling_search — 축약 사다리 단계 확장", () => {
  it("3어절→2어절→1어절로 내려가 결과가 나온 단계에서 멈추고, 2단 이상이면 축약 단수를 밝힌다", async () => {
    const { client, tried } = tracingClient((q) => (q === "경조사비" ? HIT_PREC_XML : EMPTY_PREC_XML))
    const r = await handleFinRulingSearch(client, {
      query: "임직원 경조사비 손금",
      domains: ["precedent"],
    })
    expect(tried).toEqual(["임직원 경조사비 손금", "임직원 경조사비", "경조사비"])
    const text = r.content[0].text
    expect(text).toContain(`검색어 축약 2단: "경조사비"`)
    expect(text).toContain("경조사비 손금산입")
  })

  /**
   * 사다리 순서 박제 — 공용 ladderQueries(앞토막만 축약)를 쓰면 종착점이 첫 어절("임직원")이
   * 되어 주제어를 먼저 버린다. 실무자 자연어는 [주체][주제어][쟁점 동사성 명사] 순이라
   * 양끝이 가장 덜 정보적이고, "손금·여부·해당" 류가 꼬리에 오므로 꼬리부터 깎는다.
   */
  it("양끝을 번갈아 깎는다 — 4어절: 꼬리 → 머리 → 꼬리", async () => {
    const { client, tried } = tracingClient(() => EMPTY_PREC_XML)
    await handleFinRulingSearch(client, {
      query: "임직원 경조사비 복리후생비 손금",
      domains: ["precedent"],
    })
    expect(tried).toEqual([
      "임직원 경조사비 복리후생비 손금",
      "임직원 경조사비 복리후생비",
      "경조사비 복리후생비",
      "경조사비",
    ])
  })

  it("양끝을 번갈아 깎는다 — 3어절: 꼬리 → 머리", async () => {
    const { client, tried } = tracingClient(() => EMPTY_PREC_XML)
    await handleFinRulingSearch(client, { query: "직원 경조사비 손금", domains: ["precedent"] })
    expect(tried).toEqual(["직원 경조사비 손금", "직원 경조사비", "경조사비"])
  })

  it("2어절은 예산이 남으므로 양끝 둘 다 시도한다 (꼬리 제거 → 머리 제거)", async () => {
    const { client, tried } = tracingClient(() => EMPTY_PREC_XML)
    await handleFinRulingSearch(client, { query: "임직원 경조사비", domains: ["precedent"] })
    expect(tried).toEqual(["임직원 경조사비", "임직원", "경조사비"])
  })

  it("2어절에서 머리 어절이 0건이면 꼬리 어절까지 내려가 결과를 찾는다", async () => {
    const { client, tried } = tracingClient((q) =>
      q === "경조사비" ? HIT_PREC_XML : EMPTY_PREC_XML
    )
    const r = await handleFinRulingSearch(client, {
      query: "임직원 경조사비",
      domains: ["precedent"],
    })
    expect(tried).toEqual(["임직원 경조사비", "임직원", "경조사비"])
    const text = r.content[0].text
    expect(text).toContain(`검색어 축약 2단: "경조사비"`)
    expect(text).toContain("경조사비 손금산입")
  })

  /**
   * 전처리 동기화 — 국소 사다리는 불용어 목록을 복제하지 않고 fin-common의
   * RULING_STOPWORDS를 직접 참조한다. 공용 목록이 늘어나면 이 도구도 함께 따라간다.
   */
  it("공용 불용어 목록을 그대로 참조한다 — 축약 단계에 불용어가 남지 않는다", async () => {
    const { client, tried } = tracingClient(() => EMPTY_PREC_XML)
    await handleFinRulingSearch(client, {
      query: "임직원 및 경조사비 등 손금",
      domains: ["precedent"],
    })
    // 원문은 1순위로 그대로 둔다 ("및"이 공식 명칭의 일부일 수 있다). 축약 단계에서만 제거
    expect(tried).toEqual(["임직원 및 경조사비 등 손금", "임직원 경조사비", "경조사비"])
  })

  it("1단 축약이면 종전 표기를 유지한다 (단수 표기는 2단부터)", async () => {
    const { client, tried } = tracingClient((q) => (q === "임직원" ? HIT_PREC_XML : EMPTY_PREC_XML))
    const r = await handleFinRulingSearch(client, {
      query: "임직원 경조사비",
      domains: ["precedent"],
    })
    expect(tried).toEqual(["임직원 경조사비", "임직원"])
    const text = r.content[0].text
    expect(text).toContain(`(검색어 축약: "임직원")`)
    expect(text).not.toContain("축약 1단")
  })

  it("2단계에서 429가 나면 사다리를 더 내려가지 않고 ⚠ 확인 불가로 보고한다", async () => {
    const { client, tried } = tracingClient((_q, nth) => {
      if (nth === 1) return EMPTY_PREC_XML
      throw new Error("429 요청 한도 초과")
    })
    const r = await handleFinRulingSearch(client, {
      query: "임직원 경조사비 손금",
      domains: ["precedent"],
    })
    // 오류 이후 3·4단계를 시도하지 않는다 — 재시도는 429를 악화시키고 0건 위장을 만든다
    expect(tried).toEqual(["임직원 경조사비 손금", "임직원 경조사비"])
    const text = r.content[0].text
    expect(text).toContain("⚠ 조회 실패")
    expect(text).toContain("429")
    expect(text).toContain(`"없음"이 아니라 확인 불가`)
    // 오류가 0건으로 위장되지 않는다 (도메인 줄에 0건 표기가 없어야 한다)
    expect(text).not.toContain("법원 판례 — 0건")
    expect(text).not.toContain("전부 0건")
    expect(r.isError).toBe(true)
  })

  it("어절이 더 많아도 도메인당 4회에서 멈춘다 (법제처 분당 30회 · 4곳 병렬)", async () => {
    const { client, tried } = tracingClient(() => EMPTY_PREC_XML)
    await handleFinRulingSearch(client, {
      query: "퇴직금 중간정산 손금 산입 요건 여부",
      domains: ["precedent"],
    })
    expect(tried).toHaveLength(4)
    // ⚠ 양끝 교대는 한 번에 한 어절씩만 깎으므로 6어절 질의는 예산 안에서 3어절까지만 내려간다.
    //   1어절에 닿는 것은 4어절 이하 질의뿐 (상한을 올리면 분당 30회 한도에 걸린다)
    expect(tried).toEqual([
      "퇴직금 중간정산 손금 산입 요건 여부",
      "퇴직금 중간정산 손금 산입 요건",
      "중간정산 손금 산입 요건",
      "중간정산 손금 산입",
    ])
  })

  it("4곳 병렬에서도 도메인당 상한이 유지된다 (총 16회)", async () => {
    const perTarget = new Map<string, number>()
    const client = {
      fetchApi: async (p: { target?: string }) => {
        const t = p.target ?? "?"
        perTarget.set(t, (perTarget.get(t) ?? 0) + 1)
        return EMPTY_PREC_XML
      },
    } as unknown as LawApiClient
    await handleFinRulingSearch(client, { query: "퇴직금 중간정산 손금 산입 요건 여부" })
    expect(perTarget.size).toBe(4)
    expect([...perTarget.values()].every((n) => n === 4)).toBe(true)
  })

  it("모든 축약 단계가 0건이면 시도한 검색어 전체와 '전부 0건'을 한 줄로 밝힌다", async () => {
    const { client } = tracingClient(() => EMPTY_PREC_XML)
    const r = await handleFinRulingSearch(client, {
      query: "임직원 경조사비 손금",
      domains: ["precedent"],
    })
    const text = r.content[0].text
    expect(text).toContain("법원 판례 — 0건 (축약 3단계 전부 0건")
    expect(text).toContain(`"임직원 경조사비 손금" → "임직원 경조사비" → "경조사비"`)
    expect(text).toContain("검색어를 바꿔야 한다는 뜻입니다")
  })

  it("사다리 검색어 나열은 도메인마다 반복하지 않고 한 번만 나온다", async () => {
    const { client } = tracingClient(() => EMPTY_PREC_XML)
    const r = await handleFinRulingSearch(client, { query: "임직원 경조사비 손금" })
    const text = r.content[0].text
    expect(text.split("축약 사다리")).toHaveLength(2) // 등장 1회
    expect(text.match(/축약 3단계 전부 0건/g)).toHaveLength(4) // 도메인 줄은 4개 전부
  })

  it("4곳 전부 사다리 0건이어도 4,000자 예산 안에 들어간다 (절단 금지)", async () => {
    const { client } = tracingClient(() => EMPTY_PREC_XML)
    const r = await handleFinRulingSearch(client, { query: "임직원 경조사비 복리후생비 손금" })
    const text = r.content[0].text
    expect(text.length).toBeLessThan(4000)
    expect(text).not.toContain("예산 4,000자 초과로 절단")
    // 실측 결함 질의 그대로 — 종착점이 "임직원"이 아니라 "경조사비"여야 한다
    expect(text).toContain("축약 4단계 전부 0건")
    expect(text).toContain(
      `"임직원 경조사비 복리후생비 손금" → "임직원 경조사비 복리후생비" → "경조사비 복리후생비" → "경조사비"`
    )
  })

  it("어절이 1개면 축약 없이 1회만 호출하고 종전 문구를 쓴다", async () => {
    const { client, tried } = tracingClient(() => EMPTY_PREC_XML)
    const r = await handleFinRulingSearch(client, { query: "퇴직금", domains: ["precedent"] })
    expect(tried).toEqual(["퇴직금"])
    const text = r.content[0].text
    expect(text).toContain("정상 조회 결과 없음")
    expect(text).not.toContain("축약 사다리")
  })

  it("결과가 기준일로 전부 걸러진 단계에서는 사다리를 더 내려가지 않는다", async () => {
    // 그 검색어에 자료가 있다는 사실은 이미 확인됐다 — 축약하면 '없음' 사유가 흐려진다
    const { client, tried } = tracingClient(() => HIT_PREC_XML)
    const r = await handleFinRulingSearch(client, {
      query: "임직원 경조사비 손금",
      domains: ["precedent"],
      basis_date: "2000-01-01",
    })
    expect(tried).toEqual(["임직원 경조사비 손금"])
    expect(r.content[0].text).toContain("모두 기준일 이후")
  })
})
