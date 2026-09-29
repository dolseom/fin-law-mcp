/**
 * fin_article 회귀 — 최종 검토(`.release-scratch/orch/reports/final-review-fable.md`) F1·F2·참고 1
 *
 * F1: 조문이 없거나(✗) 조문 조회에 실패해도 예규 검색어가 "법령명 제N조"로 폴백되고, 축약 사다리가
 *     "법령명"까지 줄여 법령 전체의 최신 예규 3건을 "이 조문의 예규 후보"로 실었다
 *     (라이브: 법인세법 제999조 → "418건 중 최신 3건"). 제목 없이 폴백 검색한 사실도 헤더에 없었다.
 * F2: 항을 지정했는데 그 항만 싣지 못하고 앞부분부터 절단한 경우(항 미발견·그 항이 예산 초과)에도
 *     상단 고지가 "본문은 조 전체이고"라고 적어 첫 줄 ⚠절단과 충돌했다.
 * 참고 1: 위임 본문 동봉에서 하위법령을 정확히 특정하지 못해 조회를 건너뛴 건을 "조회 실패·시간 초과"로 셌다.
 *
 * 픽스처는 형태만 줄인 합성본이다 (P2·P4·P5는 최종 검토의 스텁 프로브 시나리오 그대로).
 */
import { describe, it, expect, beforeEach } from "vitest"
import { handleFinArticle } from "./article.js"
import { lawCache } from "../lib/cache.js"
import { normalizeLawSearchText, resolveLawAlias } from "../lib/search-normalizer.js"
import type { LawApiClient } from "../lib/api-client.js"

const lawXml = (name: string, mst: string, type = "법률") => `<?xml version="1.0" encoding="UTF-8"?>
<LawSearch><totalCnt>1</totalCnt>
  <law id="1"><법령명한글>${name}</법령명한글><법령일련번호>${mst}</법령일련번호><법령ID>9${mst}</법령ID>
    <법령구분명>${type}</법령구분명><시행일자>20260101</시행일자><제개정구분명>일부개정</제개정구분명><현행연혁코드>현행</현행연혁코드></law>
</LawSearch>`
const EMPTY_LAW_XML = '<?xml version="1.0"?><LawSearch><totalCnt>0</totalCnt></LawSearch>'
const unitJson = (units: Array<Record<string, unknown>>) =>
  JSON.stringify({ 법령: { 조문: { 조문단위: units.map((u) => ({ 조문여부: "조문", ...u })) } } })
const RULING_XML =
  `<?xml version="1.0" encoding="UTF-8"?><CgmExpc><totalCnt>418</totalCnt>` +
  ["20240101", "20230101", "20220101"]
    .map((d, i) => `<cgmExpc id="${i + 1}"><안건명>무관 예규 ${i + 1}</안건명><안건번호>법인세과-${100 + i}</안건번호><해석일자>${d}</해석일자></cgmExpc>`)
    .join("") +
  "</CgmExpc>"
// 시행령 위임 1건(본문 없음) — 본문 동봉 대상
const THREE_TIER = JSON.stringify({
  LspttnThdCmpLawXService: {
    기본정보: { 법령명: "법인세법", 기준법령명: "법인세법", 삼단비교존재여부: "Y" },
    기준법령목록: { 법령명: "법인세법" },
    위임조문삼단비교: {
      법률조문: { 조번호: "0026", 조가지번호: "00", 시행령조문: { 조번호: "0045", 조가지번호: "00", 법령명: "법인세법 시행령", 조제목: "복리후생비" } },
    },
  },
})

/** 법령 검색은 항상 법인세법 1건(시행령 이름으로 찾아도 법인세법 — 하위법령 특정 불가), 조문 조회는 articleFn */
function stub(articleFn: (p: Record<string, string>) => Promise<string> | string, rulingQueries: string[]): LawApiClient {
  return {
    searchLaw: async () => lawXml("법인세법", "280349"),
    fetchApi: async (p: { endpoint: string; target: string; extraParams?: Record<string, string> }) => {
      if (p.target === "ntsCgmExpc") {
        rulingQueries.push(p.extraParams?.query ?? "")
        return RULING_XML
      }
      if (p.endpoint === "lawSearch.do") return EMPTY_LAW_XML
      return await articleFn({ target: p.target, ...(p.extraParams || {}) })
    },
    getThreeTier: async () => THREE_TIER,
    getAnnexes: async () => "{}",
    searchAdminRule: async () => '<?xml version="1.0"?><AdmRulSearch><totalCnt>0</totalCnt></AdmRulSearch>',
  } as unknown as LawApiClient
}

