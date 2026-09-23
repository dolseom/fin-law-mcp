/**
 * fin_article 회귀 — 섹션 고지 문구 (9차 리뷰 I1·I4·B3)
 *
 * I1: 조문이 없을 때 "(✗없음)"과 실패용 꼬리 "— "없음"이 아니라 확인 불가입니다."가 **한 줄에** 나갔다.
 *     현행 조회의 정상 0건은 ✗없음, 기준일 조회의 미발견은 "그 시행본에 없음"(번호가 달랐을 수 있음) —
 *     한쪽 문구만 나가야 한다. 진짜 조회 실패는 종전대로 확인 불가다.
 * I4: 기준일 조회의 원문 링크는 법령명·조문만 담아 **현행본**을 연다 — 표시가 없으면 기준일 시행본의 원문으로 읽힌다.
 * B3: "개정 예정"이 이미 시행된 개정을 예정으로 내고 같은 시행일을 공포본 수만큼 반복했다
 *     (실측: 「소득세법 시행령」 현행 시행일 2026-07-01인데 "2026-07-01 시행 개정 공포됨" 4건 + 2027-01-01 ×6).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { handleFinArticle } from "./article.js"
import { lawCache } from "../lib/cache.js"
import type { LawApiClient } from "../lib/api-client.js"

const lawXml = (name: string, efYd: string) => `<?xml version="1.0" encoding="UTF-8"?>
<LawSearch><totalCnt>1</totalCnt>
  <law id="1"><법령명한글>${name}</법령명한글><법령일련번호>286211</법령일련번호><법령ID>003956</법령ID>
    <법령구분명>대통령령</법령구분명><시행일자>${efYd}</시행일자><제개정구분명>일부개정</제개정구분명><현행연혁코드>현행</현행연혁코드></law>
</LawSearch>`

const articleJson = (num: string, title: string, body: string) =>
  JSON.stringify({
    법령: { 조문: { 조문단위: [{ 조문여부: "조문", 조문번호: num, 조문가지번호: "0", 조문제목: title, 조문내용: body }] } },
  })

/** 2026-09-16 실측 `소득세법 시행령` eflaw 검색(display 20)의 시행예정·현행 행 (태그만 남김) */
const eflawRow = (mst: string, code: string, ancYd: string, efYd: string) =>
  `<law id="1"><법령일련번호>${mst}</법령일련번호><현행연혁코드>${code}</현행연혁코드><법령명한글><![CDATA[소득세법 시행령]]></법령명한글>` +
  `<법령ID>003956</법령ID><공포일자>${ancYd}</공포일자><제개정구분명>일부개정</제개정구분명><법령구분명>대통령령</법령구분명><시행일자>${efYd}</시행일자></law>`
const UPCOMING_XML =
  '<?xml version="1.0" encoding="UTF-8"?><LawSearch><target>eflaw</target>' +
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
  ]
    .map(([mst, code, anc, ef]) => eflawRow(mst, code, anc, ef))
    .join("") +
  "</LawSearch>"

function stub(opts: { article?: string | Error; eflawSearch?: string; slices?: string }): LawApiClient {
  return {
    searchLaw: async (_q: string, _k: unknown, _d: number, target: string) =>
      target === "eflaw" ? (opts.eflawSearch ?? '<?xml version="1.0"?><LawSearch><totalCnt>0</totalCnt></LawSearch>') : lawXml("소득세법 시행령", "20260701"),
    fetchApi: async (p: { endpoint: string; target: string }) => {
      if (p.endpoint === "lawSearch.do" && p.target === "eflaw") return opts.slices ?? ""
      if (p.endpoint === "lawSearch.do") return '<?xml version="1.0"?><CgmExpc><totalCnt>0</totalCnt></CgmExpc>'
      if (opts.article instanceof Error) throw opts.article
      return opts.article ?? '{"법령":{}}'
    },
    getThreeTier: async () => '{"LspttnThdCmpLawXService":{"기본정보":{"법령명":"소득세법 시행령","기준법령명":"소득세법 시행령"}}}',
    getAnnexes: async () => "{}",
    searchAdminRule: async () => '<?xml version="1.0"?><AdmRulSearch><totalCnt>0</totalCnt></AdmRulSearch>',
  } as unknown as LawApiClient
}

