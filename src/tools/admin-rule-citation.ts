// 자체 패치 #4 — verify_citations 행정규칙 인용 검증 (docs/SELF-PATCHES.md)
//
// 배경: verify_citations의 법령명 접미사 화이트리스트가 법령 7종뿐이라
// 「식품등의 표시기준」 제N조 같은 고시·행정규칙 인용은 추출조차 안 되어
// 검증을 조용히 건너뛰었다. 세무 맥락에서 고시·통칙 인용은 빈번하다.
//
// 동작: 행정규칙 접미사(고시·훈령·예규·통칙·기준·지침)로 끝나는 인용은
// 법령 검색 대신 행정규칙 API(target=admrul)로 명칭 실존을 확인한다.
// 행정규칙 본문은 조문 단위 조회 API가 없어 **명칭 실존만** 검증한다(정직 표기).
// '기준'·'지침'은 일반 명사와 겹칠 수 있어 미발견 시 ✗ 대신 ⚠로 보고한다.
import { DOMParser } from "@xmldom/xmldom"
import type { LawApiClient } from "../lib/api-client.js"
import { looseMatchLawName } from "../lib/law-search.js"
import { detectAbolishedAdminRule } from "../lib/abolished-laws.js"
import { compactName } from "../lib/fin-common.js"

// 확실한 행정규칙 접미사 — 미발견 시 ✗(환각 의심)로 보고
const STRICT_ADMIN_SUFFIX = /(고시|훈령|예규|통칙)$/
// 일반 명사와 겹칠 수 있는 접미사 — 미발견 시 ⚠(재확인)로만 보고
const SOFT_ADMIN_SUFFIX = /(기준|지침)$/

export function isAdminRuleName(name: string): boolean {
  const trimmed = name.trim()
  return STRICT_ADMIN_SUFFIX.test(trimmed) || SOFT_ADMIN_SUFFIX.test(trimmed)
}

/**
 * 법령 DB(법률·시행령·부령)에 없어도 행정규칙으로 실존할 수 있는 이름인지.
 * isAdminRuleName(고시·훈령·예규·통칙·기준·지침)보다 넓게 「…규정」·「…규칙」을 포함한다
 * — 「외국환거래규정」(기재부 고시)·「조사사무처리규정」(국세청 훈령)이 이 형태다.
 * 「…시행규칙」은 부령이라 법령 DB 대상이므로 제외한다.
 */
export function isAdminRuleLikeName(name: string): boolean {
  const compact = compactName(name)
  if (/시행규칙$/.test(compact)) return false
  return /(규칙|규정)$/.test(compact) || isAdminRuleName(name)
}

/**
 * 행정규칙 명칭 끝의 **메타데이터 괄호**만 떼어낸다 — 발령일·연도·발령번호.
 * 「식품등의 표시기준(2024. 1. 15.)」의 괄호는 같은 규칙의 판(版) 표시라 비교에서
 * 빼야 하지만, 「A규정(제1권)」·「A규정(제2권)」처럼 **다른 규칙을 가르는 괄호**까지
 * 지우면 서로 다른 규칙이 같은 이름이 된다 (Codex 3차 중요). 날짜·발령번호 형태만 제거한다.
 *
 * 인용 추출(verify)과 검색 일치 판정이 같은 규칙을 써야 한다 — 한쪽만 고치면
 * 괄호가 붙은 인용이 추출조차 되지 않는다 (Codex 3차 차단).
 */
export function stripRuleNameMeta(name: string): string {
  const META_PAREN = new RegExp(
    "\\s*[([［【]\\s*(?:" +
      // ① 발령일·연도: (2024. 1. 15.)
      "\\d{4}[.\\s]*\\d{0,2}[.\\s]*\\d{0,2}[.\\s]*" +
      // ② 발령번호: (기재부 고시 제2026-1호) / (제2026-1호)
      "|[^)\\]］】]*(?:고시|훈령|예규|지침|규정)\\s*제?\\s*\\d[\\d\\-–—.]*\\s*호[^)\\]］】]*" +
      "|제?\\s*\\d[\\d\\-–—.]*\\s*호" +
      // ③ 소관·종류 부연: (기재부 고시) / (국세청 훈령) / (고시).
      //    숫자가 없어야 한다 — 숫자가 들어가면 판·편 구분일 수 있다
      "|[^)\\]］】\\d]*(?:고시|훈령|예규|지침|통칙)" +
      ")\\s*[)\\]］】]\\s*$"
  )
  return compactName(name.replace(META_PAREN, "").trim())
}

