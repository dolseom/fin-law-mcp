/**
 * fin_annex — 별표·서식 조회 + 표 내용 추출 (세율표·감가상각 내용연수표)
 *
 * 재무에서 별표는 세율표·내용연수표·서식 그 자체다.
 * 기본: 목록 + 다운로드 링크 + 키워드 필터. annex_no 지정 시 해당 별표 파일(HWP·HWPX·PDF)을
 * 내려받아 kordoc으로 표 구조를 보존한 마크다운을 반환한다 (korean-law-mcp 검증 경로 이식).
 * 삭제·이동된 별표는 노이즈로 제외한다.
 */

import { z } from "zod"
import { parse as parseKoreanDoc } from "kordoc"
import type { LawApiClient } from "../lib/api-client.js"
import { sameLawFamily } from "../lib/law-search.js"
import { formatFetchFailure } from "../lib/errors.js"
import { fetchWithRetry } from "../lib/fetch-with-retry.js"
import { flattenContent } from "../lib/article-parser.js"
import { truncateWithHint, SOURCE_FOOTER, compactName } from "../lib/fin-common.js"

export const FinAnnexInputSchema = z.object({
  law: z.string().min(1).describe("법령명 (예: 법인세법 시행규칙 — 내용연수표·세율표는 대개 시행규칙 별표)"),
  keyword: z.string().optional().describe("별표명 필터 키워드 (예: 내용연수)"),
  kind: z.enum(["1", "2", "3", "4", "5"]).default("1").describe("1=별표(기본) 2=서식 3=별지 4=별도 5=부록"),
  annex_no: z
    .string()
    .optional()
    .describe("별표 선택 (예: '6', '별표6', '1의2', '000600') — 지정 시 해당 별표 파일을 내려받아 표 내용을 반환 (병합 셀은 HTML table)"),
})

