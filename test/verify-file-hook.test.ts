/**
 * verify-file.mjs 훅의 판정 집계·종료 코드 회귀 테스트 (Claude 리뷰 차단 1·중요 5·개선 9).
 *
 * 훅을 실제 서브프로세스로 돌리되 전역 fetch를 프리로드 스텁(fixtures/hook-fetch-stub.mjs)
 * 으로 바꿔 결정형으로 만든다 — 실 API 없이 "문서 저장 → 훅 판정 → 종료 코드"의
 * 전 구간을 검증한다.
 *
 * 박제하는 결함:
 *  - 차단 1: 법령명 추출이 개행을 넘어 제목을 흡수 → raw의 개행이 라인 단위 집계를
 *    깨뜨려 hold 문서가 "인용 검증 통과"로 둔갑
 *  - 중요 5: hold·미검증의 종료 코드가 0이라 stderr 보고가 구조적으로 도달 불가
 *    → FIN_VERIFY_WARN_EXIT (기본 1, FAIL_EXIT=0이면 0)
 *  - 개선 9: VERDICT_LINE에 ⌛가 빠지면 judged 미달 → "상한 초과로 잘림"이라는
 *    사실과 다른 사유 + 거짓 미검증 경고
 *
 * build/가 없으면 건너뛴다 (훅은 build/를 import한다 — CI는 build 후 test 순서).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const SCRIPT = join(ROOT, "scripts", "verify-file.mjs")
const STUB_URL = pathToFileURL(join(ROOT, "test", "fixtures", "hook-fetch-stub.mjs")).href
const hasBuild = existsSync(join(ROOT, "build", "tools", "verify.js"))

let docDir: string

function runHook(
  doc: string,
  opts: { scenario?: string; env?: Record<string, string | undefined> } = {}
) {
  const docPath = join(docDir, `doc-${Math.random().toString(36).slice(2)}.md`)
  writeFileSync(docPath, doc, "utf8")
  const env: Record<string, string | undefined> = {
    ...process.env,
    LAW_OC: "testkey",
    HOOK_STUB_SCENARIO: opts.scenario || "all-empty",
    // 바깥 환경의 종료 코드 설정이 새어 들어오지 않게 기본값 상태로 초기화
    FIN_VERIFY_FAIL_EXIT: undefined,
    FIN_VERIFY_WARN_EXIT: undefined,
    FIN_VERIFY_BASIS_DATE: undefined,
    ...opts.env,
  }
  const r = spawnSync(process.execPath, ["--import", STUB_URL, SCRIPT, docPath], {
    encoding: "utf8",
    timeout: 25_000,
    env: env as NodeJS.ProcessEnv,
  })
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" }
}

beforeAll(() => {
  docDir = mkdtempSync(join(tmpdir(), "fin-hook-test-"))
})
afterAll(() => {
  rmSync(docDir, { recursive: true, force: true })
})

const HOLD_DOC = "## 검토 메모\n\n당사 내부 회계관리규정 제5조에 따라 회계처리한다.\n"

describe.skipIf(!hasBuild)("verify-file 훅 — hold 집계와 WARN_EXIT (차단 1 + 중요 5)", () => {
  it("제목 있는 문서의 hold 인용이 '통과'로 둔갑하지 않는다 — 기본 종료 코드 1", () => {
    const r = runHook(HOLD_DOC)
    expect(r.stdout).toContain("✓0 / ✗0 / ⚠1") // 제목 흡수로 집계가 깨지면 여기부터 틀어진다
    expect(r.stdout).not.toContain("인용 검증 통과")
    expect(r.stderr).toContain("사용 보류")
    expect(r.status).toBe(1)
  }, 30_000)

  it("stderr 첫 줄이 요지를 담는다 (선행 개행으로 빈 줄이 첫 줄이 되면 안 된다)", () => {
    const r = runHook(HOLD_DOC)
    const firstLine = r.stderr.split("\n")[0]
    expect(firstLine.trim()).not.toBe("")
    expect(firstLine).toContain("사용 보류")
  }, 30_000)

  it("FIN_VERIFY_WARN_EXIT=2면 종료 코드 2 (Claude에게 전문 전달 모드)", () => {
    const r = runHook(HOLD_DOC, { env: { FIN_VERIFY_WARN_EXIT: "2" } })
    expect(r.status).toBe(2)
  }, 30_000)

  it("FAIL_EXIT=0(경고만 모드)이면 WARN_EXIT 기본도 0", () => {
    const r = runHook(HOLD_DOC, { env: { FIN_VERIFY_FAIL_EXIT: "0" } })
    expect(r.status).toBe(0)
    expect(r.stderr).toContain("사용 보류") // 보고는 그대로, 코드만 0
  }, 30_000)
})

describe.skipIf(!hasBuild)("verify-file 훅 — ✗ 경로 (기존 계약 유지)", () => {
  it("환각 인용은 FAIL_EXIT로 끝나고 stderr 첫 줄이 ✗ 요지다", () => {
    const r = runHook("가상자산투기억제법 제3조를 검토한다.\n", {
      env: { FIN_VERIFY_FAIL_EXIT: "2" },
    })
    expect(r.status).toBe(2)
    expect(r.stderr).toContain("실존하지 않는 인용")
    expect(r.stderr.split("\n")[0]).toContain("✗")
  }, 30_000)
})

describe.skipIf(!hasBuild)("verify-file 훅 — ⌛ 판정 집계 (개선 9)", () => {
  it("⌛(폐지·연혁 추정)가 판정 라인으로 집계돼 거짓 '미검증' 경고가 나오지 않는다", () => {
    const r = runHook("수입식품등의 표시기준 제3조에 따른다.\n", { scenario: "abolished-admrul" })
    expect(r.stdout).toContain("⌛")
    expect(r.stdout).toContain("✓0 / ✗0 / ⚠1") // ⌛가 judged에 들어간다
    expect(r.stdout + r.stderr).not.toContain("미검증") // 집계 미달이면 여기가 터진다
    // ⌛는 "통과"가 아니다 — 폐지 규칙 인용을 그대로 두면 안 된다 (Codex 4차 차단)
    expect(r.stdout).not.toContain("인용 검증 통과")
    expect(r.status).toBe(1)
  }, 30_000)
})

/**
 * Codex 4차 차단 회귀 — 일반 ⚠(조회 실패)가 exit 0으로 끝나면, 검증이 하나도 안 된
 * 문서(전 인용 API 장애)가 "통과"로 읽힌다. 0의 stderr는 디버그 로그에만 남는다.
 */
