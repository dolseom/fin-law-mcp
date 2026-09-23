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
  analyzeTopics,
  handleFinTopic,
  MAX_TOPICS,
  NO_MATCH_TRIGGERS_SHOWN,
  FIN_TOPIC_TOOL,
} from "./topic.js"
import { FIN_CALC_TOOL } from "./calc.js"
import { TOPICS, TOPICS_VERIFIED_AT, type Topic } from "../data/topics.js"

/** 실제 표와 무관한 최소 주제 — 매칭 규칙만 본다 */
function fake(id: string, triggers: string[], name = id, extra: Partial<Topic> = {}): Topic {
  return {
    id,
    name,
    triggers,
    checks: [`${name} 확인 사항`],
    articles: [{ law: "가상법", article: "제1조", title: "가상 조문", note: "테스트용" }],
    rulingQuery: null,
    calc: null,
    notJudged: [`${name}는 판단하지 않는다`],
    ...extra,
  }
}

/** 출력에 실린 fin_article 인자 JSON 줄만 뽑는다 */
function articleArgs(text: string): Array<{ law: string; article: string; basis_date?: string }> {
  return [...text.matchAll(/^ +(\{"law":.*\})$/gm)].map((m) => JSON.parse(m[1]))
}

const ids = (q: string, 표: Topic[]) => matchTopics(q, 표).map((t) => t.id)

