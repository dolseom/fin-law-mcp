/**
 * 공용 법령 검색 유틸 — chains / verify_citations 등에서 공유.
 *
 * 핵심: 법제처 lawSearch API는 부분 문자열 매칭 특성이 있어 "민법" → "난민법"
 * 같은 엉뚱한 매칭이 발생한다. scoreLawRelevance로 정확 매칭 우선 정렬하여
 * 첫 결과 신뢰 가능하게 만든다.
 */

import type { LawApiClient } from "./api-client.js"
import { lawCache, DEFAULT_LAW_CACHE_TTL_MS } from "./cache.js"
import { extractTag } from "./xml-parser.js"
import { normalizeLawSearchText, resolveLawAlias } from "./search-normalizer.js"

export interface LawInfo {
  lawName: string
  lawId: string
  mst: string
  lawType: string
  status?: string        // 현행연혁코드: "현행" | "연혁"(폐지·과거본). eflaw 검색 시에만 채워짐
  effectiveDate?: string // 시행일자 (YYYYMMDD)
}

// 법령명 구분점(가운뎃점) 표기 흔들림. 법제처 공식 법령명은 **한글 가운뎃점 'ㆍ'(U+318D)**
// 를 쓰지만("식품 등의 표시ㆍ광고에 관한 법률"), 실무 문서·판결문·LLM 출력은 라틴 중점
// '·'(U+00B7)를 쓰는 것이 보통이고 '‧'(U+2027)·'•'(U+2022)·'・'(U+30FB)도 섞인다.
// 표기만 다른 같은 법을 불일치로 판정하면 verify_citations는 조문 검증에 진입조차 못 하고
// (⚠ 부분매칭), applicable_law·impact_map은 resolvedLawMatches 가드에서 NOT_FOUND가 된다.
/** 법령명에 쓰이는 가운뎃점 변형 전체. 법령명 추출 정규식(verify-citations)과
 *  정규화(아래 INTERPUNCT_RE)가 같은 집합을 봐야 한다 — 어긋나면 추출 단계에서
 *  법령명이 절단돼 정규화가 손쓸 기회조차 없어진다. */
export const INTERPUNCT_CHARS = "·ㆍ‧•・"
const INTERPUNCT_RE = new RegExp(`[${INTERPUNCT_CHARS}]`, "g")

// 후보 법령명과 법제처 공식 법령명의 느슨한 일치 — 공백·가운뎃점 무시 + 접두/약칭 허용.
// findLaws가 관련도 정렬은 해도 매칭이 전혀 다른 법령일 수 있어 최종 방어선으로 사용.
// (verify-citations에서 쓰던 것을 lib로 승격 — applicable_law/impact_map 가드 공용)
/**
 * 세 번째 절("질의가 정식명으로 시작하면 일치")의 꼬리 거부 조건.
 *
 * 접두 일치만으로 받으면 **앞 인용을 흡수해 오염된 이름이 그 앞 법령으로 확정되고,
 * 뒤 인용의 조문 번호가 앞 법령에 붙어 확신형 ✓가 나간다** (퍼즈 차단, 실 API 실측:
 * "소득세법 시행령 제12조의2와 국세청 조사사무처리규정" → 「소득세법」 제41조 ✓).
 * 남은 꼬리에 조문 토큰이나 **또 다른** 법령·행정규칙 접미사가 있으면 그건 표기 흔들림이
 * 아니라 다른 문서를 가리키는 조각이 붙은 것이므로 거부한다.
 *
 * 정상 인용에서 이 꼬리는 비어 있거나 표기 흔들림뿐이다 — 종류 접미사(시행령·시행규칙)는
 * 애초에 lawTierOf가 따로 보고 걸러 주므로 여기까지 오지 않는다.
 */
const LOOSE_TAIL_REJECT_RE = /제\d+조(?:의\d+)?|법률|법|령|규칙|규정|고시|훈령|예규|지침/

export function looseMatchLawName(target: string, official: string): boolean {
  const normalize = (s: string) => s.replace(/\s+/g, "").replace(INTERPUNCT_RE, "")
  const targetNorm = normalize(target)
  const officialNorm = normalize(official)
  if (officialNorm === targetNorm) return true
  if (officialNorm.startsWith(targetNorm)) return true
  const officialPrefix = officialNorm.replace(/(법률|법)$/, "법")
  if (!targetNorm.startsWith(officialPrefix)) return false
  return !LOOSE_TAIL_REJECT_RE.test(targetNorm.slice(officialPrefix.length))
}

