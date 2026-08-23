/**
 * fin_ruling_search — 예규·심판례·해석례·판례 통합 검색 (목록 전용)
 *
 * 기존은 18개 도메인 중 하나를 골라 따로 검색해야 했다 (도메인 선택 부담이 LLM에 전가).
 * 여기서는 재무 실무 1순위 도메인 4곳을 병렬로 한 번에 검색한다.
 * - 법제처 정렬은 가나다순이라 최신 예규가 묻힌다 (베이스라인 관찰 3) → 일자 내림차순 재정렬
 * - 문서번호(법인세과-352 형식)를 복사 가능한 형태로 표기
 * - 본문은 동봉하지 않는다 (목록 전용 — 예산 4,000자). 예규 본문은 fin_nts_ruling.
 */

import { z } from "zod"
import type { LawApiClient } from "../lib/api-client.js"
import {
  parseTaxTribunalXML,
  parseInterpretationXML,
  parsePrecedentXML,
  extractTag,
} from "../lib/xml-parser.js"
import {
  type SectionResult,
  failed,
  ladderQueries,
  parseNtsRulings,
  truncateWithHint,
  AUTHORITY_FOOTER,
  SOURCE_FOOTER,
} from "../lib/fin-common.js"

const DOMAINS = ["nts", "tax_tribunal", "interpretation", "precedent"] as const
type Domain = (typeof DOMAINS)[number]

const DOMAIN_LABEL: Record<Domain, string> = {
  nts: "국세청 예규",
  tax_tribunal: "조세심판원 재결례",
  interpretation: "법제처 해석례",
  precedent: "대법원 판례",
}

// 전거 서열 주석 — 각 자료의 법적 성격을 명시해 오용(예규를 확정 근거로 인용 등)을 막는다
const DOMAIN_AUTHORITY: Record<Domain, string> = {
  nts: "행정해석 — 과세실무 기준이나 법원 구속력 없음",
  tax_tribunal: "불복 재결 — 인용 재결은 과세관청 기속",
  interpretation: "정부유권해석",
  precedent: "법원 판단 — 전거 최상위",
}

export const FinRulingSearchInputSchema = z.object({
  query: z.string().min(1).describe("쟁점 검색어 (예: 퇴직금 중간정산 손금)"),
  domains: z.array(z.enum(DOMAINS)).default([...DOMAINS]).describe("검색 도메인 (기본: 4곳 전부)"),
})

export const FIN_RULING_SEARCH_TOOL = {
  name: "fin_ruling_search",
  description:
    "[재무·세무·회계 전용 — 예규·심판례·판례 검색은 이 도구를 우선 사용] " +
    "국세청 예규 + 조세심판원 재결례 + 법제처 해석례 + 대법원 판례를 한 번에 검색해 최신순 통합 목록을 반환한다 " +
    "(문서번호·일자·제목). 예규 본문이 필요하면 fin_nts_ruling.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "쟁점 검색어" },
      domains: {
        type: "array",
        items: { type: "string", enum: [...DOMAINS] },
        description: "검색 도메인 (기본: nts·tax_tribunal·interpretation·precedent 전부)",
      },
    },
    required: ["query"],
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
} as const

interface UnifiedItem {
  domain: Domain
  docNo: string
  date: string // YYYYMMDD 정규화 (정렬용)
  dateDisplay: string
  title: string
  docId: string
  link: string
}

function normDate(raw: string): string {
  return (raw || "").replace(/[^\d]/g, "").slice(0, 8)
}

