/**
 * fin_article — 묶음 조문 조회 (fin-law-mcp의 핵심 도구)
 *
 * 1회 호출로: 조문 본문 + 시행령·시행규칙 위임조문 + 관련 예규 + 별표 + 개정 정보.
 * 3단계 파이프라인 (단계 내 병렬):
 *   ① 법령명 → MST 확정 (findLaws: 별칭 사전·부분매칭 방어 내장)
 *   ② 조문 본문(eflaw) ∥ 3단비교 위임조문(thdCmp) ∥ 별표 목록(licbyl)
 *   ③ 조문 제목 키워드로 국세청 예규 검색(ntsCgmExpc)
 *
 * 부분 실패 계약 (PRD 02): 섹션별 독립 상태 — 일부 실패가 나머지를 버리지 않는다.
 * 오류는 절대 "없음"으로 위장하지 않는다 (⚠판정불가로 사유 명시).
 */

import { z } from "zod"
import type { LawApiClient } from "../lib/api-client.js"
import { findLaws, resolvedLawMatches, sameLawFamily, type LawInfo } from "../lib/law-search.js"
import { formatFetchFailure } from "../lib/errors.js"
import { buildJO } from "../lib/law-parser.js"
import { cleanHtml, flattenContent, groupMokByReset } from "../lib/article-parser.js"
import { parseThreeTierDelegation } from "../lib/three-tier-parser.js"
import { extractTag, toArray } from "../lib/xml-parser.js"
import {
  type SectionResult,
  failed,
  withDeadline,
  truncateWithHint,
  ladderQueries,
  parseNtsRulings,
  parseUpcomingVersions,
  formatYmd,
  AUTHORITY_FOOTER,
  SOURCE_FOOTER,
} from "../lib/fin-common.js"

// ── 응답 예산 (PRD 02 문서) ─────────────────────────────────────────────
const BUDGET_ARTICLE = 6000
const BUDGET_DELEGATION = 4000
const BUDGET_RULINGS = 1000
const BUDGET_ETC = 1000
const DEADLINE_MS = 6000 // 도구 전체 deadline (p95 SLO)

export const FinArticleInputSchema = z.object({
  law: z.string().min(1).describe("법령명 (예: 법인세법, 부가세법 등 약칭 허용)"),
  article: z.string().min(1).describe("조문 번호 (예: '제26조', '제10조의2', '26')"),
  basis_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "기준일은 YYYY-MM-DD 형식이어야 합니다")
    .optional()
    .describe("기준일 (YYYY-MM-DD). 생략 시 현행"),
  include_rulings: z.boolean().default(true).describe("관련 국세청 예규 검색 포함 여부 (기본 true)"),
})
export type FinArticleInput = z.infer<typeof FinArticleInputSchema>

