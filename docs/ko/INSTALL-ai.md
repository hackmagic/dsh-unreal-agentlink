<div align="center">

[English](../INSTALL-ai.md) · [简体中文](../zh/INSTALL-ai.md) · [繁體中文](../zh-TW/INSTALL-ai.md) · [日本語](../ja/INSTALL-ai.md) · **한국어** · [Deutsch](../de/INSTALL-ai.md) · [Español](../es/INSTALL-ai.md) · [Français](../fr/INSTALL-ai.md) · [Русский](../ru/INSTALL-ai.md)

[README](../readme/README_ko.md) · [튜토리얼](01-tutorial.md) · [프로토콜](02-protocol.md) · [아키텍처](03-architecture.md) · [명령 참조](command-reference.md) · **설치 가이드**

</div>

# 설치 가이드 (AI 가독)

이 파일은 파일을 읽고 단계를 순서대로 실행하는 AI 어시스턴트를 위해 쓰였습니다.
단계를 건너뛰지 마세요; 모든 단계에는 검증 가능한 결과가 있습니다. 사람이 설치하는
경우에는 [README](../readme/README_ko.md) 또는 [튜토리얼](01-tutorial.md)을 보세요.

> AI는 `scripts/install-dsh-plugin.mjs`를 실행하기만 하면 됩니다. 이 스크립트가 전부
> 합니다: 미러 만들기 → 프로파일 manifest 편집 → 실제 설치기 호출 → 합성된 결과 검증.
> 아래 각 단계는 **검증점**입니다: 단계가 맞지 않으면 멈추고 보고하세요. 계속하지
> 마세요.

---

## 0. 먼저 확인하기 (읽기 전용, 아무것도 설치하지 않음)

```bash
node scripts/install-dsh-plugin.mjs --profile web --status
```

`installed copy:` 와 `bundle layer:` 가 `present` / `listed` 로 읽혀야 합니다. 둘이
`(absent)` / `(not listed)` 로 읽힐 때만 설치를 실행해야 합니다.

그런 다음 UnrealAgentLink 쪽을 확인합니다:

- 프로젝트에 `Plugins/UnrealAgentLink/` 가 존재하고, `Edit → Plugins` 에서 활성화되어
  있어야 합니다(에디터 재시작이 필요합니다).
- 17860 포트가 비어 있어야 합니다(`uebox` 데스크톱이 같은 포트를 차지합니다; 이
  플러그인은 그것을 필요로 하지 않습니다).

---

## 1. 설치 (한 줄 명령)

```bash
npm run build && node scripts/install-dsh-plugin.mjs --profile web --yes
```

이 스크립트는 다섯 가지 동작을 수행하며, 각각 증거를 남깁니다:

| 단계 | 산출물 | 실패했을 때의 의미 |
| --- | --- | --- |
| build | `lib/`, 64 files | 먼저 `npm run check` 를 실행; 깨진 빌드를 설치하지 말 것 |
| mirror | `<profile>/.vendor/` — `files` 항목만 포함 | 디스크 또는 권한 문제 |
| manifest edit | `<profile>/package.json` 에 dependency 한 줄 + bundle 한 줄 추가 | 아래 4번 참조 |
| installer | pnpm 이 `Done in Xs` 를 출력 | 아래 2번 참조 |
| verify | `install: ... is now a bundle layer of profile "web"` | 아래 3번 참조 |

**설치가 성공했다는 뜻은 마지막 줄뿐입니다.** 앞의 네 단계가 통과하고 다섯 번째가
실패하면, 레이어가 합성되지 않은 것이며 dsh 는 이 플러그인을 로드하지 않습니다.

---

## 2. 설치기가 거부할 때 (버전 가드)

dsh 에는 제품 차원의 가드가 있습니다: 플러그인의 `peerDependencies` 가 런타임의 dsh
버전과 맞지 않으면 설치가 거부됩니다. 이 프로젝트는 `@deepseek-ai/*` 를
`0.1.6-alpha.2` 로 고정하는데 배포되는 dsh 는 `0.2.0-rc.2` 이므로, 설치는 여기서
멈춥니다.

**그것은 제품의 결정이며, 스크립트는 의도적으로 대신 결정하지 않습니다.** 스크립트는
정확한 명령을 출력합니다:

```bash
dsh plugin --profile web allow-version dsh-unreal-agentlink@0.1.0 --dsh-version 0.2.0-rc.2 --accept-risk
```

이것을 실행하려면 사람의 확인이 필요합니다. 그런 다음 1번의 설치를 다시 실행하세요.

> `--status` 는 `version guard:` 줄에 그 예외가 이미 활성 상태인지 보여줍니다.

---

## 3. 검증 단계가 실패할 때 (레이어가 합성되지 않음)

```bash
dsh --profile web --dump-config | grep unreal-agentlink
```

