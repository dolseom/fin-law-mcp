/**
 * R9 공유 파일 경계 감사 — 재현 전용 테스트 (r1-boundaries, 2026-09-21)
 *
 * 이 파일은 **결함 재현**이 목적이다. production 코드를 고치지 않고, 실패하는 계약을
 * 그대로 박제해 다음 라운드(R2) 소유자에게 넘긴다. 기대값을 현재 동작에 맞춰 뒤집지 말 것.
 *
 * ── ① api-client 캐시 저장 시점과 루트 가드 시점의 어긋남 ─────────────────
 * drfFetch(api-client.ts:107)는 `isCacheableBody`만 보고 본문을 캐시에 담고,
 * 루트/최상위 키 검증(assertXmlRoot :119 · assertJsonKey :135)은 그 **뒤**
 * searchLaw :258 · searchAdminRule :399 · getAdminRule :430 · searchOrdinance :568 ·
 * fetchApi :674~682에서 일어난다. response-cache.ts:119~127의 blacklist는
 * `<error>`·`{"error":…}`·HTML·빈 본문만 거르므로, 법제처가 200으로 돌려주는
 * **루트만 다른 짧은 JSON/XML**(`{"Law":{}}` 42B 실측 — api-client.test.ts:34 주석)은
 * blacklist를 통과해 캐시에 담긴 뒤 가드에서 throw된다. 결과: 일시 장애가 TTL(기본 600초)
 * 동안 고정되고, 같은 URL의 다음 조회는 네트워크를 타지 못한 채 같은 오류를 되풀이한다.
 * `complete` 훅(getAdminRule 중간 절단)만 이 구멍을 막고 있고, 루트 가드에는 대응물이 없다.
 *
 * 기존 테스트가 못 잡은 이유(fixture 허점):
 *   · api-client.test.ts:32~56 — 가드는 검증하지만 캐시를 켜지 않는다(단발 호출만)
 *   · api-client-guards.test.ts:100~111 — 캐시 재호출을 보지만 `complete` 훅이 막는
 *     "중간 절단" 경로뿐이다. 루트 불일치는 다른 분기라 여기에 걸리지 않는다
 *   · api-client-guards.test.ts:191~199 — bypassCache 경로의 오염 본문이 HTML이라
 *     blacklist에서 먼저 걸러진다
 *
 * ── ② deletedArticleStamp 중복 wrapper 등가성 ─────────────────────────────
 * 같은 이름·같은 본문의 함수가 verify.ts:867과 article.ts:192에 각각 있고, 둘 다
 * admin-rule-citation.ts:69 `parseDeletedArticle`을 감싼다. 한쪽만 고치면 fin_verify는
 * ⚠삭제 조문인데 fin_article은 표지 없이 살아 있는 조문으로 답한다(이 저장소의 "절반 수정").
 * 같은 조문단위 payload를 두 도구에 넣어 판정이 갈리는지 본다.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { LawApiClient } from "./api-client.js"
import { isCacheableBody } from "./response-cache.js"
import { lawCache } from "./cache.js"
import { handleFinVerify } from "../tools/verify.js"
import { handleFinArticle } from "../tools/article.js"

const origFetch = globalThis.fetch
const ENV_KEYS = ["FIN_CACHE_TTL_SEC", "FIN_DRF_RATE_PER_MIN"] as const
const origEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) origEnv[k] = process.env[k]
  lawCache.clear()
})

afterEach(() => {
  globalThis.fetch = origFetch
  for (const k of ENV_KEYS) {
    if (origEnv[k] === undefined) delete process.env[k]
    else process.env[k] = origEnv[k]
  }
})

/** 순서대로 응답을 돌려주는 fetch stub — 마지막 본문은 이후 호출에 반복 사용한다 */
function stubSequence(bodies: string[]): { count: () => number } {
  let n = 0
  globalThis.fetch = (async () => {
    const body = bodies[Math.min(n, bodies.length - 1)]
    n++
    return new Response(body, { status: 200 })
  }) as typeof fetch
  return { count: () => n }
}

/**
 * 2회차 호출의 실제 결과를 문자열로 잡는다 — 실패 메시지에 물리 호출 수와 오류를 남기기 위한 것이다.
 * 계약(회복 + 네트워크 재호출)은 호출부에서 그대로 단언한다
 */
