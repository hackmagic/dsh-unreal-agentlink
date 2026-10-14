<div align="center">

[English](../01-tutorial.md) · [简体中文](../zh/01-tutorial.md) · [繁體中文](../zh-TW/01-tutorial.md) · [日本語](../ja/01-tutorial.md) · [한국어](../ko/01-tutorial.md) · [Deutsch](../de/01-tutorial.md) · [Español](../es/01-tutorial.md) · **Français** · [Русский](../ru/01-tutorial.md)

[README](../readme/README_fr.md) · **Tutoriel** · [Protocole](02-protocol.md) · [Architecture](03-architecture.md) · [Référence des commandes](command-reference.md)

</div>

# Tutoriel : de zéro à un pont fonctionnel

C'est le chemin de bout en bout. Le but : permettre à un agent dans DSH de piloter réellement votre éditeur Unreal local, et savoir ce qu'il doit faire et ce qui va bloquer.

Ordre de lecture conseillé : cette page → [protocole](02-protocol.md) → [architecture](03-architecture.md) → [référence des commandes](command-reference.md).

---

## 1. Modèle mental : quatre faits d'abord

Avant de toucher à quoi que ce soit, ces quatre faits déterminent la façon dont chaque opération ultérieure est écrite. Ce ne sont pas des choix de conception — ce sont des contraintes existantes d'UnrealAgentLink.

**① Le sens est inversé.** Ce plugin ne se connecte pas à l'éditeur ; **c'est l'éditeur qui se connecte**. Le plugin C++ UnrealAgentLink ouvre sans condition `ws://127.0.0.1:17860` dans `StartupModule`, et ce plugin écoute sur ce port. L'ordre de démarrage n'a donc pas d'importance : si l'éditeur démarre le premier, il réessaie toutes les 5 secondes et se connecte dès que le plugin apparaît.

**② Il n'y a pas d'authentification.** Aucun jeton, aucun en-tête, aucun sous-protocole. **Le port lui-même fait office d'identifiant** — quiconque peut atteindre 17860 peut piloter l'éditeur. C'est pourquoi il n'écoute qu'en loopback par défaut, et pourquoi vous ne devriez pas le passer en `0.0.0.0`.

**③ Les commandes s'exécutent en série sur le thread de jeu.** Quand l'éditeur reçoit une commande, il la reposte sur le thread de jeu si elle n'y est pas déjà, puis **l'exécute de manière synchrone jusqu'au bout**. Deux conséquences :

- Les commandes destinées au même éditeur se mettent naturellement en file, et ce plugin envoie aussi en série pour chaque éditeur.
- **Pendant qu'une commande bloquante s'exécute, l'éditeur ne répond à rien** — pas même à une requête de progression comme `sequence.render_status`. Tout ce que vous envoyez d'autre se contente de faire la file derrière elle.

**④ Il n'y a pas d'annulation.** `query_task` / `cancel_task` n'existent pas dans le protocole. Tuer un job `ual_task` n'arrête que **l'attente de ce plugin** ; le moteur continue de tourner et le résultat finit par revenir. Cette phrase est écrite dans la description de l'outil `ual_task` pour que le modèle la lise.

---

## 2. Prérequis

| Élément | Prérequis | Notes |
|---|---|---|
| Unreal Engine | 5.0 – 5.8 | la plage déclarée dans le `.uplugin` du plugin |
| UnrealAgentLink | le plugin C++ lui-même | à copier dans le `Plugins/` du projet |
| Node.js | `^22.19.0 \|\| >=24.0.0` | voir `engines` dans `package.json` |
| DSH runtime | toute installation fonctionnelle | ce plugin est chargé comme bundle |

**Vous n'avez pas besoin de l'application de bureau UEBox.** C'est un autre client du même éditeur qui utilise lui aussi le port 17860, donc lancer les deux en même temps crée un conflit de port. Voir [README § « Vous n'avez pas besoin d'UEBox »](../readme/README_fr.md#vous-navez-pas-besoin-duebox).

### Installer UnrealAgentLink dans un projet UE

1. Copiez tout le répertoire `UnrealAgentLink` dans le `Plugins/` du projet (ou le `Plugins/` du moteur pour une installation globale).
2. Régénérez les fichiers de projet et ouvrez le projet.
3. Confirmez qu'UnrealAgentLink est activé sous **Edit → Plugins**.