/**
 * 명칭 끝의 괄호를 **종류를 가리지 않고** 떼어낸다.
 *
 * 두 용도에만 쓴다:
 *   ① 접미사 검사 — 괄호가 붙으면 이름이 ')'로 끝나 고시·규정 화이트리스트를
 *      통과하지 못해 인용이 추출조차 되지 않는다 (Codex 3차 차단)
 *   ② 검색어 — 법제처는 LIKE 검색이라 괄호를 떼면 후보가 넓어질 뿐 좁아지지 않는다.
 *      괄호를 붙인 채로 조회하면 실존 고시가 0건 → ✗ 환각 낙인이 된다 (실측)
 *
 * **정확 일치 판정에는 쓰지 않는다.** 「A규정(제1권)」과 「A규정(제2권)」은 다른 규칙이라
 * 여기서 괄호를 지우면 서로를 정확 일치로 오판한다 (Codex 3차 중요) — 그쪽은
 * stripRuleNameMeta(날짜·발령번호만 제거)를 쓴다.
 */
export function stripTrailingParen(name: string): string {
  return name.replace(/\s*[([［【][^)\]］】]{0,60}[)\]］】]\s*$/, "").trim() || name.trim()
}

export interface AdminRuleMatch {
  name: string
  promDate?: string
  orgName?: string
  ruleType?: string
  /** 입력 명칭과 정확히 일치하는가. false면 접두 일치(더 긴 다른 규칙)라 단정 금지 */
  exact: boolean
}

/** 행정규칙 DB(admrul)에서 명칭 실존 확인 — verify 외에 law_search의 0건 폴백도 사용 */
export async function findAdminRule(
  apiClient: LawApiClient,
  name: string,
  apiKey?: string,
  signal?: AbortSignal
): Promise<AdminRuleMatch | null> {
  // display=100 (Opus 검토 권고 7): 법제처는 LIKE 부분검색+가나다순이라 정확한 규칙명이
  // 기본 20건 밖으로 밀릴 수 있다 — 법령 경로의 findLaws display=100과 같은 이유
  // 검색어에서는 괄호를 뗀다 — 「식품등의 표시기준(2024. 1. 15.)」을 그대로 조회하면
  // 실존 고시가 0건이 되어 ✗ 환각 낙인이 찍힌다 (실측). LIKE 검색이라 후보만 넓어진다
  const xml = await apiClient.searchAdminRule({
    query: stripTrailingParen(name),
    display: "100",
    apiKey,
    signal,
  })
  // 장애 응답 판별 (Codex 검토 차단 3): searchAdminRule은 searchLaw와 달리 HTML/빈 응답
  // 검사가 없어 200 상태의 장애 페이지가 "admrul 0건"으로 파싱된다 — 그대로 두면
  // '검증 불가'가 ✗ NOT_FOUND(환각 의심)로 오보되므로 throw로 ⚠ 경로에 태운다
  if (!xml || !xml.trim()) {
    throw new Error("법제처 API가 빈 응답을 반환했습니다 (일시 장애 가능) — 실존 여부 판정 불가")
  }
  // 대소문자 무시 (Codex 재검토 차단 2): <HTML>·<!DOCTYPE HTML> 변형도 장애 페이지다
  if (/<!doctype\s+html|<html[\s>]/i.test(xml)) {
    throw new Error("법제처 API가 HTML 오류 페이지를 반환했습니다 (일시 장애 가능) — 실존 여부 판정 불가")
  }
  const doc = new DOMParser().parseFromString(xml, "text/xml")
  // 기대 루트 검증: 정상 검색 응답의 루트는 AdmRulSearch (2026-08-19 실호출로 확인).
  // <error> 등 정상 형식의 오류 XML이 "0건"으로 읽히는 것을 막는다
  const rootName = doc?.documentElement?.nodeName
  if (!rootName) {
    throw new Error("법제처 API 응답 XML 파싱 실패 — 실존 여부 판정 불가")
  }
  if (rootName !== "AdmRulSearch") {
    throw new Error(`법제처 API가 예상 밖 응답(루트 ${rootName})을 반환했습니다 — 실존 여부 판정 불가`)
  }
  const rules = doc.getElementsByTagName("admrul")
  const limit = Math.min(rules.length, 100)
  // looseMatchLawName은 접두 일치를 허용한다 — 입력 「국세청 사무처리규정」에 대해
  // 「국세청 사무처리규정 시행세칙」만 있어도 "실존"이 되어 버린다. 행정규칙에는
  // 법령 쪽의 별칭 사전·tier 검사가 없어 오검증 위험이 더 크므로, 정확 일치를
  // 먼저 찾고 접두 일치는 exact=false로 구분해 돌린다 (Codex 리뷰 중요 3)
  const target = stripRuleNameMeta(name)
  let loose: AdminRuleMatch | null = null
  for (let i = 0; i < limit; i++) {
    const rule = rules[i]
    const ruleName = rule.getElementsByTagName("행정규칙명")[0]?.textContent?.trim() || ""
    // 후보 걸러내기도 괄호를 뗀 이름으로 — 붙인 채 비교하면 실존 규칙을 못 만난다.
    // (정확 일치 판정은 아래에서 stripRuleNameMeta로 따로 하므로 판(版) 구분은 유지된다)
    if (!ruleName || !looseMatchLawName(stripTrailingParen(name), ruleName)) continue
    const match: AdminRuleMatch = {
      name: ruleName,
      promDate: rule.getElementsByTagName("발령일자")[0]?.textContent?.trim() || undefined,
      orgName: rule.getElementsByTagName("소관부처명")[0]?.textContent?.trim() || undefined,
      ruleType: rule.getElementsByTagName("행정규칙종류")[0]?.textContent?.trim() || undefined,
      exact: stripRuleNameMeta(ruleName) === target,
    }
    if (match.exact) return match
    if (!loose) loose = match
  }
  return loose
}

