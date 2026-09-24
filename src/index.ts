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
import { FIN_TOPIC_TOOL, handleFinTopic } from "./tools/topic.js"
import { FIN_ARTICLE_TOOL, handleFinArticle } from "./tools/article.js"
import { FIN_LAW_SEARCH_TOOL, handleFinLawSearch } from "./tools/law-search.js"
import { FIN_RULING_SEARCH_TOOL, handleFinRulingSearch } from "./tools/ruling-search.js"
import { FIN_NTS_RULING_TOOL, handleFinNtsRuling, isNtsBodyEnabled } from "./tools/nts-ruling.js"
import { FIN_ANNEX_TOOL, handleFinAnnex } from "./tools/annex.js"
import { FIN_VERIFY_TOOL, handleFinVerify } from "./tools/verify.js"
import { FIN_CALC_TOOL, handleFinCalc } from "./tools/calc.js"
import { runToolSafely, type ToolResult } from "./lib/errors.js"
import { getLawApiProtocol } from "./lib/law-url-config.js"

const VERSION = "0.1.0"

/**
 * fin_ping 실조회 진단의 전체 예산.
 *
 * 키가 "있다"와 "법제처가 응답한다"는 다른 문제다 — 진단은 실제로 법제처를 한 번 두드려
 * 네트워크·차단·장애·한도를 가른다. 다만 진단이 오래 매달리면 첫 사용자가 "멈췄다"로
 * 읽으므로 5초에서 끊는다. 5초를 넘기면 그 사실 자체가 진단 결과다.
 *
 * ⚠ 키 오타는 이 진단으로 잡히지 않을 수 있다 — 리뷰어 2명이 가짜 OC로도 법제처가 200 정상
 * 데이터를 준다고 실측했다 (Codex 9차 P3, 원인은 정보 부족 — IP 등록 인증 등으로 추정만 가능).
 * 그래서 성공 출력에 "키 값 확인이 아님"을 함께 적는다.
 */
const PING_PROBE_TIMEOUT_MS = 5000

if (!process.env.LAW_OC) {
  console.error(
    "[fin-law-mcp] 경고: LAW_OC 환경변수가 없습니다. 법제처 OPEN API 키를 발급받아 .env에 설정하세요.\n" +
      "  발급: https://open.law.go.kr/LSO/openApi/guideResult.do (가입 이메일 @ 앞부분이 키)"
  )
}
// URL 조립과 같은 판정 함수를 쓴다 — "HTTP"처럼 대소문자가 달라도 평문으로 전환되므로 경고도 같이 나가야 한다
if (getLawApiProtocol() === "http") {
  console.error("[fin-law-mcp] 경고: LAW_API_PROTOCOL=http — 평문 전송 중입니다 (폐쇄망 전용 설정).")
}

const server = new Server(
  { name: "fin-law-mcp", version: VERSION },
  { capabilities: { tools: {} } }
)

const apiClient = new LawApiClient({ apiKey: process.env.LAW_OC || "" })

/**
 * fin_nts_ruling 조건부 등록 — FIN_NTS_BODY_ENABLED=true일 때만 tools/list에 실린다.
 *
 * OFF(공개 기본)면 이 도구가 주는 것은 예규 **목록**뿐이고, 그것은
 * fin_ruling_search(domains=["nts"])가 이미 준다. 겹치는 도구를 하나 더 실으면
 * 매 세션 도구 정의 토큰만 늘고 LLM의 선택지만 흐려진다.
 *
 * 부팅 시 한 번만 읽는다 — tools/list 요청마다 다시 읽으면 같은 세션에서 목록이
 * 흔들릴 수 있다. 호출 경로(HANDLERS)에서는 빼지 않는다: 목록을 캐시해 둔
 * 클라이언트나 도구 이름을 직접 지정한 스크립트가 "알 수 없는 도구"로 깨지지 않게,
 * OFF에서도 종전대로 목록만 돌려준다.
 */
const NTS_RULING_LISTED = isNtsBodyEnabled()

