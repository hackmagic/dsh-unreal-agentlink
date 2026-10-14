<div align="center">

[English](../03-architecture.md) · [简体中文](../zh/03-architecture.md) · [繁體中文](../zh-TW/03-architecture.md) · [日本語](../ja/03-architecture.md) · [한국어](../ko/03-architecture.md) · **Deutsch** · [Español](../es/03-architecture.md) · [Français](../fr/03-architecture.md) · [Русский](../ru/03-architecture.md)

[README](../readme/README_de.md) · [Tutorial](01-tutorial.md) · [Protokoll](02-protocol.md) · **Architektur** · [Befehlsreferenz](command-reference.md)

</div>

# Architektur

Dieses Plugin ist eine **reine Brücke**: Es plant keine Aufgaben und entscheidet nicht, was zu tun ist. Es übersetzt die Absicht eines DSH-Agenten in UnrealAgentLink-Befehle und die Antworten des Editors zurück in eine Form, mit der ein Agent arbeiten kann. Planen gehört zum Agenten von DSH, nicht hierher.

Dieser Abschnitt erklärt, warum der Code so aussieht, wie er aussieht.

---

## 1. Modulkarte

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
```

### Abhängigkeitsrichtung

```
index.ts ──► service.ts ──► protocol/bridge.ts
    │            │
    │            ├──► catalog/methods.ts ──► catalog/method-data.ts
    │            ├──► resilience/breaker.ts
    │            ├──► sessions/state.ts
    │            └──► errors/translate.ts
    └──► tools/* ──► service.ts
```

Es gibt keine Rückwärtsabhängigkeiten. `tools/` hängt nur von `service` ab, und `service` hängt von keinem Werkzeug ab.

---

## 2. Die Gate-Kette: `service.call()`

**Jeder** Befehl läuft über diesen einen Einstiegspunkt (`src/service.ts:190-332`), in fester Reihenfolge:

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

Der Wert der ersten beiden Schritte ist, dass sie **ablehnen, bevor die Engine den Aufruf überhaupt sieht**. UE ignoriert unbekannte Schlüssel stillschweigend, ein falsch geschriebener Schlüsselname lässt einen Aufruf also „gelingen", ohne etwas zu tun — weit schwerer zu debuggen als ein Fehler.

`call()` **wirft nie**. Jeder Fehler kommt als `ok: false` innerhalb von `CallOutcome.value` zurück. Das ist absichtlich: Jeder Zweig der Werkzeugschicht muss ein strukturiertes Ergebnis rendern, statt jeder sein eigenes try/catch zu machen.

### Warum die ersten zwei Schritte „Katalog" und nicht „Risikotabelle" sein müssen

`riskOf()` gibt für eine **unbekannte** Methode `'dangerous'` zurück (eine konservative Vorgabe). Eine frühere Version nutzte das, um abzuleiten, „existiert diese Methode", was:

- fünf Methoden fälschlich ablehnte, die es wirklich gibt (`level.new`, `level.open`, `level.save`, `content.migrate`, `blueprint.import_t3d`)
- während jeder erfundene `editor.*`-Name durchgelassen wurde

Die Frage ist jetzt `isKnown()` (ein Katalog-Nachschlagen), nicht `riskOf()`. **Existenz ist eine Katalogfrage, keine Risikofrage.**

---

## 3. Sitzungsisolierung und Rollback

### Das Problem

UnrealAgentLink pflegt **einen Agent-Undo-Stack pro Editor**, geteilt von jeder DSH-Sitzung. Auf der DSH-Seite können mehrere Sitzungen denselben Editor gleichzeitig steuern.

„Mach rückgängig, was meine Sitzung getan hat" ist daher keine Operation, die das Protokoll unterstützt.

### Der Ansatz

`src/sessions/state.ts` zeichnet jeden Schritt auf, den jede Sitzung gemacht hat, und gibt jeder eine **global steigende Nummer** (`global`). Vor dem Zurückrollen prüft es, ob die Schritte dieser Sitzung ein **sauberes LIFO-Suffix** des Puffers dieses Editors bilden — das heißt, ob der letzte Schritt dieser Sitzung später ist als der letzte Schritt jeder anderen Sitzung.

```
yes  → roll back, undoing only this session's steps
no   → undo nothing, and report both step lists
```

Besser ablehnen, als fremde Arbeit stillschweigend zu verwerfen.

### `rollbackOnDispose` ist standardmäßig `false`

Beim Dispose einer Sitzung automatisch zurückzurollen klingt bequem, aber **der Nutzer hat das nie verlangt**. Es ist standardmäßig aus; es einzuschalten ist eine ausdrückliche Aussage: „das Ende der Sitzung soll ihre Arbeit rückgängig machen".

---

## 4. Fehlerübersetzung: warum der Text nicht gelesen wird

Der Fehlertext wechselt mit der Editor-Kultur zwischen Chinesisch und Englisch (`result.message`). Ihn zu parsen würde das Plugin an eine Sprache binden, und der Text kann sich jederzeit ändern.

`src/errors/translate.ts` klassifiziert nur nach **Fehler-Klassenname** (`NoEditorError`, `BridgeTimeoutError`, …) und **Statuscode**, in 16 Arten, und gibt zu jeder einen Hinweis, was als Nächstes zu tun ist.

Die Reihenfolge ist: Klassenname zuerst, dann Statuscode. Unter den Statuscodes bildet `410` auf `not-found`, `422` auf `precondition` und `504` auf `timeout` ab — keine dieser Abbildungen ist offensichtlich, weshalb Prüfung 4 von `scripts/check-catalog.mjs` die C++-Quelle abfragt, um vollständige Abdeckung zu garantieren.

**Warum eine fehlende Klassifikation schädlich ist**: Der Rückfall `engine-error` sagt „die Parameter sind in Ordnung, der Editor selbst ist kaputt". Ein nicht klassifizierter Code zeigt dem Modell also in genau die falsche Richtung. Das deutlichste Beispiel ist `422` — es heißt wirklich „die Eingabe war gültig, aber es wurde nichts geschrieben", was nichts mit „der Editor ist kaputt" zu tun hat.

---

## 5. Circuit Breaker und Rate Limiter

### Der Breaker schützt den Editor

`src/resilience/breaker.ts`. Die Schlüsselentscheidung: **4xx wird als `input` aufgezeichnet und öffnet den Breaker nicht.**

Die Begründung: Ein Agent, der zehn schlechte Aufrufe hintereinander macht, **arbeitet**, er bringt den Editor nicht um. Nur wiederholte **Transport**fehler bedeuten, dass der Editor selbst in Schwierigkeiten ist.

### Der Rate Limiter hat einen echten Fehler behoben

Der Sliding-Window-Limiter ließ ursprünglich den **ersten eingereihten Aufrufer sofort durch** — damit ging der zweite Aufruf in einem Burst augenblicklich durch und das Limit bewirkte nichts. Die Korrektur steht in `breaker.ts:schedule()`: Die erste Freigabe wartet das restliche Intervall ab, statt sofort zu feuern.

---

## 6. Der Log-Ring

Der Editor schiebt `log.entry` (erfordert `ual.ForwardLogs 1` im Editor, was dieses Plugin nicht aus der Ferne einschalten kann).

`bridge.ts` hält einen Ring der Kapazität 512: gefiltert nach Mindestlevel (Standard `Display`), nach Schwere geordnet, über `sinceSeq` paginiert, mit case-insensitiver Filterung nach Kategorie und Text.

**Warum lokal**: Jede Log-Zeile direkt an das Modell weiterzuleiten würde seinen Kontext ertränken. Ein Ring plus Filterung lässt den Agenten holen, was er braucht, statt ihm alles zuzuschieben.

---

## 7. Lange Arbeit: `ual_task`

Das Protokoll hat **keine Abbruch-Semantik**. `ual_task` wickelt einen langen Aufruf in einen echten DSH-Job (kind `ual`), damit das Gespräch weitergehen kann.

Zwei Dinge müssen in die Werkzeugbeschreibung geschrieben werden, oder das Modell wird es sicher missverstehen:

1. **Das Beenden des Jobs stoppt nur das Warten dieses Plugins.** Die Engine läuft weiter und das Ergebnis kommt trotzdem zurück.
2. **Während ein blockierender Befehl läuft, antwortet der Editor auf nichts** — nicht einmal auf `sequence.render_status`. Also nicht pollen, während eine lange Aufgabe läuft.

---

## 8. Die Werkzeugoberfläche: 12, nicht 170

Wäre jeder der 170 Befehle ein eigenes Werkzeug, würden 170 Schemas den Prompt jeder Anfrage auffressen — und die überwältigende Mehrheit der Anfragen nutzt keinen davon.

Daher:

- `ual_tools` listet Fähigkeiten (filterbar nach Familie oder Stichwort)
- `ual_schema` gibt die exakten Schlüsselnamen für einen Befehl
- `ual_call` führt aus

**Fähigkeiten zu entdecken kostet zwei Schritte, nicht null.** Das ist ein absichtlicher Kompromiss: ein zusätzlicher Round Trip gegen 170 weniger Schemas pro Anfrage.

---

## 9. Generierte Dateien und „Tabellen, die niemand importiert"

Eine Defektklasse kehrt in diesem Projekt wieder und verdient eine eigene Notiz: **Eine handgepflegte Tabelle wird gebaut, aber niemand importiert sie.**

Beispiele bisher:

| Table | Symptom |
|---|---|
| `REQUIRED_KEYS` | Pflichtschlüssel-Validierung war toter Code, und `ual_schema` zeigte nie `REQUIRED:` |
| `EXTRA_PARAM_KEYS` | die 4 `PARAMS_UNRESOLVED`-Methoden hatten leere Parameterlisten |
| `UAL_CODES` | `410` / `422` / `504` waren nicht klassifiziert und fielen auf den irreführenden `engine-error` zurück |

Der gemeinsame Faden: Die Tabelle selbst war korrekt, dokumentiert und reviewed — aber die Laufzeit las einen anderen Pfad.

Die Gegenmaßnahme ist, jede Prüfung **die Quelle fragen** zu lassen statt die Tabelle:

- `check-catalog.mjs` Prüfung 3: Jeder `requires`-Schlüssel muss ein Literal sein, das in der C++-Quelle vorkommt
- `check-catalog.mjs` Prüfung 4: `UAL_CODES` muss der Menge der Codes entsprechen, die das C++ tatsächlich sendet (einschließlich gemeinsamer Gates und Ausdrucksformen wie `Code = bOk ? 200 : 207`)
- `gen-docs.mjs --check`: Die Befehlsreferenz muss zum Katalog passen

Das sind alles **nicht-selbstbestätigende** Prüfungen: Brich die Quelle oder brich die Tabelle, und eine der beiden Seiten scheitert.

---

## 10. Zwei echte Typ-Sicherheits-Fallen

### `undefined`-Eigenschaften explodieren

dsh-tools fährt eine **zweistufige** Pipeline, wenn es ein Werkzeugergebnis dispatched:

1. `snapshotJsonValue(value)` — wirft `value is not lossless JSON`, wenn **irgendeine** eigene Eigenschaft `undefined` ist
2. `validateJsonSchemaValue(schema, value)` — validiert gegen das Schema

Die erste Stufe ist strenger als das Schema und **läuft zuerst**, daher kann ein Test, der nur das Schema prüft, diese Fehlerklasse nicht finden.

Das echte Symptom: Im **Moment**, in dem ein Editor verband und bevor er `project.info` geschoben hatte, hatte sein `ual_status`-Eintrag Schlüssel wie `project: undefined` — damit warf „das Werkzeug, das Sie zuerst lesen" in dem Moment, in dem ein Editor auftauchte.

Die Korrektur ist bedingtes Spreizen, statt `undefined` zu schreiben:

```ts
...(session.info?.projectName !== undefined ? { project: session.info.projectName } : {})
```

### Das Ausgabeschema muss jeden Schlüssel deklarieren

Das Ausgabeschema eines Werkzeugs nutzt `additionalProperties: false`, und die Registry validiert es **Schlüssel für Schlüssel**. Das `attachment`, das `ual_screenshot` zurückgibt, muss also im Schema deklariert sein — sonst wirft es `ToolOutputError` **im Moment, in dem ein Screenshot gelingt**, während der Textpfad problemlos funktioniert.

Die Schema-Sprache hat keinen `ImageAttachmentRef`-Knoten, daher kann es nur als `{ type: 'json' }` deklariert werden. Das verbreitert den abgeleiteten Typ auf `JsonValue`, also muss der Render-Pfad ihn mit einem **Laufzeit-Guard** zurückverengen statt mit einer `as`-Assertion:

```ts
const attachment = imageRef(record.attachment)   // validates field by field
return attachment ? [{ type: 'image', attachment }, ...blocks] : blocks
```

Der Compiler verweigert ein einfaches `as` hier (TS2352: die zwei Typen überlappen nicht genügend) — das ist seine Forderung nach einer Laufzeitprüfung, keine Schikane.

---

## 11. Verifikationsstrategie

```bash
npm run check
```

was gleichbedeutend ist mit:

```bash
tsc -p tsconfig.json --noEmit      # src
tsc -p tsconfig.test.json          # tests (src's tsconfig does not include tests)
vitest run                         # 154 tests
node scripts/check-catalog.mjs     # 4 reconciliation checks
```

Die Tests liegen in 7 Dateien, aufgeteilt nach **der Art des Defekts, den sie finden können**:

| File | Covers |
|---|---|
| `protocol.test.ts` | den `judge()`-Vertrag, Serialisierungsregeln |
| `translate.test.ts` | Klassifikation und Hinweise für alle 16 Arten |
| `resilience.test.ts` | die Breaker-Zustandsmaschine, Rate-Limit-Einreihung, `notifierFor` |
| `catalog.test.ts` | Katalogabfragen, Prototyp-Ketten-Schutz, das Freigabe-Gate end to end |
| `bridge.test.ts` | ein echter WebSocket: Warteschlangen, Timeout-Waisen, Ereignisse, Shutdown |
| `tool-output.test.ts` | der echte Rückgabewert jedes Werkzeugs durch die zweistufige Pipeline |
| `end-to-end.test.ts` | die echte Gate-Kette + ein echter Socket + echte Werkzeugschemas |

**Warum `end-to-end.test.ts` existieren muss**: Jeder andere Test stubbt eine Schicht aus. Der `REQUIRED_KEYS`-Fehler — generiert, dokumentiert, reviewed, nie importiert — wurde von keinem Unit-Test gefangen, weil jede Schicht isoliert in sich konsistent war. Nur die echte Gate-Kette an einen echten Socket zu hängen und sie einem echten Schema zu füttern legt **die Naht zwischen den Schichten** frei.

Aus demselben Grund nutzt `tool-output.test.ts` die **echten** `snapshotJsonValue` + `validateJsonSchemaValue`, statt eine eigene Schema-Prüfung zu schreiben — sonst würde der `ual_status`-`undefined`-Defekt genauso durchschlüpfen.

---

## 12. Konfiguration

Das Schemastery-Schema in `src/config.ts` ist **die einzige Quelle für Standardwerte**. Die `config` in `cordis.patch.yml` stellt nur Standardwerte wiederholt fest, die das Schema ohnehin schon hat.

**Hinweis zu DSHs Konfigurationsschichtung**: Eine spätere Schicht **ersetzt** die `config` dieser Zeile vollständig, statt sie tief zusammenzuführen. Um einen Schlüssel zu überschreiben, müssen Sie jeden Schlüssel, den Sie behalten wollen, neu schreiben.

Schalter wie `allowDangerous` **existieren absichtlich nicht** — das Risiko-Gate läuft über DSHs native `tools/pre-execute`-Freigabenaht, statt dass das Plugin einen eigenen Bypass erfindet.

---

## 13. Degradieren bei optionalen Abhängigkeiten

`cordis.patch.yml` deklariert genau eine harte Abhängigkeit: die `tools`-Registry (über `inject`). Alles andere wird über `ctx.get` gelesen:

| Service | When missing |
|---|---|
| `jobs` | `ual_task` gibt `kind:'background'` zurück und erklärt, dass es nicht verfügbar ist |
| `fs` / `attachments` | Screenshots degradieren auf einen Textpfad plus den Grund |
| `agents` | Verbinden/Trennen des Editors benachrichtigt den Agenten nicht |
| `approval` | `ask` wird von DSH in eine Ablehnung verwandelt |

So verliert eine Komposition, die einen Dienst weglässt, **eine Funktion**, statt nicht zu laden.
