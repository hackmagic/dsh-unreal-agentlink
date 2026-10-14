<div align="center">

[English](../01-tutorial.md) · [简体中文](../zh/01-tutorial.md) · [繁體中文](../zh-TW/01-tutorial.md) · [日本語](../ja/01-tutorial.md) · [한국어](../ko/01-tutorial.md) · **Deutsch** · [Español](../es/01-tutorial.md) · [Français](../fr/01-tutorial.md) · [Русский](../ru/01-tutorial.md)

[README](../readme/README_de.md) · **Tutorial** · [Protokoll](02-protocol.md) · [Architektur](03-architecture.md) · [Befehlsreferenz](command-reference.md)

</div>

# Tutorial: von null zu einer funktionierenden Brücke

Das ist der End-to-End-Weg. Das Ziel: Ein Agenten innerhalb von DSH Ihren lokalen Unreal-Editor tatsächlich steuern lassen — und wissen, was er tun sollte und was hängen bleibt.

Empfohlene Lesereihenfolge: diese Seite → [Protokoll](02-protocol.md) → [Architektur](03-architecture.md) → [Befehlsreferenz](command-reference.md).

---

## 1. Mentales Modell: vier Fakten zuerst

Bevor Sie irgendetwas anfassen: Diese vier Fakten bestimmen, wie jede spätere Operation geschrieben wird. Sie sind keine Designentscheidungen — sie sind bestehende UnrealAgentLink-Einschränkungen.

**① Die Richtung ist umgekehrt.** Dieses Plugin wählt den Editor nicht; **der Editor wählt hinaus**. Das UnrealAgentLink-C++-Plugin öffnet in `StartupModule` unbedingt `ws://127.0.0.1:17860`, und dieses Plugin hört auf diesen Port. Die Startreihenfolge spielt daher keine Rolle: Startet der Editor zuerst, wiederholt er alle 5 Sekunden und verbindet sich trotzdem, sobald das Plugin erscheint.

**② Es gibt keine Authentifizierung.** Kein Token, kein Header, kein Subprotokoll. **Der Port selbst ist die Berechtigung** — wer 17860 erreicht, kann den Editor steuern. Deshalb bindet er standardmäßig nur Loopback, und deshalb sollten Sie ihn nicht auf `0.0.0.0` ändern.

**③ Befehle laufen seriell auf dem Game-Thread.** Empfängt der Editor einen Befehl, stellt er ihn zurück auf den Game-Thread um, falls er nicht schon dort ist, und **führt ihn dann synchron bis zum Ende aus**. Zwei Konsequenzen:

- Befehle für denselben Editor reihen sich von selbst ein, und dieses Plugin sendet pro Editor ebenfalls seriell.
- **Während ein blockierender Befehl läuft, antwortet der Editor auf nichts** — nicht einmal auf eine Fortschrittsabfrage wie `sequence.render_status`. Alles andere, was Sie senden, reiht sich dahinter ein.

**④ Es gibt kein Abbrechen.** `query_task` / `cancel_task` existieren im Protokoll nicht. Das Beenden eines `ual_task`-Jobs stoppt nur **das Warten dieses Plugins**; die Engine läuft weiter und das Ergebnis kommt trotzdem zurück. Dieser Satz steht in der Werkzeugbeschreibung von `ual_task`, damit das Modell ihn liest.

---

## 2. Voraussetzungen

| Item | Requirement | Notes |
|---|---|---|
| Unreal Engine | 5.0 – 5.8 | der im `.uplugin` des Plugins deklarierte Bereich |
| UnrealAgentLink | das C++-Plugin selbst | in das `Plugins/`-Verzeichnis des Projekts kopieren |
| Node.js | `^22.19.0 \|\| >=24.0.0` | siehe `engines` in `package.json` |
| DSH runtime | eine beliebige funktionierende Installation | dieses Plugin wird als Bundle geladen |

