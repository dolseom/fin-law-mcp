/**
 * fin_law_search — 재무 필터 법령 검색
 *
 * 법제처 lawSearch는 관련도순이 아닌 부분 문자열(LIKE) 검색이다 ("민법"→"난민법").
 * 여기서는 RelevanceScore(PRD 02)로 재정렬한다:
 *   +40 재무 법령 사전 매칭 / +30 재무권 소관부처 / +20 정확 일치·+10 접두 일치 / −30 연혁
 * 차단이 아니라 가점·강등 — 목록이 낡아도 결과가 사라지지 않는다.
 * 폐지·시행예정을 명시하고, 주제어→법령 힌트(베이스라인 관찰 5)를 동봉한다.
 */

import { z } from "zod"
import type { LawApiClient } from "../lib/api-client.js"
import { stripNonLawKeywords, resolvedLawMatches } from "../lib/law-search.js"
import { formatFetchFailure } from "../lib/errors.js"
import { extractTag } from "../lib/xml-parser.js"
import { isAdminRuleName, isAdminRuleLikeName, findAdminRule, stripTrailingParen, type AdminRuleMatch } from "./admin-rule-citation.js"
import {
  FIN_MINISTRY_CODES,
  FIN_LAW_NAMES,
  TOPIC_LAW_HINTS,
  compactName,
  isFinLaw,
  isFutureDate,
  ladderQueries,
  SOURCE_FOOTER,
} from "../lib/fin-common.js"

export const FinLawSearchInputSchema = z.object({
  query: z.string().min(1).describe("검색어 (법령명 또는 법령명+키워드)"),
  include_ordinance: z.boolean().default(false).describe("자치법규(조례) 검색 포함 — 지방세 감면 조례 확인 시에만 true"),
  basis_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "기준일은 YYYY-MM-DD 형식이어야 합니다")
    .optional()
    .describe("기준일 (YYYY-MM-DD) — 해당 시점 시행 중이던 법령으로 검색"),
})

export const FIN_LAW_SEARCH_TOOL = {
  name: "fin_law_search",
  description:
    "[재무·세무·회계 전용 — 법령 검색은 이 도구를 우선 사용] " +
    "법령을 검색해 재무 관련도순으로 재정렬한다. 폐지·연혁·시행예정을 표시하고, 주제어에 맞는 법령 힌트를 동봉한다. " +
    "조문 내용까지 필요하면 결과를 fin_article에 넘길 것.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "검색어 (법령명 또는 법령명+키워드)" },
      include_ordinance: { type: "boolean", description: "지방세 감면 조례 확인 시에만 true (기본 false)" },
      basis_date: { type: "string", description: "기준일 YYYY-MM-DD (생략 시 현행) — 해당 시점 시행본으로 검색" },
    },
    required: ["query"],
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
} as const

interface ScoredLaw {
  법령명: string
  mst: string
  lawId: string
  구분: string
  소관부처명: string
  소관부처코드: string
  시행일자: string
  제개정구분: string
  현행연혁: string
  score: number
}

function parseLawBlocks(xml: string): ScoredLaw[] {
  const blocks = xml.match(/<law [\s\S]*?<\/law>/g) || []
  return blocks.map((b) => ({
    법령명: extractTag(b, "법령명한글"),
    mst: extractTag(b, "법령일련번호"),
    lawId: extractTag(b, "법령ID"),
    구분: extractTag(b, "법령구분명"),
    소관부처명: extractTag(b, "소관부처명"),
    소관부처코드: extractTag(b, "소관부처코드"),
    시행일자: extractTag(b, "시행일자"),
    제개정구분: extractTag(b, "제개정구분명"),
    현행연혁: extractTag(b, "현행연혁코드"),
    score: 0,
  }))
}

/**
 * 기준일 범위 검색 결과에서 법령별로 "그 시점 시행 중이던 1건"만 남긴다.
 * 범위 검색은 한 법령의 여러 개정본을 모두 돌려주므로, 그대로 두면 같은 법령이
 * 시행일만 다른 채 여러 줄로 나와 어느 것이 그 시점 현행인지 알 수 없다.
 */
function pickVersionsAt(items: ScoredLaw[], basisYmd: string): ScoredLaw[] {
  const best = new Map<string, ScoredLaw>()
  for (const it of items) {
    if (!/^\d{8}$/.test(it.시행일자) || it.시행일자 > basisYmd) continue
    const key = compactName(it.법령명)
    const prev = best.get(key)
    if (!prev || it.시행일자 > prev.시행일자) best.set(key, it)
  }
  return [...best.values()]
}

