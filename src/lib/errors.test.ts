/**
 * 에러코드 분류·공용 실패 포맷 회귀 테스트 (순수 함수 — CI 상시)
 * Opus 리뷰 I5: RATE_LIMITED·TIMEOUT·PARSE_ERROR가 정의만 있고 실제로는 전부
 * EXTERNAL_API_ERROR로 뭉개지던 문제를 박제한다.
 */

import { describe, it, expect, vi } from "vitest"
import { readFileSync } from "node:fs"
import { classifyErrorCode, formatFetchFailure, ErrorCodes, runToolSafely } from "./errors.js"

describe("classifyErrorCode", () => {
  it("rate limit 게이트 메시지를 RATE_LIMITED로 분류한다", () => {
    expect(classifyErrorCode("RATE_LIMITED: 분당 호출 한도 초과 — 12초 후 재시도하세요.")).toBe(ErrorCodes.RATE_LIMITED)
    expect(classifyErrorCode("HTTP 429 Too Many Requests")).toBe(ErrorCodes.RATE_LIMITED)
  })

  it("타임아웃을 TIMEOUT으로 분류한다", () => {
    expect(classifyErrorCode("요청 시간 초과 (6000ms)")).toBe(ErrorCodes.TIMEOUT)
    expect(classifyErrorCode("The operation was aborted")).toBe(ErrorCodes.TIMEOUT)
  })

  it("도구 deadline 취소를 TIMEOUT으로 분류한다 (한글 메시지 — 장애로 오분류 방지)", () => {
    expect(classifyErrorCode("요청 취소됨(도구 deadline) — 대기 중 취소되어 호출하지 않음")).toBe(ErrorCodes.TIMEOUT)
    expect(classifyErrorCode("요청 취소됨(도구 deadline) - https://www.law.go.kr/DRF/lawSearch.do")).toBe(ErrorCodes.TIMEOUT)
  })

  it("파싱 실패를 PARSE_ERROR로 분류한다", () => {
    expect(classifyErrorCode("Unexpected token < in JSON at position 0")).toBe(ErrorCodes.PARSE_ERROR)
    expect(classifyErrorCode("XML 루트가 LawSearch가 아님")).toBe(ErrorCodes.PARSE_ERROR)
  })

  it("그 외는 EXTERNAL_API_ERROR로 분류한다", () => {
    expect(classifyErrorCode("fetch failed")).toBe(ErrorCodes.API_ERROR)
  })
})

describe("formatFetchFailure", () => {
  it("분류된 코드로 표기하고 '0건이 아님' 고지를 항상 포함한다", () => {
    const text = formatFetchFailure("법령 검색", new Error("RATE_LIMITED: 분당 호출 한도 초과 — 12초 후 재시도하세요."))
    expect(text).toContain("[RATE_LIMITED]")
    expect(text).toContain("0건이 아님")
    expect(text).not.toContain("사유: RATE_LIMITED:") // 접두 중복 제거
  })

  it("일반 오류는 EXTERNAL_API_ERROR + 재시도 안내", () => {
    const text = formatFetchFailure("별표 조회", new Error("fetch failed"))
    expect(text).toContain("[EXTERNAL_API_ERROR]")
    expect(text).toContain("재시도")
  })
})

describe("runToolSafely — 디스패처 최종 방어선 (s2-fixes · B1)", () => {
  it("핸들러가 예상 밖 예외를 던지면 isError 한글 응답으로 바꾸고 원문·키·URL을 싣지 않는다", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const res = await runToolSafely("fin_topic", async () => {
        throw new TypeError(
          "Cannot read properties of undefined (reading 'x') at https://www.law.go.kr/DRF/lawSearch.do?OC=KEY_SENTINEL&target=law"
        )
      })
      expect(res.isError).toBe(true)
      const text = res.content[0].text
      expect(text).toContain("[INTERNAL_ERROR] fin_topic 처리 중 예상하지 못한 오류")
      expect(text).toContain("⚠판정불가 (0건이 아님)")
      expect(text).not.toContain("KEY_SENTINEL")
      expect(text).not.toMatch(/https?:\/\//)
      expect(text).not.toContain("Cannot read")
      // stderr 로그에도 키는 가려진다
      const logged = spy.mock.calls.map((c) => String(c[0])).join("\n")
      expect(logged).not.toContain("KEY_SENTINEL")
    } finally {
      spy.mockRestore()
    }
  })

  it("문자열 throw·타임아웃류도 분류해 isError로 돌려준다", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const res = await runToolSafely("fin_calc", async () => {
        throw new Error("요청 취소됨(도구 deadline) - https://www.law.go.kr/DRF/lawService.do?OC=***")
      })
      expect(res.isError).toBe(true)
      expect(res.content[0].text).toContain("[REQUEST_TIMEOUT] fin_calc")
      const res2 = await runToolSafely("fin_ruling_search", async () => {
        throw "문자열 예외"
      })
      expect(res2.isError).toBe(true)
      expect(res2.content[0].text).toContain("fin_ruling_search 처리 중 예상하지 못한 오류")
    } finally {
      spy.mockRestore()
    }
  })

  it("반대 방향: 정상 응답(isError 포함)은 그대로 통과시킨다", async () => {
    const ok = { content: [{ type: "text" as const, text: "정상" }] }
    expect(await runToolSafely("fin_article", async () => ok)).toBe(ok)
    const handled = { content: [{ type: "text" as const, text: "[INVALID_PARAMETER] x" }], isError: true }
    expect(await runToolSafely("fin_article", async () => handled)).toBe(handled)
  })

  it("index.ts 디스패치가 runToolSafely로 핸들러를 감싼다 (정의만 있고 배선 안 된 함수 방지)", () => {
    // index.ts는 top-level connect 때문에 import할 수 없다 — 원문으로 배선을 확인한다
    const src = readFileSync(new URL("../index.ts", import.meta.url), "utf-8")
    expect(src).toMatch(/return await runToolSafely\(req\.params\.name, \(\) =>\s*handler\(apiClient/)
    expect(src).not.toMatch(/return await handler\(apiClient/)
  })
})
