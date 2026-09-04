import { defineConfig } from "vitest/config"

/** 라이브 전용 — 실 법제처 API를 호출한다 (LAW_OC 필요, 수동/야간 잡).
 *  · golden-live: 절대 깨지면 안 되는 응답 골든셋
 *  · calc-constants-live: fin_calc 하드코딩 상수를 조문 원문과 대조 (매년 개정 감지)
 *  두 파일을 동시에 돌리면 법제처 분당 한도(기본 30)에 걸려 조회 실패가 무더기로 난다 —
 *  결함이 아니라 측정 잡음이므로 파일 병렬을 끈다. */
export default defineConfig({
  test: {
    include: ["test/golden-live.test.ts", "test/calc-constants-live.test.ts"],
    fileParallelism: false,
  },
})
