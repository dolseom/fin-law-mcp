/**
 * fin_law_search 기준일 검색 회귀 테스트 (fixture 기반 — CI 상시)
 *
 * 핵심 계약: 기준일 검색은 eflaw + efYd **범위** 문법으로만 동작한다.
 * 단일 efYd는 법제처가 조용히 무시하고 현행 결과를 주므로, 헤더에는 기준일이
 * 찍히는데 내용은 현행인 "조용한 거짓"이 된다 (실측 2026-08-25).
 */

import { describe, it, expect } from "vitest"
import { handleFinLawSearch } from "./law-search.js"
import type { LawApiClient } from "../lib/api-client.js"

const MULTI_VERSION_XML = `<?xml version="1.0" encoding="UTF-8"?>
<LawSearch><totalCnt>4</totalCnt>
  <law id="1"><법령명한글>법인세법</법령명한글><법령일련번호>212775</법령일련번호><법령ID>1</법령ID>
    <법령구분명>법률</법령구분명><소관부처명>기획재정부</소관부처명><소관부처코드>1051000</소관부처코드>
    <시행일자>20200101</시행일자><제개정구분명>일부개정</제개정구분명><현행연혁코드>연혁</현행연혁코드></law>
  <law id="2"><법령명한글>법인세법</법령명한글><법령일련번호>165308</법령일련번호><법령ID>1</법령ID>
    <법령구분명>법률</법령구분명><소관부처명>기획재정부</소관부처명><소관부처코드>1051000</소관부처코드>
    <시행일자>20150701</시행일자><제개정구분명>일부개정</제개정구분명><현행연혁코드>연혁</현행연혁코드></law>
  <law id="3"><법령명한글>법인세법</법령명한글><법령일련번호>140000</법령일련번호><법령ID>1</법령ID>
    <법령구분명>법률</법령구분명><소관부처명>기획재정부</소관부처명><소관부처코드>1051000</소관부처코드>
    <시행일자>20120101</시행일자><제개정구분명>일부개정</제개정구분명><현행연혁코드>연혁</현행연혁코드></law>
  <law id="4"><법령명한글>법인세법 시행령</법령명한글><법령일련번호>172604</법령일련번호><법령ID>2</법령ID>
    <법령구분명>대통령령</법령구분명><소관부처명>기획재정부</소관부처명><소관부처코드>1051000</소관부처코드>
    <시행일자>20150701</시행일자><제개정구분명>일부개정</제개정구분명><현행연혁코드>연혁</현행연혁코드></law>
</LawSearch>`

function stub(xml: string, capture?: (p: Record<string, string>) => void): LawApiClient {
  return {
    fetchApi: async (p: { extraParams?: Record<string, string> }) => {
      capture?.(p.extraParams ?? {})
      return xml
    },
    searchLaw: async () => xml,
  } as unknown as LawApiClient
}

describe("fin_law_search — 기준일 검색", () => {
  it("범위 문법(from~to)으로 조회한다 — 단일 efYd는 법제처가 무시하므로", async () => {
    let seen: Record<string, string> = {}
    await handleFinLawSearch(stub(MULTI_VERSION_XML, (p) => (seen = p)), {
      query: "법인세법",
      basis_date: "2015-07-01",
    })
    expect(seen.efYd).toBe("19000101~20150701")
  })

  it("법령별로 기준일 시점 1건만 남긴다 (여러 개정본 나열 금지)", async () => {
    const r = await handleFinLawSearch(stub(MULTI_VERSION_XML), { query: "법인세법", basis_date: "2015-07-01" })
    const text = r.content[0].text
    // 20150701본은 남고, 기준일 이후인 20200101본은 빠진다
    expect(text).toContain("165308")
    expect(text).not.toContain("212775")
    // 기준일 이전 구본(20120101)도 최신 하나로 접힌다
    expect(text).not.toContain("140000")
  })

  it("헤더에 기준일을 명시한다", async () => {
    const r = await handleFinLawSearch(stub(MULTI_VERSION_XML), { query: "법인세법", basis_date: "2015-07-01" })
    expect(r.content[0].text).toContain("[기준일: 2015-07-01 시행 기준]")
  })

  it("기준일 모드에서는 연혁 경고를 붙이지 않는다 (과거본이 정상 결과)", async () => {
    const r = await handleFinLawSearch(stub(MULTI_VERSION_XML), { query: "법인세법", basis_date: "2015-07-01" })
    expect(r.content[0].text).not.toContain("⚠연혁")
  })

  it("기준일 이전 시행본이 없으면 사유를 붙여 0건으로 보고한다", async () => {
    const r = await handleFinLawSearch(stub(MULTI_VERSION_XML), { query: "법인세법", basis_date: "1900-01-01" })
    const text = r.content[0].text
    expect(text).toContain("[LAW_NOT_FOUND]")
    expect(text).toContain("시행 중이던 법령 없음")
  })

  it("기준일이 없으면 현행 검색 경로를 쓴다 (회귀 없음)", async () => {
    let called = false
    const client = {
      fetchApi: async () => {
        called = true
        return MULTI_VERSION_XML
      },
      searchLaw: async () => MULTI_VERSION_XML,
    } as unknown as LawApiClient
    const r = await handleFinLawSearch(client, { query: "법인세법" })
    expect(called).toBe(false) // 범위 검색 경로를 타지 않는다
    expect(r.content[0].text).toContain("[기준: 현행]")
  })

  it("잘못된 기준일 형식은 INVALID_PARAMETER", async () => {
    const r = await handleFinLawSearch(stub(MULTI_VERSION_XML), { query: "법인세법", basis_date: "2015/07/01" })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain("INVALID_PARAMETER")
  })
})

