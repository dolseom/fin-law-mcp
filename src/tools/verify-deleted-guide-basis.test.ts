/**
 * 9차 적대적 리뷰 확정 결함 회귀 — fin_verify 판정 계약 (fixture, 실 API 없음)
 *
 *  B1 [차단] 삭제된 조문("제39조 삭제 <2001.12.31>")에 확신형 ✓ — 조문단위가 왔다는 것만 봤다
 *  B2 [차단] 기본통칙 인용을 전부 ✗ "존재하지 않는 규칙"으로 단정 — 법제처 DB에 기본통칙이 없다
 *  I1 [중요] basis_date가 행정규칙 경로에 전달되지 않아 현행 대조가 기준일 판정으로 나갔다
 *  E6       basis_date를 줬는데 폐지 법령 안내가 "basis_date를 지정하라"를 되풀이했다
 *  E7       출력 예산 8,000자 계산 — 판정 라인이 truncateWithHint에 잘리면 훅이 미검증으로 오보한다
 *
 * 결함마다 반대 방향(정상 경로 유지)을 함께 박제한다 — 이 저장소에서 한 방향 수정의
 * 반작용이 일곱 라운드 연속 났다.
 */

import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from "vitest"
import { extractCitations, handleFinVerify, FIN_VERIFY_TOOL } from "./verify.js"
import { LawApiClient } from "../lib/api-client.js"

// 같은 파일 안 테스트끼리 법령 검색 캐시(lawCache)를 공유하면 stub이 달라도 앞 테스트 결과가 남는다
const origTtl = process.env.FIN_CACHE_TTL_SEC
beforeAll(() => {
  process.env.FIN_CACHE_TTL_SEC = "0"
})
afterAll(() => {
  if (origTtl === undefined) delete process.env.FIN_CACHE_TTL_SEC
  else process.env.FIN_CACHE_TTL_SEC = origTtl
})
afterEach(() => vi.unstubAllGlobals())

const EMPTY_LAW_XML = '<?xml version="1.0"?><LawSearch><totalCnt>0</totalCnt></LawSearch>'
const ADMRUL_EMPTY_XML = '<?xml version="1.0"?><AdmRulSearch><totalCnt>0</totalCnt></AdmRulSearch>'

const lawXml = (laws: Array<{ name: string; mst: string; status?: string; efYd?: string }>) =>
  `<?xml version="1.0"?><LawSearch><totalCnt>${laws.length}</totalCnt>` +
  laws
    .map(
      (l, i) =>
        `<law id="${i + 1}"><법령명한글>${l.name}</법령명한글><법령ID>${1563 + i}</법령ID>` +
        `<법령일련번호>${l.mst}</법령일련번호><법령구분명>법률</법령구분명>` +
        `<현행연혁코드>${l.status || "현행"}</현행연혁코드><시행일자>${l.efYd || "20260701"}</시행일자></law>`
    )
    .join("") +
  "</LawSearch>"

const articleJson = (unit: Record<string, unknown>) => JSON.stringify({ 법령: { 조문: { 조문단위: [unit] } } })

/** 법인세법 JO=003900 실응답 그대로 (2026-09-16 라이브, MST 280349) */
const DELETED_39 = {
  조문번호: "39",
  조문시행일자: "20260101",
  조문변경여부: "N",
  조문이동이전: "",
  조문키: "0039001",
  조문내용: "제39조 삭제 <2001.12.31>",
  조문이동이후: "",
  조문여부: "조문",
}
const LIVE_26 = {
  조문여부: "조문",
  조문번호: "26",
  조문제목: "과다경비 등의 손금불산입",
  조문내용: "제26조(과다경비 등의 손금불산입) 다음 각 호의 손비 중 과다하거나 부당하다고 인정하는 금액은 …",
}

interface Routes {
  lawSearch?: (query: string) => string
  eflawSearch?: (query: string) => string
  lawService?: (params: URLSearchParams) => string
  admrulSearch?: (query: string, params: URLSearchParams) => string
  admrulBody?: (params: URLSearchParams) => string
}

function stubRoutes(r: Routes): string[] {
  const urls: string[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input)
      urls.push(url)
      const u = new URL(url)
      const p = u.searchParams
      const target = p.get("target")
      const query = p.get("query") || ""
      let body: string
      if (u.pathname.endsWith("lawService.do")) {
        body = target === "admrul" ? (r.admrulBody?.(p) ?? "") : (r.lawService?.(p) ?? JSON.stringify({ 법령: { 조문: {} } }))
      } else if (target === "admrul") {
        body = r.admrulSearch?.(query, p) ?? ADMRUL_EMPTY_XML
      } else if (target === "eflaw") {
        body = r.eflawSearch?.(query) ?? EMPTY_LAW_XML
      } else {
        body = r.lawSearch?.(query) ?? EMPTY_LAW_XML
      }
      return new Response(body, { status: 200 })
    })
  )
  return urls
}

const client = () => new LawApiClient({ apiKey: "testkey" })
const verdictLines = (text: string) => text.split("\n").filter((l) => /^[✓✗⚠⌛]\s/.test(l.trim()))

const BUPIN = [{ name: "법인세법", mst: "280349" }]

// ── B1 ─────────────────────────────────────────────────────────────────

