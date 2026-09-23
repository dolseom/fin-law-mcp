/**
 * fin_nts_ruling — 입력 오류 문구·계약 회귀 (Codex 제품 검토 2026-09-05, 지적 3·4)
 *
 * 3. description이 "본문 전문"이라고 했지만 본문은 6,000자에서 절단된다 — 계약 과장
 * 4. zod 기본 오류가 영어로 샜다 ("Too big: expected number to be <=5")
 *
 * 네트워크를 타지 않는다: 입력 검증은 apiClient에 닿기 전에 끝나므로 스텁이 호출되면 그것이 회귀다.
 */
import { describe, it, expect, afterEach, vi } from "vitest"
import { handleFinNtsRuling, FIN_NTS_RULING_TOOL, BUDGET_BODY, resolveDefaultTopN } from "./nts-ruling.js"
import type { LawApiClient } from "../lib/api-client.js"

/** 입력 오류 경로에서는 절대 호출되면 안 되는 스텁 */
function neverCalled(): LawApiClient {
  return {
    fetchApi: async () => {
      throw new Error("입력 검증 실패인데 API를 호출했다")
    },
  } as unknown as LawApiClient
}

describe("fin_nts_ruling — 입력 오류는 한글 [INVALID_PARAMETER]", () => {
  it("top_n_bodies 범위 초과는 영어 zod 문구가 아니라 한글 안내를 준다", async () => {
    const r = await handleFinNtsRuling(neverCalled(), { query: "퇴직금", top_n_bodies: 6 })
    const text = r.content[0].text
    expect(r.isError).toBe(true)
    expect(text).toContain("[INVALID_PARAMETER] fin_nts_ruling:")
    expect(text).toContain("top_n_bodies는 0~5의 정수입니다 (입력: 6)")
    // 영어 유출 금지 — zod 기본 메시지의 표지
    expect(text).not.toMatch(/Too big|expected|Invalid/)
    // 다른 도구(calc·article)와 같은 예시 안내
    expect(text).toContain(`💡 예: {"query":"퇴직금 중간정산","top_n_bodies":3}`)
  })

  it("정수가 아닌 top_n_bodies도 같은 형식", async () => {
    const r = await handleFinNtsRuling(neverCalled(), { query: "퇴직금", top_n_bodies: 2.5 })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain("top_n_bodies는 0~5의 정수입니다 (입력: 2.5)")
  })

  it("빈 query도 같은 형식", async () => {
    const r = await handleFinNtsRuling(neverCalled(), { query: "" })
    const text = r.content[0].text
    expect(r.isError).toBe(true)
    expect(text).toContain("[INVALID_PARAMETER] fin_nts_ruling:")
    expect(text).toContain("query는 1자 이상의 검색어 문자열입니다")
    expect(text).not.toMatch(/Too small|expected|String must/)
  })

  it("query 누락은 '필수'라고 말한다 (빈 문자열과 구분)", async () => {
    const r = await handleFinNtsRuling(neverCalled(), { top_n_bodies: 1 })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain("query(예규 검색어)는 필수입니다")
  })

  /** Codex 9차 M4 — 공백만 있는 검색어가 빈 검색어로 API를 불러 "0건 (정상 조회 결과 없음)"이 됐다 */
  it("공백만 있는 query는 API를 부르지 않고 한글 안내를 준다", async () => {
    for (const q of ["   ", "\t"]) {
      const r = await handleFinNtsRuling(neverCalled(), { query: q })
      expect(r.isError).toBe(true)
      expect(r.content[0].text).toContain("공백만으로는 조회하지 않습니다")
      expect(r.content[0].text).not.toContain("정상 조회 결과 없음")
    }
  })
})

/**
 * Codex 9차 [차단] L — "N건 중 최신순"이 사실과 달랐고 본문도 오래된 예규에서 동봉됐다.
 * 픽스처는 실응답 형태를 따른다 (totalCnt 163 > 항목 10, 일자 "YYYY.MM.DD", 2026-09-16 실측 일자).
 */
const ntsItem = (n: number, date: string, title: string, link?: string) =>
  `<cgmExpc id="${n}"><법령해석일련번호>${n}</법령해석일련번호><안건명><![CDATA[${title}]]></안건명><안건번호>서면-${n}</안건번호>` +
  `<해석일자>${date}</해석일자>` +
  `<법령해석상세링크>${link ?? `https://taxlaw.nts.go.kr/qt/USEQTA002P.do?ntstDcmId=0100000000000${String(n).padStart(5, "0")}`}</법령해석상세링크></cgmExpc>`