이것은 반드시 다음을 출력해야 합니다:

```
# == dsh-unreal-agentlink
- id: unreal-agentlink
  name: dsh-unreal-agentlink
```

출력되지 않을 때 알려진 원인 세 가지:

1. `dsh.profile.bundles` 에 이 플러그인이 없음 — 스크립트가 추가했어야 합니다;
   `<profile>/package.json` 을 확인하세요.
2. 패키지는 `node_modules` 에 있으나 `dsh.bundle` 을 선언하지 않음 — 이것은 로드
   시점에 **크게** 실패합니다(`declares no dsh.bundle in its package.json`); 미러된
   `package.json` 을 확인하세요.
3. `--dump-config` 자체가 오류남 — 전체 출력을 원문 그대로 보고하고, 추측하지 마세요.

---

## 4. manifest 수정이 락에 막혔을 때

```
install: <path>/package.json.lock is held by pid 18344 (DeepSeek Harness)
```

dsh 는 프로파일 manifest 를 `wx` 로 생성한 `.lock` 형제 파일로 보호하며, **경쟁자는
다른 소유자의 락을 절대 지우지 않습니다**. 소유자는 실행 중인 dsh 애플리케이션
자체입니다.

- `web` 프로파일: 실행 중인 DeepSeek Harness 데스크톱 앱을 닫거나, 잡혀 있지 않은
  프로파일을 고르세요.
- `desktop` 프로파일: CLI 의 *부팅* 명령은 **금지**됩니다(`bin.js:112`
  `rejectElectronProfile`), 하지만 `dsh plugin --profile desktop …` 은 의도적으로
  예외입니다(`bin.js:119`) — 앱 자체가 호출하는 Desktop 내장 CLI 가 쓰는 경로입니다.
  제품은 앱을 먼저 완전히 종료할 것을 요구합니다. 실행 중인 앱은 자체 플러그인
  목록에서 manifest 를 다시 쓰기 때문입니다. 앱을 종료하고 설치를 실행한 뒤, 이후
  Desktop 을 실행하면 레이어가 마운트됩니다.
- 스크립트는 거부하고 소유자를 알려줍니다; 락을 억지로 풀지 않습니다.

---

## 5. 플러그인이 실제로 동작하는지 확인하기 (설치됐다고 해서 끝이 아닙니다)

```bash
# a) 에디터 쪽: 프로젝트를 엽니다. UE 로그에 연결이 보여야 합니다.
#    (UnrealAgentLink 은 5초마다 재시도합니다; 수동 연결은 필요 없습니다.)

# b) DSH 쪽: 세션에서 에이전트에게 "ual_status 로 에디터를 확인해" 라고 시키세요.
```

세 `ual_status` 필드가 인수 기준입니다:

| 필드 | 기대값 |
| --- | --- |
| `listening` | `true` |
| `editors` | `project` 이름을 가진 것이 하나 이상 |
| `orphanedMethods` | `[]` |

`listening: false` = 아무것도 듣고 있지 않음(플러그인이 로드되지 않았거나 포트가
쓰임). `editors: []` = UE 가 연결하지 않음(프로젝트가 닫혀 있거나, 플러그인이
꺼져 있거나, 포트가 다름). `orphanedMethods` 가 비어 있지 않으면 = 요청이 시간
초과했지만 아직 실행 중일 수 있음; 재시도하기 전에 `ual_logs` 를 확인하세요.

그런 다음 최소 호출 하나로 전체 경로를 확인합니다:

```bash
# in a session: ual_call { "method": "level.get_current" }
```

---

## 6. 제거

```bash
node scripts/install-dsh-plugin.mjs --profile web --remove --yes
```

이 스크립트는 dependency 항목과 bundle 항목을 모두 떼어낸 뒤, pnpm 이
`node_modules` 를 동기화하도록 실제 설치기를 실행합니다. 미러 디렉터리
`<profile>/.vendor` 는 유지되고 다음 설치에서 다시 만들어집니다; 완전히 지우려면
손으로 삭제하세요.

---

## AI를 위한 하드 규칙

1. 설치를 통과시키려고 이 프로젝트의 `peerDependencies` 를 편집**하지 마세요** —
   그것은 실제 버전 불일치를 가리는 행위입니다.
2. `<profile>/package.json` 을 손으로 편집**하지 마세요**; 스크립트가 그것을 하고
   락도 확인합니다.
3. `--accept-risk` 를 자동으로 실행 가능한 것으로 취급**하지 마세요**; 사람의 확인이
   필요합니다.
4. 어떤 단계의 출력이라도 설명과 다르면, **멈추고 출력을 원문 그대로 보고**하세요;
   "고쳐 보고 다시 실행"하지 마세요.
5. 여기의 모든 단계는 읽기 전용 명령(`--status`, `--dump-config`, `ual_status`)으로
   다시 검증할 수 있습니다.
