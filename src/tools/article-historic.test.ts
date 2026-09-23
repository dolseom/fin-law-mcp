/**
 * fin_article 회귀 — 현행 법령 DB에 없는 **연혁 법령**(폐지·개칭 전) 조회 (9차 리뷰 B5)
 *
 * findLaws는 현행만 찾는다. 그래서 `fin_article("증권거래법","제2조",basis_date="2005-01-01")`이
 * "[LAW_NOT_FOUND] … (정상 조회 후 0건 — ✗없음)"으로 나갔다 — 2009년까지 시행된 법령을 없다고
 * 단정하는 (b)형이다. 같은 서버의 fin_verify는 findRepealedLaw로 "폐지·연혁 법령 (환각 아님)"을
 * 이미 구분한다(verify.ts). 이 파일은 fin_article이 같은 사실을 말하고, basis_date가 있으면
 * 그 시점 시행본까지 조회를 잇는지 고정한다.
 *
 * 픽스처: 2026-09-16 eflaw 검색 "증권거래법" 실응답에서 행 일부를 태그만 남겨 썼다
 * (최신 행 = 2009-02-04 시행 "타법폐지", MST 80007).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { handleFinArticle } from "./article.js"
import { lawCache } from "../lib/cache.js"
import type { LawApiClient } from "../lib/api-client.js"

const EMPTY_LAW_XML = '<?xml version="1.0"?><LawSearch><totalCnt>0</totalCnt></LawSearch>'

const eflawRow = (name: string, mst: string, efYd: string, ancYd: string, kind: string, type = "법률") =>
  `<law id="1"><법령일련번호>${mst}</법령일련번호><현행연혁코드>연혁</현행연혁코드><법령명한글><![CDATA[${name}]]></법령명한글>` +
  `<법령ID>001529</법령ID><공포일자>${ancYd}</공포일자><공포번호>08635</공포번호><제개정구분명>${kind}</제개정구분명>` +
  `<법령구분명>${type}</법령구분명><시행일자>${efYd}</시행일자></law>`

const SECURITIES_ROWS: Array<[string, string, string, string]> = [
  // [MST, 시행일자, 공포일자, 제개정구분명] — 실응답 순서(시행일 내림차순)
  ["80007", "20090204", "20070803", "타법폐지"],
  ["85962", "20080321", "20080321", "일부개정"],
  ["66574", "20050328", "20050117", "일부개정"],
  ["58559", "20050127", "20040129", "일부개정"],
  ["59091", "20040401", "20031231", "일부개정"],
]
const eflawXml = (rows: Array<[string, string, string, string]>, name = "증권거래법") =>
  `<?xml version="1.0" encoding="UTF-8"?><LawSearch><target>eflaw</target><totalCnt>${rows.length}</totalCnt>` +
  rows.map(([mst, ef, anc, kind]) => eflawRow(name, mst, ef, anc, kind)).join("") +
  "</LawSearch>"

const articleJson = (num: string, title: string, body: string) =>
  JSON.stringify({
    법령: { 조문: { 조문단위: [{ 조문여부: "조문", 조문번호: num, 조문가지번호: "0", 조문제목: title, 조문내용: body }] } },
  })

interface Calls {
  eflawSearch: number
  annex: number
  service: Array<Record<string, string>>
}

/**
 * 현행 검색(target=law)은 currentXml, 연혁 검색(target=eflaw)은 historicRows,
 * 기준일 슬라이스 검색(lawSearch.do eflaw + efYd 범위)은 범위 안의 행만 돌려준다.
 */
function stub(opts: { currentXml?: string; historicRows?: Array<[string, string, string, string]>; eflawError?: Error; name?: string }, calls: Calls): LawApiClient {
  const name = opts.name ?? "증권거래법"
  return {
    searchLaw: async (_q: string, _k: unknown, _display: number, target: string) => {
      if (target === "eflaw") {
        calls.eflawSearch++
        if (opts.eflawError) throw opts.eflawError
        return eflawXml(opts.historicRows ?? [], name)
      }
      return opts.currentXml ?? EMPTY_LAW_XML
    },
    fetchApi: async (p: { endpoint: string; target: string; extraParams?: Record<string, string> }) => {
      if (p.endpoint === "lawSearch.do" && p.target === "eflaw") {
        const to = (p.extraParams?.efYd || "").split("~")[1] || "99991231"
        return eflawXml((opts.historicRows ?? []).filter(([, ef]) => ef <= to), name)
      }
      if (p.endpoint === "lawSearch.do") return '<?xml version="1.0"?><CgmExpc><totalCnt>0</totalCnt></CgmExpc>'
      calls.service.push({ target: p.target, ...(p.extraParams || {}) })
      // 실서버 동작: 시행본 MST에 그 시행일이 아닌 efYd를 주면 HTML 오류 (2026-09-17 실측)
      if (p.extraParams?.efYd && p.extraParams.efYd !== "20040401" && p.extraParams?.MST === "59091") {
        throw new Error("법제처 API 비정상 응답(HTML 페이지)")
      }
      if (p.extraParams?.MST === "59091" && p.extraParams?.JO === "000200") {
        return articleJson("2", "정의", "제2조(정의) 2004-04-01 시행본 증권거래법 2조 본문")
      }
      return '{"법령":{}}'
    },
    getThreeTier: async () => "{}",
    getAnnexes: async () => {
      calls.annex++
      return "{}"
    },
    searchAdminRule: async () => '<?xml version="1.0"?><AdmRulSearch><totalCnt>0</totalCnt></AdmRulSearch>',
  } as unknown as LawApiClient
}

