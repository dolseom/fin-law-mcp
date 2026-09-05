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

  it("✗·⌛ 혼합에서도 일반 ⚠(판정 불가) 상세가 stderr에서 유실되지 않는다 (Codex 5차 중요)", () => {
    // ⌛(폐지 연혁 추정)과 ✗(환각)가 한 문서에 — 종전에는 fail·hold가 있으면
    // 일반 ⚠ 보고가 stdout에만 남아 훅 소비자에게 닿지 않았다
    const r = runHook("수입식품등의 표시기준 제3조와 가상자산투기억제법 제3조를 본다.\n", {
      scenario: "abolished-admrul",
    })
    expect(r.stderr).toContain("실존하지 않는 인용") // ✗ — 첫 줄 우선순위 유지
    expect(r.stderr).toContain("판정 불가") // 일반 ⚠(⌛) 상세도 stderr에
    expect(r.stderr).toContain("⌛")
    expect(r.stderr.split("\n")[0]).toContain("✗")
    expect(r.status).toBe(1)
  }, 30_000)
})

describe.skipIf(!hasBuild)("verify-file 훅 — CRLF 문서 (Codex 5차 차단)", () => {
  it("CRLF로 감싸인 인용이 '인용 0건 통과'로 우회되지 않는다", () => {
    const r = runHook("국가를 당사자로 하는 계약에 관한\r\n법률 제7조에 따라 계약한다.\r\n")
    expect(r.stdout).not.toContain("법령 인용이 없습니다") // 0건 우회면 회귀
    expect(r.stdout).toContain("인용 1건")
  }, 30_000)
})

/**
 * Codex 8차 차단 회귀 — 추출 0건의 두 갈래.
 *
 * 마크다운 목록 표시 + 줄바꿈으로 법령명이 갈라지면("- 국가를 당사자로 하는 계약에 관한"
 * + 줄바꿈 + "법률 제7조") 추출이 0건이 된다 (같은 문장이 목록 표시 없이는 1건 — 실측).
 * 훅은 total===0을 "법령 인용이 없습니다 + exit 0"으로만 처리했으므로, 실제 인용이 있는
 * 검토서가 검증 성공으로 통과했다 — 확정적 거짓 성공이다.
 * 추출기의 이음새 결함(퍼즈 EXCLUSIONS mdlist+softwrap)은 v0.2 대상이고, 여기서
 * 박제하는 것은 **훅의 종료 규칙**이다: 표기 흔적이 있으면 "없음"이라고 말하지 않는다.
 */
describe.skipIf(!hasBuild)("verify-file 훅 — 추출 0건 거짓 성공 (Codex 8차 차단)", () => {
  const MDLIST_SOFTWRAP = "- 국가를 당사자로 하는 계약에 관한\n법률 제7조에 따른다.\n"

  it("표기 흔적이 있는데 추출 0건이면 통과가 아니다 — WARN_EXIT + ⚠ 보고", () => {
    const r = runHook(MDLIST_SOFTWRAP)
    expect(r.stdout).not.toContain("법령 인용이 없습니다") // 거짓 성공 문구가 남으면 회귀
    expect(r.stdout).not.toContain("인용 검증 통과")
    expect(r.stderr).toContain("인용 표기 흔적은 있으나 추출 0건")
    expect(r.stderr.split("\n")[0]).toContain("⚠") // 첫 줄이 요지 (비차단 코드에서 이 줄만 보인다)
    expect(r.status).toBe(1)
  }, 30_000)

  it("WARN_EXIT 규칙을 그대로 따른다 (2면 2, FAIL_EXIT=0이면 0)", () => {
    expect(runHook(MDLIST_SOFTWRAP, { env: { FIN_VERIFY_WARN_EXIT: "2" } }).status).toBe(2)
    const lenient = runHook(MDLIST_SOFTWRAP, { env: { FIN_VERIFY_FAIL_EXIT: "0" } })
    expect(lenient.status).toBe(0)
    expect(lenient.stderr).toContain("추출 0건") // 코드만 0, 보고는 그대로
  }, 30_000)

  it("인용 표기가 전혀 없는 문서는 종전대로 통과한다 (exit 0)", () => {
    const r = runHook("이번 분기 실적은 전년 대비 개선되었습니다.\n")
    expect(r.stdout).toContain("법령 인용이 없습니다")
    expect(r.stderr).not.toContain("추출 0건")
    expect(r.status).toBe(0)
  }, 30_000)

  // 흔적을 넓게 잡으면 평문이 매번 ⚠를 문다 — "규정·규칙·고시·훈령·통칙"은 낱말
  // 단독으로는 흔적이 아니다. 조문 번호·겹낫표·강한 접미(법률·시행령·시행규칙)만 흔적이다
  it.each([
    ["사내 규정에 따라 처리했습니다.\n", "낱말 '규정'"],
    ["매월 규칙적으로 결산 절차를 점검한다.\n", "낱말 '규칙'"],
    ["대외 고시 자료를 정리했습니다.\n", "낱말 '고시'"],
  ])("법령 인용이 없는 평문은 흔적이 아니다 (%s → exit 0)", (doc) => {
    const r = runHook(doc)
    expect(r.stdout).toContain("법령 인용이 없습니다")
    expect(r.stderr).not.toContain("인용 표기 흔적은 있으나")
    expect(r.status).toBe(0)
  }, 30_000)

  it("추출이 되는 문서는 이 분기를 타지 않는다 (정상 검증 경로 유지)", () => {
    // 같은 문장에서 목록 표시만 뺀 형태 — 1건으로 추출돼 판정 라인까지 간다
    const r = runHook("국가를 당사자로 하는 계약에 관한\n법률 제7조에 따른다.\n")
    expect(r.stdout).toContain("인용 1건")
    expect(r.stderr).not.toContain("인용 표기 흔적은 있으나")
    expect(r.stdout).toMatch(/✓\d+ \/ ✗\d+ \/ ⚠\d+/) // 요약 집계까지 도달
  }, 30_000)
})

describe.skipIf(!hasBuild)("verify-file 훅 — 청크 집계 기준 (Codex 5차 개선)", () => {
  it("문단 간 중복 인용이 상한 절단 미검증을 가리지 않는다", () => {
    // 문단1: 한 문단에 16건 (상한 15 초과 → 1건 절단) / 문단2: 문단1과 중복 1건.
    // 전역 dedup total 16 vs 청크 판정 합 16 — 종전 기준(total)으로는 미검증 0으로
    // 접혀 절단이 가려졌다. plannedTotal(17) 기준이면 미검증 1건이 드러난다
    const para1 = Array.from({ length: 16 }, (_, i) => `법인세법 제${i + 1}조`).join(", ") + "를 본다."
    const para2 = "법인세법 제1조를 다시 본다."
    const r = runHook(`${para1}\n\n${para2}\n`, { env: { FIN_VERIFY_INTERVAL_MS: "1" } })
    expect(r.stdout + r.stderr).toContain("미검증")
    expect(r.status).not.toBe(0)
  }, 30_000)
})
