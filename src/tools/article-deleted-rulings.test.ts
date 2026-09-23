/**
 * fin_article 회귀 — 삭제 조문 표지와 예규 후보 정렬 (9차 후속)
 *
 * ① 삭제 조문: 법제처는 삭제된 조문도 번호를 남긴다("제39조 삭제 <2001.12.31>" — 법인세법 조문 213개 중 32개).
 *    fin_verify는 이것을 ⚠삭제 조문으로 판정하는데(admin-rule-citation.ts parseDeletedArticle), fin_article은
 *    같은 조문에 표지 없이 위임·예규 섹션을 붙여 살아 있는 조문으로 읽혔다. 번호로 찾은 예규는 삭제 전
 *    조문에 관한 것이라 "이 조문의 예규 후보"가 되면 안 된다.
 * ② 예규 후보 정렬: sort 없이 display=3을 부르면 법제처 기본 정렬(안건명 가나다순)의 앞 3건이 오는데
 *    "N건 중 상위 3건"으로 표기했다. fin_ruling_search와 같은 sort=ddes(일자 내림차순)를 쓴다.
 * ③ 기준일 본문 조회의 efYd는 기준일이 아니라 시행본 시행일이다 (검수자 실측: 근로기준법 MST 150421 +
 *    efYd=20180101 → "일치하는 법령이 없습니다" / efYd=20140701 → 제35조 본문).
 */
import { describe, it, expect, beforeEach } from "vitest"
import { handleFinArticle } from "./article.js"
import { lawCache } from "../lib/cache.js"
import type { LawApiClient } from "../lib/api-client.js"

const lawXml = (name: string, mst: string, efYd: string) => `<?xml version="1.0" encoding="UTF-8"?>
<LawSearch><totalCnt>1</totalCnt>
  <law id="1"><법령명한글>${name}</법령명한글><법령일련번호>${mst}</법령일련번호><법령ID>001563</법령ID>
    <법령구분명>법률</법령구분명><시행일자>${efYd}</시행일자><제개정구분명>일부개정</제개정구분명><현행연혁코드>현행</현행연혁코드></law>
</LawSearch>`

const unitJson = (unit: Record<string, unknown>) => JSON.stringify({ 법령: { 조문: { 조문단위: [{ 조문여부: "조문", ...unit }] } } })

// law-280349 실응답 조문단위 형태
const DELETED_39 = unitJson({ 조문번호: "39", 조문내용: "제39조 삭제 <2001.12.31>" })
const HANG_DELETED = unitJson({
  조문번호: "18",
  조문제목: "수입배당금액의 익금불산입",
  조문내용: "제18조(수입배당금액의 익금불산입)",
  항: [
    { 항번호: "①", 항내용: "① 내국법인이 …익금에 산입하지 아니한다." },
    { 항번호: "②", 항내용: "② 삭제 <2022.12.31>" },
  ],
})
const TITLE_WITH_DELETE_WORD = unitJson({
  조문번호: "10",
  조문제목: "등록의 삭제",
  조문내용: "제10조(등록의 삭제) 관할 세무서장은 등록을 삭제할 수 있다.",
})
const ALIVE_26 = unitJson({ 조문번호: "26", 조문제목: "과다경비 등의 손금불산입", 조문내용: "제26조(과다경비 등의 손금불산입) 본문" })

/** total에 빈 문자열을 주면 totalCnt 태그 자체가 빠진다 (법제처 응답 형태 방어) */
const rulingXml = (dates: string[], total: number | string = 12) =>
  `<?xml version="1.0" encoding="UTF-8"?><CgmExpc>${total === "" ? "" : `<totalCnt>${total}</totalCnt>`}` +
  dates
    .map((d, i) => `<cgmExpc id="${i + 1}"><안건명>예규 ${i + 1}</안건명><안건번호>법인세과-${100 + i}</안건번호><해석일자>${d}</해석일자></cgmExpc>`)
    .join("") +
  "</CgmExpc>"

