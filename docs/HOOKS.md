# 워크플로 훅 — 검토서를 저장하는 순간 인용을 검증한다

`fin_verify`는 물어봐야 답한다. 물어보는 것을 잊으면 검증은 일어나지 않는다.
Claude Code 훅으로 걸면 **검토서(.md)를 저장할 때마다** 인용이 자동으로 대조되고,
실존하지 않는 조문이 있으면 Claude가 그 사실을 즉시 통보받는다.

---

## 1. 검증 스크립트

`scripts/verify-file.mjs`가 파일 경로를 받아 그 안의 법령 인용을 `fin_verify`로 대조한다.

```bash
node scripts/verify-file.mjs 검토서.md
```

```
[인용 검증] 검토서.md — 인용 3건
  ✓2 / ✗1 / ⚠0

✗ 실존하지 않는 인용 1건 — 이 문서는 그대로 쓰면 안 됩니다
  ✗ 법인세법 제9999조 — 법령 「법인세법」은 실존하나 제9999조가 없음 (정상 조회 후 0건). 조문 번호 확인

해당 인용을 수정하거나 삭제한 뒤 다시 저장하세요.
```

동작 규칙:

- **✗이 1건이라도 있으면 실패** (기본 종료 코드 1). ✗은 "정상 조회 후 0건"일 때만 나온다
- **⚠는 실패로 치지 않는다.** ⚠는 "없음"이 아니라 "확인 실패"다. 조회 장애를 근거 삭제 지시로 바꾸면 안 된다. 대신 경고로 남는다
- **⚠ 중 "사용 보류"는 따로 다시 보고한다** (stderr, 종료 코드는 0). 미등재 약칭·환각 의심처럼 확인 전까지 쓰면 안 되는 인용이라, 다른 ⚠와 뭉뚱그리면 마지막 줄의 "인용 검증 통과"가 그것까지 통과시킨 것으로 읽힌다. 그럼에도 실패로 올리지 않는 이유는 위와 같다 — 확인 실패를 삭제 지시로 바꾸지 않기 위해서다
- 인용이 0건이면 그냥 통과한다 (검증할 것이 없다)
- `.md`·`.txt`가 아니면 건너뛴다 (종료 코드 0)
- 인용이 15건을 넘으면 문단 단위로 나눠 여러 번 검증한다. `fin_verify`의 인용 상한(15건)을 그냥 넘기면 뒷부분이 조용히 미검증으로 남기 때문이다
- 경로는 인자로도 받고, 훅이 stdin으로 주는 JSON(`tool_input.file_path`)에서도 읽는다

환경변수:

| 변수 | 뜻 |
| --- | --- |
| `LAW_OC` | (필수) 법제처 OPEN API 키. 저장소 `.env`에서 자동 로드된다 |
| `FIN_VERIFY_FAIL_EXIT` | ✗ 발견 시 종료 코드 (기본 `1`). **훅으로 쓸 때는 `2`** — 아래 3절 참고 |
| `FIN_VERIFY_BASIS_DATE` | 기준일 `YYYY-MM-DD`. 과거 시점 기준으로 검토서를 쓸 때 |
| `FIN_VERIFY_INTERVAL_MS` | 구간 간 간격 (기본 3000). 법제처 분당 한도 회피용 |

---

## 2. 훅 설정

`~/.claude/settings.json`(전체 프로젝트) 또는 프로젝트의 `.claude/settings.json`에 넣는다.

```json
{
  "env": {
    "FIN_VERIFY_FAIL_EXIT": "2"
  },
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "node /절대경로/fin-law-mcp/scripts/verify-file.mjs",
            "timeout": 180
          }
        ]
      }
    ]
  }
}
```

- `matcher`는 **도구 이름**에 대한 정규식이고 대소문자를 구분한다. 여러 도구는 `|`로 잇는다
  (`,` 구분자는 Claude Code v2.1.191 이상에서만 동작하니 `|`를 쓰는 편이 안전하다).
  `matcher` 값에 배열을 넣으면 스키마 오류로 **그 파일의 훅 전체가 무시된다**
- `timeout`은 **초** 단위다 (생략 시 600). 인용이 많은 문서는 구간을 나눠 여러 번 호출하므로 넉넉히 준다
- 훅은 stdin으로 `tool_name`·`tool_input`·`tool_response`·`cwd`·`session_id` 등이 담긴 JSON을 받는다.
  `verify-file.mjs`는 여기서 `tool_input.file_path`를 읽는다
