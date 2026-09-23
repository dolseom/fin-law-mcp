/**
 * 연혁 조회 유틸 — 기준일 시점 법령 버전 해소(eflaw 시행 슬라이스)
 */
import type { LawApiClient } from "./api-client.js"
import { extractTag } from "./xml-parser.js"

export interface HistoricalVersion {
  mst: string
  efYd: string  // 시행일자 (YYYYMMDD)
  ancNo: string
  ancYd: string
  lawNm: string
  rrCls: string
}

/** eflaw 검색의 시행 슬라이스 한 건 (HistoricalVersion과 동일 형상) */
export type EffectiveSlice = HistoricalVersion

const SLICE_LAW_RE = /<law[^>]*>([\s\S]*?)<\/law>/g

/**
 * eflaw(시행일 기준) 검색 XML → 대상 법령의 시행 슬라이스 목록 (시행일·공포일·공포번호 내림차순).
 * lsHistory는 공포단위 1행이라 한 공포본의 조항별 분리시행(단계 시행일)이 보이지 않는다 —
 * 예: 소득세법 법률 제9897호는 시행일이 4개(2009.12.31./2010.1.1./2010.4.1./2010.7.1.)인데
 * lsHistory엔 2010.1.1. 한 행뿐. eflaw는 슬라이스마다 한 행씩 반환한다.
 */
export function parseEffectiveSlices(xmlText: string, lawName: string): EffectiveSlice[] {
  const normalizedTarget = lawName.replace(/\s/g, "")
  const out: EffectiveSlice[] = []
  let m
  while ((m = SLICE_LAW_RE.exec(xmlText)) !== null) {
    const c = m[1]
    const lawNm = extractTag(c, "법령명한글")
    if (!lawNm || lawNm.replace(/\s/g, "") !== normalizedTarget) continue
    const efYd = extractTag(c, "시행일자")
    const mst = extractTag(c, "법령일련번호")
    if (!/^\d{8}$/.test(efYd) || !mst) continue
    const ancNoRaw = extractTag(c, "공포번호")
    out.push({
      mst,
      efYd,
      // eflaw 공포번호는 0패딩("09897") — lsHistory 표기와 맞춰 정수화
      ancNo: ancNoRaw ? String(parseInt(ancNoRaw, 10)) : "",
      ancYd: extractTag(c, "공포일자"),
      lawNm,
      rrCls: extractTag(c, "제개정구분명"),
    })
  }
  out.sort((a, b) =>
    parseInt(b.efYd || "0", 10) - parseInt(a.efYd || "0", 10) ||
    parseInt(b.ancYd || "0", 10) - parseInt(a.ancYd || "0", 10) ||
    parseInt(b.ancNo || "0", 10) - parseInt(a.ancNo || "0", 10))
  return out
}

/**
 * fromYmd~toYmd 구간에 시행일이 있는 대상 법령의 슬라이스 조회 (eflaw efYd 범위 검색).
 * applicable_law의 분리시행 보정용 — 실패는 호출부에서 보수적으로 무시한다.
 */
export async function fetchEffectiveSlices(
  apiClient: LawApiClient,
  lawName: string,
  fromYmd: string,
  toYmd: string,
  apiKey?: string,
  signal?: AbortSignal
): Promise<EffectiveSlice[]> {
  const xml = await apiClient.fetchApi({
    endpoint: "lawSearch.do",
    target: "eflaw",
    type: "XML",
    extraParams: { query: lawName, display: "100", efYd: `${fromYmd}~${toYmd}` },
    apiKey,
    signal,
  })
  return parseEffectiveSlices(xml, lawName)
}

/** 기준일 시점에 시행 중이던 법령 버전 */
export interface VersionAtResult {
  /** 기준일 이하 최신 시행본. 못 찾으면 undefined (호출부는 ⚠로 고지할 것) */
  slice?: EffectiveSlice
  /** 후보를 못 찾은 사유 — 응답에 그대로 실어 조용한 실패를 막는다 */
  reason?: string
}

/**
 * 기준일 시점에 시행 중이던 법령 버전을 해소한다.
 *
 * 왜 필요한가 (실측 2026-08-25):
 *  - 검색 API에 **단일 efYd를 주면 조용히 무시**된다 (efYd=20200101 결과 = efYd 없음 결과).
 *    범위 문법(`from~to`)만 실제 필터로 동작한다.
 *  - 조회 API에 **현행 MST + 과거 efYd**를 주면 빈 응답이 온다.
 *    → 기준일 버전의 MST를 먼저 확보해야 그 시점 조문을 볼 수 있다.
 * 이 두 가지 때문에 "기준일을 그대로 efYd에 넘기는" 방식은 동작하지 않는다.
 */
export async function resolveVersionAt(
  apiClient: LawApiClient,
  lawName: string,
  basisYmd: string,
  apiKey?: string,
  signal?: AbortSignal
): Promise<VersionAtResult> {
  let slices: EffectiveSlice[]
  try {
    // 1900년부터 기준일까지 — 법제처 display 상한(100)에 걸려도 기준일에 가까운
    // 슬라이스가 반환분에 포함된다(실측 3케이스). 못 찾으면 아래에서 정직하게 고지한다.
    slices = await fetchEffectiveSlices(apiClient, lawName, "19000101", basisYmd, apiKey, signal)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { reason: `기준일 버전 조회 실패 (${msg})` }
  }
  // parseEffectiveSlices는 시행일 내림차순 정렬 — 기준일 이하 첫 항목이 그 시점 현행
  const eligible = slices.filter((s) => s.efYd <= basisYmd)
  if (eligible.length === 0) {
    return {
      reason:
        slices.length === 0
          ? `기준일 이전 시행 이력을 찾지 못함 (법령명 표기 또는 기준일이 제정 이전인지 확인)`
          : `기준일 이하 시행본 없음 (검색 상한에 걸렸을 수 있음)`,
    }
  }
  return { slice: eligible[0] }
}
