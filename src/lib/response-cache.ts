/**
 * 프로세스 내 응답 캐시 — 같은 조회의 반복 왕복을 없앤다.
 *
 * 왜 필요한가: fin_verify는 인용마다 법령 검색·조문 조회를 따로 한다. 한 문서에서
 * 같은 법령이 다섯 번 인용되면 같은 요청이 다섯 번 나가고, 그 비용이 15건 상한·
 * 20초 상한·분당 한도(기본 30)를 모두 압박한다. 행정규칙 본문은 한 건이 380~760KB라
 * 반복 조회의 대가가 특히 크다.
 *
 * 안전 규칙 (이 저장소의 "조용한 실패 금지"와 같은 선):
 *  · 성공 응답만 담는다 — 오류·HTML 장애 페이지를 담으면 일시 장애가 TTL 동안 고정된다
 *  · 키는 요청 URL 전체다 — efYd(기준일)·target·조문 번호가 모두 URL에 있으므로
 *    기준일 조회와 현행 조회가 섞이지 않는다
 *  · TTL·항목 수·총 바이트 상한을 모두 둔다. 상한 초과 시 오래된 항목부터 버린다
 *  · FIN_CACHE_TTL_SEC=0이면 캐시를 끈다 (장애 진단용 탈출구)
 */

export interface ResponseCacheStats {
  hits: number
  misses: number
  entries: number
  bytes: number
}

interface Entry {
  value: string
  expiresAt: number
  bytes: number
}

export interface ResponseCacheOptions {
  ttlMs?: number
  maxEntries?: number
  maxBytes?: number
  now?: () => number
}

const DEFAULT_TTL_MS = 10 * 60 * 1000
const DEFAULT_MAX_ENTRIES = 200
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024

export class ResponseCache {
  private map = new Map<string, Entry>()
  private ttlMs: number
  private maxEntries: number
  private maxBytes: number
  private now: () => number
  private bytes = 0
  private hits = 0
  private misses = 0

  constructor(opts: ResponseCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
    this.now = opts.now ?? Date.now
  }

  get enabled(): boolean {
    return this.ttlMs > 0
  }

  /**
   * @param accept **지금 호출의** 가드. 키가 요청 URL뿐이라 같은 URL을 더 느슨한 조건으로
   *   요청한 호출이 담아 둔 본문이 남아 있을 수 있다 (fetchApi의 expectedRoot·expectedJsonKey는
   *   URL에 들어가지 않는다). 거부하면 적중으로 세지 않고 **미스로 돌려 그 항목을 버린다** —
   *   호출측이 네트워크로 회복해야 한다
   */
  get(key: string, accept?: (value: string) => boolean): string | undefined {
    if (!this.enabled) return undefined
    const hit = this.map.get(key)
    if (!hit) {
      this.misses++
      return undefined
    }
    if (hit.expiresAt <= this.now()) {
      this.map.delete(key)
      this.bytes -= hit.bytes
      this.misses++
      return undefined
    }
    if (accept && !accept(hit.value)) {
      this.map.delete(key)
      this.bytes -= hit.bytes
      this.misses++
      return undefined
    }
    // 최근 사용을 뒤로 보내 LRU 근사를 만든다 (Map은 삽입 순서를 유지한다)
    this.map.delete(key)
    this.map.set(key, hit)
    this.hits++
    return hit.value
  }

  set(key: string, value: string): void {
    if (!this.enabled) return
    const bytes = value.length * 2 // UTF-16 근사 — 정확한 바이트가 아니라 상한 관리용
    if (bytes > this.maxBytes) return // 단일 응답이 상한을 넘으면 담지 않는다
    const prev = this.map.get(key)
    if (prev) this.bytes -= prev.bytes
    this.map.delete(key)
    this.map.set(key, { value, bytes, expiresAt: this.now() + this.ttlMs })
    this.bytes += bytes
    this.evict()
  }

  private evict(): void {
    while (this.map.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.map.keys().next()
      if (oldest.done) break
      const entry = this.map.get(oldest.value)
      this.map.delete(oldest.value)
      if (entry) this.bytes -= entry.bytes
    }
  }

  clear(): void {
    this.map.clear()
    this.bytes = 0
  }

  stats(): ResponseCacheStats {
    return { hits: this.hits, misses: this.misses, entries: this.map.size, bytes: this.bytes }
  }
}

/**
 * 캐시에 담아도 되는 응답인지. 장애 페이지·빈 응답을 담으면 일시 장애가 TTL 동안
 * 고정되어 "조용한 실패"가 된다 — 상위 가드(assertXmlRoot·checkHtmlError)가 잡기 전에
 * 여기서 먼저 거른다
 */
export function isCacheableBody(text: string): boolean {
  if (!text || !text.trim()) return false
  if (/^\s*<!doctype\s+html|^\s*<html[\s>]/i.test(text)) return false
  // 법제처는 200 + 정상 형식의 오류 본문도 돌려준다 (<error>…</error>,
  // {"error":…}). 이것을 담으면 일시 장애가 TTL 동안 "0건"으로 고정된다 — 상위 가드가
  // 잡기 전에 캐시에서 먼저 거른다 (Codex 7차 중요)
  if (/^\s*(?:<\?xml[^>]*\?>\s*)?<\s*(?:error|Error|ERROR|fault|OpenAPI_ServiceResponse)[\s>]/.test(text)) return false
  if (/^\s*\{\s*"(?:error|errorMessage|resultCode)"/.test(text)) return false
  return true
}

/**
 * `FIN_CACHE_TTL_SEC`이 정하는 캐시 TTL(ms). 0이면 캐시 완전 비활성.
 * 미지정 600초 / 숫자 아님·0·음수는 비활성.
 *
 * 이 저장소의 캐시 두 계층(응답 본문 캐시 = 이 파일, 파싱 결과 캐시 = `cache.ts`)이
 * **같은 함수**로 on/off를 판정한다 — 규칙을 두 곳에 쓰면 어긋난다
 */
export function resolveCacheTtlMs(): number {
  const ttlSec = process.env.FIN_CACHE_TTL_SEC === undefined ? 600 : Number(process.env.FIN_CACHE_TTL_SEC)
  return Number.isFinite(ttlSec) && ttlSec > 0 ? ttlSec * 1000 : 0
}

/** 환경변수 기반 기본 캐시 — FIN_CACHE_TTL_SEC=0이면 비활성 */
export function createResponseCacheFromEnv(): ResponseCache {
  const maxEntries = Number(process.env.FIN_CACHE_MAX_ENTRIES) || DEFAULT_MAX_ENTRIES
  const maxMb = Number(process.env.FIN_CACHE_MAX_MB) || 16
  return new ResponseCache({
    ttlMs: resolveCacheTtlMs(),
    maxEntries,
    maxBytes: maxMb * 1024 * 1024,
  })
}
