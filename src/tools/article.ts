/**
 * fin_article — 묶음 조문 조회 (fin-law-mcp의 핵심 도구)
 *
 * 1회 호출로: 조문 본문 + 시행령·시행규칙 위임조문 + 예규 후보 + 별표 + 개정 정보.
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
import {
  findLaws,
  findRepealedLaw,
  resolvedLawMatches,
  sameLawFamily,
  lawTierOf,
  type LawInfo,
  type LawTier,
} from "../lib/law-search.js"
import { formatFetchFailure, classifyErrorCode } from "../lib/errors.js"
import { resolveVersionAt, type VersionAtResult } from "../lib/historical-utils.js"
import { buildJO } from "../lib/law-parser.js"
import { cleanHtml, flattenContent, groupMokByReset } from "../lib/article-parser.js"
import {
  parseThreeTierDelegation,
  parseThreeTierRows,
  type ThreeTierRowItem,
  type ThreeTierRowSet,
} from "../lib/three-tier-parser.js"
import { isAdminRuleLikeName, findAdminRule, stripTrailingParen, parseDeletedArticle } from "./admin-rule-citation.js"
import { LATEST_FIRST_SORT, isLatestFirst, readTotalCnt } from "./ruling-search.js"
import { formatAnnexNo } from "./annex.js"
import { toArray, extractTag } from "../lib/xml-parser.js"
import { pickArticleUnit, unitJoLabel } from "../lib/article-unit.js"
import {
  type SectionResult,
  failed,
  withDeadline,
  truncateWithHint,
  ladderQueries,
  parseNtsRulings,
  parseUpcomingVersions,
  formatYmd,
  isFutureDate,
  compactName,
  isCalendarBasisDate,
  BASIS_DATE_CALENDAR_MESSAGE,
  SOURCE_FOOTER,
} from "../lib/fin-common.js"

// ── 응답 예산 (PRD 02 문서) ─────────────────────────────────────────────
const BUDGET_ARTICLE = 6000
const BUDGET_DELEGATION = 4000
const BUDGET_RULINGS = 1000
const BUDGET_ETC = 1000
const DEADLINE_MS = 6000 // 도구 전체 deadline (p95 SLO)
/** 개정 예정 확인용 eflaw 검색 한 페이지의 건수 */
const UPCOMING_PAGE_SIZE = 20

export const FinArticleInputSchema = z.object({
  law: z.string().min(1).describe("법령명 (예: 법인세법, 부가세법 등 약칭 허용)"),
  article: z.string().min(1).describe("조문 번호 (예: '제26조', '제10조의2', '26')"),
  basis_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "기준일은 YYYY-MM-DD 형식이어야 합니다")
    .refine(isCalendarBasisDate, BASIS_DATE_CALENDAR_MESSAGE)
    .optional()
    .describe("기준일 (YYYY-MM-DD). 생략 시 현행"),
  include_rulings: z.boolean().default(true).describe("관련 국세청 예규 검색 포함 여부 (기본 true)"),
})

// MCP tools/list 노출용 JSON Schema (zod와 수동 동기화)
export const FIN_ARTICLE_TOOL = {
  name: "fin_article",
  description:
    "[재무·세무·회계 전용 — 세법 조문 질의에는 이 도구를 우선 사용] " +
    "조문 1개를 물으면 조문 본문 + 위임 시행령·시행규칙 조문 + 국세청 예규 후보(조문 제목 키워드 검색 — 적용 관계 미확인) + 별표 + 개정 정보를 한 번에 반환한다. " +
    "예: 법인세법 제26조. 실무 검토의 시작점.",
  inputSchema: {
    type: "object",
    properties: {
      law: { type: "string", description: "법령명 (약칭 허용: 법인세법, 조특법, 상증세법 등)" },
      article: { type: "string", description: "조문 번호 (예: '제26조', '제10조의2')" },
      basis_date: { type: "string", description: "기준일 YYYY-MM-DD (생략 시 현행)" },
      include_rulings: { type: "boolean", description: "예규 후보 검색 포함 (기본 true — 조문 제목 키워드 검색이라 적용 관계는 미확인)" },
    },
    required: ["law", "article"],
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
} as const

interface ArticleInput {
  /** 조 단위 표기 "제26조"·"제10조의2" — 본문 JO·위임 매핑·링크가 모두 이것을 쓴다 */
  label: string
  /** 조 뒤에 붙어 온 항·호·목 등 세부 표기 ("제1항", "제1호" …). 없으면 "" */
  detail: string
}

/**
 * "제26조"/"26"/"제10조의2"/"제26조제1항"/"26조 1항"/"제26조(과다경비 등의 손금불산입)" → 조 단위.
 *
 * 전에는 완전 일치만 받아서 "제26조제1항"이 정규화되지 않고 그대로 라벨이 됐다. 그 라벨은
 * 3단비교의 "제26조"와 안 맞아 **실존하는 위임을 "(위임 조문 없음)"으로 단정**했고(9차 리뷰
 * B4, 라이브 재현: 법인세법 제26조제1항), "제10조의2제3항"은 JO 변환에서 가지번호가 잘려
 * **제10조 본문**이 제10조의2로 나갔다. 위임 매핑은 조 단위이므로 조로 접고 세부는 따로 둔다.
 *
 * 해석할 수 없으면 null — 조 표기가 없는 숫자열("1항")을 조로 읽거나, 조가 둘 이상인
 * 입력("제26조 및 제27조")의 앞 조만 조회하면 요청과 다른 조문을 답하게 된다.
 * 행정규칙 번호("제9-5조")도 null이다 (호출측이 원문 그대로 표시한다).
 */
function parseArticleInput(input: string): ArticleInput | null {
  const s = input.trim()
  const m = s.match(/^§?\s*제?\s*(\d+)\s*(조)?(?:\s*의\s*(\d+))?/)
  if (!m) return null
  const label = m[3] ? `제${m[1]}조의${m[3]}` : `제${m[1]}조`
  // 조문 제목 괄호는 세부 표기가 아니다 — 떼고 본다
  const rest = s.slice(m[0].length).replace(/^\s*\([^)]*\)/, "").trim()
  if (!rest) return { label, detail: "" }
  // "조" 없이 숫자 뒤에 무언가 붙으면("1항", "26-5") 조 번호인지 알 수 없다
  if (!m[2]) return null
  if (/^-/.test(rest) || /\d+\s*조/.test(rest)) return null
  return { label, detail: rest }
}

// ── ② 조문 본문 렌더링 (article-detail.ts 검증 로직 이식 — 목 누락 방지 포함) ──

// 요청 조문번호 대조(pickArticleUnit)는 fin_verify와 같은 규칙이라 lib/article-unit.ts로 공유한다 (외부 검토 B4)

interface RenderedUnit {
  /** 조 헤더 줄 + 조문내용 (항 이전) */
  head: string
  /** 항별 렌더링 (호·목·단서 포함). no = 항 번호(① → 1), 못 읽으면 null */
  hangs: Array<{ no: number | null; text: string }>
}

/** 항번호 표기 → 숫자 ("①"·"(99)"·"제2항"). 못 읽으면 null */
function hangNumberOf(raw: unknown): number | null {
  const s = String(raw ?? "").replace(/[\s().]/g, "")
  if (!s) return null
  const c = s.codePointAt(0)!
  if (c >= 0x2460 && c <= 0x2473) return c - 0x2460 + 1 // ①-⑳
  if (c >= 0x3251 && c <= 0x325f) return c - 0x3251 + 21 // ㉑-㉟
  if (c >= 0x32b1 && c <= 0x32bf) return c - 0x32b1 + 36 // ㊱-㊿
  const m = s.match(/^제?(\d+)항?$/)
  return m ? parseInt(m[1], 10) : null
}

function renderUnitParts(unit: any): RenderedUnit {
  const displayNum = unitJoLabel(unit) ?? `제${unit.조문번호 || ""}조`
  const joTitle = unit.조문제목 || ""

  let head = ""
  let bodyFirst = ""
  if (unit.조문내용) bodyFirst = cleanHtml(flattenContent(unit.조문내용)).trim()
  // 조문내용이 이미 "제N조(제목)"로 시작하면 헤더 중복 출력 방지
  if (!bodyFirst.replace(/\s+/g, "").startsWith(displayNum.replace(/\s+/g, ""))) {
    head += `${displayNum}${joTitle ? ` (${joTitle})` : ""}\n`
  }
  if (bodyFirst) head += `${bodyFirst}\n`
  const hangs: RenderedUnit["hangs"] = []
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
    for (const hang of hangList) {
      let out = ""
      const renderMok = (mokList: any[]) => {
        for (const mok of mokList) {
          const mokContent = flattenContent(mok.목내용)
          if (mokContent) out += `      ${numbered(mok.목번호, cleanHtml(mokContent), (n) => n)}\n`
        }
      }
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
      // 항번호 필드가 없으면 본문 첫 글자(①)로 읽는다
      hangs.push({ no: hangNumberOf(hang.항번호) ?? hangNumberOf(String(hangContent ?? "").trim().charAt(0)), text: out })
    }
  }
  return { head, hangs }
}

const joinUnit = (r: RenderedUnit): string => (r.head + r.hangs.map((h) => h.text).join("")).trim()

/**
 * 위임·모법 본문 동봉용 — **요청 조문과 번호가 같은 조문단위 1개**만 렌더링한다.
 * 일치가 없거나 여럿이면 "" (호출측은 목록 표시로 폴백한다). 번호 대조가 없으면 JO를 무시한
 * 응답의 다른 조문이 "시행령 본문"으로 동봉된다 — 조문 본문 섹션과 같은 결함(B4)
 */
function renderArticleUnits(lawData: any, joLabel: string): string {
  const label = parseArticleInput(joLabel)?.label
  const pick = label ? pickArticleUnit(lawData, label) : { kind: "none" as const }
  return pick.kind === "match" ? joinUnit(renderUnitParts(pick.unit)) : ""
}

/** 세부 표기("제99항"·"99항"·"②"·"제2항제3호")에서 항 번호. 항 지정이 없으면 null */
function detailHangNumber(detail: string): number | null {
  const s = detail.replace(/\s+/g, "")
  const m = s.match(/^제?(\d+)항/)
  if (m) return parseInt(m[1], 10)
  const first = s.charAt(0)
  return first && /[①-⑳㉑-㉟㊱-㊿]/.test(first) ? hangNumberOf(first) : null
}

interface ArticleBody {
  text: string
  /** 예산 절단 여부 — true면 헤더가 "전체 성공"이면 안 된다 (외부 검토 B3) */
  truncated: boolean
  fullLength: number
  shownLength: number
  /** 요청 항을 우선 실었는가 (조 전체 대신) */
  detailFirst: boolean
  /** 우선 실은 항 번호 — "제2항제3호" 요청이면 제2항 전체(호·단서 포함)를 싣는다 */
  detailHang?: number
  /**
   * 항을 요청했는데 그 항만 싣지 못한 사유 (detailFirst=false일 때만). 상단 고지가 절단 사실과
   * 어긋나지 않게 쓴다 (최종 검토 F2 — 절단인데 "본문은 조 전체이고"). 번호는 wantedHang.
   *  - notFound: 응답 항 번호가 모두 읽히는데 요청 번호가 없다 (절단 여부와 무관하게 알린다)
   *  - ambiguous: 같은 번호 항이 둘 이상 / noStructure: 항 구조·번호를 읽지 못함 / overBudget: 그 항 자체가 예산 초과
   */
  detailMiss?: "notFound" | "ambiguous" | "noStructure" | "overBudget"
  /** 요청 표기에서 읽은 항 번호 (항 지정이 없으면 undefined) */
  wantedHang?: number
}

/**
 * 조문 본문을 예산에 맞춘다 (외부 검토 B3).
 *
 * 전에는 조 전체를 앞에서부터 잘랐다 — 요청이 "제1조제99항"이어도 앞부분만 실려 뒤쪽 항의
 * 예외가 빠졌고, 성공 판정은 절단 전에 끝나 헤더가 "전체 성공"이었다.
 *  - 절단되면 truncated=true (헤더에 "본문 일부 절단(n자 중 m자)")
 *  - 요청 항을 구조(항번호)로 찾으면 조 머리 + 그 항(호·목·단서 포함)만 싣는다
 *  - 항 지정 없이 잘렸으면, 잘린 첫 항을 지정한 재조회가 **실제로 예산 안에 들어올 때만** 인자 예시를 준다
 */
