<div align="center">

[English](../02-protocol.md) · [简体中文](../zh/02-protocol.md) · [繁體中文](../zh-TW/02-protocol.md) · [日本語](../ja/02-protocol.md) · **한국어** · [Deutsch](../de/02-protocol.md) · [Español](../es/02-protocol.md) · [Français](../fr/02-protocol.md) · [Русский](../ru/02-protocol.md)

[README](../readme/README_ko.md) · [튜토리얼](01-tutorial.md) · **프로토콜** · [아키텍처](03-architecture.md) · [명령 참조](command-reference.md)

</div>

# 프로토콜 참조

UnrealAgentLink의 와이어 프로토콜. 이 플러그인은 **서버**이고; Unreal Editor는 **클라이언트**다.

여기 나오는 모든 결론은 `.ua-ref/plugin/UnrealAgentLink/Source/UnrealAgentLink/` 아래의 C++에서 나왔고, 하중을 받는 지점에는 파일과 행 참조가 붙어 있다.

---

## 1. 연결

| 항목 | 값 | 근거 |
|---|---|---|
| 방향 | UE가 전화를 건다 | `Network/UAL_NetworkManager.cpp:77` `CreateWebSocket(TargetUrl)` |
| 기본 주소 | `ws://127.0.0.1:17860` | `Core/UnrealAgentLink.cpp:88` |
| 바꾸는 법 | 커맨드 라인 `-UALServer=ws://host:port` | `Core/UnrealAgentLink.cpp:90` |
| 인증 | **없음** — 토큰, 헤더, 서브프로토콜 모두 없음 | `CreateWebSocket`은 URL만 받는다 |
| 재연결 | 5초 고정 주기, backoff 없음 | `Network/UAL_NetworkManager.cpp:116` |
| 연결 정체 보호 | 있음(`ConnectTimeoutSeconds`) | `Network/UAL_NetworkManager.cpp:145-155` |

이 플러그인은 17860을 `maxPayload` 64 MB로 listen한다.

### Origin 검사

loopback origin만 받아들인다(`127.*`, `::1`, `::ffff:127.*`). 설정된 `host`가 `127.0.0.1` / `localhost`가 아닌 값으로 **의도적으로** 설정된 경우에만 넓어진다. 이유는 "인증 없음"에 있다 — 포트가 credential이다.

### 핸드셰이크

**핸드셰이크는 없다.** 에디터는 연결되는 즉시 `project.info`를 밀어 넣고, 이 플러그인은 그것으로 식별됨(`editor-identified`)을 표시한다. 그것이 도착하기 전에는 "연결됐지만 미식별" 상태인데 — `ual_status`의 그런 레코드에는 `sessionId` / `connectedAt` / `lastSeenAt` / `heartbeats` / `stale`만 있고 `project` 같은 건 없다.

---

## 2. 메시지 형태

```
UE → plugin:  { ver:"1.0", type:"req",  method, id, params }
plugin → UE:  { ver:"1.0", type:"res",  id, code, result }
UE → plugin:  { ver:"1.0", type:"evt",  method, payload }
```

### `req` (이 플러그인 → 에디터)

| 필드 | 비고 |
|---|---|
| `ver` | 항상 `"1.0"` |
| `type` | `"req"` |
| `method` | 명령 이름, 예: `actor.get_info` |
| `id` | **서버**가 생성하며 형태는 `dsh-<uuid>` |
| `params` | 선택. **비어 있을 때는 키 전체가 생략**되고, `null`로 보내지 않는다 |

`id`는 비어 있지 않아야 한다: `SendResponse`의 첫 줄이 `if (RequestId.IsEmpty()) { return; }`(`Utils/UAL_CommandUtils.cpp:2503-2506`)이기 때문이다 — **id 없는 요청은 응답을 받지 못한다**.

에디터 쪽 파싱(`Commands/UAL_CommandHandler.cpp:87-94`)은 `params`를 먼저 읽고 구 필드 `payload`로 폴백한다. 이 플러그인은 `params`만 보낸다.

### `res` (에디터 → 이 플러그인)

| 필드 | 비고 |
|---|---|
| `ver` | `"1.0"` |
| `type` | `"res"` |
| `id` | 요청 `id`를 에코하며, 매칭에 쓰인다 |
| `code` | **숫자**다, 문자열이 아니다 |
| `result` | 선택. **내용이 없으면 키 전체가 생략**된다 |

생략 로직은 `Utils/UAL_CommandUtils.cpp:2513-2516`에 있다: `Data.IsValid()`일 때만 `result`가 기록된다.

에디터 쪽 응답 본문 파싱(`Commands/UAL_CommandHandler.cpp:98-104`)은 `result` → `data` → `payload` 순서로 시도한다. 이 플러그인은 `result`를 보낸다.

### `evt` (에디터 → 이 플러그인, 단방향 푸시)

