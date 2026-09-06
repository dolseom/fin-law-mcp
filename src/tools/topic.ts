/**
 * fin_topic — 자연어 질문에서 **다음 호출 인자**로 건너가는 진입 도구
 *
 * 단절 지점은 검색어가 아니라 조문 번호다. fin_article은 law+article이 필수인데
 * 질문자는 번호를 모르고, fin_law_search는 법령명까지만 준다. 그 사이를
 * src/data/topics.ts의 큐레이션 표가 잇는다.
 *
 * ⚠ 판정 도구가 아니다 — ✓·✗도, 금액 결론도 내지 않는다. "무엇을 확인해야 하는지"와
 *   "다음에 무엇을 호출해야 하는지"만 준다. 판정은 fin_verify, 금액은 fin_calc의 몫이다.
 * ⚠ 법제처 API를 호출하지 않는다 (표만 읽는다). 그래서 SOURCE_FOOTER를 붙이지 않는다 —
 *   이 응답은 법제처 원문이 아니라 사람이 적어 둔 표이고, 출처 문구를 달면 원문처럼 읽힌다.
 */

import { z } from "zod"
import { compactName } from "../lib/fin-common.js"
import { TOPICS, TOPICS_VERIFIED_AT, type Topic } from "../data/topics.js"

/**
 * 한 번에 보여 주는 주제 수 상한.
 * 걸린 것을 전부 쏟으면 진입 도구가 아니라 소음이 된다 — 잘린 개수는 한 줄로 알린다.
 */
export const MAX_TOPICS = 3

/**
 * 비교용 정규화 — 공백·가운뎃점 제거는 fin-common의 compactName을 **그대로 재사용**한다.
 *
 * 재사용 판단: 한국어 질문은 띄어쓰기가 흔들린다("법인 카드"·"법인카드", "경조사 비").
 * 공백을 남기면 트리거 "법인카드"가 "법인 카드"에 걸리지 않아, 진입 도구가 첫 질문부터
 * 0건을 내놓는다. 대가로 어절 경계를 넘는 오탐이 생길 수 있으나("외출 장비" → "출장비"),
 * 이 도구는 판정하지 않고 후보를 최대 3개 보여 줄 뿐이라 **누락이 오탐보다 비싸다**.
 *
 * compactName에 없는 소문자화만 덧붙인다 — 트리거에 영문·약어가 섞일 수 있다(IRP·VAT).
 */
function normalizeForMatch(s: string): string {
  return compactName(s).toLowerCase()
}

/** 매칭 결과 하나 — 어느 트리거가 걸렸는지까지 (출력의 "매칭어") */
export interface TopicMatch {
  topic: Topic
  /** 질문에 실제로 걸린 트리거. 표에 적힌 순서를 유지한다 */
  matched: string[]
}

/**
 * 걸린 트리거 수를 점수로 삼아 정렬한 **전체** 매칭 (상한 적용 전).
 *
 * 의미 검색이 아니다 — 정규화한 질문 문자열에 트리거가 부분 문자열로 들어 있는지만 본다.
 * 형태소 분석도 동의어 확장도 없다. 표의 triggers에 일상어를 넣는 것이 이 도구의 회수율이다.
 */
export function rankTopics(question: string, topics: readonly Topic[] = TOPICS): TopicMatch[] {
  const q = normalizeForMatch(question)
  if (!q) return []

  const hits: Array<TopicMatch & { order: number }> = []
  topics.forEach((topic, order) => {
    const matched = topic.triggers.filter((t) => {
      const n = normalizeForMatch(t)
      // 빈 트리거는 모든 질문에 걸린다 — 표의 실수가 전체 주제를 매칭시키지 않게 막는다
      return n.length > 0 && q.includes(n)
    })
    if (matched.length > 0) hits.push({ topic, matched, order })
  })

  // 동점이면 표 순서를 유지한다 — 표는 "실무자가 실제로 묻는 순서"로 적혀 있어 그 자체가
  // 우선순위다. Array.sort의 안정성에 기대지 않고 order로 명시한다 (엔진 의존 제거).
  hits.sort((a, b) => b.matched.length - a.matched.length || a.order - b.order)
  return hits.map(({ topic, matched }) => ({ topic, matched }))
}