function composeArticleBody(
  parts: RenderedUnit,
  detail: string,
  budget: number,
  hint: string,
  retry: (hangNo: number) => string
): ArticleBody {
  const full = joinUnit(parts)
  const wanted = detailHangNumber(detail)
  const hitsOf = (no: number) => parts.hangs.filter((h) => h.no === no)
  // 항 번호가 모두 읽히는데 요청 번호가 없을 때만 "찾지 못함"이라 한다 — 구조를 못 읽은 응답에서
  // 부존재를 단정하지 않는다
  const notFound =
    wanted !== null && hitsOf(wanted).length === 0 && parts.hangs.length > 0 && parts.hangs.every((h) => h.no !== null)
  const wantedHang = wanted ?? undefined
  if (full.length <= budget) {
    // 항 구분이 없는(또는 번호를 못 읽은) 조문에 항을 요청한 경우도 "조 전체"만 적으면 요청 항이
    // 확인된 것처럼 읽힌다 (라이브: 법인세법 제26조제99항 — 제26조는 항 없이 호만 있다)
    const unstructuredMiss = wanted !== null && !notFound && hitsOf(wanted).length === 0
    return {
      text: full,
      truncated: false,
      fullLength: full.length,
      shownLength: full.length,
      detailFirst: false,
      wantedHang,
      ...(notFound
        ? { detailMiss: "notFound" as const }
        : unstructuredMiss
          ? { detailMiss: "noStructure" as const }
          : {}),
    }
  }
  // 안내문 자리 — 항만 실은 본문 뒤에 붙는 고지가 예산을 넘지 않게
  const NOTICE_RESERVE = 300
  const hangOnly = (no: number): string | null => {
    const hit = hitsOf(no)
    if (hit.length !== 1) return null
    const t = (parts.head + hit[0].text).trim()
    return t.length <= budget - NOTICE_RESERVE ? t : null
  }

  if (wanted !== null) {
    const t = hangOnly(wanted)
    if (t !== null) {
      return {
        text:
          `${t}\n… (조 전체 ${full.length.toLocaleString()}자가 예산 ${budget.toLocaleString()}자를 넘어 ` +
          `요청한 제${wanted}항만 실었습니다 — 다른 항은 생략, 전체는 ${hint})`,
        truncated: true,
        fullLength: full.length,
        shownLength: t.length,
        detailFirst: true,
        detailHang: wanted,
        wantedHang,
      }
    }
  }

  const cutText = truncateWithHint(full, budget, hint)
  const noticeAt = cutText.lastIndexOf("\n… (예산")
  const shown = noticeAt >= 0 ? noticeAt : Math.min(full.length, budget)
  // 잘린 지점 뒤에서 시작하는 첫 항 — 그 항을 지정한 재조회가 예산 안에 들어오면 인자 예시를 준다
  let offset = parts.head.length
  let firstOmitted: number | null = null
  for (const h of parts.hangs) {
    // 끝 줄바꿈은 절단 때 지워지므로 빼고 잰다 — 다 실린 항을 "잘린 항"으로 예시하지 않게
    if (offset + h.text.trimEnd().length > shown && h.no !== null && h.no !== wanted) {
      firstOmitted = h.no
      break
    }
    offset += h.text.length
  }
  const retryNote = firstOmitted !== null && hangOnly(firstOmitted) !== null ? `\n💡 뒤쪽 항은 항을 지정해 다시 조회하면 그 항을 우선 싣습니다 — 예: ${retry(firstOmitted)}` : ""
  const hitCount = wanted === null ? 0 : hitsOf(wanted).length
  const detailMiss: ArticleBody["detailMiss"] =
    wanted === null
      ? undefined
      : notFound
        ? "notFound"
        : hitCount === 1
          ? "overBudget"
          : hitCount > 1
            ? "ambiguous"
            : "noStructure"
  return {
    text: cutText + retryNote,
    truncated: true,
    fullLength: full.length,
    shownLength: shown,
    detailFirst: false,
    wantedHang,
    ...(detailMiss ? { detailMiss } : {}),
  }
}

/**
 * 조 전체가 삭제된 자리표시 조문이면 삭제 표기("<2001.12.31>", 없으면 "")를, 아니면 null.
 * 판정은 fin_verify와 같은 parseDeletedArticle — 한쪽만 알면 verify는 ⚠삭제 조문인데
 * fin_article은 같은 조문에 표지 없이 위임·예규를 붙여 "살아 있는 조문"으로 읽힌다.
 * 항이 딸려 있으면 살아 있는 조문이다 (항 하나만 삭제된 "② 삭제"는 조문 삭제가 아니다)
 */
function deletedArticleStamp(unit: any): string | null {
  const content = unit?.조문내용
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map(String).join(" ") : ""
  if (!text) return null
  const hang = unit?.항
  if (hang !== undefined && hang !== null && hang !== "" && !(Array.isArray(hang) && hang.length === 0)) return null
  return parseDeletedArticle(text)
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
    // 소속 필드명이 바뀌면 owner가 비고, 아래 `!owner ||`가 무관 법령 별표를 통과시킨다
    // (fin_annex와 같은 결함 — Codex 2차 차단 3)
    const ownerRaw =
      node.법령명 || node.관련법령명 || node.법령명한글 || node.소속법령명 || node.상위법령명 || ""
    const owner = typeof ownerRaw === "string" ? ownerRaw : flattenContent(ownerRaw)
    if (!owner || sameLawFamily(lawName, owner)) {
      acc.push({ no: String(node.별표번호 ?? "").trim(), name: name.trim() })
    }
    return
  }
  for (const v of Object.values(node)) findAnnexItems(v, acc, lawName)
}

/**
 * 「외국환거래규정」(기재부 고시)처럼 법령 DB에 없는 행정규칙을 조문까지 붙여 물어오면
 * "✗없음"은 틀린 단정이 된다 — 옆 도구(fin_law_search·fin_verify)는 실존을 확인해 주는데
 * 조문 요청만 없음으로 답하던 모순(잔여①). 실존이면 이 도구의 미수록임을 밝히고 경로를 준다.
 *
 * ⚠ 이것은 제공처(법제처) 한계가 아니라 fin_article 미구현이다 — `lawService.do?target=admrul`은
 * 조문형식여부=Y 규칙의 조문 본문을 준다(2026-09-01 실측, CHANGELOG 정정). fin_verify는 그것으로
 * 조문 대조까지 한다. 문구를 "API 미지원"으로 쓰면 제품 미구현을 제공처 탓으로 돌리는 것이 된다.
 *
 * ⚠ 조회 **실패**를 null로 돌리면 안 된다: 호출측은 그것을 "행정규칙에도 없음"으로 읽어
 * `[LAW_NOT_FOUND] ✗없음`을 찍는다 — 이 함수의 목적과 정확히 반대다 (Codex 리뷰 차단 3).
 * 미발견만 null(기존 판정 경로)이고, 실패는 ⚠판정불가 문구로 구분해 돌린다.
 */
async function adminRuleNotice(
  apiClient: LawApiClient,
  name: string,
  articleLabel: string,
  signal?: AbortSignal
): Promise<string | null> {
  // 괄호가 붙으면 이름이 ')'로 끝나 규정·규칙 판정을 통과하지 못해 폴백 자체가 꺼진다
  if (!isAdminRuleLikeName(stripTrailingParen(name))) return null
  try {
    const rule = await findAdminRule(apiClient, name, undefined, signal)
    if (!rule) return null
    const meta = [rule.ruleType, rule.orgName, rule.promDate ? `발령 ${rule.promDate}` : ""].filter(Boolean).join(" · ")
    // exact=false는 이름이 겹치는 **다른** 규칙이 있다는 뜻이다 — 「국세청 사무처리규정」
    // 요청에 「…시행세칙」을 실존으로 답하면 요청과 다른 문서를 근거로 만든다 (Codex 2차 차단 2)
    if (!rule.exact) {
      return (
        `[ADMIN_RULE_AMBIGUOUS] "${name}" — 법령 DB에 없고, 행정규칙 DB에도 **정확히 일치하는** 이름이 없습니다.\n` +
        `이름이 겹치는 「${rule.name}」${meta ? ` (${meta})` : ""}만 검색되었습니다 — 같은 문서가 아닐 수 있습니다.\n` +
        `💡 정확한 명칭을 확인해 다시 요청하세요 (실존 단정 불가, 없음도 아님).\n` +
        `⚠️ LLM은 위 규칙의 내용을 요청한 규정의 내용으로 쓰지 마세요.`
      )
    }
    return (
      `[ADMIN_RULE] "${name}" — 법령(법률·시행령·부령) DB에는 없지만 **행정규칙 「${rule.name}」**${meta ? ` (${meta})` : ""}로 실존합니다.\n` +
      `⚠ fin_article은 아직 행정규칙 조문 본문을 싣지 않습니다 (v0.2 예정) — ${articleLabel}은 **"없는 조문"이 아니라 이 도구 미수록**입니다.\n` +
      `💡 조문 실존 여부는 fin_verify로 확인할 수 있고(법제처가 조문 형식으로 주는 규칙에 한함), 원문은 국가법령정보센터(law.go.kr) → 행정규칙에서 확인하세요.\n` +
      `⚠️ LLM은 조문 내용을 추측하지 마세요.`
    )
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return (
      `[${classifyErrorCode(msg)}] "${name}" — 법령 DB 0건이고, 행정규칙 DB 조회는 **실패**했습니다 — ⚠판정불가 (0건이 아님).\n` +
      `사유: ${msg}\n` +
      `💡 "${name}"은 고시·훈령일 수 있습니다 — 잠시 후 재시도하거나 fin_verify로 명칭 실존을 확인하세요.\n` +
      `⚠️ LLM은 이 결과를 "존재하지 않는 규정"으로 단정하지 마세요.`
    )
  }
}

/**
 * 현행 법령 DB에 없는 이름이 **연혁 법령**(폐지·개칭 전)인지 확인한다 (9차 리뷰 B5).
 *
 * findLaws는 현행만 찾는다. 그래서 「증권거래법」(2009-02-04 타법폐지)을 basis_date=2005-01-01로
 * 물어도 "[LAW_NOT_FOUND] … ✗없음"이 나갔다 — 실존했던 법령을 없다고 단정하는 (b)형이고,
 * 같은 서버의 fin_verify는 findRepealedLaw로 "폐지·연혁 법령 (환각 아님)"을 이미 구분한다.
 *
 *  - 연혁 법령 + basis_date → 그 시점 시행본을 해소해 조회를 잇는다 ({ law })
 *  - basis_date 없음 · 기준일에 이미 폐지 → 사실대로 고지 ({ text })
 *  - 연혁에도 없음 → null (호출측의 기존 ✗없음 판정) — 연혁 검색 목록을 전부 받았을 때만
 *  - 목록 일부만 받았는데 못 찾음 → { unconfirmed: 받은 범위 } (호출측이 ⚠판정불가 — ✗없음 아님)
 *  - 연혁 조회 실패·시행본 해소 실패 → ⚠판정불가 ({ text, isError }) — 실패를 null로
 *    돌리면 호출측이 ✗없음을 찍는다 (adminRuleNotice와 같은 함정)
 */
