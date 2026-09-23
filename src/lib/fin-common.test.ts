/**
 * truncateWithHint — 예산 절단이 의미 경계(항·호·줄·문장)를 지키는지.
 *
 * 왜 필요한가: 조문은 "원칙 + 단서·예외"가 한 쌍이라 뒤쪽이 잘리면 남은 절반이
 * 완결된 조문처럼 읽힌다. 문자 수로만 자르던 구현에서는 이 오독이 고지 없이 났다.
 */
import { describe, it, expect, vi, afterEach } from "vitest"
import { truncateWithHint, parseUpcomingVersions, isFutureDate } from "./fin-common.js"

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

// ── 시행예정 판정 (9차 리뷰 B3·I2) ──────────────────────────────────────

/** 시각 고정 — Date만 가짜로 둔다 (타이머까지 가짜면 다른 비동기 코드가 멈춘다) */
function freezeAt(iso: string): void {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date(iso))
}

describe("isFutureDate — 오늘은 한국 시간 기준 (I2)", () => {
  const savedTz = process.env.TZ
  afterEach(() => {
    vi.useRealTimers()
    if (savedTz === undefined) delete process.env.TZ
    else process.env.TZ = savedTz
  })

  it("UTC 호스트에서 1월 1일 새벽(KST)에 당일 시행 법령을 시행예정으로 보지 않는다", () => {
    // 2026-01-01 00:30 KST = 2025-12-31 15:30 UTC — 세법 1.1. 시행일 새벽. 호스트 로컬 날짜는 12-31이다
    process.env.TZ = "UTC"
    freezeAt("2026-01-01T00:30:00+09:00")
    expect(isFutureDate("20260101")).toBe(false)
    expect(isFutureDate("20260102")).toBe(true)
  })

  it("반대 방향: KST 12월 31일 밤에는 다음 날 시행이 아직 시행예정이다 (UTC·KST 호스트 모두)", () => {
    for (const tz of ["UTC", "Asia/Seoul", "America/Los_Angeles"]) {
      process.env.TZ = tz
      freezeAt("2025-12-31T23:30:00+09:00")
      expect(isFutureDate("20260101"), tz).toBe(true)
      expect(isFutureDate("20251231"), tz).toBe(false)
      vi.useRealTimers()
    }
  })

  it("형식이 아니면 false (종전 동작)", () => {
    expect(isFutureDate("")).toBe(false)
    expect(isFutureDate("2026-01-01")).toBe(false)
  })

  /**
   * 종전 구현은 `/^\d{8}$/`만 보고 문자열 비교를 했다 — "20261345" > "20260101"이 참이라
   * **달력에 없는 날짜가 전부 시행예정**이 됐다. 결함이 드러나려면 잘못된 날짜가 오늘보다
   * **미래**여야 한다: 과거의 잘못된 날짜는 종전 구현에서도 우연히 false다 (함정 9).
   */
  it("달력에 없는 날짜는 오늘보다 미래여도 시행예정이 아니다 (종전 구현은 전부 true였다)", () => {
    freezeAt("2026-01-01T12:00:00+09:00")
    // 13월·32일·0월·0일 — 시행일 태그를 잘못 읽었다는 뜻이지 미래 시행일이 아니다
    expect(isFutureDate("20261345")).toBe(false)
    expect(isFutureDate("20260132")).toBe(false)
    expect(isFutureDate("20261300")).toBe(false)
    expect(isFutureDate("20260000")).toBe(false)
    // 2027은 윤년이 아니다 — 2월 29일은 존재하지 않는다
    expect(isFutureDate("20270229")).toBe(false)
    // 반대 방향: 실재하는 미래 날짜는 그대로 시행예정이다 (2028은 윤년)
    expect(isFutureDate("20280229")).toBe(true)
    expect(isFutureDate("20270228")).toBe(true)
    // 이 한 줄만으로는 결함이 드러나지 않는다 — 과거라서 종전 구현도 false였다
    expect(isFutureDate("20240230")).toBe(false)
  })

  it("정상 날짜는 오늘·어제·내일로 그대로 갈린다 (달력 검사가 유효 날짜를 깎지 않는다)", () => {
    freezeAt("2026-01-01T12:00:00+09:00")
    expect(isFutureDate("20251231")).toBe(false) // 어제
    expect(isFutureDate("20260101")).toBe(false) // 오늘 — 시행일 당일은 이미 시행 중이다
    expect(isFutureDate("20260102")).toBe(true) // 내일
    expect(isFutureDate("20240229")).toBe(false) // 실재하는 과거 윤년 날짜
    expect(isFutureDate("20260228")).toBe(true) // 2026은 평년 — 2월 28일까지가 실재한다
  })
})

