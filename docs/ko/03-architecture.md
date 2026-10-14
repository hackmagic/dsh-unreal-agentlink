<div align="center">

[English](../03-architecture.md) · [简体中文](../zh/03-architecture.md) · [繁體中文](../zh-TW/03-architecture.md) · [日本語](../ja/03-architecture.md) · **한국어** · [Deutsch](../de/03-architecture.md) · [Español](../es/03-architecture.md) · [Français](../fr/03-architecture.md) · [Русский](../ru/03-architecture.md)

[README](../readme/README_ko.md) · [튜토리얼](01-tutorial.md) · [프로토콜](02-protocol.md) · **아키텍처** · [명령 참조](command-reference.md)

</div>

# 아키텍처

이 플러그인은 **순수 브리지**다: 작업을 계획하거나 무엇을 할지 결정하지 않는다. DSH 에이전트의 의도를 UnrealAgentLink 명령으로, 그리고 에디터의 응답을 에이전트가 쓸 수 있는 형태로 번역한다. 계획은 DSH의 에이전트에 속한 일이고, 이곳에 속한 일이 아니다.

이 절에서는 코드가 그런 모양인 이유를 설명한다.

---

## 1. 모듈 맵

```
src/
  index.ts          Cordis lifecycle, approval gate, dispose-time rollback
  config.ts         Schemastery schema (the single source of default values)
  service.ts        call() gate chain — the one entry point for every command
  protocol/
    bridge.ts       WebSocket server: connections, queues, timeouts, orphans, log ring
    serialization.ts  outbound parameter validation (stricter than JSON.stringify)
    types.ts        wire types and UAL_CODES
  catalog/
    method-data.ts      five tables extracted from C++ (generated, do not hand-edit)
    method-overrides.ts  manual patches where the extractor cannot reach
    methods.ts          170 commands with risk tier and summary + query functions
  errors/translate.ts   error classification (by class name / status code, not by text)
  resilience/breaker.ts rate limiter + circuit breaker
  sessions/state.ts     session ledger, LIFO test, lock merging, cache, log filtering
  tools/                the 12 tools
scripts/
  extract-methods.mjs   extracts the catalog from the C++ (generates method-data.ts)
  check-catalog.mjs     reconciles catalog against the C++ registry, both directions
  gen-docs.mjs          renders docs/<lang>/command-reference.md for all 9 languages
  languages.mjs         the language set — shared by the generator and the docs tests
docs/                   tutorial / protocol / architecture / command reference, ×9 languages
tests/                  162 tests in 8 files
```

### 의존성 방향

```
index.ts ──► service.ts ──► protocol/bridge.ts
    │            │
    │            ├──► catalog/methods.ts ──► catalog/method-data.ts
    │            ├──► resilience/breaker.ts
    │            ├──► sessions/state.ts
    │            └──► errors/translate.ts
    └──► tools/* ──► service.ts
```

역방향 의존성은 없다. `tools/`는 `service`에만 의존하고, `service`는 어떤 tool에도 의존하지 않는다.

---

## 2. gate chain: `service.call()`

**모든** 명령은 이 하나의 진입점(`src/service.ts:190-332`)을 고정된 순서로 통과한다:

```
1. catalog gate    the method is not in the catalog → refuse, never forward
2. requires gate   a required key is missing → refuse, never forward
3. read cache      read-only + cacheable + not long → return, never touch the socket
4. breaker         acquire() throws when open / admit() lets exactly one half-open probe
5. rate limit      throws when the queue is full
6. send            bridge.send() → the editor
7. judge()         200/207 plus result.ok/error decides success
8. ledger          recorded only when the call both mutates and succeeds
9. translate       on failure, classify by class name / status code
   finally         breaker.release()
```

처음 두 단계의 가치는 엔진이 그 호출을 보기도 전에 **거부한다**는 데 있다. UE는 알 수 없는 키를 조용히 무시하므로, 키 이름을 잘못 쓰면 호출이 아무 일도 하지 않은 채 "성공"한다 — 오류보다 훨씬 디버그하기 어렵다.

