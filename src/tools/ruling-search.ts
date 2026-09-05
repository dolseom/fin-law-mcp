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
  parseNtsRulings,
  truncateWithHint,
  AUTHORITY_FOOTER,
  RULING_STOPWORDS,
  SOURCE_FOOTER,
} from "../lib/fin-common.js"

const DOMAINS = ["nts", "tax_tribunal", "interpretation", "precedent"] as const
type Domain = (typeof DOMAINS)[number]

const DOMAIN_LABEL: Record<Domain, string> = {
  nts: "국세청 예규",
  tax_tribunal: "조세심판원 재결례",
  interpretation: "법제처 해석례",
  // 법제처 판례 DB는 대법원만이 아니라 전 심급(고법·지법 포함)을 준다 — "대법원 판례"로
  // 라벨하면 하급심이 최상위 전거로 읽힌다 (실사용 시뮬레이션 ④: 5건 중 대법원 1건 실측)
  precedent: "법원 판례",
}

// 전거 서열 주석 — 각 자료의 법적 성격을 명시해 오용(예규를 확정 근거로 인용 등)을 막는다
const DOMAIN_AUTHORITY: Record<Domain, string> = {
  nts: "행정해석 — 과세실무 기준이나 법원 구속력 없음",
  tax_tribunal: "불복 재결 — 인용 재결은 과세관청 기속",
  interpretation: "정부유권해석",
  precedent: "법원 판단 — 심급 확인 필요: 대법원 확정판결이 최상위, 하급심은 상소·확정 여부 확인",
}

export const FinRulingSearchInputSchema = z.object({
  query: z.string().min(1).describe("쟁점 검색어 (예: 퇴직금 중간정산 손금)"),
  // 빈 배열을 허용하면 한 번도 조회하지 않고 "전체 성공 · 검색 범위 (0곳)"을 돌려준다 —
  // 호출측은 이것을 "검색했지만 결과 없음"으로 읽는다 (조용한 no-op, Codex 2차 중요)
  domains: z
    .array(z.enum(DOMAINS))
    .min(1, "domains는 최소 1곳 이상이어야 합니다 (생략하면 4곳 전부 검색)")
    .default([...DOMAINS])
    .describe("검색 도메인 (기본: 4곳 전부)"),
  basis_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "기준일은 YYYY-MM-DD 형식이어야 합니다")
    .optional()
    .describe("기준일 (YYYY-MM-DD) — 이 날짜까지 나온 예규·재결·판례만 (회신·의결·선고일 기준)"),
})

