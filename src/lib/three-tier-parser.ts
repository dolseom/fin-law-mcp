/**
 * 3단비교 JSON 파싱
 * LexDiff에서 이식 (debugLogger 제거)
 */

import type {
  ThreeTierArticle,
  ThreeTierData,
  ThreeTierMeta,
  DelegationItem,
} from "./types.js"

// \uBB38\uC790\uC5F4\uC774 \uC544\uB2CC \uAC12(\uBC30\uC5F4\u00B7\uAC1D\uCCB4)\uC774 \uC624\uBA74 ""\uB85C \u2014 `.replace is not a function` \uC608\uC678\uAC00
// \uC601\uC5B4 TypeError \uADF8\uB300\uB85C \uC0AC\uC6A9\uC790\uC5D0\uAC8C \uB178\uCD9C\uB418\uB358 \uC790\uB9AC\uB2E4 (9\uCC28 \uB9AC\uBDF0: \uAE30\uC900\uBC95\uB839\uBAA9\uB85D.\uBC95\uB839\uBA85 \uBC30\uC5F4)
function normalizeWhitespace(text: unknown): string {
  return (typeof text === "string" ? text : "").replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim()
}

/** \uBB38\uC790\uC5F4 \uB610\uB294 \uBB38\uC790\uC5F4 \uBC30\uC5F4 \uD544\uB4DC \u2192 \uBE44\uC9C0 \uC54A\uC740 \uCCAB \uBB38\uC790\uC5F4 */
function firstText(value: unknown): string {
  for (const v of Array.isArray(value) ? value : [value]) {
    const t = normalizeWhitespace(v)
    if (t) return t
  }
  return ""
}

function normalizeDelegationTitle(title: string, joNum?: string): string {
  let t = normalizeWhitespace(title)
  if (!t) return ""

  const mParen = t.match(/^제\s*\d+\s*조(?:의\s*\d+)?\s*\(([^)]+)\)$/)
  if (mParen?.[1]) return normalizeWhitespace(mParen[1])

  const j = normalizeWhitespace(joNum || "").replace(/\s+/g, "")
  if (j) {
    const compact = t.replace(/\s+/g, "")
    if (compact.startsWith(j)) {
      t = t.substring(t.indexOf(j) + j.length).trim()
      t = t.replace(/^[\s:：-]+/, "").trim()
    }
  }

  t = t.replace(/^제\s*\d+\s*조(?:의\s*\d+)?\s*/, "").trim()
  t = t.replace(/^[\s:：-]+/, "").trim()

  return t
}

function stripLeadingJoHeaderFromContent(content: string): string {
  if (!content) return ""
  const raw = content.trim()
  const m = raw.match(/^(제\s*\d+\s*조(?:의\s*\d+)?\s*(?:\([^)]+\))?)\s*([\s\S]*)$/)
  if (!m) return raw

  const header = m[1] || ""
  const body = (m[2] || "").trim()
  if (/\([^)]+\)/.test(header) && body) return body
  return raw
}

function pickBestLawName(a?: string, b?: string, type?: DelegationItem["type"], meta?: ThreeTierMeta): string {
  const aa = normalizeWhitespace(a || "")
  const bb = normalizeWhitespace(b || "")
  if (!aa) return bb
  if (!bb) return aa

  if (meta && type === "시행령") {
    const def = normalizeWhitespace(meta.sihyungryungName || "")
    if (def && aa === def && bb !== def) return bb
    if (def && bb === def && aa !== def) return aa
  }
  if (meta && type === "시행규칙") {
    const def = normalizeWhitespace(meta.sihyungkyuchikName || "")
    if (def && aa === def && bb !== def) return bb
    if (def && bb === def && aa !== def) return aa
  }

  return bb.length > aa.length ? bb : aa
}

