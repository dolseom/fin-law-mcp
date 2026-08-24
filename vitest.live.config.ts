import { defineConfig } from "vitest/config"

/** 라이브 골든셋 전용 — 실 법제처 API를 호출한다 (LAW_OC 필요, 수동/야간 잡). */
export default defineConfig({
  test: {
    include: ["test/golden-live.test.ts"],
  },
})
