<div align="center">

[English](../03-architecture.md) · [简体中文](../zh/03-architecture.md) · [繁體中文](../zh-TW/03-architecture.md) · [日本語](../ja/03-architecture.md) · [한국어](../ko/03-architecture.md) · [Deutsch](../de/03-architecture.md) · [Español](../es/03-architecture.md) · **Français** · [Русский](../ru/03-architecture.md)

[README](../readme/README_fr.md) · [Tutoriel](01-tutorial.md) · [Protocole](02-protocol.md) · **Architecture** · [Référence des commandes](command-reference.md)

</div>

# Architecture

Ce plugin est un **pont pur** : il ne planifie pas les tâches et ne décide pas quoi faire. Il traduit l'intention d'un agent DSH en commandes UnrealAgentLink, et les réponses de l'éditeur en une forme utilisable par un agent. La planification appartient à l'agent de DSH, pas ici.

Cette section explique pourquoi le code est fait comme il l'est.

---

## 1. Carte des modules

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

### Direction des dépendances

```
index.ts ──► service.ts ──► protocol/bridge.ts
    │            │
    │            ├──► catalog/methods.ts ──► catalog/method-data.ts
    │            ├──► resilience/breaker.ts
    │            ├──► sessions/state.ts
    │            └──► errors/translate.ts
    └──► tools/* ──► service.ts
```

Il n'y a pas de dépendances inverses. `tools/` ne dépend que de `service`, et `service` ne dépend d'aucun outil.

---

## 2. La chaîne de contrôles : `service.call()`

**Chaque** commande passe par ce point d'entrée unique (`src/service.ts:190-332`), dans un ordre fixe :

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

L'intérêt des deux premières étapes est qu'elles **refusent avant que le moteur ne voie jamais l'appel**. UE ignore silencieusement les clés inconnues, donc un nom de clé mal orthographié fait « réussir » un appel à ne rien faire — bien plus difficile à déboguer qu'une erreur.

`call()` ne **lève jamais** d'exception. Chaque échec revient en `ok: false` à l'intérieur de `CallOutcome.value`. C'est délibéré : chaque branche de la couche d'outils doit pouvoir produire un résultat structuré plutôt que de faire son propre try/catch.

### Pourquoi les deux premières étapes doivent être « catalogue » et non « table de risques »

`riskOf()` renvoie `'dangerous'` pour une méthode **inconnue** (un défaut conservateur). Une version antérieure s'en servait pour déduire « cette méthode existe-t-elle », ce qui :

- refusait à tort 5 méthodes qui existent réellement (`level.new`, `level.open`, `level.save`, `content.migrate`, `blueprint.import_t3d`)
- tout en laissant passer n'importe quel nom `editor.*` inventé

La question est maintenant `isKnown()` (une recherche dans le catalogue), et non `riskOf()`. **L'existence est une question de catalogue, pas une question de risque.**

---

## 3. Isolation des sessions et retour arrière

### Le problème

UnrealAgentLink maintient **une pile d'annulation d'agent par éditeur**, partagée par toutes les sessions DSH. Côté DSH, plusieurs sessions peuvent piloter le même éditeur en même temps.

Donc « annuler ce que ma session a fait » n'est pas une opération que le protocole prend en charge.

### L'approche

`src/sessions/state.ts` enregistre chaque étape faite par chaque session et donne à chacune un **numéro croissant globalement** (`global`). Avant d'annuler, il vérifie si les étapes de cette session forment un **suffixe LIFO net** du tampon de cet éditeur — c'est-à-dire si la dernière étape de cette session est postérieure à la dernière étape de toutes les autres sessions.

```
yes  → roll back, undoing only this session's steps
no   → undo nothing, and report both step lists
```

Mieux vaut refuser que de jeter silencieusement le travail de quelqu'un d'autre.

### `rollbackOnDispose` vaut `false` par défaut

Annuler automatiquement à la destruction d'une session semble pratique, mais **l'utilisateur ne l'a jamais demandé**. C'est désactivé par défaut ; l'activer est une déclaration explicite que « la fin de la session doit annuler son travail ».

---

## 4. Traduction des erreurs : pourquoi on ne lit pas le texte

Le texte d'erreur passe du chinois à l'anglais selon la culture de l'éditeur (`result.message`). L'analyser lierait le plugin à une seule langue, et le texte peut changer à tout moment.

`src/errors/translate.ts` classe uniquement selon le **nom de la classe d'erreur** (`NoEditorError`, `BridgeTimeoutError`, …) et le **code d'état**, en 16 types, et donne pour chacun une suggestion sur ce qu'il faut faire ensuite.

L'ordre est : d'abord le nom de classe, puis le code d'état. Parmi les codes d'état, `410` correspond à `not-found`, `422` à `precondition` et `504` à `timeout` — aucune de ces correspondances n'est évidente, ce qui explique que le contrôle 4 de `scripts/check-catalog.mjs` interroge le source C++ pour garantir une couverture complète.