/** 법령 종류(본법/시행령/시행규칙) — 이름 끝 접미사로 판별 */
export type LawTier = "본법" | "시행령" | "시행규칙"
export function lawTierOf(name: string): LawTier {
  const n = name.replace(/\s+/g, "")
  if (n.endsWith("시행규칙")) return "시행규칙"
  if (n.endsWith("시행령")) return "시행령"
  return "본법"
}

/**
 * findLaws 결과 1위가 요청한 법령명과 실제로 관련 있는지 최종 확인.
 * 법제처 LIKE 검색은 관련 법령이 하나도 없어도 부분매칭 목록을 돌려주므로,
 * laws[0]을 맹신하면 「상법」 요청에 무관한 법의 분석을 확신형으로 내보내게 된다.
 * 별칭 입력("화관법"→화학물질관리법)은 canonical 해소 후에도 대조한다.
 *
 * 종류(본법/시행령/시행규칙)가 다르면 불일치 — looseMatch의 접두 허용 때문에
 * "법인세법 시행령" 요청이 본법 「법인세법」과 매칭되어 본법 MST로 조문을 검증하고
 * ✓와 본법 URL을 내보내던 결함 방지 (Opus I1). 별칭이 종류를 바꾸는 케이스
 * ("관시령"→관세법 시행령)가 있어 tier 비교는 canonical 해소 후 경로별로 한다.
 */
export function resolvedLawMatches(requested: string, officialName: string): boolean {
  const officialTier = lawTierOf(officialName)
  if (lawTierOf(requested) === officialTier && looseMatchLawName(requested, officialName)) return true
  const canonical = resolveLawAlias(normalizeLawSearchText(requested)).canonical
  if (canonical !== requested && lawTierOf(canonical) === officialTier && looseMatchLawName(canonical, officialName)) {
    return true
  }
  // 약칭 + 종류 접미사("부가세법 시행령")는 resolveLawAlias가 전체 문자열 키로만
  // 조회해 해소되지 않는다 — 접미사를 떼어 본체만 canonical로 바꾼 뒤 재결합한다
  // (I1의 tier 필터는 정상인데 별칭 경로가 못 따라오던 문제, Opus I-b)
  const m = requested.match(/^(.*?)\s*(시행령|시행규칙)$/)
  if (m) {
    const bodyCanonical = resolveLawAlias(normalizeLawSearchText(m[1])).canonical
    if (bodyCanonical !== m[1]) {
      const recombined = `${bodyCanonical} ${m[2]}`
      return lawTierOf(recombined) === officialTier && looseMatchLawName(recombined, officialName)
    }
  }
  return false
}

/**
 * 같은 법령 패밀리(본법·시행령·시행규칙)인지 — 종류는 무시하고 본법명만 대조.
 * 별표 소속 대조처럼 "유사 법령 혼입은 막되 하위법령은 통과"가 필요한 곳에서 쓴다
 * (기준내용연수표는 법인세법 '시행규칙' 별표지만 본법 조회의 별표 섹션에 나와야 한다).
 */
export function sameLawFamily(a: string, b: string): boolean {
  const baseOf = (s: string) => s.replace(/\s*시행(?:령|규칙)\s*$/, "")
  return resolvedLawMatches(baseOf(a), baseOf(b))
}

/**
 * 법령명이 아닌 부가 키워드 제거 (법제처 lawSearch API는 법령명 검색이므로).
 *
 * ⚠ "시행령"·"시행규칙"은 여기 넣지 않는다 — 이들은 부가 키워드가 아니라 **법령 종류**다.
 * 제거하면 "법인세법 시행령" 검색이 "법인세법"으로 축약돼 본법이 상위에 오고,
 * resolvedLawMatches의 종류 일치 필터(I1)가 검색 경로에서 무력해진다 (Codex 리뷰 중요 3).
 */