async function historicLawFallback(
  apiClient: LawApiClient,
  lookupName: string,
  rawName: string,
  articleLabel: string,
  efYd: string | undefined,
  signal: AbortSignal
): Promise<{ text: string; isError?: boolean } | { law: LawInfo; basisNote: string } | { unconfirmed: string } | null> {
  const { law: repealed, lookupFailed, reason, listComplete, listTotal, listReceived } = await findRepealedLaw(
    apiClient,
    lookupName,
    undefined,
    signal
  )
  // 연혁 검색은 한 페이지(30건)만 받는다 — 결과가 그보다 많으면 받은 목록의 최대 시행일은 "마지막"이 아니고,
  // 못 찾았어도 "연혁에 없음"이 입증되지 않는다 (Fable 최종 검토 F3 — verify.ts와 같은 한정)
  const listScope = listTotal !== undefined ? `전체 ${listTotal}건 중 받은 ${listReceived}건` : `받은 ${listReceived}건`
  if (lookupFailed) {
    return {
      text:
        `[${classifyErrorCode(reason || "")}] "${rawName}" — 현행 법령 DB 0건이고, 연혁(폐지·개칭 전) 법령 조회는 **실패**했습니다 — ⚠판정불가 (✗없음이 아님).\n` +
        `사유: ${reason ?? "사유 미상"}\n` +
        `💡 잠시 후 재시도하거나 fin_verify로 법령 실존을 확인하세요.\n` +
        `⚠️ LLM은 이 결과를 "존재하지 않는 법령"으로 단정하지 마세요.`,
      isError: true,
    }
  }
  // pickRepealed는 접두 일치도 받는다 — 조문 본문을 내줄 경로라 종류(본법·시행령)까지 맞춘다
  if (!repealed || !resolvedLawMatches(lookupName, repealed.lawName)) {
    // 목록이 불완전하면 "연혁에도 없음"(✗)을 단정하지 않는다 — 판정은 호출측이 현행 후보 유무와 함께 정한다
    return listComplete === false ? { unconfirmed: listScope } : null
  }

  if (!efYd) {
    return {
      text:
        `[LAW_HISTORIC] "${rawName}" — 현행 법령에는 없고 **연혁 법령 「${repealed.lawName}」**(폐지·개칭 등으로 현행이 아님)으로 확인됩니다 — ✗없음이 아닙니다.\n` +
        (listComplete === false
          ? `연혁 검색 목록 ${listScope} 안에서 가장 늦은 시행일: ${repealed.effectiveDate ? formatYmd(repealed.effectiveDate) : "미상"} — 목록 밖의 더 늦은 시행은 미확인 (폐지·개칭이 반영된 날일 수 있습니다).\n`
          : `연혁 목록의 가장 늦은 시행일: ${repealed.effectiveDate ? formatYmd(repealed.effectiveDate) : "미상"} (폐지·개칭이 반영된 날일 수 있습니다).\n`) +
        `💡 그 시점 조문은 basis_date(YYYY-MM-DD)를 지정해 다시 요청하세요 — 기준일 시행본에서 ${articleLabel} 조문을 찾습니다.\n` +
        `⚠️ LLM은 현행 법령의 같은 번호 조문으로 대신하거나 내용을 추측하지 마세요.`,
    }
  }

  const { slice, reason: why } = await resolveVersionAt(apiClient, repealed.lawName, efYd, undefined, signal)
  if (!slice) {
    return {
      text:
        `[BASIS_DATE_UNRESOLVED] "${rawName}" — 현행에는 없는 연혁 법령 「${repealed.lawName}」이지만, ${formatYmd(efYd)} 시점 시행본을 확정하지 못했습니다 — ⚠판정불가 (없음이 아님).\n` +
        `사유: ${why}\n` +
        `💡 기준일을 바꿔 다시 요청하세요. LLM은 과거 조문을 추측하지 마세요.`,
      isError: true,
    }
  }
  // 기준일 이하 가장 늦은 슬라이스가 폐지 행이면 그날부터 효력이 없다
  // (실측 2026-09-16: 증권거래법 eflaw 최신 행 = 2009-02-04 시행 "타법폐지").
  // "폐지제정"은 구법 폐지와 동명 신법 제정이 한 행이라 폐지가 아니다 (historical-utils 참고)
  if (/폐지/.test(slice.rrCls) && !/폐지제정/.test(slice.rrCls)) {
    return {
      text:
        `[LAW_REPEALED] "${rawName}" — 연혁 법령 「${repealed.lawName}」은 기준일 ${formatYmd(efYd)}에 **이미 폐지**된 상태입니다 ` +
        `(${formatYmd(slice.efYd)} 시행 ${slice.rrCls}) — 그 날짜에 시행 중인 조문이 없습니다.\n` +
        `💡 폐지 전 조문은 ${formatYmd(slice.efYd)} 이전 날짜를 basis_date로 지정하세요.\n` +
        `⚠️ LLM은 이 법령의 조문을 기준일 당시 유효한 규정으로 쓰지 마세요.`,
    }
  }
  return {
    law: { ...repealed, mst: slice.mst, effectiveDate: slice.efYd, status: "연혁" },
    basisNote: slice.efYd === efYd ? "" : ` (해당일 시행본 없음 → 직전 개정본 ${formatYmd(slice.efYd)} 시행 기준으로 조회)`,
  }
}

// ── 역방향 위임 해소 (시행령·시행규칙 조문 → 모법 조문) ──────────────────
//
// 법제처 3단비교는 **기준법령(모법) 조번호로만 색인**된다 — 시행령 MST로 호출해도
// 같은 모법 매핑이 온다(2026-09-05 실측). 이 사실을 모르고 시행령 §45를 물으면서
// 배열에서 "제45조"를 찾으면 **모법 §45**(합병 시 이월결손금 승계)의 위임이
// 시행령 §45(복리후생비)의 위임으로 실린다 — 무관한 조문이 "위임"이 되는 오검증이다.
// 그래서 하위법령 입력이면 매핑을 뒤집어 "이 조문을 위임한 모법 조문"을 찾는다.

const REVERSE_BODY_LIMIT = 2
const REVERSE_BODY_MS = 3000

/**
 * 하위법령 이름에서 모법 이름 도출 ("소득세법 시행령" → "소득세법").
 * 응답의 기준법령이 **이 법령의 모법이 맞는지** 대조하는 데 쓴다 —
 * 표시용 폴백으로 쓰면 추측한 이름이 진짜 기준법령인 양 실린다 (2026-09-06 실측 결함).
 */
function guessBaseLawName(name: string): string {
  return name.replace(/\s*시행(?:령|규칙)\s*$/, "").trim()
}

interface ReverseHit {
  baseJo: string
  baseJoNum: string
  /** 같은 행에 있던 반대편 하위법령 조문 표기 (시행령 입력이면 시행규칙, 반대도 성립) */
  siblings: string[]
}

/**
 * 모법 MST로 3단비교 표를 다시 받는다 — 하위법령 MST가 다른 기준법령의 표를 줬을 때.
 * 모법 이름(guessBaseLawName)은 **조회어로만** 쓴다: 받은 표의 기준법령명이 그 이름과
 * 일치하는지 호출측이 다시 확인하므로 추측한 이름이 기준법령인 양 실리지 않는다.
 */
async function fetchParentThreeTier(
  apiClient: LawApiClient,
  parentName: string,
  signal: AbortSignal
): Promise<{ rowSet?: ThreeTierRowSet; failure?: string }> {
  try {
    // 인자는 아래 본문 동봉의 findLaws와 같게 — 같은 캐시 키라 모법 해소가 한 번으로 끝난다
    const parents = await findLaws(apiClient, parentName, undefined, 3, 100, signal)
    const parent = parents.find((l) => resolvedLawMatches(parentName, l.lawName))
    if (!parent) return { failure: `모법 「${parentName}」을 법령 검색에서 정확히 찾지 못함` }
    const jsonText = await apiClient.getThreeTier({ mst: parent.mst, knd: "2", signal })
    return { rowSet: parseThreeTierRows(JSON.parse(jsonText)) }
  } catch (e) {
    return { failure: e instanceof Error ? e.message : String(e) }
  }
}

