/**
 * api-client 응답 가드·캐시 우회·재시도 계상 회귀 테스트 (fixture 기반 — CI 상시)
 *
 * Codex 9차 리뷰에서 확정된 결함:
 *  M3. getAdminRule·searchOrdinance는 XML로 고정만 되고 루트 가드가 없어, 200 + `<error>` 본문이
 *      소비자에서 "0건 (정상 조회 결과 없음)"으로 나갔다 (fin_annex 행정규칙 별표·fin_law_search 자치법규)
 *  P1. fin_ping이 캐시 적중(네트워크 없음)을 "통신: 성공"으로 보고했다 → searchLaw bypassCache
 *  재시도. 429 재시도가 분당 한도 토큰을 쓰지 않아 한도가 그 순간 사실상 3배로 풀렸다
 *
 * 각 결함마다 반대 방향(정상 응답은 그대로 통과·캐시는 평소대로 적중·404 재시도는 계상하지 않음)을 함께 박제한다.
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest"
import { LawApiClient } from "./api-client.js"
import { isCacheableBody } from "./response-cache.js"
import { maskSensitiveUrl } from "./fetch-with-retry.js"
import { handleFinLawSearch } from "../tools/law-search.js"
import { handleFinAnnex } from "../tools/annex.js"

const origFetch = globalThis.fetch
const ENV_KEYS = ["FIN_CACHE_TTL_SEC", "FIN_DRF_RATE_PER_MIN", "FIN_DRF_MAX_CONCURRENCY"] as const
const origEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) origEnv[k] = process.env[k]
  process.env.FIN_CACHE_TTL_SEC = "0"
})

afterEach(() => {
  globalThis.fetch = origFetch
  for (const k of ENV_KEYS) {
    if (origEnv[k] === undefined) delete process.env[k]
    else process.env[k] = origEnv[k]
  }
})

/** 법제처가 200으로 돌려주는 정상 형식 오류 XML */
const ERROR_XML = '<?xml version="1.0" encoding="UTF-8"?><error><message>일시 장애</message></error>'

/** 행정규칙 본문 정상 형태 (2026-09-16 실측: 루트 AdmRulService, 닫는 태그로 끝남) */
const ADMRUL_BODY = [
  '<?xml version="1.0" encoding="UTF-8"?><AdmRulService><행정규칙기본정보><행정규칙명>조사사무처리규정</행정규칙명>',
  "<조문형식여부>Y</조문형식여부></행정규칙기본정보>",
  "<별표번호>0001</별표번호><별표가지번호>01</별표가지번호><별표구분>별지</별표구분>",
  "<별표제목><![CDATA[세무조사 사전통지서]]></별표제목>",
  "<별표서식파일링크>/LSW/flDownload.do?flSeq=2</별표서식파일링크><별표내용><![CDATA[…]]></별표내용>",
  "</AdmRulService>",
].join("")

/** 전송이 중간에 끊긴 본문 — 루트는 맞지만 닫는 태그가 없다 */
const ADMRUL_TRUNCATED = ADMRUL_BODY.slice(0, ADMRUL_BODY.indexOf("<별표내용>"))

const ADMRUL_SEARCH =
  '<?xml version="1.0" encoding="UTF-8"?><AdmRulSearch><totalCnt>1</totalCnt><admrul id="1">' +
  "<행정규칙일련번호>2100000277992</행정규칙일련번호><행정규칙명>조사사무처리규정</행정규칙명>" +
  "<행정규칙종류>훈령</행정규칙종류><발령일자>20250101</발령일자><소관부처명>국세청</소관부처명></admrul></AdmRulSearch>"

/** 자치법규 검색 0건 — 2026-09-16 실측 루트 OrdinSearch */
const ORDIN_EMPTY =
  '<?xml version="1.0" encoding="UTF-8"?><OrdinSearch><target>ordin</target><section>ordinNm</section>' +
  "<totalCnt>0</totalCnt><page>1</page><numOfRows>0</numOfRows></OrdinSearch>"

