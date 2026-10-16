<div align="center">

[English](../INSTALL-ai.md) · [简体中文](../zh/INSTALL-ai.md) · [繁體中文](../zh-TW/INSTALL-ai.md) · [日本語](../ja/INSTALL-ai.md) · [한국어](../ko/INSTALL-ai.md) · **Deutsch** · [Español](../es/INSTALL-ai.md) · [Français](../fr/INSTALL-ai.md) · [Русский](../ru/INSTALL-ai.md)

[README](../readme/README_de.md) · [Tutorial](01-tutorial.md) · [Protokoll](02-protocol.md) · [Architektur](03-architecture.md) · [Befehlsreferenz](command-reference.md) · **Installationsanleitung**

</div>

# Installation (KI-lesbar)

Diese Datei ist für einen KI-Assistenten geschrieben, der Dateien liest und Schritte der Reihe nach ausführt.
Überspringen Sie keinen Schritt; jeder Schritt hat ein überprüfbares Ergebnis. Für eine Installation durch einen Menschen siehe das
[README](../readme/README_de.md) oder das [Tutorial](01-tutorial.md).

> Die KI muss nur `scripts/install-dsh-plugin.mjs` ausführen. Dieses Skript tut
> alles: spiegeln → das Profil-Manifest bearbeiten → den echten Installer aufrufen →
> das zusammengesetzte Ergebnis prüfen. Jeder Schritt unten ist ein **Prüfpunkt**: wenn
> ein Schritt nicht passt, halten Sie an und melden Sie es. Machen Sie nicht weiter.

---

## 0. Zuerst prüfen (nur lesend, installiert nichts)

```bash
node scripts/install-dsh-plugin.mjs --profile web --status
```

`installed copy:` und `bundle layer:` sollten `present` / `listed` anzeigen. Nur wenn
dort `(absent)` / `(not listed)` steht, muss eine Installation laufen.

Prüfen Sie dann die UnrealAgentLink-Seite:

- `Plugins/UnrealAgentLink/` existiert im Projekt und ist unter
  `Edit → Plugins` aktiviert (der Editor braucht einen Neustart).
- Port 17860 ist frei (`uebox` Desktop beansprucht denselben Port; dieses Plugin
  braucht ihn nicht).

---

## 1. Installieren (ein Befehl)

```bash
npm run build && node scripts/install-dsh-plugin.mjs --profile web --yes
```

Das Skript führt fünf Aktionen aus, von denen jede einen Beleg hinterlässt:

| Schritt | Artefakt | Bedeutung bei Scheitern |
| --- | --- | --- |
| build | `lib/`, 64 files | zuerst `npm run check` laufen lassen; keinen kaputten Build installieren |
| mirror | `<profile>/.vendor/` mit nur den `files`-Einträgen | Platten- oder Berechtigungsproblem |
| manifest edit | `<profile>/package.json` erhält eine dependency-Zeile + eine bundle-Zeile | siehe §4 |
| installer | pnpm gibt `Done in Xs` aus | siehe §2 |
| verify | `install: ... is now a bundle layer of profile "web"` | siehe §3 |

**Nur die letzte Zeile bedeutet, dass die Installation gelungen ist.** Bestehen die ersten vier Schritte
und scheitert der fünfte, ist die Schicht nicht zusammengesetzt, und dsh wird das Plugin nicht laden.

---

## 2. Wenn der Installer verweigert (Versionswächter)

dsh hat eine Wache auf Produktebene: eine Installation wird verweigert, wenn die
`peerDependencies` des Plugins mit der dsh-Version der Laufzeit unverträglich sind. Dieses Projekt
deklariert jeden `@deepseek-ai/dsh-*`-Peer als
`>=0.1.6-alpha.2 <0.2.0-0 || >=0.2.0-rc.1 <0.3.0`, was sowohl die Version akzeptiert, gegen die
dieses Plugin gebaut und getestet wird (`0.1.6-alpha.2`), als auch die `0.2.x`-Linie, von der das
aktuelle dsh ausgeliefert wird — eine normale Installation auf einer unterstützten Laufzeit endet
daher **nicht** hier.

> Die beiden Zweige sind keine Zierde. semver weigert sich, eine Prerelease-Version gegen einen
> Bereich zu prüfen, dessen Comparators kein Prerelease-Tag tragen, sodass ein blankes
> `^0.1.6-alpha.2` jede `0.2.0-rc.*`-Laufzeit unverträglich erscheinen ließ. Jede unterstützte
> Linie braucht daher ihren eigenen Zweig mit einer ausdrücklichen Prerelease-Untergrenze, und die
> Obergrenze endet an der nächsten Linie, deren API niemand getestet hat.

Die Wache greift weiterhin bei einer Laufzeit außerhalb dieser Bereiche — einer künftigen `0.3.x` oder
einer `0.1.x`, die älter als `0.1.6-alpha.2` ist. **Das ist eine Produktentscheidung; das Skript
trifft sie absichtlich nicht für Sie.** dsh gibt den genauen Befehl aus, wenn es verweigert:

```bash
dsh plugin --profile web allow-version dsh-unreal-agentlink@0.1.0 --dsh-version 0.2.0-rc.2 --accept-risk
```