async function renderReverseDelegation(params: {
  apiClient: LawApiClient
  law: LawInfo
  tier: LawTier
  articleLabel: string
  rowSet: ThreeTierRowSet
  outerSignal: AbortSignal
  /** 도구 deadline — 모법 표 재조회로 늘어난 시간만큼 본문 동봉 예산을 줄인다 */
  deadlineAt: number
}): Promise<string> {
  const { apiClient, law, tier, articleLabel, outerSignal, deadlineAt } = params
  let rowSet = params.rowSet

  // 이름이 시행령·시행규칙이 아닌데 기준법령이 다르다 = 어느 열을 뒤져야 할지 모른다.
  // 추측해서 아무 열이나 대조하면 다시 무관 조문이 "위임"으로 실린다 — 생략+고지.
  // 기준법령의 조문 번호는 이 조문 번호와 다르다 — "해당 조문"이라고 쓰면 같은 번호로 유도한다
  if (tier === "본법") {
    return (
      `(위임 조회 생략 — 법제처 3단비교는 「${rowSet.baseLawName}」 조문 기준으로만 색인되어 ` +
      `「${law.lawName}」 ${articleLabel}의 위임 관계는 이 응답에서 확정할 수 없습니다.\n` +
      `💡 이 조문을 위임한 「${rowSet.baseLawName}」 조문을 알면 그 조문으로 fin_article을 호출해 정방향 위임 목록에서 확인하세요 ` +
      `(조문 번호는 이 조문의 번호와 다를 수 있습니다).\n` +
      `⚠️ LLM은 위임 조문을 추측하지 마세요 — "위임 없음"이 아니라 조회 미지원입니다)`
    )
  }

  // 하위법령 입력이라 해서 응답의 기준법령이 이 법령의 **모법**이라는 보장은 없다.
  // 법제처 3단비교는 하위법령 MST로 부르면 **다른 기준법령의 표**를 돌려줄 때가 있다
  // (2026-09-06 raw 실측 18건 중 4건 어긋남. 괄호 안은 법률조문 배열 원본 행 수):
  //   법인세법 시행령 283635 → 「법인세법」(499) ✓ / 부가가치세법 시행령 283641 → 「부가가치세법」(189) ✓
  //   소득세법 시행령 286211 → 「법인세법」(499) ✗ / 소득세법 시행규칙 286379 → 「국세기본법」(216) ✗
  //   법인세법 시행규칙 287787 → 「국세기본법」(216) ✗ / 근로기준법 시행령 270551 → 「공휴일에 관한 법률」(5) ✗
  // 원인(9차 리뷰 규명): 그 하위법령을 위임한 기준법령이 여럿이면 `기준법령목록`이 배열로 오고
  // 표는 **첫 항목**의 것이다 — 소득세법 시행령 → ["법인세법","소득세법","지방세특례제한법"].
  // 그 표에서 조번호만 맞춰 뒤지면 다른 법령의 조문이 "모법 위임 근거"로 확신형으로 실린다
  // (실측: 「소득세법 시행령」 §38(근로소득의 범위)에 법인세법 §24(기부금의 손금불산입)).
  // 그래서 목록에 모법이 있으면 **모법 MST로 한 번 더** 받는다 (리뷰어 실측: 5건 모두 모법 MST
  // 표에 자기 위임이 온전히 있음 — 351·231·250·60·11건). 기준법령명이 비었거나 표 자체가
  // 없는 응답(국세징수법 시행규칙 284983: 삼단비교존재여부 N)도 같다. 목록에 모법이 없으면
  // 다시 받을 근거가 없으니 생략+고지를 유지한다.
  const expectedBase = guessBaseLawName(law.lawName)
  const isParentTable = (rs: ThreeTierRowSet) => !!rs.baseLawName && resolvedLawMatches(expectedBase, rs.baseLawName)
  const firstBaseName = rowSet.baseLawName
  let refetchFailure = ""
  if (!isParentTable(rowSet)) {
    const listed = rowSet.baseLawNames.some((n) => resolvedLawMatches(expectedBase, n))
    if (listed || !rowSet.baseLawName) {
      const r = await fetchParentThreeTier(apiClient, expectedBase, outerSignal)
      if (r.rowSet) rowSet = r.rowSet
      else refetchFailure = r.failure || "사유 미상"
    }
  }
  if (!isParentTable(rowSet)) {
    const cause = refetchFailure
      ? `${firstBaseName ? `응답은 「${firstBaseName}」 기준 표여서` : "응답에 기준법령 표가 없어"} 모법 「${expectedBase}」 기준 표를 다시 조회했으나 **실패**했습니다(${refetchFailure}) — "없음"이 아니라 확인 불가입니다`
      : rowSet !== params.rowSet
        ? `모법 「${expectedBase}」 MST로 다시 조회한 표도 ${rowSet.baseLawName ? `「${rowSet.baseLawName}」 기준이어서` : "기준법령명이 없어"} 모법 기준 표를 확보하지 못했습니다`
        : `응답은 「${firstBaseName}」 기준 표이고, 기준법령목록(${rowSet.baseLawNames.map((n) => `「${n}」`).join("·") || "없음"})에 이 법령의 모법(「${expectedBase}」)이 없습니다`
    return (
      `(위임 조회 생략 — 「${law.lawName}」 ${articleLabel}의 모법 위임 근거를 확정할 수 없습니다. ${cause}.\n` +
      `법제처 3단비교는 하위법령으로 조회하면 다른 기준법령의 표를 돌려주는 경우가 있어(실측), ` +
      `조번호만 같은 **다른 법령의 조문**이 "모법"으로 실리는 것을 막기 위해 생략했습니다.\n` +
      `💡 이 조문을 위임한 「${expectedBase}」 조문을 알면 그 조문으로 fin_article을 호출해 정방향 위임 목록에서 확인하세요 ` +
      `(모법 조문 번호는 이 조문의 번호와 보통 다릅니다).\n` +
      `⚠️ LLM은 모법 조문을 추측하지 마세요 — "위임 없음"이 아니라 조회 미지원입니다)`
    )
  }

  // 여기 도달했으면 기준법령 = 이 법령의 모법임이 위에서 확인됐다 (추측한 이름은 쓰지 않는다)
  const baseName = rowSet.baseLawName
  const siblingTier = tier === "시행령" ? "시행규칙" : "시행령"
  const target = articleLabel.replace(/\s+/g, "")
  const sameNo = (i: ThreeTierRowItem) => !!i.joNum && i.joNum.replace(/\s+/g, "") === target

  // 열별 법령명 폴백 — 법제처는 같은 열에서도 법령명을 비워 보내는 행이 있다(실측).
  // 열에서 아무 이름이나 집으면 특례규정·직제 같은 다른 하위법령 이름이 붙는다 —
  // 같은 법령 계열의 짝(「소득세법 시행규칙」 ↔ 「소득세법 시행령」)이 열에 있을 때만 쓴다
  const familySibling = `${expectedBase} ${siblingTier}`
  const siblingLawName =
    rowSet.rows
      .flatMap((r) => (siblingTier === "시행규칙" ? r.rules : r.decrees))
      .map((i) => i.lawName)
      .find((n) => n && resolvedLawMatches(familySibling, n)) || ""

  // 이 조문을 위임한 모법 조문 수집 (같은 모법 조문이 여러 행에 걸치면 하나로 묶는다).
  //
  // ⚠ 조번호만 보면 안 된다 — 모법 표의 시행령 열에는 **다른 하위법령**의 조문도 섞여 온다
  // (9차 리뷰 B1, raw 실측: 조세특례제한법 표의 시행령 열에 「농ㆍ축산ㆍ임ㆍ어업용 기자재 …
  // 특례규정」 31건·「외국인관광객 등에 대한 … 특례규정」 4건, 국세기본법 표에 「국무조정실과
  // 그 소속기관 직제」 6건). 조번호만 맞추면 「국세기본법 시행령」 §18에 직제 §18의 모법인
  // 국세기본법 §67(조세심판원)이 [모법]으로 실린다 — 리뷰어 전수 계산 38개 조문 중 33개 노출.
  // 그래서 항목의 법령명이 조회한 하위법령과 일치하는 것만 인정한다.
  //
  // 법령명이 **빈** 항목은 그것만으로는 소속을 알 수 없다. raw 실측으로는 빈 항목마다 같은
  // (모법 조문, 조번호)에 이름 있는 짝이 있었다(법인세법 64·소득세법 46·조특법 120건 전부) —
  // 짝이 우리 법령뿐이면 우리 것이고(그 행의 짝 조문도 함께 보여준다), 짝이 다른 법령이면
  // 그 법령 것이다. 짝이 없는 빈 항목만 "소속 미확인"으로 고지한다 (오검증보다 누락 고지)
  const own = (i: ThreeTierRowItem) => !!i.lawName && resolvedLawMatches(law.lawName, i.lawName)
  const byBase = new Map<string, { baseJoNum: string; own: boolean; foreign: boolean; rows: typeof rowSet.rows }>()
  for (const row of rowSet.rows) {
    const candidates = (tier === "시행령" ? row.decrees : row.rules).filter(sameNo)
    if (candidates.length === 0) continue
    const b = byBase.get(row.baseJo) || { baseJoNum: row.baseJoNum, own: false, foreign: false, rows: [] }
    if (candidates.some(own)) b.own = true
    if (candidates.some((i) => i.lawName && !own(i))) b.foreign = true
    b.rows.push(row)
    byBase.set(row.baseJo, b)
  }
  const hitMap = new Map<string, ReverseHit>()
  for (const [baseJo, b] of byBase) {
    if (!b.own) continue
    const hit: ReverseHit = { baseJo, baseJoNum: b.baseJoNum, siblings: [] }
    for (const row of b.rows) {
      const candidates = (tier === "시행령" ? row.decrees : row.rules).filter(sameNo)
      // 이 행의 항목이 우리 것이 확실할 때만 짝을 싣는다 — 이름 빈 행은 같은 모법 조문에 다른 법령 짝이 없을 때만
      if (!candidates.some(own) && (b.foreign || candidates.some((i) => i.lawName))) continue
      for (const s of siblingTier === "시행규칙" ? row.rules : row.decrees) {
        if (!s.joNum) continue
        const label = `${s.lawName || siblingLawName || "(법령명 미표기)"} ${s.joNum}${s.title ? ` (${s.title})` : ""}`
        if (!hit.siblings.includes(label)) hit.siblings.push(label)
      }
    }
    hitMap.set(baseJo, hit)
  }
  const hits = [...hitMap.values()].sort((a, b) => a.baseJo.localeCompare(b.baseJo))
  const unowned = [...byBase.entries()]
    .filter(([, b]) => !b.own && !b.foreign)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, b]) => b.baseJoNum)
  // 모법 조문 번호는 나열하지 않는다 — 번호가 보이면 "소속 미확인"이라고 적어도 위임 근거로 읽힌다
  // (검수 결정 9/17. 실데이터에서는 이 경우가 0건이라 잃는 정보가 없다)
  const unownedNote =
    unowned.length > 0
      ? `\n※ 3단비교에 법령명이 비어 있는 같은 번호(${articleLabel}) 매핑 ${unowned.length}건은 어느 하위법령 조문인지 **소속을 확인할 수 없어 싣지 않았습니다** ` +
        `— 위임 근거 없음이 아니라 소속 미확인입니다`
      : ""

  const self = `「${law.lawName}」 ${articleLabel}`
  const notice =
    `※ 역방향 조회 — 법제처 3단비교는 모법(「${baseName}」) 조문 기준으로만 색인됩니다. ` +
    `${self} — 이 조문을 **위임한 모법 조문**을 역으로 찾은 결과입니다`

  if (hits.length === 0) {
    return (
      `(${self} — 이 조문을 위임한 모법 조문을 3단비교에서 찾지 못했습니다 — ` +
      `위임 매핑 미발견이지 "위임 근거 없음"이 아닙니다.\n` +
      `💡 이 조문을 위임한 「${baseName}」 조문을 알면 그 조문으로 fin_article을 호출해 정방향 위임 목록에서 확인하세요 ` +
      `(모법 조문 번호는 이 조문의 번호와 보통 다릅니다).\n` +
      `⚠️ LLM은 모법 조문을 추측하지 마세요)\n${notice}${unownedNote}`
    )
  }

  // 모법 조문 본문 동봉 — 상위 REVERSE_BODY_LIMIT건. 정방향 bodyMap과 같은 방식이다
  // (모법 MST를 findLaws로 해소하고, 정확 일치가 없으면 목록 표시로 폴백).
  // 예산은 도구 deadline 안쪽으로 줄인다 — 모법 표를 다시 받느라 시간을 썼으면 본문을
  // 기다리다 위임 목록까지 통째로 "시간초과"가 되는 것보다 목록만 내는 쪽이 낫다
  const BODY_DEADLINE_MARGIN_MS = 500
  const bodyBudget = Math.min(REVERSE_BODY_MS, deadlineAt - Date.now() - BODY_DEADLINE_MARGIN_MS)
  const bodyMap = new Map<string, string>()
  let baseUnresolved = false
  const needBody = bodyBudget > 0 ? hits.slice(0, REVERSE_BODY_LIMIT) : []
  const bodyAborter = new AbortController()
  const onOuterAbort = () => bodyAborter.abort()
  outerSignal.addEventListener("abort", onOuterAbort, { once: true })
  const fetchBodies = (async () => {
    if (needBody.length === 0) return
    const baseLaws = await findLaws(apiClient, baseName, undefined, 3, 100, bodyAborter.signal)
    // 정확 일치가 없으면 본문을 붙이지 않는다 — 엉뚱한 법령의 조문을 "모법 본문"으로
    // 동봉하는 것이 이 수정이 막으려는 바로 그 오류다
    const base = baseLaws.find((l) => resolvedLawMatches(baseName, l.lawName))
    if (!base) {
      // 조회를 시도하지 않았다 — "조회 실패·시간 초과"와 사유를 구분한다 (최종 검토 참고 1과 같은 모양)
      baseUnresolved = true
      return
    }
    await Promise.all(
      needBody.map(async (h) => {
        try {
          const jt = await apiClient.fetchApi({
            endpoint: "lawService.do",
            target: "law",
            type: "JSON",
            extraParams: { MST: base.mst, JO: buildJO(h.baseJoNum) },
            signal: bodyAborter.signal,
            expectedJsonKey: "법령",
          })
          const body = renderArticleUnits(JSON.parse(jt)?.법령, h.baseJoNum)
          if (body) bodyMap.set(h.baseJo, body)
        } catch {
          /* 개별 조문 실패는 목록 표시로 폴백 (부분 실패 계약) */
        }
      })
    )
  })()
  let bodyTimer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    fetchBodies,
    new Promise((r) => {
      bodyTimer = setTimeout(() => {
        bodyAborter.abort()
        r(undefined)
      }, Math.max(0, bodyBudget))
    }),
  ]).catch(() => {})
  clearTimeout(bodyTimer)
  outerSignal.removeEventListener("abort", onOuterAbort)

  // 소속 미확인 고지는 위에 둔다 — 모법 본문이 길면 섹션 예산 절단에 끝부분이 잘린다
  let out = `${notice}${unownedNote}\n\n`
  for (const h of hits) {
    out += `[모법] ${baseName} ${h.baseJoNum}\n`
    const body = bodyMap.get(h.baseJo)
    if (body) out += `${cleanHtml(body).trim()}\n`
    if (h.siblings.length > 0) out += `  ↳ 같은 위임 행의 ${siblingTier}: ${h.siblings.join(" · ")}\n`
    out += `\n`
  }
  // 상한 초과와 조회 실패는 원인이 다르다 — 뭉뚱그리면 재시도할 이유가 사라진다
  const missing = hits.length - bodyMap.size
  if (missing > 0) {
    const causes: string[] = []
    const overflow = hits.length - needBody.length
    const failedCount = needBody.length - bodyMap.size
    if (bodyBudget <= 0) causes.push(`${overflow}건은 도구 응답 시간 예산 소진으로 본문 조회를 생략 — "본문 없음"이 아님`)
    else if (overflow > 0) causes.push(`${overflow}건은 상위 ${REVERSE_BODY_LIMIT}건 상한 초과(응답 시간 예산)`)
    if (failedCount > 0) {
      causes.push(
        baseUnresolved
          ? `${failedCount}건은 모법(「${baseName}」)을 법령 검색에서 정확히 특정하지 못해 본문 조회 생략 — "본문 없음"이 아님`
          : `${failedCount}건은 조회 실패·시간 초과 — "본문 없음"이 아님`
      )
    }
    out += `\n※ 모법 조문 본문 ${missing}건은 조문 번호만 표시했습니다 (${causes.join(" / ")}). 본문은 fin_article("${baseName}", "<조번호>")로 조회하세요`
  }
  return out.trim()
}

// ── 메인 핸들러 ─────────────────────────────────────────────────────────
/**
 * p가 끝나기 전에 signal이 abort되면 취소 오류로 끝낸다. 하위 호출이 signal을 존중하지 않아도
 * (세마포어 대기·signal 미전달 경로) 핸들러는 deadline·호출 취소 시점에 돌아온다.
 * 메시지의 "취소됨"은 classifyErrorCode가 TIMEOUT으로 분류하는 표지다.
 * abort 직후 잠깐(ABORT_GRACE_MS) 기다린다 — signal을 존중하는 하위 호출은 그 안에 자기 판정
 * (연혁 경로의 [BASIS_DATE_UNRESOLVED] 등)으로 끝나고, 그 문구가 일반 취소 문구보다 정확하다
 */
const ABORT_GRACE_MS = 100
function untilAborted<T>(p: Promise<T>, signal: AbortSignal, why: () => string): Promise<T> {
  if (signal.aborted) {
    p.catch(() => {}) // 이미 시작된 p의 거절이 처리되지 않은 거절로 새지 않게
    return Promise.reject(new Error(why()))
  }
  return new Promise<T>((resolve, reject) => {
    let grace: ReturnType<typeof setTimeout> | undefined
    const onAbort = () => {
      grace = setTimeout(() => reject(new Error(why())), ABORT_GRACE_MS)
    }
    signal.addEventListener("abort", onAbort, { once: true })
    const settle = () => {
      signal.removeEventListener("abort", onAbort)
      clearTimeout(grace)
    }
    p.then(
      (v) => {
        settle()
        resolve(v)
      },
      (e) => {
        settle()
        reject(e)
      }
    )
  })
}

/** 호출자 취소(MCP 요청 취소)를 도구 내부 aborter에 잇는다. 해제 함수를 돌려준다 */
function linkAbort(parent: AbortSignal | undefined, child: AbortController): () => void {
  if (!parent) return () => {}
  if (parent.aborted) {
    child.abort()
    return () => {}
  }
  const onAbort = () => child.abort()
  parent.addEventListener("abort", onAbort, { once: true })
  return () => parent.removeEventListener("abort", onAbort)
}

