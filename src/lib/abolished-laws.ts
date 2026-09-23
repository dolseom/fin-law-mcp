/**
 * 폐지 법령·행정규칙 감지 — search_law / search_admin_rule 보조.
 *
 * 폐지된 법령은 현행(target=law) 검색에, 폐지된 행정규칙은 admrul 기본(nw=1)
 * 검색에 잡히지 않아 LLM이 "존재하지 않는 규정"으로 오판한다
 * (「월별납부제도 운영에 관한 고시」 사례 — 2024-12-11 폐지,
 * 「징수업무 처리에 관한 고시」로 통·폐합됐는데 "검색 결과 없음"으로 안내).
 * 법령은 eflaw(연혁 포함), 행정규칙은 nw=2 보조검색으로 폐지 이력을 찾아
 * 폐지 사실·폐지사유·후속(통합) 규정으로 안내한다.
 */

import type { LawApiClient } from "./api-client.js"
import { lawCache, DEFAULT_LAW_CACHE_TTL_MS } from "./cache.js"
import { extractTag } from "./xml-parser.js"
import { normalizeAliasKey } from "./search-normalizer.js"

const fmtDate = (d: string) => (d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : d)

/** 법제처 LIKE 검색이 무관 목록을 반환할 때가 있어 이름-쿼리 포함관계로 걸러낸다 */
function isRelated(name: string, query: string): boolean {
  const nk = normalizeAliasKey(name)
  const qk = normalizeAliasKey(query)
  if (!nk || !qk) return false
  return nk.includes(qk) || qk.includes(nk)
}

// ========== 법령 (target=eflaw) ==========

export interface AbolishedLaw {
  name: string
  lawId: string
  mst: string
  effDate: string // 폐지 시행일자
  revisionType: string // "폐지" | "타법폐지"
  lawType: string
}

/** eflaw 검색 XML에서 법령ID별 최신 이력을 골라 폐지 확정된 것만 추출 */
export function parseAbolishedLawsXml(xmlText: string, query: string): AbolishedLaw[] {
  interface Rec { name: string; lawId: string; mst: string; effDate: string; revisionType: string; lawType: string }
  const latestById = new Map<string, Rec>()
  const lawRegex = /<law[^>]*>([\s\S]*?)<\/law>/g
  let m
  while ((m = lawRegex.exec(xmlText)) !== null) {
    const c = m[1]
    const lawId = extractTag(c, "법령ID")
    if (!lawId) continue
    const rec: Rec = {
      name: extractTag(c, "법령명한글"),
      lawId,
      mst: extractTag(c, "법령일련번호"),
      effDate: extractTag(c, "시행일자"),
      revisionType: extractTag(c, "제개정구분명"),
      lawType: extractTag(c, "법령구분명"),
    }
    const prev = latestById.get(lawId)
    if (!prev || rec.effDate > prev.effDate) latestById.set(lawId, rec)
  }
  // 최신 이력이 폐지·타법폐지인 법령만 — 현행이 살아있는 법령은 여기서 자연 탈락
  return [...latestById.values()]
    .filter((r) => (r.revisionType === "폐지" || r.revisionType === "타법폐지") && isRelated(r.name, query))
    .sort((a, b) => (a.name < b.name ? -1 : 1))
}

/**
 * 폐지 법령 조회 — 보조 정보이므로 실패는 전파하지 않고 빈 배열.
 *
 * ⚠ 이 함수를 **판정**(환각 여부·부존재 단정)에 쓰면 안 된다 — 실패가 빈 배열로 위장돼
 * "폐지 이력 없음"과 구분되지 않는다 (Codex 4차 개선 지적. 현재 활성 소비자 없음 —
 * 배선하려면 lookupFailed를 구분하는 findRepealedLaw를 쓸 것). 안내문 동봉 같은
 * 보조 용도 전용이다.
 */
export async function findAbolishedLaws(
  apiClient: LawApiClient,
  query: string,
  apiKey?: string
): Promise<AbolishedLaw[]> {
  // 명칭 끝 괄호(발령일·개정 부연)는 떼고 조회한다 — 붙인 채면 eflaw도 항상 0건이다.
  // tools/admin-rule-citation.ts의 stripTrailingParen과 같은 규칙 (lib→tools 순환 방지 인라인)
  const lookup = query.replace(/\s*[([［【][^)\]］】]{0,60}[)\]］】]\s*$/, "").trim() || query.trim()
  const cacheKey = `abolished-law:${lookup.toLowerCase()}`
  const cached = lawCache.get<AbolishedLaw[]>(cacheKey)
  if (cached) return cached
  try {
    const xml = await apiClient.searchLaw(lookup, apiKey, 50, "eflaw")
    const parsed = parseAbolishedLawsXml(xml, lookup)
    // 정상 조회 후의 결과만 담는다 — 실패는 catch로 빠지므로 여기 도달하지 않는다
    lawCache.set(cacheKey, parsed, DEFAULT_LAW_CACHE_TTL_MS)
    return parsed
  } catch {
    return []
  }
}

// ========== 행정규칙 (target=admrul, nw=2) ==========