/** 상위 MAX_TOPICS개 주제만 (점수 내림차순, 동점은 표 순서) */
export function matchTopics(question: string, topics: readonly Topic[] = TOPICS): Topic[] {
  return rankTopics(question, topics)
    .slice(0, MAX_TOPICS)
    .map((m) => m.topic)
}

export const FinTopicInputSchema = z.object({
  question: z
    .string()
    .min(1, "question(자연어 질문)은 한 글자 이상이어야 합니다")
    .describe("자연어 질문 (예: 거래처 축의금 20만원을 법인카드로 냈는데 어떻게 처리하나요)"),
  basis_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD 형식이어야 합니다 (예: 2026-01-01)")
    .optional()
    .describe("기준일 (YYYY-MM-DD). 주면 fin_article 인자에 함께 싣는다"),
})
export type FinTopicInput = z.infer<typeof FinTopicInputSchema>

// MCP tools/list 노출용 JSON Schema (zod와 수동 동기화)
export const FIN_TOPIC_TOOL = {
  name: "fin_topic",
  // 도구 정의는 매 세션 모든 대화에 실린다 — 도구 **선택**에 필요한 것만 남긴다:
  // ① 조문 번호를 모를 때 여기서 시작한다 ② 판정·계산은 하지 않는다.
  description:
    "[재무·세무·회계 전용 — 조문 번호를 모를 때 여기서 시작] " +
    "자연어 질문을 큐레이션된 업무 주제표에 맞춰, 답변 전 확인할 사실과 다음 호출 인자" +
    "(fin_article의 법령·조문, 예규 검색어, 계산기)를 돌려준다. " +
    "판정·계산은 하지 않는다 — 조문 본문은 fin_article, 금액은 fin_calc.",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", description: "자연어 질문 (사용자 표현 그대로)" },
      basis_date: { type: "string", description: "기준일 YYYY-MM-DD (생략 시 현행) — fin_article 인자에 함께 실린다" },
    },
    required: ["question"],
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
} as const

const EXAMPLE = `{ "question": "거래처 축의금 20만원을 법인카드로 냈는데 어떻게 처리하나요" }`

/** 인자 라벨 — zod 기본 메시지는 영어라 무엇을 채울지 알기 어렵다 (calc.ts와 같은 방식) */
const LABELS: Record<string, string> = {
  question: "question(자연어 질문)",
  basis_date: "basis_date(기준일)",
}

/**
 * 하단 고지 두 줄 — 표가 낡을 수 있다는 것과, 이 도구가 판단하지 않는다는 것.
 * 마지막 대조일을 함께 실어 "얼마나 낡았는지"를 사용자가 스스로 판단하게 한다.
 */
const FOOTER = [
  `※ 위 조문은 사람이 적어 둔 **큐레이션 표**입니다 — 조문 본문은 반드시 fin_article로 확인하세요 (표의 조문을 실 API로 마지막 대조한 날: ${TOPICS_VERIFIED_AT}).`,
  `※ 이 도구는 사안을 판단하지 않습니다 — 손금·과세 여부와 금액은 조문 본문·예규와 사실관계로 판단하세요.`,
]

function renderTopic(m: TopicMatch, basisDate?: string): string[] {
  const t = m.topic
  const lines: string[] = [`■ 주제: ${t.name} (매칭어: ${m.matched.join(" · ")})`]

  if (t.checks.length > 0) {
    lines.push(`확인할 사실 (답변 전 반드시):`)
    for (const c of t.checks) lines.push(`  · ${c}`)
  }

  lines.push(`근거 조문 후보 → fin_article 인자 그대로:`)
  for (const a of t.articles) {
    lines.push(`  · ${a.law} ${a.article} (${a.title})${a.note ? ` — ${a.note}` : ""}`)
    // 손으로 문자열을 이으면 따옴표·이스케이프가 깨진다 — 반드시 JSON.stringify로 만든다.
    // 그대로 복사해 붙일 수 있어야 하므로 한 줄로 둔다.
    const args: Record<string, string> = { law: a.law, article: a.article }
    if (basisDate) args.basis_date = basisDate
    lines.push(`    ${JSON.stringify(args)}`)
  }

  lines.push(
    t.rulingQuery
      ? `예규 검색어: "${t.rulingQuery}" (fin_ruling_search)${t.rulingNote ? ` — ${t.rulingNote}` : ""}`
      : `예규 검색어: 해당 없음${t.rulingNote ? ` — ${t.rulingNote}` : ""}`
  )
  lines.push(
    t.calc
      ? `계산: fin_calc ${t.calc}${t.calcNote ? ` — ${t.calcNote}` : ""}`
      : `계산: 해당 없음${t.calcNote ? ` — ${t.calcNote}` : ""}`
  )

  if (t.notJudged.length > 0) {
    lines.push(`이 도구가 판단하지 않는 것:`)
    for (const n of t.notJudged) lines.push(`  · ${n}`)
  }
  return lines
}