**Sie brauchen die UEBox-Desktop-App nicht.** Sie ist ein anderer Client desselben Herstellers, der zufällig ebenfalls Port 17860 nutzt, daher ist der gleichzeitige Betrieb beider ein Portkonflikt. Siehe [README § „Sie brauchen kein UEBox"](../readme/README_de.md#sie-brauchen-kein-uebox).

### UnrealAgentLink in ein UE-Projekt installieren

1. Kopieren Sie das gesamte `UnrealAgentLink`-Verzeichnis in das `Plugins/`-Verzeichnis des Projekts (oder in das `Plugins/`-Verzeichnis der Engine für eine globale Installation).
2. Projektdateien neu generieren und das Projekt öffnen.
3. Bestätigen Sie, dass UnrealAgentLink unter **Edit → Plugins** aktiviert ist.

Das Plugin aktiviert seine beiden engine-eigenen Abhängigkeiten `IKRig` und `PythonScriptPlugin` automatisch (siehe `.uplugin`). Sobald der Editor startet, beginnt er ohne jede Konfiguration, sich mit 17860 zu verbinden.

> Ist der Port belegt (zum Beispiel durch die UEBox-Desktop-App), geben Sie dem Editor einen anderen:
> `UnrealEditor.exe MyProject.uproject -UALServer=ws://127.0.0.1:17861`
> und passen Sie die Einstellung `port` auf dieser Seite an.

---

## 3. Dieses Plugin installieren

```bash
git clone <this-repo> dsh-unreal-agentlink
cd dsh-unreal-agentlink
npm install
npm run check      # typecheck + 154 tests + catalog reconciliation, one command
```

`npm run check` muss vollständig grün sein, bevor es weitergeht. Es prüft drei Dinge: Quellen und Tests typechecken beide, alle Verhaltenstests laufen durch, und der 170-Befehle-Katalog passt Eintrag für Eintrag zur C++-Registry.

### Als DSH-Bundle installieren

`package.json` deklariert `dsh.bundle.patch: ./cordis.patch.yml`, und diese Datei tut genau eine Sache:

```yaml
- insert:
    - id: unreal-agentlink
      name: dsh-unreal-agentlink
```

**Hinweis**: In DSHs Konfigurationsschichtung **ersetzt** eine spätere Schicht die `config` dieser Zeile vollständig, statt sie tief zusammenzuführen. Um einen Schlüssel zu überschreiben, müssen Sie jeden Schlüssel, den Sie behalten wollen, neu schreiben.

---

## 4. Erste Verbindung

### Schritt 1: bestätigen, dass die Brücke lebt

Lassen Sie den Agenten `ual_status` aufrufen. Achten Sie auf vier Felder:

```
listening: true
url: ws://127.0.0.1:17860
editors: [ { sessionId: "ue-xxxxxxxx", project: "MyProject", ... } ]
```

- `listening: false` → das Plugin ist nicht gestartet, oder der Port ist belegt. Suchen Sie im DSH-Log nach `EADDRINUSE`.
- `listening: true` aber `editors: []` → die Brücke wartet. Bestätigen Sie, dass das UE-Projekt offen und UnrealAgentLink aktiviert ist.

Für den **ersten Moment**, nachdem ein Editor verbunden hat, enthält sein Eintrag nur `sessionId` / `connectedAt` / `lastSeenAt` / `heartbeats` / `stale` — Felder wie `project` erscheinen erst, sobald der Editor `project.info` schiebt. Das ist ein normaler Zustand, kein Fehler.

### Schritt 2: Fähigkeiten entdecken

Raten Sie keine Befehlsnamen. Zwei Schritte:

```
ual_tools  { filter: "material" }        → list the material family with a one-line summary each
ual_schema { method: "material.create" } → that command's param keys, required keys, result keys, status codes
```

Die Schlüsselnamen von `ual_schema` werden **wörtlich** aus den C++-Handlern extrahiert. Überspringen Sie diesen Schritt nicht: **UE ignoriert unbekannte oder falsch getypte Schlüssel stillschweigend** — ein falsch geschriebener Schlüsselname erzeugt keinen Fehler, er „gelingt" einfach, ohne etwas zu tun.

### Schritt 3: der erste echte Aufruf

```
ual_call { method: "level.get_current" }
```

Reine Leseoperation, keine Seiteneffekte. Sie gibt das `result` des Editors **wörtlich** zurück; dieses Plugin formt es nicht um.

### Schritt 4: auf die Szene schauen

```
ual_screenshot { width: 1280, height: 720 }
```

Zurück kommt ein **echtes Bild**, das der Agent direkt sehen kann. Das schlägt `ual_call { method: "editor.screenshot" }`, das nur einen Dateipfad zurückgibt.

Sind `pending_shaders` / `pending_assets` eines Screenshots ungleich null, kompiliert oder streamt die Ansicht noch und ist **nicht das endgültige Aussehen**. Beurteilen Sie ein Material nicht danach als kaputt.

---

## 5. Häufige Arbeitsabläufe

### Eigenschaft eines Actors ändern

```
ual_schema { method: "actor.set_property" }        # check key names first
ual_call   { method: "actor.get_info", params: { targets: { names: ["Cube_1"] } } }
ual_call   { method: "actor.set_property", params: {
               targets: { names: ["Cube_1"] },
               properties: { Mobility: "Movable" } } }
```

Ist ein Eigenschaftsname falsch geschrieben, **gibt der Editor Vorschläge** zurück statt eines 404. Lesen Sie die Vorschläge; wiederholen Sie nicht die Falschschreibung.

### Batch-Operationen

Für eine bekannte Abfolge von Arbeiten nutzen Sie `ual_batch`, um sie in einem Round Trip zu erledigen:

```
ual_batch { calls: [
  { method: "actor.spawn", params: { asset_id: "cube", name: "A" } },
  { method: "actor.spawn", params: { asset_id: "cube", name: "B" } },
  { method: "actor.get_info", params: { targets: { names: ["A", "B"] } } }
] }
```

- Läuft seriell (der Editor ist ohnehin seriell) und **bricht standardmäßig beim ersten Fehler ab**; `continueOnError: true` ändert das.
- Begrenzt durch `maxBatchCalls` (Standard 12).
- **Ist auch nur ein einzelner Eintrag gefährlich, geht der ganze Batch durch die Freigabe.** Der Freigabe-Dialog nennt, welcher Eintrag es war.

### Lange Aufgaben

Befehle, die den Game-Thread blockieren, müssen über `ual_task` laufen:

```
ual_task { method: "sequence.render", params: { sequence_path: "/Game/Seq/Main" }, label: "Render main sequence" }
```

Sie gibt sofort eine `jobId` zurück und das Gespräch geht weiter. Das Ergebnis holen Sie mit `job_output`.

Welche davon lang sind: `sequence.render`, `cpp.compile`, `level.build`, `blueprint.compile_all`, `pcg.execute`, `pie.run`, Asset-Importe. Die Timeout-Spalte von `ual_schema` markiert sie als „blocking".

**Fragen Sie den Editor nicht ab**, während eine lange Aufgabe läuft — er wird nicht antworten.

### Rollback

```
ual_undo_history            # see what is in the buffer first
ual_undo { dryRun: true }   # rehearse
ual_undo                    # actually undo
```

UnrealAgentLink pflegt **einen unabhängigen Agent-Undo-Stack pro Editor**, getrennt von der Ctrl+Z-Historie des Nutzers. Dieses Plugin zeichnet auf, zu welcher DSH-Sitzung jeder Schritt gehört, und **rollt nur zurück, wenn die Schritte dieser Sitzung ein sauberes LIFO-Suffix des Puffers bilden**. Hat in der Zwischenzeit eine andere Sitzung den Editor angefasst, **macht das Werkzeug nichts rückgängig** und meldet beide Schrittlisten, statt fremde Arbeit stillschweigend zu verwerfen.

### Asset-Sperren setzen

Vor einer mehrschrittigen Änderung an einem Asset:

```
ual_locks { claim: ["/Game/Materials/M_Rock"] }
... make changes ...
ual_locks { release: ["/Game/Materials/M_Rock"] }
```

Der Editor zeichnet im Content Browser ein „KI bearbeitet"-Abzeichen, und der Nutzer wird gewarnt, wenn er es von Hand zu bearbeiten beginnt. Ansprüche aus mehreren Sitzungen führt dieses Plugin vor dem Senden zu einer Tabelle zusammen und sendet sie nach einem Wiederverbinden des Editors erneut.

### Logs lesen

```
ual_logs { level: "Warning", contains: "Niagara" }
```

Der Log-Ring ist standardmäßig leer — die UE-seitige Log-Weiterleitung ist **standardmäßig aus** und erfordert `ual.ForwardLogs 1` im Editor (dieses Plugin kann sie nicht aus der Ferne einschalten). `ual_logs` sagt das, wenn es nichts zurückgibt.

Ist die Weiterleitung aus, nutzen Sie stattdessen das eigene Message-Log der Engine:

```
ual_call { method: "messagelog.list", params: { limit: 50 } }
```

---

## 6. Fehler lesen

Dieses Plugin **parst niemals Fehlertext** (der Text wechselt mit der Editor-Kultur zwischen Chinesisch und Englisch). Es klassifiziert nur nach **Fehler-Klassenname und Statuscode**, in 16 Arten.

| kind | Meaning | What to do |
|---|---|---|
| `no-editor` | kein Editor verbunden | das UE-Projekt öffnen; bestätigen, dass das Plugin aktiviert ist |
| `timeout` | Zeitüberschreitung, **der Befehl läuft möglicherweise noch** | **nicht erneut senden**. Den tatsächlichen Zustand zuerst mit einem Lesebefehl prüfen |
| `editor-lost` | der Editor hat die Verbindung verloren | auf seinen 5-Sekunden-Reconnect warten |
| `queue-stalled` | ein früherer Befehl hat eine Zeitüberschreitung gehabt | `orphaned` in `ual_status` prüfen |
| `circuit-open` | wiederholte Transportfehler haben den Breaker geöffnet | stoppen, auf den Cooldown warten, `ual_status` prüfen |
| `rate-limited` | die Rate-Limit-Warteschlange ist voll | langsamer werden |
| `not-found` | keine solche Methode und kein solches Asset | mit `ual_tools` den echten Befehlsnamen finden |
| `bad-params` | ein Parameter fehlt oder hat den falschen Typ | Schlüsselnamen mit `ual_schema` prüfen |
| `precondition` | eine Vorbedingung ist fehlgeschlagen (412/413/422) | `details` lesen; 422 heißt „Eingabe gültig, aber es wurde nichts geschrieben" |
| `registry-busy` | die Asset-Registry scannt noch | `content.registry_status` pollen |
| `unsupported` | diese Editor-Version unterstützt es nicht | z. B. braucht `anim.*` UE 5.5+ |
| `engine-error` | der Editor selbst ist gescheitert | `result.message` lesen (für Menschen) und `details` (für Maschinen) |

**Zeitüberschreitung ist die Art, die am meisten Disziplin braucht.** Das Protokoll hat kein Abbrechen, eine Zeitüberschreitung bedeutet also nur „dieses Plugin hat aufgehört zu warten" — der Befehl läuft sehr wahrscheinlich noch auf dem Game-Thread. Die richtige Reaktion: `orphaned` in `ual_status` prüfen, dann den tatsächlichen Zustand mit einem reinen Lesebefehl verifizieren, und **nicht erneut senden**.

---

## 7. Konfiguration

Jeder Schlüssel ist änderbar, und die Standardwerte sind „lebendig, aber faul". Die vollständige Tabelle steht in [README § Konfiguration](../readme/README_de.md#konfiguration). Einige, die eine Erwähnung wert sind:

- **`port`** — hier ändern, und die UE-Seite braucht ebenfalls `-UALServer=`.
- **`rateLimitRps: 0`** — deaktiviert das Rate-Limit.
- **`rollbackOnDispose: false`** — macht beim Ende einer Sitzung **nicht** automatisch Undo. Es einzuschalten bedeutet Rollback beim Dispose, was normalerweise eine Überraschung ist, die der Nutzer nicht verlangt hat.
- **`logForwardingEnabled: false`** — nur auf `true` setzen, nachdem `ual.ForwardLogs 1` im Editor ausgeführt wurde.

---

## 8. Fehlerbehebung

**`ual_status` zeigt `listening: true`, aber keinen Editor**
Das UE-Projekt ist nicht offen, oder UnrealAgentLink ist nicht aktiviert. Sie können auch `LogUALNetwork` im Editor-Log prüfen: Normalerweise sollten Sie `Connecting to ws://127.0.0.1:17860` und `Connected to` sehen.

**`EADDRINUSE` beim Start**
17860 ist belegt. Am häufigsten durch die UEBox-Desktop-App. Schließen Sie sie, oder verschieben Sie sowohl den Editor als auch dieses Plugin auf einen anderen Port.

**Alle Befehle geben `unknown-method` zurück oder werden rundweg verweigert**
Dieses Plugin lässt nur die 170 Befehle durch, die in seinem Katalog tatsächlich existieren. Nutzen Sie `ual_tools`, um den Namen zu bestätigen. Veraltete Befehle (wie `editor.play`, `take_screenshot`) geben den Ersatz zurück, den man nutzen soll.

**Screenshots sind schwarz oder halbfertig**
Prüfen Sie `pending_shaders` / `pending_assets`. Ungleich null heißt, Kompilierung oder Streaming sind noch nicht fertig. Erhöhen Sie `warmup_frames` und versuchen Sie es erneut.

**`ual_undo` verweigert die Ausführung**
Die Schritte dieser Sitzung sind kein sauberes LIFO-Suffix des Puffers — eine andere Sitzung hat den Editor in der Zwischenzeit angefasst. Das ist **absichtlicher Schutz**, kein Fehler. Nutzen Sie `ual_undo_history`, um den tatsächlichen Inhalt zu sehen.

**Eine Konfigurationsänderung hatte keine Wirkung**
DSHs Konfigurationsschichtung **ersetzt** die `config` dieser Zeile vollständig, statt sie tief zusammenzuführen. Sie müssen jeden Schlüssel, den Sie behalten wollen, ausschreiben.

**`ual_task` hat den Job beendet, aber der Editor ist noch beschäftigt**
Erwartet. Das Protokoll hat kein Abbrechen. Warten Sie, bis es fertig ist — oder, praktischer, senden Sie keine anderen Befehle, während eine lange Aufgabe läuft.

---

## 9. Nächste Schritte

- [Protokollreferenz](02-protocol.md) — Nachrichtenformen, Ereignisse, Statuscodes
- [Architektur](03-architecture.md) — die Begründung hinter der Gate-Kette, der Sitzungsisolierung und der Fehlerübersetzung
- [Befehlsreferenz](command-reference.md) — vollständige Parameter und Ergebnisschlüssel für alle 170 Befehle (generiert)
