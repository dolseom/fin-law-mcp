/**
 * fin_verify 인용 추출 퍼즈(속성) 테스트 — 순수 함수·네트워크 없음 (CI 상시)
 *
 * 왜 퍼즈인가: 최근 차단급 결함 4건이 전부 **텍스트 변형**에서 나왔다.
 *   CRLF(5차) / 어절 경계 soft-wrap(4차) / 낱말 안 줄바꿈 "시⏎행령"(6차) /
 *   두 패스 병합 시 조응 이중 해소(7차)
 * 하나하나를 사례로 박제하면 다음 변형 조합이 또 뚫린다. 그래서 **실존 형태 인용을
 * 조합해 문장을 만들고, 문서에서 실제로 일어나는 변형을 조합해 걸어** 불변식을 검사한다.
 *
 * 불변식 (변형은 표기를 바꿀 뿐 인용의 내용을 바꾸지 않는다):
 *   ① 추출 건수(total)가 기대 건수와 같다
 *   ② 기대한 (법령명, 조문)이 각각 정확히 한 번 나온다 (법령명은 공백 제거 후 비교)
 *   ③ 조응("같은 법", "동 시행령")이 기대한 선행사로 해소된다
 *   ④ 기대에 없는 법령명이 만들어지지 않는다 (환각 이름 생성 금지)
 *
 * 이 파일은 **결함을 드러내는 것**이 목적이다. 추출기(src/tools/verify.ts)를 여기서
 * 고치지 않는다 — 여섯 라운드 연속으로 직전 수정의 반작용이 차단급을 만들었다.
 * 현재 실패하는 변형 조합은 EXCLUSIONS에 사유·예시와 함께 명시적으로 남긴다.
 *
 * 실패 전량 보고서: FIN_FUZZ_REPORT=<경로> 로 실행하면 제외분까지 표로 덤프한다.
 */

import { describe, it, expect } from "vitest"
import { writeFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { extractCitationsWithTotal } from "../src/tools/verify.js"

// ── 시드 고정 PRNG (mulberry32) ─────────────────────────────────────────
const SEED = 20260902

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = <T>(rng: () => number, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)]
const compact = (s: string): string => s.replace(/\s+/g, "")

// ── 원자: 실존 형태의 인용 ───────────────────────────────────────────────
// 전부 실무에서 실제로 쓰는 표기다. 퍼즈가 없는 법령명을 만들어 놓고 "못 찾았다"고
// 채점하면 의미가 없다 — 기대값은 항상 "정상 인용이 원형 그대로 추출될 것"이다.
//
// ⚠ 아래 두 원자는 **추출 불변식용 표기이며 실존 여부와 무관하다** (실 API 확인, 2026-09-05).
//   · 「소득세법 시행령」 제12조의2 — 법령은 실존하나 그 조문은 현행에 없다
//   · 「국세청 조사사무처리규정」 — 정확 일치 0건. **정식 명칭은 「조사사무처리규정」**이다
//     (findAdminRule 실측: "조사사무처리규정" → exact=true, 훈령·국세청 /
//      "국세청 조사사무처리규정" → 0건). 기관명을 앞에 붙인 표기가 실무에서 흔해 원자로 둔다.
//   이 파일은 **추출 불변식만** 검사하므로 판정에는 영향이 없다. 다만 이 원자들을
//   검증 단계 테스트(✓/✗ 기대값)에 그대로 옮겨 쓰면 안 된다.

interface LawAtomDef {
  tag: string
  /** 조응("같은 법")의 선행사가 되는 본법명 */
  name: string
  suffix?: "시행령" | "시행규칙"
  article: string
  /** 기본 표기가 「」인가 */
  quoted: boolean
  /** 규정류 — "같은 규정"의 선행사이고 "같은 법"의 선행사는 아니다 */
  reg?: boolean
  /** 행정규칙·규정류 경로(ADMIN_ARTICLE_RE)로 추출되는가 */
  adminLike?: boolean
  /** 법령명이 여러 어절인가 (어절 경계 soft-wrap 대상) */
  multiWord: boolean
}

