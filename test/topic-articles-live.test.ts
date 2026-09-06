/**
 * fin_topic 주제표의 조문 후보 실존·제목 대조 — 실 법제처 API 호출 (LAW_OC 필요)
 *
 * 왜 필요한가:
 *   src/data/topics.ts는 **사람이 적어 둔 큐레이션 표**다. 의미 검색이 아니라 손으로 적은
 *   조문 번호라서, 조문이 개정·이동·삭제되면 표만 낡는다. 그런데 fin_topic은 오류 없이
 *   낡은 번호를 "근거 조문 후보"로 확신형 출력한다 — 사용자는 그 번호로 fin_article을
 *   부르고 엉뚱한 조문을 읽는다. 이 테스트가 그 낡음을 잡는 **유일한** 장치다.
 *
 * 설계 원칙 (test/calc-constants-live.test.ts와 같다):
 *   1) **조회 실패는 skip** — 법제처 장애·분당 한도는 표의 문제가 아니다. 실패로 물들이면
 *      경보가 무뎌진다.
 *   2) **파싱·대조 실패는 fail** — 조문이 없거나 제목이 다르면 표를 갱신해야 한다는 신호다.
 *      조용히 통과시키면 이 테스트가 영구히 무의미해진다.
 *   3) 실패 메시지에 **원문 제목과 표의 title을 나란히** 적는다.
 *
 * ⚠ handleFinArticle을 쓰지 않는다 — 1회 호출이 3단비교·별표·개정·예규까지 여러 번
 *   조회해 분당 한도(기본 30)를 금방 태운다. 여기서는 법령 검색 1회 + 조문 조회 1회의
 *   가벼운 경로(findLaws · buildJO · LawApiClient.getLawText)만 쓴다.
 *
 * 실행: npm run test:live
 */

import { describe, it, expect, beforeAll } from "vitest"
import type { TestContext } from "vitest"
import { config } from "dotenv"
import { LawApiClient } from "../src/lib/api-client.js"
import { findLaws } from "../src/lib/law-search.js"
import { buildJO } from "../src/lib/law-parser.js"
import { TOPICS, TOPICS_VERIFIED_AT, type ArticleCandidate } from "../src/data/topics.js"

config({ quiet: true })

const hasKey = !!process.env.LAW_OC
const d = describe.runIf(hasKey)

/** 법제처 분당 한도(기본 30)에 걸리지 않게 호출을 띄운다 — 다른 라이브 파일과 겹칠 수 있다 */
const CALL_GAP_MS = 1_200
/** 표가 커져도(주제 10개 × 조문 3개 ≈ 조회 40회) beforeAll이 끊기지 않게 넉넉히 */
const LOAD_TIMEOUT_MS = 600_000

let apiClient: LawApiClient
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Loaded<T> = { ok: true; value: T } | { ok: false; reason: string }

/** 조회 실패(장애·한도)와 대조 실패를 구분해 담는다 */
async function load<T>(fn: () => Promise<T>): Promise<Loaded<T>> {
  try {
    return { ok: true, value: await fn() }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

/** skip 사유를 남기고 값을 꺼낸다 — 조회 실패를 테스트 실패로 만들지 않는다 */
function need<T>(ctx: TestContext, key: string, entry: Loaded<T>): T {
  if (!entry.ok) {
    ctx.skip(`[조회 실패 — 표의 문제 아님] ${key}: ${entry.reason}`)
    throw new Error("unreachable")
  }
  return entry.value
}

const mstCache = new Map<string, string>()
async function resolveMst(lawName: string): Promise<string> {
  const cached = mstCache.get(lawName)
  if (cached) return cached
  const laws = await findLaws(apiClient, lawName, undefined, 3)
  const hit = laws.find((l) => l.lawName === lawName) ?? laws[0]
  await sleep(CALL_GAP_MS)
  if (!hit) throw new Error(`법령 검색 0건: ${lawName}`)
  // 표의 law는 fin_article에 그대로 넘어가는 값이다 — 약칭·오타면 여기서 드러난다.
  // 이것은 조회 실패가 아니라 **표의 문제**이므로 skip이 아닌 fail로 올린다.
  if (hit.lawName !== lawName) {
    throw new Error(
      `LAW_NAME_MISMATCH: 표의 법령명 "${lawName}" → 법제처 응답 "${hit.lawName}". ` +
        `표에는 정식 법령명을 적어야 합니다 (약칭 금지)`
    )
  }
  mstCache.set(lawName, hit.mst)
  return hit.mst
}

const asArray = <T,>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v])

interface FetchedArticle {
  /** 법제처가 준 조문 제목 (조문제목 필드, 없으면 조문내용의 괄호에서 추출) */
  title: string
  /** 표시용 조문 번호 ("제45조" · "제10조의2") */
  label: string
}

/**
 * 조문 1개 조회 — 응답 구조가 바뀌면 던진다 (조용한 통과 금지).
 * `조문여부 === "조문"`인 단위만 본다: 편·장·절 제목 행이 같은 배열에 섞여 온다.
 */