const firstLine = (t: string) => t.split("\n")[0]
const section = (text: string, header: string) => {
  const start = text.indexOf(header)
  const end = text.indexOf("\n■ ", start + 1)
  return text.slice(start, end < 0 ? undefined : end)
}
const RULINGS = "■ 국세청 예규 후보"

// P4: 항 10개(각 약 700자) — 제99항은 없다
const P4_UNIT = unitJson([
  {
    조문번호: "26",
    조문제목: "긴 조문",
    조문내용: "제26조(긴 조문)",
    항: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({ 항번호: `${n}`, 항내용: `${n}. ` + "가나다라마바사 ".repeat(90) })),
  },
])
// P5: 제2항 자체가 6,000자 초과
const P5_UNIT = unitJson([
  {
    조문번호: "26",
    조문제목: "긴 조문",
    조문내용: "제26조(긴 조문)",
    항: [
      { 항번호: "1", 항내용: "1. 짧다" },
      { 항번호: "2", 항내용: "2. " + "가나다라마바사 ".repeat(900) },
    ],
  },
])

beforeEach(() => lawCache.clear())

describe("F1 — 조문이 없거나 조회에 실패하면 예규 후보를 싣지 않는다", () => {
  it("absent: 법인세법 제999조(✗) → 예규 검색 0회, '검색 생략 — 현행본에 없는 조문'", async () => {
    const queries: string[] = []
    const r = await handleFinArticle(stub(() => unitJson([]), queries), { law: "법인세법", article: "제999조" })
    const text = r.content[0].text
    expect(firstLine(text)).toContain("조문 없음(✗)")
    expect(queries).toEqual([])
    const rulings = section(text, RULINGS)
    expect(rulings).toContain("검색 생략 — 현행본에 없는 조문")
    expect(rulings).not.toContain("무관 예규")
    expect(rulings).not.toContain("최신 3건")
  })

  it("P2: 조문 조회 네트워크 실패 → 예규 검색 0회, '조문 조회에 실패해 조문 제목을 확보하지 못했습니다'", async () => {
    const queries: string[] = []
    const r = await handleFinArticle(
      stub(() => {
        throw new Error("fetch failed ECONNRESET")
      }, queries),
      { law: "법인세법", article: "제26조" }
    )
    const text = r.content[0].text
    expect(firstLine(text)).toContain("조문(")
    expect(queries).toEqual([])
    const rulings = section(text, RULINGS)
    expect(rulings).toContain("검색 생략 — 조문 조회에 실패해 조문 제목을 확보하지 못했습니다")
    expect(rulings).not.toContain("무관 예규")
  })

  it("조문은 받았지만 제목이 비었으면 헤더에 '조문 제목 미확보 — 법령명·조문번호로 검색'을 적는다", async () => {
    const queries: string[] = []
    const r = await handleFinArticle(stub(() => unitJson([{ 조문번호: "26", 조문내용: "제26조 제목 없는 조문 본문" }]), queries), {
      law: "법인세법",
      article: "제26조",
    })
    const text = r.content[0].text
    expect(queries[0]).toBe("법인세법 제26조")
    const rulings = section(text, RULINGS)
    expect(rulings).toContain('조문 제목 미확보 — 법령명·조문번호 "법인세법 제26조"로 검색')
    expect(rulings).not.toContain("조문 제목 키워드 검색")
  })

  it("[반대] 제목이 있으면 종전대로 제목 키워드 검색 헤더·검색어", async () => {
    const queries: string[] = []
    const r = await handleFinArticle(
      stub(() => unitJson([{ 조문번호: "26", 조문제목: "과다경비 등의 손금불산입", 조문내용: "제26조(과다경비 등의 손금불산입) 본문" }]), queries),
      { law: "법인세법", article: "제26조" }
    )
    const text = r.content[0].text
    expect(queries[0]).toBe("과다경비 등의 손금불산입")
    const rulings = section(text, RULINGS)
    expect(rulings).toContain("조문 제목 키워드 검색 — 적용 관계 미확인")
    expect(rulings).toContain("무관 예규 1")
  })
})

