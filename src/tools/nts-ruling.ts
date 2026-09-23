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
import { parseNtsRulings, truncateWithHint, SOURCE_FOOTER } from "../lib/fin-common.js"
import { formatFetchFailure } from "../lib/errors.js"
import { maskSensitiveUrl } from "../lib/fetch-with-retry.js"
import { assessLatestFirst, buildLadder, ladderWarning, readTotalCnt, totalCntNote, LATEST_FIRST_SORT } from "./ruling-search.js"

/** 본문 1건당 절단 상한. ⚠ 도구 description의 "최대 6,000자"와 같은 수여야 한다 (nts-ruling.test.ts가 대조) */
export const BUDGET_BODY = 6000

/**
 * 본문 자동 동봉 기본 건수 — `FIN_NTS_BODY_TOP_N` (README 환경변수 표).
 *
 * 종전 `Number(env) || 2`는 **명시한 "0"을 2로 되돌렸다** — 목록만 받겠다는 설정이 조용히
 * 무시되고 비공식 경로(taxlaw)에서 매번 본문 2건을 받아 왔다. 같은 줄이 빈 문자열도
 * `Number("")=0`의 falsy에 기대 처리해, 둘을 구분할 수 없었다.
 * 이 저장소의 환경 파서 관례는 response-cache.ts `resolveCacheTtlMs`다 — **미지정과 명시값을
 * `undefined`로 가르고** 값 자체는 유한수 검사로 거른다. 같은 방식으로 맞춘다.
 *
 * | 입력 | 결과 | 이유 |
 * |---|---|---|
 * | 미지정 · 빈값 · 공백만 | 2 | 설정하지 않은 것과 같다 (`Number("")=0`에 기대지 않는다) |
 * | `"0"` | 0 | 명시 0은 "목록만" |
 * | `"3"` · `" 3 "` | 3 | 정상 |
 * | `"7"` · `"-1"` | 5 · 0 | 범위 밖은 가까운 경계로 — 의도는 "더/덜"이다 |
 * | `"2.9"` | 2 | 스키마가 정수라 소수부는 버린다 |
 * | `"abc"` · `"NaN"` · `"Infinity"` | 2 | 해석 불가 → 기본값 |
 *
 * ⚠ zod 4의 `.default()`는 기본값을 **검증 없이** 통과시킨다(스키마의 int·0~5가 적용되지 않는다).
 *   그래서 환경값을 스키마 기본값으로 넣지 않고 여기서 정수·범위를 보장한 뒤 호출 시점에 쓴다 —
 *   모듈 로드 시 한 번 굳지 않으므로 테스트와 실행이 같은 경로를 탄다.
 */
export function resolveDefaultTopN(): number {
  const raw = process.env.FIN_NTS_BODY_TOP_N
  if (raw === undefined || raw.trim() === "") return 2
  const n = Number(raw)
  if (!Number.isFinite(n)) return 2
  return Math.min(Math.max(Math.trunc(n), 0), 5)
}

const TOP_N_DESCRIPTION = "본문 자동 동봉 건수 (기본 2 — 서버 설정 FIN_NTS_BODY_TOP_N으로 달라질 수 있음, 최대 5, 0=목록만)"

export const FinNtsRulingInputSchema = z.object({
  // 공백만 있는 검색어는 빈 검색어로 API를 불러 "0건"을 돌려줬다 (Codex 9차 M4) — 걷어낸 뒤 검증
  query: z.string().trim().min(1).describe("예규 검색어 (예: 퇴직금 중간정산 손금)"),
  // 생략 시 기본값은 handler에서 resolveDefaultTopN()으로 정한다 (위 ⚠ — zod 기본값은 검증을 우회한다)
  top_n_bodies: z.number().int().min(0).max(5).optional().describe(TOP_N_DESCRIPTION),
})

const INPUT_EXAMPLE = `{"query":"퇴직금 중간정산","top_n_bodies":3}`

/**
 * zod 기본 오류는 영어다 ("Too big: expected number to be <=5") — 사용자에게 그대로 새면
 * 이 서버의 다른 한글 안내와 어긋난다. calc.ts·article.ts와 같은 [INVALID_PARAMETER] 형식으로 맞춘다.
 * 필드별 문구는 스키마의 제약(0~5 정수 / 1자 이상)과 같은 사실을 말해야 한다 — 한쪽만 바뀌면 거짓말이 된다.
 */
