/**
 * fin_article 회귀 — 시행령·시행규칙 조문을 물었을 때의 위임 섹션 (역방향 해소)
 *
 * 법제처 3단비교(thdCmp)는 **기준법령(모법) 조번호로만 색인**된다 — 시행령 MST로
 * 호출해도 같은 모법 매핑이 돌아온다 (2026-09-05 실측: 법인세법 MST 280349와
 * 법인세법 시행령 MST 283635의 `위임조문삼단비교.법률조문` 499건이 동일하고,
 * `기본정보.기준법령명`은 양쪽 다 "법인세법").
 *
 * 그래서 `fin_article("법인세법 시행령","제45조")`가 배열에서 조번호 0045를 그대로
 * 찾으면 **모법 §45**(합병 시 이월결손금 승계)의 위임인 시행령 §10·§81, 시행규칙 §4가
 * 시행령 §45(복리후생비)의 "위임"으로 본문까지 붙는다 — 무관한 조문이 근거가 되는
 * 오검증이다. 이 파일은 그 경로가 다시 열리지 않는지 fixture로 고정한다.
 *
 * 평가셋 4번("법인세법 시행령 제19조 손비의 범위 — 시행령→모법 역방향 연결")과 같은 축.
 */
import { describe, it, expect } from "vitest"
import { handleFinArticle } from "./article.js"
import { normalizeLawSearchText, resolveLawAlias } from "../lib/search-normalizer.js"
import type { LawApiClient } from "../lib/api-client.js"

/** 실 LawApiClient.searchLaw는 질의를 정규화·별칭 해소한 뒤 던진다 — 스텁도 같게 */
const asSearched = (q: string) => resolveLawAlias(normalizeLawSearchText(q)).canonical.replace(/\s+/g, "")

const DECREE_MST = "283635"
const PARENT_MST = "280349"
const RULE_MST = "283700"

