import { describe, it, expect, vi, afterEach } from "vitest"
import { ResponseCache, isCacheableBody } from "./response-cache.js"
import { LawApiClient } from "./api-client.js"

describe("ResponseCache — TTL·상한·비활성", () => {
  it("TTL 안에서는 적중, 지나면 만료된다", () => {
    let now = 1000
    const c = new ResponseCache({ ttlMs: 500, now: () => now })
    c.set("u1", "body")
    expect(c.get("u1")).toBe("body")
    now = 1499
    expect(c.get("u1")).toBe("body")
    now = 1501
    expect(c.get("u1")).toBeUndefined()
  })

  it("항목 수 상한을 넘으면 오래된 것부터 버린다", () => {
    const c = new ResponseCache({ ttlMs: 60_000, maxEntries: 2 })
    c.set("a", "1")
    c.set("b", "2")
    c.set("c", "3")
    expect(c.get("a")).toBeUndefined()
    expect(c.get("b")).toBe("2")
    expect(c.get("c")).toBe("3")
  })

  it("적중한 항목은 뒤로 밀려 LRU로 살아남는다", () => {
    const c = new ResponseCache({ ttlMs: 60_000, maxEntries: 2 })
    c.set("a", "1")
    c.set("b", "2")
    expect(c.get("a")).toBe("1") // a를 최근 사용으로
    c.set("c", "3")
    expect(c.get("a")).toBe("1")
    expect(c.get("b")).toBeUndefined()
  })

  it("바이트 상한을 넘는 단일 응답은 담지 않는다", () => {
    const c = new ResponseCache({ ttlMs: 60_000, maxBytes: 10 })
    c.set("big", "0123456789") // 20바이트(UTF-16 근사) > 10
    expect(c.get("big")).toBeUndefined()
    expect(c.stats().entries).toBe(0)
  })

  it("ttlMs=0이면 비활성 — 담지도 꺼내지도 않는다", () => {
    const c = new ResponseCache({ ttlMs: 0 })
    c.set("a", "1")
    expect(c.enabled).toBe(false)
    expect(c.get("a")).toBeUndefined()
  })
})

describe("isCacheableBody — 장애 응답은 담지 않는다", () => {
  it("정상 XML은 담는다", () => {
    expect(isCacheableBody('<?xml version="1.0"?><LawSearch><totalCnt>1</totalCnt></LawSearch>')).toBe(true)
  })

  it.each(["", "   ", "<!DOCTYPE html><html><body>오류</body></html>", "<html>error</html>"])(
    "빈 응답·HTML 장애 페이지는 담지 않는다 (%s)",
    (body) => {
      expect(isCacheableBody(body)).toBe(false)
    }
  )

  /**
   * Codex 7차 중요 — 법제처는 200 + **정상 형식의 오류 본문**도 준다. 이것을 담으면
   * 일시 장애가 TTL 동안 "0건"으로 고정된다 (상위 파서가 항목 0개로 읽는다).
   */
  it.each([
    '{"error":{"message":"temporary"}}',
    '{"errorMessage":"일시 오류"}',
    "<error><message>temporary</message></error>",
    '<?xml version="1.0"?><error><code>SVC-001</code></error>',
  ])("200 상태의 오류 본문도 담지 않는다 (%s)", (body) => {
    expect(isCacheableBody(body)).toBe(false)
  })

  it("0건이 정상인 응답은 담는다 (오류와 구분)", () => {
    expect(isCacheableBody('<?xml version="1.0"?><LawSearch><totalCnt>0</totalCnt></LawSearch>')).toBe(true)
    expect(isCacheableBody('{"별표목록":[]}')).toBe(true)
  })
})

describe("LawApiClient — 캐시 배선", () => {
  const realFetch = globalThis.fetch
  const realTtl = process.env.FIN_CACHE_TTL_SEC
  afterEach(() => {
    globalThis.fetch = realFetch
    if (realTtl === undefined) delete process.env.FIN_CACHE_TTL_SEC
    else process.env.FIN_CACHE_TTL_SEC = realTtl
    vi.restoreAllMocks()
  })

  const XML = '<?xml version="1.0"?><LawSearch><totalCnt>0</totalCnt></LawSearch>'

  it("같은 조회는 한 번만 나간다", async () => {
    process.env.FIN_CACHE_TTL_SEC = "600"
    const spy = vi.fn(async () => new Response(XML, { status: 200 }))
    globalThis.fetch = spy as unknown as typeof fetch
    const client = new LawApiClient({ apiKey: "k" })
    await client.searchLaw("법인세법")
    await client.searchLaw("법인세법")
    await client.searchLaw("법인세법")
    expect(spy).toHaveBeenCalledTimes(1)
    expect(client.cacheStats().hits).toBe(2)
  })

  it("FIN_CACHE_TTL_SEC=0이면 매번 나간다 (진단용 탈출구)", async () => {
    process.env.FIN_CACHE_TTL_SEC = "0"
    const spy = vi.fn(async () => new Response(XML, { status: 200 }))
    globalThis.fetch = spy as unknown as typeof fetch
    const client = new LawApiClient({ apiKey: "k" })
    await client.searchLaw("법인세법")
    await client.searchLaw("법인세법")
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it("오류 응답은 캐시하지 않는다 — 일시 장애가 TTL 동안 고정되면 안 된다", async () => {
    process.env.FIN_CACHE_TTL_SEC = "600"
    let call = 0
    const spy = vi.fn(async () => {
      call++
      // 첫 호출만 500, 이후 정상 (500은 DRF_RETRY의 재시도 대상이 아니라 그대로 실패한다)
      return call === 1 ? new Response("서버 오류", { status: 500 }) : new Response(XML, { status: 200 })
    })
    globalThis.fetch = spy as unknown as typeof fetch
    const client = new LawApiClient({ apiKey: "k" })
    await expect(client.searchLaw("법인세법")).rejects.toThrow()
    const after = await client.searchLaw("법인세법")
    expect(after).toContain("LawSearch")
  })

  it("서로 다른 기준일(efYd) 조회는 서로 다른 캐시 항목이다", async () => {
    process.env.FIN_CACHE_TTL_SEC = "600"
    const spy = vi.fn(async () => new Response(XML, { status: 200 }))
    globalThis.fetch = spy as unknown as typeof fetch
    const client = new LawApiClient({ apiKey: "k" })
    await client.getLawText({ mst: "001", jo: "002600", efYd: "20200101" })
    await client.getLawText({ mst: "001", jo: "002600", efYd: "20250101" })
    expect(spy).toHaveBeenCalledTimes(2)
  })
})