**Pourquoi un classement manquant est nocif** : le repli `engine-error` dit « les paramètres sont bons, c'est l'éditeur lui-même qui est cassé ». Un code non classé envoie donc le modèle exactement dans la mauvaise direction. L'exemple le plus clair est `422` — il signifie vraiment « l'entrée était valide mais rien n'a été écrit », ce qui n'a rien à voir avec « l'éditeur est cassé ».

---

## 5. Disjoncteur et limiteur de débit

### Le disjoncteur protège l'éditeur

`src/resilience/breaker.ts`. La décision clé : **un 4xx est enregistré comme `input` et ne déclenche pas le disjoncteur.**

Le raisonnement : un agent qui fait dix mauvais appels d'affilée est **en train de travailler**, pas de tuer l'éditeur. Seuls des échecs de **transport** répétés signifient que l'éditeur lui-même va mal.

### Le limiteur de débit a corrigé un vrai bug

Le limiteur à fenêtre glissante laissait à l'origine passer le **premier appelant en file immédiatement** — donc le deuxième appel d'une rafale passait instantanément et la limite ne servait à rien. Le correctif est dans `breaker.ts:schedule()` : la première libération attend la fin de l'intervalle restant au lieu de partir immédiatement.

---

## 6. Le tampon circulaire de logs

L'éditeur pousse `log.entry` (ce qui exige `ual.ForwardLogs 1` dans l'éditeur, que ce plugin ne peut pas activer à distance).

`bridge.ts` garde un tampon circulaire de capacité 512 : filtré par niveau minimal (`Display` par défaut), ordonné par sévérité, paginé via `sinceSeq`, avec filtrage insensible à la casse sur la catégorie et le texte.

**Pourquoi le faire localement** : transmettre directement chaque ligne de log au modèle noierait son contexte. Un tampon circulaire plus un filtrage laisse l'agent tirer ce dont il a besoin au lieu de tout recevoir poussé.

---

## 7. Travail long : `ual_task`

Le protocole n'a **aucune sémantique d'annulation**. `ual_task` enveloppe un appel long dans un vrai job DSH (kind `ual`) pour que la conversation puisse continuer.

Deux choses doivent être écrites dans la description de l'outil, sinon le modèle va à coup sûr mal comprendre :

1. **Tuer le job n'arrête que l'attente de ce plugin.** Le moteur continue de tourner et le résultat finit par revenir.
2. **Pendant qu'une commande bloquante s'exécute, l'éditeur ne répond à rien** — pas même à `sequence.render_status`. Donc n'interrogez pas pendant qu'une tâche longue tourne.

---

## 8. La surface d'outils : 12, pas 170

Si chacune des 170 commandes était son propre outil, 170 schémas mangeraient le prompt de chaque requête — et l'immense majorité des requêtes n'en utilise aucun.

Donc :

- `ual_tools` liste les capacités (filtrable par famille ou mot-clé)
- `ual_schema` donne les noms de clés exacts d'une commande
- `ual_call` exécute

**Découvrir les capacités prend deux étapes, pas zéro.** C'est un compromis délibéré : un aller-retour réseau de plus en échange de 170 schémas de moins par requête.

---

## 9. Fichiers générés et tables jamais importées

Une classe de défauts revient régulièrement dans ce projet et mérite sa propre note : **une table maintenue à la main est construite, mais personne ne l'importe.**

Instances jusqu'ici :

| Table | Symptôme |
|---|---|
| `REQUIRED_KEYS` | la validation des clés requises était du code mort, et `ual_schema` n'affichait jamais `REQUIRED:` |
| `EXTRA_PARAM_KEYS` | les 4 méthodes `PARAMS_UNRESOLVED` avaient des listes de paramètres vides |
| `UAL_CODES` | `410`/`422`/`504` n'étaient pas classés et retombaient sur le trompeur `engine-error` |

Le fil conducteur : la table elle-même était correcte, documentée et revue — mais le runtime lisait un autre chemin.

La contre-mesure est de faire **demander à la source** à chaque contrôle, plutôt qu'à la table :

- contrôle 3 de `check-catalog.mjs` : chaque clé `requires` doit être un littéral présent dans le source C++
- contrôle 4 de `check-catalog.mjs` : `UAL_CODES` doit correspondre à l'ensemble des codes que le C++ envoie réellement (y compris les gardes partagées et les formes d'expression comme `Code = bOk ? 200 : 207`)
- `gen-docs.mjs --check` : la référence des commandes doit correspondre au catalogue

Ce sont tous des contrôles **non auto-justifiants** : cassez la source ou cassez la table, et l'un des deux côtés échoue.

---

## 10. Deux vrais pièges de sûreté de type

### Les propriétés `undefined` font exploser

dsh-tools exécute un pipeline en **deux étapes** lorsqu'il distribue le résultat d'un outil :

1. `snapshotJsonValue(value)` — lève `value is not lossless JSON` si **n'importe quelle** propriété propre est `undefined`
2. `validateJsonSchemaValue(schema, value)` — valide par rapport au schéma

