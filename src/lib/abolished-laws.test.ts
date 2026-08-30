/**
 * abolished-laws 회귀 테스트 (fixture — CI 상시)
 */

import { describe, it, expect } from "vitest"
import { findAbolishedLaws } from "./abolished-laws.js"
import type { LawApiClient } from "./api-client.js"

describe("findAbolishedLaws — 괄호 붙은 법령명 (Codex 4차 개선)", () => {
  it("연혁 조회는 괄호를 뗀 이름으로 나간다 (붙인 채면 eflaw도 항상 0건)", async () => {
    let requested = ""
    const client = {
      searchLaw: async (q: string) => {
        requested = q
        return '<?xml version="1.0"?><LawSearch><totalCnt>0</totalCnt></LawSearch>'
      },
    } as unknown as LawApiClient
    await findAbolishedLaws(client, "택지소유상한에 관한 법률(1998. 9. 19. 폐지)")
    expect(requested).toBe("택지소유상한에 관한 법률")
  })
})