const newCalls = (): Calls => ({ eflawSearch: 0, annex: 0, service: [] })

beforeEach(() => lawCache.clear())
// 가짜 타이머를 쓰는 테스트가 도중에 실패해도 다음 테스트로 새지 않게 한다
afterEach(() => vi.useRealTimers())

describe("fin_article — 연혁 법령을 ✗없음으로 단정하지 않는다 (B5)", () => {
  it("basis_date가 있으면 그 시점 시행본에서 조문을 조회한다 (증권거래법 2005-01-01 → 2004-04-01 시행본)", async () => {
    const calls = newCalls()
    const r = await handleFinArticle(stub({ historicRows: SECURITIES_ROWS }, calls), {
      law: "증권거래법",
      article: "제2조",
      basis_date: "2005-01-01",
      include_rulings: false,
    })
    const text = r.content[0].text
    expect(r.isError).toBeFalsy()
    expect(text).not.toContain("[LAW_NOT_FOUND]")
    expect(text).not.toContain("✗없음")
    expect(text).toContain("■ 증권거래법 제2조 ⚠연혁 법령(현행 아님)")
    expect(text).toContain("2004-04-01 시행본 증권거래법 2조 본문")
    expect(text).toContain("직전 개정본 2004-04-01 시행 기준으로 조회")
    expect(text).toContain("현행 법령 DB에 없는 **연혁 법령**")
    // efYd는 기준일(20050101)이 아니라 시행본 시행일 — 기준일을 넣으면 법제처가 HTML 오류를 준다 (실측)
    expect(calls.service[0]).toMatchObject({ target: "eflaw", MST: "59091", JO: "000200", efYd: "20040401" })
    // 별표는 현행 법령만 조회된다 — 연혁 법령에 "없음"을 찍지 않고 생략을 밝힌다
    expect(calls.annex).toBe(0)
    expect(text).toContain('"별표 없음"이 아님')
  })

  it("basis_date가 없으면 연혁 법령임을 알리고 basis_date를 권한다 (본문은 주지 않는다)", async () => {
    const calls = newCalls()
    const r = await handleFinArticle(stub({ historicRows: SECURITIES_ROWS }, calls), { law: "증권거래법", article: "제2조" })
    const text = r.content[0].text
    expect(r.isError).toBeFalsy()
    expect(text).toContain("[LAW_HISTORIC]")
    expect(text).toContain("연혁 법령 「증권거래법」")
    expect(text).toContain("✗없음이 아닙니다")
    expect(text).toContain("basis_date")
    expect(text).toContain("2009-02-04")
    expect(calls.service).toEqual([])
  })

  it("기준일에 이미 폐지됐으면 폐지 사실과 시행일을 말하고 조문을 주지 않는다", async () => {
    const calls = newCalls()
    const r = await handleFinArticle(stub({ historicRows: SECURITIES_ROWS }, calls), {
      law: "증권거래법",
      article: "제2조",
      basis_date: "2010-01-01",
    })
    const text = r.content[0].text
    expect(text).toContain("[LAW_REPEALED]")
    expect(text).toContain("**이미 폐지**")
    expect(text).toContain("2009-02-04 시행 타법폐지")
    expect(text).not.toContain("✗없음")
    expect(calls.service).toEqual([])
  })

  it("이름만 비슷한 현행 법령이 걸려도(특별소비세법 → 개별소비세법) 연혁 법령을 확인한다", async () => {
    const calls = newCalls()
    const current = `<?xml version="1.0" encoding="UTF-8"?><LawSearch><totalCnt>1</totalCnt>
  <law id="1"><법령명한글>개별소비세법</법령명한글><법령일련번호>280345</법령일련번호><법령ID>001570</법령ID>
    <법령구분명>법률</법령구분명><시행일자>20260101</시행일자><현행연혁코드>현행</현행연혁코드></law></LawSearch>`
    const r = await handleFinArticle(
      stub({ currentXml: current, historicRows: [["59091", "20040401", "20031231", "일부개정"]], name: "특별소비세법" }, calls),
      { law: "특별소비세법", article: "제2조", basis_date: "2005-01-01", include_rulings: false }
    )
    const text = r.content[0].text
    expect(text).not.toContain("[LAW_AMBIGUOUS]")
    expect(text).toContain("■ 특별소비세법 제2조 ⚠연혁 법령(현행 아님)")
  })

  it("반대 방향: 연혁에도 없으면 종전대로 ✗없음 (환각 낙인은 그대로)", async () => {
    const calls = newCalls()
    const r = await handleFinArticle(stub({ historicRows: [] }, calls), { law: "탄소거래세법", article: "제2조", basis_date: "2005-01-01" })
    const text = r.content[0].text
    expect(r.isError).toBe(true)
    expect(text).toContain("[LAW_NOT_FOUND]")
    expect(text).toContain("현행·연혁 모두 정상 조회 후 0건 — ✗없음")
    expect(calls.eflawSearch).toBe(1)
  })

  it("반대 방향: 연혁 조회가 실패하면 ✗없음이 아니라 ⚠판정불가", async () => {
    const calls = newCalls()
    const r = await handleFinArticle(stub({ eflawError: new Error("요청 시간 초과 (3000ms)") }, calls), {
      law: "증권거래법",
      article: "제2조",
      basis_date: "2005-01-01",
    })
    const text = r.content[0].text
    expect(r.isError).toBe(true)
    expect(text).toContain("⚠판정불가")
    expect(text).not.toContain("[LAW_NOT_FOUND]")
    expect(text).toContain("요청 시간 초과")
  })

  it("반대 방향: 접두만 겹치는 연혁 법령(증권거래법 시행령)은 본법 요청의 대상으로 받지 않는다", async () => {
    const calls = newCalls()
    const r = await handleFinArticle(stub({ historicRows: SECURITIES_ROWS, name: "증권거래법 시행령" }, calls), {
      law: "증권거래법",
      article: "제2조",
      basis_date: "2005-01-01",
    })
    expect(r.content[0].text).toContain("[LAW_NOT_FOUND]")
    expect(calls.service).toEqual([])
  })

  // 기준일 해소의 취소는 두 경로에 있다 — 현행 법령의 과거 판본(article.ts ①-b basisAborter)과
  // 이 연혁 경로(lookupAborter). 한쪽만 고치면 반대쪽이 deadline 밖에 남는다(이 저장소에서 10번 반복)
  it("연혁 경로의 시행본 해소도 6초 예산에서 실제로 취소되고 ⚠판정불가로 끝난다", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    const seen: { signal?: AbortSignal } = {}
    const client = {
      searchLaw: async (_q: string, _k: unknown, _d: number, target: string) =>
        target === "eflaw" ? eflawXml(SECURITIES_ROWS) : EMPTY_LAW_XML,
      fetchApi: async (p: { endpoint: string; target: string; signal?: AbortSignal }) => {
        if (p.endpoint === "lawSearch.do" && p.target === "eflaw") {
          seen.signal = p.signal
          return await new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => resolve(eflawXml(SECURITIES_ROWS)), 20_000)
            p.signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(timer)
                reject(new Error("요청 취소됨(도구 deadline) — 대기 중 취소되어 호출하지 않음"))
              },
              { once: true }
            )
          })
        }
        return '{"법령":{}}'
      },
      getThreeTier: async () => "{}",
      getAnnexes: async () => "{}",
      searchAdminRule: async () => '<?xml version="1.0"?><AdmRulSearch><totalCnt>0</totalCnt></AdmRulSearch>',
    } as unknown as LawApiClient
    const p = handleFinArticle(client, { law: "증권거래법", article: "제2조", basis_date: "2005-01-01", include_rulings: false })
    await vi.advanceTimersByTimeAsync(6000)
    expect(seen.signal).toBeDefined()
    expect(seen.signal?.aborted).toBe(true)
    const r = await p
    const text = r.content[0].text
    expect(r.isError).toBe(true)
    expect(text).toContain("[BASIS_DATE_UNRESOLVED]")
    expect(text).toContain("⚠판정불가 (없음이 아님)")
    expect(text).not.toContain("[LAW_NOT_FOUND]")
    expect(text).not.toContain("✗없음")
  })

  it("반대 방향: 현행 법령이 정확히 잡히면 연혁 조회를 하지 않는다 (호출 수 불변)", async () => {
    const calls = newCalls()
    const current = `<?xml version="1.0" encoding="UTF-8"?><LawSearch><totalCnt>1</totalCnt>
  <law id="1"><법령명한글>증권거래세법</법령명한글><법령일련번호>280000</법령일련번호><법령ID>001580</법령ID>
    <법령구분명>법률</법령구분명><시행일자>20260101</시행일자><현행연혁코드>현행</현행연혁코드></law></LawSearch>`
    const r = await handleFinArticle(stub({ currentXml: current, historicRows: SECURITIES_ROWS }, calls), {
      law: "증권거래세법",
      article: "제2조",
      include_rulings: false,
    })
    // 개정 예정 탐지(display 20)가 eflaw를 1번 부른다 — 연혁 확인(display 30)은 없어야 한다
    expect(calls.eflawSearch).toBe(1)
    expect(r.content[0].text).not.toContain("연혁 법령")
  })
})