/**
 * fin_topic 조건부 등록 — FIN_TOPIC_ENABLED=true일 때만 tools/list에 실린다 (v0.1 실험 기능).
 *
 * 폐기가 아니라 **검증 전 노출 보류**다. 13개 주제표의 어절 매칭기라 독립 평가에서 표 안 질문의
 * 1위 정답이 72%, 표 밖 질문의 오탐이 25%였고, 이 도구를 거친 답이 더 나은지는 아직 측정하지
 * 못했다 (.release-scratch/orch/compare/astra-review.md D3). 기본 목록에 두면 틀린 주제를 내미는
 * 비용만 확정된다.
 *
 * NTS_RULING_LISTED와 같은 규칙이다 — 부팅 시 한 번만 읽고, HANDLERS에서는 빼지 않는다
 * (이름으로 직접 부르는 스크립트·목록을 캐시한 클라이언트는 계속 동작한다).
 */
const TOPIC_LISTED = ["true", "1"].includes((process.env.FIN_TOPIC_ENABLED || "").toLowerCase())

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // 조문 도구를 가장 앞에 — 법령명+조문으로 바로 부르는 것이 기본 경로다.
    // fin_topic(옵트인)은 조문 번호를 모를 때의 보조 진입이라 그 뒤에 둔다
    FIN_ARTICLE_TOOL,
    ...(TOPIC_LISTED ? [FIN_TOPIC_TOOL] : []),
    FIN_LAW_SEARCH_TOOL,
    FIN_RULING_SEARCH_TOOL,
    ...(NTS_RULING_LISTED ? [FIN_NTS_RULING_TOOL] : []),
    FIN_ANNEX_TOOL,
    FIN_VERIFY_TOOL,
    FIN_CALC_TOOL,
    {
      name: "fin_ping",
      description:
        "[재무·세무·회계 전용] fin-law-mcp 서버 연결·설정 진단. 서버가 살아 있는지, API 키가 설정됐는지, " +
        "법제처가 실제로 응답하는지(가벼운 검색 1건 실행)를 확인한다 (키 오타까지 가려내지는 못할 수 있음). 설치 직후 점검·조회 실패 원인 파악에 사용.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
  ],
}))

/**
 * 실조회 실패 원인 분류 — 첫 사용자가 "무엇을 고쳐야 하는지"까지 읽을 수 있게.
 *
 * 원문 메시지를 그대로 노출하면 `assertXmlRoot`·`fetchWithRetry`의 내부 문구가
 * 나와 개발자가 아닌 사용자에게는 아무 지시도 되지 않는다. 위에서부터 먼저
 * 맞는 것을 쓰므로 **순서가 계약**이다 — 취소·타임아웃이 가장 앞에 온다
 * (재시도 중 5초 예산이 끝나면 원래 원인 대신 취소 메시지가 남기 때문).
 */
const PROBE_CAUSES: Array<{ test: RegExp; cause: string; hint: string }> = [
  {
    test: /요청 취소됨|timeout after|타임아웃/i,
    cause: `타임아웃 — ${PING_PROBE_TIMEOUT_MS / 1000}초 안에 응답이 오지 않았습니다`,
    hint: "브라우저에서 https://www.law.go.kr 이 열리는지 확인하세요. 사내 프록시·방화벽 뒤라면 아웃바운드 HTTPS가 막혔을 수 있습니다.",
  },
  {
    test: /HTML/,
    cause: "HTML 오류 페이지 수신 — 법제처 점검 중이거나 접근이 차단됐습니다",
    hint: "브라우저에서 https://www.law.go.kr 이 정상으로 열리는지 확인하고, 열리면 잠시 후 다시 시도하세요.",
  },
  {
    // fetchWithRetry는 200 빈 본문을 "비정상 응답(빈 본문)"으로 던진다 — 종전 패턴("빈 응답")은
    // 이 문구와 맞지 않아 원문 메시지가 그대로 나갔다 (Codex 9차 P2). 빈 본문은 키 거부가 아니라 장애 신호다
    test: /빈 본문|빈 응답/,
    cause: "법제처가 빈 응답을 반환 — 일시 장애일 수 있습니다",
    hint: "잠시 후 다시 시도하세요. 계속되면 브라우저에서 https://www.law.go.kr 이 열리는지 확인하세요.",
  },
  {
    test: /예상 밖 응답/,
    cause: "법제처가 오류 응답을 반환 — 키가 거부됐을 가능성이 큽니다",
    hint: ".env의 LAW_OC 값이 법제처 가입 이메일의 @ 앞부분과 같은지 확인하세요 (발급·확인: https://open.law.go.kr/LSO/openApi/guideResult.do).",
  },
  {
    // 로컬 한도(이 서버의 토큰버킷)는 법제처 429와 원인도 조치도 다르다 — 종전엔 둘을 한 줄로 묶어
    // 로컬 한도에도 "FIN_DRF_RATE_PER_MIN을 낮추세요"라고 해, 이미 막힌 한도를 더 조이게 했다 (Codex 9차 P2)
    test: /RATE_LIMITED: 일일/,
    cause: "이 서버의 일일 호출 한도(FIN_DRF_DAILY_CAP, 기본 1,500회) 소진 — 법제처 거부가 아니라 로컬 한도입니다",
    hint: "메시지의 대기 시간이 지난 뒤 다시 시도하세요.",
  },
  {
    test: /RATE_LIMITED/,
    cause: "이 서버의 분당 호출 한도(FIN_DRF_RATE_PER_MIN, 기본 30회) 소진 — 법제처 거부가 아니라 로컬 한도입니다",
    hint: "진단 직전에 다른 도구 호출이 몰렸을 수 있습니다. 1분 뒤 다시 시도하세요.",
  },
  {
    test: /\(429\)|한도 초과/,
    cause: "법제처가 호출 한도 초과(429)를 반환",
    hint: "1~2분 뒤 다시 시도하세요. 같은 키를 다른 도구와 함께 쓰고 있다면 FIN_DRF_RATE_PER_MIN을 낮추세요.",
  },
  {
    test: /법제처 서버 오류/,
    cause: "법제처 서버 오류 (5xx)",
    hint: "법제처 쪽 장애입니다. 잠시 후 다시 시도하세요.",
  },
  {
    test: /fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|getaddrinfo|certificate|socket/i,
    cause: "네트워크 연결 실패",
    hint: "인터넷 연결과 사내 프록시 설정을 확인하세요 (국세청 예규 본문 경로만 LAW_EXTERNAL_HTTPS_PROXY를 씁니다).",
  },
]

