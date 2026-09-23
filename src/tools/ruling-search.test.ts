/**
 * fin_ruling_search 기준일 필터 회귀 테스트 (fixture 기반 — CI 상시)
 *
 * 예규·재결·판례는 "시행일"이 아니라 회신·의결·선고일 기준이라 법령과 필터 의미가
 * 다르다. 또한 기준일 필터는 상위 N건 자르기 **전에** 적용해야 한다 —
 * 뒤에 적용하면 상위가 전부 기준일 이후일 때 실제로 있는 과거 자료가 0건으로 보인다.
 */

import { describe, it, expect } from "vitest"
import {
  handleFinRulingSearch,
  buildLadder,
  isLatestFirst,
  ladderWarning,
  readTotalCnt,
  totalCntNote,
  FIN_RULING_SEARCH_TOOL,
} from "./ruling-search.js"
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

  /**
   * Codex 9차 M2 — 종전 사다리는 이 질의의 2단계가 "손금 산입 요건"(쟁점 접미만)이었고, 라이브에서
   * 대손금·주식매수선택권 예규 5건을 "전체 성공"으로 줬다. 주제어("퇴직금")가 있는 질의에서는
   * 주제어 없는 축약 단계를 건너뛴다. 창과 종착점이 같아 사다리는 2단이 된다.
   */
  it("핵심 어절이 1개뿐이면 쟁점 접미만 남은 단계를 건너뛰고 핵심 어절로 간다", async () => {
    const { client, tried } = tracingClient(() => EMPTY_PREC_XML)
    await handleFinRulingSearch(client, {
      query: "퇴직금 손금 산입 요건 여부",
      domains: ["precedent"],
    })
    expect(tried).toEqual(["퇴직금 손금 산입 요건 여부", "퇴직금"])
    expect(tried).not.toContain("손금 산입 요건")
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
      "· https://www.law.go.kr/LSW/specialDeccInfoP.do?trbClsCd=360101&specialDeccSeq=213580"
    )
  })

  /**
   * Codex 9차 M1 — `deccSeq=`는 실존 ID도 없는 ID와 같은 6,303B 빈 셸을 연다 (2026-09-16 curl:
   * 947374·183014·111136 전부). 열리는 형식은 specialDeccSeq + trbClsCd=360101 (세 건 모두 제목 일치,
   * 없는 ID는 오류페이지). "200"만 보고 통과시킨 형식이 다시 들어오지 않게 박제한다.
   */
  it("재결례 링크는 빈 셸을 여는 deccSeq 형식을 쓰지 않는다", async () => {
    const decc = await handleFinRulingSearch(xmlClient(DECC_DRF_XML), {
      query: "퇴직금",
      domains: ["tax_tribunal"],
    })
    const text = decc.content[0].text
    expect(text).not.toContain("deccSeq=213580&")
    expect(text).not.toMatch(/[?&]deccSeq=/)
    expect(text).toMatch(/specialDeccSeq=213580(?:\s|$)/m)
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
    expect(text).toContain("https://www.law.go.kr/LSW/specialDeccInfoP.do?trbClsCd=360101&specialDeccSeq=")
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

/**
 * Codex 9차 [차단] L — "최신순"·"검색 N건"이 사실과 달랐다.
 *
 * 종전엔 sort 없이 display=10을 받아 그 10건 안에서만 일자순으로 정렬하고, 받은 건수를 "검색 N건"이라
 * 적었다. 법제처 기본 정렬은 제목 가나다순이라 "퇴직금 중간정산" 예규 163건 중 2021년 건이 "최신"이 됐다.
 * 이전 픽스처는 totalCnt와 항목 수가 같아서(8=8, 1=1) 이 결함이 숨어 있었다 — 아래 픽스처는
 * 실응답 형태(target·키워드·section·page·numOfRows 동반, totalCnt 163 > 항목 10, 일자 "YYYY.MM.DD")를 따른다.
 */
const ntsItem = (n: number, date: string, title: string) =>
  `<cgmExpc id="${n}"><법령해석일련번호>${n}</법령해석일련번호><안건명><![CDATA[${title}]]></안건명><안건번호>서면-${n}</안건번호>` +
  `<질의기관명>국세청</질의기관명><해석기관명>국세청</해석기관명><해석일자>${date}</해석일자>` +
  `<법령해석상세링크>https://taxlaw.nts.go.kr/qt/USEQTA002P.do?ntstDcmId=0100000000000${String(n).padStart(5, "0")}</법령해석상세링크>` +
  `<데이터기준일시>20260915</데이터기준일시></cgmExpc>`

const ntsSearchXml = (total: number, rows: Array<[string, string]>) =>
  `<?xml version="1.0" encoding="UTF-8"?><CgmExpc><target>ntsCgmExpc</target><키워드>퇴직금 중간정산</키워드>` +
  `<section>itmNm</section><totalCnt>${total}</totalCnt><page>1</page><numOfRows>${rows.length}</numOfRows>` +
  rows.map(([d, t], i) => ntsItem(i + 1, d, t)).join("") +
  `</CgmExpc>`

/** 2026-09-16 실측 sort=ddes 1쪽의 일자 그대로 (totalCnt 163) */
const NTS_DDES_163 = ntsSearchXml(163, [
  ["2025.02.17", "임원 퇴직금 중간정산액을 업무무관가지급금으로 보아 수정"],
  ["2024.07.10", "퇴직금 중간정산 후 해외 근무기간이 있는 경우 희망퇴직"],
  ["2024.02.29", "임원 퇴직금 중간정산액의 손금산입 여부"],
  ["2023.09.15", "퇴직금 중간정산 사유"],
  ["2023.04.11", "퇴직금 중간정산 근속연수"],
  ["2021.06.29", "2회 이상 퇴직금 중간정산 후 퇴직소득 세액정산 방법"],
  ["2018.05.24", "퇴직금 중간정산 퇴직소득"],
  ["2017.06.22", "퇴직금 중간정산 원천징수"],
  ["2016.11.22", "퇴직금 중간정산 과세"],
  ["2016.01.13", "퇴직금 중간정산 손금"],
])

/** 2026-09-16 실측 정렬 없는 1쪽의 일자 그대로 — 제목 가나다순이라 일자가 뒤섞인다 (totalCnt 163) */
const NTS_GANADA_163 = ntsSearchXml(163, [
  ["2004.03.08", "1년 미만 근무자에 대한 퇴직금 중간정산시 손금산입 여부"],
  ["2021.06.29", "2회 이상 퇴직금 중간정산 후 퇴직소득 세액정산 방법"],
  ["1999.09.14", "공사ㆍ공단의 구조조정시 퇴직금을 중간정산하는 경우"],
  ["2009.03.17", "과세이연한 중간정산퇴직금 합산과세여부"],
  ["2002.03.09", "교직원퇴직금을 중간정산한 후 퇴직하는 경우"],
  ["1997.05.12", "근로기준법상 사용자가 아닌 근로자 1"],
  ["1997.06.23", "근로기준법상 사용자가 아닌 근로자 2"],
  ["1997.07.22", "근로기준법에 따른 퇴직금 중간정산"],
  ["1999.09.09", "근로기준법에 의한 퇴직금의 중간정산"],
  ["1999.05.10", "근로기준법에 의한 퇴직금중간정산"],
])

/** 도메인별 요청 파라미터를 기록하는 스텁 */
function paramClient(respond: (target: string) => string): {
  client: LawApiClient
  calls: Array<{ target: string; params: Record<string, string> }>
} {
  const calls: Array<{ target: string; params: Record<string, string> }> = []
  const client = {
    fetchApi: async (p: { target: string; extraParams?: Record<string, string> }) => {
      calls.push({ target: p.target, params: { ...(p.extraParams ?? {}) } })
      return respond(p.target)
    },
  } as unknown as LawApiClient
  return { client, calls }
}

const EMPTY_BY_TARGET: Record<string, string> = {
  ntsCgmExpc: "<CgmExpc><totalCnt>0</totalCnt></CgmExpc>",
  ttSpecialDecc: "<Decc><totalCnt>0</totalCnt></Decc>",
  expc: "<Expc><totalCnt>0</totalCnt></Expc>",
  prec: "<PrecSearch><totalCnt>0</totalCnt></PrecSearch>",
}

describe("fin_ruling_search — 최신순 정렬·검색 건수 (Codex 9차 L)", () => {
  it("4곳 모두 sort=ddes(일자 내림차순)로 요청한다", async () => {
    const { client, calls } = paramClient((t) => EMPTY_BY_TARGET[t])
    await handleFinRulingSearch(client, { query: "퇴직금" })
    expect(new Set(calls.map((c) => c.target))).toEqual(new Set(["ntsCgmExpc", "ttSpecialDecc", "expc", "prec"]))
    expect(calls.every((c) => c.params.sort === "ddes")).toBe(true)
  })

  it("기준일이 없으면 기간 파라미터를 싣지 않는다", async () => {
    const { client, calls } = paramClient((t) => EMPTY_BY_TARGET[t])
    await handleFinRulingSearch(client, { query: "퇴직금" })
    for (const c of calls) {
      expect(Object.keys(c.params).sort()).toEqual(["display", "query", "sort"])
    }
  })

  it("기준일이 있으면 도메인별 기간 파라미터(explYd·rslYd·explYd·prncYd)를 범위 문법으로 싣는다", async () => {
    const { client, calls } = paramClient((t) => EMPTY_BY_TARGET[t])
    await handleFinRulingSearch(client, { query: "퇴직금", basis_date: "2015-01-01" })
    const byTarget = Object.fromEntries(calls.map((c) => [c.target, c.params]))
    expect(byTarget.ntsCgmExpc.explYd).toBe("19000101~20150101")
    expect(byTarget.ttSpecialDecc.rslYd).toBe("19000101~20150101")
    expect(byTarget.expc.explYd).toBe("19000101~20150101")
    expect(byTarget.prec.prncYd).toBe("19000101~20150101")
    // 도메인이 섞이지 않는다 — 판례·재결례에 해석일자 파라미터를 싣지 않는다
    expect(byTarget.prec.explYd).toBeUndefined()
    expect(byTarget.ttSpecialDecc.explYd).toBeUndefined()
  })

  it("검색 총건수는 받은 10건이 아니라 응답 totalCnt다 (163건 중 최신 5건)", async () => {
    const r = await handleFinRulingSearch(xmlClient(NTS_DDES_163), { query: "퇴직금 중간정산", domains: ["nts"] })
    const text = r.content[0].text
    expect(text).toContain("최신순 5건 · 검색 163건 중 최신 5건 표시")
    expect(text).not.toContain("검색 10건")
    // 표시 5건은 받은 순서(일자 내림차순)의 앞 5건 — 2025년 건이 첫 줄
    const lines = text.split("\n").filter((l) => l.startsWith("  · "))
    expect(lines[0]).toContain("(2025.02.17)")
    expect(lines[4]).toContain("(2023.04.11)")
    expect(text).not.toContain("(2021.06.29)")
  })

  it("받은 순서가 일자 내림차순이 아니면(정렬 미적용) '최신순'이라 쓰지 않는다", async () => {
    const r = await handleFinRulingSearch(xmlClient(NTS_GANADA_163), { query: "퇴직금 중간정산", domains: ["nts"] })
    const text = r.content[0].text
    expect(text).not.toContain("최신순 5건")
    expect(text).not.toContain("중 최신 5건 표시")
    expect(text).toContain("일자순 5건 · 검색 163건 중 법제처 응답 10건만 일자순 정렬 — 최신순 미보장")
  })

  it("반대 방향: 검색 결과를 전부 받았으면 받은 순서와 무관하게 로컬 정렬이 곧 최신순이다", async () => {
    // fullClient는 일자 오름차순으로 5건을 주고 totalCnt도 5 — 전체를 받았으므로 최신순이 사실이다
    const r = await handleFinRulingSearch(fullClient(5, 10), { query: "퇴직금", domains: ["precedent"] })
    const text = r.content[0].text
    expect(text).toContain("최신순 5건")
    expect(text).not.toContain("최신순 미보장")
    expect(text).not.toContain("검색 5건 중") // 5건 전부 표시 — 절단 고지 없음
  })

  it("totalCnt를 못 읽은 응답은 '전체를 받았다'로 보지 않고, 받은 건수를 검색 총건수로 부르지 않는다", async () => {
    const noTotal = NTS_GANADA_163.replace("<totalCnt>163</totalCnt>", "")
    const r = await handleFinRulingSearch(xmlClient(noTotal), { query: "퇴직금 중간정산", domains: ["nts"] })
    const text = r.content[0].text
    expect(text).toContain(
      "일자순 5건 · 받은 10건(검색 총건수 미확인 — 응답의 totalCnt를 읽지 못함) 중 법제처 응답 10건만 일자순 정렬"
    )
    expect(text).not.toContain("검색 10건")
    // 반대 방향: 받은 순서가 내림차순이면 최신순은 사실이고, 건수 표기만 받은 건수 기준이다
    const noTotalDesc = NTS_DDES_163.replace("<totalCnt>163</totalCnt>", "")
    const r2 = await handleFinRulingSearch(xmlClient(noTotalDesc), { query: "퇴직금 중간정산", domains: ["nts"] })
    expect(r2.content[0].text).toContain(
      "최신순 5건 · 받은 10건(검색 총건수 미확인 — 응답의 totalCnt를 읽지 못함) 중 최신 5건 표시"
    )
  })

  /**
   * isLatestFirst는 "받은 순서가 일자 내림차순"이라는 **관찰**이다.
   * 종전 구현은 일자를 못 읽은 항목을 걸러낸 뒤 비교해서, 빈 배열(`[].every`)·전부 미상·단 1건이
   * 모두 true였다 — 관찰한 것이 없는데 관찰했다고 답했다. 그 true가 호출부에서 "최신순" 헤더가 됐다.
   */
  it("isLatestFirst — 정렬을 실제로 관찰한 경우에만 true (빈 목록·단건·일자 미상은 근거가 아니다)", () => {
    // 점 표기와 8자리를 섞어도 비교한다
    expect(isLatestFirst(["2025.02.17", "20240710", "2024.02.29"])).toBe(true)
    // 같은 날짜가 이어지는 것도 내림차순이다
    expect(isLatestFirst(["20240101", "20240101"])).toBe(true)
    // 역순
    expect(isLatestFirst(["2004.03.08", "2021.06.29"])).toBe(false)
    // 종전 결함 ①: 빈 배열이 [].every로 true
    expect(isLatestFirst([])).toBe(false)
    // 종전 결함 ②: 일자를 하나도 못 읽어도 true
    expect(isLatestFirst(["", "", ""])).toBe(false)
    // 종전 결함 ③: 미상 항목을 건너뛰고 남은 것만 비교 — 그 항목의 위치는 확인되지 않았다
    expect(isLatestFirst(["2025.02.17", "", "2024.07.10"])).toBe(false)
    // 종전 결함 ④: 비교 쌍이 없는 1건이 "전체에서 가장 최신"의 증거로 쓰였다
    expect(isLatestFirst(["20250217"])).toBe(false)
    // 달력에 없는 일자는 정렬 확인 근거가 아니다 — 일자 태그를 잘못 읽었다는 뜻이다
    expect(isLatestFirst(["20251345", "20240101"])).toBe(false)
    expect(isLatestFirst(["20250229", "20240101"])).toBe(false) // 2025는 윤년이 아니다
    expect(isLatestFirst(["20240229", "20240101"])).toBe(true) // 2024는 윤년
  })

  /**
   * 본문은 정렬을 확인하지 못하면 "일자순 + 최신순 미보장"이라 적는다. 도구 설명이 단정형이면
   * LLM이 그 경고를 무시하고 언제나 최신이라 읽는다 — 설명과 본문이 같은 사실을 말해야 한다.
   */
  it("도구 설명은 최신순을 무조건 보장한다고 말하지 않는다", () => {
    const d = FIN_RULING_SEARCH_TOOL.description
    expect(d).not.toContain("최신순 통합 목록")
    expect(d).toContain("정렬을 확인한 도메인은 최신순")
    expect(d).toContain("일자순")
  })
})

/**
 * "검색 결과를 전부 받았다"(totalCnt ≤ 받은 건수) 우회는 종전에 **일자를 전혀 보지 않았다** —
 * 일자를 하나도 못 읽은 응답도 "최신순"으로 나갔다. 전부 받아도 일자를 못 읽은 항목은 로컬 정렬이
 * 끝으로 밀어낼 뿐 실제 위치를 모른다. 총건수 형태(누락·비숫자·항목보다 작은 값)도 함께 고정한다.
 */
describe("fin_ruling_search — 전부 받았다는 우회에도 일자 검증이 빠지지 않는다", () => {
  /** 받은 건수 < totalCnt인 실응답 형태 (totalCnt 42 / 3건 수신) */
  const partial = (rows: Array<[string, string]>, total = 42) => ntsSearchXml(total, rows)
  const DESC_3: Array<[string, string]> = [
    ["2025.02.17", "퇴직금 중간정산 최신"],
    ["2024.07.10", "퇴직금 중간정산 중간"],
    ["2023.09.15", "퇴직금 중간정산 과거"],
  ]
  const MIXED_3: Array<[string, string]> = [
    ["2004.03.08", "퇴직금 중간정산 가"],
    ["2021.06.29", "퇴직금 중간정산 나"],
    ["1999.09.14", "퇴직금 중간정산 다"],
  ]

  it("totalCnt 42 · 3건 수신이 내림차순이면 최신순 — 표시 건수와 총건수를 섞지 않는다", async () => {
    const r = await handleFinRulingSearch(xmlClient(partial(DESC_3)), { query: "퇴직금 중간정산", domains: ["nts"] })
    const text = r.content[0].text
    expect(text).toContain("최신순 3건")
    expect(text).toContain("검색 42건 중 최신 3건 표시")
    expect(text).not.toContain("검색 3건")
  })

  it("totalCnt 42 · 3건 수신이 뒤섞였으면 최신순이 아니고 목록 밖을 경고한다", async () => {
    const r = await handleFinRulingSearch(xmlClient(partial(MIXED_3)), { query: "퇴직금 중간정산", domains: ["nts"] })
    const text = r.content[0].text
    expect(text).toContain("일자순 3건")
    expect(text).toContain("법제처 응답 3건만 일자순 정렬 — 최신순 미보장(더 최신 자료가 목록 밖에 있을 수 있음)")
  })

  it("totalCnt가 숫자가 아니면 '전부 받았다'로 보지 않고 받은 건수 기준으로 말한다", async () => {
    const broken = partial(MIXED_3, 3).replace("<totalCnt>3</totalCnt>", "<totalCnt>알수없음</totalCnt>")
    const r = await handleFinRulingSearch(xmlClient(broken), { query: "퇴직금 중간정산", domains: ["nts"] })
    const text = r.content[0].text
    expect(text).toContain("받은 3건(검색 총건수 미확인 — 응답의 totalCnt를 읽지 못함)")
    expect(text).toContain("최신순 미보장")
    expect(text).not.toContain("검색 3건")
  })

  it("totalCnt가 받은 건수보다 작은 모순된 응답은 '전부 받았다'의 근거로 쓰지 않는다", async () => {
    // totalCnt 2 < 수신 3 — 두 수가 서로 어긋나므로 정렬 확인은 일자로만 한다 (뒤섞임 → 최신순 아님)
    const r = await handleFinRulingSearch(xmlClient(partial(MIXED_3, 2)), { query: "퇴직금 중간정산", domains: ["nts"] })
    const text = r.content[0].text
    expect(text).toContain("일자순 3건")
    expect(text).toContain("최신순 미보장(더 최신 자료가 목록 밖에 있을 수 있음)")
  })

  /**
   * 총건수 계약은 정렬 판정과 **별개**다 — 종전 `Math.max(totalCnt, 받은 건수)`는 정렬이 맞는
   * 응답에서도 "검색 3건"을 지어냈고, 위 모순 테스트는 정렬 문구만 봐서 그것을 놓쳤다(R1 감사).
   * 그래서 같은 모순을 **내림차순·뒤섞임 양쪽**에 넣고, 도메인 줄의 건수 표기까지 본다.
   */
  describe("총건수는 지어내지 않는다 — 모순·누락·비숫자 (받은 건수는 따로 보존)", () => {
    /** 해당 도메인 줄만 본다 — 헤더·꼬리말의 다른 숫자에 기대지 않는다 */
    const headline = (text: string): string => text.split("\n").find((l) => l.startsWith("■ ")) ?? ""
    const run = async (xml: string): Promise<string> =>
      headline((await handleFinRulingSearch(xmlClient(xml), { query: "퇴직금 중간정산", domains: ["nts"] })).content[0].text)

    it("모순(totalCnt 2 < 받은 3) — 내림차순이어도 '검색 3건'을 지어내지 않는다", async () => {
      const line = await run(partial(DESC_3, 2))
      // 정렬은 관찰됐으므로 최신순은 사실이다 — 총건수만 미확인이다 (두 사실을 섞지 않는다)
      expect(line).toContain("최신순 3건")
      expect(line).toContain("받은 3건(검색 총건수 미확인 — totalCnt 2건 < 받은 3건)")
      expect(line).not.toContain("검색 3건") // 종전: Math.max(2, 3) = 3
      expect(line).not.toContain("검색 2건") // 받은 3건을 2건으로 줄여 적지도 않는다
    })

    it("모순(totalCnt 2 < 받은 3) — 뒤섞였으면 일자순이고 총건수도 미확인이다", async () => {
      const line = await run(partial(MIXED_3, 2))
      expect(line).toContain("일자순 3건")
      expect(line).toContain("받은 3건(검색 총건수 미확인 — totalCnt 2건 < 받은 3건)")
      expect(line).toContain("최신순 미보장(더 최신 자료가 목록 밖에 있을 수 있음)")
      expect(line).not.toContain("검색 3건")
    })

    it("모순의 극단: totalCnt 0인데 3건을 받았다 — 0건이라 적지도, 3을 총건수로 삼지도 않는다", async () => {
      for (const rows of [DESC_3, MIXED_3]) {
        const line = await run(partial(rows, 0))
        expect(line).toContain("받은 3건(검색 총건수 미확인 — totalCnt 0건 < 받은 3건)")
        expect(line).not.toContain("검색 0건")
        expect(line).not.toContain("검색 3건")
        expect(line).not.toContain("— 0건") // 받은 3건이 있는데 0건 도메인으로 적지 않는다
      }
    })

    it("누락(totalCnt 태그 없음) — 내림차순·뒤섞임 양쪽 모두 사유까지 적는다", async () => {
      for (const rows of [DESC_3, MIXED_3]) {
        const line = await run(partial(rows).replace("<totalCnt>42</totalCnt>", ""))
        expect(line).toContain("받은 3건(검색 총건수 미확인 — 응답의 totalCnt를 읽지 못함)")
        expect(line).not.toContain("검색 3건")
        expect(line).not.toContain("검색 42건")
      }
    })

    it("비숫자(totalCnt 알수없음) — 내림차순에서도 받은 건수를 검색 총건수로 부르지 않는다", async () => {
      const line = await run(partial(DESC_3).replace("<totalCnt>42</totalCnt>", "<totalCnt>알수없음</totalCnt>"))
      expect(line).toContain("최신순 3건")
      expect(line).toContain("받은 3건(검색 총건수 미확인 — 응답의 totalCnt를 읽지 못함)")
      expect(line).not.toContain("검색 3건")
    })

    it("반대 방향: totalCnt가 받은 건수와 정확히 같으면 미확인 표기를 붙이지 않는다", async () => {
      for (const rows of [DESC_3, MIXED_3]) {
        const line = await run(partial(rows, 3))
        expect(line).toContain("최신순 3건") // 전부 받았고 일자를 전부 읽었다
        expect(line).not.toContain("검색 총건수 미확인")
        expect(line).not.toContain("최신순 미보장")
      }
    })

    it("반대 방향: totalCnt 42 · 받은 3건은 확인된 총건수라 그대로 적는다", async () => {
      for (const rows of [DESC_3, MIXED_3]) {
        const line = await run(partial(rows))
        expect(line).toContain("검색 42건 중")
        expect(line).not.toContain("검색 총건수 미확인")
      }
    })

    it("readTotalCnt — 숫자가 아니거나 안전 정수 범위를 넘으면 미확인(undefined)", () => {
      expect(readTotalCnt("<totalCnt>163</totalCnt>")).toBe(163)
      expect(readTotalCnt("<totalCnt> 163 </totalCnt>")).toBe(163)
      expect(readTotalCnt("<totalCnt>0</totalCnt>")).toBe(0)
      expect(readTotalCnt("<CgmExpc></CgmExpc>")).toBeUndefined()
      expect(readTotalCnt("<totalCnt>알수없음</totalCnt>")).toBeUndefined()
      expect(readTotalCnt("<totalCnt>-1</totalCnt>")).toBeUndefined()
      expect(readTotalCnt("<totalCnt>1e5</totalCnt>")).toBeUndefined()
      expect(readTotalCnt("<totalCnt>Infinity</totalCnt>")).toBeUndefined()
      // 안전 정수 경계 — 밖은 Number()가 조용히 다른 값으로 반올림한다
      expect(readTotalCnt("<totalCnt>9007199254740991</totalCnt>")).toBe(9007199254740991)
      expect(readTotalCnt("<totalCnt>9007199254740993</totalCnt>")).toBeUndefined()
      // 자릿수가 과하면 Number()에서 Infinity가 된다 — 총건수를 읽은 것이 아니다
      expect(readTotalCnt(`<totalCnt>${"9".repeat(400)}</totalCnt>`)).toBeUndefined()
    })

    it("totalCntNote — 확인됐으면 undefined, 아니면 사유를 그대로 돌려준다", () => {
      expect(totalCntNote(42, 3)).toBeUndefined()
      expect(totalCntNote(3, 3)).toBeUndefined()
      expect(totalCntNote(0, 0)).toBeUndefined()
      expect(totalCntNote(undefined, 3)).toBe("응답의 totalCnt를 읽지 못함")
      expect(totalCntNote(2, 3)).toBe("totalCnt 2건 < 받은 3건")
      expect(totalCntNote(0, 3)).toBe("totalCnt 0건 < 받은 3건")
    })
  })

  it("전부 받았어도 일자를 하나도 못 읽으면 최신순이라 쓰지 않는다 (종전 우회의 핵심)", async () => {
    const undated: Array<[string, string]> = [
      ["", "퇴직금 중간정산 가"],
      ["", "퇴직금 중간정산 나"],
      ["", "퇴직금 중간정산 다"],
    ]
    const r = await handleFinRulingSearch(xmlClient(partial(undated, 3)), { query: "퇴직금 중간정산", domains: ["nts"] })
    const text = r.content[0].text
    expect(text).toContain("일자순 3건")
    expect(text).toContain("일자 미상 3건이 있어 받은 순서를 확인하지 못했습니다")
    // 전부 받은 응답이다 — "목록 밖에 더 최신"은 이 경우 거짓이므로 붙이지 않는다
    expect(text).not.toContain("목록 밖에 있을 수 있음")
  })

  it("전부 받았어도 일부 일자가 비면 그 건수를 밝힌다", async () => {
    const someUndated: Array<[string, string]> = [
      ["2025.02.17", "퇴직금 중간정산 가"],
      ["", "퇴직금 중간정산 나"],
      ["2023.09.15", "퇴직금 중간정산 다"],
    ]
    const r = await handleFinRulingSearch(xmlClient(partial(someUndated, 3)), { query: "퇴직금 중간정산", domains: ["nts"] })
    expect(r.content[0].text).toContain("일자 미상 1건이 있어 받은 순서를 확인하지 못했습니다")
  })

  it("전부 받지 못한 응답에 일자 미상이 섞이면 두 사유를 모두 적는다", async () => {
    const someUndated: Array<[string, string]> = [
      ["2025.02.17", "퇴직금 중간정산 가"],
      ["", "퇴직금 중간정산 나"],
      ["2023.09.15", "퇴직금 중간정산 다"],
    ]
    const text = (
      await handleFinRulingSearch(xmlClient(partial(someUndated)), { query: "퇴직금 중간정산", domains: ["nts"] })
    ).content[0].text
    expect(text).toContain("일자 미상 1건이 있어 받은 순서를 확인하지 못했습니다 · 최신순 미보장(더 최신 자료가 목록 밖에 있을 수 있음)")
  })

  it("반대 방향: 전부 받았고 일자를 전부 읽었으면 받은 순서가 뒤섞여도 최신순이 사실이다", async () => {
    const r = await handleFinRulingSearch(xmlClient(partial(MIXED_3, 3)), { query: "퇴직금 중간정산", domains: ["nts"] })
    const text = r.content[0].text
    expect(text).toContain("최신순 3건")
    expect(text).not.toContain("최신순 미보장")
    // 로컬 정렬 결과가 곧 최신순 — 2021년 건이 첫 줄
    const lines = text.split("\n").filter((l) => l.startsWith("  · "))
    expect(lines[0]).toContain("(2021.06.29)")
  })

  it("기준일 대조를 못 한 일자 미상 자료는 목록에 남기되 그 사실을 적는다", async () => {
    const someUndated: Array<[string, string]> = [
      ["2009.03.17", "퇴직금 중간정산 가"],
      ["", "퇴직금 중간정산 나"],
      ["2025.02.17", "퇴직금 중간정산 다"],
    ]
    const r = await handleFinRulingSearch(xmlClient(partial(someUndated)), {
      query: "퇴직금 중간정산",
      domains: ["nts"],
      basis_date: "2015-01-01",
    })
    const text = r.content[0].text
    expect(text).toContain("일자 미상 1건은 기준일 대조를 못 해 그대로 남겼습니다")
    expect(text).toContain("기준일 이후 1건 제외")
    expect(text).toContain("퇴직금 중간정산 나") // 미상 자료는 버리지 않는다
    expect(text).not.toContain("퇴직금 중간정산 다") // 기준일 이후는 제외
  })

  it("반대 방향: 일자를 전부 읽은 기준일 조회에는 미상 고지가 붙지 않는다", async () => {
    const r = await handleFinRulingSearch(xmlClient(partial(DESC_3)), {
      query: "퇴직금 중간정산",
      domains: ["nts"],
      basis_date: "2024-01-01",
    })
    expect(r.content[0].text).not.toContain("기준일 대조를 못 해")
  })
})

describe("fin_ruling_search — 기준일 기간 검색의 반작용 (Codex 9차 L ④)", () => {
  it("기간 검색이 적용되면 0건은 '기준일 이전 범위에서' 0건으로 적고 사다리를 내려간다", async () => {
    const { client, tried } = tracingClient(() => EMPTY_PREC_XML)
    const r = await handleFinRulingSearch(client, {
      query: "임직원 경조사비 손금",
      domains: ["precedent"],
      basis_date: "2015-01-01",
    })
    expect(tried).toEqual(["임직원 경조사비 손금", "임직원 경조사비", "경조사비"])
    const text = r.content[0].text
    expect(text).toContain("기준일 이전 범위에서 정상 조회 결과 없음")
    expect(text).toContain("기준일 이후 자료는 기간 검색에서 제외됨")
  })

  it("법제처가 기간 파라미터를 무시해 최신 10건이 모두 기준일 이후면, 목록 밖에 과거 자료가 있을 수 있다고 밝힌다", async () => {
    // 스텁은 파라미터를 무시하고 2016~2025년 10건(totalCnt 163)을 준다
    const r = await handleFinRulingSearch(xmlClient(NTS_DDES_163), {
      query: "퇴직금 중간정산",
      domains: ["nts"],
      basis_date: "2015-01-01",
    })
    const text = r.content[0].text
    expect(text).toContain("검색된 10건이 모두 기준일 이후")
    expect(text).toContain("기준일 이전 자료는 이 목록 밖에 있을 수 있음")
    expect(text).not.toContain("정상 조회 결과 없음")
  })

  it("일부만 기준일 이후면 제외 건수와 함께 기간 검색 미적용을 고지한다", async () => {
    const r = await handleFinRulingSearch(xmlClient(NTS_DDES_163), {
      query: "퇴직금 중간정산",
      domains: ["nts"],
      basis_date: "2020-01-01",
    })
    const text = r.content[0].text
    expect(text).toContain("기준일 이후 6건 제외(법제처 기간 검색 미적용 응답")
    expect(text).toContain("(2018.05.24)")
    expect(text).not.toContain("(2021.06.29)")
  })
})

describe("fin_ruling_search — 축약 결과 무관 가능성 경고 (Codex 9차 M2)", () => {
  /** 제목 목록을 그대로 돌려주는 nts 응답 */
  const ntsHit = (titles: string[]) =>
    ntsSearchXml(titles.length, titles.map((t, i): [string, string] => [`2021.0${i + 1}.01`, t]))

  it("주체·쟁점어만 빠진 축약 결과에는 빠진 어절과 쟁점 경고를 붙이고 헤더에서도 밝힌다", async () => {
    // 라이브 재현 질의: 종전 2단계 "법인 대표이사"가 무관 5/5 — 이제 "대표이사 퇴직금"으로 간다
    const { client } = tracingClient((q) =>
      q === "대표이사 퇴직금"
        ? ntsHit(["대표이사 퇴직금 지급규정", "대표이사 퇴직금 한도"])
        : "<CgmExpc><totalCnt>0</totalCnt></CgmExpc>"
    )
    const r = await handleFinRulingSearch(client, {
      query: "법인 대표이사 퇴직금 한도 초과액 손금 불산입",
      domains: ["nts"],
    })
    const text = r.content[0].text
    expect(text).toContain("전체 성공 · ⚠ 축약 검색어 결과 포함")
    expect(text).toContain(`⚠ 검색어 축약으로 빠진 어절: "법인", "한도", "초과액", "손금", "불산입"`)
    expect(text).toContain("쟁점이 다른 자료가 섞일 수 있습니다")
  })

  it("빠진 주제어가 있으면 그 어절이 제목에 든 자료 수를 사실로 적는다", async () => {
    const { client } = tracingClient((q) =>
      q === "경조사비"
        ? ntsHit(["임직원 경조사비 손금산입 범위", "거래처 경조사비 접대비 해당 여부"])
        : "<CgmExpc><totalCnt>0</totalCnt></CgmExpc>"
    )
    const r = await handleFinRulingSearch(client, { query: "임직원 경조사비 복리후생비 손금", domains: ["nts"] })
    const text = r.content[0].text
    expect(text).toContain(`빠진 어절: "임직원", "복리후생비", "손금"`)
    expect(text).toContain("원 질문과 무관한 자료가 섞일 수 있습니다 (빠진 주제어가 제목에 있는 자료 1/2건)")
  })

  it("반대 방향: 원 검색어로 찾은 결과에는 경고도 헤더 표시도 붙지 않는다", async () => {
    const r = await handleFinRulingSearch(xmlClient(NTS_DDES_163), { query: "퇴직금 중간정산", domains: ["nts"] })
    const text = r.content[0].text
    expect(text).not.toContain("⚠ 검색어 축약")
    expect(text).not.toContain("축약 검색어 결과 포함")
  })

  it("반대 방향: 경고가 붙어도 결과는 그대로 나온다 (경고가 0건을 만들지 않는다)", async () => {
    const { client } = tracingClient((q) => (q === "경조사비" ? HIT_PREC_XML : EMPTY_PREC_XML))
    const r = await handleFinRulingSearch(client, { query: "임직원 경조사비 손금", domains: ["precedent"] })
    const text = r.content[0].text
    expect(text).toContain("경조사비 손금산입")
    expect(text).toContain("최신순 1건")
    expect(text).not.toContain("— 0건")
  })

  it("ladderWarning — 축약하지 않았거나 불용어만 빠졌으면 빈 문자열", () => {
    expect(ladderWarning("퇴직금 중간정산", "퇴직금 중간정산", ["x"])).toBe("")
    expect(ladderWarning("임직원 및 경조사비", "임직원 경조사비", ["x"])).toBe("")
  })
})

describe("buildLadder — 주제어 없는 단계 제거·주체 어절 건너뛰기 (Codex 9차 M2)", () => {
  it("7어절: 주체 '법인'을 건너뛰어 핵심 창이 '대표이사 퇴직금', 종착점이 '퇴직금'이 된다", () => {
    expect(buildLadder("법인 대표이사 퇴직금 한도 초과액 손금 불산입")).toEqual([
      "법인 대표이사 퇴직금 한도 초과액 손금 불산입",
      "대표이사 퇴직금 한도 초과액 손금",
      "대표이사 퇴직금",
      "퇴직금",
    ])
  })

  it("5어절: 가운데가 쟁점어뿐이면 그 단계를 건너뛰고 '한도'로 끝나지 않는다", () => {
    expect(buildLadder("퇴직금 한도 초과액 손금 불산입")).toEqual(["퇴직금 한도 초과액 손금 불산입", "퇴직금"])
  })

  it("4어절: 교대 축약이 쟁점어만 남기면 버리고 핵심 어절을 종착점으로 붙인다", () => {
    expect(buildLadder("퇴직금 손금 산입 요건")).toEqual(["퇴직금 손금 산입 요건", "퇴직금 손금 산입", "퇴직금"])
  })

  it("반대 방향: 주체 어절을 빼면 핵심이 1개뿐일 때는 주체를 창에 남긴다", () => {
    expect(buildLadder("법인 퇴직금 손금 산입 요건")).toEqual([
      "법인 퇴직금 손금 산입 요건",
      "퇴직금 손금 산입",
      "법인 퇴직금",
      "퇴직금",
    ])
  })

  it("반대 방향: 임원·직원처럼 쟁점인 주체는 건너뛰지 않는다 (종전 창 유지)", () => {
    expect(buildLadder("임직원 경조사비 복리후생비 손금 여부")).toEqual([
      "임직원 경조사비 복리후생비 손금 여부",
      "경조사비 복리후생비 손금",
      "임직원 경조사비",
      "경조사비",
    ])
    expect(buildLadder("퇴직급여 충당금 손금")).toEqual(["퇴직급여 충당금 손금", "퇴직급여 충당금", "충당금"])
  })

  it("반대 방향: 질의 전체가 쟁점어뿐이면 아무 단계도 버리지 않는다 (0건 위장 금지)", () => {
    expect(buildLadder("손금 산입 요건 여부 해당")).toEqual(["손금 산입 요건 여부 해당", "산입 요건 여부", "손금 산입", "산입"])
  })

  it("실측 성공 질의의 사다리 첫 단계·짧은 질의는 그대로다 — 경조사비·퇴직금 중간정산·대손충당금", () => {
    expect(buildLadder("경조사비")).toEqual(["경조사비"])
    expect(buildLadder("퇴직금 중간정산")).toEqual(["퇴직금 중간정산", "퇴직금", "중간정산"])
    expect(buildLadder("대손충당금 손금 산입 한도 계산")[0]).toBe("대손충당금 손금 산입 한도 계산")
  })
})

describe("fin_ruling_search — 공백 질의 (Codex 9차 M4)", () => {
  it("공백만 있는 query는 API를 부르지 않고 한글 INVALID_PARAMETER", async () => {
    for (const q of ["   ", "\t", " \n "]) {
      const { client, tried } = tracingClient(() => EMPTY_PREC_XML)
      const r = await handleFinRulingSearch(client, { query: q })
      expect(r.isError).toBe(true)
      expect(r.content[0].text).toContain("[INVALID_PARAMETER] fin_ruling_search:")
      expect(r.content[0].text).toContain("공백이 아닌 1자 이상")
      expect(r.content[0].text).not.toContain("전체 성공")
      expect(tried).toHaveLength(0)
    }
  })

  it("query 누락도 영어 zod 문구가 아니라 한글", async () => {
    const r = await handleFinRulingSearch(xmlClient(EMPTY_PREC_XML), {})
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain("query(쟁점 검색어)는 필수")
    expect(r.content[0].text).not.toMatch(/Invalid input|expected string/)
  })

  it("반대 방향: 앞뒤·중복 공백만 다른 질의는 정상 검색되고 '축약' 표기가 붙지 않는다", async () => {
    const { client, tried } = tracingClient(() => HIT_PREC_XML)
    const r = await handleFinRulingSearch(client, { query: " 경조사비  손금 ", domains: ["precedent"] })
    expect(r.isError).toBeUndefined()
    expect(tried).toEqual(["경조사비 손금"])
    expect(r.content[0].text).not.toContain("검색어 축약")
    expect(r.content[0].text).toContain("경조사비 손금산입")
  })
})