describe("B1 삭제된 조문 — ✓ 금지, ⚠(사용 보류) [9차 차단]", () => {
  it("삭제 자리표시 조문(실응답 형태)은 ✓가 아니라 ⚠ 사용 보류다", async () => {
    stubRoutes({ lawSearch: () => lawXml(BUPIN), lawService: () => articleJson(DELETED_39) })
    const res = await handleFinVerify(client(), { text: "법인세법 제39조에 따라 손금에 산입한다." })
    const text = res.content[0].text
    expect(text).toContain("✓0 / ✗0 / ⚠1")
    const [line] = verdictLines(text)
    expect(line.startsWith("⚠ 법인세법 제39조 — [사용 보류] 삭제된 조문 (삭제 <2001.12.31>)")).toBe(true)
    expect(line).toContain("현행 근거로 쓸 수 없음")
    expect(line).toContain("basis_date") // 연혁 인용의 탈출구 안내
    expect(text).toContain("⚠️ 삭제된 조문 인용 있음")
    // 확인된 사실이지 "확인 실패"가 아니다 — 보류 헤더와도 섞지 않는다
    expect(text).not.toContain("부존재 확정")
    expect(text).not.toContain("사용 보류 인용 있음")
    // ✓ 고지는 ✓가 없으니 붙지 않는다
    expect(text).not.toContain("실존한다는 뜻입니다")
  })

  it("가지조문 삭제(제18조의3 삭제 <2022.12.31>)도 같다", async () => {
    stubRoutes({
      lawSearch: () => lawXml(BUPIN),
      lawService: () => articleJson({ 조문여부: "조문", 조문번호: "18", 조문가지번호: "3", 조문내용: "제18조의3 삭제 <2022.12.31>" }),
    })
    const res = await handleFinVerify(client(), { text: "법인세법 제18조의3을 적용한다." })
    expect(verdictLines(res.content[0].text)[0]).toContain("[사용 보류] 삭제된 조문 (삭제 <2022.12.31>)")
  })

  it("[반대] 정상 조문은 ✓ 유지", async () => {
    stubRoutes({ lawSearch: () => lawXml(BUPIN), lawService: () => articleJson(LIVE_26) })
    const res = await handleFinVerify(client(), { text: "법인세법 제26조에 따른다." })
    const text = res.content[0].text
    expect(text).toContain("✓1 / ✗0 / ⚠0")
    expect(text).not.toContain("삭제된 조문")
  })

  it("[반대] 제목·본문에 '삭제'라는 낱말이 든 정상 조문을 오탐하지 않는다", async () => {
    stubRoutes({
      lawSearch: () => lawXml(BUPIN),
      lawService: () =>
        articleJson({
          조문여부: "조문",
          조문번호: "10",
          조문제목: "등록의 삭제",
          조문내용: "제10조(등록의 삭제) 관할 세무서장은 다음 각 호의 경우 등록을 삭제한다.",
        }),
    })
    const res = await handleFinVerify(client(), { text: "법인세법 제10조에 따른다." })
    expect(res.content[0].text).toContain("✓1 / ✗0 / ⚠0")
  })

  it("[반대] 항 하나만 삭제된 조문(② 삭제)은 조문이 살아 있다 — ✓", async () => {
    stubRoutes({
      lawSearch: () => lawXml(BUPIN),
      lawService: () =>
        articleJson({
          조문여부: "조문",
          조문번호: "18",
          조문가지번호: "2",
          조문제목: "내국법인 수입배당금액의 익금불산입",
          조문내용: "제18조의2(내국법인 수입배당금액의 익금불산입)",
          항: [
            { 항번호: "①", 항내용: "① 내국법인이 … 익금에 산입하지 아니한다." },
            { 항번호: "②", 항내용: "② 삭제 <2022.12.31>" },
          ],
        }),
    })
    const res = await handleFinVerify(client(), { text: "법인세법 제18조의2 제1항에 따른다." })
    expect(res.content[0].text).toContain("✓1 / ✗0 / ⚠0")
  })

  it("[반대] ✗(조문 0건)는 그대로 ✗ — 삭제 판정이 부존재 판정을 먹지 않는다", async () => {
    stubRoutes({ lawSearch: () => lawXml(BUPIN) }) // lawService 기본 = 조문 없음
    const res = await handleFinVerify(client(), { text: "법인세법 제999조에 따른다." })
    expect(res.content[0].text).toContain("✓0 / ✗1 / ⚠0")
  })

  it("삭제 ⚠와 일반 ⚠가 섞이면 '없음 아님' 고지는 붙는다 (일반 ⚠ 몫)", async () => {
    stubRoutes({
      lawSearch: (q) => (q === "법인세법" ? lawXml(BUPIN) : EMPTY_LAW_XML),
      lawService: () => articleJson(DELETED_39),
    })
    const res = await handleFinVerify(client(), { text: "법인세법 제39조와 같은 규칙 제3조를 본다." })
    const text = res.content[0].text
    expect(text).toContain("⚠️ 삭제된 조문 인용 있음")
    expect(text).toContain('※ ⚠는 "없음"(부존재 확정)이 아닙니다')
  })
})

describe("B1 기준일 경로 — 그 시점에 살아 있으면 ✓, 이미 삭제면 ⚠ [9차 차단]", () => {
  // 기준일 시행본 해소(resolveVersionAt) — 1999-01-01 시행본(MST 111)은 제39조가 살아 있고,
  // 2002-01-01 시행본(MST 222)은 삭제 자리표시다
  const SLICES_XML =
    '<?xml version="1.0"?><LawSearch><totalCnt>2</totalCnt>' +
    "<law id=\"1\"><법령명한글>법인세법</법령명한글><법령일련번호>222</법령일련번호><시행일자>20020101</시행일자><공포일자>20011231</공포일자></law>" +
    "<law id=\"2\"><법령명한글>법인세법</법령명한글><법령일련번호>111</법령일련번호><시행일자>19990101</시행일자><공포일자>19981228</공포일자></law>" +
    "</LawSearch>"
  // 법제처 실거동을 흉내 낸다 — 과거 판본 MST는 efYd가 **그 판본의 시행일**일 때만 조문을 주고,
  // 다르면 HTML 오류를 준다 (2026-09-16 실측: 근로기준법 MST 150421 + efYd 20180101 → "일치하는
  // 법령 없음" / + efYd 20140701 → 본문). 종전 코드는 기준일을 efYd로 넘겨 여기서 전부 ⚠였다
  const VERSION_EF: Record<string, string> = { "111": "19990101", "222": "20020101" }
  const HTML_ERROR = "<!DOCTYPE html><html><body>오류</body></html>"
  const routes: Routes = {
    lawSearch: () => lawXml(BUPIN),
    eflawSearch: () => SLICES_XML,
    lawService: (p) => {
      const mst = p.get("MST") || ""
      if (p.get("target") !== "eflaw" || p.get("efYd") !== VERSION_EF[mst]) return HTML_ERROR
      return mst === "111"
        ? articleJson({ 조문여부: "조문", 조문번호: "39", 조문제목: "기부금의 손금불산입", 조문내용: "제39조(기부금의 손금불산입) …" })
        : articleJson(DELETED_39)
    },
  }
  const serviceCalls = (urls: string[]) =>
    urls.filter((u) => u.includes("lawService.do")).map((u) => new URL(u).searchParams)

  it("기준일 시점에 살아 있던 조문(현재는 삭제)은 ✓ — 조회 efYd는 기준일이 아니라 판본 시행일", async () => {
    const urls = stubRoutes(routes)
    const res = await handleFinVerify(client(), { text: "법인세법 제39조에 따라 손금에 산입한다.", basis_date: "2000-01-01" })
    const text = res.content[0].text
    expect(text).toContain("✓1 / ✗0 / ⚠0")
    expect(text).toContain("기준일 시행본: 1999-01-01")
    expect(text).not.toContain("삭제된 조문")
    const calls = serviceCalls(urls)
    expect(calls).toHaveLength(1)
    expect(calls[0].get("target")).toBe("eflaw")
    expect(calls[0].get("MST")).toBe("111")
    expect(calls[0].get("efYd")).toBe("19990101") // 20000101(기준일)이면 회귀
  })

  it("기준일 시행본에서 이미 삭제된 조문은 ⚠ — 기준일을 다시 지정하라는 말 대신 삭제 전 시점을 안내", async () => {
    const urls = stubRoutes(routes)
    const res = await handleFinVerify(client(), { text: "법인세법 제39조에 따라 손금에 산입한다.", basis_date: "2019-01-01" })
    const text = res.content[0].text
    expect(text).toContain("✓0 / ✗0 / ⚠1")
    const [line] = verdictLines(text)
    expect(line).toContain("[사용 보류] 기준일 시행본에서 이미 삭제된 조문 (삭제 <2001.12.31>)")
    expect(line).toContain("기준일 시행본: 2002-01-01")
    expect(line).toContain("삭제 전 시점")
    expect(line).not.toContain("basis_date로 해당 시점을 지정") // 무기준일 문구가 새면 회귀
    expect(serviceCalls(urls).map((p) => p.get("efYd"))).toEqual(["20020101"]) // 20190101이면 회귀
    // 요약 헤더도 대조한 판본에 맞춰야 한다 — 기준일 시행본을 보고 "현행 근거"라고 하면 거짓이다 (R2)
    const header = text.split("\n\n")[0]
    expect(header).toContain("⚠️ 삭제된 조문 인용 있음 — 대조한 본문에서 삭제 확인")
    expect(header).not.toContain("현행")
  })

  it("[반대] 기준일이 판본 시행일과 같은 경우도 그대로 동작한다 (종전 코드가 우연히 통과하던 경우)", async () => {
    const urls = stubRoutes(routes)
    const res = await handleFinVerify(client(), { text: "법인세법 제39조에 따라 손금에 산입한다.", basis_date: "1999-01-01" })
    expect(res.content[0].text).toContain("✓1 / ✗0 / ⚠0")
    expect(serviceCalls(urls).map((p) => p.get("efYd"))).toEqual(["19990101"])
  })

  it("[반대] 기준일이 없으면 target=law·efYd 없음 (현행 조회 경로 불변)", async () => {
    const urls = stubRoutes({ lawSearch: () => lawXml(BUPIN), lawService: () => articleJson(LIVE_26) })
    const res = await handleFinVerify(client(), { text: "법인세법 제26조에 따른다." })
    expect(res.content[0].text).toContain("✓1")
    const [p] = serviceCalls(urls)
    expect(p.get("target")).toBe("law")
    expect(p.has("efYd")).toBe(false)
  })
})