export const FIN_ANNEX_TOOL = {
  name: "fin_annex",
  description:
    "[재무·세무·회계 전용 — 세율표·감가상각 내용연수표·서식은 이 도구를 우선 사용] " +
    "법령의 별표·서식 목록을 반환하고, annex_no를 지정하면 해당 별표의 표 내용을 추출해 반환한다 " +
    "(병합 셀 보존을 위해 표는 HTML table로 나온다). " +
    "내용연수표·세율표는 대개 시행규칙에 있다 (예: law='법인세법 시행규칙', keyword='내용연수' → 목록에서 번호 확인 후 annex_no로 재호출).",
  inputSchema: {
    type: "object",
    properties: {
      law: { type: "string", description: "법령명 (내용연수표·세율표는 대개 시행규칙)" },
      keyword: { type: "string", description: "별표명 필터 키워드" },
      kind: { type: "string", enum: ["1", "2", "3", "4", "5"], description: "1=별표(기본) 2=서식 3=별지 4=별도 5=부록" },
      annex_no: { type: "string", description: "별표 선택 (예: '6', '별표6', '1의2') — 지정 시 표 내용을 추출해 반환 (병합 셀은 HTML table)" },
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

// ── 별표 선택·추출 (korean-law-mcp get_annexes 검증 경로 이식) ─────────────

/**
 * 별표 선택값("6"·"별표 6"·"1의2"·"000600") → 법제처 별표번호 6자리 코드 후보 + 본번호.
 * 법제처 코드는 본번호4 + 의번호2 (별표 6 = 000600, 별표 1의2 = 000102).
 */
export function parseAnnexSelector(sel: string): { codes: Set<string>; mainNo: string | null } {
  const codes = new Set<string>()
  const m = sel.trim().match(/(\d{1,6})(?:\s*의\s*(\d{1,2}))?/)
  if (!m) return { codes, mainNo: null }
  const raw = m[1]
  const n = parseInt(raw, 10)
  if (m[2]) {
    codes.add(String(n).padStart(4, "0") + String(parseInt(m[2], 10)).padStart(2, "0"))
    return { codes, mainNo: String(n) }
  }
  codes.add(raw)
  codes.add(String(n).padStart(6, "0"))
  if (raw.length <= 3) codes.add(String(n * 100).padStart(6, "0"))
  // 6자리 코드 입력(000600)이면 본번호를 되짚어 제목 매칭에도 쓴다
  const mainNo = raw.length >= 4 ? (n % 100 === 0 ? String(Math.floor(n / 100)) : null) : String(n)
  return { codes, mainNo }
}

/** 별표 제목이 본번호를 가리키는가 — "[별표 6]"·"별표 제6호" + 묶음 범위("별표 1~5") */
export function titleMatchesAnnexNo(title: string, mainNo: string): boolean {
  if (new RegExp(`\\[\\s*별표\\s*${mainNo}\\s*\\]`).test(title)) return true
  if (new RegExp(`별표\\s*제?\\s*${mainNo}(?![0-9])`).test(title)) return true
  const num = parseInt(mainNo, 10)
  if (!Number.isNaN(num)) {
    const range = /별표\s*(\d+)\s*[~\-]\s*(\d+)/g
    let r
    while ((r = range.exec(title)) !== null) {
      if (num >= parseInt(r[1], 10) && num <= parseInt(r[2], 10)) return true
    }
  }
  return false
}

/** 묶음 별표("[별표1~5]") 마크다운에서 요청한 별표 섹션만 추출. 못 찾으면 null(전체 유지) */
export function extractBundledSection(markdown: string, mainNo: string): string | null {
  const num = parseInt(mainNo, 10)
  if (Number.isNaN(num)) return null
  const m = markdown.match(new RegExp(`(##\\s*\\[별표\\s*${num}\\][\\s\\S]*?)(?=##\\s*\\[별표\\s*\\d|$)`))
  return m ? m[1].trim() : null
}

const isBundledAnnex = (title: string) => /별표\s*\d+\s*[~\-]\s*\d+/.test(title)

async function extractAnnexContent(
  entries: AnnexEntry[],
  selector: string,
  law: string
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const { codes, mainNo } = parseAnnexSelector(selector)
  const matched = entries.find(
    (a) => (a.no && codes.has(a.no)) || (mainNo !== null && titleMatchesAnnexNo(a.name, mainNo))
  )
  if (!matched) {
    const avail = entries.slice(0, 15).map((a) => formatAnnexNo(a.no) || a.name).join(", ")
    return {
      content: [
        {
          type: "text",
          text: `[NOT_FOUND] "${selector}"에 해당하는 별표가 없습니다 (법령: ${law}).\n사용 가능한 별표: ${avail || "없음"}\n\n${SOURCE_FOOTER}`,
        },
      ],
      isError: true,
    }
  }
  if (!matched.fileLink) {
    return {
      content: [
        {
          type: "text",
          text: `⚠ [${formatAnnexNo(matched.no)}] ${matched.name} — 법제처 응답에 파일 링크가 없어 내용을 추출할 수 없습니다. annex_no 없이 목록을 재조회하세요.\n\n${SOURCE_FOOTER}`,
        },
      ],
      isError: true,
    }
  }
  const url = (matched.fileLink.startsWith("http") ? matched.fileLink : `https://www.law.go.kr${matched.fileLink}`)
    .replace(/&amp;/g, "&")
  const response = await fetchWithRetry(url, { timeout: 30_000 })
  if (!response.ok) {
    return {
      content: [{ type: "text", text: `⚠ 별표 파일 다운로드 실패 (HTTP ${response.status}) — 원문 링크로 확인하세요: ${url}\n\n${SOURCE_FOOTER}` }],
      isError: true,
    }
  }
  const result = await parseKoreanDoc(await response.arrayBuffer())
  if (result.fileType === "pdf" && result.isImageBased) {
    // 이미지 기반 PDF는 텍스트가 없다 — 실패를 성공으로 위장하지 않고 링크로 안내
    return {
      content: [
        {
          type: "text",
          text: `[${formatAnnexNo(matched.no)}] ${matched.name}\n이미지 기반 PDF(${result.pageCount ?? "?"}페이지)라 텍스트 추출이 불가합니다. 원문: ${url}\n\n${SOURCE_FOOTER}`,
        },
      ],
    }
  }
  if (!result.success || !result.markdown) {
    return {
      content: [
        {
          type: "text",
          text: `⚠ [${formatAnnexNo(matched.no)}] ${matched.name} — 표 추출 실패: ${!result.success ? result.error : "본문 없음"}. 원문: ${url}\n\n${SOURCE_FOOTER}`,
        },
      ],
      isError: true,
    }
  }
  let markdown = result.markdown
  if (mainNo !== null && isBundledAnnex(matched.name)) {
    const section = extractBundledSection(markdown, mainNo)
    if (section) markdown = section
  }
  const text =
    `[기준: 현행] ${law} [${formatAnnexNo(matched.no)}] ${matched.name}\n` +
    `(파일: ${result.fileType.toUpperCase()}${result.pageCount ? ` · ${result.pageCount}페이지` : ""} · 원문: ${url})\n\n` +
    `${markdown}\n\n${SOURCE_FOOTER}`
  return { content: [{ type: "text", text: truncateWithHint(text, 20_000, "원문 파일 링크로 전체 확인") }] }
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
  const { law, keyword, kind, annex_no } = parsed.data

  try {
    const jsonText = await apiClient.getAnnexes({ lawName: law, knd: kind })
    const acc: AnnexEntry[] = []
    collectAnnexes(JSON.parse(jsonText), acc, law)

    // 소속 법령 대조 (유사 법령 별표 혼입 방어 — 같은 패밀리의 하위법령 별표는 통과)
    let entries = acc.filter((a) => !a.owner || sameLawFamily(law, a.owner))
    if (keyword) {
      const ck = compactName(keyword)
      entries = entries.filter((a) => compactName(a.name).includes(ck))
    }

    // 별표 지정 → 파일 다운로드 + 표 추출 (목록 대신 내용 반환)
    if (annex_no && entries.length > 0) {
      return await extractAnnexContent(entries, annex_no, law)
    }

    const kindLabel = { "1": "별표", "2": "서식", "3": "별지", "4": "별도", "5": "부록" }[kind]
    if (entries.length === 0) {
      let text = `[기준: 현행] ${law} ${kindLabel} — 0건 (정상 조회 결과 없음)`
      if (keyword) text += `\n💡 키워드 "${keyword}" 없이 재시도하거나, 내용연수표·세율표는 시행규칙(예: "${law.replace(/(시행령|시행규칙)?$/, "")} 시행규칙")에서 찾으세요`
      text += `\n\n${SOURCE_FOOTER}`
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
    text += `\n\n※ 표 내용이 필요하면 annex_no로 재호출하세요 (예: annex_no="${formatAnnexNo(shown[0]?.no || "").replace("별표 ", "") || "6"}") — 표 구조를 마크다운으로 반환\n${SOURCE_FOOTER}`

    return { content: [{ type: "text", text: truncateWithHint(text, 8000, "키워드로 좁혀 재조회") }] }
  } catch (e) {
    return {
      content: [{ type: "text", text: formatFetchFailure("별표 조회", e) }],
      isError: true,
    }
  }
}
