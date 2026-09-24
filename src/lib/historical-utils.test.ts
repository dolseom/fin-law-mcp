/**
 * resolveVersionAt 회귀 테스트 (fixture 기반 — CI 상시)
 *
 * 배경 (실측 2026-08-25): 법제처 검색 API는 **단일 efYd를 조용히 무시**하고
 * 범위 문법만 필터로 동작하며, 조회 API는 **현행 MST + 과거 efYd에 빈 응답**을 준다.
 * 그래서 "기준일을 그대로 efYd로 넘기는" 방식은 동작하지 않는다 —
 * 기준일 시점 시행본의 MST를 먼저 확보해야 한다.
 */

import { describe, it, expect } from "vitest"
import { resolveVersionAt, parseEffectiveSlices } from "./historical-utils.js"
import type { LawApiClient } from "./api-client.js"

const SLICES_XML = `<?xml version="1.0" encoding="UTF-8"?>
<LawSearch>
  <law id="1">
    <법령명한글>법인세법</법령명한글><법령일련번호>212775</법령일련번호>
    <시행일자>20200101</시행일자><공포일자>20191231</공포일자><공포번호>16833</공포번호><제개정구분명>일부개정</제개정구분명>
  </law>
  <law id="2">
    <법령명한글>법인세법</법령명한글><법령일련번호>165308</법령일련번호>
    <시행일자>20150701</시행일자><공포일자>20141223</공포일자><공포번호>12850</공포번호><제개정구분명>일부개정</제개정구분명>
  </law>
  <law id="3">
    <법령명한글>법인세법 시행령</법령명한글><법령일련번호>999999</법령일련번호>
    <시행일자>20200101</시행일자><공포일자>20191231</공포일자><공포번호>30256</공포번호><제개정구분명>일부개정</제개정구분명>
  </law>
</LawSearch>`

const EMPTY_XML = `<?xml version="1.0" encoding="UTF-8"?><LawSearch><totalCnt>0</totalCnt></LawSearch>`

function stub(xml: string, capture?: (params: Record<string, string>) => void): LawApiClient {
  return {
    fetchApi: async (p: { extraParams?: Record<string, string> }) => {
      capture?.(p.extraParams ?? {})
      return xml
    },
  } as unknown as LawApiClient
}

describe("parseEffectiveSlices", () => {
  it("대상 법령만 골라 시행일 내림차순으로 정렬한다", () => {
    const slices = parseEffectiveSlices(SLICES_XML, "법인세법")
    expect(slices.map((s) => s.efYd)).toEqual(["20200101", "20150701"]) // 시행령은 제외
    expect(slices[0].mst).toBe("212775")
  })
})

describe("resolveVersionAt", () => {
  it("범위 문법(from~to)으로 조회한다 — 단일 efYd는 법제처가 무시하므로", async () => {
    const seen: Record<string, string>[] = []
    await resolveVersionAt(stub(SLICES_XML, (p) => seen.push(p)), "법인세법", "20200101")
    expect(seen.every((p) => p.efYd.includes("~"))).toBe(true)
    // 먼저 전년 1월 1일~기준일 좁은 구간 — 대상이 있으면 그 1회로 끝난다
    expect(seen.map((p) => p.efYd)).toEqual(["20190101~20200101"])
  })

  it("기준일 이하 최신 시행본을 고른다", async () => {
    const { slice } = await resolveVersionAt(stub(SLICES_XML), "법인세법", "20200101")
    expect(slice?.efYd).toBe("20200101")
    expect(slice?.mst).toBe("212775")
  })

  it("기준일이 중간이면 직전 개정본을 고른다", async () => {
    const { slice } = await resolveVersionAt(stub(SLICES_XML), "법인세법", "20180315")
    expect(slice?.efYd).toBe("20150701") // 20200101은 기준일 이후라 제외
  })

  it("기준일 이전 이력이 없으면 사유와 함께 미해소로 돌려준다 (조용한 실패 금지)", async () => {
    const { slice, reason } = await resolveVersionAt(stub(EMPTY_XML), "법인세법", "19000101")
    expect(slice).toBeUndefined()
    expect(reason).toBeTruthy()
    expect(reason).toContain("찾지 못함")
  })

  it("조회 실패는 '없음'이 아니라 사유로 보고한다", async () => {
    const failing = {
      fetchApi: async () => {
        throw new Error("법제처 API가 빈 응답을 반환했습니다")
      },
    } as unknown as LawApiClient
    const { slice, reason } = await resolveVersionAt(failing, "법인세법", "20200101")
    expect(slice).toBeUndefined()
    expect(reason).toContain("조회 실패")
  })
})