/** 기준일 해소가 읽는 eflaw 슬라이스 응답 */
const SLICE_2020 = `<?xml version="1.0" encoding="UTF-8"?><LawSearch><totalCnt>1</totalCnt>
  <law id="1"><법령명한글>소득세법 시행령</법령명한글><법령일련번호>230000</법령일련번호><시행일자>20200101</시행일자><공포일자>20191231</공포일자><공포번호>30000</공포번호><제개정구분명>일부개정</제개정구분명></law></LawSearch>`

/** 조문 섹션만 잘라 본다 — 다른 섹션의 "확인 불가" 문구와 섞이지 않게 */
const articleSection = (text: string) => {
  const start = text.indexOf("■ 소득세법 시행령")
  const end = text.indexOf("\n■ ", start + 1)
  return text.slice(start, end)
}

beforeEach(() => lawCache.clear())

describe("fin_article — 조문 없음 문구가 모순되지 않는다 (I1)", () => {
  it("현행 조회의 정상 0건은 ✗없음 한 가지로만 말한다", async () => {
    const r = await handleFinArticle(stub({}), { law: "소득세법 시행령", article: "제999조", include_rulings: false })
    const text = r.content[0].text
    const sec = articleSection(text)
    expect(sec).toContain("✗ 없음:")
    expect(sec).toContain("제999조 조문이 없습니다")
    expect(sec).not.toContain("확인 불가")
    expect(text.split("\n")[0]).toContain("조문 없음(✗)")
    expect(text.split("\n")[0]).not.toContain("실패 섹션: 조문")
  })

  it("기준일 조회의 미발견은 ✗없음으로 단정하지 않고, 확인 불가와도 섞지 않는다", async () => {
    const r = await handleFinArticle(stub({ slices: SLICE_2020 }), {
      law: "소득세법 시행령",
      article: "제999조",
      basis_date: "2020-01-01",
      include_rulings: false,
    })
    const text = r.content[0].text
    const sec = articleSection(text)
    expect(sec).toContain("⚠ 기준일 시행본에서 미발견")
    expect(sec).toContain("2020-01-01 시행본에서 제999조 조문을 찾지 못했습니다")
    expect(sec).toContain("현행 번호로 부존재를 단정하지 마세요")
    expect(sec).not.toContain("✗")
    expect(sec).not.toContain("확인 불가")
    expect(text.split("\n")[0]).toContain("조문 미발견(기준일 시행본)")
  })

  it("반대 방향: 진짜 조회 실패는 종전대로 '없음이 아니라 확인 불가'이고 ✗를 찍지 않는다", async () => {
    const r = await handleFinArticle(stub({ article: new Error("법제처 API가 HTML 오류 페이지를 반환했습니다") }), {
      law: "소득세법 시행령",
      article: "제38조",
      include_rulings: false,
    })
    const text = r.content[0].text
    const sec = articleSection(text)
    expect(sec).toContain("⚠ 조회 실패(실패)")
    expect(sec).toContain('"없음"이 아니라 확인 불가입니다')
    expect(sec).not.toContain("✗")
    expect(text.split("\n")[0]).toContain("실패 섹션: 조문(실패")
  })

  it("반대 방향: 조문이 있으면 두 문구 모두 없다", async () => {
    const r = await handleFinArticle(stub({ article: articleJson("38", "근로소득의 범위", "제38조(근로소득의 범위) 본문") }), {
      law: "소득세법 시행령",
      article: "제38조",
      include_rulings: false,
    })
    const sec = articleSection(r.content[0].text)
    expect(sec).toContain("제38조(근로소득의 범위) 본문")
    expect(sec).not.toContain("없음")
  })
})