Le plugin active automatiquement ses deux dépendances fournies par le moteur, `IKRig` et `PythonScriptPlugin` (voir le `.uplugin`). Dès que l'éditeur démarre, il commence à se connecter à 17860 sans aucune configuration.

> Si le port est pris (par exemple par l'application de bureau UEBox), donnez-en un autre à l'éditeur :
> `UnrealEditor.exe MyProject.uproject -UALServer=ws://127.0.0.1:17861`
> et changez le réglage `port` de ce côté pour correspondre.

---

## 3. Installer ce plugin

```bash
git clone <this-repo> dsh-unreal-agentlink
cd dsh-unreal-agentlink
npm install
npm run check      # typecheck + 154 tests + catalog reconciliation, one command
```

`npm run check` doit être entièrement vert avant d'aller plus loin. Il vérifie trois choses : les sources et les types des tests compilent, les tests de comportement passent tous, et le catalogue des 170 commandes s'aligne sur le registre C++, entrée par entrée.

### Installer comme bundle DSH

`package.json` déclare `dsh.bundle.patch: ./cordis.patch.yml`, et ce fichier ne fait qu'une chose :

```yaml
- insert:
    - id: unreal-agentlink
      name: dsh-unreal-agentlink
```

**Remarque** : dans l'empilement de configuration de DSH, une couche ultérieure **remplace** entièrement le `config` de cette ligne au lieu de le fusionner en profondeur. Pour surcharger une clé, vous devez réécrire toutes les clés que vous voulez conserver.

---

## 4. Première connexion

### Étape 1 : confirmer que le pont est vivant

Faites appeler `ual_status` par l'agent. Surveillez quatre champs :

```
listening: true
url: ws://127.0.0.1:17860
editors: [ { sessionId: "ue-xxxxxxxx", project: "MyProject", ... } ]
```

- `listening: false` → le plugin n'a pas démarré, ou le port est pris. Cherchez `EADDRINUSE` dans le log DSH.
- `listening: true` mais `editors: []` → le pont attend. Confirmez que le projet UE est ouvert et qu'UnrealAgentLink est activé.

Pendant le **premier instant** après la connexion d'un éditeur, son enregistrement ne contient que `sessionId` / `connectedAt` / `lastSeenAt` / `heartbeats` / `stale` — des champs comme `project` n'apparaissent qu'une fois que l'éditeur a poussé `project.info`. C'est un état normal, pas une erreur.

### Étape 2 : découvrir les capacités

Ne devinez pas les noms de commandes. Deux étapes :

```
ual_tools  { filter: "material" }        → list the material family with a one-line summary each
ual_schema { method: "material.create" } → that command's param keys, required keys, result keys, status codes
```

Les noms de clés de `ual_schema` sont **extraits tels quels** des gestionnaires C++. Ne sautez pas cette étape : **UE ignore silencieusement les clés inconnues ou mal typées** — un nom de clé mal orthographié ne provoque pas d'erreur, il « réussit » simplement à ne rien faire.

### Étape 3 : le premier vrai appel

```
ual_call { method: "level.get_current" }
```

Lecture pure, aucun effet de bord. Il renvoie le `result` de l'éditeur **tel quel** ; ce plugin ne le remodèle pas.

### Étape 4 : regarder le niveau

```
ual_screenshot { width: 1280, height: 720 }
```

Ce qui revient est une **vraie image** que l'agent peut voir directement. C'est préférable à `ual_call { method: "editor.screenshot" }`, qui ne renvoie qu'un chemin de fichier.

Si `pending_shaders` / `pending_assets` d'une capture d'écran sont non nuls, la vue est encore en compilation ou en streaming et **n'est pas l'aspect final**. Ne concluez pas qu'un matériau est cassé à partir d'elle.

---

## 5. Flux de travail courants

### Modifier la propriété d'un acteur

```
ual_schema { method: "actor.set_property" }        # check key names first
ual_call   { method: "actor.get_info", params: { targets: { names: ["Cube_1"] } } }
ual_call   { method: "actor.set_property", params: {
               targets: { names: ["Cube_1"] },
               properties: { Mobility: "Movable" } } }
```

Quand un nom de propriété est mal orthographié, l'éditeur **renvoie des suggestions** plutôt qu'un 404. Lisez les suggestions ; ne réessayez pas la faute d'orthographe.

### Opérations par lot

Pour une séquence de travail connue, utilisez `ual_batch` pour la faire en un seul aller-retour réseau :

```
ual_batch { calls: [
  { method: "actor.spawn", params: { asset_id: "cube", name: "A" } },
  { method: "actor.spawn", params: { asset_id: "cube", name: "B" } },
  { method: "actor.get_info", params: { targets: { names: ["A", "B"] } } }
] }
```

- S'exécute en série (l'éditeur est en série de toute façon), et **s'arrête au premier échec** par défaut ; `continueOnError: true` change cela.
- Plafonné par `maxBatchCalls` (12 par défaut).
- **Si un seul élément est dangereux, tout le lot passe par l'approbation.** L'invite d'approbation nomme l'élément en question.

