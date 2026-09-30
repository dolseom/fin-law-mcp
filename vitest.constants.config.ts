import { defineConfig } from "vitest/config"

/** fin_calc 상수 원문 대조 전용 — `npm run test:constants` (LAW_OC 필요).
 *  FIN_LIVE_STRICT=1: 조회 실패·키 없음도 실패로 올린다. skip이 초록불로 보여 "대조하지 못했다"가
 *  통과로 묻히지 않게 — CONSTANTS_CHECKED_ON(calc.ts)은 이 명령이 전부 통과한 뒤에만 올린다.
 *  (vitest.live.config.ts와 병합하지 않는다 — mergeConfig는 include 배열을 이어 붙여 라이브 전체가 돈다) */
export default defineConfig({
  test: {
    include: ["test/calc-constants-live.test.ts"],
    exclude: ["**/node_modules/**", "**/build/**", "**/.release-scratch/**"],
    env: { FIN_LIVE_STRICT: "1" },
  },
})