function dedupeDelegations(items: DelegationItem[], meta: ThreeTierMeta): DelegationItem[] {
  const map = new Map<string, DelegationItem>()

  for (const item of items) {
    const key = item.jo ? `${item.type}|${item.jo}` : `${item.type}|${normalizeWhitespace(item.lawName || "")}|${normalizeWhitespace(item.title || "")}`
    const prev = map.get(key)
    if (!prev) {
      map.set(key, item)
      continue
    }

    const merged: DelegationItem = {
      ...prev,
      lawName: pickBestLawName(prev.lawName, item.lawName, item.type, meta),
      title: normalizeWhitespace(prev.title || "").length >= normalizeWhitespace(item.title || "").length ? prev.title : item.title,
      content: prev.content && prev.content.trim().length >= item.content.trim().length ? prev.content : item.content,
    }
    map.set(key, merged)
  }

  return Array.from(map.values())
}

function convertToJO(articleNum: string, branchNum: string = "00"): string {
  const article = articleNum.padStart(4, "0")
  const branch = branchNum.padStart(2, "0")
  return article + branch
}

function formatJoNum(jo: string): string {
  const articleNum = parseInt(jo.substring(0, 4), 10)
  const branchNum = parseInt(jo.substring(4, 6), 10)

  if (branchNum === 0) {
    return `제${articleNum}조`
  }
  return `제${articleNum}조의${branchNum}`
}

// ── 행(row) 보존 파싱 — 역방향(시행령·시행규칙 → 모법) 해소용 ──────────────
//
// 법제처 3단비교(thdCmp)는 **기준법령(모법) 조문 기준으로만 색인**된다.
// 시행령 MST로 호출해도 같은 모법 매핑이 돌아온다 (2026-09-05 실측:
// 법인세법 MST 280349와 법인세법 시행령 MST 283635의 `위임조문삼단비교.법률조문`
// 배열 499건이 동일, `기본정보.법령명`만 다르고 `기준법령명`은 양쪽 다 "법인세법").
// 그래서 시행령 §45를 물으면서 배열에서 조번호 0045를 찾으면 **모법 §45**가 잡힌다.
//
// parseThreeTierDelegation은 모법 조문 단위로 위임을 묶어(dedupe) 행 짝을 잃는다.
// 역방향에는 "이 시행령 조문과 **같은 행**의 시행규칙 조문"이 필요하므로 원본 행을
// 그대로 보존하는 별도 파서를 둔다.

export interface ThreeTierRowItem {
  lawName: string
  jo: string
  joNum: string
  title: string
  content: string
}

export interface ThreeTierRow {
  /** 기준법령(모법) 조문 */
  baseJo: string
  baseJoNum: string
  /** 같은 행의 시행령 조문 (법제처는 보통 1건, 배열 방어) */
  decrees: ThreeTierRowItem[]
  /** 같은 행의 시행규칙 조문 */
  rules: ThreeTierRowItem[]
}

export interface ThreeTierRowSet {
  /** 3단비교 색인의 기준이 되는 법령(모법) 이름 — 없으면 "". 이 표(rows)가 이 법령 기준이다 */
  baseLawName: string
  /**
   * `기준법령목록`에 실린 기준법령 전체 (응답 순서). 하위법령 MST로 조회하면 여럿이 올 수 있고,
   * 그때 표(rows)는 **첫 항목의 것**이다 — 목록에 모법이 있어도 표는 다른 법령일 수 있다.
   */
  baseLawNames: string[]
  /** 조회에 쓴 MST의 법령명 (시행령 MST로 부르면 시행령명이 온다) */
  queriedLawName: string
  rows: ThreeTierRow[]
}

function toRowItem(item: any, fallbackLawName: string): ThreeTierRowItem {
  const joCode = item?.조번호 ? convertToJO(String(item.조번호), String(item.조가지번호 || "00")) : ""
  const joNum = joCode ? formatJoNum(joCode) : ""
  return {
    lawName: firstText(item?.법령명) || normalizeWhitespace(fallbackLawName),
    jo: joCode,
    joNum,
    title: normalizeDelegationTitle(item?.조제목 || "", joNum),
    content: stripLeadingJoHeaderFromContent(item?.조내용 || ""),
  }
}

/**
 * 3단비교 원본 행 파싱 — 모법 조문 ↔ 같은 행의 시행령·시행규칙 조문 짝을 보존한다.
 * 위임 방향 판정(정방향/역방향)에 필요한 `baseLawName`도 함께 돌려준다.
 */
