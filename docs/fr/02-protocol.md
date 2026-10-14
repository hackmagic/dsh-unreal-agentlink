<div align="center">

[English](../02-protocol.md) · [简体中文](../zh/02-protocol.md) · [繁體中文](../zh-TW/02-protocol.md) · [日本語](../ja/02-protocol.md) · [한국어](../ko/02-protocol.md) · [Deutsch](../de/02-protocol.md) · [Español](../es/02-protocol.md) · **Français** · [Русский](../ru/02-protocol.md)

[README](../readme/README_fr.md) · [Tutoriel](01-tutorial.md) · **Protocole** · [Architecture](03-architecture.md) · [Référence des commandes](command-reference.md)

</div>

# Référence du protocole

Le protocole de communication d'UnrealAgentLink. Ce plugin est le **serveur** ; l'éditeur Unreal est le **client**.

Chaque conclusion ici vient du C++ sous `.ua-ref/plugin/UnrealAgentLink/Source/UnrealAgentLink/`, avec des références de fichier et de ligne aux points porteurs.

---

## 1. Connexion

| Élément | Valeur | Preuve |
|---|---|---|
| Direction | l'éditeur se connecte | `Network/UAL_NetworkManager.cpp:77` `CreateWebSocket(TargetUrl)` |
| Adresse par défaut | `ws://127.0.0.1:17860` | `Core/UnrealAgentLink.cpp:88` |
| La changer | ligne de commande `-UALServer=ws://host:port` | `Core/UnrealAgentLink.cpp:90` |
| Authentification | **aucune** — ni jeton, ni en-tête, ni sous-protocole | `CreateWebSocket` ne prend qu'une URL |
| Reconnexion | un cycle fixe de 5 secondes, sans backoff | `Network/UAL_NetworkManager.cpp:116` |
| Protection contre le blocage de connexion | oui (`ConnectTimeoutSeconds`) | `Network/UAL_NetworkManager.cpp:145-155` |

Ce plugin écoute sur 17860 avec un `maxPayload` de 64 Mo.

### Vérification de l'origine

Seules les origines loopback sont acceptées (`127.*`, `::1`, `::ffff:127.*`). L'acceptation ne s'élargit que si le `host` configuré a été **délibérément** positionné sur autre chose que `127.0.0.1` / `localhost`. La raison est dans « pas d'authentification » — le port est l'identifiant.

### Handshake

**Il n'y a pas de handshake.** Un éditeur pousse `project.info` immédiatement à la connexion, et ce plugin l'utilise pour le marquer comme identifié (`editor-identified`). Avant son arrivée, la connexion est « connectée mais non identifiée » — un tel enregistrement dans `ual_status` n'a que `sessionId` / `connectedAt` / `lastSeenAt` / `heartbeats` / `stale`, sans `project` ni compagnie.

---

## 2. Formes des messages

```
UE → plugin:  { ver:"1.0", type:"req",  method, id, params }
plugin → UE:  { ver:"1.0", type:"res",  id, code, result }
UE → plugin:  { ver:"1.0", type:"evt",  method, payload }
```

### `req` (ce plugin → éditeur)

| Champ | Notes |
|---|---|
| `ver` | toujours `"1.0"` |
| `type` | `"req"` |
| `method` | le nom de la commande, par ex. `actor.get_info` |
| `id` | généré par le **serveur**, de la forme `dsh-<uuid>` |
| `params` | optionnel. **Toute la clé est omise quand elle est vide**, et non envoyée en `null` |

`id` doit être non vide : la première ligne de `SendResponse` est `if (RequestId.IsEmpty()) { return; }` (`Utils/UAL_CommandUtils.cpp:2503-2506`) — **une requête sans id ne reçoit jamais de réponse**.

Côté éditeur, l'analyse (`Commands/UAL_CommandHandler.cpp:87-94`) lit `params` d'abord et se rabat sur le champ historique `payload`. Ce plugin n'envoie que `params`.

### `res` (éditeur → ce plugin)

| Champ | Notes |
|---|---|
| `ver` | `"1.0"` |
| `type` | `"res"` |
| `id` | fait écho à l'`id` de la requête, sert au rapprochement |
| `code` | un **nombre**, pas une chaîne |
| `result` | optionnel. **Toute la clé est omise quand il n'y a pas de contenu** |

La logique d'omission est dans `Utils/UAL_CommandUtils.cpp:2513-2516` : `result` n'est écrit que si `Data.IsValid()`.

Côté éditeur, l'analyse du corps de réponse (`Commands/UAL_CommandHandler.cpp:98-104`) essaie `result` → `data` → `payload` dans cet ordre. Ce plugin envoie `result`.

### `evt` (éditeur → ce plugin, push unidirectionnel)

