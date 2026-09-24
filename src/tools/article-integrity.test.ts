/**
 * fin_article 회귀 — 근거 무결성 (외부 적대적 검토 B3·B4·I4, `.release-scratch/orch/compare/astra-review.md`)
 *
 * B4 조문 동일성: 반환 조문번호(+가지번호)를 요청 조문과 대조하지 않고 첫 조문단위를 렌더링했다.
 *     정상 루트 + 제99조 응답에 제1조를 요청하면 "■ … 제1조" 헤더 아래 제99조 본문이 "전체 성공"으로 나갔다.
 * B3 완전성: 본문이 예산(6,000자)에서 잘려도 첫 줄이 "전체 성공"이었고(성공 판정이 절단 전),
 *     "제1조제99항"을 요청해도 조 전체의 앞부분만 실려 뒤쪽 항의 예외가 빠졌다.
 * I4 취소·시한: 첫 법령 검색(findLaws)에 signal이 없어 검색이 6.6초 걸리면 핸들러도 6.6초 뒤에 돌아왔고,
 *     호출자(MCP 요청) 취소를 받지 않았다.
 *
 * 픽스처는 형태만 줄인 합성본이다 (실제 법령 본문 아님).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { handleFinArticle } from "./article.js"
import { lawCache } from "../lib/cache.js"
import type { LawApiClient } from "../lib/api-client.js"

const EMPTY_LAW_XML = '<?xml version="1.0"?><LawSearch><totalCnt>0</totalCnt></LawSearch>'
const lawXml = (name: string, mst: string, type = "법률") => `<?xml version="1.0" encoding="UTF-8"?>
<LawSearch><totalCnt>1</totalCnt>
  <law id="1"><법령명한글>${name}</법령명한글><법령일련번호>${mst}</법령일련번호><법령ID>9${mst}</법령ID>
    <법령구분명>${type}</법령구분명><시행일자>20260101</시행일자><제개정구분명>일부개정</제개정구분명><현행연혁코드>현행</현행연혁코드></law>
</LawSearch>`
const LAW = "완전성가상법"
const LAW_MST = "900001"

const unitsJson = (units: Array<Record<string, unknown>>) => JSON.stringify({ 법령: { 조문: { 조문단위: units } } })
const unit = (num: string, body: string, extra: Record<string, unknown> = {}) => ({
  조문여부: "조문",
  조문번호: num,
  조문내용: body,
  ...extra,
})

interface Calls {
  service: Array<Record<string, string>>
  rulings: number
}

/** 법령 검색은 LAW 1건, 조문 조회는 article(JO·efYd별로 고를 수 있게 함수) — 나머지 섹션은 빈 정상 응답 */
function stub(article: (p: Record<string, string>) => string, calls: Calls = { service: [], rulings: 0 }, extra: Partial<Record<string, unknown>> = {}): LawApiClient {
  return {
    searchLaw: async (q: string, _k: unknown, _d: number, target: string) =>
      target === "eflaw" ? EMPTY_LAW_XML : q === LAW ? lawXml(LAW, LAW_MST) : EMPTY_LAW_XML,
    fetchApi: async (p: { endpoint: string; target: string; extraParams?: Record<string, string> }) => {
      if (p.endpoint === "lawSearch.do" && p.target === "eflaw") {
        // 기준일 슬라이스 — 2020-01-01 시행본 1건
        return `<?xml version="1.0" encoding="UTF-8"?><LawSearch><totalCnt>1</totalCnt><law id="1"><법령명한글>${LAW}</법령명한글><법령일련번호>800001</법령일련번호><시행일자>20200101</시행일자><공포일자>20191231</공포일자><공포번호>1</공포번호><제개정구분명>일부개정</제개정구분명></law></LawSearch>`
      }
      if (p.endpoint === "lawSearch.do") {
        calls.rulings++
        return '<?xml version="1.0"?><CgmExpc><totalCnt>0</totalCnt></CgmExpc>'
      }
      const params = { target: p.target, ...(p.extraParams || {}) }
      calls.service.push(params)
      return article(params)
    },
    getThreeTier: async () =>
      JSON.stringify({ LspttnThdCmpLawXService: { 기본정보: { 법령명: LAW, 기준법령명: LAW, 삼단비교존재여부: "N" } } }),
    getAnnexes: async () => "{}",
    searchAdminRule: async () => '<?xml version="1.0"?><AdmRulSearch><totalCnt>0</totalCnt></AdmRulSearch>',
    ...extra,
  } as unknown as LawApiClient
}

