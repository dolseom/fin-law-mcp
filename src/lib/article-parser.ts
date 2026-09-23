/**
 * 법령 조문 파싱 유틸리티 (annex·article·nts-body 공통)
 */

/** 중첩 배열 평탄화 후 문자열 결합 (<img> 태그 제외) */
export function flattenContent(value: any): string {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) return ""

  const result: string[] = []
  for (const item of value) {
    if (typeof item === "string") {
      if (!item.startsWith("<img") && !item.startsWith("</img")) {
        result.push(item)
      }
    } else if (Array.isArray(item)) {
      result.push(flattenContent(item))
    }
  }
  return result.join("\n")
}

/** 목 배열을 소속 호별로 그룹핑.
 *  법제처 JSON은 목(目)을 호의 자식이 아니라 **항 레벨 형제 배열**로 주고 목 객체에
 *  소속 호 정보가 없다(키는 목번호·목내용뿐). 목번호가 '가'로 리셋되는 지점을 새 호의
 *  목 시작으로 보고 순서를 복원한다 — 조판 규칙상 각 호의 목은 항상 '가'부터 시작한다. */
export function groupMokByReset(mokArray: any[]): any[][] {
  const groups: any[][] = []
  for (const mok of mokArray) {
    if (!mok || typeof mok !== "object") continue
    const num = String(mok.목번호 ?? "").trim()
    if (num.startsWith("가") || groups.length === 0) groups.push([])
    groups[groups.length - 1].push(mok)
  }
  return groups
}

/** HTML 정리 - 엔티티 디코딩 순서 중요: &amp; 최후 처리 (이중 인코딩 방지) */
export function cleanHtml(text: string): string {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')  // &amp; 반드시 마지막 (이중 인코딩 &amp;lt; → &lt; 방지)
    .trim()
}
