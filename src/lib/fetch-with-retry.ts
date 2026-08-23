/**
 * Fetch with retry and timeout
 * - Exponential backoff for 429, 503, 504
 * - AbortController for timeout
 */

/**
 * URL에서 민감 정보(API 키) 마스킹 — 에러 메시지/로그 노출 방지.
 * 법제처 API는 ?OC=KEY 쿼리 파라미터로 키를 받으므로 해당 값만 *** 처리.
 * 추가 방어로 일반적인 키 파라미터 이름들도 마스킹.
 */
export function maskSensitiveUrl(url: string): string {
  if (!url) return url
  return url.replace(/([?&](?:oc|apikey|api_key|authkey|auth_key|key)=)[^&]+/gi, "$1***")
}

export interface FetchWithRetryOptions extends RequestInit {
  /** Request timeout in ms (default: 30000) */
  timeout?: number
  /** Max retry attempts (default: 3) */
  retries?: number
  /** Base delay for exponential backoff in ms (default: 1000) */
  retryDelay?: number
  /** HTTP status codes to retry on (default: [429, 503, 504]) */
  retryOn?: number[]
  /**
   * 정상 응답이 HTML인 요청(예: DRF type=HTML — lsHistory 연혁 목록)에 true.
   * 기본(false)은 "200인데 HTML = 점검 페이지"로 보고 재시도하는데, HTML이
   * 정상인 엔드포인트에선 매 호출이 재시도 소진 + 지연(요청 4배 증폭)이 된다.
   * true여도 빈 본문은 여전히 일시 장애로 재시도한다.
   */
  allowHtmlBody?: boolean
}

const DEFAULT_TIMEOUT = 30000
const DEFAULT_RETRIES = 3
const DEFAULT_RETRY_DELAY = 1000
const DEFAULT_RETRY_ON = [429, 503, 504]

/**
 * 법제처 API가 200으로 빈 본문/HTML(점검·과부하 페이지)을 반환하는 간헐 장애 감지.
 * 정상 응답은 XML(`<`) 또는 JSON(`{`/`[`)으로 시작하므로 빈 본문과 HTML 페이지만 걸러낸다.
 */
function detectBadBody(text: string): "empty" | "html" | null {
  const t = text.trim()
  if (!t) return "empty"
  if (/^<!doctype html/i.test(t) || /^<html[\s>]/i.test(t)) return "html"
  return null
}

// 법제처 OPEN API가 Node 기본 UA(undici)를 봇으로 분류해 거부하므로
// 일반 브라우저 UA로 호출. LAW_USER_AGENT 환경변수로 override 가능.
const DEFAULT_USER_AGENT =
  process.env.LAW_USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

// 법제처 OPEN API는 Referer 헤더가 없으면 OC 키가 유효해도
// "사용자 정보 검증에 실패하였습니다 (정확한 서버장비의 IP주소 및 도메인주소를 등록해 주세요)"
// XML을 반환한다. 메시지는 IP/도메인 등록 문제로 오인되기 쉬우나 실제 원인은 Referer 누락이다.
// (브라우저 UA만으로는 통과하지 못하고 Referer가 결정적). LAW_REFERER 환경변수로 override 가능.
const DEFAULT_REFERER = process.env.LAW_REFERER || "https://www.law.go.kr/"

// Referer를 붙일 법제처 계열 호스트 판별 (그 외 호스트엔 주입하지 않음).
function isLawGoKrHost(targetUrl: string): boolean {
  try {
    return /(^|\.)law\.go\.kr$/i.test(new URL(targetUrl).hostname)
  } catch {
    return false
  }
}

/**
 * Fetch with automatic retry and timeout
 */