| Champ | Notes |
|---|---|
| `ver` | présent quand l'événement est envoyé via `SendEvent` ; **les événements d'import de l'extension du navigateur de contenu ne le portent pas** |
| `type` | `"evt"` |
| `method` | le nom de l'événement |
| `payload` | optionnel |
| `id` | **n'existe pas** — les événements ne peuvent pas recevoir de réponse |

---

## 3. Comment l'échec est exprimé

**Par `code` seul.** Il n'y a **aucun** champ `error` au niveau de l'enveloppe dans le message.

| Code | Signification | kind du plugin |
|---|---|---|
| `200` | succès | — |
| `207` | succès partiel | `partial: true` |
| `400` | un paramètre manque ou est mal typé | `bad-params` |
| `404` | méthode ou asset inconnu | `not-found` |
| `409` | conflit (par ex. un profileur exclusif tourne déjà) | `conflict` |
| `410` | supprimé | `not-found` |
| `412` | précondition non satisfaite | `precondition` |
| `413` | au-delà d'un plafond (par ex. création par lot au-delà d'une limite de cvar) | `precondition` |
| `422` | entrée valide mais rien n'a été écrit | `precondition` |
| `500` | erreur interne de l'éditeur | `engine-error` |
| `501` | non pris en charge sur cette version | `unsupported` |
| `503` | le registre d'assets scanne encore | `registry-busy` |
| `504` | délai dépassé côté éditeur | `timeout` |

`0` n'est **jamais utilisé**.

Ces 13 codes sont définis dans `protocol/types.ts` sous le nom `UAL_CODES`, et le contrôle 4 de `scripts/check-catalog.mjs` les interroge directement dans le source C++ — y compris un 503 émis par des gardes partagées comme `FUAL_RegistryReady::Ensure`, et des formes d'expression comme `Code = bOk ? 200 : 207`. Un code manquant ou en trop fait échouer le contrôle.

### Où vit le texte d'erreur

```
result.message   ← for humans, Chinese or English by editor culture, never parse it
result.details   ← for machines (suggestions / expected_type / registry progress)
```

`SendError` construit `{message: ...}`, et la surcharge à 4 arguments attache aussi `details` (`Utils/UAL_CommandUtils.cpp:2525-2539`).

### 200 peut encore être un échec

**C'est le piège le plus facile à prendre.** De nombreux gestionnaires renvoient `200` avec `result.ok === false` :

- `editor.undo` — quand il n'y a rien à annuler
- `blueprint.compile` — quand la compilation comporte des erreurs
- `pie.observe` — quand l'observation échoue

Ce plugin juge donc du succès avec `judge(result, code)` plutôt qu'avec le code seul :

| Situation | Verdict |
|---|---|
| `code === 200`, `result.ok !== false`, `result.error` vide | succès |
| `code === 207` | succès, mais `partial: true` |
| `result.ok === false` | **échec** |
| `result.error` est une chaîne non vide | **échec** |
| `result` n'est pas un objet (ou est absent) | juger sur le code ; ne pas deviner |

Cette règle est **nécessaire** : il y a 55 sites `SetStringField(TEXT("error"), ...)` répartis sur 14 fichiers C++. Autrement dit, « 200 avec une erreur non vide » est la norme, pas une anomalie.

---

## 4. Événements

| Événement | Quand | Payload |
|---|---|---|
| `project.info` | immédiatement à la connexion, en tenant lieu de handshake | nom du projet, chemin, version du moteur, version du plugin, mode d'exécution, niveau courant, disponibilité de Python, et plus |
| `project.closed` | l'éditeur ferme le projet | — |
| `system.heartbeat` | toutes les **10 secondes** | `{}` (**toujours présent**, non omis) |
| `log.entry` | sortie de log UE (nécessite le cvar `ual.ForwardLogs 1`) | `text` / `category` / `level` |
| `content.import_folder` | l'utilisateur choisit « import to UnrealBox asset library » dans le menu contextuel du navigateur de contenu | `paths` / `real_paths` / `asset_metadata` |
| `content.import_assets` | comme ci-dessus, lancé depuis la vue du niveau | `asset_paths` / `asset_real_paths` / `asset_metadata` |

### Heartbeats et déclaration d'un éditeur mort

Les heartbeats sont un **tickeur indépendant de 10 secondes** (`Network/UAL_NetworkManager.cpp:173`), sans lien avec la reconnexion à 5 secondes. Ce plugin marque un éditeur `stale` après **45 secondes** sans heartbeat — en accord avec le front end (`Network/UAL_NetworkManager.cpp:172`).

### Les deux événements d'import sont des envois sans réponse

Ils ne portent **aucun `id`**, et l'éditeur **n'attend pas de réponse**. Le `Handle_Response` côté éditeur (`Commands/UAL_CommandHandler.cpp:185-297`) n'affiche une notification Slate que lorsqu'il reçoit un `type:"res"`, en lisant `ok` / `count` / `importedPath` / `error`.