describe("matchTopics — 어절 단위 매칭", () => {
  const 표: Topic[] = [
    fake("card", ["법인카드"], "법인카드"),
    fake("meal", ["식대", "밥값"], "식대"),
    fake("trip", ["출장비", "출장"], "출장비"),
  ]

  it("트리거 하나가 걸리면 그 주제 하나를 돌려준다", () => {
    expect(ids("법인카드 한도가 궁금합니다", 표)).toEqual(["card"])
  })

  it("트리거 뒤에 조사·어미가 붙어도 걸린다", () => {
    expect(ids("법인카드로 결제했어요", 표)).toEqual(["card"])
    expect(ids("출장비를 정액으로 주면", 표)).toEqual(["trip"])
  })

  it("띄어쓰기가 흔들려도 걸린다 — 경계 양쪽 조각이 2글자 이상이면", () => {
    expect(ids("법인 카드로 결제했어요", 표)).toEqual(["card"])
  })

  it("어절 이음새에서만 생기는 말에는 걸리지 않는다 (9차 리뷰 차단 결함)", () => {
    const 이음새표 = [fake("loan", ["가지급"]), fake("car", ["회사차", "주차비"]), fake("pt", ["알바"])]
    // 공백을 지우면 "회사가지급한"·"회사차원"·"주차비"·"알바가"가 되지만 사용자는 그 말을 쓰지 않았다
    expect(ids("회사가 지급한 과태료 손금 되나요", 이음새표)).toEqual([])
    expect(ids("회사 차원에서 결산 일정", 이음새표)).toEqual([])
    expect(ids("이번 주 차비 좀 아껴야겠어요", 이음새표)).toEqual([])
    expect(ids("그건 내 알 바가 아니에요", 이음새표)).toEqual([])
  })

  it("어절 안쪽에서 시작하는 짧은 말에는 걸리지 않는다", () => {
    const 내부표 = [fake("flower", ["화환"]), fake("trip2", ["출장비"])]
    expect(ids("기말 외화환산손익 계산", 내부표)).toEqual([])
    expect(ids("수출 장비 선적 서류", 내부표)).toEqual([])
  })

  it("2글자 이하 트리거는 뒤에 조사·어미만 허용한다", () => {
    const 짧은표 = [fake("condolence", ["부조"]), fake("lease", ["리스"])]
    expect(ids("거래처 상가에 부조를 했어요", 짧은표)).toEqual(["condolence"])
    expect(ids("부조리 신고 절차", 짧은표)).toEqual([])
    expect(ids("차를 리스했는데 비용처리", 짧은표)).toEqual(["lease"])
    expect(ids("환율 리스크 관리", 짧은표)).toEqual([])
  })

  it("'이'로 시작하는 나머지는 정확한 조사 꼴만 허용한다 — '대표이사'의 '이사'는 조사가 아니다", () => {
    const 표2 = [fake("boss", ["사장", "대표"])]
    expect(ids("사장이 돈 뺐어요", 표2)).toEqual(["boss"])
    expect(ids("대표님이 가져갔어요", 표2)).toEqual(["boss"])
    expect(ids("대표이사 상여금", 표2)).toEqual([])
  })

  it("1글자 트리거는 나머지가 정확한 조사일 때만 걸린다", () => {
    const 한글자표 = [fake("car", ["차"])]
    expect(ids("차를 샀는데", 한글자표)).toEqual(["car"])
    expect(ids("3개월 차이", 한글자표)).toEqual([])
    expect(ids("차가운 반응", 한글자표)).toEqual([])
  })

  it("공백이 든 트리거는 연속 어절 각각의 앞부분에서 걸린다", () => {
    const 공백표 = [fake("ent", ["거래처 접대"]), fake("gift", ["선물 사"])]
    expect(ids("거래처랑 접대했는데 영수증", 공백표)).toEqual(["ent"])
    expect(ids("거래처접대비 한도", 공백표)).toEqual(["ent"])
    // 조각에도 짧은 말 규칙이 걸린다 — "선물세트"의 "세트"는 조사가 아니다
    expect(ids("선물세트 사서 돌렸어요", 공백표)).toEqual([])
    expect(ids("선물 사 줬어요", 공백표)).toEqual(["gift"])
  })

  it("숫자 트리거는 더 긴 숫자의 일부에서 걸리지 않는다", () => {
    const 숫자표 = [fake("car", ["800만원"]), fake("fee", ["3.3"]), fake("ins", ["60시간"])]
    expect(ids("연봉 2,800만원 직원", 숫자표)).toEqual([])
    expect(ids("3.31 기준 결산", 숫자표)).toEqual([])
    expect(ids("2023.3.15에 산 기계", 숫자표)).toEqual([])
    expect(ids("월 160시간 근무", 숫자표)).toEqual([])
    expect(ids("3.3% 떼고 줬어요", 숫자표)).toEqual(["fee"])
    expect(ids("감가상각 800만원 한도", 숫자표)).toEqual(["car"])
    expect(ids("월60시간 미만", 숫자표)).toEqual(["ins"])
  })

  it("4글자 이상 트리거는 붙여 쓴 복합어 안에서도 걸린다 — 어절 경계는 건너지 않는다", () => {
    const 복합표 = [fake("c", ["경조사비"]), fake("p", ["가지급금"]), fake("m", ["법인명의"])]
    expect(ids("직원경조사비 한도", 복합표)).toEqual(["c"])
    expect(ids("대표이사가지급금 정리", 복합표)).toEqual(["p"])
    // "외국법인" 안에서 시작해 다음 어절로 넘어가는 매칭은 인정하지 않는다
    expect(ids("외국법인 명의로 송금", 복합표)).toEqual([])
  })

  it("+로 이은 트리거는 두 말이 질문 어디에든 모두 있어야 걸린다 (순서 무관)", () => {
    const 조합표 = [fake("wed", ["결혼+직원"])]
    expect(ids("직원이 결혼해서 50만원 줬어요", 조합표)).toEqual(["wed"])
    expect(ids("결혼하는 직원 축하금", 조합표)).toEqual(["wed"])
    expect(ids("자녀 결혼시키면 증여재산공제", 조합표)).toEqual([])
    const [top] = rankTopics("직원이 결혼해서", 조합표)
    expect(top.hits[0].words).toEqual(["결혼해서", "직원이"])
  })

  it("두 주제가 걸리면 전부 돌려준다", () => {
    const got = ids("법인카드로 출장 숙박비 결제", 표)
    expect(got).toContain("card")
    expect(got).toContain("trip")
  })

  it("겹치는 매칭은 가장 긴 것 하나만 센다 — 트리거가 서로를 포함해도 점수가 부풀지 않는다", () => {
    const [top] = rankTopics("출장비 정산", 표)
    expect(top.topic.id).toBe("trip")
    expect(top.matched).toEqual(["출장비"])
  })

  it("걸린 어절 원문을 함께 알려 준다 (출력의 '매칭어 ← 원문')", () => {
    const [top] = rankTopics("법인 카드로 결제했어요", 표)
    expect(top.hits).toEqual([{ trigger: "법인카드", kind: "strong", words: ["법인 카드로"] }])
  })

  it("동점을 표 순서가 아니라 매칭 글자 수로 가른다 — 표 순서를 뒤집어도 결과가 같다", () => {
    const 동점표 = [fake("short", ["식대"]), fake("long", ["출장비"])]
    expect(ids("식대랑 출장비 처리", 동점표)).toEqual(["long", "short"])
    expect(ids("식대랑 출장비 처리", [동점표[1], 동점표[0]])).toEqual(["long", "short"])
  })

  it("글자 수까지 같으면 질문에서 먼저 나온 주제가 앞선다", () => {
    const 동점표 = [fake("a", ["밥값"]), fake("b", ["식대"])]
    expect(ids("식대랑 밥값", 동점표)).toEqual(["b", "a"])
    expect(ids("밥값이랑 식대", 동점표)).toEqual(["a", "b"])
  })

  it(`아무리 많이 걸려도 상위 ${MAX_TOPICS}개까지만 돌려준다`, () => {
    const 많은표 = [...Array(7)].map((_, i) => fake(`t${i}`, ["공통어"], `주제${i}`))
    expect(rankTopics("공통어 질문", 많은표)).toHaveLength(7) // 잘린 개수를 세려면 전체가 필요하다
    expect(matchTopics("공통어 질문", 많은표)).toHaveLength(MAX_TOPICS)
  })

  it("걸리는 트리거가 없으면 0건", () => {
    expect(matchTopics("연차수당은 언제 주나요", 표)).toEqual([])
  })

  it("빈 질문·문장부호만 있는 질문은 0건 — 빈 문자열이 모든 주제에 걸리지 않는다", () => {
    expect(matchTopics("   ", 표)).toEqual([])
    expect(matchTopics("?!.", 표)).toEqual([])
  })

  it("빈 트리거·빈 조각이 표에 섞여도 전체 매칭이 되지 않는다", () => {
    expect(matchTopics("아무 말", [fake("bad", [""], "빈트리거")])).toEqual([])
    expect(matchTopics("직원 아무 말", [fake("bad2", ["+직원"], "빈조각")])).toEqual([])
  })
})

