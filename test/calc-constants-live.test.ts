/**
 * fin_calc 하드코딩 상수의 신선도 라이브 테스트 — 실 법제처 API 호출 (LAW_OC 필요)
 *
 * 왜 필요한가:
 *   calc.ts는 세법의 수치(세율표·공제표·상각률·이자율·한도)를 코드에 박아 두고 계산한다.
 *   세법은 매년 1월 개정되므로, 조문이 바뀌었는데 상수가 그대로면 **오류 없이 틀린 금액**이
 *   확신형으로 출력된다. 이 저장소가 가장 경계하는 "조용한 실패"다.
 *   → 여기서 조문 원문을 매번 받아 파싱하고, 코드가 실제로 쓰는 값과 대조한다.
 *
 * 설계 원칙:
 *   1) **행동 대조** — 상수를 import하지 않고 calc.ts의 공개 함수를 호출해 나온 값과 비교한다.
 *      상수 자체가 맞아도 배선이 틀리면 사용자에게 가는 값은 틀리다. 사용자가 받는 값을 본다.
 *   2) **조회 실패는 skip** — 법제처 장애·rate limit은 상수 문제가 아니다. 실패로 물들이면
 *      경보가 무뎌진다. 단, **파싱 실패는 fail** — 조용히 통과하면 이 테스트가 영구히 무의미해진다.
 *   3) 실패 메시지는 "상수 갱신 신호"임을 밝히고 원문 값과 코드 값을 나란히 적는다.
 *
 * ⚠ 이 테스트가 깨지면 먼저 조문이 개정된 것인지 확인할 것. 개정이면 calc.ts 상수를 갱신하고
 *   BENCHMARK·회귀 테스트를 함께 고친다. 테스트를 완화해 통과시키는 것은 답이 아니다.
 *
 * 실행: npm run test:live
 */

import { describe, it, expect, beforeAll } from "vitest"
import type { TestContext } from "vitest"
import { config } from "dotenv"
import { LawApiClient } from "../src/lib/api-client.js"
import { findLaws } from "../src/lib/law-search.js"
import { buildJO } from "../src/lib/law-parser.js"
import { handleFinAnnex } from "../src/tools/annex.js"
import {
  handleFinCalc,
  calcExecutiveSeveranceLimit,
  calcEntertainmentLimit,
  calcDepreciationLimit,
  calcDeemedInterest,
  calcRetirementIncomeTax,
  serviceYearsDeduction,
  convertedPayDeduction,
  basicIncomeTax,
} from "../src/tools/calc.js"

config({ quiet: true })

const hasKey = !!process.env.LAW_OC
const d = describe.runIf(hasKey)

// ─────────────────────────────────────────────────────────────────────────────
// 한국어 금액·비율 표기 파서
//
// 법제처 원문은 조문마다 표기가 흔들린다. 같은 1,400만원이 소득세법에서는 "1,400만원",
// 지방세법에서는 "1천400만원"이다. 표기를 하나로 가정하면 정상 조문을 "파싱 실패"로
// 읽어 이 테스트가 스스로 눈이 먼다.
// ─────────────────────────────────────────────────────────────────────────────

/** 금액 토큰 — "1,400만원" "1억5천만원" "8만4천원" "100억원" */
const AMOUNT_TOKEN = /[\d,]+[억만천백십\d,]*원/g
/** 행 머리의 금액 (누진 기초세액·기초공제액) */
const LEADING_AMOUNT = /^\s*([\d,]+[억만천백십\d,]*원)/

/**
 * 만·억 단위 앞에 오는 수사(數詞) 조각을 숫자로. "5천"→5000 · "4천520"→4520 · "8백"→800
 * 아라비아 숫자와 한글 단위가 섞여 나오는 법제처 표기를 그대로 받는다.
 */
function parseNumeralSegment(seg: string): number | null {
  let rest = seg.replace(/[,\s]/g, "")
  if (!rest) return null
  let total = 0
  const thousand = rest.match(/^(\d+)천/)
  if (thousand) {
    total += Number(thousand[1]) * 1000
    rest = rest.slice(thousand[0].length)
  }
  const hundred = rest.match(/^(\d+)백/)
  if (hundred) {
    total += Number(hundred[1]) * 100
    rest = rest.slice(hundred[0].length)
  }
  const ten = rest.match(/^(\d+)십/)
  if (ten) {
    total += Number(ten[1]) * 10
    rest = rest.slice(ten[0].length)
  }
  if (rest) {
    if (!/^\d+$/.test(rest)) return null
    total += Number(rest)
  }
  return total
}

/** "1억5천170만원" → 151700000 · "8만4천원" → 84000 · "100억원" → 10000000000 */
function parseKoreanAmount(text: string): number | null {
  let rest = text.replace(/[,\s]/g, "").replace(/원$/, "")
  if (!rest) return null
  let total = 0
  const eok = rest.indexOf("억")
  if (eok >= 0) {
    const v = parseNumeralSegment(rest.slice(0, eok))
    if (v === null) return null
    total += v * 100_000_000
    rest = rest.slice(eok + 1)
  }
  const man = rest.indexOf("만")
  if (man >= 0) {
    const v = parseNumeralSegment(rest.slice(0, man))
    if (v === null) return null
    total += v * 10_000
    rest = rest.slice(man + 1)
  }
  if (rest) {
    const v = parseNumeralSegment(rest)
    if (v === null) return null
    total += v
  }
  return total
}