const THREE_TIER_39 = JSON.stringify({
  LspttnThdCmpLawXService: {
    기본정보: { 법령명: "법인세법", 기준법령명: "법인세법", 삼단비교존재여부: "Y" },
    기준법령목록: { 법령명: "법인세법" },
    // 삭제 조문 자리에 매핑이 남아 있는 경우(가정) — 싣지 않아야 한다
    위임조문삼단비교: {
      법률조문: { 조번호: "0039", 조가지번호: "00", 시행령조문: { 조번호: "0076", 조가지번호: "00", 법령명: "법인세법 시행령", 조제목: "" } },
    },
  },
})

interface Calls {
  rulingParams: Array<Record<string, string>>
}

function stub(article: string, calls: Calls, opts: { rulings?: string; threeTier?: string } = {}): LawApiClient {
  return {
    searchLaw: async () => lawXml("법인세법", "280349", "20260101"),
    fetchApi: async (p: { endpoint: string; target: string; extraParams?: Record<string, string> }) => {
      if (p.target === "ntsCgmExpc") {
        calls.rulingParams.push(p.extraParams || {})
        return opts.rulings ?? rulingXml([])
      }
      if (p.endpoint === "lawSearch.do") return '<?xml version="1.0"?><LawSearch><totalCnt>0</totalCnt></LawSearch>'
      return article
    },
    getThreeTier: async () => opts.threeTier ?? THREE_TIER_39,
    getAnnexes: async () => "{}",
    searchAdminRule: async () => '<?xml version="1.0"?><AdmRulSearch><totalCnt>0</totalCnt></AdmRulSearch>',
  } as unknown as LawApiClient
}

const newCalls = (): Calls => ({ rulingParams: [] })

beforeEach(() => lawCache.clear())

describe("fin_article — 조 전체가 삭제된 조문 표지", () => {
  it("법인세법 제39조: 헤더·첫 줄에 삭제 표지를 달고 위임 목록과 예규 검색을 싣지 않는다", async () => {
    const calls = newCalls()
    const r = await handleFinArticle(stub(DELETED_39, calls, { rulings: rulingXml(["20240101"]) }), { law: "법인세법", article: "제39조" })
    const text = r.content[0].text
    expect(text.split("\n")[0]).toContain("조회 성공 — ⚠삭제된 조문(삭제 <2001.12.31>)")
    expect(text).toContain("■ 법인세법 제39조 ⚠삭제된 조문(삭제 <2001.12.31>)")
    // 본문 렌더러(cleanHtml)는 <…> 개정 표기를 지운다 — 삭제 일자는 헤더 표지가 보존한다
    expect(text).toContain("■ 법인세법 제39조 ⚠삭제된 조문(삭제 <2001.12.31>)\n제39조 삭제")
    // 3단비교에 남은 매핑이 "삭제된 조문의 위임"으로 나가지 않는다
    expect(text).not.toContain("[시행령] 법인세법 시행령 제76조")
    expect(text).toContain("위임 조회 생략 — 삭제된 조문(삭제 <2001.12.31>)입니다")
    // 번호로 폴백한 예규 검색을 하지 않는다
    expect(calls.rulingParams).toEqual([])
    expect(text).toContain("검색 생략 — 삭제된 조문이라")
    expect(text).not.toContain("법인세과-100")
  })

  it("반대 방향: 항 하나만 삭제된 조문은 살아 있는 조문이다 (표지 없음)", async () => {
    const calls = newCalls()
    const r = await handleFinArticle(stub(HANG_DELETED, calls), { law: "법인세법", article: "제18조" })
    const text = r.content[0].text
    expect(text).not.toContain("⚠삭제된 조문")
    expect(text).not.toContain("위임 조회 생략 — 삭제된")
    expect(calls.rulingParams.length).toBeGreaterThan(0)
  })

  it("반대 방향: 제목에 '삭제'라는 낱말이 든 조문도 표지 없음", async () => {
    const r = await handleFinArticle(stub(TITLE_WITH_DELETE_WORD, newCalls()), { law: "법인세법", article: "제10조", include_rulings: false })
    expect(r.content[0].text).not.toContain("⚠삭제된 조문")
  })
})

