/**
 * fin_ping 실조회 진단 계약 — 빌드된 서버를 실제 stdio로 띄워 확인한다.
 *
 * 키가 "설정됨"이라는 말은 진단이 아니다 — 오타 난 키도 설정은 되어 있다.
 * fin_ping은 법제처를 한 번 두드려 성공/실패를 가르고, 실패면 다음 조치까지 준다.
 *
 * 실 API는 부르지 않는다. 아래 PRELOAD_SRC를 임시 폴더에 쓴 뒤 `node --import`로
 * 서버 **본체보다 먼저** 실어 globalThis.fetch를 fixture로 바꾼다. 프리로드가 아니라
 * 테스트 안에서 바꾸면 서버가 별도 프로세스라 닿지 않는다.
 *
 * ⚠ build/를 띄우므로 CI는 build → test 순서여야 한다 (tools-list.test.ts와 같은 전제).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { spawn } from "node:child_process"
import path from "node:path"
import os from "node:os"
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const serverEntry = path.join(repoRoot, "build", "index.js")
// build/가 없으면(클린 checkout에서 build 전) skip — 실패로 위장하지 않는다
const hasBuild = existsSync(serverEntry)

/**
 * 서버 프로세스에 먼저 실리는 프리로드. 저장소에 파일로 두지 않고 임시 폴더에 쓴다
 * (어디서도 import되지 않아 dead-file 게이트에 걸린다).
 *
 * 키 누락(missing)은 process.env.LAW_OC를 **빈 문자열로 존재시켜** 만든다 —
 * delete 하면 build/bootstrap.js의 dotenv가 저장소 .env에서 도로 채워 넣는다
 * (dotenv는 hasOwnProperty로만 판단하므로 빈 문자열이면 덮어쓰지 않는다).
 */
const PRELOAD_SRC = `
const MODE = process.env.FIN_PING_TEST_MODE || "success"
process.env.LAW_OC = MODE === "missing" ? "" : "fixture-key"

const SUCCESS_XML =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  "<LawSearch><target>law</target><totalCnt>3</totalCnt><page>1</page>" +
  '<law id="001766"><법령일련번호>248130</법령일련번호><법령명한글>법인세법</법령명한글>' +
  "<시행일자>20260101</시행일자></law></LawSearch>"

// 200 + HTML 점검 페이지 — 법제처 장애·차단의 실제 형태
const HTML_ERROR = "<!DOCTYPE html><html><head><title>시스템 점검</title></head><body>점검 중입니다</body></html>"

// 정상 루트인데 법인세법 검색이 0건 — 통신은 됐지만 정상 응답이 아니다
const ZERO_XML = '<?xml version="1.0" encoding="UTF-8"?><LawSearch><target>law</target><totalCnt>0</totalCnt><page>1</page></LawSearch>'

let calls = 0
globalThis.fetch = async (url) => {
  const target = typeof url === "string" ? url : String(url)
  if (!target.includes("law.go.kr")) throw new Error("fixture 미등록 호출: " + target)
  calls++
  if (MODE === "fail_html" || (MODE === "cache_then_fail" && calls > 1)) {
    return new Response(HTML_ERROR, { status: 200, headers: { "content-type": "text/html" } })
  }
  if (MODE === "http429_retry_after") {
    return new Response("too many requests", { status: 429, headers: { "Retry-After": "30" } })
  }
  if (MODE === "empty_body") return new Response("", { status: 200 })
  if (MODE === "zero_hits") return new Response(ZERO_XML, { status: 200, headers: { "content-type": "application/xml" } })
  return new Response(SUCCESS_XML, { status: 200, headers: { "content-type": "application/xml" } })
}
`

let preloadUrl = ""
let tmpDir = ""

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "fin-ping-fixture-"))
  const file = path.join(tmpDir, "preload.mjs")
  writeFileSync(file, PRELOAD_SRC, "utf8")
  preloadUrl = pathToFileURL(file).href
})

afterAll(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
})