/** 도메인별 검색 — 0건이면 사다리 1회 축약 (오류에는 재시도 금지) */
async function searchDomain(apiClient: LawApiClient, domain: Domain, query: string): Promise<SectionResult & { items?: UnifiedItem[]; usedQuery?: string }> {
  const queries = ladderQueries(query, 2)
  try {
    for (const q of queries) {
      let items: UnifiedItem[] = []
      if (domain === "nts") {
        const xml = await apiClient.fetchApi({ endpoint: "lawSearch.do", target: "ntsCgmExpc", type: "XML", extraParams: { query: q, display: "10" } })
        items = parseNtsRulings(xml, 10).map((r) => ({
          domain,
          docNo: r.docNo,
          date: normDate(r.date),
          dateDisplay: r.date,
          title: r.title,
          docId: (r.link.match(/ntstDcmId=(\d+)/) || [])[1] || "",
          link: r.link,
        }))
      } else if (domain === "tax_tribunal") {
        const xml = await apiClient.fetchApi({ endpoint: "lawSearch.do", target: "ttSpecialDecc", type: "XML", extraParams: { query: q, display: "10" } })
        items = parseTaxTribunalXML(xml).items.map((r) => ({
          domain,
          docNo: r.청구번호,
          date: normDate(r.의결일자 || r.처분일자),
          dateDisplay: r.의결일자 || r.처분일자,
          title: r.사건명,
          docId: r.특별행정심판재결례일련번호,
          link: r.행정심판재결례상세링크,
        }))
      } else if (domain === "interpretation") {
        const xml = await apiClient.fetchApi({ endpoint: "lawSearch.do", target: "expc", type: "XML", extraParams: { query: q, display: "10" } })
        items = parseInterpretationXML(xml).items.map((r) => ({
          domain,
          docNo: r.법령해석례번호,
          date: normDate(r.회신일자),
          dateDisplay: r.회신일자,
          title: r.안건명,
          docId: r.법령해석례일련번호,
          link: r.법령해석례상세링크,
        }))
      } else {
        const xml = await apiClient.fetchApi({ endpoint: "lawSearch.do", target: "prec", type: "XML", extraParams: { query: q, display: "10" } })
        items = parsePrecedentXML(xml).items.map((r) => ({
          domain,
          docNo: r.사건번호,
          date: normDate(r.선고일자),
          dateDisplay: r.선고일자,
          title: `${r.판례명}${r.법원명 ? ` [${r.법원명}]` : ""}`,
          docId: r.판례일련번호,
          link: r.판례상세링크,
        }))
      }
      if (items.length > 0) {
        // 병합사건 등 문서번호 중복 제거 (베이스라인 관찰 6)
        const seen = new Set<string>()
        const deduped = items.filter((i) => {
          const key = i.docNo || i.docId || i.title
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
        // 최신순 재정렬 (법제처는 가나다순 — 최신 예규가 묻히는 문제)
        deduped.sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0))
        return { status: "성공", text: "", items: deduped.slice(0, 5), usedQuery: q }
      }
    }
    return { status: "성공", text: "", items: [], usedQuery: queries[queries.length - 1] }
  } catch (e) {
    return failed(e instanceof Error ? e.message : String(e))
  }
}

export async function handleFinRulingSearch(
  apiClient: LawApiClient,
  rawInput: unknown
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const parsed = FinRulingSearchInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    return {
      content: [{ type: "text", text: `[INVALID_PARAMETER] fin_ruling_search: ${parsed.error.issues.map((i) => i.message).join("; ")}` }],
      isError: true,
    }
  }
  const { query, domains } = parsed.data

  const results = await Promise.all(domains.map((d) => searchDomain(apiClient, d, query).then((r) => ({ domain: d, r }))))

  const failedDomains = results.filter(({ r }) => r.status !== "성공")
  const okDomains = results.filter(({ r }) => r.status === "성공")
  const totalHits = okDomains.reduce((n, { r }) => n + (r.items?.length || 0), 0)

  const overall =
    failedDomains.length === 0
      ? "전체 성공"
      : `부분 성공 — 실패: ${failedDomains.map(({ domain, r }) => `${DOMAIN_LABEL[domain]}(${r.reason})`).join(", ")}`

  let text = `[기준: 현행] 통합 해석·결정례 검색 — "${query}" · ${overall}\n`

  for (const { domain, r } of okDomains) {
    const label = DOMAIN_LABEL[domain]
    const items = r.items || []
    const ladderNote = r.usedQuery && r.usedQuery !== query ? ` (검색어 축약: "${r.usedQuery}")` : ""
    if (items.length === 0) {
      text += `\n■ ${label} — 0건${ladderNote} (정상 조회 결과 없음)\n`
      continue
    }
    text += `\n■ ${label} [${DOMAIN_AUTHORITY[domain]}] — 최신순 ${items.length}건${ladderNote}\n`
    text += items.map((i) => `  · ${i.docNo || "(번호없음)"} (${i.dateDisplay}) ${i.title}`).join("\n") + "\n"
  }
  for (const { domain, r } of failedDomains) {
    text += `\n■ ${DOMAIN_LABEL[domain]} — ⚠ 조회 실패: ${r.reason} ("없음"이 아니라 확인 불가)\n`
  }

  if (totalHits > 0) {
    text += `\n※ 예규 본문: fin_nts_ruling · 조문 근거: fin_article`
  }
  text += `\n${AUTHORITY_FOOTER}`
  text += `\n\n${SOURCE_FOOTER}`

  return { content: [{ type: "text", text: truncateWithHint(text, 4000, "도메인을 좁혀 재검색") }] }
}