interface AdmRuleHistoryHit {
  name: string
  seq: string // 행정규칙일련번호 (본문 조회 ID)
  ruleId: string // 행정규칙ID — 개명을 넘어 유지되는 그룹핑 키
  promDate: string // 발령일자
  revisionType: string // 제개정구분명
  statusCode: string // 현행연혁구분
  ruleType: string
  orgName: string
}

export function parseAdmrulHistoryXml(xmlText: string): AdmRuleHistoryHit[] {
  const out: AdmRuleHistoryHit[] = []
  const regex = /<admrul[^>]*>([\s\S]*?)<\/admrul>/g
  let m
  while ((m = regex.exec(xmlText)) !== null) {
    const c = m[1]
    out.push({
      name: extractTag(c, "행정규칙명"),
      seq: extractTag(c, "행정규칙일련번호"),
      ruleId: extractTag(c, "행정규칙ID"),
      promDate: extractTag(c, "발령일자"),
      revisionType: extractTag(c, "제개정구분명"),
      statusCode: extractTag(c, "현행연혁구분"),
      ruleType: extractTag(c, "행정규칙종류"),
      orgName: extractTag(c, "소관부처명"),
    })
  }
  return out
}

/** 폐지 레코드 본문 XML에서 제개정이유(폐지사유) 추출 */
export function extractAbolitionReason(xmlText: string): string {
  const block = xmlText.match(/<제개정이유>([\s\S]*?)<\/제개정이유>/)?.[1] || ""
  const cdata = [...block.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)].map((m) => m[1].trimEnd())
  const text = cdata.filter((l) => l.trim().length > 0).join("\n").trim()
  return text.length > 700 ? text.slice(0, 700) + "…" : text
}

/**
 * 폐지사유 문장에서 후속(통합) 규정명 추출.
 * "…을 「징수업무 처리에 관한 고시」로 통ㆍ폐합하여…" 패턴 — 통합·이관·흡수·대체 앞의 「」명.
 */
export function extractSuccessorNames(reason: string, excludeNames: string[]): string[] {
  const exclude = new Set(excludeNames.map(normalizeAliasKey))
  const out: string[] = []
  const regex = /「([^」]{2,60})」\s*(?:으로|로|에)\s*(?:통\s*[ㆍ·]?\s*폐합|통합|이관|흡수|대체)/g
  let m
  while ((m = regex.exec(reason)) !== null) {
    const name = m[1].trim()
    if (exclude.has(normalizeAliasKey(name))) continue
    if (!out.includes(name)) out.push(name)
  }
  return out
}

/**
 * 현행 0건인 행정규칙 쿼리에서 폐지·제명변경 이력을 찾아 안내문 생성.
 * 해당 없으면 null (상위에서 기존 noResultHint로 폴백).
 */
export async function detectAbolishedAdminRule(
  apiClient: LawApiClient,
  query: string,
  apiKey?: string,
  // verify의 20초 상한 전파 — 없으면 상한 이후에도 연혁 조회가 계속되고,
  // 그 결과로 strict 접미사 규칙이 뒤늦게 ✗ 판정을 받는다 (Codex 3차 중요)
  signal?: AbortSignal
): Promise<string | null> {
  const cacheKey = `abolished-admrul:${query.toLowerCase().trim()}`
  const cached = lawCache.get<string>(cacheKey)
  if (cached !== null) return cached || null // "" = 해당없음 네거티브 캐시
  if (signal?.aborted) {
    throw new Error("요청 취소됨(도구 deadline) — 행정규칙 연혁 확인 전에 시간 상한 도달")
  }
  let result: string | null = null
  // 폐지사유 본문 조회가 실패하면 안내문이 '반쪽'(폐지사유·후속 규정 없음)으로 나온다.
  // 그 반쪽을 캐시하면 장애가 걷힌 뒤에도 TTL 동안 후속 규정 없이 답하게 된다 —
  // 아래에서 캐시를 건너뛴다
  let partial = false
  try {
    const xml = await apiClient.searchAdminRule({ query, nw: "2", apiKey, signal })
    const hits = parseAdmrulHistoryXml(xml)

    // 행정규칙ID로 그룹핑 (개명을 넘어 동일 규칙 추적), 발령일자 오름차순
    const groups = new Map<string, AdmRuleHistoryHit[]>()
    for (const h of hits) {
      const key = h.ruleId || normalizeAliasKey(h.name)
      if (!key) continue
      const g = groups.get(key) || []
      g.push(h)
      groups.set(key, g)
    }

    for (const g of groups.values()) {
      g.sort((a, b) => (a.promDate < b.promDate ? -1 : 1))
      const latest = g[g.length - 1]
      // 쿼리 연관성: 과거 명칭 포함 어느 버전이든 일치하면 같은 규칙으로 본다
      if (!g.some((h) => isRelated(h.name, query))) continue

      if (latest.revisionType === "폐지") {
        const built = await buildAbolishedAdminRuleNote(apiClient, query, g, apiKey, signal)
        result = built.note
        partial = built.bodyLookupFailed
        break
      }
      // 현행이 살아있는데 현행 검색이 0건이었다면 제명변경(구명칭 검색) 케이스
      if (latest.statusCode === "현행" && !isRelated(latest.name, query)) {
        result =
          `[제명변경] '${query}' — 현행 행정규칙 0건. 같은 규칙이 명칭 변경되어 현행입니다:\n\n` +
          `「${g.find((h) => isRelated(h.name, query))?.name || query}」 → 「${latest.name}」 (${latest.ruleType}, ${latest.orgName}, 발령 ${fmtDate(latest.promDate)})\n\n` +
          `💡 현행 명칭 「${latest.name}」(행정규칙일련번호 ${latest.seq})으로 다시 조회하세요.\n`
        break
      }
    }
  } catch (e) {
    // 연혁 조회 **실패**를 null로 돌리면 호출측이 "폐지 이력도 없음"으로 읽고
    // ✗ NOT_FOUND를 찍는다 — 폐지된 실존 규칙이 환각으로 판정된다 (Codex 2차 중요).
    // 실패는 캐시하지 않는다 (일시 장애를 한 시간 동안 굳히지 않기 위해)
    throw new Error(`행정규칙 연혁 조회 실패: ${e instanceof Error ? e.message : String(e)}`)
  }
  // 정상 조회 후의 결과만 담는다 — "해당없음"("")은 담고, 반쪽 안내문은 담지 않는다.
  // "정상 조회 후 0건"과 "조회 실패"의 구분이 이 저장소의 제1원칙이다
  if (!partial) lawCache.set(cacheKey, result || "", DEFAULT_LAW_CACHE_TTL_MS)
  return result
}

