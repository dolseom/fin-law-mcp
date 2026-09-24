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
import { TOPICS, TOPICS_VERIFIED_AT, type Topic } from "../data/topics.js"
import { isCalendarBasisDate, BASIS_DATE_CALENDAR_MESSAGE } from "../lib/fin-common.js"

/**
 * 한 번에 보여 주는 주제 수 상한.
 * 걸린 것을 전부 쏟으면 진입 도구가 아니라 소음이 된다 — 잘린 개수는 한 줄로 알린다.
 */
export const MAX_TOPICS = 3

// ─────────────────────────────────────────────────────────────────────────────
// 매칭 규칙 — 어절 단위
//
// 종전(9/6)에는 질문의 공백을 모두 지우고 트리거를 부분 문자열로 찾았다. "누락이 오탐보다
// 비싸다"는 판단이었는데, 9차 리뷰 코퍼스(439문장)로 재니 표 밖 질문 253개 중 116개가
// 주제를 띄웠고 그중 42건은 **어절 이음새**에서만 생긴 말이었다("회사가 지급한" → 가지급,
// "외화 환산" → 화환, "수출 장비" → 출장비). 틀린 주제가 1위로 나가면 LLM이 무관한 조문으로
// 확신형 답을 낸다 — 누락보다 비싸다. 그래서 규칙을 어절 단위로 바꿨다:
//
//   ① 트리거는 **어떤 어절의 시작**에서 일치해야 한다. 뒤에 조사·어미가 붙는 것은 허용한다
//      ("경조사비를" ✓, "외화환산" 안의 "화환" ✗).
//   ② 2글자 이하 트리거는 어절 전체이거나 **뒤에 조사·어미만** 붙어야 한다
//      ("부조를" ✓, "부조리" ✗ / "리스했는데" ✓, "리스크" ✗).
//   ③ 공백이 든 트리거("거래처 접대")는 연속한 어절 각각의 시작에서 일치한다
//      ("거래처랑 접대했는데" ✓). 붙여 써도 된다("거래처접대").
//   ④ 띄어쓰기 흔들림("법인 카드")은 어절 경계를 건너 인정하되, 경계 양쪽 조각이 모두
//      2글자 이상일 때만이다 — "회사 차원"(회사차)·"알 바가"(알바)·"주 차비"(주차비)를 막는다.
//   ⑤ 숫자로 시작하는 트리거는 앞이, 숫자로 끝나는 트리거는 뒤가 숫자·쉼표·점이 아니어야 한다
//      ("2,800만원" 안의 "800만원" ✗, "3.31" 안의 "3.3" ✗).
//   ⑥ "결혼+직원"처럼 +로 이은 트리거는 두 말이 질문 어디에든 모두 있어야 한다(순서 무관).
//
// 세기 — 트리거는 세 벌이다(src/data/topics.ts의 Topic 주석):
//   강(triggers) 4점 — 하나로 주제를 띄운다.
//   약(weakTriggers) 2점 — 넓은 쟁점어("원천징수"·"가산세"). 혼자서는 못 띄운다.
//   맥락(contextTriggers) 1점 — 어느 주제에나 나오는 말("손금"·"거래처"·"대표"). 절대 혼자 못 띄운다.
//   주제는 강 트리거가 하나 이상이거나, 약 트리거가 하나 이상이면서 약·맥락이 합쳐 둘 이상일 때만 뜬다.
//   같은 주제 안에서 겹치는 매칭은 가장 센·긴 것 하나만 센다("미사용 연차수당"을 세 번 세지 않게).
// 동점 — 매칭된 글자 수가 많은 쪽, 그다음 질문에서 먼저 나온 쪽. 표 순서는 끝까지 같을 때만
//   쓴다(뒤쪽 주제가 앞쪽 주제의 범용어에 체계적으로 지던 결함 — 9차 리뷰).
// ─────────────────────────────────────────────────────────────────────────────

/** 이 길이 이하의 트리거는 뒤에 조사·어미만 허용한다 (규칙 ②) */
const SHORT_TRIGGER_MAX = 2

