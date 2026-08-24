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

export function truncateWithHint(text: string, max: number, hint: string): string {
  if (text.length <= max) return text
  return text.slice(0, max) + `\n… (예산 ${max.toLocaleString()}자 초과로 절단 — 전체는 ${hint})`
}

export const SOURCE_FOOTER = "출처: 법제처 국가법령정보센터 · 법적 효력이 필요한 판단에는 원문을 확인하세요"

// ── 축약 재검색 사다리 (자체 패치 #5 원칙: 진짜 0건에만 축약, 오류에는 재시도 금지) ──
const RULING_STOPWORDS = new Set(["등의", "등", "및", "의", "에", "관한", "대한", "따른"])

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
  공포일자: string
}

export function parseUpcomingVersions(xml: string, lawName: string): UpcomingVersion[] {
  const blocks = xml.match(/<law [\s\S]*?<\/law>/g) || []
  const target = compactName(lawName)
  const out: UpcomingVersion[] = []
  for (const b of blocks) {
    const name = extractTag(b, "법령명한글")
    if (compactName(name) !== target) continue
    if (extractTag(b, "현행연혁코드") !== "시행예정") continue
    out.push({ 시행일자: extractTag(b, "시행일자"), 공포일자: extractTag(b, "공포일자") })
  }
  out.sort((a, b) => (a.시행일자 < b.시행일자 ? -1 : 1))
  return out
}

export function formatYmd(yyyymmdd: string): string {
  return /^\d{8}$/.test(yyyymmdd) ? `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}` : yyyymmdd
}

// ── 전거 서열 (재무·세무 실무의 근거 우선순위 — 답변 신뢰도의 뼈대) ──────
export const AUTHORITY_FOOTER =
  "※ 전거 서열(높음→낮음): 법령 조문(법률·시행령·시행규칙) > 대법원 판례 > 심판례·유권해석 > 예규(행정해석 — 구속력 없음). 상충 시 상위 전거 우선"

/** YYYYMMDD → 오늘 이후면 true (시행예정 판정) */
export function isFutureDate(yyyymmdd: string): boolean {
  if (!/^\d{8}$/.test(yyyymmdd || "")) return false
  const now = new Date()
  const today = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`
  return yyyymmdd > today
}