const LAW_ATOMS: readonly LawAtomDef[] = [
  { tag: "법인세법", name: "법인세법", article: "제26조", quoted: false, multiWord: false },
  { tag: "소득세법령", name: "소득세법", suffix: "시행령", article: "제12조의2", quoted: false, multiWord: true },
  { tag: "부가세법", name: "부가가치세법", article: "제32조", quoted: false, multiWord: false },
  {
    tag: "국가계약법",
    name: "국가를 당사자로 하는 계약에 관한 법률",
    article: "제7조",
    quoted: false,
    multiWord: true,
  },
  {
    tag: "외감법령",
    name: "주식회사 등의 외부감사에 관한 법률",
    suffix: "시행령",
    article: "제5조",
    quoted: false,
    multiWord: true,
  },
  { tag: "근퇴법", name: "근로자퇴직급여 보장법", article: "제8조", quoted: false, multiWord: true },
  { tag: "법인세칙", name: "법인세법", suffix: "시행규칙", article: "제15조", quoted: true, multiWord: true },
  { tag: "외국환규정", name: "외국환거래규정", article: "제23조", quoted: true, reg: true, adminLike: true, multiWord: false },
  {
    tag: "조사사무규정",
    name: "국세청 조사사무처리규정",
    article: "제41조",
    quoted: false,
    reg: true,
    adminLike: true,
    multiWord: true,
  },
]

/** 괄호 안에만 쓰는 인용 — 본 원자 풀과 겹치지 않게 분리 (기대 다중집합 모호성 방지) */
const PAREN_ONLY = [
  { name: "지방세법", article: "제103조" },
  { name: "관세법", article: "제19조" },
] as const

interface AnaphorDef {
  tag: string
  text: string
  needs: "law" | "reg"
  /** 선행사로부터 기대 법령명을 만든다 */
  resolve: (antecedent: string) => string
  article: string
}

const ANAPHOR_ATOMS: readonly AnaphorDef[] = [
  { tag: "같은법", text: "같은 법 제3조", needs: "law", resolve: (a) => a, article: "제3조" },
  { tag: "같은법령", text: "같은 법 시행령 제163조", needs: "law", resolve: (a) => `${a} 시행령`, article: "제163조" },
  { tag: "동시행령", text: "동 시행령 제8조", needs: "law", resolve: (a) => `${a} 시행령`, article: "제8조" },
  { tag: "같은규정", text: "같은 규정 제9조", needs: "reg", resolve: (a) => a, article: "제9조" },
]

/** 원자 사이 연결어 — 조사·접속사·문장 경계·문단 경계 */
const CONNECTORS = [
  "에 따라 ",
  " 및 ",
  "를 준용하고, ",
  "를 적용한다. ",
  "와 ",
  "를 본다.\n\n",
] as const

const TITLES = ["2026년 세무 검토 대상", "내부 검토 메모 초안", "법인 결산 유의사항 정리"] as const
const MD_PREFIXES = ["- ", "## ", "1. ", "* "] as const

// ── 기대값 ──────────────────────────────────────────────────────────────

interface Expect {
  lawName: string
  article: string
  /** 조응 인용인가 — 실패 분류에서 "엉뚱한 법령 확신"을 가르는 기준 */
  anaphor: boolean
}

interface FuzzCase {
  id: string
  comboId: string
  combo: readonly string[]
  text: string
  expects: Expect[]
  atomTags: string[]
  /** 규정·행정규칙 경로 원자를 포함하는가 (제목 오염 복구 수단이 없는 경로) */
  hasAdminAtom: boolean
  /** 변형이 걸린 원자 태그 */
  mutatedTag?: string
}

// ── 문장 생성 ────────────────────────────────────────────────────────────