/**
 * 짧은 트리거 뒤에 붙어도 되는 조사·어미 — 어절의 나머지가 이것으로 **시작**하면 허용한다.
 * "이"는 "이사"·"이자"와 부딪혀 따로 둔다(JOSA_I).
 */
const JOSA_PREFIX = [
  "은", "는", "을", "를", "의", "에", "로", "와", "과", "랑", "도", "만", "께", "님", "뿐", "가",
  "으로", "에서", "에게", "한테", "까지", "부터", "보다", "처럼", "마다", "밖에",
  "하", "한", "할", "함", "합", "했", "해", "되", "된", "될", "됐", "돼", "당", "시키", "시",
  "중", "때", "면", "나", "요", "고", "지", "란",
  "인데", "인가", "인지", "인거", "인게", "인줄",
]
/** "이"로 시작하는 조사는 정확한 꼴만 — "대표이사"의 "이사"를 조사로 읽지 않게 */
const JOSA_I = ["이", "인", "이나", "이랑", "이면", "이라", "이고", "이에", "이요", "이지", "이야", "이었", "이던", "이든"]
/** 1글자 트리거는 더 좁게 — 나머지가 정확히 이것이어야 한다("차를" ✓, "차이"·"차원"·"차가운" ✗) */
const JOSA_ONE_CHAR = new Set(["", "를", "을", "가", "는", "은", "도", "로", "으로", "랑", "와", "에", "만"])

function josaOk(rest: string, triggerLength: number): boolean {
  if (triggerLength === 1) return JOSA_ONE_CHAR.has(rest)
  if (rest === "") return true
  if (JOSA_I.some((j) => rest === j || (j.length > 1 && rest.startsWith(j)))) return true
  return JOSA_PREFIX.some((j) => rest.startsWith(j))
}

/**
 * 이 길이 이상의 트리거는 복합어 안에서도 인정한다("직원경조사비" 안의 "경조사비",
 * "대표이사가지급금" 안의 "가지급금"). 어절 경계는 건너지 않는다. 0이면 끈다.
 * 코퍼스 측정(9/16): 0·5·6은 붙여 쓴 복합어 3문장을 놓치고, 4는 그 3문장을 잡으면서 표 밖 오탐이
 * 늘지 않았다. 3으로 내리면 "화환"(외화환산)·"가산금"(국세환급가산금) 급의 오탐이 돌아온다.
 */
const INNER_MATCH_MIN: number = 4

/** 질문을 어절로 나눈 결과 — 매칭은 compact(어절을 이어 붙인 소문자열) 위에서 한다 */
interface Tokenized {
  compact: string
  /** compact의 i번째 글자가 어절의 첫 글자인가 */
  wordStart: boolean[]
  /** compact의 i번째 글자가 속한 어절 번호 */
  wordOf: number[]
  /** 어절 원문 (표시용 — 대소문자 보존) */
  words: string[]
  /** 어절 번호 → compact에서 시작하는 위치 */
  wordBegin: number[]
  /** 어절 번호 → compact에서 끝나는 위치(배타) */
  wordEnd: number[]
}

function tokenize(question: string): Tokenized {
  const words = question
    // 가운뎃점류는 글자(Lo)로 분류되는 것이 섞여 있어 먼저 경계로 바꾼다
    .replace(/[·ㆍ‧•・]/g, " ")
    // 점·쉼표는 숫자 사이(2,800 · 3.3 · 2023.3.31)에서만 어절 안에 남긴다
    .replace(/(?<!\d)[.,]|[.,](?!\d)/g, " ")
    .split(/[^\p{L}\p{N}.,%]+/u)
    .filter((w) => w.length > 0)

  let compact = ""
  const wordStart: boolean[] = []
  const wordOf: number[] = []
  const wordBegin: number[] = []
  const wordEnd: number[] = []
  words.forEach((w, i) => {
    const lower = w.toLowerCase()
    wordBegin.push(compact.length)
    for (let k = 0; k < lower.length; k++) {
      wordStart.push(k === 0)
      wordOf.push(i)
    }
    compact += lower
    wordEnd.push(compact.length)
  })
  return { compact, wordStart, wordOf, words, wordBegin, wordEnd }
}

