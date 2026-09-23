/**
 * abolished-laws 회귀 테스트 (fixture — CI 상시)
 */

import { describe, it, expect } from "vitest"
import { findAbolishedLaws, detectAbolishedAdminRule } from "./abolished-laws.js"
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

/**
 * 폐지사유 본문 조회의 deadline 전파 (R2 — R1 감사 지적).
 *
 * detectAbolishedAdminRule은 연혁 **검색**에만 signal을 걸고 폐지사유 **본문**(수백 KB)
 * 조회에는 걸지 않았다 — 상한이 지난 뒤에도 본문 조회가 살아 쿼터를 쓴다.
 * 함께 박제하는 반대 사례: 정상 본문에서 폐지사유·후속 규정이 그대로 파싱되는 것,
 * 그리고 본문 조회 실패가 "후속 규정 없음"(확인된 사실)으로 둔갑하지 않는 것.
 */
describe("detectAbolishedAdminRule — 폐지사유 본문 조회의 signal 전파", () => {
  const RULE = "월별납부제도 운영에 관한 고시"
  const SUCCESSOR = "징수업무 처리에 관한 고시"
  const ABOLISHED_SEQ = "2100000200002"
  const PREV_SEQ = "2100000200001"

  const admrul = (seq: string, promDate: string, revisionType: string) =>
    `<admrul><행정규칙명>${RULE}</행정규칙명><행정규칙일련번호>${seq}</행정규칙일련번호>` +
    `<행정규칙ID>15001</행정규칙ID><발령일자>${promDate}</발령일자><제개정구분명>${revisionType}</제개정구분명>` +
    `<현행연혁구분>연혁</현행연혁구분><행정규칙종류>고시</행정규칙종류><소관부처명>국세청</소관부처명></admrul>`

  // 발령일자 오름차순 정렬 전 순서로 둔다 — 정렬 없이 마지막 항목을 폐지 레코드로 쓰면 어긋난다
  const HISTORY_XML =
    '<?xml version="1.0"?><AdmRulSearch><totalCnt>2</totalCnt>' +
    admrul(ABOLISHED_SEQ, "20241211", "폐지") +
    admrul(PREV_SEQ, "20221201", "일부개정") +
    "</AdmRulSearch>"

  const REASON_BODY =
    '<?xml version="1.0"?><AdmRulService><제개정이유>' +
    `<![CDATA[「${RULE}」를 「${SUCCESSOR}」로 통ㆍ폐합하여 폐지함]]>` +
    "</제개정이유></AdmRulService>"

  interface BodyCall {
    id: string
    signal?: AbortSignal
  }

  /** 지연 본문 stub — 받은 signal을 실제로 관찰하고 abort되면 그 자리에서 끝난다 */
  function delayedClient(calls: BodyCall[], delayMs: number, state: { resolved: boolean }) {
    return {
      searchAdminRule: async (_p: { query: string; nw?: string; signal?: AbortSignal }) => HISTORY_XML,
      getAdminRule: (id: string, _apiKey?: string, signal?: AbortSignal) => {
        calls.push({ id, signal })
        return new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => {
            state.resolved = true
            resolve(REASON_BODY)
          }, delayMs)
          signal?.addEventListener("abort", () => {
            clearTimeout(timer)
            reject(new Error("요청 취소됨(도구 deadline) — 폐지사유 본문 조회 중단"))
          })
        })
      },
    } as unknown as LawApiClient
  }

  it("abort하면 본문 조회가 그 자리에서 끝난다 — 폐지 사실은 남고 후속 규정은 '없음'이 아니다", async () => {
    const calls: BodyCall[] = []
    const state = { resolved: false }
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 5)
    const note = await detectAbolishedAdminRule(
      delayedClient(calls, 3_000, state),
      `${RULE} R2-abort`,
      undefined,
      controller.signal
    )
    // 받은 signal 그대로가 본문 조회에 전달됐는가 (전달 안 되면 3초 뒤 resolved=true로 드러난다)
    expect(calls).toHaveLength(1)
    expect(calls[0].id).toBe(ABOLISHED_SEQ)
    expect(calls[0].signal).toBe(controller.signal)
    expect(state.resolved).toBe(false)
    // 폐지 자체는 검색으로 확인된 사실이라 안내문은 유지된다
    expect(note).toContain("폐지된 행정규칙입니다")
    expect(note).toContain(`행정규칙일련번호 ${PREV_SEQ}`)
    // 이 서버에 없는 upstream 도구명으로 안내하지 않는다
    expect(note).not.toMatch(/get_admin_rule|search_admin_rule/)
    // 조회 실패를 "후속 규정 없음"으로 쓰지 않는다 (3값 판정)
    expect(note).toContain("폐지사유 본문 조회에 **실패**")
    expect(note).toContain("후속 규정이 없다는 뜻이 아닙니다")
    expect(note).not.toContain("후속 규정 자동 추출 실패")
    expect(note).not.toContain(SUCCESSOR)
  }, 10_000)

  it("[반대] 정상 본문이면 폐지사유·후속 규정을 그대로 싣는다 (signal은 전달만 하고 판정을 바꾸지 않는다)", async () => {
    const calls: BodyCall[] = []
    const state = { resolved: false }
    const controller = new AbortController()
    const note = await detectAbolishedAdminRule(
      delayedClient(calls, 0, state),
      `${RULE} R2-ok`,
      undefined,
      controller.signal
    )
    expect(calls[0].signal).toBe(controller.signal)
    expect(state.resolved).toBe(true)
    expect(note).toContain("폐지사유(제개정이유)")
    expect(note).toContain(`후속(통합) 규정: 「${SUCCESSOR}」`)
    expect(note).not.toContain("폐지사유 본문 조회에 **실패**")
  })

  it("[반대] signal 없이 불러도 종전대로 동작한다 (본문 조회에 undefined가 간다)", async () => {
    const calls: BodyCall[] = []
    const state = { resolved: false }
    const note = await detectAbolishedAdminRule(delayedClient(calls, 0, state), `${RULE} R2-nosignal`)
    expect(calls[0].signal).toBeUndefined()
    expect(note).toContain(`후속(통합) 규정: 「${SUCCESSOR}」`)
  })
})
