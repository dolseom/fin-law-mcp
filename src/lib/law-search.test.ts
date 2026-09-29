/**
 * resolvedLawMatches 종류(본법/시행령/시행규칙) 일치 회귀 테스트 (순수 함수 — CI 상시)
 * Opus 리뷰 I1: looseMatch의 접두 허용 때문에 "법인세법 시행령" 요청이 본법과
 * 매칭되어 본법 MST로 조문을 검증하고 ✓를 내던 결함을 박제한다.
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import { findLaws, findRepealedLaw, lawTierOf, pickRepealed, resolvedLawMatches, sameLawFamily, stripNonLawKeywords } from "./law-search.js"
import { LawApiClient } from "./api-client.js"

describe("stripNonLawKeywords — 법령 종류 보존 (Codex 리뷰 중요 3 회귀)", () => {
  it("시행령·시행규칙은 부가 키워드가 아니라 법령 종류이므로 보존한다", () => {
    // 제거하면 검색이 본법으로 축약돼 I1의 종류 일치 필터가 검색 경로에서 무력해진다
    expect(stripNonLawKeywords("법인세법 시행령")).toBe("법인세법 시행령")
    expect(stripNonLawKeywords("법인세법 시행규칙")).toBe("법인세법 시행규칙")
    expect(stripNonLawKeywords("소득세법 시행령 제163조")).toContain("시행령")
  })

  it("진짜 부가 키워드는 계속 제거한다", () => {
    expect(stripNonLawKeywords("관세법 과태료 기준")).toBe("관세법")
    expect(stripNonLawKeywords("법인세법 판례 해석")).toBe("법인세법")
    expect(stripNonLawKeywords("부가가치세법 별표")).toBe("부가가치세법")
  })

  it("시행령 + 부가 키워드가 섞이면 종류만 남긴다", () => {
    expect(stripNonLawKeywords("법인세법 시행령 별표")).toBe("법인세법 시행령")
  })
})

describe("lawTierOf", () => {
  it("접미사로 본법/시행령/시행규칙을 판별한다", () => {
    expect(lawTierOf("법인세법")).toBe("본법")
    expect(lawTierOf("법인세법 시행령")).toBe("시행령")
    expect(lawTierOf("법인세법 시행규칙")).toBe("시행규칙")
    expect(lawTierOf("법인세법시행령")).toBe("시행령") // 공백 없는 표기
  })
})

describe("resolvedLawMatches — 본법/시행령 혼동 (Opus I1 회귀)", () => {
  it("시행령 요청이 본법과 매칭되지 않는다 (핵심 결함)", () => {
    expect(resolvedLawMatches("법인세법 시행령", "법인세법")).toBe(false)
  })

  it("본법 요청이 시행령과 매칭되지 않는다", () => {
    expect(resolvedLawMatches("법인세법", "법인세법 시행령")).toBe(false)
  })

  it("시행령 요청이 시행규칙과 매칭되지 않는다", () => {
    expect(resolvedLawMatches("법인세법 시행령", "법인세법 시행규칙")).toBe(false)
  })

  it("시행규칙 요청이 본법과 매칭되지 않는다", () => {
    expect(resolvedLawMatches("소득세법 시행규칙", "소득세법")).toBe(false)
  })

  it("같은 종류끼리는 매칭된다", () => {
    expect(resolvedLawMatches("법인세법", "법인세법")).toBe(true)
    expect(resolvedLawMatches("법인세법 시행령", "법인세법 시행령")).toBe(true)
    expect(resolvedLawMatches("법인세법시행령", "법인세법 시행령")).toBe(true)
  })

  it("검색 결과에서 시행령 요청은 시행령을 고른다 (verify laws.find 시뮬레이션)", () => {
    const searchResult = ["법인세법", "법인세법 시행령", "법인세법 시행규칙"]
    const picked = searchResult.find((n) => resolvedLawMatches("법인세법 시행령", n))
    expect(picked).toBe("법인세법 시행령")
  })

  it("별칭이 종류를 바꾸는 케이스도 canonical 해소 후 매칭된다 (관시령→관세법 시행령)", () => {
    expect(resolvedLawMatches("관시령", "관세법 시행령")).toBe(true)
    expect(resolvedLawMatches("관시령", "관세법")).toBe(false)
  })

  it("본법 별칭 매칭은 유지된다 (공정거래법→독점규제 및 공정거래에 관한 법률)", () => {
    expect(resolvedLawMatches("공정거래법", "독점규제 및 공정거래에 관한 법률")).toBe(true)
  })

  it("부분매칭 함정은 여전히 차단된다 (민법≠난민법, 지방세법≠지방교부세법)", () => {
    expect(resolvedLawMatches("민법", "난민법")).toBe(false)
    expect(resolvedLawMatches("지방세법", "지방교부세법")).toBe(false)
  })
})

describe("sameLawFamily — 별표 소속 대조 (하위법령 통과, 유사 법령 차단)", () => {
  it("본법 조회에 시행규칙 별표(기준내용연수표)가 통과된다 (골든셋 #1)", () => {
    expect(sameLawFamily("법인세법", "법인세법 시행규칙")).toBe(true)
    expect(sameLawFamily("법인세법", "법인세법 시행령")).toBe(true)
    expect(sameLawFamily("법인세법 시행규칙", "법인세법")).toBe(true)
  })

  it("유사 법령은 여전히 차단된다", () => {
    expect(sameLawFamily("지방세법", "지방교부세법 시행규칙")).toBe(false)
    expect(sameLawFamily("법인세법", "소득세법 시행규칙")).toBe(false)
  })
})

describe("pickRepealed — 완전 일치 우선 (실측 회귀)", () => {
  it("본법 질의에 하위법령이 최신 시행일로 이기지 않는다", () => {
    const rows = [
      { lawName: "택지소유상한에관한법률시행규칙", lawId: "1", mst: "1", lawType: "부령", status: "연혁", effectiveDate: "19990101" },
      { lawName: "택지소유상한에관한법률", lawId: "2", mst: "2", lawType: "법률", status: "연혁", effectiveDate: "19980925" },
    ]
    expect(pickRepealed(rows, "택지소유상한에 관한 법률")?.lawName).toBe("택지소유상한에관한법률")
  })

  it("완전 일치가 없으면 접두 일치 중 최신본을 고른다 (기존 동작 유지)", () => {
    const rows = [
      { lawName: "택지소유상한에관한법률시행령", lawId: "1", mst: "1", lawType: "대통령령", status: "연혁", effectiveDate: "19980101" },
      { lawName: "택지소유상한에관한법률시행규칙", lawId: "2", mst: "2", lawType: "부령", status: "연혁", effectiveDate: "19990101" },
    ]
    expect(pickRepealed(rows, "택지소유상한에 관한 법률")?.lawName).toBe("택지소유상한에관한법률시행규칙")
  })
})

describe("findLaws — 약칭+접미사 확장 사다리 (Opus 재검증 개선, fixture)", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("법제처가 모르는 '근퇴법 시행령'을 본체 canonical 재결합으로 찾는다", async () => {
    // searchLaw의 별칭 해소는 전체 문자열 키("근퇴법시행령")로만 조회해 이 형태를 못 푼다 —
    // 1.5차 사다리가 본체("근퇴법")만 canonical로 바꿔 재결합해야 한다
    const HIT =
      '<?xml version="1.0"?><LawSearch><totalCnt>1</totalCnt><law id="1">' +
      "<법령명한글>근로자퇴직급여 보장법 시행령</법령명한글><법령ID>1</법령ID>" +
      "<법령일련번호>111</법령일련번호><법령구분명>대통령령</법령구분명></law></LawSearch>"
    const EMPTY = '<?xml version="1.0"?><LawSearch><totalCnt>0</totalCnt></LawSearch>'
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input)
        return new Response(url.includes(encodeURIComponent("근로자퇴직급여")) ? HIT : EMPTY, { status: 200 })
      })
    )
    const laws = await findLaws(new LawApiClient({ apiKey: "testkey" }), "근퇴법 시행령", undefined, 5, 100)
    expect(laws).toHaveLength(1)
    expect(laws[0].lawName).toBe("근로자퇴직급여 보장법 시행령")
  })
})

/**
 * 퍼즈 차단 회귀 — looseMatchLawName 세 번째 절("질의가 정식명으로 시작하면 일치")이
 * **오염된 이름 전부에 확신형 ✓를 내주는 공용 통로**였다.
 *
 * 추출 단계에서 앞 인용을 흡수한 이름("소득세법 시행령 제12조의2와 국세청 조사사무처리규정")이
 * findLaws 3차 사다리에서 「소득세법」을 뽑아 오고, 3절이 접두 일치만 보고 통과시켜
 * **뒤 인용의 조문 번호가 앞 법령에 붙은 채 ✓**가 나갔다 (실 API 실측).
 * 추출 쪽(CUT_REF_RE)만 고치면 증상만 막히므로 판정 관문도 함께 좁힌다.
 *
 * 실측으로 확인한 것: 3절은 **질의가 공식명보다 긴 경우에만** 판정을 가른다.
 * "…에 관한 법" ↔ "…에 관한 법률" 같은 정상 흔들림은 2절(공식명이 질의로 시작)이 이미 받는다.
 */
