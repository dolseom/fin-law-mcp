#!/usr/bin/env node
/**
 * 파일 인용 검증 — 문서 파일의 법령 인용을 fin_verify로 대조하고, ✗가 하나라도 있으면 실패한다.
 *
 * 용도: 검토서·메모를 저장하는 순간 "실존하지 않는 조문"이 문서에 남는 것을 막는 마지막 관문.
 * Claude Code 훅으로 거는 방법은 docs/HOOKS.md 참고.
 *
 * 실행:
 *   node scripts/verify-file.mjs <파일경로>
 *   echo '{"tool_input":{"file_path":"검토서.md"}}' | node scripts/verify-file.mjs   # 훅 stdin
 *
 * 환경변수:
 *   LAW_OC                 (필수) 법제처 OPEN API 키. 저장소 .env에서 자동 로드
 *   FIN_VERIFY_FAIL_EXIT   ✗ 발견 시 종료 코드 (기본 1). Claude Code PostToolUse 훅에서는 2로 둘 것 —
 *                          종료 코드 2일 때만 stderr가 Claude에게 전달된다 (0이면 디버그 로그에만 남는다)
 *   FIN_VERIFY_BASIS_DATE  기준일 YYYY-MM-DD (생략 시 현행)
 *
 * 종료 코드: 0 = ✗ 없음 / 1(또는 FIN_VERIFY_FAIL_EXIT) = ✗ 있음 / 3 = 실행 불가(키·파일 오류)
 * ⚠(확인 실패)는 실패로 치지 않는다 — "없음"이 아니라 "확인 못 함"이므로 경고만 남긴다.
 */

import { config } from "dotenv"
import { readFileSync, existsSync, statSync } from "node:fs"
import { dirname, join, extname } from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
config({ path: join(ROOT, ".env"), quiet: true })

// ?? 가 아니라 || 를 쓰면 FIN_VERIFY_FAIL_EXIT=0(경고만 하고 통과)을 설정할 수 없다
const FAIL_EXIT = Number.isFinite(Number(process.env.FIN_VERIFY_FAIL_EXIT))
  ? Number(process.env.FIN_VERIFY_FAIL_EXIT)
  : 1
const MAX_BYTES = 512 * 1024
/** fin_verify의 인용 상한(15건)에 맞춰 문단 단위로 나눈다 — 넘기면 뒷부분이 조용히 미검증된다 */
const CHUNK_CITATION_LIMIT = 15
const CHUNK_INTERVAL_MS = Number(process.env.FIN_VERIFY_INTERVAL_MS) || 3_000
/** 인용 판정 라인 — 마크 뒤에 공백이 온다. 요약 헤더(⚠️…)와 구분하는 유일한 표식이다 */
const VERDICT_LINE = /^[✓✗⚠]\s/

/** 훅은 stdin으로 JSON을 준다 — 인자와 stdin 양쪽을 받는다 */
async function resolveTargetPath() {
  const fromArgv = process.argv[2]
  if (fromArgv) return fromArgv
  if (process.stdin.isTTY) return null
  let raw = ""
  for await (const chunk of process.stdin) raw += chunk
  if (!raw.trim()) return null
  try {
    const payload = JSON.parse(raw)
    return payload?.tool_input?.file_path || payload?.file_path || null
  } catch {
    return raw.trim() // 경로 한 줄만 준 경우
  }
}

const target = await resolveTargetPath()
if (!target) {
  console.error("[오류] 검증할 파일 경로가 없습니다. 사용법: node scripts/verify-file.mjs <파일경로>")
  process.exit(3)
}
if (!existsSync(target)) {
  console.error(`[오류] 파일이 없습니다: ${target}`)
  process.exit(3)
}
const size = statSync(target).size
if (size > MAX_BYTES) {
  console.error(`[오류] 파일이 너무 큽니다 (${Math.round(size / 1024)}KB > ${MAX_BYTES / 1024}KB): ${target}`)
  process.exit(3)
}
if (![".md", ".txt", ".markdown", ""].includes(extname(target).toLowerCase())) {
  console.error(`[건너뜀] 텍스트 문서가 아닙니다: ${target}`)
  process.exit(0)
}
if (!process.env.LAW_OC) {
  console.error("[오류] LAW_OC가 설정되지 않았습니다 — 인용을 검증할 수 없습니다 (.env 확인).")
  process.exit(3)
}
if (!existsSync(join(ROOT, "build", "tools", "verify.js"))) {
  console.error("[오류] build/가 없습니다. 먼저 `npm run build`를 실행하세요.")
  process.exit(3)
}

const { LawApiClient } = await import(pathToFileURL(join(ROOT, "build", "lib", "api-client.js")).href)
const { handleFinVerify, extractCitationsWithTotal } = await import(
  pathToFileURL(join(ROOT, "build", "tools", "verify.js")).href
)

const text = readFileSync(target, "utf8")
const { total } = extractCitationsWithTotal(text)
if (total === 0) {
  console.log(`[인용 검증] ${target} — 법령 인용이 없습니다 (검증 대상 0건)`)
  process.exit(0)
}

