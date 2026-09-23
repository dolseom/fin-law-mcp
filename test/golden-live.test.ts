/**
 * 골든셋 라이브 테스트 — 실 법제처 API 호출 (LAW_OC 필요)
 *
 * 절대 깨지면 안 되는 회귀 기준 (PRD 04_PROJECT_SPEC):
 *   1. 소득세법 §12 조회 시 목(目)이 45개 이상 전부 나온다 (352자 절단 사고 재발 방지)
 *   2. fin_article(법인세법 제26조)에 시행령 위임조문 본문이 동봉된다 (묶음 = 제품)
 *   3. fin_annex(법인세법 시행규칙 별표 6)가 기준내용연수표의 **값**을 표 구조 그대로 준다
 *      (별표명 목록만 나오는 것은 통과가 아니다 — 실무자는 "제조업 몇 년"을 알아야 한다)
 *
 * CI 상시 실행 대상이 아니다 — 실 API 골든셋은 수동/야간 잡 (법제처 장애가 CI를 깨지 않게).
 * 실행: npx vitest run test/golden-live.test.ts
 */

import { describe, it, expect, beforeAll } from "vitest"
import { config } from "dotenv"
import { LawApiClient } from "../src/lib/api-client.js"
import { handleFinArticle } from "../src/tools/article.js"
import { handleFinAnnex } from "../src/tools/annex.js"

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
      // 예규 문서번호 표기 (구형 법인46012-3683 / 신형 법인세과-352·법규과-1353 형식).
      // 최신순(sort=ddes) 전환 후 상위는 신형 번호다 — 구형만 받던 정규식이 신형을 놓쳤다
      expect(text).toMatch(/[가-힣]+(?:\d{2,5})?-\d{2,4}/)
      // 별표에 재무 핵심 표 노출
      expect(text).toContain("기준내용연수")
      // 조용한 실패 없음 (전체 성공 또는 실패 사유 명시)
      expect(text).toMatch(/전체 성공|부분 성공/)
      // 출처 고지
      expect(text).toContain("국가법령정보센터")
    }
  )

  it(
    "기준일 조회(2015-07-01 법인세법 §55) — 현행 데이터가 무고지로 섞이지 않는다",
    { timeout: 30_000 },
    async () => {
      // 실사용 시뮬레이션 차단 지적: 기준일 헤더 아래 별표·위임·개정경고가 현행 데이터로
      // 무고지 혼입 + 위임 본문 공백 삼킴 ("헤더는 기준일, 내용은 현행"인 조용한 거짓)
      const res = await handleFinArticle(apiClient, {
        law: "법인세법",
        article: "제55조",
        basis_date: "2015-07-01",
        include_rulings: false,
      })
      expect(res.isError).toBeFalsy()
      const text = res.content[0].text

      // 조문 본문은 실제 2015년 시행본 (당시 최고세율 22% — 현행과 다름)
      expect(text).toContain("100분의 22")
      // 섹션별 기준을 상단에 고지
      expect(text).toContain("기준일 조회 범위")
      // 위임(3단비교)은 현행 매핑을 붙이지 않고 정직하게 생략
      // ("월수의 계산" 문구는 §55② 조문 본문에 정당하게 존재 — 위임 누출 지표는 조문 번호로)
      expect(text).toContain("기준일 조회 미지원")
      expect(text).not.toContain("시행령 제92조") // 현행 §55의 위임 매핑이 붙으면 회귀
      // 별표는 [현행 기준] 라벨
      expect(text).toContain("별표 [현행 기준")
      // 개정 예정 경고(현행 전용)가 기준일 응답에 붙지 않는다
      expect(text).not.toContain("■ ⚠ 법령 개정 예정") // 줄 머리 (R3 항목 5에서 "법령 단위" 문구로 변경)
      expect(text).not.toContain("개정 공포됨")
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

d("골든셋: fin_annex", () => {
  it(
    "법인세법 시행규칙 별표 6 — 기준내용연수표의 값이 표 구조로 추출된다",
    { timeout: 60_000 },
    async () => {
      const res = await handleFinAnnex(apiClient, { law: "법인세법 시행규칙", annex_no: "6" })
      expect(res.isError).toBeFalsy()
      const text = res.content[0].text

      // 어느 법령의 몇 번 별표인지 (다른 법령 별표 혼입 방어)
      expect(text).toContain("법인세법 시행규칙 [별표 6]")
      expect(text).toContain("업종별 자산의 기준내용연수 및 내용연수범위")
      // 표 구조 보존 — 평문으로 뭉개지면 "업종↔연수" 대응이 깨져 값 인용이 불가능해진다
      expect(text).toContain("<table>")

      // 값 대조: 줄바꿈 태그·물결표(～ ∼ ~) 표기 흔들림을 흡수한 뒤 실값을 확인한다
      const flat = text
        .replace(/<br\s*\/?>/g, "")
        .replace(/[～∼~]/g, "~")
        .replace(/\s+/g, "")

      // 제1호 4년(3년~5년) — 가죽·가방·신발 제조업 / 교육 서비스업
      expect(flat).toContain("4년(3년~5년)")
      expect(flat).toContain("15.가죽,가방및신발제조업")
      expect(flat).toContain("85.교육서비스업")
      // 제4호 8년(6년~10년) — 종합 건설업
      expect(flat).toContain("8년(6년~10년)")
      expect(flat).toContain("41.종합건설업")
      // 제5호 10년(8년~12년) — 식료품 제조업
      expect(flat).toContain("10년(8년~12년)")
      expect(flat).toContain("10.식료품제조업")
      // 제9호 20년(15년~25년) — 수도업 (표의 최장 구간)
      expect(flat).toContain("20년(15년~25년)")
      expect(flat).toContain("36.수도업")
      // 표 하단 비고까지 절단 없이 도달한다 (중간에서 잘리면 마지막 구간이 사라진다)
      expect(flat).toContain("별표3또는별표5의적용을받는자산을제외한")
      // 출처 고지
      expect(text).toContain("국가법령정보센터")
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
