/**
 * 법제처 API 클라이언트
 */

import { normalizeLawSearchText, resolveLawAlias } from "./search-normalizer.js"
import { fetchWithRetry } from "./fetch-with-retry.js"

// 법제처 DRF는 정상 파라미터에도 연속 호출 버스트에 간헐 404를 낸다
// (2026-07-19 행위시법 골드셋 R1에서 19콜 중 10콜 관측, 수초 내 자연 회복 —
// lsHistory 페이징 연속 조회에서 특히 빈발). DRF 엔드포인트는 고정이라
// 영구 404가 사실상 없으므로 404를 재시도 대상에 포함한다.
// 재시도 2회·콜당 timeout 3초 (PRD 04 운영 계약 — 콜 하나가 도구 deadline 6초를 다 먹지 않게)
const DRF_RETRY = { retryOn: [404, 429, 503, 504], retries: 2, timeout: 3000 }
import { requestContext } from "./session-state.js"
import { getLawApiBaseUrl } from "./law-url-config.js"
import { createTokenBucket, createDailyCap, createSemaphore, type TokenBucket, type DailyCap, type Semaphore } from "./rate-limit.js"
import { createResponseCacheFromEnv, isCacheableBody, type ResponseCache, type ResponseCacheStats } from "./response-cache.js"

const LAW_API_BASE = getLawApiBaseUrl()

export class LawApiClient {
  private defaultApiKey: string
  private bucket: TokenBucket
  private dailyCap: DailyCap
  private semaphore: Semaphore
  private cache: ResponseCache

  constructor(config: { apiKey: string }) {
    this.defaultApiKey = config.apiKey
    // PRD 04: 기존 law-mcp와 같은 LAW_OC 키를 공유하는 병행 환경이 기본 전제 —
    // 보수적으로 30/분·1,500/일로 시작, 단독 사용 시 환경변수로 상향 (Opus 리뷰 반영)
    const ratePerMin = Number(process.env.FIN_DRF_RATE_PER_MIN) || 30
    const daily = Number(process.env.FIN_DRF_DAILY_CAP) || 1500
    // 동시 실행 상한 — DRF는 연속 버스트에 간헐 404 (Opus I3: maxConcurrency 4)
    const maxConcurrency = Math.min(Math.max(Number(process.env.FIN_DRF_MAX_CONCURRENCY) || 4, 1), 16)
    this.bucket = createTokenBucket(ratePerMin)
    this.dailyCap = createDailyCap(daily)
    this.semaphore = createSemaphore(maxConcurrency)
    // 같은 URL의 반복 조회를 프로세스 안에서 접는다 (FIN_CACHE_TTL_SEC=0이면 비활성).
    // 인용 5건이 같은 법령을 가리키면 종전엔 검색·조문 조회가 5회씩 나갔다
    this.cache = createResponseCacheFromEnv()
  }

  /** 캐시 적중 통계 — 진단용 (fin_ping) */
  cacheStats(): ResponseCacheStats {
    return this.cache.stats()
  }

  /** 호출 전 한도 게이트 — 초과는 RATE_LIMITED로 throw (0건 위장 금지: 호출측에서 ⚠ 처리) */
  private gate(): void {
    const v1 = this.bucket.take(1)
    if (!v1.ok) throw new Error(`RATE_LIMITED: 분당 호출 한도 초과 — ${v1.retryAfterSec}초 후 재시도하세요.`)
    const v2 = this.dailyCap.take(1)
    if (!v2.ok) throw new Error(`RATE_LIMITED: 일일 호출 한도 초과 — ${v2.retryAfterSec}초 후 재시도하세요.`)
  }

