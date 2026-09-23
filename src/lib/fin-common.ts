/**
 * fin-law-mcp 공용 유틸 — 재무 도메인 지식과 부분 실패 계약의 공통 구현
 */

import { extractTag } from "./xml-parser.js"

// ── 부분 실패 계약 ──────────────────────────────────────────────────────
export interface SectionResult {
  status: "성공" | "실패" | "시간초과"
  text: string
  reason?: string
}

export function failed(reason: string): SectionResult {
  return { status: "실패", text: "", reason }
}

/**
 * deadline 내 완료 못 하면 시간초과 처리.
 * onTimeout으로 AbortController.abort를 넘기면 진행 중 호출도 함께 취소된다 —
 * deadline 후 fetch가 백그라운드에서 살아 쿼터를 소모하던 문제 (Opus I3).
 */
export async function withDeadline(
  p: Promise<SectionResult>,
  deadlineAt: number,
  onTimeout?: () => void
): Promise<SectionResult> {
  const remain = deadlineAt - Date.now()
  if (remain <= 0) {
    onTimeout?.()
    return { status: "시간초과", text: "", reason: "도구 deadline 초과" }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<SectionResult>((resolve) => {
    timer = setTimeout(() => {
      onTimeout?.()
      resolve({ status: "시간초과", text: "", reason: `deadline 초과` })
    }, remain)
  })
  try {
    return await Promise.race([p, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// ── 예산 절단 ───────────────────────────────────────────────────────────
// 조문은 앞의 원칙과 뒤의 단서·예외가 한 쌍이다. 문자 수로만 자르면 단서가
// 통째로 사라지고, 남은 절반은 "원칙만 있는 조문"으로 읽혀 오독이 눈에 띄지
// 않는다 (Codex 제품 검토). → 절단 지점을 의미 경계로 당기고, 무엇이 빠졌는지
// 를 고지에 적는다. 우선순위: 항 → 호 → 줄바꿈 → 문장 끝 → 그대로 자르기.
// 단, 당긴 결과가 예산의 60% 미만이면 너무 많이 버리는 것이라 다음 순위로 내려간다.

/** 경계로 당긴 뒤 남아야 하는 최소 비율 — 이보다 짧아지면 다음 우선순위로 */
const TRUNCATE_MIN_RATIO = 0.6

// ⚠ 아래 표지 정규식은 renderArticleUnits(tools/article.ts)의 출력 형식에 묶여 있다.
//   항 = 2칸 들여쓰기 + 원숫자(①) 또는 괄호숫자((①)·(1)), 호 = 4칸 + "N." · "N의M.",
//   목 = 6칸. 렌더러 들여쓰기를 바꾸면 여기도 같이 바꿔야 한다.
/** 항 경계 (조문 경계 "제N조" 포함) */
const HANG_BOUNDARY = /\n(?: {2}\(?(?:[①-⑳㉑-㉟㊱-㊿]|\d+\))|제\d+조(?:의\d+)?)/g
/** 호 경계 */
const HO_BOUNDARY = /\n {4}\d+(?:의\d+)?\./g
/** 문장 끝 "…다." — 앞 글자가 공백이 아닐 것을 요구해 목번호 "다."(들여쓰기 뒤)를 배제한다 */
const SENTENCE_END = /\S다\.(?=\s|$)/g

/** s 안에서 re의 마지막 매치 위치. after=true면 매치 끝, false면 매치 시작 */
function lastBoundary(re: RegExp, s: string, after: boolean): number {
  re.lastIndex = 0
  let cut = -1
  let m: RegExpExecArray | null
  while ((m = re.exec(s)) !== null) {
    cut = after ? m.index + m[0].length : m.index
    if (m[0].length === 0) re.lastIndex++
  }
  return cut
}

/** 잘려나간 부분의 첫 항/호/조 표지 — "무엇이 빠졌는지"를 고지에 적기 위한 것 */
function omittedMarker(rest: string): string {
  const cands: Array<{ at: number; label: string }> = []
  const hang = /\n {2}\(?([①-⑳㉑-㉟㊱-㊿])/.exec(rest)
  if (hang) cands.push({ at: hang.index, label: `${hang[1]}항` })
  const ho = /\n {4}(\d+(?:의\d+)?)\./.exec(rest)
  if (ho) cands.push({ at: ho.index, label: `제${ho[1]}호` })
  const jo = /\n(제\d+조(?:의\d+)?)/.exec(rest)
  if (jo) cands.push({ at: jo.index, label: jo[1] })
  cands.sort((a, b) => a.at - b.at)
  return cands[0]?.label ?? ""
}

export function truncateWithHint(text: string, max: number, hint: string): string {
  if (text.length <= max) return text
  const cap = Math.max(0, max)
  const head = text.slice(0, cap)
  const floor = cap * TRUNCATE_MIN_RATIO

  // 경계 절단(항·호)은 잘린 지점이 곧 다음 단위의 시작이라 "②항부터 생략"이 정확하다.
  // 줄·문장·그대로 자르기는 단위 중간일 수 있어 "이하 생략"으로 약하게 적는다.
  let cut = cap
  let atUnitStart = false
  for (const c of [
    { at: lastBoundary(HANG_BOUNDARY, head, false), unit: true },
    { at: lastBoundary(HO_BOUNDARY, head, false), unit: true },
    { at: head.lastIndexOf("\n"), unit: false },
    { at: lastBoundary(SENTENCE_END, head, true), unit: false },
  ]) {
    if (c.at > 0 && c.at >= floor) {
      cut = c.at
      atUnitStart = c.unit
      break
    }
  }

  const marker = omittedMarker(text.slice(cut))
  const omitted = marker ? (atUnitStart ? `${marker}부터 생략, ` : `${marker} 등 이하 생략, `) : ""
  return (
    text.slice(0, cut).replace(/[ \t\n]+$/, "") +
    `\n… (예산 ${max.toLocaleString()}자 초과로 절단 — ${omitted}전체는 ${hint})`
  )
}

export const SOURCE_FOOTER = "출처: 법제처 국가법령정보센터 · 법적 효력이 필요한 판단에는 원문을 확인하세요"

// ── 축약 재검색 사다리 (자체 패치 #5 원칙: 진짜 0건에만 축약, 오류에는 재시도 금지) ──
/** 축약 시 버리는 어절. ruling-search는 자체 사다리를 쓰므로 이 목록을 직접 참조한다 (복제 금지) */
export const RULING_STOPWORDS = new Set(["등의", "등", "및", "의", "에", "관한", "대한", "따른"])

export function ladderQueries(base: string, maxSteps = 4): string[] {
  const toks = base.split(/\s+/).filter((t) => t && !RULING_STOPWORDS.has(t))
  if (toks.length === 0) return [base]
  // ⚠ 원본을 반드시 1순위로 — 불용어("및"·"관한")가 공식 법령명의 일부인 경우가 있어
  //   ("상속세 및 증여세법" 등) 축약본만 검색하면 공식 명칭을 한 번도 안 친다 (Opus 리뷰 I2)
  const qs: string[] = [base.replace(/\s+/g, " ").trim()]
  // 앞토막 축약 (3→2→1어절) 후, 남은 개별 토큰을 뒤에서부터 폴백
  // (예규 제목 어휘는 조문 제목의 마지막 명사구인 경우가 많다: "손금불산입" 등)
  for (let n = Math.min(toks.length, 3); n >= 1; n--) qs.push(toks.slice(0, n).join(" "))
  for (let i = toks.length - 1; i >= 1; i--) qs.push(toks[i])
  return [...new Set(qs)].slice(0, maxSteps)
}

// ── 국세청 예규 목록 파싱 (ntsCgmExpc) ──────────────────────────────────
export interface NtsRulingItem {
  title: string
  docNo: string
  date: string
  link: string
}

export function parseNtsRulings(xml: string, max: number): NtsRulingItem[] {
  const items: NtsRulingItem[] = []
  const blocks = xml.match(/<cgmExpc [\s\S]*?<\/cgmExpc>/g) || []
  for (const block of blocks.slice(0, max)) {
    items.push({
      title: extractTag(block, "안건명"),
      docNo: extractTag(block, "안건번호"),
      date: extractTag(block, "해석일자"),
      link: extractTag(block, "법령해석상세링크"),
    })
  }
  return items
}

// ── 재무 도메인 사전 ────────────────────────────────────────────────────

/** 재무권 소관부처 코드 (Phase 0 실호출 확정 — phase0/PHASE0_검증기록.md) */
export const FIN_MINISTRY_CODES: Record<string, string> = {
  "1053000": "재정경제부",
  "1210000": "국세청",
  "1220000": "관세청",
  "1741000": "행정안전부",
  "1160100": "금융위원회",
  "1492000": "고용노동부",
}

/** 재무 법령 사전 (06_재무도메인 §3 — 차단이 아닌 가점에만 사용. 목록이 낡아도 결과는 사라지지 않는다) */
export const FIN_LAW_NAMES: string[] = [
  // 국세
  "국세기본법", "국세징수법", "법인세법", "소득세법", "부가가치세법", "조세특례제한법",
  "상속세 및 증여세법", "종합부동산세법", "개별소비세법", "주세법", "인지세법", "증권거래세법",
  "교육세법", "농어촌특별세법", "교통ㆍ에너지ㆍ환경세법", "조세범 처벌법", "조세범 처벌절차법",
  "국제조세조정에 관한 법률", "국세와 지방세의 조정 등에 관한 법률", "부담금관리 기본법",
  // 지방세
  "지방세기본법", "지방세징수법", "지방세법", "지방세특례제한법",
  // 관세·무역·외환
  "관세법", "자유무역협정의 이행을 위한 관세법의 특례에 관한 법률", "대외무역법", "외국환거래법",
  // 회계·감사·공시
  "주식회사 등의 외부감사에 관한 법률", "자본시장과 금융투자업에 관한 법률", "상법", "국가재정법",
  // 인사·급여·4대보험
  "근로기준법", "근로자퇴직급여 보장법", "최저임금법", "임금채권보장법",
  "국민연금법", "국민건강보험법", "고용보험법", "산업재해보상보험법",
  "고용보험 및 산업재해보상보험의 보험료징수 등에 관한 법률",
  "파견근로자 보호 등에 관한 법률", "기간제 및 단시간근로자 보호 등에 관한 법률",
  "남녀고용평등과 일ㆍ가정 양립 지원에 관한 법률",
  // 거래·계약·경쟁
  "독점규제 및 공정거래에 관한 법률", "하도급거래 공정화에 관한 법률",
  "전자상거래 등에서의 소비자보호에 관한 법률", "전자금융거래법", "여신전문금융업법",
  "약관의 규제에 관한 법률", "전자문서 및 전자거래 기본법",
  // 절차·불복
  "행정기본법", "행정절차법", "행정심판법", "행정소송법", "민법", "민사집행법",
]

/** 주제어 → 법령 힌트 (베이스라인 관찰 5: 법령명 LIKE 검색으로는 주제어→법령 도달 불가) */
export const TOPIC_LAW_HINTS: Array<{ pattern: RegExp; laws: string[] }> = [
  { pattern: /취득세|등록면허세|재산세|주민세|지방소득세/, laws: ["지방세법", "지방세특례제한법"] },
  { pattern: /감가상각|내용연수/, laws: ["법인세법", "법인세법 시행령", "법인세법 시행규칙"] },
  { pattern: /접대비|기업업무추진비/, laws: ["법인세법", "조세특례제한법"] },
  { pattern: /퇴직금|퇴직급여|퇴직연금/, laws: ["근로자퇴직급여 보장법", "법인세법 시행령", "소득세법"] },
  { pattern: /원천징수|연말정산/, laws: ["소득세법", "소득세법 시행령"] },
  { pattern: /매입세액|세금계산서|영세율/, laws: ["부가가치세법"] },
  { pattern: /이전가격|국외특수관계/, laws: ["국제조세조정에 관한 법률"] },
  { pattern: /배당|자기주식|감자/, laws: ["상법", "법인세법", "소득세법"] },
  { pattern: /외부감사|감사인/, laws: ["주식회사 등의 외부감사에 관한 법률"] },
  { pattern: /해외송금|외환|환전|해외직접투자/, laws: ["외국환거래법"] },
  { pattern: /세액공제|세액감면|중소기업.*감면/, laws: ["조세특례제한법"] },
  { pattern: /증여|상속/, laws: ["상속세 및 증여세법"] },
  { pattern: /4대보험|고용보험료|산재보험료/, laws: ["고용보험 및 산업재해보상보험의 보험료징수 등에 관한 법률", "국민연금법", "국민건강보험법"] },
  { pattern: /가산세|수정신고|경정청구/, laws: ["국세기본법"] },
]

/** 가운뎃점·공백을 무시한 압축 비교용 */
export function compactName(s: string): string {
  return (s || "").replace(/[·ㆍ‧•・\s]/g, "")
}

const FIN_LAW_COMPACT = new Set(FIN_LAW_NAMES.map(compactName))

/** 재무 법령 사전 매칭 (본법뿐 아니라 시행령·시행규칙도 인정) */
export function isFinLaw(lawName: string): boolean {
  const c = compactName(lawName).replace(/(시행령|시행규칙)$/, "")
  return FIN_LAW_COMPACT.has(c)
}

// ── 시행예정 개정 감지 (eflaw 검색의 현행연혁코드=시행예정 행) ──────────
// 세법은 개정이 공포된 뒤 시행까지 시차가 있다. 이미 공포된 미래 개정을
// 모르고 현행 조문만 보면 개정 직전 검토에서 사고가 난다 — 경고를 동봉한다.

export interface UpcomingVersion {
  시행일자: string
  /** 이 시행일에 걸린 공포본의 공포일자 (최근 → 과거, 중복 제거) */
  공포일자: string[]
}

/**
 * ⚠ `현행연혁코드=시행예정`만 믿으면 안 된다 — 법제처는 **시행일이 이미 지난 행**에도
 * 시행예정 코드를 남기고, 공포본마다 슬라이스를 따로 둬 같은 시행일이 여러 행으로 온다.
 * 실측(2026-09-16, 소득세법 시행령 display 20): 현행 시행일 2026-07-01인데 "2026-07-01 시행
 * 예정" 4행 + 2027-01-01 6행 + 2028-01-01 1행 → 이미 시행된 개정이 "개정 예정"으로 4번 나열됐다.
 * 그래서 시행일이 오늘(KST)보다 뒤인 행만 남기고(fin_law_search의 📅시행예정과 같은 기준),
 * 같은 시행일은 하나로 접는다.
 */
export function parseUpcomingVersions(xml: string, lawName: string): UpcomingVersion[] {
  const blocks = xml.match(/<law [\s\S]*?<\/law>/g) || []
  const target = compactName(lawName)
  const byDate = new Map<string, Set<string>>()
  for (const b of blocks) {
    const name = extractTag(b, "법령명한글")
    if (compactName(name) !== target) continue
    if (extractTag(b, "현행연혁코드") !== "시행예정") continue
    const efYd = extractTag(b, "시행일자")
    if (!isFutureDate(efYd)) continue
    const set = byDate.get(efYd) || new Set<string>()
    const ancYd = extractTag(b, "공포일자")
    if (ancYd) set.add(ancYd)
    byDate.set(efYd, set)
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([efYd, set]) => ({ 시행일자: efYd, 공포일자: [...set].sort().reverse() }))
}

export function formatYmd(yyyymmdd: string): string {
  return /^\d{8}$/.test(yyyymmdd) ? `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}` : yyyymmdd
}

// ── 전거 서열 (재무·세무 실무의 근거 우선순위 — 답변 신뢰도의 뼈대) ──────
export const AUTHORITY_FOOTER =
  "※ 전거 서열(높음→낮음): 법령 조문(법률·시행령·시행규칙) > 대법원 판례 > 심판례·유권해석 > 예규(행정해석 — 구속력 없음). 상충 시 상위 전거 우선"

/**
 * YYYYMMDD가 달력에 실재하는 날짜인가 — 형식만 맞고 존재하지 않는 값을 거른다.
 *
 * 문자열 비교만 하면 "20261345"·"20270229"가 오늘보다 커서 "시행예정"이 된다. 그런 값이 왔다는
 * 것은 시행일 태그를 잘못 읽었다는 뜻이라(응답 형식 변경·다른 태그 혼입) 시행예정의 근거로 쓸 수
 * 없다. Date.UTC 왕복 비교라 윤년도 정확하다 (ruling-search.ts isSortableDate와 같은 방식).
 * ⚠ Date.UTC는 0~99년을 1900년대로 옮기므로 그 범위의 연도는 왕복에서 걸려 false가 된다 —
 *   법령 시행일에 나올 수 없는 값이라 그대로 둔다.
 */
function isRealYmd(yyyymmdd: string): boolean {
  if (!/^\d{8}$/.test(yyyymmdd)) return false
  const y = Number(yyyymmdd.slice(0, 4))
  const m = Number(yyyymmdd.slice(4, 6))
  const d = Number(yyyymmdd.slice(6, 8))
  const probe = new Date(Date.UTC(y, m - 1, d))
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d
}

/** basis_date 달력 검증 거절 문구 — 5개 도구(article·law_search·ruling_search·topic·verify) 공통 */
export const BASIS_DATE_CALENDAR_MESSAGE = "기준일이 달력에 없는 날짜입니다 (예: 2024-02-30·2023-02-29·2026-13-01) — 실제 날짜를 YYYY-MM-DD로 지정하세요"

/**
 * basis_date(YYYY-MM-DD) 달력 검증 — zod `.refine`용.
 *
 * 스키마가 형식 regex만 봐서 2024-02-30·2026-13-01이 통과해 법제처 efYd로 그대로 나갔다
 * (improvement-candidates B3). 형식이 틀린 값은 true를 돌려 각 스키마의 기존 형식 메시지
 * 한 줄만 나가게 하고(중복 오류 방지), 형식이 맞는 값만 isRealYmd(윤년 포함)로 거른다.
 */
export function isCalendarBasisDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return true
  return isRealYmd(value.replace(/-/g, ""))
}

/**
 * YYYYMMDD → 오늘(한국 시간) 이후면 true (시행예정 판정).
 * 법령 시행일은 KST 날짜다 — 호스트 로컬 시간대로 "오늘"을 잡으면 UTC 서버에서
 * 1월 1일 0시~9시(KST)에 당일 시행 법령이 "시행예정"으로 보인다 (9차 리뷰 I2)
 *
 * 형식 검사만으로는 부족하다 — 달력에 없는 날짜는 오늘보다 "큰" 문자열이라 전부 시행예정이 됐다.
 * 소비자 셋 다 이 false를 "시행예정이 아니다"로 읽으면 맞다: parseUpcomingVersions(:261)는 그 행을
 * 개정 예정 목록에서 빼고, fin_law_search(law-search.ts:120)와 fin_article(article.ts:1194)은
 * 📅시행예정 딱지를 붙이지 않는다 — 셋 다 "읽을 수 없는 시행일로 예정을 단정하지 않는다"가 맞다.
 */
export function isFutureDate(yyyymmdd: string): boolean {
  if (!isRealYmd(yyyymmdd || "")) return false
  const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, "")
  return yyyymmdd > today
}