async function buildAbolishedAdminRuleNote(
  apiClient: LawApiClient,
  query: string,
  history: AdmRuleHistoryHit[],
  apiKey?: string,
  // 상위(detectAbolishedAdminRule)가 받은 deadline signal을 본문 조회까지 잇는다 —
  // 연혁 검색에만 걸고 여기서 끊기면 상한 이후에도 수백 KB 본문 조회가 살아 쿼터를 쓴다
  signal?: AbortSignal
): Promise<{ note: string; bodyLookupFailed: boolean }> {
  const latest = history[history.length - 1] // 폐지 레코드
  const prev = history.length >= 2 ? history[history.length - 2] : null

  const lines = [
    `[폐지] '${query}' — 현행 행정규칙 0건. 폐지된 행정규칙입니다:`,
    "",
    `「${latest.name}」 (${latest.ruleType}, ${latest.orgName}) — ${fmtDate(latest.promDate)} 폐지`,
  ]
  if (prev) {
    lines.push(`   - 폐지 직전 버전: 행정규칙일련번호 ${prev.seq} (발령 ${fmtDate(prev.promDate)}) — 폐지 전 본문은 이 일련번호로 국가법령정보센터에서 확인`)
  }

  // 폐지 레코드 본문에서 폐지사유·후속 규정 추출 (실패해도 폐지 안내 자체는 유지).
  // ⚠ 조회 실패와 "조회했으나 후속 규정이 없음"을 같은 문장으로 쓰면 안 된다 —
  // 전자는 아직 모르는 것이고 후자는 확인된 것이다 (3값 판정).
  // deadline 취소도 이 catch로 들어와 bodyLookupFailed가 된다 — 폐지 사실(검색으로 확인)은
  // 남기고 "후속 규정 없음"으로는 말하지 않으며, 반쪽 안내문이라 캐시도 하지 않는다
  let successors: string[] = []
  let bodyLookupFailed = false
  try {
    const bodyXml = await apiClient.getAdminRule(latest.seq, apiKey, signal)
    const reason = extractAbolitionReason(bodyXml)
    if (reason) {
      lines.push("", "폐지사유(제개정이유):", ...reason.split("\n").map((l) => `   ${l}`))
      successors = extractSuccessorNames(reason, history.map((h) => h.name))
    }
  } catch {
    bodyLookupFailed = true
  }

  lines.push("")
  if (successors.length > 0) {
    lines.push(`💡 후속(통합) 규정: ${successors.map((s) => `「${s}」`).join(", ")} — 「${successors[0]}」 현행본을 조회해 그 기준으로 답변하세요.`)
  } else if (bodyLookupFailed) {
    lines.push(`⚠️ 폐지사유 본문 조회에 **실패**했습니다 — 후속 규정이 없다는 뜻이 아닙니다. 행정규칙일련번호 ${latest.seq}로 국가법령정보센터에서 직접 확인하거나 잠시 후 재시도하세요.`)
  } else {
    lines.push(`💡 후속 규정 자동 추출 실패 — 위 폐지사유를 근거로 후속·통합 규정을 확인하거나, 소관부처(${latest.orgName})의 제도 키워드로 행정규칙을 재검색하세요.`)
  }
  lines.push("⚠️ 폐지된 행정규칙을 현행 기준으로 인용하지 마세요. 답변에는 폐지 사실과 후속 규정을 명시하세요.")
  return { note: lines.join("\n") + "\n", bodyLookupFailed }
}