function scoreLaw(item: ScoredLaw, query: string, basisMode = false): number {
  let s = 0
  const cQuery = compactName(query)
  const cName = compactName(item.법령명)
  if (isFinLaw(item.법령명)) s += 40
  if (FIN_MINISTRY_CODES[item.소관부처코드]) s += 30
  if (cName === cQuery) s += 20
  else if (cName.startsWith(cQuery)) s += 10
  // 기준일 검색에서는 연혁이 곧 정답이므로 강등하지 않는다
  if (item.현행연혁 === "연혁" && !basisMode) s -= 30
  if (item.제개정구분 === "폐지") s -= 20
  return s
}

function formatLawLine(item: ScoredLaw, basisMode = false): string {
  const flags: string[] = []
  // 기준일 검색에서는 과거본이 정상 결과다 — 경고를 붙이면 정상을 이상으로 읽게 된다
  if (item.현행연혁 === "연혁" && !basisMode) flags.push("⚠연혁(과거본)")
  if (item.제개정구분 === "폐지") flags.push("⚠폐지")
  if (isFutureDate(item.시행일자)) flags.push("📅시행예정")
  const flagStr = flags.length ? ` ${flags.join(" ")}` : ""
  return `  · ${item.법령명} [${item.구분}] ${item.소관부처명} · 시행 ${item.시행일자}${flagStr} (MST ${item.mst})`
}