/**
 * 2026-09-16 실측 — `소득세법 시행령` eflaw 검색(display 20) 원문에서 필요한 태그만 남겼다.
 * 현행 시행일이 2026-07-01인데 같은 날짜의 "시행예정" 행이 4개 남아 있고, 2027-01-01은 공포본마다 6행이다.
 */
const eflawRow = (mst: string, code: string, ancYd: string, efYd: string) =>
  `<law id="1"><법령일련번호>${mst}</법령일련번호><현행연혁코드>${code}</현행연혁코드><법령명한글><![CDATA[소득세법 시행령]]></법령명한글>` +
  `<법령ID>003956</법령ID><공포일자>${ancYd}</공포일자><제개정구분명>일부개정</제개정구분명><법령구분명>대통령령</법령구분명><시행일자>${efYd}</시행일자></law>`
const INCOME_DECREE_EFLAW =
  '<?xml version="1.0" encoding="UTF-8"?><LawSearch><target>eflaw</target><totalCnt>367</totalCnt>' +
  [
    ["269541", "시행예정", "20250228", "20280101"],
    ["283631", "시행예정", "20260227", "20270101"],
    ["280865", "시행예정", "20251230", "20270101"],
    ["269541", "시행예정", "20250228", "20270101"],
    ["267821", "시행예정", "20241231", "20270101"],
    ["247489", "시행예정", "20221231", "20270101"],
    ["241175", "시행예정", "20220308", "20270101"],
    ["286211", "현행", "20260522", "20260701"],
    ["283631", "시행예정", "20260227", "20260701"],
    ["280865", "시행예정", "20251230", "20260701"],
    ["279961", "시행예정", "20251128", "20260701"],
    ["269541", "시행예정", "20250228", "20260701"],
    ["283631", "연혁", "20260227", "20260227"],
  ]
    .map(([mst, code, anc, ef]) => eflawRow(mst, code, anc, ef))
    .join("") +
  "</LawSearch>"

describe("parseUpcomingVersions — 이미 시행된 개정을 예정으로 내지 않는다 (B3)", () => {
  afterEach(() => vi.useRealTimers())

  it("시행일이 오늘(KST) 이전인 '시행예정' 행은 버린다 — 2026-07-01 4행이 사라진다", () => {
    freezeAt("2026-09-16T12:00:00+09:00")
    const ups = parseUpcomingVersions(INCOME_DECREE_EFLAW, "소득세법 시행령")
    expect(ups.map((u) => u.시행일자)).not.toContain("20260701")
  })

  it("같은 시행일은 하나로 접고 공포일은 최근순으로 모은다", () => {
    freezeAt("2026-09-16T12:00:00+09:00")
    const ups = parseUpcomingVersions(INCOME_DECREE_EFLAW, "소득세법 시행령")
    expect(ups).toEqual([
      { 시행일자: "20270101", 공포일자: ["20260227", "20251230", "20250228", "20241231", "20221231", "20220308"] },
      { 시행일자: "20280101", 공포일자: ["20250228"] },
    ])
  })

  it("반대 방향: 진짜 미래 개정은 남는다 — 시행 전날이면 2026-07-01도 예정이다", () => {
    freezeAt("2026-06-30T12:00:00+09:00")
    const ups = parseUpcomingVersions(INCOME_DECREE_EFLAW, "소득세법 시행령")
    expect(ups.map((u) => u.시행일자)).toEqual(["20260701", "20270101", "20280101"])
    expect(ups[0].공포일자).toEqual(["20260227", "20251230", "20251128", "20250228"])
  })

  it("시행 당일(KST)에는 더 이상 예정이 아니다", () => {
    freezeAt("2027-01-01T00:10:00+09:00")
    const ups = parseUpcomingVersions(INCOME_DECREE_EFLAW, "소득세법 시행령")
    expect(ups.map((u) => u.시행일자)).toEqual(["20280101"])
  })

  it("다른 법령명 행과 현행·연혁 행은 종전대로 제외한다", () => {
    freezeAt("2026-01-01T12:00:00+09:00")
    const ups = parseUpcomingVersions(INCOME_DECREE_EFLAW, "소득세법")
    expect(ups).toEqual([])
  })
})