export const NON_LAW_NAME_RE = /\s*(과태료|절차|비용|처벌|기준|허가|신청|부과|근거|위반|방법|요건|조건|처분|수수료|신고|등록|면허|인가|승인|취소|정지|벌칙|벌금|과징금|이행강제금|시정명령|체계|구조|3단|판례|해석|개정|별표|서식|수입|수출|통관|반환|납부|감면|면제|제한|금지|의무|권리|자격|종류|기간|대상|범위|적용|감경|영향도|영향|분석|위임입법|위임|현황|미이행|미제정|시계열|타임라인|변화|처리|민원|매뉴얼|업무|담당|적합성|상위법|저촉|검증|파급|연쇄|불복|소송|쟁송|FTA|원산지|HS코드|품목분류|관세사)\s*/g

export function stripNonLawKeywords(query: string): string {
  return query.replace(NON_LAW_NAME_RE, " ").replace(/\s+/g, " ").trim()
}

/** XML에서 법령 정보 파싱 */
export function parseLawXml(xmlText: string, max: number): LawInfo[] {
  const lawRegex = /<law[^>]*>([\s\S]*?)<\/law>/g
  const results: LawInfo[] = []
  let match
  while ((match = lawRegex.exec(xmlText)) !== null && results.length < max) {
    const content = match[1]
    const lawName = extractTag(content, "법령명한글")
    if (!lawName) continue
    results.push({
      lawName,
      lawId: extractTag(content, "법령ID"),
      mst: extractTag(content, "법령일련번호"),
      lawType: extractTag(content, "법령구분명"),
      status: extractTag(content, "현행연혁코드") || undefined,
      effectiveDate: extractTag(content, "시행일자") || undefined,
    })
  }
  return results
}

/** 쿼리 대비 법령명 관련도 점수 (높을수록 관련) */
export function scoreLawRelevance(lawName: string, query: string, queryWords: string[]): number {
  let score = 0
  // 정확 매칭: 쿼리가 법령명을 포함
  if (query.includes(lawName)) score += 100
  // 법령명이 쿼리를 포함
  if (lawName.includes(query.replace(/\s+/g, ""))) score += 80
  // 단어 매칭
  for (const w of queryWords) {
    if (lawName.includes(w)) score += 10
  }
  // 법률 > 시행령 > 시행규칙 우선순위
  if (!/시행령|시행규칙/.test(lawName)) score += 5
  return score
}

/**
 * 법령 검색 + 관련도 정렬 + 캐싱.
 * 1차: 원본 쿼리 → 2차: 부가키워드 제거 → 3차: 법령명 패턴 직접 추출
 * 이후 scoreLawRelevance로 정렬.
 *
 * @param searchDisplay 법제처 API display 파라미터. 기본 100(API 상한) —
 *                      법제처는 LIKE 부분검색+가나다순이라 짧은 법령명("상법"은 100개 중 34번째)은
 *                      조회량이 작으면 아예 도착하지 못해 관련도 정렬이 입력 자체를 받지 못한다.
 *                      (종전 기본 20은 applicable_law가 「상법」 대신 무관한 법을 잡는 원인이었음.
 *                      요청 비용은 20이든 100이든 동일 1회.)
 */