/**
 * 전체 수신 계약 (외부 검토 B5) — 종전 resolveVersionAt은 display=100 한 페이지만 받아
 * 그 안에서 최신본을 확정했다. 총 101건 중 1920~2019년 100건만 오면 101번째 최신본을
 * 모른 채 2019년 구본을 확정했다.
 */
function lawBlock(efYd: string, mst: string, lawNm = "법인세법"): string {
  return (
    `<law id="${mst}"><법령명한글>${lawNm}</법령명한글><법령일련번호>${mst}</법령일련번호>` +
    `<시행일자>${efYd}</시행일자><공포일자>${efYd}</공포일자><공포번호>${mst}</공포번호><제개정구분명>일부개정</제개정구분명></law>`
  )
}
function searchXml(blocks: string[], totalCnt?: string): string {
  const total = totalCnt === undefined ? "" : `<totalCnt>${totalCnt}</totalCnt>`
  return `<?xml version="1.0" encoding="UTF-8"?><LawSearch><target>eflaw</target>${total}<page>1</page>${blocks.join("")}</LawSearch>`
}
/** 1920~2019년 100건 (연 1건) */
const OLD_100 = Array.from({ length: 100 }, (_, i) => lawBlock(`${1920 + i}0101`, String(100 + i)))
const NEWEST = lawBlock("20260101", "9001")
const BASIS = "20260924"
const NARROW = "20250101~20260924" // 전년 1월 1일~기준일
const WHOLE = "19000101~20260924"
const FIVE = "20210101~20260924" // 5년 전 1월 1일~기준일

/**
 * 구간(efYd)·페이지별로 다른 응답을 돌려주는 스텁 — 요청을 "구간#페이지"로 기록한다.
 * 표에 없는 요청은 throw (예상 밖 요청이 조용히 통과하지 않도록)
 */
function rangeStub(table: Record<string, string>, calls: string[], seen?: Record<string, string>[]): LawApiClient {
  return {
    fetchApi: async (p: { extraParams?: Record<string, string> }) => {
      const params = p.extraParams ?? {}
      seen?.push(params)
      const key = `${params.efYd}#${params.page ?? "1"}`
      calls.push(key)
      const xml = table[key]
      if (xml === undefined) throw new Error(`예상 밖 요청: ${key}`)
      return xml
    },
  } as unknown as LawApiClient
}
/** 좁은 구간에 대상 법령이 없는 응답 (다른 법령 행만) */
const NARROW_NO_TARGET = searchXml([lawBlock("20260101", "5", "법인세법 시행령")], "1")