describe("fin_article — 기준일이 시행일과 다를 때 본문은 시행본 시행일로 조회한다", () => {
  // 실측 2026-09-17: 법인세법 MST 212775(2020-01-01 시행본) + efYd=20200315 → HTML 오류,
  // efYd=20200101 → 정상. 종전 코드는 기준일을 그대로 넣어 "직전 개정본으로 조회"라고 적고는 본문 조회에 실패했다
  const efYds: string[] = []
  const htmlOnMismatch = (): LawApiClient =>
    ({
      searchLaw: async () => lawXml("소득세법 시행령", "20260701"),
      fetchApi: async (p: { endpoint: string; target: string; extraParams?: Record<string, string> }) => {
        if (p.endpoint === "lawSearch.do" && p.target === "eflaw") return SLICE_2020
        if (p.endpoint === "lawSearch.do") return '<?xml version="1.0"?><CgmExpc><totalCnt>0</totalCnt></CgmExpc>'
        efYds.push(p.extraParams?.efYd || "")
        if (p.extraParams?.efYd !== "20200101") throw new Error("법제처 API 비정상 응답(HTML 페이지)")
        return articleJson("38", "근로소득의 범위", "제38조(근로소득의 범위) 2020년 시행본 본문")
      },
      getThreeTier: async () => "{}",
      getAnnexes: async () => "{}",
      searchAdminRule: async () => '<?xml version="1.0"?><AdmRulSearch><totalCnt>0</totalCnt></AdmRulSearch>',
    }) as unknown as LawApiClient

  it("기준일 2020-03-15 → 2020-01-01 시행본의 본문이 나온다 (efYd=20200101)", async () => {
    efYds.length = 0
    const r = await handleFinArticle(htmlOnMismatch(), {
      law: "소득세법 시행령",
      article: "제38조",
      basis_date: "2020-03-15",
      include_rulings: false,
    })
    const text = r.content[0].text
    expect(efYds).toEqual(["20200101"])
    expect(text).toContain("직전 개정본 2020-01-01 시행 기준으로 조회")
    expect(text).toContain("2020년 시행본 본문")
    expect(articleSection(text)).not.toContain("조회 실패")
  })

  it("반대 방향: 기준일이 곧 시행일이면 그 날짜 그대로다", async () => {
    efYds.length = 0
    await handleFinArticle(htmlOnMismatch(), { law: "소득세법 시행령", article: "제38조", basis_date: "2020-01-01", include_rulings: false })
    expect(efYds).toEqual(["20200101"])
  })
})

describe("fin_article — 기준일 본문 조회의 MST·efYd는 선택한 시행본의 것 그대로다", () => {
  // 실측 2026-09-17: 법인세법 2020-01-01 시행본 MST 212775 + efYd=20200315(기준일) → HTML 오류,
  // efYd=20200101(그 판본 시행일) → 정상. 기준일이 시행일과 같은 날로만 재면 통과해 보인다.
  const CORP_SLICES = `<?xml version="1.0" encoding="UTF-8"?><LawSearch><totalCnt>2</totalCnt>
  <law id="1"><법령명한글>법인세법</법령명한글><법령일련번호>212775</법령일련번호><시행일자>20200101</시행일자><공포일자>20191231</공포일자><공포번호>16833</공포번호><제개정구분명>일부개정</제개정구분명></law>
  <law id="2"><법령명한글>법인세법</법령명한글><법령일련번호>200000</법령일련번호><시행일자>20190101</시행일자><공포일자>20181224</공포일자><공포번호>16008</공포번호><제개정구분명>일부개정</제개정구분명></law></LawSearch>`

  function corpStub(seen: Array<Record<string, string>>): LawApiClient {
    return {
      searchLaw: async () => lawXml("법인세법", "20260101").replace("286211", "280349"),
      fetchApi: async (p: { endpoint: string; target: string; extraParams?: Record<string, string> }) => {
        if (p.endpoint === "lawSearch.do" && p.target === "eflaw") {
          const to = (p.extraParams?.efYd || "").split("~")[1] || "99991231"
          return to >= "20200101" ? CORP_SLICES : CORP_SLICES.replace(/<law id="1">[\s\S]*?<\/law>/, "")
        }
        if (p.endpoint === "lawSearch.do") return '<?xml version="1.0"?><CgmExpc><totalCnt>0</totalCnt></CgmExpc>'
        seen.push({ target: p.target, ...(p.extraParams || {}) })
        const { MST, efYd } = p.extraParams || {}
        if (MST === "212775" && efYd === "20200101") {
          return articleJson("26", "과다경비 등의 손금불산입", "제26조(과다경비 등의 손금불산입) 2020-01-01 시행본 본문")
        }
        throw new Error("법제처 API 비정상 응답(HTML 페이지)")
      },
      getThreeTier: async () => "{}",
      getAnnexes: async () => "{}",
      searchAdminRule: async () => '<?xml version="1.0"?><AdmRulSearch><totalCnt>0</totalCnt></AdmRulSearch>',
    } as unknown as LawApiClient
  }

  it("법인세법 기준일 2020-03-15 → MST 212775 + efYd=20200101 한 번만 부른다", async () => {
    const seen: Array<Record<string, string>> = []
    const r = await handleFinArticle(corpStub(seen), {
      law: "법인세법",
      article: "제26조",
      basis_date: "2020-03-15",
      include_rulings: false,
    })
    const text = r.content[0].text
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ target: "eflaw", MST: "212775", JO: "002600", efYd: "20200101" })
    expect(text).toContain("2020-01-01 시행본 본문")
    expect(text).toContain("직전 개정본 2020-01-01 시행 기준으로 조회")
    expect(text).not.toContain("조회 실패")
  })

  it("반대 방향: 기준일이 시행본 시행일과 같으면 그대로 20200101 (괄호 고지는 붙지 않는다)", async () => {
    const seen: Array<Record<string, string>> = []
    const r = await handleFinArticle(corpStub(seen), {
      law: "법인세법",
      article: "제26조",
      basis_date: "2020-01-01",
      include_rulings: false,
    })
    expect(seen[0]).toMatchObject({ MST: "212775", efYd: "20200101" })
    expect(r.content[0].text).not.toContain("직전 개정본")
  })
})