interface Segment {
  kind: "law" | "anaphor"
  tag: string
  text: string
  def?: LawAtomDef
  adminLike?: boolean
  quoted?: boolean
  multiWord?: boolean
}

function renderLaw(def: LawAtomDef, quoted: boolean): string {
  const lawName = def.suffix ? `${def.name} ${def.suffix}` : def.name
  return quoted ? `「${lawName}」 ${def.article}` : `${lawName} ${def.article}`
}

function lawNameOf(def: LawAtomDef): string {
  return def.suffix ? `${def.name} ${def.suffix}` : def.name
}

function buildSentence(rng: () => number): {
  segments: Segment[]
  connectors: string[]
  expects: Expect[]
  atomTags: string[]
  hasAdminAtom: boolean
} {
  const count = 2 + Math.floor(rng() * 4) // 2~5개
  const segments: Segment[] = []
  const expects: Expect[] = []
  const usedLaw = new Set<string>()
  const usedAnaphor = new Set<string>()
  let lastLawName = ""
  let lastRegName = ""

  while (segments.length < count) {
    const wantAnaphor =
      segments.length > 0 &&
      rng() < 0.4 &&
      ANAPHOR_ATOMS.some((a) => !usedAnaphor.has(a.tag) && (a.needs === "law" ? lastLawName : lastRegName))
    if (wantAnaphor) {
      const candidates = ANAPHOR_ATOMS.filter(
        (a) => !usedAnaphor.has(a.tag) && (a.needs === "law" ? lastLawName : lastRegName)
      )
      const a = pick(rng, candidates)
      usedAnaphor.add(a.tag)
      const antecedent = a.needs === "law" ? lastLawName : lastRegName
      segments.push({ kind: "anaphor", tag: a.tag, text: a.text })
      expects.push({ lawName: a.resolve(antecedent), article: a.article, anaphor: true })
      continue
    }
    const candidates = LAW_ATOMS.filter((d) => !usedLaw.has(d.tag))
    if (candidates.length === 0) break
    const d = pick(rng, candidates)
    usedLaw.add(d.tag)
    segments.push({
      kind: "law",
      tag: d.tag,
      text: renderLaw(d, d.quoted),
      def: d,
      adminLike: d.adminLike,
      quoted: d.quoted,
      multiWord: d.multiWord,
    })
    expects.push({ lawName: lawNameOf(d), article: d.article, anaphor: false })
    if (d.reg) lastRegName = d.name
    else lastLawName = d.name
  }

  const connectors: string[] = []
  for (let i = 1; i < segments.length; i++) connectors.push(pick(rng, CONNECTORS))

  return {
    segments,
    connectors,
    expects,
    atomTags: segments.map((s) => s.tag),
    hasAdminAtom: segments.some((s) => s.adminLike === true),
  }
}

// ── 변형기 ──────────────────────────────────────────────────────────────

/** 어절 경계 soft-wrap — 양옆이 한글인 공백 하나를 개행으로 (문서 줄바꿈) */
function softWrap(text: string, rng: () => number): string | null {
  const spots: number[] = []
  for (let i = 1; i < text.length - 1; i++) {
    if (text[i] === " " && /[가-힣]/.test(text[i - 1]) && /[가-힣]/.test(text[i + 1])) spots.push(i)
  }
  if (spots.length === 0) return null
  const at = pick(rng, spots)
  return `${text.slice(0, at)}\n${text.slice(at + 1)}`
}

/** 낱말 안 줄바꿈 — 한글 연속 구간 안쪽을 끊는다 ("시⏎행령"). 조문 토큰은 건드리지 않는다 */
function inWordBreak(text: string, rng: () => number): string | null {
  const head = text.replace(/\s*제\s*\d+\s*조(?:의\s*\d+)?\s*$/, "")
  if (head.length === 0) return null
  const spots: number[] = []
  for (const m of head.matchAll(/[가-힣]{3,}/g)) {
    for (let k = 1; k < m[0].length; k++) spots.push(m.index! + k)
  }
  if (spots.length === 0) return null
  const at = pick(rng, spots)
  return `${text.slice(0, at)}\n${text.slice(at)}`
}

