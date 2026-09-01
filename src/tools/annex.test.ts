/**
 * fin_annex 별표 선택·추출 순수 함수 테스트 (korean-law-mcp 이식 회귀 — CI 상시)
 */

import { describe, it, expect } from "vitest"
import {
  parseAnnexSelector,
  titleMatchesAnnexNo,
  extractBundledSection,
  isUnnumberedAnnex,
  formatAnnexNo,
  parseAdminRuleAnnexes,
  handleFinAnnex,
} from "./annex.js"
import type { LawApiClient } from "../lib/api-client.js"

describe("parseAnnexSelector — 별표 선택값 해석", () => {
  it("정수 입력은 6자리 코드 후보(본번호×100)를 만든다", () => {
    const { codes, mainNo } = parseAnnexSelector("6")
    expect(codes.has("000600")).toBe(true)
    expect(mainNo).toBe("6")
  })

  it("'별표 6' 표기도 동일하게 해석한다", () => {
    const { codes, mainNo } = parseAnnexSelector("별표 6")
    expect(codes.has("000600")).toBe(true)
    expect(mainNo).toBe("6")
  })

  it("의-번호('1의2')는 본번호4+의번호2 코드가 된다", () => {
    const { codes, mainNo } = parseAnnexSelector("1의2")
    expect(codes.has("000102")).toBe(true)
    expect(mainNo).toBe("1")
  })

  it("6자리 코드 입력(000600)은 본번호를 되짚는다", () => {
    const { codes, mainNo } = parseAnnexSelector("000600")
    expect(codes.has("000600")).toBe(true)
    expect(mainNo).toBe("6")
  })

  it("숫자 없는 입력은 빈 결과", () => {
    const { codes, mainNo } = parseAnnexSelector("내용연수")
    expect(codes.size).toBe(0)
    expect(mainNo).toBeNull()
  })
})

describe("titleMatchesAnnexNo — 제목 매칭", () => {
  it("'[별표 6]'·'별표 제6호' 표기를 매칭한다", () => {
    expect(titleMatchesAnnexNo("[별표 6] 업종별 자산의 기준내용연수", "6")).toBe(true)
    expect(titleMatchesAnnexNo("별표 제6호 업종별 자산", "6")).toBe(true)
  })

  it("자릿수가 다른 번호는 매칭하지 않는다 (별표 66 ≠ 6)", () => {
    expect(titleMatchesAnnexNo("[별표 66] 다른 표", "6")).toBe(false)
    expect(titleMatchesAnnexNo("별표 66 다른 표", "6")).toBe(false)
  })

  it("묶음 범위('별표 1~5')에 포함되면 매칭한다", () => {
    expect(titleMatchesAnnexNo("[별표1~5] 통합 별표", "3")).toBe(true)
    expect(titleMatchesAnnexNo("[별표1~5] 통합 별표", "6")).toBe(false)
  })
})

describe("extractBundledSection — 묶음 별표 섹션 추출", () => {
  const md = "## [별표 1] 첫 표\n내용1\n\n## [별표 2] 둘째 표\n내용2\n\n## [별표 3] 셋째 표\n내용3"

  it("요청한 별표 섹션만 잘라낸다", () => {
    const sec = extractBundledSection(md, "2")
    expect(sec).toContain("둘째 표")
    expect(sec).toContain("내용2")
    expect(sec).not.toContain("내용1")
    expect(sec).not.toContain("내용3")
  })

  it("마지막 섹션도 끝까지 잘라낸다", () => {
    const sec = extractBundledSection(md, "3")
    expect(sec).toContain("내용3")
  })

  it("없는 번호는 null (전체 유지 폴백)", () => {
    expect(extractBundledSection(md, "9")).toBeNull()
  })
})

/**
 * 번호 없는 별표 회귀 (자체 점검에서 발견).
 *
 * 법령에 별표가 하나뿐이면 법제처는 별표번호를 "000000"으로 준다.
 * 이것을 "별표 0"으로 표시하면 원문에 없는 번호를 만들어내는 것이고
 * (상증세법 시행령 원문 표기는 "[별표]"), 그런 별표가 2건이면 둘 다 "0"이라
 * annex_no로 구분할 수 없어 한 건이 조용히 가려진다.
 */
