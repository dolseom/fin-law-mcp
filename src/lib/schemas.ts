/**
 * 응답 길이 제한 유틸
 *
 * 원래는 공통 Zod 스키마 모음이었으나, 날짜·페이지네이션 스키마는 각 도구가
 * 자체 inputSchema로 정의하게 되면서 소비자가 사라졌다. 지금 남은 소비자는
 * nts-body의 truncateResponse 하나뿐이다.
 */

/**
 * 응답 크기 제한 (50KB)
 */
const MAX_RESPONSE_SIZE = 50000

/**
 * truncateResponse 옵션
 */
interface TruncateOptions {
  maxLength?: number
  /** true이면 초과 시 핵심 내용만 요약 추출 */
  summary?: boolean
}

/**
 * 응답 크기 제한 적용
 *
 * @param text - 원본 텍스트
 * @param maxSizeOrOpts - 숫자(최대 길이) 또는 옵션 객체
 */
export function truncateResponse(text: string, maxSizeOrOpts?: number): string
export function truncateResponse(text: string, maxSizeOrOpts?: TruncateOptions): string
export function truncateResponse(text: string, maxSizeOrOpts: number | TruncateOptions = MAX_RESPONSE_SIZE): string {
  let maxSize: number
  let summary = false

  if (typeof maxSizeOrOpts === "object" && maxSizeOrOpts !== null) {
    maxSize = maxSizeOrOpts.maxLength ?? MAX_RESPONSE_SIZE
    summary = !!maxSizeOrOpts.summary
  } else {
    maxSize = maxSizeOrOpts
  }

  if (text.length <= maxSize) return text

  // summary 모드: 핵심 내용(첫 줄 + 섹션 제목들 + 마지막 줄) 추출
  if (summary) {
    return _extractSummary(text, maxSize)
  }

  // 기본 동작: 단순 잘라내기
  const truncated = text.slice(0, maxSize)
  return truncated + `\n\n⚠️ 응답이 너무 길어 ${maxSize.toLocaleString()}자로 잘렸습니다.`
}

/**
 * 핵심 내용 요약 추출 (summary 모드 내부 함수)
 * 첫 줄 + 모든 섹션 헤더(▶ ...) + 각 섹션의 처음 2줄 + 말미 안내
 */
function _extractSummary(text: string, maxSize: number): string {
  const lines = text.split("\n")
  const collected: string[] = []
  let budget = maxSize - 100 // 말미 안내 여유

  // 첫 줄(제목) 항상 포함
  if (lines.length > 0) {
    collected.push(lines[0])
    budget -= lines[0].length + 1
  }

  let i = 1
  while (i < lines.length && budget > 0) {
    const line = lines[i]
    // 섹션 헤더이거나 빈 줄이 아닌 경우
    if (/^▶|^#{1,4}\s|^=====|^-----/.test(line)) {
      collected.push("")
      collected.push(line)
      budget -= line.length + 2
      // 헤더 다음 2줄까지 포함
      let j = 1
      for (; j <= 2 && i + j < lines.length && budget > 0; j++) {
        const nextLine = lines[i + j]
        if (/^▶|^#{1,4}\s/.test(nextLine)) break // 다음 섹션이면 중단
        collected.push(nextLine)
        budget -= nextLine.length + 1
      }
      i += j // j 루프로 소비한 만큼 i를 추가 증가
    }
    i++
  }

  const tail = `\n\n📋 요약 모드: 원문 ${text.length.toLocaleString()}자 중 핵심만 추출 (${collected.join("\n").length.toLocaleString()}자)`
  return collected.join("\n") + tail
}