  /** 모든 DRF 호출의 단일 관문 — 동시 실행 상한(세마포어) + rate limit 게이트를 거친다 */
  private async drfFetch(url: string, opts: Parameters<typeof fetchWithRetry>[1] = DRF_RETRY): Promise<Response> {
    const signal = opts?.signal as AbortSignal | undefined
    // 캐시 적중은 세마포어·rate limit 앞에서 처리한다 — 나가지 않는 호출이
    // 동시성 슬롯과 분당 토큰을 먹으면 캐시의 의미가 없다
    const cached = this.cache.get(url)
    if (cached !== undefined) return new Response(cached, { status: 200 })
    const release = await this.semaphore.acquire()
    try {
      // 세마포어 대기 중 deadline이 지났으면 호출하지 않는다 — 뒤늦은 호출은
      // 결과를 쓰지도 못하면서 쿼터만 소모한다 (Codex 리뷰 중요 4)
      if (signal?.aborted) throw new Error("요청 취소됨(도구 deadline) — 대기 중 취소되어 호출하지 않음")
      this.gate() // 토큰 소모는 실제 호출 직전 — 세마포어 대기 중 소모하지 않는다
      const res = await fetchWithRetry(url, opts)
      // 오류 응답은 담지 않는다 — 일시 장애를 TTL 동안 고정하면 "조용한 실패"가 된다.
      // 본문을 한 번 읽어 캐시에 넣고 같은 내용의 새 Response를 돌려준다
      // (호출부는 .text()만 쓴다 — clone()은 큰 응답에서 메모리를 두 배로 쓴다)
      if (!res.ok || !this.cache.enabled) return res
      const text = await res.text()
      if (isCacheableBody(text)) this.cache.set(url, text)
      return new Response(text, { status: res.status, statusText: res.statusText })
    } finally {
      release()
    }
  }

  /**
   * 검색 XML의 루트 엘리먼트 검증 — 정상 형식의 오류 XML("사용자 정보 검증 실패" 등)이
   * "0건"으로 읽히는 사고 방지 (08 문서 실사고 · Codex 코드 리뷰 차단 1).
   * admrul 경로(admin-rule-citation)에만 있던 가드를 공용으로 승격.
   */
  private assertXmlRoot(text: string, expectedRoots: string[], context: string): void {
    const m = text.match(/<\s*([A-Za-z_][\w]*)[\s>]/)
    const root = m?.[1]
    if (!root || !expectedRoots.includes(root)) {
      throw new Error(
        `${context} - 법제처 API가 예상 밖 응답(루트 ${root || "없음"})을 반환했습니다. ` +
          `오류 응답일 수 있습니다 — "0건"이 아니라 확인 실패로 처리하세요.`
      )
    }
  }