describe("analyzeTopics — 강·약·맥락 트리거", () => {
  const 표: Topic[] = [
    fake("fee", ["강사료"], "강사료", { weakTriggers: ["원천징수", "3.3"], contextTriggers: ["세금"] }),
    fake("car", ["업무용승용차"], "승용차", { weakTriggers: ["리스"], contextTriggers: ["감가상각", "비용처리", "회사 명의"] }),
    fake("dep", ["감가상각"], "감가상각"),
  ]

  it("약 트리거 하나만으로는 주제를 띄우지 않고, 0건 안내용 목록(weakOnly)에만 남긴다", () => {
    const r = analyzeTopics("배당금 원천징수 세율", 표)
    expect(r.ranked).toEqual([])
    expect(r.weakOnly.map((m) => m.topic.id)).toEqual(["fee"])
  })

  it("약 트리거 둘, 또는 약 트리거 + 맥락어면 띄운다", () => {
    expect(analyzeTopics("3.3 원천징수", 표).ranked.map((m) => m.topic.id)).toEqual(["fee"])
    expect(analyzeTopics("원천징수 세금 계산", 표).ranked.map((m) => m.topic.id)).toEqual(["fee"])
  })

  it("맥락어만으로는 둘이 걸려도 띄우지 않는다", () => {
    const r = analyzeTopics("회사 명의로 조화 보냈는데 비용처리", 표)
    expect(r.ranked).toEqual([])
    expect(r.weakOnly).toEqual([]) // 맥락어는 "넓은 말만 걸린 주제" 안내에도 올리지 않는다
  })

  it("맥락어는 순위를 가른다 — 다른 주제의 강 트리거를 맥락어로 두면 그 말이 함께 나올 때 앞선다", () => {
    // car = 강(업무용승용차) + 맥락(감가상각) > dep = 강(감가상각)
    expect(ids("업무용승용차 감가상각 한도", 표)).toEqual(["car", "dep"])
    // 강 트리거는 약 + 맥락보다 앞선다 — "리스 회계 사용권자산 감가상각"이 업무용승용차로 가지 않게
    expect(ids("리스 감가상각", 표)).toEqual(["dep", "car"])
  })

  it("세기가 hits에 실린다", () => {
    const [top] = analyzeTopics("원천징수 세금 계산", 표).ranked
    expect(top.hits.map((h) => [h.trigger, h.kind])).toEqual([
      ["원천징수", "weak"],
      ["세금", "context"],
    ])
  })
})

