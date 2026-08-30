/**
 * fin_article 회귀 — 행정규칙 이름에 조문을 붙여 물었을 때 (잔여①)
 *
 * 「외국환거래규정」(기재부 고시) 제9-5조처럼 법령 DB에 없는 행정규칙을 조문까지
 * 붙여 물으면 "정상 조회 후 0건 — ✗없음"으로 답하고 있었다. 같은 서버의
 * fin_law_search·fin_verify는 실존을 확인해 주는데 조문 요청만 없음으로 단정하던
 * 모순이다 — 실존하는 고시를 환각으로 낙인찍는 방향의 오답이라 위험도가 높다.
 */
import { describe, it, expect } from "vitest"
import { handleFinArticle } from "./article.js"
import type { LawApiClient } from "../lib/api-client.js"

const EMPTY_LAW_XML = '<?xml version="1.0"?><LawSearch><totalCnt>0</totalCnt></LawSearch>'

const NOISE_LAW_XML = `<?xml version="1.0" encoding="UTF-8"?>
<LawSearch><totalCnt>1</totalCnt>
  <law id="1"><법령명한글>외국환거래법 시행령</법령명한글><법령일련번호>999999</법령일련번호><법령ID>3</법령ID>
    <법령구분명>대통령령</법령구분명><소관부처명>기획재정부</소관부처명><소관부처코드>1051000</소관부처코드>
    <시행일자>20260101</시행일자><제개정구분명>일부개정</제개정구분명><현행연혁코드>현행</현행연혁코드></law>
</LawSearch>`

const ADMRUL_HIT_XML =
  '<?xml version="1.0"?><AdmRulSearch><totalCnt>1</totalCnt><admrul>' +
  "<행정규칙명>외국환거래규정</행정규칙명><행정규칙종류>고시</행정규칙종류>" +
  "<소관부처명>기획재정부</소관부처명><발령일자>20260702</발령일자></admrul></AdmRulSearch>"

const ADMRUL_EMPTY_XML = '<?xml version="1.0"?><AdmRulSearch><totalCnt>0</totalCnt></AdmRulSearch>'

function stub(lawXml: string, admrulXml: string): LawApiClient {
  return {
    searchLaw: async () => lawXml,
    fetchApi: async () => lawXml,
    searchAdminRule: async () => admrulXml,
    getThreeTier: async () => "{}",
    getAnnexes: async () => "{}",
  } as unknown as LawApiClient
}

describe("fin_article — 행정규칙 조문 요청 (잔여①)", () => {
  it("법령 DB 0건이어도 행정규칙으로 실존하면 ✗없음으로 단정하지 않는다", async () => {
    const r = await handleFinArticle(stub(EMPTY_LAW_XML, ADMRUL_HIT_XML), {
      law: "외국환거래규정",
      article: "제9-5조",
    })
    const text = r.content[0].text
    expect(text).toContain("[ADMIN_RULE]")
    expect(text).toContain("외국환거래규정")
    expect(text).toContain("고시")
    expect(text).not.toContain("[LAW_NOT_FOUND]")
    // "없는 조문"과 "조회 미지원"을 명확히 구분해야 한다
    expect(text).toContain("조회 미지원")
  })

  it("조문 본문은 주지 않고 추측 금지를 명시한다 (행정규칙은 조문 단위 API가 없다)", async () => {
    const r = await handleFinArticle(stub(EMPTY_LAW_XML, ADMRUL_HIT_XML), {
      law: "외국환거래규정",
      article: "제9-5조",
    })
    expect(r.content[0].text).toContain("추측하지 마세요")
    expect(r.content[0].text).toContain("제9-5조")
  })

  it("이름만 비슷한 법령이 1건 걸려도 행정규칙 실존을 확인한다 (0건 전용 폴백 금지)", async () => {
    const r = await handleFinArticle(stub(NOISE_LAW_XML, ADMRUL_HIT_XML), {
      law: "외국환거래규정",
      article: "제9-5조",
    })
    const text = r.content[0].text
    expect(text).toContain("[ADMIN_RULE]")
    // 무관한 법령의 조문을 본문으로 내주지 않는다
    expect(text).not.toContain("외국환거래법 시행령 제9-5조")
  })

  it("행정규칙에도 없으면 기존 ✗없음 판정을 유지한다 (환각 낙인은 그대로)", async () => {
    const r = await handleFinArticle(stub(EMPTY_LAW_XML, ADMRUL_EMPTY_XML), {
      law: "탄소세규정",
      article: "제5조",
    })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain("[LAW_NOT_FOUND]")
  })

  it("행정규칙 형태가 아닌 이름은 행정규칙 DB를 조회하지 않는다", async () => {
    let called = false
    const client = {
      searchLaw: async () => EMPTY_LAW_XML,
      fetchApi: async () => EMPTY_LAW_XML,
      searchAdminRule: async () => {
        called = true
        return ADMRUL_HIT_XML
      },
    } as unknown as LawApiClient
    const r = await handleFinArticle(client, { law: "탄소세법", article: "제5조" })
    expect(called).toBe(false)
    expect(r.content[0].text).toContain("[LAW_NOT_FOUND]")
  })
})

/**
 * Codex 공개 전 리뷰 차단 3 회귀 — 조회 실패를 부존재로 변환하던 문제.
 * adminRuleNotice가 행정규칙 API 오류를 catch로 삼키고 null을 돌려주면,
 * 호출자는 그것을 "행정규칙에도 없음"으로 읽어 `[LAW_NOT_FOUND] ✗없음`을 찍는다.
 * 이 함수가 존재하는 이유(실존 고시를 없다고 단정하지 않기)와 정반대 동작이다.
 */
