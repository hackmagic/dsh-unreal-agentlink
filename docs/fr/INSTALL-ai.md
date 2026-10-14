<div align="center">

[English](../INSTALL-ai.md) · [简体中文](../zh/INSTALL-ai.md) · [繁體中文](../zh-TW/INSTALL-ai.md) · [日本語](../ja/INSTALL-ai.md) · [한국어](../ko/INSTALL-ai.md) · [Deutsch](../de/INSTALL-ai.md) · [Español](../es/INSTALL-ai.md) · **Français** · [Русский](../ru/INSTALL-ai.md)

[README](../readme/README_fr.md) · [Tutoriel](01-tutorial.md) · [Protocole](02-protocol.md) · [Architecture](03-architecture.md) · [Référence des commandes](command-reference.md) · **Guide d'installation**

</div>

# Installation (version lisible par IA)

Ce fichier est écrit pour un assistant IA qui lit des fichiers et exécute des étapes dans l'ordre.
Ne sautez aucune étape ; chaque étape a un résultat vérifiable. Pour une installation humaine, voir le
[README](../../README.md) ou le [tutoriel](01-tutorial.md).

> L'IA n'a qu'à exécuter `scripts/install-dsh-plugin.mjs`. Ce script fait
> tout : miroir → modifier le manifeste de profil → appeler le vrai
> programme d'installation → vérifier le résultat composé. Chaque étape
> ci-dessous est un **point de vérification** : si une étape ne correspond
> pas, arrêtez-vous et signalez-le. Ne continuez pas.

---

## 0. Vérifier d'abord (en lecture seule, n'installe rien)

```bash
node scripts/install-dsh-plugin.mjs --profile web --status
```

`installed copy:` et `bundle layer:` devraient afficher `present` / `listed`. Ce n'est que
s'ils affichent `(absent)` / `(not listed)` qu'une installation doit être lancée.

Puis vérifiez le côté UnrealAgentLink :

- `Plugins/UnrealAgentLink/` existe dans le projet et est activé sous
  `Edit → Plugins` (l'éditeur a besoin d'un redémarrage).
- Le port 17860 est libre (`uebox` desktop réclame le même port ; ce plugin n'en a pas
  besoin).

---

## 1. Installer (une seule commande)

```bash
npm run build && node scripts/install-dsh-plugin.mjs --profile web --yes
```

Le script effectue cinq actions, chacune laissant une trace :

| Étape | Artefact | Signification en cas d'échec |
| --- | --- | --- |
| build | `lib/`, 64 fichiers | exécutez d'abord `npm run check` ; n'installez pas un build cassé |
| mirror | `<profile>/.vendor/` ne contenant que les entrées `files` | problème de disque ou de permission |
| manifest edit | `<profile>/package.json` gagne une ligne de dépendance + une ligne de bundle | voir §4 |
| installer | pnpm affiche `Done in Xs` | voir §2 |
| verify | `install: ... is now a bundle layer of profile "web"` | voir §3 |

**Seule la dernière ligne signifie que l'installation a réussi.** Si les quatre premières
étapes passent et que la cinquième échoue, la couche n'est pas composée et dsh ne
chargera pas le plugin.

---

## 2. Si le programme d'installation refuse (contrôle de version)

dsh a un contrôle au niveau produit : une installation est refusée lorsque les
`peerDependencies` du plugin sont incompatibles avec la version de dsh du runtime.
Ce projet épingle `@deepseek-ai/*` à `0.1.6-alpha.2` alors que le dsh livré est
`0.2.0-rc.2`, l'installation s'arrête donc ici.

**C'est une décision produit ; le script ne la prend délibérément pas à votre place.**
Il affiche la commande exacte :

```bash
dsh plugin --profile web allow-version dsh-unreal-agentlink@0.1.0 --dsh-version 0.2.0-rc.2 --accept-risk
```

Son exécution requiert une confirmation humaine. Puis relancez l'installation depuis §1.

> `--status` indique sur la ligne `version guard:` si l'exemption est déjà active.