const LAW_SEARCH_XML =
  '<?xml version="1.0" encoding="UTF-8"?><LawSearch><totalCnt>1</totalCnt><law id="1"><법령일련번호>1</법령일련번호>' +
  "<법령명한글>지방세특례제한법</법령명한글><법령구분명>법률</법령구분명><소관부처코드>1741000</소관부처코드>" +
  "<소관부처명>행정안전부</소관부처명><시행일자>20250101</시행일자><현행연혁코드>현행</현행연혁코드></law></LawSearch>"

function stubAll(route: (url: URL) => Response | Promise<Response>): { count: () => number } {
  let n = 0
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    n++
    return route(new URL(String(input)))
  }) as typeof fetch
  return { count: () => n }
}

const xml = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "application/xml" } })
const client = () => new LawApiClient({ apiKey: "dummy" })

describe("getAdminRule — 응답 가드 (Codex 9차 M3)", () => {
  it("200 + <error> 본문은 확인 실패로 throw한다", async () => {
    stubAll(() => xml(ERROR_XML))
    await expect(client().getAdminRule("2100000277992")).rejects.toThrow(/예상 밖 응답.*확인 실패/)
  })

  it("빈 본문은 throw한다", async () => {
    // fetchWithRetry의 빈 본문 재시도가 소진된 뒤의 메시지도 확인 실패다
    stubAll(() => xml(""))
    await expect(client().getAdminRule("1")).rejects.toThrow(/빈 (본문|응답)/)
  }, 15_000)

  it("닫는 태그 없이 끊긴 본문은 throw한다", async () => {
    stubAll(() => xml(ADMRUL_TRUNCATED))
    await expect(client().getAdminRule("2100000277992")).rejects.toThrow(/끊긴 응답/)
  })

  it("반대 방향: 정상 본문은 그대로 돌려준다", async () => {
    stubAll(() => xml(ADMRUL_BODY))
    await expect(client().getAdminRule("2100000277992")).resolves.toBe(ADMRUL_BODY)
  })

  it("끊긴 본문은 캐시에 담지 않는다 — 다음 조회가 새 응답을 받는다", async () => {
    process.env.FIN_CACHE_TTL_SEC = "600"
    let call = 0
    const s = stubAll(() => xml(++call === 1 ? ADMRUL_TRUNCATED : ADMRUL_BODY))
    const c = client()
    await expect(c.getAdminRule("2100000277992")).rejects.toThrow(/끊긴 응답/)
    await expect(c.getAdminRule("2100000277992")).resolves.toBe(ADMRUL_BODY)
    expect(s.count()).toBe(2)
    // 정상 본문은 담긴다 (반대 방향 — 캐시가 꺼지지 않았다)
    await c.getAdminRule("2100000277992")
    expect(s.count()).toBe(2)
  })
})

describe("searchOrdinance — 응답 가드 (Codex 9차 M3)", () => {
  it("200 + <error> 본문은 확인 실패로 throw한다", async () => {
    stubAll(() => xml(ERROR_XML))
    await expect(client().searchOrdinance({ query: "지방세 감면" })).rejects.toThrow(/예상 밖 응답/)
  })

  it("XML 선언 뒤 HTML 점검 페이지도 throw한다", async () => {
    stubAll(() => xml('<?xml version="1.0"?><html><body>점검 중</body></html>'))
    await expect(client().searchOrdinance({ query: "지방세 감면" })).rejects.toThrow(/HTML/)
  })

  it("반대 방향: 정상 0건(루트 OrdinSearch)은 그대로 통과한다", async () => {
    stubAll(() => xml(ORDIN_EMPTY))
    await expect(client().searchOrdinance({ query: "없는검색어" })).resolves.toContain("<totalCnt>0</totalCnt>")
  })
})