`call()`은 **절대 던지지 않는다**. 모든 실패는 `CallOutcome.value` 안의 `ok: false`로 돌아온다. 이것은 의도적인 것이다: tool 레이어의 모든 분기가 구조화된 결과를 렌더링해야 하지, 각자 try/catch를 하면 안 된다.

### 왜 처음 두 단계는 "위험 표"가 아니라 "카탈로그"여야 하는가

`riskOf()`는 **알 수 없는** method에 대해 `'dangerous'`를 반환한다(보수적인 기본값). 이전 버전은 이것으로 "이 메서드가 존재하는가"를 추론했는데, 그 결과:

- 실제로 존재하는 메서드 5개를 거짓으로 거부하고(`level.new`, `level.open`, `level.save`, `content.migrate`, `blueprint.import_t3d`)
- 한편으로는 지어낸 `editor.*` 이름은 무엇이든 통과시켰다

이제 질문은 `riskOf()`가 아니라 `isKnown()`(카탈로그 조회)다. **존재 여부는 카탈로그 질문이지 위험 질문이 아니다.**

---

## 3. 세션 격리와 롤백

### 문제

UnrealAgentLink은 **에디터별로 agent undo 스택을 하나씩** 유지하며, 모든 DSH 세션이 공유한다. DSH 쪽에서는 여러 세션이 동시에 같은 에디터를 구동할 수 있다.

그래서 "내 세션이 한 일을 undo하는 것"은 프로토콜이 지원하지 않는 조작이다.

### 접근법

`src/sessions/state.ts`는 각 세션이 밟은 모든 단계를 기록하고 각각에 **전역적으로 증가하는 번호**(`global`)를 준다. 롤백하기 전에 이 세션의 단계들이 그 에디터 버퍼의 **깔끔한 LIFO 접미사**를 이루는지, 즉 이 세션의 마지막 단계가 다른 모든 세션의 마지막 단계보다 뒤인지 확인한다.

```
yes  → roll back, undoing only this session's steps
no   → undo nothing, and report both step lists
```

남의 작업을 조용히 버리는 것보다 거부하는 편이 낫다.

### `rollbackOnDispose`의 기본값은 false

세션이 dispose될 때 자동으로 롤백하면 편해 보이지만, **사용자는 그것을 요청한 적이 없다**. 기본으로 꺼져 있고; 켜는 것은 "세션이 끝나면 그 작업을 undo해야 한다"는 명시적 선언이다.

---

## 4. 오류 변환: 왜 텍스트를 읽지 않는가

오류 텍스트는 에디터 culture에 따라 중국어와 영어를 오간다(`result.message`). 그것을 파싱하면 플러그인이 한 언어에 묶이고, 텍스트는 언제든 바뀔 수 있다.

`src/errors/translate.ts`는 **오류 클래스 이름**(`NoEditorError`, `BridgeTimeoutError`, …)과 **status code**만으로 16가지 kind로 분류하고, 각각에 대해 다음에 무엇을 할지에 대한 제안을 준다.

순서는: 클래스 이름 먼저, 그다음 status code. status code 중에서 `410`은 `not-found`로, `422`는 `precondition`로, `504`는 `timeout`으로 매핑된다 — 이 매핑들은 어느 것도 자명하지 않으며, 그래서 `scripts/check-catalog.mjs`의 check 4가 C++ 소스를 조회해서 완전한 커버리지를 보장한다.

**분류가 빠지면 왜 해로운가**: 폴백인 `engine-error`는 "파라미터는 괜찮고 에디터 자체가 고장 났다"고 말한다. 그래서 분류되지 않은 코드는 모델을 정반대 방향으로 가리킨다. 가장 명확한 예는 `422`다 — 그것은 실제로 "입력은 유효했지만 아무것도 기록되지 않았다"는 뜻이라, "에디터가 고장 났다"와는 전혀 다르다.

---

## 5. 회로 차단기와 rate limiter

### breaker는 에디터를 보호한다

`src/resilience/breaker.ts`. 핵심 결정: **4xx는 `input`으로 기록되고 breaker를 trip시키지 않는다.**

