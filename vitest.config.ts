import { defineConfig } from "vitest/config"

/**
 * 기본 테스트는 fixture 기반 결정형만 — 실 API 호출 없이 CI에서 항상 같은 결과여야 한다.
 * 라이브 골든셋(test/golden-live.test.ts)은 .env의 LAW_OC가 있으면 자동 실행되어
 * 법제처 장애·rate limit으로 `npm test`를 깨뜨렸다 (Codex 리뷰 차단 1).
 * → 기본 스위트에서 제외하고 `npm run test:live`로만 돌린다.
 */
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/build/**", "test/golden-live.test.ts"],
  },
})