- `.md` 필터는 스크립트가 직접 한다 (`matcher`는 도구 이름만 보고 파일 확장자는 못 본다).
  다른 확장자면 조용히 통과한다

### 왜 종료 코드 2인가

PostToolUse에서 종료 코드마다 결과가 다르다.

| 종료 코드 | 결과 |
| --- | --- |
| `0` | 성공. **stderr는 디버그 로그에만 남고 Claude에게 보이지 않는다** |
| `2` | stderr가 **Claude에게 전달된다.** 도구는 이미 실행됐으므로 되돌리지는 못한다 |
| 그 외 | 비차단 오류. 대화 기록에 `hook error` + stderr 첫 줄이 표시된다 |

즉 **✗ 결과가 Claude에게 닿게 하려면 종료 코드가 2여야 한다.** 그래서 위 설정의
`env`에 `FIN_VERIFY_FAIL_EXIT=2`를 둔다. Claude는 "이 파일에 실존하지 않는 인용이 있다"는
stderr를 읽고 스스로 고칠 수 있다.

`VAR=값 node …` 같은 인라인 접두사 대신 `env` 키를 쓰는 이유는 이식성이다. 셸 형식 훅은
Windows에서 Git Bash가 있으면 Git Bash로, 없으면 PowerShell로 실행되는데
`VAR=값 명령` 문법은 PowerShell에서 동작하지 않는다. `env` 키는 셸과 무관하게 적용된다.
(훅에 `"shell": "bash"`를 명시해 고정하는 방법도 있다.)

### 종료 코드 3 — 실행 불가

키가 없거나(`LAW_OC` 미설정) `build/`가 없으면 스크립트는 **3을 반환하고 그 사유를 말한다**.
조용히 통과시키지 않는다 — "검증했다"고 믿는데 실제로는 아무것도 안 한 상태가
검증 실패보다 위험하기 때문이다. 대화 기록에 `hook error`가 뜨면 `.env`와 `npm run build`를 확인하라.

---

## 3. 범위 좁히기

모든 `.md` 저장에 API를 호출하는 것이 부담이면 경로로 좁힌다. 스크립트를 감싸는 대신
검토서를 특정 폴더(예: `검토서/`)에 모으고, 그 경로만 통과시키는 얇은 래퍼를 쓴다.

```bash
#!/usr/bin/env bash
# scripts/verify-if-review.sh
payload=$(cat)
path=$(echo "$payload" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s)?.tool_input?.file_path||"")}catch{console.log("")}})')
case "$path" in
  *검토서/*.md|*reviews/*.md) echo "$payload" | node /c/dev/fin-law-mcp/scripts/verify-file.mjs ;;
  *) exit 0 ;;
esac
```

---

## 4. 설정이 먹었는지 확인

- `/hooks` — 설정된 훅을 이벤트별로 보여주는 읽기 전용 목록. **어느 설정 파일에서 왔는지**까지 보인다
- `claude doctor` — 설정 파일 검증. `matcher`에 배열을 넣어 훅 전체가 무시되는 것 같은 실수를 잡아준다
- `claude --debug` — 세션을 이 플래그로 켠 뒤 `.md`를 저장하면, 어떤 matcher가 검사됐고 훅이 어떤
  종료 코드·출력을 냈는지 디버그 로그에 남는다

설정 파일은 저장 후 잠시 뒤 실행 중인 세션에 자동 반영된다 (재시작 불필요).
우선순위는 `.claude/settings.local.json` > `.claude/settings.json` > `~/.claude/settings.json` 순이다.

---

## 5. 한계 — 훅이 해주지 않는 것

- **인용의 실존만 본다.** "법인세법 제26조가 실존하는가"는 확인하지만
  "그 조문이 이 사안에 맞는 근거인가"는 확인하지 않는다. 판단은 여전히 사람 몫이다
- **⚠는 막지 않는다.** 법제처 장애·분당 한도로 확인이 안 된 인용은 경고로만 남는다.
  경고가 반복되면 `FIN_VERIFY_INTERVAL_MS`를 늘리거나 나눠서 재검증하라
- **매 저장마다 실 API를 호출한다.** 법제처 분당 한도(30회)를 다른 도구와 공유하고 있다면
  3절처럼 경로를 좁히는 편이 낫다
- **되돌리지 못한다.** PostToolUse는 파일이 이미 쓰인 뒤에 돈다. 훅은 잘못된 인용이
  들어가는 것을 막는 게 아니라, 들어간 사실을 즉시 드러내는 장치다