La première étape est plus stricte que le schéma et **s'exécute en premier**, donc un test qui ne vérifie que le schéma ne peut pas attraper cette classe de bug.

Le vrai symptôme : à l'**instant** où un éditeur se connectait et avant qu'il n'ait poussé `project.info`, son enregistrement `ual_status` avait des clés comme `project: undefined` — donc « l'outil que vous lisez en premier » plantait dès qu'un éditeur apparaissait.

Le correctif est l'étalement conditionnel plutôt que d'écrire `undefined` :

```ts
...(session.info?.projectName !== undefined ? { project: session.info.projectName } : {})
```

### Le schéma de sortie doit déclarer chaque clé

Le schéma de sortie d'un outil utilise `additionalProperties: false`, et le registre le valide **clé par clé**. Donc l'`attachment` renvoyé par `ual_screenshot` doit être déclaré dans le schéma — sinon il lève `ToolOutputError` **à l'instant où une capture d'écran réussit**, alors que le chemin texte fonctionne très bien.

Le langage de schéma n'a pas de nœud `ImageAttachmentRef`, il ne peut donc être déclaré que `{ type: 'json' }`. Cela élargit le type inféré à `JsonValue`, donc le chemin de rendu doit le restreindre avec un **contrôle à l'exécution** plutôt qu'une assertion `as` :

```ts
const attachment = imageRef(record.attachment)   // validates field by field
return attachment ? [{ type: 'image', attachment }, ...blocks] : blocks
```

Le compilateur refuse un simple `as` ici (TS2352 : les deux types ne se recouvrent pas suffisamment) — c'est lui qui exige un contrôle à l'exécution, pas lui qui fait des difficultés.

---

## 11. Stratégie de vérification

```bash
npm run check
```

ce qui équivaut à :

```bash
tsc -p tsconfig.json --noEmit      # src
tsc -p tsconfig.test.json          # tests (src's tsconfig does not include tests)
vitest run                         # 154 tests
node scripts/check-catalog.mjs     # 4 reconciliation checks
```

Les tests vivent dans 7 fichiers, divisés selon **le type de défaut qu'ils peuvent détecter** :

| Fichier | Couvre |
|---|---|
| `protocol.test.ts` | le contrat de `judge()`, les règles de sérialisation |
| `translate.test.ts` | le classement et les indices pour les 16 types |
| `resilience.test.ts` | la machine à états du disjoncteur, la mise en file du limiteur de débit, `notifierFor` |
| `catalog.test.ts` | les requêtes du catalogue, la protection de la chaîne de prototypes, la porte d'approbation de bout en bout |
| `bridge.test.ts` | un vrai WebSocket : files, orphelines de délai, événements, arrêt |
| `tool-output.test.ts` | la vraie valeur de retour de chaque outil à travers le pipeline en deux étapes |
| `end-to-end.test.ts` | la vraie chaîne de contrôles + une vraie socket + les vrais schémas d'outils |

**Pourquoi `end-to-end.test.ts` doit exister** : tous les autres tests simulent une couche. Le bug `REQUIRED_KEYS` — généré, documenté, revu, jamais importé — n'a été attrapé par aucun test unitaire, parce que chaque couche était cohérente avec elle-même en isolation. Seul le câblage de la vraie chaîne de contrôles à une vraie socket, nourri par un vrai schéma, expose **la jointure entre les couches**.

Pour la même raison, `tool-output.test.ts` utilise les **vrais** `snapshotJsonValue` + `validateJsonSchemaValue` plutôt que d'écrire sa propre vérification de schéma — sinon le défaut `undefined` de `ual_status` passerait tout aussi bien.

---

## 12. Configuration

Le schéma Schemastery dans `src/config.ts` est **la source unique des valeurs par défaut**. Le `config` de `cordis.patch.yml` ne fait que réaffirmer des défauts que le schéma a déjà.

**Notez l'empilement de configuration de DSH** : une couche ultérieure **remplace** entièrement le `config` de cette ligne au lieu de le fusionner en profondeur. Pour surcharger une clé, vous devez réécrire toutes les clés que vous voulez conserver.

Des interrupteurs comme `allowDangerous` **n'existent délibérément pas** — la porte de risque passe par le point d'approbation natif `tools/pre-execute` de DSH plutôt que par un contournement inventé par le plugin lui-même.

---

## 13. Dégradation sur dépendances optionnelles

`cordis.patch.yml` déclare exactement une dépendance dure : le registre `tools` (via `inject`). Tout le reste est lu via `ctx.get` :

| Service | Quand il est absent |
|---|---|
| `jobs` | `ual_task` renvoie `kind:'background'` et explique qu'il n'est pas disponible |
| `fs` / `attachments` | les captures d'écran se rabattent sur un chemin texte plus la raison |
| `agents` | la connexion/déconnexion d'un éditeur ne notifie pas l'agent |
| `approval` | `ask` est transformé en refus par DSH |

Ainsi, une composition qui omet un service **perd une fonctionnalité** au lieu de ne pas pouvoir se charger.
