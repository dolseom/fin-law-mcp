import { describe, it, expect, vi, beforeEach } from "vitest"

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }))
vi.mock("../lib/fetch-with-retry.js", () => ({ fetchWithRetry: fetchMock }))
vi.mock("../lib/external-https-proxy.js", () => ({
  getExternalHttpsProxyConfig: () => null,
  requestExternalHttps: vi.fn(),
}))

import { parseNtstDcmId, getNtsDecisionBody } from "./nts-body.js"

// 자체 패치 #1 — id 입력 해석 규칙 (docs/SELF-PATCHES.md)
describe("parseNtstDcmId", () => {
  it("taxlaw 상세 링크에서 ntstDcmId를 추출한다", () => {
    expect(
      parseNtstDcmId("https://taxlaw.nts.go.kr/qt/USEQTA002P.do?ntstDcmId=010000000000515153")
    ).toBe("010000000000515153")
  })

  it("다른 쿼리 파라미터가 섞인 링크에서도 추출한다", () => {
    expect(
      parseNtstDcmId("https://taxlaw.nts.go.kr/qt/USEQTA002P.do?foo=1&ntstDcmId=010000000000515153&bar=2")
    ).toBe("010000000000515153")
  })

  it("ntstDcmId 원시값(12자리 이상 숫자)을 그대로 통과시킨다", () => {
    expect(parseNtstDcmId("010000000000515153")).toBe("010000000000515153")
    expect(parseNtstDcmId("  010000000000515153  ")).toBe("010000000000515153")
  })

  it("법제처 일련번호(짧은 숫자)는 null — 자동 변환 불가", () => {
    expect(parseNtstDcmId("515153")).toBeNull()
    expect(parseNtstDcmId("1234567")).toBeNull()
  })

  it("숫자가 아닌 입력은 null", () => {
    expect(parseNtstDcmId("법인세과-352")).toBeNull()
    expect(parseNtstDcmId("")).toBeNull()
  })

  it("taxlaw가 아닌 호스트의 URL은 거부한다 (Codex 권고)", () => {
    expect(parseNtstDcmId("https://evil.example/?ntstDcmId=010000000000515153")).toBeNull()
  })

  it("쿼리값이 전체 숫자가 아니면 거부한다 (Codex 권고)", () => {
    expect(parseNtstDcmId("https://taxlaw.nts.go.kr/qt/USEQTA002P.do?ntstDcmId=12345678901a")).toBeNull()
  })
})

// ---- 장애·응답구조 경로 (fetch 모킹, Codex 권고) ----

function mockResponse(payload: unknown, ok = true, status = 200) {
  fetchMock.mockResolvedValueOnce({
    ok, status,
    text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
  })
}

const GOOD_ID = "010000000000515153"
const LONG_TEXT = "중간정산일 현재 1년 이상 주택을 소유하지 아니한 세대의 세대주인 임원 관련 회신 본문입니다."

describe("getNtsDecisionBody 장애·응답구조 경로", () => {
  beforeEach(() => { fetchMock.mockReset() })

  it("정상 응답이면 제목·본문을 출력하고 isError가 아니다", async () => {
    mockResponse({ data: { ASIQTB002PR01: { dcmDVO: {
      ntstDcmTtl: "무주택 임원 퇴직금 중간정산 가능 여부",
      ntstDcmDscmCntn: "법인세과-352", ntstDcmRgtDt: "20130716",
      ntstDcmCntn: `<p>${LONG_TEXT}</p>`,
    } } } })
    const r = await getNtsDecisionBody(null as any, { id: GOOD_ID })
    expect(r.isError).toBeFalsy()
    expect(r.content[0].text).toContain("무주택 임원")
    expect(r.content[0].text).toContain("법인세과-352")
    expect(r.content[0].text).toContain("주택을 소유하지 아니한")
  })

  it("dcmDVO 누락이면 [FETCH_FAILED] + isError", async () => {
    mockResponse({ data: { ASIQTB002PR01: {} } })
    const r = await getNtsDecisionBody(null as any, { id: GOOD_ID })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain("[FETCH_FAILED]")
  })

  it("dcmDVO가 객체가 아니면(문자열) [FETCH_FAILED]", async () => {
    mockResponse({ data: { ASIQTB002PR01: { dcmDVO: "invalid" } } })
    const r = await getNtsDecisionBody(null as any, { id: GOOD_ID })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain("[FETCH_FAILED]")
  })

  it("본문 없이 요지만 있으면 요지 출력 + '본문 데이터 없음' + isError", async () => {
    mockResponse({ data: { ASIQTB002PR01: { dcmDVO: {
      ntstDcmTtl: "제목", ntstDcmGistCntn: LONG_TEXT,
    } } } })
    const r = await getNtsDecisionBody(null as any, { id: GOOD_ID })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain("요지:")
    expect(r.content[0].text).toContain("본문 데이터 없음")
  })

  it("HTTP 오류면 [FETCH_FAILED] + 원문 링크 안내", async () => {
    mockResponse("Service Unavailable", false, 503)
    const r = await getNtsDecisionBody(null as any, { id: GOOD_ID })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain("[FETCH_FAILED]")
    expect(r.content[0].text).toContain(`ntstDcmId=${GOOD_ID}`)
  })

  it("JSON 파싱 실패면 [FETCH_FAILED]", async () => {
    mockResponse("<html>점검 중</html>")
    const r = await getNtsDecisionBody(null as any, { id: GOOD_ID })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain("[FETCH_FAILED]")
  })

  it("메타데이터가 객체(malformed)면 [object Object] 대신 N/A", async () => {
    mockResponse({ data: { ASIQTB002PR01: { dcmDVO: {
      ntstDcmTtl: "제목", ntstDcmDscmCntn: { weird: true }, ntstDcmCntn: `<p>${LONG_TEXT}</p>`,
    } } } })
    const r = await getNtsDecisionBody(null as any, { id: GOOD_ID })
    expect(r.content[0].text).not.toContain("[object Object]")
    expect(r.content[0].text).toContain("문서번호: N/A")
  })
})