const ntsXml = (total: number, rows: Array<[string, string]>) =>
  `<?xml version="1.0" encoding="UTF-8"?><CgmExpc><target>ntsCgmExpc</target><section>itmNm</section>` +
  `<totalCnt>${total}</totalCnt><page>1</page><numOfRows>${rows.length}</numOfRows>` +
  rows.map(([d, t], i) => ntsItem(i + 1, d, t)).join("") +
  `</CgmExpc>`

const DDES_DATES = ["2025.02.17", "2024.07.10", "2024.02.29", "2023.09.15", "2023.04.11", "2021.06.29", "2018.05.24", "2017.06.22", "2016.11.22", "2016.01.13"]
const GANADA_DATES = ["2004.03.08", "2021.06.29", "1999.09.14", "2009.03.17", "2002.03.09", "1997.05.12", "1997.06.23", "1997.07.22", "1999.09.09", "1999.05.10"]
const EMPTY_NTS = "<CgmExpc><totalCnt>0</totalCnt></CgmExpc>"

function recordingClient(respond: (q: string) => string): { client: LawApiClient; calls: Array<Record<string, string>> } {
  const calls: Array<Record<string, string>> = []
  const client = {
    fetchApi: async (p: { extraParams?: Record<string, string> }) => {
      calls.push({ ...(p.extraParams ?? {}) })
      return respond(p.extraParams?.query ?? "")
    },
  } as unknown as LawApiClient
  return { client, calls }
}