describe("TOPICS 불변식 — 내용이 아니라 형식만 본다", () => {
  it("표가 비어 있지 않다", () => {
    expect(TOPICS.length).toBeGreaterThan(0)
  })

  it(`대표어(앞 ${NO_MATCH_TRIGGERS_SHOWN}개)는 +가 없는 강 트리거다 — 0건 안내가 "그대로 넣으면 걸린다"고 약속하는 말이다`, () => {
    for (const t of TOPICS) {
      for (const s of t.triggers.slice(0, NO_MATCH_TRIGGERS_SHOWN)) {
        expect(s, `${t.id}: 대표어 "${s}"에 +가 있습니다`).not.toContain("+")
      }
    }
  })

  it("같은 강 트리거가 두 주제에 있지 않다 — 있으면 동점을 표 밖의 요인이 가른다 (9차 리뷰: 접대비·차량 감가상각)", () => {
    const owner = new Map<string, string>()
    const dups: string[] = []
    for (const t of TOPICS) {
      for (const s of t.triggers) {
        const key = s.replace(/\s+/g, "").toLowerCase()
        const prev = owner.get(key)
        if (prev && prev !== t.id) dups.push(`"${s}": ${prev} ↔ ${t.id}`)
        owner.set(key, t.id)
      }
    }
    expect(dups).toEqual([])
  })

  it("한 주제 안에서 같은 말이 강·약·맥락에 겹쳐 적히지 않는다", () => {
    for (const t of TOPICS) {
      const all = [...t.triggers, ...(t.weakTriggers ?? []), ...(t.contextTriggers ?? [])].map((s) => s.replace(/\s+/g, "").toLowerCase())
      const dups = all.filter((v, i) => all.indexOf(v) !== i)
      expect(dups, `${t.id}: 중복 트리거`).toEqual([])
    }
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

/**
 * 표의 **산문**이 원문보다 넓거나 좁게 적혀 있던 자리를 잠근다.
 *
 * 매칭 기대값이 아니다 — 트리거·점수·순위는 위쪽 가짜 표로만 본다. 여기서 보는 것은
 * checks·note 문장이 조문의 요건 구조(한정·AND·OR·별도 한도)를 지우지 않는지다.
 * 산문은 매칭에 쓰이지 않고 topic.ts가 출력에 그대로 싣기만 하므로, 이 단언이 깨지면
 * 그것은 매처 회귀가 아니라 **표의 사실관계 회귀**다.
 *
 * 근거는 `.release-scratch/probes/r9-prose-cache/`의 오프라인 캐시 판본이다(2026-09-16 수집):
 *   소득세법 제12조 3호 러목(MST 280405) · 국민연금법 시행령 제2조 4호(MST 272577)
 *   법인세법 제27조의2 제3~5항(MST 280349) · 법인세법 시행령 제50조의2 제13·15항(MST 283635)
 */
describe("TOPICS 산문 — 조문의 요건 구조를 지우지 않는다", () => {
  const 주제 = (id: string): Topic => {
    const found = TOPICS.find((t) => t.id === id)
    if (found === undefined) throw new Error(`주제 ${id}가 표에서 사라졌습니다`)
    return found
  }

  it("식대 비과세 — 현물 식사는 사내급식·유사 제공일 때이고, 법인카드 결제만으로 단정하지 않는다", () => {
    const t = 주제("meal-allowance-nontaxable")
    const checks = t.checks.join("\n")
    // 러목 앞부분의 한정을 문장에 남긴다 ("법인카드로 먹으면 비과세"로 읽히면 안 된다)
    expect(checks).toContain("사내급식이나 이와 유사한 방법으로 제공받는 식사")
    expect(checks).toContain("법인카드로 결제했다는 사실만으로 그 요건이 채워지지는 않는다")
    // 20만원은 "식사 등을 제공받지 아니하는 근로자"의 식사대에만 붙는 한도다
    expect(checks).toContain("식사를 제공받지 아니하는 근로자에 한정")
    expect(checks).toContain("월 20만원")
    const 러목 = t.articles.find((a) => a.law === "소득세법" && a.article === "제12조")?.note ?? ""
    expect(러목).toContain("제3호 러목")
    expect(러목).toContain("식사 기타 음식물을 제공받지 아니하는 자에 한정한다")
  })

  it("국민연금 60시간 미만 예외 — 나목에도 3개월 계속근로, 다목은 합산 60시간 + 그 사업장에서의 적용 희망", () => {
    const checks = 주제("social-insurance-coverage").checks.join("\n")
    expect(checks).toContain("3개월 이상 계속 근로하면서 사용자 동의를 받아 근로자 적용을 희망하는 사람(나목")
    expect(checks).toContain("각 사업장의 1개월 소정근로시간 합이 60시간 이상인 사람이 60시간 미만인 그 사업장에서 적용을 희망")
    // 네 갈래는 국민연금 시행령의 예외다 — 건강보험·고용보험 예외와 뭉뚱그리지 않는다
    expect(checks).toContain("건강보험·고용보험에는 각각 다른 예외가 있다")
  })

  it("업무용승용차 — 400만원 축소는 감가상각비 한도와 처분손실 한도 둘 다에 걸린다", () => {
    const t = 주제("business-vehicle-expense")
    const checks = t.checks.join("\n")
    expect(checks).toContain("처분손실 한도 800만원")
    expect(checks).toContain("제4항 처분손실")
    // 소규모법인 요건은 3개 AND, 그중 둘째 안이 임대업 주업 OR 수입비율이다
    expect(checks).toContain("세 요건을 모두 갖춘 법인")
    expect(checks).toContain("부동산 임대업이 주된 사업이거나")
    expect(checks).toContain("상시근로자 5명 미만")
    // 운행기록 미작성 기준(1,500만원→500만원)은 800/400과 다른 줄기다 — 섞이면 안 된다
    expect(checks).toContain("1,500만원이 500만원")
    const note = t.articles.find((a) => a.law === "법인세법" && a.article === "제27조의2")?.note ?? ""
    expect(note).toContain("제4항이 처분손실")
    expect(note).toContain("제3항·제4항의 800만원을 각각 400만원으로")
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

  it("basis_date를 주면 예규 검색 인자에도 실린다 — 조문은 그 시점, 예규는 현재가 섞이지 않게 (9차 리뷰)", async () => {
    const q = TOPICS[0].rulingQuery
    expect(q, "첫 주제에 예규 검색어가 없습니다").not.toBeNull()
    const text = (await handleFinTopic(null, { question: 확실한질문, basis_date: "2026-01-01" })).content[0].text
    expect(text).toContain(`fin_ruling_search ${JSON.stringify({ query: q, basis_date: "2026-01-01" })}`)
    // 기준일이 없으면 종전 표기 그대로 (README의 실측 출력)
    const plain = (await handleFinTopic(null, { question: 확실한질문 })).content[0].text
    expect(plain).toContain(`예규 검색어: "${q}" (fin_ruling_search)`)
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

  it("0건은 '그런 제도가 없다'도 '표에 주제가 없다'도 아니라고 말한다 (판정이 아님 — 9차 리뷰)", async () => {
    const text = (await handleFinTopic(null, { question: "zzz 아무 데도 없는 말 qqq" })).content[0].text
    expect(text).toContain("판정이 아닙니다")
    // 표에 있는 주제를 다른 말로 물어도 0건이 난다 — "이 표에 그 주제가 없다"고 단정하면 거짓이다
    expect(text).not.toContain("이 표에 그 주제가 없다")
    expect(text).toContain("이 표에 주제가 없다는 뜻도 아닙니다")
    // fin_law_search의 0건도 "법이 없다"로 읽히면 안 된다는 경고가 함께 있어야 한다
    expect(text).toContain("그런 법령이 없다")
  })

  it("약 트리거 하나만 걸린 주제는 조문 없이 이름과 걸린 말만 0건 안내에 보여 준다", async () => {
    // 실제 표의 약 트리거 중, 그 말 하나만으로 된 질문이 약 트리거 단독이 되는 것을 고른다 (표 내용에 기대지 않게)
    const pick = TOPICS.flatMap((t) => (t.weakTriggers ?? []).map((w) => ({ t, w }))).find(
      ({ t, w }) => rankTopics(w).length === 0 && analyzeTopics(w).weakOnly.some((m) => m.topic.id === t.id)
    )
    expect(pick, "약 트리거 단독 질문을 만들 수 없습니다 — 표의 weakTriggers 확인").toBeDefined()
    const text = (await handleFinTopic(null, { question: pick!.w })).content[0].text
    expect(text).toContain("매칭된 주제가 없습니다")
    expect(text).toContain("넓은 말 하나만 걸린 주제")
    expect(text).toContain(`  · ${pick!.t.name} (${pick!.w} ← "${pick!.w}" [약])`)
    expect(articleArgs(text), "약 트리거만 걸렸는데 조문 인자를 냈습니다").toEqual([])
  })

  it("매칭어마다 질문에서 걸린 원문 어절을 함께 보인다 — 오탐을 읽는 쪽이 알아볼 수 있게", async () => {
    const trigger = TOPICS[0].triggers[0]
    const text = (await handleFinTopic(null, { question: `${trigger}를 회사에서 줬어요` })).content[0].text
    expect(text).toContain(`■ 주제: ${TOPICS[0].name} (매칭어: ${trigger} ← "${trigger}를"`)
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

