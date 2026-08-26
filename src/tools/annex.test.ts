/**
 * fin_annex 별표 선택·추출 순수 함수 테스트 (korean-law-mcp 이식 회귀 — CI 상시)
 */

import { describe, it, expect } from "vitest"
import { parseAnnexSelector, titleMatchesAnnexNo, extractBundledSection, isUnnumberedAnnex, formatAnnexNo } from "./annex.js"

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