export async function handleFinArticle(
  apiClient: LawApiClient,
  rawInput: unknown,
  ctx: { signal?: AbortSignal } = {}
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
  const articleInput = parseArticleInput(input.article)
  // 해석 못 한 표기는 원문 그대로 둔다 — 행정규칙 안내("제9-5조")는 원문 표기가 맞다.
  // 법령 조문 조회로 넘어가기 전에 아래에서 거절한다
  const articleLabel = articleInput?.label ?? input.article.trim()
  const efYd = input.basis_date ? input.basis_date.replace(/-/g, "") : undefined

  // ① 단계의 행정규칙 폴백에도 도구 deadline을 건다 — 이게 없으면 6초 예산을
  // 넘겨도 행정규칙 조회가 재시도까지 다 소진한다 (Codex 2차 중요: 폴백이 abort
  // controller 생성보다 앞서 실행된다)
  const lookupAborter = new AbortController()
  const lookupTimer = setTimeout(() => lookupAborter.abort(), Math.max(0, deadlineAt - Date.now()))
  // 첫 검색부터 deadline·호출 취소 안에 둔다 (외부 검토 I4: findLaws에 signal이 없어 첫 검색이
  // 6.6초 지연되면 핸들러도 6.6초 뒤에야 돌아왔고, 호출자가 취소해도 요청이 계속 나갔다)
  const unlinkLookup = linkAbort(ctx.signal, lookupAborter)
  const abortWhy = () =>
    ctx.signal?.aborted
      ? "요청 취소됨(호출자 취소) — 이후 조회를 하지 않음"
      : `요청 취소됨(도구 deadline) — ${DEADLINE_MS / 1000}초 예산 안에 응답이 없어 중단`

  // ── ① 법령 확정 ──
  // 조회·일치 판정은 괄호를 뗀 이름으로 — "법인세법(법률 제19193호로 개정된 것)"을
  // 그대로 조회하면 실존 법령이 "정상 조회 후 0건 — ✗없음"으로 단정된다.
  // 12def7e의 괄호 확대가 adminRuleNotice에만 닿고 본 경로에는 안 닿았던 자리
  // (Claude 리뷰 중요 7 — fin_law_search는 같은 입력의 괄호를 떼고 찾는다)
  const lawLookup = stripTrailingParen(input.law)
  let law: LawInfo
  // 연혁 법령(폐지·개칭 전)으로 확정됐는가 — 그때는 기준일 시행본까지 이미 해소돼 있다
  let historic = false
  let basisNote = ""
  try {
    const laws = await untilAborted(
      findLaws(apiClient, lawLookup, undefined, 5, 100, lookupAborter.signal),
      lookupAborter.signal,
      abortWhy
    )
    // 정확 매칭 우선(부분매칭 함정 방어: "지방세법"→지방교부세법)
    const exact = laws.find((l) => resolvedLawMatches(lawLookup, l.lawName))
    if (exact) {
      law = exact
    } else {
      // LIKE 검색이 이름만 비슷한 법령을 물어와도 실제 대상이 행정규칙일 수 있다
      // (0건일 때만 확인하면 노이즈 1건에 폴백이 꺼진다 — 잔여②와 같은 함정)
      const notice = await untilAborted(
        adminRuleNotice(apiClient, input.law, articleLabel, lookupAborter.signal),
        lookupAborter.signal,
        abortWhy
      )
      if (notice) return { content: [{ type: "text", text: notice }] }
      // 연혁 법령도 같은 함정이다 — 「특별소비세법」은 이름이 비슷한 「개별소비세법」이 걸려도
      // 연혁으로 실존한다. 0건일 때만 보면 노이즈 1건에 확인이 꺼진다
      const hist = await untilAborted(
        historicLawFallback(apiClient, lawLookup, input.law, articleLabel, efYd, lookupAborter.signal),
        lookupAborter.signal,
        abortWhy
      )
      if (hist && "text" in hist) {
        return { content: [{ type: "text", text: hist.text }], ...(hist.isError ? { isError: true } : {}) }
      }
      if (hist && "law" in hist) {
        law = hist.law
        historic = true
        basisNote = hist.basisNote
      } else if (laws.length === 0 && hist) {
        // 연혁 검색 목록을 다 받지 못한 채 못 찾았다 — "현행·연혁 모두 0건(✗없음)"은 입증되지 않았다
        return {
          content: [
            {
              type: "text",
              text:
                `[LAW_UNRESOLVED] "${input.law}" — 현행 법령 DB 0건이고, 연혁(폐지·개칭 전) 법령은 연혁 검색 목록 ${hist.unconfirmed} 안에서 찾지 못했습니다 — ⚠판정불가 (✗없음이 아님: 목록 밖은 미확인).\n` +
                `💡 정식 법령명을 확인하거나 fin_law_search로 먼저 검색하세요. 연혁 법령이면 fin_verify로 실존을 확인하세요.\n` +
                `⚠️ LLM은 이 결과를 "존재하지 않는 법령"으로 단정하지 말고, 조문 내용을 추측하지 마세요.`,
            },
          ],
          isError: true,
        }
      } else if (laws.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `[LAW_NOT_FOUND] "${input.law}" 법령을 찾지 못했습니다 (현행·연혁 모두 정상 조회 후 0건 — ✗없음).\n💡 법령명을 확인하거나 fin_law_search로 먼저 검색하세요.\n⚠️ LLM은 조문 내용을 추측하지 마세요.`,
            },
          ],
          isError: true,
        }
      } else {
        // 정확 일치가 없으면 조문 본문을 주지 않는다 — 경고를 붙여도 LLM이 본문을
        // 그대로 인용하면 무관한 법령의 조문이 검토서에 실린다
        // ("국조법" → 「국정감사 및 조사에 관한 법률」 실측, Opus I-d)
        const candidates = laws.slice(0, 5).map((l) => `  · ${l.lawName} [${l.lawType}]${l.status === "연혁" ? " ⚠연혁" : ""}`).join("\n")
        return {
          content: [
            {
              type: "text",
              text:
                `[LAW_AMBIGUOUS] "${input.law}"과 정확히 일치하는 법령이 없습니다 — ⚠판정불가 (없음이 아님).\n` +
                `조문 본문은 생략했습니다. 아래 후보 중 의도한 법령의 **정확한 명칭**으로 다시 요청하세요.\n\n` +
                `검색된 유사 법령:\n${candidates}\n\n` +
                `⚠️ LLM은 위 후보의 조문 내용을 추측하지 마세요. 약칭을 썼다면 정식 명칭으로 바꿔 재시도하세요.`,
            },
          ],
          isError: true,
        }
      }
    }
  } catch (e) {
    return {
      content: [{ type: "text", text: formatFetchFailure("법령 검색", e) }],
      isError: true,
    }
  } finally {
    // 타이머 잔존 방지 — 이후 단계는 자체 aborter를 쓴다
    clearTimeout(lookupTimer)
    unlinkLookup()
  }

  // 법령으로 확정된 뒤에만 조문 표기를 거절한다 — 행정규칙·연혁 안내는 원문 표기로 충분하다.
  // 조로 못 접는 표기를 그대로 두면 buildJO가 앞 숫자만 떼어 **다른 조문**을 답한다
  // ("부칙 제3조" → 본칙 제3조, "제26조 및 제27조" → 제26조만)
  if (!articleInput) {
    return {
      content: [
        {
          type: "text",
          text:
            `[INVALID_PARAMETER] fin_article: 조문 번호 "${input.article}"를 조 단위로 해석하지 못했습니다 — ` +
            `조문 1개를 "제26조"·"제10조의2"·"제26조제1항" 형태로 지정하세요.\n` +
            `💡 여러 조문은 조문마다 따로 호출하세요. 부칙은 이 도구가 조회하지 않고, 별표는 fin_annex를 쓰세요.\n` +
            `⚠️ LLM은 조문 번호를 추측해 바꾸지 마세요.`,
        },
      ],
      isError: true,
    }
  }

  // ── ①-b 기준일 버전 해소 ──
  // 현행 MST에 과거 efYd만 붙이면 법제처는 빈 응답을 준다(실측) — 기준일 시점에
  // 시행 중이던 버전의 MST를 먼저 확보해야 그 시점 조문이 나온다.
  // (연혁 법령은 historicLawFallback이 같은 해소를 이미 했다)
  if (efYd && !historic) {
    // 이 해소에도 남은 도구 예산을 건다 — signal 없이 부르면 ①의 lookupTimer는 위 finally에서
    // 이미 해제됐고 ②의 aborter는 아직 없어서, 이 한 호출만 deadline 밖에 놓인다:
    // 동시성 세마포어 대기에는 상한이 없고(api-client drfFetch), 콜당 3초 × 3시도 + backoff는
    // 6초 예산을 넘겨도 아무도 끊지 못한다(DRF_RETRY). 취소는 resolveVersionAt 안에서 reason으로
    // 돌아오므로 결과는 "조문 없음"이 아니라 ⚠판정불가다 (연혁 경로는 lookupAborter가 같은 일을 한다)
    const basisAborter = new AbortController()
    const basisTimer = setTimeout(() => basisAborter.abort(), Math.max(0, deadlineAt - Date.now()))
    const unlinkBasis = linkAbort(ctx.signal, basisAborter)
    let resolved: VersionAtResult
    try {
      resolved = await untilAborted(
        resolveVersionAt(apiClient, law.lawName, efYd, undefined, basisAborter.signal),
        basisAborter.signal,
        abortWhy
      ).catch((e): VersionAtResult => ({ reason: e instanceof Error ? e.message : String(e) }))
    } finally {
      clearTimeout(basisTimer)
      unlinkBasis()
    }
    const { slice, reason } = resolved
    if (slice) {
      law = { ...law, mst: slice.mst, effectiveDate: slice.efYd, status: slice.efYd === law.effectiveDate ? law.status : "연혁" }
      basisNote =
        slice.efYd === efYd
          ? ""
          : ` (해당일 시행본 없음 → 직전 개정본 ${formatYmd(slice.efYd)} 시행 기준으로 조회)`
    } else {
      return {
        content: [
          {
            type: "text",
            text:
              `[BASIS_DATE_UNRESOLVED] "${input.law}"의 ${input.basis_date} 시점 시행본을 확정하지 못했습니다 — ⚠판정불가 (없음이 아님).\n` +
              `사유: ${reason}\n` +
              `💡 기준일을 빼고 현행으로 조회하거나, 법령명 표기를 확인하세요. LLM은 과거 조문을 추측하지 마세요.`,
          },
        ],
        isError: true,
      }
    }
  }

  // ── ② 병렬: 조문 본문 ∥ 3단 위임 ∥ 별표 ──
  let joTitleForRulings = ""
  // 예규 검색어가 조문 제목이 아니라 "법령명 제N조" 폴백이었는가 — rulingsP 안에서 갱신하고 조립 때 헤더에 쓴다
  let rulingsByNumber = false
  // 개정 예정 조회가 검색 목록 일부만 받았을 때의 확인 범위 고지 — upcomingP 안에서 갱신하고 조립 때 쓴다
  let upcomingScope = ""
  // 위임 섹션 제목은 방향에 따라 달라진다 (정방향=하위법령 위임 / 역방향=모법 근거).
  // threeTierP 안에서 갱신하고 Promise.all 이후에 읽는다 (joTitleForRulings와 같은 방식)
  let delegationHeader = "■ 시행령·시행규칙 위임"
  // deadline 도달 시 진행 중 업스트림 호출을 함께 취소 — 백그라운드 쿼터 소모 방지 (Opus I3)
  const aborter = new AbortController()
  const abortOnDeadline = () => aborter.abort()
  // 호출자 취소도 진행 중 섹션 호출을 함께 끊는다 (I4) — 해제는 섹션 수집 직후
  const unlinkSections = linkAbort(ctx.signal, aborter)
  // 조문 섹션이 "조회는 됐는데 그 번호 조문이 없음"으로 끝났을 때의 결과 객체 — 조회 실패와 문구가
  // 달라야 한다. 실패용 꼬리("없음이 아니라 확인 불가")를 붙이면 "(✗없음)"과 한 줄에 모순으로
  // 나갔다 (9차 리뷰 I1). 플래그가 아니라 객체 동일성으로 본다 — deadline 뒤에 늦게 끝난
  // 조회가 플래그를 세우면 "시간초과" 결과가 "없음"으로 읽힌다
  let absentResult: SectionResult | undefined
  // 조 전체가 삭제된 조문이었을 때의 결과 객체와 삭제 표기 — 판정 방식은 absentResult와 같다
  let deletedResult: SectionResult | undefined
  let deletedStamp = ""
  // 반환 조문이 요청 조문과 다를 때의 결과 객체 (B4) — 판정 방식은 absentResult와 같다
  let mismatchResult: SectionResult | undefined
  // 정상 조문의 결과 객체와 항별 렌더링 — 조립 단계에서 예산 절단·요청 항 우선에 쓴다 (B3)
  let articleParts: { result: SectionResult; parts: RenderedUnit } | undefined

  const articleP: Promise<SectionResult> = (async () => {
    const extraParams: Record<string, string> = { MST: law.mst, JO: buildJO(articleLabel) }
    // efYd는 기준일이 아니라 **해소한 시행본의 시행일**이어야 한다 — 기준일이 시행일과 다르면
    // (basisNote "직전 개정본 … 시행 기준으로 조회") 법제처가 HTML 오류를 준다.
    // 실측 2026-09-17: 법인세법 MST 212775 + efYd=20200315 → HTML / efYd=20200101 → 정상,
    // 증권거래법 MST 59091 + efYd=20050101 → HTML / efYd=20040401 → 정상, 검수자: 근로기준법
    // MST 150421 + efYd=20180101 → "일치하는 법령이 없습니다" / efYd=20140701 → 정상.
    // 기준일이 시행일과 같은 날(2020-01-01 등)로만 재면 통과해 보인다.
    // ⚠ 기준일 모드에서 lawService에 efYd를 넘기는 곳은 이 한 곳이다 — 위임 본문 동봉(정방향·역방향)은
    // 기준일 모드에서 3단비교 자체를 생략하고, 연혁 법령(historicLawFallback)도 law.effectiveDate에
    // 시행본 시행일을 넣어 이 경로로 합류한다
    if (efYd) extraParams.efYd = law.effectiveDate || efYd
    // 현행 조회는 target=law — 법제처가 efYd 없는 eflaw lawService를 HTML 오류로 돌려주기
    // 시작했다 (2026-08-30 실측: eflaw+MST+JO는 HTML, 같은 파라미터의 law는 정상,
    // eflaw+efYd 동반도 정상). eflaw는 기준일(efYd) 조회에만 쓴다
    const jsonText = await apiClient.fetchApi({
      endpoint: "lawService.do",
      target: efYd ? "eflaw" : "law",
      type: "JSON",
      extraParams,
      signal: aborter.signal,
      expectedJsonKey: "법령",
    })
    const lawData = JSON.parse(jsonText)?.법령
    if (!lawData) return failed("법령 데이터 없음 (기준일이 시행일과 안 맞을 수 있음)")
    // 요청 조문과 번호가 같은 조문단위만 쓴다 (외부 검토 B4) — 조문 제목(예규 검색어)·삭제 판정도 그 단위에서
    const pick = pickArticleUnit(lawData, articleLabel)
    if (pick.kind === "none") {
      // 기준일 조회는 **그 시행본**에 없다는 뜻일 뿐이다 — 조문 번호는 전부개정·신설·삭제로
      // 바뀌므로 현행 번호로 옛 조문의 부존재를 단정하면 안 된다
      absentResult = failed(
        efYd
          ? `${formatYmd(law.effectiveDate || efYd)} 시행본에서 ${articleLabel} 조문을 찾지 못했습니다 (정상 조회 후 0건). ` +
              `그 시점에는 신설 전이거나 삭제·이동된 조문일 수 있습니다 — 전부개정 등으로 조문 번호가 달랐을 수 있으니 현행 번호로 부존재를 단정하지 마세요`
          : `「${law.lawName}」 현행본에 ${articleLabel} 조문이 없습니다 (정상 조회 후 0건 — ✗없음). 조문 번호를 확인하세요`
      )
      return absentResult
    }
    if (pick.kind !== "match") {
      // "없음"이 아니다 — 응답은 왔지만 요청 조문의 근거로 확정할 수 없다. 본문은 싣지 않는다
      mismatchResult = failed(
        `[ARTICLE_MISMATCH] 확인 불가(반환 조문 불일치) — 요청 ${articleLabel}, ` +
          (pick.kind === "mismatch"
            ? `응답 ${[...new Set(pick.returned)].slice(0, 5).join("·")}`
            : `응답에 같은 번호 조문 ${pick.count}개(확정 불가)`) +
          `. 응답 본문은 ${articleLabel}의 근거가 아니어서 싣지 않았습니다 — 잠시 후 재시도하거나 www.law.go.kr 원문을 확인하세요`
      )
      return mismatchResult
    }
    const unit = pick.unit
    if (unit.조문제목) joTitleForRulings = String(unit.조문제목)
    const parts = renderUnitParts(unit)
    const result: SectionResult = { status: "성공" as const, text: joinUnit(parts) }
    articleParts = { result, parts }
    const stamp = deletedArticleStamp(unit)
    if (stamp !== null) {
      deletedStamp = stamp
      deletedResult = result
    }
    return result
  })().catch((e) => failed(e instanceof Error ? e.message : String(e)))

  const threeTierP: Promise<SectionResult> = (async () => {
    if (efYd) {
      // 3단비교는 현행 기준만 제공된다 — 기준일 시행본에 현행 위임 매핑을 붙이면
      // 무관한 조문이 "위임"으로 실린다 (1995년 §55 국내원천소득에 현행 세율 조문의
      // 시행령 §92가 붙던 실사용 시뮬레이션 실측). 확정 불가는 생략+고지가 정직하다.
      // 이 분기가 없으면 아래 시행령 본문 조회도 현행 MST+과거 efYd로 빈 응답을 받아
      // 조용히 삼켜진다 (CLAUDE.local에 기록된 함정)
      return {
        status: "성공" as const,
        text: "(기준일 조회 미지원 — 법제처 3단비교는 현행 기준만 제공되어 기준일 시행본의 위임 관계를 확정할 수 없습니다. 현행 위임은 basis_date 없이 조회하세요)",
      }
    }
    const jsonText = await apiClient.getThreeTier({ mst: law.mst, knd: "2", signal: aborter.signal })
    const rawJson = JSON.parse(jsonText)

    // 3단비교 배열은 **기준법령(모법) 조번호**로 색인된다 — 시행령 MST로 호출해도
    // 모법 매핑이 온다(2026-09-05 실측). 기준법령이 조회한 법령 자신이 아니면
    // 같은 조번호로 찾은 항목은 **다른 법령의 조문**이므로 정방향 조회를 쓰면 안 된다.
    const rowSet = parseThreeTierRows(rawJson)
    const tier = lawTierOf(law.lawName)
    // 역방향으로 넘어가도 끝이 아니다 — 기준법령이 이 하위법령의 **모법**이 맞는지는
    // renderReverseDelegation이 다시 확인한다 (무관 법령의 표가 오는 실측 사례가 있다)
    const baseIsSelf = rowSet.baseLawName ? resolvedLawMatches(rowSet.baseLawName, law.lawName) : tier === "본법"
    if (!baseIsSelf) {
      delegationHeader = "■ 모법 위임 근거 (역방향)"
      return {
        status: "성공" as const,
        text: await renderReverseDelegation({
          apiClient,
          law,
          tier,
          articleLabel,
          rowSet,
          outerSignal: aborter.signal,
          deadlineAt,
        }),
      }
    }

    const data = parseThreeTierDelegation(rawJson)
    const target = data.articles.find((a) => a.joNum.replace(/\s+/g, "") === articleLabel.replace(/\s+/g, ""))
    if (!target || target.delegations.length === 0) {
      return { status: "성공" as const, text: "(위임 조문 없음)" }
    }
    const dels = target.delegations

    // 3단비교가 본문(content)을 안 실어주는 경우: 시행령·시행규칙 위임조문 상위 3건은
    // 직접 조회해 동봉 (묶음이 곧 제품 — 실무자가 다음에 물을 것을 미리 답한다).
    // 시행규칙 제외는 조용한 누락이었다 — 내용연수·상각률·이자율이 다 시행규칙에 있다
    // (실사용 시뮬레이션 ③: 법인세법 §26의 시행규칙 §22가 제목만 나오던 실측)
    const bodyMap = new Map<string, string>()
    // 소속 하위법령을 법령 검색에서 정확히 특정하지 못해 본문 조회를 생략한 건 (`${type}|${joNum}`)
    const unresolved = new Set<string>()
    const BODY_LIMIT = 3
    const bodyEligible = dels.filter(
      (d) => (d.type === "시행령" || d.type === "시행규칙") && !(d.content || "").trim() && d.joNum
    )
    const needBody = bodyEligible.slice(0, BODY_LIMIT)
    if (needBody.length > 0) {
      // 본문 동봉은 3초 예산 안에서만 — 예산이 끝나면 자식 호출까지 실제로 끊는다.
      // race만 걸고 두면 진행 중 fetch가 바깥 6초 deadline까지 살아 쿼터를 소모한다
      // (Codex 상세 리뷰: delegated-body 3s race가 자식을 abort하지 않음)
      const bodyAborter = new AbortController()
      const onOuterAbort = () => bodyAborter.abort()
      aborter.signal.addEventListener("abort", onOuterAbort, { once: true })
      const fetchBodies = (async () => {
        // 소속 법령별로 묶어 각자 MST를 해소한다 — 시행규칙 조문을 시행령 MST로
        // 조회하면 엉뚱한 조문이 "본문"으로 동봉된다
        const byName = new Map<string, typeof needBody>()
        for (const d of needBody) {
          const name =
            d.lawName || (d.type === "시행령" ? data.meta.sihyungryungName : data.meta.sihyungkyuchikName) || ""
          if (!name) {
            unresolved.add(`${d.type}|${d.joNum}`)
            continue
          }
          const group = byName.get(name)
          if (group) group.push(d)
          else byName.set(name, [d])
        }
        await Promise.all(
          [...byName.entries()].map(async ([decreeName, items]) => {
            const decreeLaws = await findLaws(apiClient, decreeName, undefined, 3, 100, bodyAborter.signal)
            // 정확 일치가 없으면 동봉을 생략하고 목록 표시로 폴백 — 엉뚱한 법령의 조문을
            // "시행령 본문"으로 동봉하는 것보다 안 싣는 쪽이 안전 (Opus I1: 무고지 폴백 제거)
            const decree = decreeLaws.find((l) => resolvedLawMatches(decreeName, l.lawName))
            if (!decree) {
              // 조회를 시도하지 않은 건이다 — "조회 실패·시간 초과"로 세면 재시도로 풀릴 것처럼 읽힌다 (최종 검토 참고 1)
              for (const d of items) unresolved.add(`${d.type}|${d.joNum}`)
              return
            }
            await Promise.all(
              items.map(async (d) => {
                try {
                  // 위임 본문 동봉은 현행 전용 경로 — target=law (efYd 없는 eflaw는
                  // HTML 오류가 되어 catch로 삼켜지고 본문이 조용히 빠진다. 2026-08-30 실측)
                  const jt = await apiClient.fetchApi({
                    endpoint: "lawService.do",
                    target: "law",
                    type: "JSON",
                    extraParams: { MST: decree.mst, JO: buildJO(d.joNum!) },
                    signal: bodyAborter.signal,
                    expectedJsonKey: "법령",
                  })
                  const body = renderArticleUnits(JSON.parse(jt)?.법령, d.joNum!)
                  if (body) bodyMap.set(`${d.type}|${d.joNum!}`, body)
                } catch {
                  /* 개별 조문 실패는 목록 표시로 폴백 (부분 실패 계약) */
                }
              })
            )
          })
        )
      })()
      let bodyTimer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        fetchBodies,
        new Promise((r) => {
          bodyTimer = setTimeout(() => {
            bodyAborter.abort() // 예산 초과 — 진행 중 자식 호출 취소
            r(undefined)
          }, 3000)
        }),
      ]).catch(() => {})
      clearTimeout(bodyTimer) // 타이머 잔존 방지 (Opus I3)
      aborter.signal.removeEventListener("abort", onOuterAbort)
    }

    let out = ""
    for (const d of dels) {
      const label = d.type === "시행령" ? "[시행령]" : d.type === "시행규칙" ? "[시행규칙]" : "[행정규칙]"
      out += `${label} ${d.lawName || ""} ${d.joNum || ""}${d.title ? ` (${d.title})` : ""}\n`
      const body = (d.content || "").trim() || (d.joNum ? bodyMap.get(`${d.type}|${d.joNum}`) : "")
      if (body) out += `${cleanHtml(body).trim()}\n`
      out += `\n`
    }
    // 어떤 위임은 본문이 붙고 어떤 건 제목만 나오는 이유를 밝힌다 — 고지가 없으면
    // "본문이 없는 조문"으로 읽힌다 (잔여③)
    // 상한 초과와 조회 실패는 원인이 다르다 — 뭉뚱그리면 "실패한 3건"이 "상한 때문"으로
    // 읽혀 재시도할 이유가 사라진다 (Codex 리뷰 개선 1)
    const overflow = bodyEligible.length - needBody.length
    const missing = needBody.filter((d) => !bodyMap.has(`${d.type}|${d.joNum}`))
    const unresolvedCount = missing.filter((d) => unresolved.has(`${d.type}|${d.joNum}`)).length
    const failed = missing.length - unresolvedCount
    if (overflow > 0 || missing.length > 0) {
      const causes: string[] = []
      if (overflow > 0) causes.push(`${overflow}건은 상위 ${BODY_LIMIT}건 상한 초과(응답 시간 예산)`)
      if (unresolvedCount > 0) causes.push(`${unresolvedCount}건은 소속 하위법령을 법령 검색에서 정확히 특정하지 못해 본문 조회 생략 — "본문 없음"이 아님`)
      if (failed > 0) causes.push(`${failed}건은 조회 실패·시간 초과 — "본문 없음"이 아님`)
      out += `\n※ 위임 조문 본문 ${overflow + missing.length}건은 제목만 표시했습니다 (${causes.join(" / ")}). 본문이 필요하면 fin_article로 해당 조문을 직접 조회하세요`
    }
    return { status: "성공" as const, text: out.trim() }
  })().catch((e) => failed(e instanceof Error ? e.message : String(e)))

  const annexP: Promise<SectionResult> = (async () => {
    // 별표 목록은 현행 법령 기준이다 — 현행에 없는 연혁 법령에 "없음"을 찍으면 별표가 없던 법령으로 읽힌다
    if (historic) return { status: "성공" as const, text: "(연혁 법령 — 별표 목록은 현행 법령만 조회되어 생략. \"별표 없음\"이 아님)" }
    const jsonText = await apiClient.getAnnexes({ lawName: law.lawName, knd: "1", signal: aborter.signal }) // 1=별표만 (서식 노이즈 제외)
    const acc: AnnexItem[] = []
    findAnnexItems(JSON.parse(jsonText), acc, law.lawName)
    if (acc.length === 0) return { status: "성공" as const, text: "없음" }
    const shown = acc.slice(0, 10)
    let out = `${acc.length}건`
    if (acc.length > shown.length) out += ` (상위 ${shown.length}건 표시 / 전체 ${acc.length}건 — 전체는 fin_annex)`
    // 법제처 별표번호는 6자리 코드(000400)다 — 그대로 찍으면 "[별표 000400]"이라는
    // 원문에 없는 표기가 되고, 실무자가 그대로 인용하면 틀린 인용이 된다.
    // fin_annex와 같은 포맷터를 쓴다 (000000은 번호 없는 별표라 "[별표]")
    out += "\n" + shown.map((a) => `  · ${a.no ? `[${formatAnnexNo(a.no)}] ` : ""}${a.name}`).join("\n")
    return { status: "성공" as const, text: out }
  })().catch((e) => failed(e instanceof Error ? e.message : String(e)))

  // 시행예정 개정 경고 — 이미 공포된 미래 개정을 모르면 개정 직전 검토에서 사고
  const upcomingP: Promise<SectionResult> = (async () => {
    if (efYd) {
      // 개정 예정은 현행 조회 전용 — 1995년 기준 응답에 "2027-01-01 시행 개정 공포됨"이
      // 붙던 혼입 제거 (실사용 시뮬레이션 d). 기준일 모드의 생략은 상단 조회 범위 고지가 설명한다
      return { status: "성공" as const, text: "" }
    }
    const xml = await apiClient.searchLaw(law.lawName, undefined, UPCOMING_PAGE_SIZE, "eflaw", aborter.signal)
    // 한 페이지만 받는다 — 검색 결과가 그보다 많으면 목록 밖의 시행예정 행은 조용히 빠진다.
    // 판정은 바꾸지 않고 확인 범위만 고지한다 (Fable 최종 검토 F3 제안 ④ — findRepealedLaw와 같은 완전성 규칙)
    const received = (xml.match(/<law[^>]*>[\s\S]*?<\/law>/g) ?? []).length
    const rawTotal = readTotalCnt(xml)
    const total = rawTotal !== undefined && rawTotal >= received ? rawTotal : undefined
    const complete = total !== undefined ? received >= total : received < UPCOMING_PAGE_SIZE
    // 받은 이 법령의 행이 시행일 내림차순이고 이미 시행된 행까지 내려왔으면, 목록 밖(뒤쪽)에 미래 시행 행은 없다 —
    // 큰 세법은 연혁이 수백 건이라 이 근거 없이는 매 호출 고지가 붙는다. 순서를 확인할 수 없으면 고지한다
    const ownDates = (xml.match(/<law[^>]*>[\s\S]*?<\/law>/g) ?? [])
      .filter((b) => compactName(extractTag(b, "법령명한글")) === compactName(law.lawName))
      .map((b) => extractTag(b, "시행일자"))
    const coveredByOrder =
      ownDates.length > 0 &&
      ownDates.every((d) => /^\d{8}$/.test(d)) &&
      ownDates.every((d, i) => i === 0 || d <= ownDates[i - 1]) &&
      !isFutureDate(ownDates[ownDates.length - 1])
    if (!complete && !coveredByOrder) {
      upcomingScope = `연혁 검색 목록 ${total !== undefined ? `전체 ${total}건 중 받은 ${received}건` : `받은 ${received}건`}만 확인 — 목록 밖의 공포된 개정은 누락됐을 수 있음`
    }
    // 시행일이 지난 "시행예정" 행은 parseUpcomingVersions가 거르고 같은 시행일은 하나로 접는다
    const ups = parseUpcomingVersions(xml, law.lawName)
    if (ups.length === 0) return { status: "성공" as const, text: "" }
    const anc = (list: string[]) =>
      list.length === 0 ? "" : `(공포 ${formatYmd(list[0])}${list.length > 1 ? ` 외 ${list.length - 1}건` : ""})`
    return {
      status: "성공" as const,
      text: ups.map((u) => `${formatYmd(u.시행일자)} 시행 개정 공포됨${anc(u.공포일자)}`).join(" · "),
    }
  })().catch((e) => failed(e instanceof Error ? e.message : String(e)))

  // ── ③ 예규 검색 (조문 제목 확보 직후 — 나머지 섹션과 병렬) ──
  // 종전에는 4섹션 Promise.all이 끝난 **뒤에** 예규 검색을 시작해, 3단비교가 느리면(deadline 근처)
  // 예규 섹션도 함께 "도구 deadline 초과"로 빠졌다 (R3 라이브: 조특법 시행령 §27 cold 6회 중 2회).
  // 예규에 필요한 것은 조문 제목(articleR)뿐이므로 조문 섹션이 끝나는 즉시 시작한다
  const articleD = withDeadline(articleP, deadlineAt, abortOnDeadline)
  const rulingsP: Promise<SectionResult> = articleD.then(async (articleDone): Promise<SectionResult> => {
    if (!input.include_rulings) return { status: "성공", text: "(검색 생략 — include_rulings=false)" }
    if (articleDone === deletedResult) {
      // 삭제 조문은 제목이 없어 검색어가 "법령명 제N조"로 폴백된다 — 걸리는 예규는 삭제 전 조문이나
      // 번호만 같은 다른 조문에 관한 것이라 "이 조문의 예규 후보"로 내면 오독된다
      return {
        status: "성공",
        text: "(검색 생략 — 삭제된 조문이라 조문 제목이 없고, 번호로 찾은 예규는 삭제 전 조문에 관한 것이어서 현행 근거로 쓸 수 없습니다. 삭제 전 예규는 fin_ruling_search로 직접 찾으세요)",
      }
    }
    if (articleDone === mismatchResult) {
      // 반환 조문이 요청 조문과 달라 조문 제목을 확정할 수 없다 — 번호로 찾은 예규를 이 조문의 후보로 내지 않는다
      return { status: "성공", text: "(검색 생략 — 반환 조문이 요청 조문과 달라 조문 제목을 확정하지 못했습니다. 예규는 fin_ruling_search로 직접 찾으세요)" }
    }
    // 없는 조문·조회 실패도 제목이 없어 검색어가 "법령명 제N조"로 폴백되고, 사다리가 "법령명"까지 줄여
    // 법령 전체의 최신 예규 3건이 "이 조문의 후보"로 붙었다 (최종 검토 F1 — 법인세법 제999조 → 418건 중 3건).
    // 조문 부존재·확인 불가 옆에 예규가 있으면 LLM이 부존재를 무시하고 예규로 답을 만든다
    if (articleDone === absentResult) {
      return {
        status: "성공",
        text: efYd
          ? "(검색 생략 — 기준일 시행본에서 조문을 찾지 못해 조문 제목이 없고, 번호로 찾은 예규는 이 조문에 관한 것인지 확인할 수 없습니다. 예규는 fin_ruling_search로 직접 찾으세요)"
          : "(검색 생략 — 현행본에 없는 조문이라 조문 제목이 없고, 번호로 찾은 예규는 이 조문의 후보가 아닙니다. 조문 번호를 먼저 확인하세요)",
      }
    }
    if (articleDone.status !== "성공") {
      return {
        status: "성공",
        text: "(검색 생략 — 조문 조회에 실패해 조문 제목을 확보하지 못했습니다. 번호로 찾은 예규를 이 조문의 후보로 내지 않습니다 — 조문을 다시 조회하거나 예규는 fin_ruling_search로 직접 찾으세요)",
      }
    }
    // 조문은 받았지만 제목이 비어 있으면 검색어가 "법령명 제N조"다 — 헤더가 "조문 제목 키워드 검색"이라고
    // 적으면 사실과 다르므로 조립 단계에서 헤더를 바꾼다
    rulingsByNumber = !rulingQueryFromTitle(joTitleForRulings, "")
    const rulingQuery = rulingQueryFromTitle(joTitleForRulings, `${law.lawName} ${articleLabel}`)
    return withDeadline(
      (async () => {
        const queries = ladderQueries(rulingQuery)
        for (let qi = 0; qi < queries.length; qi++) {
          const q = queries[qi]
          // 오류는 즉시 실패로 (사다리는 0건에만 — 오류를 0건으로 위장 금지)
          // sort 없이 부르면 법제처 기본 정렬(안건명 가나다순)의 앞 3건이 온다 — 그것을 "상위 3건"이라
          // 부르면 오래된 해석이 대표처럼 읽힌다. fin_ruling_search와 같은 일자 내림차순을 요청한다
          // (ruling-search.ts LATEST_FIRST_SORT — ntsCgmExpc 포함 4도메인 라이브 확인)
          const xml = await apiClient.fetchApi({
            endpoint: "lawSearch.do",
            target: "ntsCgmExpc",
            type: "XML",
            extraParams: { query: q, display: "3", sort: LATEST_FIRST_SORT },
            expectedRoot: "CgmExpc",
            signal: aborter.signal,
          })
          const total = readTotalCnt(xml)
          const items = parseNtsRulings(xml, 3)
          if (items.length === 0) continue
          const ladderNote = qi > 0 ? ` — 검색어 축약: "${rulingQuery}" → "${q}"` : ""
          // 총건수는 응답의 totalCnt로만 말한다 — 종전 폴백(`total || items.length`)은 태그가
          // 없거나 숫자가 아닌 응답에서 **받은 수를 총수로** 써서, 42건짜리 검색을 "3건 중 3건"
          // 으로 적어 "이게 전부"로 읽히게 했다. totalCnt가 받은 수보다 작은 응답도 총수로
          // 믿을 수 없다 (계약은 ruling-search.ts readTotalCnt와 같다 — 지어낸 0/받은 수 금지)
          // 총수 확인과 정렬 확인은 별개다 — 전체를 다 받았다는 것은 "빠진 게 없다"는 뜻일 뿐
          // 받은 순서가 일자 내림차순이라는 뜻이 아니다. 종전 `allReturned || …`는 전체 2건이
          // 오름차순으로 와도 "최신 2건"이라 적었다.
          //
          // ⚠ 여기서 ruling-search의 assessLatestFirst를 쓰면 안 된다 — 그쪽의 "전부 받았고 일자를
          // 전부 읽었으면 최신순" 근거는 **호출부가 일자순으로 재정렬한다**는 전제 위에 있다
          // (nts-ruling.ts는 판정 뒤 items.sort로 재정렬한다). 이 섹션은 받은 순서를 그대로
          // 표시하므로 근거는 "받은 순서가 내림차순인가" 하나뿐이다. 일자를 못 읽은 항목이 있으면
          // 그 항목의 위치를 확인할 수 없어 isLatestFirst가 false다 (ruling-search.ts 계약)
          const allReturned = total !== undefined && total === items.length
          const latestFirst = isLatestFirst(items.map((r) => r.date))
          const countPart =
            total !== undefined && total >= items.length
              ? `${total}건 중 `
              : `총건수 미확인(${
                  total === undefined ? "응답에 totalCnt 없음" : `totalCnt ${total}건 < 받은 ${items.length}건`
                }) — `
          const orderPart = latestFirst
            ? `최신 ${items.length}건`
            : allReturned
              ? `전체 ${items.length}건(받은 순서 그대로 — 일자순 정렬 미확인)`
              : `${items.length}건(일자순 정렬 미확인)`
          let out = `${countPart}${orderPart} (검색어: "${q}"${ladderNote})\n`
          out += items.map((r) => `  · ${r.docNo} (${r.date}) ${r.title}`).join("\n")
          // 축약이 일어났으면 검색어가 조문 제목이 아니라 그 일부(일반 명사)다 —
          // "과다경비 등의 손금불산입" → "손금불산입"이면 지급이자·접대비 손금불산입
          // 예규가 걸리고, 이것을 "이 조문의 관련 예규"로 읽으면 무관한 해석이 근거가 된다
          // (실측: 법인세법 §26 요청에 §28·§25 예규 3건). 축약 사실만으로는 약하다
          if (qi > 0) {
            out += `\n  ⚠ 검색어가 일반 명사로 축약되어 **이 조문과 무관한 예규가 섞일 수 있습니다** — 제목을 확인하고, 조문과 맞는 것만 근거로 쓰세요`
          }
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
  })

  const [articleR, threeTierR, annexR, upcomingR, rulingsR] = await Promise.all([
    articleD,
    withDeadline(threeTierP, deadlineAt, abortOnDeadline),
    withDeadline(annexP, deadlineAt, abortOnDeadline),
    withDeadline(upcomingP, deadlineAt, abortOnDeadline),
    rulingsP,
  ])
  unlinkSections()
  const articleDeleted = articleR === deletedResult

  // ── 조립 (부분 실패 계약) ──
  // 삭제 조문에는 위임 목록을 싣지 않는다 — 3단비교에 남은 매핑은 삭제 전 관계일 수 있어
  // "삭제된 조문의 위임"이 현행 근거로 읽힌다 (fin_verify는 같은 조문을 ⚠삭제 조문으로 판정한다)
  const deletedLabel = `삭제된 조문${deletedStamp ? `(삭제 ${deletedStamp})` : ""}`
  const delegationR: SectionResult = articleDeleted
    ? {
        status: "성공",
        text:
          `(위임 조회 생략 — ${deletedLabel}입니다. 3단비교에 남은 매핑은 삭제 전 관계일 수 있어 현행 위임 근거로 쓸 수 없습니다. ` +
          `삭제 전 조문과 위임은 basis_date로 삭제 이전 날짜를 지정해 조회하세요)`,
      }
    : threeTierR
  const sections: Array<{ name: string; r: SectionResult; budget: number; hint: string }> = [
    { name: "조문", r: articleR, budget: BUDGET_ARTICLE, hint: "www.law.go.kr 원문" },
    { name: "위임", r: delegationR, budget: BUDGET_DELEGATION, hint: "법제처 3단비교 원문" },
    { name: "예규", r: rulingsR, budget: BUDGET_RULINGS, hint: "fin_nts_ruling" },
    { name: "별표", r: annexR, budget: BUDGET_ETC, hint: "fin_annex" },
  ]
  const articleAbsent = articleR === absentResult
  const articleMismatch = articleR === mismatchResult
  // 조문 본문은 여기서 예산에 맞춘다 — 성공 판정(첫 줄)이 절단 여부를 알아야 한다 (B3: 절단 전에
  // 성공을 계산해 잘린 본문이 "전체 성공"으로 나갔다). 객체 동일성은 absentResult와 같은 이유다
  const articleBody =
    articleParts && articleR === articleParts.result
      ? composeArticleBody(
          articleParts.parts,
          articleInput.detail,
          BUDGET_ARTICLE,
          sections[0].hint,
          (no) => `fin_article({ law: "${input.law.trim()}", article: "${articleLabel}제${no}항"${input.basis_date ? `, basis_date: "${input.basis_date}"` : ""} })`
        )
      : undefined
  const truncatedNames = sections
    .filter((s) => s.r.status === "성공" && (s.name === "조문" ? !!articleBody?.truncated : s.r.text.length > s.budget))
    .map((s) =>
      s.name === "조문" && articleBody
        ? `본문 일부 절단(${articleBody.fullLength.toLocaleString()}자 중 ${articleBody.shownLength.toLocaleString()}자${
            articleBody.detailFirst
              ? ` — 요청 제${articleBody.detailHang}항 우선 수록`
              : articleBody.detailMiss === "notFound"
                ? ` — 요청 제${articleBody.wantedHang}항 미발견, 조 앞부분부터`
                : articleBody.detailMiss
                  ? ` — 요청 제${articleBody.wantedHang}항만 싣지 못해 조 앞부분부터`
                  : ""
          })`
        : `${s.name} 일부 절단(예산 ${s.budget.toLocaleString()}자)`
    )
  const failedNames = sections
    .filter((s) => s.r.status !== "성공" && !(s.name === "조문" && articleAbsent))
    .map((s) => `${s.name}(${s.r.status}: ${s.r.reason})`)
  const overallParts = [
    ...(articleAbsent ? [efYd ? "조문 미발견(기준일 시행본)" : "조문 없음(✗)"] : []),
    ...(failedNames.length > 0 ? [`실패 섹션: ${failedNames.join(", ")}`] : []),
  ]
  // 삭제 조문·절단은 조회 실패가 아니다 — 그래도 첫 줄에서 바로 보이게 한다 ("전체 성공" 금지)
  const notes = [...(articleDeleted ? [`⚠${deletedLabel}`] : []), ...truncatedNames.map((n) => `⚠${n}`)]
  const overall =
    overallParts.length === 0
      ? notes.length > 0
        ? `조회 성공 — ${notes.join(" / ")}`
        : "전체 성공"
      : `부분 성공 — ${[...notes, ...overallParts].join(" / ")}`

  const basisLine = input.basis_date ? `[기준일: ${input.basis_date} 시행 기준${basisNote}]` : `[기준: 현행]`
  // 기준일 헤더 아래 현행 데이터가 무고지로 섞이면 "헤더는 기준일, 내용은 현행"인
  // 조용한 거짓이 된다 (실사용 시뮬레이션 차단 지적) — 섹션별 기준을 상단에 못박는다
  const basisScope = efYd
    ? `※ 기준일 조회 범위: 조문 본문·시행일자만 ${input.basis_date} 시행본입니다. 위임(3단비교)·개정 예정은 법제처가 현행 기준만 제공하여 생략했고, [현행 기준] 표시 섹션은 현행 데이터입니다`
    : ""
  const historicScope = historic
    ? `※ 「${law.lawName}」은 현행 법령 DB에 없는 **연혁 법령**(폐지·개칭 전)입니다 — 아래 조문은 기준일 시행본이며 현행 규정이 아닙니다`
    : ""
  // 조 단위로 접었다는 사실을 남긴다 — 위임 매핑은 조 단위라 항·호에 한정된 위임만 골라낼 수 없다
  // 본문 범위 문구는 실제로 실은 범위와 같아야 한다 — 절단·요청 항 미확보인데 "조 전체이고"라 적으면
  // 첫 줄의 ⚠절단과 한 응답 안에서 충돌한다 (최종 검토 F2). 본문이 없으면(없음·불일치·실패) 범위를 말하지 않는다
  const bodyScope = ((): string => {
    if (!articleBody) return "본문은 싣지 못했고"
    const b = articleBody
    const shownPart = `조 전체 ${b.fullLength.toLocaleString()}자가 예산을 넘어 앞부분 ${b.shownLength.toLocaleString()}자만 실었고`
    if (b.detailFirst) return `조 전체가 예산을 넘어 조 머리와 제${b.detailHang}항만 실었고`
    if (!b.truncated) {
      return b.detailMiss === "notFound"
        ? `조 전체이고(요청한 제${b.wantedHang}항은 응답의 항 번호에서 찾지 못했습니다 — 항 번호를 확인하세요)`
        : b.detailMiss === "noStructure"
          ? `조 전체이고(이 조문은 응답에서 항으로 구분되지 않아 요청한 제${b.wantedHang}항의 존재를 확인하지 못했습니다 — 항 번호를 확인하세요)`
          : "조 전체이고"
    }
    switch (b.detailMiss) {
      case "notFound":
        return `요청한 제${b.wantedHang}항을 응답의 항 번호에서 찾지 못해 ${shownPart}(뒤쪽 항 생략)`
      case "overBudget":
        return `요청한 제${b.wantedHang}항 자체가 예산을 넘어 ${shownPart}(제${b.wantedHang}항 뒷부분·뒤쪽 항 생략)`
      case "ambiguous":
        return `요청한 제${b.wantedHang}항이 응답에 둘 이상이라 특정하지 못해 ${shownPart}(뒤쪽 항 생략)`
      case "noStructure":
        return `응답에서 항 번호를 읽지 못해 요청한 제${b.wantedHang}항만 골라내지 못하고 ${shownPart}(뒤쪽 생략)`
      default:
        return `요청 표기에 항 번호가 없어 그 부분만 골라내지 못하고 ${shownPart}(뒤쪽 생략)`
    }
  })()
  const detailScope = articleInput.detail
    ? `※ 요청 표기 "${input.article.trim()}" → 조 단위(${articleLabel})로 조회했습니다 — ` +
      `본문은 ${bodyScope}, 위임(3단비교)은 조 단위 매핑이라 ` +
      `${articleInput.detail}에 해당하는 위임만 골라내지 못합니다. ${articleInput.detail}의 위임 여부는 아래 본문의 "대통령령으로 정하는" 등 문구로 확인하세요`
    : ""
  // 기준일 조회에서는 그 시점 시행본이 **정상 결과**다 — 경고를 붙이면 정상을 이상으로 읽게 된다
  // (fin_law_search는 basisMode에서 이미 억제한다: law-search.ts의 formatLawLine).
  // 특히 미래 시행일은 "과거본"이 사실과 정반대인데, 이 도구는 아래 "개정 예정" 줄에서
  // basis_date로 그 시행일을 조회하라고 **직접 권한다** — 권한 대로 한 사용자에게
  // "폐지" 딱지를 보여주면 개정 대비 검토를 막는 (b)형이 된다.
  // 여기서 status가 "연혁"인 것은 위 resolveVersionAt이 시행본을 갈아끼우며 덮어쓴 값이고
  // 폐지를 뜻하지 않는다 (기준일 없는 현행 조회에서만 폐지·과거본을 의미한다).
  // 연혁 법령은 기준일 조회에서도 표시한다 — 위 억제는 "현행 법령의 과거 시행본"이 정상 결과라서이고,
  // 법령 자체가 현행에 없다는 사실은 기준일과 무관하게 알려야 한다
  const statusMark = historic
    ? " ⚠연혁 법령(현행 아님)"
    : efYd
      ? isFutureDate(law.effectiveDate || "")
        ? " 📅시행예정"
        : ""
      : law.status === "연혁"
        ? " ⚠연혁(폐지·과거본)"
        : ""
  const publicUrl = `https://www.law.go.kr/법령/${law.lawName}/${articleLabel}`
  // 이 주소는 법령명·조문만 담아 **현행본**을 연다 — 기준일 조회에서 표시 없이 주면
  // 기준일 시행본의 원문인 것처럼 읽힌다 (9차 리뷰 I4)
  const linkLabel = historic
    ? `원문(현행 법령 주소 형식 — 연혁 법령은 열리지 않을 수 있고 ${input.basis_date} 시행본이 아님)`
    : efYd
      ? `원문(현행본 링크 — ${input.basis_date} 시행본이 아님)`
      : "원문"

  const sec = (s: { name: string; r: SectionResult; budget: number; hint: string }, header: string): string => {
    if (s.name === "조문" && articleAbsent) {
      return efYd ? `${header}\n  ⚠ 기준일 시행본에서 미발견: ${s.r.reason}` : `${header}\n  ✗ 없음: ${s.r.reason}`
    }
    if (s.r.status !== "성공") return `${header}\n  ⚠ 조회 실패(${s.r.status}): ${s.r.reason} — "없음"이 아니라 확인 불가입니다.`
    if (s.name === "조문" && articleBody) return `${header}\n${articleBody.text}`
    return `${header}\n${truncateWithHint(s.r.text, s.budget, s.hint)}`
  }

  const text = [
    ...[`${basisLine} ${overall}`, basisScope, historicScope, detailScope].filter(Boolean),
    ``,
    sec({ ...sections[0] }, `■ ${law.lawName} ${articleLabel}${statusMark}${articleDeleted ? ` ⚠${deletedLabel}${efYd ? " — 기준일 시행본 기준" : ""}` : ""}`),
    ``,
    sec({ ...sections[1] }, delegationHeader),
    ``,
    // "관련"은 근거 관계를 단정한다 — 실제로는 조문 제목 키워드 검색이라 무관 예규가 섞인다
    // (아래 ③ 주석·축약 경고와 같은 사실). 제목에서부터 후보임을 밝힌다 (Codex 제품 검토 2)
    sec(
      { ...sections[2] },
      `■ 국세청 예규 후보 (${
        rulingsByNumber
          ? `조문 제목 미확보 — 법령명·조문번호 "${law.lawName} ${articleLabel}"로 검색, 이 조문의 예규인지 확인 안 됨`
          : "조문 제목 키워드 검색 — 적용 관계 미확인"
      })${efYd ? " [현행 기준 — 기준일 필터 없음]" : ""}`
    ),
    ``,
    sec({ ...sections[3] }, `■ 별표${efYd ? " [현행 기준 — 기준일 별표 조회는 법제처 미지원]" : ""}`),
    ``,
    `■ 법령 정보 — 시행일자 ${law.effectiveDate || "미상"} · ${linkLabel}: ${encodeURI(publicUrl)}`,
    upcomingR.status === "성공"
      ? upcomingR.text
        ? // 법령 단위 예고다 — 공포된 개정이 이 조문을 바꾸는지는 알 수 없다. 조문 바로 아래에
          // "개정 예정"만 쓰면 조문 개정으로 읽힌다 (R3 라이브: 법인세법 §26에 §21 개정의 2028 시행이 붙음)
          `■ ⚠ 법령 개정 예정(「${law.lawName}」 법령 단위 — 이 조문 해당 여부는 부칙·개정문 확인) — ${upcomingR.text}. ` +
          `개정 이후 기준 검토는 basis_date로 해당 시행일을 지정${upcomingScope ? ` (확인 범위: ${upcomingScope})` : ""}`
        : upcomingScope
          ? `■ 법령 개정 예정 — 받은 목록에서는 발견되지 않음 (확인 범위: ${upcomingScope}). "개정 예정 없음"으로 단정하지 말 것`
          : ``
      : `■ 법령 개정 예정 여부 — ⚠ 확인 실패(${upcomingR.reason}). "개정 없음"으로 단정하지 말 것`,
    ``,
    `※ 전거 서열: 이 응답의 조문(법률·시행령·시행규칙)이 1차 근거 — 예규는 행정해석(구속력 없음), 상충 시 조문 우선`,
    SOURCE_FOOTER,
  ].join("\n").replace(/\n{3,}/g, "\n\n")

  // 반환 조문 불일치는 핵심 근거(요청 조문 본문)를 확정하지 못한 것이다 — 나머지 섹션은 싣되
  // 호출측(훅·LLM)이 정상 응답으로 읽지 않게 isError로 표시한다
  return { content: [{ type: "text", text }], ...(articleMismatch ? { isError: true } : {}) }
}
