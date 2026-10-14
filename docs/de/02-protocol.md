<div align="center">

[English](../02-protocol.md) · [简体中文](../zh/02-protocol.md) · [繁體中文](../zh-TW/02-protocol.md) · [日本語](../ja/02-protocol.md) · [한국어](../ko/02-protocol.md) · **Deutsch** · [Español](../es/02-protocol.md) · [Français](../fr/02-protocol.md) · [Русский](../ru/02-protocol.md)

[README](../readme/README_de.md) · [Tutorial](01-tutorial.md) · **Protokoll** · [Architektur](03-architecture.md) · [Befehlsreferenz](command-reference.md)

</div>

# Protokollreferenz

Das Drahtprotokoll von UnrealAgentLink. Dieses Plugin ist der **Server**; der Unreal Editor ist der **Client**.

Jede Aussage hier stammt aus dem C++ unter `.ua-ref/plugin/UnrealAgentLink/Source/UnrealAgentLink/`, mit Datei- und Zeilenangaben an den tragenden Stellen.

---

## 1. Verbindung

| Item | Value | Evidence |
|---|---|---|
| Richtung | UE wählt hinaus | `Network/UAL_NetworkManager.cpp:77` `CreateWebSocket(TargetUrl)` |
| Standardadresse | `ws://127.0.0.1:17860` | `Core/UnrealAgentLink.cpp:88` |
| Ändern | Kommandozeile `-UALServer=ws://host:port` | `Core/UnrealAgentLink.cpp:90` |
| Authentifizierung | **keine** — kein Token, Header oder Subprotokoll | `CreateWebSocket` nimmt nur eine URL |
| Reconnect | ein fester 5-Sekunden-Zyklus, kein Backoff | `Network/UAL_NetworkManager.cpp:116` |
| Schutz gegen Hängen beim Verbinden | ja (`ConnectTimeoutSeconds`) | `Network/UAL_NetworkManager.cpp:145-155` |

Dieses Plugin hört auf 17860 mit einem `maxPayload` von 64 MB.

### Ursprungsprüfung

Nur Loopback-Ursprünge werden akzeptiert (`127.*`, `::1`, `::ffff:127.*`). Es weitet sich nur, wenn der konfigurierte `host` **absichtlich** auf etwas anderes als `127.0.0.1` / `localhost` gesetzt wurde. Der Grund steht bei „keine Authentifizierung" — der Port ist die Berechtigung.

### Handshake

**Es gibt keinen Handshake.** Ein Editor schiebt bei Verbindung sofort `project.info`, und dieses Plugin nutzt das, um ihn als identifiziert zu markieren (`editor-identified`). Bevor es ankommt, ist die Verbindung „verbunden, aber nicht identifiziert" — so ein Eintrag in `ual_status` hat nur `sessionId` / `connectedAt` / `lastSeenAt` / `heartbeats` / `stale`, ohne `project` und Konsorten.

---

## 2. Nachrichtenformen

```
UE → plugin:  { ver:"1.0", type:"req",  method, id, params }
plugin → UE:  { ver:"1.0", type:"res",  id, code, result }
UE → plugin:  { ver:"1.0", type:"evt",  method, payload }
```

### `req` (dieses Plugin → Editor)

| Field | Notes |
|---|---|
| `ver` | immer `"1.0"` |
| `type` | `"req"` |
| `method` | der Befehlsname, z. B. `actor.get_info` |
| `id` | vom **Server** erzeugt, geformt als `dsh-<uuid>` |
| `params` | optional. **Der ganze Schlüssel wird weggelassen, wenn er leer ist**, nicht als `null` gesendet |

`id` muss nicht leer sein: Die erste Zeile von `SendResponse` ist `if (RequestId.IsEmpty()) { return; }` (`Utils/UAL_CommandUtils.cpp:2503-2506`) — **eine Anfrage ohne `id` bekommt nie eine Antwort**.

