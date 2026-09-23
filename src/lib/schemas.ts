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
 * 응답 크기 제한 적용 — 초과분을 잘라내고 말미에 안내를 붙인다.
 *
 * @param text - 원본 텍스트
 * @param maxSize - 최대 길이(기본 50,000자)
 */
export function truncateResponse(text: string, maxSize: number = MAX_RESPONSE_SIZE): string {
  if (text.length <= maxSize) return text
  const truncated = text.slice(0, maxSize)
  return truncated + `\n\n⚠️ 응답이 너무 길어 ${maxSize.toLocaleString()}자로 잘렸습니다.`
}
