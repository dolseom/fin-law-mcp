/**
 * fin_article 회귀 — 조문 번호에 항·호·제목이 붙은 입력 (9차 리뷰 B4)
 *
 * 전에는 "제26조"·"26"·"제10조의2"만 조 단위로 정규화했다. "제26조제1항"은 그대로 라벨이 되어
 *   ① 3단비교의 "제26조"와 안 맞아 **실존 위임을 "(위임 조문 없음)"으로 단정**했고
 *      (검수자 라이브 재현: 법인세법 제26조제1항 → 없음 / 제26조 → 시행령 6개 조문 이상)
 *   ② "제10조의2제3항"은 JO 변환에서 가지번호가 잘려 **제10조 본문**을 받았다.
 * 위임 매핑은 조 단위이므로 조로 접어 조회하고, 항·호가 있었다는 사실은 고지로 남긴다.
 * 조로 접을 수 없는 입력("부칙 제3조", "제26조 및 제27조")은 앞 숫자만 떼어 **다른 조문**을
 * 답하던 경로라 법령 확정 뒤 거절한다.
 */
import { describe, it, expect, beforeEach } from "vitest"
import { handleFinArticle } from "./article.js"
import { lawCache } from "../lib/cache.js"
import type { LawApiClient } from "../lib/api-client.js"

const LAW_XML = `<?xml version="1.0" encoding="UTF-8"?>
<LawSearch><totalCnt>1</totalCnt>
  <law id="1"><법령명한글>법인세법</법령명한글><법령일련번호>280349</법령일련번호><법령ID>001563</법령ID>
    <법령구분명>법률</법령구분명><시행일자>20260101</시행일자><제개정구분명>일부개정</제개정구분명><현행연혁코드>현행</현행연혁코드></law>
</LawSearch>`
const EMPTY_LAW_XML = '<?xml version="1.0"?><LawSearch><totalCnt>0</totalCnt></LawSearch>'

const articleJson = (num: string, branch: string, title: string, body: string) =>
  JSON.stringify({
    법령: { 조문: { 조문단위: [{ 조문여부: "조문", 조문번호: num, 조문가지번호: branch, 조문제목: title, 조문내용: body }] } },
  })

// thd-280349 실응답의 §26 행 일부 (조내용 줄임)
const row26 = (decreeJo: string, rule?: [string, string]) => ({
  조번호: "0026",
  조가지번호: "00",
  조제목: "",
  조내용: "제3관 손금의 계산 <개정 2010.12.30>",
  시행령조문: { 조제목: "", 조가지번호: "00", 법령명: "법인세법 시행령", 조내용: "", 조번호: decreeJo },
  ...(rule ? { 시행규칙조문: { 조제목: rule[1], 조가지번호: "00", 법령명: "법인세법 시행규칙", 조내용: "", 조번호: rule[0] } } : {}),
})
const THREE_TIER = JSON.stringify({
  LspttnThdCmpLawXService: {
    기본정보: { 법령일련번호: "280349", 법령ID: "001563", 법령명: "법인세법", 기준법령명: "법인세법", 삼단비교존재여부: "Y" },
    기준법령목록: { 법령명: "법인세법" },
    위임조문삼단비교: {
      법률조문: [row26("0043"), row26("0044", ["0022", "제22조(현실적인 퇴직의 범위등)"]), row26("0045")],
    },
  },
})

function stub(joCalls: string[]): LawApiClient {
  return {
    searchLaw: async (q: string) => (q.replace(/\s+/g, "") === "법인세법" ? LAW_XML : EMPTY_LAW_XML),
    fetchApi: async (p: { endpoint: string; extraParams?: Record<string, string> }) => {
      if (p.endpoint === "lawSearch.do") return '<?xml version="1.0"?><CgmExpc><totalCnt>0</totalCnt></CgmExpc>'
      const jo = p.extraParams?.JO || ""
      if (p.extraParams?.MST === "280349") joCalls.push(jo)
      if (jo === "002600") return articleJson("26", "0", "과다경비 등의 손금불산입", "제26조(과다경비 등의 손금불산입) 모법 26조 본문")
      if (jo === "001002") return articleJson("10", "2", "연결사업연도", "제10조의2(연결사업연도) 10조의2 본문")
      if (jo === "001000") return articleJson("10", "0", "사업연도의 변경", "제10조(사업연도의 변경) 10조 본문")
      return '{"법령":{}}'
    },
    getThreeTier: async () => THREE_TIER,
    getAnnexes: async () => "{}",
    searchAdminRule: async () => '<?xml version="1.0"?><AdmRulSearch><totalCnt>0</totalCnt></AdmRulSearch>',
  } as unknown as LawApiClient
}

