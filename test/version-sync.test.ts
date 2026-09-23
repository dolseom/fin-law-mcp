/**
 * 버전 동기 — src/index.ts의 VERSION 리터럴(serverInfo·fin_ping 출력에 쓰임)과
 * package.json의 version이 같은지 확인한다.
 *
 * index.ts는 import하는 순간 stdio 서버를 띄우므로(top-level connect) 모듈을 불러오지 않고
 * 원문을 읽어 리터럴을 뽑는다. 빌드 없이 결정형이다.
 */

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

describe("버전 동기", () => {
  it("src/index.ts의 VERSION이 package.json version과 같다", () => {
    const indexSrc = readFileSync(path.join(repoRoot, "src", "index.ts"), "utf8")
    const matches = [...indexSrc.matchAll(/^\s*(?:export\s+)?const\s+VERSION\s*=\s*["']([^"']+)["']/gm)]
    // 선언이 없거나 두 개 이상이면 비교 대상이 모호하다 — 조용히 통과시키지 않는다
    expect(matches.length, "src/index.ts에서 VERSION 선언을 정확히 1개 찾아야 합니다").toBe(1)

    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as { version?: string }
    expect(typeof pkg.version, "package.json에 version이 없습니다").toBe("string")

    expect(matches[0][1]).toBe(pkg.version)
  })
})
