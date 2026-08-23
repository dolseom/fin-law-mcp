/**
 * 국세청 예규·법령해석 본문 조회 (자체 패치 #1 — docs/SELF-PATCHES.md)
 *
 * 법제처 OPEN API는 국세청 법령해석(ntsCgmExpc)의 목록만 제공하고 본문이 없다.
 * 본문은 국세법령정보시스템(taxlaw.nts.go.kr)의 내부 action.do 엔드포인트로 조회한다.
 * 판례 HTML 폴백(precedents.ts fetchTaxlawAction)이 이미 쓰는 것과 동일한 경로.
 *
 * ⚠️ precedents.ts는 upstream이 활발히 수정 중이라 직접 참조하지 않고
 *    필요한 비공개 헬퍼를 이 파일에 복제했다 (rebase 충돌 방지).
 */

import { z } from "zod"
import type { LawApiClient } from "../lib/api-client.js"
import { cleanHtml } from "../lib/article-parser.js"
import { truncateResponse } from "../lib/schemas.js"
import { fetchWithRetry } from "../lib/fetch-with-retry.js"
import {
  getExternalHttpsProxyConfig,
  requestExternalHttps,
} from "../lib/external-https-proxy.js"

export const GetNtsDecisionBodySchema = z.object({
  id: z.string().describe(
    "search_decisions(domain='nts') 결과의 링크(taxlaw.nts.go.kr …ntstDcmId=…) 또는 ntstDcmId 값"
  ),
  apiKey: z.string().optional().describe(
    "미사용 — 국세청 공개 엔드포인트 직접 조회라 법제처 OC 키가 필요 없음 (타 도메인과의 인터페이스 호환용)"
  ),
})

export type GetNtsDecisionBodyInput = z.infer<typeof GetNtsDecisionBodySchema>

/**
 * id 입력에서 ntstDcmId 추출.
 * - taxlaw.nts.go.kr 링크(호스트 검증) → 쿼리스트링에서 추출 (전체 숫자만 인정)
 * - 12자리 이상 숫자 → ntstDcmId로 간주 (예: 010000000000515153)
 * - 그 외(법제처 일련번호, 타 호스트 URL 등) → null (자동 변환 불가)
 */
export function parseNtstDcmId(id: string): string | null {
  const raw = String(id).trim()
  if (/^\d{12,}$/.test(raw)) return raw
  try {
    const url = new URL(raw)
    if (url.hostname === "taxlaw.nts.go.kr") {
      const value = url.searchParams.get("ntstDcmId") ?? ""
      if (/^\d{12,}$/.test(value)) return value
    }
  } catch {
    // URL 형식이 아님 — 아래에서 null 반환
  }
  return null
}

// ---- 이하 precedents.ts 비공개 헬퍼 복제 (동작 동일 유지) ----