/**
 * 비율 표기 → 소수. 법령은 "N퍼센트"와 "M분의 N"을 섞어 쓴다.
 *   "6퍼센트" → 0.06 · "1천분의 15" → 0.015 · "1,000분의 46" → 0.046 · "100분의 5" → 0.05
 */
function parseRate(text: string): number | null {
  const frac = text.match(/([\d,]+[억만천백십\d,]*)\s*분의\s*([\d,.]+)/)
  if (frac) {
    const denom = parseNumeralSegment(frac[1])
    const numer = Number(frac[2].replace(/,/g, ""))
    if (denom && Number.isFinite(numer)) return numer / denom
  }
  const pct = text.match(/([\d.]+)\s*퍼센트/)
  if (pct) return Number(pct[1]) / 100
  return null
}

/**
 * 법제처 조문 본문의 ASCII 박스표(┌┬┐├┼┤└┴┘│─)를 2열 행 배열로.
 * 한 행이 여러 물리 줄에 걸치면(칸 폭 초과) 공백으로 이어 붙인다 —
 * "8,800만원 초과" + "1억5천만원 이하" 가 한 칸이다.
 */
function parseBoxTable(source: string): Array<[string, string]> {
  const start = source.indexOf("┌")
  const end = source.lastIndexOf("┘")
  if (start < 0 || end < 0 || end <= start) return []
  const body = source.slice(start, end + 1)
  // 가로 구분선으로 행 블록을 나눈다 (┌─┬─┐ / ├─┼─┤ / └─┴─┘)
  const blocks = body.split(/[┌├└][─┬┼┴]*[┐┤┘]/)
  const rows: Array<[string, string]> = []
  for (const block of blocks) {
    const cells: Array<[string, string]> = []
    for (const m of block.matchAll(/│([^│]*)│([^│]*)│/g)) cells.push([m[1], m[2]])
    if (cells.length === 0) continue
    const left = cells.map((c) => c[0].trim()).filter(Boolean).join(" ")
    const right = cells.map((c) => c[1].trim()).filter(Boolean).join(" ")
    if (left || right) rows.push([left, right])
  }
  return rows
}

/** 구간 표기 "A 초과 B 이하" / "B 이하" / "A 초과" → [from, upTo] */
function parseAmountBand(label: string): { from: number; upTo: number } | null {
  const amounts = [...label.matchAll(AMOUNT_TOKEN)].map((m) => parseKoreanAmount(m[0]))
  if (amounts.some((a) => a === null)) return null
  const nums = amounts as number[]
  const hasOver = label.includes("초과")
  const hasUnder = label.includes("이하")
  if (hasOver && hasUnder && nums.length >= 2) return { from: nums[0], upTo: nums[1] }
  if (hasUnder && nums.length >= 1) return { from: 0, upTo: nums[0] }
  if (hasOver && nums.length >= 1) return { from: nums[0], upTo: Infinity }
  return null
}

/** 연수 구간 "5년 초과 10년 이하" → [from, upTo] */
function parseYearBand(label: string): { from: number; upTo: number } | null {
  const years = [...label.matchAll(/(\d+)\s*년/g)].map((m) => Number(m[1]))
  const hasOver = label.includes("초과")
  const hasUnder = label.includes("이하")
  if (hasOver && hasUnder && years.length >= 2) return { from: years[0], upTo: years[1] }
  if (hasUnder && years.length >= 1) return { from: 0, upTo: years[0] }
  if (hasOver && years.length >= 1) return { from: years[0], upTo: Infinity }
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// 원문 조회 (조회 실패 = skip, 파싱 실패 = fail)
// ─────────────────────────────────────────────────────────────────────────────

type Loaded<T> = { ok: true; value: T } | { ok: false; reason: string }

interface ArticleUnit {
  hang: string
  text: string
  ho: Array<{ no: string; text: string }>
}
interface ArticleDoc {
  title: string
  units: ArticleUnit[]
  /** 항·호 본문 전체를 이어 붙인 것 — 문자열 존재 확인용 */
  flat: string
}

const asArray = <T,>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v])

function parseArticleJson(raw: string): ArticleDoc {
  const json = JSON.parse(raw)
  const units = asArray<any>(json?.["법령"]?.["조문"]?.["조문단위"])
  const unit = units.find((u) => u?.["조문여부"] === "조문")
  if (!unit) throw new Error("응답에 조문 단위가 없습니다 (법제처 응답 구조 변화 가능)")
  const parsed: ArticleUnit[] = asArray<any>(unit["항"]).map((h) => ({
    hang: String(h?.["항번호"] ?? ""),
    text: String(h?.["항내용"] ?? ""),
    ho: asArray<any>(h?.["호"]).map((x) => ({ no: String(x?.["호번호"] ?? ""), text: String(x?.["호내용"] ?? "") })),
  }))
  return {
    title: String(unit["조문내용"] ?? ""),
    units: parsed,
    flat: parsed.map((u) => [u.text, ...u.ho.map((x) => x.text)].join("\n")).join("\n"),
  }
}