### Tâches longues

Les commandes qui bloquent le thread de jeu doivent passer par `ual_task` :

```
ual_task { method: "sequence.render", params: { sequence_path: "/Game/Seq/Main" }, label: "Render main sequence" }
```

Il renvoie immédiatement un `jobId` et la conversation continue. Récupérez le résultat avec `job_output`.

Lesquelles sont longues : `sequence.render`, `cpp.compile`, `level.build`, `blueprint.compile_all`, `pcg.execute`, `pie.run`, les imports d'assets. La colonne de délai de `ual_schema` les marque « blocking ».

**N'interrogez pas** l'éditeur pendant qu'une tâche longue s'exécute — il ne répondra pas.

### Annulation

```
ual_undo_history            # see what is in the buffer first
ual_undo { dryRun: true }   # rehearse
ual_undo                    # actually undo
```

UnrealAgentLink maintient **une pile d'annulation d'agent indépendante par éditeur**, distincte de l'historique Ctrl+Z de l'utilisateur. Ce plugin enregistre à quelle session DSH appartient chaque étape et **n'annule que lorsque les étapes de cette session forment un suffixe LIFO net du tampon**. Si une autre session a touché l'éditeur entre-temps, l'outil **n'annule rien** et rapporte les deux listes d'étapes plutôt que de jeter silencieusement le travail de quelqu'un d'autre.

### Réclamer des verrous d'assets

Avant une modification d'asset en plusieurs étapes :

```
ual_locks { claim: ["/Game/Materials/M_Rock"] }
... make changes ...
ual_locks { release: ["/Game/Materials/M_Rock"] }
```

L'éditeur affiche un badge « AI is editing » dans le navigateur de contenu, et l'utilisateur est averti s'il commence à le modifier à la main. Les réclamations de plusieurs sessions sont fusionnées par ce plugin en une seule table avant l'envoi, et renvoyées après la reconnexion d'un éditeur.

### Lire les logs

```
ual_logs { level: "Warning", contains: "Niagara" }
```

Le tampon circulaire de logs est vide par défaut — la redirection des logs côté UE est **désactivée par défaut** et nécessite de lancer `ual.ForwardLogs 1` dans l'éditeur (ce plugin ne peut pas l'activer à distance). `ual_logs` le dit quand il ne renvoie rien.

Sans redirection, utilisez plutôt le journal de messages du moteur :

```
ual_call { method: "messagelog.list", params: { limit: 50 } }
```

---

## 6. Lire les échecs

Ce plugin **n'analyse jamais le texte d'erreur** (le texte passe du chinois à l'anglais selon la culture de l'éditeur). Il classe uniquement selon le **nom de la classe d'erreur et le code d'état**, en 16 types.

