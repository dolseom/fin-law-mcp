/**
 * tools/list 계약 — 빌드된 서버를 실제 stdio로 띄워 확인한다.
 *
 * fin_nts_ruling은 FIN_NTS_BODY_ENABLED=true일 때만 목록에 실린다 (기획검토 1-5).
 * OFF면 이 도구가 주는 것은 예규 목록뿐이고 fin_ruling_search(domains=["nts"])와 겹친다.
 *
 * ⚠ build/를 띄우므로 CI는 build → test 순서여야 한다 (verify-file-hook.test.ts와 같은 전제).
 * tools/list는 네트워크를 타지 않아 LAW_OC 없이도 결정형이다.
 */

import { describe, it, expect } from "vitest"
import { spawn } from "node:child_process"
import path from "node:path"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const serverEntry = path.join(repoRoot, "build", "index.js")
// build/가 없으면(클린 checkout에서 build 전) verify-file-hook.test.ts와 같이 skip — 실패로 위장하지 않는다
const hasBuild = existsSync(serverEntry)

function listTools(ntsBodyEnabled: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverEntry], {
      cwd: repoRoot,
      // dotenv는 이미 있는 process.env를 덮어쓰지 않으므로 개인 .env의 값보다 이쪽이 이긴다
      env: { ...process.env, FIN_NTS_BODY_ENABLED: ntsBodyEnabled },
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
    const timer = setTimeout(() => finish(() => reject(new Error("tools/list 응답 타임아웃"))), 20_000)

    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8")
      let nl: number
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        let msg: { id?: number; result?: { tools: Array<{ name: string }> } }
        try {
          msg = JSON.parse(line)
        } catch {
          continue // stdout은 MCP 전용이지만 방어적으로 무시
        }
        if (msg.id === 2 && msg.result) {
          const tools = msg.result.tools.map((t) => t.name)
          finish(() => resolve(tools))
        }
      }
    })
    child.on("error", (e) => finish(() => reject(e)))

    const send = (o: unknown) => child.stdin.write(JSON.stringify(o) + "\n")
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "tools-list-test", version: "1" } },
    })
    send({ jsonrpc: "2.0", method: "notifications/initialized" })
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
  })
}

// ⚠ 나열 순서가 곧 계약이다 — 아래 toEqual이 순서까지 본다.
// 진입 도구 fin_topic이 맨 앞이어야 한다 (index.ts의 tools 배열 주석 참조).
const BASE_TOOLS = ["fin_topic", "fin_article", "fin_law_search", "fin_ruling_search", "fin_annex", "fin_verify", "fin_calc", "fin_ping"]

describe.skipIf(!hasBuild)("tools/list — fin_nts_ruling 조건부 등록", () => {
  it("FIN_NTS_BODY_ENABLED=false면 8개 (fin_nts_ruling 미노출)", async () => {
    const tools = await listTools("false")
    expect(tools).toEqual(BASE_TOOLS)
    expect(tools).not.toContain("fin_nts_ruling")
  }, 30_000)

  it("FIN_NTS_BODY_ENABLED=true면 9개 (fin_nts_ruling 노출)", async () => {
    const tools = await listTools("true")
    expect(tools).toContain("fin_nts_ruling")
    expect(tools).toHaveLength(BASE_TOOLS.length + 1)
  }, 30_000)

  it("환경변수 미설정은 OFF와 같다 — 공개 기본값", async () => {
    const tools = await listTools("")
    expect(tools).not.toContain("fin_nts_ruling")
  }, 30_000)
})