describe("fin_article — 기준일 조회: efYd는 시행본 시행일, 그 시점 삭제 조문도 표지", () => {
  // 근로기준법 §35: 2014-07-01 시행본에는 살아 있고, 2019-01-15에 삭제됐다 (검수자 실측)
  const slices = `<?xml version="1.0" encoding="UTF-8"?><LawSearch><totalCnt>2</totalCnt>
  <law id="1"><법령명한글>근로기준법</법령명한글><법령일련번호>207000</법령일련번호><시행일자>20190115</시행일자><공포일자>20190115</공포일자><공포번호>16270</공포번호><제개정구분명>일부개정</제개정구분명></law>
  <law id="2"><법령명한글>근로기준법</법령명한글><법령일련번호>150421</법령일련번호><시행일자>20140701</시행일자><공포일자>20140121</공포일자><공포번호>12325</공포번호><제개정구분명>일부개정</제개정구분명></law></LawSearch>`

  function basisStub(efYds: string[]): LawApiClient {
    return {
      searchLaw: async () => lawXml("근로기준법", "283457", "20260101"),
      fetchApi: async (p: { endpoint: string; target: string; extraParams?: Record<string, string> }) => {
        if (p.endpoint === "lawSearch.do" && p.target === "eflaw") {
          const to = (p.extraParams?.efYd || "").split("~")[1] || "99991231"
          // 범위 검색 흉내 — 기준일 이하 행만
          return to >= "20190115" ? slices : slices.replace(/<law id="1">[\s\S]*?<\/law>/, "")
        }
        if (p.endpoint === "lawSearch.do") return '<?xml version="1.0"?><CgmExpc><totalCnt>0</totalCnt></CgmExpc>'
        const { MST, efYd } = p.extraParams || {}
        efYds.push(`${MST}@${efYd}`)
        // 실서버: 시행본 MST에 그 시행일이 아닌 efYd를 주면 "일치하는 법령이 없습니다"/HTML 오류
        if (MST === "150421" && efYd === "20140701") {
          return unitJson({ 조문번호: "35", 조문제목: "예고해고의 적용 예외", 조문내용: "제35조(예고해고의 적용 예외) 제26조는 다음 각 호의 어느 하나에 해당하는 근로자에게는 적용하지 아니한다." })
        }
        if (MST === "207000" && efYd === "20190115") return unitJson({ 조문번호: "35", 조문내용: "제35조 삭제 <2019.1.15>" })
        throw new Error("법제처 API 비정상 응답(HTML 페이지)")
      },
      getThreeTier: async () => "{}",
      getAnnexes: async () => "{}",
      searchAdminRule: async () => '<?xml version="1.0"?><AdmRulSearch><totalCnt>0</totalCnt></AdmRulSearch>',
    } as unknown as LawApiClient
  }

  it("basis 2018-01-01 → 2014-07-01 시행본을 efYd=20140701로 조회해 제35조 본문이 나온다", async () => {
    const efYds: string[] = []
    const r = await handleFinArticle(basisStub(efYds), { law: "근로기준법", article: "제35조", basis_date: "2018-01-01", include_rulings: false })
    const text = r.content[0].text
    expect(efYds).toEqual(["150421@20140701"])
    expect(text).toContain("예고해고의 적용 예외")
    expect(text).not.toContain("⚠삭제된 조문")
    expect(text).not.toContain("조회 실패")
  })

  it("basis 2020-01-01 → 2019-01-15 시행본에서 삭제된 조문으로 표지한다", async () => {
    const efYds: string[] = []
    const r = await handleFinArticle(basisStub(efYds), { law: "근로기준법", article: "제35조", basis_date: "2020-01-01", include_rulings: false })
    const text = r.content[0].text
    expect(efYds).toEqual(["207000@20190115"])
    expect(text).toContain("■ 근로기준법 제35조 ⚠삭제된 조문(삭제 <2019.1.15>) — 기준일 시행본 기준")
  })
})

