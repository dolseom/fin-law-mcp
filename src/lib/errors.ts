/**
 * 통일된 에러 처리 모듈
 */

import { maskSensitiveUrl } from "./fetch-with-retry.js"

/**
 * 에러 코드
 */
export const ErrorCodes = {
  NOT_FOUND: "LAW_NOT_FOUND",
  INVALID_PARAM: "INVALID_PARAMETER",
  API_ERROR: "EXTERNAL_API_ERROR",
  RATE_LIMITED: "RATE_LIMITED",
  TIMEOUT: "REQUEST_TIMEOUT",
  PARSE_ERROR: "PARSE_ERROR",
  INTERNAL: "INTERNAL_ERROR",
} as const

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes]

/**
 * 에러 메시지 → 에러코드 분류. rate limit·timeout·파싱 실패가 전부
 * EXTERNAL_API_ERROR로 뭉개지면 호출측(LLM)이 "재시도 대기"와 "장애 보고"를
 * 구분할 수 없다 (Opus I5 — RATE_LIMITED·PARSE_ERROR가 실제로 생성되도록).
 */
export function classifyErrorCode(msg: string): ErrorCode {
  if (/RATE_LIMITED|429|한도 초과/i.test(msg)) return ErrorCodes.RATE_LIMITED
  // "요청 취소됨(도구 deadline)"은 시간 예산 초과의 결과다 — 영어 abort만 잡으면
  // 이 한글 메시지가 EXTERNAL_API_ERROR(장애)로 분류되어, 호출측이 "재시도하면
  // 되는 지연"을 "법제처 장애"로 읽는다
  if (/timeout|timed?\s*out|시간 초과|취소됨|abort/i.test(msg)) return ErrorCodes.TIMEOUT
  if (/JSON|XML|파싱|parse/i.test(msg)) return ErrorCodes.PARSE_ERROR
  return ErrorCodes.API_ERROR
}

/**
 * 외부 조회 실패의 공용 포맷 — 도구 catch 블록의 인라인 [EXTERNAL_API_ERROR]
 * 문자열을 일원화한다. "0건 아님" 고지(조용한 실패 방지 계약)를 항상 포함한다.
 */
export function formatFetchFailure(what: string, error: unknown): string {
  const rawMsg = error instanceof Error ? error.message : String(error)
  const code = classifyErrorCode(rawMsg)
  const msg = maskSensitiveUrl(rawMsg.replace(/^RATE_LIMITED:\s*/, ""))
  const hint =
    code === ErrorCodes.RATE_LIMITED
      ? "\n💡 호출 한도 초과입니다 — 안내된 시간 후 재시도하세요."
      : code === ErrorCodes.TIMEOUT
        ? "\n💡 응답 지연입니다 — 잠시 후 재시도하세요."
        : code === ErrorCodes.PARSE_ERROR
          ? "\n💡 응답 형식 이상입니다 — 법제처 API 장애일 수 있으니 잠시 후 재시도하세요."
          : "\n💡 잠시 후 재시도하세요. 법제처 API 간헐 장애일 수 있습니다."
  return `[${code}] ${what} 실패 — ⚠판정불가 (0건이 아님)\n사유: ${msg}${hint}`
}

/** 도구 핸들러 응답 형태 (index.ts 디스패처와 같은 모양). interface가 아니라 type이어야
 * SDK 결과 타입(인덱스 시그니처)에 대입된다 */
export type ToolResult = {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}

const UNEXPECTED_REASON: Record<ErrorCode, string> = {
  LAW_NOT_FOUND: "조회 대상 확인 중 오류",
  INVALID_PARAMETER: "입력 처리 중 오류",
  EXTERNAL_API_ERROR: "외부 조회 처리 중 오류 — 법제처 API 간헐 장애일 수 있습니다",
  RATE_LIMITED: "호출 한도 초과 — 잠시 후 재시도하세요",
  REQUEST_TIMEOUT: "응답 지연·요청 취소 — 잠시 후 재시도하세요",
  PARSE_ERROR: "응답 형식 이상 — 법제처 API 장애일 수 있으니 잠시 후 재시도하세요",
  INTERNAL_ERROR: "서버 내부 처리 오류",
}

/**
 * 디스패처의 최종 방어선 — 핸들러가 예상하지 못한 예외를 던져도 MCP 오류 응답(isError)으로 바꾼다.
 *
 * topic·calc·ruling-search 핸들러에는 최상위 try가 없고 article의 try는 앞부분만 감싼다
 * (improvement-candidates B1). 예외가 새면 SDK가 영어 원문 메시지를 JSON-RPC 오류로 내보내
 * "⚠판정불가 (0건이 아님)" 계약 문구가 빠진다. 응답에는 **원문 메시지를 싣지 않는다** —
 * 원문에는 요청 URL(인증키 포함 가능)·내부 서비스명이 들어갈 수 있어 분류 결과만 한글로 준다.
 * 원문은 마스킹해 stderr에만 남긴다 (stdio MCP에서 stderr는 프로토콜 채널이 아니다).
 */
export async function runToolSafely(toolName: string, run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run()
  } catch (error) {
    const rawMsg = error instanceof Error ? error.message : String(error)
    // 프로그래밍 오류(TypeError 등)는 법제처 장애로 분류하지 않는다 — 재시도로 풀리지 않는다
    const programming =
      error instanceof TypeError || error instanceof ReferenceError || error instanceof RangeError
    const code: ErrorCode = programming ? ErrorCodes.INTERNAL : classifyErrorCode(rawMsg)
    try {
      console.error(`[${toolName}] 예상 밖 예외 (${code}): ${maskSensitiveUrl(rawMsg)}`)
    } catch {
      // 로그 실패가 응답을 막지 않게 한다
    }
    return {
      content: [
        {
          type: "text",
          text:
            `[${code}] ${toolName} 처리 중 예상하지 못한 오류가 발생했습니다 — ⚠판정불가 (0건이 아님)
` +
            `사유: ${UNEXPECTED_REASON[code]}
` +
            `💡 같은 입력으로 다시 시도하고, 반복되면 입력과 함께 이슈로 알려 주세요.`,
        },
      ],
      isError: true,
    }
  }
}