describe("기준일 + 법령명만 인용 — 시행본을 조회하지 않으므로 ✓ 대신 ⚠ + 고지 (9차 검수)", () => {
  it("기준일이 있으면 ⚠ '[현행 기준 대조 — 기준일 미적용]', 호출은 늘지 않는다", async () => {
    const urls = stubRoutes({ lawSearch: () => lawXml(BUPIN) })
    const res = await handleFinVerify(client(), { text: "「법인세법」에 따라 신고한다.", basis_date: "2019-01-01" })
    const text = res.content[0].text
    expect(text).toContain("✓0 / ✗0 / ⚠1")
    const [line] = verdictLines(text)
    expect(line.startsWith("⚠ 「법인세법」 — [현행 기준 대조 — 기준일 미적용] 법령 「법인세법」 실존")).toBe(true)
    expect(line).toContain("기준일(2019-01-01) 시점의 시행 여부는 미확인")
    // 시행본 조회(eflaw 검색·lawService)를 더하지 않는다
    expect(urls.some((u) => u.includes("target=eflaw") || u.includes("lawService.do"))).toBe(false)
  })

  it("[반대] 기준일이 없으면 명칭 실존 ✓ 그대로", async () => {
    stubRoutes({ lawSearch: () => lawXml(BUPIN) })
    const res = await handleFinVerify(client(), { text: "「법인세법」에 따라 신고한다." })
    const text = res.content[0].text
    expect(text).toContain("✓1 / ✗0 / ⚠0")
    expect(text).not.toContain("기준일 미적용")
  })
})

// ── B2 ─────────────────────────────────────────────────────────────────