export const FIN_RULING_SEARCH_TOOL = {
  name: "fin_ruling_search",
  description:
    "[재무·세무·회계 전용 — 예규·심판례·판례 검색은 이 도구를 우선 사용] " +
    "국세청 예규 + 조세심판원 재결례 + 법제처 해석례 + 법원 판례(전 심급)를 한 번에 검색해 최신순 통합 목록을 반환한다 " +
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
      basis_date: { type: "string", description: "기준일 YYYY-MM-DD — 이 날짜까지 나온 자료만 (회신·의결·선고일 기준)" },
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

/**
 * 도메인당 검색 호출 상한 (원 검색어 1 + 축약 3).
 * 법제처 분당 30회 한도를 도메인 4곳이 병렬로 나눠 쓰므로 4회를 넘기지 않는다.
 */
const LADDER_MAX_CALLS = 4

/**
 * ruling-search 전용 축약 사다리 — 양끝을 번갈아 깎아 1어절까지 내려간다.
 *
 * 원문 → 꼬리 1어절 제거 → 머리 1어절 제거 → 꼬리 제거 → 머리 제거 …
 *   "임직원 경조사비 복리후생비 손금" → "임직원 경조사비 복리후생비" → "경조사비 복리후생비" → "경조사비"
 *
 * 공용 ladderQueries는 앞토막만 잘라(3→2→1어절) 마지막에 첫 어절만 남긴다. 실무자 자연어는
 * [주체][주제어][쟁점 동사성 명사] 순이라 정보가 가운데 몰려 있어, 앞토막 축약은 주제어를
 * 먼저 버린다("임직원 경조사비 복리후생비 손금"의 종착점이 "경조사비"가 아니라 "임직원").
 * 꼬리를 먼저 깎는 이유는 "손금·여부·해당" 류 쟁점어가 꼬리에 오기 때문.
 *
 * 공용 함수를 고치면 article·law-search·nts-ruling까지 함께 바뀌므로 순서 생성만 국소화하고,
 * 전처리(불용어 제거)는 공용 목록 RULING_STOPWORDS를 그대로 참조한다 (목록 복제 금지).
 * ⚠ 예산 4회 안에서 1어절에 닿는 것은 4어절 이하 질의뿐이다. 5어절 이상은 상한에 먼저 걸린다.
 */
function buildLadder(query: string): string[] {
  const normalized = query.replace(/\s+/g, " ").trim()
  const toks = query.split(/\s+/).filter((t) => t && !RULING_STOPWORDS.has(t))
  // 원문을 반드시 1순위로 — 불용어("및"·"관한")가 공식 명칭의 일부인 경우가 있다
  const qs: string[] = [normalized]
  let lo = 0
  let hi = toks.length
  let dropTail = true
  while (hi - lo > 1) {
    if (dropTail) hi--
    else lo++
    dropTail = !dropTail
    qs.push(toks.slice(lo, hi).join(" "))
  }
  // 2어절 질의는 축약 후보가 양끝 두 어절뿐이고 예산(4회)이 남는다 — 나머지 한쪽도 시도한다.
  // 3어절 이상은 교대 축약만으로 주제어에 닿으므로 추가하지 않는다 (호출 예산 보존)
  if (toks.length === 2) qs.push(toks[1])
  return [...new Set(qs.filter(Boolean))].slice(0, LADDER_MAX_CALLS)
}

/**
 * 도메인별 검색 — 0건이면 양끝을 번갈아 깎아 단계적으로 축약한다 (최대 4회 호출).
 *
 * ⚠ 다음 단계로 넘어가는 조건은 "정상 조회 결과 0건" 하나뿐이다. 오류·타임아웃·429는
 *   throw되어 catch로 빠지며 절대 재시도하지 않는다 — 오류를 0건으로 위장하면 호출측이
 *   "그런 해석 없음"으로 단정한다 (이 저장소의 최악 결함).
 * ⚠ 어떤 단계가 결과를 냈는데 기준일 필터로 전부 걸러진 경우는 "0건 조회"가 아니므로
 *   사다리를 더 내려가지 않는다 (그 검색어에는 자료가 있다는 사실이 이미 확인됐다).
 */
async function searchDomain(
  apiClient: LawApiClient,
  domain: Domain,
  query: string,
  basisYmd?: string
): Promise<
  SectionResult & {
    items?: UnifiedItem[]
    usedQuery?: string
    /** 실제로 시도할 수 있었던 축약 사다리 전체 (0건 보고용) */
    ladder?: string[]
    /** 결과를 낸(또는 마지막으로 시도한) 사다리 단계. 0 = 원 검색어 */
    ladderStep?: number
    excludedByBasis?: number
    truncated?: number
  }
> {
  const queries = buildLadder(query)
  try {
    for (let step = 0; step < queries.length; step++) {
      const q = queries[step]
      let items: UnifiedItem[] = []
      if (domain === "nts") {
        const xml = await apiClient.fetchApi({ endpoint: "lawSearch.do", target: "ntsCgmExpc", type: "XML", extraParams: { query: q, display: "10" }, expectedRoot: "CgmExpc" })
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
        const xml = await apiClient.fetchApi({ endpoint: "lawSearch.do", target: "ttSpecialDecc", type: "XML", extraParams: { query: q, display: "10" }, expectedRoot: "Decc" })
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
        const xml = await apiClient.fetchApi({ endpoint: "lawSearch.do", target: "expc", type: "XML", extraParams: { query: q, display: "10" }, expectedRoot: "Expc" })
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
        const xml = await apiClient.fetchApi({ endpoint: "lawSearch.do", target: "prec", type: "XML", extraParams: { query: q, display: "10" }, expectedRoot: "PrecSearch" })
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
        // 기준일 필터는 상위 5건 자르기 **전에** 적용한다 — 뒤에 적용하면 상위가
        // 전부 기준일 이후일 때 실제로는 있는 과거 자료가 0건으로 보인다.
        // 예규·재결·판례는 시행일이 아니라 회신·의결·선고일 기준이라 API 필터
        // 대신 파싱된 일자로 직접 거른다 (일자 미상은 남기고 아래에서 고지)
        let excludedByBasis = 0
        let filtered = deduped
        if (basisYmd) {
          filtered = deduped.filter((i) => {
            if (!/^\d{8}$/.test(i.date)) return true // 일자 미상은 버리지 않는다
            const keep = i.date <= basisYmd
            if (!keep) excludedByBasis++
            return keep
          })
        }
        // 표시 상한(5건)을 넘긴 분량은 조용히 버리지 않고 건수를 넘긴다
        return {
          status: "성공",
          text: "",
          items: filtered.slice(0, 5),
          usedQuery: q,
          ladder: queries,
          ladderStep: step,
          excludedByBasis,
          truncated: Math.max(filtered.length - 5, 0),
        }
      }
    }
    // 사다리 전 단계가 정상 조회 0건 — 축약으로는 더 넓힐 수 없다는 사실을 그대로 넘긴다
    return {
      status: "성공",
      text: "",
      items: [],
      usedQuery: queries[queries.length - 1],
      ladder: queries,
      ladderStep: queries.length - 1,
    }
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
  const { query, domains, basis_date } = parsed.data
  const basisYmd = basis_date ? basis_date.replace(/-/g, "") : undefined

  const results = await Promise.all(
    domains.map((d) => searchDomain(apiClient, d, query, basisYmd).then((r) => ({ domain: d, r })))
  )

  const failedDomains = results.filter(({ r }) => r.status !== "성공")
  const okDomains = results.filter(({ r }) => r.status === "성공")
  const totalHits = okDomains.reduce((n, { r }) => n + (r.items?.length || 0), 0)

  const overall =
    failedDomains.length === 0
      ? "전체 성공"
      : `부분 성공 — 실패: ${failedDomains.map(({ domain, r }) => `${DOMAIN_LABEL[domain]}(${r.reason})`).join(", ")}`

  let text = basis_date
    ? `[기준일: ${basis_date}까지] 통합 해석·결정례 검색 — "${query}" · ${overall}\n※ 회신·의결·선고일이 기준일 이후인 자료는 제외했습니다 (일자 미상은 남김)\n`
    : `[기준: 현행] 통합 해석·결정례 검색 — "${query}" · ${overall}\n`

  for (const { domain, r } of okDomains) {
    const label = DOMAIN_LABEL[domain]
    const items = r.items || []
    // 몇 단 축약했는지 밝힌다 — 2단 이상이면 원 질문과 검색어가 크게 달라져 결과 해석이 바뀐다
    const step = r.ladderStep ?? 0
    const ladderNote =
      r.usedQuery && r.usedQuery !== query
        ? step >= 2
          ? ` (검색어 축약 ${step}단: "${r.usedQuery}")`
          : ` (검색어 축약: "${r.usedQuery}")`
        : ""
    const basisNote = r.excludedByBasis ? ` · 기준일 이후 ${r.excludedByBasis}건 제외` : ""
    if (items.length === 0) {
      // 기준일 때문에 비었으면 "자료 없음"과 구분해 표기한다 (조용한 실패 금지)
      if (r.excludedByBasis) {
        text += `\n■ ${label} — 0건${ladderNote} (검색된 ${r.excludedByBasis}건이 모두 기준일 이후 — 기준일 이전 자료는 검색 상위에 없을 수 있음)\n`
        continue
      }
      // 축약 사다리를 끝까지 내려가고도 0건임을 도메인마다 표시한다.
      // 사다리 검색어 자체는 도메인 전체가 동일하므로 아래에서 한 번만 나열한다 (중복 제거)
      const ladder = r.ladder || []
      const zeroNote =
        ladder.length > 1
          ? ` (축약 ${ladder.length}단계 전부 0건 — 정상 조회 결과 없음)`
          : ` (정상 조회 결과 없음)`
      text += `\n■ ${label} — 0건${zeroNote}\n`
      continue
    }
    const truncNote = r.truncated ? ` · 검색 ${items.length + r.truncated}건 중 최신 ${items.length}건 표시` : ""
    text += `\n■ ${label} [${DOMAIN_AUTHORITY[domain]}] — 최신순 ${items.length}건${truncNote}${ladderNote}${basisNote}\n`
    text += items.map((i) => `  · ${i.docNo || "(번호없음)"} (${i.dateDisplay}) ${i.title}`).join("\n") + "\n"
  }
  for (const { domain, r } of failedDomains) {
    text += `\n■ ${DOMAIN_LABEL[domain]} — ⚠ 조회 실패: ${r.reason} ("없음"이 아니라 확인 불가)\n`
  }

  // 축약 사다리를 끝까지 내려가고도 0건인 도메인이 있으면 실제로 시도한 검색어를 한 줄로 밝힌다.
  // 사다리는 질의어만으로 정해지므로 도메인마다 같다 — 도메인 줄마다 반복하지 않고 여기서 한 번만.
  // 이걸 안 밝히면 실무자가 "그런 해석이 없다"로 단정한다 (실제로는 검색어를 바꿔야 하는 상황)
  const exhausted = okDomains.find(
    ({ r }) => (r.items?.length ?? 0) === 0 && !r.excludedByBasis && (r.ladder?.length ?? 0) > 1
  )
  if (exhausted) {
    const ladder = exhausted.r.ladder || []
    // 다른 도메인은 결과가 있을 수 있으므로 "0건인 도메인은"으로 한정한다
    text += `\n※ 0건인 도메인은 축약 사다리 ${ladder.map((q) => `"${q}"`).join(" → ")} ${ladder.length}단계를 모두 시도한 결과입니다 — 자료가 없다는 뜻이 아니라 검색어를 바꿔야 한다는 뜻입니다 (다른 실무 용어로 재검색)`
  }

  if (totalHits > 0) {
    text += `\n※ 예규 본문: fin_nts_ruling · 조문 근거: fin_article`
  }
  // 커버 범위를 매번 밝힌다 — 이 4곳이 "전부"가 아님을 모르면 0건을 "그런 해석 없음"으로
  // 단정하게 된다 (법제처 해석·결정례 도메인은 18곳, 여기선 재무 실무 1순위 4곳만 검색)
  const covered = domains.map((d) => DOMAIN_LABEL[d]).join(" · ")
  text += `\n※ 검색 범위: ${covered} (${domains.length}곳). 법제처 해석·결정례 도메인 전체(18곳) 중 재무 실무 1순위만 검색하므로, 0건이 "해석 없음"을 뜻하지 않습니다`
  text += `\n${AUTHORITY_FOOTER}`
  text += `\n\n${SOURCE_FOOTER}`

  // 전 도메인 실패는 도구 실행 실패다 — 부분 성공과 달리 isError로 표기 (Opus I5: isError 통일)
  const allFailed = okDomains.length === 0 && failedDomains.length > 0
  return {
    content: [{ type: "text", text: truncateWithHint(text, 4000, "도메인을 좁혀 재검색") }],
    ...(allFailed ? { isError: true as const } : {}),
  }
}
