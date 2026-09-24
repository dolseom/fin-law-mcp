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

/** eflaw 검색 한 페이지의 건수 — 법제처 display 상한 */
const SLICE_PAGE_SIZE = 100
/** 기준일 해소 한 번의 요청 예산(구간·페이지 합계) — 넘으면 확정 불가 (분당 30회 한도·6초 예산 보호) */
const SLICE_MAX_PAGES = 6

/** eflaw 검색 한 페이지 — 슬라이스 외에 전체 수신 여부 판정에 필요한 원시 건수·총건수를 함께 */
interface SlicePage {
  slices: EffectiveSlice[]
  /** 이 페이지의 <law> 블록 수 (대상 법령 필터 전) — totalCnt는 검색어에 걸린 전 법령(시행령 등 포함)의 수다 */
  rawCount: number
  /** 응답 totalCnt — 태그가 없거나 숫자가 아니면 undefined (0으로 지어내면 "전부 받음"으로 오판) */
  totalCnt?: number
}

function readTotalCnt(xml: string): number | undefined {
  const raw = extractTag(xml, "totalCnt").trim()
  if (!/^\d+$/.test(raw)) return undefined
  const n = Number(raw)
  return Number.isSafeInteger(n) ? n : undefined
}

async function fetchSlicePage(
  apiClient: LawApiClient,
  lawName: string,
  fromYmd: string,
  toYmd: string,
  page: number,
  apiKey?: string,
  signal?: AbortSignal
): Promise<SlicePage> {
  const extraParams: Record<string, string> = { query: lawName, display: String(SLICE_PAGE_SIZE), efYd: `${fromYmd}~${toYmd}` }
  // 1페이지는 page를 붙이지 않는다 — 종전 URL(캐시 키)과 같게 둔다. 이름은 api-client의
  // lawSearch.do page 파라미터와 같다 (eflaw에서의 동작은 라이브 확인 필요)
  if (page > 1) extraParams.page = String(page)
  const xml = await apiClient.fetchApi({
    endpoint: "lawSearch.do",
    target: "eflaw",
    type: "XML",
    extraParams,
    apiKey,
    signal,
  })
  return {
    slices: parseEffectiveSlices(xml, lawName),
    rawCount: (xml.match(new RegExp(SLICE_LAW_RE.source, "g")) ?? []).length,
    totalCnt: readTotalCnt(xml),
  }
}

/**
 * fromYmd~toYmd 구간에 시행일이 있는 대상 법령의 슬라이스 조회 (eflaw efYd 범위 검색, 1페이지만).
 * applicable_law의 분리시행 보정용 — 실패는 호출부에서 보수적으로 무시한다.
 * 목록이 100건을 넘을 수 있는 "최신본 확정" 용도에는 쓰지 말 것 — resolveVersionAt 참고.
 */
export async function fetchEffectiveSlices(
  apiClient: LawApiClient,
  lawName: string,
  fromYmd: string,
  toYmd: string,
  apiKey?: string,
  signal?: AbortSignal
): Promise<EffectiveSlice[]> {
  return (await fetchSlicePage(apiClient, lawName, fromYmd, toYmd, 1, apiKey, signal)).slices
}

/** 기준일 시점에 시행 중이던 법령 버전 */
export interface VersionAtResult {
  /** 기준일 이하 최신 시행본. 못 찾으면 undefined (호출부는 ⚠로 고지할 것) */
  slice?: EffectiveSlice
  /** 후보를 못 찾은 사유 — 응답에 그대로 실어 조용한 실패를 막는다 */
  reason?: string
}

/** 한 구간을 끝까지 받은 결과 — complete=false면 reason에 사유 */
type RangeResult =
  | { complete: true; slices: EffectiveSlice[] }
  | { complete: false; reason: string; totalCnt?: number }

/**
 * fromYmd~toYmd 구간의 시행 슬라이스를 **전부** 받는다 (totalCnt만큼 page를 넘긴다).
 * 요청 예산(budget.left)을 다 쓰거나, 총건수를 못 읽었는데 페이지가 꽉 찼거나, 총건수가
 * 남았는데 빈 페이지가 오면 complete=false. 네트워크·취소 오류는 그대로 throw한다.
 */