export async function fetchWithRetry(
  url: string,
  options: FetchWithRetryOptions = {}
): Promise<Response> {
  const {
    timeout = DEFAULT_TIMEOUT,
    retries = DEFAULT_RETRIES,
    retryDelay = DEFAULT_RETRY_DELAY,
    retryOn = DEFAULT_RETRY_ON,
    allowHtmlBody = false,
    ...fetchOptions
  } = options

  let lastError: Error | null = null

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeout)

    const headers = new Headers(fetchOptions.headers)
    if (!headers.has("user-agent")) headers.set("user-agent", DEFAULT_USER_AGENT)
    if (!headers.has("referer") && isLawGoKrHost(url)) headers.set("referer", DEFAULT_REFERER)

    try {
      let response = await fetch(url, {
        ...fetchOptions,
        headers,
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

      // Success or non-retryable error
      if (response.ok || !retryOn.includes(response.status)) {
        // 안티봇 우회(law-antibot)는 원저작 라이선스 부재로 미탑재 (NOTICE 참조).
        // 클라우드 IP 등에서 안티봇 HTML이 오면 아래 detectBadBody("html")가 잡아
        // 재시도 소진 후 오류가 되며, 호출 측은 ⚠판정불가("법제처 접근 차단 가능성")로 처리한다.
        // 200인데 빈 본문/HTML(법제처 점검·과부하 페이지)이면 일시 장애로 보고 재시도.
        // 이를 막지 않으면 XML 파서가 "missing root element"로 터진다.
        // ⚠ 마지막 시도도 검사한다 — 소진 후 불량 본문을 그대로 반환하면 JSON 경로
        //   (assertXmlRoot를 안 타는 조문·3단비교·별표)에서 오류가 0건으로 위장된다 (Opus 리뷰 B1-2)
        if (response.ok) {
          let bodyText: string | null = null
          try { bodyText = await response.clone().text() } catch { /* clone 실패 시 정상 처리 */ }
          if (bodyText !== null) {
            const bad = detectBadBody(bodyText)
            if (bad === "empty" || (bad === "html" && !allowHtmlBody)) {
              lastError = new Error(
                `법제처 API 비정상 응답(${bad === "empty" ? "빈 본문" : "HTML 페이지"}) - ${maskSensitiveUrl(url)}`
              )
              if (attempt < retries) {
                await sleep(getRetryDelay(response, retryDelay, attempt))
                continue
              }
              throw lastError // 재시도 소진 — 불량 응답을 정상으로 반환하지 않는다
            }
          }
        }
        return response
      }

      // Retryable error - check if we have retries left
      if (attempt < retries) {
        const delay = getRetryDelay(response, retryDelay, attempt)
        await sleep(delay)
        continue
      }

      // No retries left
      return response
    } catch (error) {
      clearTimeout(timeoutId)

      // Timeout or network error — URL에서 API 키 제거 후 에러 생성
      if (error instanceof Error) {
        if (error.name === "AbortError") {
          lastError = new Error(`Request timeout after ${timeout}ms for ${maskSensitiveUrl(url)}`)
        } else {
          // fetch 네이티브 에러 메시지에도 URL이 포함될 수 있음
          const masked = maskSensitiveUrl(error.message)
          lastError = masked !== error.message ? new Error(masked) : error
        }
      }

      // Retry on network errors
      if (attempt < retries) {
        const delay = getRetryDelay(null, retryDelay, attempt)
        await sleep(delay)
        continue
      }
    }
  }

  throw lastError || new Error("Request failed after retries")
}

/** Retry-After 헤더 우선, 없으면 exponential backoff + jitter */
function getRetryDelay(response: Response | null, retryDelay: number, attempt: number): number {
  if (response) {
    const retryAfter = response.headers.get("Retry-After")
    if (retryAfter) {
      const seconds = Number(retryAfter)
      if (!isNaN(seconds) && seconds > 0) {
        return seconds * 1000
      }
    }
  }
  const baseDelay = retryDelay * Math.pow(2, attempt)
  return baseDelay + Math.random() * baseDelay * 0.5
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