describe("B2 기본통칙·집행기준 — 법제처 DB 미수록, ✗ 단정 금지 [9차 차단]", () => {
  it("말줄임표(…)가 든 기본통칙 번호가 raw에서 잘리지 않는다", () => {
    const cites = extractCitations("법인세법 기본통칙 19-19…46에 따라 처리한다.")
    const t = cites.find((c) => c.kind === "행정규칙")
    expect(t?.raw).toBe("법인세법 기본통칙 19-19…46")
    // 세 점 표기와 문장 끝 마침표
    expect(extractCitations("소득세법 기본통칙 20-0...1.")[0].raw).toBe("소득세법 기본통칙 20-0...1")
  })

  it("기본통칙 라벨(raw)에 앞 문장이 붙지 않는다 — 모법명만 남긴다 (R3 D2)", () => {
    const cites = extractCitations("업무무관 가지급금 판단은 법인세법 기본통칙 28-53…2를 참고한다.")
    const t = cites.filter((c) => c.kind === "행정규칙")
    expect(t).toHaveLength(1)
    expect(t[0].raw).toBe("법인세법 기본통칙 28-53…2")
    expect(t[0].lawName).toBe("법인세법 기본통칙")
    // 조사·접속어 뒤의 집행기준도 같다
    const j = extractCitations("원천징수 시기는 소득세법 집행기준 127-0-1에 따른다.").find((c) => c.kind === "행정규칙")
    expect(j?.raw).toBe("소득세법 집행기준 127-0-1")
    expect(j?.lawName).toBe("소득세법 집행기준")
  })

  it("[반대] 공백 든 긴 정식 명칭은 잘리지 않는다 — '…등에 관한 법률 집행기준'", () => {
    const LONG = "고용보험 및 산업재해보상보험의 보험료징수 등에 관한 법률"
    const t = extractCitations(`${LONG} 집행기준 16-0-1을 확인한다.`).find((c) => c.kind === "행정규칙")
    expect(t?.lawName).toBe(`${LONG} 집행기준`)
    expect(t?.raw.startsWith(LONG)).toBe(true)
    // 앞 문장이 있어도 정식 명칭 전체가 남는다
    const t2 = extractCitations(`보험료 산정은 ${LONG} 집행기준을 따른다.`).find((c) => c.kind === "행정규칙")
    expect(t2?.lawName).toBe(`${LONG} 집행기준`)
    expect(t2?.raw).toBe(`${LONG} 집행기준`)
  })

  it("기본통칙은 ⚠ + 모법 실존 확인 — ✗·'사용 금지' 없음, 행정규칙 DB는 조회하지 않는다", async () => {
    const urls = stubRoutes({ lawSearch: (q) => (q === "법인세법" ? lawXml(BUPIN) : EMPTY_LAW_XML) })
    const res = await handleFinVerify(client(), { text: "법인세법 기본통칙 19-19…46에 따라 처리한다." })
    const text = res.content[0].text
    expect(text).toContain("✓0 / ✗0 / ⚠1")
    const [line] = verdictLines(text)
    expect(line).toContain("법제처 DB 미수록(국세청 기본통칙·집행기준)")
    expect(line).toContain("번호 실존은 검증하지 않음")
    expect(line).toContain("모법 「법인세법」 실존 확인")
    expect(text).not.toContain("NOT_FOUND")
    expect(text).not.toContain("사용 금지")
    // DB에 "통칙"이 한 건도 없으므로(실측) 조회는 호출 낭비다
    expect(urls.some((u) => u.includes("target=admrul"))).toBe(false)
  })

  it("「」로 감싼 기본통칙도 같은 경로 — ✗가 아니다", async () => {
    stubRoutes({ lawSearch: (q) => (q === "소득세법" ? lawXml([{ name: "소득세법", mst: "1" }]) : EMPTY_LAW_XML) })
    const res = await handleFinVerify(client(), { text: "「소득세법 기본통칙」에 따른다." })
    const text = res.content[0].text
    expect(text).toContain("✗0")
    expect(verdictLines(text)[0]).toContain("모법 「소득세법」 실존 확인")
  })

  it("모법도 법령 DB에 없으면 ⚠ 사용 보류 (없음 단정은 하지 않는다)", async () => {
    stubRoutes({})
    const res = await handleFinVerify(client(), { text: "가상자산투기억제법 기본통칙 3-1…2를 본다." })
    const text = res.content[0].text
    expect(text).toContain("✓0 / ✗0 / ⚠1")
    const [line] = verdictLines(text)
    expect(line).toContain("[사용 보류]")
    expect(line).toContain("모법 「가상자산투기억제법」도 현행 법령 DB에서 확인되지 않음")
  })

  it("모법 조회가 실패하면 ⚠ 판정 불가 사유를 밝힌다 (✗ 아님)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("서버 오류", { status: 500 })))
    const res = await handleFinVerify(client(), { text: "법인세법 기본통칙 19-19…46에 따라 처리한다." })
    const text = res.content[0].text
    expect(text).toContain("✗0")
    expect(verdictLines(text)[0]).toContain("조회 실패로 미확인")
  })

  // 종전 fixture는 행정규칙일련번호도 조문도 없어 "명칭만 확인"으로 끝났다 — getAdminRule이
  // 그 seq로 불리는지, 실제 소비 형식(AdmRulService·조문형식여부=Y·<조문내용>)의 본문에서
  // 조문을 읽는지 아무것도 대조하지 못했다 (R1 감사). 여기서 본문 대조까지 박제한다.
  // seq는 비밀이 아닌 fixture 값이고, 「법인세 집행기준」이 DB에 실존한다는 가정은 이 분기
  // (ntsGuideKind=집행기준인데 정확 일치가 있는 경우)를 고정하기 위한 것이다
  describe("집행기준 — DB 정확 일치가 있으면 본문 조문까지 대조한다", () => {
    const GUIDE = "법인세 집행기준"
    const GUIDE_SEQ = "2100000900123"
    const hitXml = (seq?: string) =>
      '<?xml version="1.0"?><AdmRulSearch><totalCnt>1</totalCnt><admrul>' +
      `<행정규칙명>${GUIDE}</행정규칙명>` +
      (seq ? `<행정규칙일련번호>${seq}</행정규칙일련번호>` : "") +
      "<행정규칙종류>고시</행정규칙종류><소관부처명>국세청</소관부처명><발령일자>20260101</발령일자></admrul></AdmRulSearch>"
    // 실제 소비 형식 — checkAdminRuleArticle은 루트 AdmRulService·조문형식여부=Y·<조문내용> 표제를 본다
    const GUIDE_BODY =
      '<?xml version="1.0"?><AdmRulService><행정규칙기본정보><조문형식여부>Y</조문형식여부></행정규칙기본정보>' +
      "<조문내용><![CDATA[제19조(손금의 범위) …]]></조문내용>" +
      "<조문내용><![CDATA[제23조(감가상각비의 손금산입) …]]></조문내용>" +
      "<조문내용><![CDATA[제24조 삭제<2025. 3. 1.>\n]]></조문내용></AdmRulService>"
    const routes = (seq: string | undefined, body: () => string): Routes => ({
      admrulSearch: (q, p) => (p.get("nw") !== "2" && q.startsWith(GUIDE) ? hitXml(seq) : ADMRUL_EMPTY_XML),
      admrulBody: body,
    })
    const bodyCalls = (urls: string[]) =>
      urls.filter((u) => u.includes("lawService.do") && u.includes("target=admrul")).map((u) => new URL(u).searchParams)

    it("본문에 있는 조문은 ✓ — getAdminRule이 검색으로 받은 seq로 불린다", async () => {
      const urls = stubRoutes(routes(GUIDE_SEQ, () => GUIDE_BODY))
      const res = await handleFinVerify(client(), { text: `「${GUIDE}」 제23조에 따라 상각범위액을 계산한다.` })
      const text = res.content[0].text
      expect(text).toContain("✓1 / ✗0 / ⚠0")
      expect(verdictLines(text)[0]).toContain(`행정규칙 「${GUIDE}」 제23조 확인`)
      expect(verdictLines(text)[0]).toContain("본문 조문 3개와 대조함")
      expect(text).not.toContain("미수록") // 정확 일치가 있으면 국세청 미수록 경로로 돌아가지 않는다
      const calls = bodyCalls(urls)
      expect(calls).toHaveLength(1)
      expect(calls[0].get("ID")).toBe(GUIDE_SEQ)
    })

    it("[반대] 정상 본문에 없는 조문은 ✗ (정상 조회 후 0건)", async () => {
      const urls = stubRoutes(routes(GUIDE_SEQ, () => GUIDE_BODY))
      const res = await handleFinVerify(client(), { text: `「${GUIDE}」 제88조에 따른다.` })
      const text = res.content[0].text
      expect(text).toContain("✓0 / ✗1 / ⚠0")
      expect(verdictLines(text)[0]).toContain("제88조가 없음")
      expect(bodyCalls(urls)).toHaveLength(1)
    })

    it("[반대] 본문의 전체 삭제 조문은 ✗도 ✓도 아닌 ⚠ 사용 보류", async () => {
      stubRoutes(routes(GUIDE_SEQ, () => GUIDE_BODY))
      const res = await handleFinVerify(client(), { text: `「${GUIDE}」 제24조에 따른다.` })
      const text = res.content[0].text
      expect(text).toContain("✓0 / ✗0 / ⚠1")
      expect(verdictLines(text)[0]).toContain("[사용 보류] 삭제된 조문 (삭제 <2025. 3. 1.>)")
      expect(text).toContain("⚠️ 삭제된 조문 인용 있음")
    })

    it("[반대] 본문 장애(끊긴 응답)는 ✗가 아니라 ⚠ 판정 불가", async () => {
      const urls = stubRoutes(routes(GUIDE_SEQ, () => GUIDE_BODY.replace("</AdmRulService>", "")))
      const res = await handleFinVerify(client(), { text: `「${GUIDE}」 제23조에 따른다.` })
      const text = res.content[0].text
      expect(text).toContain("✓0 / ✗0 / ⚠1")
      expect(verdictLines(text)[0]).toContain("확인 실패로 판정 불가 (없음 아님)")
      expect(verdictLines(text)[0]).toContain("끊긴 응답")
      expect(bodyCalls(urls).length).toBeGreaterThanOrEqual(1)
    })

    it("[반대] 검색 결과에 seq가 없으면 본문 조회 0회 + ⚠ (명칭만으로 ✓를 주지 않는다)", async () => {
      const urls = stubRoutes(routes(undefined, () => GUIDE_BODY))
      const res = await handleFinVerify(client(), { text: `「${GUIDE}」 제23조에 따른다.` })
      const text = res.content[0].text
      expect(text).toContain("✓0 / ✗0 / ⚠1")
      expect(verdictLines(text)[0]).toContain("본문 조회 ID를 받지 못해 조문 대조 불가")
      expect(bodyCalls(urls)).toHaveLength(0)
    })

    it("[반대] 기본통칙은 shortcut — 행정규칙 검색도 본문 조회도 0회", async () => {
      const urls = stubRoutes({
        lawSearch: (q) => (q === "법인세법" ? lawXml(BUPIN) : EMPTY_LAW_XML),
        ...routes(GUIDE_SEQ, () => GUIDE_BODY),
      })
      const res = await handleFinVerify(client(), { text: "법인세법 기본통칙 19-19…46에 따라 처리한다." })
      expect(res.content[0].text).toContain("법제처 DB 미수록")
      expect(urls.filter((u) => u.includes("target=admrul"))).toHaveLength(0)
      expect(bodyCalls(urls)).toHaveLength(0)
    })

    it("[반대] 세목명 없는 계약 집행기준+조문은 국세청 문서가 아니다 — 일반 행정규칙으로 본문까지 대조", async () => {
      const CONTRACT = "지방자치단체 입찰 및 계약 집행기준"
      const CONTRACT_SEQ = "2100000900456"
      const urls = stubRoutes({
        admrulSearch: (q, p) =>
          p.get("nw") !== "2" && q.startsWith(CONTRACT)
            ? '<?xml version="1.0"?><AdmRulSearch><totalCnt>1</totalCnt><admrul>' +
              `<행정규칙명>${CONTRACT}</행정규칙명><행정규칙일련번호>${CONTRACT_SEQ}</행정규칙일련번호>` +
              "<행정규칙종류>예규</행정규칙종류><소관부처명>행정안전부</소관부처명><발령일자>20250701</발령일자></admrul></AdmRulSearch>"
            : ADMRUL_EMPTY_XML,
        admrulBody: () =>
          '<?xml version="1.0"?><AdmRulService><행정규칙기본정보><조문형식여부>Y</조문형식여부></행정규칙기본정보>' +
          "<조문내용><![CDATA[제5조(적용범위) …]]></조문내용></AdmRulService>",
      })
      const res = await handleFinVerify(client(), { text: `「${CONTRACT}」 제5조를 따른다.` })
      const text = res.content[0].text
      expect(text).toContain("✓1 / ✗0 / ⚠0")
      expect(verdictLines(text)[0]).toContain(`행정규칙 「${CONTRACT}」 제5조 확인`)
      expect(text).not.toContain("미수록")
      expect(text).not.toContain("국세법령정보시스템")
      const calls = bodyCalls(urls)
      expect(calls).toHaveLength(1)
      expect(calls[0].get("ID")).toBe(CONTRACT_SEQ)
    })
  })

  it("집행기준이 DB에 없으면 미수록 ⚠ — '규칙명이 아닐 수 있음'이라는 틀린 사유를 대지 않는다", async () => {
    stubRoutes({ lawSearch: (q) => (q === "부가가치세법" ? lawXml([{ name: "부가가치세법", mst: "2" }]) : EMPTY_LAW_XML) })
    const res = await handleFinVerify(client(), { text: "부가가치세법 집행기준 32-0-1에 따른다." })
    const [line] = verdictLines(res.content[0].text)
    expect(line.startsWith("⚠")).toBe(true)
    expect(line).toContain("법제처 DB 미수록")
    expect(line).not.toContain("규칙명이 아닐 수 있음")
  })

  it("[반대] 실존하지 않는 가짜 고시는 ✗ NOT_FOUND 유지 — 통칙 완화가 고시·훈령·예규에 번지지 않는다", async () => {
    stubRoutes({})
    for (const text of ["가공전산처리고시 제3조를 따른다.", "「가공세무처리훈령」 제2조를 따른다.", "「가공회계예규」에 따른다."]) {
      const res = await handleFinVerify(client(), { text })
      const out = res.content[0].text
      expect(out, text).toContain("✗1")
      expect(out, text).toContain("NOT_FOUND")
    }
  })

  it("[반대] DB에 실존하는 집행기준(세목명 없음)은 국세청 문서로 취급하지 않는다", async () => {
    stubRoutes({
      admrulSearch: () =>
        '<?xml version="1.0"?><AdmRulSearch><totalCnt>1</totalCnt><admrul><행정규칙명>지방자치단체 입찰 및 계약 집행기준</행정규칙명>' +
        "<행정규칙종류>예규</행정규칙종류><소관부처명>행정안전부</소관부처명><발령일자>20250701</발령일자></admrul></AdmRulSearch>",
    })
    const res = await handleFinVerify(client(), { text: "「지방자치단체 입찰 및 계약 집행기준」을 따른다." })
    const text = res.content[0].text
    expect(text).toContain("✓1")
    expect(text).not.toContain("미수록")
  })

  it("도구 description이 기본통칙 미수록 사실을 말하고, '통칙을 대조한다'고 약속하지 않는다", () => {
    const d = FIN_VERIFY_TOOL.description
    expect(d).toContain("기본통칙·집행기준은 법제처 DB 미수록")
    expect(d).not.toContain("고시·훈령·통칙")
    expect(d).toContain("삭제된 조문")
  })
})