const run = async (article: string) => {
  const joCalls: string[] = []
  const r = await handleFinArticle(stub(joCalls), { law: "법인세법", article, include_rulings: false })
  return { r, text: r.content[0].text, joCalls }
}

beforeEach(() => lawCache.clear())

describe("fin_article — 항·호·제목이 붙은 조문 번호는 조 단위로 조회한다", () => {
  for (const article of ["제26조제1항", "제26조 제1항", "26조 1항", "제26조 제1호", "제26조(과다경비 등의 손금불산입)", "제26조(과다경비 등의 손금불산입) 제2항"]) {
    it(`"${article}" → 제26조의 본문·위임이 나온다 ("위임 조문 없음"으로 단정하지 않는다)`, async () => {
      const { r, text, joCalls } = await run(article)
      expect(r.isError).toBeFalsy()
      expect(text).toContain("■ 법인세법 제26조\n")
      expect(text).toContain("모법 26조 본문")
      expect(text).not.toContain("(위임 조문 없음)")
      expect(text).toContain("[시행령] 법인세법 시행령 제43조")
      expect(text).toContain("[시행규칙] 법인세법 시행규칙 제22조")
      expect(joCalls[0]).toBe("002600")
      // 링크도 조 단위 — "제26조제1항"을 그대로 넣은 주소는 열리지 않는다
      expect(text).toContain(encodeURI("https://www.law.go.kr/법령/법인세법/제26조"))
      expect(text).not.toContain(encodeURI(`/${article}`))
    })
  }

  it("항·호가 있었다는 사실과 위임 매핑이 조 단위라는 한계를 고지한다", async () => {
    const { text } = await run("제26조제1항")
    expect(text).toContain('요청 표기 "제26조제1항" → 조 단위(제26조)로 조회')
    expect(text).toContain("제1항에 해당하는 위임만 골라내지 못합니다")
  })

  it("조문 제목만 붙은 입력은 세부 표기가 없으므로 고지하지 않는다", async () => {
    const { text } = await run("제26조(과다경비 등의 손금불산입)")
    expect(text).not.toContain("요청 표기")
  })

  it('"제10조의2제3항"은 가지번호를 잃지 않는다 — 제10조 본문이 나가면 회귀', async () => {
    const { text, joCalls } = await run("제10조의2제3항")
    expect(joCalls[0]).toBe("001002")
    expect(text).toContain("■ 법인세법 제10조의2")
    expect(text).toContain("10조의2 본문")
    expect(text).not.toContain("10조 본문")
  })
})

describe("fin_article — 기존 표기는 그대로다 (반대 방향)", () => {
  for (const [article, jo, header] of [
    ["제26조", "002600", "■ 법인세법 제26조\n"],
    ["26", "002600", "■ 법인세법 제26조\n"],
    ["제 26 조", "002600", "■ 법인세법 제26조\n"],
    ["제10조의2", "001002", "■ 법인세법 제10조의2"],
    ["10의2", "001002", "■ 법인세법 제10조의2"],
  ] as const) {
    it(`"${article}" → ${header.trim()} (고지 없음)`, async () => {
      const { r, text, joCalls } = await run(article)
      expect(r.isError).toBeFalsy()
      expect(joCalls[0]).toBe(jo)
      expect(text).toContain(header)
      expect(text).not.toContain("요청 표기")
    })
  }
})

describe("fin_article — 조 단위로 접을 수 없는 표기는 다른 조문을 답하지 않고 거절한다", () => {
  for (const article of ["제26조 및 제27조", "부칙 제3조", "1항", "제26조제1항, 제27조"]) {
    it(`"${article}" → INVALID_PARAMETER (본문 조회 없음)`, async () => {
      const { r, text, joCalls } = await run(article)
      expect(r.isError).toBe(true)
      expect(text).toContain("[INVALID_PARAMETER]")
      expect(text).toContain("조 단위로 해석하지 못했습니다")
      expect(joCalls).toEqual([])
      expect(text).not.toContain("모법 26조 본문")
    })
  }
})
