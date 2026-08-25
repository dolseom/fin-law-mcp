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