async function fetchArticle(law: string, article: string): Promise<FetchedArticle> {
  const mst = await resolveMst(law)
  const raw = await apiClient.getLawText({ mst, jo: buildJO(article) })
  await sleep(CALL_GAP_MS)

  const json = JSON.parse(raw)
  const units = asArray<any>(json?.["법령"]?.["조문"]?.["조문단위"])
  const unit = units.find((u) => u?.["조문여부"] === "조문")
  if (!unit) {
    throw new Error(
      `ARTICLE_NOT_FOUND: ${law} ${article} — 응답에 조문 단위가 없습니다 ` +
        `(조문이 삭제·이동됐거나 법제처 응답 구조가 바뀌었습니다)`
    )
  }

  const num = String(unit["조문번호"] ?? "")
  const branch = String(unit["조문가지번호"] ?? "")
  const label = branch && branch !== "0" ? `제${num}조의${branch}` : `제${num}조`

  // 조문제목이 정식 필드지만, 비어 오는 응답이 있어 조문내용의 "제N조(제목)"에서도 뽑는다
  const rawTitle = String(unit["조문제목"] ?? "").trim()
  const fromBody = /^제\d+조(?:의\d+)?\s*\(([^)]*)\)/.exec(String(unit["조문내용"] ?? "").trim())?.[1]?.trim() ?? ""
  const title = rawTitle || fromBody
  if (!title) {
    throw new Error(
      `TITLE_PARSE_FAILED: ${law} ${article} — 조문 제목을 파싱하지 못했습니다 ` +
        `(조문제목·조문내용 모두 비었습니다. 법제처 응답 구조 변화 확인)`
    )
  }
  return { title, label }
}

/** 표기 흔들림만 무시한다 (공백·가운뎃점·따옴표) — 낱말이 다르면 대조 실패다 */
const normalizeTitle = (s: string): string => s.replace(/[·ㆍ‧•・\s"'“”‘’]/g, "")

/** "표를 갱신하라는 신호"임을 밝히는 실패 메시지 */
function signal(topicId: string, a: ArticleCandidate, fetched: FetchedArticle): string {
  return (
    `[표 갱신 신호] ${a.law} ${a.article} — 조문 제목이 다릅니다 (주제 "${topicId}").\n` +
    `  원문(법제처): ${fetched.label}(${fetched.title})\n` +
    `  표(topics.ts): ${a.article}(${a.title})\n` +
    `  → 조문이 개정·이동됐는지 확인하고 src/data/topics.ts의 title·article과 ` +
    `TOPICS_VERIFIED_AT(현재 ${TOPICS_VERIFIED_AT})을 함께 갱신하세요. ` +
    `테스트를 완화해 통과시키는 것은 답이 아닙니다.`
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 조회 (순차 — 분당 한도를 지킨다)
// ─────────────────────────────────────────────────────────────────────────────

interface Target {
  topicId: string
  candidate: ArticleCandidate
  key: string
}

const targets: Target[] = TOPICS.flatMap((t) =>
  t.articles.map((candidate) => ({
    topicId: t.id,
    candidate,
    key: `${candidate.law} ${candidate.article}`,
  }))
)

const fetched = new Map<string, Loaded<FetchedArticle>>()

beforeAll(async () => {
  if (!hasKey) return
  apiClient = new LawApiClient({ apiKey: process.env.LAW_OC || "" })

  // 같은 (법령, 조문)이 여러 주제에 나올 수 있다 — 한 번만 조회한다
  for (const key of new Set(targets.map((t) => t.key))) {
    const target = targets.find((t) => t.key === key)!
    fetched.set(key, await load(() => fetchArticle(target.candidate.law, target.candidate.article)))
  }
}, LOAD_TIMEOUT_MS)

// ─────────────────────────────────────────────────────────────────────────────

d("fin_topic 주제표 — 조문 실존·제목 대조", () => {
  it("대조할 조문 후보가 하나 이상 있다", () => {
    // 표가 비면 이 파일 전체가 조용히 0건 통과한다 — 그 상태를 정상으로 읽지 않는다
    expect(targets.length, "src/data/topics.ts에 조문 후보가 없습니다").toBeGreaterThan(0)
  })

  for (const { topicId, candidate, key } of targets) {
    it(`${topicId}: ${key} (${candidate.title})`, (ctx) => {
      const entry = fetched.get(key)
      expect(entry, `${key} 조회 결과가 없습니다 (beforeAll 확인)`).toBeDefined()
      const doc = need(ctx, key, entry!)

      // ① 실존 — 요청한 번호와 응답의 번호가 같은가 (법제처는 인접 조문을 돌려주기도 한다)
      expect(
        doc.label,
        `[표 갱신 신호] ${key} — 요청한 조문과 다른 조문이 왔습니다 (원문: ${doc.label}). ` +
          `조문이 이동·삭제됐는지 확인하고 src/data/topics.ts를 갱신하세요.`
      ).toBe(candidate.article)

      // ② 제목 대조 — 표가 낡았는지를 판정하는 본체
      expect(normalizeTitle(doc.title), signal(topicId, candidate, doc)).toBe(normalizeTitle(candidate.title))
    })
  }
})
