#!/usr/bin/env node
/**
 * 인용 검증 게이트 — 재무 도메인 정상 인용 20문장이 전부 ✓로 판정되는지 확인한다.
 *
 * 취지: fin_verify는 "틀린 인용을 잡는 것"만으로는 쓸 수 없다. 맞는 인용에 ✗·⚠를 내면
 * 실무자가 맞는 근거를 지운다(거짓 양성). 이 게이트는 그 반대 방향 —
 * **정상 인용 20문장이 100% ✓로 통과하는가**를 회귀 기준으로 고정한다.
 *
 * 20문장은 모두 실존 인용이며 재무 스펙트럼(법인세·소득세·부가가치세·상증·조특·
 * 근퇴·외감·외국환거래규정)과 표기 변형(「」·시행령·시행규칙·조응·약칭)을 덮는다.
 *
 * 실행:
 *   npm run build && node scripts/gate20.mjs
 *
 * 환경변수:
 *   LAW_OC                (필수) 법제처 OPEN API 키. 저장소 .env에서 자동 로드
 *   GATE_INTERVAL_MS      문장 간 간격(기본 6000). 법제처 분당 한도(30) 회피용
 *   GATE_RATE_COOLDOWN_MS 한도에 걸린 문장의 재시도 대기(기본 65000)
 *
 * 종료 코드: 0 = 25개 인용 전부 ✓ / 1 = ✗ 또는 ⚠ 잔존
 */

import { config } from "dotenv"
import { pathToFileURL } from "node:url"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
config({ path: join(ROOT, ".env"), quiet: true })

const BUILD = join(ROOT, "build")
if (!existsSync(join(BUILD, "tools", "verify.js"))) {
  console.error("[오류] build/가 없습니다. 먼저 `npm run build`를 실행하세요.")
  process.exit(1)
}
if (!process.env.LAW_OC) {
  console.error("[오류] LAW_OC가 설정되지 않았습니다 (.env 또는 환경변수).")
  process.exit(1)
}

const { LawApiClient } = await import(pathToFileURL(join(BUILD, "lib", "api-client.js")).href)
const { handleFinVerify } = await import(pathToFileURL(join(BUILD, "tools", "verify.js")).href)

/**
 * 게이트 문장 — 전부 실존 인용이다. 문장을 바꾸려면 인용의 실존을 먼저 확인할 것.
 * 각 항목의 expect는 그 문장이 만들어내는 인용 수 (추출 누락도 회귀다).
 */
const SENTENCES = [
  { text: "「법인세법」 제26조에 따라 과다하거나 부당하다고 인정하는 인건비는 손금에 산입하지 아니한다.", cites: 1, note: "「」 표기" },
  { text: "임원에게 지급하는 상여금의 손금불산입 기준은 「법인세법 시행령」 제43조에 규정되어 있다.", cites: 1, note: "「」 + 시행령" },
  { text: "법인세법 제19조의2에 따른 대손금은 같은 법 시행령 제19조의2의 요건을 충족해야 한다.", cites: 2, note: "조응(같은 법 시행령) + 가지조문" },
  { text: "법인세법 제52조 부당행위계산의 부인을 적용할 때에는 동 시행령 제88조의 유형을 확인한다.", cites: 2, note: "조응(동 시행령)" },
  { text: "감가상각자산의 기준내용연수는 법인세법 시행규칙 제15조에서 정한 바에 따른다.", cites: 1, note: "시행규칙" },
  { text: "소득세법 제12조는 비과세소득을 항목별로 열거하고 있다.", cites: 1, note: "본법" },
  { text: "사업소득의 필요경비 계산은 소득세법 제27조 및 같은 법 시행령 제55조에 따른다.", cites: 2, note: "접속사 + 조응" },
  { text: "부가가치세법 제32조에 따른 세금계산서 발급 의무를 확인해야 한다.", cites: 1, note: "본법" },
  { text: "부가세법 제37조에 따라 납부세액은 매출세액에서 매입세액을 뺀 금액으로 한다.", cites: 1, note: "약칭(부가세법)" },
  { text: "상속세 및 증여세법 제63조에 따라 유가증권 등을 평가한다.", cites: 1, note: "'및'이 든 정식 명칭" },
  { text: "상증법 제13조에 따라 상속개시일 전 증여재산을 상속세 과세가액에 가산한다.", cites: 1, note: "약칭(상증법)" },
  { text: "조세특례제한법 제7조는 중소기업에 대한 특별세액감면을 규정한다.", cites: 1, note: "본법" },
  { text: "조특법 제10조에 따른 연구·인력개발비 세액공제를 적용한다.", cites: 1, note: "약칭(조특법)" },
  { text: "근로자퇴직급여 보장법 제8조에 따라 사용자는 퇴직금제도를 설정하여야 한다.", cites: 1, note: "공백이 든 정식 명칭" },
  { text: "근퇴법 제20조에 따른 확정기여형퇴직연금제도의 부담금을 납입한다.", cites: 1, note: "약칭(근퇴법)" },
  { text: "주식회사 등의 외부감사에 관한 법률 제4조는 외부감사의 대상을 정한다.", cites: 1, note: "긴 정식 명칭(절단 회귀)" },
  { text: "외감법 제5조에 따른 회계처리기준을 적용하여 재무제표를 작성한다.", cites: 1, note: "약칭(외감법)" },
  { text: "국세기본법 제14조 실질과세 원칙과 같은 법 제26조의2 부과제척기간을 함께 검토한다.", cites: 2, note: "조응(같은 법) + 가지조문" },
  { text: "「외국환거래규정」에서 정한 절차에 따라 해외직접투자를 신고한다.", cites: 1, note: "행정규칙(기재부 고시) — 법령 DB 0건 → ✗ 낙인 회귀" },
  { text: "상법 제447조에 따라 재무제표를 작성하고 관세법 제30조의 과세가격 결정 원칙을 검토한다.", cites: 2, note: "짧은 법령명 2건" },
]

