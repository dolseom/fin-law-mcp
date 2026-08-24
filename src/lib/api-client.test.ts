/**
 * JSON 루트 키 가드 회귀 테스트 (fixture 기반 — CI 상시)
 *
 * Opus B-1: 법제처는 조회 조건이 안 맞으면 200 + **루트 키가 다른 짧은 JSON**을 준다
 * (실측: efYd 불일치 시 42바이트 `{"Law":{...}}`). 빈 본문도 HTML도 아니라서 기존
 * 가드를 전부 통과하고, `?.법령`이 undefined가 되어 "조문 없음(✗)"으로 위장됐다.
 */

import { describe, it, expect, afterEach } from "vitest"
import { LawApiClient } from "./api-client.js"

const origFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = origFetch
})

function stubBody(body: string) {
  globalThis.fetch = (async () =>
    new Response(body, { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch
}

const client = () => new LawApiClient({ apiKey: "dummy" })
const call = (expectedJsonKey?: string) =>
  client().fetchApi({
    endpoint: "lawService.do",
    target: "eflaw",
    type: "JSON",
    extraParams: { MST: "280349", JO: "002600" },
    ...(expectedJsonKey ? { expectedJsonKey } : {}),
  })

describe("fetchApi — JSON 루트 키 가드", () => {
  it("기대 키가 없으면 throw한다 (0건 위장 차단)", async () => {
    stubBody(JSON.stringify({ Law: { 조문: null } })) // 실측된 42바이트 응답 형태
    await expect(call("법령")).rejects.toThrow(/예상 밖 응답/)
  })

  it("오류 메시지가 '0건이 아님'을 명시한다", async () => {
    stubBody(JSON.stringify({ Law: {} }))
    await expect(call("법령")).rejects.toThrow(/확인 실패/)
  })

  it("기대 키가 있으면 정상 통과한다", async () => {
    stubBody(JSON.stringify({ 법령: { 조문: { 조문단위: [] } } }))
    await expect(call("법령")).resolves.toContain("법령")
  })

  it("JSON 파싱 실패도 '0건'이 아니라 확인 실패로 처리한다", async () => {
    stubBody("{ not json")
    await expect(call("법령")).rejects.toThrow(/파싱/)
  })

  it("expectedJsonKey를 안 주면 종전대로 통과한다 (기존 호출부 호환)", async () => {
    stubBody(JSON.stringify({ Law: {} }))
    await expect(call()).resolves.toBeTruthy()
  })
})