근거: 나쁜 호출을 열 번 연속으로 하는 에이전트는 **작동하는** 것이지, 에디터를 죽이는 것이 아니다. 반복되는 **전송** 실패만이 에디터 자체가 곤경에 빠졌다는 뜻이다.

### rate limiter가 실제 버그를 고쳤다

슬라이딩 윈도우 limiter가 원래 **큐에 맨 처음 들어간 호출자를 즉시 통과**시켰다 — 그래서 버스트의 두 번째 호출은 즉시 통과하고 한도는 아무 일도 하지 않았다. 수정은 `breaker.ts:schedule()`에 있다: 첫 release가 즉시 발사하는 대신 남은 간격을 기다린다.

---

## 6. 로그 링

에디터는 `log.entry`를 밀어 넣는다(에디터 안에서 `ual.ForwardLogs 1`이 필요하고, 이것은 이 플러그인이 원격으로 켤 수 없다).

`bridge.ts`는 용량 512의 링을 유지한다: 최소 레벨(기본 `Display`)로 필터링하고, 심각도로 정렬하고, `sinceSeq`로 페이지네이션하고, 대소문자를 구분하지 않는 카테고리/텍스트 필터링을 한다.

**왜 로컬에서 하는가**: 모든 로그 줄을 모델에게 그대로 전달하면 모델의 context가 잠긴다. 링과 필터링이 있으면 에이전트가 필요한 것을 끌어올 수 있지, 모든 것이 밀려 들어오지는 않는다.

---

## 7. 오래 걸리는 작업: `ual_task`

프로토콜에는 **취소 의미론이 없다**. `ual_task`는 오래 걸리는 호출을 실제 DSH job(kind `ual`)으로 감싸서 대화가 계속될 수 있게 한다.

두 가지는 반드시 tool description에 적어야 한다, 그렇지 않으면 모델이 틀림없이 오해한다:

1. **job을 죽이는 것은 이 플러그인의 대기만 멈춘다.** 엔진은 계속 돌고 결과는 그래도 돌아온다.
2. **blocking 명령이 실행되는 동안 에디터는 아무것도 응답하지 않는다** — `sequence.render_status`조차도. 그러므로 오래 걸리는 작업이 실행되는 동안 poll하지 마세요.

---

## 8. tool 표면: 170이 아니라 12

170개 명령이 각자 tool이라면 170개의 schema가 모든 요청의 프롬프트를 먹을 것이다 — 그리고 압도적 다수의 요청은 그중 무엇도 쓰지 않는다.

그래서:

- `ual_tools`는 기능을 나열한다(계열이나 키워드로 필터링 가능)
- `ual_schema`는 한 명령의 정확한 키 이름을 준다
- `ual_call`은 실행한다

**기능 발견은 0단계가 아니라 2단계가 든다.** 이것은 의도적인 절충이다: 왕복 한 번을 더 쓰는 대신 요청당 schema 170개를 줄인다.

---

## 9. 생성된 파일과 "아무도 가져오지 않는 표"

이 프로젝트에서 한 결함 종류가 되풀이되고 따로 적어둘 만하다: **손으로 유지되는 표가 만들어지지만, 아무도 그것을 임포트하지 않는다.**

지금까지의 사례:

| 표 | 증상 |
|---|---|
| `REQUIRED_KEYS` | 필수 키 검증이 죽은 코드였고, `ual_schema`가 `REQUIRED:`를 보여주지 않았다 |
| `EXTRA_PARAM_KEYS` | `PARAMS_UNRESOLVED` 메서드 4개의 파라미터 목록이 비어 있었다 |
| `UAL_CODES` | `410` / `422` / `504`가 분류되지 않고 오도적인 `engine-error`로 폴백됐다 |

공통점: 표 자체는 정확했고 문서화됐고 리뷰됐지만 — 런타임은 다른 경로를 읽었다.

대책은 각 검사가 **표에 묻지 않고 소스에 묻게** 만드는 것이다:

