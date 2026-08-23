/**
 * 방어 로직 fixture 계약 테스트 — 실 API 없이 CI 상시 실행
 *
 * 계약 구조(2계층): fetch-with-retry는 불량 본문(HTML·빈 응답)을 재시도하고,
 * 재시도 소진 시 응답을 통과시킨다 → 최종 검출은 api-client(checkHtmlError 등)가 한다.
 * 이 테스트는 그 통합 경로가 오류를 "정상"으로 위장하지 않는지 검증한다.
 *
 * 근거 사고: 200+HTML 장애 페이지 정상 파싱, <HTML> 대문자 통과, 간헐 404
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import { fetchWithRetry, maskSensitiveUrl } from "../src/lib/fetch-with-retry.js"
import { LawApiClient } from "../src/lib/api-client.js"

const LAW_URL = "https://www.law.go.kr/DRF/lawSearch.do?OC=secret123&target=law"

function stubFetchSequence(bodies: Array<{ status?: number; body: string }>) {
  let call = 0
  const mock = vi.fn(async () => {
    const item = bodies[Math.min(call, bodies.length - 1)]
    call++
    return new Response(item.body, { status: item.status ?? 200, headers: { "content-type": "text/html" } })
  })
  vi.stubGlobal("fetch", mock)
  return mock
}

afterEach(() => vi.unstubAllGlobals())

const client = () => new LawApiClient({ apiKey: "testkey" })

describe("fetch-with-retry 계층 (재시도 동작)", () => {
  it("200 + HTML 장애 페이지는 재시도를 소진한다 (조용한 1회 통과 금지)", async () => {
    const mock = stubFetchSequence([{ body: "<!DOCTYPE html><html>점검 중</html>" }])
    await fetchWithRetry(LAW_URL, { retries: 2, retryDelay: 1 })
    expect(mock).toHaveBeenCalledTimes(3) // 1 + 재시도 2 — 소진 후엔 상위 계층이 검출
  })

  it("장애가 회복되면 재시도 중에 정상 응답을 얻는다", async () => {
    const mock = stubFetchSequence([
      { body: "<html>점검</html>" },
      { body: '<?xml version="1.0"?><LawSearch><totalCnt>1</totalCnt></LawSearch>' },
    ])
    const res = await fetchWithRetry(LAW_URL, { retries: 2, retryDelay: 1 })
    expect(await res.text()).toContain("totalCnt")
    expect(mock).toHaveBeenCalledTimes(2)
  })

  it("간헐 404는 재시도 후 회복된다 (DRF 특성 — retryOn에 404 포함)", async () => {
    const mock = stubFetchSequence([
      { status: 404, body: "not found" },
      { status: 404, body: "not found" },
      { body: '<?xml version="1.0"?><LawSearch><totalCnt>1</totalCnt></LawSearch>' },
    ])
    const res = await fetchWithRetry(LAW_URL, { retries: 3, retryDelay: 1, retryOn: [404, 429, 503, 504] })
    expect(res.ok).toBe(true)
    expect(mock).toHaveBeenCalledTimes(3)
  })

  it("allowHtmlBody=true면 HTML이 정상인 엔드포인트를 재시도로 증폭시키지 않는다", async () => {
    const mock = stubFetchSequence([{ body: "<html><body>연혁 목록</body></html>" }])
    const res = await fetchWithRetry(LAW_URL, { retries: 2, retryDelay: 1, allowHtmlBody: true })
    expect(res.ok).toBe(true)
    expect(mock).toHaveBeenCalledTimes(1)
  })
})

// 불량 본문은 fetch 계층에서 지수 백오프 재시도(약 7초)를 소진한 뒤 api-client가
// 최종 검출한다 — 타임아웃은 그 실제 비용을 반영한 값
describe("api-client 계층 (최종 검출 — 오류의 정상 위장 금지)", () => {
  it("재시도 소진 후에도 HTML 장애 페이지면 명확한 오류를 던진다", { timeout: 20_000 }, async () => {
    stubFetchSequence([{ body: "<!DOCTYPE html><html>점검 중</html>" }])
    await expect(
      client().fetchApi({ endpoint: "lawSearch.do", target: "law", type: "XML", extraParams: { query: "x" } })
    ).rejects.toThrow()
  })

  it("대문자 <HTML>도 장애 페이지로 검출한다 (실사고 회귀)", { timeout: 20_000 }, async () => {
    stubFetchSequence([{ body: "<HTML><BODY>ERROR</BODY></HTML>" }])
    await expect(
      client().fetchApi({ endpoint: "lawSearch.do", target: "law", type: "XML", extraParams: { query: "x" } })
    ).rejects.toThrow()
  })

  it("200 + 빈 본문이면 searchLaw가 파서 전에 오류로 전환한다", { timeout: 20_000 }, async () => {
    stubFetchSequence([{ body: "   " }])
    await expect(client().searchLaw("법인세법")).rejects.toThrow()
  })
})

describe("maskSensitiveUrl (키 노출 방지)", () => {
  it("OC·apikey류 쿼리 값만 마스킹한다", () => {
    expect(maskSensitiveUrl("https://x/y?OC=abc&target=law")).toBe("https://x/y?OC=***&target=law")
    expect(maskSensitiveUrl("https://x/y?apiKey=k&q=1")).toBe("https://x/y?apiKey=***&q=1")
  })
})
