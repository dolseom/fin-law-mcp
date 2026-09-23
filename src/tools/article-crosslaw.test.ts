/**
 * fin_article 회귀 — 3단비교 역방향의 **다른 하위법령 항목 혼입**(9차 리뷰 B1)과
 * **다른 기준법령 표**(B2), 그리고 `기준법령목록` 배열 형태의 파서 예외(I3)
 *
 * B1: 모법 표의 시행령 열에는 그 모법이 위임한 **다른 대통령령**의 조문도 섞여 온다
 *   (2026-09-16 raw: 국세기본법 표에 「국무조정실과 그 소속기관 직제」 6건, 조세특례제한법 표에
 *   「농ㆍ축산ㆍ임ㆍ어업용 기자재 … 특례규정」 31건 등). 조번호만 맞추면 「국세기본법 시행령」 §18에
 *   직제 §18(비상임심판관)의 모법인 국세기본법 §67(조세심판원)이 [모법]으로 실린다 — 검수자 라이브 재현.
 *   리뷰어 전수 계산: 후보 38개 조문 중 33개에서 출력에 노출.
 *
 * B2: 하위법령 MST로 부르면 기준법령이 여럿일 때 `기준법령목록.법령명`이 배열로 오고, 표는 첫 항목의
 *   것이다(소득세법 시행령 → ["법인세법","소득세법","지방세특례제한법"] → 법인세법 표). 9/6 가드는
 *   그 표를 막기만 해서 **진짜 위임까지 떨어뜨렸다**. 리뷰어 실측: 모법 MST로 다시 받으면 5건 모두
 *   자기 위임이 온전히 나온다.
 *
 * 픽스처는 `.release-scratch/probes/r9-raw/thd-*.json` 실응답에서 행을 잘라 썼다 (조내용만 줄임).
 */
import { describe, it, expect, beforeEach } from "vitest"
import { handleFinArticle } from "./article.js"
import { parseThreeTierRows } from "../lib/three-tier-parser.js"
import { lawCache } from "../lib/cache.js"
import { normalizeLawSearchText, resolveLawAlias } from "../lib/search-normalizer.js"
import type { LawApiClient } from "../lib/api-client.js"

/** 실 LawApiClient.searchLaw는 질의를 정규화·별칭 해소한 뒤 던진다 — 스텁도 같게 */
const asSearched = (q: string) => resolveLawAlias(normalizeLawSearchText(q)).canonical.replace(/\s+/g, "")