Auf der Editorseite liest das Parsen (`Commands/UAL_CommandHandler.cpp:87-94`) zuerst `params` und fällt auf das Altfeld `payload` zurück. Dieses Plugin sendet nur `params`.

### `res` (Editor → dieses Plugin)

| Field | Notes |
|---|---|
| `ver` | `"1.0"` |
| `type` | `"res"` |
| `id` | spiegelt das `id` der Anfrage, dient dem Abgleich |
| `code` | eine **Zahl**, kein String |
| `result` | optional. **Der ganze Schlüssel wird weggelassen, wenn es keinen Inhalt gibt** |

Die Weglassungslogik steht in `Utils/UAL_CommandUtils.cpp:2513-2516`: `result` wird nur geschrieben, wenn `Data.IsValid()`.

Auf der Editorseite versucht das Parsen des Antwortkörpers (`Commands/UAL_CommandHandler.cpp:98-104`) der Reihe nach `result` → `data` → `payload`. Dieses Plugin sendet `result`.

### `evt` (Editor → dieses Plugin, einseitiger Push)

| Field | Notes |
|---|---|
| `ver` | vorhanden, wenn das Ereignis über `SendEvent` gesendet wird; **die Import-Ereignisse der Content-Browser-Erweiterung tragen es nicht** |
| `type` | `"evt"` |
| `method` | der Ereignisname |
| `payload` | optional |
| `id` | **existiert nicht** — Ereignisse können nicht beantwortet werden |

---

## 3. Wie Fehler ausgedrückt werden

**Allein über `code`.** Es gibt im Nachrichtenformat **kein** `error`-Feld auf Umschlag-Ebene.

| Code | Meaning | This plugin's kind |
|---|---|---|
| `200` | Erfolg | — |
| `207` | Teilerfolg | `partial: true` |
| `400` | ein Parameter fehlt oder hat den falschen Typ | `bad-params` |
| `404` | keine solche Methode und kein solches Asset | `not-found` |
| `409` | Konflikt (z. B. ein exklusiver Profiler läuft schon) | `conflict` |
| `410` | entfernt | `not-found` |
| `412` | Vorbedingung nicht erfüllt | `precondition` |
| `413` | über einem Cap (z. B. Batch-Erzeugung über ein cvar-Limit hinaus) | `precondition` |
| `422` | Eingabe gültig, aber es wurde nichts geschrieben | `precondition` |
| `500` | interner Fehler des Editors | `engine-error` |
| `501` | auf dieser Version nicht unterstützt | `unsupported` |
| `503` | die Asset-Registry scannt noch | `registry-busy` |
| `504` | Zeitüberschreitung auf Editorseite | `timeout` |

`0` wird **nie** verwendet.

Diese 13 Codes sind in `protocol/types.ts` als `UAL_CODES` definiert, und Prüfung 4 von `scripts/check-catalog.mjs` fragt sie direkt in der C++-Quelle ab — einschließlich einer 503, die von gemeinsamen Gates wie `FUAL_RegistryReady::Ensure` ausgegeben wird, und Ausdrucksformen wie `Code = bOk ? 200 : 207`. Ein fehlender oder überzähliger Code lässt die Prüfung scheitern.

### Wo der Fehlertext steht

```
result.message   ← for humans, Chinese or English by editor culture, never parse it
result.details   ← for machines (suggestions / expected_type / registry progress)
```

`SendError` baut `{message: ...}`, und die 4-Argument-Überladung hängt auch `details` an (`Utils/UAL_CommandUtils.cpp:2525-2539`).

### 200 kann trotzdem ein Fehler sein

**Das ist die Falle, in die man am leichtsten tappt.** Viele Handler geben `200` mit `result.ok === false` zurück:

- `editor.undo` — wenn es nichts rückgängig zu machen gibt
- `blueprint.compile` — wenn die Kompilierung Fehler hat
- `pie.observe` — wenn die Beobachtung fehlschlägt