async function secondCallOutcome(run: () => Promise<string>): Promise<string> {
  return run().then(
    (text) => `회복(본문 ${text.length}자)`,
    (e) => `재실패: ${e instanceof Error ? e.message : String(e)}`
  )
}

/** 캐시를 켠 클라이언트 — 생성자에서 env를 읽으므로 TTL 설정 뒤에 만들어야 한다 */
function cachedClient(): LawApiClient {
  process.env.FIN_CACHE_TTL_SEC = "600"
  process.env.FIN_DRF_RATE_PER_MIN = "100"
  return new LawApiClient({ apiKey: "OC_SENTINEL_TEST" })
}

// 법제처가 조회 조건 불일치에 200으로 돌려주는 짧은 JSON (루트 키만 다르다)
const WRONG_JSON_ROOT = JSON.stringify({ Law: {} })
const GOOD_JSON = JSON.stringify({ 법령: { 조문: { 조문단위: [{ 조문여부: "조문", 조문번호: "26", 조문내용: "제26조(과다경비) 본문" }] } } })
// 200 + 정상 형식의 오류 XML — blacklist가 먼저 거른다 (반대 대조용)
const ERROR_XML = '<?xml version="1.0" encoding="UTF-8"?><error><message>일시 장애</message></error>'
// 루트만 어긋난 정상 형식 XML — blacklist를 통과한다
const WRONG_XML_ROOT = '<?xml version="1.0" encoding="UTF-8"?><LawSearch><totalCnt>0</totalCnt></LawSearch>'
const GOOD_CGM_XML =
  '<?xml version="1.0" encoding="UTF-8"?><CgmExpc><totalCnt>1</totalCnt>' +
  "<cgmExpc id=\"1\"><안건명>예규 1</안건명><안건번호>법인세과-100</안건번호><해석일자>20250310</해석일자></cgmExpc></CgmExpc>"
const GOOD_LAW_SEARCH_XML =
  '<?xml version="1.0" encoding="UTF-8"?><LawSearch><totalCnt>1</totalCnt><law id="1">' +
  "<법령명한글>법인세법</법령명한글><법령일련번호>280349</법령일련번호><시행일자>20260101</시행일자>" +
  "<현행연혁코드>현행</현행연혁코드></law></LawSearch>"
const ADMRUL_BODY =
  '<?xml version="1.0" encoding="UTF-8"?><AdmRulService><행정규칙기본정보><조문형식여부>Y</조문형식여부>' +
  "</행정규칙기본정보><조문내용>제1조(목적) …</조문내용></AdmRulService>"
const ADMRUL_TRUNCATED = ADMRUL_BODY.slice(0, ADMRUL_BODY.indexOf("<조문내용>"))

const jsonCall = (c: LawApiClient) =>
  c.fetchApi({
    endpoint: "lawService.do",
    target: "law",
    type: "JSON",
    extraParams: { MST: "280349", JO: "002600" },
    expectedJsonKey: "법령",
  })

const xmlCall = (c: LawApiClient) =>
  c.fetchApi({
    endpoint: "lawSearch.do",
    target: "ntsCgmExpc",
    type: "XML",
    extraParams: { query: "손금불산입", display: "3" },
    expectedRoot: "CgmExpc",
  })

// ── ① 캐시 × 루트 가드 ───────────────────────────────────────────────────