export async function handleFinLawSearch(
  apiClient: LawApiClient,
  rawInput: unknown
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const parsed = FinLawSearchInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    return {
      content: [{ type: "text", text: `[INVALID_PARAMETER] fin_law_search: ${parsed.error.issues.map((i) => i.message).join("; ")}` }],
      isError: true,
    }
  }
  const { query, include_ordinance, basis_date } = parsed.data
  const basisYmd = basis_date ? basis_date.replace(/-/g, "") : undefined

  // 검색어에서 부가 키워드 제거 ("관세법 과태료 기준" → "관세법").
  // 괄호는 먼저 뗀다 — "외국환거래규정(기재부 고시)"를 그대로 두면 축약 사다리가
  // "고시)"까지 잘라내 **완전히 무관한 법령**(「정부기관 및 공공법인 등의 광고시행에
  // 관한 법률」)을 답으로 준다 (실측). 괄호 안은 대개 소관·발령 메타데이터다
  const stripped = stripNonLawKeywords(stripTrailingParen(query)).trim() || query
  const strippedNote = stripped !== query ? ` (법령명 검색어로 정제: "${query}" → "${stripped}")` : ""

  try {
    // 사다리: 0건일 때만 어절 축약 (오류에는 재시도하지 않음)
    let items: ScoredLaw[] = []
    let usedQuery = stripped
    let totalCnt = "0"
    for (const q of ladderQueries(stripped, 3)) {
      // 기준일 검색은 eflaw + efYd **범위** 문법으로만 동작한다 —
      // 단일 efYd는 법제처가 조용히 무시하고 현행 결과를 준다 (실측)
      const xml = basisYmd
        ? await apiClient.fetchApi({
            endpoint: "lawSearch.do",
            target: "eflaw",
            type: "XML",
            extraParams: { query: q, display: "100", efYd: `19000101~${basisYmd}` },
            expectedRoot: "LawSearch",
          })
        : await apiClient.searchLaw(q, undefined, 50)
      totalCnt = extractTag(xml, "totalCnt") || "0"
      items = parseLawBlocks(xml)
      if (basisYmd) items = pickVersionsAt(items, basisYmd)
      if (items.length > 0) {
        usedQuery = q
        break
      }
    }

    // 「외국환거래규정」(기재부 고시)처럼 법령 DB에 없어도 행정규칙으로 실존하는
    // 이름을 "✗없음"으로 단정하면 틀린 단정이 된다 — 같은 서버의 fin_verify는 ✓를
    // 주는데 law_search가 ✗를 주던 모순 (실사용 시뮬레이션 A8).
    // 0건일 때만 확인하면 안 된다: 법제처는 LIKE 검색이라 무관한 1건만 걸려도
    // 폴백이 통째로 꺼진다 — 「조사사무처리규정」(국세청 훈령)이 「…가족관계등록
    // 사무처리규칙」 1건에 가려 사라지던 실측(잔여②). 정확히 일치하는 법령이
    // 없으면 건수와 무관하게 행정규칙 DB를 병행 조회한다.
    // 조회 후보에 원본 질의도 넣는다: stripNonLawKeywords는 법령명 검색용 정제라
    // "조사사무처리규정"을 "조사사무 규정"으로 쪼개고, 그 형태로는 행정규칙 DB가
    // 원본 명칭을 못 찾는다 (실측). 행정규칙 명칭은 정제 전 이름이 정답에 가깝다
    const adminCandidates = [...new Set([stripTrailingParen(query), query.trim(), stripped].filter(Boolean))]
    // 일치 판정에 stripped만 쓰면 안 된다: 정제가 「산업안전보건기준에 관한 규칙」의
    // '기준'을 지워 정식 부령이 "불일치"가 되고, 행정규칙 DB에 비슷한 이름이 있으면
    // 정상 법령에 [행정규칙] 배너가 붙는다 (테스트로 적발). 원본 질의도 함께 대조한다
    const exactLawFound = items.some((i) => adminCandidates.some((cand) => resolvedLawMatches(cand, i.법령명)))
    let adminRule: AdminRuleMatch | null = null
    let adminNote = ""
    if (!exactLawFound && adminCandidates.some((c) => isAdminRuleLikeName(c) || isAdminRuleName(c))) {
      // 앞 후보의 **실패**가 뒤 후보의 정상 0건에 덮이면 안 된다 — 확인하지 못한 것이
      // "없음"으로 읽힌다 (Codex 리뷰 중요 2). 실패가 한 번이라도 있으면 그쪽을 남긴다
      let anyFailed = false
      for (const cand of adminCandidates) {
        try {
          adminRule = await findAdminRule(apiClient, cand)
          if (adminRule) break
        } catch {
          anyFailed = true
        }
      }
      if (!adminRule) {
        adminNote = anyFailed ? " · 행정규칙 DB는 확인 실패(없음 단정 아님)" : " · 행정규칙 DB에도 0건"
      }
    }
    // exact=false는 "이름이 그것으로 시작하는 **다른** 규칙이 있다"는 뜻이지
    // 요청한 규칙이 실존한다는 증거가 아니다 — 「국세청 사무처리규정」 질의에
    // 「…시행세칙」만 있어도 실존으로 단정하던 것을 막는다 (Codex 2차 차단 1).
    // exact 플래그를 만들어 놓고 소비자에 전파하지 않으면 수정한 것이 아니다
    const adminMeta = adminRule
      ? [adminRule.ruleType, adminRule.orgName, adminRule.promDate ? `발령 ${adminRule.promDate}` : ""]
          .filter(Boolean)
          .join(" · ")
      : ""
    const adminRuleBlock = !adminRule
      ? ""
      : adminRule.exact
        ? `[행정규칙] "${query.trim()}" — 법령(법률·시행령·부령) DB에는 없지만 **행정규칙 「${adminRule.name}」**` +
          (adminMeta ? ` (${adminMeta})` : "") +
          `로 실존합니다.\n` +
          `※ 행정규칙은 조문 단위 조회 미지원 — 인용 검증은 fin_verify, 원문은 국가법령정보센터(law.go.kr)에서 행정규칙으로 검색하세요.` +
          (basis_date ? `\n※ 기준일 검색은 법령만 지원 — 위 행정규칙 실존은 현행 기준입니다` : "")
        : `[행정규칙·유사] "${query.trim()}"과 **정확히 일치하는** 행정규칙은 찾지 못했습니다 — ` +
          `이름이 겹치는 「${adminRule.name}」${adminMeta ? ` (${adminMeta})` : ""}만 검색되었습니다.\n` +
          `※ 표기를 확인하세요 — 실존 단정 불가 (없음도 아님).`

    if (items.length === 0) {
      // 정확 일치 행정규칙일 때만 그것으로 답한다. 유사 일치면 법령 0건 사실도
      // 함께 알려야 한다 — 유사 규칙 하나로 "찾았다"고 끝내면 안 된다
      if (adminRule?.exact) {
        return {
          content: [{ type: "text", text: `${adminRuleBlock}\n\n${SOURCE_FOOTER}` }],
        }
      }
      if (adminRule) {
        return {
          content: [
            {
              type: "text",
              text:
                `[LAW_NOT_FOUND] "${stripped}" 법령 검색 결과 0건 (정상 조회)${strippedNote}\n\n` +
                `${adminRuleBlock}\n\n${SOURCE_FOOTER}`,
            },
          ],
        }
      }
      // 0건이어도 주제어 힌트는 준다 (주제어→법령 매핑 부재가 기존 병목)
      const hints = TOPIC_LAW_HINTS.filter((h) => h.pattern.test(query))
      const basisSuffix = basis_date ? ` — ${basis_date} 시점에 시행 중이던 법령 없음 (제정 이전이거나 표기 확인 필요)` : ""
      let text = `[LAW_NOT_FOUND] "${stripped}" 검색 결과 0건 (정상 조회 — ✗없음)${adminNote}${strippedNote}${basisSuffix}`
      if (hints.length > 0) {
        text += `\n💡 주제어 힌트: ${[...new Set(hints.flatMap((h) => h.laws))].join(" · ")} — 이 법령명으로 fin_article 또는 재검색을 시도하세요`
      }
      text += `\n\n${SOURCE_FOOTER}`
      return { content: [{ type: "text", text }] }
    }

    items.forEach((i) => (i.score = scoreLaw(i, usedQuery, !!basisYmd)))
    items.sort((a, b) => b.score - a.score || (b.시행일자 > a.시행일자 ? 1 : -1))

    const top = items.slice(0, 10)
    const demoted = items.length - top.length

    // 행정규칙으로 실존하는데 법령 DB가 이름만 비슷한 다른 법령을 물어온 경우 —
    // 사용자가 찾던 것은 행정규칙 쪽이므로 먼저 알리고, 법령 결과는 아래에 남긴다
    let text = adminRuleBlock
      ? `${adminRuleBlock}\n※ 아래 법령 검색 결과는 이름이 비슷한 **다른 법령**입니다 — 찾던 것이 위 행정규칙이면 아래 목록을 근거로 쓰지 마세요.\n\n`
      : ""
    text += basis_date
      ? `[기준일: ${basis_date} 시행 기준] 법령 검색 — 해당 시점 시행본 ${items.length}건 중 재무 관련도순 상위 ${top.length}건`
      : `[기준: 현행] 법령 검색 — 전체 ${totalCnt}건 중 재무 관련도순 상위 ${top.length}건`
    if (usedQuery !== stripped) text += ` — 검색어 축약: "${stripped}" → "${usedQuery}"`
    text += strippedNote + "\n"
    text += top.map((t) => formatLawLine(t, !!basisYmd)).join("\n")
    if (demoted > 0) text += `\n  (관련도 하위 ${demoted}건 생략 — 필요 시 더 구체적인 법령명으로 재검색)`
    // 행정규칙 조회를 시도했다가 실패한 사실은 감추지 않는다 — 아래 목록만 보면
    // "행정규칙은 없다"로 읽히지만 실제로는 확인이 안 된 것이다
    if (!adminRuleBlock && adminNote.includes("확인 실패")) {
      text += `\n※ "${query.trim()}"은 행정규칙(고시·훈령)일 수 있으나 행정규칙 DB 확인에 실패했습니다 — 위 목록에 없다고 "없음"으로 단정하지 마세요`
    }

    // 주제어 힌트 (상위 결과에 힌트 법령이 이미 있으면 생략)
    const hints = TOPIC_LAW_HINTS.filter((h) => h.pattern.test(query))
    if (hints.length > 0) {
      const hintLaws = [...new Set(hints.flatMap((h) => h.laws))]
      const topNames = new Set(top.map((t) => compactName(t.법령명)))
      const missing = hintLaws.filter((l) => !topNames.has(compactName(l)))
      if (missing.length > 0) {
        text += `\n💡 주제어 힌트: 이 주제의 근거 법령은 ${missing.join(" · ")} 쪽에 있을 가능성이 높습니다 — fin_article로 조회하세요`
      }
    }

    // 지방세 조례 옵트인
    if (include_ordinance) {
      try {
        const ordXml = await apiClient.searchOrdinance({ query: stripped, display: 5 })
        const ordBlocks = ordXml.match(/<law [\s\S]*?<\/law>/g) || []
        if (ordBlocks.length > 0) {
          text += `\n\n■ 자치법규(조례) — 옵트인 검색 ${ordBlocks.length}건\n`
          text += ordBlocks
            .slice(0, 5)
            .map((b) => `  · ${extractTag(b, "자치법규명") || extractTag(b, "법령명한글")} (${extractTag(b, "지자체기관명")})`)
            .join("\n")
        } else {
          text += `\n\n■ 자치법규(조례) — 0건`
        }
      } catch (e) {
        text += `\n\n■ 자치법규(조례) — ⚠ 조회 실패(${e instanceof Error ? e.message : String(e)}) — 0건이 아니라 확인 불가`
      }
    }

    text += `\n\n${SOURCE_FOOTER}`
    return { content: [{ type: "text", text }] }
  } catch (e) {
    return {
      content: [{ type: "text", text: formatFetchFailure("법령 검색", e) }],
      isError: true,
    }
  }
}

/** 재무 법령 사전 노출 (도구 설명·디버깅용) */
export const FIN_LAW_DICTIONARY = FIN_LAW_NAMES