- `check-catalog.mjs` check 3: 모든 `requires` 키는 C++ 소스에 등장하는 리터럴이어야 한다
- `check-catalog.mjs` check 4: `UAL_CODES`는 C++가 실제로 보내는 코드 집합과 일치해야 한다(공유 게이트와 `Code = bOk ? 200 : 207` 같은 표현식 형태 포함)
- `gen-docs.mjs --check`: 명령 참조가 카탈로그와 일치해야 한다
- `i18n.test.ts`: 문서가 완전하고 내부적으로 일관되어야 한다 — 번역에서 이것은 "링크가 여전히 resolve된다"는 뜻이고, 앵커는 *번역된* 제목에서 도출되므로 조용히 깨진다

언어 집합이 이 형태의 최신 사례다. `gen-docs.mjs`와 `tests/i18n.test.ts` 모두 어떤 언어가 있는지 알아야 하는데, 각자 사본을 들고 있는 동안 언어를 추가하려면 둘 다 손으로 찾아야 했다 — 그리고 생성기는 쓰지만 테스트가 검사하지 않는 언어는 아무도 검증하지 않는 언어다. `scripts/languages.mjs`가 이제 단일 출처이고, 둘이 임포트한다.

이것들은 모두 **자기 정당화하지 않는** 검사다: 소스를 깨거나 표를 깨면 어느 쪽이든 실패한다.

---

## 10. 타입 안전성의 실제 함정 두 개

### `undefined` 프로퍼티가 폭발한다

dsh-tools는 tool 결과를 디스패치할 때 **2단계** 파이프라인을 실행한다:

1. `snapshotJsonValue(value)` — **어떤** 자체 프로퍼티라도 `undefined`이면 `value is not lossless JSON`를 던진다
2. `validateJsonSchemaValue(schema, value)` — schema를 검증한다

첫 단계가 schema보다 엄격하고 **먼저 실행**되므로, schema만 확인하는 테스트는 이 부류의 버그를 잡을 수 없다.

실제 증상: 에디터가 연결되고 `project.info`를 밀어 넣기 전인 **그 순간**, `ual_status` 레코드에 `project: undefined` 같은 키가 있었다 — 그래서 "가장 먼저 읽는 도구"가 에디터가 나타나는 즉시 던졌다.

수정은 `undefined`를 쓰는 대신 조건부 전개다:

```ts
...(session.info?.projectName !== undefined ? { project: session.info.projectName } : {})
```

### 출력 schema는 모든 키를 선언해야 한다

tool의 출력 schema는 `additionalProperties: false`를 쓰고, 레지스트리는 그것을 **키 단위로** 검증한다. 그래서 `ual_screenshot`가 반환하는 `attachment`는 schema에 선언되어야 한다 — 그렇지 않으면 스크린샷이 **성공하는 순간** `ToolOutputError`를 던지는데, 텍스트 경로는 잘 동작한다.

schema 언어에는 `ImageAttachmentRef` 노드가 없어서 `{ type: 'json' }`로만 선언할 수 있다. 그러면 추론 타입이 `JsonValue`로 넓어지므로, 렌더 경로는 `as` 단정이 아니라 **런타임 가드**로 좁혀야 한다:

```ts
const attachment = imageRef(record.attachment)   // validates field by field
return attachment ? [{ type: 'image', attachment }, ...blocks] : blocks
```

컴파일러가 여기서 단순 `as`를 거부한다(TS2352: 두 타입이 충분히 겹치지 않는다) — 그것은 런타임 검사를 요구하는 것이지, 까다로운 게 아니다.

---

## 11. 검증 전략

```bash
npm run check
```

다음과 동일하다:

```bash
tsc -p tsconfig.json --noEmit      # src
tsc -p tsconfig.test.json          # tests (src's tsconfig does not include tests)
vitest run                         # 154 tests
node scripts/check-catalog.mjs     # 4 reconciliation checks
```

테스트는 8개 파일에 있고, **그들이 찾아낼 수 있는 결함의 종류**로 나뉜다:

