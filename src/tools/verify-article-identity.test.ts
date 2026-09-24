/**
 * fin_verify 반환 조문 동일성 (외부 검토 B4 같은 모양 — v01-sameshape, fixture·실 API 없음)
 *
 * 전에는 lawService 응답의 **첫 조문단위**를 번호 대조 없이 잡아 ✓ "실존"을 줬다 — 업스트림이
 * JO를 무시하거나 응답이 섞이면 다른 조문으로 ✓가 나가고 훅도 exit 0이었다. 삭제 판정도
 * 그 첫 단위로 했다. 요청 조문번호(+가지번호)와 같은 단위만 근거로 쓰고, 없거나 여럿이면 ⚠다.
 */

import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from "vitest"
import { handleFinVerify } from "./verify.js"
import { LawApiClient } from "../lib/api-client.js"
import { pickArticleUnit, unitJoLabel, canonicalJoLabel } from "../lib/article-unit.js"

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
const lawXml = (name: string, mst: string) =>
  `<?xml version="1.0"?><LawSearch><totalCnt>1</totalCnt><law id="1"><법령명한글>${name}</법령명한글>` +
  `<법령ID>1563</법령ID><법령일련번호>${mst}</법령일련번호><법령구분명>법률</법령구분명>` +
  `<현행연혁코드>현행</현행연혁코드><시행일자>20260701</시행일자></law></LawSearch>`
const unitsJson = (units: Array<Record<string, unknown>>) => JSON.stringify({ 법령: { 조문: { 조문단위: units } } })

const JO_1 = { 조문여부: "조문", 조문번호: "1", 조문제목: "목적", 조문내용: "제1조(목적) 이 법은 …" }
const JO_99 = { 조문여부: "조문", 조문번호: "99", 조문제목: "다른 조문", 조문내용: "제99조(다른 조문) 제99조 다른 조문이다." }
const JO_10 = { 조문여부: "조문", 조문번호: "10", 조문제목: "본조", 조문내용: "제10조(본조) …" }
const JO_10_2 = { 조문여부: "조문", 조문번호: "10", 조문가지번호: "2", 조문제목: "가지조", 조문내용: "제10조의2(가지조) …" }
const DELETED_39 = { 조문여부: "조문", 조문번호: "39", 조문내용: "제39조 삭제 <2001.12.31>" }
const LIVE_26 = { 조문여부: "조문", 조문번호: "26", 조문제목: "과다경비 등의 손금불산입", 조문내용: "제26조(과다경비 등의 손금불산입) …" }

function stub(lawService: (p: URLSearchParams) => string, eflawSearch?: () => string): string[] {
  const urls: string[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input)
      urls.push(url)
      const u = new URL(url)
      const p = u.searchParams
      let body: string
      if (u.pathname.endsWith("lawService.do")) body = lawService(p)
      else if (p.get("target") === "eflaw") body = eflawSearch?.() ?? EMPTY_LAW_XML
      else if (p.get("target") === "admrul") body = '<?xml version="1.0"?><AdmRulSearch><totalCnt>0</totalCnt></AdmRulSearch>'
      else body = lawXml(p.get("query") || "완전성가상법", "900001")
      return new Response(body, { status: 200 })
    })
  )
  return urls
}

const client = () => new LawApiClient({ apiKey: "testkey" })
const verdictLines = (text: string) => text.split("\n").filter((l) => /^[✓✗⚠⌛]\s/.test(l.trim()))
// scripts/verify-file.mjs HOLD_RE와 같은 정규식 — 이 ⚠는 "사용 보류"가 아니라 일반 판정 불가(WARN)
const HOLD_RE = /사용\s*보류|사용을 보류/

