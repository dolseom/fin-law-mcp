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
    // 조문 미제공 사유를 제공처 탓으로 돌리지 않는다 — 법제처는 조문형식여부=Y 규칙의
    // 조문 본문을 주고 fin_verify가 그것으로 조문까지 대조한다 (CHANGELOG 2026-09-01 정정)
    expect(text).toContain("이 도구는 행정규칙 조문 본문을 싣지 않습니다")
    expect(text).not.toContain("조문 단위 조회 미지원")
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

/**
 * Fable 최종 검토 F3(a) 회귀 — 기준일 검색은 eflaw display=100 **한 페이지**다.
 * 종전에는 그 페이지 안에서 법령별 최대 시행일을 "그 시점 시행본"으로 확정해, 총 150건 중
 * 페이지 밖에 있는 기준일 이하 최신본(2015-07-01)을 모른 채 구본(2012-01-01)을 답했다.
 * resolveVersionAt(cac5c41)과 같은 전제: 전부 받았음을 입증할 때만 확정한다.
 */
function basisRow(name: string, mst: string, efYd: string): string {
  return (
    `<law id="${mst}"><법령명한글>${name}</법령명한글><법령일련번호>${mst}</법령일련번호><법령ID>1</법령ID>` +
    `<법령구분명>법률</법령구분명><소관부처명>기획재정부</소관부처명><소관부처코드>1051000</소관부처코드>` +
    `<시행일자>${efYd}</시행일자><제개정구분명>일부개정</제개정구분명><현행연혁코드>연혁</현행연혁코드></law>`
  )
}

// 전 구간(19000101~기준일) 1페이지: 총 150건 중 100건 — 법인세법은 2012-01-01본만, 시행령은 2014-01-01본만 들어 있다
const FULL_PAGE_XML =
  `<LawSearch><totalCnt>150</totalCnt>` +
  basisRow("법인세법", "140000", "20120101") +
  basisRow("법인세법 시행령", "150000", "20140101") +
  Array.from({ length: 98 }, (_, i) => basisRow("법인세법 시행규칙", String(200000 + i), `${1950 + (i % 60)}0101`)).join("") +
  `</LawSearch>`

// resolveVersionAt의 좁은 구간(전년 1월 1일~기준일): 목록 밖이던 2015-07-01본이 여기 있다
const NARROW_XML =
  `<LawSearch><totalCnt>2</totalCnt>` +
  basisRow("법인세법", "165308", "20150701") +
  basisRow("법인세법 시행령", "172604", "20150701") +
  `</LawSearch>`

function pagedStub(
  onNarrow: () => Promise<string> | string,
  calls: Array<Record<string, string>> = []
): LawApiClient {
  return {
    fetchApi: async (p: { extraParams?: Record<string, string> }) => {
      const ep = p.extraParams ?? {}
      calls.push(ep)
      if (ep.efYd?.startsWith("19000101~")) return FULL_PAGE_XML
      return onNarrow()
    },
    searchLaw: async () => FULL_PAGE_XML,
  } as unknown as LawApiClient
}