describe("api-client 캐시 — 루트 가드가 거부한 본문을 담으면 안 된다 (r1-boundaries 재현)", () => {
  it("JSON 루트 불일치({\"Law\":{}})는 캐시되면 안 된다 — 다음 조회가 네트워크로 회복해야 한다", async () => {
    const s = stubSequence([WRONG_JSON_ROOT, GOOD_JSON])
    const c = cachedClient()
    await expect(jsonCall(c)).rejects.toThrow(/예상 밖 응답/)
    // 계약: 가드가 거부한 본문은 담기지 않으므로 두 번째 호출은 실제로 나간다
    const outcome = await secondCallOutcome(() => jsonCall(c))
    expect(s.count(), `2회차 ${outcome}`).toBe(2)
    expect(outcome).toMatch(/^회복/)
  })

  it("[양성 대조] 정상 JSON은 종전대로 캐시 적중한다 — 캐시를 끄는 수정이 아니다", async () => {
    const s = stubSequence([GOOD_JSON])
    const c = cachedClient()
    await expect(jsonCall(c)).resolves.toContain("조문단위")
    await expect(jsonCall(c)).resolves.toContain("조문단위")
    expect(s.count()).toBe(1)
    expect(c.cacheStats().hits).toBe(1)
  })

  it("XML 루트 불일치(expectedRoot=CgmExpc에 <LawSearch>)도 캐시되면 안 된다", async () => {
    const s = stubSequence([WRONG_XML_ROOT, GOOD_CGM_XML])
    const c = cachedClient()
    await expect(xmlCall(c)).rejects.toThrow(/예상 밖 응답/)
    const outcome = await secondCallOutcome(() => xmlCall(c))
    expect(s.count(), `2회차 ${outcome}`).toBe(2)
    expect(outcome).toMatch(/^회복/)
  })

  it("searchLaw 루트 불일치(<AdmRulSearch>)도 캐시되면 안 된다", async () => {
    const s = stubSequence(['<?xml version="1.0"?><AdmRulSearch><totalCnt>0</totalCnt></AdmRulSearch>', GOOD_LAW_SEARCH_XML])
    const c = cachedClient()
    await expect(c.searchLaw("법인세법", undefined, 1, "law")).rejects.toThrow(/예상 밖 응답/)
    const outcome = await secondCallOutcome(() => c.searchLaw("법인세법", undefined, 1, "law"))
    expect(s.count(), `2회차 ${outcome}`).toBe(2)
    expect(outcome).toMatch(/^회복/)
  })

  it("[반대 대조] <error> 루트는 blacklist가 먼저 걸러 이미 회복된다 — 막고 있는 것이 무엇인지 구분", async () => {
    const s = stubSequence([ERROR_XML, GOOD_CGM_XML])
    const c = cachedClient()
    await expect(xmlCall(c)).rejects.toThrow(/예상 밖 응답/)
    await expect(xmlCall(c)).resolves.toContain("<CgmExpc>")
    expect(s.count()).toBe(2)
  })

  it("[반대 대조] getAdminRule 중간 절단은 complete 훅이 막아 이미 회복된다", async () => {
    const s = stubSequence([ADMRUL_TRUNCATED, ADMRUL_BODY])
    const c = cachedClient()
    await expect(c.getAdminRule("2100000277992")).rejects.toThrow(/끊긴 응답/)
    await expect(c.getAdminRule("2100000277992")).resolves.toContain("</AdmRulService>")
    expect(s.count()).toBe(2)
  })

  it("isCacheableBody의 실제 통과 범위 — 루트 불일치 본문은 전부 통과한다(그래서 담긴다)", () => {
    // blacklist가 막는 것
    expect(isCacheableBody("")).toBe(false)
    expect(isCacheableBody(ERROR_XML)).toBe(false)
    expect(isCacheableBody('{"error":"x"}')).toBe(false)
    expect(isCacheableBody("<!DOCTYPE html><html></html>")).toBe(false)
    // blacklist가 막지 못하는 것 = 이번 결함의 입력들
    expect(isCacheableBody(WRONG_JSON_ROOT)).toBe(true)
    expect(isCacheableBody(WRONG_XML_ROOT)).toBe(true)
    expect(isCacheableBody(ADMRUL_TRUNCATED)).toBe(true)
    // 법제처가 XML 선언 뒤에 HTML을 붙여 주는 변형도 통과한다 (checkHtmlError가 뒤에서 잡는다)
    expect(isCacheableBody('<?xml version="1.0"?><html><body>점검 중</body></html>')).toBe(true)
  })
})

// ── ② deletedArticleStamp 중복 wrapper ───────────────────────────────────

/** lawService JSON 조문단위 한 건 */
const unitJson = (unit: Record<string, unknown>) =>
  JSON.stringify({ 법령: { 조문: { 조문단위: [{ 조문여부: "조문", ...unit }] } } })

const LAW_SEARCH_BUPIN = GOOD_LAW_SEARCH_XML
const EMPTY_ADMRUL = '<?xml version="1.0"?><AdmRulSearch><totalCnt>0</totalCnt></AdmRulSearch>'

