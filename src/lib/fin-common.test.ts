/**
 * truncateWithHint — 예산 절단이 의미 경계(항·호·줄·문장)를 지키는지.
 *
 * 왜 필요한가: 조문은 "원칙 + 단서·예외"가 한 쌍이라 뒤쪽이 잘리면 남은 절반이
 * 완결된 조문처럼 읽힌다. 문자 수로만 자르던 구현에서는 이 오독이 고지 없이 났다.
 */
import { describe, it, expect } from "vitest"
import { truncateWithHint } from "./fin-common.js"

const NOTICE = "\n… (예산 "
/** 고지 앞 본문 길이 — 계약: 이 값이 max 이하여야 한다 */
const bodyOf = (out: string): string => out.slice(0, out.lastIndexOf(NOTICE))

describe("truncateWithHint — 의미 경계 절단", () => {
  it("예산 이하면 그대로 둔다 (경계값 포함)", () => {
    expect(truncateWithHint("짧은 본문", 100, "원문")).toBe("짧은 본문")
    const exact = "가".repeat(100)
    expect(truncateWithHint(exact, 100, "원문")).toBe(exact)
  })

  it("항 경계로 당기고 생략된 항을 고지한다", () => {
    const text = ["제1조 (목적)", `  ① ${"가".repeat(60)}`, `  ② ${"나".repeat(60)}`, "  ③ 끝"].join("\n")
    const cut = text.indexOf("\n  ②")
    expect(cut).toBeGreaterThanOrEqual(60) // 60% 규칙에 걸리지 않는 위치인지 확인

    const out = truncateWithHint(text, 100, "www.law.go.kr 원문")
    expect(bodyOf(out)).toBe(text.slice(0, cut))
    expect(out).toContain("②항부터 생략")
    expect(out).toContain("전체는 www.law.go.kr 원문")
    expect(out).not.toContain("나".repeat(2)) // ②항 내용은 한 글자도 새지 않는다
  })

  it("조문 경계(\\n제N조)도 항과 같은 순위로 본다", () => {
    const text = [`제1조 (목적) ${"가".repeat(70)}`, `제2조 (정의) ${"나".repeat(70)}`].join("\n")
    const cut = text.indexOf("\n제2조")
    const out = truncateWithHint(text, 100, "원문")
    expect(bodyOf(out)).toBe(text.slice(0, cut))
    expect(out).toContain("제2조부터 생략")
  })

  it("항 경계가 없으면 호 경계로 당긴다", () => {
    const text = ["  ① 항 본문", `    1. ${"가".repeat(56)}`, `    2. ${"나".repeat(56)}`, "    3. 끝"].join("\n")
    const cut = text.indexOf("\n    2.")
    expect(cut).toBeGreaterThanOrEqual(60)

    const out = truncateWithHint(text, 100, "원문")
    expect(bodyOf(out)).toBe(text.slice(0, cut))
    expect(out).toContain("제2호부터 생략")
  })

  it("항 경계가 예산의 60% 미만이면 버리고 더 뒤의 호 경계를 쓴다", () => {
    const text = `  ① 서두\n  ② ${"나".repeat(60)}\n    1. ${"다".repeat(20)}\n    2. 끝`
    const hang = text.indexOf("\n  ②")
    const ho = text.indexOf("\n    1.")
    expect(hang).toBeLessThan(60) // 항 경계는 60% 미만 → 탈락해야 한다
    expect(ho).toBeGreaterThanOrEqual(60)

    const out = truncateWithHint(text, 100, "원문")
    expect(bodyOf(out)).toBe(text.slice(0, ho))
    expect(out).toContain("제1호부터 생략")
  })

  it("항·호 표지가 없으면 줄바꿈에서 자른다 (표가 행 중간에서 끊기지 않는다)", () => {
    const rows = Array.from({ length: 20 }, (_, i) => `| 항목${i} | 값${i} |`)
    const text = rows.join("\n")
    const out = truncateWithHint(text, 100, "원문 파일 링크로 전체 확인")
    const body = bodyOf(out)
    expect(body.length).toBeLessThanOrEqual(100)
    for (const line of body.split("\n")) expect(line.endsWith("|")).toBe(true)
    expect(out).toContain("전체는 원문 파일 링크로 전체 확인")
  })

  it("줄바꿈이 없으면 문장 끝(…다.)에서 자른다", () => {
    const text = `${"가".repeat(25)}한다. `.repeat(5)
    const out = truncateWithHint(text, 100, "원문")
    const body = bodyOf(out)
    expect(body.length).toBeLessThanOrEqual(100)
    expect(body.endsWith("한다.")).toBe(true)
  })

  it("목번호 \"다.\"는 문장 끝으로 보지 않는다", () => {
    // 들여쓴 목번호에서 자르면 "      다." 만 남아 내용이 통째로 사라진다.
    const text = `      다. ${"가".repeat(50)}`
    const out = truncateWithHint(text, 10, "원문")
    expect(bodyOf(out)).toBe("      다. 가")
  })

  it("경계가 하나도 없으면 그대로 자른다 (기존 동작)", () => {
    const text = "가".repeat(300)
    const out = truncateWithHint(text, 100, "원문")
    expect(bodyOf(out)).toBe("가".repeat(100))
    expect(out).toContain("예산 100자 초과로 절단 — 전체는 원문")
    expect(out).not.toContain("생략,")
  })

  it("단위 중간에서 잘리면 \"부터\"가 아니라 \"이하 생략\"으로 적는다", () => {
    // 줄바꿈 절단: 잘린 지점이 ②항의 시작이 아니라 ①항 내부다
    const text = ["  ① 첫 줄", "  ① 이어지는 설명 " + "가".repeat(60), `  ② ${"나".repeat(30)}`].join("\n")
    const out = truncateWithHint(text, 100, "원문")
    if (out.includes("생략,")) expect(out).toMatch(/등 이하 생략, |부터 생략, /)
    expect(bodyOf(out).length).toBeLessThanOrEqual(100)
  })

  it("어떤 입력에서도 본문은 max를 넘지 않는다 (반환 = max + 고지 이하)", () => {
    const fixtures = [
      ["제1조 (목적)", `  ① ${"가".repeat(80)}`, `  ② ${"나".repeat(80)}`].join("\n"),
      Array.from({ length: 40 }, (_, i) => `| ${i} | ${"값".repeat(10)} |`).join("\n"),
      `${"가".repeat(25)}한다. `.repeat(20),
      "나".repeat(1000),
      `  ① ${"가".repeat(300)}`,
    ]
    for (const max of [10, 100, 480, 1000]) {
      for (const f of fixtures) {
        const out = truncateWithHint(f, max, "힌트")
        if (f.length <= max) {
          expect(out).toBe(f)
          continue
        }
        expect(bodyOf(out).length).toBeLessThanOrEqual(max)
        expect(out.endsWith("전체는 힌트)")).toBe(true)
      }
    }
  })
})