function formatInputError(error: z.ZodError, rawInput: unknown): string {
  const raw = (rawInput && typeof rawInput === "object" ? rawInput : {}) as Record<string, unknown>
  const shown = (v: unknown): string => (v === undefined ? "없음" : JSON.stringify(v))
  const seen = new Set<string>()
  const parts: string[] = []
  for (const i of error.issues) {
    const field = String(i.path[0] ?? "")
    if (seen.has(field)) continue
    seen.add(field)
    if (field === "top_n_bodies") {
      parts.push(`top_n_bodies는 0~5의 정수입니다 (입력: ${shown(raw.top_n_bodies)})`)
    } else if (field === "query") {
      parts.push(
        raw.query === undefined
          ? "query(예규 검색어)는 필수입니다"
          : `query는 1자 이상의 검색어 문자열입니다 (공백만으로는 조회하지 않습니다 · 입력: ${shown(raw.query)})`
      )
    } else {
      parts.push(`${field || "입력"}: ${i.message}`)
    }
  }
  return `[INVALID_PARAMETER] fin_nts_ruling: ${parts.join("; ")}\n💡 예: ${INPUT_EXAMPLE}`
}

export const FIN_NTS_RULING_TOOL = {
  name: "fin_nts_ruling",
  description:
    "[재무·세무·회계 전용 — 국세청 예규가 필요하면 이 도구를 우선 사용] " +
    "국세청 예규·법령해석을 검색하고 상위 건의 본문(최대 6,000자, 초과 시 절단 고지)을 자동 동봉한다 (문서번호·회신일자 포함). " +
    "세무 검토서에 예규 원문을 인용할 때 사용.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "예규 검색어" },
      top_n_bodies: { type: "number", description: TOP_N_DESCRIPTION },
    },
    required: ["query"],
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
} as const

/**
 * 국세청 예규 **본문** 동봉 여부 — 기본 OFF.
 * 비공식 경로(taxlaw.nts.go.kr)는 명시적 옵트인이다 (공개 배포 정책, Codex 리뷰 차단 3).
 * 개인 사용자는 .env에 FIN_NTS_BODY_ENABLED=true 한 줄로 활성화한다.
 *
 * 같은 플래그가 tools/list 등록 여부도 결정한다 (index.ts) — OFF면 이 도구가 주는 것은
 * 목록뿐이고, 그 목록은 fin_ruling_search(domains=["nts"])와 겹친다.
 * 판정 규칙을 두 곳에 따로 쓰면 한쪽만 바뀌므로 이 함수 하나만 쓴다.
 */
export function isNtsBodyEnabled(): boolean {
  const v = (process.env.FIN_NTS_BODY_ENABLED || "").toLowerCase()
  return v === "true" || v === "1"
}