/**
 * 문단 단위 청크. 한 청크의 인용이 상한을 넘지 않게 모은다.
 * 한 문단만으로 상한을 넘으면 그 문단은 단독 청크로 두고 fin_verify의 절단 고지에 맡긴다.
 *
 * 상한 이내면 **원문을 그대로 넘긴다**. 문단을 골라 재조립하면 조응("같은 법")의 선행사가
 * 사라져 멀쩡한 인용이 ⚠가 된다 — 나눌 필요가 없을 때는 나누지 않는 것이 정확하다.
 */
function chunkByCitations(fullText) {
  if (total <= CHUNK_CITATION_LIMIT) return [fullText]
  const paragraphs = fullText.split(/\n\s*\n/).filter((p) => p.trim())
  const chunks = []
  let buf = []
  let bufCount = 0
  for (const p of paragraphs) {
    const n = extractCitationsWithTotal(p).total
    if (n === 0) continue
    if (bufCount > 0 && bufCount + n > CHUNK_CITATION_LIMIT) {
      chunks.push(buf.join("\n\n"))
      buf = []
      bufCount = 0
    }
    buf.push(p)
    bufCount += n
  }
  if (buf.length > 0) chunks.push(buf.join("\n\n"))
  return chunks.length > 0 ? chunks : [fullText]
}

const chunks = chunkByCitations(text)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const client = new LawApiClient({ apiKey: process.env.LAW_OC })
const basis_date = process.env.FIN_VERIFY_BASIS_DATE

console.log(`[인용 검증] ${target} — 인용 ${total}건`)
if (chunks.length > 1) {
  console.log(
    `  인용이 상한(${CHUNK_CITATION_LIMIT}건)을 넘어 ${chunks.length}개 구간으로 나눠 검증합니다.\n` +
      `  구간 경계에 걸친 조응 인용("같은 법")은 선행사를 잃어 ⚠로 나올 수 있습니다 — 그 경우 법령명을 명시하세요.`
  )
}

const failLines = []
const warnLines = []
let ok = 0

for (let i = 0; i < chunks.length; i++) {
  if (i > 0) await sleep(CHUNK_INTERVAL_MS)
  const res = await handleFinVerify(client, basis_date ? { text: chunks[i], basis_date } : { text: chunks[i] })
  for (const line of res.content[0].text.split("\n")) {
    const t = line.trim()
    // 판정 라인만 센다. 요약 헤더는 이모지 변형(⚠️ = U+26A0 U+FE0F)이라 뒤에 공백이 오지
    // 않는다 — startsWith로 거르면 헤더가 ⚠ 1건으로 잘못 잡힌다 (스모크에서 실측)
    if (!VERDICT_LINE.test(t)) continue
    if (t.startsWith("✗")) failLines.push(t)
    else if (t.startsWith("⚠")) warnLines.push(t)
    else ok++
  }
}

console.log(`  ✓${ok} / ✗${failLines.length} / ⚠${warnLines.length}`)

// 한 문단이 단독으로 상한을 넘으면 그 청크의 뒷부분은 fin_verify가 자른다 —
// 절단 고지는 요약 헤더에만 있어 판정 라인 필터에 걸러진다. 판정 합과 인용 수가
// 어긋나는 것으로만 드러나던 것을 명시한다 (Opus 리뷰 개선 6)
const judged = ok + failLines.length + warnLines.length
if (judged < total) {
  console.log(
    `\n⚠ 인용 ${total}건 중 ${judged}건만 판정됐습니다 (${total - judged}건 미검증 — 한 문단의 인용이 ` +
      `상한 ${CHUNK_CITATION_LIMIT}건을 넘어 잘렸습니다). 그 문단을 나눠 다시 검증하세요.`
  )
}

if (warnLines.length > 0) {
  console.log(`\n⚠ 판정 불가 ${warnLines.length}건 ("없음"이 아니라 확인 실패 — 원문으로 직접 확인하세요)`)
  for (const l of warnLines) console.log(`  ${l}`)
}

if (failLines.length > 0) {
  const msg =
    `\n✗ 실존하지 않는 인용 ${failLines.length}건 — 이 문서는 그대로 쓰면 안 됩니다\n` +
    failLines.map((l) => `  ${l}`).join("\n") +
    `\n\n해당 인용을 수정하거나 삭제한 뒤 다시 저장하세요.`
  // 훅에서 Claude가 읽는 경로는 stderr다
  console.error(msg)
  process.exit(FAIL_EXIT)
}

// "사용 보류"를 요구하는 ⚠는 단순 확인 실패와 다르다 — 미등재 약칭·환각 의심처럼
// 확인 전까지 쓰면 안 되는 인용이다. 이것을 다른 ⚠와 뭉뚱그리면 마지막 줄의
// "인용 검증 통과"가 보류 항목까지 통과시킨 것으로 읽힌다 (실측: 환각 규정 인용이
// soft 강등으로 ⚠가 된 뒤 "통과"로 보고됐다)
const holdLines = warnLines.filter((l) => /사용\s*보류|사용을 보류/.test(l))
if (holdLines.length > 0) {
  console.error(
    `\n⚠ 사용 보류 ${holdLines.length}건 — 실존이 확인되지 않은 인용입니다. "통과"가 아닙니다:\n` +
      holdLines.map((l) => `  ${l}`).join("\n") +
      `\n\n정식 명칭으로 재검증하거나, 법령이 아닌 문서(사내 규정 등)라면 그렇게 표기하세요.`
  )
  process.exit(0)
}

console.log("\n인용 검증 통과 — 실존하지 않는 인용 없음")
process.exit(0)
