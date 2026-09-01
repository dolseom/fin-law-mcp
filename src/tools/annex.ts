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
import { stripTrailingParen, isAdminRuleLikeName, findAdminRule } from "./admin-rule-citation.js"
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
      keyword: { type: "string", description: "별표명 필터 키워드 (예: 내용연수). 번호 없는 별표는 이것으로 지정하며, 한 건으로 좁혀지면 표 내용을 반환" },
      kind: { type: "string", enum: ["1", "2", "3", "4", "5"], description: "1=별표(기본) 2=서식 3=별지 4=별도 5=부록" },
      annex_no: { type: "string", description: "별표 선택 (예: '6', '별표6', '1의2') — 지정 시 표 내용을 추출해 반환 (병합 셀은 HTML table). 번호가 없는 별표(목록에 '[별표]'로 표시)는 annex_no 대신 keyword로 지정" },
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
    // "[별표 8의10] [별표 11]로 이동" 형태는 [^\]]*가 ]를 못 넘어 살아남았다 —
    // 유령 별표가 목록에 뜨고 도구가 그걸 재호출하라고 권했다 (Opus 리뷰 개선 4)
    if (/^삭제|^\[?별표\s*[\d의]+[\s\S]*?(?:이동|삭제)\s*(?:<[^>]*>)?\s*$|^\[?별표\s*\d+[^\]]*(이동|삭제)/.test(name.trim())) return
    // 소속 법령 필드는 응답마다 이름이 다를 수 있다 — 하나만 읽으면 필드명이 바뀌었을 때
    // owner가 빈 문자열이 되고, 아래 `!a.owner ||` 필터가 **무관 법령의 별표를 통과시킨다**
    // (Codex 2차 차단 3). 알려진 이름을 모두 시도한다
    const ownerRaw =
      node.법령명 || node.관련법령명 || node.법령명한글 || node.소속법령명 || node.상위법령명 || ""
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

/**
 * 별표번호 6자리(003600) → "별표 36" 표시.
 * 000000은 **번호가 없는 별표**다 — 법령에 별표가 하나뿐이면 법제처가 이렇게 준다
 * (상증세법 시행령 「[별표] 가업상속공제를 적용받는…」 실측: 원문 표기도 번호 없이
 * "[별표]"다). "별표 0"으로 적으면 원문에 없는 번호를 만들어내는 것이라, 그대로
 * 인용하면 틀린 표기가 된다
 */
export function formatAnnexNo(no: string, label = "별표"): string {
  if (!/^\d{4,6}$/.test(no)) return no
  const main = parseInt(no.slice(0, 4), 10)
  const branch = parseInt(no.slice(4, 6) || "0", 10)
  if (main === 0 && branch === 0) return label
  return branch > 0 ? `${label} ${main}의${branch}` : `${label} ${main}`
}

/** 행정규칙 본문(admrul)의 별표·서식 블록 파싱 — 법령 별표 API(licbyl)가 다루지 않는 영역.
 *
 * 고시·훈령에도 별표·서식이 있다 (실측 2026-09-01: 외국환거래규정 52건,
 * 조사사무처리규정 67건, 법인세 사무처리규정 20건). 국세청 훈령의 별지서식은
 * 실무 수요가 있는데 fin_annex는 법령 DB만 봐서 "0건"으로 답해 왔다.
 *
 * 파일 링크 형식(/LSW/flDownload.do?flSeq=…)이 법령 별표와 같아 추출 경로를 그대로 쓴다.
 */
export function parseAdminRuleAnnexes(
  xml: string,
  kind: string,
  ruleName: string
): { entries: AnnexEntry[]; byKind: Record<string, number> } {
  const wantKind = ADMIN_ANNEX_KIND[kind]
  const pick = (block: string, tag: string): string => {
    const m = new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`).exec(block)
    return m ? m[1].trim() : ""
  }
  const entries: AnnexEntry[] = []
  const byKind: Record<string, number> = {}
  // 별표 **내용**은 고정폭 텍스트 아트라 그 안에 "<별표번호>" 같은 문자열이 그대로 들어올 수
  // 있다. 그대로 split하면 CDATA 속 문자열에서 **가짜 별표와 가짜 다운로드 링크**가 만들어진다
  // (Codex 7차 중요, 실측 재현). 목록에 필요한 필드는 번호·구분·제목·링크뿐이므로 내용을 걷어낸다
  const meta = xml.replace(/<별표내용>[\s\S]*?<\/별표내용>/g, "")
  for (const raw of meta.split("<별표번호>").slice(1)) {
    const no = (/^([^<]*)</.exec(raw)?.[1] || "").trim()
    // 제목이 없으면 별표 블록이 아니다 (본문 텍스트에 태그명이 섞인 경우 방어)
    const name = pick(raw, "별표제목")
    if (!name || !/^\d+$/.test(no)) continue
    const gubun = pick(raw, "별표구분") || "별표"
    byKind[gubun] = (byKind[gubun] || 0) + 1
    if (wantKind && gubun !== wantKind) continue
    const branch = (pick(raw, "별표가지번호") || "0").replace(/\D/g, "") || "0"
    entries.push({
      // 법령 별표와 같은 6자리 코드로 맞춘다 (본번호 4 + 가지번호 2) — formatAnnexNo·
      // parseAnnexSelector가 그대로 동작한다
      no: String(parseInt(no, 10)).padStart(4, "0") + String(parseInt(branch, 10)).padStart(2, "0"),
      name,
      fileLink: pick(raw, "별표서식파일링크"),
      owner: ruleName,
    })
  }
  return { entries, byKind }
}

/** fin_annex의 kind 코드 → 행정규칙 본문의 별표구분 값 */
const ADMIN_ANNEX_KIND: Record<string, string> = {
  "1": "별표",
  "2": "서식",
  "3": "별지",
  "4": "별도",
  "5": "부록",
}

/** 번호가 없는 별표인가 (법제처가 000000으로 주는 단일 별표) */
export function isUnnumberedAnnex(no: string): boolean {
  return /^0{1,6}$/.test(no.trim())
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
  // (?![0-9])만으로는 "별표 1의2"가 "1" 요청에 매칭된다 — 지번(의N)까지 배제해야
  // 「별표 1」 요청이 「별표 1의2」를 집지 않는다 (Opus 리뷰 개선 3)
  if (new RegExp(`별표\\s*제?\\s*${mainNo}(?![0-9])(?!\\s*의\\s*\\d)`).test(title)) return true
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
  law: string,
  /** 표기 라벨 — 별지 서식을 "[별표 N]"으로 적으면 원문에 없는 표기가 된다 */
  kindLabel = "별표"
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const { codes, mainNo } = parseAnnexSelector(selector)
  // 별표번호 정확 일치를 제목 매칭보다 먼저 전량 스캔한다 — 법제처는 별표명 가나다순으로
  // 주므로(별표번호순 아님) 순서에 기댄 find는 엉뚱한 별표를 집을 수 있다 (Opus 리뷰 개선 3)
  const matched =
    entries.find((a) => a.no && codes.has(a.no)) ??
    (mainNo !== null ? entries.find((a) => titleMatchesAnnexNo(a.name, mainNo)) : undefined)
  if (!matched) {
    // 라벨은 요청한 구분을 따른다 — 서식·별지 요청에 "사용 가능한 별표: 별표 1"이라고
    // 답하면 사용자가 '서식 1'을 '별표 1'로 오인한다 (Codex 7차 개선)
    const avail = entries.slice(0, 15).map((a) => formatAnnexNo(a.no, kindLabel) || a.name).join(", ")
    return {
      content: [
        {
          type: "text",
          text: `[NOT_FOUND] "${selector}"에 해당하는 ${kindLabel}이(가) 없습니다 (법령: ${law}).\n사용 가능한 ${kindLabel}: ${avail || "없음"}\n\n${SOURCE_FOOTER}`,
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
          text: `⚠ [${formatAnnexNo(matched.no, kindLabel)}] ${matched.name} — 법제처 응답에 파일 링크가 없어 내용을 추출할 수 없습니다. annex_no 없이 목록을 재조회하세요.\n\n${SOURCE_FOOTER}`,
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
          text: `[${formatAnnexNo(matched.no, kindLabel)}] ${matched.name}\n이미지 기반 PDF(${result.pageCount ?? "?"}페이지)라 텍스트 추출이 불가합니다. 원문: ${url}\n\n${SOURCE_FOOTER}`,
        },
      ],
    }
  }
  if (!result.success || !result.markdown) {
    return {
      content: [
        {
          type: "text",
          text: `⚠ [${formatAnnexNo(matched.no, kindLabel)}] ${matched.name} — 표 추출 실패: ${!result.success ? result.error : "본문 없음"}. 원문: ${url}\n\n${SOURCE_FOOTER}`,
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
    `[기준: 현행] ${law} [${formatAnnexNo(matched.no, kindLabel)}] ${matched.name}\n` +
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
    // 조회·소속 대조는 괄호를 뗀 이름으로 — "법인세법(2026. 1. 1. 개정)"을 그대로
    // 조회하면 실존 별표가 "정상 조회 결과 없음"으로 단정된다. article·law_search·verify는
    // 보정됐는데 별표 직행 경로만 남아 있었다 (Codex 4차 중요 — 반쪽 수정의 같은 패턴).
    // 출력 헤더의 표시는 원문(law) 그대로 둔다
    const lawLookup = stripTrailingParen(law)
    const jsonText = await apiClient.getAnnexes({ lawName: lawLookup, knd: kind })
    const acc: AnnexEntry[] = []
    collectAnnexes(JSON.parse(jsonText), acc, lawLookup)

    // 소속 법령 대조 (유사 법령 별표 혼입 방어 — 같은 패밀리의 하위법령 별표는 통과)
    let entries = acc.filter((a) => !a.owner || sameLawFamily(lawLookup, a.owner))

    // 법령 DB에 별표가 없고 이름이 고시·훈령·규정류면 행정규칙 본문의 별표를 본다.
    // 고시·훈령에도 별표·서식이 있는데(실측: 외국환거래규정 52건·조사사무처리규정 67건)
    // 법령 별표 API만 보고 "0건"으로 답해 왔다 (law_search·verify의 행정규칙 폴백과 같은 배선)
    let adminRuleLabel = ""
    let adminRuleFailure = ""
    let adminRuleOtherKinds = ""
    if (entries.length === 0 && isAdminRuleLikeName(lawLookup)) {
      try {
        const match = await findAdminRule(apiClient, lawLookup)
        // 이름은 정확히 맞는데 본문 조회 ID가 없으면 별표를 확인할 방법이 없다 —
        // 그대로 "0건"으로 내보내면 실존 별표가 없는 것으로 읽힌다 (Codex 7차 중요.
        // 조문 검증 경로는 같은 상황을 ⚠로 처리하는데 별표 경로에만 빠져 있었다)
        if (match?.exact && !match.seq) {
          adminRuleFailure = `행정규칙 「${match.name}」은 실존하나 본문 조회 ID(행정규칙일련번호)를 받지 못해 별표를 확인할 수 없습니다`
        }
        // 접두 일치(더 긴 다른 규칙)로 남의 별표를 보여주지 않는다 — 정확 일치만
        if (match?.exact && match.seq) {
          const body = await apiClient.getAdminRule(match.seq)
          const found = parseAdminRuleAnnexes(body, kind, match.name)
          const meta = [match.ruleType, match.orgName].filter(Boolean).join(" · ")
          if (found.entries.length > 0) {
            entries = found.entries
            adminRuleLabel = `[행정규칙] 「${match.name}」${meta ? ` (${meta})` : ""} `
          } else {
            // 요청한 구분에는 없지만 다른 구분에는 있다 — 국세청 훈령의 서식은 대개
            // '별지'(kind=3)다. 이걸 안 밝히면 실존 서식 66건이 "0건"으로 읽힌다
            const others = Object.entries(found.byKind)
              .map(([k, n]) => `${k} ${n}건`)
              .join(" · ")
            if (others) {
              const codeOf = Object.entries(ADMIN_ANNEX_KIND)
                .filter(([, v]) => found.byKind[v])
                .map(([k, v]) => `${v}=kind "${k}"`)
                .join(", ")
              adminRuleOtherKinds =
                `\n💡 「${match.name}」${meta ? ` (${meta})` : ""}은 행정규칙이며 ${others}이 있습니다` +
                (codeOf ? ` — ${codeOf}로 재호출하세요` : "")
            }
          }
        }
      } catch (e) {
        // 실패를 "0건"으로 바꾸지 않는다 — 아래 0건 안내에 사유를 붙인다
        adminRuleFailure = e instanceof Error ? e.message : String(e)
      }
    }
    if (keyword) {
      const ck = compactName(keyword)
      entries = entries.filter((a) => compactName(a.name).includes(ck))
    }

    const kindLabel = { "1": "별표", "2": "서식", "3": "별지", "4": "별도", "5": "부록" }[kind]

    // 별표 지정 → 파일 다운로드 + 표 추출 (목록 대신 내용 반환)
    if (annex_no && entries.length > 0) {
      return await extractAnnexContent(entries, annex_no, law, kindLabel)
    }
    // 번호 없는 별표는 annex_no로 지정할 수 없다. keyword로 한 건까지 좁혀졌다면
    // 지정된 것이나 마찬가지이므로 내용을 준다 — 이게 없으면 "keyword로 지정하세요"라는
    // 안내를 따라도 목록만 다시 나와서 내용에 도달할 방법이 없다
    if (!annex_no && keyword && entries.length === 1 && isUnnumberedAnnex(entries[0].no)) {
      return await extractAnnexContent(entries, entries[0].no, law, kindLabel)
    }

    if (entries.length === 0) {
      let text = adminRuleFailure
        ? `[기준: 현행] ${law} ${kindLabel} — ⚠ 판정 불가 (0건 아님): 법령 DB 0건 + 행정규칙 조회 실패 — ${adminRuleFailure}`
        : `[기준: 현행] ${law} ${kindLabel} — 0건 (정상 조회 결과 없음)`
      if (adminRuleOtherKinds) text += adminRuleOtherKinds
      if (keyword) text += `\n💡 키워드 "${keyword}" 없이 재시도하거나, 내용연수표·세율표는 시행규칙(예: "${law.replace(/(시행령|시행규칙)?$/, "")} 시행규칙")에서 찾으세요`
      text += `\n\n${SOURCE_FOOTER}`
      return { content: [{ type: "text", text }] }
    }

    entries.sort((a, b) => (a.no > b.no ? 1 : -1))
    const shown = entries.slice(0, 20)
    // 행정규칙 별표는 라벨에 규칙명이 이미 들어간다 — law를 또 붙이면 이름이 두 번 나온다
    let text = `[기준: 현행] ${adminRuleLabel || `${law} `}${kindLabel} — ${entries.length}건${keyword ? ` (키워드 "${keyword}" 필터)` : ""}`
    if (entries.length > shown.length) text += ` · 표시 ${shown.length}건 / 전체 ${entries.length}건 (키워드로 좁히세요)`
    text += "\n"
    text += shown
      .map((a) => {
        // 소속 법령을 함께 보인다 — 같은 패밀리라도 시행령 별표와 시행규칙 별표는
        // 다른 문서다. 번호 없는 별표가 여러 건일 때는 이것이 유일한 구분 수단이다
        const ownerNote = a.owner && compactName(a.owner) !== compactName(lawLookup) ? ` — ${a.owner}` : ""
        // 표기는 요청한 구분을 따른다 — 별지 서식을 "[별표 14]"로 적으면 원문에 없는
        // 표기를 만들어 그대로 인용하면 틀린 인용이 된다 (행정규칙 별지에서 실제로 발생)
        let line = `  · [${formatAnnexNo(a.no, kindLabel)}]${ownerNote} ${a.name}`
        if (a.fileLink) {
          const url = a.fileLink.startsWith("http") ? a.fileLink : `https://www.law.go.kr${a.fileLink}`
          line += `\n      다운로드: ${url.replace(/&amp;/g, "&")}`
        }
        return line
      })
      .join("\n")
    // 번호 없는 별표는 annex_no로 지정할 수 없다 — "0"으로 안내하면 원문에 없는
    // 번호를 쓰게 되고, 그런 별표가 2건 이상이면 첫 건만 반환되어 나머지는 조용히 가려진다
    const unnumbered = entries.filter((a) => isUnnumberedAnnex(a.no))
    if (unnumbered.length > 0 && unnumbered.length === entries.length) {
      text +=
        `\n\n※ 이 법령의 ${kindLabel}에는 번호가 없습니다 (원문 표기도 "[${kindLabel}]") — annex_no 대신 ` +
        `keyword로 지정하세요 (예: keyword="${(shown[0]?.name || "").slice(0, 8)}")\n${SOURCE_FOOTER}`
    } else {
      const numbered = shown.find((a) => !isUnnumberedAnnex(a.no))
      const example = numbered ? formatAnnexNo(numbered.no, kindLabel).replace(`${kindLabel} `, "") : "6"
      text += `\n\n※ 표 내용이 필요하면 annex_no로 재호출하세요 (예: annex_no="${example}") — 표 구조를 마크다운으로 반환`
      if (unnumbered.length > 0) {
        text += `\n※ 번호 없는 ${kindLabel} ${unnumbered.length}건은 annex_no로 지정할 수 없습니다 — keyword로 지정하세요`
      }
      text += `\n${SOURCE_FOOTER}`
    }

    return { content: [{ type: "text", text: truncateWithHint(text, 8000, "키워드로 좁혀 재조회") }] }
  } catch (e) {
    return {
      content: [{ type: "text", text: formatFetchFailure("별표 조회", e) }],
      isError: true,
    }
  }
}
