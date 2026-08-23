#!/usr/bin/env node
/**
 * fin-law-mcp — 재무·회계·세무·자금 특화 한국 법령 MCP 서버 (stdio 전용)
 *
 * 규칙 (PRD 04_PROJECT_SPEC):
 * - stdout은 MCP 프로토콜 전용. 진단 로그는 stderr만 사용한다.
 * - API 키는 환경변수 LAW_OC만. 미설정 시 발급 안내를 내보낸다.
 * - 오류를 0건으로 위장하지 않는다 (3값 판정: ✓/✗/⚠).
 */

import "./bootstrap.js" // ⚠ 반드시 첫 import — .env를 다른 모듈 평가 전에 로드
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { LawApiClient } from "./lib/api-client.js"
import { FIN_ARTICLE_TOOL, handleFinArticle } from "./tools/article.js"
import { FIN_LAW_SEARCH_TOOL, handleFinLawSearch } from "./tools/law-search.js"
import { FIN_RULING_SEARCH_TOOL, handleFinRulingSearch } from "./tools/ruling-search.js"
import { FIN_NTS_RULING_TOOL, handleFinNtsRuling } from "./tools/nts-ruling.js"
import { FIN_ANNEX_TOOL, handleFinAnnex } from "./tools/annex.js"
import { FIN_VERIFY_TOOL, handleFinVerify } from "./tools/verify.js"
import { FIN_CALC_TOOL, handleFinCalc } from "./tools/calc.js"

const VERSION = "0.1.0"

if (!process.env.LAW_OC) {
  console.error(
    "[fin-law-mcp] 경고: LAW_OC 환경변수가 없습니다. 법제처 OPEN API 키를 발급받아 .env에 설정하세요.\n" +
      "  발급: https://open.law.go.kr/LSO/openApi/guideResult.do (가입 이메일 @ 앞부분이 키)"
  )
}
if (process.env.LAW_API_PROTOCOL === "http") {
  console.error("[fin-law-mcp] 경고: LAW_API_PROTOCOL=http — 평문 전송 중입니다 (폐쇄망 전용 설정).")
}

const server = new Server(
  { name: "fin-law-mcp", version: VERSION },
  { capabilities: { tools: {} } }
)

const apiClient = new LawApiClient({ apiKey: process.env.LAW_OC || "" })

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    FIN_ARTICLE_TOOL,
    FIN_LAW_SEARCH_TOOL,
    FIN_RULING_SEARCH_TOOL,
    FIN_NTS_RULING_TOOL,
    FIN_ANNEX_TOOL,
    FIN_VERIFY_TOOL,
    FIN_CALC_TOOL,
    {
      name: "fin_ping",
      description:
        "[재무·세무·회계 전용] fin-law-mcp 서버 연결·설정 진단. 서버가 살아 있는지, API 키가 설정됐는지 확인할 때 사용.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
  ],
}))

const HANDLERS: Record<string, (client: LawApiClient, args: unknown) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>> = {
  fin_article: handleFinArticle,
  fin_law_search: handleFinLawSearch,
  fin_ruling_search: handleFinRulingSearch,
  fin_nts_ruling: handleFinNtsRuling,
  fin_annex: handleFinAnnex,
  fin_verify: handleFinVerify,
  fin_calc: handleFinCalc,
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const handler = HANDLERS[req.params.name]
  if (handler) {
    return await handler(apiClient, req.params.arguments ?? {})
  }
  if (req.params.name === "fin_ping") {
    const keyState = process.env.LAW_OC ? "설정됨" : "누락 — .env에 LAW_OC를 설정하세요"
    return {
      content: [
        {
          type: "text",
          text: `fin-law-mcp v${VERSION} 정상 동작\nLAW_OC: ${keyState}`,
        },
      ],
    }
  }
  return {
    content: [{ type: "text", text: `알 수 없는 도구: ${req.params.name}` }],
    isError: true,
  }
})

await server.connect(new StdioServerTransport())