describe("fin_article — 예규 후보는 최신순으로 받는다", () => {
  it("sort=ddes를 요청하고, 응답이 일자 내림차순이면 '최신 N건'으로 표기한다", async () => {
    const calls = newCalls()
    const r = await handleFinArticle(stub(ALIVE_26, calls, { rulings: rulingXml(["20250310", "20240105", "20230101"], 42) }), {
      law: "법인세법",
      article: "제26조",
    })
    const text = r.content[0].text
    expect(calls.rulingParams[0]).toMatchObject({ sort: "ddes", display: "3" })
    expect(text).toContain("42건 중 최신 3건")
    expect(text).not.toContain("상위 3건")
  })

  it("반대 방향: 응답 순서가 일자 내림차순이 아니면(정렬 무시) '최신'이라 부르지 않는다", async () => {
    const calls = newCalls()
    const r = await handleFinArticle(stub(ALIVE_26, calls, { rulings: rulingXml(["20130716", "20250310", "20200101"], 42) }), {
      law: "법인세법",
      article: "제26조",
    })
    const text = r.content[0].text
    expect(text).toContain("42건 중 3건(일자순 정렬 미확인)")
    expect(text).not.toContain("최신")
  })

  it("전체가 3건 이하라도 받은 순서가 일자순이 아니면 '전체 목록'이지 '최신순'이 아니다", async () => {
    // 총수 확인(전체를 다 받았다)과 정렬 확인(내림차순으로 왔다)은 별개다 — 종전 코드는
    // allReturned만으로 "최신 2건"이라 적어, 법제처가 sort를 무시한 응답을 최신순으로 표기했다
    const calls = newCalls()
    const r = await handleFinArticle(stub(ALIVE_26, calls, { rulings: rulingXml(["20130716", "20250310"], 2) }), {
      law: "법인세법",
      article: "제26조",
    })
    const text = r.content[0].text
    expect(text).toContain("2건 중 전체 2건(받은 순서 그대로 — 일자순 정렬 미확인)")
    expect(text).not.toContain("최신")
  })

  it("전체 2건이 내림차순으로 오면 '최신'으로 표기한다 (반대 방향)", async () => {
    const calls = newCalls()
    const r = await handleFinArticle(stub(ALIVE_26, calls, { rulings: rulingXml(["20250310", "20130716"], 2) }), {
      law: "법인세법",
      article: "제26조",
    })
    expect(r.content[0].text).toContain("2건 중 최신 2건")
  })
})