describe("fin_nts_ruling — 최신순·검색 건수 (Codex 9차 L)", () => {
  it("sort=ddes로 요청하고, 검색 총건수(totalCnt) 대비 최신순으로 적는다", async () => {
    const { client, calls } = recordingClient(() => ntsXml(163, DDES_DATES.map((d, i) => [d, `퇴직금 중간정산 ${i}`])))
    const r = await handleFinNtsRuling(client, { query: "퇴직금 중간정산", top_n_bodies: 0 })
    expect(calls[0].sort).toBe("ddes")
    const text = r.content[0].text
    expect(text).toContain("국세청 예규 — 163건 중 최신순 10건")
    expect(text.split("\n")[1]).toContain("(2025.02.17)")
  })

  it("받은 순서가 일자 내림차순이 아니면(정렬 미적용) 최신순이라 쓰지 않는다", async () => {
    const { client } = recordingClient(() => ntsXml(163, GANADA_DATES.map((d, i) => [d, `퇴직금 중간정산 ${i}`])))
    const r = await handleFinNtsRuling(client, { query: "퇴직금 중간정산", top_n_bodies: 0 })
    const text = r.content[0].text
    expect(text).not.toContain("중 최신순")
    expect(text).toContain("163건 중 법제처 응답 10건을 일자순 정렬 — 최신순 미보장")
  })

  it("totalCnt를 못 읽으면 받은 건수를 총건수로 부르지 않고, 순서가 뒤섞였으면 최신순이라 쓰지 않는다", async () => {
    const noTotal = ntsXml(163, GANADA_DATES.map((d, i) => [d, `퇴직금 중간정산 ${i}`])).replace("<totalCnt>163</totalCnt>", "")
    const { client } = recordingClient(() => noTotal)
    const r = await handleFinNtsRuling(client, { query: "퇴직금 중간정산", top_n_bodies: 0 })
    const text = r.content[0].text
    expect(text).toContain(
      "받은 10건(검색 총건수 미확인 — 응답의 totalCnt를 읽지 못함) 중 법제처 응답 10건을 일자순 정렬 — 최신순 미보장"
    )
    expect(text).not.toContain("10건 중 최신순")
  })

  it("반대 방향: 전체를 다 받았으면(totalCnt = 받은 건수) 최신순이 사실이다", async () => {
    const { client } = recordingClient(() => ntsXml(10, GANADA_DATES.map((d, i) => [d, `퇴직금 중간정산 ${i}`])))
    const r = await handleFinNtsRuling(client, { query: "퇴직금 중간정산", top_n_bodies: 0 })
    const text = r.content[0].text
    expect(text).toContain("10건 중 최신순 10건")
    expect(text).not.toContain("검색 총건수 미확인")
    expect(text.split("\n")[1]).toContain("(2021.06.29)")
  })

  /**
   * 종전 `Math.max(totalCnt, 받은 건수)`는 totalCnt 2 / 수신 3을 "3건"으로 지어내, 받은 3건이
   * 검색 결과 전부인 것처럼 읽혔다 — 총건수도 받은 건수도 그 수를 말한 적이 없다.
   * 총건수 확인은 정렬 판정과 **별개**라 모순마다 내림차순·뒤섞임 양쪽을 본다 (ruling-search와 같은 계약).
   */
  describe("총건수는 지어내지 않는다 — 모순·누락·비숫자", () => {
    const DESC_3 = ["2025.02.17", "2024.07.10", "2023.09.15"]
    const MIXED_3 = ["2004.03.08", "2021.06.29", "1999.09.14"]
    const run = async (xml: string): Promise<string> => {
      const { client } = recordingClient(() => xml)
      return (await handleFinNtsRuling(client, { query: "퇴직금 중간정산", top_n_bodies: 0 })).content[0].text
    }
    const xmlOf = (dates: string[], total: number) => ntsXml(total, dates.map((d, i) => [d, `퇴직금 중간정산 ${i}`]))

    it("모순(totalCnt 2 < 받은 3)은 내림차순·뒤섞임 양쪽에서 미확인으로 적는다", async () => {
      for (const dates of [DESC_3, MIXED_3]) {
        const text = await run(xmlOf(dates, 2))
        const head = text.split("\n")[0]
        expect(head).toContain("받은 3건(검색 총건수 미확인 — totalCnt 2건 < 받은 3건)")
        // 종전: Math.max(2, 3) = 3 → "3건 중 최신순 3건"
        expect(head).not.toContain("3건 중 최신순")
        expect(head).not.toContain("2건 중")
      }
    })

    it("모순의 극단: totalCnt 0인데 3건을 받았다 — 0건이라 적지 않는다", async () => {
      const head = (await run(xmlOf(DESC_3, 0))).split("\n")[0]
      expect(head).toContain("받은 3건(검색 총건수 미확인 — totalCnt 0건 < 받은 3건)")
      expect(head).not.toContain("0건 중")
      expect(head).not.toContain("— 0건")
    })

    it("누락(totalCnt 태그 없음)은 내림차순에서도 받은 건수를 총건수로 부르지 않는다", async () => {
      const head = (await run(xmlOf(DESC_3, 42).replace("<totalCnt>42</totalCnt>", ""))).split("\n")[0]
      expect(head).toContain("받은 3건(검색 총건수 미확인 — 응답의 totalCnt를 읽지 못함) 중 최신순 3건")
      expect(head).not.toContain("3건 중 최신순")
    })

    it("비숫자(totalCnt 알수없음)도 미확인 — 내림차순·뒤섞임 양쪽", async () => {
      for (const dates of [DESC_3, MIXED_3]) {
        const head = (
          await run(xmlOf(dates, 42).replace("<totalCnt>42</totalCnt>", "<totalCnt>알수없음</totalCnt>"))
        ).split("\n")[0]
        expect(head).toContain("받은 3건(검색 총건수 미확인 — 응답의 totalCnt를 읽지 못함)")
        expect(head).not.toContain("42건 중")
        expect(head).not.toContain("3건 중 최신순")
      }
    })

    it("반대 방향: totalCnt 42 · 받은 3건은 확인된 총건수라 그대로 적는다", async () => {
      for (const dates of [DESC_3, MIXED_3]) {
        const head = (await run(xmlOf(dates, 42))).split("\n")[0]
        expect(head).toContain("42건 중")
        expect(head).not.toContain("검색 총건수 미확인")
      }
    })
  })
})

/**
 * 국세법령정보시스템 본문 요청에서 ntstDcmId만 기록 (실제 본문 추출 성공 여부와 무관).
 * 본문 조회 건수를 세는 describe 두 곳이 같은 관찰 방식을 써야 해서 모듈 수준에 둔다.
 */
function recordBodyRequests(): string[] {
  const ids: string[] = []
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const params = new URLSearchParams(String(init?.body ?? ""))
    const id = JSON.parse(params.get("paramData") || "{}")?.dcmDVO?.ntstDcmId
    if (id) ids.push(id)
    return new Response(JSON.stringify({ data: {} }), { status: 200 })
  }) as typeof fetch
  return ids
}

