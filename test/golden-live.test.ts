/**
 * 골든셋 라이브 테스트 — 실 법제처 API 호출 (LAW_OC 필요)
 *
 * 절대 깨지면 안 되는 회귀 기준 (PRD 04_PROJECT_SPEC):
 *   1. 소득세법 §12 조회 시 목(目)이 45개 이상 전부 나온다 (352자 절단 사고 재발 방지)
 *   2. fin_article(법인세법 제26조)에 시행령 위임조문 본문이 동봉된다 (묶음 = 제품)
 *
 * CI 상시 실행 대상이 아니다 — 실 API 골든셋은 수동/야간 잡 (법제처 장애가 CI를 깨지 않게).
 * 실행: npx vitest run test/golden-live.test.ts
 */

import { describe, it, expect, beforeAll } from "vitest"
import { config } from "dotenv"
import { LawApiClient } from "../src/lib/api-client.js"
import { handleFinArticle } from "../src/tools/article.js"

config({ quiet: true })

const hasKey = !!process.env.LAW_OC
const d = describe.runIf(hasKey)

let apiClient: LawApiClient

beforeAll(() => {
  apiClient = new LawApiClient({ apiKey: process.env.LAW_OC || "" })
})

d("골든셋: fin_article", () => {
  it(
    "법인세법 제26조 — 조문+시행령 본문+예규 문서번호가 1회 응답에 동봉된다",
    { timeout: 30_000 },
    async () => {
      const res = await handleFinArticle(apiClient, { law: "법인세법", article: "제26조" })
      expect(res.isError).toBeFalsy()
      const text = res.content[0].text

      // 조문 본문
      expect(text).toContain("과다경비 등의 손금불산입")
      expect(text).toContain("손금에 산입하지 아니한다")
      // 시행령 위임조문 '본문' 동봉 (목록만이 아니라)
      expect(text).toContain("법인세법 시행령 제43조")
      expect(text).toContain("상여금")
      // 예규 문서번호 표기 (법인46012-3683 / 법인세과-352 형식)
      expect(text).toMatch(/[가-힣]+\d{2,5}-\d{2,4}/)
      // 별표에 재무 핵심 표 노출
      expect(text).toContain("기준내용연수")
      // 조용한 실패 없음 (전체 성공 또는 실패 사유 명시)
      expect(text).toMatch(/전체 성공|부분 성공/)
      // 출처 고지
      expect(text).toContain("국가법령정보센터")
    }
  )

  it(
    "소득세법 제12조 — 목(目) 45개 이상 전부 나온다 (잘림 감지)",
    { timeout: 30_000 },
    async () => {
      const res = await handleFinArticle(apiClient, {
        law: "소득세법",
        article: "제12조",
        include_rulings: false,
      })
      expect(res.isError).toBeFalsy()
      const text = res.content[0].text

      // 목 라인 패턴: 들여쓰기 6칸 + "가." 형식
      const mokCount = (text.match(/^\s{6}[가-힣]{1,2}\./gm) || []).length
      expect(mokCount).toBeGreaterThanOrEqual(45)
      // 과거 사고: 352자로 절단 — 본문 길이 하한
      expect(text.length).toBeGreaterThan(4_000)
    }
  )
})

if (!hasKey) {
  describe("골든셋 (건너뜀)", () => {
    it("LAW_OC 미설정 — 라이브 골든셋은 키 설정 후 실행", () => {
      expect(hasKey).toBe(false)
    })
  })
}
