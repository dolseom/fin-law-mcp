/**
 * 파싱 결과 캐시 — 자주 조회되는 법령 데이터를 캐싱하여 API 호출·재파싱 절약.
 *
 * ⚠ 이 저장소에는 캐시가 **둘**이다. 규칙이 어긋나면 안 된다:
 *  ① `response-cache.ts` — drfFetch 단일 관문의 **응답 본문** 캐시
 *  ② 이 파일의 `lawCache` — law-search·abolished-laws의 **파싱 결과** 캐시
 *
 * 둘 다 `FIN_CACHE_TTL_SEC` 하나로 제어한다. 종전에는 ②가 env와 무관한 1시간 고정이라
 *  · `FIN_CACHE_TTL_SEC=0`(장애 진단용 탈출구)이 ①만 끄고 ②는 그대로 살아 있었고
 *  · README가 약속한 "신선도를 최대 TTL만큼 늦춘다"가 ②에서는 6배(10분 → 1시간) 틀렸다.
 * 이제 env가 ②의 **상한**이다 — 호출부가 더 짧은 TTL을 요청하면 그쪽이 이긴다.
 */

import { resolveCacheTtlMs } from "./response-cache.js"

/** 호출부 기본 TTL — env가 더 짧으면 env가 이긴다 */
export const DEFAULT_LAW_CACHE_TTL_MS = 60 * 60 * 1000

// env 파싱은 response-cache.ts의 resolveCacheTtlMs 하나만 쓴다 — 두 계층이 같은 판정을
// 공유해야 하고, 규칙을 두 곳에 쓰면 어긋난다 (cache.test.ts가 일치를 대조한다)
export { resolveCacheTtlMs }

interface CacheEntry<T> {
  data: T
  timestamp: number
  ttl: number // time to live in milliseconds
}

export class SimpleCache {
  private cache: Map<string, CacheEntry<any>>
  private maxSize: number

  constructor(maxSize: number = 100) {
    this.cache = new Map()
    this.maxSize = maxSize
  }

  set<T>(key: string, data: T, ttl: number = 24 * 60 * 60 * 1000): void {
    // TTL default: 24 hours

    const envTtl = resolveCacheTtlMs()
    if (envTtl <= 0) {
      // FIN_CACHE_TTL_SEC=0 — 완전 bypass. 이미 담긴 항목도 지운다(런타임 중 꺼도 즉시 듣도록)
      this.cache.delete(key)
      return
    }
    // env는 상한이다 — 호출부가 더 짧게 요청하면 그쪽을 쓴다
    const effectiveTtl = Math.min(ttl, envTtl)

    // If cache is full, evict expired entries first, then oldest
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      this.evictOne()
    }

    // 기존 키 업데이트 시 Map 순서 끝으로 이동 (LRU 정합성)
    this.cache.delete(key)
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      ttl: effectiveTtl
    })
  }

  /** 만료 엔트리 우선 제거, 없으면 LRU(가장 오래된) 제거 */
  private evictOne(): void {
    const now = Date.now()
    // 1차: 만료된 엔트리 찾아서 제거
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > entry.ttl) {
        this.cache.delete(key)
        return
      }
    }
    // 2차: 만료 없으면 Map 순서상 첫 번째(가장 오래된) 제거
    const oldestKey = this.cache.keys().next().value
    if (oldestKey) {
      this.cache.delete(oldestKey)
    }
  }

  get<T>(key: string): T | null {
    if (resolveCacheTtlMs() <= 0) return null // FIN_CACHE_TTL_SEC=0 — 항상 miss
    const entry = this.cache.get(key)

    if (!entry) {
      return null
    }

    // Check if expired
    const now = Date.now()
    if (now - entry.timestamp > entry.ttl) {
      this.cache.delete(key)
      return null
    }

    // LRU 승격: Map 순서 끝으로 이동
    this.cache.delete(key)
    this.cache.set(key, entry)

    return entry.data as T
  }

  has(key: string): boolean {
    if (resolveCacheTtlMs() <= 0) return false // FIN_CACHE_TTL_SEC=0 — 항상 miss
    const entry = this.cache.get(key)
    if (!entry) return false

    // Check if expired
    const now = Date.now()
    if (now - entry.timestamp > entry.ttl) {
      this.cache.delete(key)
      return false
    }

    return true
  }

  delete(key: string): void {
    this.cache.delete(key)
  }

  clear(): void {
    this.cache.clear()
  }

  size(): number {
    return this.cache.size
  }

  // Clean up expired entries
  cleanup(): void {
    const now = Date.now()
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > entry.ttl) {
        this.cache.delete(key)
      }
    }
  }
}

// Global cache instance
// 64개 도구 × 다양한 쿼리 조합 → maxSize=100은 빈번한 eviction 유발
// 법령 데이터는 변경 빈도가 낮아 캐시 적중률이 높으므로 넉넉하게 설정
export const lawCache = new SimpleCache(500)

// Cleanup expired entries every hour
setInterval(() => {
  lawCache.cleanup()
}, 60 * 60 * 1000).unref()