  /**
   * JSON 응답의 기대 최상위 키 검증 — assertXmlRoot의 JSON 대응물.
   * 법제처는 조회 조건이 안 맞으면 200 + 짧은 JSON(루트 키가 다름)을 돌려주는데,
   * 이를 "조회는 됐고 내용이 없다"로 읽으면 오류가 0건으로 위장된다.
   */
  private assertJsonKey(text: string, expectedKey: string, context: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error(`${context} - 법제처 API 응답을 JSON으로 파싱하지 못했습니다 — "0건"이 아니라 확인 실패로 처리하세요.`)
    }
    if (!parsed || typeof parsed !== "object" || !(expectedKey in (parsed as Record<string, unknown>))) {
      const keys = parsed && typeof parsed === "object" ? Object.keys(parsed as Record<string, unknown>).slice(0, 3).join(", ") : "없음"
      throw new Error(
        `${context} - 법제처 API가 예상 밖 응답(최상위 키: ${keys || "없음"}, 기대: ${expectedKey})을 반환했습니다. ` +
          `조회 조건 불일치·오류 응답일 수 있습니다 — "0건"이 아니라 확인 실패로 처리하세요.`
      )
    }
  }

  /**
   * API 키 결정 순서:
   * 1. 요청별 override 키
   * 2. 현재 요청 컨텍스트의 API 키 (HTTP stateless 모드)
   * 3. 환경변수 LAW_OC
   * 4. 생성자에서 받은 기본 키
   */
  private getApiKey(overrideKey?: string): string {
    const ctxApiKey = requestContext.getStore()?.apiKey
    // KOREAN_LAW_API_KEY(기존 korean-law MCP의 변수) 폴백은 제거 — 문서 계약은
    // "LAW_OC만"이고, 다른 서버의 키를 조용히 빌려 쓰면 rate limit 공유가 숨는다 (Codex 리뷰)
    const key = overrideKey || ctxApiKey || process.env.LAW_OC || this.defaultApiKey
    if (!key) {
      throw new Error("API 키가 필요합니다. 법제처(https://open.law.go.kr/LSO/openApi/guideResult.do)에서 발급받으세요.")
    }
    return key
  }

  /** HTTP 응답 검증 — 상태 코드 분류 + HTML 에러 페이지 감지 */
  private async throwIfError(response: Response, endpoint: string): Promise<void> {
    if (!response.ok) {
      // body stream 리크 방지: throw 전에 body consume
      try { await response.text() } catch { /* ignore */ }
      const status = response.status
      if (status === 429) throw new Error(`API 요청 한도 초과 (429) - 잠시 후 다시 시도하세요.`)
      if (status >= 500) throw new Error(`법제처 서버 오류 (${status}) - ${endpoint}`)
      throw new Error(`API 오류 (${status}) - ${endpoint}`)
    }
  }

  /** 현재 응답 타입 반환 (환경변수 LAW_RESPONSE_TYPE, 기본값 XML) */
  private getResponseType(): "XML" | "JSON" {
    const t = (process.env.LAW_RESPONSE_TYPE || "XML").toUpperCase()
    return t === "JSON" ? "JSON" : "XML"
  }

  /** 응답 본문이 HTML 에러 페이지인지 확인 — 대소문자 무시 (<HTML> 변형이 통과한 실사고, fixture 테스트로 박제) */
  private checkHtmlError(text: string, context: string): void {
    if (/<!doctype\s+html|<html[\s>]/i.test(text)) {
      const hint = this.getResponseType() === "XML"
        ? " XML 엔드포인트 장애 시 LAW_RESPONSE_TYPE=JSON 환경변수로 우회할 수 있습니다."
        : ""
      throw new Error(`${context} - API가 HTML 에러 페이지를 반환했습니다. 파라미터를 확인해주세요.${hint}`)
    }
  }

  /**
   * 빈 응답 감지 — 법제처가 간헐 장애 시 200으로 빈 본문을 반환하는 케이스.
   * 그대로 XML 파서에 넘기면 "missing root element"로 터지므로 명확한 메시지로 전환.
   * (fetchWithRetry가 빈/HTML 응답을 재시도하지만, 재시도 소진 후에도 빈 응답이면 여기서 처리)
   */
  private checkEmptyResponse(text: string, context: string): void {
    if (!text || !text.trim()) {
      throw new Error(`${context} - 법제처 API가 빈 응답을 반환했습니다. 일시적 장애일 수 있으니 잠시 후 다시 시도하세요.`)
    }
  }

  /**
   * 법령 검색
   * @param display 결과 개수 (기본값 법제처 API default, 짧은 법령명("상법" 등) 정확 매칭 찾으려면 큰 값 권장)
   * @param target "law"=현행법령(기본), "eflaw"=시행일 기준(시행예정 포함)
   */
  async searchLaw(query: string, apiKey?: string, display?: number, target: "law" | "eflaw" = "law", signal?: AbortSignal): Promise<string> {
    const normalizedQuery = normalizeLawSearchText(query)
    const aliasResolution = resolveLawAlias(normalizedQuery)
    const finalQuery = aliasResolution.canonical

    const params = new URLSearchParams({
      OC: this.getApiKey(apiKey),
      type: this.getResponseType(),
      target,
      query: finalQuery,
    })
    if (display && display > 0) params.append("display", String(display))

    const url = `${LAW_API_BASE}/lawSearch.do?${params.toString()}`
    const response = await this.drfFetch(url, signal ? { ...DRF_RETRY, signal } : DRF_RETRY)
    await this.throwIfError(response, "searchLaw")

    const text = await response.text()
    this.checkEmptyResponse(text, "법령 검색")
    this.checkHtmlError(text, "법령 검색 결과를 받지 못했습니다")
    if (this.getResponseType() === "XML") this.assertXmlRoot(text, ["LawSearch"], "법령 검색")
    return text
  }

  /**
   * 현행법령 조회
   */
  async getLawText(params: {
    mst?: string
    lawId?: string
    jo?: string
    efYd?: string
    apiKey?: string
  }): Promise<string> {
    // 현행 조회는 target=law — 법제처가 efYd 없는 eflaw lawService를 HTML 오류로
    // 돌려주기 시작했다 (2026-08-30 실측). eflaw는 기준일(efYd) 조회에만
    const apiParams = new URLSearchParams({
      target: params.efYd ? "eflaw" : "law",
      OC: this.getApiKey(params.apiKey),
      type: "JSON",
    })

    if (params.mst) apiParams.append("MST", String(params.mst))
    if (params.lawId) apiParams.append("ID", String(params.lawId))
    if (params.jo) apiParams.append("JO", String(params.jo))
    if (params.efYd) apiParams.append("efYd", String(params.efYd))

    const url = `${LAW_API_BASE}/lawService.do?${apiParams.toString()}`
    const response = await this.drfFetch(url)
    await this.throwIfError(response, "getLawText")

    const text = await response.text()

    this.checkHtmlError(text, params.jo
      ? `법령 조문(${params.jo})을 찾을 수 없습니다. MST/lawId와 조문번호를 확인해주세요.`
      : "법령을 찾을 수 없습니다. MST 또는 법령명을 확인해주세요.")

    return text
  }

  /**
   * 신구법 대조
   */
  async compareOldNew(params: {
    mst?: string
    lawId?: string
    ld?: string
    ln?: string
    apiKey?: string
  }): Promise<string> {
    const apiParams = new URLSearchParams({
      target: "oldAndNew",
      OC: this.getApiKey(params.apiKey),
      type: this.getResponseType(),
    })

    if (params.mst) apiParams.append("MST", String(params.mst))
    if (params.lawId) apiParams.append("ID", String(params.lawId))
    if (params.ld) apiParams.append("LD", String(params.ld))
    if (params.ln) apiParams.append("LN", String(params.ln))

    const url = `${LAW_API_BASE}/lawService.do?${apiParams.toString()}`
    const response = await this.drfFetch(url)
    await this.throwIfError(response, "compareOldNew")

    return await response.text()
  }

  /**
   * 3단비교 (위임조문)
   */
  async getThreeTier(params: {
    mst?: string
    lawId?: string
    knd?: "1" | "2"
    apiKey?: string
    signal?: AbortSignal
  }): Promise<string> {
    const apiParams = new URLSearchParams({
      target: "thdCmp",
      OC: this.getApiKey(params.apiKey),
      type: "JSON",
      knd: params.knd || "2",
    })

    if (params.mst) apiParams.append("MST", String(params.mst))
    if (params.lawId) apiParams.append("ID", String(params.lawId))

    const url = `${LAW_API_BASE}/lawService.do?${apiParams.toString()}`
    const response = await this.drfFetch(url, params.signal ? { ...DRF_RETRY, signal: params.signal } : DRF_RETRY)
    await this.throwIfError(response, "getThreeTier")

    return await response.text()
  }

  /**
   * 행정규칙 검색
   */
  async searchAdminRule(params: {
    query: string
    knd?: string
    apiKey?: string
    nw?: string // 1=현행(기본), 2=연혁 — 폐지·개정 전 이력 포함
    display?: string // 결과 수 (기본 20) — 자체 패치 #4: 인용 검증은 100 필요 (가나다순 밀림 대비)
    // 도구 deadline 전파 — 이것이 없으면 verify의 20초 상한 이후에도 행정규칙 호출이
    // 살아남아 쿼터를 소모한다. 다른 조회 경로에는 모두 있는데 여기만 빠져 있었다
    // (Codex 리뷰 중요 5)
    signal?: AbortSignal
  }): Promise<string> {
    const apiParams = new URLSearchParams({
      OC: this.getApiKey(params.apiKey),
      type: this.getResponseType(),
      target: "admrul",
      query: params.query,
    })

    if (params.knd) apiParams.append("knd", params.knd)
    if (params.nw) apiParams.append("nw", params.nw)
    if (params.display) apiParams.append("display", params.display)

    const url = `${LAW_API_BASE}/lawSearch.do?${apiParams.toString()}`
    const response = await this.drfFetch(url, params.signal ? { ...DRF_RETRY, signal: params.signal } : DRF_RETRY)
    await this.throwIfError(response, "searchAdminRule")

    return await response.text()
  }

  /**
   * 행정규칙 조회
   */
  async getAdminRule(id: string, apiKey?: string, signal?: AbortSignal): Promise<string> {
    const apiParams = new URLSearchParams({
      target: "admrul",
      OC: this.getApiKey(apiKey),
      type: this.getResponseType(),
      ID: id,
    })

    const url = `${LAW_API_BASE}/lawService.do?${apiParams.toString()}`
    // 본문이 크다(실측 213~405KB) — 도구 deadline을 전파해 상한 이후 조회를 끊는다
    const response = await this.drfFetch(url, signal ? { ...DRF_RETRY, signal } : DRF_RETRY)
    await this.throwIfError(response, "getAdminRule")

    const text = await response.text()
    this.checkHtmlError(text, "행정규칙을 찾을 수 없습니다. ID를 확인해주세요")

    return text
  }

  /**
   * 별표/서식 조회
   * LexDiff 방식: lawSearch.do + target=licbyl
   */
  async getAnnexes(params: {
    lawName: string
    knd?: "1" | "2" | "3" | "4" | "5"
    apiKey?: string
    signal?: AbortSignal
  }): Promise<string> {
    // 법령 종류 판별
    const lawType = this.detectLawType(params.lawName)
    const targetMap = {
      law: "licbyl",
      ordinance: "ordinbyl",
      admin: "admbyl",
    }
    const target = targetMap[lawType]

    const apiParams = new URLSearchParams({
      target,
      OC: this.getApiKey(params.apiKey),
      type: "JSON",
      query: params.lawName,
      search: "2", // 해당법령으로 검색
      display: "100", // 최대 100개
    })

    // 일반 법령만 knd 필터 적용
    if (lawType === 'law' && params.knd) {
      apiParams.set("knd", params.knd)
    }

    const url = `${LAW_API_BASE}/lawSearch.do?${apiParams.toString()}`
    const response = await this.drfFetch(url, params.signal ? { ...DRF_RETRY, signal: params.signal } : DRF_RETRY)
    await this.throwIfError(response, "getAnnexes")

    const text = await response.text()
    // 법제처는 별표 API 미신청 계정에 200 + HTML("미신청된 목록/본문에 대한 접근입니다")을 준다.
    // 가드가 없으면 JSON.parse 실패가 "응답 형식 이상 — 법제처 장애"로 오진되어 신규 사용자가
    // 원인(OPEN API 별표 종류 미신청)을 못 찾는다 (Opus 리뷰 개선 5)
    this.checkEmptyResponse(text, "별표 조회")
    if (/<!doctype\s+html|<html[\s>]/i.test(text)) {
      throw new Error(
        "별표 조회 - API가 HTML 페이지를 반환했습니다. 법제처 OPEN API 신청에 '별표·서식'이 포함되지 않았거나 일시 장애일 수 있습니다 (open.law.go.kr에서 신청 범위 확인)."
      )
    }
    return text
  }

  /**
   * 법령 종류 판별
   */
  private detectLawType(lawName: string): 'law' | 'ordinance' | 'admin' {
    // 조례/규칙 판별 (자치법규)
    if (/조례/.test(lawName) ||
      /(특별시|광역시|도|시|군|구)\s+[가-힣]+\s*(조례|규칙)/.test(lawName)) {
      return 'ordinance'
    }

    // 시행령/시행규칙이 있으면 일반 법령 ("령"만으로는 판별 불가 — "복무규정", "관리령" 등 행정규칙 오분류 방지)
    if (/시행령|시행규칙/.test(lawName)) {
      return 'law'
    }

    // 행정규칙: 훈령, 예규, 고시, 지침, 내규, 세칙 (규정/규칙 단독은 시행규칙 오분류 위험 → 4차 fallback에 위임)
    if (/훈령|예규|고시|지침|내규|세칙/.test(lawName)) {
      return 'admin'
    }

    // 일반 법령 (법, 규정 등)
    return 'law'
  }

  /**
   * 자치법규 검색
   */
  async searchOrdinance(params: {
    query: string
    display?: number
    apiKey?: string
  }): Promise<string> {
    const apiParams = new URLSearchParams({
      target: "ordin",
      OC: this.getApiKey(params.apiKey),
      type: this.getResponseType(),
      query: params.query,
      display: (params.display || 20).toString(),
    })

    const url = `${LAW_API_BASE}/lawSearch.do?${apiParams.toString()}`
    const response = await this.drfFetch(url)
    await this.throwIfError(response, "searchOrdinance")

    return await response.text()
  }

  /**
   * 자치법규 조회
   */
  async getOrdinance(ordinSeq: string, jo?: string, apiKey?: string): Promise<string> {
    const apiParams = new URLSearchParams({
      target: "ordin",
      OC: this.getApiKey(apiKey),
      type: "JSON",
      MST: ordinSeq,
    })
    if (jo) apiParams.append("JO", jo)

    const url = `${LAW_API_BASE}/lawService.do?${apiParams.toString()}`
    const response = await this.drfFetch(url)
    await this.throwIfError(response, "getOrdinance")

    const text = await response.text()
    this.checkHtmlError(text, "자치법규를 찾을 수 없습니다. ordinSeq를 확인해주세요")

    return text
  }

  /**
   * 일자별 조문 개정 이력 조회
   */
  async getArticleHistory(params: {
    lawId?: string
    jo?: string
    regDt?: string
    fromRegDt?: string
    toRegDt?: string
    org?: string
    page?: number
    apiKey?: string
  }): Promise<string> {
    const apiParams = new URLSearchParams({
      target: "lsJoHstInf",
      OC: this.getApiKey(params.apiKey),
      type: this.getResponseType(),
    })

    if (params.lawId) apiParams.append("ID", String(params.lawId))
    if (params.jo) apiParams.append("JO", String(params.jo))
    if (params.regDt) apiParams.append("regDt", String(params.regDt))
    if (params.fromRegDt) apiParams.append("fromRegDt", String(params.fromRegDt))
    if (params.toRegDt) apiParams.append("toRegDt", String(params.toRegDt))
    if (params.org) apiParams.append("org", String(params.org))
    if (params.page) apiParams.append("page", params.page.toString())

    const url = `${LAW_API_BASE}/lawSearch.do?${apiParams.toString()}`
    const response = await this.drfFetch(url)
    await this.throwIfError(response, "getArticleHistory")

    return await response.text()
  }

  /**
   * 범용 API 호출 (fetchWithRetry 기반)
   */
  async fetchApi(params: {
    endpoint: "lawSearch.do" | "lawService.do"
    target: string
    type?: "XML" | "JSON" | "HTML"
    extraParams?: Record<string, string>
    apiKey?: string
    /** 검색 XML의 기대 루트 (예: "CgmExpc") — 지정 시 불일치는 오류로 throw (0건 위장 방지) */
    expectedRoot?: string
    /** JSON 응답의 기대 최상위 키 (예: "법령") — 부재 시 throw (JSON 경로의 0건 위장 방지) */
    expectedJsonKey?: string
    /** 도구 deadline 취소 전파 — abort 시 재시도 없이 즉시 중단 (쿼터 보호) */
    signal?: AbortSignal
  }): Promise<string> {
    const init: Record<string, string> = {
      OC: this.getApiKey(params.apiKey),
      target: params.target,
    }
    if (params.type) init.type = params.type
    const apiParams = new URLSearchParams(init)

    if (params.extraParams) {
      for (const [key, value] of Object.entries(params.extraParams)) {
        apiParams.append(key, String(value))
      }
    }

    const url = `${LAW_API_BASE}/${params.endpoint}?${apiParams.toString()}`
    // type=HTML(lsHistory 등)은 HTML 본문이 정상 — 빈본문/HTML 재시도 휴리스틱이
    // 정상 응답마다 재시도를 소진(요청 4배 증폭 + ~7s 지연)하지 않도록 허용 플래그
    const response = await this.drfFetch(url, {
      ...DRF_RETRY,
      ...(params.type === "HTML" ? { allowHtmlBody: true } : {}),
      ...(params.signal ? { signal: params.signal } : {}),
    })
    await this.throwIfError(response, `fetchApi(${params.target})`)

    const text = await response.text()
    // type=HTML 응답은 HTML이 정상 — checkHtmlError(XML/JSON 응답에 HTML이 오면 에러) 우회
    if (params.type !== "HTML") {
      this.checkEmptyResponse(text, `fetchApi(${params.target})`)
      this.checkHtmlError(text, "API 응답 오류 - 파라미터를 확인해주세요")
    }
    // 검색 XML은 루트 검증 — 정상 형식 오류 XML의 "0건" 위장 방지
    if (params.type === "XML" && params.expectedRoot) {
      this.assertXmlRoot(text, [params.expectedRoot], `fetchApi(${params.target})`)
    }
    // JSON도 같은 가드가 필요하다 — 법제처는 조회 실패 시 빈 본문이 아니라
    // 루트 키가 다른 짧은 JSON(예: {"Law":{...}} 42바이트)을 200으로 돌려준다.
    // 이걸 그대로 파싱하면 `?.법령`이 undefined가 되어 "조문 없음(✗)"으로 위장된다
    // (Opus B-1: basis_date를 준 fin_verify가 모든 인용을 ✗로 판정하던 원인)
    if (params.type === "JSON" && params.expectedJsonKey) {
      this.assertJsonKey(text, params.expectedJsonKey, `fetchApi(${params.target})`)
    }

    return text
  }

  /**
   * 법령 변경이력 목록 조회
   */
  async getLawHistory(params: {
    regDt: string
    org?: string
    display?: number
    page?: number
    apiKey?: string
  }): Promise<string> {
    const apiParams = new URLSearchParams({
      target: "lsHstInf",
      OC: this.getApiKey(params.apiKey),
      type: this.getResponseType(),
      regDt: params.regDt,
    })

    if (params.org) apiParams.append("org", params.org)
    if (params.display) apiParams.append("display", params.display.toString())
    if (params.page) apiParams.append("page", params.page.toString())

    const url = `${LAW_API_BASE}/lawSearch.do?${apiParams.toString()}`
    const response = await this.drfFetch(url)
    await this.throwIfError(response, "getLawHistory")

    return await response.text()
  }
}