---

## 3. Si l'étape de vérification échoue (couche non composée)

```bash
dsh --profile web --dump-config | grep unreal-agentlink
```

Cela doit afficher :

```
# == dsh-unreal-agentlink
- id: unreal-agentlink
  name: dsh-unreal-agentlink
```

Trois causes connues lorsque ce n'est pas le cas :

1. `dsh.profile.bundles` ne liste pas ce plugin — le script aurait dû l'ajouter ;
   vérifiez `<profile>/package.json`.
2. Le paquet est dans `node_modules` mais ne déclare aucun `dsh.bundle` — cela échoue
   **bruyamment** au chargement (`declares no dsh.bundle in its package.json`) ; vérifiez
   le `package.json` mis en miroir.
3. `--dump-config` lui-même échoue — signalez la sortie complète telle quelle, ne devinez pas.

---

## 4. Si la modification du manifeste est refusée par un verrou

```
install: <path>/package.json.lock is held by pid 18344 (DeepSeek Harness)
```

dsh protège un manifeste de profil par un fichier frère `.lock` créé en `wx`, et **un
contendant ne supprime jamais le verrou d'un autre détenteur**. Le détenteur est
l'application dsh en cours d'exécution elle-même.

- Pour le profil `web` : fermez l'application de bureau DeepSeek Harness en cours
  d'exécution, ou choisissez un profil qui n'est pas détenu.
- Pour le profil `desktop` : la CLI est **interdite** (`bin.js:38`
  `rejectElectronProfile`) ; seule l'application Electron peut le gérer, ou fermez
  l'application et modifiez à la main.
- Le script refuse et nomme le détenteur ; il ne lutte pas contre le verrou.

---

## 5. Vérifier que le plugin fonctionne réellement (être installé ne suffit pas)

```bash
# a) Côté éditeur : ouvrez le projet. Le log UE devrait afficher une connexion.
#    (UnrealAgentLink réessaie toutes les 5 secondes ; aucune connexion manuelle n'est nécessaire.)

# b) Côté DSH : demandez à l'agent dans une session de « vérifier l'éditeur avec ual_status ».
```

Les trois champs de `ual_status` sont les critères d'acceptation :

| Champ | Attendu |
| --- | --- |
| `listening` | `true` |
| `editors` | au moins un, portant un nom `project` |
| `orphanedMethods` | `[]` |

`listening: false` = rien n'écoute (plugin non chargé, ou port pris).
`editors: []` = UE ne s'est pas connecté (projet fermé, plugin désactivé, ou un port inadapté).
Un `orphanedMethods` non vide = une requête a expiré mais tourne peut-être encore ;
consultez `ual_logs` avant de réessayer.

Puis confirmez le chemin complet avec un appel minimal :

```bash
# dans une session : ual_call { "method": "level.get_current" }
```

---

## 6. Désinstaller

```bash
node scripts/install-dsh-plugin.mjs --profile web --remove --yes
```

Le script supprime à la fois la dépendance et l'entrée de bundle, puis exécute le vrai
programme d'installation pour que pnpm synchronise `node_modules`. Le répertoire miroir
`<profile>/.vendor` est conservé et reconstruit à la prochaine installation ; supprimez-le
à la main si vous voulez vous en débarrasser.

---

## Règles strictes pour l'IA

1. **Ne modifiez pas** les `peerDependencies` de ce projet pour faire passer une
   installation — cela masquerait une véritable incompatibilité de version.
2. **Ne modifiez pas** `<profile>/package.json` à la main ; le script le fait et il
   vérifie le verrou.
3. **Ne traitez pas** `--accept-risk` comme automatiquement exécutable ; il requiert une
   confirmation humaine.
4. Si la sortie d'une étape diffère de ce qui est décrit, **arrêtez-vous et signalez la
   sortie telle quelle** ; n'essayez pas de « corriger et relancer ».
5. Chaque étape ici peut être revérifiée avec des commandes en lecture seule (`--status`,
   `--dump-config`, `ual_status`).