/** 「」 감싸기 / 벗기기 */
function toggleQuote(seg: Segment): string {
  if (!seg.def) return seg.text
  return renderLaw(seg.def, !seg.quoted)
}

// ── 케이스 조립 ─────────────────────────────────────────────────────────

const COMBOS: readonly (readonly string[])[] = [
  [],
  ["crlf"],
  ["cr"],
  ["softwrap"],
  ["inword"],
  ["title"],
  ["mdlist"],
  ["quotewrap"],
  ["pareninsert"],
  ["parennest"],
  ["crlf", "softwrap"],
  ["crlf", "inword"],
  ["softwrap", "inword"],
  ["title", "softwrap"],
  ["mdlist", "crlf"],
  ["mdlist", "softwrap"],
  ["quotewrap", "softwrap"],
  ["pareninsert", "crlf"],
  ["parennest", "softwrap"],
  ["cr", "inword"],
  ["title", "inword"],
]

const CASES_PER_COMBO = 16

function buildCase(comboIdx: number, n: number, rng: () => number): FuzzCase {
  const combo = COMBOS[comboIdx]
  const comboId = combo.length === 0 ? "none" : combo.join("+")
  const built = buildSentence(rng)
  const segments = built.segments.map((s) => ({ ...s }))
  const connectors = [...built.connectors]
  const expects = built.expects.map((e) => ({ ...e }))
  let mutatedTag: string | undefined

  // 「」 감싸기/벗기기 — 무작위 법령 원자 하나
  if (combo.includes("quotewrap")) {
    const idxs = segments.map((s, i) => (s.kind === "law" ? i : -1)).filter((i) => i >= 0)
    if (idxs.length > 0) {
      const i = pick(rng, idxs)
      segments[i].text = toggleQuote(segments[i])
      segments[i].quoted = !segments[i].quoted
      mutatedTag = segments[i].tag
    }
  }

  // 괄호 중첩 — "법인세법(지방세법 제103조) 제26조" (바깥 매치가 괄호를 삼키는 형태)
  if (combo.includes("parennest")) {
    const idxs = segments
      .map((s, i) => (s.kind === "law" && s.quoted !== true && s.adminLike !== true ? i : -1))
      .filter((i) => i >= 0)
    if (idxs.length > 0) {
      const i = pick(rng, idxs)
      const inner = pick(rng, PAREN_ONLY)
      const def = segments[i].def!
      segments[i].text = `${lawNameOf(def)}(${inner.name} ${inner.article}) ${def.article}`
      expects.push({ lawName: inner.name, article: inner.article, anaphor: false })
      mutatedTag = segments[i].tag
    }
  }

  // 조응 앞 괄호 안 「」 인용 — 선행사 오염 유도 (괄호 안 인용은 선행사가 되지 않는다)
  if (combo.includes("pareninsert")) {
    const idxs = segments.map((s, i) => (s.kind === "anaphor" ? i : -1)).filter((i) => i >= 0)
    if (idxs.length > 0) {
      const i = pick(rng, idxs)
      const inner = pick(rng, PAREN_ONLY)
      segments[i].text = `(「${inner.name}」 ${inner.article} 참조) ${segments[i].text}`
      expects.push({ lawName: inner.name, article: inner.article, anaphor: false })
      mutatedTag = segments[i].tag
    }
  }

  if (combo.includes("softwrap")) {
    const idxs = segments.map((s, i) => (s.kind === "law" ? i : -1)).filter((i) => i >= 0)
    for (const i of shuffled(idxs, rng)) {
      const next = softWrap(segments[i].text, rng)
      if (next) {
        segments[i].text = next
        mutatedTag = segments[i].tag
        break
      }
    }
  }

  if (combo.includes("inword")) {
    const idxs = segments.map((s, i) => (s.kind === "law" ? i : -1)).filter((i) => i >= 0)
    for (const i of shuffled(idxs, rng)) {
      const next = inWordBreak(segments[i].text, rng)
      if (next) {
        segments[i].text = next
        mutatedTag = segments[i].tag
        break
      }
    }
  }

  let text = segments[0].text
  for (let i = 1; i < segments.length; i++) text += connectors[i - 1] + segments[i].text
  text += "를 참조한다."

  // 구두점 없는 평문 제목 줄이 바로 위에 붙는 경우 (문서에서 흔한 형태)
  if (combo.includes("title")) text = `${pick(rng, TITLES)}\n${text}`
  // 마크다운 목록·헤더 접두
  if (combo.includes("mdlist")) text = `${pick(rng, MD_PREFIXES)}${text}`
  // 개행 표기
  if (combo.includes("crlf")) text = text.replace(/\n/g, "\r\n")
  if (combo.includes("cr")) text = text.replace(/\n/g, "\r")

  return {
    id: `${comboId}#${n}`,
    comboId,
    combo,
    text,
    expects,
    atomTags: built.atomTags,
    hasAdminAtom: built.hasAdminAtom,
    mutatedTag,
  }
}

