// 자체 패치 #4 테스트 — verify_citations 행정규칙 인용 검증
import { describe, expect, it } from "vitest"
import type { LawApiClient } from "../lib/api-client.js"
import { isAdminRuleName, isAdminRuleLikeName, tryVerifyAdminRuleCitation, verifyAdminRuleCitation } from "./admin-rule-citation.js"
// fin-law-mcp: upstream verify-citations 대신 자체 verify.ts의 추출기로 연결
// (상한 15은 추출기 내부 고정)
import { extractCitations as parseCitations } from "./verify.js"

const MATCH_XML = `<?xml version="1.0" encoding="UTF-8"?>
<AdmRulSearch>
<admrul id="1">
<행정규칙명>식품등의 표시기준</행정규칙명>
<행정규칙일련번호>2100000000000</행정규칙일련번호>
<발령일자>20240115</발령일자>
<행정규칙종류>고시</행정규칙종류>
<소관부처명>식품의약품안전처</소관부처명>
</admrul>
</AdmRulSearch>`

const EMPTY_XML = `<?xml version="1.0" encoding="UTF-8"?><AdmRulSearch><totalCnt>0</totalCnt></AdmRulSearch>`

function stubClient(xml: string): LawApiClient {
  return { searchAdminRule: async () => xml } as unknown as LawApiClient
}

describe("isAdminRuleName", () => {
  it("행정규칙 접미사를 인식한다", () => {
    expect(isAdminRuleName("식품등의 표시기준")).toBe(true)
    expect(isAdminRuleName("법인세법 기본통칙")).toBe(true)
    expect(isAdminRuleName("국세청 고시")).toBe(true)
    expect(isAdminRuleName("개인정보 보호지침")).toBe(true)
  })
  it("법령 접미사는 행정규칙으로 보지 않는다", () => {
    expect(isAdminRuleName("법인세법")).toBe(false)
    expect(isAdminRuleName("법인세법 시행규칙")).toBe(false)
    expect(isAdminRuleName("서울특별시 조례")).toBe(false)
  })
})

describe("parseCitations 행정규칙 추출 (접미사 확장)", () => {
  it("「식품등의 표시기준」 제N조에서 규칙명을 추출한다", () => {
    const cites = parseCitations("「식품등의 표시기준」 제4조에 따라 표시하여야 한다.")
    expect(cites).toHaveLength(1)
    expect(cites[0].lawName).toBe("식품등의 표시기준")
  })
  it("기존 법령 추출은 그대로 동작한다", () => {
    const cites = parseCitations("법인세법 제19조에 따른 손금")
    expect(cites[0].lawName).toBe("법인세법")
  })

  it("행정규칙 캡처는 '같은 법' 조응의 선행사가 되지 않는다 (Opus 차단 1 회귀 방지)", () => {
    const text =
      "법인세법 제19조의2에 따른 대손금은 인정된다. 국세청의 실무 판단 기준 제3조도 참고한다. " +
      "같은 법 시행령 제19조의2 제1항도 확인하라."
    const cites = parseCitations(text)
    expect(cites).toHaveLength(3)
    expect(cites[0].lawName).toBe("법인세법")
    expect(cites[1].lawName).toBe("국세청의 실무 판단 기준")
    expect(cites[2].lawName).toBe("법인세법 시행령") // '판단 기준 시행령'이 되면 회귀
  })

  it("산문 '기준' 캡처 뒤 '같은 법' 단독 조응도 법령으로 해소된다", () => {
    const text = "소득세법 제12조에 따라 비과세된다. 회사 내부 지급 기준 제2조 참조. 같은 법 제20조도 본다."
    const cites = parseCitations(text)
    expect(cites[2].lawName).toBe("소득세법")
  })
})

describe("tryVerifyAdminRuleCitation", () => {
  it("행정규칙 DB에 실존하면 ✓ + 명칭만 확인했음을 명시한다", async () => {
    const result = await tryVerifyAdminRuleCitation(
      stubClient(MATCH_XML), ["식품등의 표시기준"], "식품등의 표시기준 제4조"
    )
    expect(result).toContain("✓")
    expect(result).toContain("행정규칙 「식품등의 표시기준」 실존")
    expect(result).toContain("명칭 실존만 확인")
  })
  it("미발견이면 null (호출자가 폴백 계속)", async () => {
    const result = await tryVerifyAdminRuleCitation(
      stubClient(EMPTY_XML), ["가상의무언가고시명"], "라벨"
    )
    expect(result).toBeNull()
  })
})