const lawXml = (name: string, mst: string, id: string, type: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<LawSearch><totalCnt>1</totalCnt>
  <law id="1"><법령명한글>${name}</법령명한글><법령일련번호>${mst}</법령일련번호><법령ID>${id}</법령ID>
    <법령구분명>${type}</법령구분명><시행일자>20260227</시행일자><제개정구분명>일부개정</제개정구분명><현행연혁코드>현행</현행연혁코드></law>
</LawSearch>`
const EMPTY_LAW_XML = '<?xml version="1.0"?><LawSearch><totalCnt>0</totalCnt></LawSearch>'
const EMPTY_RULING_XML = '<?xml version="1.0"?><CgmExpc><totalCnt>0</totalCnt></CgmExpc>'

const articleJson = (num: string, branch: string, title: string, body: string) =>
  JSON.stringify({
    법령: { 조문: { 조문단위: [{ 조문여부: "조문", 조문번호: num, 조문가지번호: branch, 조문제목: title, 조문내용: body }] } },
  })

interface Law {
  name: string
  mst: string
  id: string
  type: string
}

/**
 * 법령명 → MST, (MST, JO) → 조문 본문, MST → 3단비교 응답으로 분기하는 스텁.
 * 3단비교 호출 MST를 기록한다 — 모법 재조회 여부를 본다.
 */
function stub(laws: Law[], bodies: Record<string, string>, thd: Record<string, string | Error>, thdCalls: string[] = []): LawApiClient {
  return {
    searchLaw: async (q: string) => {
      const hit = laws.find((l) => l.name.replace(/\s+/g, "") === asSearched(q))
      return hit ? lawXml(hit.name, hit.mst, hit.id, hit.type) : EMPTY_LAW_XML
    },
    fetchApi: async (p: { endpoint: string; extraParams?: Record<string, string> }) => {
      if (p.endpoint === "lawSearch.do") return EMPTY_RULING_XML
      return bodies[`${p.extraParams?.MST}|${p.extraParams?.JO}`] ?? '{"법령":{}}'
    },
    getThreeTier: async (p: { mst?: string }) => {
      thdCalls.push(p.mst || "")
      const r = thd[p.mst || ""]
      if (r instanceof Error) throw r
      return r ?? '{"LspttnThdCmpLawXService":{"기본정보":{"삼단비교존재여부":"N"}}}'
    },
    getAnnexes: async () => "{}",
    searchAdminRule: async () => '<?xml version="1.0"?><AdmRulSearch><totalCnt>0</totalCnt></AdmRulSearch>',
  } as unknown as LawApiClient
}

const table = (queried: { name: string; mst: string }, baseName: string | null, baseList: string | string[] | null, rows: unknown[]) =>
  JSON.stringify({
    LspttnThdCmpLawXService: {
      기본정보: {
        법령일련번호: queried.mst,
        법령명: queried.name,
        삼단비교존재여부: "Y",
        ...(baseName ? { 기준법령명: baseName } : {}),
      },
      ...(baseList
        ? {
            기준법령목록: {
              법령명: baseList,
              위임3단비교상세링크: Array.isArray(baseList)
                ? baseList.map(() => "/DRF/lawService.do?OC=test&target=thdCmp&ID=000000&knd=2&type=XML&mobileYn=")
                : "/DRF/lawService.do?OC=test&target=thdCmp&ID=000000&knd=2&type=XML&mobileYn=",
            },
          }
        : {}),
      위임조문삼단비교: { 법률조문: rows },
    },
  })

beforeEach(() => lawCache.clear())

// ── B1: 다른 하위법령 항목 혼입 ────────────────────────────────────────────

describe("fin_article 역방향 — 모법 표에 섞인 다른 하위법령 항목을 [모법]으로 싣지 않는다 (B1)", () => {
  const GIBON: Law = { name: "국세기본법", mst: "288571", id: "001586", type: "법률" }
  const GIBON_DECREE: Law = { name: "국세기본법 시행령", mst: "283623", id: "002884", type: "대통령령" }
  const DIRECTORATE = "국무조정실과 그 소속기관 직제"

  // thd-283623 실응답의 두 행 — 같은 조번호 0018이 국세기본법 시행령(§35)과 직제(§67)에 있다
  const ROWS = [
    {
      조번호: "0035",
      조가지번호: "00",
      조제목: "제35조(국세의 우선)",
      조내용: "①  국세 및 강제징수비는 다른 공과금이나 그 밖의 채권에 우선하여 징수",
      시행령조문: { 조제목: "제18조(국세의 우선)", 조가지번호: "00", 법령명: "국세기본법 시행령", 조내용: "", 조번호: "0018" },
      시행규칙조문: { 조제목: "제11조의3(가등기권리자에 대한 압류 통지 등)", 조가지번호: "03", 법령명: "국세기본법 시행규칙", 조내용: "", 조번호: "0011" },
    },
    {
      조번호: "0067",
      조가지번호: "00",
      조제목: "제67조(조세심판원)",
      조내용: "①  심판청구에 대한 결정을 하기 위하여 국무총리 소속으로 조세심판원을 ",
      시행령조문: { 조제목: "제18조(비상임심판관)", 조가지번호: "00", 법령명: DIRECTORATE, 조내용: "", 조번호: "0018" },
    },
  ]
  const BODIES = {
    [`${GIBON_DECREE.mst}|001800`]: articleJson("18", "0", "국세의 우선", "제18조(국세의 우선) 시행령 18조 본문"),
    [`${GIBON.mst}|003500`]: articleJson("35", "0", "국세의 우선", "제35조(국세의 우선) 모법 35조 본문"),
    [`${GIBON.mst}|006700`]: articleJson("67", "0", "조세심판원", "제67조(조세심판원) 모법 67조 본문"),
  }
  const THD = {
    [GIBON_DECREE.mst]: table(GIBON_DECREE, "국세기본법", "국세기본법", ROWS),
    [GIBON.mst]: table(GIBON, "국세기본법", "국세기본법", ROWS),
  }

  it("「국세기본법 시행령」 §18에 직제 §18의 모법(국세기본법 §67 조세심판원)이 실리지 않는다", async () => {
    const r = await handleFinArticle(stub([GIBON, GIBON_DECREE], BODIES, THD), { law: "국세기본법 시행령", article: "제18조", include_rulings: false })
    const text = r.content[0].text
    expect(text).not.toContain("[모법] 국세기본법 제67조")
    expect(text).not.toContain("조세심판원")
    expect(text).not.toContain("모법 67조 본문")
  })

  it("자기 법령명 항목의 모법(§35)과 같은 행의 시행규칙 짝은 그대로 나온다", async () => {
    const r = await handleFinArticle(stub([GIBON, GIBON_DECREE], BODIES, THD), { law: "국세기본법 시행령", article: "제18조", include_rulings: false })
    const text = r.content[0].text
    expect(text).toContain("■ 모법 위임 근거 (역방향)")
    expect(text).toContain("[모법] 국세기본법 제35조")
    expect(text).toContain("모법 35조 본문")
    expect(text).toContain("같은 위임 행의 시행규칙: 국세기본법 시행규칙 제11조의3")
    // 다른 법령 항목은 그 법령 것이다 — 소속 미확인으로 고지할 대상도 아니다
    expect(text).not.toContain("소속 미확인")
  })

  it("반대 방향: 본법 §67 정방향 위임에는 직제 조문이 그 법령명 그대로 나온다 (정방향 동작 유지)", async () => {
    const r = await handleFinArticle(stub([GIBON, GIBON_DECREE], BODIES, THD), { law: "국세기본법", article: "제67조", include_rulings: false })
    const text = r.content[0].text
    expect(text).toContain("■ 시행령·시행규칙 위임")
    expect(text).toContain(`[시행령] ${DIRECTORATE} 제18조 (비상임심판관)`)
  })

  // 법인세법 표(thd-280349)의 실응답 패턴 — 같은 (모법 조문, 조번호)에 이름 있는 항목과 빈 항목이 짝으로 온다
  const CORP: Law = { name: "법인세법", mst: "280349", id: "001563", type: "법률" }
  const CORP_DECREE: Law = { name: "법인세법 시행령", mst: "283635", id: "003608", type: "대통령령" }
  const decree38 = (lawName: string, rule: [string, string, string]) => ({
    조번호: "0024",
    조가지번호: "00",
    조제목: "",
    조내용: "제3관 손금의 계산 <개정 2010.12.30>",
    시행령조문: { 조제목: "", 조가지번호: "00", 법령명: lawName, 조내용: "", 조번호: "0038" },
    시행규칙조문: { 조제목: rule[2], 조가지번호: rule[1], 법령명: "법인세법 시행규칙", 조내용: "", 조번호: rule[0] },
  })
  const CORP_BODIES = {
    [`${CORP_DECREE.mst}|003800`]: articleJson("38", "0", "", "제38조 시행령 38조 본문"),
    [`${CORP.mst}|002400`]: articleJson("24", "0", "기부금의 손금불산입", "제24조(기부금의 손금불산입) 모법 24조 본문"),
  }

  it("법령명이 빈 항목은 이름 있는 짝이 우리 법령이면 인정하고, 그 행의 시행규칙 짝도 보여준다", async () => {
    const rows = [decree38("법인세법 시행령", ["0018", "02", "제18조의2(한국학교 등의 요건 등)"]), decree38("", ["0019", "00", "제19조(학교등의 요건 충족여부등 보고기한 등)"])]
    const thd = { [CORP_DECREE.mst]: table(CORP_DECREE, "법인세법", "법인세법", rows) }
    const r = await handleFinArticle(stub([CORP, CORP_DECREE], CORP_BODIES, thd), { law: "법인세법 시행령", article: "제38조", include_rulings: false })
    const text = r.content[0].text
    expect(text).toContain("[모법] 법인세법 제24조")
    expect(text).toContain("법인세법 시행규칙 제18조의2")
    expect(text).toContain("법인세법 시행규칙 제19조")
    expect(text).not.toContain("소속 미확인")
  })

  it("법령명이 빈 항목의 짝이 다른 하위법령이면 그 법령 것으로 보고 싣지 않는다", async () => {
    // thd-287181: 조특법 §106의2 → 특례규정 §27 (이름 있음) + 같은 번호 빈 항목(가정)
    const JOTEUK: Law = { name: "조세특례제한법", mst: "280409", id: "001584", type: "법률" }
    const JOTEUK_DECREE: Law = { name: "조세특례제한법 시행령", mst: "287181", id: "003586", type: "대통령령" }
    const SPECIAL = "농ㆍ축산ㆍ임ㆍ어업용 기자재 및 석유류에 대한 부가가치세 영세율 및 면세 적용 등에 관한 특례규정"
    const rows = [
      {
        조번호: "0030",
        조가지번호: "00",
        조제목: "",
        조내용: "제4절의2 고용지원을 위한 조세특례",
        시행령조문: { 조제목: "", 조가지번호: "00", 법령명: "조세특례제한법 시행령", 조내용: "", 조번호: "0027" },
        시행규칙조문: { 조제목: "제61조(서식 등)", 조가지번호: "00", 법령명: "조세특례제한법 시행규칙", 조내용: "", 조번호: "0061" },
      },
      { 조번호: "0106", 조가지번호: "02", 조제목: "", 조내용: "제3장 간접국세", 시행령조문: { 조제목: "", 조가지번호: "00", 법령명: SPECIAL, 조내용: "", 조번호: "0027" } },
      { 조번호: "0106", 조가지번호: "02", 조제목: "", 조내용: "제3장 간접국세", 시행령조문: { 조제목: "", 조가지번호: "00", 법령명: "", 조내용: "", 조번호: "0027" } },
    ]
    const thd = { [JOTEUK_DECREE.mst]: table(JOTEUK_DECREE, "조세특례제한법", "조세특례제한법", rows) }
    const bodies = {
      [`${JOTEUK_DECREE.mst}|002700`]: articleJson("27", "0", "중소기업 취업자에 대한 소득세 감면", "제27조 시행령 27조 본문"),
      [`${JOTEUK.mst}|003000`]: articleJson("30", "0", "중소기업 취업자에 대한 소득세 감면", "제30조 모법 30조 본문"),
    }
    const r = await handleFinArticle(stub([JOTEUK, JOTEUK_DECREE], bodies, thd), { law: "조세특례제한법 시행령", article: "제27조", include_rulings: false })
    const text = r.content[0].text
    expect(text).toContain("[모법] 조세특례제한법 제30조")
    expect(text).not.toContain("제106조의2")
    expect(text).not.toContain("소속 미확인")
  })

  it("이름 있는 짝이 없는 빈 항목은 싣지 않고 건수만 고지한다 — 모법 조문 번호도 나열하지 않는다", async () => {
    const rows = [
      decree38("법인세법 시행령", ["0018", "02", "제18조의2(한국학교 등의 요건 등)"]),
      { 조번호: "0099", 조가지번호: "00", 조제목: "", 조내용: "", 시행령조문: { 조제목: "", 조가지번호: "00", 법령명: "", 조내용: "", 조번호: "0038" } },
    ]
    const thd = { [CORP_DECREE.mst]: table(CORP_DECREE, "법인세법", "법인세법", rows) }
    const r = await handleFinArticle(stub([CORP, CORP_DECREE], CORP_BODIES, thd), { law: "법인세법 시행령", article: "제38조", include_rulings: false })
    const text = r.content[0].text
    expect(text).toContain("[모법] 법인세법 제24조")
    expect(text).not.toContain("[모법] 법인세법 제99조")
    expect(text).toContain("매핑 1건은 어느 하위법령 조문인지 **소속을 확인할 수 없어 싣지 않았습니다**")
    // 번호가 보이면 "소속 미확인"이라 적어도 위임 근거로 읽힌다 (검수 결정 9/17)
    expect(text).not.toContain("제99조")
  })

  it("빈 항목만 있으면 매핑 미발견 + 소속 미확인 고지 — '위임 근거 없음'으로 단정하지 않는다", async () => {
    const rows = [{ 조번호: "0099", 조가지번호: "00", 조제목: "", 조내용: "", 시행령조문: { 조제목: "", 조가지번호: "00", 법령명: "", 조내용: "", 조번호: "0038" } }]
    const thd = { [CORP_DECREE.mst]: table(CORP_DECREE, "법인세법", "법인세법", rows) }
    const r = await handleFinArticle(stub([CORP, CORP_DECREE], CORP_BODIES, thd), { law: "법인세법 시행령", article: "제38조", include_rulings: false })
    const text = r.content[0].text
    // 고지 문구 안의 "[모법]으로 싣지 않았습니다"는 허용 — 줄 머리의 [모법] 항목이 없어야 한다
    expect(text).not.toMatch(/^\[모법\]/m)
    expect(text).toContain("매핑 미발견")
    expect(text).toContain("소속 미확인")
    expect(text).not.toContain("제99조")
  })
})

// ── B2: 다른 기준법령 표 → 모법 MST 재조회 ──────────────────────────────────

describe("fin_article 역방향 — 기준법령목록에 모법이 있으면 모법 MST로 다시 받아 위임을 복구한다 (B2)", () => {
  const INCOME: Law = { name: "소득세법", mst: "280405", id: "001565", type: "법률" }
  const INCOME_DECREE: Law = { name: "소득세법 시행령", mst: "286211", id: "003956", type: "대통령령" }
  const CORP: Law = { name: "법인세법", mst: "280349", id: "001563", type: "법률" }

  // thd-286211 실응답 형태: 기본정보.기준법령명 = 목록[0], 표는 법인세법 것 (§38 = 법인세법 시행령 §38)
  const FOREIGN_TABLE = table(INCOME_DECREE, "법인세법", ["법인세법", "소득세법", "지방세특례제한법"], [
    {
      조번호: "0024",
      조가지번호: "00",
      조제목: "",
      조내용: "제3관 손금의 계산 <개정 2010.12.30>",
      시행령조문: { 조제목: "", 조가지번호: "00", 법령명: "법인세법 시행령", 조내용: "", 조번호: "0038" },
    },
  ])
  // thd-280405 실응답 행: 소득세법 §20 → 소득세법 시행령 §38 + 시행규칙 §15의4
  const PARENT_TABLE = table(INCOME, "소득세법", "소득세법", [
    {
      조번호: "0020",
      조가지번호: "00",
      조제목: "",
      조내용: "제2관 소득의 종류와 금액 <개정 2009.12.31>",
      시행령조문: { 조제목: "", 조가지번호: "00", 법령명: "소득세법 시행령", 조내용: "", 조번호: "0038" },
      시행규칙조문: { 조제목: "제15조의4(퇴직급여 적립방법 등)", 조가지번호: "04", 법령명: "소득세법 시행규칙", 조내용: "", 조번호: "0015" },
    },
  ])
  const BODIES = {
    [`${INCOME_DECREE.mst}|003800`]: articleJson("38", "0", "근로소득의 범위", "제38조(근로소득의 범위) 시행령 38조 본문"),
    [`${INCOME.mst}|002000`]: articleJson("20", "0", "근로소득", "제20조(근로소득) 소득세법 20조 본문"),
    [`${CORP.mst}|002400`]: articleJson("24", "0", "기부금의 손금불산입", "제24조(기부금의 손금불산입) 법인세법 24조 본문"),
  }
  const LAWS = [INCOME, INCOME_DECREE, CORP]

  it("소득세법 시행령 §38 — 법인세법 표 대신 소득세법 표로 모법 §20을 찾는다", async () => {
    const calls: string[] = []
    const r = await handleFinArticle(stub(LAWS, BODIES, { [INCOME_DECREE.mst]: FOREIGN_TABLE, [INCOME.mst]: PARENT_TABLE }, calls), {
      law: "소득세법 시행령",
      article: "제38조",
      include_rulings: false,
    })
    const text = r.content[0].text
    expect(calls).toEqual([INCOME_DECREE.mst, INCOME.mst])
    expect(text).toContain("■ 모법 위임 근거 (역방향)")
    expect(text).toContain("[모법] 소득세법 제20조")
    expect(text).toContain("소득세법 20조 본문")
    expect(text).toContain("같은 위임 행의 시행규칙: 소득세법 시행규칙 제15조의4")
    expect(text).not.toContain("위임 조회 생략")
    expect(text).toContain("전체 성공")
  })

  it("반대 방향: 재조회로 복구해도 첫 표(법인세법)의 조문은 [모법]으로 새지 않는다", async () => {
    const r = await handleFinArticle(stub(LAWS, BODIES, { [INCOME_DECREE.mst]: FOREIGN_TABLE, [INCOME.mst]: PARENT_TABLE }), {
      law: "소득세법 시행령",
      article: "제38조",
      include_rulings: false,
    })
    const text = r.content[0].text
    expect(text).not.toContain("법인세법 제24조")
    expect(text).not.toContain("기부금")
  })

  it("재조회한 표도 모법 기준이 아니면 생략 고지를 유지한다 (가드가 원래 막던 (a)형)", async () => {
    const r = await handleFinArticle(stub(LAWS, BODIES, { [INCOME_DECREE.mst]: FOREIGN_TABLE, [INCOME.mst]: FOREIGN_TABLE }), {
      law: "소득세법 시행령",
      article: "제38조",
      include_rulings: false,
    })
    const text = r.content[0].text
    expect(text).toContain("위임 조회 생략")
    expect(text).toContain("다시 조회한 표도 「법인세법」 기준")
    expect(text).not.toContain("[모법]")
    expect(text).not.toContain("기부금")
  })

  it("재조회가 실패하면 '없음'이 아니라 확인 불가로 고지한다", async () => {
    const r = await handleFinArticle(
      stub(LAWS, BODIES, { [INCOME_DECREE.mst]: FOREIGN_TABLE, [INCOME.mst]: new Error("요청 시간 초과 (3000ms)") }),
      { law: "소득세법 시행령", article: "제38조", include_rulings: false }
    )
    const text = r.content[0].text
    expect(text).toContain("위임 조회 생략")
    expect(text).toContain("**실패**했습니다")
    expect(text).toContain("요청 시간 초과")
    expect(text).toContain("확인 불가")
    expect(text).not.toContain("[모법]")
    expect(text).not.toContain("무관한 표")
  })

  it("모법을 법령 검색에서 정확히 찾지 못하면 재조회하지 않고 고지한다", async () => {
    const calls: string[] = []
    const r = await handleFinArticle(stub([INCOME_DECREE, CORP], BODIES, { [INCOME_DECREE.mst]: FOREIGN_TABLE }, calls), {
      law: "소득세법 시행령",
      article: "제38조",
      include_rulings: false,
    })
    const text = r.content[0].text
    expect(calls).toEqual([INCOME_DECREE.mst])
    expect(text).toContain("모법 「소득세법」을 법령 검색에서 정확히 찾지 못함")
    expect(text).not.toContain("[모법]")
  })

  it("시행규칙도 같다 — 법인세법 시행규칙(목록 [국세기본법, 법인세법])은 법인세법 표로 복구한다", async () => {
    const GIBON: Law = { name: "국세기본법", mst: "288571", id: "001586", type: "법률" }
    const CORP_RULE: Law = { name: "법인세법 시행규칙", mst: "287787", id: "007229", type: "기획재정부령" }
    // thd-287787 형태 + thd-280349의 시행규칙 §15 행 (시행령 짝은 법령명이 빈 채로 온다)
    const foreign = table(CORP_RULE, "국세기본법", ["국세기본법", "법인세법"], [
      { 조번호: "0081", 조가지번호: "00", 조제목: "", 조내용: "", 시행규칙조문: { 조제목: "", 조가지번호: "00", 법령명: "국세기본법 시행규칙", 조내용: "", 조번호: "0015" } },
    ])
    const parent = table(CORP, "법인세법", "법인세법", [
      {
        조번호: "0023",
        조가지번호: "00",
        조제목: "",
        조내용: "제3관 손금의 계산 <개정 2010.12.30>",
        시행령조문: [
          { 조제목: "", 조가지번호: "00", 법령명: "", 조내용: "", 조번호: "0028" },
          { 조제목: "", 조가지번호: "00", 법령명: "법인세법 시행령", 조내용: "", 조번호: "0026" },
        ],
        시행규칙조문: { 조제목: "제15조(내용연수와 상각률)", 조가지번호: "00", 법령명: "법인세법 시행규칙", 조내용: "", 조번호: "0015" },
      },
    ])
    const bodies = {
      [`${CORP_RULE.mst}|001500`]: articleJson("15", "0", "내용연수와 상각률", "제15조(내용연수와 상각률) 시행규칙 15조 본문"),
      [`${CORP.mst}|002300`]: articleJson("23", "0", "감가상각비의 손금불산입", "제23조(감가상각비의 손금불산입) 모법 23조 본문"),
    }
    const r = await handleFinArticle(stub([GIBON, CORP, CORP_RULE], bodies, { [CORP_RULE.mst]: foreign, [CORP.mst]: parent }), {
      law: "법인세법 시행규칙",
      article: "제15조",
      include_rulings: false,
    })
    const text = r.content[0].text
    expect(text).toContain("[모법] 법인세법 제23조")
    expect(text).not.toContain("국세기본법 제81조")
    // 빈 법령명의 시행령 짝은 같은 계열 이름으로만 채운다
    expect(text).toContain("같은 위임 행의 시행령: 법인세법 시행령 제28조 · 법인세법 시행령 제26조")
  })

  it("표가 없는 응답(존재여부 N — 국세징수법 시행규칙 284983 형태)도 모법 MST로 다시 받는다", async () => {
    const JINGSU: Law = { name: "국세징수법", mst: "286427", id: "001585", type: "법률" }
    const JINGSU_RULE: Law = { name: "국세징수법 시행규칙", mst: "284983", id: "006742", type: "기획재정부령" }
    const none = JSON.stringify({
      LspttnThdCmpLawXService: { 기본정보: { 법령일련번호: "284983", 법령ID: "006742", 법령명: "국세징수법 시행규칙", 삼단비교존재여부: "N" } },
    })
    const parent = table(JINGSU, "국세징수법", "국세징수법", [
      { 조번호: "0031", 조가지번호: "00", 조제목: "", 조내용: "", 시행규칙조문: { 조제목: "", 조가지번호: "00", 법령명: "국세징수법 시행규칙", 조내용: "", 조번호: "0020" } },
    ])
    const bodies = {
      [`${JINGSU_RULE.mst}|002000`]: articleJson("20", "0", "압류조서", "제20조(압류조서) 시행규칙 20조 본문"),
      [`${JINGSU.mst}|003100`]: articleJson("31", "0", "압류의 요건 등", "제31조(압류의 요건 등) 모법 31조 본문"),
    }
    const calls: string[] = []
    const r = await handleFinArticle(stub([JINGSU, JINGSU_RULE], bodies, { [JINGSU_RULE.mst]: none, [JINGSU.mst]: parent }, calls), {
      law: "국세징수법 시행규칙",
      article: "제20조",
      include_rulings: false,
    })
    const text = r.content[0].text
    expect(calls).toEqual([JINGSU_RULE.mst, JINGSU.mst])
    expect(text).toContain("[모법] 국세징수법 제31조")
  })

  it("반대 방향: 기준법령이 처음부터 모법이면 재조회하지 않는다 (호출 수 불변)", async () => {
    const calls: string[] = []
    const r = await handleFinArticle(stub(LAWS, BODIES, { [INCOME_DECREE.mst]: PARENT_TABLE }, calls), {
      law: "소득세법 시행령",
      article: "제38조",
      include_rulings: false,
    })
    expect(calls).toEqual([INCOME_DECREE.mst])
    expect(r.content[0].text).toContain("[모법] 소득세법 제20조")
  })
})

// ── I3: 기준법령목록 배열 형태 ────────────────────────────────────────────

describe("parseThreeTierRows — 기준법령목록의 실응답 형태 (I3)", () => {
  it("기본정보.기준법령명이 없고 목록 법령명이 배열이어도 예외 없이 첫 항목을 기준으로 삼는다", () => {
    // 리뷰어 재현: 이 형태에서 `.replace is not a function` TypeError가 사용자에게 영어로 노출됐다
    const rs = parseThreeTierRows({
      LspttnThdCmpLawXService: { 기본정보: { 법령명: "소득세법 시행령" }, 기준법령목록: { 법령명: ["법인세법", "소득세법"] }, 위임조문삼단비교: { 법률조문: [] } },
    })
    expect(rs.baseLawName).toBe("법인세법")
    expect(rs.baseLawNames).toEqual(["법인세법", "소득세법"])
    expect(rs.queriedLawName).toBe("소득세법 시행령")
  })

  it("실응답(286211)처럼 기준법령명과 배열 목록이 함께 오면 기준법령명을 쓰고 목록 전체를 보존한다", () => {
    const rs = parseThreeTierRows({
      LspttnThdCmpLawXService: {
        기본정보: { 법령명: "소득세법 시행령", 기준법령명: "법인세법", 삼단비교존재여부: "Y" },
        기준법령목록: {
          제개정구분: [{ content: "일부개정" }, { content: "일부개정" }, { content: "타법개정" }],
          법령명: ["법인세법", "소득세법", "지방세특례제한법"],
        },
        위임조문삼단비교: {
          법률조문: { 조번호: "0024", 조가지번호: "00", 시행령조문: { 조번호: "0038", 조가지번호: "00", 법령명: "법인세법 시행령" } },
        },
      },
    })
    expect(rs.baseLawName).toBe("법인세법")
    expect(rs.baseLawNames).toEqual(["법인세법", "소득세법", "지방세특례제한법"])
    expect(rs.rows).toHaveLength(1)
    expect(rs.rows[0].decrees[0].lawName).toBe("법인세법 시행령")
  })

  it("기준법령이 하나면 목록 법령명은 문자열이다 (종전 형태 유지)", () => {
    const rs = parseThreeTierRows({
      LspttnThdCmpLawXService: { 기본정보: { 법령명: "법인세법 시행령", 기준법령명: "법인세법" }, 기준법령목록: { 법령명: "법인세법" } },
    })
    expect(rs.baseLawName).toBe("법인세법")
    expect(rs.baseLawNames).toEqual(["법인세법"])
    expect(rs.rows).toEqual([])
  })

  it("표가 없는 응답(존재여부 N)은 기준법령이 비어 있다", () => {
    const rs = parseThreeTierRows({ LspttnThdCmpLawXService: { 기본정보: { 법령명: "국세징수법 시행규칙", 삼단비교존재여부: "N" } } })
    expect(rs.baseLawName).toBe("")
    expect(rs.baseLawNames).toEqual([])
  })

  it("항목 법령명이 문자열이 아니어도 예외를 내지 않는다", () => {
    const rs = parseThreeTierRows({
      LspttnThdCmpLawXService: {
        기본정보: { 기준법령명: ["법인세법"] },
        위임조문삼단비교: { 법률조문: { 조번호: "0024", 시행령조문: { 조번호: "0038", 법령명: ["법인세법 시행령"], 조제목: {} } } },
      },
    })
    expect(rs.baseLawName).toBe("법인세법")
    expect(rs.rows[0].decrees[0].lawName).toBe("법인세법 시행령")
  })
})