describe("fin_law_search — 기준일 검색이 한 페이지를 넘을 때 (F3)", () => {
  it("정확 일치 법령은 resolveVersionAt으로 다시 확정한다 — 페이지 밖 최신본(2015-07-01)을 답한다", async () => {
    const calls: Array<Record<string, string>> = []
    const r = await handleFinLawSearch(pagedStub(() => NARROW_XML, calls), { query: "법인세법", basis_date: "2015-07-01" })
    const text = r.content[0].text
    const line = text.split("\n").find((l) => l.startsWith("  · 법인세법 [")) ?? ""
    expect(line).toContain("MST 165308")
    expect(line).toContain("시행 20150701")
    expect(line).not.toContain("⚠시행본 미확정")
    expect(text).not.toContain("MST 140000")
    expect(text).toContain("받은 목록 안의 최대 시행일 20120101이 아니라 20150701 시행본")
    // 추가 호출은 좁은 구간 1회뿐 (분당 30회 한도 보호)
    expect(calls).toHaveLength(2)
    expect(calls[1].efYd).toBe("20140101~20150701")
  })

  it("재확인하지 않은 다른 법령 줄에는 '⚠시행본 미확정'을 붙이고 헤더·주석에 받은 범위를 적는다", async () => {
    const r = await handleFinLawSearch(pagedStub(() => NARROW_XML), { query: "법인세법", basis_date: "2015-07-01" })
    const text = r.content[0].text
    const decree = text.split("\n").find((l) => l.startsWith("  · 법인세법 시행령")) ?? ""
    expect(decree).toContain("MST 150000")
    expect(decree).toContain("⚠시행본 미확정")
    expect(text).toContain("검색 결과 전체 150건 중 받은 100건에서 추린 시행본")
    expect(text).toContain("목록 밖에 기준일 이하의 더 늦은 시행본이 있을 수 있습니다")
  })

  it("재확정에 실패하면 정확 일치 법령도 미확정으로 표시하고 사유를 적는다 (구본을 확정처럼 말하지 않음)", async () => {
    const r = await handleFinLawSearch(
      pagedStub(() => {
        throw new Error("법령 검색 실패 (HTTP 500)")
      }),
      { query: "법인세법", basis_date: "2015-07-01" }
    )
    const text = r.content[0].text
    const line = text.split("\n").find((l) => l.startsWith("  · 법인세법 [")) ?? ""
    expect(line).toContain("⚠시행본 미확정")
    expect(text).toContain("「법인세법」의 기준일 시행본을 확정하지 못했습니다")
    expect(text).toContain("HTTP 500")
    expect(r.isError).toBeUndefined() // 목록 자체는 정상 조회 — 첫 줄 판정은 경고로
  })

  it("호출자가 취소하면 재확인을 기다리지 않고 미확정으로 돌린다", async () => {
    const ac = new AbortController()
    const p = handleFinLawSearch(
      pagedStub(() => new Promise<string>(() => {})), // 응답 없는 좁은 구간 조회
      { query: "법인세법", basis_date: "2015-07-01" },
      { signal: ac.signal }
    )
    setTimeout(() => ac.abort(), 20)
    const text = (await p).content[0].text
    expect(text).toContain("호출자 취소")
    expect(text).toContain("⚠시행본 미확정")
  })

  it("페이지가 검색 결과 전부면(totalCnt = 받은 건수) 추가 호출 없이 종전대로 확정한다", async () => {
    let n = 0
    const r = await handleFinLawSearch(
      stub(MULTI_VERSION_XML, () => n++),
      { query: "법인세법", basis_date: "2015-07-01" }
    )
    expect(n).toBe(1)
    expect(r.content[0].text).not.toContain("⚠시행본 미확정")
    expect(r.content[0].text).toContain("해당 시점 시행본 2건 중")
  })
})

describe("fin_law_search — 총건수를 지어내지 않는다 (최종 검토 참고 2)", () => {
  it("현행 검색 응답에 totalCnt가 없으면 '전체 0건'이 아니라 받은 건수와 미확인 사유를 적는다", async () => {
    const noTotal = MULTI_VERSION_XML.replace("<totalCnt>4</totalCnt>", "")
    const r = await handleFinLawSearch(stub(noTotal), { query: "법인세법" })
    const text = r.content[0].text
    expect(text).not.toContain("전체 0건")
    expect(text).toContain("받은 4건(검색 총건수 미확인 — 응답의 totalCnt를 읽지 못함)")
  })

  it("현행 검색 총건수가 받은 50건보다 많으면 받은 범위 안에서 정렬했음을 적는다", async () => {
    const many =
      `<LawSearch><totalCnt>569</totalCnt>` +
      Array.from({ length: 50 }, (_, i) => basisRow("법인세법", String(300000 + i), "20240101")).join("") +
      `</LawSearch>`
    const r = await handleFinLawSearch(stub(many), { query: "법인세법" })
    expect(r.content[0].text).toContain("[기준: 현행] 법령 검색 — 전체 569건 중 받은 50건을 재무 관련도순으로 정렬한 상위 10건")
  })

  it("총건수가 확인되고 전부 받았으면 종전 표기를 유지한다", async () => {
    const r = await handleFinLawSearch(stub(MULTI_VERSION_XML), { query: "법인세법" })
    expect(r.content[0].text).toContain("[기준: 현행] 법령 검색 — 전체 4건 중 재무 관련도순 상위")
  })
})