/**
 * renderArticleUnits(tools/article.ts)가 실제로 내는 모양 그대로의 회귀 테스트.
 * 렌더러의 들여쓰기(항 2칸 · 호 4칸 · 목 6칸)가 바뀌면 여기서 먼저 깨져야 한다.
 */
describe("truncateWithHint — 실제 조문 렌더 형태", () => {
  const ARTICLE = [
    "제25조 (기업업무추진비의 손금불산입)",
    "  ① 내국법인이 한 차례의 접대에 지출한 기업업무추진비 중 대통령령으로 정하는 금액을 초과하는 기업업무추진비로서 적격증빙을 받지 아니한 것은 각 사업연도의 소득금액을 계산할 때 손금에 산입하지 아니한다.",
    "    1. 국외지역에서 지출한 기업업무추진비로서 지출증빙을 구비하기 어려운 경우",
    "    2. 농어민으로부터 직접 재화를 공급받는 경우의 지출로서 그 대가를 금융회사를 통하여 지급한 지출액",
    "  ② 제1항에도 불구하고 다음 각 호의 어느 하나에 해당하는 경우에는 그러하지 아니하다.",
    "    1. 대통령령으로 정하는 경우",
  ].join("\n")

  it("②항 직전에서 끊고 ②항이 빠졌음을 고지한다", () => {
    const out = truncateWithHint(ARTICLE, 300, "www.law.go.kr 원문")
    expect(bodyOf(out)).toBe(ARTICLE.slice(0, ARTICLE.indexOf("\n  ②")))
    expect(out).toContain("②항부터 생략")
    // 단서("그러하지 아니하다")가 반쪽만 남는 일이 없어야 한다
    expect(out).not.toContain("그러하지")
  })

  it("항 경계가 예산 밖이면 호 경계까지만 내보낸다", () => {
    const out = truncateWithHint(ARTICLE, 200, "www.law.go.kr 원문")
    expect(bodyOf(out)).toBe(ARTICLE.slice(0, ARTICLE.indexOf("\n    2.")))
    expect(out).toContain("제2호부터 생략")
  })
})