export async function handleFinNtsRuling(
  apiClient: LawApiClient,
  rawInput: unknown
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const parsed = FinNtsRulingInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    return {
      content: [{ type: "text", text: formatInputError(parsed.error, rawInput) }],
      isError: true,
    }
  }
  const { query } = parsed.data
  // 생략이면 서버 설정(FIN_NTS_BODY_TOP_N), 명시했으면 그 값 — 명시한 0은 "목록만"이라 살려 둔다
  const topNBodies = parsed.data.top_n_bodies ?? resolveDefaultTopN()

  // ── 검색 (축약 사다리 — 0건에만) ──
  // fin_ruling_search와 같은 사다리를 쓴다. 종전 공용 ladderQueries는 앞토막만 잘라 "임직원 경조사비
  // 복리후생비 손금"의 종착점이 주체 "임직원"이었고, 같은 질의가 두 도구에서 다른 검색어로 흘렀다
  // (Codex 9차 M2 — 이 도구는 상위 건 본문까지 동봉하므로 무관 결과의 비용이 더 크다)
  const ladder = buildLadder(query)
  let items: ReturnType<typeof parseNtsRulings> = []
  let usedStep = 0
  let totalCnt: number | undefined
  try {
    for (let step = 0; step < ladder.length; step++) {
      const xml = await apiClient.fetchApi({
        endpoint: "lawSearch.do",
        target: "ntsCgmExpc",
        type: "XML",
        // sort=ddes — 생략하면 제목 가나다순이라 "퇴직금 중간정산" 163건 중 2021년 건이 "최신"이 되고
        // 본문도 오래된 예규에서 동봉됐다 (Codex 9차 [차단] L, 정렬 실측은 ruling-search.ts DOMAIN_SEARCH)
        extraParams: { query: ladder[step], display: "10", sort: LATEST_FIRST_SORT },
        expectedRoot: "CgmExpc",
      })
      totalCnt = readTotalCnt(xml)
      items = parseNtsRulings(xml, 10)
      if (items.length > 0) {
        usedStep = step
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
    const zeroNote =
      ladder.length > 1
        ? `축약 사다리 ${ladder.map((q) => `"${q}"`).join(" → ")} 전부 0건 — 정상 조회 결과 없음`
        : "정상 조회 결과 없음"
    return {
      content: [
        {
          type: "text",
          text: `[기준: 현행] 국세청 예규 — 0건 (${zeroNote})\n다른 실무 용어로 재시도하거나 fin_ruling_search로 심판례·판례를 함께 확인하세요.\n\n${SOURCE_FOOTER}`,
        },
      ],
    }
  }

  // "최신순"이라 부를 근거 — 전부 받았고 일자를 전부 읽었거나, 받은 순서가 일자 내림차순이다.
  // 판정은 **아래 재정렬 전**의 받은 순서로 한다 (정렬 파라미터가 먹혔는지는 그 순서에만 남아 있다)
  const order = assessLatestFirst(items.map((r) => r.date), totalCnt)
  // 일자 내림차순 재정렬 — 법제처가 정렬해 줬으면 순서가 바뀌지 않는다. 본문 동봉은 이 순서의 앞 N건이다
  items.sort((a, b) => {
    const da = (a.date || "").replace(/[^\d]/g, "")
    const db = (b.date || "").replace(/[^\d]/g, "")
    return db > da ? 1 : db < da ? -1 : 0
  })

  const usedQuery = ladder[usedStep]
  const ladderNote = usedStep > 0 ? ` — 검색어 축약: "${query}" → "${usedQuery}"` : ""
  // 총건수를 확인하지 못했으면 받은 건수 기준으로만 말하고 사유도 적는다 (받은 10건을 검색 총건수로
  // 부르지 않는다). 종전 Math.max(totalCnt, 받은 수)는 totalCnt 2 / 수신 3을 "3건"으로 지어내
  // 받은 3건이 검색 결과 전부인 것처럼 읽혔다 — 받은 건수는 아래 표기에 그대로 남는다
  const unconfirmedTotal = totalCntNote(totalCnt, items.length)
  // 확인된 총건수만 남긴다 — 미확인이면 undefined이고 받은 건수로 메우지 않는다
  const confirmedTotal = unconfirmedTotal === undefined ? totalCnt : undefined
  const total =
    confirmedTotal !== undefined
      ? `${confirmedTotal}건`
      : `받은 ${items.length}건(검색 총건수 미확인 — ${unconfirmedTotal})`
  // 최신순이 아닐 때의 사유는 둘로 갈린다 — 일자를 못 읽어 순서를 확인 못 한 것과, 목록 밖에 더
  // 최신 예규가 있을 수 있는 것. 전부 받은 응답에 "목록 밖"을 붙이면 거짓이라 성립하는 것만 잇는다
  const orderReason = [
    order.undated ? `일자 미상 ${order.undated}건이 있어 받은 순서를 확인하지 못했습니다` : "",
    order.allReturned ? "" : "최신순 미보장(더 최신 예규가 목록 밖에 있을 수 있음)",
  ]
    .filter(Boolean)
    .join(" · ")
  const countNote = order.latestFirst
    ? `${total} 중 최신순 ${items.length}건`
    : `${total} 중 법제처 응답 ${items.length}건을 일자순 정렬${orderReason ? ` — ${orderReason}` : ""}`
  let text = `[기준: 현행] 국세청 예규 — ${countNote}${ladderNote}\n`
  if (usedStep > 0) {
    const warning = ladderWarning(query, usedQuery, items.map((r) => r.title))
    if (warning) text += `  ${warning}\n`
  }
  text += items.map((r, i) => `  ${i + 1}. ${r.docNo} (${r.date}) ${r.title}`).join("\n")

  // ── 본문 동봉 (상위 N건 병렬) ──
  const n = Math.min(topNBodies, items.length)
  if (n === 0) {
    // 0의 출처를 밝힌다 — 입력하지 않았는데 본문이 안 오면 서버 설정을 봐야 한다
    const zeroSource = parsed.data.top_n_bodies === undefined ? " · 서버 설정 FIN_NTS_BODY_TOP_N=0" : ""
    text += `\n\n(본문 미동봉 — top_n_bodies=0${zeroSource})`
  } else if (!isNtsBodyEnabled()) {
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
      // 목록 링크는 법제처가 준 값 그대로다 — 인증키(OC)가 실린 DRF 링크가 오면 출력에 새지 않게
      // &amp;를 되돌린 뒤 가린다 (ruling-search detailUrl과 같은 마지막 방어, Codex 9차)
      const link = maskSensitiveUrl(b.r.link.replace(/&amp;/g, "&"))
      text += `\n\n━━━ 본문: ${b.r.docNo} (${b.r.date}) ━━━\n`
      if (b.ok) {
        text += truncateWithHint(b.text, BUDGET_BODY, `원문 링크 ${link}`)
      } else {
        // 조용한 실패 금지: 본문 실패는 목록을 죽이지 않고 사유를 명시
        text += `⚠ 본문 조회 실패 — "본문 없음"이 아니라 확인 불가입니다.\n${truncateWithHint(b.text || "", 500, "원문 링크")}\n원문: ${link}`
      }
    }
  }

  text += `\n\n※ 이 목록·본문은 국세법령정보시스템(taxlaw.nts.go.kr) 기준`
  text += `\n※ 예규는 국세청 행정해석으로 법원을 구속하지 않습니다 — 조문 근거는 fin_article, 판례 대조는 fin_ruling_search`
  text += `\n${SOURCE_FOOTER}`
  return { content: [{ type: "text", text }] }
}