describe("가드 오류가 소비자에서 '0건'이 아니라 ⚠로 나온다 (Codex 9차 M3)", () => {
  it("fin_law_search include_ordinance — 자치법규 검색 오류는 ⚠ 조회 실패", async () => {
    stubAll((u) => {
      const t = u.searchParams.get("target")
      if (t === "ordin") return xml(ERROR_XML)
      if (t === "admrul") return xml('<?xml version="1.0"?><AdmRulSearch><totalCnt>0</totalCnt></AdmRulSearch>')
      return xml(LAW_SEARCH_XML)
    })
    const r = await handleFinLawSearch(client(), { query: "지방세특례제한법", include_ordinance: true })
    const text = r.content[0].text
    expect(text).toContain("■ 자치법규(조례) — ⚠ 조회 실패")
    expect(text).not.toContain("■ 자치법규(조례) — 0건")
  })

  it("반대 방향: 자치법규 정상 0건은 종전대로 0건", async () => {
    stubAll((u) => {
      const t = u.searchParams.get("target")
      if (t === "ordin") return xml(ORDIN_EMPTY)
      if (t === "admrul") return xml('<?xml version="1.0"?><AdmRulSearch><totalCnt>0</totalCnt></AdmRulSearch>')
      return xml(LAW_SEARCH_XML)
    })
    const r = await handleFinLawSearch(client(), { query: "지방세특례제한법", include_ordinance: true })
    expect(r.content[0].text).toContain("■ 자치법규(조례) — 0건")
  })

  const annexRoute = (body: string) => (u: URL) => {
    const t = u.searchParams.get("target")
    if (u.pathname.endsWith("lawSearch.do") && t === "admbyl") return new Response(JSON.stringify({ AdmBylSearch: { totalCnt: "0" } }), { status: 200 })
    if (u.pathname.endsWith("lawSearch.do") && t === "licbyl") return new Response(JSON.stringify({ LicBylSearch: { totalCnt: "0" } }), { status: 200 })
    if (u.pathname.endsWith("lawSearch.do") && t === "admrul") return xml(ADMRUL_SEARCH)
    if (u.pathname.endsWith("lawService.do") && t === "admrul") return xml(body)
    return xml(ERROR_XML)
  }

  it("fin_annex 행정규칙 폴백 — 본문이 <error>면 '0건'이 아니라 ⚠ 판정 불가", async () => {
    stubAll(annexRoute(ERROR_XML))
    const r = await handleFinAnnex(client(), { law: "조사사무처리규정", kind: "3" })
    const text = r.content[0].text
    expect(text).toContain("⚠ 판정 불가 (0건 아님)")
    expect(text).not.toContain("0건 (정상 조회 결과 없음)")
  })

  it("fin_annex 행정규칙 폴백 — 끊긴 본문도 ⚠ 판정 불가", async () => {
    stubAll(annexRoute(ADMRUL_TRUNCATED))
    const r = await handleFinAnnex(client(), { law: "조사사무처리규정", kind: "3" })
    expect(r.content[0].text).toContain("⚠ 판정 불가 (0건 아님)")
  })

  it("반대 방향: 정상 본문이면 별지 목록이 나온다", async () => {
    stubAll(annexRoute(ADMRUL_BODY))
    const r = await handleFinAnnex(client(), { law: "조사사무처리규정", kind: "3" })
    const text = r.content[0].text
    expect(text).toContain("세무조사 사전통지서")
    expect(text).not.toContain("판정 불가")
  })
})

describe("searchLaw bypassCache — fin_ping 거짓 성공 차단 (Codex 9차 P1)", () => {
  const OK = '<?xml version="1.0"?><LawSearch><totalCnt>1</totalCnt><law id="1"><법령명한글>법인세법</법령명한글></law></LawSearch>'

  it("캐시가 켜져 있어도 bypassCache 조회는 실제로 나가고, 법제처 장애를 그대로 받는다", async () => {
    process.env.FIN_CACHE_TTL_SEC = "600"
    let call = 0
    const s = stubAll(() => (++call === 1 ? xml(OK) : xml("<html><body>점검</body></html>", 200)))
    const c = client()
    await c.searchLaw("법인세법", undefined, 1, "law") // 일반 도구 호출이 캐시에 담는다
    await expect(c.searchLaw("법인세법", undefined, 1, "law", undefined, { bypassCache: true })).rejects.toThrow(/HTML/)
    expect(s.count()).toBeGreaterThanOrEqual(2)
  }, 15_000)

  it("반대 방향: bypassCache가 없으면 종전대로 캐시에서 답한다", async () => {
    process.env.FIN_CACHE_TTL_SEC = "600"
    const s = stubAll(() => xml(OK))
    const c = client()
    await c.searchLaw("법인세법", undefined, 1, "law")
    await c.searchLaw("법인세법", undefined, 1, "law")
    expect(s.count()).toBe(1)
    expect(c.cacheStats().hits).toBe(1)
  })
})