interface Span {
  start: number
  end: number
}

const startsWithDigit = (s: string) => /^[0-9]/.test(s)
const endsWithDigit = (s: string) => /[0-9]$/.test(s)

/** 규칙 ⑤ — 숫자로 끝난 매칭 뒤에 숫자(또는 숫자 앞의 점·쉼표)가 이어지는가 */
function digitContinues(compact: string, end: number): boolean {
  const next = compact[end] ?? ""
  return /[0-9]/.test(next) || (/[.,]/.test(next) && /[0-9]/.test(compact[end + 1] ?? ""))
}

/**
 * 어절 하나의 앞부분에 말 하나가 규칙 ②·⑤를 지키며 붙어 있는가.
 * 공백이 든 트리거의 각 조각에 쓴다 — 조각마다 같은 규칙을 적용해야 "선물세트 사서"가
 * "선물 사"에 걸리지 않는다(짧은 조각 "선물" 뒤의 "세트"는 조사가 아니다).
 */
function partAtWordStart(word: string, part: string): boolean {
  if (!word.startsWith(part)) return false
  const rest = word.slice(part.length)
  if (endsWithDigit(part) && digitContinues(rest, 0)) return false
  if (!startsWithDigit(part) && part.length <= SHORT_TRIGGER_MAX) return josaOk(rest, part.length)
  return true
}

/** 트리거 하나(+ 없는 말)가 질문에서 규칙 ①~⑤를 지키며 나타나는 자리 전부 (시작 위치 순) */
function findTerm(tk: Tokenized, term: string): Span[] {
  const parts = term.toLowerCase().split(/\s+/).filter(Boolean)
  const t = parts.join("")
  if (!t) return []
  const { compact, wordStart, wordOf, wordBegin, wordEnd, words } = tk
  const found = new Map<number, Span>()

  // (가) 이어 붙인 문자열에서 — 붙여 쓴 질문("거래처접대")과 띄어쓰기 흔들림("법인 카드")
  // 트리거에 적힌 공백의 위치 (t 기준) — 질문의 어절 경계가 여기 오면 규칙 ③으로 허용
  const spaceAt = new Set<number>()
  let acc = 0
  for (const p of parts.slice(0, -1)) {
    acc += p.length
    spaceAt.add(acc)
  }
  for (let p = compact.indexOf(t); p >= 0; p = compact.indexOf(t, p + 1)) {
    const end = p + t.length

    // 규칙 ①·⑤ — 시작 자리 (복합어 안 매칭은 INNER_MATCH_MIN 이상 길이에서만, 어절을 건너지 않을 때만)
    let inner = false
    if (startsWithDigit(t)) {
      if (!wordStart[p] && /[0-9.,]/.test(compact[p - 1])) continue
    } else if (!wordStart[p]) {
      if (INNER_MATCH_MIN === 0 || t.length < INNER_MATCH_MIN) continue
      inner = true
    }

    // 규칙 ③·④ — 매칭 안에 질문의 어절 경계가 있으면 트리거의 공백 자리이거나, 양쪽 조각이 2글자 이상
    let seamOk = true
    let pieceStart = p
    for (let j = 1; j < t.length; j++) {
      if (!wordStart[p + j]) continue
      if (inner) {
        seamOk = false
        break
      }
      if (!spaceAt.has(j)) {
        const before = p + j - pieceStart
        let next = p + j + 1
        while (next < end && !wordStart[next]) next++
        const after = next - (p + j)
        if (before < 2 || after < 2) {
          seamOk = false
          break
        }
      }
      pieceStart = p + j
    }
    if (!seamOk) continue

    // 규칙 ⑤ — 숫자로 끝나면 뒤가 숫자(또는 숫자 앞의 점·쉼표)가 아니어야 한다
    if (endsWithDigit(t) && end < compact.length && !wordStart[end] && digitContinues(compact, end)) continue

    // 규칙 ② — 짧은 트리거는 어절의 나머지가 조사·어미여야 한다 (어절을 건너는 매칭은 ④에서 이미 막힌다)
    if (!startsWithDigit(t) && t.length <= SHORT_TRIGGER_MAX) {
      if (!josaOk(compact.slice(end, wordEnd[wordOf[p]]), t.length)) continue
    }

    found.set(p, { start: p, end })
  }

  // (나) 공백이 든 트리거 — 연속한 어절 각각의 앞부분에서 (규칙 ③: "거래처랑 접대했는데")
  if (parts.length > 1) {
    for (let i = 0; i + parts.length <= words.length; i++) {
      if (found.has(wordBegin[i])) continue
      if (!parts.every((part, k) => partAtWordStart(compact.slice(wordBegin[i + k], wordEnd[i + k]), part))) continue
      const last = i + parts.length - 1
      found.set(wordBegin[i], { start: wordBegin[i], end: wordBegin[last] + parts[parts.length - 1].length })
    }
  }

  return [...found.values()].sort((a, b) => a.start - b.start)
}