const lawXml = (name: string, mst: string, id: string, type: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<LawSearch><totalCnt>1</totalCnt>
  <law id="1"><법령명한글>${name}</법령명한글><법령일련번호>${mst}</법령일련번호><법령ID>${id}</법령ID>
    <법령구분명>${type}</법령구분명><소관부처명>기획재정부</소관부처명><소관부처코드>1051000</소관부처코드>
    <시행일자>20260227</시행일자><제개정구분명>일부개정</제개정구분명><현행연혁코드>현행</현행연혁코드></law>
</LawSearch>`

const EMPTY_LAW_XML = '<?xml version="1.0"?><LawSearch><totalCnt>0</totalCnt></LawSearch>'
const EMPTY_RULING_XML = '<?xml version="1.0"?><CgmExpc><totalCnt>0</totalCnt></CgmExpc>'

/** 법제처 실응답 형태 그대로 — 조제목은 비고, 조내용에는 편장절관 헤더가 온다 */
const row = (baseJo: string, decree?: [string, string, string], rule?: [string, string, string]) => {
  const r: Record<string, unknown> = {
    조번호: baseJo,
    조가지번호: "00",
    조제목: "",
    조내용: "제3관 손금의 계산 <개정 2010.12.30>",
  }
  if (decree) {
    r.시행령조문 = { 조번호: decree[0], 조가지번호: decree[1], 법령명: "법인세법 시행령", 조제목: decree[2], 조내용: "" }
  }
  if (rule) {
    r.시행규칙조문 = { 조번호: rule[0], 조가지번호: rule[1], 법령명: "법인세법 시행규칙", 조제목: rule[2], 조내용: "" }
  }
  return r
}

const THREE_TIER_JSON = JSON.stringify({
  LspttnThdCmpLawXService: {
    기본정보: {
      법령일련번호: DECREE_MST,
      법령ID: "003608",
      법령명: "법인세법 시행령",
      기준법령명: "법인세법",
      삼단비교존재여부: "Y",
    },
    기준법령목록: { 법령명: "법인세법" },
    위임조문삼단비교: {
      법률조문: [
        // 모법 §26(과다경비 등의 손금불산입) → 시행령 §43·§44·§45, 시행규칙 §22
        row("0026", ["0043", "00", ""]),
        row("0026", ["0044", "00", ""], ["0022", "00", "제22조(현실적인 퇴직의 범위등)"]),
        row("0026", ["0045", "00", ""]),
        // 모법 §54(소득금액 계산에 관한 세부 규정 — 포괄 위임) → 시행령 §45
        row("0054", ["0045", "00", ""]),
        // 모법 §45(합병 시 이월결손금 승계) → 시행령 §10·§81, 시행규칙 §4
        // ★ 시행령 §45 질의에 이 행이 실리면 회귀다 (조번호만 같고 법령이 다르다)
        row("0045", ["0010", "00", ""], ["0004", "00", "제4조(결손금 공제)"]),
        row("0045", ["0081", "00", ""]),
      ],
    },
  },
})

const articleJson = (num: string, branch: string, title: string, body: string) =>
  JSON.stringify({
    법령: { 조문: { 조문단위: [{ 조문여부: "조문", 조문번호: num, 조문가지번호: branch, 조문제목: title, 조문내용: body }] } },
  })

/** MST + JO로 어떤 법령의 어떤 조문인지 구분하는 스텁 (실서버와 같은 분기) */
function stub(): LawApiClient {
  return {
    searchLaw: async (q: string) => {
      const n = asSearched(q)
      if (n === "법인세법시행령") return lawXml("법인세법 시행령", DECREE_MST, "003608", "대통령령")
      if (n === "법인세법시행규칙") return lawXml("법인세법 시행규칙", RULE_MST, "003609", "기획재정부령")
      if (n === "법인세법") return lawXml("법인세법", PARENT_MST, "001563", "법률")
      return EMPTY_LAW_XML
    },
    fetchApi: async (p: { endpoint: string; target: string; extraParams?: Record<string, string> }) => {
      if (p.endpoint === "lawSearch.do") return EMPTY_RULING_XML
      const mst = p.extraParams?.MST
      const jo = p.extraParams?.JO
      if (mst === DECREE_MST && jo === "004500") {
        return articleJson("45", "0", "복리후생비의 손금불산입", "제45조(복리후생비의 손금불산입) 시행령 45조 본문")
      }
      if (mst === RULE_MST && jo === "002200") {
        return articleJson("22", "0", "현실적인 퇴직의 범위등", "제22조(현실적인 퇴직의 범위등) 시행규칙 22조 본문")
      }
      if (mst === PARENT_MST && jo === "002600") {
        return articleJson("26", "0", "과다경비 등의 손금불산입", "제26조(과다경비 등의 손금불산입) 모법 26조 본문")
      }
      if (mst === PARENT_MST && jo === "005400") {
        return articleJson("54", "0", "소득금액 계산에 관한 세부 규정", "제54조(소득금액 계산에 관한 세부 규정) 모법 54조 본문")
      }
      // 모법 §45의 위임인 시행령 §10·§81 — 회귀 시 이 본문이 응답에 실린다
      if (mst === DECREE_MST && jo === "001000") {
        return articleJson("10", "0", "합병 시 이월결손금 승계", "제10조(합병 시 이월결손금 승계) 승계결손금 본문")
      }
      if (mst === DECREE_MST && jo === "008100") {
        return articleJson("81", "0", "분할 시 이월결손금 승계", "제81조(분할 시 이월결손금 승계) 분할결손금 본문")
      }
      return '{"법령":{}}'
    },
    getThreeTier: async () => THREE_TIER_JSON,
    getAnnexes: async () => "{}",
    searchAdminRule: async () => '<?xml version="1.0"?><AdmRulSearch><totalCnt>0</totalCnt></AdmRulSearch>',
  } as unknown as LawApiClient
}

describe("fin_article — 시행령 조문 질의는 모법 위임을 역방향으로 해소한다", () => {
  it("모법 §45의 위임(시행령 §10·§81, 시행규칙 §4)이 시행령 §45의 위임으로 실리지 않는다", async () => {
    const r = await handleFinArticle(stub(), { law: "법인세법 시행령", article: "제45조" })
    const text = r.content[0].text
    // ★ 핵심 회귀: 조번호만 같은 모법 §45의 하위 조문이 새어 나오면 실패
    expect(text).not.toContain("시행령 제10조")
    expect(text).not.toContain("시행령 제81조")
    expect(text).not.toContain("시행규칙 제4조")
    expect(text).not.toContain("결손금 승계")
    expect(text).not.toContain("결손금 공제")
    // 정방향 라벨([시행령]/[시행규칙])은 하위법령 질의에 나오면 안 된다
    expect(text).not.toContain("[시행령]")
    expect(text).not.toContain("[시행규칙]")
  })

  it("대신 이 시행령 조문을 위임한 모법 조문을 '모법 위임 근거'로 보여준다", async () => {
    const r = await handleFinArticle(stub(), { law: "법인세법 시행령", article: "제45조" })
    const text = r.content[0].text
    expect(text).toContain("■ 모법 위임 근거")
    expect(text).toContain("역방향")
    expect(text).toContain("[모법] 법인세법 제26조")
    // 포괄 위임(§54)도 실제 매핑이므로 함께 나온다
    expect(text).toContain("[모법] 법인세법 제54조")
    // 상위 2건은 본문까지 동봉
    expect(text).toContain("모법 26조 본문")
  })

  it("시행령 조문 본문 자체는 그대로 나온다 (위임 방향과 무관)", async () => {
    const r = await handleFinArticle(stub(), { law: "법인세법 시행령", article: "제45조" })
    const text = r.content[0].text
    expect(text).toContain("■ 법인세법 시행령 제45조")
    expect(text).toContain("복리후생비의 손금불산입")
    expect(text).toMatch(/전체 성공|부분 성공/)
  })

  it("시행규칙 질의는 같은 행의 시행령 조문을 짝으로 보여준다", async () => {
    const r = await handleFinArticle(stub(), { law: "법인세법 시행규칙", article: "제22조" })
    const text = r.content[0].text
    expect(text).toContain("■ 모법 위임 근거")
    expect(text).toContain("[모법] 법인세법 제26조")
    expect(text).toContain("같은 위임 행의 시행령")
    expect(text).toContain("법인세법 시행령 제44조")
    // 모법 §26의 다른 위임(시행령 §43·§45)은 이 행의 짝이 아니다
    expect(text).not.toContain("시행령 제43조")
    expect(text).not.toContain("시행령 제45조")
  })

  it("매핑이 없는 시행령 조문은 '위임 없음'이 아니라 '매핑 미발견'으로 답한다", async () => {
    const r = await handleFinArticle(stub(), { law: "법인세법 시행령", article: "제999조" })
    const text = r.content[0].text
    expect(text).toContain("매핑 미발견")
    expect(text).not.toContain("[모법] 법인세법 제45조")
    expect(text).toContain("추측하지 마세요")
  })
})

describe("fin_article — 본법 질의의 정방향 위임은 그대로다 (반대 방향 회귀 방지)", () => {
  it("법인세법 제26조는 종전대로 시행령·시행규칙 위임 목록을 준다", async () => {
    const r = await handleFinArticle(stub(), { law: "법인세법", article: "제26조" })
    const text = r.content[0].text
    expect(text).toContain("■ 시행령·시행규칙 위임")
    expect(text).not.toContain("모법 위임 근거")
    expect(text).toContain("[시행령] 법인세법 시행령 제43조")
    expect(text).toContain("[시행규칙] 법인세법 시행규칙 제22조")
  })

  it("본법 제45조는 종전대로 그 조문의 위임(시행령 §10·§81)을 준다", async () => {
    const r = await handleFinArticle(stub(), { law: "법인세법", article: "제45조" })
    const text = r.content[0].text
    expect(text).toContain("[시행령] 법인세법 시행령 제10조")
    expect(text).toContain("[시행령] 법인세법 시행령 제81조")
    expect(text).toContain("결손금 공제")
  })
})

/**
 * 요구 3 — 방향 판정은 사용자 입력이 아니라 **해소된 정식 명칭**(law.lawName)으로 한다.
 * 약칭 "관시령"은 별칭 사전에서 「관세법 시행령」으로 풀리므로 역방향 경로에 걸려야 한다.
 */
describe("fin_article — 약칭이 시행령으로 해소돼도 역방향으로 잡힌다", () => {
  const CUSTOMS_DECREE_MST = "290001"
  const CUSTOMS_MST = "290000"
  const CUSTOMS_THREE_TIER = JSON.stringify({
    LspttnThdCmpLawXService: {
      기본정보: { 법령명: "관세법 시행령", 기준법령명: "관세법", 삼단비교존재여부: "Y" },
      위임조문삼단비교: {
        법률조문: [
          {
            조번호: "0030",
            조가지번호: "00",
            조제목: "",
            조내용: "",
            시행령조문: { 조번호: "0019", 조가지번호: "00", 법령명: "관세법 시행령", 조제목: "", 조내용: "" },
          },
        ],
      },
    },
  })

  const customsStub = (): LawApiClient =>
    ({
      searchLaw: async (q: string) => {
        const n = asSearched(q)
        if (n === "관세법시행령") return lawXml("관세법 시행령", CUSTOMS_DECREE_MST, "004000", "대통령령")
        if (n === "관세법") return lawXml("관세법", CUSTOMS_MST, "004001", "법률")
        return EMPTY_LAW_XML
      },
      fetchApi: async (p: { endpoint: string; extraParams?: Record<string, string> }) => {
        if (p.endpoint === "lawSearch.do") return EMPTY_RULING_XML
        if (p.extraParams?.MST === CUSTOMS_MST && p.extraParams?.JO === "003000") {
          return articleJson("30", "0", "과세가격 결정의 원칙", "제30조(과세가격 결정의 원칙) 관세법 30조 본문")
        }
        return articleJson("19", "0", "과세가격 산출", "제19조(과세가격 산출) 관세법 시행령 19조 본문")
      },
      getThreeTier: async () => CUSTOMS_THREE_TIER,
      getAnnexes: async () => "{}",
      searchAdminRule: async () => '<?xml version="1.0"?><AdmRulSearch><totalCnt>0</totalCnt></AdmRulSearch>',
    }) as unknown as LawApiClient

  it('"관시령 제19조"도 모법 역방향으로 답한다', async () => {
    const r = await handleFinArticle(customsStub(), { law: "관시령", article: "제19조" })
    const text = r.content[0].text
    expect(text).toContain("■ 관세법 시행령 제19조")
    expect(text).toContain("■ 모법 위임 근거")
    expect(text).toContain("[모법] 관세법 제30조")
    expect(text).not.toContain("[시행령]")
  })
})