// ── I1 ─────────────────────────────────────────────────────────────────

describe("I1 basis_date — 행정규칙은 현행 대조임을 밝히고 ✓·✗를 기준일 판정으로 내지 않는다 [9차 중요]", () => {
  const RULE = "식품등의 표시기준"
  const HIT =
    `<?xml version="1.0"?><AdmRulSearch><totalCnt>1</totalCnt><admrul><행정규칙명>${RULE}</행정규칙명>` +
    "<행정규칙일련번호>2100000000001</행정규칙일련번호><행정규칙종류>고시</행정규칙종류>" +
    "<소관부처명>식품의약품안전처</소관부처명><발령일자>20240115</발령일자></admrul></AdmRulSearch>"
  const BODY =
    '<?xml version="1.0"?><AdmRulService><행정규칙기본정보><조문형식여부>Y</조문형식여부></행정규칙기본정보>' +
    "<조문내용><![CDATA[제1조(목적) 이 고시는 …]]></조문내용>" +
    "<조문내용><![CDATA[제3조(표시대상) …]]></조문내용>" +
    "<조문내용><![CDATA[제4조 삭제<2025. 2. 5.>\n]]></조문내용></AdmRulService>"
  const adminRoutes: Routes = {
    admrulSearch: (_q, p) => (p.get("nw") === "2" ? ADMRUL_EMPTY_XML : HIT),
    admrulBody: () => BODY,
  }

  it("[반대] 기준일 없으면 조문 대조 ✓ 그대로", async () => {
    stubRoutes(adminRoutes)
    const res = await handleFinVerify(client(), { text: `${RULE} 제3조에 따른다.` })
    const text = res.content[0].text
    expect(text).toContain("✓1 / ✗0 / ⚠0")
    expect(text).not.toContain("기준일 미적용")
  })

  it("기준일이 있으면 ✓ → ⚠ + '[현행 기준 대조 — 기준일 미적용]'을 raw 바로 뒤에", async () => {
    stubRoutes(adminRoutes)
    const res = await handleFinVerify(client(), { text: `${RULE} 제3조에 따른다.`, basis_date: "2019-01-01" })
    const text = res.content[0].text
    expect(text).toContain("[기준: 2019-01-01]")
    expect(text).toContain("✓0 / ✗0 / ⚠1")
    const [line] = verdictLines(text)
    expect(line.startsWith(`⚠ ${RULE} 제3조 — [현행 기준 대조 — 기준일 미적용] `)).toBe(true)
    expect(line).toContain("기준일(2019-01-01) 시점의 존재는 미확인")
  })

  it("기준일이 있으면 현행 본문에 없는 조문도 ✗가 아니라 ⚠ (기준일 시점은 조회하지 않았다)", async () => {
    stubRoutes(adminRoutes)
    const res = await handleFinVerify(client(), { text: `${RULE} 제99조에 따른다.`, basis_date: "2019-01-01" })
    const text = res.content[0].text
    expect(text).toContain("✓0 / ✗0 / ⚠1")
    expect(verdictLines(text)[0]).toContain("시점의 부존재는 미확인")
  })

  it("[반대] 기준일 없이 현행 본문에 없는 조문은 ✗ 유지", async () => {
    stubRoutes(adminRoutes)
    const res = await handleFinVerify(client(), { text: `${RULE} 제99조에 따른다.` })
    expect(res.content[0].text).toContain("✗1")
  })

  it("[반대] 현행·연혁 DB 어디에도 없는 규칙(NOT_FOUND)은 기준일이 있어도 ✗ 유지, 고지도 붙이지 않는다", async () => {
    stubRoutes({})
    const res = await handleFinVerify(client(), { text: "가공전산처리고시 제3조를 따른다.", basis_date: "2019-01-01" })
    const text = res.content[0].text
    expect(text).toContain("✗1")
    expect(text).not.toContain("기준일 미적용")
  })

  it("행정규칙 본문의 삭제 조문은 ⚠ 사용 보류 — 기준일이 있으면 고지가 앞에 붙고 삭제 표지는 유지된다", async () => {
    stubRoutes(adminRoutes)
    const now = await handleFinVerify(client(), { text: `${RULE} 제4조에 따른다.` })
    const nowLine = verdictLines(now.content[0].text)[0]
    expect(nowLine).toContain("[사용 보류] 삭제된 조문 (삭제 <2025. 2. 5.>)")
    expect(now.content[0].text).toContain("⚠️ 삭제된 조문 인용 있음")

    stubRoutes(adminRoutes)
    const based = await handleFinVerify(client(), { text: `${RULE} 제4조에 따른다.`, basis_date: "2019-01-01" })
    const basedLine = verdictLines(based.content[0].text)[0]
    expect(basedLine).toContain("[현행 기준 대조 — 기준일 미적용] [사용 보류] 삭제된 조문")
    expect(based.content[0].text).toContain("⚠️ 삭제된 조문 인용 있음")
  })

  it("「…규정」 폴백 경로(법령 DB 0건 → 행정규칙)도 같은 고지를 받는다 — 절반 수정 방지", async () => {
    stubRoutes({
      admrulSearch: (_q, p) =>
        p.get("nw") === "2"
          ? ADMRUL_EMPTY_XML
          : '<?xml version="1.0"?><AdmRulSearch><totalCnt>1</totalCnt><admrul><행정규칙명>조사사무처리규정</행정규칙명>' +
            "<행정규칙일련번호>2100000277992</행정규칙일련번호><행정규칙종류>훈령</행정규칙종류>" +
            "<소관부처명>국세청</소관부처명><발령일자>20240101</발령일자></admrul></AdmRulSearch>",
      admrulBody: () =>
        '<?xml version="1.0"?><AdmRulService><조문형식여부>Y</조문형식여부>' +
        "<조문내용>제23조(조사의 개시) …</조문내용></AdmRulService>",
    })
    const res = await handleFinVerify(client(), {
      text: "「조사사무처리규정」 제23조에 따라 세무조사를 실시한다.",
      basis_date: "2019-01-01",
    })
    const text = res.content[0].text
    expect(text).toContain("✓0")
    expect(verdictLines(text)[0]).toContain("[현행 기준 대조 — 기준일 미적용]")
  })

  it("기본통칙도 기준일이 있으면 고지가 붙는다 (모법 확인은 현행 법령 DB)", async () => {
    stubRoutes({ lawSearch: (q) => (q === "법인세법" ? lawXml(BUPIN) : EMPTY_LAW_XML) })
    const res = await handleFinVerify(client(), { text: "법인세법 기본통칙 19-19…46에 따른다.", basis_date: "2019-01-01" })
    expect(verdictLines(res.content[0].text)[0]).toContain("[현행 기준 대조 — 기준일 미적용] 법제처 DB 미수록")
  })
})

