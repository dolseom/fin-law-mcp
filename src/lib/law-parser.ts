/**
 * 법령 조문 번호 파싱 및 변환 유틸리티
 * LexDiff에서 이식 (debugLogger 제거)
 */

interface ArticleComponents {
  articleNumber: number
  branchNumber: number
}

function stripClauseAndItem(raw: string): string {
  return raw
    .replace(/제?\d+항.*$/u, "")
    .replace(/제?\d+호.*$/u, "")
    .replace(/제?\d+목.*$/u, "")
}

function normalizeSeparators(raw: string): string {
  return raw
    .replace(/[‐‑‒–—―﹘﹣－]/gu, "-")
    .replace(/[·•]/gu, " ")
}

function parseArticleComponents(input: string): ArticleComponents {
  const sanitized = stripClauseAndItem(
    normalizeSeparators(input)
      .replace(/제|第/gu, "")
      .replace(/조문|條/gu, "조")
      .replace(/之/gu, "의")
      .replace(/[()]/gu, "")
      .replace(/\s+/gu, "")
      .trim(),
  )

  const match = sanitized.match(/(\d+)(?:조)?(?:(?:의|-)\s*(\d+))?/u)

  if (!match) {
    throw new Error(`조문 패턴을 인식할 수 없습니다: ${input}`)
  }

  const articleNumber = Number.parseInt(match[1], 10)
  const branchNumber = match[2] ? Number.parseInt(match[2], 10) : 0

  if (Number.isNaN(articleNumber) || Number.isNaN(branchNumber)) {
    throw new Error(`조문 번호를 해석할 수 없습니다: ${input}`)
  }

  return { articleNumber, branchNumber }
}

/**
 * Converts Korean law article notation to 6-digit JO code (법률/시행령/시행규칙용)
 * Format: AAAABB (AAAA=article, BB=branch)
 * Examples:
 *   "38조" → "003800"
 *   "10조의2" → "001002"
 *   "제5조" → "000500"
 */
export function buildJO(input: string): string {
  const components = parseArticleComponents(input)
  const articleNum = components.articleNumber.toString().padStart(4, "0")
  const branchNum = components.branchNumber.toString().padStart(2, "0")
  return `${articleNum}${branchNum}`
}
