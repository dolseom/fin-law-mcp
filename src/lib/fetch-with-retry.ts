/**
 * Fetch with retry and timeout
 * - Exponential backoff for 429, 503, 504
 * - AbortController for timeout
 */

/**
 * URL에서 민감 정보(API 키) 마스킹 — 에러 메시지/로그 노출 방지.
 * 법제처 API는 ?OC=KEY 쿼리 파라미터로 키를 받으므로 해당 값만 *** 처리.
 * 추가 방어로 일반적인 키 파라미터 이름들도 마스킹.
 *
 * XML 본문에서 그대로 꺼낸 링크는 `&`가 `&amp;`로 온다 — `…&amp;OC=KEY&amp;…`에서는 OC 앞 글자가
 * `;`라 `[?&]` 경계만 보면 키가 그대로 남는다 (Codex 9차: fin_annex·fin_nts_ruling 원문 링크).
 * `;`도 경계로 보고, 값은 `&`·공백·따옴표·꺾쇠에서 끊는다 (메시지 속 URL 뒤 문장까지 삼키지 않게).
 */
export function maskSensitiveUrl(url: string): string {
  if (!url) return url
  return url.replace(/([?&;](?:oc|apikey|api_key|authkey|auth_key|key)=)[^&\s"'<>]+/gi, "$1***")
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
  /**
   * Retry-After 대기 상한(ms). 서버가 이보다 오래 쉬라고 하면 재시도하지 않고 그 응답을 그대로 돌려준다.
   *
   * 상한이 없으면 429 + `Retry-After: 30`에 30초를 자다가 도구 deadline(취소)에 끊겨, 호출측에는
   * 원인(한도 초과) 대신 "요청 취소됨·타임아웃"만 남았다 (Codex 9차: fin_ping이 429를 타임아웃으로 분류).
   * 서버가 30초 쉬라는데 그 전에 다시 두드리는 재시도도 한도를 악화시킬 뿐이다.
   */
  maxRetryAfterMs?: number
  /**
   * 재시도 직전 게이트 — false면 재시도하지 않고 마지막 응답(오류 본문이면 그 오류)으로 끝낸다.
   * status는 재시도 사유가 된 HTTP 상태(네트워크 오류는 null). api-client가 429 재시도를
   * 분당 호출 한도에 계상하는 데 쓴다.
   */
  beforeRetry?: (status: number | null) => boolean
  /**
   * 콜당 timeout에 걸린 시도를 재시도할지 (기본 true — 종전 동작).
   * 콜당 timeout을 도구 deadline에 가깝게 길게 잡은 호출(3단비교 5초 / deadline 6초)은
   * timeout 뒤 재시도가 deadline 안에 끝날 수 없어 쿼터만 쓴다 — false면 timeout 오류를 바로 올린다.
   * 404·429·빈 본문 같은 빠른 실패의 재시도는 이 값과 무관하게 retries대로 한다
   */
  retryOnTimeout?: boolean
}

const DEFAULT_TIMEOUT = 30000
const DEFAULT_RETRIES = 3
const DEFAULT_RETRY_DELAY = 1000
const DEFAULT_RETRY_ON = [429, 503, 504]
const DEFAULT_MAX_RETRY_AFTER_MS = 10_000

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
    maxRetryAfterMs = DEFAULT_MAX_RETRY_AFTER_MS,
    beforeRetry,
    retryOnTimeout = true,
    signal: outerSignal,
    ...fetchOptions
  } = options

  let lastError: Error | null = null

  for (let attempt = 0; attempt <= retries; attempt++) {
    // 외부 취소(도구 deadline)는 재시도하지 않고 즉시 중단 — deadline이 지난 뒤에도
    // fetch가 백그라운드에서 살아 쿼터를 소모하던 문제 (Opus I3)
    if (outerSignal?.aborted) {
      throw new Error(`요청 취소됨(도구 deadline) - ${maskSensitiveUrl(url)}`)
    }
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeout)
    const onOuterAbort = () => controller.abort()
    outerSignal?.addEventListener("abort", onOuterAbort, { once: true })
    const cleanup = () => {
      clearTimeout(timeoutId)
      outerSignal?.removeEventListener("abort", onOuterAbort)
    }

    const headers = new Headers(fetchOptions.headers)
    if (!headers.has("user-agent")) headers.set("user-agent", DEFAULT_USER_AGENT)
    if (!headers.has("referer") && isLawGoKrHost(url)) headers.set("referer", DEFAULT_REFERER)

    try {
      let response = await fetch(url, {
        ...fetchOptions,
        headers,
        signal: controller.signal,
      })

      cleanup()

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
              if (attempt < retries && (!beforeRetry || beforeRetry(response.status))) {
                await sleep(getRetryDelay(response, retryDelay, attempt), outerSignal)
                continue
              }
              throw lastError // 재시도 소진·게이트 거부 — 불량 응답을 정상으로 반환하지 않는다
            }
          }
        }
        return response
      }

      // Retryable error - check if we have retries left
      if (attempt < retries) {
        // 서버가 상한보다 오래 쉬라고 했으면 기다리지 않고 그 응답(429 등)을 그대로 넘긴다 —
        // 호출측 상태 코드 분류가 "한도 초과"를 말할 수 있어야 한다
        // 게이트는 상한 확인 뒤에만 부른다 — 어차피 재시도하지 않을 응답에 한도 토큰을 쓰지 않게
        const serverWait = retryAfterMs(response)
        if (serverWait !== null && serverWait > maxRetryAfterMs) return response
        if (beforeRetry && !beforeRetry(response.status)) return response
        const delay = getRetryDelay(response, retryDelay, attempt)
        await sleep(delay, outerSignal)
        continue
      }

      // No retries left
      return response
    } catch (error) {
      cleanup()

      // Timeout or network error — URL에서 API 키 제거 후 에러 생성
      if (error instanceof Error) {
        if (error.name === "AbortError") {
          // 외부 취소(도구 deadline)는 timeout과 구분 — 재시도 없이 즉시 중단
          if (outerSignal?.aborted) {
            throw new Error(`요청 취소됨(도구 deadline) - ${maskSensitiveUrl(url)}`)
          }
          lastError = new Error(`Request timeout after ${timeout}ms for ${maskSensitiveUrl(url)}`)
          if (!retryOnTimeout) break // 재시도가 deadline 안에 끝날 수 없는 호출 — 바로 올린다
        } else {
          // fetch 네이티브 에러 메시지에도 URL이 포함될 수 있음
          const masked = maskSensitiveUrl(error.message)
          lastError = masked !== error.message ? new Error(masked) : error
        }
      }

      // Retry on network errors
      if (attempt < retries && (!beforeRetry || beforeRetry(null))) {
        const delay = getRetryDelay(null, retryDelay, attempt)
        await sleep(delay, outerSignal)
        continue
      }
      break // 재시도 소진·게이트 거부 — 마지막 오류를 던진다
    }
  }

  throw lastError || new Error("Request failed after retries")
}

/** Retry-After 헤더(초 단위)를 ms로 — 없거나 읽을 수 없으면 null */
function retryAfterMs(response: Response | null): number | null {
  const retryAfter = response?.headers.get("Retry-After")
  if (!retryAfter) return null
  const seconds = Number(retryAfter)
  return !isNaN(seconds) && seconds > 0 ? seconds * 1000 : null
}

/** Retry-After 헤더 우선, 없으면 exponential backoff + jitter */
function getRetryDelay(response: Response | null, retryDelay: number, attempt: number): number {
  const serverWait = retryAfterMs(response)
  if (serverWait !== null) return serverWait
  const baseDelay = retryDelay * Math.pow(2, attempt)
  return baseDelay + Math.random() * baseDelay * 0.5
}

/**
 * abort 가능한 대기. 외부 취소(도구 deadline)가 재시도 backoff 중에 걸리면
 * 남은 대기를 건너뛰고 즉시 깨어난다 — 이게 없으면 20ms에 취소해도 backoff
 * 1초를 다 기다린 뒤에야 끝난다 (Codex 리뷰 중요 4).
 */
function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener("abort", done)
      resolve()
    }
    signal?.addEventListener("abort", done, { once: true })
  })
}