| 파일 | 커버리지 |
|---|---|
| `protocol.test.ts` | `judge()` 계약, 직렬화 규칙 |
| `translate.test.ts` | 16가지 kind 전체의 분류와 힌트 |
| `resilience.test.ts` | breaker 상태 머신, rate limit 큐잉, `notifierFor` |
| `catalog.test.ts` | 카탈로그 조회, 프로토타입 체인 보호, approval gate의 end-to-end |
| `bridge.test.ts` | 실제 WebSocket: 큐, 타임아웃 고아, 이벤트, 셧다운 |
| `tool-output.test.ts` | 2단계 파이프라인을 통과하는 모든 tool의 실제 반환값 |
| `i18n.test.ts` | 9개 언어 전체에서 문서가 완전하고 내부적으로 일관됨 |
| `end-to-end.test.ts` | 실제 gate chain + 실제 소켓 + 실제 tool schema |

**왜 `end-to-end.test.ts`가 존재해야 하는가**: 다른 모든 테스트는 한 레이어를 스텁한다. `REQUIRED_KEYS` 버그 — 생성되고 문서화되고 리뷰됐는데 임포트되지 않음 — 는 어떤 단위 테스트에도 잡히지 않았는데, 각 레이어가 고립된 상태에서 자기 정합적이었기 때문이다. 실제 gate chain을 실제 소켓에 연결해서 실제 schema에 먹여줘야만 **레이어 사이의 이음새**가 드러난다.

같은 이유로 `tool-output.test.ts`는 자체 schema 검사를 쓰지 않고 **실제** `snapshotJsonValue` + `validateJsonSchemaValue`를 쓴다 — 그렇지 않으면 `ual_status`의 `undefined` 결함이 그냥 빠져나갈 것이다.

`i18n.test.ts`는 같은 이유로, 다른 이음새에 대해 존재한다. `src/` 아래의 모든 것은 `docs/`에 대해 아무것도 모르므로, 기존 테스트로는 언어 전환 바에서 언어를 빠뜨렸거나 이름을 바꾼 제목에 링크한 번역을 눈치챌 수 없었다. 그것은 문서를 데이터로 읽는다: 모든 언어가 네 파일을 가지고, 모든 바가 아홉 언어를 모두 나열하고 자신의 것만 볼드하며, 모든 상대 링크가 실제 파일로 resolve되고, 모든 `#anchor`가 실제 제목으로 resolve된다. 마지막이 흥미로운 것인데 — 앵커는 *번역된* 제목 텍스트에서 도출되므로, 번역자가 "Verification strategy"를 다르게 쓰는 순간 그 절로 들어오는 모든 링크가 조용히 무효가 되고 어디에도 오류가 나지 않는다. `gen-docs.mjs --check`는 생성된 명령 참조를 같은 방식으로 보호한다; `i18n.test.ts`는 렌더를 재구현하지 않고 그것을 셸 아웃한다.

---

## 12. 구성

`src/config.ts`의 Schemastery schema가 **기본값의 단일 출처**다. `cordis.patch.yml`의 `config`는 schema가 이미 가진 기본값을 되풀이해서 적은 것뿐이다.

**DSH의 설정 레이어링을 참고**: 뒤에 오는 레이어는 그 행의 `config`를 deep-merge하지 않고 **통째로 교체**한다. 어떤 키든 override하려면 유지하고 싶은 키를 모두 다시 써야 한다.

`allowDangerous` 같은 스위치는 **의도적으로 존재하지 않는다** — 위험 gate는 플러그인이 자체 우회로를 발명하는 대신 DSH의 네이티브 `tools/pre-execute` approval 이음새를 거친다.

---

## 13. 선택적 의존성에서 성능 저하하기

`cordis.patch.yml`은 하드 의존성을 정확히 하나 선언한다: `tools` 레지스트리(`inject` 경유). 나머지는 전부 `ctx.get`으로 읽는다:

| 서비스 | 없을 때 |
|---|---|
| `jobs` | `ual_task`가 `kind:'background'`를 반환하고 사용 불가를 설명한다 |
| `fs` / `attachments` | 스크린샷이 텍스트 경로와 이유로 성능 저하한다 |
| `agents` | 에디터 연결/단절이 agent에게 알리지 않는다 |
| `approval` | `ask`가 DSH에 의해 거부로 바뀐다 |

이렇게 하면 서비스 하나를 생략한 구성이 **기능 하나를 잃을** 뿐, 로드에 실패하지 않는다.
