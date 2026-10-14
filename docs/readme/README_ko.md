<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · **한국어** · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Русский](README_ru.md)

# dsh-unreal-agentlink

### Unreal 에디터를 에이전트의 손아래 두는 DSH 플러그인.

**순수 브리지. 에이전트가 계획하고, 이 플러그인은 번역만 합니다.**

```
DSH agent  ──도구 호출──►  dsh-unreal-agentlink  ◄──WebSocket──  Unreal 에디터
(계획, 결정)               (이 플러그인: 서버, 번역기)   에디터가 먼저 연결
```

[요구 사항](#요구-사항) · [빠른 시작](#빠른-시작) · [도구](#12개-도구) · [구성](#구성) · [문서](#문서)

<code>npm install &amp;&amp; npm run check</code>

</div>

---

에이전트는 이미 파일을 읽고 명령을 실행할 수 있습니다. 이 플러그인은 거기에 **에디터 그 자체**를 더합니다. 레벨을 조회하고, actor를 스폰하고, 블루프린트와 머티리얼을 편집하고, 시퀀스를 렌더하고, 에이전트가 실제로 *볼* 수 있는 스크린샷을 찍고, 문제가 생기면 자신이 한 작업을 되돌립니다.

이 플러그인은 작업을 **계획하지 않습니다**. 계획은 DSH의 네이티브 에이전트의 몫입니다. 이 플러그인은 안전 계층을 갖춘 번역기입니다 — 에이전트의 의도를 UnrealAgentLink 명령으로 바꾸고, 에디터의 응답을 에이전트가 그에 따라 행동할 수 있는 형태로 되돌립니다.

---

## 요구 사항

| 항목 | 요구 사항 |
|---|---|
| Unreal Engine | 5.0 – 5.8 |
| UnrealAgentLink | C++ 플러그인 본체. 프로젝트의 `Plugins/`에 넣으세요 |
| Node.js | `^22.19.0 \|\| >=24.0.0` |
| DSH 런타임 | 이 플러그인을 번들로 설치한 것 |

### UEBox는 필요 없습니다

UEBox 데스크톱 앱은 **의존성이 아닙니다**. 같은 제조사의 다른 클라이언트일 뿐인데, 우연히 17860 포트도 쓰므로 둘을 동시에 띄우면 포트 충돌이 납니다 — 관계는 그것이 전부입니다. 근거는 다음과 같습니다.

- `UnrealAgentLink.uplugin:25-34`은 의존성을 정확히 두 개만 선언하며, 둘 다 엔진 기본 제공입니다: `IKRig`와 `PythonScriptPlugin`. uebox 모듈은 없습니다.
- `UnrealAgentLink.Build.cs`의 모든 항목이 엔진 모듈입니다(UnrealEd / AssetRegistry / MovieScene / Landscape …). uebox SDK는 없습니다.
- 전체 소스에서 문자열 `uebox`는 3번 등장하며, 모두 `// Copyright uebox.ai` 저작권 헤더입니다.
- 소스 어디에서도 uebox.ai를 호출하지 않습니다. `FHttpModule`을 쓰는 유일한 곳은 로컬 머신의 프록시 설정을 읽는 코드뿐입니다(`UAL_ProxyDiagnostics.cpp:167`).

플러그인을 프로젝트에 넣기만 하면 스스로 동작합니다. `StartupModule`이 `Init("ws://127.0.0.1:17860")`를 무조건 호출하고(`Core/UnrealAgentLink.cpp:86-97`), 연결되는 즉시 `project.info`를 밀어 넣으며, 핸드셰이크도 토큰도 인증도 없습니다.

> 포트를 옮기려면: 에디터 쪽은 `-UALServer=ws://127.0.0.1:17861`, 이 플러그인 쪽은 `port` 설정을 맞추세요.

---

## 빠른 시작

```bash
npm install
npm run check      # typecheck (src + tests) + 154 tests + catalog reconciliation, one command
```

DSH 번들로 설치하려면: `package.json`이 `dsh.bundle.patch`를 선언하고, `cordis.patch.yml`이 배포 패키지 이름으로 한 줄을 삽입합니다 — `{id: unreal-agentlink, name: dsh-unreal-agentlink}`.

> **구성 레이어링**: 뒤쪽 레이어가 해당 행의 `config`를 **전체 교체**하며 깊은 병합(deep-merge)을 하지 않습니다. 무엇이든 덮어쓰려면 유지하고 싶은 키를 전부 다시 써야 합니다.

**엔드투엔드 경로는 [튜토리얼](../ko/01-tutorial.md)을 보세요** — UE 쪽 설치, 첫 연결, 자주 쓰는 작업 흐름, 실패를 읽는 방법.

---

## 문서

| 문서 | 내용 |
|---|---|
| [튜토리얼](../ko/01-tutorial.md) | 엔드투엔드: 플러그인 설치, 연결 성공까지, 자주 쓰는 작업 흐름, 문제 해결 |
| [프로토콜 레퍼런스](../ko/02-protocol.md) | 메시지 구조, 이벤트, 13개 상태 코드, 직렬화 규칙, 타임아웃과 동시성 의미 |
| [아키텍처](../ko/03-architecture.md) | 게이트 체인, 세션 격리와 되돌리기, 오류 번역, 검증 전략, 우리가 겪은 함정 |
| [명령 레퍼런스](../ko/command-reference.md) | 170개 명령 전체의 파라미터 / 필수 키 / 결과 키 / 상태 코드(**자동 생성**) |

위 네 문서 모두 이 파일 위쪽에 적힌 모든 언어로 제공되며, `docs/<lang>/` 아래에 있습니다.

---

## 먼저 알아둘 네 가지 사실

이것들은 설계 선택이 아닙니다. UnrealAgentLink의 기존 제약이며, 모든 작업의写法를決めます.

1. **① 연결 방향이 거꾸로입니다.** 이 플러그인이 에디터에 걸지 않습니다 — **에디터가 먼저 겁니다**. 시작 순서는 상관없습니다. 에디터를 먼저 띄우면 5초마다 재시도하다가 플러그인이 나타나는 순간 연결됩니다.
2. **② 인증이 없습니다.** 토큰도 헤더도 서브프로토콜도 없습니다. **포트 자체가 자격 증명**이므로 기본적으로 루프백에만 바인딩합니다. `0.0.0.0`으로 바꾸지 마세요.
3. **③ 명령이 게임 스레드에서 직렬로 실행됩니다.** 그리고 차단 명령이 실행되는 동안에는 **에디터가 아무것도 응답하지 않습니다** — `sequence.render_status` 같은 진행 상황 조회도 예외가 아닙니다.
4. **④ 취소가 없습니다.** `query_task`와 `cancel_task`는 존재하지 않습니다. `ual_task` 잡을 죽이는 것은 이 플러그인의 대기만 중단시킵니다. 엔진은 계속 돌고 결과는 그대로 돌아옵니다.

---

## 12개 도구

170개 명령을 170개 도구로 노출하면, 특정 작업이 전혀 쓰지 않는 기능 설명이 매 요청의 프롬프트 상당 부분을 잡아먹습니다. 그래서 기능 파악은 0단계가 아니라 2단계입니다.

| 도구 | 용도 |
|---|---|
| `ual_status` | 에디터 연결 / 차단기 / 속도 제한 / 세션 / 고아 명령. **무언가 잘못됐을 때 가장 먼저 읽을 것** |
| `ual_tools` | 170개 명령 전체를 나열(22개 계열). 계열 또는 키워드로 필터링 가능 |
| `ual_schema` | 한 명령의 **정확한 키 이름** — 호출 전에 확인. UE는 알 수 없는 키를 조용히 무시함 |
| `ual_call` | 명령 하나를 실행하고 에디터의 결과를 원문 그대로 반환 |
| `ual_batch` | 한 번의 왕복으로 여러 명령 실행(`maxBatchCalls` 상한. 위험한 항목이 하나라도 있으면 전체 배치가 승인을 거침) |
| `ual_screenshot` | 촬영해 **실제 이미지**를 반환. 에이전트가 직접 볼 수 있음 |
| `ual_logs` | 로컬 로그 링을 읽음(UE 쪽 전달은 기본 꺼짐 — 튜토리얼 참고) |
| `ual_undo` / `ual_undo_history` | 세션별 되돌리기 / undo 버퍼 조회 |
| `ual_locks` | 에셋 락을 획득. 에디터가 "AI가 편집 중" 배지를 그림 |
| `ual_editor_bind` | 에디터가 여러 개 연결됐을 때 세션을 하나에 고정 |
| `ual_task` | 긴 차단 명령을 진짜 백그라운드 잡으로 바꿔 대화를 이어갈 수 있게 함 |

### 위험 등급

read 65 / write 89 / **destructive 2 / dangerous 14**(마지막 16개는 승인을 거칩니다).

`tools/pre-execute`는 destructive와 dangerous 메서드(`ual_batch` 안의 위험한 항목 포함)에 `{kind:'ask'}`를 반환해 결정을 세션 정책에 맡깁니다. **등록되지 않은 메서드는 즉시 거부**되고 에디터에 도달하지 않습니다.

`never` 정책에서는 `ask`가 자동 거부됩니다 — 이는 「무인 세션은 에디터를 건드려서는 안 된다」의 올바른 해석입니다.

---

## 구성

기본값은 「살아는 있지만 게으른」 상태입니다. 근거까지 담긴 전체 표는 [튜토리얼 7장](../ko/01-tutorial.md#7-구성)에 있습니다.

| 키 | 기본값 | 의미 |
|---|---|---|
| `host` / `port` | `127.0.0.1` / `17860` | 루프백에 두세요. 인증이 없어 포트에 닿는 것이 곧 에디터를 조종하는 것 |
| `timeoutMs` | `180000` | 차단 명령은 각자 하한을 올림 |
| `cacheTtlMs` / `cacheMaxEntries` | `2000` / `128` | 세션별 읽기 캐시 |
| `rateLimitRps` / `rateLimitQueue` | `5` / `32` | 초당 명령 수 / 대기열 상한(0이면 속도 제한 끔) |
| `breakerThreshold` / `breakerCooldownMs` | `3` / `30000` | 연속 전송 실패 몇 회로 열기 / 쿨다운 |
| `logCapacity` / `logMinLevel` | `512` / `Display` | 로그 링 |
| `logForwardingEnabled` | `false` | 에디터 안에서 `ual.ForwardLogs`를 실행한 뒤에만 `true`로 |
| `rollbackOnDispose` | `false` | LIFO 접미사만 정확함 — 아키텍처 문서 참고 |
| `notifyOnEditorChange` | `true` | 에디터가 연결되거나 끊길 때 에이전트에 한 줄 주입 |
| `screenshotAttachments` / `screenshotMaxBytes` | `true` / 12MB | 이미지 블록 / 크기 상한 |
| `maxBatchCalls` | `12` | `ual_batch` 한 건의 상한 |

---

## 개발

```bash
npm run build       # tsc → lib/
npm run dev         # tsc --watch
npm run check       # typecheck + tests + catalog reconciliation (run before committing)
npm test            # tests only
npm run typecheck   # src and tests typechecked separately
```

### 소스 구조

```
src/
  index.ts                  Cordis lifecycle, approval gate, dispose-time rollback
  config.ts                 Schemastery schema (the single source of default values)
  service.ts                call() gate chain: catalog → requires → read cache → breaker → rate limit → send → ledger → translate
  protocol/{bridge,serialization,types}.ts   WS server / outbound validation / wire types
  catalog/{method-data,method-overrides,methods}.ts   170-command catalog (data extracted from C++)
  errors/translate.ts       Error classification (by class name / status code, never by message text)
  resilience/breaker.ts     Rate limiter + circuit breaker
  sessions/state.ts         Session ledger / LIFO test / lock merging / cache / log filtering
  tools/                    The 12 tools
scripts/                    Catalog extraction and reconciliation, doc generation
docs/                       Tutorial / protocol / architecture / command reference
tests/                      154 tests
```

### 생성된 파일: 직접 수정 금지

`src/catalog/method-data.ts`와 `docs/command-reference.md`는 모두 **자동 생성**됩니다.

```bash
node scripts/extract-methods.mjs .ua-ref/plugin/UnrealAgentLink/Source   # rebuild the catalog from C++
npm run build && node scripts/gen-docs.mjs                             # rebuild the command reference
```

손으로 관리하는 표를 만들어 두고 아무도 import하지 않는 것은 이 프로젝트에서 반복되는 결함 유형입니다(`REQUIRED_KEYS`, `EXTRA_PARAM_KEYS`, `UAL_CODES`가 모두 여기서 적발됐습니다). 대책은 각 검사가 **표에게 묻지 않고 소스에게 묻게** 하는 것입니다 — [아키텍처 9장](../ko/03-architecture.md#9-생성된-파일과-아무도-가져오지-않는-표)을 보세요.

### 테스트와 점검

```bash
npm run check                       # typecheck (src + tests) + 154 passed + catalog reconciliation
npm test                            # 154 passed
node scripts/check-catalog.mjs      # 170/170 zero drift; every requires key appears in C++; code set matches C++
node scripts/gen-docs.mjs --check   # is the command reference up to date
```

테스트 파일 7개는 **그들이 찾아낼 수 있는 결함의 종류**로 나뉘며, 각각 이유가 있습니다 — [아키텍처 11장](../ko/03-architecture.md#11-검증-전략)을 보세요.

`requires`는 손으로 쓰지 않습니다. 핸들러 자신의 `SendError(..., 400, "Missing field: X")` 메시지(28곳)에서 도출합니다. 필수 키를 잘못 정하면 브리지가 엔진이 보기도 전에 *유효한* 호출을 거부하게 되기 때문입니다. 결과는 `method-data.ts`의 `REQUIRED_KEYS`로 들어가고, `methods.ts`의 `requiresOf()`가 런타임 사용에 병합합니다(`service.call()`의 사전 거부, `ual_schema`의 `REQUIRED:` 행, 오류 힌트가 모두 이 함수 하나를 지납니다).

의도적으로 **좁히기만 하고 넓히지 않습니다**. `or`가 들어간 메시지(`"Missing field: name or path"`)는 아예 건너뛰고, 같은 파일의 피호출 함수에서 건져낸 키는 분기 국소적인 것으로 버립니다 — `scripts/extract-methods.mjs`의 `REQUIRED_DROPPED`를 보세요. 모든 항목에 C++ 줄 번호가 적혀 있습니다. 그래서 「건져낸 키가 없다」는 것은 놓친 검사가 아니라 안전한 기본값입니다.

---

## 프로토콜 핵심

```
UE → plugin:  { ver:"1.0", type:"req",  method, id, params }     // id is generated by the server
plugin → UE:  { ver:"1.0", type:"res",  id, code, result }        // the key is omitted when empty
UE → plugin:  { ver,       type:"evt", method, payload }
```

- 실패는 **`code`만으로** 표현됩니다. envelope 수준의 `error` 필드는 없습니다.
- 사람이 읽는 텍스트는 `result.message`에 있습니다(에디터 문화에 따라 중국어 또는 영어 — **파싱하지 마세요**). 기계가 읽는 상세 정보는 `result.details`에 있습니다.
- **많은 핸들러가 `result.ok === false`인 채 `200`을 반환합니다**(`editor.undo`, `blueprint.compile`, `pie.observe`). 그래서 플러그인은 코드만이 아니라 `judge()`로 성공을 판단합니다. C++ 파일 14개에 `SetStringField(TEXT("error"), ...)` 호출이 55곳 있습니다 — 이것이 정상이며 예외가 아닙니다.
- `content.import_folder` / `content.import_assets`는 **일회성 외발 푸시**입니다: `id`가 없고 응답을 기다리지 않습니다. 플러그인은 이를 로그와 에이전트 알림으로 바꾸며, **`res`를 지어내지 않습니다** — `ok:false`로 응답하는 것은 사용자에게 거짓 「가져오기 실패」 대화상자를 보여줄 뿐이며, 침묵보다 나쁩니다.

전체 내용(13개 상태 코드 전부, 직렬화 규칙, 타임아웃 의미)은 [프로토콜 레퍼런스](../ko/02-protocol.md)에 있습니다.

---

## 라이선스

MIT