describe("F2 — 상단 본문 범위 고지가 절단 사실과 일치한다", () => {
  it("P4: 제26조제99항(항 없음) + 절단 → 첫 줄 '요청 제99항 미발견', 상단 '찾지 못해 … 앞부분 N자만 실었고'", async () => {
    const r = await handleFinArticle(stub(() => P4_UNIT, []), { law: "법인세법", article: "제26조제99항", include_rulings: false })
    const text = r.content[0].text
    expect(firstLine(text)).toMatch(/⚠본문 일부 절단\([\d,]+자 중 [\d,]+자 — 요청 제99항 미발견, 조 앞부분부터\)/)
    expect(text).not.toContain("본문은 조 전체이고")
    expect(text).toMatch(/본문은 요청한 제99항을 응답의 항 번호에서 찾지 못해 조 전체 [\d,]+자가 예산을 넘어 앞부분 [\d,]+자만 실었고/)
  })

  it("P5: 제26조제2항(그 항이 6,000자 초과) → '요청한 제2항 자체가 예산을 넘어', '조 전체이고' 없음", async () => {
    const r = await handleFinArticle(stub(() => P5_UNIT, []), { law: "법인세법", article: "제26조제2항", include_rulings: false })
    const text = r.content[0].text
    expect(firstLine(text)).toContain("요청 제2항만 싣지 못해 조 앞부분부터")
    expect(text).not.toContain("본문은 조 전체이고")
    expect(text).toContain("본문은 요청한 제2항 자체가 예산을 넘어 조 전체")
    expect(text).toContain("(제2항 뒷부분·뒤쪽 항 생략)")
  })

  it("예산 안의 조문에 없는 항을 요청하면 조 전체라고 하되 그 항을 찾지 못했다고 적는다", async () => {
    const r = await handleFinArticle(
      stub(
        () =>
          unitJson([
            { 조문번호: "26", 조문제목: "짧은 조문", 조문내용: "제26조(짧은 조문)", 항: [1, 2, 3].map((n) => ({ 항번호: `${n}`, 항내용: `${n}. 제${n}항 본문` })) },
          ]),
        []
      ),
      { law: "법인세법", article: "제26조제9항", include_rulings: false }
    )
    const text = r.content[0].text
    expect(firstLine(text)).toContain("전체 성공")
    expect(text).toContain("본문은 조 전체이고(요청한 제9항은 응답의 항 번호에서 찾지 못했습니다")
  })

  it("예산 안의 항 구분 없는 조문에 항을 요청하면 그 항의 존재를 확인하지 못했다고 적는다 (라이브: 법인세법 제26조제99항)", async () => {
    const r = await handleFinArticle(
      stub(
        () =>
          unitJson([
            { 조문번호: "26", 조문제목: "호만 있는 조문", 조문내용: "제26조(호만 있는 조문) 다음 각 호의 손비는 손금에 산입하지 아니한다.", 호: [{ 호번호: "1.", 호내용: "1. 인건비" }] },
          ]),
        []
      ),
      { law: "법인세법", article: "제26조제99항", include_rulings: false }
    )
    const text = r.content[0].text
    expect(text).toContain("본문은 조 전체이고(이 조문은 응답에서 항으로 구분되지 않아 요청한 제99항의 존재를 확인하지 못했습니다")
  })

  it("[반대] 예산 안의 조문에서 요청 항을 찾으면 '조 전체이고'만 적는다", async () => {
    const r = await handleFinArticle(
      stub(
        () =>
          unitJson([
            { 조문번호: "26", 조문제목: "짧은 조문", 조문내용: "제26조(짧은 조문)", 항: [1, 2].map((n) => ({ 항번호: `${n}`, 항내용: `${n}. 제${n}항 본문` })) },
          ]),
        []
      ),
      { law: "법인세법", article: "제26조제2항", include_rulings: false }
    )
    const text = r.content[0].text
    expect(text).toContain("본문은 조 전체이고, 위임")
    expect(text).not.toContain("확인하지 못했습니다")
  })

  it("absent + 항 지정(제999조제2항) → '조 전체이고'가 아니라 '본문은 싣지 못했고'", async () => {
    const r = await handleFinArticle(stub(() => unitJson([]), []), { law: "법인세법", article: "제999조제2항", include_rulings: false })
    const text = r.content[0].text
    expect(text).not.toContain("조 전체이고")
    expect(text).toContain("본문은 싣지 못했고")
  })
})