describe("resolveVersionAt — 전체 수신 입증 (B5)", () => {
  it("좁은 구간에 대상이 있으면 요청 1회로 확정 — page 파라미터 없음", async () => {
    const calls: string[] = []
    const seen: Record<string, string>[] = []
    const table = { [`${NARROW}#1`]: searchXml([lawBlock("20250101", "8001"), NEWEST], "2") }
    const { slice } = await resolveVersionAt(rangeStub(table, calls, seen), "법인세법", BASIS)
    expect(calls).toEqual([`${NARROW}#1`])
    expect(seen[0]).toEqual({ query: "법인세법", display: "100", efYd: NARROW })
    expect(slice?.mst).toBe("9001")
  })

  it("오래 개정 없는 작은 법령은 요청 2회 — 좁은 구간 0건 → 전 구간 1페이지(종전과 같은 파라미터·결과)", async () => {
    const calls: string[] = []
    const seen: Record<string, string>[] = []
    const table = {
      [`${NARROW}#1`]: searchXml([], "0"),
      [`${WHOLE}#1`]: searchXml([lawBlock("20150701", "165308"), lawBlock("20200101", "212775")], "2"),
    }
    const { slice } = await resolveVersionAt(rangeStub(table, calls, seen), "법인세법", BASIS)
    expect(calls).toEqual([`${NARROW}#1`, `${WHOLE}#1`])
    expect(seen[1]).toEqual({ query: "법인세법", display: "100", efYd: WHOLE })
    expect(slice?.mst).toBe("212775")
  })

  it("총 101건 중 1페이지 100건(1920~2019)만 오면 2페이지를 받아 최신본을 고른다", async () => {
    const calls: string[] = []
    const table = {
      [`${NARROW}#1`]: NARROW_NO_TARGET,
      [`${WHOLE}#1`]: searchXml(OLD_100, "101"),
      [`${WHOLE}#2`]: searchXml([NEWEST], "101"),
    }
    const { slice, reason } = await resolveVersionAt(rangeStub(table, calls), "법인세법", BASIS)
    expect(calls).toEqual([`${NARROW}#1`, `${WHOLE}#1`, `${WHOLE}#2`])
    expect(reason).toBeUndefined()
    expect(slice?.efYd).toBe("20260101")
    expect(slice?.mst).toBe("9001")
  })

  it("2페이지를 못 받으면 구본을 확정하지 않고 조회 실패 사유를 돌려준다", async () => {
    const calls: string[] = []
    const table = { [`${NARROW}#1`]: NARROW_NO_TARGET, [`${WHOLE}#1`]: searchXml(OLD_100, "101") }
    const { slice, reason } = await resolveVersionAt(rangeStub(table, calls), "법인세법", BASIS)
    expect(slice).toBeUndefined()
    expect(reason).toContain("조회 실패")
  })

  it("총건수가 남았는데 다음 페이지가 비면 5년 구간으로, 거기에도 대상이 없으면 확정 불가", async () => {
    const calls: string[] = []
    const table = {
      [`${NARROW}#1`]: NARROW_NO_TARGET,
      [`${WHOLE}#1`]: searchXml(OLD_100, "101"),
      [`${WHOLE}#2`]: searchXml([], "101"),
      [`${FIVE}#1`]: NARROW_NO_TARGET,
    }
    const { slice, reason } = await resolveVersionAt(rangeStub(table, calls), "법인세법", BASIS)
    expect(calls).toEqual([`${NARROW}#1`, `${WHOLE}#1`, `${WHOLE}#2`, `${FIVE}#1`])
    expect(slice).toBeUndefined()
    expect(reason).toContain("확정 불가")
    expect(reason).toContain("101")
  })

  it("totalCnt가 없는데 100건이 꽉 차면 확정 불가 (다음 페이지 유무를 모른다)", async () => {
    const calls: string[] = []
    // 어느 구간이든 같은 꽉 찬 응답 — 좁은 구간부터 끝을 입증하지 못한다
    const client = {
      fetchApi: async (p: { extraParams?: Record<string, string> }) => {
        calls.push(p.extraParams?.efYd ?? "")
        return searchXml(OLD_100)
      },
    } as unknown as LawApiClient
    const { slice, reason } = await resolveVersionAt(client, "법인세법", BASIS)
    // 좁은 구간 불완전 → 전 구간(역시 불완전) → 좁은 구간을 못 받았으니 5년 구간은 생략
    expect(calls).toEqual([NARROW, WHOLE])
    expect(slice).toBeUndefined()
    expect(reason).toContain("확정 불가")
  })

  it("totalCnt가 숫자가 아니거나 받은 수보다 작은데 100건이 꽉 차면 확정 불가", async () => {
    for (const bad of ["abc", "", "50"]) {
      const client = {
        fetchApi: async () => searchXml(OLD_100, bad),
      } as unknown as LawApiClient
      const { slice, reason } = await resolveVersionAt(client, "법인세법", BASIS)
      expect(slice, `totalCnt=${bad}`).toBeUndefined()
      expect(reason).toContain("확정 불가")
    }
  })

  it("전 구간이 예산(6회)으로 못 받을 만큼 크고 5년 구간도 못 받으면 확정 불가 — 헛요청 없이", async () => {
    const calls: string[] = []
    const table = {
      [`${NARROW}#1`]: NARROW_NO_TARGET,
      [`${WHOLE}#1`]: searchXml(OLD_100, "900"),
      [`${FIVE}#1`]: searchXml(OLD_100, "600"),
    }
    const { slice, reason } = await resolveVersionAt(rangeStub(table, calls), "법인세법", BASIS)
    // 좁은 구간 1 + 전 구간 1(900건은 남은 4회로 불가) + 5년 구간 1(600건은 남은 3회로 불가) → 중단
    expect(calls).toEqual([`${NARROW}#1`, `${WHOLE}#1`, `${FIVE}#1`])
    expect(slice).toBeUndefined()
    expect(reason).toContain("확정 불가")
  })

  it("요청 예산은 구간 합계 6회 — 전 구간 350건이면 4페이지까지 받아 마지막 페이지의 최신본을 고른다", async () => {
    const calls: string[] = []
    const table: Record<string, string> = { [`${NARROW}#1`]: NARROW_NO_TARGET }
    for (let p = 1; p <= 3; p++) table[`${WHOLE}#${p}`] = searchXml(OLD_100, "350")
    table[`${WHOLE}#4`] = searchXml([...OLD_100.slice(0, 49), NEWEST], "350")
    const { slice } = await resolveVersionAt(rangeStub(table, calls), "법인세법", BASIS)
    expect(calls).toEqual([`${NARROW}#1`, `${WHOLE}#1`, `${WHOLE}#2`, `${WHOLE}#3`, `${WHOLE}#4`])
    expect(slice?.mst).toBe("9001")
  })

  it("좁은 구간이 꽉 차 불완전하면 전 구간으로 넘어간다", async () => {
    const calls: string[] = []
    const table = {
      [`${NARROW}#1`]: searchXml(OLD_100), // totalCnt 없음 + 꽉 참 → 불완전
      [`${WHOLE}#1`]: searchXml([lawBlock("20240101", "8300"), lawBlock("20100101", "8100")], "2"),
    }
    const { slice } = await resolveVersionAt(rangeStub(table, calls), "법인세법", BASIS)
    expect(calls).toEqual([`${NARROW}#1`, `${WHOLE}#1`])
    expect(slice?.mst).toBe("8300")
  })

  it("좁은 구간에 대상이 없고 전 구간이 수백 건이면 5년 구간을 전부 받아 확정한다", async () => {
    const calls: string[] = []
    const table = {
      [`${NARROW}#1`]: NARROW_NO_TARGET,
      [`${WHOLE}#1`]: searchXml(OLD_100, "900"),
      // 5년 구간: 시행령 행이 섞이고 순서가 뒤집혀 있다
      [`${FIVE}#1`]: searchXml(
        [lawBlock("20220101", "8100"), lawBlock("20240101", "5", "법인세법 시행령"), lawBlock("20230101", "8200")],
        "3"
      ),
    }
    const { slice, reason } = await resolveVersionAt(rangeStub(table, calls), "법인세법", BASIS)
    expect(reason).toBeUndefined()
    expect(calls).toEqual([`${NARROW}#1`, `${WHOLE}#1`, `${FIVE}#1`])
    expect(slice?.mst).toBe("8200")
  })

  it("다중 시행일·역순·정렬 무시 응답에서도 기준일 이하 최대 시행일을 고른다 (페이지 경계를 넘어도)", async () => {
    const calls: string[] = []
    // 1페이지: 기준일 이후 1건 + 뒤섞인 순서 98건 + 다른 법령 1건 = 100
    const shuffled = [...OLD_100.slice(0, 98)].reverse()
    const page1 = [
      lawBlock("20300101", "7777"), // 기준일 이후 — 제외
      ...shuffled.slice(0, 50),
      lawBlock("20240101", "5555", "법인세법 시행령"), // 다른 법령 — 제외
      ...shuffled.slice(50),
    ]
    // 2페이지: 역순(오래된 것 먼저) + 기준일 이하 최대 시행일이 가운데
    const page2 = [lawBlock("19100101", "1"), lawBlock("20250701", "8888"), lawBlock("20250101", "8887")]
    expect(page1.length).toBe(100)
    const table = {
      [`${NARROW}#1`]: searchXml(OLD_100), // 불완전 → 전 구간으로
      [`${WHOLE}#1`]: searchXml(page1, "103"),
      [`${WHOLE}#2`]: searchXml(page2, "103"),
    }
    const { slice } = await resolveVersionAt(rangeStub(table, calls), "법인세법", BASIS)
    expect(calls).toEqual([`${NARROW}#1`, `${WHOLE}#1`, `${WHOLE}#2`])
    expect(slice?.efYd).toBe("20250701")
    expect(slice?.mst).toBe("8888")
  })

  it("좁은 구간 응답도 정렬을 믿지 않는다 — 역순이어도 기준일 이하 최대 시행일", async () => {
    const calls: string[] = []
    const table = {
      [`${NARROW}#1`]: searchXml(
        [lawBlock("20250101", "1"), lawBlock("20260701", "3"), lawBlock("20270101", "4"), lawBlock("20250701", "2")],
        "4"
      ),
    }
    const { slice } = await resolveVersionAt(rangeStub(table, calls), "법인세법", BASIS)
    expect(calls.length).toBe(1)
    expect(slice?.mst).toBe("3") // 20270101은 기준일 이후
  })

  it("정확히 100건 + totalCnt 100이면 추가 페이지 없이 확정", async () => {
    const calls: string[] = []
    const table = { [`${NARROW}#1`]: NARROW_NO_TARGET, [`${WHOLE}#1`]: searchXml(OLD_100, "100") }
    const { slice } = await resolveVersionAt(rangeStub(table, calls), "법인세법", BASIS)
    expect(calls).toEqual([`${NARROW}#1`, `${WHOLE}#1`])
    expect(slice?.efYd).toBe("20190101")
  })

  it("오류 루트(루트가 다른 정상 형식 XML)는 종전과 같은 '찾지 못함' 실패", async () => {
    const calls: string[] = []
    const ERR = `<?xml version="1.0" encoding="UTF-8"?><Error><msg>검색 오류</msg></Error>`
    const table = { [`${NARROW}#1`]: ERR, [`${WHOLE}#1`]: ERR }
    const { slice, reason } = await resolveVersionAt(rangeStub(table, calls), "법인세법", BASIS)
    expect(calls).toEqual([`${NARROW}#1`, `${WHOLE}#1`])
    expect(slice).toBeUndefined()
    expect(reason).toContain("찾지 못함")
  })

  it("취소(abort)로 2페이지가 실패하면 조회 실패 사유 — 1페이지 구본으로 떨어지지 않는다", async () => {
    let n = 0
    const client = {
      fetchApi: async () => {
        n++
        if (n === 1) return NARROW_NO_TARGET
        if (n === 2) return searchXml(OLD_100, "101")
        throw new Error("요청이 취소되었습니다")
      },
    } as unknown as LawApiClient
    const { slice, reason } = await resolveVersionAt(client, "법인세법", BASIS)
    expect(slice).toBeUndefined()
    expect(reason).toContain("조회 실패")
  })

  it("좁은 구간 조회가 실패(취소)하면 곧바로 조회 실패 — 전 구간을 더 부르지 않는다", async () => {
    let n = 0
    const client = {
      fetchApi: async () => {
        n++
        throw new Error("요청이 취소되었습니다")
      },
    } as unknown as LawApiClient
    const { slice, reason } = await resolveVersionAt(client, "법인세법", BASIS)
    expect(n).toBe(1)
    expect(slice).toBeUndefined()
    expect(reason).toContain("조회 실패")
  })
})