| 필드 | 비고 |
|---|---|
| `ver` | 이벤트가 `SendEvent`로 보내질 때 존재한다; **콘텐츠 브라우저 확장의 import 이벤트는 그것을 담지 않는다** |
| `type` | `"evt"` |
| `method` | 이벤트 이름 |
| `payload` | 선택 |
| `id` | **존재하지 않음** — 이벤트는 응답할 수 없다 |

---

## 3. 실패를 어떻게 표현하는가

**`code`만으로.** 메시지에 envelope 레벨의 `error` 필드는 **없다**.

| 코드 | 의미 | 이 플러그인의 kind |
|---|---|---|
| `200` | 성공 | — |
| `207` | 부분 성공 | `partial: true` |
| `400` | 파라미터가 없거나 타입이 잘못됨 | `bad-params` |
| `404` | 그런 method나 애셋이 없음 | `not-found` |
| `409` | 충돌(예: 독점 프로파일러가 이미 실행 중) | `conflict` |
| `410` | 제거됨 | `not-found` |
| `412` | 사전 조건 미충족 | `precondition` |
| `413` | 상한 초과(예: cvar 한도를 넘긴 배치 생성) | `precondition` |
| `422` | 입력은 유효하지만 아무것도 기록되지 않음 | `precondition` |
| `500` | 에디터 내부 오류 | `engine-error` |
| `501` | 이 버전에서 미지원 | `unsupported` |
| `503` | 애셋 레지스트리가 아직 스캔 중 | `registry-busy` |
| `504` | 에디터 쪽 시간 초과 | `timeout` |

`0`은 **절대 쓰이지 않는다**.

이 13개 코드는 `protocol/types.ts`에서 `UAL_CODES`로 정의되고, `scripts/check-catalog.mjs`의 check 4가 C++ 소스를 직접 조회해서 검증한다 — `FUAL_RegistryReady::Ensure` 같은 공유 게이트가 내보내는 503과, `Code = bOk ? 200 : 207` 같은 표현식 형태까지 포함해서. 코드가 하나 빠지거나 하나 더 있어도 check는 실패한다.

### 오류 텍스트가 있는 곳

```
result.message   ← for humans, Chinese or English by editor culture, never parse it
result.details   ← for machines (suggestions / expected_type / registry progress)
```

`SendError`는 `{message: ...}`를 만들고, 4인자 오버로드가 `details`도 함께 붙인다(`Utils/UAL_CommandUtils.cpp:2525-2539`).

### 200도 실패일 수 있다

**가장 빠지기 쉬운 함정이다.** 많은 핸들러가 `result.ok === false`인 채 `200`을 반환한다:

- `editor.undo` — undo할 것이 없을 때
- `blueprint.compile` — 컴파일에 오류가 있을 때
- `pie.observe` — 관찰이 실패했을 때

그래서 이 플러그인은 code만이 아니라 `judge(result, code)`로 성공을 판정한다:

| 상황 | 판정 |
|---|---|
| `code === 200`, `result.ok !== false`, `result.error`가 비어 있음 | 성공 |
| `code === 207` | 성공이지만 `partial: true` |
| `result.ok === false` | **실패** |
| `result.error`가 비어 있지 않은 문자열 | **실패** |
| `result`가 객체가 아님(또는 없음) | code로 판정하고 추측하지 않음 |

이 규칙은 **필요하다**: 14개 C++ 파일에 `SetStringField(TEXT("error"), ...)`가 55곳 있다. 즉 "200에 비어 있지 않은 error"는 예외가 아니라 규범이다.

---

## 4. 이벤트

| 이벤트 | 언제 | payload |
|---|---|---|
| `project.info` | 연결되는 즉시, 핸드셰이크를 대신함 | 프로젝트 이름, 경로, 엔진 버전, 플러그인 버전, 실행 모드, 현재 레벨, Python 사용 가능 여부 등 |
| `project.closed` | 에디터가 프로젝트를 닫을 때 | — |
| `system.heartbeat` | **10초**마다 | `{}`(**항상 존재**, 생략되지 않음) |
| `log.entry` | UE 로그 출력(cvar `ual.ForwardLogs 1` 필요) | `text` / `category` / `level` |
| `content.import_folder` | 사용자가 콘텐츠 브라우저 컨텍스트 메뉴에서 "import to UnrealBox asset library"를 선택할 때 | `paths` / `real_paths` / `asset_metadata` |
| `content.import_assets` | 위와 동일, 레벨 뷰포트에서 시작됨 | `asset_paths` / `asset_real_paths` / `asset_metadata` |

### 하트비트와 에디터 사망 선언

하트비트는 5초 재연결과 무관한 **독립적인 10초 티커**다(`Network/UAL_NetworkManager.cpp:173`). 이 플러그인은 하트비트가 **45초** 없으면 에디터를 `stale`로 표시한다 — 프론트 엔드와 동일하게(`Network/UAL_NetworkManager.cpp:172`).

### 두 import 이벤트는 fire-and-forget다

`id`를 **담지 않고**, 에디터는 **응답을 기다리지 않는다**. 에디터 쪽 `Handle_Response`(`Commands/UAL_CommandHandler.cpp:185-297`)는 `type:"res"`를 받을 때만 Slate 알림을 띄우고, `ok` / `count` / `importedPath` / `error`를 읽는다.