describe("참고 1 — 위임 본문 동봉: 하위법령 미특정은 '조회 실패'와 구분한다", () => {
  it("정방향: 시행령을 법령 검색에서 정확히 특정 못함 → '특정하지 못해 본문 조회 생략', '조회 실패' 없음", async () => {
    const r = await handleFinArticle(
      stub(() => unitJson([{ 조문번호: "26", 조문제목: "과다경비 등의 손금불산입", 조문내용: "제26조(과다경비 등의 손금불산입) 본문" }]), []),
      { law: "법인세법", article: "제26조", include_rulings: false }
    )
    const deleg = section(r.content[0].text, "■ 시행령·시행규칙 위임")
    expect(deleg).toContain("복리후생비")
    expect(deleg).toContain("1건은 소속 하위법령을 법령 검색에서 정확히 특정하지 못해 본문 조회 생략")
    expect(deleg).not.toContain("조회 실패")
  })

  it("[반대] 정방향: 시행령은 특정됐는데 본문 조회가 실패 → '조회 실패·시간 초과'", async () => {
    const client = stub((p) => {
      if (p.MST === "280349") return unitJson([{ 조문번호: "26", 조문제목: "과다경비 등의 손금불산입", 조문내용: "제26조(과다경비 등의 손금불산입) 본문" }])
      throw new Error("fetch failed ECONNRESET")
    }, [])
    ;(client as unknown as { searchLaw: unknown }).searchLaw = async (q: string) =>
      /시행령/.test(q) ? lawXml("법인세법 시행령", "280350", "대통령령") : lawXml("법인세법", "280349")
    const r = await handleFinArticle(client, { law: "법인세법", article: "제26조", include_rulings: false })
    const deleg = section(r.content[0].text, "■ 시행령·시행규칙 위임")
    expect(deleg).toContain("1건은 조회 실패·시간 초과")
    expect(deleg).not.toContain("특정하지 못해")
  })

  it("역방향: 모법을 법령 검색에서 정확히 특정 못함 → '모법(「법인세법」)을 … 특정하지 못해'", async () => {
    const asSearched = (q: string) => resolveLawAlias(normalizeLawSearchText(q)).canonical.replace(/\s+/g, "")
    const REVERSE_THD = JSON.stringify({
      LspttnThdCmpLawXService: {
        기본정보: { 법령명: "법인세법 시행령", 기준법령명: "법인세법", 삼단비교존재여부: "Y" },
        기준법령목록: { 법령명: "법인세법" },
        위임조문삼단비교: {
          법률조문: {
            조번호: "0026",
            조가지번호: "00",
            조제목: "",
            조내용: "",
            시행령조문: { 조번호: "0045", 조가지번호: "00", 법령명: "법인세법 시행령", 조제목: "", 조내용: "" },
          },
        },
      },
    })
    const client = {
      searchLaw: async (q: string) =>
        asSearched(q) === "법인세법시행령"
          ? lawXml("법인세법 시행령", "283635", "대통령령")
          : // 모법 검색에 이름이 다른 법령만 온다 — 정확 일치 없음
            lawXml("소득세법", "999999"),
      fetchApi: async (p: { endpoint: string; extraParams?: Record<string, string> }) => {
        if (p.endpoint === "lawSearch.do") return '<?xml version="1.0"?><CgmExpc><totalCnt>0</totalCnt></CgmExpc>'
        return unitJson([{ 조문번호: "45", 조문가지번호: "0", 조문제목: "복리후생비의 손금불산입", 조문내용: "제45조(복리후생비의 손금불산입) 본문" }])
      },
      getThreeTier: async () => REVERSE_THD,
      getAnnexes: async () => "{}",
      searchAdminRule: async () => '<?xml version="1.0"?><AdmRulSearch><totalCnt>0</totalCnt></AdmRulSearch>',
    } as unknown as LawApiClient
    const r = await handleFinArticle(client, { law: "법인세법 시행령", article: "제45조", include_rulings: false })
    const deleg = section(r.content[0].text, "■ 모법 위임 근거 (역방향)")
    expect(deleg).toContain("[모법] 법인세법 제26조")
    expect(deleg).toContain("1건은 모법(「법인세법」)을 법령 검색에서 정확히 특정하지 못해 본문 조회 생략")
    expect(deleg).not.toContain("조회 실패")
  })
})