// MCP tools/list 노출용 JSON Schema (zod와 수동 동기화)
export const FIN_ARTICLE_TOOL = {
  name: "fin_article",
  description:
    "[재무·세무·회계 전용 — 세법 조문 질의에는 이 도구를 우선 사용] " +
    "조문 1개를 물으면 조문 본문 + 위임 시행령·시행규칙 조문 + 관련 국세청 예규 + 별표 + 개정 정보를 한 번에 반환한다. " +
    "예: 법인세법 제26조. 실무 검토의 시작점.",
  inputSchema: {
    type: "object",
    properties: {
      law: { type: "string", description: "법령명 (약칭 허용: 법인세법, 조특법, 상증세법 등)" },
      article: { type: "string", description: "조문 번호 (예: '제26조', '제10조의2')" },
      basis_date: { type: "string", description: "기준일 YYYY-MM-DD (생략 시 현행)" },
      include_rulings: { type: "boolean", description: "관련 예규 검색 포함 (기본 true)" },
    },
    required: ["law", "article"],
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
} as const

/** "제26조"/"26"/"제10조의2" → 표시용 "제26조"·"제10조의2" */
function normalizeArticleLabel(input: string): string {
  const m = input.trim().match(/^제?\s*(\d+)\s*조?(?:의\s*(\d+))?$/)
  if (!m) return input.trim()
  return m[2] ? `제${m[1]}조의${m[2]}` : `제${m[1]}조`
}

// ── ② 조문 본문 렌더링 (article-detail.ts 검증 로직 이식 — 목 누락 방지 포함) ──
function renderArticleUnits(lawData: any): string {
  const rawUnits = lawData?.조문?.조문단위
  const units: any[] = toArray(rawUnits)
  let out = ""
  for (const unit of units) {
    if (unit.조문여부 !== "조문") continue
    const joNum = unit.조문번호 || ""
    const joBranch = unit.조문가지번호 || ""
    const joTitle = unit.조문제목 || ""
    const displayNum = joBranch && joBranch !== "0" ? `제${joNum}조의${joBranch}` : `제${joNum}조`

    let bodyFirst = ""
    if (unit.조문내용) bodyFirst = cleanHtml(flattenContent(unit.조문내용)).trim()
    // 조문내용이 이미 "제N조(제목)"로 시작하면 헤더 중복 출력 방지
    if (!bodyFirst.replace(/\s+/g, "").startsWith(displayNum.replace(/\s+/g, ""))) {
      out += `${displayNum}${joTitle ? ` (${joTitle})` : ""}\n`
    }
    if (bodyFirst) out += `${bodyFirst}\n`
    if (unit.항) {
      const hangList = Array.isArray(unit.항) ? unit.항 : [unit.항]
      // 번호 필드와 본문이 같은 번호로 시작하는 중복("1. 1. 인건비", "(①) ①…") 방지:
      // 본문이 이미 그 번호로 시작하면 번호를 덧붙이지 않는다
      const numbered = (rawNum: unknown, content: string, decorate: (n: string) => string): string => {
        const n = String(rawNum ?? "").trim()
        const c = content.trim()
        if (!n) return c
        const bare = n.replace(/[.()]/g, "")
        if (bare && c.replace(/^[\s(]*/, "").startsWith(bare)) return c
        return `${decorate(n)} ${c}`
      }
      const renderMok = (mokList: any[]) => {
        for (const mok of mokList) {
          const mokContent = flattenContent(mok.목내용)
          if (mokContent) out += `      ${numbered(mok.목번호, cleanHtml(mokContent), (n) => n)}\n`
        }
      }
      for (const hang of hangList) {
        const hangContent = flattenContent(hang.항내용)
        if (hangContent) out += `  ${numbered(hang.항번호, cleanHtml(hangContent), (n) => `(${n})`)}\n`

        const hoList = hang.호 ? (Array.isArray(hang.호) ? hang.호 : [hang.호]) : []
        // 법제처 JSON은 목을 호가 아닌 항 레벨 형제 배열로 주는 경우가 있다 (목 45개 누락 사고의 원인)
        const hangMokList = hang.목 ? (Array.isArray(hang.목) ? hang.목 : [hang.목]) : []
        const mokGroups = groupMokByReset(hangMokList)
        const alignable = hoList.length > 0 && mokGroups.length === hoList.length

        for (let i = 0; i < hoList.length; i++) {
          const ho = hoList[i]
          const hoContent = flattenContent(ho.호내용)
          if (hoContent) out += `    ${numbered(ho.호번호, cleanHtml(hoContent), (n) => (n.endsWith(".") ? n : `${n}.`))}\n`
          if (ho.목) renderMok(Array.isArray(ho.목) ? ho.목 : [ho.목])
          if (alignable) renderMok(mokGroups[i])
        }
        if (!alignable && hangMokList.length > 0) renderMok(hangMokList)
      }
    }
  }
  return out.trim()
}

// ── ③ 예규 검색 (ntsCgmExpc — 목록만. 본문은 fin_nts_ruling) ──────────────

/** 조문 제목에서 예규 검색어 추출 (괄호·조사 제거) */
function rulingQueryFromTitle(joTitle: string, lawName: string): string {
  const cleaned = joTitle.replace(/[()]/g, " ").replace(/\s+/g, " ").trim()
  return cleaned || lawName
}

// ── 별표 목록 (licbyl JSON — 방어적 추출) ────────────────────────────────
interface AnnexItem {
  no: string
  name: string
}

function findAnnexItems(node: any, acc: AnnexItem[], lawName: string): void {
  if (!node || typeof node !== "object") return
  if (Array.isArray(node)) {
    for (const item of node) findAnnexItems(item, acc, lawName)
    return
  }
  const name = node.별표명 || node.별표제목
  if (typeof name === "string" && name.trim()) {
    // 삭제·이동된 별표 항목은 노이즈 — 제외
    if (/^삭제|^\[?별표\s*\d+[^\]]*(이동|삭제)/.test(name.trim())) return
    // 별표 검색(search=2)이 유사 법령명까지 돌려주는 경우 방어: 법령명 필드가 있으면 대조.
    // 하위법령(시행령·시행규칙) 별표는 통과 — 기준내용연수표는 시행규칙 별표다 (골든셋 #1)
    const ownerRaw = node.법령명 || node.관련법령명 || ""
    const owner = typeof ownerRaw === "string" ? ownerRaw : flattenContent(ownerRaw)
    if (!owner || sameLawFamily(lawName, owner)) {
      acc.push({ no: String(node.별표번호 ?? "").trim(), name: name.trim() })
    }
    return
  }
  for (const v of Object.values(node)) findAnnexItems(v, acc, lawName)
}

// ── 메인 핸들러 ─────────────────────────────────────────────────────────
export async function handleFinArticle(
  apiClient: LawApiClient,
  rawInput: unknown
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const parsed = FinArticleInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    return {
      content: [
        {
          type: "text",
          text: `[INVALID_PARAMETER] fin_article: 입력 오류 — ${parsed.error.issues.map((i) => i.message).join("; ")}\n💡 예: { "law": "법인세법", "article": "제26조" }`,
        },
      ],
      isError: true,
    }
  }
  const input = parsed.data
  const deadlineAt = Date.now() + DEADLINE_MS
  const articleLabel = normalizeArticleLabel(input.article)
  const efYd = input.basis_date ? input.basis_date.replace(/-/g, "") : undefined

  // ── ① 법령 확정 ──
  let law: LawInfo
  let lawFallback = false // 정확 일치 없이 최상위 검색 결과로 폴백했는가 — 무고지 금지 (Opus I1)
  try {
    const laws = await findLaws(apiClient, input.law, undefined, 5)
    if (laws.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `[LAW_NOT_FOUND] "${input.law}" 법령을 찾지 못했습니다 (정상 조회 후 0건 — ✗없음).\n💡 법령명을 확인하거나 fin_law_search로 먼저 검색하세요.\n⚠️ LLM은 조문 내용을 추측하지 마세요.`,
          },
        ],
        isError: true,
      }
    }
    // 정확 매칭 우선(부분매칭 함정 방어: "지방세법"→지방교부세법), 다음 순위 폴백
    const exact = laws.find((l) => resolvedLawMatches(input.law, l.lawName))
    law = exact ?? laws[0]
    lawFallback = !exact
  } catch (e) {
    return {
      content: [{ type: "text", text: formatFetchFailure("법령 검색", e) }],
      isError: true,
    }
  }

  // ── ② 병렬: 조문 본문 ∥ 3단 위임 ∥ 별표 ──
  let joTitleForRulings = ""
  // deadline 도달 시 진행 중 업스트림 호출을 함께 취소 — 백그라운드 쿼터 소모 방지 (Opus I3)
  const aborter = new AbortController()
  const abortOnDeadline = () => aborter.abort()

  const articleP: Promise<SectionResult> = (async () => {
    const extraParams: Record<string, string> = { MST: law.mst, JO: buildJO(articleLabel) }
    if (efYd) extraParams.efYd = efYd
    const jsonText = await apiClient.fetchApi({ endpoint: "lawService.do", target: "eflaw", type: "JSON", extraParams, signal: aborter.signal })
    const lawData = JSON.parse(jsonText)?.법령
    if (!lawData) return failed("법령 데이터 없음 (기준일이 시행일과 안 맞을 수 있음)")
    const units: any[] = toArray(lawData?.조문?.조문단위)
    const firstArticle = units.find((u: any) => u.조문여부 === "조문")
    if (firstArticle?.조문제목) joTitleForRulings = String(firstArticle.조문제목)
    const body = renderArticleUnits(lawData)
    if (!body) return failed(`${articleLabel} 조문 없음 — 조문 번호를 확인하세요 (✗없음)`)
    return { status: "성공" as const, text: body }
  })().catch((e) => failed(e instanceof Error ? e.message : String(e)))

  const threeTierP: Promise<SectionResult> = (async () => {
    const jsonText = await apiClient.getThreeTier({ mst: law.mst, knd: "2", signal: aborter.signal })
    const data = parseThreeTierDelegation(JSON.parse(jsonText))
    const target = data.articles.find((a) => a.joNum.replace(/\s+/g, "") === articleLabel.replace(/\s+/g, ""))
    if (!target || target.delegations.length === 0) {
      return { status: "성공" as const, text: "(위임 조문 없음)" }
    }
    const dels = target.delegations

    // 3단비교가 본문(content)을 안 실어주는 경우: 시행령 위임조문 상위 3건은 직접 조회해 동봉
    // (묶음이 곧 제품 — 실무자가 다음에 물을 것을 미리 답한다)
    const bodyMap = new Map<string, string>()
    const needBody = dels.filter((d) => d.type === "시행령" && !(d.content || "").trim() && d.joNum).slice(0, 3)
    if (needBody.length > 0) {
      const fetchBodies = (async () => {
        const decreeName = data.meta.sihyungryungName || needBody[0].lawName || ""
        if (!decreeName) return
        const decreeLaws = await findLaws(apiClient, decreeName, undefined, 3)
        // 정확 일치가 없으면 동봉을 생략하고 목록 표시로 폴백 — 엉뚱한 법령의 조문을
        // "시행령 본문"으로 동봉하는 것보다 안 싣는 쪽이 안전 (Opus I1: 무고지 폴백 제거)
        const decree = decreeLaws.find((l) => resolvedLawMatches(decreeName, l.lawName))
        if (!decree) return
        await Promise.all(
          needBody.map(async (d) => {
            try {
              const extra: Record<string, string> = { MST: decree.mst, JO: buildJO(d.joNum!) }
              if (efYd) extra.efYd = efYd
              const jt = await apiClient.fetchApi({ endpoint: "lawService.do", target: "eflaw", type: "JSON", extraParams: extra, signal: aborter.signal })
              const body = renderArticleUnits(JSON.parse(jt)?.법령)
              if (body) bodyMap.set(d.joNum!, body)
            } catch {
              /* 개별 조문 실패는 목록 표시로 폴백 (부분 실패 계약) */
            }
          })
        )
      })()
      // 본문 동봉은 3초 안에 되는 만큼만 — 못 받으면 목록만 표시 (deadline 보호)
      let bodyTimer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([fetchBodies, new Promise((r) => { bodyTimer = setTimeout(r, 3000) })]).catch(() => {})
      clearTimeout(bodyTimer) // 타이머 잔존 방지 (Opus I3)
    }

    let out = ""
    for (const d of dels) {
      const label = d.type === "시행령" ? "[시행령]" : d.type === "시행규칙" ? "[시행규칙]" : "[행정규칙]"
      out += `${label} ${d.lawName || ""} ${d.joNum || ""}${d.title ? ` (${d.title})` : ""}\n`
      const body = (d.content || "").trim() || (d.joNum ? bodyMap.get(d.joNum) : "")
      if (body) out += `${cleanHtml(body).trim()}\n`
      out += `\n`
    }
    return { status: "성공" as const, text: out.trim() }
  })().catch((e) => failed(e instanceof Error ? e.message : String(e)))

  const annexP: Promise<SectionResult> = (async () => {
    const jsonText = await apiClient.getAnnexes({ lawName: law.lawName, knd: "1", signal: aborter.signal }) // 1=별표만 (서식 노이즈 제외)
    const acc: AnnexItem[] = []
    findAnnexItems(JSON.parse(jsonText), acc, law.lawName)
    if (acc.length === 0) return { status: "성공" as const, text: "없음" }
    const shown = acc.slice(0, 10)
    let out = `${acc.length}건`
    if (acc.length > shown.length) out += ` (상위 ${shown.length}건 표시 / 전체 ${acc.length}건 — 전체는 fin_annex)`
    out += "\n" + shown.map((a) => `  · ${a.no ? `[별표 ${a.no}] ` : ""}${a.name}`).join("\n")
    return { status: "성공" as const, text: out }
  })().catch((e) => failed(e instanceof Error ? e.message : String(e)))

  // 시행예정 개정 경고 — 이미 공포된 미래 개정을 모르면 개정 직전 검토에서 사고
  const upcomingP: Promise<SectionResult> = (async () => {
    const xml = await apiClient.searchLaw(law.lawName, undefined, 20, "eflaw", aborter.signal)
    const ups = parseUpcomingVersions(xml, law.lawName)
    if (ups.length === 0) return { status: "성공" as const, text: "" }
    return {
      status: "성공" as const,
      text: ups.map((u) => `${formatYmd(u.시행일자)} 시행 개정 공포됨(공포 ${formatYmd(u.공포일자)})`).join(" · "),
    }
  })().catch((e) => failed(e instanceof Error ? e.message : String(e)))

  const [articleR, threeTierR, annexR, upcomingR] = await Promise.all([
    withDeadline(articleP, deadlineAt, abortOnDeadline),
    withDeadline(threeTierP, deadlineAt, abortOnDeadline),
    withDeadline(annexP, deadlineAt, abortOnDeadline),
    withDeadline(upcomingP, deadlineAt, abortOnDeadline),
  ])

  // ── ③ 예규 검색 (조문 제목 확보 후) ──
  let rulingsR: SectionResult = { status: "성공", text: "(검색 생략 — include_rulings=false)" }
  let rulingQuery = ""
  if (input.include_rulings) {
    rulingQuery = rulingQueryFromTitle(joTitleForRulings, `${law.lawName} ${articleLabel}`)
    rulingsR = await withDeadline(
      (async () => {
        const queries = ladderQueries(rulingQuery)
        for (let qi = 0; qi < queries.length; qi++) {
          const q = queries[qi]
          // 오류는 즉시 실패로 (사다리는 0건에만 — 오류를 0건으로 위장 금지)
          const xml = await apiClient.fetchApi({
            endpoint: "lawSearch.do",
            target: "ntsCgmExpc",
            type: "XML",
            extraParams: { query: q, display: "3" },
            expectedRoot: "CgmExpc",
            signal: aborter.signal,
          })
          const total = extractTag(xml, "totalCnt")
          const items = parseNtsRulings(xml, 3)
          if (items.length === 0) continue
          const ladderNote = qi > 0 ? ` — 검색어 축약: "${rulingQuery}" → "${q}"` : ""
          let out = `${total || items.length}건 중 상위 ${items.length}건 (검색어: "${q}"${ladderNote})\n`
          out += items.map((r) => `  · ${r.docNo} (${r.date}) ${r.title}`).join("\n")
          out += `\n  ※ 본문이 필요하면 fin_nts_ruling 사용`
          return { status: "성공" as const, text: out }
        }
        return {
          status: "성공" as const,
          text: `0건 (축약 사다리 ${ladderQueries(rulingQuery).map((q) => `"${q}"`).join(" → ")} 전부 0건 — 정상 조회 결과 없음. fin_nts_ruling으로 다른 키워드 시도 가능)`,
        }
      })().catch((e) => failed(e instanceof Error ? e.message : String(e))),
      deadlineAt,
      abortOnDeadline
    )
  }

  // ── 조립 (부분 실패 계약) ──
  const sections: Array<{ name: string; r: SectionResult; budget: number; hint: string }> = [
    { name: "조문", r: articleR, budget: BUDGET_ARTICLE, hint: "www.law.go.kr 원문" },
    { name: "위임", r: threeTierR, budget: BUDGET_DELEGATION, hint: "법제처 3단비교 원문" },
    { name: "예규", r: rulingsR, budget: BUDGET_RULINGS, hint: "fin_nts_ruling" },
    { name: "별표", r: annexR, budget: BUDGET_ETC, hint: "fin_annex" },
  ]
  const failedNames = sections.filter((s) => s.r.status !== "성공").map((s) => `${s.name}(${s.r.status}: ${s.r.reason})`)
  const overall = failedNames.length === 0 ? "전체 성공" : `부분 성공 — 실패 섹션: ${failedNames.join(", ")}`

  const basisLine = input.basis_date ? `[기준일: ${input.basis_date} 시행 기준]` : `[기준: 현행]`
  const statusMark = law.status === "연혁" ? " ⚠연혁(폐지·과거본)" : ""
  const publicUrl = `https://www.law.go.kr/법령/${law.lawName}/${articleLabel}`

  const sec = (s: { name: string; r: SectionResult; budget: number; hint: string }, header: string): string => {
    if (s.r.status !== "성공") return `${header}\n  ⚠ 조회 실패(${s.r.status}): ${s.r.reason} — "없음"이 아니라 확인 불가입니다.`
    return `${header}\n${truncateWithHint(s.r.text, s.budget, s.hint)}`
  }

  const fallbackLine = lawFallback
    ? `⚠ 요청 "${input.law}"과 정확히 일치하는 법령이 없어 최상위 검색 결과 「${law.lawName}」로 조회했습니다. 의도한 법령인지 확인하세요 (다르면 fin_law_search로 정확한 명칭 검색).`
    : ``

  const text = [
    `${basisLine} ${overall}`,
    fallbackLine,
    ``,
    sec({ ...sections[0] }, `■ ${law.lawName} ${articleLabel}${statusMark}`),
    ``,
    sec({ ...sections[1] }, `■ 시행령·시행규칙 위임`),
    ``,
    sec({ ...sections[2] }, `■ 관련 국세청 예규`),
    ``,
    sec({ ...sections[3] }, `■ 별표`),
    ``,
    `■ 법령 정보 — 시행일자 ${law.effectiveDate || "미상"} · 원문: ${encodeURI(publicUrl)}`,
    upcomingR.status === "성공"
      ? upcomingR.text
        ? `■ ⚠ 개정 예정 — ${upcomingR.text}. 개정 이후 기준 검토는 basis_date로 해당 시행일을 지정`
        : ``
      : `■ 개정 예정 여부 — ⚠ 확인 실패(${upcomingR.reason}). "개정 없음"으로 단정하지 말 것`,
    ``,
    `※ 전거 서열: 이 응답의 조문(법률·시행령·시행규칙)이 1차 근거 — 예규는 행정해석(구속력 없음), 상충 시 조문 우선`,
    SOURCE_FOOTER,
  ].join("\n").replace(/\n{3,}/g, "\n\n")

  return { content: [{ type: "text", text }] }
}
