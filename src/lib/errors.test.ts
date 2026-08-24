/**
 * 에러코드 분류·공용 실패 포맷 회귀 테스트 (순수 함수 — CI 상시)
 * Opus 리뷰 I5: RATE_LIMITED·TIMEOUT·PARSE_ERROR가 정의만 있고 실제로는 전부
 * EXTERNAL_API_ERROR로 뭉개지던 문제를 박제한다.
 */

import { describe, it, expect } from "vitest"
import { classifyErrorCode, formatFetchFailure, ErrorCodes } from "./errors.js"

describe("classifyErrorCode", () => {
  it("rate limit 게이트 메시지를 RATE_LIMITED로 분류한다", () => {
    expect(classifyErrorCode("RATE_LIMITED: 분당 호출 한도 초과 — 12초 후 재시도하세요.")).toBe(ErrorCodes.RATE_LIMITED)
    expect(classifyErrorCode("HTTP 429 Too Many Requests")).toBe(ErrorCodes.RATE_LIMITED)
  })

  it("타임아웃을 TIMEOUT으로 분류한다", () => {
    expect(classifyErrorCode("요청 시간 초과 (6000ms)")).toBe(ErrorCodes.TIMEOUT)
    expect(classifyErrorCode("The operation was aborted")).toBe(ErrorCodes.TIMEOUT)
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
