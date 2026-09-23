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

  /** Codex 9차 — XML 본문에서 꺼낸 링크는 &가 &amp;로 온다. OC 앞 글자가 ';'라 종전 정규식이 놓쳤다 */
  it("&amp;로 이스케이프된 링크의 OC도 가린다", () => {
    expect(maskSensitiveUrl("/DRF/lawService.do?target=licbyl&amp;OC=OC_SENTINEL_TEST&amp;ID=1")).toBe(
      "/DRF/lawService.do?target=licbyl&amp;OC=***&amp;ID=1"
    )
  })

  it("메시지 속 URL 뒤의 문장은 삼키지 않는다", () => {
    expect(maskSensitiveUrl("실패 - https://x/y?OC=abc123 (재시도)")).toBe("실패 - https://x/y?OC=*** (재시도)")
  })

  it("반대 방향: 키 파라미터가 아닌 값은 건드리지 않는다", () => {
    const url = "https://www.law.go.kr/LSW/specialDeccInfoP.do?trbClsCd=360101&specialDeccSeq=947374"
    expect(maskSensitiveUrl(url)).toBe(url)
    expect(maskSensitiveUrl("https://taxlaw.nts.go.kr/qt/USEQTA002P.do?ntstDcmId=010000000000474699")).toBe(
      "https://taxlaw.nts.go.kr/qt/USEQTA002P.do?ntstDcmId=010000000000474699"
    )
  })
})

/**
 * Codex 9차 — Retry-After 상한이 없어 429 + `Retry-After: 30`에 30초를 자다가 도구 deadline에 끊겼고,
 * fin_ping은 원인(한도 초과)을 "타임아웃"으로 보고했다.
 */
describe("fetchWithRetry — Retry-After 상한·재시도 게이트", () => {
  it("Retry-After가 상한보다 길면 기다리지 않고 429를 그대로 돌려준다", async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return new Response("too many", { status: 429, headers: { "Retry-After": "30" } })
    }) as typeof fetch
    const t0 = Date.now()
    let gateCalls = 0
    const res = await fetchWithRetry("https://www.law.go.kr/DRF/lawSearch.do?OC=secret", {
      retries: 2,
      retryOn: [429],
      maxRetryAfterMs: 3000,
      // 재시도하지 않을 응답에는 게이트(= 한도 토큰 소모)를 부르지 않는다
      beforeRetry: () => {
        gateCalls++
        return true
      },
    })
    expect(res.status).toBe(429)
    expect(calls).toBe(1)
    expect(gateCalls).toBe(0)
    expect(Date.now() - t0).toBeLessThan(500)
  })

  it("반대 방향: Retry-After가 상한 안이면 그만큼 기다렸다가 재시도한다", async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return calls === 1
        ? new Response("too many", { status: 429, headers: { "Retry-After": "1" } })
        : new Response("<LawSearch/>", { status: 200 })
    }) as typeof fetch
    const t0 = Date.now()
    const res = await fetchWithRetry("https://www.law.go.kr/DRF/lawSearch.do?OC=secret", {
      retries: 2,
      retryOn: [429],
      maxRetryAfterMs: 3000,
    })
    expect(res.status).toBe(200)
    expect(calls).toBe(2)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900)
  })

  it("beforeRetry가 false면 재시도하지 않고 마지막 응답으로 끝낸다", async () => {
    let calls = 0
    const seen: Array<number | null> = []
    globalThis.fetch = (async () => {
      calls++
      return new Response("busy", { status: 503 })
    }) as typeof fetch
    const res = await fetchWithRetry("https://www.law.go.kr/DRF/lawSearch.do?OC=secret", {
      retries: 2,
      retryDelay: 10,
      beforeRetry: (status) => {
        seen.push(status)
        return false
      },
    })
    expect(res.status).toBe(503)
    expect(calls).toBe(1)
    expect(seen).toEqual([503])
  })

  it("beforeRetry가 false면 200 빈 본문도 재시도 없이 오류로 끝낸다 (불량 본문을 정상으로 넘기지 않음)", async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return new Response("", { status: 200 })
    }) as typeof fetch
    await expect(
      fetchWithRetry("https://www.law.go.kr/DRF/lawSearch.do?OC=secret", { retries: 2, retryDelay: 10, beforeRetry: () => false })
    ).rejects.toThrow(/빈 본문/)
    expect(calls).toBe(1)
  })

  it("반대 방향: beforeRetry가 true면 종전대로 재시도한다", async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return calls < 3 ? new Response("busy", { status: 503 }) : new Response("<LawSearch/>", { status: 200 })
    }) as typeof fetch
    const res = await fetchWithRetry("https://www.law.go.kr/DRF/lawSearch.do?OC=secret", {
      retries: 2,
      retryDelay: 10,
      beforeRetry: () => true,
    })
    expect(res.status).toBe(200)
    expect(calls).toBe(3)
  })
})