/**
 * 법제처 API 실조회 진단.
 *
 * ⚠ 이 호출은 일반 도구와 **같은 경로**(세마포어 → 분당 한도 → 재시도)를 탄다. 진단만 우회로를
 * 쓰면 "핑은 되는데 도구는 안 되는" 상태를 못 잡는다.
 * ⚠ 단 **캐시 읽기만은 건너뛴다** — 캐시 적중은 네트워크를 타지 않고 200을 돌려주므로, 직전 도구
 * 호출이 같은 검색을 담아 뒀으면 법제처가 죽어 있어도 "통신: 성공"이 나갔다 (Codex 9차 P1)
 */
async function probeLawApi(): Promise<{ line: string; hint?: string; note?: string }> {
  const aborter = new AbortController()
  const timer = setTimeout(() => aborter.abort(), PING_PROBE_TIMEOUT_MS)
  const startedAt = Date.now()
  try {
    // 가장 가벼운 조회 1건 — display=1, 재무 실무에서 가장 흔한 법령명
    const xml = await apiClient.searchLaw("법인세법", undefined, 1, "law", aborter.signal, { bypassCache: true })
    const ms = Date.now() - startedAt
    // 수신 건수는 결과 블록 수로 센다. 블록이 안 잡히면(응답 형식 변화) totalCnt로 내려간다 —
    // 어느 쪽도 못 세면 "성공"만 말하고 건수를 지어내지 않는다
    const received = (xml.match(/<law[\s>]/g) || []).length
    const totalCnt = /<totalCnt>\s*(\d+)\s*<\/totalCnt>/.exec(xml)?.[1]
    // 법인세법 검색이 0건이면 통신은 됐어도 정상 응답이 아니다 — 실존 법령이 0건으로 오는 상태를
    // "성공"이라 부르면 도구마다 "없음"이 쏟아지는 원인을 진단이 가린다 (Codex 9차 P2)
    if (received === 0 && (totalCnt === undefined || totalCnt === "0")) {
      return {
        line: `법제처 API 통신: 실패 — 응답은 왔으나 법인세법 검색 결과가 0건입니다 (${ms}ms)`,
        hint:
          "정상이라면 1건 이상이어야 합니다. 법제처 일시 장애·응답 형식 변경·키 권한 문제일 수 있습니다 — " +
          "잠시 후 다시 시도하고, 계속되면 .env의 LAW_OC 값을 확인하세요.",
      }
    }
    const count = received > 0 ? String(received) : totalCnt
    return {
      line: `법제처 API 통신: 성공 (법인세법 검색 ${count ? `${count}건, ` : ""}${ms}ms)`,
      note: "통신 성공은 키 값이 맞다는 확인이 아닙니다 — 틀린 키에도 법제처가 정상 응답한 실측 사례가 있습니다(원인 미확인). 키는 .env의 LAW_OC를 직접 확인하세요",
    }
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e)
    const matched = PROBE_CAUSES.find((c) => c.test.test(raw))
    return {
      line: `법제처 API 통신: 실패 — ${matched ? matched.cause : raw.slice(0, 200)}`,
      hint:
        matched?.hint ??
        "LAW_OC 값과 인터넷 연결을 확인하고, https://open.law.go.kr 접속이 되는지 브라우저로 확인하세요.",
    }
  } finally {
    clearTimeout(timer)
  }
}