/**
 * 후보들을 행정규칙 DB에서 찾아 실존이면 결과 문자열, 아니면 null.
 * 법령 검색 실패 후의 폴백 경로에서도 사용한다 (…규정/…규칙이 행정규칙인 경우).
 */
export async function tryVerifyAdminRuleCitation(
  apiClient: LawApiClient,
  candidates: string[],
  label: string,
  apiKey?: string,
  signal?: AbortSignal
): Promise<string | null> {
  for (const cand of candidates) {
    const match = await findAdminRule(apiClient, cand, apiKey, signal)
    if (match) {
      const meta = [match.ruleType, match.orgName, match.promDate ? `발령 ${match.promDate}` : undefined]
        .filter(Boolean)
        .join(" · ")
      // 접두 일치는 ✓가 아니다 — 인용한 이름의 규칙이 실존한다는 증거가 아니라
      // 이름이 그것으로 시작하는 **다른** 규칙이 있다는 뜻이다 (Codex 리뷰 중요 3)
      if (!match.exact) {
        return (
          `⚠ ${label} — 이 명칭과 정확히 일치하는 행정규칙은 찾지 못했고, ` +
          `이름이 겹치는 「${match.name}」${meta ? ` (${meta})` : ""}만 검색되었습니다. ` +
          `표기를 확인하세요 — 실존 단정 불가 (없음도 아님)`
        )
      }
      return (
        `✓ ${label} — 행정규칙 「${match.name}」 실존${meta ? ` (${meta})` : ""}. ` +
        `※ 행정규칙은 조문 단위 검증 미지원 — 명칭 실존만 확인함`
      )
    }
  }
  return null
}

/** 행정규칙 접미사 인용의 전용 검증 경로 (실존 → 폐지 연혁 → 미발견 순). */
export async function verifyAdminRuleCitation(
  apiClient: LawApiClient,
  candidates: string[],
  label: string,
  rawName: string,
  apiKey?: string,
  // verify의 20초 상한을 이 경로에도 전파한다 — 없으면 상한 이후에도 조회가 살아
  // 쿼터를 소모한다 (Codex 2차 중요: 이 함수만 signal을 받지 않았다)
  signal?: AbortSignal
): Promise<string> {
  try {
    const hit = await tryVerifyAdminRuleCitation(apiClient, candidates, label, apiKey, signal)
    if (hit) return hit

    // 현행에 없으면 폐지·제명변경 연혁 확인 (환각과 폐지 규칙을 구분).
    // 괄호는 떼고 조회한다 — 붙인 채면 폐지 연혁도 항상 0건이다 (Claude 리뷰 중요 3)
    for (const cand of candidates) {
      const note = await detectAbolishedAdminRule(apiClient, stripTrailingParen(cand), apiKey, signal)
      if (note) {
        const firstLine = note.split("\n").find(line => line.trim()) || note
        return `⌛ ${label} — 폐지·개정 연혁의 행정규칙으로 추정. ${firstLine.trim()}`
      }
    }

    // 접미사 판정은 괄호를 뗀 이름으로 — "사내 전결기준(2026. 1. 1.) 제3조"처럼 발령일
    // 괄호가 붙으면 이름이 ')'로 끝나 soft 강등이 빗나가고, 더 정밀한 표기가 오히려
    // ✗ 환각 낙인을 받는다 (Claude 리뷰 중요 3)
    const suffixBase = stripTrailingParen(rawName.trim())
    if (SOFT_ADMIN_SUFFIX.test(suffixBase) && !STRICT_ADMIN_SUFFIX.test(suffixBase)) {
      return `⚠ ${label} — 행정규칙 DB에서 확인 실패 ('${rawName}'이(가) 규칙명이 아닐 수 있음. 정식 명칭 재확인 필요)`
    }
    return `✗ ${label} — [NOT_FOUND] 행정규칙 DB에 해당 규칙 없음 (규칙명 오탈자 또는 존재하지 않는 규칙)`
  } catch (e) {
    return `⚠ ${label} — 행정규칙 검색 실패: ${e instanceof Error ? e.message : String(e)}`
  }
}