async function collectRange(
  apiClient: LawApiClient,
  lawName: string,
  fromYmd: string,
  toYmd: string,
  budget: { left: number },
  apiKey?: string,
  signal?: AbortSignal
): Promise<RangeResult> {
  const slices: EffectiveSlice[] = []
  let received = 0
  for (let page = 1; ; page++) {
    if (budget.left <= 0) {
      return { complete: false, reason: `요청 상한 ${SLICE_MAX_PAGES}회 안에 ${fromYmd}~${toYmd} 시행 이력을 전부 받지 못함` }
    }
    budget.left--
    const res = await fetchSlicePage(apiClient, lawName, fromYmd, toYmd, page, apiKey, signal)
    slices.push(...res.slices)
    received += res.rawCount
    // totalCnt가 받은 누계보다 작으면 모순 응답이라 총건수로 쓰지 않는다 (없는 것과 같게 취급)
    const total = res.totalCnt !== undefined && res.totalCnt >= received ? res.totalCnt : undefined
    if (total === undefined) {
      if (res.rawCount >= SLICE_PAGE_SIZE) {
        return { complete: false, reason: `검색 응답이 ${SLICE_PAGE_SIZE}건으로 꽉 찼는데 총건수(totalCnt)를 확인하지 못함` }
      }
      return { complete: true, slices } // 페이지가 덜 찼다 = 마지막 페이지
    }
    if (received >= total) return { complete: true, slices }
    if (res.rawCount === 0) {
      return { complete: false, reason: `총 ${total}건 중 ${received}건만 수신 (다음 페이지가 비어 있음)`, totalCnt: total }
    }
    // 남은 예산으로 끝까지 못 받을 게 확실하면 헛요청하지 않는다 (분당 30회 한도 보호)
    if (Math.ceil((total - received) / SLICE_PAGE_SIZE) > budget.left) {
      return { complete: false, reason: `총 ${total}건 — 요청 상한 ${SLICE_MAX_PAGES}회 안에 전부 받을 수 없음`, totalCnt: total }
    }
  }
}

/** 먼저 볼 좁은 구간(기준일 전년 1월 1일~)과, 전 구간이 끝나지 않을 때 볼 구간(5년 전 1월 1일~) */
const NARROW_BACK_YEARS = 1
const FALLBACK_BACK_YEARS = 5

/**
 * 기준일 시점에 시행 중이던 법령 버전을 해소한다.
 *
 * 왜 필요한가 (실측 2026-08-25):
 *  - 검색 API에 **단일 efYd를 주면 조용히 무시**된다 (efYd=20200101 결과 = efYd 없음 결과).
 *    범위 문법(`from~to`)만 실제 필터로 동작한다.
 *  - 조회 API에 **현행 MST + 과거 efYd**를 주면 빈 응답이 온다.
 *    → 기준일 버전의 MST를 먼저 확보해야 그 시점 조문을 볼 수 있다.
 * 이 두 가지 때문에 "기준일을 그대로 efYd에 넘기는" 방식은 동작하지 않는다.
 *
 * 전체 수신을 입증해야 확정한다 (외부 검토 B5): 종전에는 display=100 한 페이지 안에서 최신본을
 * 골라, 총 101건 중 1920~2019년 100건만 오면 101번째(2026년 최신본)를 모른 채 2019년 구본을
 * 확정했다. 이제
 *  ① 전년 1월 1일~기준일 좁은 구간을 전부 받아 대상 법령 슬라이스가 있으면 확정 (대부분 요청 1회)
 *  ② 좁은 구간에 대상이 없거나 전부 받지 못했으면 1900~기준일 전 구간을 totalCnt만큼 page를 넘겨 받는다
 *  ③ 전 구간을 예산 안에 못 받으면 5년 전 1월 1일~기준일 구간으로 다시 시도
 *  ④ 어느 구간도 전부 받았다고 입증하지 못하면 확정하지 않고 reason으로 돌려준다
 * 좁힌 구간이 맞는 이유: 구간 상한이 기준일이므로, 그 구간을 **전부** 받았고 대상 법령
 * 슬라이스가 있으면 그중 최대 시행일이 전체의 기준일 이하 최대다 — API 정렬 순서와 무관하다.
 * 좁은 구간을 먼저 보는 이유 (2026-09-24 라이브): 전 구간 우선이면 부가가치세법 4페이지·
 * 법인세법 시행령 3페이지가 필요했고, 소득세법 시행령은 page 2 도중 도구 deadline(6초)에 걸려
 * [BASIS_DATE_UNRESOLVED]가 됐다. page 파라미터와 efYd 하한 필터는 같은 날 라이브로 동작을 확인했다.
 * 정렬은 API 순서를 믿지 않는다 — 받은 전 후보에서 기준일 이하 최대 시행일을 고른다.
 */