const INTERVAL_MS = Number(process.env.GATE_INTERVAL_MS) || 6_000
/** 한도에 걸렸을 때의 재시도 대기 — 토큰버킷이 1분치를 다시 채우는 데 필요한 시간 */
const RATE_LIMIT_COOLDOWN_MS = Number(process.env.GATE_RATE_COOLDOWN_MS) || 65_000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** fin_verify 응답 텍스트에서 요약 카운트와 판정 라인을 뽑는다 */
function parseResult(text) {
  const m = text.match(/✓(\d+)\s*\/\s*✗(\d+)\s*\/\s*⚠(\d+)/)
  const counts = m
    ? { ok: Number(m[1]), bad: Number(m[2]), unknown: Number(m[3]) }
    : { ok: 0, bad: 0, unknown: 0 }
  const lines = text
    .split("\n")
    .filter((l) => /^[✓✗⚠]\s/.test(l))
    .map((l) => l.trim())
  return { counts, lines, parsed: !!m }
}

/** ⚠ 사유가 분당 한도(측정 잡음)인가 — 결함과 구분해 보고하기 위한 판별 */
const isRateNoise = (lines) =>
  lines.some((l) => l.startsWith("⚠") && /RATE_LIMITED|한도|429|TIMEOUT|시간 상한/.test(l))

const client = new LawApiClient({ apiKey: process.env.LAW_OC })

console.log(`인용 검증 게이트 — 정상 인용 ${SENTENCES.length}문장 (기대 인용 ${SENTENCES.reduce((s, x) => s + x.cites, 0)}건)`)
console.log(`간격 ${INTERVAL_MS}ms · 시작 ${new Date().toLocaleTimeString("ko-KR")}\n`)

const results = []
let retried = 0

for (let i = 0; i < SENTENCES.length; i++) {
  const item = SENTENCES[i]
  if (i > 0) await sleep(INTERVAL_MS)

  let res = await handleFinVerify(client, { text: item.text })
  let parsed = parseResult(res.content[0].text)

  // ⚠는 "없음"이 아니라 확인 실패다 — 1회 재시도해 측정 잡음과 실제 결함을 가른다
  if (parsed.counts.unknown > 0 || parsed.counts.bad > 0) {
    const cooldown = isRateNoise(parsed.lines) ? RATE_LIMIT_COOLDOWN_MS : INTERVAL_MS * 2
    console.log(`  ↻ [${i + 1}] 재시도 (⚠${parsed.counts.unknown} ✗${parsed.counts.bad}) — ${cooldown / 1000}초 대기`)
    await sleep(cooldown)
    res = await handleFinVerify(client, { text: item.text })
    parsed = parseResult(res.content[0].text)
    retried++
  }

  const { ok, bad, unknown } = parsed.counts
  const mark = bad > 0 ? "✗" : unknown > 0 ? "⚠" : "✓"
  const countNote = ok + bad + unknown !== item.cites ? ` ⚠추출 ${ok + bad + unknown}건 (기대 ${item.cites}건)` : ""
  console.log(`${mark} [${String(i + 1).padStart(2)}] ✓${ok} ✗${bad} ⚠${unknown}${countNote}  ${item.note} — ${item.text.slice(0, 40)}…`)

  results.push({ ...item, ...parsed.counts, mark, lines: parsed.lines, text: item.text, extracted: ok + bad + unknown })
}

// ── 요약 ────────────────────────────────────────────────────────────────
const total = results.reduce(
  (a, r) => ({ ok: a.ok + r.ok, bad: a.bad + r.bad, unknown: a.unknown + r.unknown }),
  { ok: 0, bad: 0, unknown: 0 }
)
const passSentences = results.filter((r) => r.mark === "✓").length
const miscount = results.filter((r) => r.extracted !== r.cites)

console.log(`\n${"─".repeat(70)}`)
console.log(`문장: ${passSentences}/${SENTENCES.length} 통과 · 인용: ✓${total.ok} / ✗${total.bad} / ⚠${total.unknown} · 재시도 ${retried}회`)

if (miscount.length > 0) {
  console.log(`\n[인용 추출 수 불일치 ${miscount.length}건 — 추출 누락도 회귀다]`)
  for (const r of miscount) console.log(`  · ${r.text}\n    기대 ${r.cites}건 / 실제 ${r.extracted}건`)
}

const failed = results.filter((r) => r.mark !== "✓")
if (failed.length > 0) {
  console.log(`\n[실패 문장 ${failed.length}건]`)
  for (const r of failed) {
    console.log(`\n  ${r.mark} ${r.text}`)
    for (const l of r.lines.filter((l) => !l.startsWith("✓"))) console.log(`      ${l}`)
  }
  const noise = failed.filter((r) => isRateNoise(r.lines)).length
  if (noise > 0) console.log(`\n※ 이 중 ${noise}건은 분당 한도·타임아웃 사유입니다 (측정 잡음 — GATE_INTERVAL_MS를 늘려 재실행하세요)`)
}

console.log(`\n종료 ${new Date().toLocaleTimeString("ko-KR")}`)
process.exit(total.bad > 0 || total.unknown > 0 || miscount.length > 0 ? 1 : 0)
