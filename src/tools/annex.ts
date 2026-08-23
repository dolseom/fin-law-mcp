/**
 * fin_annex — 별표·서식 조회 (세율표·감가상각 내용연수표)
 *
 * 재무에서 별표는 세율표·내용연수표·서식 그 자체다.
 * MVP: 목록 + 다운로드 링크 + 키워드 필터. 사전 파싱(JSON 동봉)은 P1 후반 파이프라인.
 * 삭제·이동된 별표는 노이즈로 제외한다.
 */

import { z } from "zod"
import type { LawApiClient } from "../lib/api-client.js"
import { resolvedLawMatches } from "../lib/law-search.js"
import { flattenContent } from "../lib/article-parser.js"
import { truncateWithHint, SOURCE_FOOTER, compactName } from "../lib/fin-common.js"

export const FinAnnexInputSchema = z.object({
  law: z.string().min(1).describe("법령명 (예: 법인세법 시행규칙 — 내용연수표·세율표는 대개 시행규칙 별표)"),
  keyword: z.string().optional().describe("별표명 필터 키워드 (예: 내용연수)"),
  kind: z.enum(["1", "2", "3", "4", "5"]).default("1").describe("1=별표(기본) 2=서식 3=별지 4=별도 5=부록"),
})

export const FIN_ANNEX_TOOL = {
  name: "fin_annex",
  description:
    "[재무·세무·회계 전용 — 세율표·감가상각 내용연수표·서식은 이 도구를 우선 사용] " +
    "법령의 별표·서식 목록과 다운로드 링크를 반환한다. 내용연수표·세율표는 대개 시행규칙에 있다 " +
    "(예: law='법인세법 시행규칙', keyword='내용연수').",
  inputSchema: {
    type: "object",
    properties: {
      law: { type: "string", description: "법령명 (내용연수표·세율표는 대개 시행규칙)" },
      keyword: { type: "string", description: "별표명 필터 키워드" },
      kind: { type: "string", enum: ["1", "2", "3", "4", "5"], description: "1=별표(기본) 2=서식 3=별지 4=별도 5=부록" },
    },
    required: ["law"],
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
} as const

interface AnnexEntry {
  no: string
  name: string
  fileLink: string
  owner: string
}

function collectAnnexes(node: any, acc: AnnexEntry[], lawName: string): void {
  if (!node || typeof node !== "object") return
  if (Array.isArray(node)) {
    for (const item of node) collectAnnexes(item, acc, lawName)
    return
  }
  const name = node.별표명 || node.별표제목
  if (typeof name === "string" && name.trim()) {
    if (/^삭제|^\[?별표\s*\d+[^\]]*(이동|삭제)/.test(name.trim())) return
    const ownerRaw = node.법령명 || node.관련법령명 || ""
    const owner = typeof ownerRaw === "string" ? ownerRaw : flattenContent(ownerRaw)
    const fileLink = node.별표서식파일링크 || node.별표파일링크 || node.별표법령상세링크 || ""
    acc.push({
      no: String(node.별표번호 ?? "").trim(),
      name: name.trim(),
      fileLink: typeof fileLink === "string" ? fileLink.trim() : "",
      owner,
    })
    return
  }
  for (const v of Object.values(node)) collectAnnexes(v, acc, lawName)
}

/** 별표번호 6자리(003600) → "별표 36" 표시 */
function formatAnnexNo(no: string): string {
  if (!/^\d{4,6}$/.test(no)) return no
  const main = parseInt(no.slice(0, 4), 10)
  const branch = parseInt(no.slice(4, 6) || "0", 10)
  return branch > 0 ? `별표 ${main}의${branch}` : `별표 ${main}`
}

export async function handleFinAnnex(
  apiClient: LawApiClient,
  rawInput: unknown
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const parsed = FinAnnexInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    return {
      content: [{ type: "text", text: `[INVALID_PARAMETER] fin_annex: ${parsed.error.issues.map((i) => i.message).join("; ")}` }],
      isError: true,
    }
  }
  const { law, keyword, kind } = parsed.data

  try {
    const jsonText = await apiClient.getAnnexes({ lawName: law, knd: kind })
    const acc: AnnexEntry[] = []
    collectAnnexes(JSON.parse(jsonText), acc, law)

    // 소속 법령 대조 (유사 법령 별표 혼입 방어)
    let entries = acc.filter((a) => !a.owner || resolvedLawMatches(law, a.owner))
    if (keyword) {
      const ck = compactName(keyword)
      entries = entries.filter((a) => compactName(a.name).includes(ck))
    }

    const kindLabel = { "1": "별표", "2": "서식", "3": "별지", "4": "별도", "5": "부록" }[kind]
    if (entries.length === 0) {
      let text = `[기준: 현행] ${law} ${kindLabel} — 0건 (정상 조회 결과 없음)`
      if (keyword) text += `\n💡 키워드 "${keyword}" 없이 재시도하거나, 내용연수표·세율표는 시행규칙(예: "${law.replace(/(시행령|시행규칙)?$/, "")} 시행규칙")에서 찾으세요`
      return { content: [{ type: "text", text }] }
    }

    entries.sort((a, b) => (a.no > b.no ? 1 : -1))
    const shown = entries.slice(0, 20)
    let text = `[기준: 현행] ${law} ${kindLabel} — ${entries.length}건${keyword ? ` (키워드 "${keyword}" 필터)` : ""}`
    if (entries.length > shown.length) text += ` · 표시 ${shown.length}건 / 전체 ${entries.length}건 (키워드로 좁히세요)`
    text += "\n"
    text += shown
      .map((a) => {
        let line = `  · [${formatAnnexNo(a.no)}] ${a.name}`
        if (a.fileLink) {
          const url = a.fileLink.startsWith("http") ? a.fileLink : `https://www.law.go.kr${a.fileLink}`
          line += `\n      다운로드: ${url.replace(/&amp;/g, "&")}`
        }
        return line
      })
      .join("\n")
    text += `\n\n※ 표 내용의 기계 판독(사전 파싱 JSON)은 후속 버전에서 제공 — 현재는 원문 파일을 확인하세요\n${SOURCE_FOOTER}`

    return { content: [{ type: "text", text: truncateWithHint(text, 8000, "키워드로 좁혀 재조회") }] }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      content: [{ type: "text", text: `[EXTERNAL_API_ERROR] 별표 조회 실패 — ⚠판정불가 (0건이 아님)\n사유: ${msg}` }],
      isError: true,
    }
  }
}
