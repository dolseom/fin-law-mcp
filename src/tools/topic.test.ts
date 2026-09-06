/**
 * fin_topic 테스트 — 매칭 규칙과 핸들러 계약 (오프라인, CI 상시 실행)
 *
 * 설계 원칙:
 *   1) 매칭 동작은 **이 파일 안의 가짜 Topic 배열**로 검증한다. 실제 TOPICS의 내용에
 *      기대면 표를 채울 때마다 무관한 테스트가 깨지고, 결국 표를 고치는 사람이
 *      테스트를 지우게 된다.
 *   2) 실제 TOPICS에 대해서는 **불변식만** 본다 (id 중복·조문 표기·calc enum 등).
 *      내용이 맞는지는 test/topic-articles-live.test.ts가 실 API로 대조한다.
 *   3) 키 노출 회귀 테스트는 없다 — 이 도구는 법제처 API를 호출하지 않는다.
 *      대신 출력에 실리는 fin_article 인자 JSON이 다시 JSON.parse되는지 확인한다.
 */

import { describe, it, expect } from "vitest"
import {
  matchTopics,
  rankTopics,
  handleFinTopic,
  MAX_TOPICS,
  NO_MATCH_TRIGGERS_SHOWN,
  FIN_TOPIC_TOOL,
} from "./topic.js"
import { FIN_CALC_TOOL } from "./calc.js"
import { TOPICS, TOPICS_VERIFIED_AT, type Topic } from "../data/topics.js"

/** 실제 표와 무관한 최소 주제 — 매칭 규칙만 본다 */
function fake(id: string, triggers: string[], name = id): Topic {
  return {
    id,
    name,
    triggers,
    checks: [`${name} 확인 사항`],
    articles: [{ law: "가상법", article: "제1조", title: "가상 조문", note: "테스트용" }],
    rulingQuery: null,
    calc: null,
    notJudged: [`${name}는 판단하지 않는다`],
  }
}

/** 출력에 실린 fin_article 인자 JSON 줄만 뽑는다 */
function articleArgs(text: string): Array<{ law: string; article: string; basis_date?: string }> {
  return [...text.matchAll(/^ +(\{"law":.*\})$/gm)].map((m) => JSON.parse(m[1]))
}

describe("matchTopics — 트리거 부분 문자열 매칭", () => {
  const 표: Topic[] = [
    fake("card", ["법인카드", "카드"], "법인카드"),
    fake("meal", ["식대", "밥값"], "식대"),
    fake("trip", ["출장비", "출장"], "출장비"),
  ]

  it("트리거 하나가 걸리면 그 주제 하나를 돌려준다", () => {
    expect(matchTopics("법인카드 한도가 궁금합니다", 표).map((t) => t.id)).toEqual(["card"])
  })

  it("띄어쓰기가 달라도 걸린다 — 공백을 지우고 비교한다", () => {
    expect(matchTopics("법인 카드로 결제했어요", 표).map((t) => t.id)).toEqual(["card"])
  })

  it("두 주제가 걸리면 전부 돌려준다", () => {
    const ids = matchTopics("법인카드로 출장 숙박비 결제", 표).map((t) => t.id)
    expect(ids).toContain("card")
    expect(ids).toContain("trip")
  })

  it("걸린 트리거 수가 많은 주제가 앞선다 (점수 = 트리거 수)", () => {
    // "출장비"·"출장"이 둘 다 걸리는 trip(2점) > "카드" 하나만 걸리는 card(1점)
    expect(matchTopics("카드로 낸 출장비", 표).map((t) => t.id)).toEqual(["trip", "card"])
  })

  it("어느 트리거가 걸렸는지 rankTopics가 표 표기 순서로 알려 준다", () => {
    const [top] = rankTopics("출장비 정산", 표)
    expect(top.topic.id).toBe("trip")
    expect(top.matched).toEqual(["출장비", "출장"])
  })

  it("동점이면 표 순서를 유지한다 (안정 정렬)", () => {
    expect(matchTopics("밥값과 출장 처리", 표).map((t) => t.id)).toEqual(["meal", "trip"])
    // 표 순서를 뒤집으면 결과 순서도 뒤집힌다 — 우연히 맞은 정렬이 아님을 확인
    expect(matchTopics("밥값과 출장 처리", [표[2], 표[1], 표[0]]).map((t) => t.id)).toEqual(["trip", "meal"])
  })

  it(`아무리 많이 걸려도 상위 ${MAX_TOPICS}개까지만 돌려준다`, () => {
    const 많은표 = [...Array(7)].map((_, i) => fake(`t${i}`, ["공통어"], `주제${i}`))
    expect(rankTopics("공통어 질문", 많은표)).toHaveLength(7) // 잘린 개수를 세려면 전체가 필요하다
    expect(matchTopics("공통어 질문", 많은표)).toHaveLength(MAX_TOPICS)
  })

  it("걸리는 트리거가 없으면 0건", () => {
    expect(matchTopics("연차수당은 언제 주나요", 표)).toEqual([])
  })

  it("빈 질문은 0건 — 빈 문자열이 모든 주제에 걸리지 않는다", () => {
    expect(matchTopics("   ", 표)).toEqual([])
  })

  it("빈 트리거가 표에 섞여도 전체 매칭이 되지 않는다", () => {
    expect(matchTopics("아무 말", [fake("bad", [""], "빈트리거")])).toEqual([])
  })
})