export function parseThreeTierRows(jsonData: any): ThreeTierRowSet {
  const service = jsonData?.LspttnThdCmpLawXService
  if (!service) {
    throw new Error("LspttnThdCmpLawXService 데이터가 없습니다")
  }

  const basicInfo = service.기본정보 || {}
  // 기준법령명은 `기본정보.기준법령명`에 온다 (2026-09-16 raw 38건 중 표가 있는 37건 전부).
  // `기준법령목록`은 기준법령이 여럿이면 **필드마다 배열**로 온다 — 객체 배열이 아니다:
  //   소득세법 시행령 286211 → { 법령명: ["법인세법","소득세법","지방세특례제한법"], 위임3단비교상세링크: [...] }
  //   근로기준법 시행령 270551 → { 법령명: ["공휴일에 관한 법률","근로기준법"], ... }
  // 표(위임조문삼단비교)는 목록 첫 항목의 것이다 (위 두 건 모두 기본정보.기준법령명 = 목록[0]).
  // 표가 없는 응답(국세징수법 시행규칙 284983: 삼단비교존재여부 N)은 두 필드가 다 없다.
  const baseLawNames: string[] = []
  for (const entry of Array.isArray(service.기준법령목록) ? service.기준법령목록 : [service.기준법령목록]) {
    for (const n of Array.isArray(entry?.법령명) ? entry.법령명 : [entry?.법령명]) {
      const name = normalizeWhitespace(n)
      if (name && !baseLawNames.includes(name)) baseLawNames.push(name)
    }
  }
  const baseLawName = firstText(basicInfo.기준법령명) || baseLawNames[0] || ""
  const queriedLawName = firstText(basicInfo.법령명)

  const rawArticles = service.위임조문삼단비교?.법률조문
  if (!rawArticles) return { baseLawName, baseLawNames, queriedLawName, rows: [] }

  const articleArray = Array.isArray(rawArticles) ? rawArticles : [rawArticles]
  const rows: ThreeTierRow[] = []

  for (const rawArticle of articleArray) {
    const baseJo = convertToJO(String(rawArticle.조번호 || "0000"), String(rawArticle.조가지번호 || "00"))
    const decreeRaw = rawArticle.시행령조문
    const ruleRaw = rawArticle.시행규칙조문
    const decrees = (Array.isArray(decreeRaw) ? decreeRaw : decreeRaw ? [decreeRaw] : []).map((d: any) =>
      toRowItem(d, basicInfo.시행령명 || "")
    )
    const rules = (Array.isArray(ruleRaw) ? ruleRaw : ruleRaw ? [ruleRaw] : []).map((d: any) =>
      toRowItem(d, basicInfo.시행규칙명 || "")
    )
    if (decrees.length === 0 && rules.length === 0) continue
    rows.push({ baseJo, baseJoNum: formatJoNum(baseJo), decrees, rules })
  }

  return { baseLawName, baseLawNames, queriedLawName, rows }
}

/**
 * 위임조문 3단비교 JSON 파싱 (knd=2)
 */