function normalizeHtmlText(html: string): string {
  const withBlockBreaks = html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(p|div|tr|table|tbody|thead|tfoot|ul|ol|li|h[1-6])\s*>/gi, "\n")
    .replace(/<\s*(p|div|tr|table|tbody|thead|tfoot|ul|ol|li|h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<\/\s*td\s*>/gi, "\t")
    .replace(/<\s*td\b[^>]*>/gi, "")

  return cleanHtml(withBlockBreaks)
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function hasSubstantiveTaxlawBody(text: string): boolean {
  const compact = text.replace(/\s+/g, "")
  if (compact.length < 20) return false
  return !/(내용없음|본문없음|조회된내용이없습니다|자료가없습니다)/.test(compact)
}

function normalizeTaxlawBodyCandidate(value: unknown): string {
  if (typeof value !== "string") return ""
  const body = normalizeHtmlText(value)
  return hasSubstantiveTaxlawBody(body) ? body : ""
}

function extractTaxlawEditorBody(actionData: any): string {
  const editorList = Array.isArray(actionData?.dcmHwpEditorDVOList)
    ? actionData.dcmHwpEditorDVOList
    : []

  for (const item of editorList) {
    const value = typeof item?.dcmFleByte === "string" ? item.dcmFleByte : ""
    if (!value.includes("<html") && !value.includes("<body") && value.length <= 100) continue
    const body = normalizeTaxlawBodyCandidate(value)
    if (body) return body
  }

  return ""
}

async function fetchTaxlawAction(ntstDcmId: string, referer: string): Promise<any> {
  const body = new URLSearchParams({
    actionId: "ASIQTB002PR01",
    paramData: JSON.stringify({ dcmDVO: { ntstDcmId } }),
  })
  const headers = {
    "content-type": "application/x-www-form-urlencoded",
    "origin": "https://taxlaw.nts.go.kr",
    "referer": referer,
    "x-requested-with": "XMLHttpRequest",
  }

  const proxyConfig = getExternalHttpsProxyConfig()
  if (proxyConfig) {
    const response = await requestExternalHttps("https://taxlaw.nts.go.kr/action.do", {
      method: "POST",
      headers,
      body: body.toString(),
    }, proxyConfig)
    if (!response.ok) {
      throw new Error(`taxlaw action.do failed with HTTP ${response.status}`)
    }
    return JSON.parse(response.text)
  }

  const response = await fetchWithRetry("https://taxlaw.nts.go.kr/action.do", {
    method: "POST",
    headers,
    body: body.toString(),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`taxlaw action.do failed with HTTP ${response.status}`)
  }
  return JSON.parse(text)
}

// ---- 본체 ----

/** 국세청 예규·법령해석 본문 조회 — get_decision_text(domain="nts") 핸들러 */
export async function getNtsDecisionBody(
  _apiClient: LawApiClient,
  args: GetNtsDecisionBodyInput
): Promise<{ content: Array<{ type: string, text: string }>, isError?: boolean }> {
  const ntstDcmId = parseNtstDcmId(args.id)
  if (!ntstDcmId) {
    const text =
      `[ID_MISMATCH] '${args.id}'는 법제처 일련번호로 보입니다. 국세청 본문 조회에는 ntstDcmId가 필요합니다.\n` +
      `→ search_decisions(domain="nts") 결과의 '링크'(taxlaw.nts.go.kr …ntstDcmId=…)를 id로 그대로 전달하세요.\n` +
      `(두 식별번호는 별개 체계라 자동 변환이 불가합니다.)`
    return { content: [{ type: "text", text }], isError: true }
  }

  const detailUrl = `https://taxlaw.nts.go.kr/qt/USEQTA002P.do?ntstDcmId=${ntstDcmId}`
  try {
    const actionJson = await fetchTaxlawAction(ntstDcmId, detailUrl)
    const actionData = actionJson?.data?.ASIQTB002PR01
    const dcm = actionData?.dcmDVO
    if (!dcm || typeof dcm !== "object" || Array.isArray(dcm)) {
      throw new Error("응답에 정상적인 dcmDVO가 없음 — ntstDcmId가 유효한지 확인 필요")
    }

    // 문자열·숫자만 통과 (malformed 응답의 [object Object] 출력 방지)
    const asText = (v: unknown): string =>
      typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : ""

    const title = asText(dcm.ntstDcmTtl)
    const gist = normalizeTaxlawBodyCandidate(dcm.ntstDcmGistCntn)
    const body = extractTaxlawEditorBody(actionData) || normalizeTaxlawBodyCandidate(dcm.ntstDcmCntn)

    let output = `=== ${title || "국세청 문서"} ===\n\n`
    output += `문서번호: ${asText(dcm.ntstDcmDscmCntn) || "N/A"}\n`
    output += `회신일자: ${asText(dcm.ntstDcmRgtDt) || "N/A"}\n`
    output += `기관: ${asText(dcm.ogzNm) || "국세청"}\n`
    output += `유형: ${asText(dcm.ntstDcmClNm) || "N/A"}\n\n`
    if (gist) output += `요지:\n${gist}\n\n`
    if (body) {
      output += `본문:\n${body}\n\n`
    } else {
      output += `본문: (본문 데이터 없음 — 아래 원문 링크에서 확인)\n\n`
    }
    output += `출처: ${detailUrl}\n`

    return { content: [{ type: "text", text: truncateResponse(output) }], isError: !body || undefined }
  } catch (error) {
    // 외부 사이트 장애·구조 변경 대비: 추측 금지 + 원문 링크 폴백
    const message = error instanceof Error ? error.message : String(error)
    const text =
      `[FETCH_FAILED] 국세법령정보시스템 본문 조회 실패: ${message}\n` +
      `원문 링크에서 직접 확인하세요: ${detailUrl}\n` +
      `⚠️ LLM은 본문을 추측/생성하지 말고 링크를 사용자에게 안내할 것.`
    return { content: [{ type: "text", text }], isError: true }
  }
}