describe("fin_article — 행정규칙 조회 실패 (Codex 리뷰 차단 3)", () => {
  const failingClient = (err: Error): LawApiClient =>
    ({
      searchLaw: async () => EMPTY_LAW_XML,
      fetchApi: async () => EMPTY_LAW_XML,
      searchAdminRule: async () => {
        throw err
      },
    }) as unknown as LawApiClient

  it("행정규칙 DB 장애를 '법령 없음'으로 단정하지 않는다", async () => {
    const r = await handleFinArticle(failingClient(new Error("법제처 API가 HTML 오류 페이지를 반환했습니다")), {
      law: "외국환거래규정",
      article: "제9-5조",
    })
    const text = r.content[0].text
    expect(text).not.toContain("[LAW_NOT_FOUND]")
    expect(text).toContain("⚠판정불가")
    expect(text).toContain("실패")
    expect(text).toContain('"존재하지 않는 규정"으로 단정하지 마세요')
  })

  it("타임아웃도 부존재가 아니라 판정불가로 보고한다", async () => {
    const r = await handleFinArticle(failingClient(new Error("요청 시간 초과 (3000ms)")), {
      law: "외국환거래규정",
      article: "제9-5조",
    })
    const text = r.content[0].text
    expect(text).toContain("REQUEST_TIMEOUT")
    expect(text).not.toContain("✗없음")
  })
})

/**
 * Codex 2차 차단 2 회귀 — exact 플래그를 만들어 놓고 소비자에 전파하지 않던 문제.
 * 「국세청 사무처리규정」 요청에 「…시행세칙」만 있어도 "실존"으로 답하면
 * 요청과 다른 문서를 근거로 만들게 된다.
 */
const PREFIX_ADMRUL_XML =
  '<?xml version="1.0"?><AdmRulSearch><totalCnt>1</totalCnt><admrul>' +
  "<행정규칙명>국세청 사무처리규정 시행세칙</행정규칙명><행정규칙종류>훈령</행정규칙종류>" +
  "<소관부처명>국세청</소관부처명><발령일자>20260101</발령일자></admrul></AdmRulSearch>"

describe("fin_article — 행정규칙 접두 일치 (Codex 2차 차단 2)", () => {
  it("이름이 겹치는 다른 규칙을 실존으로 단정하지 않는다", async () => {
    const r = await handleFinArticle(stub(EMPTY_LAW_XML, PREFIX_ADMRUL_XML), {
      law: "국세청 사무처리규정",
      article: "제1조",
    })
    const text = r.content[0].text
    expect(text).toContain("[ADMIN_RULE_AMBIGUOUS]")
    expect(text).toContain("정확히 일치하는")
    expect(text).toContain("국세청 사무처리규정 시행세칙")
    expect(text).not.toContain("[ADMIN_RULE] ")
    // 다른 문서의 내용을 요청 규정의 내용으로 쓰지 말라고 명시
    expect(text).toContain("쓰지 마세요")
  })

  it("정확 일치는 종전대로 실존으로 답한다", async () => {
    const r = await handleFinArticle(stub(EMPTY_LAW_XML, ADMRUL_HIT_XML), {
      law: "외국환거래규정",
      article: "제9-5조",
    })
    expect(r.content[0].text).toContain("[ADMIN_RULE]")
    expect(r.content[0].text).not.toContain("AMBIGUOUS")
  })
})

/**
 * 법제처 lawService.do 거동 변화 대응 (2026-08-30 실측) — efYd 없는 eflaw 호출이
 * HTML 오류 페이지로 돌아오기 시작했다 (같은 MST·JO의 target=law는 정상,
 * eflaw+efYd 동반도 정상). 현행 조회가 eflaw로 남아 있으면 fin_article 본문이
 * 전면 "⚠ 조회 실패"가 되고, 위임 본문 동봉은 catch에 삼켜져 조용히 빠진다.
 */
describe("fin_article — 현행 조문 조회는 target=law", () => {
  const LAW_HIT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<LawSearch><totalCnt>1</totalCnt>
  <law id="1"><법령명한글>법인세법</법령명한글><법령일련번호>280349</법령일련번호><법령ID>1563</법령ID>
    <법령구분명>법률</법령구분명><소관부처명>기획재정부</소관부처명>
    <시행일자>20260701</시행일자><제개정구분명>일부개정</제개정구분명><현행연혁코드>현행</현행연혁코드></law>
</LawSearch>`

  it("efYd 없는 lawService 호출에 eflaw를 쓰지 않는다", async () => {
    const targets: string[] = []
    const client = {
      searchLaw: async () => LAW_HIT_XML,
      fetchApi: async (p: { endpoint: string; target: string }) => {
        if (p.endpoint === "lawService.do") targets.push(p.target)
        return '{"법령":{}}'
      },
      searchAdminRule: async () => ADMRUL_EMPTY_XML,
      getThreeTier: async () => "{}",
      getAnnexes: async () => "{}",
    } as unknown as LawApiClient
    await handleFinArticle(client, { law: "법인세법", article: "제26조" })
    expect(targets.length).toBeGreaterThan(0)
    expect(targets.every((t) => t === "law")).toBe(true)
  })
})
