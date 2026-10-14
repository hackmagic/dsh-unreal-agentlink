<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Deutsch](README_de.md) · [Español](README_es.md) · **Français** · [Русский](README_ru.md)

# dsh-unreal-agentlink

### Un plugin DSH qui met votre éditeur Unreal sous le contrôle de votre agent.

**Pont pur. L'agent planifie ; ce plugin ne fait que traduire.**

```
DSH agent  ──tool calls──►  dsh-unreal-agentlink  ◄──WebSocket──  Unreal Editor
(plans, decides)            (this plugin: server, translator)   editor dials out
```

[Prérequis](#prérequis) · [Démarrage rapide](#démarrage-rapide) · [12 outils](#12-outils) · [Configuration](#configuration) · [Documentation](#documentation)

<code>npm install &amp;&amp; npm run check</code>

</div>

---

Votre agent sait déjà lire des fichiers et exécuter des commandes. Ce plugin lui donne l'éditeur lui-même : interroger le niveau, faire apparaître des acteurs, modifier des blueprints et des matériaux, rendre des séquences, prendre des captures d'écran qu'il peut réellement *voir*, et annuler son propre travail quand quelque chose tourne mal.

Il ne planifie **pas** les tâches. La planification appartient à l'agent natif de DSH. Ce plugin est un traducteur doté d'une couche de sécurité — il transforme l'intention de l'agent en commandes UnrealAgentLink, et les réponses de l'éditeur en quelque chose sur quoi l'agent peut agir.

---

## Prérequis

| Élément | Prérequis |
|---|---|
| Unreal Engine | 5.0 – 5.8 |
| UnrealAgentLink | le plugin C++ lui-même, à déposer dans le `Plugins/` de votre projet |
| Node.js | `^22.19.0 \|\| >=24.0.0` |
| DSH runtime | ce plugin installé comme bundle |

### Vous n'avez pas besoin d'UEBox

L'application de bureau UEBox n'est **pas une dépendance**. C'est un autre client du même éditeur qui utilise lui aussi le port 17860, donc lancer les deux en même temps crée un conflit de port — c'est toute la relation. Les preuves :

- `UnrealAgentLink.uplugin:25-34` déclare exactement deux dépendances, toutes deux fournies par le moteur : `IKRig` et `PythonScriptPlugin`. Aucun module uebox.
- Chaque entrée de `UnrealAgentLink.Build.cs` est un module du moteur (UnrealEd / AssetRegistry / MovieScene / Landscape …). Aucun SDK uebox.
- La chaîne `uebox` apparaît trois fois dans tout le code source, et uniquement dans des en-têtes `// Copyright uebox.ai`.
- Rien dans le code source n'appelle uebox.ai. La seule utilisation de `FHttpModule` lit les réglages proxy de la machine locale (`UAL_ProxyDiagnostics.cpp:167`).

Une fois le plugin dans votre projet, il fonctionne seul : `StartupModule` appelle sans condition `Init("ws://127.0.0.1:17860")` (`Core/UnrealAgentLink.cpp:86-97`), pousse `project.info` dès qu'il se connecte, et n'a ni handshake, ni jeton, ni authentification.

> Pour changer de port : `-UALServer=ws://127.0.0.1:17861` côté éditeur, et le réglage `port` de ce côté.

---

## Démarrage rapide

```bash
npm install
npm run check      # typecheck (src + tests) + 154 tests + catalog reconciliation, one command
```

Pour l'installer comme bundle DSH : `package.json` déclare `dsh.bundle.patch`, et `cordis.patch.yml` insère une ligne par nom de paquet publié — `{id: unreal-agentlink, name: dsh-unreal-agentlink}`.

> **Empilement de configuration** : une couche ultérieure **remplace** entièrement le `config` de cette ligne au lieu de le fusionner en profondeur. Pour surcharger quoi que ce soit, réécrivez toutes les clés que vous voulez conserver.

**Pour le chemin de bout en bout, voir le [tutoriel](../fr/01-tutorial.md)** — installation côté UE, première connexion, flux de travail courants, et comment lire les échecs.

---

## Documentation

| Document | Contenu |
|---|---|
| [Tutoriel](../fr/01-tutorial.md) | De bout en bout : installer le plugin, le connecter, flux de travail courants, dépannage |
| [Référence du protocole](../fr/02-protocol.md) | Formes des messages, événements, les 13 codes d'état, règles de sérialisation, sémantique des délais et de la concurrence |
| [Architecture](../fr/03-architecture.md) | La chaîne de contrôles, l'isolation des sessions et le retour arrière, la traduction des erreurs, la stratégie de vérification, les pièges rencontrés |
| [Référence des commandes](../fr/command-reference.md) | Paramètres / clés requises / clés de résultat / codes d'état pour les 170 commandes (**généré**) |

Les quatre sont disponibles dans chaque langue listée en haut de ce fichier, sous `docs/<lang>/`.

---

## Quatre faits à établir d'abord

Ce ne sont pas des choix de conception. Ce sont des contraintes existantes d'UnrealAgentLink, et elles déterminent la façon dont chaque opération est écrite.

1. **Le sens est inversé.** Ce plugin ne se connecte pas à l'éditeur — **c'est l'éditeur qui se connecte**. L'ordre de démarrage n'a pas d'importance : ouvrez l'éditeur d'abord et il réessaiera toutes les 5 secondes jusqu'à ce que le plugin apparaisse.
2. **Il n'y a pas d'authentification.** Aucun jeton, aucun en-tête, aucun sous-protocole. **Le port fait office d'identifiant**, donc il n'écoute qu'en loopback par défaut. Ne le changez pas en `0.0.0.0`.
3. **Les commandes s'exécutent en série sur le thread de jeu.** Et pendant qu'une commande bloquante s'exécute, **l'éditeur ne répond à rien** — pas même à une requête de progression comme `sequence.render_status`.
4. **Il n'y a pas d'annulation.** `query_task` et `cancel_task` n'existent pas. Tuer un job `ual_task` n'arrête que l'attente de ce plugin ; le moteur continue et le résultat finit par revenir.

---

## 12 outils

Exposer les 170 commandes sous forme de 170 outils consommerait une grande partie du prompt de chaque requête pour des capacités qu'une tâche donnée n'utilise jamais. Découvrir les capacités prend donc deux étapes, et non zéro :

| Outil | Utilité |
|---|---|
| `ual_status` | Connexions de l'éditeur / disjoncteur / limiteur de débit / session / commandes orphelines. **À lire en premier quand quelque chose va mal** |
| `ual_tools` | Lister les 170 commandes (22 familles), filtrables par famille ou mot-clé |
| `ual_schema` | Les **noms de clés exacts** d'une commande — à vérifier avant d'appeler ; UE ignore silencieusement les clés inconnues |
| `ual_call` | Exécuter une commande, renvoyer le résultat de l'éditeur tel quel |
| `ual_batch` | Plusieurs commandes en un seul aller-retour réseau (plafonné par `maxBatchCalls` ; un élément dangereux fait passer tout le lot par l'approbation) |
| `ual_screenshot` | Capturer et renvoyer une **vraie image** que l'agent peut voir |
| `ual_logs` | Lire le tampon circulaire local (la redirection côté UE est désactivée par défaut — voir le tutoriel) |
| `ual_undo` / `ual_undo_history` | Retour arrière par session / inspecter le tampon d'annulation |
| `ual_locks` | Réclamer des verrous d'assets ; l'éditeur affiche un badge « AI is editing » |
| `ual_editor_bind` | Épingler une session à un éditeur quand plusieurs sont connectés |
| `ual_task` | Transformer une commande longue et bloquante en vrai job d'arrière-plan pour que la conversation continue |

### Niveaux de risque

lecture 65 / écriture 89 / **destructeur 2 / dangereux 14** (les 16 derniers passent par l'approbation).

`tools/pre-execute` renvoie `{kind:'ask'}` pour les méthodes destructrices et dangereuses (y compris un élément dangereux à l'intérieur d'un `ual_batch`), laissant la décision à la politique de session. **Une méthode non enregistrée est refusée d'emblée** et n'atteint jamais l'éditeur.

Notez que sous une politique `never`, `ask` est automatiquement refusé — c'est la bonne lecture de « les sessions sans surveillance ne doivent pas toucher à l'éditeur ».

---

## Configuration

Les valeurs par défaut sont « vivantes mais paresseuses ». La table complète avec ses justifications est dans le [tutoriel §7](../fr/01-tutorial.md#7-configuration).

| Clé | Défaut | Signification |
|---|---|---|
| `host` / `port` | `127.0.0.1` / `17860` | Restez en loopback : sans authentification, atteindre le port c'est piloter l'éditeur |
| `timeoutMs` | `180000` | Les commandes bloquantes relèvent leurs propres planchers |
| `cacheTtlMs` / `cacheMaxEntries` | `2000` / `128` | Cache de lecture par session |
| `rateLimitRps` / `rateLimitQueue` | `5` / `32` | Commandes par seconde / plafond de file (0 désactive la limitation) |
| `breakerThreshold` / `breakerCooldownMs` | `3` / `30000` | Échecs de transport consécutifs pour ouvrir / temps de recharge |
| `logCapacity` / `logMinLevel` | `512` / `Display` | Tampon circulaire de logs |
| `logForwardingEnabled` | `false` | À mettre à `true` seulement après avoir lancé `ual.ForwardLogs` dans l'éditeur |
| `rollbackOnDispose` | `false` | Seul un suffixe LIFO est exact — voir le document d'architecture |
| `notifyOnEditorChange` | `true` | Injecte une ligne à l'agent quand un éditeur se connecte ou se déconnecte |
| `screenshotAttachments` / `screenshotMaxBytes` | `true` / 12MB | Blocs d'image / plafond de taille |
| `maxBatchCalls` | `12` | Plafond par `ual_batch` |

---

## Développement

```bash
npm run build       # tsc → lib/
npm run dev         # tsc --watch
npm run check       # typecheck + tests + catalog reconciliation (run before committing)
npm test            # tests only
npm run typecheck   # src and tests typechecked separately
```

### Organisation des sources

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
scripts/                    Catalog extraction and reconciliation, doc generation
docs/                       Tutorial / protocol / architecture / command reference
tests/                      154 tests
```

### Fichiers générés : ne pas modifier à la main

`src/catalog/method-data.ts` et `docs/command-reference.md` sont tous deux **générés** :

```bash
node scripts/extract-methods.mjs .ua-ref/plugin/UnrealAgentLink/Source   # rebuild the catalog from C++
npm run build && node scripts/gen-docs.mjs                             # rebuild the command reference
```

Une table maintenue à la main que personne n'importe est une classe de défauts récurrente dans ce projet (`REQUIRED_KEYS`, `EXTRA_PARAM_KEYS` et `UAL_CODES` en ont tous été victimes). La contre-mesure est de faire **demander à la source** à chaque contrôle, plutôt qu'à la table — voir [architecture §9](../fr/03-architecture.md#9-fichiers-générés-et-tables-jamais-importées).

### Tests et contrôles

```bash
npm run check                       # typecheck (src + tests) + 154 passed + catalog reconciliation
npm test                            # 154 passed
node scripts/check-catalog.mjs      # 170/170 zero drift; every requires key appears in C++; code set matches C++
node scripts/gen-docs.mjs --check   # is the command reference up to date
```

Les sept fichiers de tests sont divisés selon **le type de défaut qu'ils peuvent détecter**, chacun pour une raison — voir [architecture §11](../fr/03-architecture.md#11-stratégie-de-vérification).

`requires` n'est pas écrit à la main : il est dérivé des propres messages `SendError(..., 400, "Missing field: X")` des gestionnaires (28 sites), parce qu'une clé requise erronée fait rejeter par le pont un appel *valide* avant que le moteur ne le voie. Le résultat atterrit dans `method-data.ts` sous le nom `REQUIRED_KEYS`, et `requiresOf()` de `methods.ts` l'intègre à l'utilisation runtime (le rejet anticipé dans `service.call()`, la ligne `REQUIRED:` de `ual_schema` et les indices d'erreur passent tous par cette unique fonction).

Cela **ne fait que restreindre, jamais élargir** : un message contenant `or` (`"Missing field: name or path"`) est ignoré entièrement, et les clés récupérées depuis une fonction appelée dans le même fichier sont écartées comme locales à une branche — voir `REQUIRED_DROPPED` dans `scripts/extract-methods.mjs`, où chaque entrée cite son numéro de ligne C++. Donc « aucune clé récupérée » est le comportement sûr par défaut, pas un contrôle manqué.

---

## Essentiels du protocole

```
UE → plugin:  { ver:"1.0", type:"req",  method, id, params }     // id is generated by the server
plugin → UE:  { ver:"1.0", type:"res",  id, code, result }        // the key is omitted when empty
UE → plugin:  { ver,       type:"evt", method, payload }
```

- L'échec est exprimé **par `code` seul**. Il n'y a pas de champ `error` au niveau de l'enveloppe.
- Le texte lisible par un humain est dans `result.message` (chinois ou anglais selon la culture de l'éditeur — **ne l'analysez pas**) ; le détail lisible par une machine est dans `result.details`.
- **De nombreux gestionnaires renvoient `200` avec `result.ok === false`** (`editor.undo`, `blueprint.compile`, `pie.observe`), donc le plugin juge du succès avec `judge()`, et non par le code seul. Il y a 55 sites `SetStringField(TEXT("error"), ...)` répartis sur 14 fichiers C++ — c'est la norme, pas une anomalie.
- `content.import_folder` / `content.import_assets` sont des **push sortants sans réponse attendue** : pas d'`id`, pas de réponse attendue. Le plugin les transforme en logs et en notifications à l'agent et **ne fabrique pas de `res`** — répondre `ok:false` n'afficherait à l'utilisateur qu'une fausse boîte de dialogue « échec de l'import », ce qui est pire que le silence.

Le détail complet (les 13 codes d'état, les règles de sérialisation, la sémantique des délais) est dans la [référence du protocole](../fr/02-protocol.md).

---

## Licence

MIT