describe("fin_nts_ruling — 본문 동봉은 최신 건에서 (Codex 9차 L ⑤)", () => {
  const origFetch = globalThis.fetch
  const origEnabled = process.env.FIN_NTS_BODY_ENABLED
  afterEach(() => {
    globalThis.fetch = origFetch
    if (origEnabled === undefined) delete process.env.FIN_NTS_BODY_ENABLED
    else process.env.FIN_NTS_BODY_ENABLED = origEnabled
  })

  it("받은 순서가 뒤섞여 있어도 일자 최신 2건의 본문을 요청한다", async () => {
    process.env.FIN_NTS_BODY_ENABLED = "true"
    const ids = recordBodyRequests()
    // 전체 10건을 가나다순으로 받음 — 최신은 2번째(2021.06.29)·4번째(2009.03.17)
    const { client } = recordingClient(() => ntsXml(10, GANADA_DATES.map((d, i) => [d, `퇴직금 중간정산 ${i}`])))
    await handleFinNtsRuling(client, { query: "퇴직금 중간정산", top_n_bodies: 2 })
    expect(ids.sort()).toEqual(["010000000000000002", "010000000000000004"])
  })

  it("반대 방향: 법제처가 최신순으로 준 목록이면 앞 2건 그대로다", async () => {
    process.env.FIN_NTS_BODY_ENABLED = "true"
    const ids = recordBodyRequests()
    const { client } = recordingClient(() => ntsXml(163, DDES_DATES.map((d, i) => [d, `퇴직금 중간정산 ${i}`])))
    await handleFinNtsRuling(client, { query: "퇴직금 중간정산", top_n_bodies: 2 })
    expect(ids.sort()).toEqual(["010000000000000001", "010000000000000002"])
  })

  it("본문 실패 시 싣는 원문 링크에 인증키(OC)가 있으면 가린다", async () => {
    process.env.FIN_NTS_BODY_ENABLED = "true"
    recordBodyRequests()
    const drf = "/DRF/lawService.do?OC=OC_SENTINEL_TEST&amp;target=ntsCgmExpc&amp;ID=777&amp;type=HTML"
    const xml =
      `<CgmExpc><totalCnt>1</totalCnt>${ntsItem(1, "2024.01.01", "퇴직금 중간정산", drf)}</CgmExpc>`
    const { client } = recordingClient(() => xml)
    const r = await handleFinNtsRuling(client, { query: "퇴직금 중간정산", top_n_bodies: 1 })
    const text = r.content[0].text
    expect(text).toContain("⚠ 본문 조회 실패")
    expect(text).not.toContain("OC_SENTINEL_TEST")
    expect(text).toContain("원문: /DRF/lawService.do?OC=***&target=ntsCgmExpc")
  })
})

describe("fin_nts_ruling — 축약 사다리 (Codex 9차 M2, fin_ruling_search와 같은 사다리)", () => {
  it("종착점이 주체('임직원')가 아니라 주제어('경조사비')다", async () => {
    const { client, calls } = recordingClient(() => EMPTY_NTS)
    const r = await handleFinNtsRuling(client, { query: "임직원 경조사비 복리후생비 손금", top_n_bodies: 0 })
    expect(calls.map((c) => c.query)).toEqual([
      "임직원 경조사비 복리후생비 손금",
      "임직원 경조사비 복리후생비",
      "경조사비 복리후생비",
      "경조사비",
    ])
    expect(r.content[0].text).toContain("전부 0건 — 정상 조회 결과 없음")
  })

  it("축약 단계에서 찾은 결과에는 빠진 어절 경고를 붙인다", async () => {
    const { client } = recordingClient((q) =>
      q === "경조사비" ? ntsXml(1, [["2003.05.27", "임직원에게 지급하는 경조사비의 손금산입 범위"]]) : EMPTY_NTS
    )
    const r = await handleFinNtsRuling(client, { query: "임직원 경조사비 복리후생비 손금", top_n_bodies: 0 })
    const text = r.content[0].text
    expect(text).toContain(`검색어 축약: "임직원 경조사비 복리후생비 손금" → "경조사비"`)
    expect(text).toContain(`⚠ 검색어 축약으로 빠진 어절: "임직원", "복리후생비", "손금"`)
    expect(text).toContain("임직원에게 지급하는 경조사비의 손금산입 범위")
  })

  it("반대 방향: 원 검색어로 찾으면 축약 표기·경고가 없다", async () => {
    const { client, calls } = recordingClient(() => ntsXml(1, [["2003.05.27", "경조사비 손금산입"]]))
    const r = await handleFinNtsRuling(client, { query: " 경조사비  손금 ", top_n_bodies: 0 })
    expect(calls.map((c) => c.query)).toEqual(["경조사비 손금"])
    expect(r.content[0].text).not.toContain("검색어 축약")
  })
})

