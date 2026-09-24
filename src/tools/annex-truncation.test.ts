/**
 * fin_annex 별표 본문 절단 표기 (외부 검토 B3 같은 모양 — v01-sameshape, fixture·실 API 없음)
 *
 * 전에는 헤더·본문·출처를 한 덩어리로 20,000자에서 잘라 첫 줄은 멀쩡하고 끝에만 고지가 붙었다 —
 * 긴 별표 표의 뒤쪽 행이 빠져도 첫 줄만 보면 전체 별표로 읽혔다.
 */

import { describe, it, expect, vi, afterEach } from "vitest"

vi.mock("kordoc", () => ({ parse: vi.fn() }))
import { parse } from "kordoc"
import { handleFinAnnex } from "./annex.js"
import type { LawApiClient } from "../lib/api-client.js"

afterEach(() => vi.unstubAllGlobals())

const client = {
  getAnnexes: async () =>
    JSON.stringify({
      LicBylSearch: {
        licbyl: [
          {
            별표명: "업종별 자산의 기준내용연수와 내용연수범위표",
            별표번호: "000600",
            관련법령명: "법인세법 시행규칙",
            별표서식파일링크: "/LSW/flDownload.do?flSeq=1",
          },
        ],
      },
    }),
} as unknown as LawApiClient

function stubFile(markdown: string) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })))
  vi.mocked(parse).mockResolvedValue({ success: true, fileType: "hwp", markdown, pageCount: 3 } as any)
}

const row = (i: number) => `| ${String(i).padStart(4, "0")} | 기계장치 품목 ${i} | 5년 | 4~6년 |`

describe("fin_annex — 별표 본문 절단 표기", () => {
  it("긴 별표 → 첫 줄에 '⚠본문 일부 절단(n자 중 m자)', 출처 줄 유지, 전체 20,000자 이내", async () => {
    const markdown = Array.from({ length: 1500 }, (_, i) => row(i + 1)).join("\n")
    stubFile(markdown)
    const res = await handleFinAnnex(client, { law: "법인세법 시행규칙", annex_no: "6" })
    const text = res.content[0].text
    const first = text.split("\n")[0]
    expect(first).toMatch(/^\[기준: 현행\] 법인세법 시행규칙 \[별표 6\] .* ⚠본문 일부 절단\(\d+자 중 \d+자\)/)
    const m = first.match(/\((\d+)자 중 (\d+)자\)/)!
    expect(Number(m[1])).toBe(markdown.length)
    expect(Number(m[2])).toBeLessThan(markdown.length)
    // 실린 m자는 원문 앞부분 그대로다
    expect(text).toContain(markdown.slice(0, Number(m[2])))
    expect(text).toContain("나머지 행을 받는 재조회 경로 없음")
    expect(text.trimEnd().endsWith("원문을 확인하세요")).toBe(true) // SOURCE_FOOTER가 잘리지 않는다
    expect(text.length).toBeLessThanOrEqual(20_000)
    expect(res.isError).toBeFalsy()
  })

  it("[반대] 짧은 별표 → 절단 표기 없음, 본문 전부", async () => {
    const markdown = Array.from({ length: 20 }, (_, i) => row(i + 1)).join("\n")
    stubFile(markdown)
    const res = await handleFinAnnex(client, { law: "법인세법 시행규칙", annex_no: "6" })
    const text = res.content[0].text
    expect(text.split("\n")[0]).not.toContain("절단")
    expect(text).toContain(markdown)
    expect(text).not.toContain("초과로 절단")
  })
})