/**
 * 후속 — findRepealedLaw·개정 예정 조회는 eflaw 검색 한 페이지만 받는다 (Fable 최종 검토 F3).
 * 목록이 불완전하면 "연혁에도 없음"(✗)·"마지막 시행"·"개정 예정 없음"을 단정하지 않는다.
 */
describe("F3 후속 — 연혁·개정 예정 검색 목록의 완전성", () => {
  const histRow = (name: string, i: number, ef: string, code = "연혁") =>
    `<law id="${i}"><법령명한글>${name}</법령명한글><법령ID>8</법령ID><법령일련번호>${3000 + i}</법령일련번호>` +
    `<법령구분명>법률</법령구분명><현행연혁코드>${code}</현행연혁코드><시행일자>${ef}</시행일자><공포일자>${ef}</공포일자>` +
    `<제개정구분명>일부개정</제개정구분명></law>`
  const histXml = (rows: string[], total: number) =>
    `<?xml version="1.0" encoding="UTF-8"?><LawSearch><totalCnt>${total}</totalCnt>${rows.join("")}</LawSearch>`
  const client = (eflaw: string, current = EMPTY_LAW_XML): LawApiClient =>
    ({
      searchLaw: async (_q: string, _k: unknown, _d: number, target: string) => (target === "eflaw" ? eflaw : current),
      fetchApi: async (p: { endpoint: string }) =>
        p.endpoint === "lawSearch.do"
          ? '<?xml version="1.0"?><CgmExpc><totalCnt>0</totalCnt></CgmExpc>'
          : unitJson([{ 조문번호: "26", 조문제목: "과다경비 등의 손금불산입", 조문내용: "제26조(과다경비 등의 손금불산입) 본문" }]),
      getThreeTier: async () => "{}",
      getAnnexes: async () => "{}",
      searchAdminRule: async () => '<?xml version="1.0"?><AdmRulSearch><totalCnt>0</totalCnt></AdmRulSearch>',
    }) as unknown as LawApiClient
  const otherRows = (n: number) => Array.from({ length: n }, (_, i) => histRow("소득세법", i, `${1980 + (i % 26)}0101`))

  it("현행 0건 + 연혁 목록 일부(153건 중 30건)에서 못 찾음 → ✗없음이 아니라 ⚠판정불가", async () => {
    const r = await handleFinArticle(client(histXml(otherRows(30), 153)), { law: "가상자산투기억제법", article: "제3조" })
    const text = r.content[0].text
    expect(text).toContain("[LAW_UNRESOLVED]")
    expect(text).toContain("연혁 검색 목록 전체 153건 중 받은 30건 안에서 찾지 못했습니다 — ⚠판정불가 (✗없음이 아님")
    expect(text).not.toContain("✗없음)")
    expect(text).not.toContain("현행·연혁 모두 정상 조회 후 0건")
    expect(r.isError).toBe(true)
  })

  it("[반대] 연혁 목록을 전부 받고(총 2건) 못 찾음 → 종전대로 ✗없음", async () => {
    const r = await handleFinArticle(client(histXml(otherRows(2), 2)), { law: "가상자산투기억제법", article: "제3조" })
    const text = r.content[0].text
    expect(text).toContain("[LAW_NOT_FOUND]")
    expect(text).toContain("현행·연혁 모두 정상 조회 후 0건 — ✗없음")
  })

  it("연혁 법령을 찾았지만 목록이 불완전하면 '가장 늦은 시행일'을 받은 목록 안으로 한정", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => histRow("증권거래법", i, `${1980 + (i % 26)}0101`))
    const r = await handleFinArticle(client(histXml(rows, 153)), { law: "증권거래법", article: "제2조" })
    const text = r.content[0].text
    expect(text).toContain("[LAW_HISTORIC]")
    expect(text).toContain("연혁 검색 목록 전체 153건 중 받은 30건 안에서 가장 늦은 시행일: 2005-01-01 — 목록 밖의 더 늦은 시행은 미확인")
    expect(text).not.toContain("연혁 목록의 가장 늦은 시행일")
  })

  it("[반대] 연혁 목록이 완전하면 종전 문구 '연혁 목록의 가장 늦은 시행일'", async () => {
    const rows = [histRow("증권거래법", 0, "20090204"), histRow("증권거래법", 1, "20040401")]
    const r = await handleFinArticle(client(histXml(rows, 2)), { law: "증권거래법", article: "제2조" })
    expect(r.content[0].text).toContain("연혁 목록의 가장 늦은 시행일: 2009-02-04 (폐지·개칭")
  })

  it("개정 예정: 검색 목록 일부(300건 중 20건)만 받으면 확인 범위를 고지한다 — 발견 0건이어도 '없음' 단정 안 함", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => histRow("법인세법", i, `${1990 + i}0101`))
    const r = await handleFinArticle(client(histXml(rows, 300), lawXml("법인세법", "280349")), {
      law: "법인세법",
      article: "제26조",
      include_rulings: false,
    })
    const text = r.content[0].text
    expect(text).toContain(
      '■ 법령 개정 예정 — 받은 목록에서는 발견되지 않음 (확인 범위: 연혁 검색 목록 전체 300건 중 받은 20건만 확인 — 목록 밖의 공포된 개정은 누락됐을 수 있음). "개정 예정 없음"으로 단정하지 말 것'
    )
  })

  it("개정 예정: 불완전 목록에서 발견되면 그 줄 끝에 확인 범위를 붙인다", async () => {
    const rows = [histRow("법인세법", 0, "20991231", "시행예정"), ...Array.from({ length: 19 }, (_, i) => histRow("법인세법", i + 1, `${1990 + i}0101`))]
    const r = await handleFinArticle(client(histXml(rows, 300), lawXml("법인세법", "280349")), {
      law: "법인세법",
      article: "제26조",
      include_rulings: false,
    })
    const text = r.content[0].text
    expect(text).toContain("2099-12-31 시행 개정 공포됨")
    expect(text).toContain("(확인 범위: 연혁 검색 목록 전체 300건 중 받은 20건만 확인")
  })

  it("[반대] 개정 예정: 목록은 불완전해도 이 법령 행이 시행일 내림차순으로 이미 시행된 행까지 왔으면 고지 없음", async () => {
    // 실응답 순서(시행일 내림차순 — article-historic.test.ts 픽스처 주석) — 미래 행은 앞쪽에 다 들어왔다
    const rows = [
      histRow("법인세법", 0, "20991231", "시행예정"),
      ...Array.from({ length: 19 }, (_, i) => histRow("법인세법", i + 1, `${2025 - i}0101`)),
    ]
    const r = await handleFinArticle(client(histXml(rows, 569), lawXml("법인세법", "280349")), {
      law: "법인세법",
      article: "제26조",
      include_rulings: false,
    })
    const text = r.content[0].text
    expect(text).toContain("2099-12-31 시행 개정 공포됨")
    expect(text).not.toContain("확인 범위")
  })

  it("[반대] 개정 예정: 목록이 완전하고 발견 0건이면 종전처럼 줄 없음", async () => {
    const rows = [histRow("법인세법", 0, "20200101")]
    const r = await handleFinArticle(client(histXml(rows, 1), lawXml("법인세법", "280349")), {
      law: "법인세법",
      article: "제26조",
      include_rulings: false,
    })
    expect(r.content[0].text).not.toContain("법령 개정 예정")
  })
})
