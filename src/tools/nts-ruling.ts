/**
 * fin_nts_ruling — 국세청 예규 검색 + 상위 N건 본문 자동 동봉
 *
 * 법제처 API는 국세청 예규의 목록만 준다. 본문은 국세법령정보시스템 비공식 경로로
 * 확보한다 (자체 패치 #1 코어 승격 — src/tools/nts-body.ts).
 * - 본문 조회 실패는 "0건"으로 위장하지 않는다: 목록은 유지하고 실패 사유를 명시
 * - FIN_NTS_BODY_ENABLED=false면 목록만 반환 (공개 배포판 기본 OFF 정책)
 * - 예산: 본문 건당 6,000자, 기본 N=2 (최대 5)
 */

import { z } from "zod"
import type { LawApiClient } from "../lib/api-client.js"
import { getNtsDecisionBody, parseNtstDcmId } from "./nts-body.js"
import { ladderQueries, parseNtsRulings, truncateWithHint, SOURCE_FOOTER } from "../lib/fin-common.js"
import { formatFetchFailure } from "../lib/errors.js"
import { extractTag } from "../lib/xml-parser.js"

const BUDGET_BODY = 6000
// 환경변수 기본값도 0~5로 클램프 (zod .default()는 검증을 우회하므로 여기서 강제)
const DEFAULT_TOP_N = Math.min(Math.max(Number(process.env.FIN_NTS_BODY_TOP_N) || 2, 0), 5)

export const FinNtsRulingInputSchema = z.object({
  query: z.string().min(1).describe("예규 검색어 (예: 퇴직금 중간정산 손금)"),
  top_n_bodies: z.number().int().min(0).max(5).default(DEFAULT_TOP_N).describe("본문 자동 동봉 건수 (기본 2, 최대 5, 0=목록만)"),
})

export const FIN_NTS_RULING_TOOL = {
  name: "fin_nts_ruling",
  description:
    "[재무·세무·회계 전용 — 국세청 예규가 필요하면 이 도구를 우선 사용] " +
    "국세청 예규·법령해석을 검색하고 상위 건의 본문 전문을 자동 동봉한다 (문서번호·회신일자 포함). " +
    "세무 검토서에 예규 원문을 인용할 때 사용.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "예규 검색어" },
      top_n_bodies: { type: "number", description: "본문 자동 동봉 건수 (기본 2, 최대 5, 0=목록만)" },
    },
    required: ["query"],
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
} as const

function bodyEnabled(): boolean {
  const v = (process.env.FIN_NTS_BODY_ENABLED || "").toLowerCase()
  // 기본 OFF — 비공식 경로(taxlaw.nts.go.kr)는 명시적 옵트인 (공개 배포 정책, Codex 리뷰 차단 3).
  // 개인 사용자는 .env에 FIN_NTS_BODY_ENABLED=true 한 줄로 활성화.
  return v === "true" || v === "1"
}

export async function handleFinNtsRuling(
  apiClient: LawApiClient,
  rawInput: unknown
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const parsed = FinNtsRulingInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    return {
      content: [{ type: "text", text: `[INVALID_PARAMETER] fin_nts_ruling: ${parsed.error.issues.map((i) => i.message).join("; ")}` }],
      isError: true,
    }
  }
  const { query, top_n_bodies } = parsed.data

  // ── 검색 (축약 사다리 — 0건에만) ──
  let items: ReturnType<typeof parseNtsRulings> = []
  let usedQuery = query
  let totalCnt = "0"
  try {
    for (const q of ladderQueries(query, 4)) {
      const xml = await apiClient.fetchApi({
        endpoint: "lawSearch.do",
        target: "ntsCgmExpc",
        type: "XML",
        extraParams: { query: q, display: "10" },
        expectedRoot: "CgmExpc",
      })
      totalCnt = extractTag(xml, "totalCnt") || "0"
      items = parseNtsRulings(xml, 10)
      if (items.length > 0) {
        usedQuery = q
        break
      }
    }
  } catch (e) {
    return {
      content: [{ type: "text", text: formatFetchFailure("예규 검색", e) }],
      isError: true,
    }
  }

  if (items.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: `[기준: 현행] 국세청 예규 — 0건 (축약 사다리 ${ladderQueries(query, 4).map((q) => `"${q}"`).join(" → ")} 전부 0건 — 정상 조회 결과 없음)\n다른 실무 용어로 재시도하거나 fin_ruling_search로 심판례·판례를 함께 확인하세요.\n\n${SOURCE_FOOTER}`,
        },
      ],
    }
  }

  // 최신순 재정렬 (법제처는 가나다순)
  items.sort((a, b) => {
    const da = (a.date || "").replace(/[^\d]/g, "")
    const db = (b.date || "").replace(/[^\d]/g, "")
    return db > da ? 1 : db < da ? -1 : 0
  })

  const ladderNote = usedQuery !== query ? ` — 검색어 축약: "${query}" → "${usedQuery}"` : ""
  let text = `[기준: 현행] 국세청 예규 — ${totalCnt}건 중 최신순 ${items.length}건${ladderNote}\n`
  text += items.map((r, i) => `  ${i + 1}. ${r.docNo} (${r.date}) ${r.title}`).join("\n")

  // ── 본문 동봉 (상위 N건 병렬) ──
  const n = Math.min(top_n_bodies, items.length)
  if (n === 0) {
    text += `\n\n(본문 미동봉 — top_n_bodies=0)`
  } else if (!bodyEnabled()) {
    text += `\n\n(본문 동봉 비활성 — 활성화하려면 .env에 FIN_NTS_BODY_ENABLED=true 설정. 비공식 경로라 옵트인입니다. 원문은 목록의 링크에서 확인)`
  } else {
    const targets = items.slice(0, n)
    const bodies = await Promise.all(
      targets.map(async (r) => {
        const id = parseNtstDcmId(r.link)
        if (!id) return { r, ok: false, text: "링크에서 ntstDcmId를 추출할 수 없음" }
        const res = await getNtsDecisionBody(apiClient, { id })
        return { r, ok: !res.isError, text: res.content[0]?.text || "" }
      })
    )
    for (const b of bodies) {
      text += `\n\n━━━ 본문: ${b.r.docNo} (${b.r.date}) ━━━\n`
      if (b.ok) {
        text += truncateWithHint(b.text, BUDGET_BODY, `원문 링크 ${b.r.link}`)
      } else {
        // 조용한 실패 금지: 본문 실패는 목록을 죽이지 않고 사유를 명시
        text += `⚠ 본문 조회 실패 — "본문 없음"이 아니라 확인 불가입니다.\n${truncateWithHint(b.text || "", 500, "원문 링크")}\n원문: ${b.r.link}`
      }
    }
  }

  text += `\n\n※ 이 목록·본문은 국세법령정보시스템(taxlaw.nts.go.kr) 기준`
  text += `\n※ 예규는 국세청 행정해석으로 법원을 구속하지 않습니다 — 조문 근거는 fin_article, 판례 대조는 fin_ruling_search`
  text += `\n${SOURCE_FOOTER}`
  return { content: [{ type: "text", text }] }
}