describe("TOPICS 불변식 — 내용이 아니라 형식만 본다", () => {
  it("표가 비어 있지 않다", () => {
    expect(TOPICS.length).toBeGreaterThan(0)
  })

  it("id가 중복되지 않는다", () => {
    const ids = TOPICS.map((t) => t.id)
    const dups = ids.filter((v, i) => ids.indexOf(v) !== i)
    expect(new Set(ids).size, `중복 id: ${dups.join(", ")}`).toBe(ids.length)
  })

  it("이름·트리거·조문 후보가 비어 있지 않다", () => {
    for (const t of TOPICS) {
      expect(t.name.trim(), `${t.id}: name`).not.toBe("")
      expect(t.triggers.length, `${t.id}: triggers`).toBeGreaterThan(0)
      for (const trigger of t.triggers) expect(trigger.trim(), `${t.id}: 빈 트리거`).not.toBe("")
      expect(t.articles.length, `${t.id}: articles`).toBeGreaterThan(0)
    }
  })

  it("조문 후보의 law·article·title·note가 규칙을 지킨다", () => {
    for (const t of TOPICS) {
      for (const a of t.articles) {
        expect(a.law.trim(), `${t.id}: law`).not.toBe("")
        // 라이브 테스트가 이 표기 그대로 조회한다 — "제45조"·"제10조의2"만 허용
        expect(a.article, `${t.id} ${a.law} ${a.article}: article 표기`).toMatch(/^제\d+조(?:의\d+)?$/)
        expect(a.title.trim(), `${t.id} ${a.law} ${a.article}: title`).not.toBe("")
        expect(a.note.trim(), `${t.id} ${a.law} ${a.article}: note`).not.toBe("")
      }
    }
  })

  // 지원하지 않는 calc_type을 적으면 사용자가 없는 계산을 호출한다.
  // 목록을 여기에 복제하면 fin_calc가 계산을 늘렸을 때 이 테스트가 조용히 낡으므로
  // 도구 정의(JSON Schema)에서 직접 읽는다.
  const CALC_TYPES: readonly string[] = FIN_CALC_TOOL.inputSchema.properties.calc_type.enum
  it(`calc는 null이거나 fin_calc의 ${CALC_TYPES.length}종 중 하나다`, () => {
    for (const t of TOPICS) {
      if (t.calc === null) continue
      expect(CALC_TYPES, `${t.id}: calc="${t.calc}"는 fin_calc에 없는 계산입니다`).toContain(t.calc)
    }
  })

  it("마지막 대조일이 YYYY-MM-DD 형식이다", () => {
    expect(TOPICS_VERIFIED_AT).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe("handleFinTopic — 입력 검증", () => {
  it("question이 없으면 한글 [INVALID_PARAMETER] + isError", async () => {
    const res = await handleFinTopic(null, {})
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain("[INVALID_PARAMETER] fin_topic")
    expect(res.content[0].text).toContain("question(자연어 질문)가 필요합니다")
    // zod 기본 영어 메시지가 그대로 새어 나가면 안 된다
    expect(res.content[0].text).not.toMatch(/expected|received|invalid input/i)
  })

  it("question이 문자열이 아니면 한글로 거부한다", async () => {
    const res = await handleFinTopic(null, { question: 42 })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain("문자열이어야 합니다")
    expect(res.content[0].text).not.toMatch(/expected|received|invalid input/i)
  })

  it("question이 빈 문자열이면 한글로 거부한다", async () => {
    const res = await handleFinTopic(null, { question: "" })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain("한 글자 이상")
  })

  it("basis_date 형식이 틀리면 한글로 거부한다", async () => {
    const res = await handleFinTopic(null, { question: TOPICS[0].triggers[0], basis_date: "2026/01/01" })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain("YYYY-MM-DD 형식이어야 합니다")
    expect(res.content[0].text).not.toMatch(/expected|received|invalid input/i)
  })

  it("입력이 객체가 아니어도 한글 오류로 끝난다 (throw 금지)", async () => {
    // 인자를 특정할 수 없어 라벨이 "입력"으로 떨어지는 경로 — 받침 조사가 "이"여야 한다
    // ("입력가 필요합니다" 방지)
    const res = await handleFinTopic(null, "그냥 문자열")
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain("입력이 필요합니다")
    expect(res.content[0].text).not.toMatch(/expected|received|invalid input/i)
  })
})

describe("handleFinTopic — 출력", () => {
  /** 표의 첫 주제가 반드시 걸리는 질문 (그 주제의 첫 트리거를 그대로 쓴다) */
  const 확실한질문 = TOPICS[0].triggers[0]
  /** 표 전체의 (law, article) 후보 — 출력이 표 밖의 조문을 지어내지 않았는지 대조용 */
  const 표의조문 = new Set(TOPICS.flatMap((t) => t.articles.map((a) => `${a.law}|${a.article}`)))

  it("매칭되면 주제 블록과 fin_article 인자 JSON을 낸다", async () => {
    const res = await handleFinTopic(null, { question: 확실한질문 })
    expect(res.isError).toBeUndefined()
    const text = res.content[0].text
    expect(text).toContain(`■ 주제: ${TOPICS[0].name}`)
    expect(text).toContain("근거 조문 후보 → fin_article 인자 그대로:")
    expect(text).toContain("확인할 사실")
  })

  it("출력의 인자 JSON은 그대로 JSON.parse되고, 표에 있는 조문만 담는다", async () => {
    const args = articleArgs((await handleFinTopic(null, { question: 확실한질문 })).content[0].text)
    expect(args.length, "fin_article 인자 JSON이 한 줄도 없습니다").toBeGreaterThan(0)
    for (const a of args) {
      expect(a.article).toMatch(/^제\d+조(?:의\d+)?$/)
      expect(표의조문, `표에 없는 조문이 출력됐습니다: ${a.law} ${a.article}`).toContain(`${a.law}|${a.article}`)
      expect(a.basis_date, "basis_date를 주지 않았는데 인자에 실렸습니다").toBeUndefined()
    }
    // 첫 주제의 첫 조문은 반드시 실린다 (인자 키 순서까지 고정 — 복사해 붙이는 문자열이다)
    const first = TOPICS[0].articles[0]
    expect(args).toContainEqual({ law: first.law, article: first.article })
  })

  it("basis_date를 주면 모든 인자 JSON에 함께 실린다", async () => {
    const text = (await handleFinTopic(null, { question: 확실한질문, basis_date: "2026-01-01" })).content[0].text
    const args = articleArgs(text)
    expect(args.length).toBeGreaterThan(0)
    for (const a of args) expect(a.basis_date).toBe("2026-01-01")
    expect(text).toContain("기준일 2026-01-01")
  })

  it("0건이면 isError가 아니고, 다음 수와 주제 목록을 안내한다", async () => {
    const res = await handleFinTopic(null, { question: "zzz 아무 데도 없는 말 qqq" })
    expect(res.isError).toBeUndefined()
    const text = res.content[0].text
    expect(text).toContain("매칭된 주제가 없습니다")
    expect(text).toContain("fin_law_search")
    expect(text).toContain(`표에 있는 주제 (${TOPICS.length}개)`)
    for (const t of TOPICS) expect(text, `주제 목록에 ${t.name}이 없습니다`).toContain(t.name)
  })

  it("0건은 '그런 제도가 없다'가 아니라 '이 표에 없다'라고 말한다 (판정이 아님)", async () => {
    const text = (await handleFinTopic(null, { question: "zzz 아무 데도 없는 말 qqq" })).content[0].text
    expect(text).toContain("판정이 아닙니다")
    expect(text).toContain("이 표에 그 주제가 없다")
    // fin_law_search의 0건도 "법이 없다"로 읽히면 안 된다는 경고가 함께 있어야 한다
    expect(text).toContain("그런 법령이 없다")
  })

  it("0건 안내가 사용자 질문 문장을 다른 도구의 인자로 넘기지 않는다", async () => {
    // 실측 결함(9/6): 질문 문장을 fin_law_search의 query로 주면 그 도구는 반드시 0건을 내고,
    // 돌아온 "✗없음"이 "그런 법령은 없다"로 읽혀 (a)형 오답 경로가 된다.
    // 표식을 심어, 질문 조각이 응답 어디에도 실리지 않는다는 것을 고정한다.
    const 표식 = "ZZQQ표식XY"
    const 질문 = `${표식} 직원이 갑자기 그만둔다는데 입사 2년 3개월이면 얼마 줘야해요`
    const text = (await handleFinTopic(null, { question: 질문 })).content[0].text

    expect(text, "0건 안내에 사용자 질문이 그대로 실렸습니다").not.toContain(표식)
    expect(text).not.toContain("얼마 줘야해요")

    // 응답에 남은 인자 JSON은 모두 파싱되고(손으로 이은 문자열이 아님),
    // 어느 값도 사용자 질문에서 온 것이 아니어야 한다
    const jsons = [...text.matchAll(/\{"[^\n{}]*\}/g)].map((m) => JSON.parse(m[0]) as Record<string, string>)
    expect(jsons.length, "다음 수의 인자 JSON이 한 벌도 없습니다").toBeGreaterThan(0)
    for (const j of jsons) {
      for (const v of Object.values(j)) {
        expect(질문, `인자 JSON에 질문 조각이 실렸습니다: ${JSON.stringify(j)}`).not.toContain(v)
      }
    }
  })

  it("0건 안내는 주제 이름과 대표 트리거를 함께 보여 준다", async () => {
    const text = (await handleFinTopic(null, { question: "zzz 아무 데도 없는 말 qqq" })).content[0].text
    for (const t of TOPICS) {
      // 주제 수·이름을 하드코딩하지 않고 TOPICS에서 끌어 쓴다 (표가 늘어도 이 테스트는 산다)
      const shown = t.triggers.slice(0, NO_MATCH_TRIGGERS_SHOWN)
      expect(shown.length, `${t.id}: 트리거가 없습니다`).toBeGreaterThan(0)
      const 줄 = `  · ${t.name} — ${shown.map((s) => `"${s}"`).join(", ")}`
      expect(text, `${t.id}: 이름과 대표 트리거가 한 줄에 없습니다`).toContain(줄)
    }
  })

  it("0건 안내에 보여 준 트리거를 그대로 넣으면 그 주제가 실제로 걸린다", async () => {
    // 안내가 거짓말이 아님을 고정한다. rankTopics(전체)로 본다 — 흔한 말이 여러 주제에
    // 걸리면 MAX_TOPICS 상한에 잘릴 수 있고, 안내가 약속한 것은 "1위"가 아니라 "후보에 든다"이다.
    for (const t of TOPICS) {
      for (const trigger of t.triggers.slice(0, NO_MATCH_TRIGGERS_SHOWN)) {
        const ids = rankTopics(trigger).map((m) => m.topic.id)
        expect(ids, `${t.id}: 안내한 트리거 "${trigger}"를 넣어도 걸리지 않습니다`).toContain(t.id)
      }
    }
  })

  it("0건 안내가 길어져도 한 주제는 한 줄이다 (주제가 늘어도 형식이 무너지지 않는다)", async () => {
    const text = (await handleFinTopic(null, { question: "zzz 아무 데도 없는 말 qqq" })).content[0].text
    const 주제줄 = text.split("\n").filter((l) => TOPICS.some((t) => l.startsWith(`  · ${t.name} — `)))
    expect(주제줄).toHaveLength(TOPICS.length)
  })

  it("매칭 응답의 하단 고지 두 줄은 종전 그대로다", async () => {
    const text = (await handleFinTopic(null, { question: 확실한질문 })).content[0].text
    expect(text).toContain("큐레이션 표")
    expect(text).toContain("fin_article로 확인하세요")
    expect(text).toContain(TOPICS_VERIFIED_AT)
    expect(text).toContain("이 도구는 사안을 판단하지 않습니다")
    // 이 응답은 법제처 원문이 아니다 — 출처 문구를 달면 원문처럼 읽힌다
    expect(text).not.toContain("출처: 법제처")
    // 두 줄이 이 순서로 응답의 맨 끝에 붙는다 — README의 실측 출력이 이 형태다
    const 끝두줄 = text.split("\n").slice(-2)
    expect(끝두줄[0]).toContain("위 조문은")
    expect(끝두줄[1]).toContain("이 도구는 사안을 판단하지 않습니다")
  })

  it("0건 응답에는 '위 조문' 고지가 붙지 않는다 — 가리킬 조문이 없다", async () => {
    const text = (await handleFinTopic(null, { question: "zzz 아무 데도 없는 말 qqq" })).content[0].text
    // 조문을 하나도 내놓지 않은 응답에서 "위 조문"·"대조일"은 없는 것을 있다고 암시한다
    expect(text, "0건인데 '위 조문'을 가리킵니다").not.toContain("위 조문")
    expect(text, "0건인데 큐레이션 조문 고지가 붙었습니다").not.toContain("큐레이션 표")
    expect(text, "0건인데 조문 대조일이 실렸습니다").not.toContain(TOPICS_VERIFIED_AT)
    // 판단하지 않는다는 고지는 0건에도 남는다
    expect(text).toContain("이 도구는 사안을 판단하지 않습니다")
    expect(text).not.toContain("출처: 법제처")
  })

  it("'판단하지 않는다' 고지는 두 경로에서 같은 문장이다 (한쪽만 표류하지 않는다)", async () => {
    const 마지막줄 = async (q: string) =>
      (await handleFinTopic(null, { question: q })).content[0].text.split("\n").at(-1)
    expect(await 마지막줄("zzz 아무 데도 없는 말 qqq")).toBe(await 마지막줄(확실한질문))
  })

  it("판정 기호(✓·✗)를 내지 않는다 — 진입 도구는 판정하지 않는다", async () => {
    const text = (await handleFinTopic(null, { question: 확실한질문 })).content[0].text
    expect(text, "fin_topic 출력에 판정 기호가 있습니다 (표의 문구도 함께 확인)").not.toMatch(/[✓✗]/)
  })
})

describe("FIN_TOPIC_TOOL 정의", () => {
  it("question만 필수이고 basis_date는 선택이다 (zod와 수동 동기화)", () => {
    expect(FIN_TOPIC_TOOL.inputSchema.required).toEqual(["question"])
    expect(Object.keys(FIN_TOPIC_TOOL.inputSchema.properties)).toEqual(["question", "basis_date"])
  })

  it("description은 도구 선택에 필요한 것을 담는다 — 진입점·비판정", () => {
    const d: string = FIN_TOPIC_TOOL.description
    expect(d).toContain("[재무·세무·회계 전용")
    expect(d).toContain("조문 번호를 모를 때")
    expect(d).toContain("판정·계산은 하지 않는다")
  })

  // 도구 정의는 매 세션 모든 대화에 실린다 — 실측(약 600자)에 여유를 둔 상한
  it("도구 정의가 짧게 유지된다", () => {
    const len = JSON.stringify(FIN_TOPIC_TOOL).length
    expect(len, `FIN_TOPIC_TOOL ${len}자`).toBeLessThanOrEqual(900)
  })
})