const firstLine = (t: string) => t.split("\n")[0]
const articleSection = (text: string) => {
  const start = text.indexOf(`■ ${LAW}`)
  const end = text.indexOf("\n■ ", start + 1)
  return text.slice(start, end)
}

beforeEach(() => lawCache.clear())

describe("B4 — 반환 조문이 요청 조문과 다르면 본문을 근거로 내지 않는다", () => {
  it("제1조 요청 + 제99조 응답 → 제99조 본문 없음, '전체 성공' 아님, 확인 불가(반환 조문 불일치), isError", async () => {
    const calls: Calls = { service: [], rulings: 0 }
    const r = await handleFinArticle(stub(() => unitsJson([unit("99", "제99조 다른 조문이다.")]), calls), { law: LAW, article: "제1조" })
    const text = r.content[0].text
    expect(text).not.toContain("다른 조문이다")
    expect(text).not.toContain("전체 성공")
    expect(firstLine(text)).toContain("부분 성공")
    expect(articleSection(text)).toContain("확인 불가(반환 조문 불일치)")
    expect(articleSection(text)).toContain("요청 제1조, 응답 제99조")
    // "없음 ✗"과 구별 — 정상 0건이 아니다
    expect(text).not.toContain("✗")
    expect(r.isError).toBe(true)
    // 조문 제목을 확정할 수 없으니 예규 후보 검색도 하지 않는다
    expect(calls.rulings).toBe(0)
  })

  it("가지조문: 제10조의2 요청에 제10조(가지번호 없음)가 오면 불일치", async () => {
    const r = await handleFinArticle(stub(() => unitsJson([unit("10", "제10조(본조) 본조 본문이다.", { 조문가지번호: null })])), {
      law: LAW,
      article: "제10조의2",
      include_rulings: false,
    })
    const text = r.content[0].text
    expect(text).not.toContain("본조 본문이다")
    expect(articleSection(text)).toContain("요청 제10조의2, 응답 제10조")
    expect(r.isError).toBe(true)
  })

  it("[반대] 가지조문 일치(조문번호 10 + 가지 '2')와 가지 없는 조문(가지 '0'·null)은 정상 — '전체 성공'", async () => {
    for (const [article, u] of [
      ["제10조의2", unit("10", "제10조의2(가지) 가지 조문 본문이다.", { 조문가지번호: "2" })],
      ["제10조", unit("10", "제10조(본조) 본조 본문이다.", { 조문가지번호: "0" })],
      ["제10조", unit("10", "제10조(본조) 본조 본문이다.", { 조문가지번호: null })],
    ] as const) {
      lawCache.clear()
      const r = await handleFinArticle(stub(() => unitsJson([u])), { law: LAW, article, include_rulings: false })
      const text = r.content[0].text
      expect(firstLine(text)).toContain("전체 성공")
      expect(text).toContain(String(u.조문내용))
      expect(r.isError).toBeUndefined()
    }
  })

  it("응답에 여러 조문이 섞여 오면 요청 조문만 싣는다 (다른 조문 본문은 제외)", async () => {
    const r = await handleFinArticle(
      stub(() => unitsJson([unit("99", "제99조 다른 조문이다."), unit("1", "제1조(목적) 요청 조문 본문이다.")])),
      { law: LAW, article: "제1조", include_rulings: false }
    )
    const text = r.content[0].text
    expect(text).toContain("요청 조문 본문이다")
    expect(text).not.toContain("다른 조문이다")
    expect(firstLine(text)).toContain("전체 성공")
  })

  it("같은 번호 조문이 둘이면 확정 불가 — 본문을 싣지 않는다", async () => {
    const r = await handleFinArticle(
      stub(() => unitsJson([unit("1", "제1조 첫째 후보다."), unit("1", "제1조 둘째 후보다.")])),
      { law: LAW, article: "제1조", include_rulings: false }
    )
    const text = r.content[0].text
    expect(text).not.toContain("후보다")
    expect(articleSection(text)).toContain("확정 불가")
    expect(r.isError).toBe(true)
  })

  it("기준일(efYd) 경로에도 적용된다", async () => {
    const calls: Calls = { service: [], rulings: 0 }
    const r = await handleFinArticle(stub(() => unitsJson([unit("99", "제99조 옛 다른 조문이다.")]), calls), {
      law: LAW,
      article: "제1조",
      basis_date: "2020-01-01",
      include_rulings: false,
    })
    const text = r.content[0].text
    expect(calls.service.some((s) => s.target === "eflaw" && s.efYd === "20200101")).toBe(true)
    expect(text).not.toContain("옛 다른 조문이다")
    expect(articleSection(text)).toContain("확인 불가(반환 조문 불일치)")
    expect(text).not.toContain("전체 성공")
    expect(r.isError).toBe(true)
  })

  it("연혁 법령 경로에도 적용된다", async () => {
    const HIST = "옛가상법"
    const histRow = `<law id="1"><법령일련번호>70001</법령일련번호><현행연혁코드>연혁</현행연혁코드><법령명한글><![CDATA[${HIST}]]></법령명한글><법령ID>7</법령ID><공포일자>20031231</공포일자><공포번호>1</공포번호><제개정구분명>일부개정</제개정구분명><법령구분명>법률</법령구분명><시행일자>20040401</시행일자></law>`
    const histXml = `<?xml version="1.0" encoding="UTF-8"?><LawSearch><target>eflaw</target><totalCnt>1</totalCnt>${histRow}</LawSearch>`
    const client = {
      searchLaw: async (_q: string, _k: unknown, _d: number, target: string) => (target === "eflaw" ? histXml : EMPTY_LAW_XML),
      fetchApi: async (p: { endpoint: string; target: string }) => {
        if (p.endpoint === "lawSearch.do" && p.target === "eflaw") return histXml
        if (p.endpoint === "lawSearch.do") return '<?xml version="1.0"?><CgmExpc><totalCnt>0</totalCnt></CgmExpc>'
        return unitsJson([unit("99", "제99조 연혁 다른 조문이다.")])
      },
      getThreeTier: async () => "{}",
      getAnnexes: async () => "{}",
      searchAdminRule: async () => '<?xml version="1.0"?><AdmRulSearch><totalCnt>0</totalCnt></AdmRulSearch>',
    } as unknown as LawApiClient
    const r = await handleFinArticle(client, { law: HIST, article: "제2조", basis_date: "2005-01-01", include_rulings: false })
    const text = r.content[0].text
    expect(text).toContain("연혁 법령")
    expect(text).not.toContain("연혁 다른 조문이다")
    expect(text).toContain("확인 불가(반환 조문 불일치)")
    expect(r.isError).toBe(true)
  })

  it("위임 본문 동봉도 번호를 대조한다 — 다른 조문이 오면 '시행령 본문'으로 싣지 않고 목록 표시로 폴백", async () => {
    const DECREE = `${LAW} 시행령`
    const THD = JSON.stringify({
      LspttnThdCmpLawXService: {
        기본정보: { 법령명: LAW, 시행령명: DECREE, 삼단비교존재여부: "Y" },
        위임조문삼단비교: {
          법률조문: {
            조번호: "0001",
            조가지번호: "00",
            조제목: "목적",
            조내용: "제1조 본문",
            시행령조문: [
              { 조번호: "0005", 조가지번호: "00", 조제목: "맞는 위임", 조내용: "" },
              { 조번호: "0006", 조가지번호: "00", 조제목: "엉뚱한 응답", 조내용: "" },
            ],
          },
        },
      },
    })
    const client = stub(
      (p) => {
        if (p.MST === LAW_MST) return unitsJson([unit("1", "제1조(목적) 모법 본문이다.")])
        // 시행령 제5조 요청 → 제5조, 제6조 요청 → 엉뚱하게 제77조
        if (p.JO === "000500") return unitsJson([unit("5", "제5조(맞는 위임) 시행령 제5조 본문이다.")])
        return unitsJson([unit("77", "제77조 시행령 다른 조문이다.")])
      },
      undefined,
      {
        searchLaw: async (q: string, _k: unknown, _d: number, target: string) =>
          target === "eflaw" ? EMPTY_LAW_XML : q === LAW ? lawXml(LAW, LAW_MST) : q === DECREE ? lawXml(DECREE, "900002", "대통령령") : EMPTY_LAW_XML,
        getThreeTier: async () => THD,
      }
    )
    const r = await handleFinArticle(client, { law: LAW, article: "제1조", include_rulings: false })
    const text = r.content[0].text
    expect(text).toContain("시행령 제5조 본문이다")
    expect(text).not.toContain("시행령 다른 조문이다")
    expect(text).toContain("1건은 조회 실패")
  })
})