// ── E6 ─────────────────────────────────────────────────────────────────

describe("E6 폐지 법령 + basis_date — 이미 준 기준일을 다시 요구하지 않는다", () => {
  const REPEALED_XML = lawXml([{ name: "택지소유상한에 관한 법률", mst: "222", status: "연혁", efYd: "19980925" }])

  it("기준일이 있으면 '기준일을 지정했지만 …'으로 안내한다", async () => {
    stubRoutes({ eflawSearch: () => REPEALED_XML })
    const res = await handleFinVerify(client(), {
      text: "택지소유상한에 관한 법률 제5조에 따라 부담금을 부과한다.",
      basis_date: "1995-01-01",
    })
    const [line] = verdictLines(res.content[0].text)
    expect(line).toContain("폐지·연혁 법령")
    expect(line).toContain("기준일(1995-01-01)을 지정했지만")
    expect(line).not.toContain("basis_date를 지정해 재검증")
  })

  it("[반대] 기준일이 없으면 종전대로 basis_date 지정을 안내한다", async () => {
    stubRoutes({ eflawSearch: () => REPEALED_XML })
    const res = await handleFinVerify(client(), { text: "택지소유상한에 관한 법률 제5조에 따라 부담금을 부과한다." })
    expect(verdictLines(res.content[0].text)[0]).toContain("basis_date를 지정해 재검증")
  })
})

// ── E7 ─────────────────────────────────────────────────────────────────

describe("E7 출력 예산 — 헤더가 전부 서고 판정 라인이 전부 절단돼도 판정 라인 15개가 살아남는다", () => {
  // 분당 한도(기본 30, 클라이언트별)가 이 입력의 조회 수보다 작아 뒤쪽 인용이 짧은 RATE_LIMITED ⚠로
  // 끝나면 "최악"이 아니게 된다(R2 실측: 5,825자, 절단 9줄). 한도를 이 테스트에서만 풀어
  // 긴 판정 줄 11개가 전부 절단되는 진짜 최악 구성을 만든다
  const origRate = process.env.FIN_DRF_RATE_PER_MIN
  beforeAll(() => {
    process.env.FIN_DRF_RATE_PER_MIN = "1000"
  })
  afterAll(() => {
    if (origRate === undefined) delete process.env.FIN_DRF_RATE_PER_MIN
    else process.env.FIN_DRF_RATE_PER_MIN = origRate
  })

  it("헤더 6줄 + 480자 초과 라인 + 전체 20건 → 8,000자 이내, 판정 라인 15개, 예산 절단 없음", async () => {
    const LONG = (tag: string) => `${tag}${"가".repeat(300)}에 관한 특별법`
    stubRoutes({
      lawSearch: (q) =>
        q === "법인세법"
          ? lawXml(BUPIN)
          : q === "하하하하하하하법"
            ? lawXml([
                { name: LONG("갑"), mst: "901" },
                { name: LONG("을"), mst: "902" },
              ])
            : EMPTY_LAW_XML,
      lawService: (p) =>
        p.get("JO") === "002600" ? articleJson(LIVE_26) : p.get("JO") === "003900" ? articleJson(DELETED_39) : JSON.stringify({ 법령: { 조문: {} } }),
    })
    const parts = [
      "법인세법 제26조", // ✓
      "법인세법 제39조", // 삭제 ⚠
      "법인세법 제999조", // ✗
      "당사 취업규칙 제12조", // 사용 보류(hold)
      ...Array.from({ length: 16 }, (_, i) => `하하하하하하하법 제${i + 1}조`), // 유사 명칭만 → 긴 일반 ⚠
    ]
    const res = await handleFinVerify(client(), { text: parts.join(", ") + "를 검토한다." })
    const text = res.content[0].text
    expect(text).toContain("전체 20건 중 15건 검증")
    expect(text).toContain("실존한다는 뜻입니다")
    expect(text).toContain("사용 금지")
    expect(text).toContain("⚠️ 사용 보류 인용 있음")
    expect(text).toContain("삭제된 조문 인용 있음")
    expect(text).toContain('※ ⚠는 "없음"(부존재 확정)이 아닙니다')
    expect(text).toContain("세부 절단")
    expect(text.length).toBeLessThanOrEqual(8000)
    expect(text).not.toContain("예산 8,000자 초과로 절단")
    expect(verdictLines(text)).toHaveLength(15)
    // 헤더 6줄이 전부 서는 최악 구성이다 — 헤더가 길어지면 라인 상한(lineCap ≤ 480)이 먼저 줄어든다.
    // 기대값을 느슨하게 하는 대신 실제 형식을 못박는다 (R2: 헤더 문구를 늘렸다).
    // 절단된 줄 = 앞 lineCap자 + 접미사(24자)이므로 줄 길이 자체는 480을 넘을 수 있다 —
    // 접미사를 뺀 본문 길이로 상한을 잰다
    const header = text.split("\n\n")[0]
    expect(header.split("\n")).toHaveLength(6)
    const CUT_SUFFIX = " …(세부 절단 — 이 인용은 단독 재검증)"
    const cut = verdictLines(text).filter((l) => l.endsWith(CUT_SUFFIX))
    expect(cut.length).toBeGreaterThanOrEqual(11) // 15건 상한 중 유사 명칭 긴 ⚠ 11건은 전부 절단
    const kept = new Set(cut.map((l) => l.length - CUT_SUFFIX.length))
    expect(kept.size).toBe(1) // 모든 절단 줄이 같은 lineCap으로 잘렸다
    const lineCap = [...kept][0]
    expect(lineCap).toBeLessThanOrEqual(480)
    // 라인 예산이 헤더에 먹혀 판정 내용이 뭉텅이로 사라지지 않았는가 (헤더 증가분 ÷ 15 수준만 줄어야 한다)
    expect(lineCap).toBeGreaterThanOrEqual(470)
    // 판정 15줄이 **전부** 이 lineCap으로 절단되는 최악(여기선 ✓·삭제·✗·보류 4줄이 짧다)을 산술로 잰다:
    // 헤더 + "\n" + 15 × (lineCap + 접미사) + 줄 사이 "\n" 14 + "\n\n" + 푸터 ≤ 8,000.
    // 하한은 lineCap이 필요 이상 작아 판정 내용을 낭비하지 않는지(floor 오차 15자 이내)
    const footer = text.slice(text.lastIndexOf("\n\n") + 2)
    const worst = header.length + 1 + 15 * (lineCap + CUT_SUFFIX.length) + 14 + 2 + footer.length
    expect(worst).toBeLessThanOrEqual(8000)
    expect(worst).toBeGreaterThan(8000 - 15)
    // 훅(scripts/verify-file.mjs:240)은 헤더가 아니라 **판정 줄**의 "사용 보류"로 hold를 가른다 —
    // 헤더 문구를 바꿔도 이 분류가 살아 있어야 WARN_EXIT 보고가 그대로다
    expect(verdictLines(text).filter((l) => /사용\s*보류|사용을 보류/.test(l)).length).toBeGreaterThanOrEqual(2)
  }, 20_000)
})