/** 항 본문 (없으면 파싱 실패로 던진다 — "0건"을 정상으로 읽지 않는다) */
function hang(doc: ArticleDoc, no: string): string {
  const found = doc.units.find((u) => u.hang === no)
  if (!found) throw new Error(`${doc.title} ${no}항을 찾을 수 없습니다`)
  return found.text
}
/** 호 본문 */
function ho(doc: ArticleDoc, hangNo: string, hoNo: string): string {
  const h = doc.units.find((u) => u.hang === hangNo)
  const found = h?.ho.find((x) => x.no.startsWith(hoNo))
  if (!found) throw new Error(`${doc.title} ${hangNo}항 제${hoNo} 호를 찾을 수 없습니다`)
  return found.text
}

let apiClient: LawApiClient
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 법제처 분당 한도(기본 30)에 걸리지 않게 호출을 띄운다 — 다른 라이브 파일과 겹칠 수 있다 */
const CALL_GAP_MS = 1_200
let callCount = 0

const mstCache = new Map<string, string>()
async function resolveMst(lawName: string): Promise<string> {
  const cached = mstCache.get(lawName)
  if (cached) return cached
  callCount++
  const laws = await findLaws(apiClient, lawName, undefined, 3)
  const hit = laws.find((l) => l.lawName === lawName) ?? laws[0]
  if (!hit) throw new Error(`법령 검색 0건: ${lawName}`)
  if (hit.lawName !== lawName) throw new Error(`법령명 불일치: 요청 "${lawName}" → 응답 "${hit.lawName}"`)
  mstCache.set(lawName, hit.mst)
  await sleep(CALL_GAP_MS)
  return hit.mst
}