/** 트리거의 세기 — Topic.triggers(강) · weakTriggers(약) · contextTriggers(맥락) */
export type TriggerKind = "strong" | "weak" | "context"

/**
 * 세기별 점수. 맥락어는 순위만 가른다 — "업무용 차량 감가상각"에서 업무용승용차 주제가
 * 감가상각 주제를 앞서게 하는 식이다. 점수 비(4:2:1)는 코퍼스로 쟀다(topic-corpus.test.ts).
 */
const KIND_SCORE: Record<TriggerKind, number> = { strong: 4, weak: 2, context: 1 }
const KIND_RANK: Record<TriggerKind, number> = { strong: 0, weak: 1, context: 2 }

/** 매칭어 하나 — 어느 트리거가 질문의 어느 어절에서 걸렸는지 */
export interface TriggerHit {
  /** 표에 적힌 트리거 그대로 */
  trigger: string
  kind: TriggerKind
  /** 질문에서 걸린 어절 원문 — +로 이은 트리거면 말마다 하나씩 */
  words: string[]
}

/** 매칭 결과 하나 — 어느 트리거가 걸렸는지까지 (출력의 "매칭어") */
export interface TopicMatch {
  topic: Topic
  /** 점수에 들어간 트리거 (질문에 나온 순서) */
  matched: string[]
  /** matched와 같은 순서의 상세 — 원문 어절과 세기 */
  hits: TriggerHit[]
}

interface Candidate {
  trigger: string
  kind: TriggerKind
  /** +로 나눈 말마다의 출현 자리들 */
  occurrences: Span[][]
  length: number
}

function overlaps(a: Span, taken: Span[]): boolean {
  return taken.some((b) => a.start < b.end && b.start < a.end)
}

interface Scored extends TopicMatch {
  count: Record<TriggerKind, number>
  score: number
  chars: number
  firstPos: number
  order: number
}