/**
 * FIN_NTS_BODY_TOP_N 해석 계약.
 *
 * 종전 `Number(env) || 2`는 **명시한 "0"을 2로 되돌렸다** — "목록만 받겠다"는 서버 설정이 조용히
 * 무시되고 비공식 경로(taxlaw)에서 매번 본문 2건을 받아 왔다. 같은 줄이 빈 문자열을
 * `Number("")=0`의 falsy로 처리해 "미지정"과 "명시 0"을 구분할 수 없었다.
 * 해석 규칙 전체를 여기서 고정한다 (resolveDefaultTopN 주석의 표와 같은 사실).
 */
describe("fin_nts_ruling — FIN_NTS_BODY_TOP_N 해석 (기본값 계약)", () => {
  const origTopN = process.env.FIN_NTS_BODY_TOP_N
  afterEach(() => {
    if (origTopN === undefined) delete process.env.FIN_NTS_BODY_TOP_N
    else process.env.FIN_NTS_BODY_TOP_N = origTopN
  })

  const resolved = (raw: string | undefined): number => {
    if (raw === undefined) delete process.env.FIN_NTS_BODY_TOP_N
    else process.env.FIN_NTS_BODY_TOP_N = raw
    return resolveDefaultTopN()
  }

  it("미지정·빈값·공백만은 기본 2 — Number('')=0의 falsy에 기대지 않는다", () => {
    expect(resolved(undefined)).toBe(2)
    expect(resolved("")).toBe(2)
    expect(resolved("   ")).toBe(2)
    expect(resolved("\t")).toBe(2)
  })

  it("명시한 '0'은 0이다 (목록만) — 종전 결함의 핵심", () => {
    expect(resolved("0")).toBe(0)
  })

  it("0~5 정수는 그대로, 앞뒤 공백은 걷어낸다", () => {
    expect(resolved("1")).toBe(1)
    expect(resolved("3")).toBe(3)
    expect(resolved("5")).toBe(5)
    expect(resolved(" 3 ")).toBe(3)
  })

  it("범위 밖은 가까운 경계로 클램프하고 소수부는 버린다 (스키마가 0~5 정수라서)", () => {
    expect(resolved("6")).toBe(5)
    expect(resolved("99")).toBe(5)
    expect(resolved("-1")).toBe(0)
    expect(resolved("2.9")).toBe(2)
    expect(resolved("0.9")).toBe(0)
  })

  it("해석할 수 없는 값은 기본 2 — 조용히 0으로 깎지 않는다", () => {
    expect(resolved("abc")).toBe(2)
    expect(resolved("NaN")).toBe(2)
    expect(resolved("Infinity")).toBe(2)
    expect(resolved("-Infinity")).toBe(2)
    expect(resolved("3개")).toBe(2)
  })

  it("도구 설명은 기본값이 서버 설정으로 달라질 수 있음을 밝힌다 (스키마와 같은 문구)", () => {
    const d = FIN_NTS_RULING_TOOL.inputSchema.properties.top_n_bodies.description
    expect(d).toContain("FIN_NTS_BODY_TOP_N")
    expect(d).toContain("0=목록만")
    expect(d).toContain("최대 5")
  })
})

/**
 * 환경값이 **실제 본문 조회 건수**로 이어지는지 — 해석만 맞고 배선이 빠지면 절반만 고친 것이다.
 * 국세청 본문 경로는 나가지 않는다: globalThis.fetch를 가로채 요청 건수만 센다.
 */