describe("B3 — 예산 절단은 첫 줄에 드러나고, 요청 항을 우선 싣는다", () => {
  // 9천자 조문: 항 99개, 각 항 약 90자, 제99항 끝에 필수 예외
  const hangs = Array.from({ length: 99 }, (_, i) => ({
    항번호: String(i + 1),
    항내용: `(${i + 1}) 제${i + 1}항 원칙이다. ${"원칙 설명 문장이다. ".repeat(7)}${i === 98 ? " 다만, 필수 예외다." : ""}`,
  }))
  const LONG_HANGS = unitsJson([unit("1", "제1조(원칙)", { 조문제목: "원칙", 항: hangs })])

  it("제1조제99항 요청 → 뒤쪽 제99항의 예외가 출력에 있고, 첫 줄은 절단 표기('전체 성공' 아님)", async () => {
    const r = await handleFinArticle(stub(() => LONG_HANGS), { law: LAW, article: "제1조제99항", include_rulings: false })
    const text = r.content[0].text
    expect(text).toContain("필수 예외다")
    expect(text).not.toContain("전체 성공")
    expect(firstLine(text)).toMatch(/본문 일부 절단\([\d,]+자 중 [\d,]+자 — 요청 제99항 우선 수록\)/)
    // 다른 항은 싣지 않았다는 사실과 범위 안내가 일치한다
    expect(articleSection(text)).toContain("요청한 제99항만 실었습니다")
    expect(text).toContain("조 머리와 제99항만 실었고")
    expect(articleSection(text)).not.toContain("제50항 원칙이다")
  })

  it("항 미지정 → 첫 줄에 절단 표기, '전체 성공' 없음, 재조회 인자 예시가 실제로 그 항을 가져온다", async () => {
    const r = await handleFinArticle(stub(() => LONG_HANGS), { law: LAW, article: "제1조", include_rulings: false })
    const text = r.content[0].text
    expect(text).not.toContain("전체 성공")
    expect(firstLine(text)).toMatch(/조회 성공 — ⚠본문 일부 절단\([\d,]+자 중 [\d,]+자\)/)
    expect(text).not.toContain("필수 예외다")
    const m = text.match(/fin_article\(\{ law: "완전성가상법", article: "제1조제(\d+)항" \}\)/)
    expect(m).not.toBeNull()
    const k = Number(m![1])
    // 예시 항은 실제로 잘린 항이다
    expect(articleSection(text)).not.toContain(`제${k}항 원칙이다`)
    lawCache.clear()
    const again = await handleFinArticle(stub(() => LONG_HANGS), { law: LAW, article: `제1조제${k}항`, include_rulings: false })
    expect(again.content[0].text).toContain(`제${k}항 원칙이다`)
  })

  it("항 구조가 없는 긴 조문(외부 검토 재현 fixture) → 절단 표기만 — 효과 없는 재조회 예시는 주지 않는다", async () => {
    const long = "제1조 " + "원칙이다. ".repeat(1500) + " 필수 예외다."
    for (const article of ["제1조제99항", "제1조"]) {
      lawCache.clear()
      const r = await handleFinArticle(stub(() => unitsJson([unit("1", long)])), { law: LAW, article, include_rulings: false })
      const text = r.content[0].text
      expect(text).not.toContain("전체 성공")
      expect(firstLine(text)).toContain("⚠본문 일부 절단(")
      expect(text).not.toContain("항을 지정해 다시 조회")
      expect(text).toContain("예산 6,000자 초과로 절단")
    }
  })

  it("[반대] 예산 안의 조문은 항을 지정해도 조 전체 — '전체 성공'", async () => {
    const r = await handleFinArticle(stub(() => unitsJson([unit("1", "제1조(목적)", { 항: hangs.slice(0, 3) })])), {
      law: LAW,
      article: "제1조제2항",
      include_rulings: false,
    })
    const text = r.content[0].text
    expect(firstLine(text)).toContain("전체 성공")
    expect(text).toContain("제1항 원칙이다")
    expect(text).toContain("제3항 원칙이다")
    expect(text).toContain("본문은 조 전체이고")
  })

  it("위임 섹션이 예산에서 잘려도 첫 줄에 드러난다", async () => {
    const THD = JSON.stringify({
      LspttnThdCmpLawXService: {
        기본정보: { 법령명: LAW, 시행령명: `${LAW} 시행령`, 삼단비교존재여부: "Y" },
        위임조문삼단비교: {
          법률조문: {
            조번호: "0001",
            조가지번호: "00",
            조제목: "목적",
            조내용: "제1조 본문",
            시행령조문: [{ 조번호: "0005", 조가지번호: "00", 조제목: "긴 위임", 조내용: "긴 위임 본문이다. ".repeat(600) }],
          },
        },
      },
    })
    const r = await handleFinArticle(stub(() => unitsJson([unit("1", "제1조(목적) 본문이다.")]), undefined, { getThreeTier: async () => THD }), {
      law: LAW,
      article: "제1조",
      include_rulings: false,
    })
    const text = r.content[0].text
    expect(text).not.toContain("전체 성공")
    expect(firstLine(text)).toContain("⚠위임 일부 절단(예산 4,000자)")
  })
})

