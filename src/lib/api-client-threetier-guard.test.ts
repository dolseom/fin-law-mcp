/**
 * getThreeTier 응답 가드 회귀 테스트 (s2-fixes · r2-cache §6 목록 밖 발견)
 *
 * 종전 getThreeTier는 가드가 없어 200 + 루트가 다른 JSON·XML 선언 뒤 HTML이 캐시에 담겨
 * TTL(600초) 동안 소비자(fin_article 위임 섹션)가 같은 실패를 반복했다.
 * 정상 루트 근거: .release-scratch/probes/r9-raw/thd-*.json 38건(2026-09-16 knd=2 실응답)의
 * 최상위 키가 전부 LspttnThdCmpLawXService. 위임 표가 없는 법령은 같은 루트에 기본정보만 온다.
 * 아래 픽스처는 그 형태를 줄인 합성본이다(실응답 파일은 링크에 인증키가 있어 복사하지 않음).
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest"
import { LawApiClient } from "./api-client.js"

const origFetch = globalThis.fetch
const ENV_KEYS = ["FIN_CACHE_TTL_SEC", "FIN_DRF_RATE_PER_MIN", "FIN_DRF_MAX_CONCURRENCY"] as const
const origEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) origEnv[k] = process.env[k]
  process.env.FIN_CACHE_TTL_SEC = "600"
})

afterEach(() => {
  globalThis.fetch = origFetch
  for (const k of ENV_KEYS) {
    if (origEnv[k] === undefined) delete process.env[k]
    else process.env[k] = origEnv[k]
  }
})

const GOOD_THREE_TIER = JSON.stringify({
  LspttnThdCmpLawXService: {
    기본정보: { 법령명: "법인세법", 시행일자: "20260101" },
    기준법령목록: { 법령명: "법인세법" },
    위임조문삼단비교: { 법률조문: [] },
  },
})

/** 위임 표가 없는 법령의 정상 응답 형태 (thd-284983 실측 모양) — 정상 0건은 통과·캐시 */
const GOOD_NO_DELEGATION = JSON.stringify({
  LspttnThdCmpLawXService: { 기본정보: { 법령명: "어떤법" } },
})

const BAD_CASES: Array<{ name: string; body: string; message: RegExp }> = [
  {
    name: "루트가 다른 JSON",
    body: JSON.stringify({ Law: "일치하는 법령이 없습니다" }),
    message: /3단비교 조회 - 법제처 API가 예상 밖 응답\(최상위 키: Law, 기대: LspttnThdCmpLawXService\)/,
  },
  {
    name: "빈 객체",
    body: "{}",
    message: /예상 밖 응답/,
  },
  {
    // blacklist의 HTML 규칙은 `^\s*<html` 앵커라 XML 선언이 앞에 붙으면 통과한다
    name: "XML 선언 뒤 HTML",
    body: '<?xml version="1.0" encoding="UTF-8"?>\n<html><body>점검 중</body></html>',
    message: /3단비교 조회 - API가 HTML 에러 페이지를 반환했습니다/,
  },
]

function stubAll(route: () => Response): { count: () => number } {
  let n = 0
  globalThis.fetch = (async () => {
    n++
    return route()
  }) as typeof fetch
  return { count: () => n }
}

const json = (body: string) => new Response(body, { status: 200, headers: { "content-type": "application/json" } })
const client = () => new LawApiClient({ apiKey: "dummy" })

describe("getThreeTier — 응답 가드 + 캐시 저장 금지", () => {
  for (const c of BAD_CASES) {
    it(`${c.name} — 1회차 확인 실패 → 2회차 재조회(캐시 안 됨) → 3회차 정상 적중`, async () => {
      let n = 0
      const s = stubAll(() => json(++n === 1 ? c.body : GOOD_THREE_TIER))
      const cl = client()
      const run = () => cl.getThreeTier({ mst: "283635", knd: "2" })

      await expect(run()).rejects.toThrow(c.message)
      expect(s.count(), "1회차가 한 번에 끝나지 않았다").toBe(1)

      await expect(run()).resolves.toBe(GOOD_THREE_TIER)
      expect(s.count(), "거부된 본문이 캐시에 남아 있다").toBe(2)

      await expect(run()).resolves.toBe(GOOD_THREE_TIER)
      expect(s.count(), "정상 본문이 캐시에 안 담겼다").toBe(2)
    })
  }

  it("반대 방향: 위임 표 없는 정상 응답(기본정보만)은 통과하고 캐시된다", async () => {
    const s = stubAll(() => json(GOOD_NO_DELEGATION))
    const cl = client()
    await expect(cl.getThreeTier({ mst: "284983", knd: "2" })).resolves.toBe(GOOD_NO_DELEGATION)
    await expect(cl.getThreeTier({ mst: "284983", knd: "2" })).resolves.toBe(GOOD_NO_DELEGATION)
    expect(s.count()).toBe(1)
  })
})