describe("fin_article — 총건수는 totalCnt로만 말한다 (받은 수를 총수로 쓰지 않는다)", () => {
  it("totalCnt 태그가 없으면 받은 3건을 총수처럼 적지 않고 미확인을 밝힌다", async () => {
    const calls = newCalls()
    const r = await handleFinArticle(stub(ALIVE_26, calls, { rulings: rulingXml(["20250310", "20240105", "20230101"], "") }), {
      law: "법인세법",
      article: "제26조",
    })
    const text = r.content[0].text
    expect(text).toContain("총건수 미확인(응답에 totalCnt 없음) — 최신 3건")
    expect(text).not.toContain("3건 중")
  })

  it("totalCnt가 숫자가 아니어도 같다 (빈 태그·문자열)", async () => {
    const calls = newCalls()
    const r = await handleFinArticle(stub(ALIVE_26, calls, { rulings: rulingXml(["20250310", "20240105"], "조회 실패") }), {
      law: "법인세법",
      article: "제26조",
    })
    const text = r.content[0].text
    expect(text).toContain("총건수 미확인(응답에 totalCnt 없음) — 최신 2건")
    expect(text).not.toContain("조회 실패건")
  })

  it("totalCnt가 받은 수보다 작으면(응답 불일치) 총수로 믿지 않는다", async () => {
    const calls = newCalls()
    const r = await handleFinArticle(stub(ALIVE_26, calls, { rulings: rulingXml(["20250310", "20240105", "20230101"], 1) }), {
      law: "법인세법",
      article: "제26조",
    })
    const text = r.content[0].text
    expect(text).toContain("총건수 미확인(totalCnt 1건 < 받은 3건) — 최신 3건")
    expect(text).not.toContain("1건 중")
  })

  it("반대 방향: totalCnt가 받은 수보다 크면 종전대로 '42건 중'이다", async () => {
    const calls = newCalls()
    const r = await handleFinArticle(stub(ALIVE_26, calls, { rulings: rulingXml(["20250310", "20240105", "20230101"], 42) }), {
      law: "법인세법",
      article: "제26조",
    })
    const text = r.content[0].text
    expect(text).toContain("42건 중 최신 3건")
    expect(text).not.toContain("총건수 미확인")
  })

  it("일자를 하나도 못 읽으면 전체를 다 받았어도 '최신'이라 부르지 않는다 (경계: ruling-search.isLatestFirst)", async () => {
    // isLatestFirst가 "일자를 못 읽은 항목이 있으면 false"여야 성립한다 (ruling-search.ts 계약)
    const calls = newCalls()
    const r = await handleFinArticle(stub(ALIVE_26, calls, { rulings: rulingXml(["", "", ""], 3) }), {
      law: "법인세법",
      article: "제26조",
    })
    const text = r.content[0].text
    expect(text).toContain("3건 중 전체 3건(받은 순서 그대로 — 일자순 정렬 미확인)")
    expect(text).not.toContain("최신")
  })

  it("일자가 일부만 유효해도 '최신'이라 부르지 않는다 — 그 항목의 위치를 확인할 수 없다", async () => {
    // 이 섹션은 받은 순서를 그대로 표시한다(재정렬 없음) — 일자를 못 읽은 항목이 하나라도 있으면
    // 그것이 어디에 있어야 할지 모르므로 내림차순 주장이 서지 않는다 (ruling-search.isLatestFirst 계약)
    const calls = newCalls()
    const r = await handleFinArticle(stub(ALIVE_26, calls, { rulings: rulingXml(["20250310", "", "20230101"], 42) }), {
      law: "법인세법",
      article: "제26조",
    })
    const text = r.content[0].text
    expect(text).toContain("42건 중 3건(일자순 정렬 미확인)")
    expect(text).not.toContain("최신")
  })

  it("전체를 다 받고 일자도 다 읽혔지만 순서가 뒤섞이면 재정렬하지 않고 전체 목록으로 적는다", async () => {
    // ruling-search의 assessLatestFirst는 이 경우를 "최신순"으로 본다 — 그쪽 호출부가 일자순으로
    // 재정렬하기 때문이다(nts-ruling.ts items.sort). fin_article은 재정렬하지 않으므로 그 근거를 쓸 수 없다
    const calls = newCalls()
    const r = await handleFinArticle(stub(ALIVE_26, calls, { rulings: rulingXml(["20130716", "20250310", "20200101"], 3) }), {
      law: "법인세법",
      article: "제26조",
    })
    const text = r.content[0].text
    expect(text).toContain("3건 중 전체 3건(받은 순서 그대로 — 일자순 정렬 미확인)")
    expect(text).not.toContain("최신")
    // 표시 순서는 받은 순서 그대로 — 재정렬해 놓고 "받은 순서"라 적으면 거짓이 된다
    expect(text.indexOf("법인세과-100")).toBeLessThan(text.indexOf("법인세과-101"))
  })
})