describe.skipIf(!hasBuild)("verify-file 훅 — 일반 ⚠도 통과로 삼키지 않는다 (Codex 4차 차단)", () => {
  it("전 인용이 조회 실패(⚠)면 WARN_EXIT로 끝나고 판정 불가를 보고한다", () => {
    const r = runHook("법인세법 제26조를 검토한다.\n", { scenario: "api-error" })
    expect(r.stdout).toContain("✓0 / ✗0 / ⚠1")
    expect(r.stdout).not.toContain("인용 검증 통과")
    expect(r.stderr).toContain("판정 불가")
    expect(r.stderr).not.toContain("삭제한 뒤") // 확인 실패는 삭제 지시가 아니다
    expect(r.status).toBe(1)
  }, 30_000)

  it("FAIL_EXIT=0 + WARN_EXIT=2 혼합에서도 보류 보고가 ✗의 exit 0에 가려지지 않는다", () => {
    // ✗(환각)와 hold(사내 규정)가 한 문서에 — 종료 코드는 해당 코드의 최댓값(2)
    const r = runHook("가상자산투기억제법 제3조와 당사 내부 회계관리규정 제5조를 검토한다.\n", {
      env: { FIN_VERIFY_FAIL_EXIT: "0", FIN_VERIFY_WARN_EXIT: "2" },
    })
    expect(r.stderr).toContain("실존하지 않는 인용")
    expect(r.stderr).toContain("사용 보류")
    expect(r.status).toBe(2)
  }, 30_000)
})
