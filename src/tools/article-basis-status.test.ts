/**
 * fin_article 회귀 — 기준일 조회에 "폐지·과거본" 딱지가 붙던 문제
 *
 * `resolveVersionAt`이 기준일 시행본으로 갈아끼우면서 status를 무조건 "연혁"으로
 * 덮어쓴다(article.ts의 ①-b). 그 값을 헤더 라벨에 그대로 찍으면
 *   ① 기준일 조회에서 그 시점 시행본은 **정상 결과**인데 이상으로 읽히고
 *   ② 미래 시행일에서는 "과거본"이 사실과 정반대가 된다
 * 특히 이 도구는 "개정 예정" 줄에서 basis_date로 그 시행일을 조회하라고 직접 권한다 —
 * 권한 대로 한 사용자에게 "폐지" 딱지를 보여주면 개정 대비 검토를 막는 (b)형이다.
 *
 * fin_law_search는 같은 문제를 basisMode로 이미 막아 뒀다(law-search.ts formatLawLine).
 * 같은 판정이 fin_article에는 닿지 않은 "절반만 고쳐진" 사례 — 이 테스트가 재발을 막는다.
 */
import { describe, it, expect, beforeEach } from "vitest"
import { handleFinArticle } from "./article.js"
import { lawCache } from "../lib/cache.js"
import type { LawApiClient } from "../lib/api-client.js"

const LAW_NAME = "근로자퇴직급여 보장법"

/** 오늘 기준 상대 날짜 — 하드코딩하면 시간이 지나며 테스트가 거짓말을 한다 */
function ymdOffsetYears(years: number): string {
  const d = new Date()
  d.setFullYear(d.getFullYear() + years)
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`
}
const FUTURE_YMD = ymdOffsetYears(1)
const PAST_YMD = ymdOffsetYears(-5)
const CURRENT_YMD = "20260701"

const dash = (ymd: string): string => `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`

/** 현행 검색 결과 — 현행연혁코드=현행 */
const LAW_XML = `<?xml version="1.0" encoding="UTF-8"?>
<LawSearch><totalCnt>1</totalCnt>
  <law id="1"><법령명한글>${LAW_NAME}</법령명한글><법령일련번호>100000</법령일련번호><법령ID>1</법령ID>
    <법령구분명>법률</법령구분명><소관부처명>고용노동부</소관부처명><소관부처코드>1492000</소관부처코드>
    <시행일자>${CURRENT_YMD}</시행일자><제개정구분명>일부개정</제개정구분명><현행연혁코드>현행</현행연혁코드></law>
</LawSearch>`

/** 같은 법령이 연혁(폐지·과거본)으로만 잡히는 경우 — 기준일 없이 조회한 상태 */
const LAW_XML_HISTORIC = LAW_XML.replace("<현행연혁코드>현행</현행연혁코드>", "<현행연혁코드>연혁</현행연혁코드>")

/** eflaw 시행본 슬라이스 — 기준일 해소가 읽는 응답 */
function slicesXml(ymd: string, mst: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<LawSearch><totalCnt>1</totalCnt>
  <law id="1"><법령명한글>${LAW_NAME}</법령명한글><법령일련번호>${mst}</법령일련번호>
    <시행일자>${ymd}</시행일자><공포일자>20260317</공포일자><공포번호>09897</공포번호>
    <제개정구분명>일부개정</제개정구분명></law>
</LawSearch>`
}

const ARTICLE_JSON = JSON.stringify({
  법령: {
    조문: {
      조문단위: [
        {
          조문여부: "조문",
          조문번호: "8",
          조문가지번호: "0",
          조문제목: "퇴직금제도의 설정 등",
          조문내용: "제8조(퇴직금제도의 설정 등) 계속근로기간 1년에 대하여 30일분 이상의 평균임금",
        },
      ],
    },
  },
})

/**
 * @param sliceYmd  기준일 해소가 돌려줄 시행본 날짜 (undefined면 슬라이스 0건)
 * @param lawXml    법령명 검색 응답 (현행/연혁 구분)
 */
function stub(sliceYmd?: string, lawXml: string = LAW_XML): LawApiClient {
  return {
    searchLaw: async (q: string) =>
      q.replace(/\s/g, "") === LAW_NAME.replace(/\s/g, "")
        ? lawXml
        : '<?xml version="1.0"?><LawSearch><totalCnt>0</totalCnt></LawSearch>',
    fetchApi: async (args: { endpoint?: string; target?: string }) =>
      args.target === "eflaw" && args.endpoint === "lawSearch.do"
        ? sliceYmd
          ? slicesXml(sliceYmd, "200000")
          : '<?xml version="1.0"?><LawSearch><totalCnt>0</totalCnt></LawSearch>'
        : ARTICLE_JSON,
    getThreeTier: async () => "{}",
    getAnnexes: async () => "{}",
    searchAdminRule: async () => '<?xml version="1.0"?><AdmRulSearch><totalCnt>0</totalCnt></AdmRulSearch>',
  } as unknown as LawApiClient
}

describe("fin_article — 기준일 조회의 시행본 라벨", () => {
  // findLaws는 법령명으로 lawCache(모듈 전역, TTL 1시간)를 탄다 — 같은 법령을
  // 현행/연혁 두 형태로 쓰는 케이스가 서로를 덮는다 (단독 실행은 통과, 전체 실행은 실패)
  beforeEach(() => lawCache.clear())

  it("미래 시행일 기준 조회에 '폐지·과거본'을 붙이지 않는다 (사실과 정반대다)", async () => {
    const r = await handleFinArticle(stub(FUTURE_YMD), {
      law: LAW_NAME,
      article: "제8조",
      basis_date: dash(FUTURE_YMD),
      include_rulings: false,
    })
    const text = r.content[0].text
    expect(text).not.toContain("폐지·과거본")
    expect(text).not.toContain("⚠연혁")
    // 아직 시행 전이라는 사실 자체는 알려야 한다 — 억제만 하면 현행과 구분이 사라진다
    expect(text).toContain("📅시행예정")
  })

  it("과거 시행일 기준 조회에도 경고를 붙이지 않는다 (그 시점 시행본이 정상 결과다)", async () => {
    const r = await handleFinArticle(stub(PAST_YMD), {
      law: LAW_NAME,
      article: "제8조",
      basis_date: dash(PAST_YMD),
      include_rulings: false,
    })
    const text = r.content[0].text
    expect(text).not.toContain("폐지·과거본")
    expect(text).not.toContain("📅시행예정") // 과거본은 시행예정이 아니다
    expect(text).toContain("[기준일:") // 기준일 조회라는 사실은 헤더가 말한다
  })

  it("기준일 없는 현행 조회에서 연혁본이면 경고는 그대로 유지한다 (억제가 과하면 안 된다)", async () => {
    const r = await handleFinArticle(stub(undefined, LAW_XML_HISTORIC), {
      law: LAW_NAME,
      article: "제8조",
      include_rulings: false,
    })
    const text = r.content[0].text
    expect(text).toContain("⚠연혁(폐지·과거본)")
  })
})
