/**
 * basis_date 달력 검증 회귀 테스트 (s2-fixes · improvement-candidates B3)
 *
 * 스키마가 형식(YYYY-MM-DD)만 봐서 2024-02-30·2026-13-01 같은 달력에 없는 날짜가
 * 통과해 법제처 efYd로 그대로 나갔다. basis_date를 받는 5개 도구 전부에서
 * 거절(INVALID_PARAMETER·한글)과 통과(윤년 2024-02-29)를 함께 확인한다.
 */

import { describe, it, expect } from "vitest"
import type { LawApiClient } from "../lib/api-client.js"
import { isCalendarBasisDate } from "../lib/fin-common.js"
import { FinArticleInputSchema, handleFinArticle } from "./article.js"
import { FinLawSearchInputSchema, handleFinLawSearch } from "./law-search.js"
import { FinRulingSearchInputSchema, handleFinRulingSearch } from "./ruling-search.js"
import { FinTopicInputSchema, handleFinTopic } from "./topic.js"
import { FinVerifyInputSchema, handleFinVerify } from "./verify.js"

const BAD_DATES = ["2024-02-30", "2023-02-29", "2026-13-01"]

/** 어떤 API 메서드가 불려도 실패시키는 클라이언트 — 거절은 조회 전에 끝나야 한다 */
const noCallClient = new Proxy(
  {},
  {
    get(_t, prop) {
      if (prop === "then") return undefined
      return () => {
        throw new Error(`거절 입력인데 API가 호출됨: ${String(prop)}`)
      }
    },
  }
) as unknown as LawApiClient

type Handler = (c: LawApiClient, input: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>

const TOOLS: Array<{
  name: string
  handler: Handler
  schema: { safeParse: (v: unknown) => { success: boolean } }
  base: Record<string, unknown>
}> = [
  { name: "fin_article", handler: handleFinArticle as Handler, schema: FinArticleInputSchema, base: { law: "법인세법", article: "제26조" } },
  { name: "fin_law_search", handler: handleFinLawSearch as Handler, schema: FinLawSearchInputSchema, base: { query: "법인세법" } },
  { name: "fin_ruling_search", handler: handleFinRulingSearch as Handler, schema: FinRulingSearchInputSchema, base: { query: "퇴직금 손금" } },
  { name: "fin_topic", handler: handleFinTopic as Handler, schema: FinTopicInputSchema, base: { question: "접대비 한도" } },
  { name: "fin_verify", handler: handleFinVerify as Handler, schema: FinVerifyInputSchema, base: { text: "법인세법 제26조" } },
]

describe("isCalendarBasisDate", () => {
  it("달력에 없는 날짜는 false", () => {
    for (const d of BAD_DATES) expect(isCalendarBasisDate(d), d).toBe(false)
    expect(isCalendarBasisDate("2025-04-31")).toBe(false)
    expect(isCalendarBasisDate("2025-00-10")).toBe(false)
  })

  it("실재 날짜(윤년 2024-02-29·1900년대 포함)는 true", () => {
    expect(isCalendarBasisDate("2024-02-29")).toBe(true)
    expect(isCalendarBasisDate("2000-02-29")).toBe(true)
    expect(isCalendarBasisDate("2026-12-31")).toBe(true)
    expect(isCalendarBasisDate("1995-01-01")).toBe(true)
  })

  it("형식이 틀린 값은 true — 형식 regex 메시지 한 줄만 나가게 한다", () => {
    expect(isCalendarBasisDate("20240230")).toBe(true)
    expect(isCalendarBasisDate("2024/02/30")).toBe(true)
  })
})

describe.each(TOOLS)("$name — basis_date 달력 검증", ({ name, handler, schema, base }) => {
  it.each(BAD_DATES)("%s는 한글 INVALID_PARAMETER로 거절하고 API를 부르지 않는다", async (d) => {
    const res = await handler(noCallClient, { ...base, basis_date: d })
    expect(res.isError).toBe(true)
    const text = res.content[0].text
    expect(text).toContain(`[INVALID_PARAMETER] ${name}`)
    expect(text).toContain("달력에 없는 날짜")
    expect(text).not.toContain("API가 호출됨")
  })

  it("2024-02-29(윤년)는 스키마를 통과한다", () => {
    expect(schema.safeParse({ ...base, basis_date: "2024-02-29" }).success).toBe(true)
  })

  it("형식 오류는 기존 형식 메시지 하나만 낸다 (달력 메시지 중복 없음)", async () => {
    const res = await handler(noCallClient, { ...base, basis_date: "2024/02/29" })
    expect(res.isError).toBe(true)
    const text = res.content[0].text
    expect(text).toContain("YYYY-MM-DD 형식이어야 합니다")
    expect(text).not.toContain("달력에 없는 날짜")
  })
})

describe("fin_topic — 통과 방향은 핸들러까지 (API 미사용 도구)", () => {
  it("2024-02-29는 거절되지 않고 fin_article 인자에 실린다", async () => {
    const res = await handleFinTopic(noCallClient, { question: "접대비 한도", basis_date: "2024-02-29" })
    expect(res.isError).toBeFalsy()
    expect(res.content[0].text).toContain("2024-02-29")
  })
})