export async function findLaws(
  apiClient: LawApiClient,
  query: string,
  apiKey?: string,
  max = 3,
  searchDisplay = 100,
  signal?: AbortSignal
): Promise<LawInfo[]> {
  const cacheKey = `law-search:${query}:${max}:${searchDisplay}`
  const cached = lawCache.get<LawInfo[]>(cacheKey)
  if (cached) return cached.slice(0, max)

  const effectiveMax = Math.max(max, searchDisplay)  // 정렬 대상 전체 수집

  // 인프라 에러(타임아웃·5xx·파싱 실패)는 "법령 없음"과 구분해야 한다.
  // 삼키면 법제처 장애 중 verify_citations가 실존 조문을 NOT_FOUND로 오판한다.
  let lastInfraError: unknown
  const trySearch = async (q: string): Promise<LawInfo[]> => {
    try {
      const xmlText = await apiClient.searchLaw(q, apiKey, searchDisplay, "law", signal)
      return parseLawXml(xmlText, effectiveMax)
    } catch (e) {
      // 취소는 사다리를 계속 돌 이유가 없다 — 즉시 전파 (Codex 상세 리뷰: 취소 미전파)
      if (e instanceof Error && /취소됨/.test(e.message)) throw e
      if (e instanceof Error && /429|401|403|API 키/.test(e.message)) throw e
      lastInfraError = e
      return []
    }
  }

  // 1차: 원본 쿼리
  let results: LawInfo[] = await trySearch(query)

  // 1.5차: 약칭+종류 접미사("근퇴법 시행령") — searchLaw의 별칭 해소는 전체 문자열
  // 키로만 조회해 이 형태를 못 푼다. 본체만 canonical로 바꿔 재결합해 한 번 더
  // (resolvedLawMatches의 I-b 로직을 검색 경로에도 적용. 접미사 없는 약칭은
  //  searchLaw가 이미 canonical로 바꿔 던지므로 여기서 또 할 필요 없다)
  if (results.length === 0) {
    const m = normalizeLawSearchText(query).match(/^(.*?)\s*(시행령|시행규칙)$/)
    if (m) {
      const bodyCanonical = resolveLawAlias(m[1]).canonical
      if (bodyCanonical !== m[1]) {
        results = await trySearch(`${bodyCanonical} ${m[2]}`)
      }
    }
  }

  // 2차: 부가 키워드 제거
  if (results.length === 0) {
    const stripped = stripNonLawKeywords(query)
    if (stripped && stripped !== query) {
      results = await trySearch(stripped)
    }
  }

  // 3차: 법령명 패턴 직접 추출
  if (results.length === 0) {
    const lawNameMatch = query.match(/[가-힣]+(법|시행령|시행규칙|규칙|규정|령)(?:\s|$)/)
    if (lawNameMatch) {
      results = await trySearch(lawNameMatch[0].trim())
    }
  }

  // 전 단계가 인프라 에러로만 끝났으면 "없음"이 아니라 "실패"로 전파
  if (results.length === 0 && lastInfraError !== undefined) {
    throw lastInfraError instanceof Error
      ? new Error(`법령 검색 실패 (법제처 API 오류 — 법령이 없다는 뜻이 아님): ${lastInfraError.message}`)
      : lastInfraError
  }

  // 관련도 정렬
  if (results.length > 1) {
    const queryWords = query.replace(NON_LAW_NAME_RE, " ")
      .trim().split(/\s+/).filter(w => w.length > 0)
    results.sort((a, b) => {
      const scoreA = scoreLawRelevance(a.lawName, query, queryWords)
      const scoreB = scoreLawRelevance(b.lawName, query, queryWords)
      return scoreB - scoreA
    })
  }

  // max만큼만 반환
  const final = results.slice(0, max)
  // 0건은 담지 않는다(네거티브 캐시 금지). 그리고 **부분 실패도 담지 않는다**:
  // 사다리 앞 단계가 인프라 오류로 죽고 뒤 단계(부가키워드 제거·패턴 추출)가 답을 냈다면
  // 그 답은 원본 쿼리의 정답이 아니라 **폴백의 답**이다. 담으면 법제처 일시 장애가
  // 만든 차선책이 TTL 동안 고정되고, 장애가 걷혀도 원본 쿼리를 다시 타지 않는다
  // (Codex 7차 "오류 응답이 캐시되어 0건으로 고정"과 같은 부류)
  if (final.length > 0 && lastInfraError === undefined) {
    lawCache.set(cacheKey, final, DEFAULT_LAW_CACHE_TTL_MS)
  }

  return final
}

/**
 * eflaw 검색 결과(연혁 포함)에서 질의명과 일치하는 '폐지(연혁)' 법령의 최신본을 고른다.
 *
 * 순수 함수(테스트 용이) — findRepealedLaw가 네트워크 후 이 로직으로 판정.
 * 현행(target=law)에서 못 찾은 인용이 '지어낸 법령'인지 '폐지된 법령'인지 가른다.
 * 매칭은 공백무시 완전일치 또는 접두(약칭)만 허용해 엉뚱한 법령 흡수를 막는다.
 */
export function pickRepealed(rows: LawInfo[], query: string): LawInfo | undefined {
  const norm = (s: string) => s.replace(/\s+/g, "")
  const q = norm(query)
  return rows
    .filter((r) => r.status === "연혁"
      && (norm(r.lawName) === q || norm(r.lawName).startsWith(q)))
    .sort((a, b) => {
      // 완전 일치 우선 — 접두 허용만으로 정렬하면 본법 질의에 하위법령
      // ("…법" 질의 → "…법시행규칙")이 최신 시행일로 이겨버린다 (실측)
      const exactA = norm(a.lawName) === q ? 1 : 0
      const exactB = norm(b.lawName) === q ? 1 : 0
      if (exactA !== exactB) return exactB - exactA
      return (b.effectiveDate || "").localeCompare(a.effectiveDate || "")
    })[0]
}

