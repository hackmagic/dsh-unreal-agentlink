<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · **Deutsch** · [Español](README_es.md) · [Français](README_fr.md) · [Русский](README_ru.md)

# dsh-unreal-agentlink

### Ein DSH-Plugin, das Ihren Unreal-Editor unter Ihren Agenten stellt.

**Reine Brücke. Der Agent plant; dieses Plugin übersetzt nur.**

```
DSH agent  ──tool calls──►  dsh-unreal-agentlink  ◄──WebSocket──  Unreal Editor
(plans, decides)            (this plugin: server, translator)   editor dials out
```

[Installation](#installation) · [Voraussetzungen](#voraussetzungen) · [12 Werkzeuge](#12-werkzeuge) · [Konfiguration](#konfiguration) · [Dokumentation](#dokumentation)

<code>npm install &amp;&amp; npm run check</code>

</div>

---

Ihr Agent kann bereits Dateien lesen und Befehle ausführen. Dieses Plugin gibt ihm den Editor selbst: die Szene abfragen, Actors spawnen, Blueprints und Materialien bearbeiten, Sequenzen rendern, Screenshots machen, die er tatsächlich *sehen* kann, und seine eigene Arbeit zurückrollen, wenn etwas schiefgeht.

Es **plant keine** Aufgaben. Planen gehört zum nativen Agenten von DSH. Dieses Plugin ist ein Übersetzer mit einer Sicherheitsschicht — es verwandelt die Absicht des Agenten in UnrealAgentLink-Befehle und die Antworten des Editors zurück in etwas, mit dem ein Agent arbeiten kann.

---

## Voraussetzungen

| Item | Requirement |
|---|---|
| Unreal Engine | 5.0 – 5.8 |
| UnrealAgentLink | das C++-Plugin selbst, abgelegt im `Plugins/`-Verzeichnis Ihres Projekts |
| Node.js | `^22.19.0 \|\| >=24.0.0` |
| DSH runtime | dieses Plugin als Bundle installiert |

### Sie brauchen kein UEBox

Die UEBox-Desktop-App ist **keine Abhängigkeit**. Sie ist ein anderer Client desselben Herstellers, der zufällig ebenfalls Port 17860 verwendet, daher ist der gleichzeitige Betrieb beider ein Portkonflikt — das ist die gesamte Beziehung. Die Belege:

- `UnrealAgentLink.uplugin:25-34` deklariert genau zwei Abhängigkeiten, beide vom Engine-Lieferumfang: `IKRig` und `PythonScriptPlugin`. Kein uebox-Modul.
- Jeder Eintrag in `UnrealAgentLink.Build.cs` ist ein Engine-Modul (UnrealEd / AssetRegistry / MovieScene / Landscape …). Kein uebox-SDK.
- Der String `uebox` kommt in der gesamten Quelle dreimal vor, jedes Mal in einem `// Copyright uebox.ai`-Header.
- Nichts in der Quelle ruft uebox.ai auf. Die einzige Verwendung von `FHttpModule` liest die Proxy-Einstellungen des lokalen Rechners (`UAL_ProxyDiagnostics.cpp:167`).

Sobald das Plugin in Ihrem Projekt liegt, läuft es von selbst: `StartupModule` ruft `Init("ws://127.0.0.1:17860")` unbedingt auf (`Core/UnrealAgentLink.cpp:86-97`), schiebt `project.info` im Moment des Verbindens und hat weder Handshake, Token noch Authentifizierung.

> Um den Port zu ändern: `-UALServer=ws://127.0.0.1:17861` auf der Editorseite und die Einstellung `port` auf dieser Seite.

---

## Installation

Drei Teile: das UnrealAgentLink-C++-Plugin in Ihr UE-Projekt legen, dieses Plugin in DSH installieren und den Editor öffnen. Das ist alles — **kein UEBox, kein Token, kein Handshake**.

### Schritt 1 — UnrealAgentLink ins UE-Projekt installieren

1. Kopieren Sie das gesamte `UnrealAgentLink`-Verzeichnis in das `Plugins/`-Verzeichnis Ihres Projekts (oder in das `Plugins/`-Verzeichnis der Engine für eine globale Installation).
2. Projektdateien neu generieren und das Projekt öffnen.
3. Bestätigen Sie, dass UnrealAgentLink unter **Edit → Plugins** aktiviert ist. Es zieht zwei engine-eigene Abhängigkeiten, `IKRig` und `PythonScriptPlugin`, automatisch mit.

Von da an wählt der Editor von selbst hinaus: `StartupModule` ruft unbedingt `Init("ws://127.0.0.1:17860")` auf und wiederholt alle 5 Sekunden, deshalb **spielt die Startreihenfolge keine Rolle**.

> Port bereits belegt (zum Beispiel durch UEBox)? Geben Sie dem Editor einen anderen und passen Sie ihn auf dieser Seite an:
> `UnrealEditor.exe MyProject.uproject -UALServer=ws://127.0.0.1:17861`

### Schritt 2 — dieses Plugin in DSH installieren

```bash
git clone <this-repo> dsh-unreal-agentlink
cd dsh-unreal-agentlink
npm install
npm run check      # typecheck (src + tests) + 189 tests + catalog + doc reconciliation, one command
```

`npm run check` muss vollständig grün sein, bevor es weitergeht — es prüft, dass Quellen und Tests typechecken, die Verhaltenstests durchlaufen und der 170-Befehle-Katalog Eintrag für Eintrag zur C++-Registry passt.

Registrieren Sie es dann als DSH-Bundle. `package.json` deklariert `dsh.bundle.patch: ./cordis.patch.yml`, und diese Datei tut genau eine Sache:

```yaml
- insert:
    - id: unreal-agentlink
      name: dsh-unreal-agentlink
```

> **Konfigurationsschichtung**: Eine spätere Schicht **ersetzt** die `config` dieser Zeile vollständig, statt sie tief zusammenzuführen. Um etwas zu überschreiben, müssen Sie jeden Schlüssel, den Sie behalten wollen, neu schreiben.

DSH liefert keinen Befehl, der ein lokales Plugin außerhalb des Baumes installiert, daher liefert dieses Repository einen Installer, der die Arbeit macht und sich dann dem echten unterordnet:

```bash
npm run status:dsh -- --profile web     # was gerade registriert ist (dasselbe Skript, npm-Passthrough)
node scripts/install-dsh-plugin.mjs --profile web             # spiegeln, Manifest bearbeiten, installieren, prüfen
```

Er verweigert das Anfassen eines Manifests, das ein laufendes DSH noch hält, und beweist, dass die Schicht zusammengesetzt ist, bevor er Erfolg meldet: `dsh --profile <profile> --dump-config` muss `# == dsh-unreal-agentlink` enthalten, außer bei `desktop`, das die CLI nicht zusammensetzt — dort wird die Schicht über `dsh plugin --profile desktop list` nachgewiesen, was denselben Paketgraphen liest. Stoppt die Peer-Dependency-Wache die Installation, gibt er den genauen Befehl aus, um das Risiko zu akzeptieren — **diese Entscheidung ist Ihre, nicht die des Skripts**.

Zwei weitere Wege, beide ausformuliert: die [manuelle Installation](#manuelle-installation-ohne-das-skript) unten und [INSTALL-ai.md](../de/INSTALL-ai.md) — eine Version, die ein KI-Agent lesen und Schritt für Schritt befolgen kann.
### Schritt 3 — Projekt öffnen und prüfen

Öffnen Sie das UE-Projekt, lassen Sie dann den Agenten `ual_status` aufrufen und prüfen Sie drei Felder:

```
listening: true
url: ws://127.0.0.1:17860
editors: [ { sessionId: "ue-xxxxxxxx", project: "MyProject", ... } ]
```

- `listening: false` → das Plugin ist nicht gestartet, oder der Port ist belegt. Suchen Sie im DSH-Log nach `EADDRINUSE`.
- `listening: true` aber `editors: []` → die Brücke wartet. Bestätigen Sie, dass das UE-Projekt offen und UnrealAgentLink aktiviert ist.

Für den **ersten Moment**, nachdem ein Editor verbunden hat, enthält sein Eintrag nur `sessionId` / `connectedAt` / `lastSeenAt` / `heartbeats` / `stale`; Felder wie `project` erscheinen erst, sobald der Editor `project.info` schiebt. Das ist ein normaler Zustand, kein Fehler.

Versuchen Sie dann einen reinen Leseaufruf ohne Seiteneffekte:

```
ual_call { method: "level.get_current" }
```

**Der vollständige Weg — Arbeitsabläufe, Fehler lesen, Fehlerbehebung — steht im [Tutorial](../de/01-tutorial.md).**

### Manuelle Installation ohne das Skript

Das Skript oben ist eine Bequemlichkeit; der zugrunde liegende Mechanismus ist vier Zeilen Manifest plus ein Produktbefehl. Dabei ist `<profile>` gleich `web` — `desktop` funktioniert ebenfalls, mit der einen Ersetzung, die am Ende dieses Abschnitts genannt wird — und `$DSH_HOME` ist standardmäßig `~/.dsh`:

```bash
# 1. einmal bauen, dann nur das kopieren, was npm pack ausliefert
npm run build
cp -r lib cordis.patch.yml package.json LICENSE README.md \
      "$DSH_HOME/profiles/<profile>/.vendor/"

# 2. die Abhängigkeit und die Bundle-Schicht registrieren (beide sind nötig)
"$DSH_HOME/profiles/<profile>/package.json"    # die zwei unten gezeigten Einträge hinzufügen

# 3. den echten Installer laufen lassen
dsh plugin --profile <profile> install

# 4. beweisen, dass die Schicht zusammengesetzt ist
dsh --profile <profile> --dump-config | grep -A2 '# == dsh-unreal-agentlink'
```

Schritt 4 ist der einzige Schritt, den `desktop` nicht ausführen kann: Die CLI weigert sich, dieses Profil von der Kommandozeile aus zu starten, daher weisen Sie es stattdessen mit `dsh plugin --profile desktop list` nach (siehe unten).

Die zwei Einträge, in `<profile>/package.json`:

```json
"dependencies": { "dsh-unreal-agentlink": "file:C:/Users/you/.dsh/profiles/web/.vendor" },
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-unreal-agentlink"] } }
```

Beide sind verpflichtend, und sie scheitern unterschiedlich: ein aufgelistetes Paket, das kein `dsh.bundle` deklariert, scheitert beim Start **laut**, während ein installiertes Paket, das nicht aufgelistet ist, **überhaupt keine Schicht** beisteuert und in `--dump-config` nichts erscheint.

**Warum `file:` auf eine Kopie zeigt und nicht auf Ihren Arbeitsbereich**: pnpm kopiert, was es zum Installationszeitpunkt vorfindet, also wird eine halb gespeicherte Quelldatei — oder ein gelöschtes `lib/` nach einem gescheiterten Build — zu dem Plugin, das DSH lädt. Zuerst spiegeln, dann installieren.

**Das Profil `desktop` ist ein unterstütztes Ziel, mit einer CLI-Lücke.** `dsh --profile desktop …` wird rundweg abgewiesen (`bin.js:112`, `rejectElectronProfile`), weil die Electron-App die Lebensdauer dieses Profils besitzt — doch die Wache wird für `dsh plugin` bewusst übersprungen (`bin.js:119`), und die von Desktop mitgelieferte CLI, die die App selbst aufruft, hängt genau davon ab (`dsh-desktop-host/lib/cli.js:91-104` übergibt `manageDesktopProfile: true`). Installieren Sie also wie oben gezeigt in `desktop`, mit zwei Änderungen: Schritt 4 wird `dsh plugin --profile desktop list`, und die App muss vorher vollständig beendet werden. Die Meldung des Produkts selbst sagt das ausdrücklich — *„Öffnen Sie DeepSeek Harness Desktop einmal, um sein Profil zu initialisieren, und beenden Sie es dann vollständig, bevor Sie `dsh plugin --profile desktop` ausführen"* —, weil eine laufende App das Manifest aus ihrer speicherinternen Plugin-Liste neu schreibt, sodass eine darunter vorgenommene Änderung verloren gehen kann. Starten Sie Desktop danach, um die Schicht einzubinden.

---

## Dokumentation

| Document | Contents |
|---|---|
| [Tutorial](../de/01-tutorial.md) | End-to-End: Plugin installieren, verbinden, häufige Arbeitsabläufe, Fehlerbehebung |
| [Protokollreferenz](../de/02-protocol.md) | Nachrichtenformen, Ereignisse, die 13 Statuscodes, Serialisierungsregeln, Timeout- und Nebenläufigkeitssemantik |
| [Architektur](../de/03-architecture.md) | Die Gate-Kette, Sitzungsisolierung und Rollback, Fehlerübersetzung, Verifikationsstrategie, die Fallen, auf die wir gestoßen sind |
| [Befehlsreferenz](../de/command-reference.md) | Params / required keys / result keys / status codes für alle 170 Befehle (**generiert**) |
| [Installationsanleitung (KI-lesbar)](../de/INSTALL-ai.md) | Die Installationsprozedur, geschrieben damit ein KI-Agent sie liest und ausführt, mit den Prüfungen, die er vorher und nachher laufen lassen muss |

Alle fünf gibt es in jeder oben in dieser Datei genannten Sprache, unter `docs/<lang>/` — `en` (kanonisch, direkt unter `docs/`), `zh`, `zh-TW`, `ja`, `ko`, `de`, `es`, `fr`, `ru`.

---

## Vier Fakten zuerst

Dies sind keine Designentscheidungen. Es sind bestehende UnrealAgentLink-Einschränkungen, und sie bestimmen, wie jede Operation geschrieben wird.

1. **Die Richtung ist umgekehrt.** Dieses Plugin wählt den Editor nicht — **der Editor wählt hinaus**. Die Startreihenfolge spielt keine Rolle: Öffnen Sie den Editor zuerst, und er wiederholt alle 5 Sekunden, bis das Plugin erscheint.
2. **Es gibt keine Authentifizierung.** Kein Token, kein Header, kein Subprotokoll. **Der Port ist die Berechtigung**, daher bindet er standardmäßig nur Loopback. Ändern Sie ihn nicht auf `0.0.0.0`.
3. **Befehle laufen seriell auf dem Game-Thread.** Und während ein blockierender Befehl läuft, **antwortet der Editor auf nichts** — nicht einmal auf eine Fortschrittsabfrage wie `sequence.render_status`.
4. **Es gibt kein Abbrechen.** `query_task` und `cancel_task` existieren nicht. Das Beenden eines `ual_task`-Jobs stoppt nur das Warten dieses Plugins; die Engine macht weiter und das Ergebnis kommt trotzdem zurück.

---

## 12 Werkzeuge

Würde man 170 Befehle als 170 Werkzeuge bereitstellen, kostete das in jedem Request einen großen Teil des Prompts für Fähigkeiten, die eine bestimmte Aufgabe nie berührt. Fähigkeiten zu entdecken ist daher zwei Schritte, nicht null:

| Tool | Purpose |
|---|---|
| `ual_status` | Editor-Verbindungen / Breaker / Rate-Limit / Sitzung / verwaiste Befehle. **Lesen Sie das zuerst, wenn etwas nicht stimmt** |
| `ual_tools` | Alle 170 Befehle auflisten (22 Familien), filterbar nach Familie oder Stichwort |
| `ual_schema` | Die **exakten Schlüsselnamen** für einen Befehl — vor dem Aufruf prüfen; UE ignoriert unbekannte Schlüssel stillschweigend |
| `ual_call` | Einen Befehl ausführen, das Ergebnis des Editors wörtlich zurückgeben |
| `ual_batch` | Mehrere Befehle in einem Round Trip (begrenzt durch `maxBatchCalls`; ein gefährlicher Eintrag schickt den ganzen Batch durch die Freigabe) |
| `ual_screenshot` | Ein **echtes Bild** aufnehmen und zurückgeben, das der Agent sehen kann |
| `ual_logs` | Den lokalen Log-Ring lesen (UE-seitige Weiterleitung ist standardmäßig aus — siehe Tutorial) |
| `ual_undo` / `ual_undo_history` | Rollback pro Sitzung / den Undo-Puffer inspizieren |
| `ual_locks` | Asset-Sperren beanspruchen; der Editor zeichnet ein „KI bearbeitet"-Abzeichen |
| `ual_editor_bind` | Eine Sitzung an einen Editor binden, wenn mehrere verbunden sind |
| `ual_task` | Einen langen blockierenden Befehl in einen echten Hintergrundjob verwandeln, damit das Gespräch weitergeht |

### Risikostufen

read 65 / write 89 / **destructive 2 / dangerous 14** (die letzten 16 gehen durch die Freigabe).

`tools/pre-execute` gibt `{kind:'ask'}` für destruktive und gefährliche Methoden zurück (einschließlich jedes gefährlichen Eintrags in einem `ual_batch`) und überlässt die Entscheidung der Sitzungsrichtlinie. **Eine nicht registrierte Methode wird rundweg verweigert** und erreicht den Editor nie.

Beachten Sie, dass unter der Richtlinie `never` ein `ask` automatisch abgelehnt wird — das ist die korrekte Lesart von „unbeaufsichtigte Sitzungen dürfen den Editor nicht anfassen".

---

## Konfiguration

Die Standardwerte sind „lebendig, aber faul". Die vollständige Tabelle mit Begründung steht in [Tutorial §7](../de/01-tutorial.md#7-konfiguration).

| Key | Default | Meaning |
|---|---|---|
| `host` / `port` | `127.0.0.1` / `17860` | Auf Loopback halten: ohne Auth bedeutet Zugang zum Port, den Editor zu steuern |
| `timeoutMs` | `180000` | Blockierende Befehle heben ihre eigenen Untergrenzen |
| `cacheTtlMs` / `cacheMaxEntries` | `2000` / `128` | Lese-Cache pro Sitzung |
| `rateLimitRps` / `rateLimitQueue` | `5` / `32` | Befehle pro Sekunde / Warteschlangen-Cap (0 deaktiviert das Rate-Limit) |
| `breakerThreshold` / `breakerCooldownMs` | `3` / `30000` | Aufeinanderfolgende Transportfehler zum Öffnen / Cooldown |
| `logCapacity` / `logMinLevel` | `512` / `Display` | Log-Ring |
| `logForwardingEnabled` | `false` | Nur auf `true` setzen, nachdem `ual.ForwardLogs` im Editor ausgeführt wurde |
| `rollbackOnDispose` | `false` | Nur ein LIFO-Suffix ist exakt — siehe Architekturdokument |
| `notifyOnEditorChange` | `true` | Eine Zeile in den Agenten einfügen, wenn ein Editor verbindet oder trennt |
| `screenshotAttachments` / `screenshotMaxBytes` | `true` / 12MB | Bild-Blöcke / Größen-Cap |
| `maxBatchCalls` | `12` | Cap pro `ual_batch` |

---

## Entwicklung

```bash
npm run build       # tsc → lib/
npm run dev         # tsc --watch
npm run check       # typecheck + tests + catalog reconciliation (run before committing)
npm test            # tests only
npm run typecheck   # src and tests typechecked separately
```

### Quellcode-Layout

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
scripts/                    Catalog extraction and reconciliation, doc generation and normalization,
                              the language set, and the DSH profile installer
docs/                       Tutorial / protocol / architecture / command reference / install guide,
                              in 9 languages
tests/                      189 tests
```

### Generierte Dateien: nicht von Hand bearbeiten

`src/catalog/method-data.ts` und `docs/command-reference.md` sind beide **generiert**:

```bash
node scripts/extract-methods.mjs .ua-ref/plugin/UnrealAgentLink/Source   # rebuild the catalog from C++
npm run build && node scripts/gen-docs.mjs                             # rebuild the command reference (all 9 languages)
```

Eine handgepflegte Tabelle, die niemand importiert, ist eine wiederkehrende Defektklasse in diesem Projekt (`REQUIRED_KEYS`, `EXTRA_PARAM_KEYS` und `UAL_CODES` sind alle darüber aufgefallen). Die Gegenmaßnahme ist, jede Prüfung **die Quelle fragen** zu lassen statt die Tabelle — siehe [Architektur §9](../de/03-architecture.md#9-generierte-dateien-und-tabellen-die-niemand-importiert).

### Tests und Prüfungen

```bash
npm run check                       # typecheck (src + tests) + 189 passed + catalog + doc reconciliation
npm test                            # 189 passed
node scripts/check-catalog.mjs      # 170/170 zero drift; every requires key appears in C++; code set matches C++
node scripts/gen-docs.mjs --check   # is the command reference up to date in all 9 languages
node scripts/normalize-doc-headers.mjs --check   # are the language bars canonical in all 54 files
node scripts/normalize-doc-links.mjs --check     # do the body links resolve from where they sit
npm run docs                        # regenerate + rewrite the 54 doc headers and links
npm run install:dsh -- --profile web    # register this plugin with a dsh profile (see Installation)
```

Die zehn Testdateien sind nach **der Art des Defekts, den sie finden können** aufgeteilt, jede aus einem Grund — siehe [Architektur §11](../de/03-architecture.md#11-verifikationsstrategie).

`requires` ist nicht handgeschrieben: Es wird aus den eigenen `SendError(..., 400, "Missing field: X")`-Meldungen der Handler abgeleitet (28 Stellen), weil ein falscher Pflichtschlüssel die Brücke einen *gültigen* Aufruf ablehnen lässt, bevor die Engine ihn sieht. Das Ergebnis landet in `method-data.ts` als `REQUIRED_KEYS`, und `requiresOf()` aus `methods.ts` führt es zur Laufzeit zusammen (die frühe Ablehnung in `service.call()`, die `REQUIRED:`-Zeile in `ual_schema` und die Fehlerhinweise laufen alle über diese eine Funktion).

Es **verengt absichtlich nur, erweitert nie**: Eine Meldung, die `or` enthält (`"Missing field: name or path"`), wird vollständig übersprungen, und aus einer im selben File aufgerufenen Funktion geerntete Schlüssel werden als zweig-lokal fallengelassen — siehe `REQUIRED_DROPPED` in `scripts/extract-methods.mjs`, wo jeder Eintrag seine C++-Zeilennummer nennt. „Keine Schlüssel geerntet" ist also der sichere Standard, keine verpasste Prüfung.

### Testen ohne Unreal Engine

Sie brauchen weder einen Editor noch UEBox, um dieses Plugin laufen zu lassen — und die Naht ist das Protokoll selbst: UEBox wählt sich **hinaus** zu dieser Brücke, ein Fake-Editor ist also nur ein WebSocket-Client, der antwortet.

```bash
npm run smoke                        # den echten Dienst starten, einen Fake-Editor einwählen,
                                     # alle 12 Werkzeuge aufrufen, jedes Ergebnis validieren
npm run smoke -- --out /tmp/ual      # Transkript und PNGs woanders ablegen
npm run smoke -- --method actor.get  # eine einzelne Katalogmethode, roh ausgegeben
npm run mock:ue                      # nur der Fake-Editor, zum manuellen Herumstochern
```

`tools/mock-ue-editor.mjs` ist ein echter Prozess, kein Stub: Er wählt `ws://127.0.0.1:17860`, schiebt `project.info` und `system.heartbeat`, leitet `log.entry`-Zeilen weiter, schreibt ein echtes PNG für `editor.screenshot` und beantwortet **alle 170 katalogisierten Methoden** — mit realistischen Bodies für die Familien, auf die es ankommt, und einem Body mit den dokumentierten Ergebnisschlüsseln für den Rest. `tools/ual-smoke.mjs` startet denselben `UalService`, den `apply()` startet, ruft jedes Werkzeug über sein echtes `execute` auf, validiert jeden Wert gegen das Ausgabeschema dieses Werkzeugs und gibt aus, was das Modell gesehen hätte. Es ist der manuelle Zwilling von `tests/mock-editor.test.ts`; beide sind in [Architektur §11](../de/03-architecture.md#11-verifikationsstrategie) beschrieben.

---

## Protokoll-Grundlagen

```
UE → plugin:  { ver:"1.0", type:"req",  method, id, params }     // id is generated by the server
plugin → UE:  { ver:"1.0", type:"res",  id, code, result }        // the key is omitted when empty
UE → plugin:  { ver,       type:"evt", method, payload }
```

- Ein Fehler wird **allein über `code`** ausgedrückt. Es gibt kein `error`-Feld auf Umschlag-Ebene.
- Menschenlesbarer Text steht in `result.message` (Chinesisch oder Englisch je nach Editor-Kultur — **nicht parsen**); maschinenlesbare Details stehen in `result.details`.
- **Viele Handler geben `200` mit `result.ok === false` zurück** (`editor.undo`, `blueprint.compile`, `pie.observe`), daher beurteilt das Plugin den Erfolg mit `judge()`, nicht allein über den Code. Es gibt 55 Stellen mit `SetStringField(TEXT("error"), ...)` über 14 C++-Dateien verteilt — das ist die Norm, keine Anomalie.
- `content.import_folder` / `content.import_assets` sind **Fire-and-Forget-Pushes** nach außen: kein `id`, keine erwartete Antwort. Das Plugin verwandelt sie in Logs und Agent-Benachrichtigungen und **erfindet kein `res`** — mit `ok:false` zu antworten würde dem Nutzer nur einen falschen „Import fehlgeschlagen"-Dialog zeigen, was schlimmer ist als Stille.

Die vollständigen Details (alle 13 Statuscodes, Serialisierungsregeln, Timeout-Semantik) stehen in der [Protokollreferenz](../de/02-protocol.md).

---

## Lizenz

MIT