/** verify·article 양쪽에 같은 조문단위를 먹이는 최소 stub (실 네트워크 없음) */
function dualStub(articleJsonText: string): LawApiClient {
  return {
    searchLaw: async () => LAW_SEARCH_BUPIN,
    fetchApi: async (p: { endpoint: string; target: string }) => {
      if (p.endpoint === "lawSearch.do") {
        return p.target === "ntsCgmExpc"
          ? '<?xml version="1.0"?><CgmExpc><totalCnt>0</totalCnt></CgmExpc>'
          : '<?xml version="1.0"?><LawSearch><totalCnt>0</totalCnt></LawSearch>'
      }
      return articleJsonText
    },
    getThreeTier: async () => "{}",
    getAnnexes: async () => "{}",
    searchAdminRule: async () => EMPTY_ADMRUL,
  } as unknown as LawApiClient
}

const verdictLines = (text: string) => text.split("\n").filter((l) => /^[✓✗⚠⌛]\s/.test(l.trim()))

/** (라벨, 조문단위, 삭제로 판정되어야 하는가) — 두 wrapper가 같은 답을 내야 한다 */
const CASES: Array<{ name: string; unit: Record<string, unknown>; deleted: boolean }> = [
  {
    name: "전체 삭제 · 항 없음 (실응답 형태)",
    unit: { 조문번호: "39", 조문내용: "제39조 삭제 <2001.12.31>" },
    deleted: true,
  },
  {
    name: "전체 삭제 · 항이 빈 배열",
    unit: { 조문번호: "39", 조문내용: "제39조 삭제 <2001.12.31>", 항: [] },
    deleted: true,
  },
  {
    name: "전체 삭제 · 항이 빈 문자열",
    unit: { 조문번호: "39", 조문내용: "제39조 삭제 <2001.12.31>", 항: "" },
    deleted: true,
  },
  {
    name: "전체 삭제 · 조문내용이 배열 (두 wrapper 모두 Array 분기를 갖고 있다)",
    unit: { 조문번호: "39", 조문내용: ["제39조 삭제", "<2001.12.31>"] },
    deleted: true,
  },
  {
    name: "부분 삭제 · 항 하나만 삭제 (살아 있는 조문)",
    unit: {
      조문번호: "18",
      조문제목: "수입배당금액의 익금불산입",
      조문내용: "제18조(수입배당금액의 익금불산입)",
      항: [
        { 항번호: "①", 항내용: "① 내국법인이 … 익금에 산입하지 아니한다." },
        { 항번호: "②", 항내용: "② 삭제 <2022.12.31>" },
      ],
    },
    deleted: false,
  },
  {
    name: "제목에 '삭제'라는 낱말만 든 조문 (살아 있는 조문)",
    unit: { 조문번호: "10", 조문제목: "등록의 삭제", 조문내용: "제10조(등록의 삭제) 관할 세무서장은 등록을 삭제한다." },
    deleted: false,
  },
]

describe("deletedArticleStamp 중복 wrapper — fin_verify(verify.ts:867)와 fin_article(article.ts:192)이 같은 답을 내는가", () => {
  for (const c of CASES) {
    it(`${c.name} → 양쪽 모두 ${c.deleted ? "삭제" : "정상"}`, async () => {
      process.env.FIN_CACHE_TTL_SEC = "0" // 두 호출이 법령 검색 캐시를 공유하지 않게
      const payload = unitJson(c.unit)
      const articleNo = `제${c.unit.조문번호}조`

      const v = await handleFinVerify(dualStub(payload), { text: `법인세법 ${articleNo}에 따른다.` })
      const vLine = verdictLines(v.content[0].text)[0] || ""
      const vDeleted = /\[사용 보류\] 삭제된 조문/.test(vLine)

      const a = await handleFinArticle(dualStub(payload), { law: "법인세법", article: articleNo, include_rulings: false })
      const aText = a.content[0].text
      const aDeleted = aText.includes("⚠삭제된 조문")

      expect(vDeleted, `fin_verify 판정 줄: ${vLine}`).toBe(c.deleted)
      expect(aDeleted, `fin_article 첫 줄: ${aText.split("\n")[0]}`).toBe(c.deleted)
      // 두 wrapper가 갈리면 훅은 ⚠인데 본문 조회는 정상으로 보이는 절반 수정이 된다
      expect(aDeleted, "두 도구의 삭제 판정이 갈렸다").toBe(vDeleted)
    })
  }
})
