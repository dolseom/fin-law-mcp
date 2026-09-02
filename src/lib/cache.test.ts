/**
 * 캐시 두 계층 정합 회귀 테스트 (fixture — CI 상시)
 *
 * 이 저장소에는 캐시가 둘이다:
 *  ① response-cache.ts — drfFetch 단일 관문의 **응답 본문** 캐시 (FIN_CACHE_TTL_SEC)
 *  ② cache.ts의 lawCache — law-search·abolished-laws의 **파싱 결과** 캐시
 *
 * 둘이 다른 규칙을 따르면 `FIN_CACHE_TTL_SEC=0`(장애 진단용 탈출구)이 절반만 듣고,
 * 일시 장애로 만들어진 결과가 ②에 그대로 굳는다. 아래는 그 두 가지를 박제한다.
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest"
import { lawCache, resolveCacheTtlMs, DEFAULT_LAW_CACHE_TTL_MS, SimpleCache } from "./cache.js"
import { createResponseCacheFromEnv } from "./response-cache.js"
import { findLaws } from "./law-search.js"
import { findAbolishedLaws, detectAbolishedAdminRule } from "./abolished-laws.js"
import type { LawApiClient } from "./api-client.js"

const LAW_XML = (name: string, mst: string) =>
  `<?xml version="1.0"?><LawSearch><totalCnt>1</totalCnt><law>` +
  `<법령명한글>${name}</법령명한글><법령ID>001</법령ID><법령일련번호>${mst}</법령일련번호>` +
  `<법령구분명>법률</법령구분명></law></LawSearch>`

const EMPTY_LAW_XML = '<?xml version="1.0"?><LawSearch><totalCnt>0</totalCnt></LawSearch>'

const ADMRUL_HISTORY_XML =
  `<?xml version="1.0"?><AdmRulSearch>` +
  `<admrul><행정규칙명>월별납부제도 운영에 관한 고시</행정규칙명><행정규칙일련번호>111</행정규칙일련번호>` +
  `<행정규칙ID>A1</행정규칙ID><발령일자>20200101</발령일자><제개정구분명>일부개정</제개정구분명>` +
  `<현행연혁구분>연혁</현행연혁구분><행정규칙종류>고시</행정규칙종류><소관부처명>국세청</소관부처명></admrul>` +
  `<admrul><행정규칙명>월별납부제도 운영에 관한 고시</행정규칙명><행정규칙일련번호>222</행정규칙일련번호>` +
  `<행정규칙ID>A1</행정규칙ID><발령일자>20241211</발령일자><제개정구분명>폐지</제개정구분명>` +
  `<현행연혁구분>연혁</현행연혁구분><행정규칙종류>고시</행정규칙종류><소관부처명>국세청</소관부처명></admrul>` +
  `</AdmRulSearch>`

const ADMRUL_BODY_XML =
  `<?xml version="1.0"?><AdmRulService><제개정이유><![CDATA[` +
  `「징수업무 처리에 관한 고시」로 통ㆍ폐합하여 이 고시를 폐지함.` +
  `]]></제개정이유></AdmRulService>`

const ABOLISHED_QUERY = "월별납부제도 운영에 관한 고시"

const realTtl = process.env.FIN_CACHE_TTL_SEC

beforeEach(() => {
  lawCache.clear()
})

afterEach(() => {
  lawCache.clear()
  if (realTtl === undefined) delete process.env.FIN_CACHE_TTL_SEC
  else process.env.FIN_CACHE_TTL_SEC = realTtl
})

describe("FIN_CACHE_TTL_SEC은 두 계층을 함께 제어한다", () => {
  it("두 계층의 on/off 판정이 어긋나지 않는다 (env 파싱 표류 방지)", () => {
    const cases: (string | undefined)[] = [undefined, "", "0", "600", "30", "abc", "-5", " 600 "]
    for (const v of cases) {
      if (v === undefined) delete process.env.FIN_CACHE_TTL_SEC
      else process.env.FIN_CACHE_TTL_SEC = v
      const responseLayerOn = createResponseCacheFromEnv().enabled
      const parsedLayerOn = resolveCacheTtlMs() > 0
      expect(parsedLayerOn, `FIN_CACHE_TTL_SEC=${JSON.stringify(v)}에서 두 계층 판정 불일치`)
        .toBe(responseLayerOn)
    }
  })

  it("FIN_CACHE_TTL_SEC=0이면 lawCache는 set이 no-op이고 get은 항상 miss다", () => {
    process.env.FIN_CACHE_TTL_SEC = "0"
    const c = new SimpleCache(10)
    c.set("k", "v")
    expect(c.get("k")).toBeNull()
    expect(c.has("k")).toBe(false)
    expect(c.size()).toBe(0)
  })

  it("FIN_CACHE_TTL_SEC은 호출부 TTL의 상한이다 (더 짧은 쪽이 이긴다)", () => {
    process.env.FIN_CACHE_TTL_SEC = "1"
    // 호출부가 1시간을 요청해도 env가 1초면 1초 — README의 '최대 TTL' 약속이 사실이 된다
    expect(resolveCacheTtlMs()).toBe(1000)
    expect(Math.min(DEFAULT_LAW_CACHE_TTL_MS, resolveCacheTtlMs())).toBe(1000)
  })

  it("FIN_CACHE_TTL_SEC=0이면 findLaws가 매번 다시 조회한다 (진단용 탈출구)", async () => {
    process.env.FIN_CACHE_TTL_SEC = "0"
    let calls = 0
    const client = {
      searchLaw: async () => {
        calls++
        return LAW_XML("법인세법", "100")
      },
    } as unknown as LawApiClient

    await findLaws(client, "법인세법")
    await findLaws(client, "법인세법")
    expect(calls).toBe(2)
  })

  it("FIN_CACHE_TTL_SEC=0이면 findAbolishedLaws도 매번 다시 조회한다", async () => {
    process.env.FIN_CACHE_TTL_SEC = "0"
    let calls = 0
    const client = {
      searchLaw: async () => {
        calls++
        return EMPTY_LAW_XML
      },
    } as unknown as LawApiClient

    await findAbolishedLaws(client, "택지소유상한에 관한 법률")
    await findAbolishedLaws(client, "택지소유상한에 관한 법률")
    expect(calls).toBe(2)
  })
})

describe("실패에서 나온 결과는 어느 계층에도 굳지 않는다", () => {
  it("findLaws: 원본 쿼리가 인프라 오류로 죽고 폴백이 답을 내면 그 답을 캐시하지 않는다", async () => {
    process.env.FIN_CACHE_TTL_SEC = "600"
    let primaryDown = true
    const seen: string[] = []
    const client = {
      searchLaw: async (q: string) => {
        seen.push(q)
        if (q === "법인세법 별표" && primaryDown) {
          throw new Error("법제처 API 오류 (503)")
        }
        // 폴백(부가키워드 제거) 경로는 다른 법령을 준다 — 원본 쿼리의 정답이 아니다
        return q === "법인세법 별표" ? LAW_XML("법인세법", "100") : LAW_XML("법인세법 시행규칙", "900")
      },
    } as unknown as LawApiClient

    const first = await findLaws(client, "법인세법 별표")
    expect(first[0].lawName).toBe("법인세법 시행규칙") // 폴백이 낸 답

    // 장애가 걷혔다. 두 번째 호출은 원본 쿼리를 다시 타야 한다
    primaryDown = false
    seen.length = 0
    const second = await findLaws(client, "법인세법 별표")
    expect(seen.length, "폴백 결과가 캐시돼 재조회가 일어나지 않았다").toBeGreaterThan(0)
    expect(second[0].lawName).toBe("법인세법")
  })

  it("findLaws: 전 단계가 정상이면 캐시한다 (캐시 자체를 죽이지 않았는지 확인)", async () => {
    process.env.FIN_CACHE_TTL_SEC = "600"
    let calls = 0
    const client = {
      searchLaw: async () => {
        calls++
        return LAW_XML("법인세법", "100")
      },
    } as unknown as LawApiClient

    await findLaws(client, "법인세법")
    await findLaws(client, "법인세법")
    expect(calls).toBe(1)
  })

  it("detectAbolishedAdminRule: 폐지사유 본문 조회가 실패한 반쪽 안내문은 캐시하지 않는다", async () => {
    process.env.FIN_CACHE_TTL_SEC = "600"
    let bodyDown = true
    let bodyCalls = 0
    const client = {
      searchAdminRule: async () => ADMRUL_HISTORY_XML,
      getAdminRule: async () => {
        bodyCalls++
        if (bodyDown) throw new Error("법제처 API 오류 (타임아웃)")
        return ADMRUL_BODY_XML
      },
    } as unknown as LawApiClient

    const first = await detectAbolishedAdminRule(client, ABOLISHED_QUERY)
    expect(first).toContain("[폐지]")
    expect(first).not.toContain("징수업무 처리에 관한 고시")

    // 장애가 걷혔다. 반쪽 안내문이 굳었다면 본문을 다시 조회하지 않는다
    bodyDown = false
    const second = await detectAbolishedAdminRule(client, ABOLISHED_QUERY)
    expect(bodyCalls, "본문 조회 실패로 만든 안내문이 캐시돼 재조회가 없었다").toBe(2)
    expect(second).toContain("징수업무 처리에 관한 고시")
  })

  it("detectAbolishedAdminRule: 본문까지 정상이면 캐시한다", async () => {
    process.env.FIN_CACHE_TTL_SEC = "600"
    let searchCalls = 0
    const client = {
      searchAdminRule: async () => {
        searchCalls++
        return ADMRUL_HISTORY_XML
      },
      getAdminRule: async () => ADMRUL_BODY_XML,
    } as unknown as LawApiClient

    await detectAbolishedAdminRule(client, ABOLISHED_QUERY)
    await detectAbolishedAdminRule(client, ABOLISHED_QUERY)
    expect(searchCalls).toBe(1)
  })

  it("detectAbolishedAdminRule: 연혁 조회 실패는 캐시되지 않고 예외로 전파된다", async () => {
    process.env.FIN_CACHE_TTL_SEC = "600"
    let down = true
    const client = {
      searchAdminRule: async () => {
        if (down) throw new Error("법제처 API 오류 (503)")
        return ADMRUL_HISTORY_XML
      },
      getAdminRule: async () => ADMRUL_BODY_XML,
    } as unknown as LawApiClient

    await expect(detectAbolishedAdminRule(client, ABOLISHED_QUERY)).rejects.toThrow(/조회 실패/)
    down = false
    const after = await detectAbolishedAdminRule(client, ABOLISHED_QUERY)
    expect(after).toContain("[폐지]")
  })
})

describe("캐시 키가 서로 다른 조회를 섞지 않는다", () => {
  it("현행(target=law)과 연혁(target=eflaw) 결과가 같은 이름에서 섞이지 않는다", async () => {
    process.env.FIN_CACHE_TTL_SEC = "600"
    const targets: string[] = []
    const client = {
      searchLaw: async (_q: string, _k?: string, _d?: number, target = "law") => {
        targets.push(target)
        return target === "eflaw" ? EMPTY_LAW_XML : LAW_XML("법인세법", "100")
      },
    } as unknown as LawApiClient

    const current = await findLaws(client, "법인세법")
    const abolished = await findAbolishedLaws(client, "법인세법")
    expect(current).toHaveLength(1)
    expect(abolished).toHaveLength(0)
    expect(targets).toEqual(["law", "eflaw"]) // 한쪽이 다른 쪽 캐시를 먹지 않았다
  })

  it("max·display가 다르면 다른 캐시 항목이다", async () => {
    process.env.FIN_CACHE_TTL_SEC = "600"
    let calls = 0
    const client = {
      searchLaw: async () => {
        calls++
        return LAW_XML("법인세법", "100")
      },
    } as unknown as LawApiClient

    await findLaws(client, "법인세법", undefined, 3, 100)
    await findLaws(client, "법인세법", undefined, 3, 20)
    expect(calls).toBe(2)
  })
})