Daher beurteilt dieses Plugin den Erfolg mit `judge(result, code)` statt allein über den Code:

| Situation | Verdict |
|---|---|
| `code === 200`, `result.ok !== false`, `result.error` leer | Erfolg |
| `code === 207` | Erfolg, aber `partial: true` |
| `result.ok === false` | **Fehler** |
| `result.error` ist ein nicht leerer String | **Fehler** |
| `result` ist kein Objekt (oder fehlt) | nach Code beurteilen; nicht raten |

Diese Regel ist **notwendig**: Es gibt 55 Stellen mit `SetStringField(TEXT("error"), ...)` über 14 C++-Dateien verteilt. Anders gesagt: „200 mit nicht leerem Error" ist die Norm, keine Anomalie.

---

## 4. Ereignisse

| Event | When | Payload |
|---|---|---|
| `project.info` | sofort bei Verbindung, ersetzt den Handshake | Projektname, Pfad, Engine-Version, Plugin-Version, Run-Modus, aktuelle Szene, Python-Verfügbarkeit und mehr |
| `project.closed` | der Editor schließt das Projekt | — |
| `system.heartbeat` | alle **10 Sekunden** | `{}` (**immer vorhanden**, nicht weggelassen) |
| `log.entry` | UE-Log-Ausgabe (erfordert die cvar `ual.ForwardLogs 1`) | `text` / `category` / `level` |
| `content.import_folder` | der Nutzer wählt „import to UnrealBox asset library" aus dem Kontextmenü des Content Browsers | `paths` / `real_paths` / `asset_metadata` |
| `content.import_assets` | wie oben, aus dem Level-Viewport ausgelöst | `asset_paths` / `asset_real_paths` / `asset_metadata` |

### Heartbeats und wann ein Editor als tot gilt

Heartbeats sind ein **unabhängiger 10-Sekunden-Ticker** (`Network/UAL_NetworkManager.cpp:173`), ohne Bezug zum 5-Sekunden-Reconnect. Dieses Plugin markiert einen Editor nach **45 Sekunden** ohne Heartbeat als `stale` — passend zum Frontend (`Network/UAL_NetworkManager.cpp:172`).

### Die beiden Import-Ereignisse sind Fire-and-Forget

Sie tragen **kein `id`**, und der Editor **wartet nicht auf eine Antwort**. Das Editor-seitige `Handle_Response` (`Commands/UAL_CommandHandler.cpp:185-297`) poppt nur eine Slate-Benachrichtigung, wenn es `type:"res"` empfängt, und liest `ok` / `count` / `importedPath` / `error`.

Dieses Plugin ist eine reine Brücke ohne die Fähigkeit, Assets zu importieren, daher verwandelt es die Ereignisse in **Logs und Agent-Benachrichtigungen** und **erfindet kein `res`** — mit `ok:false` zu antworten würde dem Nutzer nur einen falschen „Import fehlgeschlagen"-Dialog zeigen, was schlimmer ist als Stille.

---

## 5. Serialisierungsregeln

Ausgehende Parameter laufen vor dem Draht durch `toSerializable()` in `protocol/serialization.ts`. Das ist strenger als `JSON.stringify`, denn **UE behandelt ein Feld, das es nicht lesen kann, als „nicht gesendet"** — stillschweigend nichts zu tun ist schwerer zu diagnostizieren als ein Fehler.

| Input | Handling |
|---|---|
| `null` / Boolean / String | wie es ist |
| endliche Zahl | wie es ist |
| **nicht endliche Zahl** (`NaN` / `Infinity`) | **wirft** — UE würde es als „Feld fehlt" lesen |
| `undefined` (auf oberster Ebene oder in einem Array) | **wirft** |
| `undefined` (als Wert einer Objekteigenschaft) | **der Schlüssel wird fallengelassen** |
| function / symbol / bigint | **wirft** |
| Zirkelbezug | **wirft** |
| `Uint8Array` | in einen base64-String umgewandelt |
| `Date` | in einen ISO-String umgewandelt |
| `Map` (Schlüssel müssen Strings sein) | in ein einfaches Objekt umgewandelt |
| `Set` | in ein Array umgewandelt |
| andere nicht-einfache Objekte (Klasseninstanzen etc.) | **wirft** |

