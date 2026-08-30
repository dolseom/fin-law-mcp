// 자체 패치 #4 테스트 — verify_citations 행정규칙 인용 검증
import { describe, expect, it } from "vitest"
import type { LawApiClient } from "../lib/api-client.js"
import { isAdminRuleName, isAdminRuleLikeName, findAdminRule, stripRuleNameMeta, stripTrailingParen, tryVerifyAdminRuleCitation, verifyAdminRuleCitation } from "./admin-rule-citation.js"
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

/**
 * Codex 공개 전 리뷰 중요 3 회귀 — 접두 일치를 실존으로 단정하던 문제.
 * looseMatchLawName은 "공식 명칭이 입력명으로 시작하면 일치"를 허용한다.
 * 행정규칙에는 법령 쪽의 별칭 사전·종류(tier) 검사가 없어, 입력한 규정보다
 * 긴 다른 규칙만 있어도 ✓가 나가면 그대로 오검증이 된다.
 */
const PREFIX_ONLY_XML =
  '<?xml version="1.0"?><AdmRulSearch><totalCnt>1</totalCnt><admrul>' +
  "<행정규칙명>국세청 사무처리규정 시행세칙</행정규칙명><행정규칙종류>훈령</행정규칙종류>" +
  "<소관부처명>국세청</소관부처명><발령일자>20260101</발령일자></admrul></AdmRulSearch>"

const EXACT_XML =
  '<?xml version="1.0"?><AdmRulSearch><totalCnt>2</totalCnt>' +
  "<admrul><행정규칙명>국세청 사무처리규정 시행세칙</행정규칙명><행정규칙종류>훈령</행정규칙종류>" +
  "<소관부처명>국세청</소관부처명><발령일자>20260101</발령일자></admrul>" +
  "<admrul><행정규칙명>국세청 사무처리규정</행정규칙명><행정규칙종류>훈령</행정규칙종류>" +
  "<소관부처명>국세청</소관부처명><발령일자>20260202</발령일자></admrul></AdmRulSearch>"

function xmlStub(xml: string): LawApiClient {
  return { searchAdminRule: async () => xml } as unknown as LawApiClient
}

describe("findAdminRule — 정확 일치와 접두 일치 구분 (Codex 리뷰 중요 3)", () => {
  it("접두 일치만 있으면 exact=false로 표시한다", async () => {
    const m = await findAdminRule(xmlStub(PREFIX_ONLY_XML), "국세청 사무처리규정")
    expect(m).not.toBeNull()
    expect(m!.exact).toBe(false)
    expect(m!.name).toBe("국세청 사무처리규정 시행세칙")
  })

  it("목록에 정확 일치가 있으면 접두 일치보다 우선한다 (순서 무관)", async () => {
    const m = await findAdminRule(xmlStub(EXACT_XML), "국세청 사무처리규정")
    expect(m!.exact).toBe(true)
    expect(m!.name).toBe("국세청 사무처리규정")
  })

  it("접두 일치는 ✓가 아니라 ⚠ 문구로 돌려준다 (실존 단정 금지)", async () => {
    const line = await tryVerifyAdminRuleCitation(xmlStub(PREFIX_ONLY_XML), ["국세청 사무처리규정"], "국세청 사무처리규정")
    expect(line).not.toBeNull()
    expect(line!.startsWith("⚠")).toBe(true)
    expect(line).toContain("정확히 일치하는 행정규칙은 찾지 못했")
    expect(line).toContain("국세청 사무처리규정 시행세칙")
  })

  it("정확 일치는 종전대로 ✓ 문구다", async () => {
    const line = await tryVerifyAdminRuleCitation(xmlStub(EXACT_XML), ["국세청 사무처리규정"], "국세청 사무처리규정")
    expect(line!.startsWith("✓")).toBe(true)
  })
})

/**
 * Codex 2차 회귀 — exact 판정이 괄호 메타데이터 때문에 정상 명칭을 강등하던 문제.
 * 행정규칙 명칭에는 발령일·연도가 괄호로 붙는 경우가 있다.
 */
const PAREN_XML =
  '<?xml version="1.0"?><AdmRulSearch><totalCnt>1</totalCnt><admrul>' +
  "<행정규칙명>식품등의 표시기준(2024. 1. 15.)</행정규칙명><행정규칙종류>고시</행정규칙종류>" +
  "<소관부처명>식품의약품안전처</소관부처명><발령일자>20240115</발령일자></admrul></AdmRulSearch>"

describe("findAdminRule — 괄호 메타데이터 정규화 (Codex 2차 중요)", () => {
  it("명칭 끝 괄호(발령일·연도)는 일치 판정에서 제외한다", async () => {
    const m = await findAdminRule(xmlStub(PAREN_XML), "식품등의 표시기준")
    expect(m).not.toBeNull()
    expect(m!.exact).toBe(true)
  })

  it("괄호를 떼도 다른 이름이면 여전히 exact=false", async () => {
    const m = await findAdminRule(xmlStub(PREFIX_ONLY_XML), "국세청 사무처리규정")
    expect(m!.exact).toBe(false)
  })
})