describe("verifyAdminRuleCitation", () => {
  it("확실 접미사(고시)는 미발견 시 ✗ NOT_FOUND", async () => {
    const result = await verifyAdminRuleCitation(
      stubClient(EMPTY_XML), ["존재하지않는국세청고시"], "라벨A", "존재하지않는국세청고시"
    )
    expect(result.startsWith("✗")).toBe(true)
    expect(result).toContain("NOT_FOUND")
  })
  it("모호 접미사(기준)는 미발견 시 ⚠로만 보고 (일반 명사 오탐 방지)", async () => {
    const result = await verifyAdminRuleCitation(
      stubClient(EMPTY_XML), ["애매한판단기준"], "라벨B", "애매한판단기준"
    )
    expect(result.startsWith("⚠")).toBe(true)
    expect(result).toContain("확인 실패")
  })
  it("검색 실패는 ⚠로 보고한다 (검증 불가 ≠ 환각)", async () => {
    const client = { searchAdminRule: async () => { throw new Error("네트워크 오류") } } as unknown as LawApiClient
    const result = await verifyAdminRuleCitation(client, ["아무고시"], "라벨C", "아무고시")
    expect(result.startsWith("⚠")).toBe(true)
  })
})

describe("장애 응답 판별 (Codex 차단 3 회귀 방지)", () => {
  const HTML_ERROR = "<!DOCTYPE html><html><body>시스템 점검 중입니다</body></html>"

  it("200 상태의 HTML 오류 페이지는 ✗가 아니라 ⚠(판정 불가)로 보고한다", async () => {
    const result = await verifyAdminRuleCitation(
      stubClient(HTML_ERROR), ["존재하지않는국세청고시"], "라벨D", "존재하지않는국세청고시"
    )
    expect(result.startsWith("⚠")).toBe(true)
    expect(result).toContain("HTML 오류 페이지")
    expect(result).not.toContain("NOT_FOUND")
  })

  it("빈 응답도 ⚠(판정 불가)로 보고한다", async () => {
    const result = await verifyAdminRuleCitation(stubClient("  "), ["아무고시"], "라벨E", "아무고시")
    expect(result.startsWith("⚠")).toBe(true)
    expect(result).toContain("빈 응답")
  })

  it("tryVerify 경로는 throw로 전파한다 (호출자 catch가 ⚠ 또는 기존 경로 유지 처리)", async () => {
    await expect(
      tryVerifyAdminRuleCitation(stubClient(HTML_ERROR), ["아무고시"], "라벨")
    ).rejects.toThrow("HTML 오류 페이지")
  })

  it("대문자 HTML 변형(<HTML>)도 장애 페이지로 판별한다 (Codex 재검토 차단 2)", async () => {
    const upper = "<!DOCTYPE HTML><HTML><BODY>System Maintenance</BODY></HTML>"
    const result = await verifyAdminRuleCitation(
      stubClient(upper), ["존재하지않는국세청고시"], "라벨F", "존재하지않는국세청고시"
    )
    expect(result.startsWith("⚠")).toBe(true)
    expect(result).toContain("HTML 오류 페이지")
  })

  it("예상 밖 루트의 오류 XML(<error>)은 0건이 아니라 ⚠(판정 불가)로 보고한다", async () => {
    const errXml = `<?xml version="1.0" encoding="UTF-8"?><error><code>SVC-001</code><msg>서비스 점검</msg></error>`
    const result = await verifyAdminRuleCitation(stubClient(errXml), ["아무고시"], "라벨G", "아무고시")
    expect(result.startsWith("⚠")).toBe(true)
    expect(result).toContain("예상 밖 응답")
    expect(result).toContain("error")
  })
})

describe("isAdminRuleLikeName — 행정규칙 병행 조회 대상 판정", () => {
  it("「…규정」·「…규칙」은 대상 (법령 DB에 없어도 고시·훈령으로 실존할 수 있다)", () => {
    expect(isAdminRuleLikeName("외국환거래규정")).toBe(true)
    expect(isAdminRuleLikeName("조사사무처리규정")).toBe(true)
    expect(isAdminRuleLikeName("산업안전보건기준에 관한 규칙")).toBe(true)
  })

  it("「…시행규칙」은 부령 = 법령 DB 대상이므로 제외한다", () => {
    expect(isAdminRuleLikeName("법인세법 시행규칙")).toBe(false)
    expect(isAdminRuleLikeName("소득세법시행규칙")).toBe(false)
  })

  it("고시·훈령·예규·통칙 접미사도 포함한다 (isAdminRuleName 상위집합)", () => {
    expect(isAdminRuleLikeName("소득세법 기본통칙")).toBe(true)
    expect(isAdminRuleLikeName("전자신고 고시")).toBe(true)
  })

  it("일반 법령명은 대상이 아니다 (불필요한 행정규칙 조회 방지)", () => {
    expect(isAdminRuleLikeName("법인세법")).toBe(false)
    expect(isAdminRuleLikeName("상속세 및 증여세법")).toBe(false)
    expect(isAdminRuleLikeName("법인세법 시행령")).toBe(false)
  })

  it("가운뎃점·공백이 섞여도 접미사를 인식한다", () => {
    expect(isAdminRuleLikeName("외국환 거래 규정")).toBe(true)
  })
})