Nur einfache Objekte, Arrays und JSON-Skalare kommen durch.

---

## 6. Timing und Nebenläufigkeit

**Befehle für einen Editor sind seriell.** Dieses Plugin hält eine Sende-Warteschlange pro Editor und hängt jeden Befehl an das `then` des vorherigen. Das dient nicht dem Protokoll — es liegt daran, dass der Editor ohnehin auf dem Game-Thread synchron bis zum Ende ausführt.

**Warteschlangen sind über Editoren hinweg unabhängig.** Sind mehrere Editoren verbunden, bekommt jeder seine eigene Warteschlange.

### Timeouts

Der Standard ist 180 Sekunden, und blockierende Befehle heben ihre eigenen Untergrenzen (die Timeout-Spalte von `ual_schema` markiert sie als „blocking").

**Eine Zeitüberschreitung heißt nicht, dass der Befehl nicht gelaufen ist.** Sie heißt nur, dass dieses Plugin aufgehört hat zu warten. Passiert das:

1. Der Editor wird markiert, dass er einen verwaisten Befehl hat (`orphaned` in `ual_status`).
2. Nachfolgende **kurze Befehle an denselben Editor werden rundweg verweigert** (`queue-stalled`), statt hinter Arbeit eingereiht zu werden, die möglicherweise nie zurückkommt.
3. Ein Aufruf mit `long: true` kann weiterhin gesendet werden — so drückt man aus: „Ich bin bereit zu warten".

**Dasselbe gilt für abgebrochene Aufrufe**: Das Beenden eines `ual_task`-Jobs läuft über Abort, und Abort stoppt nur das Warten dieses Plugins, während die Engine weiterläuft. Ein Abort zeichnet daher ebenfalls einen Waisen auf.

### Verbindungsabbruch

Trennt ein Editor die Verbindung, scheitert jede für ihn laufende Anfrage mit `editor-lost`, und der Fehler trägt alle Methodennamen.

---

## 7. Was dieses Plugin nicht sendet

Um die Grenze ausdrücklich zu machen:

- **Kein Token** — es gibt keinen Authentifizierungsmechanismus.
- **Kein `GET /api/ual/action`** — alte Dokumentation beschrieb das als HTTP-Dienst; das ist falsch.
- **Kein Task-Polling** — `query_task` / `cancel_task` existieren nicht.
- **Kein erfundenes `res`** — siehe den Abschnitt zu den Import-Ereignissen.
- **Keine aktive Wiederverbindung zum Editor** — die Richtung ist umgekehrt; der Editor wiederholt alle 5 Sekunden von selbst.

---

## 8. Zugehörige Dateien

| File | Contents |
|---|---|
| `src/protocol/types.ts` | Nachrichtentypen, `UAL_CODES`, `UalError` |
| `src/protocol/bridge.ts` | WebSocket-Server, Warteschlangen, Timeouts, Waisen, Log-Ring |
| `src/protocol/serialization.ts` | jede Serialisierungsregel aus der Tabelle oben |
| `src/service.ts` | `judge()`, die Gate-Kette, das Ledger |
| `src/errors/translate.ts` | Statuscode / Klassenname → 16 Arten |

C++-Gegenstücke: `Utils/UAL_CommandUtils.cpp` (`SendResponse` / `SendError` / `SendEvent`), `Commands/UAL_CommandHandler.cpp` (eingehender Dispatch), `Network/UAL_NetworkManager.cpp` (Verbindung, Heartbeat, Reconnect).