/**
 * Codex 3차 중요 회귀 — 괄호 정규화가 서로 다른 규칙을 같은 규칙으로 만들던 문제.
 * 날짜·발령번호는 같은 규칙의 판(版) 표시라 비교에서 빼야 하지만,
 * 「A규정(제1권)」·「A규정(제2권)」은 다른 규칙이므로 구분이 유지되어야 한다.
 */
describe("stripRuleNameMeta — 날짜·발령번호만 제거 (Codex 3차 중요)", () => {
  it("발령일 괄호는 제거한다", () => {
    expect(stripRuleNameMeta("식품등의 표시기준(2024. 1. 15.)")).toBe(stripRuleNameMeta("식품등의 표시기준"))
  })

  it("발령번호 괄호도 제거한다", () => {
    expect(stripRuleNameMeta("외국환거래규정(제2026-1호)")).toBe(stripRuleNameMeta("외국환거래규정"))
  })

  it("판·편을 가르는 괄호는 남긴다 (서로 다른 규칙)", () => {
    expect(stripRuleNameMeta("A규정(제1권)")).not.toBe(stripRuleNameMeta("A규정(제2권)"))
    expect(stripRuleNameMeta("A규정(제1권)")).not.toBe(stripRuleNameMeta("A규정"))
  })
})

describe("stripTrailingParen — 검색어·접미사 검사용 (종류 무관 제거)", () => {
  it("괄호 종류를 가리지 않고 뗀다", () => {
    expect(stripTrailingParen("외국환거래규정(기재부 고시)")).toBe("외국환거래규정")
    expect(stripTrailingParen("A규정(제1권)")).toBe("A규정")
  })

  it("괄호가 전부인 이름은 원본을 유지한다 (빈 문자열 방지)", () => {
    expect(stripTrailingParen("(고시)")).toBe("(고시)")
  })

  it("괄호가 없으면 그대로", () => {
    expect(stripTrailingParen("법인세법")).toBe("법인세법")
  })
})

describe("stripRuleNameMeta — 소관·종류 부연 괄호 (자체 점검)", () => {
  it("소관+종류 부연은 메타데이터로 본다", () => {
    expect(stripRuleNameMeta("외국환거래규정(기재부 고시)")).toBe(stripRuleNameMeta("외국환거래규정"))
    expect(stripRuleNameMeta("조사사무처리규정(국세청 훈령)")).toBe(stripRuleNameMeta("조사사무처리규정"))
  })

  it("숫자가 든 괄호는 판·편 구분일 수 있어 남긴다", () => {
    expect(stripRuleNameMeta("A규정(제1권)")).not.toBe(stripRuleNameMeta("A규정"))
    expect(stripRuleNameMeta("A규정(제1권)")).not.toBe(stripRuleNameMeta("A규정(제2권)"))
  })
})

/**
 * Claude(Fable) 리뷰 중요 3 회귀 — soft 접미사 판정·폐지 연혁 조회가 발령일 괄호를
 * 못 벗겨, 더 정밀한 표기("사내 전결기준(2026. 1. 1.) 제3조")가 오히려 ✗ 환각
 * 낙인을 받던 문제. 접미사 판정과 연혁 조회 양쪽 모두 괄호를 뗀 이름을 봐야 한다.
 */
describe("발령일 괄호가 붙은 soft 접미사 인용 (Claude 리뷰 중요 3)", () => {
  it("괄호 때문에 soft 강등이 빗나가 ✗ 낙인이 찍히지 않는다 + 연혁 조회는 괄호 뗀 이름", async () => {
    const calls: Array<{ query: string; nw?: string }> = []
    const client = {
      searchAdminRule: async (p: { query: string; nw?: string }) => {
        calls.push({ query: p.query, nw: p.nw })
        return EMPTY_XML
      },
    } as unknown as LawApiClient
    const line = await verifyAdminRuleCitation(
      client,
      ["사내 전결기준(2026. 1. 1.)"],
      "사내 전결기준(2026. 1. 1.) 제3조",
      "사내 전결기준(2026. 1. 1.)"
    )
    expect(line.startsWith("⚠")).toBe(true)
    expect(line).not.toContain("✗")
    expect(line).toContain("규칙명이 아닐 수 있음")
    // 폐지 연혁 조회(nw=2)가 괄호를 뗀 이름으로 나갔는가 — 붙인 채면 항상 0건이다
    const histCall = calls.find((c) => c.nw === "2")
    expect(histCall).toBeDefined()
    expect(histCall!.query).toBe("사내 전결기준")
  })

  it("strict 접미사(고시)는 괄호가 붙어도 종전대로 ✗ 유지 (환각 검출력 보존)", async () => {
    const line = await verifyAdminRuleCitation(
      stubClient(EMPTY_XML),
      ["가공전산처리고시(2026. 1. 1.)"],
      "가공전산처리고시(2026. 1. 1.) 제3조",
      "가공전산처리고시(2026. 1. 1.)"
    )
    expect(line.startsWith("✗")).toBe(true)
  })
})
