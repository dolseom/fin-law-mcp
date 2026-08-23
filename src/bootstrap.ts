/**
 * 환경 부트스트랩 — 반드시 index.ts의 "첫 번째 import"여야 한다.
 *
 * ESM import 호이스팅 때문에 index.ts 본문에서 config()를 호출해도
 * 의존 모듈의 모듈 스코프 상수(LAW_API_BASE, UA/Referer, 기본 N값 등)가
 * .env 로드보다 먼저 평가된다 (Codex 코드 리뷰 중요 5 — 실결함).
 * MCP 클라이언트가 임의 cwd에서 실행해도 되도록 모듈 기준 경로로 로드한다.
 */

import { config } from "dotenv"
import { fileURLToPath } from "node:url"
import path from "node:path"

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.join(moduleDir, "..", ".env"), quiet: true })
