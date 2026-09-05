/**
 * 행정규칙 검색(searchAdminRule) 오류 응답 가드 회귀 테스트 (fixture 기반 — CI 상시)
 *
 * Codex 8차 [중요]: `searchAdminRule`에만 루트 검증이 없었다. 법제처가 200 +
 * `<error>…</error>`를 돌려주면
 *   ① abolished-laws의 연혁 조회(nw=2)에서 parseAdmrulHistoryXml이 빈 배열을 내고
 *   ② "해당없음"("")이 lawCache에 TTL(1시간) 동안 네거티브 캐시로 굳고
 *   ③ admin-rule-citation이 그 null을 "폐지 이력도 없음"으로 읽어 실존·폐지 행정규칙에
 *      하드 ✗ NOT_FOUND를 찍었다.
 * 재현 조건은 "현행 검색은 정상 0건, 연혁(nw=2) 호출만 오류 본문"이다.
 *
 * 반대 방향도 함께 박제한다: **정상 0건**(루트는 맞고 항목이 0개)은 여전히 ""로
 * 캐시되어야 한다. 이게 깨지면 네거티브 캐시가 통째로 무력화된다.
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest"
import { LawApiClient } from "./api-client.js"
import { detectAbolishedAdminRule } from "./abolished-laws.js"
import { lawCache } from "./cache.js"

const QUERY = "월별납부제도 운영에 관한 고시"
const CACHE_KEY = `abolished-admrul:${QUERY.toLowerCase().trim()}`

/** 법제처가 200으로 돌려주는 정상 형식 오류 XML */
const ERROR_XML =
  '<?xml version="1.0" encoding="UTF-8"?><error><code>500</code>' +
  "<message>서비스 처리 중 오류가 발생하였습니다.</message></error>"

/** 정상 0건 — 루트는 맞고 항목만 없다 (네거티브 캐시 대상) */
const EMPTY_HIT_XML = '<?xml version="1.0" encoding="UTF-8"?><AdmRulSearch><totalCnt>0</totalCnt></AdmRulSearch>'

/**
 * XML 선언 뒤에 오는 HTML 점검 페이지.
 * 본문이 `<html`로 시작하지 않아 fetchWithRetry의 detectBadBody를 통과한다 —
 * api-client의 checkHtmlError가 잡아야 하는 자리다.
 */
const HTML_AFTER_DECL = '<?xml version="1.0" encoding="UTF-8"?><html><body>시스템 점검 중입니다</body></html>'

/** 폐지 연혁 정상 응답 (장애 복구 확인용) */
const ADMRUL_HISTORY_XML =
  '<?xml version="1.0"?><AdmRulSearch><totalCnt>2</totalCnt>' +
  `<admrul><행정규칙명>${QUERY}</행정규칙명><행정규칙일련번호>111</행정규칙일련번호>` +
  "<행정규칙ID>A1</행정규칙ID><발령일자>20200101</발령일자><제개정구분명>일부개정</제개정구분명>" +
  "<현행연혁구분>연혁</현행연혁구분><행정규칙종류>고시</행정규칙종류><소관부처명>국세청</소관부처명></admrul>" +
  `<admrul><행정규칙명>${QUERY}</행정규칙명><행정규칙일련번호>222</행정규칙일련번호>` +
  "<행정규칙ID>A1</행정규칙ID><발령일자>20241211</발령일자><제개정구분명>폐지</제개정구분명>" +
  "<현행연혁구분>연혁</현행연혁구분><행정규칙종류>고시</행정규칙종류><소관부처명>국세청</소관부처명></admrul>" +
  "</AdmRulSearch>"

const ADMRUL_BODY_XML =
  '<?xml version="1.0"?><AdmRulService><제개정이유><![CDATA[' +
  "「징수업무 처리에 관한 고시」로 통ㆍ폐합하여 이 고시를 폐지함." +
  "]]></제개정이유></AdmRulService>"

const origFetch = globalThis.fetch
const origTtl = process.env.FIN_CACHE_TTL_SEC

const origResponseType = process.env.LAW_RESPONSE_TYPE

let searchCalls = 0
let lastSearchUrl = ""

/** 검색(lawSearch.do) 본문만 바꿔 가며 stub — 본문 조회(lawService.do)는 항상 정상 */
function stubSearch(bodyFor: () => string): void {
  searchCalls = 0
  lastSearchUrl = ""
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes("lawService.do")) {
      return new Response(ADMRUL_BODY_XML, { status: 200, headers: { "content-type": "application/xml" } })
    }
    searchCalls++
    lastSearchUrl = url
    return new Response(bodyFor(), { status: 200, headers: { "content-type": "application/xml" } })
  }) as typeof fetch
}

const client = () => new LawApiClient({ apiKey: "dummy" })

beforeEach(() => {
  lawCache.clear()
  // 응답 본문 캐시도 켠 상태로 검증한다 — 두 계층이 함께 "실패는 담지 않는다"를 지켜야 한다
  process.env.FIN_CACHE_TTL_SEC = "600"
})

afterEach(() => {
  globalThis.fetch = origFetch
  lawCache.clear()
  if (origTtl === undefined) delete process.env.FIN_CACHE_TTL_SEC
  else process.env.FIN_CACHE_TTL_SEC = origTtl
  if (origResponseType === undefined) delete process.env.LAW_RESPONSE_TYPE
  else process.env.LAW_RESPONSE_TYPE = origResponseType
})