type PingMode =
  | "success"
  | "fail_html"
  | "missing"
  | "cache_then_fail"
  | "http429_retry_after"
  | "empty_body"
  | "zero_hits"

/**
 * 한 서버 프로세스에서 fin_ping을 count번 **순서대로** 부른다 (앞 응답을 받은 뒤 다음 요청).
 * 캐시 우회는 같은 프로세스 안에서 두 번째 호출로만 확인할 수 있다.
 */
function callPings(mode: PingMode, count: number, env: Record<string, string> = {}): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", preloadUrl, serverEntry], {
      cwd: repoRoot,
      env: {
        ...process.env,
        FIN_PING_TEST_MODE: mode,
        FIN_NTS_BODY_ENABLED: "false",
        FIN_CACHE_TTL_SEC: "0",
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    let buf = ""
    let settled = false
    const texts: string[] = []
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      fn()
    }
    const timer = setTimeout(() => finish(() => reject(new Error("fin_ping 응답 타임아웃"))), 25_000 * count)

    const send = (o: unknown) => child.stdin.write(JSON.stringify(o) + "\n")
    const sendPing = (id: number) =>
      send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "fin_ping", arguments: {} } })

    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8")
      let nl: number
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        let msg: { id?: number; result?: { content: Array<{ text: string }> } }
        try {
          msg = JSON.parse(line)
        } catch {
          continue // stdout은 MCP 전용이지만 방어적으로 무시
        }
        if (typeof msg.id === "number" && msg.id >= 2 && msg.result) {
          texts.push(msg.result.content.map((c) => c.text).join("\n"))
          if (texts.length === count) finish(() => resolve(texts))
          else sendPing(msg.id + 1)
        }
      }
    })
    child.on("error", (e) => finish(() => reject(e)))

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ping-test", version: "1" } },
    })
    send({ jsonrpc: "2.0", method: "notifications/initialized" })
    sendPing(2)
  })
}

const callPing = async (mode: PingMode, env: Record<string, string> = {}): Promise<string> =>
  (await callPings(mode, 1, env))[0]

