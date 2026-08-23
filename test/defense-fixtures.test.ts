/**
 * 방어 로직 fixture 계약 테스트 — 실 API 없이 CI 상시 실행
 *
 * 계약 구조(2계층): fetch-with-retry는 불량 본문(HTML·빈 응답)을 재시도하고,
 * 재시도 소진 시 **오류를 throw한다** (통과시키면 JSON 경로에서 0건 위장 —
 * Opus 리뷰 B1-2로 수정). api-client는 루트 검증(assertXmlRoot) 등 2차 검출을 맡는다.
 *
 * 근거 사고: 200+HTML 장애 페이지 정상 파싱, <HTML> 대문자 통과, 오류 XML 0건 위장, 간헐 404
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
  it("200 + HTML 장애 페이지는 재시도 소진 후 오류를 던진다 (통과 금지 — B1-2)", async () => {
    const mock = stubFetchSequence([{ body: "<!DOCTYPE html><html>점검 중</html>" }])
    await expect(fetchWithRetry(LAW_URL, { retries: 2, retryDelay: 1 })).rejects.toThrow(/HTML 페이지/)
    expect(mock).toHaveBeenCalledTimes(3) // 1 + 재시도 2
  })

  it("200 + 빈 본문도 재시도 소진 후 오류를 던진다", async () => {
    stubFetchSequence([{ body: "   " }])
    await expect(fetchWithRetry(LAW_URL, { retries: 1, retryDelay: 1 })).rejects.toThrow(/빈 본문/)
  })

  it("불량 본문 오류 메시지에서 API 키가 마스킹된다", async () => {
    stubFetchSequence([{ body: "" }])
    try {
      await fetchWithRetry(LAW_URL, { retries: 0, retryDelay: 1 })
      expect.unreachable("오류가 발생해야 함")
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      expect(msg).not.toContain("secret123")
      expect(msg).toContain("OC=***")
    }
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

describe("오류 XML의 0건 위장 방지 (루트 검증 — Codex 리뷰 차단 1)", () => {
  it("정상 형식의 오류 XML(예상 밖 루트)이면 searchLaw가 0건 대신 오류를 던진다", async () => {
    stubFetchSequence([{ body: '<?xml version="1.0"?><Message>사용자 정보 검증에 실패하였습니다</Message>' }])
    await expect(client().searchLaw("법인세법")).rejects.toThrow(/예상 밖 응답/)
  })

  it("fetchApi expectedRoot 불일치도 오류로 던진다", async () => {
    stubFetchSequence([{ body: '<?xml version="1.0"?><Error><msg>차단</msg></Error>' }])
    await expect(
      client().fetchApi({
        endpoint: "lawSearch.do",
        target: "ntsCgmExpc",
        type: "XML",
        extraParams: { query: "x" },
        expectedRoot: "CgmExpc",
      })
    ).rejects.toThrow(/예상 밖 응답/)
  })

  it("정상 루트는 통과한다", async () => {
    stubFetchSequence([{ body: '<?xml version="1.0"?><LawSearch><totalCnt>0</totalCnt></LawSearch>' }])
    await expect(client().searchLaw("법인세법")).resolves.toContain("totalCnt")
  })
})

describe("rate limit 배선 (PRD 04 운영 계약)", () => {
  it("분당 한도 초과 시 RATE_LIMITED를 던진다 (0건 위장 아님)", async () => {
    stubFetchSequence([{ body: '<?xml version="1.0"?><LawSearch><totalCnt>0</totalCnt></LawSearch>' }])
    process.env.FIN_DRF_RATE_PER_MIN = "2"
    try {
      const c = client() // 생성 시점에 한도 읽음
      await c.searchLaw("법인세법")
      await c.searchLaw("소득세법")
      await expect(c.searchLaw("부가가치세법")).rejects.toThrow(/RATE_LIMITED/)
    } finally {
      delete process.env.FIN_DRF_RATE_PER_MIN
    }
  })
})

describe("maskSensitiveUrl (키 노출 방지)", () => {
  it("OC·apikey류 쿼리 값만 마스킹한다", () => {
    expect(maskSensitiveUrl("https://x/y?OC=abc&target=law")).toBe("https://x/y?OC=***&target=law")
    expect(maskSensitiveUrl("https://x/y?apiKey=k&q=1")).toBe("https://x/y?apiKey=***&q=1")
  })
})
