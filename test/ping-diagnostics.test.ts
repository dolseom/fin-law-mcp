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

globalThis.fetch = async (url) => {
  const target = typeof url === "string" ? url : String(url)
  if (!target.includes("law.go.kr")) throw new Error("fixture 미등록 호출: " + target)
  if (MODE === "fail_html") {
    return new Response(HTML_ERROR, { status: 200, headers: { "content-type": "text/html" } })
  }
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

type PingMode = "success" | "fail_html" | "missing"

function callPing(mode: PingMode): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", preloadUrl, serverEntry], {
      cwd: repoRoot,
      env: { ...process.env, FIN_PING_TEST_MODE: mode, FIN_NTS_BODY_ENABLED: "false", FIN_CACHE_TTL_SEC: "0" },
      stdio: ["pipe", "pipe", "pipe"],
    })
    let buf = ""
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      fn()
    }
    const timer = setTimeout(() => finish(() => reject(new Error("fin_ping 응답 타임아웃"))), 25_000)

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
        if (msg.id === 2 && msg.result) {
          const text = msg.result.content.map((c) => c.text).join("\n")
          finish(() => resolve(text))
        }
      }
    })
    child.on("error", (e) => finish(() => reject(e)))

    const send = (o: unknown) => child.stdin.write(JSON.stringify(o) + "\n")
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ping-test", version: "1" } },
    })
    send({ jsonrpc: "2.0", method: "notifications/initialized" })
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "fin_ping", arguments: {} } })
  })
}

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