export function parseThreeTierDelegation(jsonData: any): ThreeTierData {
  const service = jsonData.LspttnThdCmpLawXService

  if (!service) {
    throw new Error("LspttnThdCmpLawXService 데이터가 없습니다")
  }

    const basicInfo = service.기본정보 || {}
    const meta: ThreeTierMeta = {
      lawId: basicInfo.법령ID || "",
      lawName: basicInfo.법령명 || "",
      lawSummary: basicInfo.법령요약정보 || "",
      sihyungryungId: basicInfo.시행령ID || "",
      sihyungryungName: basicInfo.시행령명 || "",
      sihyungryungSummary: basicInfo.시행령요약정보 || "",
      sihyungkyuchikId: basicInfo.시행규칙ID || "",
      sihyungkyuchikName: basicInfo.시행규칙명 || "",
      sihyungkyuchikSummary: basicInfo.시행규칙요약정보 || "",
      exists: basicInfo.삼단비교존재여부 === "Y",
      basis: basicInfo.삼단비교기준 || "L",
    }

    const articles: ThreeTierArticle[] = []
    const rawArticles = service.위임조문삼단비교?.법률조문

    if (!rawArticles) {
      return { meta, articles: [], kndType: "위임조문" }
    }

    const articleArray = Array.isArray(rawArticles) ? rawArticles : [rawArticles]
    const articleMap = new Map<string, ThreeTierArticle>()

    for (const rawArticle of articleArray) {
      const articleNum = rawArticle.조번호 || "0000"
      const branchNum = rawArticle.조가지번호 || "00"
      const jo = convertToJO(articleNum, branchNum)
      const joNum = formatJoNum(jo)
      const title = rawArticle.조제목 || ""
      const content = rawArticle.조내용 || ""

      let article = articleMap.get(jo)
      if (!article) {
        article = {
          jo,
          joNum,
          title,
          content,
          delegations: [],
          citations: [],
        }
        articleMap.set(jo, article)
      }

      // 시행령조문 파싱
      if (rawArticle.시행령조문) {
        const sihyungryung = Array.isArray(rawArticle.시행령조문)
          ? rawArticle.시행령조문
          : [rawArticle.시행령조문]

        for (const item of sihyungryung) {
          const joCode = item.조번호 ? convertToJO(item.조번호, item.조가지번호 || "00") : undefined
          const joNumDisplay = joCode ? formatJoNum(joCode) : undefined
          const lawName = item.법령명 || item.시행령명 || item.법령명_한글 || meta.sihyungryungName
          const normalizedTitle = normalizeDelegationTitle(item.조제목 || "", joNumDisplay)
          article.delegations.push({
            type: "시행령",
            lawName,
            jo: joCode,
            joNum: joNumDisplay,
            title: normalizedTitle,
            content: stripLeadingJoHeaderFromContent(item.조내용 || ""),
          })
        }
      }

      // 시행규칙조문 파싱
      if (rawArticle.시행규칙조문) {
        const sihyungkyuchik = Array.isArray(rawArticle.시행규칙조문)
          ? rawArticle.시행규칙조문
          : [rawArticle.시행규칙조문]

        for (const item of sihyungkyuchik) {
          const joCode = item.조번호 ? convertToJO(item.조번호, item.조가지번호 || "00") : undefined
          const joNumDisplay = joCode ? formatJoNum(joCode) : undefined
          const lawName = item.법령명 || meta.sihyungkyuchikName
          const normalizedTitle = normalizeDelegationTitle(item.조제목 || "", joNumDisplay)
          article.delegations.push({
            type: "시행규칙",
            lawName,
            jo: joCode,
            joNum: joNumDisplay,
            title: normalizedTitle,
            content: stripLeadingJoHeaderFromContent(item.조내용 || ""),
          })
        }
      }

      // 위임행정규칙목록 파싱
      if (rawArticle.위임행정규칙목록?.위임행정규칙) {
        const rules = Array.isArray(rawArticle.위임행정규칙목록.위임행정규칙)
          ? rawArticle.위임행정규칙목록.위임행정규칙
          : [rawArticle.위임행정규칙목록.위임행정규칙]

        for (const item of rules) {
          article.delegations.push({
            type: "행정규칙",
            lawName: item.위임행정규칙명 || "",
            jo: item.위임행정규칙조번호
              ? convertToJO(item.위임행정규칙조번호, item.위임행정규칙조가지번호 || "00")
              : undefined,
            joNum: item.위임행정규칙조번호
              ? formatJoNum(convertToJO(item.위임행정규칙조번호, item.위임행정규칙조가지번호 || "00"))
              : undefined,
            title: "",
            content: "",
          })
        }
      }
    }

    for (const article of articleMap.values()) {
      if (article.delegations.length > 0) {
        article.delegations = dedupeDelegations(article.delegations, meta)
      }
      if (article.delegations.length > 0) {
        articles.push(article)
      }
    }

    return {
      meta,
      articles,
      kndType: "위임조문",
    }
}