Ihre Ausführung erfordert eine menschliche Bestätigung. Führen Sie dann die Installation aus §1 erneut aus.

> `--status` zeigt in der Zeile `version guard:`, ob die Ausnahme bereits aktiv ist.

---

## 3. Wenn der Prüfschritt scheitert (Schicht nicht zusammengesetzt)

```bash
dsh --profile web --dump-config | grep unreal-agentlink
```

Das muss ausgeben:

```
# == dsh-unreal-agentlink
- id: unreal-agentlink
  name: dsh-unreal-agentlink
```

Drei bekannte Ursachen, wenn es das nicht tut:

1. `dsh.profile.bundles` führt dieses Plugin nicht — das Skript sollte es hinzugefügt haben;
   prüfen Sie `<profile>/package.json`.
2. Das Paket liegt in `node_modules`, deklariert aber kein `dsh.bundle` — das scheitert
   **laut** beim Laden (`declares no dsh.bundle in its package.json`); prüfen Sie das
   gespiegelte `package.json`.
3. `--dump-config` selbst bricht mit einem Fehler ab — melden Sie die vollständige Ausgabe wörtlich, ohne zu raten.

---

## 4. Wenn die Manifest-Bearbeitung an der Sperre abgewiesen wird

```
install: <path>/package.json.lock is held by pid 18344 (DeepSeek Harness)
```

dsh schützt ein Profil-Manifest mit einer per `wx` erzeugten `.lock`-Schwesterdatei, und **ein
Konkurrent löscht niemals die Sperre eines anderen Halters**. Der Halter ist die laufende dsh
-Anwendung selbst.

- Für das Profil `web`: schließen Sie die laufende DeepSeek-Harness-Desktop-App oder wählen
  Sie ein Profil, das nicht gehalten wird.
- Für das Profil `desktop`: der *Boot*-Befehl der CLI ist **verboten**
  (`bin.js:112` `rejectElectronProfile`), aber `dsh plugin --profile desktop …` ist
  bewusst ausgenommen (`bin.js:119`) — es ist der Weg, den die von Desktop
  mitgelieferte CLI, die die App selbst aufruft, nutzt. Das Produkt verlangt, dass
  die App zuerst vollständig beendet wird, weil eine laufende App das Manifest aus
  ihrer eigenen Plugin-Liste neu schreibt. Beenden Sie sie, führen Sie die
  Installation aus und starten Sie Desktop danach, um die Schicht einzubinden.
- Das Skript verweigert und nennt den Halter; es bekämpft die Sperre nicht.

---

## 5. Prüfen, dass das Plugin wirklich funktioniert (installiert sein genügt nicht)

```bash
# a) Editorseite: öffnen Sie das Projekt. Das UE-Log sollte eine Verbindung zeigen.
#    (UnrealAgentLink wiederholt alle 5 Sekunden; ein manuelles Verbinden ist nicht nötig.)

# b) DSH-Seite: bitten Sie den Agenten in einer Sitzung, "den Editor mit ual_status zu prüfen".
```

Die drei `ual_status`-Felder sind die Abnahmekriterien:

| Feld | Erwartet |
| --- | --- |
| `listening` | `true` |
| `editors` | mindestens eines, das einen `project`-Namen trägt |
| `orphanedMethods` | `[]` |

`listening: false` = nichts hört zu (Plugin nicht geladen, oder der Port ist belegt).
`editors: []` = UE hat sich nicht verbunden (Projekt geschlossen, Plugin deaktiviert, oder ein Port-Mismatch).
Ein nicht leeres `orphanedMethods` = eine Anfrage ist abgelaufen, läuft aber möglicherweise noch;
prüfen Sie `ual_logs`, bevor Sie es erneut versuchen.

Bestätigen Sie dann den ganzen Pfad mit einem minimalen Aufruf:

```bash
# in a session: ual_call { "method": "level.get_current" }
```

---

## 6. Deinstallation

```bash
node scripts/install-dsh-plugin.mjs --profile web --remove --yes
```

Das Skript entfernt sowohl den dependency- als auch den bundle-Eintrag und führt dann den echten
Installer aus, damit pnpm `node_modules` abgleicht. Das Spiegelverzeichnis
`<profile>/.vendor` bleibt erhalten und wird bei der nächsten Installation neu aufgebaut; löschen Sie es
von Hand, wenn es verschwinden soll.

---

## Harte Regeln für die KI

1. **Bearbeiten Sie nicht** die `peerDependencies` dieses Projekts, um eine Installation bestehen zu lassen —
   das würde eine echte Versionsunverträglichkeit verbergen.
2. **Bearbeiten Sie nicht** `<profile>/package.json` von Hand; das Skript tut es und prüft
   die Sperre.
3. **Behandeln Sie** `--accept-risk` **nicht** als automatisch ausführbar; es braucht eine menschliche
   Bestätigung.
4. Weicht die Ausgabe eines Schritts von der Beschreibung ab, **halten Sie an und melden Sie die
   Ausgabe wörtlich**; "versuchen Sie nicht, etwas zu reparieren und erneut zu laufen".
5. Jeder Schritt hier kann mit rein lesenden Befehlen erneut geprüft werden (`--status`,
   `--dump-config`, `ual_status`).
