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
import { stripNonLawKeywords } from "../lib/law-search.js"
import { formatFetchFailure } from "../lib/errors.js"
import { extractTag } from "../lib/xml-parser.js"
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

function scoreLaw(item: ScoredLaw, query: string): number {
  let s = 0
  const cQuery = compactName(query)
  const cName = compactName(item.법령명)
  if (isFinLaw(item.법령명)) s += 40
  if (FIN_MINISTRY_CODES[item.소관부처코드]) s += 30
  if (cName === cQuery) s += 20
  else if (cName.startsWith(cQuery)) s += 10
  if (item.현행연혁 === "연혁") s -= 30
  if (item.제개정구분 === "폐지") s -= 20
  return s
}

function formatLawLine(item: ScoredLaw): string {
  const flags: string[] = []
  if (item.현행연혁 === "연혁") flags.push("⚠연혁(과거본)")
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
  const { query, include_ordinance } = parsed.data

  // 검색어에서 부가 키워드 제거 ("관세법 과태료 기준" → "관세법")
  const stripped = stripNonLawKeywords(query).trim() || query
  const strippedNote = stripped !== query ? ` (법령명 검색어로 정제: "${query}" → "${stripped}")` : ""

  try {
    // 사다리: 0건일 때만 어절 축약 (오류에는 재시도하지 않음)
    let items: ScoredLaw[] = []
    let usedQuery = stripped
    let totalCnt = "0"
    for (const q of ladderQueries(stripped, 3)) {
      const xml = await apiClient.searchLaw(q, undefined, 50)
      totalCnt = extractTag(xml, "totalCnt") || "0"
      items = parseLawBlocks(xml)
      if (items.length > 0) {
        usedQuery = q
        break
      }
    }

    if (items.length === 0) {
      // 0건이어도 주제어 힌트는 준다 (주제어→법령 매핑 부재가 기존 병목)
      const hints = TOPIC_LAW_HINTS.filter((h) => h.pattern.test(query))
      let text = `[LAW_NOT_FOUND] "${stripped}" 검색 결과 0건 (정상 조회 — ✗없음)${strippedNote}`
      if (hints.length > 0) {
        text += `\n💡 주제어 힌트: ${[...new Set(hints.flatMap((h) => h.laws))].join(" · ")} — 이 법령명으로 fin_article 또는 재검색을 시도하세요`
      }
      text += `\n\n${SOURCE_FOOTER}`
      return { content: [{ type: "text", text }] }
    }

    items.forEach((i) => (i.score = scoreLaw(i, usedQuery)))
    items.sort((a, b) => b.score - a.score || (b.시행일자 > a.시행일자 ? 1 : -1))

    const top = items.slice(0, 10)
    const demoted = items.length - top.length

    let text = `[기준: 현행] 법령 검색 — 전체 ${totalCnt}건 중 재무 관련도순 상위 ${top.length}건`
    if (usedQuery !== stripped) text += ` — 검색어 축약: "${stripped}" → "${usedQuery}"`
    text += strippedNote + "\n"
    text += top.map(formatLawLine).join("\n")
    if (demoted > 0) text += `\n  (관련도 하위 ${demoted}건 생략 — 필요 시 더 구체적인 법령명으로 재검색)`

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