/**
 * 잔여② 회귀 — 법령 DB의 노이즈 1건이 행정규칙 폴백을 꺼뜨리던 결함.
 * 법제처는 LIKE 검색이라 「조사사무처리규정」(국세청 훈령) 질의에
 * 「…가족관계등록사무처리규칙」 1건이 걸린다. "0건일 때만 폴백"이면
 * 그 1건 때문에 실존하는 훈령이 통째로 사라지고 무관한 법령만 답이 된다 (실측).
 */
const NOISE_LAW_XML = `<?xml version="1.0" encoding="UTF-8"?>
<LawSearch><totalCnt>1</totalCnt>
  <law id="1"><법령명한글>대일항쟁기 강제동원 피해조사 및 국외강제동원 희생자 등 지원에 관한 특별법에 의한 가족관계등록사무처리규칙</법령명한글>
    <법령일련번호>105590</법령일련번호><법령ID>9</법령ID><법령구분명>대법원규칙</법령구분명>
    <소관부처명>대법원</소관부처명><소관부처코드>1000000</소관부처코드>
    <시행일자>20100603</시행일자><제개정구분명>일부개정</제개정구분명><현행연혁코드>현행</현행연혁코드></law>
</LawSearch>`

const EXACT_RULE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<LawSearch><totalCnt>1</totalCnt>
  <law id="1"><법령명한글>산업안전보건기준에 관한 규칙</법령명한글>
    <법령일련번호>273603</법령일련번호><법령ID>7</법령ID><법령구분명>고용노동부령</법령구분명>
    <소관부처명>고용노동부</소관부처명><소관부처코드>1492000</소관부처코드>
    <시행일자>20260302</시행일자><제개정구분명>일부개정</제개정구분명><현행연혁코드>현행</현행연혁코드></law>
</LawSearch>`

const ADMRUL_HIT_XML =
  '<?xml version="1.0"?><AdmRulSearch><totalCnt>1</totalCnt><admrul>' +
  "<행정규칙명>조사사무처리규정</행정규칙명><행정규칙종류>훈령</행정규칙종류>" +
  "<소관부처명>국세청</소관부처명><발령일자>20260420</발령일자></admrul></AdmRulSearch>"

const ADMRUL_EMPTY_XML = '<?xml version="1.0"?><AdmRulSearch><totalCnt>0</totalCnt></AdmRulSearch>'

function stubWithAdmin(lawXml: string, admrulXml: string, onAdmin?: (q: string) => void): LawApiClient {
  return {
    fetchApi: async () => lawXml,
    searchLaw: async () => lawXml,
    searchAdminRule: async (p: { query: string }) => {
      onAdmin?.(p.query)
      return admrulXml
    },
  } as unknown as LawApiClient
}

describe("fin_law_search — 행정규칙 병행 조회 (잔여②)", () => {
  it("법령 DB에 무관한 1건이 잡혀도 행정규칙 실존을 알린다", async () => {
    const r = await handleFinLawSearch(stubWithAdmin(NOISE_LAW_XML, ADMRUL_HIT_XML), {
      query: "조사사무처리규정",
    })
    const text = r.content[0].text
    expect(text).toContain("[행정규칙]")
    expect(text).toContain("조사사무처리규정")
    expect(text).toContain("훈령")
    expect(text).toContain("국세청")
    // 법령 결과는 남기되 근거로 쓰지 말라고 분리 고지한다
    expect(text).toContain("다른 법령")
    expect(text).toContain("가족관계등록사무처리규칙")
  })

  it("행정규칙 조회에 원본 질의를 쓴다 — 정제된 검색어로는 못 찾는다", async () => {
    const seen: string[] = []
    await handleFinLawSearch(stubWithAdmin(NOISE_LAW_XML, ADMRUL_HIT_XML, (q) => seen.push(q)), {
      query: "조사사무처리규정",
    })
    // stripNonLawKeywords가 "조사사무 규정"으로 쪼개므로 원본이 후보에 있어야 한다
    expect(seen[0]).toBe("조사사무처리규정")
  })

  it("정확히 일치하는 법령이 있으면 행정규칙 DB를 조회하지 않는다 (부령 「…규칙」 오배너 방지)", async () => {
    let adminCalled = false
    const r = await handleFinLawSearch(
      stubWithAdmin(EXACT_RULE_XML, ADMRUL_HIT_XML, () => (adminCalled = true)),
      { query: "산업안전보건기준에 관한 규칙" }
    )
    expect(adminCalled).toBe(false)
    expect(r.content[0].text).not.toContain("[행정규칙]")
  })

  it("법령 0건 + 행정규칙 0건이면 기존 ✗없음 판정을 유지한다", async () => {
    const EMPTY = '<?xml version="1.0"?><LawSearch><totalCnt>0</totalCnt></LawSearch>'
    const r = await handleFinLawSearch(stubWithAdmin(EMPTY, ADMRUL_EMPTY_XML), { query: "외국환거래규정" })
    const text = r.content[0].text
    expect(text).toContain("[LAW_NOT_FOUND]")
    expect(text).toContain("행정규칙 DB에도 0건")
  })
})

describe("fin_law_search — 행정규칙 확인 실패 고지", () => {
  it("행정규칙 DB 장애를 '없음'으로 감추지 않는다", async () => {
    const client = {
      fetchApi: async () => NOISE_LAW_XML,
      searchLaw: async () => NOISE_LAW_XML,
      searchAdminRule: async () => {
        throw new Error("법제처 API가 HTML 오류 페이지를 반환했습니다")
      },
    } as unknown as LawApiClient
    const r = await handleFinLawSearch(client, { query: "조사사무처리규정" })
    const text = r.content[0].text
    expect(text).toContain("확인에 실패")
    expect(text).toContain('"없음"으로 단정하지 마세요')
  })
})