/**
 * ── R2 cache: 가드가 거부한 200 본문은 캐시에 담기지 않는다 ─────────────────────
 *
 * r1-boundaries 5-1(차단): `drfFetch`가 `isCacheableBody`만 보고 담고 루트/최상위 키 가드는
 * 그 **뒤** 호출부에서 돌았다. blacklist는 빈 본문·선두 HTML·`<error>`·`{"error":…}`만 막으므로
 * 법제처가 200으로 주는 **루트만 다른 본문**은 캐시에 들어갔고, TTL(기본 600초) 동안 같은 URL의
 * 모든 조회가 네트워크를 못 타고 같은 오류를 되풀이했다.
 *
 * 수정: 각 호출부의 가드를 `cacheOpts.complete`로 넘겨 **저장·적중·반환을 한 함수가 판정**한다.
 * 아래는 실제로 기존 가드가 거부하는 본문만 쓰고, 케이스마다 1회차 오류 → 2회차 회복 →
 * 3회차 캐시 적중과 물리 fetch 수를 함께 본다(캐시를 꺼서 통과시키는 가짜 수정 차단).
 */
describe("가드가 거부한 200 본문은 캐시에 담기지 않는다 (r1-boundaries 5-1)", () => {
  const GOOD_JSON = JSON.stringify({ 법령: { 조문: { 조문단위: [{ 조문여부: "조문", 조문번호: "26" }] } } })
  const GOOD_CGM = '<?xml version="1.0"?><CgmExpc><totalCnt>1</totalCnt><cgmExpc id="1"><안건명>예규</안건명></cgmExpc></CgmExpc>'
  // 별표 정상 응답 — licbyl 루트는 기존 fixture(:159 annexRoute)와 같은 이름만 쓴다.
  // assertAnnexJsonRoot는 target별 루트 allowlist가 아니라 "객체·비어 있지 않음·error 키 없음"이다
  const GOOD_ANNEX = JSON.stringify({ LicBylSearch: { totalCnt: "0" } })
  /** XML 선언이 앞에 붙은 HTML — `^\s*<html` 앵커를 빗나가 blacklist를 통과한다 */
  const HTML_AFTER_DECL = '<?xml version="1.0"?><html><body>시스템 점검 중입니다</body></html>'

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

  const CASES: Array<{
    name: string
    bad: string
    good: string
    message: RegExp
    run: (c: LawApiClient) => Promise<string>
  }> = [
    {
      name: "searchLaw — 루트 불일치(<AdmRulSearch>)",
      bad: '<?xml version="1.0"?><AdmRulSearch><totalCnt>0</totalCnt></AdmRulSearch>',
      good: LAW_SEARCH_XML,
      message: /예상 밖 응답\(루트 AdmRulSearch\)/,
      run: (c) => c.searchLaw("지방세특례제한법", undefined, 1, "law"),
    },
    {
      name: "fetchApi JSON — 최상위 키 불일치({\"Law\":{}} 42바이트 실측 형태)",
      bad: JSON.stringify({ Law: {} }),
      good: GOOD_JSON,
      message: /예상 밖 응답\(최상위 키: Law/,
      run: jsonCall,
    },
    {
      name: "fetchApi XML — expectedRoot=CgmExpc에 <LawSearch>",
      bad: '<?xml version="1.0"?><LawSearch><totalCnt>0</totalCnt></LawSearch>',
      good: GOOD_CGM,
      message: /예상 밖 응답\(루트 LawSearch\)/,
      run: xmlCall,
    },
    {
      name: "searchOrdinance — XML 선언 뒤 HTML 점검 페이지",
      bad: HTML_AFTER_DECL,
      good: ORDIN_EMPTY,
      message: /HTML 에러 페이지/,
      run: (c) => c.searchOrdinance({ query: "지방세 감면" }),
    },
    {
      name: "searchAdminRule — XML 선언 뒤 HTML 점검 페이지",
      bad: HTML_AFTER_DECL,
      good: ADMRUL_SEARCH,
      message: /HTML 에러 페이지/,
      run: (c) => c.searchAdminRule({ query: "조사사무처리규정" }),
    },
    {
      name: "getAdminRule — 중간에 끊긴 본문(닫는 태그 없음)",
      bad: ADMRUL_TRUNCATED,
      good: ADMRUL_BODY,
      message: /끊긴 응답/,
      run: (c) => c.getAdminRule("2100000277992"),
    },
    {
      // 종전 complete 훅은 닫는 태그만 봤다 — 닫는 태그가 있는 오류 본문은 그대로 담겼다
      name: "getAdminRule — 닫는 태그는 있으나 루트가 다름",
      bad: '<?xml version="1.0"?><AdmRulSearch><totalCnt>0</totalCnt></AdmRulService>',
      good: ADMRUL_BODY,
      message: /예상 밖 응답\(루트 AdmRulSearch\)/,
      run: (c) => c.getAdminRule("2100000277992"),
    },
    {
      name: "getAdminRule — 닫는 태그는 있으나 본문이 HTML",
      bad: '<?xml version="1.0"?><html><body>점검 중</body></html></AdmRulService>',
      good: ADMRUL_BODY,
      message: /HTML 에러 페이지/,
      run: (c) => c.getAdminRule("2100000277992"),
    },
    {
      name: "getAnnexes — 빈 JSON 객체",
      bad: "{}",
      good: GOOD_ANNEX,
      message: /오류 응답\(최상위 키: 없음\)/,
      run: (c) => c.getAnnexes({ lawName: "법인세법" }),
    },
    {
      name: "getAnnexes — JSON 파싱 실패",
      bad: '{ "별표목록": ',
      good: GOOD_ANNEX,
      message: /파싱하지 못했습니다/,
      run: (c) => c.getAnnexes({ lawName: "법인세법" }),
    },
    {
      // blacklist의 JSON 규칙은 `{"error"…`로 **시작**할 때만 막는다 — 첫 키가 아니면 통과한다
      name: "getAnnexes — 첫 키가 아닌 error 키",
      bad: JSON.stringify({ totalCnt: "0", error: "미신청된 목록입니다" }),
      good: GOOD_ANNEX,
      message: /오류 응답\(최상위 키: totalCnt, error\)/,
      run: (c) => c.getAnnexes({ lawName: "법인세법" }),
    },
    {
      // blacklist의 HTML 규칙은 `^\s*<html` 앵커라 XML 선언이 앞에 붙으면 통과한다
      name: "getAnnexes — XML 선언 뒤 HTML(미신청 안내 페이지 형태)",
      bad: HTML_AFTER_DECL,
      good: GOOD_ANNEX,
      message: /HTML 페이지를 반환했습니다/,
      run: (c) => c.getAnnexes({ lawName: "법인세법" }),
    },
  ]

  for (const c of CASES) {
    it(`${c.name} — 1회차 오류 → 2회차 회복 → 3회차 적중`, async () => {
      process.env.FIN_CACHE_TTL_SEC = "600"
      let n = 0
      const s = stubAll(() => xml(++n === 1 ? c.bad : c.good))
      const cl = client()

      await expect(c.run(cl)).rejects.toThrow(c.message)
      expect(s.count(), "1회차가 한 번에 끝나지 않았다").toBe(1)

      await expect(c.run(cl)).resolves.toBeTruthy()
      expect(s.count(), "2회차가 네트워크를 타지 않았다 — 거부된 본문이 캐시에 남아 있다").toBe(2)

      await expect(c.run(cl)).resolves.toBeTruthy()
      expect(s.count(), "3회차가 캐시에 적중하지 않았다 — 정상 본문까지 안 담겼다(캐시를 끈 수정)").toBe(2)
      expect(cl.cacheStats().hits, "정상 본문 적중이 통계에 안 잡혔다").toBe(1)
    })
  }

  it("blacklist(isCacheableBody)만으로는 위 본문들을 막지 못한다 — 가드 배선이 필요한 이유", () => {
    expect(isCacheableBody('<?xml version="1.0"?><AdmRulSearch><totalCnt>0</totalCnt></AdmRulSearch>')).toBe(true)
    expect(isCacheableBody(JSON.stringify({ Law: {} }))).toBe(true)
    expect(isCacheableBody(HTML_AFTER_DECL)).toBe(true)
    expect(isCacheableBody('<?xml version="1.0"?><AdmRulSearch><totalCnt>0</totalCnt></AdmRulService>')).toBe(true)
    expect(isCacheableBody(ADMRUL_TRUNCATED)).toBe(true)
    expect(isCacheableBody("{}")).toBe(true)
    expect(isCacheableBody(JSON.stringify({ totalCnt: "0", error: "미신청된 목록입니다" }))).toBe(true)
    // 반대 방향 — blacklist가 이미 막는 것은 그대로 막는다
    expect(isCacheableBody(ERROR_XML)).toBe(false)
    expect(isCacheableBody('{"error":"x"}')).toBe(false)
  })

  it("가드가 있어도 정상 0건은 종전대로 담긴다 (네거티브 캐시 보존)", async () => {
    process.env.FIN_CACHE_TTL_SEC = "600"
    const s = stubAll(() => xml('<?xml version="1.0"?><AdmRulSearch><totalCnt>0</totalCnt></AdmRulSearch>'))
    const c = client()
    await expect(c.searchAdminRule({ query: "없는규칙" })).resolves.toContain("<totalCnt>0</totalCnt>")
    await expect(c.searchAdminRule({ query: "없는규칙" })).resolves.toContain("<totalCnt>0</totalCnt>")
    expect(s.count(), "정상 0건이 캐시되지 않았다").toBe(1)
  })

  it("FIN_CACHE_TTL_SEC=0이면 가드를 통과한 정상 본문도 담지 않는다 (진단용 탈출구 보존)", async () => {
    process.env.FIN_CACHE_TTL_SEC = "0"
    const s = stubAll(() => xml(LAW_SEARCH_XML))
    const c = client()
    await expect(c.searchLaw("지방세특례제한법", undefined, 1, "law")).resolves.toContain("<LawSearch>")
    await expect(c.searchLaw("지방세특례제한법", undefined, 1, "law")).resolves.toContain("<LawSearch>")
    expect(s.count(), "TTL=0인데 캐시가 동작했다").toBe(2)
    expect(c.cacheStats().hits).toBe(0)
  })

  it("bypassCache는 읽기만 건너뛴다 — 가드를 통과한 정상 본문은 담아 다음 일반 조회가 적중한다", async () => {
    process.env.FIN_CACHE_TTL_SEC = "600"
    const s = stubAll(() => xml(LAW_SEARCH_XML))
    const c = client()
    await expect(c.searchLaw("지방세특례제한법", undefined, 1, "law")).resolves.toContain("<LawSearch>")
    expect(s.count()).toBe(1)
    // fin_ping 경로(6번째 인자) — 캐시가 있어도 네트워크를 탄다
    await expect(
      c.searchLaw("지방세특례제한법", undefined, 1, "law", undefined, { bypassCache: true })
    ).resolves.toContain("<LawSearch>")
    expect(s.count(), "bypassCache가 캐시 적중으로 끝났다 — ping이 거짓 성공을 보고한다").toBe(2)
    // 일반 조회는 적중한다
    await expect(c.searchLaw("지방세특례제한법", undefined, 1, "law")).resolves.toContain("<LawSearch>")
    expect(s.count()).toBe(2)
  })

  /**
   * drfFetch 계약: complete가 false를 돌려주든 던지든 "거부"다 — 담지 않고, drfFetch 자신은
   * 던지지 않는다(오류는 호출부의 같은 가드가 기존 한국어 메시지로 올린다).
   * private 메서드라 형 단언으로 직접 부른다 — 현재 production 가드는 모두 throw 형이다
   */
  it("complete가 false를 돌려주거나 던지면 담지 않고, drfFetch 자신은 던지지 않는다", async () => {
    process.env.FIN_CACHE_TTL_SEC = "600"
    const s = stubAll(() => xml(LAW_SEARCH_XML))
    const c = client()
    const drf = (c as unknown as {
      drfFetch: (u: string, o?: unknown, co?: { complete?: (t: string) => boolean | void }) => Promise<Response>
    }).drfFetch.bind(c)
    const url = "https://www.law.go.kr/DRF/lawSearch.do?target=law&query=r2cache"

    const r1 = await drf(url, undefined, { complete: () => false })
    expect(await r1.text(), "거부해도 본문은 호출부로 전달돼야 한다").toContain("<LawSearch>")
    const r2 = await drf(url, undefined, {
      complete: () => {
        throw new Error("가드 거부")
      },
    })
    expect(await r2.text()).toContain("<LawSearch>")
    expect(s.count(), "거부된 본문이 캐시에 담겼다").toBe(2)
    // 가드가 없는 호출은 종전대로 담고, 다음 호출이 적중한다
    await drf(url)
    await drf(url)
    expect(s.count()).toBe(3)
  })

  it("bypassCache 조회도 거부된 본문은 담지 않는다 — 진단이 캐시를 오염시키지 않는다", async () => {
    process.env.FIN_CACHE_TTL_SEC = "600"
    let n = 0
    const s = stubAll(() =>
      xml(++n === 1 ? '<?xml version="1.0"?><AdmRulSearch><totalCnt>0</totalCnt></AdmRulSearch>' : LAW_SEARCH_XML)
    )
    const c = client()
    // fin_ping 경로(6번째 인자) — 읽기만 건너뛰고 쓰기는 한다
    await expect(c.searchLaw("지방세특례제한법", undefined, 1, "law", undefined, { bypassCache: true })).rejects.toThrow(
      /예상 밖 응답/
    )
    // 일반 도구 호출이 그 오염 본문을 쓰면 안 된다
    await expect(c.searchLaw("지방세특례제한법", undefined, 1, "law")).resolves.toContain("<LawSearch>")
    expect(s.count()).toBe(2)
  })

  it("fetchApi type=HTML(lsHistory)은 정상 성공하고 재시도로 증폭되지 않는다", async () => {
    process.env.FIN_CACHE_TTL_SEC = "600"
    const s = stubAll(() => new Response("<html><body><table>연혁</table></body></html>", { status: 200 }))
    const c = client()
    await expect(
      c.fetchApi({ endpoint: "lawSearch.do", target: "lsHistory", type: "HTML", extraParams: { query: "법인세법" } })
    ).resolves.toContain("연혁")
    expect(s.count(), "정상 HTML에 재시도가 붙었다").toBe(1)
    // HTML 본문은 종전대로 blacklist에서 걸러져 담기지 않는다 (이번 수정이 바꾸지 않은 계약)
    await expect(
      c.fetchApi({ endpoint: "lawSearch.do", target: "lsHistory", type: "HTML", extraParams: { query: "법인세법" } })
    ).resolves.toContain("연혁")
    expect(s.count()).toBe(2)
  })
})

/**
 * 캐시 키는 요청 URL뿐이고 expectedRoot·expectedJsonKey는 URL에 들어가지 않는다.
 * 같은 URL을 느슨하게 한 번, 엄격하게 한 번 부르는 경로가 실제로 있다:
 *   느슨 = `historical-utils.ts:60 fetchEffectiveSlices`(eflaw, expectedRoot 없음,
 *          `resolveVersionAt`이 `"19000101"~기준일`로 호출)
 *   엄격 = `tools/law-search.ts:155`(같은 endpoint·target·type·extraParams 순서 + expectedRoot)
 * 두 호출의 URL이 문자 단위로 같으므로, 저장 시점 가드만 고치면 엄격한 쪽이 느슨한 쪽의
 * 본문을 검증 없이 받는다.
 */
describe("같은 URL·다른 가드 — 느슨한 호출이 담은 본문을 엄격한 호출이 그대로 쓰면 안 된다", () => {
  const WRONG_ROOT = '<?xml version="1.0"?><AdmRulSearch><totalCnt>0</totalCnt></AdmRulSearch>'
  const args = {
    endpoint: "lawSearch.do" as const,
    target: "eflaw",
    type: "XML" as const,
    extraParams: { query: "지방세특례제한법", display: "100", efYd: "19000101~20250101" },
  }

  it("적중을 거부하고 재조회한다 — 장애가 이어지면 기존 한국어 오류, 걷히면 회복", async () => {
    process.env.FIN_CACHE_TTL_SEC = "600"
    let down = true
    // 단언이 깨지면 vitest가 이 값을 출력한다 — OC를 마스킹해 두지 않으면
    // LAW_OC가 실제로 설정된 환경에서 실키가 로그로 나간다
    const urls: string[] = []
    const s = stubAll((u) => {
      urls.push(maskSensitiveUrl(u.toString()))
      return xml(down ? WRONG_ROOT : LAW_SEARCH_XML)
    })
    const c = client()

    // ① 가드 없는 호출 — 거부 조건이 없으므로 통과하고 캐시에 담긴다
    await expect(c.fetchApi(args)).resolves.toContain("AdmRulSearch")
    expect(s.count()).toBe(1)

    // ② 같은 URL + expectedRoot — 적중을 검증해 거부하고 다시 조회한다 (여전히 장애)
    await expect(c.fetchApi({ ...args, expectedRoot: "LawSearch" })).rejects.toThrow(/예상 밖 응답\(루트 AdmRulSearch\)/)
    expect(s.count(), "엄격한 호출이 느슨한 호출의 캐시를 그대로 썼다").toBe(2)
    expect(urls[0], "두 호출의 캐시 키(URL)가 달라 재현이 성립하지 않는다").toBe(urls[1])
    expect(urls[0]).not.toContain("expectedRoot")
    // 거부된 적중은 hit이 아니라 miss로 센다
    expect(c.cacheStats().hits).toBe(0)

    // ③ 장애가 걷히면 회복하고, 그 정상 본문은 담긴다
    down = false
    await expect(c.fetchApi({ ...args, expectedRoot: "LawSearch" })).resolves.toContain("<LawSearch>")
    expect(s.count()).toBe(3)
    await expect(c.fetchApi({ ...args, expectedRoot: "LawSearch" })).resolves.toContain("<LawSearch>")
    expect(s.count(), "회복 뒤 정상 본문이 캐시되지 않았다").toBe(3)

    // ④ 반대 방향 — 엄격한 호출이 담은 정상 본문은 느슨한 호출도 그대로 쓴다
    await expect(c.fetchApi(args)).resolves.toContain("<LawSearch>")
    expect(s.count()).toBe(3)
  })
})

describe("DRF 재시도 — 429 계상·Retry-After 상한 (Codex 9차)", () => {
  const OK = '<?xml version="1.0"?><LawSearch><totalCnt>0</totalCnt></LawSearch>'

  it("분당 토큰이 없으면 429를 재시도하지 않고 한도 초과로 올린다", async () => {
    process.env.FIN_DRF_RATE_PER_MIN = "1" // 첫 호출이 유일한 토큰을 쓴다
    let call = 0
    const s = stubAll(() => (++call === 1 ? new Response("too many", { status: 429 }) : xml(OK)))
    await expect(client().searchLaw("법인세법")).rejects.toThrow(/한도 초과 \(429\)/)
    expect(s.count()).toBe(1)
  })

  it("반대 방향: 토큰이 남아 있으면 429도 종전대로 재시도해 회복한다", async () => {
    process.env.FIN_DRF_RATE_PER_MIN = "100"
    let call = 0
    const s = stubAll(() => (++call === 1 ? new Response("too many", { status: 429 }) : xml(OK)))
    await expect(client().searchLaw("법인세법")).resolves.toContain("LawSearch")
    expect(s.count()).toBe(2)
  }, 15_000)

  it("반대 방향: 404(버스트 간헐 오류) 재시도는 토큰이 없어도 계상하지 않는다", async () => {
    process.env.FIN_DRF_RATE_PER_MIN = "1"
    let call = 0
    const s = stubAll(() => (++call === 1 ? new Response("not found", { status: 404 }) : xml(OK)))
    await expect(client().searchLaw("법인세법")).resolves.toContain("LawSearch")
    expect(s.count()).toBe(2)
  }, 15_000)

  it("Retry-After가 3초를 넘으면 기다리지 않고 429로 끝낸다 (타임아웃으로 위장되지 않음)", async () => {
    process.env.FIN_DRF_RATE_PER_MIN = "100"
    const s = stubAll(() => new Response("too many", { status: 429, headers: { "Retry-After": "30" } }))
    const t0 = Date.now()
    await expect(client().searchLaw("법인세법")).rejects.toThrow(/한도 초과 \(429\)/)
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(s.count()).toBe(1)
  })
})