describe("I4 — 첫 법령 검색부터 도구 deadline·호출 취소 안에 있다", () => {
  afterEach(() => vi.useRealTimers())

  it("첫 검색이 6.6초 걸리는(signal을 무시하는) 서버 → 6초 deadline 직후 반환, 첫 검색에 signal 전달", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    const seen: { signal?: AbortSignal } = {}
    const other: string[] = []
    const client = {
      searchLaw: async (q: string, _k: unknown, _d: number, _t: string, signal?: AbortSignal) => {
        seen.signal = signal
        return await new Promise<string>((resolve) => setTimeout(() => resolve(lawXml(LAW, LAW_MST)), 6600))
      },
      fetchApi: async () => {
        other.push("fetchApi")
        return "{}"
      },
      getThreeTier: async () => {
        other.push("thd")
        return "{}"
      },
      getAnnexes: async () => "{}",
      searchAdminRule: async () => '<?xml version="1.0"?><AdmRulSearch><totalCnt>0</totalCnt></AdmRulSearch>',
    } as unknown as LawApiClient
    const start = Date.now()
    let doneAt = 0
    const p = handleFinArticle(client, { law: LAW, article: "제1조" }).then((r) => {
      doneAt = Date.now()
      return r
    })
    await vi.advanceTimersByTimeAsync(6300)
    expect(doneAt).toBeGreaterThan(0)
    expect(doneAt - start).toBeLessThan(6600)
    expect(doneAt - start).toBeGreaterThanOrEqual(6000)
    expect(seen.signal).toBeDefined()
    expect(seen.signal?.aborted).toBe(true)
    const r = await p
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain("[REQUEST_TIMEOUT] 법령 검색 실패")
    expect(r.content[0].text).toContain("요청 취소됨(도구 deadline)")
    // 늦게 온 검색 결과로 후속 조회를 하지 않는다
    await vi.advanceTimersByTimeAsync(2000)
    expect(other).toEqual([])
  })

  it("호출자 취소(ctx.signal) → 즉시 중단, 취소 뒤 업스트림 요청 0건", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    const live: string[] = []
    const cancelled: string[] = []
    // 실제 api-client처럼: 취소된 signal이면 호출하지 않고 즉시 거절, 진행 중이면 abort에 거절
    const call = <T>(name: string, signal: AbortSignal | undefined, ms: number, value: T): Promise<T> => {
      if (signal?.aborted) {
        cancelled.push(name)
        return Promise.reject(new Error("요청 취소됨(도구 deadline) — 대기 중 취소되어 호출하지 않음"))
      }
      live.push(name)
      return new Promise<T>((resolve, reject) => {
        const t = setTimeout(() => resolve(value), ms)
        signal?.addEventListener("abort", () => {
          clearTimeout(t)
          reject(new Error("aborted"))
        })
      })
    }
    const client = {
      searchLaw: (_q: string, _k: unknown, _d: number, _t: string, signal?: AbortSignal) => call("searchLaw", signal, 3000, lawXml(LAW, LAW_MST)),
      fetchApi: (p: { signal?: AbortSignal }) => call("fetchApi", p.signal, 100, unitsJson([unit("1", "제1조 본문")])),
      getThreeTier: (p: { signal?: AbortSignal }) => call("thd", p.signal, 100, "{}"),
      getAnnexes: (p: { signal?: AbortSignal }) => call("annex", p.signal, 100, "{}"),
      searchAdminRule: (_q: string, _k: unknown, _d: number, signal?: AbortSignal) =>
        call("admrul", signal, 100, '<?xml version="1.0"?><AdmRulSearch><totalCnt>0</totalCnt></AdmRulSearch>'),
    } as unknown as LawApiClient
    const caller = new AbortController()
    const start = Date.now()
    let doneAt = 0
    const p = handleFinArticle(client, { law: LAW, article: "제1조" }, { signal: caller.signal }).then((r) => {
      doneAt = Date.now()
      return r
    })
    await vi.advanceTimersByTimeAsync(1000)
    const liveBeforeCancel = live.length
    caller.abort()
    await vi.advanceTimersByTimeAsync(300)
    expect(doneAt).toBeGreaterThan(0)
    expect(doneAt - start).toBeLessThan(1300)
    const r = await p
    expect(r.isError).toBe(true)
    expect(r.content[0].text).not.toContain("✗")
    await vi.advanceTimersByTimeAsync(10_000)
    // 취소 뒤 실제로 나간 요청 0건 (시도는 즉시 거절됨)
    expect(live.length).toBe(liveBeforeCancel)
    expect(live).toEqual(["searchLaw"])
  })

  it("이미 취소된 호출은 법령 검색도 하지 않는다", async () => {
    const live: string[] = []
    const client = {
      searchLaw: async (_q: string, _k: unknown, _d: number, _t: string, signal?: AbortSignal) => {
        if (signal?.aborted) throw new Error("요청 취소됨(도구 deadline) — 대기 중 취소되어 호출하지 않음")
        live.push("searchLaw")
        return lawXml(LAW, LAW_MST)
      },
    } as unknown as LawApiClient
    const caller = new AbortController()
    caller.abort()
    const r = await handleFinArticle(client, { law: LAW, article: "제1조" }, { signal: caller.signal })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain("호출자 취소")
    expect(live).toEqual([])
  })
})
