import { defineConfig } from "vitest/config"

/** 라이브 전용 — 실 법제처 API를 호출한다 (LAW_OC 필요, 수동/야간 잡).
 *  파일명 규칙 `*-live.test.ts`로 잡는다(기본 스위트 vitest.config.ts는 같은 규칙으로 제외).
 *  · golden-live: 절대 깨지면 안 되는 응답 골든셋
 *  · calc-constants-live: fin_calc 하드코딩 상수를 조문 원문과 대조 (매년 개정 감지)
 *  · topic-articles-live: fin_topic 주제표의 (법령, 조문)이 실존하고 제목이 같은지 대조
 *  이 파일들을 동시에 돌리면 법제처 분당 한도(기본 30)에 걸려 조회 실패가 무더기로 난다 —
 *  결함이 아니라 측정 잡음이므로 파일 병렬을 끈다. */
export default defineConfig({
  test: {
    include: ["**/*-live.test.ts"],
    exclude: ["**/node_modules/**", "**/build/**", "**/.release-scratch/**"],
    fileParallelism: false,
  },
})
