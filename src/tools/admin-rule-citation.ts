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
  /** 행정규칙일련번호 — 본문 조회(getAdminRule)의 ID. 조문 존재 확인에 쓴다 */
  seq?: string
}

/** 행정규칙 본문에서 조문 존재를 확인한 결과 */
export type AdminArticleCheck =
  | { status: "확인"; total: number }
  | { status: "없음"; total: number }
  /** 조문 형식이 아닌 규칙(조문형식여부=N) — 통짜 본문이라 조문 단위 판정 불가 */
  | { status: "형식아님" }

/**
 * 행정규칙 본문을 받아 인용된 조문이 실제로 있는지 확인한다.
 *
 * 2026-09-01 실측: `lawService.do?target=admrul&ID=…`은 본문을 돌려주고, `조문형식여부`가
 * Y인 규칙은 `<조문내용>`이 "제N조(제목) 본문" 형태로 구조화되어 온다
 * (조사사무처리규정 113개·법인세 사무처리규정 205개·상속세 및 증여세 사무처리규정 76개).
 * N인 규칙(외국환거래규정 등)은 통짜 텍스트에 "제1-1조" 같은 자체 체계를 써서
 * 조문 단위 판정을 하면 안 된다 — 그 경우 "형식아님"으로 돌려 ⚠를 유지한다.
 *
 * 실패는 throw한다 — 조회 실패를 "조문 없음"으로 바꾸면 실존 조문이 ✗가 된다
 * (이 저장소에서 세 번 밟은 함정: B-0·잔여②파생2·차단3).
 */
export async function checkAdminRuleArticle(
  apiClient: LawApiClient,
  seq: string,
  article: string,
  apiKey?: string,
  signal?: AbortSignal
): Promise<AdminArticleCheck> {
  const xml = await apiClient.getAdminRule(seq, apiKey, signal)
  if (!xml || !xml.trim()) throw new Error("행정규칙 본문이 빈 응답 — 조문 확인 불가")
  // 응답이 끝까지 왔는지 먼저 본다 — 전송이 중간에 끊긴 XML은 앞부분만 파싱되어
  // "조문 N개 중 없음(✗)"이나 "확인(✓)"이라는 **틀린 확정 판정**을 만든다 (Codex 7차 중요).
  // 잘림은 판정 불가(⚠)여야 한다
  const rootMatch = /<\s*([A-Za-z_][\w]*)[\s>]/.exec(xml)
  const root = rootMatch?.[1]
  if (root !== "AdmRulService") {
    throw new Error(`행정규칙 본문이 예상 밖 응답(루트 ${root || "없음"}) — 조문 확인 불가`)
  }
  if (!/<\/\s*AdmRulService\s*>\s*$/.test(xml.trimEnd())) {
    throw new Error("행정규칙 본문이 중간에 끊긴 응답(닫는 태그 없음) — 조문 확인 불가")
  }
  const format = /<조문형식여부>\s*([YN])\s*<\/조문형식여부>/.exec(xml)?.[1]
  const bodies = xml.split("<조문내용>").slice(1)
  // 조문형식여부가 없거나 N이면 조문 단위 판정을 하지 않는다
  if (format !== "Y" || bodies.length === 0) return { status: "형식아님" }
  const numbers = new Set<string>()
  for (const b of bodies) {
    // "제5조의2(관할 조정 사유) …" — 조문 표제로 **시작**하는 것만 본다.
    // 본문 중간의 참조("제23조에 따라")를 세면 없는 조문이 실존으로 둔갑한다
    const m = /^(?:<!\[CDATA\[)?\s*제\s*(\d+)\s*조(?:\s*의\s*(\d+))?/.exec(b)
    if (m) numbers.add(m[2] ? `제${m[1]}조의${m[2]}` : `제${m[1]}조`)
  }
  if (numbers.size === 0) return { status: "형식아님" }
  const want = article.replace(/\s+/g, "")
  return numbers.has(want) ? { status: "확인", total: numbers.size } : { status: "없음", total: numbers.size }
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
      seq: rule.getElementsByTagName("행정규칙일련번호")[0]?.textContent?.trim() || undefined,
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
  signal?: AbortSignal,
  /**
   * 인용된 조문("제23조"). 주면 명칭 실존에 그치지 않고 본문에서 조문 존재까지 대조한다
   * — 조문 형식(조문형식여부=Y) 규칙에 한해 ✓/✗ 판정이 가능하다 (2026-09-01 실측).
   * 생략하면 종전대로 명칭 실존만 확인한다 (law_search 폴백 등 조문 없는 호출부)
   */
  article?: string
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
      // 조문이 붙은 인용은 본문까지 대조한다 — 명칭만 확인하고 ✓를 주면 없는 조문이
      // "검증 통과"로 읽힌다 (Opus 리뷰 중요 1이 ⚠ 강등으로 막아 둔 자리를, 이제
      // 실제 대조로 판정한다)
      if (article) {
        // 본문 조회 ID가 없으면 대조 자체가 불가능하다 — 명칭만 확인하고 ✓를 주면
        // 조문이 검증되지 않은 채 "통과"로 읽힌다 (Opus 리뷰 중요 1의 구멍)
        if (!match.seq) {
          return (
            `⚠ ${label} — 행정규칙 「${match.name}」 실존${meta ? ` (${meta})` : ""} · ` +
            `${article}는 미확인 (본문 조회 ID를 받지 못해 조문 대조 불가) — 원문 확인 필요`
          )
        }
        try {
          const check = await checkAdminRuleArticle(apiClient, match.seq, article, apiKey, signal)
          if (check.status === "확인") {
            return (
              `✓ ${label} — 행정규칙 「${match.name}」 ${article} 확인${meta ? ` (${meta})` : ""} · ` +
              `본문 조문 ${check.total}개와 대조함`
            )
          }
          if (check.status === "없음") {
            return (
              `✗ ${label} — 행정규칙 「${match.name}」은 실존하나 ${article}가 없음 ` +
              `(본문 조문 ${check.total}개 대조${meta ? ` · ${meta}` : ""}). 조문 번호 확인`
            )
          }
          return (
            `⚠ ${label} — 행정규칙 「${match.name}」 실존${meta ? ` (${meta})` : ""} · ` +
            `${article}는 미확인 — 이 규칙은 조문 형식이 아니어서(본문이 통짜 텍스트) 조문 단위 대조 불가. 원문 확인 필요`
          )
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          // deadline 취소는 상위(fin_verify)가 ⌛로 표기해야 한다 — 여기서 ⚠로 삼키지 않는다
          if (/취소됨/.test(msg)) throw e
          return (
            `⚠ ${label} — 행정규칙 「${match.name}」 실존${meta ? ` (${meta})` : ""} · ` +
            `${article} 확인 실패로 판정 불가 (없음 아님): ${msg}`
          )
        }
      }
      return (
        `✓ ${label} — 행정규칙 「${match.name}」 실존${meta ? ` (${meta})` : ""}. ` +
        `※ 명칭 실존만 확인함 (조문 미지정)`
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
  signal?: AbortSignal,
  /** 인용된 조문 — 주면 본문 대조까지 한다 (조문 형식 규칙에 한해 ✓/✗) */
  article?: string
): Promise<string> {
  try {
    const hit = await tryVerifyAdminRuleCitation(apiClient, candidates, label, apiKey, signal, article)
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