function scoreTopic(tk: Tokenized, topic: Topic, order: number): Scored | null {
  const candidates: Candidate[] = []
  const collect = (list: readonly string[] | undefined, kind: TriggerKind) => {
    for (const trigger of list ?? []) {
      const terms = trigger.split("+").map((s) => s.trim())
      // 빈 트리거·빈 조각은 모든 질문에 걸린다 — 표의 실수가 전체 주제를 매칭시키지 않게 막는다
      if (terms.some((s) => s.replace(/\s+/g, "") === "")) continue
      const occurrences = terms.map((s) => findTerm(tk, s))
      if (occurrences.some((o) => o.length === 0)) continue
      const length = terms.reduce((n, s) => n + s.replace(/\s+/g, "").length, 0)
      candidates.push({ trigger, kind, occurrences, length })
    }
  }
  collect(topic.triggers, "strong")
  collect(topic.weakTriggers, "weak")
  collect(topic.contextTriggers, "context")
  if (candidates.length === 0) return null

  // 겹치는 매칭은 하나만 — 센 트리거 먼저, 같은 세기면 긴 것
  // ("미사용 연차수당"이 "연차"·"연차수당"·"미사용 연차"로 여러 번 세지 않게)
  candidates.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || b.length - a.length)
  const taken: Span[] = []
  const chosen: Array<{ c: Candidate; spans: Span[] }> = []
  for (const c of candidates) {
    const spans: Span[] = []
    for (const occ of c.occurrences) {
      const free = occ.find((s) => !overlaps(s, [...taken, ...spans]))
      if (!free) break
      spans.push(free)
    }
    if (spans.length !== c.occurrences.length) continue
    taken.push(...spans)
    chosen.push({ c, spans })
  }

  const count: Record<TriggerKind, number> = { strong: 0, weak: 0, context: 0 }
  for (const x of chosen) count[x.c.kind]++

  chosen.sort((a, b) => Math.min(...a.spans.map((s) => s.start)) - Math.min(...b.spans.map((s) => s.start)))
  const hits: TriggerHit[] = chosen.map(({ c, spans }) => ({
    trigger: c.trigger,
    kind: c.kind,
    words: spans.map((s) => {
      const from = tk.wordOf[s.start]
      const to = tk.wordOf[s.end - 1]
      return tk.words.slice(from, to + 1).join(" ")
    }),
  }))
  return {
    topic,
    matched: hits.map((h) => h.trigger),
    hits,
    count,
    score: chosen.reduce((n, x) => n + KIND_SCORE[x.c.kind], 0),
    chars: chosen.reduce((n, x) => n + x.c.length, 0),
    firstPos: Math.min(...taken.map((s) => s.start)),
    order,
  }
}

/**
 * 주제를 띄우는 조건 — 강 트리거 하나, 또는 약 트리거 하나 이상이 다른 약·맥락 트리거와 함께.
 * 맥락어만으로는 띄우지 않는다: "회사 명의로 조화 보냈는데 비용처리"가 "회사 명의"·"비용처리"
 * 두 맥락어로 업무용승용차 주제에 걸렸던 것(보류셋 첫 측정)을 막는다.
 */
function surfaces(s: Scored): boolean {
  return s.count.strong > 0 || (s.count.weak > 0 && s.count.weak + s.count.context >= 2)
}

/** rankTopics의 전체 결과 — 약 트리거 하나만 걸려 띄우지 않은 주제까지 */
export interface TopicAnalysis {
  /** 띄운 주제 (점수 내림차순, 상한 적용 전) */
  ranked: TopicMatch[]
  /** 약 트리거 하나만 걸려 띄우지 않은 주제 — 0건 안내에서 "넓은 말만 걸렸다"로 보여 준다 */
  weakOnly: TopicMatch[]
}

export function analyzeTopics(question: string, topics: readonly Topic[] = TOPICS): TopicAnalysis {
  const tk = tokenize(question)
  if (!tk.compact) return { ranked: [], weakOnly: [] }

  const surfaced: Scored[] = []
  const weakOnly: Scored[] = []
  topics.forEach((topic, order) => {
    const s = scoreTopic(tk, topic, order)
    if (!s) return
    if (surfaces(s)) surfaced.push(s)
    else if (s.count.weak > 0) weakOnly.push(s)
  })

  // 동점이면 매칭 글자 수가 많은 쪽, 그다음 질문에서 먼저 나온 쪽. 표 순서는 끝까지 같을 때만
  const byRank = (a: Scored, b: Scored) =>
    b.score - a.score || b.chars - a.chars || a.firstPos - b.firstPos || a.order - b.order
  const strip = ({ topic, matched, hits }: Scored): TopicMatch => ({ topic, matched, hits })
  return { ranked: surfaced.sort(byRank).map(strip), weakOnly: weakOnly.sort(byRank).map(strip) }
}

/**
 * 점수로 정렬한 **전체** 매칭 (상한 적용 전).
 *
 * 의미 검색이 아니다 — 위 규칙 ①~⑥으로 트리거가 질문의 어절에 나타나는지만 본다.
 * 형태소 분석도 동의어 확장도 없다. 표의 triggers에 일상어를 넣는 것이 이 도구의 회수율이다.
 */