describe("isUnnumberedAnnex — 번호 없는 별표 판별", () => {
  it("법제처의 000000을 번호 없음으로 본다", () => {
    expect(isUnnumberedAnnex("000000")).toBe(true)
    expect(isUnnumberedAnnex("0")).toBe(true)
    expect(isUnnumberedAnnex(" 000000 ")).toBe(true)
  })

  it("실제 번호는 번호 없음이 아니다", () => {
    expect(isUnnumberedAnnex("000600")).toBe(false)
    expect(isUnnumberedAnnex("000102")).toBe(false)
    expect(isUnnumberedAnnex("001200")).toBe(false)
  })
})

describe("formatAnnexNo — 법제처 6자리 코드 → 표시 표기", () => {
  it("본번호만 있으면 '별표 N'", () => {
    expect(formatAnnexNo("000400")).toBe("별표 4")
    expect(formatAnnexNo("001100")).toBe("별표 11")
  })

  it("지번이 있으면 '별표 N의M'", () => {
    expect(formatAnnexNo("000202")).toBe("별표 2의2")
    expect(formatAnnexNo("000607")).toBe("별표 6의7")
  })

  it("000000은 번호 없는 별표라 '별표'로만 적는다 ('별표 0'은 원문에 없는 표기)", () => {
    expect(formatAnnexNo("000000")).toBe("별표")
  })

  it("코드 형식이 아니면 그대로 둔다", () => {
    expect(formatAnnexNo("별표 6")).toBe("별표 6")
    expect(formatAnnexNo("")).toBe("")
  })
})

/**
 * Codex 4차 중요 회귀 — 별표 직행 경로만 괄호를 못 벗겨, "법인세법 시행규칙(2024. 3. 22.
 * 개정)" 같은 입력이 실존 별표를 "정상 조회 결과 없음"으로 단정하던 문제.
 */
describe("handleFinAnnex — 괄호 붙은 법령명 (Codex 4차 중요)", () => {
  it("조회·소속 대조는 괄호를 뗀 이름으로 간다", async () => {
    let requested = ""
    const client = {
      getAnnexes: async (p: { lawName: string }) => {
        requested = p.lawName
        return JSON.stringify({
          별표목록: [
            {
              별표명: "업종별 자산의 기준내용연수와 내용연수범위표",
              별표번호: "000600",
              법령명: "법인세법 시행규칙",
            },
          ],
        })
      },
    } as unknown as LawApiClient
    const res = await handleFinAnnex(client, { law: "법인세법 시행규칙(2024. 3. 22. 개정)" })
    expect(requested).toBe("법인세법 시행규칙")
    const text = res.content[0].text
    expect(text).toContain("1건")
    expect(text).not.toContain("0건")
    expect(text).toContain("기준내용연수") // 소속 대조(sameLawFamily)도 괄호 뗀 이름 기준
  })
})

/**
 * 행정규칙 별표·서식 (2026-09-01 신설).
 * 고시·훈령에도 별표·별지가 있는데 법령 별표 API(licbyl)만 봐서 "0건"으로 답해 왔다.
 * 실측: 조사사무처리규정 별표 1 + 별지 66, 외국환거래규정 52, 법인세 사무처리규정 20.
 */
const ADMRUL_BODY = [
  '<?xml version="1.0"?><AdmRulService><행정규칙기본정보><행정규칙명>조사사무처리규정</행정규칙명>',
  "<조문형식여부>Y</조문형식여부></행정규칙기본정보>",
  "<별표번호>0001</별표번호><별표가지번호>00</별표가지번호><별표구분>별표</별표구분>",
  "<별표제목><![CDATA[조사공무원의 행동수칙]]></별표제목>",
  "<별표서식파일링크>/LSW/flDownload.do?flSeq=1</별표서식파일링크><별표내용><![CDATA[…]]></별표내용>",
  "<별표번호>0001</별표번호><별표가지번호>01</별표가지번호><별표구분>별지</별표구분>",
  "<별표제목><![CDATA[납세자권리헌장 등 수령 및 낭독 확인서]]></별표제목>",
  "<별표서식파일링크>/LSW/flDownload.do?flSeq=2</별표서식파일링크><별표내용><![CDATA[…]]></별표내용>",
  "<별표번호>0020</별표번호><별표가지번호>00</별표가지번호><별표구분>별지</별표구분>",
  "<별표제목><![CDATA[장부·서류 등 반환 확인서]]></별표제목>",
  "<별표서식파일링크>/LSW/flDownload.do?flSeq=3</별표서식파일링크><별표내용><![CDATA[…]]></별표내용>",
  "</AdmRulService>",
].join("")