| kind | Signification | Que faire |
|---|---|---|
| `no-editor` | aucun éditeur n'est connecté | ouvrez le projet UE ; confirmez que le plugin est activé |
| `timeout` | délai dépassé, **la commande tourne peut-être encore** | **ne la renvoyez pas**. Confirmez d'abord l'état réel avec une commande de lecture |
| `editor-lost` | l'éditeur s'est déconnecté | attendez sa reconnexion à 5 secondes |
| `queue-stalled` | une commande antérieure a expiré | vérifiez `orphaned` dans `ual_status` |
| `circuit-open` | des échecs de transport répétés ont ouvert le disjoncteur | arrêtez-vous, attendez le temps de recharge, vérifiez `ual_status` |
| `rate-limited` | la file de limitation de débit est pleine | ralentissez |
| `not-found` | méthode ou asset inconnu | utilisez `ual_tools` pour trouver le vrai nom de commande |
| `bad-params` | un paramètre manque ou est mal typé | vérifiez les noms de clés avec `ual_schema` |
| `precondition` | une précondition a échoué (412/413/422) | lisez `details` ; 422 signifie « entrée valide mais rien n'a été écrit » |
| `registry-busy` | le registre d'assets scanne encore | interrogez `content.registry_status` |
| `unsupported` | cette version de l'éditeur ne le prend pas en charge | par ex. `anim.*` nécessite UE 5.5+ |
| `engine-error` | l'éditeur lui-même a échoué | lisez `result.message` (pour les humains) et `details` (pour les machines) |

**Le délai dépassé est le type qui exige le plus de discipline.** Le protocole n'a pas d'annulation, donc un délai dépassé ne signifie que « ce plugin a arrêté d'attendre » — la commande tourne très probablement encore sur le thread de jeu. La bonne réponse : vérifiez `orphaned` dans `ual_status`, puis vérifiez l'état réel avec une commande en lecture seule, et **ne la renvoyez pas**.

---

## 7. Configuration

Chaque clé est modifiable, et les valeurs par défaut sont « vivantes mais paresseuses ». La table complète est dans [README § Configuration](../readme/README_fr.md#configuration). Quelques-unes méritent d'être notées :

- **`port`** — changez-la ici et le côté UE aura besoin de `-UALServer=` aussi.
- **`rateLimitRps: 0`** — désactive la limitation de débit.
- **`rollbackOnDispose: false`** — n'annule **pas** automatiquement à la fin d'une session. L'activer signifie un retour arrière à la destruction de la session, ce qui est généralement une surprise que l'utilisateur n'a pas demandée.
- **`logForwardingEnabled: false`** — à mettre à `true` seulement après avoir lancé `ual.ForwardLogs 1` dans l'éditeur.

---

## 8. Dépannage

**`ual_status` affiche `listening: true` mais aucun éditeur**
Le projet UE n'est pas ouvert, ou UnrealAgentLink n'est pas activé. Vous pouvez aussi vérifier `LogUALNetwork` dans le log de l'éditeur : normalement vous devriez voir `Connecting to ws://127.0.0.1:17860` et `Connected to`.

**`EADDRINUSE` au démarrage**
17860 est pris. Le plus souvent par l'application de bureau UEBox. Fermez-la, ou déplacez à la fois l'éditeur et ce plugin vers un autre port.

**Toutes les commandes renvoient `unknown-method` ou sont refusées d'emblée**
Ce plugin ne laisse passer que les 170 commandes qui existent réellement dans son catalogue. Utilisez `ual_tools` pour confirmer le nom. Les commandes dépréciées (comme `editor.play`, `take_screenshot`) renvoient le remplacement à utiliser.

**Les captures d'écran sont noires ou à moitié faites**
Vérifiez `pending_shaders` / `pending_assets`. Une valeur non nulle signifie que la compilation ou le streaming n'est pas terminé. Augmentez `warmup_frames` et réessayez.

**`ual_undo` refuse de s'exécuter**
Les étapes de cette session ne forment pas un suffixe LIFO net du tampon — une autre session a touché l'éditeur entre-temps. C'est une **protection délibérée**, pas un bug. Utilisez `ual_undo_history` pour voir le contenu réel.

**Un changement de configuration n'a eu aucun effet**
L'empilement de configuration de DSH **remplace** entièrement le `config` de cette ligne au lieu de le fusionner en profondeur. Vous devez écrire toutes les clés que vous voulez conserver.

**`ual_task` a tué le job mais l'éditeur est encore occupé**
Attendu. Le protocole n'a pas d'annulation. Attendez qu'il finisse — ou, plus pragmatique, n'envoyez pas d'autres commandes pendant qu'une tâche longue s'exécute.

---

## 9. Prochaines étapes

- [Référence du protocole](02-protocol.md) — formes des messages, événements, codes d'état
- [Architecture](03-architecture.md) — le raisonnement derrière la chaîne de contrôles, l'isolation des sessions et la traduction des erreurs
- [Référence des commandes](command-reference.md) — tous les paramètres et clés de résultat des 170 commandes (généré)