Ce plugin est un pont pur, sans capacité d'importer des assets : il transforme donc les événements en **logs et notifications à l'agent** et **ne fabrique pas de `res`** — répondre `ok:false` n'afficherait à l'utilisateur qu'une fausse boîte de dialogue « échec de l'import », ce qui est pire que le silence.

---

## 5. Règles de sérialisation

Les paramètres sortants passent par `toSerializable()` dans `protocol/serialization.ts` avant de partir sur le réseau. C'est plus strict que `JSON.stringify`, parce que **UE traite un champ qu'elle ne peut pas lire comme « non envoyé »** — ne rien faire silencieusement est plus difficile à diagnostiquer qu'une erreur.

| Entrée | Traitement |
|---|---|
| `null` / booléen / chaîne | tel quel |
| nombre fini | tel quel |
| **nombre non fini** (`NaN` / `Infinity`) | **lève une exception** — UE le lirait comme « champ absent » |
| `undefined` (au niveau supérieur, ou dans un tableau) | **lève une exception** |
| `undefined` (comme valeur de propriété d'un objet) | **la clé est supprimée** |
| fonction / symbole / bigint | **lève une exception** |
| référence circulaire | **lève une exception** |
| `Uint8Array` | converti en chaîne base64 |
| `Date` | converti en chaîne ISO |
| `Map` (les clés doivent être des chaînes) | converti en objet simple |
| `Set` | converti en tableau |
| autres objets non simples (instances de classe, etc.) | **lève une exception** |

Seuls les objets simples, les tableaux et les scalaires JSON passent.

---

## 6. Timing et concurrence

**Les commandes pour un même éditeur sont en série.** Ce plugin garde une file d'envoi par éditeur, enchaînant chaque commande sur le `then` de la précédente. Ce n'est pas pour satisfaire le protocole — c'est parce que l'éditeur exécute de toute façon de manière synchrone jusqu'au bout sur le thread de jeu.

**Les files sont indépendantes d'un éditeur à l'autre.** Quand plusieurs éditeurs se connectent, chacun a sa propre file.

### Délais d'attente

La valeur par défaut est 180 secondes, et les commandes bloquantes relèvent leurs propres planchers (la colonne de délai de `ual_schema` les marque « blocking »).

**Un délai dépassé ne signifie pas que la commande n'a pas tourné.** Il signifie seulement que ce plugin a arrêté d'attendre. Quand cela arrive :

1. L'éditeur est marqué comme ayant une commande orpheline (`orphaned` dans `ual_status`).
2. Les **commandes courtes suivantes vers le même éditeur sont refusées d'emblée** (`queue-stalled`), plutôt que mises en file derrière un travail qui pourrait ne jamais revenir.
3. Un appel `long: true` peut encore être envoyé — c'est ainsi que s'exprime « je suis prêt à attendre ».

**Il en va de même pour les appels annulés** : tuer un job `ual_task` passe par l'abandon, et l'abandon n'arrête que l'attente de ce plugin tandis que le moteur continue. Un abandon enregistre donc aussi une orpheline.

### Déconnexion

Quand un éditeur se déconnecte, chaque requête en vol pour lui échoue avec `editor-lost`, et l'erreur porte tous les noms de méthodes.

---

## 7. Ce que ce plugin n'envoie pas

Pour être explicite sur la frontière :

- **Aucun jeton** — il n'y a pas de mécanisme d'authentification.
- **Aucun `GET /api/ual/action`** — une ancienne documentation décrivait ceci comme un service HTTP ; c'est faux.
- **Aucun polling de tâche** — `query_task` / `cancel_task` n'existent pas.
- **Aucun `res` fabriqué** — voir la section sur les événements d'import.
- **Aucune reconnexion active vers l'éditeur** — le sens est inversé ; l'éditeur réessaie tout seul toutes les 5 secondes.

---

## 8. Fichiers liés

| Fichier | Contenu |
|---|---|
| `src/protocol/types.ts` | types de message, `UAL_CODES`, `UalError` |
| `src/protocol/bridge.ts` | serveur WebSocket, files, délais, orphelines, tampon de logs |
| `src/protocol/serialization.ts` | chaque règle de sérialisation du tableau ci-dessus |
| `src/service.ts` | `judge()`, la chaîne de contrôles, le journal |
| `src/errors/translate.ts` | code d'état / nom de classe → 16 types |

Côté C++ : `Utils/UAL_CommandUtils.cpp` (`SendResponse` / `SendError` / `SendEvent`), `Commands/UAL_CommandHandler.cpp` (répartition des messages entrants), `Network/UAL_NetworkManager.cpp` (connexion, heartbeat, reconnexion).