describe("looseMatchLawName 3절 — 오염된 이름 거부 (퍼즈 차단)", () => {
  it("조문 토큰이 남은 이름은 접두가 맞아도 거부한다", () => {
    expect(resolvedLawMatches("법인세법 제26조", "법인세법")).toBe(false)
    expect(resolvedLawMatches("소득세법 시행령 제12조의2와 국세청 조사사무처리규정", "소득세법")).toBe(false)
  })

  it("다른 법령·행정규칙 접미사가 남은 이름도 거부한다", () => {
    expect(resolvedLawMatches("법인세법 제26조 및 지방세법", "법인세법")).toBe(false)
    expect(resolvedLawMatches("부가가치세법 시행령 제8조와 외국환거래규정", "부가가치세법")).toBe(false)
  })

  it("정상 인용은 그대로 통과한다 (반대 방향 방어)", () => {
    expect(resolvedLawMatches("법인세법", "법인세법")).toBe(true)
    expect(resolvedLawMatches("법인세법시행령", "법인세법 시행령")).toBe(true)
    expect(resolvedLawMatches("법인세", "법인세법")).toBe(true) // 2절
    expect(resolvedLawMatches("외감법", "주식회사 등의 외부감사에 관한 법률")).toBe(true) // 별칭
    expect(resolvedLawMatches("근퇴법 시행령", "근로자퇴직급여 보장법 시행령")).toBe(true) // 약칭+접미사
  })

  it("'…법률'↔'…법' 흔들림은 2절이 받으므로 3절 강화의 영향을 받지 않는다", () => {
    expect(resolvedLawMatches("국가를 당사자로 하는 계약에 관한 법", "국가를 당사자로 하는 계약에 관한 법률")).toBe(true)
    expect(resolvedLawMatches("주식회사 등의 외부감사에 관한 법", "주식회사 등의 외부감사에 관한 법률")).toBe(true)
  })

  it("조사가 붙은 꼬리는 거부 대상이 아니다", () => {
    expect(resolvedLawMatches("소득세법상", "소득세법")).toBe(true)
    expect(resolvedLawMatches("법인세법의", "법인세법")).toBe(true)
  })

  it("별표 소속 대조(sameLawFamily)는 영향받지 않는다", () => {
    expect(sameLawFamily("법인세법", "법인세법 시행규칙")).toBe(true)
    expect(sameLawFamily("법인세법", "소득세법 시행규칙")).toBe(false)
  })
})

