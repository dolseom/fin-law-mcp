/**
 * verify-file.mjs 훅 테스트용 fetch 스텁 — **법령이 실존하는** 시나리오 (node --import 프리로드).
 *
 * hook-fetch-stub.mjs는 모든 DB가 0건·장애인 시나리오만 있어, ✓가 나와야 하는 문서
 * (종료 코드 0이 정답인 문서)를 훅 전 구간으로 검증할 수 없었다. 9차 리뷰의 거짓 미검증(I4)과
 * 삭제 조문 ✓(B1)는 "✓가 나와야 하는데 exit 1" / "⚠여야 하는데 exit 0"이라 이 스텁이 필요하다.
 *
 * 시나리오 (HOOK_STUB_SCENARIO):
 *   law-exists  법령 검색은 질의한 이름 그대로 현행 법률 1건을 돌려준다.
 *               조문 조회는 JO=003900(제39조)이면 삭제 자리표시("제39조 삭제 <2001.12.31>" — 법인세법
 *               실응답 형태), JO=009900(제99조)이면 조문 없음(✗), 그 밖은 정상 조문(✓).
 *               행정규칙·연혁 검색은 0건.
 */

const EMPTY_LAW = '<?xml version="1.0"?><LawSearch><totalCnt>0</totalCnt></LawSearch>'
const EMPTY_ADMRUL = '<?xml version="1.0"?><AdmRulSearch><totalCnt>0</totalCnt></AdmRulSearch>'

const lawXml = (name, i) =>
  `<?xml version="1.0" encoding="UTF-8"?><LawSearch><totalCnt>1</totalCnt>` +
  `<law id="1"><법령일련번호>${100000 + i}</법령일련번호><법령명한글>${name}</법령명한글><법령ID>${9000 + i}</법령ID>` +
  `<법령구분명>법률</법령구분명><현행연혁코드>현행</현행연혁코드><시행일자>20260101</시행일자></law></LawSearch>`

const unitsJson = (unit) => JSON.stringify({ 법령: { 조문: { 조문단위: [unit] } } })

const scenario = process.env.HOOK_STUB_SCENARIO || "law-exists"
let seq = 0

globalThis.fetch = async (input) => {
  const u = new URL(String(input))
  const target = u.searchParams.get("target")
  if (scenario !== "law-exists") return new Response(EMPTY_LAW, { status: 200 })
  if (u.pathname.endsWith("lawService.do")) {
    if (target === "admrul") return new Response("", { status: 200 })
    const jo = u.searchParams.get("JO") || ""
    if (jo === "009900") return new Response(JSON.stringify({ 법령: { 조문: {} } }), { status: 200 })
    if (jo === "003900") {
      return new Response(
        unitsJson({ 조문번호: "39", 조문키: "0039001", 조문내용: "제39조 삭제 <2001.12.31>", 조문여부: "조문" }),
        { status: 200 }
      )
    }
    const num = String(parseInt(jo.slice(0, 4), 10) || 1)
    return new Response(
      unitsJson({ 조문여부: "조문", 조문번호: num, 조문제목: "테스트", 조문내용: `제${num}조(테스트) 본문` }),
      { status: 200 }
    )
  }
  if (target === "admrul") return new Response(EMPTY_ADMRUL, { status: 200 })
  if (target === "law") {
    const q = u.searchParams.get("query") || ""
    return new Response(q ? lawXml(q, ++seq) : EMPTY_LAW, { status: 200 })
  }
  return new Response(EMPTY_LAW, { status: 200 }) // eflaw(연혁) 등
}