describe("searchAdminRule — 200 오류 응답 가드", () => {
  it("<error> 본문은 '0건'이 아니라 throw다", async () => {
    stubSearch(() => ERROR_XML)
    await expect(client().searchAdminRule({ query: QUERY, nw: "2" })).rejects.toThrow(/예상 밖 응답/)
  })

  it("오류 메시지가 '0건이 아니라 확인 실패'임을 명시한다", async () => {
    stubSearch(() => ERROR_XML)
    await expect(client().searchAdminRule({ query: QUERY, nw: "2" })).rejects.toThrow(/확인 실패/)
  })

  it("XML 선언 뒤에 붙은 HTML 점검 페이지도 throw다", async () => {
    stubSearch(() => HTML_AFTER_DECL)
    await expect(client().searchAdminRule({ query: QUERY, nw: "2" })).rejects.toThrow(/HTML 에러 페이지/)
  })

  it("빈 본문은 '0건'이 아니라 throw다", async () => {
    stubSearch(() => "")
    await expect(client().searchAdminRule({ query: QUERY, nw: "2" })).rejects.toThrow()
  })

  it("[반대 방향] 정상 0건은 루트가 맞으므로 그대로 통과한다", async () => {
    stubSearch(() => EMPTY_HIT_XML)
    await expect(client().searchAdminRule({ query: QUERY, nw: "2" })).resolves.toContain("<totalCnt>0</totalCnt>")
  })

  it("[반대 방향] 정상 검색 결과도 그대로 통과한다", async () => {
    stubSearch(() => ADMRUL_HISTORY_XML)
    await expect(client().searchAdminRule({ query: QUERY, nw: "2" })).resolves.toContain("행정규칙일련번호")
  })

  it("LAW_RESPONSE_TYPE=JSON이어도 type=XML로 나가고 가드가 켜진다", async () => {
    // 이 경로의 소비자(parseAdmrulHistoryXml·findAdminRule)가 XML 전용이라
    // JSON 우회를 적용하면 정상 응답조차 "0건"으로 위장된다 — 응답 타입을 고정했다
    process.env.LAW_RESPONSE_TYPE = "JSON"
    stubSearch(() => ERROR_XML)
    await expect(client().searchAdminRule({ query: QUERY, nw: "2" })).rejects.toThrow(/예상 밖 응답/)
    expect(lastSearchUrl).toContain("type=XML")
    expect(lastSearchUrl).not.toContain("type=JSON")
  })
})

describe("detectAbolishedAdminRule — 연혁 오류 응답은 캐시되지 않는다", () => {
  it("(a) <error> 본문: throw + 캐시 미저장 + 두 번째 호출이 다시 네트워크를 탄다", async () => {
    stubSearch(() => ERROR_XML)
    const c = client()

    await expect(detectAbolishedAdminRule(c, QUERY)).rejects.toThrow(/행정규칙 연혁 조회 실패/)
    expect(lawCache.get<string>(CACHE_KEY), "실패가 네거티브 캐시로 굳었다").toBeNull()

    // Codex 프로브의 {one:null,two:null,calls:1} — 두 번째가 캐시 히트로 조용히 null이 되면 안 된다
    await expect(detectAbolishedAdminRule(c, QUERY)).rejects.toThrow(/행정규칙 연혁 조회 실패/)
    expect(searchCalls, "두 번째 호출이 캐시에 막혀 네트워크를 타지 않았다").toBe(2)
  })

  it("(a-2) 장애가 걷히면 같은 클라이언트로 폐지 이력을 정상 반환한다", async () => {
    let down = true
    stubSearch(() => (down ? ERROR_XML : ADMRUL_HISTORY_XML))
    const c = client()

    await expect(detectAbolishedAdminRule(c, QUERY)).rejects.toThrow(/행정규칙 연혁 조회 실패/)
    down = false
    const note = await detectAbolishedAdminRule(c, QUERY)
    expect(note).toContain("[폐지]")
    expect(note).toContain("징수업무 처리에 관한 고시")
  })

  it("(b) [반대 방향] 정상 0건은 여전히 \"\"로 네거티브 캐시된다", async () => {
    stubSearch(() => EMPTY_HIT_XML)

    expect(await detectAbolishedAdminRule(client(), QUERY)).toBeNull()
    expect(lawCache.get<string>(CACHE_KEY), "정상 0건 네거티브 캐시가 사라졌다").toBe("")

    // 새 클라이언트 = 응답 본문 캐시는 비어 있다 — 그래도 네트워크를 타지 않아야
    // 파싱 결과 캐시(lawCache)가 살아 있다는 증거가 된다
    expect(await detectAbolishedAdminRule(client(), QUERY)).toBeNull()
    expect(searchCalls, "네거티브 캐시가 무력화돼 재조회가 발생했다").toBe(1)
  })

  it("(c) HTML 본문: throw + 캐시 미저장", async () => {
    stubSearch(() => HTML_AFTER_DECL)

    await expect(detectAbolishedAdminRule(client(), QUERY)).rejects.toThrow(/행정규칙 연혁 조회 실패/)
    expect(lawCache.get<string>(CACHE_KEY)).toBeNull()
  })
})