describe("fin_article — 기준일 해소에도 도구 예산(6초)과 취소가 걸린다", () => {
  afterEach(() => vi.useRealTimers())

  /** 취소되면 즉시 거절하고, 아니면 20초 뒤에야 응답하는 느린 서버 */
  function slowSliceStub(seen: { signal?: AbortSignal }): LawApiClient {
    return {
      searchLaw: async () => lawXml("소득세법 시행령", "20260701"),
      fetchApi: async (p: { endpoint: string; target: string; signal?: AbortSignal }) => {
        if (p.endpoint === "lawSearch.do" && p.target === "eflaw") {
          seen.signal = p.signal
          return await new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => resolve(SLICE_2020), 20_000)
            p.signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(timer)
                reject(new Error("요청 취소됨(도구 deadline) — 대기 중 취소되어 호출하지 않음"))
              },
              { once: true }
            )
          })
        }
        if (p.endpoint === "lawSearch.do") return '<?xml version="1.0"?><CgmExpc><totalCnt>0</totalCnt></CgmExpc>'
        return articleJson("38", "근로소득의 범위", "본문")
      },
      getThreeTier: async () => "{}",
      getAnnexes: async () => "{}",
      searchAdminRule: async () => '<?xml version="1.0"?><AdmRulSearch><totalCnt>0</totalCnt></AdmRulSearch>',
    } as unknown as LawApiClient
  }

  it("응답이 없으면 6초에 실제로 취소되고, '조문 없음'이 아니라 ⚠판정불가로 끝난다", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    const seen: { signal?: AbortSignal } = {}
    const p = handleFinArticle(slowSliceStub(seen), {
      law: "소득세법 시행령",
      article: "제38조",
      basis_date: "2020-01-01",
      include_rulings: false,
    })
    await vi.advanceTimersByTimeAsync(6000)
    // signal을 안 넘기면(종전 코드) 이 호출만 deadline 밖에 놓여 취소되지 않는다
    expect(seen.signal).toBeDefined()
    expect(seen.signal?.aborted).toBe(true)
    const r = await p
    const text = r.content[0].text
    expect(r.isError).toBe(true)
    expect(text).toContain("[BASIS_DATE_UNRESOLVED]")
    expect(text).toContain("⚠판정불가 (없음이 아님)")
    expect(text).toContain("요청 취소됨(도구 deadline)")
    expect(text).not.toContain("✗")
    expect(text).not.toContain("조문이 없습니다")
  })

  it("반대 방향: 예산 안에 응답하면 취소하지 않고 그대로 조회한다", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    const seen: { signal?: AbortSignal } = {}
    const client = slowSliceStub(seen)
    const fast = {
      ...client,
      fetchApi: async (p: { endpoint: string; target: string; signal?: AbortSignal }) => {
        if (p.endpoint === "lawSearch.do" && p.target === "eflaw") {
          seen.signal = p.signal
          return SLICE_2020
        }
        return client.fetchApi(p as never)
      },
    } as unknown as LawApiClient
    const p = handleFinArticle(fast, { law: "소득세법 시행령", article: "제38조", basis_date: "2020-01-01", include_rulings: false })
    await vi.advanceTimersByTimeAsync(10)
    const r = await p
    expect(seen.signal?.aborted).toBe(false)
    expect(r.content[0].text).not.toContain("BASIS_DATE_UNRESOLVED")
    expect(r.content[0].text).toContain("[기준일: 2020-01-01 시행 기준]")
  })
})