function shuffled<T>(arr: readonly T[], rng: () => number): T[] {
  const out = [...arr]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

function buildCases(): FuzzCase[] {
  const rng = mulberry32(SEED)
  const cases: FuzzCase[] = []
  for (let ci = 0; ci < COMBOS.length; ci++) {
    for (let n = 0; n < CASES_PER_COMBO; n++) cases.push(buildCase(ci, n, rng))
  }
  return cases
}

// ── 채점 ────────────────────────────────────────────────────────────────

const ANAPHOR_RAW_RE = /^(?:구\s+)?(?:같은|동)\s*(?:법|영|시행령|시행규칙|규칙|규정)/

type FailureClass = "추출 0건" | "엉뚱한 법령 확신" | "없는 법령명 생성" | "인용 누락" | "건수 불일치"

interface CaseResult {
  case: FuzzCase
  ok: boolean
  cls?: FailureClass
  total: number
  got: Array<{ lawName: string; article: string; raw: string }>
  missing: Expect[]
  unexpected: Array<{ lawName: string; article: string; raw: string }>
  /** lawName은 틀렸지만 uncut(컷 전 이름)이 기대와 일치 — 검증 단계가 재시도로 구제하는 경로 */
  uncutFallback: number
}

function runCase(c: FuzzCase): CaseResult {
  const { citations, total } = extractCitationsWithTotal(c.text)
  const want = new Map<string, number>()
  for (const e of c.expects) {
    const k = `${compact(e.lawName)}|${e.article}`
    want.set(k, (want.get(k) ?? 0) + 1)
  }
  const got = citations.map((x) => ({ lawName: x.lawName, article: x.article ?? "", raw: x.raw }))
  const unexpected: CaseResult["unexpected"] = []
  let uncutFallback = 0
  for (const x of citations) {
    const primary = `${compact(x.lawName)}|${x.article ?? ""}`
    if ((want.get(primary) ?? 0) > 0) {
      want.set(primary, want.get(primary)! - 1)
      continue
    }
    const alt = x.uncut ? `${compact(x.uncut)}|${x.article ?? ""}` : ""
    if (alt && (want.get(alt) ?? 0) > 0) {
      want.set(alt, want.get(alt)! - 1)
      uncutFallback++
      continue
    }
    unexpected.push({ lawName: x.lawName, article: x.article ?? "", raw: x.raw })
  }
  const missing: Expect[] = []
  for (const e of c.expects) {
    const k = `${compact(e.lawName)}|${e.article}`
    const left = want.get(k) ?? 0
    if (left > 0) {
      missing.push(e)
      want.set(k, left - 1)
    }
  }

  const countMismatch = total !== c.expects.length
  const ok = !countMismatch && unexpected.length === 0 && missing.length === 0
  let cls: FailureClass | undefined
  if (!ok) {
    if (total === 0 && c.expects.length > 0) cls = "추출 0건"
    else if (unexpected.some((u) => ANAPHOR_RAW_RE.test(u.raw) && u.lawName !== "")) cls = "엉뚱한 법령 확신"
    else if (unexpected.some((u) => u.lawName !== "")) cls = "없는 법령명 생성"
    else if (missing.length > 0) cls = "인용 누락"
    else cls = "건수 불일치"
  }
  return { case: c, ok, cls, total, got, missing, unexpected, uncutFallback }
}

// ── 알려진 실패 (제외 목록) ─────────────────────────────────────────────
// 각 항목은 **현재 추출기가 실제로 뚫리는 지점**이다. 통과시키려고 둔 것이 아니라
// 고칠 때까지 녹색을 유지하되 사라지지 않게 박아 두는 것이다.
// 사유 없는 제외 금지 / 항목마다 실패 예시 1개 / 스테일 제외는 아래 테스트가 잡는다.

interface Exclusion {
  id: string
  reason: string
  example: string
  match: (r: CaseResult) => boolean
}

const EXCLUSIONS: Exclusion[] = [
  {
    id: "mdlist+softwrap",
    reason:
      "마크다운 목록·헤더 라인은 joinWrappedLines의 경계라 줄 잇기를 하지 않는다. " +
      "목록 항목 안에서 법령명이 줄바꿈되면 인용이 통째로 추출되지 않는다(0건 → 훅 통과). " +
      "MD_STRUCT_LINE_RE는 '제목 흡수'(차단 1) 재발 방지용이라, 반대 방향인 이 케이스가 열려 있다.",
    example: "- 국가를 당사자로 하는 계약에 관한\\n법률 제7조 → 추출 0건",
    // 실패한 사례만 덮는다 — 통과하는 사례까지 덮으면 "제외는 최소" 게이트가
    // 실제 결함 규모가 아니라 매처의 헐거움을 재게 된다
    match: (r) => !r.ok && r.case.comboId === "mdlist+softwrap",
  },
  {
    id: "title+행정규칙",
    reason:
      "구두점 없는 평문 제목이 바로 위 줄에 있으면 joinWrappedLines가 제목을 문장에 잇는다. " +
      "법령 경로(LAW_ARTICLE_RE)는 이음새 뒤 이름을 우선 쓰는 복구(joins·uncut)가 있으나 " +
      "행정규칙·규정 경로(ADMIN_ARTICLE_RE)에는 그 복구가 없어 제목이 규칙명에 흡수된다. " +
      "verify.ts 603행 주석이 '규정류는 복구 수단이 없다'고 이미 인정한 자리다.",
    example: "2026년 세무 검토 대상\\n국세청 조사사무처리규정 제41조 → lawName '2026년 세무 검토 대상 국세청 조사사무처리규정'",
    match: (r) => !r.ok && r.case.combo.includes("title") && r.case.hasAdminAtom,
  },
  {
    id: "이음새절단",
    reason:
      "줄 잇기 이음새가 법령명 안쪽이면 extractPass가 **이음새 뒤 이름을 우선**한다(verify.ts 432~440행). " +
      "제목 흡수(차단 1) 재발을 막으려 넣은 규칙인데 정상 soft-wrap된 다중어절 법령명에도 그대로 걸려 " +
      "「주식회사 등의 외부감사에 관한 법률」이 「관한 법률」로, 「법인세법」이 「세법」으로 앞에서 잘린다. " +
      "사전 최장 일치(KNOWN_LAW_NAMES, 208~226행)가 이미 정식 명칭을 확정한 뒤에도 덮어쓴다. " +
      "복구 경로 세 개가 모두 닫혀 있다: ①uncut이 trimToLawName **이전** 값이라 문맥 어절을 달고 있어" +
      "('제23조와 근로자퇴직급여 보장법') findVerifyTarget의 재조회도 0건 ②조응 인용에는 uncut이 아예 없다 " +
      "③낱말 안쪽 해석(tight)이 옳은 이름을 만들어도 mergeTightPass의 sameCitation 접미 endsWith 규칙" +
      "(386~394행)이 '같은 인용'으로 보고 잘린 primary를 채택한다. 잘린 이름이 antecedent로 새어(476행) " +
      "조응까지 오염되지만, 잘린 이름은 resolvedLawMatches를 통과하지 못하므로 판정은 ✗·⚠ 쪽이다 — " +
      "정상 인용에 낙인이 찍히는 방향이지 엉뚱한 법령에 ✓가 나가는 방향은 아니다.",
    example:
      "주식회사 등의 외부감사에\\n관한 법률 시행령 제5조와 같은 법 시행령 제163조 → " +
      "둘 다 lawName '관한 법률 시행령' (조응은 uncut도 없어 복구 불가)",
    match: (r) =>
      !r.ok &&
      (r.case.combo.includes("softwrap") || r.case.combo.includes("inword")) &&
      r.unexpected.some((u) =>
        r.case.expects.some(
          (e) =>
            e.article === u.article &&
            compact(e.lawName) !== compact(u.lawName) &&
            compact(e.lawName).endsWith(compact(u.lawName))
        )
      ),
  },
]

function excludedBy(r: CaseResult): Exclusion | undefined {
  return EXCLUSIONS.find((e) => e.match(r))
}

// ── 보고서 ──────────────────────────────────────────────────────────────

function renderReport(results: CaseResult[]): string {
  const failures = results.filter((r) => !r.ok)
  const byClass = new Map<string, CaseResult[]>()
  for (const f of failures) {
    const k = f.cls ?? "?"
    byClass.set(k, [...(byClass.get(k) ?? []), f])
  }
  const order: FailureClass[] = ["엉뚱한 법령 확신", "추출 0건", "없는 법령명 생성", "인용 누락", "건수 불일치"]
  const lines: string[] = []
  lines.push("# fin_verify 인용 추출 퍼즈 실패 전량")
  lines.push("")
  lines.push(`- 시드: ${SEED} / 사례 ${results.length}건 / 실패 ${failures.length}건`)
  lines.push(`- 약한 통과(uncut 폴백으로만 일치): ${results.reduce((a, r) => a + r.uncutFallback, 0)}건`)
  lines.push("")
  for (const cls of order) {
    const rows = byClass.get(cls)
    if (!rows || rows.length === 0) continue
    lines.push(`## ${cls} (${rows.length}건)`)
    lines.push("")
    lines.push("| 케이스 | 변형 | 입력 | 기대 | 실제 |")
    lines.push("| --- | --- | --- | --- | --- |")
    for (const r of rows) {
      const want = r.case.expects.map((e) => `${e.lawName} ${e.article}`).join(" / ")
      const got = r.got.map((g) => `${g.lawName || "(빈 법령명)"} ${g.article}`).join(" / ") || "(0건)"
      const ex = excludedBy(r)
      lines.push(
        `| ${r.case.id}${ex ? ` (제외: ${ex.id})` : ""} | ${r.case.comboId} | \`${JSON.stringify(r.case.text)}\` | ${want} | ${got} |`
      )
    }
    lines.push("")
  }
  lines.push("## 제외 목록")
  lines.push("")
  for (const e of EXCLUSIONS) {
    lines.push(`### ${e.id}`)
    lines.push("")
    lines.push(e.reason)
    lines.push("")
    lines.push(`예시: \`${e.example}\``)
    lines.push("")
  }
  return lines.join("\n")
}

// ── 테스트 ──────────────────────────────────────────────────────────────

describe("extractCitationsWithTotal 퍼즈 — 표기 변형은 인용의 내용을 바꾸지 않는다", () => {
  const cases = buildCases()
  const results = cases.map(runCase)

  it(`사례 ${cases.length}건 (시드 ${SEED}) — 기대 인용이 그대로 추출된다`, () => {
    const reportPath = process.env.FIN_FUZZ_REPORT
    if (reportPath) {
      mkdirSync(dirname(reportPath), { recursive: true })
      writeFileSync(reportPath, renderReport(results), "utf8")
    }
    const active = results.filter((r) => !r.ok && !excludedBy(r))
    const summary = active.map((r) => ({
      케이스: r.case.id,
      분류: r.cls,
      입력: r.case.text,
      기대: r.case.expects.map((e) => `${e.lawName} ${e.article}`),
      실제: r.got.map((g) => `${g.lawName || "(빈 법령명)"} ${g.article}`),
    }))
    expect(summary).toEqual([])
  })

  it("사례 수·실행 범위 — 300건 이상, 모든 변형 조합이 실제로 생성된다", () => {
    expect(cases.length).toBeGreaterThanOrEqual(300)
    const combos = new Set(cases.map((c) => c.comboId))
    expect(combos.size).toBe(COMBOS.length)
    // 조응이 실제로 섞였는지 — 조응 없는 퍼즈는 선행사 해소를 전혀 검사하지 못한다
    const anaphorCases = cases.filter((c) => c.expects.some((e) => e.anaphor))
    expect(anaphorCases.length).toBeGreaterThan(50)
  })

  it("제외 목록이 스테일이 아니다 — 각 항목이 실제 실패를 최소 1건 덮는다", () => {
    // 추출기가 고쳐지면 이 테스트가 먼저 깨진다. 제외를 지우라는 신호다
    const stale = EXCLUSIONS.filter((e) => !results.some((r) => !r.ok && e.match(r)))
    expect(stale.map((e) => e.id)).toEqual([])
  })

  it("제외 목록은 최소여야 한다 — 제외로 덮이는 사례가 전체의 15%를 넘지 않는다", () => {
    // 이 게이트가 한 번 제 몫을 했다. 분류 시점의 실패는 60/336 = 17.9%였고 상한 안에서는
    // 전 실패를 제외할 수 없었다 — "제외를 줄여라"가 아니라 **"추출기를 고쳐라"**는 신호였다.
    // 차단급 2건(조응 선행사 역전 / 행정규칙명의 앞 인용 흡수)을 고쳐 44건(13.1%)이 되어
    // 원래 상한으로 되돌렸다. 남은 44건은 전부 '이음새절단' 계열(v0.2 재구조화 대상)이다.
    // 매처는 전부 !r.ok로 묶여 있어 통과하는 사례는 한 건도 덮지 않는다 — 이 비율은
    // 매처의 헐거움이 아니라 추출기의 실제 결함 규모다. 다시 넘치면 상한을 올리지 말고 고칠 것.
    const covered = results.filter((r) => excludedBy(r) !== undefined).length
    expect(covered / results.length).toBeLessThan(0.15)
  })
})

describe("퍼즈 회귀 — 과거 차단급 4건의 변형이 사례에 실제로 포함된다", () => {
  const cases = buildCases()

  it("CRLF·낱말 안 줄바꿈·어절 soft-wrap·괄호 조응 오염이 모두 생성된다", () => {
    const has = (id: string) => cases.some((c) => c.comboId === id)
    expect(has("crlf")).toBe(true)
    expect(has("inword")).toBe(true)
    expect(has("softwrap")).toBe(true)
    expect(has("pareninsert")).toBe(true)
    expect(has("crlf+inword")).toBe(true)
  })
})