// 세 번째 인자는 호출 맥락 — 지금은 MCP 요청 취소 신호만 싣는다. 받는 핸들러(fin_annex)만 쓰고
// 나머지는 무시한다 (각자 자체 deadline aborter를 둔다)
const HANDLERS: Record<
  string,
  (client: LawApiClient, args: unknown, ctx: { signal?: AbortSignal }) => Promise<ToolResult>
> = {
  fin_topic: handleFinTopic,
  fin_article: handleFinArticle,
  fin_law_search: handleFinLawSearch,
  fin_ruling_search: handleFinRulingSearch,
  fin_nts_ruling: handleFinNtsRuling,
  fin_annex: handleFinAnnex,
  fin_verify: handleFinVerify,
  fin_calc: handleFinCalc,
}

server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  const handler = HANDLERS[req.params.name]
  if (handler) {
    // 최종 방어선 — 핸들러 밖으로 샌 예외를 영어 JSON-RPC 오류 대신 한글 isError 응답으로 바꾼다
    // (topic·calc·ruling-search에는 최상위 try가 없다. errors.ts runToolSafely 참고)
    return await runToolSafely(req.params.name, () =>
      handler(apiClient, req.params.arguments ?? {}, { signal: extra.signal })
    )
  }
  if (req.params.name === "fin_ping") {
    const lines = [`fin-law-mcp v${VERSION} 정상 동작`]
    if (process.env.LAW_OC) {
      const probe = await probeLawApi()
      lines.push(`LAW_OC: 설정됨 · ${probe.line}`)
      // 실패는 원인 한 줄로 끝내지 않는다 — 다음에 무엇을 할지까지 줘야 진단이다
      if (probe.hint) lines.push(`  → 다음 조치: ${probe.hint}`)
      if (probe.note) lines.push(`  ※ ${probe.note}`)
    } else {
      lines.push(
        "LAW_OC: 누락 — .env에 LAW_OC=<법제처 OPEN API 키>를 넣으세요" +
          " (무료 발급: https://open.law.go.kr/LSO/openApi/guideResult.do · 가입 이메일 @ 앞부분이 키)"
      )
    }
    // 부팅 시 확정한 값을 그대로 보고한다 — 여기서 env를 다시 읽으면 tools/list가
    // 실제로 무엇을 실었는지와 어긋난 진단이 나갈 수 있다 (NTS_RULING_LISTED 주석)
    lines.push(
      NTS_RULING_LISTED
        ? "FIN_NTS_BODY_ENABLED: true — 국세청 예규 본문 동봉 사용 (fin_nts_ruling 등록됨)"
        : "FIN_NTS_BODY_ENABLED: 미설정(기본 off) — 예규는 목록·링크만. 본문이 필요하면 .env에 true"
    )
    lines.push(
      TOPIC_LISTED
        ? "FIN_TOPIC_ENABLED: true — 실험 기능 fin_topic(업무 주제 큐레이션 표) 등록됨"
        : "FIN_TOPIC_ENABLED: 미설정(기본 off) — 실험 기능 fin_topic 미등록"
    )
    // 진단 실패는 isError가 아니다 — fin_ping은 "물어본 것"을 정확히 답했고,
    // isError로 만들면 클라이언트에 따라 이 본문이 통째로 감춰진다
    return { content: [{ type: "text", text: lines.join("\n") }] }
  }
  return {
    content: [{ type: "text", text: `알 수 없는 도구: ${req.params.name}` }],
    isError: true,
  }
})

await server.connect(new StdioServerTransport())
