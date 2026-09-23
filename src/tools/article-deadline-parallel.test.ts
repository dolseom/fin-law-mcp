/**
 * fin_article 회귀 — 3단비교 지연과 도구 deadline (R3 라이브 P1)
 *
 * 실측(2026-09-24, 조세특례제한법 시행령 §27 cold 6회 중 2회): thdCmp 응답이 콜당 timeout 3초를 넘어
 * 처음부터 다시 받다가 도구 deadline 6초에 abort됐고, 예규 검색은 4섹션 Promise.all이 끝난 **뒤에**
 * 시작해 예규 섹션까지 함께 "도구 deadline 초과"로 빠졌다.
 *
 * 수정 계약:
 *  (a) getThreeTier만 콜당 timeout 5초 — 4초 걸리는 응답도 받는다. timeout 뒤 재시도는 하지 않는다
 *      (deadline 안에 끝날 수 없다). 다른 호출의 3초 timeout·재시도 계약은 그대로다
 *  (b) 예규 검색은 조문 섹션이 끝나는 즉시 시작한다 — 3단비교가 deadline을 넘겨도 예규는 성공한다
 *
 * 실제 LawApiClient + fetchWithRetry를 쓰고 전역 fetch만 지연 스텁으로 바꾼다(가짜 시계).
 * 스텁 픽스처는 형태만 줄인 합성본이며 키는 가짜 값이다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { handleFinArticle } from "./article.js"
import { LawApiClient } from "../lib/api-client.js"
import { lawCache } from "../lib/cache.js"

const origFetch = globalThis.fetch
const ENV_KEYS = ["FIN_CACHE_TTL_SEC", "FIN_DRF_RATE_PER_MIN", "FIN_DRF_MAX_CONCURRENCY"] as const
const origEnv: Record<string, string | undefined> = {}

const LAW_XML = `<?xml version="1.0" encoding="UTF-8"?>
<LawSearch><totalCnt>1</totalCnt>
  <law id="1"><법령명한글>법인세법</법령명한글><법령일련번호>280349</법령일련번호><법령ID>001563</법령ID>
    <법령구분명>법률</법령구분명><시행일자>20260101</시행일자><제개정구분명>일부개정</제개정구분명><현행연혁코드>현행</현행연혁코드></law>
</LawSearch>`
const EMPTY_EFLAW_XML = '<?xml version="1.0"?><LawSearch><totalCnt>0</totalCnt></LawSearch>'
const ARTICLE_JSON = JSON.stringify({
  법령: {
    조문: {
      조문단위: [{ 조문여부: "조문", 조문번호: "26", 조문가지번호: "0", 조문제목: "과다경비 등의 손금불산입", 조문내용: "제26조(과다경비 등의 손금불산입) 본문" }],
    },
  },
})
const THREE_TIER_JSON = JSON.stringify({
  LspttnThdCmpLawXService: {
    기본정보: { 법령명: "법인세법", 시행일자: "20260101" },
    기준법령목록: { 법령명: "법인세법" },
    위임조문삼단비교: { 법률조문: [] },
  },
})
const ANNEX_JSON = JSON.stringify({ licBylSearch: { totalCnt: "0" } })
const RULING_XML =
  '<?xml version="1.0" encoding="UTF-8"?><CgmExpc><totalCnt>1</totalCnt>' +
  '<cgmExpc id="1"><안건명>과다경비 손금불산입 해당 여부</안건명><안건번호>서면-2024-법인-1</안건번호>' +
  "<해석일자>2024.05.01</해석일자><법령해석상세링크>/x</법령해석상세링크></cgmExpc></CgmExpc>"

/** URL로 응답을 고르고, thdCmp만 지정한 시간만큼 늦게 준다 (signal abort를 존중) */
function installFetch(thdDelayMs: number, lawSearchDelayMs = 0): { thdCalls: () => number; calls: string[] } {
  const calls: string[] = []
  let thd = 0
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const target = url.searchParams.get("target") || ""
    const ep = url.pathname.split("/").pop() || ""
    calls.push(`${ep}:${target}`)
    const respond = (body: string) => new Response(body, { status: 200 })
    if (ep === "lawService.do" && target === "thdCmp") {
      thd++
      return new Promise<Response>((resolve, reject) => {
        const t = setTimeout(() => resolve(respond(THREE_TIER_JSON)), thdDelayMs)
        init?.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(t)
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
          },
          { once: true }
        )
      })
    }
    if (ep === "lawService.do") return respond(ARTICLE_JSON)
    if (target === "ntsCgmExpc") return respond(RULING_XML)
    if (target === "eflaw") return respond(EMPTY_EFLAW_XML)
    if (target === "licbyl") return respond(ANNEX_JSON)
    if (lawSearchDelayMs > 0) {
      return new Promise<Response>((resolve) => setTimeout(() => resolve(respond(LAW_XML)), lawSearchDelayMs))
    }
    return respond(LAW_XML)
  }) as typeof fetch
  return { thdCalls: () => thd, calls }
}

/** 가짜 시계를 조금씩 밀며 프로미스가 끝날 때까지 돌린다 */
async function runWithClock<T>(p: Promise<T>, maxMs = 20_000): Promise<T> {
  let done = false
  let value: T | undefined
  let error: unknown
  p.then(
    (v) => {
      done = true
      value = v
    },
    (e) => {
      done = true
      error = e
    }
  )
  for (let t = 0; t < maxMs && !done; t += 50) await vi.advanceTimersByTimeAsync(50)
  if (!done) throw new Error("가짜 시계 상한 안에 끝나지 않음")
  if (error) throw error
  return value as T
}

