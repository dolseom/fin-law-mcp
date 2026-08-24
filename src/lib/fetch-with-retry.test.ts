/**
 * fetchWithRetry 취소 전파 회귀 테스트 (fixture 기반 — CI 상시)
 * Codex 리뷰 중요 4: 외부 abort(도구 deadline)가 재시도 backoff sleep 중에는
 * 전파되지 않아, 20ms에 취소해도 backoff 1초를 다 기다린 뒤 끝나던 문제를 박제한다.
 */

import { describe, it, expect, afterEach } from "vitest"
import { fetchWithRetry, maskSensitiveUrl } from "./fetch-with-retry.js"

const origFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = origFetch
})

describe("fetchWithRetry — 외부 취소 전파", () => {
  it("backoff 대기 중 abort하면 즉시 중단된다 (남은 대기를 기다리지 않음)", async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return new Response("busy", { status: 503 })
    }) as typeof fetch

    const aborter = new AbortController()
    const t0 = Date.now()
    setTimeout(() => aborter.abort(), 20)

    await expect(
      fetchWithRetry("https://www.law.go.kr/DRF/lawSearch.do?OC=secret", {
        retries: 2,
        timeout: 3000,
        retryDelay: 1000, // backoff 1초 — abort를 무시하면 여기서 걸린다
        signal: aborter.signal,
      })
    ).rejects.toThrow(/취소됨/)

    const elapsed = Date.now() - t0
    expect(elapsed).toBeLessThan(500) // 1000ms backoff를 기다렸으면 실패
    expect(calls).toBe(1) // abort 후 재시도하지 않는다
  })

  it("abort가 없으면 정상적으로 재시도한다 (취소 로직이 재시도를 죽이지 않음)", async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return calls < 2 ? new Response("busy", { status: 503 }) : new Response("<LawSearch/>", { status: 200 })
    }) as typeof fetch

    const res = await fetchWithRetry("https://www.law.go.kr/DRF/lawSearch.do?OC=secret", {
      retries: 2,
      timeout: 3000,
      retryDelay: 10,
    })
    expect(res.status).toBe(200)
    expect(calls).toBe(2)
  })

  it("취소 메시지에 API 키가 노출되지 않는다", async () => {
    globalThis.fetch = (async () => new Response("busy", { status: 503 })) as typeof fetch
    const aborter = new AbortController()
    setTimeout(() => aborter.abort(), 10)
    try {
      await fetchWithRetry("https://www.law.go.kr/DRF/lawSearch.do?OC=supersecret123", {
        retries: 2,
        retryDelay: 500,
        signal: aborter.signal,
      })
      expect.unreachable("취소로 throw되어야 한다")
    } catch (e) {
      expect((e as Error).message).not.toContain("supersecret123")
      expect((e as Error).message).toContain("***")
    }
  })
})

describe("maskSensitiveUrl", () => {
  it("OC 키를 마스킹한다", () => {
    expect(maskSensitiveUrl("https://x/y?OC=abc123&type=XML")).toBe("https://x/y?OC=***&type=XML")
  })
})