/**
 * Fable 최종 검토 F3(b) 회귀 — findRepealedLaw는 eflaw display 30 **한 페이지**만 받는다.
 * 검색 결과가 그보다 많으면 받은 목록의 최대 시행일은 "마지막 시행"이 아니다 (목록 밖에 더 늦은 행이 있을 수 있음).
 * 완전 여부를 반환값에 실어 호출측이 표기를 한정하게 한다.
 */
describe("findRepealedLaw — 한 페이지 목록의 완전 여부 (F3)", () => {
  const row = (name: string, mst: string, efYd: string) =>
    `<law id="${mst}"><법령명한글>${name}</법령명한글><법령ID>9</법령ID><법령일련번호>${mst}</법령일련번호>` +
    `<법령구분명>법률</법령구분명><현행연혁코드>연혁</현행연혁코드><시행일자>${efYd}</시행일자></law>`
  const client = (xml: string, seen?: { display?: number; target?: string }) =>
    ({
      searchLaw: async (_q: string, _k: unknown, display: number, target: string) => {
        if (seen) Object.assign(seen, { display, target })
        return xml
      },
    }) as unknown as LawApiClient

  it("totalCnt가 받은 30건보다 크면 listComplete=false — 최신 행(2009년)이 페이지 밖이어도 받은 목록 최대값만 안다", async () => {
    // 전체 153건 중 30건만 받았고 그 안의 최대 시행일은 2005-01-01 — 실제 마지막 시행(2009-02-04)은 목록 밖
    const rows = Array.from({ length: 30 }, (_, i) => row("증권거래법", String(1000 + i), `${1980 + (i % 26)}0101`)).join("")
    const seen: { display?: number; target?: string } = {}
    const r = await findRepealedLaw(client(`<LawSearch><totalCnt>153</totalCnt>${rows}</LawSearch>`, seen), "증권거래법")
    expect(seen).toEqual({ display: 30, target: "eflaw" })
    expect(r.law?.effectiveDate).toBe("20050101")
    expect(r.listComplete).toBe(false)
    expect(r.listTotal).toBe(153)
    expect(r.listReceived).toBe(30)
  })

  it("totalCnt가 받은 건수와 같으면 listComplete=true", async () => {
    const xml = `<LawSearch><totalCnt>2</totalCnt>${row("증권거래법", "1", "20090204")}${row("증권거래법", "2", "20050101")}</LawSearch>`
    const r = await findRepealedLaw(client(xml), "증권거래법")
    expect(r.listComplete).toBe(true)
    expect(r.law?.effectiveDate).toBe("20090204")
  })

  it("totalCnt가 없는데 30건이 꽉 찼으면 완전하다고 보지 않는다 (0건·전부로 지어내지 않음)", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => row("증권거래법", String(i), "20000101")).join("")
    const r = await findRepealedLaw(client(`<LawSearch>${rows}</LawSearch>`), "증권거래법")
    expect(r.listComplete).toBe(false)
    expect(r.listTotal).toBeUndefined()
  })

  it("totalCnt가 받은 건수보다 작은 모순 응답은 총건수로 쓰지 않는다", async () => {
    const xml = `<LawSearch><totalCnt>1</totalCnt>${row("증권거래법", "1", "20090204")}${row("증권거래법", "2", "20050101")}</LawSearch>`
    const r = await findRepealedLaw(client(xml), "증권거래법")
    expect(r.listTotal).toBeUndefined()
    expect(r.listComplete).toBe(true) // 30건 미만 = 마지막 페이지
  })

  it("조회 실패는 listComplete 없이 lookupFailed로 돌린다 (종전 계약 유지)", async () => {
    const failing = { searchLaw: async () => { throw new Error("법령 검색 실패 (HTTP 500)") } } as unknown as LawApiClient
    const r = await findRepealedLaw(failing, "증권거래법")
    expect(r.lookupFailed).toBe(true)
    expect(r.listComplete).toBeUndefined()
  })
})
