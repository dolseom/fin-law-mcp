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
    let seen: Record<string, string> = {}
    await resolveVersionAt(stub(SLICES_XML, (p) => (seen = p)), "법인세법", "20200101")
    expect(seen.efYd).toContain("~")
    expect(seen.efYd).toBe("19000101~20200101")
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