/** findRepealedLaw가 받는 eflaw 검색 한 페이지의 건수 */
const REPEALED_PAGE_SIZE = 30

/**
 * 검색 응답의 totalCnt — 태그가 없거나 숫자가 아니면 undefined (0으로 지어내면 "전부 받음"으로 오판).
 * tools/ruling-search.ts readTotalCnt와 같은 규칙 (lib→tools 역방향 import를 피해 인라인)
 */
function readSearchTotalCnt(xml: string): number | undefined {
  const raw = extractTag(xml, "totalCnt").trim()
  if (!/^\d+$/.test(raw)) return undefined
  const n = Number(raw)
  return Number.isSafeInteger(n) ? n : undefined
}

/** 폐지(연혁) 법령 조회 결과 */
interface RepealedLawLookup {
  law?: LawInfo
  lookupFailed?: boolean
  reason?: string
  /**
   * 받은 목록이 검색 결과 전부인가 (정상 조회 때만 채움). false면 law.effectiveDate는
   * **받은 목록 안의** 가장 늦은 시행일일 뿐이다 — 목록 밖에 더 늦은 시행본이 있을 수 있고,
   * law가 없어도 "연혁에 없음"이 입증된 것이 아니다 (외부 검토 B5·Fable 최종 검토 F3과 같은 전제)
   */
  listComplete?: boolean
  /** 응답 totalCnt — 확인된 값만 (태그 없음·비숫자·받은 건수보다 작은 모순 응답이면 undefined) */
  listTotal?: number
  /** 받은 <law> 행 수 (질의명 필터 전) */
  listReceived?: number
}

/**
 * 폐지(연혁) 법령 조회 — target=eflaw로 과거·폐지본을 검색해 최신 연혁본을 반환.
 * 현행 검색이 0건일 때만 보조로 호출(환각 vs 폐지 구분용).
 *
 * ⚠ 조회 **실패**와 **0건**을 구분해 돌린다: 실패를 undefined로 뭉개면 호출측이
 * "현행·연혁 모두 0건 (정상 조회)"이라고 적고 ✗(환각 의심)를 찍는다 — 실제로는
 * 확인하지 못한 것이라, 존재하는 구법이 환각으로 판정된다 (Codex 2차 중요)
 *
 * ⚠ 요청은 1회(display 30)다. 검색 결과가 그보다 많으면 받은 목록의 최대 시행일을 "마지막 시행"이라
 * 부를 수 없다 — listComplete로 호출측이 표기를 "받은 목록 안"으로 한정하게 한다. 페이지를 더
 * 넘기지 않는 이유: 호출측(verify·article)에서 이것은 현행 0건일 때의 보조 확인이고, 연혁 법령의
 * 기준일 시행본은 article이 resolveVersionAt으로 따로 확정한다 — 추가 요청은 분당 30회 한도만 먹는다
 */
export async function findRepealedLaw(
  apiClient: LawApiClient,
  query: string,
  apiKey?: string,
  signal?: AbortSignal
): Promise<RepealedLawLookup> {
  let xmlText: string
  try {
    xmlText = await apiClient.searchLaw(query, apiKey, REPEALED_PAGE_SIZE, "eflaw", signal)
  } catch (e) {
    return { lookupFailed: true, reason: e instanceof Error ? e.message : String(e) }
  }
  const received = (xmlText.match(/<law[^>]*>[\s\S]*?<\/law>/g) ?? []).length
  const rawTotal = readSearchTotalCnt(xmlText)
  // totalCnt가 받은 수보다 작으면 모순 응답이라 총건수로 쓰지 않는다 (historical-utils collectRange와 같은 규칙)
  const listTotal = rawTotal !== undefined && rawTotal >= received ? rawTotal : undefined
  // 총건수를 못 읽었으면 페이지가 덜 찼을 때만 "전부 받음"으로 본다
  const listComplete = listTotal !== undefined ? received >= listTotal : received < REPEALED_PAGE_SIZE
  return { law: pickRepealed(parseLawXml(xmlText, 100), query), listComplete, listTotal, listReceived: received }
}