// ── R2: 요약 헤더는 사유를 정확히 말한다 ──────────────────────────────────

describe("R2 요약 헤더 — 보류 사유·삭제 대조 시점·⚠ 종류를 뭉뚱그리지 않는다", () => {
  const header = (text: string) => text.split("\n\n")[0]

  it("기본통칙만 있는 출력 — 미수록은 '틀린 인용'도 '사용 금지'도 아니고, 원문 대조 안내다", async () => {
    stubRoutes({ lawSearch: (q) => (q === "법인세법" ? lawXml(BUPIN) : EMPTY_LAW_XML) })
    const res = await handleFinVerify(client(), { text: "법인세법 기본통칙 19-19…46에 따라 처리한다." })
    const text = res.content[0].text
    expect(text).toContain("✓0 / ✗0 / ⚠1")
    const [line] = verdictLines(text)
    expect(line).toContain("국세법령정보시스템에서 확인") // 원문 수동 대조가 조치다
    expect(line).toContain("번호 실존은 검증하지 않음")
    expect(text).not.toContain("사용 금지")
    expect(header(text)).not.toContain("삭제된 조문")
    expect(header(text)).not.toContain("사용 보류 인용 있음")
    // ⚠ 고지는 남되 "전부 조회 실패"라고 말하지 않는다 — 여기 조회는 정상이었다
    expect(header(text)).toContain('※ ⚠는 "없음"(부존재 확정)이 아닙니다')
    expect(header(text)).toContain("사유가 줄마다 다릅니다")
    expect(header(text)).not.toContain("확인 실패입니다")
  })

  it("삭제만 있는 출력 — 기준일이 없으면 현행 본문 대조이고, 헤더는 대조 시점을 줄로 넘긴다", async () => {
    stubRoutes({ lawSearch: () => lawXml(BUPIN), lawService: () => articleJson(DELETED_39) })
    const res = await handleFinVerify(client(), { text: "법인세법 제39조에 따라 손금에 산입한다." })
    const text = res.content[0].text
    expect(header(text)).toContain("⚠️ 삭제된 조문 인용 있음 — 대조한 본문에서 삭제 확인(대조 시점은 판정 줄 참조)")
    // 판정 줄은 그대로 현행 대조임을 말한다 (사실은 줄에 남는다)
    expect(verdictLines(text)[0]).toContain("현행 근거로 쓸 수 없음")
    expect(header(text)).not.toContain("부존재 확정") // 삭제만 있으면 ⚠ 고지 자체가 붙지 않는다
  })

  it("실제 약칭 hold와 사내 문서 hold가 같은 헤더를 받되 '정식 명칭 재검증'으로 단정하지 않는다", async () => {
    stubRoutes({})
    const abbr = await handleFinVerify(client(), { text: "탄소세법 제5조를 적용한다." })
    const abbrText = abbr.content[0].text
    expect(verdictLines(abbrText)[0]).toContain("약칭 형태이나")
    expect(header(abbrText)).toContain("⚠️ 사용 보류 인용 있음")
    expect(header(abbrText)).toContain("사유는 판정 줄마다 다릅니다")
    expect(header(abbrText)).not.toContain("미확인 약칭 인용 있음")
    // 약칭 고유의 조치("정식 명칭으로 재검증")는 판정 줄에만 있다 — 헤더가 모든 hold에 같은 조치를 주지 않는다
    expect(verdictLines(abbrText)[0]).toContain("정식 명칭으로 재검증")
    expect(header(abbrText)).not.toContain("정식 명칭")

    stubRoutes({})
    const internal = await handleFinVerify(client(), { text: "당사 취업규칙 제12조에 따라 지급한다." })
    const internalText = internal.content[0].text
    // 사내 규정일 수 있는 인용 — 헤더가 "정식 명칭으로 재검증"만 요구하면 틀린 조치다
    expect(verdictLines(internalText)[0]).toContain("사내 규정·사규 등 법령이 아닌 문서일 수 있어")
    expect(header(internalText)).toContain("⚠️ 사용 보류 인용 있음")
    expect(header(internalText)).not.toContain("미확인 약칭 인용 있음")
    expect(header(internalText)).not.toContain("정식 명칭")
  })

  it("기본통칙 모법 미확인 hold도 '미확인 약칭'으로 부르지 않는다 — 판정 줄이 모법 확인을 요구한다", async () => {
    stubRoutes({})
    const res = await handleFinVerify(client(), { text: "가상자산투기억제법 기본통칙 3-1…2를 본다." })
    const text = res.content[0].text
    expect(text).toContain("✓0 / ✗0 / ⚠1")
    expect(verdictLines(text)[0]).toContain("법령명 확인 전까지 사용 보류")
    expect(verdictLines(text)[0]).toContain("법제처 DB 미수록")
    expect(header(text)).toContain("⚠️ 사용 보류 인용 있음 — 사유는 판정 줄마다 다릅니다")
    expect(header(text)).not.toContain("약칭 인용 있음")
    expect(header(text)).not.toContain("사용 금지") // ✗가 아니다
  })

  it("미수록·기준일 미지원·조회 실패·✓가 섞여도 ⚠ 고지는 한 줄이고 사유를 줄로 넘긴다", async () => {
    const HTML_ERROR = "<!DOCTYPE html><html><body>오류</body></html>"
    const SLICES_XML =
      '<?xml version="1.0"?><LawSearch><totalCnt>1</totalCnt>' +
      "<law id=\"1\"><법령명한글>법인세법</법령명한글><법령일련번호>111</법령일련번호><시행일자>19990101</시행일자><공포일자>19981228</공포일자></law>" +
      "</LawSearch>"
    const RULE = "식품등의 표시기준"
    const RULE_HIT =
      `<?xml version="1.0"?><AdmRulSearch><totalCnt>1</totalCnt><admrul><행정규칙명>${RULE}</행정규칙명>` +
      "<행정규칙일련번호>2100000000001</행정규칙일련번호><행정규칙종류>고시</행정규칙종류>" +
      "<소관부처명>식품의약품안전처</소관부처명><발령일자>20240115</발령일자></admrul></AdmRulSearch>"
    const urls = stubRoutes({
      // "장애법"만 HTML 오류 — 같은 출력 안에 진짜 조회 실패를 섞는다
      lawSearch: (q) =>
        q.includes("장애법") ? HTML_ERROR : q === "법인세법" ? lawXml(BUPIN) : EMPTY_LAW_XML,
      eflawSearch: () => SLICES_XML,
      lawService: (p) => (p.get("efYd") === "19990101" ? articleJson(LIVE_26) : HTML_ERROR),
      admrulSearch: (_q, p) => (p.get("nw") === "2" ? ADMRUL_EMPTY_XML : RULE_HIT),
      admrulBody: () =>
        '<?xml version="1.0"?><AdmRulService><행정규칙기본정보><조문형식여부>Y</조문형식여부></행정규칙기본정보>' +
        "<조문내용><![CDATA[제3조(표시대상) …]]></조문내용></AdmRulService>",
    })
    const res = await handleFinVerify(client(), {
      text: `법인세법 제26조와 ${RULE} 제3조, 법인세법 기본통칙 19-19…46, 조세장애법 제7조를 함께 본다.`,
      // 기준일 ≠ 판본 시행일(19990101) — 같으면 efYd에 기준일을 넣는 회귀가 우연히 통과한다
      basis_date: "2000-06-01",
    })
    // 조회 실패 줄이 stub 우연이 아니라 실제 호출 실패에서 나왔는가 — HTML 응답에 재시도까지 돌았다
    const params = urls.map((u) => new URL(u).searchParams)
    expect(params.filter((p) => p.get("query") === "조세장애법").length).toBeGreaterThanOrEqual(2)
    // ✓는 기준일(20000601)이 아니라 판본 시행일 efYd(19990101)로 본문을 받았다
    const svc = params.filter((p) => p.get("MST") === "111")
    expect(svc.length).toBeGreaterThanOrEqual(1)
    expect(svc.every((p) => p.get("efYd") === "19990101")).toBe(true)
    expect(params.some((p) => p.get("efYd") === "20000601")).toBe(false)
    // 행정규칙 본문은 검색이 준 seq로 조회했다 (명칭만으로 ✓/⚠를 만들지 않았다)
    expect(params.filter((p) => p.get("target") === "admrul" && p.get("ID") === "2100000000001")).toHaveLength(1)
    // 기본통칙은 행정규칙 DB를 조회하지 않는다 — admrul 검색은 식품 표시기준 몫뿐
    expect(params.some((p) => p.get("target") === "admrul" && (p.get("query") || "").includes("통칙"))).toBe(false)
    const text = res.content[0].text
    expect(text).toContain("✓1 / ✗0 / ⚠3")
    const lines = verdictLines(text)
    expect(lines[0].startsWith("✓")).toBe(true)
    expect(lines[0]).toContain("기준일 시행본: 1999-01-01") // ✓ (기준일 2000-06-01에 시행 중이던 판본과 대조)
    expect(lines[1]).toContain("[현행 기준 대조 — 기준일 미적용]") // 미지원
    expect(lines[2]).toContain("법제처 DB 미수록") // 미수록
    expect(lines[3]).toContain("조회 실패로 판정 불가 (없음 아님)") // 진짜 조회 실패
    // ⚠ 고지는 한 줄만, 그리고 "전부 조회 실패"라고 하지 않는다
    const warnNotice = text.split("\n").filter((l) => l.startsWith('※ ⚠는 "없음"'))
    expect(warnNotice).toHaveLength(1)
    expect(warnNotice[0]).toContain("조회 실패·DB 미수록·기준일 미적용·표기 확인 필요")
    expect(header(text)).not.toContain("삭제된 조문")
    // ✓ 고지도 함께 선다 — ⚠ 고지가 ✓ 고지를 밀어내지 않는다
    expect(header(text)).toContain("실존한다는 뜻입니다")
  }, 30_000) // 조회 실패 경로는 실제 재시도 backoff를 탄다(stub 기준 약 7초)

  it("시간 상한 미검증 ⚠와 ✓가 섞여도 ⚠ 고지는 '없음 아님'이고, 상한 줄은 나눠서 재검증을 말한다", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      const hung: string[] = []
      vi.stubGlobal(
        "fetch",
        vi.fn((input: unknown, init?: RequestInit) => {
          const url = String(input)
          const p = new URL(url).searchParams
          if (url.includes("lawService.do")) return Promise.resolve(new Response(articleJson(LIVE_26), { status: 200 }))
          if (p.get("query") === "법인세법") return Promise.resolve(new Response(lawXml(BUPIN), { status: 200 }))
          // 그 밖의 검색은 응답하지 않는다 — 콜 timeout·도구 deadline의 abort로만 끝난다
          hung.push(p.get("query") || "")
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
          })
        })
      )
      const pending = handleFinVerify(client(), { text: "법인세법 제26조와 소득세법 제20조, 소득세법 제21조를 본다." })
      await vi.advanceTimersByTimeAsync(30_000)
      const res = await pending
      const text = res.content[0].text
      expect(hung.length).toBeGreaterThanOrEqual(1) // 매달린 호출이 실제로 있었다
      expect(text).toContain("✓1 / ✗0 / ⚠2")
      const lines = verdictLines(text)
      expect(lines[0].startsWith("✓")).toBe(true)
      expect(lines[2]).toContain("전체 시간 상한(20초) 도달로 미검증 (없음 아님)")
      expect(lines[2]).toContain("나눠서 재검증")
      expect(text).not.toContain("사용 금지") // 시간 초과를 ✗로 바꾸지 않는다
      expect(header(text)).toContain('※ ⚠는 "없음"(부존재 확정)이 아닙니다')
      expect(header(text)).toContain("실존한다는 뜻입니다")
      expect(header(text)).not.toContain("삭제된 조문")
      expect(header(text)).not.toContain("사용 보류 인용 있음")
    } finally {
      vi.useRealTimers()
    }
  })
})