export async function resolveVersionAt(
  apiClient: LawApiClient,
  lawName: string,
  basisYmd: string,
  apiKey?: string,
  signal?: AbortSignal
): Promise<VersionAtResult> {
  const budget = { left: SLICE_MAX_PAGES }
  const year = parseInt(basisYmd.slice(0, 4), 10)
  let slices: EffectiveSlice[]
  try {
    const narrowFrom = `${year - NARROW_BACK_YEARS}0101`
    const narrow = await collectRange(apiClient, lawName, narrowFrom, basisYmd, budget, apiKey, signal)
    if (narrow.complete) {
      const found = pickLatestAt(narrow.slices, basisYmd)
      if (found) return { slice: found }
    }
    const whole = await collectRange(apiClient, lawName, "19000101", basisYmd, budget, apiKey, signal)
    if (whole.complete) {
      slices = whole.slices
    } else {
      // 좁은 구간도 못 받았으면 그보다 넓은 5년 구간은 더더욱 못 받는다
      if (!narrow.complete) {
        return { reason: `기준일 버전 확정 불가 — ${narrow.reason} (목록 밖 최신본을 배제할 수 없음)` }
      }
      const fallbackFrom = `${year - FALLBACK_BACK_YEARS}0101`
      const r = await collectRange(apiClient, lawName, fallbackFrom, basisYmd, budget, apiKey, signal)
      if (!r.complete) {
        return { reason: `기준일 버전 확정 불가 — ${r.reason} (목록 밖 최신본을 배제할 수 없음)` }
      }
      const found = pickLatestAt(r.slices, basisYmd)
      if (found) return { slice: found }
      return {
        reason: `기준일 버전 확정 불가 — ${fallbackFrom}~${basisYmd} 구간에 대상 법령 시행본이 없고 전 구간은 ${whole.reason} (목록 밖 최신본을 배제할 수 없음)`,
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { reason: `기준일 버전 조회 실패 (${msg})` }
  }
  const found = pickLatestAt(slices, basisYmd)
  if (!found) {
    return {
      reason:
        slices.length === 0
          ? `기준일 이전 시행 이력을 찾지 못함 (법령명 표기 또는 기준일이 제정 이전인지 확인)`
          : `기준일 이하 시행본 없음 (검색 상한에 걸렸을 수 있음)`,
    }
  }
  return { slice: found }
}

/** 기준일 이하 최대 시행일 슬라이스 — 페이지를 이어 붙였으므로 전체를 다시 정렬한다 (API 순서 무관) */
function pickLatestAt(slices: EffectiveSlice[], basisYmd: string): EffectiveSlice | undefined {
  return slices
    .filter((s) => s.efYd <= basisYmd)
    .sort((a, b) =>
      parseInt(b.efYd, 10) - parseInt(a.efYd, 10) ||
      parseInt(b.ancYd || "0", 10) - parseInt(a.ancYd || "0", 10) ||
      parseInt(b.ancNo || "0", 10) - parseInt(a.ancNo || "0", 10))[0]
}