/**
 * 매칭 0건 — 판정하지 않고 안내만 한다.
 *
 * isError가 아니다: 도구는 물어본 것("표에 이 질문에 걸리는 주제가 있는가")을 정확히 답했다.
 * isError로 만들면 클라이언트에 따라 이 본문이 통째로 감춰져, 사용자는 다음 수도
 * 표에 무엇이 있는지도 보지 못한다 (fin_ping 진단 실패와 같은 판단).
 */
function renderNoMatch(question: string, topics: readonly Topic[]): string[] {
  const lines = [
    `매칭된 주제가 없습니다 — 표의 트리거 중 어느 것도 질문에 나타나지 않았습니다 (부분 문자열 매칭).`,
    ``,
    `다음 수:`,
    `  · 법령부터 찾기 → fin_law_search`,
    `    ${JSON.stringify({ query: question })}`,
    `  · 법령·조문 번호를 이미 안다면 → fin_article({"law":"…","article":"제N조"})`,
    `  · 아래 주제 중 가까운 것이 있으면 그 말을 넣어 다시 물어보세요`,
    ``,
    `표에 있는 주제 (${topics.length}개):`,
  ]
  for (const t of topics) lines.push(`  · ${t.name}`)
  return lines
}

export async function handleFinTopic(
  _apiClient: unknown,
  rawInput: unknown
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const parsed = FinTopicInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    const given = (k: string): unknown => (rawInput as Record<string, unknown> | null | undefined)?.[k]
    const detail = parsed.error.issues
      .map((i) => {
        const key = String(i.path[0] ?? "")
        const label = LABELS[key] || key || "입력"
        // 라벨은 괄호로 끝나 "가"가 맞지만, 인자를 특정하지 못해 폴백한 "입력"은
        // 받침이 있어 "이"를 써야 한다 ("입력가 필요합니다" 방지 — calc.ts와 같은 처리)
        const josa = label === "입력" ? "이" : "가"
        // zod 기본 메시지는 영어다. 타입 오류만 여기서 통째로 한글로 바꾸고,
        // 나머지(min·regex)는 스키마에 한글 메시지를 달아 두었으므로 그대로 쓴다.
        if (i.code === "invalid_type") {
          return given(key) === undefined
            ? `${label}${josa} 필요합니다`
            : `${label}${josa} 문자열이어야 합니다 (받은 값의 형: ${typeof given(key)})`
        }
        return `${label}: ${i.message}`
      })
      .join("; ")
    return {
      content: [{ type: "text", text: `[INVALID_PARAMETER] fin_topic: ${detail}\n💡 예: ${EXAMPLE}` }],
      isError: true,
    }
  }

  const { question, basis_date: basisDate } = parsed.data
  const ranked = rankTopics(question)
  const shown = ranked.slice(0, MAX_TOPICS)

  const body: string[] =
    shown.length === 0 ? renderNoMatch(question, TOPICS) : shown.flatMap((m, i) => (i === 0 ? renderTopic(m, basisDate) : ["", ...renderTopic(m, basisDate)]))

  const lines = [...body]
  if (ranked.length > shown.length) {
    lines.push(
      ``,
      `※ 매칭 ${ranked.length}건 중 상위 ${shown.length}건만 표시했습니다 (${ranked.length - shown.length}건 생략 — 질문을 좁히면 후보가 줄어듭니다).`
    )
  }
  if (basisDate && shown.length > 0) {
    lines.push(``, `※ 기준일 ${basisDate}을 위 fin_article 인자에 함께 실었습니다 — 그 시점 시행본으로 조회됩니다.`)
  }
  lines.push(``, ...FOOTER)

  return { content: [{ type: "text", text: lines.join("\n") }] }
}