export function rankTopics(question: string, topics: readonly Topic[] = TOPICS): TopicMatch[] {
  return analyzeTopics(question, topics).ranked
}

/** 상위 MAX_TOPICS개 주제만 (점수 내림차순) */
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
    .refine(isCalendarBasisDate, BASIS_DATE_CALENDAR_MESSAGE)
    .optional()
    .describe("기준일 (YYYY-MM-DD). 주면 fin_article 인자에 함께 싣는다"),
})

// MCP tools/list 노출용 JSON Schema (zod와 수동 동기화)
export const FIN_TOPIC_TOOL = {
  name: "fin_topic",
  // 도구 정의는 매 세션 모든 대화에 실린다 — 도구 **선택**에 필요한 것만 남긴다:
  // ① 조문 번호를 모를 때의 보조 진입(실험·옵트인) ② 표 밖·오매칭이 있다 ③ 판정·계산은 하지 않는다.
  // FIN_TOPIC_ENABLED=true일 때만 목록에 실린다 (index.ts TOPIC_LISTED)
  description:
    "[재무·세무·회계 전용 · 실험 기능 — 조문 번호를 모를 때의 보조 진입] " +
    "자연어 질문을 13개 업무 주제의 큐레이션 표에 어절로 맞춰, 답변 전 확인할 사실과 다음 호출 인자" +
    "(fin_article의 법령·조문, 예규 검색어, 계산기)를 돌려준다. 표 밖 질문은 0건이고 엉뚱한 주제가 걸릴 수 있다 — 매칭어를 확인하라. " +
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
 * 표가 낡을 수 있다는 고지 — **조문을 실제로 내놓은 응답에만** 붙인다.
 * 마지막 대조일을 함께 실어 "얼마나 낡았는지"를 사용자가 스스로 판단하게 한다.
 *
 * 0건 응답에는 붙이지 않는다: "위 조문"이 가리킬 조문도, 대조일이 낡음을 말해 줄 대상도
 * 그 응답에는 없다. 없는 것을 있다고 암시하는 문장이 된다.
 */
const FOOTER_CURATED = `※ 위 조문은 사람이 적어 둔 **큐레이션 표**입니다 — 조문 본문은 반드시 fin_article로 확인하세요 (표의 조문을 실 API로 마지막 대조한 날: ${TOPICS_VERIFIED_AT}).`

/**
 * 이 도구가 판단하지 않는다는 고지 — **매칭 여부와 무관하게 항상** 붙는다.
 * 0건이라고 해서 판정 도구로 오해될 여지가 줄어드는 것은 아니다.
 */
const FOOTER_NOT_JUDGED = `※ 이 도구는 사안을 판단하지 않습니다 — 손금·과세 여부와 금액은 조문 본문·예규와 사실관계로 판단하세요.`

/** 매칭이 있을 때의 하단 고지 두 줄 — 문구·순서 고정 (README의 실측 출력이 이 형태다) */
const FOOTER = [FOOTER_CURATED, FOOTER_NOT_JUDGED]

/**
 * 매칭어 표시 — 트리거와 **질문에서 걸린 어절**을 나란히 보인다 (예: `과태료 ← "과태료를"`).
 * 트리거만 보이면 LLM은 그 말을 사용자가 썼다고 믿는다. 원문 어절을 함께 보여야
 * "회사가 지급한"에서 "가지급"이 걸린 것 같은 오탐을 읽는 쪽이 알아볼 수 있다.
 * 약 트리거는 [약]을 붙인다 — 같은 말이 다른 쟁점에도 쓰인다는 표시다.
 */
function renderHit(h: TriggerHit): string {
  const tag = h.kind === "weak" ? " [약]" : h.kind === "context" ? " [맥락]" : ""
  return `${h.trigger} ← ${h.words.map((w) => `"${w}"`).join("+")}${tag}`
}

function renderTopic(m: TopicMatch, basisDate?: string): string[] {
  const t = m.topic
  const lines: string[] = [`■ 주제: ${t.name} (매칭어: ${m.hits.map(renderHit).join(" · ")})`]

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

  // 기준일을 받았으면 예규 검색 인자에도 싣는다 — fin_ruling_search의 basis_date는
  // "그날까지 나온 예규만" 남긴다. fin_article에만 실으면 조문은 그 시점, 예규는 현재가 섞인다.
  const rulingCall = basisDate && t.rulingQuery
    ? `fin_ruling_search ${JSON.stringify({ query: t.rulingQuery, basis_date: basisDate })}`
    : "fin_ruling_search"
  lines.push(
    t.rulingQuery
      ? `예규 검색어: "${t.rulingQuery}" (${rulingCall})${t.rulingNote ? ` — ${t.rulingNote}` : ""}`
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
 * 0건 안내에서 주제마다 함께 보여 주는 대표 트리거 수.
 *
 * 3개인 근거: 주제 이름만 나열하면 실무자는 "퇴직금 (일반 근로자)"를 보고도 **무슨 말을
 * 넣어야 걸리는지** 모른다. 3개면 하나가 사용자의 어휘와 어긋나도 둘이 남고, 표에 주제가
 * 몇 개든 한 줄에 다 들어가 화면이 무너지지 않는다 (주제가 늘면 줄 수만 늘고 줄 길이는 그대로).
 */
export const NO_MATCH_TRIGGERS_SHOWN = 3

/**
 * 매칭 0건 — 판정하지 않고, **두 번째 시도로 가는 길**만 준다.
 *
 * isError가 아니다: 도구는 물어본 것("표에 이 질문에 걸리는 주제가 있는가")을 정확히 답했다.
 * isError로 만들면 클라이언트에 따라 이 본문이 통째로 감춰져, 사용자는 다음 수도
 * 표에 무엇이 있는지도 보지 못한다 (fin_ping 진단 실패와 같은 판단).
 *
 * ⚠ 사용자 질문 문장을 다른 도구의 인자로 실어 보내지 않는다 (실측 결함, 9/6).
 *   질문 문장을 fin_law_search의 query로 주면 그 도구는 **반드시** 0건을 낸다 — 법령"명"을
 *   찾는 도구이기 때문이다. 그러면 왕복 한 번과 API 호출 한 번을 버리고, 돌아온 "✗없음"을
 *   LLM이 "그런 법령은 없다"로 읽어 진입 도구가 오히려 잘못된 확신을 만든다.
 *
 * ⚠ 0건은 "표에 그 주제가 없다"가 아니다 (9차 리뷰). 표에 있는 주제를 사용자가 표의 매칭어와
 *   다른 말로 물으면 0건이 난다 — 그때 "이 표에 없다"고 말하면 거짓이다. 그래서 "매칭어에
 *   걸리지 않았다"고만 말하고, 약 트리거 하나만 걸린 주제가 있으면 조문 없이 이름만 보여 준다.
 *
 * 대표 트리거를 **표에 적힌 순서대로 앞에서** 고르는 근거 — 세 후보를 견줬다:
 *   · 짧은 것 우선 → "연차"·"부조" 같은 파편이 대표어가 되어, 무슨 말인지 모를 것이 앞선다.
 *   · 긴 것 우선 → 법령 용어("기업업무추진비")가 앞서는데, 그 말을 아는 사람은 애초에 0건이 나지 않는다.
 *   · 표 순서 → topics.ts의 triggers는 "그 주제를 부르는 대표어 → 변형·일상어" 순으로 적혀 있고,
 *     그 순서를 지킬 책임이 표를 쓰는 사람에게 있다.
 *   표 순서를 골랐다 — 대표어를 정하는 판단은 코드가 아니라 표에 두는 것이 이 도구의 일관된 방침이다.
 *
 * 여기 실린 말을 그대로 넣어 다시 물으면 그 주제는 **반드시 후보에 든다**: 대표어는 강 트리거이고
 * +가 없는 말이며(topic.test.ts 불변식), 트리거 하나만으로 된 질문은 어절 시작에서 일치한다.
 */
function renderNoMatch(topics: readonly Topic[], weakOnly: readonly TopicMatch[]): string[] {
  const lines = [
    `매칭된 주제가 없습니다 — 질문의 어절에서 주제를 띄울 만큼 표의 매칭어가 걸리지 않았습니다.`,
    `※ 이것은 판정이 아닙니다. "그런 제도·규정이 없다"는 뜻이 아니고, **이 표에 주제가 없다는 뜻도 아닙니다** — 표에 있는 주제라도 질문의 말이 매칭어와 다르면 걸리지 않습니다.`,
  ]
  if (weakOnly.length > 0) {
    lines.push(
      ``,
      `■ 넓은 말 하나만 걸린 주제 — 같은 말이 다른 쟁점에도 쓰여 조문 후보를 내지 않았습니다:`
    )
    for (const m of weakOnly) lines.push(`  · ${m.topic.name} (${m.hits.map(renderHit).join(" · ")})`)
    lines.push(`  → 이 주제가 맞다면 아래 목록의 그 주제 말을 질문에 넣어 다시 부르세요.`)
  }
  lines.push(
    ``,
    `■ 다음 수 ① — 아래에서 가까운 주제를 찾아, 오른쪽 말 하나를 그대로 넣어 fin_topic을 다시 부르세요.`,
    `   (오른쪽 말은 그 주제의 실제 트리거입니다 — 그대로 넣으면 반드시 걸립니다)`,
    ``,
    `표에 있는 주제 (${topics.length}개) — 주제 이름 · 다시 물을 때 쓸 말:`
  )
  for (const t of topics) {
    const shown = t.triggers.slice(0, NO_MATCH_TRIGGERS_SHOWN)
    lines.push(`  · ${t.name}${shown.length > 0 ? ` — ${shown.map((s) => `"${s}"`).join(", ")}` : ""}`)
  }
  lines.push(
    ``,
    `■ 다음 수 ② — 표 밖의 주제라면 (표에 없다고 해서 규정이 없는 것은 아닙니다):`,
    `  · 법령·조문 번호를 이미 안다면 → fin_article {"law":"<법령명>","article":"<제N조>"}`,
    `  · 법령명까지만 안다면 → fin_law_search {"query":"<법령명>"} — 예: "법인세법", "근로기준법"`,
    `    ⚠ fin_law_search는 법령의 **이름**을 찾는 도구입니다. 질문 문장을 통째로 넣지 마세요 —`,
    `      반드시 0건이 나오고, 그 0건은 "그런 법령이 없다"가 아니라 "그런 이름의 법령이 없다"는 뜻일 뿐입니다.`
  )
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
  const { ranked, weakOnly } = analyzeTopics(question)
  const shown = ranked.slice(0, MAX_TOPICS)

  const body: string[] =
    shown.length === 0
      ? renderNoMatch(TOPICS, weakOnly)
      : shown.flatMap((m, i) => (i === 0 ? renderTopic(m, basisDate) : ["", ...renderTopic(m, basisDate)]))

  const lines = [...body]
  if (ranked.length > shown.length) {
    lines.push(
      ``,
      `※ 매칭 ${ranked.length}건 중 상위 ${shown.length}건만 표시했습니다 (${ranked.length - shown.length}건 생략 — 질문을 좁히면 후보가 줄어듭니다).`
    )
  }
  if (basisDate && shown.length > 0) {
    lines.push(``, `※ 기준일 ${basisDate}을 위 fin_article 인자와 예규 검색 인자에 함께 실었습니다 — 그 시점 시행본·그날까지 나온 예규로 조회됩니다.`)
  }
  // 조문을 하나라도 내놓았을 때만 큐레이션·대조일 고지를 붙인다.
  // 0건 응답에서 "위 조문"은 가리킬 대상이 없다 (매칭 응답의 두 줄은 종전 그대로).
  lines.push(``, ...(shown.length > 0 ? FOOTER : [FOOTER_NOT_JUDGED]))

  return { content: [{ type: "text", text: lines.join("\n") }] }
}