이 플러그인은 애셋을 임포트할 능력이 없는 순수 브리지이므로, 이벤트를 **로그와 agent 알림**으로 바꾸고 `res`를 **조작하지 않는다** — `ok:false`로 응답하는 것은 사용자에게 거짓 "import failed" 대화상자를 보여주는 것뿐이라, 침묵보다 나쁘다.

---

## 5. 직렬화 규칙

보내는 파라미터는 와이어에 나가기 전에 `protocol/serialization.ts`의 `toSerializable()`을 통과한다. 이것은 `JSON.stringify`보다 엄격한데, **UE는 읽을 수 없는 필드를 "보내지 않은 것"으로 취급**하기 때문이다 — 오류보다 아무 일도 하지 않는 침묵이 더 진단하기 어렵다.

| 입력 | 처리 |
|---|---|
| `null` / boolean / string | 그대로 |
| 유한 수 | 그대로 |
| **비유한 수**(`NaN` / `Infinity`) | **던짐** — UE는 "필드 없음"으로 읽는다 |
| `undefined`(최상위, 또는 배열 안) | **던짐** |
| `undefined`(객체 프로퍼티 값) | **키를 버림** |
| function / symbol / bigint | **던짐** |
| 순환 참조 | **던짐** |
| `Uint8Array` | base64 문자열로 변환 |
| `Date` | ISO 문자열로 변환 |
| `Map`(키는 문자열이어야 함) | 일반 객체로 변환 |
| `Set` | 배열로 변환 |
| 기타 비일반 객체(클래스 인스턴스 등) | **던짐** |

통과하는 것은 일반 객체, 배열, JSON 스칼라뿐이다.

---

## 6. 타이밍과 동시성

**한 에디터에 대한 명령은 직렬이다.** 이 플러그인은 에디터별로 send 큐를 하나씩 유지하고, 각 명령을 이전 명령의 `then`에 체이닝한다. 이것은 프로토콜을 만족시키기 위함이 아니다 — 에디터가 원래 game thread에서 동기적으로 완료까지 실행하기 때문이다.

**큐는 에디터 간에 독립적이다.** 여러 에디터가 연결되면 각자 큐를 갖는다.

### 타임아웃

기본값은 180초고, blocking 명령은 자체 하한선을 올린다(`ual_schema`의 timeout 열이 이들을 "blocking"으로 표시한다).

**타임아웃은 명령이 실행되지 않았다는 뜻이 아니다.** 이 플러그인이 기다리기를 멈췄다는 뜻만이다. 그런 일이 일어나면:

1. 에디터가 고아 명령을 가진 것으로 표시된다(`ual_status`의 `orphaned`).
2. 그 뒤의 **같은 에디터에 대한 짧은 명령들은 아예 거부**되며(`queue-stalled`), 영원히 돌아오지 않을 작업 뒤에 큐에 쌓이지 않는다.
3. `long: true` 호출은 여전히 보낼 수 있다 — "기다릴 의향이 있다"는 표현이다.

**중단된 호출에도 동일하게 적용된다**: `ual_task` job을 죽이는 것은 abort를 거치고, abort는 이 플러그인의 대기만 멈추며 엔진은 계속 돌아간다. 그래서 abort도 고아를 기록한다.

### 단절

에디터가 끊어지면, 그것에 대한 모든 in-flight 요청이 `editor-lost`로 실패하고, 오류는 모든 method 이름을 담고 있다.

---

## 7. 이 플러그인이 보내지 않는 것

경계를 명확히 하기 위해:

- **토큰 없음** — 인증 메커니즘이 없다.
- **`GET /api/ual/action` 없음** — 낡은 문서가 이것을 HTTP 서비스로 설명했는데, 틀렸다.
- **작업 폴링 없음** — `query_task` / `cancel_task`는 존재하지 않는다.
- **조작된 `res` 없음** — import 이벤트 절을 보세요.
- **에디터로의 능동 재연결 없음** — 방향이 거꾸로이므로; 에디터가 스스로 5초마다 재시도한다.

---

## 8. 관련 파일

| 파일 | 내용 |
|---|---|
| `src/protocol/types.ts` | 메시지 타입, `UAL_CODES`, `UalError` |
| `src/protocol/bridge.ts` | WebSocket 서버, 큐, 타임아웃, 고아, 로그 링 |
| `src/protocol/serialization.ts` | 위 표의 모든 직렬화 규칙 |
| `src/service.ts` | `judge()`, gate chain, ledger |
| `src/errors/translate.ts` | status code / 클래스 이름 → 16가지 kind |

C++ 쪽 대응물: `Utils/UAL_CommandUtils.cpp`(`SendResponse` / `SendError` / `SendEvent`), `Commands/UAL_CommandHandler.cpp`(인바운드 디스패치), `Network/UAL_NetworkManager.cpp`(연결, 하트비트, 재연결).
