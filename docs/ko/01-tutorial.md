<div align="center">

[English](../01-tutorial.md) · [简体中文](../zh/01-tutorial.md) · [繁體中文](../zh-TW/01-tutorial.md) · [日本語](../ja/01-tutorial.md) · **한국어** · [Deutsch](../de/01-tutorial.md) · [Español](../es/01-tutorial.md) · [Français](../fr/01-tutorial.md) · [Русский](../ru/01-tutorial.md)

[README](../readme/README_ko.md) · **튜토리얼** · [프로토콜](02-protocol.md) · [아키텍처](03-architecture.md) · [명령 참조](command-reference.md)

</div>

# 튜토리얼: 제로 상태에서 돌아가는 브리지까지

이 문서는 처음부터 끝까지의 경로다. 목표: DSH 안의 에이전트가 실제로 로컬 Unreal Editor를 구동하게 하고, 무엇을 해야 하는지 무엇이 멈출지를 아는 것.

권장 읽기 순서: 이 페이지 → [프로토콜](02-protocol.md) → [아키텍처](03-architecture.md) → [명령 참조](command-reference.md).

---

## 1. 정신 모델: 먼저 네 가지 사실

무엇에 손대기 전에, 이 네 가지 사실이 뒤따르는 모든 조작의 작성 방식을 결정한다. 이것들은 설계상의 선택이 아니라 — UnrealAgentLink의 기존 제약이다.

**① 방향이 거꾸로다.** 이 플러그인은 에디터에 전화를 걸지 않는다; **에디터가 전화를 건다**. UnrealAgentLink C++ 플러그인은 `StartupModule`에서 `ws://127.0.0.1:17860`을 무조건 열고, 이 플러그인이 그 포트를 listen한다. 그래서 기동 순서는 문제가 되지 않는다: 에디터가 먼저 뜨면 5초마다 재시도해서 플러그인이 나타나는 즉시 연결된다.

**② 인증이 없다.** 토큰도, 헤더도, 서브프로토콜도 없다. **포트 자체가 credential이다** — 17860에 닿을 수 있는 사람은 누구나 에디터를 구동할 수 있다. 그래서 기본적으로 loopback에만 bind하고, `0.0.0.0`으로 바꾸지 말아야 한다.

**③ 명령은 game thread에서 직렬로 실행된다.** 에디터가 명령을 받으면 이미 game thread에 없을 경우 그곳으로 다시 post한 뒤 **동기적으로 완료까지 실행한다**. 두 가지 결과:

- 같은 에디터에 대한 명령은 자연스럽게 큐에 쌓이고, 이 플러그인도 에디터별로 직렬로 보낸다.
- **blocking 명령이 실행되는 동안에는 에디터가 아무것도 응답하지 않는다** — `sequence.render_status` 같은 진행률 질의조차도. 그 사이에 보낸 것은 모두 뒤에서 큐에 쌓인다.

**④ 취소가 없다.** 프로토콜에 `query_task` / `cancel_task`는 존재하지 않는다. `ual_task` job을 죽이는 것은 이 플러그인의 **대기**만 멈춘다; 엔진은 계속 돌고 결과는 그래도 돌아온다. 이 문장은 모델이 읽을 수 있도록 `ual_task`의 tool description에 적혀 있다.

---

## 2. 사전 요구 사항

| 항목 | 요구 사항 | 비고 |
|---|---|---|
| Unreal Engine | 5.0 – 5.8 | 플러그인의 `.uplugin`에 선언된 범위 |
| UnrealAgentLink | C++ 플러그인 본체 | 프로젝트의 `Plugins/`에 복사 |
| Node.js | `^22.19.0 \|\| >=24.0.0` | `package.json`의 `engines` 참고 |
| DSH 런타임 | 동작하는 설치라면 무엇이든 | 이 플러그인은 번들로 로드된다 |

