/**
 * fin_nts_ruling 본문 머리줄 — 절단 표기·식별자 불일치 사유 (외부 검토 B3·B4 같은 모양 — v01-sameshape)
 */
import { describe, it, expect, vi, afterEach } from "vitest"

const { bodyMock } = vi.hoisted(() => ({ bodyMock: vi.fn() }))
vi.mock("./nts-body.js", async (orig) => ({ ...(await orig<typeof import("./nts-body.js")>()), getNtsDecisionBody: bodyMock }))

import { handleFinNtsRuling, BUDGET_BODY } from "./nts-ruling.js"
import type { LawApiClient } from "../lib/api-client.js"

const origEnabled = process.env.FIN_NTS_BODY_ENABLED
afterEach(() => {
  bodyMock.mockReset()
  if (origEnabled === undefined) delete process.env.FIN_NTS_BODY_ENABLED
  else process.env.FIN_NTS_BODY_ENABLED = origEnabled
})

const XML =
  `<?xml version="1.0" encoding="UTF-8"?><CgmExpc><totalCnt>1</totalCnt>` +
  `<cgmExpc id="1"><안건명><![CDATA[퇴직금 중간정산]]></안건명><안건번호>서면-1</안건번호><해석일자>2024.01.01</해석일자>` +
  `<법령해석상세링크>https://taxlaw.nts.go.kr/qt/USEQTA002P.do?ntstDcmId=010000000000000001</법령해석상세링크></cgmExpc></CgmExpc>`
const client = { fetchApi: async () => XML } as unknown as LawApiClient

describe("fin_nts_ruling — 본문 머리줄", () => {
  it("본문이 예산을 넘으면 '━━━ 본문' 머리줄에 '⚠본문 일부 절단(n자 중 m자)'", async () => {
    process.env.FIN_NTS_BODY_ENABLED = "true"
    const long = Array.from({ length: 600 }, (_, i) => `${i + 1}. 회신 문장입니다.`).join("\n")
    expect(long.length).toBeGreaterThan(BUDGET_BODY)
    bodyMock.mockResolvedValue({ content: [{ type: "text", text: long }] })
    const r = await handleFinNtsRuling(client, { query: "퇴직금 중간정산", top_n_bodies: 1 })
    const header = r.content[0].text.split("\n").find((l) => l.startsWith("━━━ 본문"))!
    expect(header).toMatch(new RegExp(`⚠본문 일부 절단\\(${long.length}자 중 \\d+자\\)$`))
    const m = Number(header.match(/중 (\d+)자\)/)![1])
    expect(m).toBeLessThanOrEqual(BUDGET_BODY)
    expect(r.content[0].text).toContain(long.slice(0, m))
  })

  it("[반대] 예산 안이면 절단 표기 없음", async () => {
    process.env.FIN_NTS_BODY_ENABLED = "true"
    bodyMock.mockResolvedValue({ content: [{ type: "text", text: "짧은 회신 본문" }] })
    const r = await handleFinNtsRuling(client, { query: "퇴직금 중간정산", top_n_bodies: 1 })
    expect(r.content[0].text).toContain("━━━ 본문: 서면-1 (2024.01.01) ━━━\n짧은 회신 본문")
    expect(r.content[0].text).not.toContain("절단")
  })

  it("식별자 불일치는 '조회 실패'가 아니라 '본문 확인 불가(식별자 불일치)'로 적고 본문을 싣지 않는다", async () => {
    process.env.FIN_NTS_BODY_ENABLED = "true"
    bodyMock.mockResolvedValue({
      content: [{ type: "text", text: "[ID_MISMATCH] 본문 확인 불가(식별자 불일치) — 요청 ntstDcmId 010000000000000001에 다른 문서(0100000000009)가 돌아와 본문을 싣지 않습니다." }],
      isError: true,
    })
    const r = await handleFinNtsRuling(client, { query: "퇴직금 중간정산", top_n_bodies: 1 })
    const text = r.content[0].text
    expect(text).toContain("⚠ 본문 확인 불가(식별자 불일치) — 다른 문서의 본문이 와서 싣지 않았습니다.")
    expect(text).not.toContain("⚠ 본문 조회 실패")
  })
})