const ADMRUL_SEARCH = [
  '<?xml version="1.0"?><AdmRulSearch><totalCnt>1</totalCnt><admrul>',
  "<행정규칙명>조사사무처리규정</행정규칙명><행정규칙종류>훈령</행정규칙종류>",
  "<소관부처명>국세청</소관부처명><행정규칙일련번호>2100000277992</행정규칙일련번호>",
  "</admrul></AdmRulSearch>",
].join("")

const EMPTY_ANNEX_JSON = JSON.stringify({ 별표목록: [] })

function adminRuleClient(overrides: Partial<Record<string, unknown>> = {}): LawApiClient {
  return {
    getAnnexes: async () => EMPTY_ANNEX_JSON,
    searchAdminRule: async () => ADMRUL_SEARCH,
    getAdminRule: async () => ADMRUL_BODY,
    ...overrides,
  } as unknown as LawApiClient
}

describe("parseAdminRuleAnnexes — 행정규칙 본문의 별표·서식", () => {
  it("요청한 구분만 돌려주고 나머지 구분의 건수를 함께 센다", () => {
    const { entries, byKind } = parseAdminRuleAnnexes(ADMRUL_BODY, "3", "조사사무처리규정")
    expect(entries).toHaveLength(2) // 별지 2건
    expect(byKind).toEqual({ 별표: 1, 별지: 2 })
  })

  it("본번호4 + 가지번호2의 법령 별표 코드로 맞춘다 (formatAnnexNo 호환)", () => {
    const { entries } = parseAdminRuleAnnexes(ADMRUL_BODY, "3", "조사사무처리규정")
    expect(entries[0].no).toBe("000101")
    expect(formatAnnexNo(entries[0].no, "별지")).toBe("별지 1의1")
    expect(entries[1].no).toBe("002000")
  })
})

describe("formatAnnexNo — 구분 라벨", () => {
  it("라벨을 주면 그 구분으로 표기한다 (별지를 '별표 20'으로 적지 않는다)", () => {
    expect(formatAnnexNo("002000", "별지")).toBe("별지 20")
    expect(formatAnnexNo("000000", "서식")).toBe("서식")
  })
})

describe("fin_annex — 행정규칙 폴백", () => {
  it("법령 DB에 없는 고시·훈령의 별지를 찾아 준다", async () => {
    const res = await handleFinAnnex(adminRuleClient(), {
      law: "조사사무처리규정",
      kind: "3",
    })
    const text = res.content[0].text
    expect(text).toContain("[행정규칙] 「조사사무처리규정」")
    expect(text).toContain("훈령 · 국세청")
    expect(text).toContain("[별지 20]") // 별지를 '별표'로 표기하지 않는다
    expect(text).toContain("2건")
  })

  it("요청한 구분이 0건이면 다른 구분의 건수와 kind 코드를 안내한다", async () => {
    const res = await handleFinAnnex(adminRuleClient(), { law: "조사사무처리규정", kind: "2" })
    const text = res.content[0].text
    expect(text).toContain("0건")
    expect(text).toContain("별지 2건")
    expect(text).toContain('별지=kind "3"')
  })

  it("행정규칙 조회 실패는 '0건'이 아니라 ⚠ 판정 불가다", async () => {
    const res = await handleFinAnnex(
      adminRuleClient({
        searchAdminRule: async () => {
          throw new Error("법제처 서버 오류 (503)")
        },
      }),
      { law: "조사사무처리규정", kind: "1" }
    )
    const text = res.content[0].text
    expect(text).toContain("⚠ 판정 불가")
    expect(text).toContain("503")
  })

  it("접두 일치(다른 규칙)로는 별표를 보여주지 않는다", async () => {
    const other = ADMRUL_SEARCH.replace(
      "<행정규칙명>조사사무처리규정</행정규칙명>",
      "<행정규칙명>조사사무처리규정 시행세칙</행정규칙명>"
    )
    const res = await handleFinAnnex(adminRuleClient({ searchAdminRule: async () => other }), {
      law: "조사사무처리규정",
      kind: "3",
    })
    expect(res.content[0].text).toContain("0건")
    expect(res.content[0].text).not.toContain("[별지 20]")
  })
})