describe("fin_nts_ruling — 기본 동봉 건수가 실제 본문 조회에 반영된다", () => {
  const origFetch = globalThis.fetch
  const origEnabled = process.env.FIN_NTS_BODY_ENABLED
  const origTopN = process.env.FIN_NTS_BODY_TOP_N
  const origRate = process.env.FIN_NTS_RATE_PER_MIN

  afterEach(() => {
    globalThis.fetch = origFetch
    for (const [k, v] of [
      ["FIN_NTS_BODY_ENABLED", origEnabled],
      ["FIN_NTS_BODY_TOP_N", origTopN],
      ["FIN_NTS_RATE_PER_MIN", origRate],
    ] as const) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    vi.resetModules()
  })

  /**
   * 새 모듈 인스턴스의 handler를 얻는다.
   * 국세청 본문 경로의 분당 토큰버킷은 nts-body.ts **모듈 로드 시** 정해진다(기본 10/분) —
   * 본문 건수를 세는 테스트가 여럿이면 서로의 토큰을 갉아먹어 RATE_LIMITED가 건수 차이로 둔갑한다.
   * 모듈을 새로 불러 버킷도 함께 새로 받고, 그 김에 env를 읽는 경로 전체를 다시 통과시킨다.
   */
  async function freshHandler(topN: string | undefined): Promise<typeof handleFinNtsRuling> {
    vi.resetModules()
    if (topN === undefined) delete process.env.FIN_NTS_BODY_TOP_N
    else process.env.FIN_NTS_BODY_TOP_N = topN
    process.env.FIN_NTS_BODY_ENABLED = "true"
    process.env.FIN_NTS_RATE_PER_MIN = "100"
    const mod = await import("./nts-ruling.js")
    return mod.handleFinNtsRuling
  }

  /** 최신순 10건 목록 (totalCnt 163) — 본문 후보는 얼마든지 있다 */
  const listClient = () => recordingClient(() => ntsXml(163, DDES_DATES.map((d, i) => [d, `퇴직금 중간정산 ${i}`]))).client

  it("FIN_NTS_BODY_TOP_N='0' + top_n_bodies 생략이면 본문을 한 건도 요청하지 않는다", async () => {
    const handler = await freshHandler("0")
    const ids = recordBodyRequests()
    const r = await handler(listClient(), { query: "퇴직금 중간정산" })
    expect(ids).toHaveLength(0)
    const text = r.content[0].text
    expect(text).toContain("(본문 미동봉 — top_n_bodies=0 · 서버 설정 FIN_NTS_BODY_TOP_N=0)")
    // 목록 자체는 그대로 나온다 — 0은 "조회 실패"가 아니다
    expect(text).toContain("163건 중 최신순 10건")
  })

  it("반대 방향: 서버 기본이 2여도 입력 top_n_bodies=0이면 본문 요청 0건", async () => {
    const handler = await freshHandler("2")
    const ids = recordBodyRequests()
    const r = await handler(listClient(), { query: "퇴직금 중간정산", top_n_bodies: 0 })
    expect(ids).toHaveLength(0)
    // 입력으로 0을 준 경우엔 서버 설정 탓으로 적지 않는다
    expect(r.content[0].text).toContain("(본문 미동봉 — top_n_bodies=0)")
    expect(r.content[0].text).not.toContain("서버 설정")
  })

  it("미지정이면 기본 2건의 본문을 요청한다 (최신 2건)", async () => {
    const handler = await freshHandler(undefined)
    const ids = recordBodyRequests()
    await handler(listClient(), { query: "퇴직금 중간정산" })
    expect(ids.sort()).toEqual(["010000000000000001", "010000000000000002"])
  })

  it("범위를 넘는 환경값은 상한 5건에서 멈춘다", async () => {
    const handler = await freshHandler("9")
    const ids = recordBodyRequests()
    await handler(listClient(), { query: "퇴직금 중간정산" })
    expect(ids).toHaveLength(5)
  })

  it("해석할 수 없는 환경값이면 기본 2건 (0건으로 깎이지 않는다)", async () => {
    const handler = await freshHandler("abc")
    const ids = recordBodyRequests()
    await handler(listClient(), { query: "퇴직금 중간정산" })
    expect(ids).toHaveLength(2)
  })

  it("모듈 로드 시점에 굳지 않는다 — import 뒤에 바꾼 환경값도 그 호출에 반영된다", async () => {
    const handler = await freshHandler("3")
    const ids = recordBodyRequests()
    // 로드 시점 값은 3이지만 호출 직전에 0으로 바꾼다
    process.env.FIN_NTS_BODY_TOP_N = "0"
    const r = await handler(listClient(), { query: "퇴직금 중간정산" })
    expect(ids).toHaveLength(0)
    expect(r.content[0].text).toContain("본문 미동봉")
  })
})

describe("fin_nts_ruling — description은 절단을 감추지 않는다", () => {
  it("'본문 전문'이 아니라 상한과 절단 고지를 밝힌다", () => {
    const d = FIN_NTS_RULING_TOOL.description
    expect(d).not.toContain("본문 전문")
    expect(d).toContain("절단 고지")
  })

  it("description의 상한 수치가 실제 예산(BUDGET_BODY)과 같다", () => {
    // 6000 → "6,000" — 한쪽만 바뀌면 description이 거짓이 된다
    expect(FIN_NTS_RULING_TOOL.description).toContain(`${BUDGET_BODY.toLocaleString("en-US")}자`)
  })
})
