/**
 * lawService 응답의 조문단위를 **요청 조문번호**와 대조한다 (외부 검토 B4 — fin_article·fin_verify 공용).
 *
 * 조문번호는 숫자 문자열, 조문가지번호는 없음(null)·""·"0"을 가지 없음으로 같게 본다.
 * 첫 조문단위를 그대로 쓰던 두 도구가 같은 결함을 따로 가졌다 — 규칙을 한곳에 둔다
 */
import { toArray } from "./xml-parser.js"

/** "제26조"·"제010조의02" → 정규형 "제26조"·"제10조의2". 조 단위 표기가 아니면 null */
export function canonicalJoLabel(label: string): string | null {
  const m = label.replace(/\s+/g, "").match(/^제(\d+)조(?:의(\d+))?$/)
  if (!m) return null
  const branch = m[2] ? parseInt(m[2], 10) : 0
  return `제${parseInt(m[1], 10)}조${branch > 0 ? `의${branch}` : ""}`
}

/** 응답 조문단위의 조 표기(정규형). 조문번호를 읽을 수 없으면 null */
export function unitJoLabel(unit: any): string | null {
  const num = String(unit?.조문번호 ?? "").trim()
  if (!/^\d+$/.test(num)) return null
  const branchRaw = String(unit?.조문가지번호 ?? "").trim()
  const branch = /^\d+$/.test(branchRaw) ? parseInt(branchRaw, 10) : 0
  return `제${parseInt(num, 10)}조${branch > 0 ? `의${branch}` : ""}`
}

export type ArticleUnitPick =
  | { kind: "match"; unit: any }
  /** 조문 단위가 하나도 없다 — 정상 0건 (호출측의 ✗없음 판정) */
  | { kind: "none" }
  /** 조문은 왔는데 요청 조문과 같은 번호가 없다 (returned = 응답의 조 표기) */
  | { kind: "mismatch"; returned: string[] }
  /** 같은 번호가 둘 이상 — 어느 것이 요청 조문인지 확정할 수 없다 */
  | { kind: "ambiguous"; count: number }

/**
 * 응답에서 요청 조문과 같은 번호의 조문단위(조문여부 "조문")를 고른다.
 * 첫 조문단위를 그대로 쓰면 업스트림이 JO를 무시하거나 응답이 섞였을 때 **다른 조문**이
 * 요청 조문으로 확인된다 — 요청 표기를 정규형으로 못 읽으면 대조 불가라 mismatch다
 */
export function pickArticleUnit(lawData: any, requestedLabel: string): ArticleUnitPick {
  const want = canonicalJoLabel(requestedLabel)
  const units = toArray(lawData?.조문?.조문단위).filter((u: any) => u?.조문여부 === "조문")
  if (units.length === 0) return { kind: "none" }
  const matches = want ? units.filter((u: any) => unitJoLabel(u) === want) : []
  if (matches.length === 1) return { kind: "match", unit: matches[0] }
  if (matches.length > 1) return { kind: "ambiguous", count: matches.length }
  return { kind: "mismatch", returned: units.map((u: any) => unitJoLabel(u) ?? "(번호 미상)") }
}