**UEBox 데스크톱 앱은 필요 없다.** 같은 제조사의 다른 클라이언트인데, 우연히 17860 포트도 쓰므로 둘을 동시에 띄우면 포트 충돌이 난다. [README § "UEBox는 필요 없습니다"](../readme/README_ko.md#uebox는-필요-없습니다) 참고.

### UE 프로젝트에 UnrealAgentLink 설치하기

1. `UnrealAgentLink` 디렉터리 전체를 프로젝트의 `Plugins/`에 복사한다(글로벌 설치는 엔진 쪽 `Plugins/`).
2. 프로젝트 파일을 재생성하고 프로젝트를 연다.
3. **Edit → Plugins**에서 UnrealAgentLink가 활성화되어 있는지 확인한다.

플러그인은 엔진 기본 제공 의존성 두 개, `IKRig`과 `PythonScriptPlugin`을 자동으로 활성화한다(`.uplugin` 참고). 에디터가 뜨면 설정 없이도 17860 연결을 시작한다.

> 포트가 이미 쓰이고 있다면(예: UEBox 데스크톱 앱), 에디터에 다른 포트를 준다:
> `UnrealEditor.exe MyProject.uproject -UALServer=ws://127.0.0.1:17861`
> 그리고 이쪽의 `port` 설정도 맞춘다.

---

## 3. 이 플러그인 설치하기

```bash
git clone <this-repo> dsh-unreal-agentlink
cd dsh-unreal-agentlink
npm install
npm run check      # typecheck + 154 tests + catalog reconciliation, one command
```

`npm run check`는 더 나아가기 전에 완전히 초록이어야 한다. 세 가지를 검증한다: 소스와 테스트가 모두 typecheck되고, 동작 테스트가 모두 통과하고, 170개 명령 카탈로그가 C++ 레지스트리와 항목별로 들어맞는다.

### DSH 번들로 설치하기

`package.json`은 `dsh.bundle.patch: ./cordis.patch.yml`을 선언하고, 그 파일이 하는 일은 하나뿐이다:

```yaml
- insert:
    - id: unreal-agentlink
      name: dsh-unreal-agentlink
```

**참고**: DSH의 설정 레이어링에서 뒤에 오는 레이어는 이 행의 `config`를 deep-merge하지 않고 **통째로 교체**한다. 어떤 키든 override하려면 유지하고 싶은 키를 모두 다시 써야 한다.

---

## 4. 첫 연결

### 1단계: 브리지가 살아 있는지 확인

에이전트에게 `ual_status`를 호출하게 한다. 네 필드를 본다:

```
listening: true
url: ws://127.0.0.1:17860
editors: [ { sessionId: "ue-xxxxxxxx", project: "MyProject", ... } ]
```

- `listening: false` → 플러그인이 시작되지 않았거나 포트가 쓰이고 있다. DSH 로그에서 `EADDRINUSE`를 찾는다.
- `listening: true`지만 `editors: []` → 브리지가 기다리는 중이다. UE 프로젝트가 열려 있고 UnrealAgentLink가 활성화되어 있는지 확인한다.

에디터가 연결된 직후 **아주 잠깐**, 그 레코드에는 `sessionId` / `connectedAt` / `lastSeenAt` / `heartbeats` / `stale`만 있고 — `project` 같은 필드는 에디터가 `project.info`를 밀어 넣은 뒤에야 나타난다. 이것은 정상 상태이지 오류가 아니다.

### 2단계: 기능 발견

명령 이름을 추측하지 않는다. 두 단계:

```
ual_tools  { filter: "material" }        → list the material family with a one-line summary each
ual_schema { method: "material.create" } → that command's param keys, required keys, result keys, status codes
```

`ual_schema`의 키 이름은 C++ 핸들러에서 **그대로 추출**한 것이다. 이 단계를 건너뛰지 마세요: **UE는 알 수 없거나 타입이 잘못된 키를 조용히 무시한다** — 키 이름을 잘못 써도 오류가 나지 않고, 아무 일도 하지 않은 채 "성공"할 뿐이다.

### 3단계: 첫 실제 호출

```
ual_call { method: "level.get_current" }
```

순수 읽기이고 부작용이 없다. 에디터의 `result`를 **그대로** 돌려준다; 이 플러그인은 형태를 고치지 않는다.

### 4단계: 레벨 보기

```
ual_screenshot { width: 1280, height: 720 }
```

돌아오는 것은 에이전트가 직접 볼 수 있는 **실제 이미지**다. 이것은 파일 경로만 돌려주는 `ual_call { method: "editor.screenshot" }`보다 낫다.

스크린샷의 `pending_shaders` / `pending_assets`가 0이 아니면 뷰가 아직 컴파일 중이거나 스트리밍 중이라 **최종 모습이 아니다**. 그것만 보고 머티리얼이 깨졌다고 판단하지 마세요.

---

## 5. 자주 쓰는 작업 흐름

### 액터의 프로퍼티 바꾸기

```
ual_schema { method: "actor.set_property" }        # check key names first
ual_call   { method: "actor.get_info", params: { targets: { names: ["Cube_1"] } } }
ual_call   { method: "actor.set_property", params: {
               targets: { names: ["Cube_1"] },
               properties: { Mobility: "Movable" } } }
```

프로퍼티 이름을 잘못 쓰면 에디터는 404 대신 **제안을 돌려준다**. 제안을 읽고, 잘못된 철자를 재시도하지 마세요.

### 배치 조작

정해진 순서의 작업이라면 `ual_batch`로 한 번의 왕복에 처리한다:

```
ual_batch { calls: [
  { method: "actor.spawn", params: { asset_id: "cube", name: "A" } },
  { method: "actor.spawn", params: { asset_id: "cube", name: "B" } },
  { method: "actor.get_info", params: { targets: { names: ["A", "B"] } } }
] }
```

- 직렬로 실행하고(에디터가 원래 직렬이다), 기본적으로 **첫 실패에서 멈춘다**; `continueOnError: true`가 그걸 바꾼다.
- `maxBatchCalls`(기본 12)로 상한이 정해진다.
- **항목 중 하나라도 위험하면 배치 전체가 approval을 거친다.** approval 프롬프트가 어떤 항목이었는지 알려준다.

### 오래 걸리는 작업

game thread를 막는 명령은 `ual_task`를 거쳐야 한다:

```
ual_task { method: "sequence.render", params: { sequence_path: "/Game/Seq/Main" }, label: "Render main sequence" }
```

`jobId`를 즉시 돌려주고 대화는 계속된다. `job_output`로 결과를 모은다.

어떤 것들이 오래 걸리나: `sequence.render`, `cpp.compile`, `level.build`, `blueprint.compile_all`, `pcg.execute`, `pie.run`, 애셋 임포트. `ual_schema`의 timeout 열이 이들을 "blocking"으로 표시한다.

오래 걸리는 작업이 실행되는 동안에는 에디터를 **poll하지 마세요** — 응답하지 않는다.

### 롤백

```
ual_undo_history            # see what is in the buffer first
ual_undo { dryRun: true }   # rehearse
ual_undo                    # actually undo
```

UnrealAgentLink은 **에디터별로 독립적인 agent undo 스택을 하나씩** 유지하며, 사용자의 Ctrl+Z 기록과 분리되어 있다. 이 플러그인은 각 단계가 어느 DSH 세션의 것인지 기록하고, **이 세션의 단계들이 버퍼의 깔끔한 LIFO 접미사를 이루는 경우에만** 롤백한다. 그 사이에 다른 세션이 에디터를 만졌다면, 이 도구는 **아무것도 undo하지 않고** 두 단계 목록을 모두 보고한다 — 남의 작업을 조용히 버리지 않는다.

### 애셋 락 걸기

애셋에 여러 단계의 변경을 하기 전에:

```
ual_locks { claim: ["/Game/Materials/M_Rock"] }
... make changes ...
ual_locks { release: ["/Game/Materials/M_Rock"] }
```

에디터는 콘텐츠 브라우저에 "AI is editing" 배지를 그리고, 사용자가 손으로 편집을 시작하면 경고한다. 여러 세션의 claim은 이 플러그인이 보내기 전에 한 표로 합쳐지고, 에디터가 재연결된 뒤 다시 보내진다.

### 로그 읽기

```
ual_logs { level: "Warning", contains: "Niagara" }
```

로그 링은 기본적으로 비어 있다 — UE 쪽 로그 포워딩은 **기본적으로 꺼져** 있으며 에디터 안에서 `ual.ForwardLogs 1`을 실행해야 한다(이 플러그인은 원격으로 켤 수 없다). `ual_logs`는 아무것도 없을 때 그 이유를 말해준다.

포워딩이 꺼져 있을 때는 엔진 자체 메시지 로그를 대신 쓴다:

```
ual_call { method: "messagelog.list", params: { limit: 50 } }
```

---

## 6. 실패 읽기

이 플러그인은 **오류 텍스트를 절대 파싱하지 않는다**(텍스트는 에디터 culture에 따라 중국어와 영어를 오간다). **오류 클래스 이름과 status code**만으로 16가지로 분류한다.

| kind | 의미 | 해야 할 일 |
|---|---|---|
| `no-editor` | 연결된 에디터가 없음 | UE 프로젝트를 열고 플러그인이 활성화되어 있는지 확인 |
| `timeout` | 시간 초과, **명령은 아직 실행 중일 수 있음** | **재전송하지 마세요**. 먼저 읽기 명령으로 실제 상태를 확인 |
| `editor-lost` | 에디터가 끊어짐 | 5초 재연결을 기다림 |
| `queue-stalled` | 앞선 명령이 시간 초과함 | `ual_status`의 `orphaned` 확인 |
| `circuit-open` | 반복된 전송 실패로 breaker가 열림 | 멈추고 cooldown을 기다린 뒤 `ual_status` 확인 |
| `rate-limited` | rate limit 큐가 가득 참 | 속도를 낮춤 |
| `not-found` | 그런 method나 애셋이 없음 | `ual_tools`로 실제 명령 이름을 찾음 |
| `bad-params` | 파라미터가 없거나 타입이 잘못됨 | `ual_schema`로 키 이름 확인 |
| `precondition` | 사전 조건 실패(412/413/422) | `details`를 읽음; 422는 "입력은 유효하지만 아무것도 기록되지 않음" |
| `registry-busy` | 애셋 레지스트리가 아직 스캔 중 | `content.registry_status`를 poll |
| `unsupported` | 이 에디터 버전이 지원하지 않음 | 예: `anim.*`은 UE 5.5+ 필요 |
| `engine-error` | 에디터 자체가 실패 | `result.message`(사람용)와 `details`(기계용)를 읽음 |

**가장 규율이 필요한 kind는 timeout이다.** 프로토콜에 취소가 없으므로, timeout은 "이 플러그인이 기다리기를 멈췄다"는 뜻만이다 — 명령은 game thread에서 아직 실행 중일 가능성이 크다. 올바른 대응은: `ual_status`에서 `orphaned`를 확인하고, 읽기 전용 명령으로 실제 상태를 검증하고, **재전송하지 않는 것**이다.

---

## 7. 구성

모든 키를 바꿀 수 있고, 기본값은 "살아 있지만 게으른" 상태다. 전체 표는 [README § 구성](../readme/README_ko.md#구성)에 있다. 눈여겨볼 만한 것 몇 개:

- **`port`** — 여기서 바꾸면 UE 쪽도 `-UALServer=`가 필요하다.
- **`rateLimitRps: 0`** — rate limiting을 끈다.
- **`rollbackOnDispose: false`** — 세션이 끝날 때 자동 undo를 **하지 않는다**. 켜면 dispose 시 롤백한다는 뜻인데, 보통 사용자가 요청하지 않은 뜻밖의 동작이다.
- **`logForwardingEnabled: false`** — 에디터 안에서 `ual.ForwardLogs 1`을 실행한 뒤에만 `true`로 설정한다.

---

## 8. 문제 해결

**`ual_status`가 `listening: true`를 보여주는데 에디터가 없다**
UE 프로젝트가 열려 있지 않거나 UnrealAgentLink가 활성화되지 않았다. 에디터 로그의 `LogUALNetwork`도 확인할 수 있다: 보통 `Connecting to ws://127.0.0.1:17860`와 `Connected to`가 보여야 한다.

**기동 시 `EADDRINUSE`**
17860이 쓰이고 있다. 대부분 UEBox 데스크톱 앱 때문이다. 그것을 닫거나, 에디터와 이 플러그인을 모두 다른 포트로 옮긴다.

**명령이 모두 `unknown-method`를 반환하거나 아예 거부된다**
이 플러그인은 카탈로그에 실제로 존재하는 170개 명령만 통과시킨다. `ual_tools`로 이름을 확인하세요. 폐기된 명령(예: `editor.play`, `take_screenshot`)은 대체 명령을 돌려준다.

**스크린샷이 검거나 반만 완성됨**
`pending_shaders` / `pending_assets`를 확인한다. 0이 아니면 컴파일이나 스트리밍이 끝나지 않은 것이다. `warmup_frames`를 올리고 재시도한다.

**`ual_undo`가 실행을 거부한다**
이 세션의 단계들이 버퍼의 깔끔한 LIFO 접미사가 아니다 — 그 사이에 다른 세션이 에디터를 만졌다. 이것은 버그가 아니라 **의도적인 보호**다. `ual_undo_history`로 실제 내용을 본다.

**구성 변경이 효과가 없었다**
DSH의 설정 레이어링은 그 행의 `config`를 deep-merge하지 않고 **통째로 교체**한다. 유지하고 싶은 키를 모두 써야 한다.

**`ual_task` job을 죽였는데 에디터가 여전히 바쁘다**
예상된 동작이다. 프로토콜에 취소가 없다. 끝날 때까지 기다린다 — 더 실용적으로는, 오래 걸리는 작업이 실행되는 동안 다른 명령을 보내지 않는 것이다.

---

## 9. 다음 단계

- [프로토콜 참조](02-protocol.md) — 메시지 형태, 이벤트, status code
- [아키텍처](03-architecture.md) — gate chain, 세션 격리, 오류 변환의 근거
- [명령 참조](command-reference.md) — 170개 명령 전체의 파라미터와 결과 키(생성됨)
