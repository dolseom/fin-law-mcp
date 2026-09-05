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

  /**
   * 5어절 이상 창 축약 (Codex 제품 검토 2026-09-05 [높음]).
   * 종전 양끝 교대는 한 번에 한 어절씩만 깎아 6어절 질의가 "중간정산 손금 산입"에서 끝났다 —
   * 예산 4회 안에 핵심어("퇴직금 중간정산")에 한 번도 못 닿았다.
   */
  it("6어절: 원문 → 양끝 제거 → 핵심 2어절 창 → 핵심 1어절 (예산 4회)", async () => {
    const { client, tried } = tracingClient(() => EMPTY_PREC_XML)
    await handleFinRulingSearch(client, {
      query: "퇴직금 중간정산 손금 산입 요건 여부",
      domains: ["precedent"],
    })
    expect(tried).toHaveLength(4)
    expect(tried).toEqual([
      "퇴직금 중간정산 손금 산입 요건 여부",
      "중간정산 손금 산입 요건",
      "퇴직금 중간정산",
      "중간정산",
    ])
  })

  it("5어절: 쟁점 접미(손금·여부)를 뺀 앞쪽 2어절 창으로 내려간다", async () => {
    const { client, tried } = tracingClient(() => EMPTY_PREC_XML)
    await handleFinRulingSearch(client, {
      query: "임직원 경조사비 복리후생비 손금 여부",
      domains: ["precedent"],
    })
    expect(tried).toEqual([
      "임직원 경조사비 복리후생비 손금 여부",
      "경조사비 복리후생비 손금",
      "임직원 경조사비",
      "경조사비",
    ])
  })

  it("7어절도 4회 안에 1어절까지 내려간다", async () => {
    const { client, tried } = tracingClient(() => EMPTY_PREC_XML)
    await handleFinRulingSearch(client, {
      query: "임직원 퇴직금 중간정산 손금 산입 요건 여부",
      domains: ["precedent"],
    })
    expect(tried).toEqual([
      "임직원 퇴직금 중간정산 손금 산입 요건 여부",
      "퇴직금 중간정산 손금 산입 요건",
      "임직원 퇴직금",
      "퇴직금",
    ])
  })

  /**
   * 종착점은 창의 **마지막** 어절이다. 법제처는 display=10을 가나다순으로 돌려주므로
   * 넓은 어절("퇴직금")로 끝내면 관련 문서가 10건 창 밖으로 밀려 0건처럼 보인다.
   */
  it("핵심 1어절 단계에서 결과가 나오면 그 단계에서 멈춘다", async () => {
    const { client, tried } = tracingClient((q) =>
      q === "중간정산" ? HIT_PREC_XML : EMPTY_PREC_XML
    )
    const r = await handleFinRulingSearch(client, {
      query: "퇴직금 중간정산 손금 산입 요건 여부",
      domains: ["precedent"],
    })
    expect(tried).toHaveLength(4)
    expect(r.content[0].text).toContain(`검색어 축약 3단: "중간정산"`)
  })

  it("쟁점 접미만으로 이뤄진 5어절은 접미 제거를 건너뛰고 원 어절로 창을 잡는다", async () => {
    const { client, tried } = tracingClient(() => EMPTY_PREC_XML)
    await handleFinRulingSearch(client, {
      query: "손금 산입 요건 여부 해당",
      domains: ["precedent"],
    })
    // core가 비면 창을 못 만든다 — 원 어절 앞쪽 2개로 되돌린다 (0건 위장 금지)
    expect(tried).toEqual([
      "손금 산입 요건 여부 해당",
      "산입 요건 여부",
      "손금 산입",
      "산입",
    ])
  })

  it("핵심 어절이 1개뿐이면 창과 종착점이 같아 사다리가 3단이 된다", async () => {
    const { client, tried } = tracingClient(() => EMPTY_PREC_XML)
    await handleFinRulingSearch(client, {
      query: "퇴직금 손금 산입 요건 여부",
      domains: ["precedent"],
    })
    expect(tried).toEqual(["퇴직금 손금 산입 요건 여부", "손금 산입 요건", "퇴직금"])
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

/**
 * 원문 링크 (Codex 제품 검토 2026-09-05 [높음]).
 * 내부적으로 link를 갖고 있으면서 출력에는 번호·일자·제목만 실어 실무자가 원문을 열 수 없었다.
 */
const NTS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CgmExpc><totalCnt>1</totalCnt>
  <cgmExpc id="1"><안건명>무주택 임원 퇴직금 중간정산 가능 여부</안건명><안건번호>법인세과-352</안건번호><해석일자>20130716</해석일자><법령해석상세링크>https://taxlaw.nts.go.kr/qt/USEQTA002P.do?ntstDcmId=010000000000515153</법령해석상세링크></cgmExpc>
</CgmExpc>`

/** ntstDcmId가 없는 목록 링크 — 상세 URL을 조립할 수 없는 경우 */
const NTS_NO_ID_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CgmExpc><totalCnt>1</totalCnt>
  <cgmExpc id="1"><안건명>예규 제목</안건명><안건번호>법인세과-999</안건번호><해석일자>20200101</해석일자><법령해석상세링크>https://taxlaw.nts.go.kr/qt/USEQTA001M.do</법령해석상세링크></cgmExpc>
</CgmExpc>`

/**
 * 법제처 DRF 상세링크 — 상대경로 + **인증키(OC) 동반**(2026-09-05 실측) + XML이라 &가 &amp;로 온다.
 * 이 링크는 출력에 싣지 않고 ID만 뽑아 공개 열람 URL로 바꾼다.
 */
const PREC_DRF_XML = `<?xml version="1.0" encoding="UTF-8"?>
<PrecSearch><totalCnt>1</totalCnt>
  <prec><판례일련번호>228547</판례일련번호><사건번호>2019두12345</사건번호><사건명>퇴직금 중간정산</사건명><선고일자>20190301</선고일자><법원명>대법원</법원명><판례상세링크>/DRF/lawService.do?OC=mysecretkey&amp;target=prec&amp;ID=228547&amp;type=HTML</판례상세링크></prec>
</PrecSearch>`

/** 실측 형태 그대로 — OC=OC_SENTINEL_TEST 이 링크에 실려 온다 */
const PREC_OC_XML = `<?xml version="1.0" encoding="UTF-8"?>
<PrecSearch><totalCnt>1</totalCnt>
  <prec><판례일련번호>613989</판례일련번호><사건번호>2019두99</사건번호><사건명>키 노출 회귀</사건명><선고일자>20190301</선고일자><법원명>대법원</법원명><판례상세링크>/DRF/lawService.do?OC=OC_SENTINEL_TEST&amp;target=prec&amp;ID=613989&amp;type=HTML</판례상세링크></prec>
</PrecSearch>`

const EXPC_DRF_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Expc><totalCnt>1</totalCnt>
  <expc><법령해석례일련번호>343221</법령해석례일련번호><안건명>경조사비 해석례</안건명><안건번호>24-0001</안건번호><회신일자>20240101</회신일자><법령해석례상세링크>/DRF/lawService.do?OC=OC_SENTINEL_TEST&amp;target=expc&amp;ID=343221&amp;type=HTML</법령해석례상세링크></expc>
</Expc>`

const DECC_DRF_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Decc><totalCnt>1</totalCnt>
  <decc><특별행정심판재결례일련번호>213580</특별행정심판재결례일련번호><사건명>재결례 제목</사건명><청구번호>조심2024서1</청구번호><의결일자>20240101</의결일자><행정심판재결례상세링크>/DRF/lawService.do?OC=OC_SENTINEL_TEST&amp;target=ttSpecialDecc&amp;ID=213580&amp;type=HTML</행정심판재결례상세링크></decc>
</Decc>`

/** 상세링크가 비어 온 경우 — ID를 못 뽑으므로 사유를 적어야 한다 */
const PREC_NO_LINK_XML = `<?xml version="1.0" encoding="UTF-8"?>
<PrecSearch><totalCnt>1</totalCnt>
  <prec><판례일련번호>1</판례일련번호><사건번호>2019두1</사건번호><사건명>링크없음</사건명><선고일자>20190301</선고일자><법원명>대법원</법원명><판례상세링크></판례상세링크></prec>
</PrecSearch>`

function xmlClient(xml: string): LawApiClient {
  return { fetchApi: async () => xml } as unknown as LawApiClient
}

describe("fin_ruling_search — 원문 링크", () => {
  it("국세청 예규는 ntstDcmId로 상세 URL을 조립한다 (fin_nts_ruling 본문 경로와 같은 형식)", async () => {
    const r = await handleFinRulingSearch(xmlClient(NTS_XML), {
      query: "퇴직금",
      domains: ["nts"],
    })
    expect(r.content[0].text).toContain(
      "법인세과-352 (20130716) 무주택 임원 퇴직금 중간정산 가능 여부 · https://taxlaw.nts.go.kr/qt/USEQTA002P.do?ntstDcmId=010000000000515153"
    )
  })

  it("ntstDcmId를 못 뽑으면 원 링크를 그대로 싣는다 (링크 자체를 버리지 않는다)", async () => {
    const r = await handleFinRulingSearch(xmlClient(NTS_NO_ID_XML), {
      query: "퇴직금",
      domains: ["nts"],
    })
    expect(r.content[0].text).toContain("· https://taxlaw.nts.go.kr/qt/USEQTA001M.do")
  })

  it("법제처 판례는 상세링크의 ID로 공개 열람 URL(precInfoP)을 조립한다", async () => {
    const r = await handleFinRulingSearch(xmlClient(PREC_DRF_XML), {
      query: "퇴직금",
      domains: ["precedent"],
    })
    const text = r.content[0].text
    expect(text).toContain("· https://www.law.go.kr/LSW/precInfoP.do?precSeq=228547")
    // DRF 링크는 어떤 형태로도 나가지 않는다 (마스킹해 실으면 열리지 않는 링크가 남는다)
    expect(text).not.toContain("lawService.do")
    expect(text).not.toContain("&amp;")
  })

  it("해석례는 expcInfoP, 조세심판원 재결례는 specialDeccInfoP로 조립한다", async () => {
    const expc = await handleFinRulingSearch(xmlClient(EXPC_DRF_XML), {
      query: "퇴직금",
      domains: ["interpretation"],
    })
    expect(expc.content[0].text).toContain(
      "· https://www.law.go.kr/LSW/expcInfoP.do?expcSeq=343221"
    )
    const decc = await handleFinRulingSearch(xmlClient(DECC_DRF_XML), {
      query: "퇴직금",
      domains: ["tax_tribunal"],
    })
    expect(decc.content[0].text).toContain(
      "· https://www.law.go.kr/LSW/specialDeccInfoP.do?deccSeq=213580"
    )
  })

  /**
   * 인증키 유출 회귀 — 법제처 상세링크는 `?OC=<키>&target=…&ID=…` 형태로 키가 실려 온다
   * (2026-09-05 실측). 어떤 경로로도 출력에 `OC=`가 남으면 안 된다.
   */
  it("상세링크에 실려 온 인증키(OC)는 출력에 한 글자도 나가지 않는다", async () => {
    const r = await handleFinRulingSearch(xmlClient(PREC_OC_XML), {
      query: "퇴직금",
      domains: ["precedent"],
    })
    const text = r.content[0].text
    expect(text).not.toContain("OC_SENTINEL_TEST")
    expect(text).not.toContain("OC=")
    // 키를 지우느라 링크를 잃지는 않는다
    expect(text).toContain("https://www.law.go.kr/LSW/precInfoP.do?precSeq=613989")
  })

  it("ID를 못 뽑으면 링크 대신 사유를 적는다 (조용히 비우지 않는다)", async () => {
    const r = await handleFinRulingSearch(xmlClient(PREC_NO_LINK_XML), {
      query: "퇴직금",
      domains: ["precedent"],
    })
    const line = r.content[0].text
      .split("\n")
      .find((l) => l.includes("링크없음"))
    expect(line).toBe("  · 2019두1 (20190301) 링크없음 [대법원] · 링크 없음(ID 미확인)")
  })
})

/**
 * 예산 4,000자 — 링크가 붙어 길어진 만큼 뒤에서 통짜로 잘리면 마지막 도메인이 통째로 사라진다
 * (조용한 절단). 예산을 넘으면 표시 건수를 줄이되 줄인 사실을 건수로 고지한다.
 */
/** 4개 도메인 전부가 count건씩 돌려주는 스텁 — 링크는 실제 DRF 상세링크 길이에 맞춘다 */
function fullClient(count: number, titleLen: number): LawApiClient {
  const title = (n: number) => `${"가".repeat(titleLen)}${n}`
  const drf = (target: string, n: number) =>
    `/DRF/lawService.do?OC=k&amp;target=${target}&amp;ID=99999${n}&amp;type=HTML`
  const rows = (make: (n: number) => string) =>
    Array.from({ length: count }, (_, i) => make(i + 1)).join("")
  const byTarget: Record<string, string> = {
    ntsCgmExpc: `<CgmExpc><totalCnt>${count}</totalCnt>${rows(
      (n) =>
        `<cgmExpc id="${n}"><안건명>${title(n)}</안건명><안건번호>법인세과-${n}</안건번호><해석일자>2024010${n}</해석일자><법령해석상세링크>https://taxlaw.nts.go.kr/qt/USEQTA002P.do?ntstDcmId=01000000000051515${n}</법령해석상세링크></cgmExpc>`
    )}</CgmExpc>`,
    ttSpecialDecc: `<Decc><totalCnt>${count}</totalCnt>${rows(
      (n) =>
        `<decc><특별행정심판재결례일련번호>${n}</특별행정심판재결례일련번호><사건명>${title(n)}</사건명><청구번호>조심2024서${n}</청구번호><의결일자>2024010${n}</의결일자><행정심판재결례상세링크>${drf("ttSpecialDecc", n)}</행정심판재결례상세링크></decc>`
    )}</Decc>`,
    expc: `<Expc><totalCnt>${count}</totalCnt>${rows(
      (n) =>
        `<expc><법령해석례일련번호>${n}</법령해석례일련번호><안건명>${title(n)}</안건명><안건번호>24-0${n}</안건번호><회신일자>2024010${n}</회신일자><법령해석례상세링크>${drf("expc", n)}</법령해석례상세링크></expc>`
    )}</Expc>`,
    prec: `<PrecSearch><totalCnt>${count}</totalCnt>${rows(
      (n) =>
        `<prec><판례일련번호>${n}</판례일련번호><사건번호>2024두${n}</사건번호><사건명>${title(n)}</사건명><선고일자>2024010${n}</선고일자><법원명>대법원</법원명><판례상세링크>${drf("prec", n)}</판례상세링크></prec>`
    )}</PrecSearch>`,
  }
  return {
    fetchApi: async (p: { target?: string }) => byTarget[p.target ?? ""] ?? "",
  } as unknown as LawApiClient
}

describe("fin_ruling_search — 링크 포함 예산 계산", () => {
  it("4곳 × 5건 + 링크가 예산 안에 들어가고 모든 항목에 링크가 붙는다", async () => {
    const r = await handleFinRulingSearch(fullClient(5, 25), { query: "퇴직금 중간정산" })
    const text = r.content[0].text
    expect(text.length).toBeLessThanOrEqual(4000)
    expect(text).not.toContain("예산 4,000자 초과로 절단")
    const itemLines = text.split("\n").filter((l) => l.startsWith("  · "))
    expect(itemLines).toHaveLength(20)
    expect(itemLines.every((l) => l.includes("https://"))).toBe(true)
    // 도메인별 링크 형식이 각각 붙는다
    expect(text).toContain("https://taxlaw.nts.go.kr/qt/USEQTA002P.do?ntstDcmId=")
    expect(text).toContain("https://www.law.go.kr/LSW/precInfoP.do?precSeq=")
    expect(text).toContain("https://www.law.go.kr/LSW/expcInfoP.do?expcSeq=")
    expect(text).toContain("https://www.law.go.kr/LSW/specialDeccInfoP.do?deccSeq=")
    expect(text).not.toContain("OC=")
  })

  it("항목이 길어 예산을 넘으면 절단하지 않고 표시 건수를 줄이며 건수를 고지한다", async () => {
    const r = await handleFinRulingSearch(fullClient(5, 90), { query: "퇴직금 중간정산" })
    const text = r.content[0].text
    expect(text.length).toBeLessThanOrEqual(4000)
    expect(text).not.toContain("예산 4,000자 초과로 절단")
    const itemLines = text.split("\n").filter((l) => l.startsWith("  · "))
    expect(itemLines.length).toBeLessThan(20)
    expect(itemLines.length).toBeGreaterThan(0)
    // 줄인 사실을 조용히 넘기지 않는다 — 4곳 모두 건수를 고지한다
    expect(text.match(/검색 5건 중 최신 \d건 표시/g)).toHaveLength(4)
    // 남은 항목에는 링크가 그대로 붙어 있다
    expect(itemLines.every((l) => l.includes("https://"))).toBe(true)
  })
})

describe("fin_ruling_search — 전체 실패 헤더", () => {
  it("성공한 도메인이 하나도 없으면 '전체 실패'로 쓴다 (부분 성공 아님)", async () => {
    const client = {
      fetchApi: async () => {
        throw new Error("503 서비스 점검")
      },
    } as unknown as LawApiClient
    const r = await handleFinRulingSearch(client, { query: "퇴직금" })
    const text = r.content[0].text
    expect(text).toContain("전체 실패")
    expect(text).not.toContain("부분 성공")
    expect(r.isError).toBe(true)
  })

  it("일부만 실패하면 종전대로 '부분 성공'", async () => {
    const client = {
      fetchApi: async (p: { target?: string }) => {
        if (p.target === "prec") throw new Error("503 서비스 점검")
        return "<Decc><totalCnt>0</totalCnt></Decc>"
      },
    } as unknown as LawApiClient
    const r = await handleFinRulingSearch(client, { query: "퇴직금" })
    const text = r.content[0].text
    expect(text).toContain("부분 성공")
    expect(text).not.toContain("전체 실패")
    expect(r.isError).toBeUndefined()
  })

  it("전부 성공하면 '전체 성공'", async () => {
    const r = await handleFinRulingSearch(xmlClient("<Decc><totalCnt>0</totalCnt></Decc>"), {
      query: "퇴직금",
    })
    expect(r.content[0].text).toContain("전체 성공")
  })
})
