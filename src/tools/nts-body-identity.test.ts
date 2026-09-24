/**
 * 국세청 예규 본문 — 반환 문서 식별자 대조 (외부 검토 B4 같은 모양 — v01-sameshape, fixture)
 *
 * 응답 dcmDVO에 ntstDcmId가 있으면 요청값과 대조한다. 필드가 없으면(실응답 형태 미확인) 대조를 건너뛴다.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }))
vi.mock("../lib/fetch-with-retry.js", () => ({ fetchWithRetry: fetchMock }))
vi.mock("../lib/external-https-proxy.js", () => ({
  getExternalHttpsProxyConfig: () => null,
  requestExternalHttps: vi.fn(),
}))

import { getNtsDecisionBody } from "./nts-body.js"

const GOOD_ID = "010000000000515153"
const BODY = "중간정산일 현재 1년 이상 주택을 소유하지 아니한 세대의 세대주인 임원 관련 회신 본문입니다."

function mockDcm(dcm: Record<string, unknown>) {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ data: { ASIQTB002PR01: { dcmDVO: { ntstDcmTtl: "제목", ntstDcmDscmCntn: "법인세과-352", ntstDcmCntn: `<p>${BODY}</p>`, ...dcm } } } }),
  })
}

describe("getNtsDecisionBody — 반환 식별자 대조", () => {
  beforeEach(() => fetchMock.mockReset())

  it("응답 ntstDcmId가 요청과 다르면 본문을 싣지 않고 '본문 확인 불가(식별자 불일치)' + isError", async () => {
    mockDcm({ ntstDcmId: "010000000000999999" })
    const r = await getNtsDecisionBody(null as any, { id: GOOD_ID })
    expect(r.isError).toBe(true)
    const text = r.content[0].text
    expect(text).toContain("본문 확인 불가(식별자 불일치)")
    expect(text).toContain("010000000000999999")
    expect(text).not.toContain("주택을 소유하지 아니한")
    expect(text).toContain(`ntstDcmId=${GOOD_ID}`) // 원문 링크 안내
  })

  it("[반대] 같은 ntstDcmId(앞자리 0 생략 포함)면 정상 본문", async () => {
    for (const same of [GOOD_ID, "10000000000515153"]) {
      mockDcm({ ntstDcmId: same })
      const r = await getNtsDecisionBody(null as any, { id: GOOD_ID })
      expect(r.isError).toBeFalsy()
      expect(r.content[0].text).toContain("주택을 소유하지 아니한")
    }
  })

  it("[반대] 응답에 ntstDcmId가 없으면 대조하지 않고 종전대로 본문", async () => {
    mockDcm({})
    const r = await getNtsDecisionBody(null as any, { id: GOOD_ID })
    expect(r.isError).toBeFalsy()
    expect(r.content[0].text).toContain("주택을 소유하지 아니한")
  })
})
