/**
 * fin_article 회귀 — 위임 조문 본문 동봉 상한 고지 (잔여③)
 *
 * 3단비교가 본문을 안 실어주면 시행령·시행규칙 위임 상위 3건만 직접 조회해 동봉한다.
 * 그 상한이 응답에 안 적혀 있어 "어떤 위임은 본문, 어떤 건 제목만"이 되고,
 * 제목만 나온 조문이 "본문이 없는 조문"으로 읽히던 문제.
 */
import { describe, it, expect } from "vitest"
import { handleFinArticle } from "./article.js"
import type { LawApiClient } from "../lib/api-client.js"

const LAW_XML = `<?xml version="1.0" encoding="UTF-8"?>
<LawSearch><totalCnt>1</totalCnt>
  <law id="1"><법령명한글>법인세법</법령명한글><법령일련번호>280349</법령일련번호><법령ID>1</법령ID>
    <법령구분명>법률</법령구분명><소관부처명>기획재정부</소관부처명><소관부처코드>1051000</소관부처코드>
    <시행일자>20260701</시행일자><제개정구분명>일부개정</제개정구분명><현행연혁코드>현행</현행연혁코드></law>
</LawSearch>`

const ARTICLE_JSON = JSON.stringify({
  법령: {
    조문: {
      조문단위: [
        { 조문여부: "조문", 조문번호: "26", 조문가지번호: "0", 조문제목: "과다경비 등의 손금불산입", 조문내용: "제26조(과다경비 등의 손금불산입) 본문" },
      ],
    },
  },
})

// 본문(조내용)이 비어 있는 시행령 위임 4건 — 상한 3건을 넘긴다
const THREE_TIER_JSON = JSON.stringify({
  LspttnThdCmpLawXService: {
    기본정보: { 법령ID: "1", 법령명: "법인세법", 시행령명: "법인세법 시행령", 삼단비교존재여부: "Y" },
    위임조문삼단비교: {
      법률조문: {
        조번호: "0026",
        조가지번호: "00",
        조제목: "과다경비 등의 손금불산입",
        조내용: "제26조 본문",
        시행령조문: [
          { 조번호: "0043", 조가지번호: "00", 조제목: "상여금 등의 손금불산입", 조내용: "" },
          { 조번호: "0044", 조가지번호: "00", 조제목: "퇴직급여의 손금불산입", 조내용: "" },
          { 조번호: "0045", 조가지번호: "00", 조제목: "복리후생비의 손금불산입", 조내용: "" },
          { 조번호: "0046", 조가지번호: "00", 조제목: "여비 등의 손금불산입", 조내용: "" },
        ],
      },
    },
  },
})

/** 시행령 MST 해소는 실패시켜 bodyMap을 비운다 — 상한 고지 문구만 검사 */
function stub(): LawApiClient {
  return {
    searchLaw: async (q: string) => (q === "법인세법" ? LAW_XML : '<?xml version="1.0"?><LawSearch><totalCnt>0</totalCnt></LawSearch>'),
    fetchApi: async () => ARTICLE_JSON,
    getThreeTier: async () => THREE_TIER_JSON,
    getAnnexes: async () => "{}",
    searchAdminRule: async () => '<?xml version="1.0"?><AdmRulSearch><totalCnt>0</totalCnt></AdmRulSearch>',
  } as unknown as LawApiClient
}

describe("fin_article — 위임 본문 동봉 상한 고지 (잔여③)", () => {
  it("본문이 빠진 위임 건수와 그 사유를 밝힌다", async () => {
    const r = await handleFinArticle(stub(), { law: "법인세법", article: "제26조" })
    const text = r.content[0].text
    expect(text).toContain("위임 조문 본문")
    expect(text).toContain("제목만 표시")
    // 상한 초과와 조회 실패를 구분해 표기한다 (Codex 리뷰 개선 1)
    expect(text).toMatch(/상위 3건 상한 초과|조회 실패·시간 초과/)
    // 직접 조회 경로를 안내한다
    expect(text).toContain("fin_article")
  })

  it("위임 조문 제목 자체는 그대로 나온다 (고지가 목록을 대체하지 않는다)", async () => {
    const r = await handleFinArticle(stub(), { law: "법인세법", article: "제26조" })
    const text = r.content[0].text
    expect(text).toContain("상여금 등의 손금불산입")
    expect(text).toContain("여비 등의 손금불산입")
  })
})