describe("fin_article — 기준일 조회의 원문 링크는 현행본임을 밝힌다 (I4)", () => {
  it("기준일 조회: 링크에 현행본 표시", async () => {
    const r = await handleFinArticle(stub({ slices: SLICE_2020, article: articleJson("38", "근로소득의 범위", "본문") }), {
      law: "소득세법 시행령",
      article: "제38조",
      basis_date: "2020-01-01",
      include_rulings: false,
    })
    expect(r.content[0].text).toContain("원문(현행본 링크 — 2020-01-01 시행본이 아님): https://www.law.go.kr/")
  })

  it("반대 방향: 현행 조회는 종전 표기 그대로", async () => {
    const r = await handleFinArticle(stub({ article: articleJson("38", "근로소득의 범위", "본문") }), {
      law: "소득세법 시행령",
      article: "제38조",
      include_rulings: false,
    })
    const text = r.content[0].text
    expect(text).toContain("· 원문: https://www.law.go.kr/")
    expect(text).not.toContain("현행본 링크")
  })
})

describe("fin_article — 개정 예정은 아직 시행 전인 것만, 시행일별로 한 번 (B3)", () => {
  afterEach(() => vi.useRealTimers())
  const UPCOMING_HEAD = "■ ⚠ 법령 개정 예정(「소득세법 시행령」 법령 단위 — 이 조문 해당 여부는 부칙·개정문 확인) — "

  it("이미 시행된 2026-07-01을 예정으로 내지 않고 2027-01-01은 한 번만 낸다", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-09-16T12:00:00+09:00"))
    const r = await handleFinArticle(stub({ eflawSearch: UPCOMING_XML, article: articleJson("38", "근로소득의 범위", "본문") }), {
      law: "소득세법 시행령",
      article: "제38조",
      include_rulings: false,
    })
    const text = r.content[0].text
    expect(text).toContain(
      `${UPCOMING_HEAD}2027-01-01 시행 개정 공포됨(공포 2026-02-27 외 5건) · 2028-01-01 시행 개정 공포됨(공포 2025-02-28)`
    )
    expect(text).not.toContain("2026-07-01 시행 개정")
    expect(text.match(/2027-01-01 시행 개정/g)).toHaveLength(1)
  })

  it("반대 방향: 시행 전이면 2026-07-01 개정도 예정으로 나온다", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-06-30T12:00:00+09:00"))
    const r = await handleFinArticle(stub({ eflawSearch: UPCOMING_XML, article: articleJson("38", "근로소득의 범위", "본문") }), {
      law: "소득세법 시행령",
      article: "제38조",
      include_rulings: false,
    })
    expect(r.content[0].text).toContain(`${UPCOMING_HEAD}2026-07-01 시행 개정 공포됨(공포 2026-02-27 외 3건) · 2027-01-01`)
  })

  it("법령 단위 예고임을 밝힌다 — 조문 개정으로 읽히는 '■ ⚠ 개정 예정 —' 단독 표기를 쓰지 않는다 (R3 항목 5)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-09-16T12:00:00+09:00"))
    const r = await handleFinArticle(stub({ eflawSearch: UPCOMING_XML, article: articleJson("38", "근로소득의 범위", "본문") }), {
      law: "소득세법 시행령",
      article: "제38조",
      include_rulings: false,
    })
    const text = r.content[0].text
    expect(text).toContain("법령 단위")
    expect(text).toContain("이 조문 해당 여부는 부칙·개정문 확인")
    expect(text).not.toContain("■ ⚠ 개정 예정 —")
  })

  it("시행예정 행이 모두 지난 날짜면 개정 예정 줄을 내지 않는다", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2028-06-01T12:00:00+09:00"))
    const r = await handleFinArticle(stub({ eflawSearch: UPCOMING_XML, article: articleJson("38", "근로소득의 범위", "본문") }), {
      law: "소득세법 시행령",
      article: "제38조",
      include_rulings: false,
    })
    expect(r.content[0].text).not.toContain("개정 예정")
  })
})