const section = (text: string, header: string): string => {
  const start = text.indexOf(header)
  const end = text.indexOf("\n■ ", start + 1)
  return text.slice(start, end < 0 ? undefined : end)
}

beforeEach(() => {
  for (const k of ENV_KEYS) origEnv[k] = process.env[k]
  process.env.FIN_CACHE_TTL_SEC = "0"
  process.env.FIN_DRF_RATE_PER_MIN = "1000"
  process.env.FIN_DRF_MAX_CONCURRENCY = "4"
  lawCache.clear()
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
})

afterEach(() => {
  vi.useRealTimers()
  globalThis.fetch = origFetch
  for (const k of ENV_KEYS) {
    if (origEnv[k] === undefined) delete process.env[k]
    else process.env[k] = origEnv[k]
  }
})

const client = () => new LawApiClient({ apiKey: "OC_SENTINEL_TEST" })

describe("getThreeTier 콜당 timeout (P1-a)", () => {
  it("4초 걸리는 3단비교 응답을 받는다 — 3초에 끊고 처음부터 다시 받지 않는다", async () => {
    const f = installFetch(4000)
    const text = await runWithClock(client().getThreeTier({ mst: "280349", knd: "2" }))
    expect(text).toContain("LspttnThdCmpLawXService")
    expect(f.thdCalls()).toBe(1)
  })

  it("5초를 넘으면 timeout 오류 — deadline 안에 끝날 수 없는 재시도는 하지 않는다", async () => {
    const f = installFetch(9000)
    await expect(runWithClock(client().getThreeTier({ mst: "280349", knd: "2" }))).rejects.toThrow(/timeout after 5000ms/)
    expect(f.thdCalls()).toBe(1)
  })

  it("[반대] 다른 호출의 계약은 불변 — 법령 검색은 3초 timeout 뒤 재시도한다", async () => {
    const calls: number[] = []
    globalThis.fetch = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      calls.push(Date.now())
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), {
          once: true,
        })
      })
    }) as typeof fetch
    await expect(runWithClock(client().searchLaw("법인세법"))).rejects.toThrow(/timeout after 3000ms/)
    expect(calls.length).toBe(3) // 첫 시도 + 재시도 2회
  })
})

describe("fin_article — 3단비교 지연이 예규 섹션을 끌고 가지 않는다 (P1)", () => {
  it("3단비교 4초 지연 — 위임 섹션 성공, 예규도 성공 (전체 성공)", async () => {
    const f = installFetch(4000)
    const r = await runWithClock(handleFinArticle(client(), { law: "법인세법", article: "제26조" }))
    const text = r.content[0].text
    expect(text.split("\n")[0]).toContain("전체 성공")
    expect(section(text, "■ 시행령·시행규칙 위임")).toContain("(위임 조문 없음)")
    expect(section(text, "■ 국세청 예규 후보")).toContain("서면-2024-법인-1")
    expect(f.thdCalls()).toBe(1)
  })

  it("3단비교가 deadline을 넘겨도 예규 섹션은 성공한다 — 위임만 실패로 표기", async () => {
    // 법령 해소에 1.5초 → 3단비교 5초 timeout이 6.5초로 deadline(6초) 뒤에 온다. 예규 검색이
    // 4섹션 뒤에 순차로 나가면 deadline에 걸리고, 조문 직후 병렬로 나가면 1.5초대에 끝난다
    installFetch(60_000, 1500)
    const r = await runWithClock(handleFinArticle(client(), { law: "법인세법", article: "제26조" }))
    const text = r.content[0].text
    const head = text.split("\n")[0]
    expect(head).toContain("부분 성공")
    expect(head).toContain("위임(")
    expect(head).not.toContain("예규(")
    const rulings = section(text, "■ 국세청 예규 후보")
    expect(rulings).toContain("서면-2024-법인-1")
    expect(rulings).not.toContain("조회 실패")
    expect(section(text, "■ 시행령·시행규칙 위임")).toContain("조회 실패")
  })

  it("[반대] 정상 경로 — 빠른 응답은 종전과 같은 섹션 구성·전체 성공", async () => {
    const f = installFetch(200)
    const r = await runWithClock(handleFinArticle(client(), { law: "법인세법", article: "제26조" }))
    const text = r.content[0].text
    expect(text.split("\n")[0]).toContain("전체 성공")
    expect(text).toContain("■ 법인세법 제26조")
    expect(text).toContain("과다경비 등의 손금불산입")
    expect(section(text, "■ 국세청 예규 후보")).toContain("검색어:")
    expect(section(text, "■ 별표")).toContain("없음")
    // 예규 검색은 조문 조회 뒤에 나간다 (조문 제목이 검색어)
    const iArticle = f.calls.indexOf("lawService.do:law")
    const iRuling = f.calls.indexOf("lawSearch.do:ntsCgmExpc")
    expect(iArticle).toBeGreaterThanOrEqual(0)
    expect(iRuling).toBeGreaterThan(iArticle)
  })

  it("[반대] include_rulings=false 분기 유지 — 예규 검색을 하지 않는다", async () => {
    const f = installFetch(200)
    const r = await runWithClock(handleFinArticle(client(), { law: "법인세법", article: "제26조", include_rulings: false }))
    expect(section(r.content[0].text, "■ 국세청 예규 후보")).toContain("include_rulings=false")
    expect(f.calls).not.toContain("lawSearch.do:ntsCgmExpc")
  })
})