describe.skipIf(!hasBuild)("fin_ping — 실조회 진단", () => {
  it("키가 통하면 성공 + 건수·응답시간", async () => {
    const text = await callPing("success")
    expect(text).toContain("fin-law-mcp v")
    expect(text).toContain("정상 동작")
    expect(text).toContain("LAW_OC: 설정됨")
    expect(text).toContain("법제처 API 통신: 성공")
    expect(text).toMatch(/법인세법 검색 1건, \d+ms/) // fixture는 결과 블록 1개
    expect(text).not.toContain("다음 조치") // 성공엔 조치 줄이 붙지 않는다
    expect(text).toContain("FIN_NTS_BODY_ENABLED")
    // 통신 성공을 키 검증으로 오독하지 않게 (Codex 9차 P3 — 가짜 OC에도 200 정상 데이터 실측)
    expect(text).toContain("통신 성공은 키 값이 맞다는 확인이 아닙니다")
  }, 30_000)

  /**
   * Codex 9차 P1 — 진단이 캐시 적중(네트워크 없음)을 "통신: 성공"으로 보고했다.
   * 캐시를 켜고 같은 프로세스에서 두 번 부른다: 첫 번째는 성공해 캐시에 담기고, 두 번째는 법제처가
   * HTML 점검 페이지를 준다. 캐시를 우회하지 않으면 두 번째도 "성공"이 나온다.
   */
  it("캐시가 켜져 있어도 두 번째 진단은 실제로 법제처를 두드린다 (캐시 적중을 성공으로 보고하지 않음)", async () => {
    const [first, second] = await callPings("cache_then_fail", 2, { FIN_CACHE_TTL_SEC: "600" })
    expect(first).toContain("법제처 API 통신: 성공")
    expect(second).toContain("법제처 API 통신: 실패")
    expect(second).toContain("HTML 오류 페이지 수신")
    expect(second).not.toContain("통신: 성공")
  }, 60_000)

  it("반대 방향: 캐시가 켜져 있어도 법제처가 정상이면 두 번 모두 성공", async () => {
    const [first, second] = await callPings("success", 2, { FIN_CACHE_TTL_SEC: "600" })
    expect(first).toContain("법제처 API 통신: 성공")
    expect(second).toContain("법제처 API 통신: 성공")
  }, 60_000)

  /** Codex 9차 P2 — 429 + Retry-After: 30이 5초 abort에 끊겨 "타임아웃"으로 분류됐다 */
  it("429 + Retry-After는 타임아웃이 아니라 법제처 호출 한도 초과로 분류한다", async () => {
    const text = await callPing("http429_retry_after")
    expect(text).toContain("법제처 API 통신: 실패")
    expect(text).toContain("법제처가 호출 한도 초과(429)를 반환")
    expect(text).not.toContain("타임아웃")
  }, 30_000)

  /**
   * Codex 9차 P2 — 200 빈 본문은 "비정상 응답(빈 본문)"으로 던져지는데 분류 패턴("빈 응답")과 안 맞아
   * 원문 메시지가 그대로 나갔다. ⚠ 재시도 2회의 backoff 상한 합(1.5초+3초)이 진단 예산 5초 안이라
   * 타임아웃으로 바뀌지 않는다 — DRF 재시도 설정을 늘리면 이 테스트가 먼저 깨진다.
   */
  it("200 빈 본문은 빈 응답(일시 장애)으로 분류하고 키 거부로 단정하지 않는다", async () => {
    const text = await callPing("empty_body")
    expect(text).toContain("법제처 API 통신: 실패")
    expect(text).toContain("빈 응답을 반환")
    expect(text).not.toContain("키가 거부됐을")
  }, 30_000)

  /** Codex 9차 P2 — 법인세법 검색 0건(totalCnt 0)도 "성공"이 됐다 */
  it("법인세법 검색 결과가 0건이면 성공이 아니라 실패", async () => {
    const text = await callPing("zero_hits")
    expect(text).toContain("법제처 API 통신: 실패")
    expect(text).toContain("0건")
    expect(text).not.toContain("통신: 성공")
    expect(text).toContain("다음 조치")
  }, 30_000)

  /** Codex 9차 P2 — 로컬 한도(RATE_LIMITED)에 "FIN_DRF_RATE_PER_MIN을 낮추세요"는 역효과였다 */
  it("로컬 분당 한도 소진은 법제처 거부와 구분하고 한도를 낮추라고 하지 않는다", async () => {
    // 음수 분당 한도 = 버킷이 모든 요청을 거부 (rate-limit.ts 계약)
    const text = await callPing("success", { FIN_DRF_RATE_PER_MIN: "-1" })
    expect(text).toContain("법제처 API 통신: 실패")
    expect(text).toContain("로컬 한도")
    expect(text).not.toContain("낮추세요")
  }, 30_000)

  it("법제처가 HTML 오류 페이지를 주면 실패 + 원인 + 다음 조치", async () => {
    const text = await callPing("fail_html")
    expect(text).toContain("LAW_OC: 설정됨")
    expect(text).toContain("법제처 API 통신: 실패")
    expect(text).toContain("HTML 오류 페이지 수신")
    expect(text).toContain("다음 조치")
    // 실패를 성공으로 위장하지 않는다 (이 서버의 조용한 실패 금지 규율)
    expect(text).not.toContain("통신: 성공")
  }, 30_000)

  it("키가 없으면 통신 진단 대신 설정 방법을 준다", async () => {
    const text = await callPing("missing")
    expect(text).toContain("LAW_OC: 누락")
    expect(text).toContain("LAW_OC=<법제처 OPEN API 키>")
    expect(text).toContain("open.law.go.kr")
    // 키가 없는데 통신을 시도했다고 말하면 안 된다
    expect(text).not.toContain("법제처 API 통신")
  }, 30_000)
})