describe("fin_verify — 반환 조문 번호 대조 (B4 같은 모양)", () => {
  it("제1조 요청 + 제99조 응답 → ⚠판정 불가(반환 조문 불일치), ✓ 0건", async () => {
    stub(() => unitsJson([JO_99]))
    const res = await handleFinVerify(client(), { text: "법인세법 제1조에 따른다." })
    const text = res.content[0].text
    expect(text).toContain("✓0 / ✗0 / ⚠1")
    const [line] = verdictLines(text)
    expect(line.startsWith("⚠ ")).toBe(true)
    expect(line).toContain("판정 불가(반환 조문 불일치)")
    expect(line).toContain("요청 제1조 대신 제99조")
    expect(line).not.toContain("실존(")
    // 훅은 마크 ⚠를 WARN으로 센다 — 보류 문구가 없으니 일반 판정 불가 쪽으로 분류된다
    expect(HOLD_RE.test(line)).toBe(false)
  })

  it("가지조문 불일치: 제10조의2 요청 + 제10조 응답 → ⚠", async () => {
    stub(() => unitsJson([JO_10]))
    const res = await handleFinVerify(client(), { text: "법인세법 제10조의2에 따른다." })
    expect(res.content[0].text).toContain("✓0 / ✗0 / ⚠1")
    expect(verdictLines(res.content[0].text)[0]).toContain("요청 제10조의2 대신 제10조")
  })

  it("[반대] 가지조문 불일치: 제10조 요청 + 제10조의2 응답 → ⚠", async () => {
    stub(() => unitsJson([JO_10_2]))
    const res = await handleFinVerify(client(), { text: "법인세법 제10조에 따른다." })
    expect(res.content[0].text).toContain("✓0 / ✗0 / ⚠1")
    expect(verdictLines(res.content[0].text)[0]).toContain("요청 제10조 대신 제10조의2")
  })

  it("같은 번호 조문단위가 둘 → ⚠ (확정 불가)", async () => {
    stub(() => unitsJson([JO_1, { ...JO_1, 조문제목: "다른 목적" }]))
    const res = await handleFinVerify(client(), { text: "법인세법 제1조에 따른다." })
    expect(res.content[0].text).toContain("✓0 / ✗0 / ⚠1")
    expect(verdictLines(res.content[0].text)[0]).toContain("같은 번호 조문이 2개")
  })

  it("[반대] 정상 일치 → 종전과 같은 ✓ (제목 표시)", async () => {
    stub(() => unitsJson([LIVE_26]))
    const res = await handleFinVerify(client(), { text: "법인세법 제26조에 따른다." })
    const text = res.content[0].text
    expect(text).toContain("✓1 / ✗0 / ⚠0")
    expect(verdictLines(text)[0]).toContain("실존 (과다경비 등의 손금불산입)")
  })

  it("[반대] 가지번호 \"0\"·\"\"·null은 가지 없음 — 제26조 ✓", async () => {
    for (const b of ["0", "", null]) {
      stub(() => unitsJson([{ ...LIVE_26, 조문가지번호: b }]))
      const res = await handleFinVerify(client(), { text: "법인세법 제26조에 따른다." })
      expect(res.content[0].text).toContain("✓1 / ✗0 / ⚠0")
      vi.unstubAllGlobals()
    }
  })

  it("[반대] 가지조문 정상 일치: 제10조의2 요청 + 제10조의2 응답 → ✓", async () => {
    stub(() => unitsJson([JO_10, JO_10_2]))
    const res = await handleFinVerify(client(), { text: "법인세법 제10조의2에 따른다." })
    expect(res.content[0].text).toContain("✓1 / ✗0 / ⚠0")
    expect(verdictLines(res.content[0].text)[0]).toContain("(가지조)")
  })

  it("삭제 판정은 일치 단위로: 앞에 삭제된 다른 조문이 있어도 요청 조문이 살아 있으면 ✓", async () => {
    stub(() => unitsJson([DELETED_39, LIVE_26]))
    const res = await handleFinVerify(client(), { text: "법인세법 제26조에 따른다." })
    const text = res.content[0].text
    expect(text).toContain("✓1 / ✗0 / ⚠0")
    expect(text).not.toContain("삭제된 조문")
  })

  it("[반대] 요청 조문이 삭제 자리표시면 뒤에 있어도 ⚠(사용 보류) 삭제", async () => {
    stub(() => unitsJson([LIVE_26, DELETED_39]))
    const res = await handleFinVerify(client(), { text: "법인세법 제39조에 따른다." })
    const text = res.content[0].text
    expect(text).toContain("✓0 / ✗0 / ⚠1")
    expect(verdictLines(text)[0]).toContain("[사용 보류] 삭제된 조문 (삭제 <2001.12.31>)")
  })

  it("[반대] 조문단위 0건 → ✗ 유지 (불일치 ⚠가 부존재 판정을 먹지 않는다)", async () => {
    stub(() => unitsJson([]))
    const res = await handleFinVerify(client(), { text: "법인세법 제999조에 따른다." })
    expect(res.content[0].text).toContain("✓0 / ✗1 / ⚠0")
  })

  it("기준일 경로도 같다 — 기준일 시행본 응답이 다른 조문이면 ⚠, 시행본 표기 유지", async () => {
    const SLICES =
      '<?xml version="1.0"?><LawSearch><totalCnt>1</totalCnt>' +
      "<law id=\"1\"><법령명한글>법인세법</법령명한글><법령일련번호>111</법령일련번호><시행일자>19990101</시행일자><공포일자>19981228</공포일자></law>" +
      "</LawSearch>"
    stub((p) => (p.get("MST") === "111" && p.get("efYd") === "19990101" ? unitsJson([JO_99]) : "<html>오류</html>"), () => SLICES)
    const res = await handleFinVerify(client(), { text: "법인세법 제39조에 따른다.", basis_date: "2000-01-01" })
    const text = res.content[0].text
    expect(text).toContain("✓0 / ✗0 / ⚠1")
    const [line] = verdictLines(text)
    expect(line).toContain("판정 불가(반환 조문 불일치)")
    expect(line).toContain("기준일 시행본: 1999-01-01")
  })
})

describe("article-unit — article.ts pickArticleUnit과 같은 의미", () => {
  it("정규형·가지번호 규칙", () => {
    expect(canonicalJoLabel("제010조의02")).toBe("제10조의2")
    expect(canonicalJoLabel("제 26 조")).toBe("제26조")
    expect(canonicalJoLabel("제26조제1항")).toBeNull()
    expect(unitJoLabel({ 조문번호: "10", 조문가지번호: "0" })).toBe("제10조")
    expect(unitJoLabel({ 조문번호: "10", 조문가지번호: null })).toBe("제10조")
    expect(unitJoLabel({ 조문번호: "10", 조문가지번호: "2" })).toBe("제10조의2")
    expect(unitJoLabel({ 조문번호: "" })).toBeNull()
  })

  it("조문여부가 '조문'이 아닌 단위(전문)는 대조 대상에서 뺀다", () => {
    const data = { 조문: { 조문단위: [{ 조문여부: "전문", 조문번호: "1" }, JO_1] } }
    expect(pickArticleUnit(data, "제1조").kind).toBe("match")
    expect(pickArticleUnit({ 조문: { 조문단위: [{ 조문여부: "전문", 조문번호: "1" }] } }, "제1조").kind).toBe("none")
  })

  it("요청 표기를 정규형으로 못 읽으면 mismatch — 아무 조문이나 고르지 않는다", () => {
    expect(pickArticleUnit({ 조문: { 조문단위: [JO_1] } }, "제1조제2항").kind).toBe("mismatch")
  })
})
