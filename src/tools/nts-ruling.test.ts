/**
 * fin_nts_ruling — 입력 오류 문구·계약 회귀 (Codex 제품 검토 2026-09-05, 지적 3·4)
 *
 * 3. description이 "본문 전문"이라고 했지만 본문은 6,000자에서 절단된다 — 계약 과장
 * 4. zod 기본 오류가 영어로 샜다 ("Too big: expected number to be <=5")
 *
 * 네트워크를 타지 않는다: 입력 검증은 apiClient에 닿기 전에 끝나므로 스텁이 호출되면 그것이 회귀다.
 */
import { describe, it, expect } from "vitest"
import { handleFinNtsRuling, FIN_NTS_RULING_TOOL, BUDGET_BODY } from "./nts-ruling.js"
import type { LawApiClient } from "../lib/api-client.js"

/** 입력 오류 경로에서는 절대 호출되면 안 되는 스텁 */
function neverCalled(): LawApiClient {
  return {
    fetchApi: async () => {
      throw new Error("입력 검증 실패인데 API를 호출했다")
    },
  } as unknown as LawApiClient
}

describe("fin_nts_ruling — 입력 오류는 한글 [INVALID_PARAMETER]", () => {
  it("top_n_bodies 범위 초과는 영어 zod 문구가 아니라 한글 안내를 준다", async () => {
    const r = await handleFinNtsRuling(neverCalled(), { query: "퇴직금", top_n_bodies: 6 })
    const text = r.content[0].text
    expect(r.isError).toBe(true)
    expect(text).toContain("[INVALID_PARAMETER] fin_nts_ruling:")
    expect(text).toContain("top_n_bodies는 0~5의 정수입니다 (입력: 6)")
    // 영어 유출 금지 — zod 기본 메시지의 표지
    expect(text).not.toMatch(/Too big|expected|Invalid/)
    // 다른 도구(calc·article)와 같은 예시 안내
    expect(text).toContain(`💡 예: {"query":"퇴직금 중간정산","top_n_bodies":3}`)
  })

  it("정수가 아닌 top_n_bodies도 같은 형식", async () => {
    const r = await handleFinNtsRuling(neverCalled(), { query: "퇴직금", top_n_bodies: 2.5 })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain("top_n_bodies는 0~5의 정수입니다 (입력: 2.5)")
  })

  it("빈 query도 같은 형식", async () => {
    const r = await handleFinNtsRuling(neverCalled(), { query: "" })
    const text = r.content[0].text
    expect(r.isError).toBe(true)
    expect(text).toContain("[INVALID_PARAMETER] fin_nts_ruling:")
    expect(text).toContain("query는 1자 이상의 검색어 문자열입니다")
    expect(text).not.toMatch(/Too small|expected|String must/)
  })

  it("query 누락은 '필수'라고 말한다 (빈 문자열과 구분)", async () => {
    const r = await handleFinNtsRuling(neverCalled(), { top_n_bodies: 1 })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain("query(예규 검색어)는 필수입니다")
  })
})

describe("fin_nts_ruling — description은 절단을 감추지 않는다", () => {
  it("'본문 전문'이 아니라 상한과 절단 고지를 밝힌다", () => {
    const d = FIN_NTS_RULING_TOOL.description
    expect(d).not.toContain("본문 전문")
    expect(d).toContain("절단 고지")
  })

  it("description의 상한 수치가 실제 예산(BUDGET_BODY)과 같다", () => {
    // 6000 → "6,000" — 한쪽만 바뀌면 description이 거짓이 된다
    expect(FIN_NTS_RULING_TOOL.description).toContain(`${BUDGET_BODY.toLocaleString("en-US")}자`)
  })
})
