/**
 * verify-file.mjs 훅 테스트용 fetch 스텁 (node --import 프리로드).
 *
 * 훅 스크립트는 build/의 실제 LawApiClient로 법제처 API를 호출한다 — 실 API에
 * 붙이면 CI가 외부 장애·rate limit에 흔들리므로, 전역 fetch를 URL 패턴 라우팅
 * 픽스처로 바꿔치기해 결정형으로 만든다 (src를 건드리지 않는 유일한 주입 지점).
 *
 * 시나리오는 HOOK_STUB_SCENARIO 환경변수로 고른다:
 *   all-empty        모든 DB 0건 (soft hold·✗ 경로)
 *   abolished-admrul 현행 행정규칙 0건 + 폐지 연혁 실존 (⌛ 경로)
 *   api-error        모든 호출이 500 (⚠ 조회 실패 경로 — 검증이 하나도 안 된 문서)
 */

const EMPTY_LAW = '<?xml version="1.0"?><LawSearch><totalCnt>0</totalCnt></LawSearch>'
const EMPTY_ADMRUL = '<?xml version="1.0"?><AdmRulSearch><totalCnt>0</totalCnt></AdmRulSearch>'
const ABOLISHED_ADMRUL_HISTORY =
  '<?xml version="1.0"?><AdmRulSearch><totalCnt>1</totalCnt><admrul id="1">' +
  "<행정규칙명>수입식품등의 표시기준</행정규칙명><행정규칙일련번호>2100000012345</행정규칙일련번호>" +
  "<행정규칙ID>9999</행정규칙ID><발령일자>20200101</발령일자><제개정구분명>폐지</제개정구분명>" +
  "<현행연혁구분>연혁</현행연혁구분><행정규칙종류>고시</행정규칙종류>" +
  "<소관부처명>식품의약품안전처</소관부처명></admrul></AdmRulSearch>"

const scenario = process.env.HOOK_STUB_SCENARIO || "all-empty"

globalThis.fetch = async (input) => {
  const url = String(input)
  if (scenario === "api-error") {
    return new Response("Internal Server Error", { status: 500 })
  }
  let body
  if (url.includes("target=admrul")) {
    body =
      scenario === "abolished-admrul" && url.includes("nw=2") ? ABOLISHED_ADMRUL_HISTORY : EMPTY_ADMRUL
  } else {
    // 현행 검색(target=law)·연혁(target=eflaw)·본문 조회 등 나머지 전부
    body = EMPTY_LAW
  }
  return new Response(body, { status: 200 })
}