/** 조회 실패(장애·한도)와 파싱 실패를 구분해 담는다 */
async function load<T>(fn: () => Promise<T>): Promise<Loaded<T>> {
  try {
    return { ok: true, value: await fn() }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

async function loadArticle(lawName: string, article: string): Promise<ArticleDoc> {
  const mst = await resolveMst(lawName)
  callCount++
  const raw = await apiClient.getLawText({ mst, jo: buildJO(article) })
  await sleep(CALL_GAP_MS)
  return parseArticleJson(raw)
}

/** skip 사유를 남기고 값을 꺼낸다 — 조회 실패를 테스트 실패로 만들지 않는다 */
function need<T>(ctx: TestContext, key: string, entry: Loaded<T>): T {
  if (!entry.ok) {
    ctx.skip(`[조회 실패 — 상수 문제 아님] ${key}: ${entry.reason}`)
    throw new Error("unreachable")
  }
  return entry.value
}

/** 상수 갱신 신호임을 밝히는 실패 메시지 */
function signal(constName: string, basis: string, source: unknown, code: unknown): string {
  return (
    `[상수 갱신 신호] ${constName} — 조문이 개정됐을 수 있습니다.\n` +
    `  근거: ${basis}\n` +
    `  원문(법제처): ${String(source)}\n` +
    `  코드(fin_calc): ${String(code)}\n` +
    `  → 개정이면 src/tools/calc.ts의 해당 상수와 회귀 테스트를 함께 갱신하세요.`
  )
}

// 조회 결과 보관소
const src: {
  citRule43: Loaded<ArticleDoc>
  ita55: Loaded<ArticleDoc>
  ita48: Loaded<ArticleDoc>
  cit25: Loaded<ArticleDoc>
  decree88: Loaded<ArticleDoc>
  decree44: Loaded<ArticleDoc>
  decree26: Loaded<ArticleDoc>
  lta92: Loaded<ArticleDoc>
  annex4: Loaded<string>
} = {} as any

beforeAll(async () => {
  if (!hasKey) return
  apiClient = new LawApiClient({ apiKey: process.env.LAW_OC || "" })

  src.citRule43 = await load(() => loadArticle("법인세법 시행규칙", "제43조"))
  src.ita55 = await load(() => loadArticle("소득세법", "제55조"))
  src.ita48 = await load(() => loadArticle("소득세법", "제48조"))
  src.cit25 = await load(() => loadArticle("법인세법", "제25조"))
  src.decree88 = await load(() => loadArticle("법인세법 시행령", "제88조"))
  src.decree44 = await load(() => loadArticle("법인세법 시행령", "제44조"))
  src.decree26 = await load(() => loadArticle("법인세법 시행령", "제26조"))
  src.lta92 = await load(() => loadArticle("지방세법", "제92조"))
  src.annex4 = await load(async () => {
    callCount += 2 // 별표 목록 조회 + 파일 다운로드
    const res = await handleFinAnnex(apiClient, { law: "법인세법 시행규칙", annex_no: "4" })
    const text = res.content[0].text
    if (res.isError) throw new Error(`fin_annex 별표 4 조회 실패: ${text.slice(0, 200)}`)
    await sleep(CALL_GAP_MS)
    return text
  })
}, 300_000)

// ─────────────────────────────────────────────────────────────────────────────

d("상수 대조: 당좌대출이자율 (법인세법 시행규칙 §43②)", () => {
  it("원문 '연간 1,000분의 46'과 fin_calc의 인정이자 계산이 일치한다", (ctx) => {
    const doc = need(ctx, "법인세법 시행규칙 제43조", src.citRule43)
    const text = hang(doc, "②")

    // 파싱 실패는 fail — 조문 구조가 바뀌었는데 조용히 통과하면 이 테스트가 눈이 먼다
    expect(text, "§43②이 당좌대출이자율을 정의하는 항이 아닙니다 (조문 구조 변화 확인)").toContain("당좌대출이자율")
    const srcRate = parseRate(text)
    expect(srcRate, `§43② 본문에서 이자율 표기를 파싱하지 못했습니다 — 원문: ${text.slice(0, 200)}`).not.toBeNull()

    // 행동 대조: 상수를 직접 읽지 않고 도구가 내놓는 금액으로 확인한다
    const principal = 1_000_000_000
    const days = 365
    const expected = Math.floor((principal * days * srcRate!) / 365).toLocaleString("ko-KR")
    return handleFinCalc(null, {
      calc_type: "가지급금인정이자",
      principal,
      days,
      rate_type: "당좌대출이자율",
    }).then((res) => {
      expect(res.isError).toBeFalsy()
      const out = res.content[0].text
      expect(
        out.includes(`${expected}원`),
        signal(
          "OVERDRAFT_LOAN_RATE",
          "법인세법 시행규칙 제43조제2항",
          `${srcRate} (${(srcRate! * 100).toFixed(3)}%) → 이자시가 ${expected}원`,
          `출력에 ${expected}원 없음`
        )
      ).toBe(true)
    })
  })
})

d("상수 대조: 종합소득 기본세율표 (소득세법 §55①)", () => {
  it("8개 구간의 하한·상한·누진기초세액·세율이 원문과 일치한다", (ctx) => {
    const doc = need(ctx, "소득세법 제55조", src.ita55)
    const rows = parseBoxTable(hang(doc, "①"))
    expect(rows.length, "§55① 본문에서 세율표를 찾지 못했습니다 (원문 형식 변화 확인)").toBeGreaterThan(0)

    const bands = rows
      .map(([label, rateCell]) => {
        const band = parseAmountBand(label)
        if (!band) return null
        const rate = parseRate(rateCell)
        if (rate === null) return null
        const lead = rateCell.match(LEADING_AMOUNT)
        const base = lead ? parseKoreanAmount(lead[1]) : 0
        if (base === null) return null
        return { label, ...band, base, rate }
      })
      .filter((b): b is NonNullable<typeof b> => b !== null)

    expect(
      bands.length,
      `세율표 구간 파싱 실패 — 표는 찾았으나 해석된 구간이 ${bands.length}개입니다. 파싱한 행: ${JSON.stringify(rows)}`
    ).toBe(8)

    for (const b of bands) {
      // 구간 안쪽 한 점과 구간 상한에서 코드가 같은 구간을 고르는지 본다
      const probes = [b.from + 1_000, Number.isFinite(b.upTo) ? b.upTo : b.from + 1_000_000_000]
      for (const x of probes) {
        const got = basicIncomeTax(x)
        expect(got.rate, signal("INCOME_TAX_BRACKETS 세율", `소득세법 제55조제1항 「${b.label}」`, b.rate, got.rate)).toBe(b.rate)
        const expectedTax = b.base + (x - b.from) * b.rate
        expect(
          got.tax,
          signal(
            "INCOME_TAX_BRACKETS 누진기초세액",
            `소득세법 제55조제1항 「${b.label}」 과세표준 ${x.toLocaleString("ko-KR")}원`,
            `${b.base} + (${x} − ${b.from}) × ${b.rate} = ${expectedTax}`,
            got.tax
          )
        ).toBeCloseTo(expectedTax, 6)
      }
    }
  })
})

d("상수 대조: 퇴직소득공제 (소득세법 §48①)", () => {
  it("근속연수공제 4개 구간이 원문과 일치한다 (§48①1)", (ctx) => {
    const doc = need(ctx, "소득세법 제48조", src.ita48)
    const rows = parseBoxTable(ho(doc, "①", "1."))
    expect(rows.length, "§48①1에서 근속연수공제표를 찾지 못했습니다").toBeGreaterThan(0)

    const bands = rows
      .map(([label, formula]) => {
        const band = parseYearBand(label)
        if (!band) return null
        const amounts = [...formula.matchAll(AMOUNT_TOKEN)].map((m) => parseKoreanAmount(m[0]))
        if (amounts.some((a) => a === null) || amounts.length === 0) return null
        const nums = amounts as number[]
        // "100만원×근속연수" → 기초 0 / "500만원+200만원×(근속연수－5년)" → 기초 500만
        const base = nums.length >= 2 ? nums[0] : 0
        const perYear = nums.length >= 2 ? nums[1] : nums[0]
        return { label, formula, ...band, base, perYear }
      })
      .filter((b): b is NonNullable<typeof b> => b !== null)

    expect(bands.length, `근속연수공제 구간 파싱 실패 — 파싱한 행: ${JSON.stringify(rows)}`).toBe(4)

    for (const b of bands) {
      // 산식의 "(근속연수－N년)"이 구간 하한과 같은지 교차 확인 (표기와 산식의 어긋남 검출)
      const offset = b.formula.match(/근속연수\s*[－\-−]\s*(\d+)\s*년/)
      if (offset) {
        expect(
          Number(offset[1]),
          signal("SERVICE_YEARS_DEDUCTION from", `소득세법 제48조제1항제1호 「${b.label}」`, offset[1], b.from)
        ).toBe(b.from)
      }
      const probes = [b.from + 1, Number.isFinite(b.upTo) ? b.upTo : b.from + 10]
      for (const n of probes) {
        const expected = b.base + b.perYear * (n - b.from)
        expect(
          serviceYearsDeduction(n),
          signal(
            "SERVICE_YEARS_DEDUCTION",
            `소득세법 제48조제1항제1호 「${b.label}」 근속 ${n}년`,
            `${b.base} + ${b.perYear} × (${n} − ${b.from}) = ${expected}`,
            serviceYearsDeduction(n)
          )
        ).toBe(expected)
      }
    }
  })

  it("환산급여공제 5개 구간이 원문과 일치한다 (§48①2)", (ctx) => {
    const doc = need(ctx, "소득세법 제48조", src.ita48)
    const rows = parseBoxTable(ho(doc, "①", "2."))
    expect(rows.length, "§48①2에서 환산급여공제표를 찾지 못했습니다").toBeGreaterThan(0)

    const bands = rows
      .map(([label, formula]) => {
        const band = parseAmountBand(label)
        if (!band) return null
        const rate = parseRate(formula)
        if (rate === null) return null
        const lead = formula.match(LEADING_AMOUNT)
        const base = lead ? parseKoreanAmount(lead[1]) : 0
        if (base === null) return null
        return { label, ...band, base, rate }
      })
      .filter((b): b is NonNullable<typeof b> => b !== null)

    expect(bands.length, `환산급여공제 구간 파싱 실패 — 파싱한 행: ${JSON.stringify(rows)}`).toBe(5)

    for (const b of bands) {
      const probes = [b.from + 1_000, Number.isFinite(b.upTo) ? b.upTo : b.from + 500_000_000]
      for (const x of probes) {
        const expected = b.base + (x - b.from) * b.rate
        expect(
          convertedPayDeduction(x),
          signal(
            "CONVERTED_PAY_DEDUCTION",
            `소득세법 제48조제1항제2호 「${b.label}」 환산급여 ${x.toLocaleString("ko-KR")}원`,
            `${b.base} + (${x} − ${b.from}) × ${b.rate} = ${expected}`,
            convertedPayDeduction(x)
          )
        ).toBeCloseTo(expected, 6)
      }
    }
  })
})

d("상수 대조: 감가상각 상각률표 (법인세법 시행규칙 [별표 4])", () => {
  it("별표 4의 상각률 전량(내용연수 2~60년)이 코드가 적용하는 상각률과 일치한다", (ctx) => {
    const text = need(ctx, "법인세법 시행규칙 별표 4", src.annex4)

    // 별표는 "할·분·리"(1/1000 단위 정수)로 적는다 — 500 = 0.500
    const table = new Map<number, { straight: number; declining: number }>()
    // 추출 결과는 앞부분이 HTML 표, 뒷부분이 마크다운 표로 섞여 나온다 (kordoc 동작)
    for (const m of text.matchAll(/<tr><td>\s*(\d+)\s*<\/td><td>\s*(\d+)\s*<\/td><td>\s*(\d+)\s*<\/td><\/tr>/g)) {
      table.set(Number(m[1]), { straight: Number(m[2]), declining: Number(m[3]) })
    }
    for (const m of text.matchAll(/^\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*$/gm)) {
      table.set(Number(m[1]), { straight: Number(m[2]), declining: Number(m[3]) })
    }

    // 파싱 실패는 fail. 별표 4는 2~60년 59행이다 — 몇 행만 잡히면 추출이 깨진 것
    expect(
      table.size,
      `별표 4 상각률 행 파싱이 부족합니다 (${table.size}행) — 표 추출 형식이 바뀌었는지 확인하세요. 응답 앞부분: ${text.slice(0, 300)}`
    ).toBeGreaterThanOrEqual(59)
    expect(table.has(2), "별표 4에 내용연수 2년 행이 없습니다").toBe(true)
    expect(table.has(60), "별표 4에 내용연수 60년 행이 없습니다").toBe(true)

    const cost = 1_000_000_000
    const mismatches: string[] = []
    for (const [years, { straight, declining }] of [...table.entries()].sort((a, b) => a[0] - b[0])) {
      if (years < 2 || years > 60) continue
      const codeStraight = calcDepreciationLimit(cost, years, "정액법", cost, 12).rate
      const codeDeclining = calcDepreciationLimit(cost, years, "정률법", cost, 12).rate
      if (Math.round(codeStraight * 1000) !== straight) {
        mismatches.push(`내용연수 ${years}년 정액법: 원문 ${straight}/1000 vs 코드 ${codeStraight}`)
      }
      if (Math.round(codeDeclining * 1000) !== declining) {
        mismatches.push(`내용연수 ${years}년 정률법: 원문 ${declining}/1000 vs 코드 ${codeDeclining}`)
      }
    }
    expect(
      mismatches,
      signal(
        "DEPRECIATION_RATE_TABLE",
        "법인세법 시행규칙 [별표 4] 감가상각자산의 상각률표 (제15조제2항 관련)",
        `${table.size}행 대조`,
        mismatches.join(" / ")
      )
    ).toEqual([])
  })

  it("정률법 잔존가액 5%·비망가액 1천원이 원문과 일치한다 (시행령 §26⑥⑦)", (ctx) => {
    const doc = need(ctx, "법인세법 시행령 제26조", src.decree26)

    const residualRate = parseRate(hang(doc, "⑥"))
    expect(residualRate, `§26⑥에서 잔존가액 비율을 파싱하지 못했습니다 — 원문: ${hang(doc, "⑥").slice(0, 200)}`).not.toBeNull()

    const memoText = hang(doc, "⑦")
    const memoAmount = parseKoreanAmount((memoText.match(AMOUNT_TOKEN) ?? [])[0] ?? "")
    expect(memoAmount, `§26⑦에서 비망가액 금액을 파싱하지 못했습니다 — 원문: ${memoText.slice(0, 200)}`).not.toBeNull()

    const cost = 1_000_000_000
    const r = calcDepreciationLimit(cost, 5, "정률법", cost, 12)
    expect(
      r.residual,
      signal("DECLINING_RESIDUAL_RATIO", "법인세법 시행령 제26조제6항 단서", `취득가액 × ${residualRate}`, `${r.residual} (= ${cost} × ?)`)
    ).toBeCloseTo(cost * residualRate!, 6)
    expect(
      r.memoValue,
      signal("MEMO_VALUE", "법인세법 시행령 제26조제7항", `${memoAmount}원과 취득가액 5% 중 적은 금액`, r.memoValue)
    ).toBe(Math.min(cost * residualRate!, memoAmount!))
  })
})

d("상수 대조: 기업업무추진비 한도 (법인세법 §25④)", () => {
  it("기본한도 1천200만원 / 중소기업 3천600만원과 월할이 원문과 일치한다 (§25④1)", (ctx) => {
    const doc = need(ctx, "법인세법 제25조", src.cit25)
    const text = ho(doc, "④", "1.")

    // "A : 1천200만원(중소기업의 경우에는 3천600만원)"
    const amounts = [...text.matchAll(AMOUNT_TOKEN)].map((m) => parseKoreanAmount(m[0]))
    expect(
      amounts.length >= 2 && !amounts.some((a) => a === null),
      `§25④1에서 기본한도 금액 2개를 파싱하지 못했습니다 — 원문: ${text.slice(0, 400)}`
    ).toBe(true)
    const [general, sme] = amounts as number[]
    expect(sme, "중소기업 기본한도가 일반 기본한도보다 크지 않습니다 (파싱 순서 확인)").toBeGreaterThan(general)

    expect(
      calcEntertainmentLimit(0, 0, false, 12).base,
      signal("기업업무추진비 기본한도(일반)", "법인세법 제25조제4항제1호", general, calcEntertainmentLimit(0, 0, false, 12).base)
    ).toBe(general)
    expect(
      calcEntertainmentLimit(0, 0, true, 12).base,
      signal("기업업무추진비 기본한도(중소기업)", "법인세법 제25조제4항제1호", sme, calcEntertainmentLimit(0, 0, true, 12).base)
    ).toBe(sme)
    // B(사업연도 개월 수) × 1/12 월할
    expect(
      calcEntertainmentLimit(0, 0, false, 6).base,
      signal("기업업무추진비 기본한도 월할", "법인세법 제25조제4항제1호 (A × B × 1/12)", general / 2, calcEntertainmentLimit(0, 0, false, 6).base)
    ).toBe(general / 2)
  })

  it("수입금액 구간·적용률과 특수관계인 100분의 10이 원문과 일치한다 (§25④2)", (ctx) => {
    const doc = need(ctx, "법인세법 제25조", src.cit25)
    const text = ho(doc, "④", "2.")
    const rows = parseBoxTable(text)
    expect(rows.length, "§25④2에서 수입금액별 한도표를 찾지 못했습니다").toBeGreaterThan(0)

    const bands = rows
      .map(([label, rateCell]) => {
        const band = parseAmountBand(label)
        if (!band) return null
        const rate = parseRate(rateCell)
        if (rate === null) return null
        const lead = rateCell.match(LEADING_AMOUNT)
        const base = lead ? parseKoreanAmount(lead[1]) : 0
        if (base === null) return null
        return { label, ...band, base, rate }
      })
      .filter((b): b is NonNullable<typeof b> => b !== null)

    expect(bands.length, `수입금액 구간 파싱 실패 — 파싱한 행: ${JSON.stringify(rows)}`).toBe(3)

    // 구간 경계에서의 누계액이 원문의 누진기초금액과 일치하는가
    // (원문 "3천만원 + (수입금액 － 100억원) × 0.2퍼센트"의 3천만원 = 100억 × 0.3%)
    for (const b of bands) {
      if (b.base === 0) continue
      const cumulative = calcEntertainmentLimit(b.from, 0, false, 12).generalAmount
      expect(
        cumulative,
        signal(
          "기업업무추진비 수입금액 누진기초금액",
          `법인세법 제25조제4항제2호 「${b.label}」`,
          `${b.base.toLocaleString("ko-KR")}원 (수입금액 ${b.from.toLocaleString("ko-KR")}원 시점)`,
          cumulative
        )
      ).toBeCloseTo(b.base, 3)
    }

    // 구간별 한계 적용률
    for (const b of bands) {
      const lo = b.from + 100_000_000
      const hi = Number.isFinite(b.upTo) ? Math.min(b.upTo, lo + 100_000_000) : lo + 100_000_000
      const marginal =
        (calcEntertainmentLimit(hi, 0, false, 12).generalAmount - calcEntertainmentLimit(lo, 0, false, 12).generalAmount) /
        (hi - lo)
      expect(
        marginal,
        signal("기업업무추진비 수입금액 적용률", `법인세법 제25조제4항제2호 「${b.label}」`, b.rate, marginal)
      ).toBeCloseTo(b.rate, 9)
    }

    // 특수관계인 거래분: 표의 비율로 산출한 금액의 100분의 10 (§25④2 단서)
    // ⚠ 특수관계인 수입금액을 **일반분과 합산한 뒤 그 증분**에 적용하는 것이 코드의 해석이고,
    //   법인세법 시행규칙 [별지 제23호서식(갑)] ⑤−⑥→⑦ 구조가 이를 명시한다. 여기서는
    //   조문이 정한 "100분의 10"이라는 비율만 대조한다 (합산 여부는 서식 근거로 확정된 사안).
    const dansuRate = parseRate(text.slice(text.indexOf("다만")))
    expect(dansuRate, `§25④2 단서에서 특수관계인 비율을 파싱하지 못했습니다 — 원문: ${text.slice(0, 300)}`).not.toBeNull()
    const revenue = 20_000_000_000
    const related = 10_000_000_000
    const r = calcEntertainmentLimit(revenue, related, false, 12)
    const increment =
      calcEntertainmentLimit(revenue + related, 0, false, 12).generalAmount -
      calcEntertainmentLimit(revenue, 0, false, 12).generalAmount
    expect(
      r.relatedAmount,
      signal("기업업무추진비 특수관계인 비율", "법인세법 제25조제4항제2호 단서", `${dansuRate} (100분의 10)`, r.relatedAmount / increment)
    ).toBeCloseTo(increment * dansuRate!, 3)
  })
})

d("상수 대조: 부당행위계산부인 적용기준 (법인세법 시행령 §88③)", () => {
  it("차액 3억원 / 시가의 100분의 5 기준이 원문과 일치한다", (ctx) => {
    const doc = need(ctx, "법인세법 시행령 제88조", src.decree88)
    const text = hang(doc, "③")

    const absAmount = parseKoreanAmount((text.match(AMOUNT_TOKEN) ?? [])[0] ?? "")
    expect(absAmount, `§88③에서 절대 기준금액을 파싱하지 못했습니다 — 원문: ${text.slice(0, 300)}`).not.toBeNull()
    const ratio = parseRate(text)
    expect(ratio, `§88③에서 시가 비율을 파싱하지 못했습니다 — 원문: ${text.slice(0, 300)}`).not.toBeNull()

    // 절대 기준: 인정이자가 정확히 기준금액이면 충족, 1원 모자라면 미충족
    // (시가를 아주 크게 잡아 비율 기준이 먼저 켜지지 않게 한다)
    const bigMarket = absAmount! * 1_000
    const atThreshold = calcDeemedInterest(bigMarket * 365, 1, bigMarket - absAmount!, false)
    const belowThreshold = calcDeemedInterest(bigMarket * 365, 1, bigMarket - absAmount! + 1, false)
    expect(
      atThreshold.meetsAbsolute,
      signal("UNFAIR_ACT_THRESHOLD_ABS", "법인세법 시행령 제88조제3항", `${absAmount!.toLocaleString("ko-KR")}원 이상`, "기준에서 미충족")
    ).toBe(true)
    expect(
      belowThreshold.meetsAbsolute,
      signal("UNFAIR_ACT_THRESHOLD_ABS", "법인세법 시행령 제88조제3항", `${absAmount!.toLocaleString("ko-KR")}원 미만은 미충족`, "충족으로 판정")
    ).toBe(false)

    // 비율 기준: 시가 대비 정확히 비율만큼이면 충족
    const market = 100_000_000
    const at = calcDeemedInterest(market * 365, 1, market * (1 - ratio!), false)
    const below = calcDeemedInterest(market * 365, 1, market * (1 - ratio!) + 1, false)
    expect(
      at.meetsRatio,
      signal("UNFAIR_ACT_THRESHOLD_RATIO", "법인세법 시행령 제88조제3항", `시가의 ${ratio} 이상`, "기준에서 미충족")
    ).toBe(true)
    expect(
      below.meetsRatio,
      signal("UNFAIR_ACT_THRESHOLD_RATIO", "법인세법 시행령 제88조제3항", `시가의 ${ratio} 미만은 미충족`, "충족으로 판정")
    ).toBe(false)
  })
})

d("상수 대조: 임원 퇴직급여 한도 (법인세법 시행령 §44④2)", () => {
  it("총급여액의 10분의 1 × 근속연수가 원문과 일치한다", (ctx) => {
    const doc = need(ctx, "법인세법 시행령 제44조", src.decree44)
    const text = ho(doc, "④", "2.")

    const ratio = parseRate(text)
    expect(ratio, `§44④2에서 급여 비율을 파싱하지 못했습니다 — 원문: ${text.slice(0, 300)}`).not.toBeNull()
    expect(text, "§44④2가 근속연수를 곱하는 산식이 아닙니다 (조문 구조 변화 확인)").toContain("근속연수")

    const salary = 120_000_000
    const years = 10
    const got = calcExecutiveSeveranceLimit(salary, years, 0)
    const expected = salary * ratio! * years
    expect(
      got.limit,
      signal("임원 퇴직급여 한도 비율", "법인세법 시행령 제44조제4항제2호", `총급여 × ${ratio} × 근속연수 = ${expected}`, got.limit)
    ).toBeCloseTo(expected, 6)
  })
})

d("상수 대조: 개인지방소득세 (지방세법 §92①)", () => {
  it("지방세법 표준세율표가 소득세법 §55① 세율표의 정확히 1/10이다 (LOCAL_INCOME_TAX_RATIO 근거)", (ctx) => {
    const itaDoc = need(ctx, "소득세법 제55조", src.ita55)
    const ltaDoc = need(ctx, "지방세법 제92조", src.lta92)

    const toBands = (source: string) =>
      parseBoxTable(source)
        .map(([label, rateCell]) => {
          const band = parseAmountBand(label)
          if (!band) return null
          const rate = parseRate(rateCell)
          if (rate === null) return null
          const lead = rateCell.match(LEADING_AMOUNT)
          const base = lead ? parseKoreanAmount(lead[1]) : 0
          if (base === null) return null
          return { label, ...band, base, rate }
        })
        .filter((b): b is NonNullable<typeof b> => b !== null)

    const ita = toBands(hang(itaDoc, "①"))
    const lta = toBands(hang(ltaDoc, "①"))
    expect(ita.length, "소득세법 §55① 세율표 파싱 실패").toBe(8)
    expect(
      lta.length,
      `지방세법 §92① 표준세율표 파싱 실패 — 파싱한 행: ${JSON.stringify(parseBoxTable(hang(ltaDoc, "①")))}`
    ).toBe(8)

    const diffs: string[] = []
    for (let i = 0; i < ita.length; i++) {
      if (ita[i].from !== lta[i].from || ita[i].upTo !== lta[i].upTo) {
        diffs.push(`구간 ${i + 1} 경계 불일치: 소득세법 [${ita[i].from}, ${ita[i].upTo}] vs 지방세법 [${lta[i].from}, ${lta[i].upTo}]`)
      }
      if (Math.abs(lta[i].rate * 10 - ita[i].rate) > 1e-9) {
        diffs.push(`구간 ${i + 1} 세율이 1/10이 아님: 소득세법 ${ita[i].rate} vs 지방세법 ${lta[i].rate}`)
      }
      if (Math.abs(lta[i].base * 10 - ita[i].base) > 1e-6) {
        diffs.push(`구간 ${i + 1} 누진기초세액이 1/10이 아님: 소득세법 ${ita[i].base} vs 지방세법 ${lta[i].base}`)
      }
    }
    expect(
      diffs,
      signal(
        "LOCAL_INCOME_TAX_RATIO",
        "지방세법 제92조제1항 표준세율표 vs 소득세법 제55조제1항 세율표",
        "두 표가 모든 구간에서 정확히 1/10 관계여야 산출세액의 10%로 계산할 수 있다",
        diffs.join(" / ")
      )
    ).toEqual([])

    // 코드가 실제로 1/10을 적용하는지 (표 관계와 배선이 어긋나지 않는지)
    const r = calcRetirementIncomeTax(300_000_000, 20)
    expect(
      r.untruncatedLocalTax,
      signal("LOCAL_INCOME_TAX_RATIO 배선", "지방세법 제92조제1항·제4항", "소득세 × 1/10", r.untruncatedLocalTax)
    ).toBeCloseTo(r.untruncatedIncomeTax / 10, 6)
  })
})

d("조회 요약", () => {
  it("이 스위트가 실제로 원문을 받아 대조했음을 남긴다", () => {
    const failed = Object.entries(src)
      .filter(([, v]) => v && !v.ok)
      .map(([k, v]) => `${k}(${(v as { reason: string }).reason})`)
    // eslint-disable-next-line no-console
    console.log(`[calc-constants-live] 법제처 호출 ${callCount}회 · 조회 실패 ${failed.length}건${failed.length ? `: ${failed.join(", ")}` : ""}`)
    // 전부 실패했다면 이 스위트는 아무것도 증명하지 못했다 — 그 사실을 드러낸다
    expect(
      failed.length,
      `모든 조문 조회가 실패해 상수 대조를 하나도 수행하지 못했습니다: ${failed.join(", ")}`
    ).toBeLessThan(Object.keys(src).length)
  })
})

if (!hasKey) {
  describe("상수 라이브 대조 (건너뜀)", () => {
    it("LAW_OC 미설정 — 상수 대조는 키 설정 후 실행", () => {
      expect(hasKey).toBe(false)
    })
  })
}
