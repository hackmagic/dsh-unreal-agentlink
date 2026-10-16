<div align="center">

[English](../INSTALL-ai.md) · [简体中文](../zh/INSTALL-ai.md) · [繁體中文](../zh-TW/INSTALL-ai.md) · [日本語](../ja/INSTALL-ai.md) · [한국어](../ko/INSTALL-ai.md) · [Deutsch](../de/INSTALL-ai.md) · **Español** · [Français](../fr/INSTALL-ai.md) · [Русский](../ru/INSTALL-ai.md)

[README](../readme/README_es.md) · [Tutorial](01-tutorial.md) · [Protocolo](02-protocol.md) · [Arquitectura](03-architecture.md) · [Referencia de comandos](command-reference.md) · **Guía de instalación**

</div>

# Guía de instalación (legible por IA)

Este archivo está escrito para un asistente de IA que lee archivos y ejecuta los pasos en orden.
No te saltes ningún paso; cada paso tiene un resultado verificable. Para una instalación
manual, consulta el [README](../readme/README_es.md) o el [Tutorial](01-tutorial.md).

> La IA solo necesita ejecutar `scripts/install-dsh-plugin.mjs`. Ese script lo hace
> todo: reflejar → editar el manifiesto del perfil → llamar al instalador real →
> verificar el resultado compuesto. Cada paso de abajo es un **punto de verificación**:
> si un paso no coincide, detente e infórmalo. No continúes.

---

## 0. Comprobar primero (solo lectura, no instala nada)

```bash
node scripts/install-dsh-plugin.mjs --profile web --status
```

`installed copy:` y `bundle layer:` deberían decir `present` / `listed`. Solo si
dicen `(absent)` / `(not listed)` hace falta ejecutar una instalación.

Luego comprueba el lado de UnrealAgentLink:

- `Plugins/UnrealAgentLink/` existe en el proyecto y está habilitado en
  `Edit → Plugins` (el editor necesita un reinicio).
- El puerto 17860 está libre (el escritorio `uebox` reclama el mismo puerto; este plugin no lo
  necesita).

---

## 1. Instalar (un comando)

```bash
npm run build && node scripts/install-dsh-plugin.mjs --profile web --yes
```

El script realiza cinco acciones, y cada una deja una prueba:

| Paso | Artefacto | Significado en caso de fallo |
| --- | --- | --- |
| build | `lib/`, 64 archivos | ejecuta primero `npm run check`; no instales una compilación rota |
| mirror | `<profile>/.vendor/` que contiene solo las entradas de `files` | problema de disco o de permisos |
| manifest edit | `<profile>/package.json` gana una línea de dependencia + una línea de bundle | consulta §4 |
| installer | pnpm imprime `Done in Xs` | consulta §2 |
| verify | `install: ... is now a bundle layer of profile "web"` | consulta §3 |

**Solo la última línea significa que la instalación tuvo éxito.** Si los cuatro primeros
pasos pasan y el quinto falla, la capa no está compuesta y dsh no cargará el plugin.

---

## 2. Si el instalador se niega (guarda de versión)

dsh tiene una guarda a nivel de producto: una instalación se rechaza cuando las
`peerDependencies` del plugin son incompatibles con la versión de dsh del runtime. Este
proyecto declara cada peer `@deepseek-ai/dsh-*` como
`>=0.1.6-alpha.2 <0.2.0-0 || >=0.2.0-rc.1 <0.3.0`, lo que acepta tanto la versión
contra la que este plugin está construido y probado (`0.1.6-alpha.2`) como la línea `0.2.x`
de la que parte el dsh actual — así que una instalación normal en un runtime compatible **no**
se detiene aquí.

> Las dos ramas no son decoración. semver se niega a hacer coincidir una versión
> preliminar con un rango cuyos comparadores no llevan etiqueta preliminar, así que
> un `^0.1.6-alpha.2` a secas hacía que todo runtime `0.2.0-rc.*` pareciera
> incompatible. Por eso cada línea compatible necesita su propia rama con un suelo
> preliminar explícito, y el límite superior se detiene en la siguiente línea cuya
> API nadie ha probado.

La guarda sigue disparándose en un runtime fuera de esos rangos — un `0.3.x` futuro, o
un `0.1.x` anterior a `0.1.6-alpha.2`. **Esa es una decisión de producto; el script
deliberadamente no la toma por ti.** dsh imprime el comando exacto cuando
se niega:

```bash
dsh plugin --profile web allow-version dsh-unreal-agentlink@0.1.0 --dsh-version 0.2.0-rc.2 --accept-risk
```

Ejecutarlo requiere confirmación humana. Luego vuelve a ejecutar la instalación desde §1.

> `--status` muestra si la exención ya está activa en la línea
> `version guard:`.

---

## 3. Si el paso de verificación falla (capa no compuesta)

```bash
dsh --profile web --dump-config | grep unreal-agentlink
```

Esto debe imprimir:

```
# == dsh-unreal-agentlink
- id: unreal-agentlink
  name: dsh-unreal-agentlink
```

Tres causas conocidas cuando no lo hace:

1. `dsh.profile.bundles` no lista este plugin — el script debería haberlo añadido;
   comprueba `<profile>/package.json`.
2. El paquete está en `node_modules` pero no declara `dsh.bundle` — esto falla
   **ruidosamente** al cargar (`declares no dsh.bundle in its package.json`); comprueba
   el `package.json` reflejado.
3. El propio `--dump-config` da error — informa de la salida completa tal cual, no adivines.

---

## 4. Si la edición del manifiesto es rechazada por el bloqueo

```
install: <path>/package.json.lock is held by pid 18344 (DeepSeek Harness)
```

dsh protege el manifiesto de un perfil con un archivo `.lock` hermano creado con `wx`, y **un
contendiente nunca borra el bloqueo de otro portador**. El portador es la propia aplicación dsh
en ejecución.

- Para el perfil `web`: cierra la aplicación de escritorio DeepSeek Harness en ejecución, o elige
  un perfil que no esté retenido.
- Para el perfil `desktop`: el comando de *arranque* de la CLI está **prohibido**
  (`bin.js:112` `rejectElectronProfile`), pero `dsh plugin --profile desktop …` está
  deliberadamente exento (`bin.js:119`) — es la ruta que usa la propia CLI que lleva
  Desktop y que la aplicación misma invoca. El producto pide cerrar la aplicación por
  completo antes, porque una aplicación en ejecución reescribe el manifiesto desde su
  propia lista de plugins. Ciérrala, ejecuta la instalación y lanza Desktop después
  para montar la capa.
- El script se niega y nombra al portador; no lucha contra el bloqueo.

---

## 5. Verificar que el plugin funciona de verdad (estar instalado no basta)

```bash
# a) Lado del editor: abre el proyecto. El registro de UE debería mostrar una conexión.
#    (UnrealAgentLink reintenta cada 5 segundos; no se necesita conectar manualmente.)

# b) Lado de DSH: pide al agente en una sesión que «compruebe el editor con ual_status».
```

Los tres campos de `ual_status` son los criterios de aceptación:

| Campo | Esperado |
| --- | --- |
| `listening` | `true` |
| `editors` | al menos uno, que lleve un nombre de `project` |
| `orphanedMethods` | `[]` |

`listening: false` = nada está escuchando (el plugin no está cargado, o el puerto está ocupado).
`editors: []` = UE no se conectó (proyecto cerrado, plugin deshabilitado, o un desajuste de puerto).
Un `orphanedMethods` no vacío = una petición expiró pero puede seguir ejecutándose;
comprueba `ual_logs` antes de reintentar.

Luego confirma toda la ruta con una llamada mínima:

```bash
# en una sesión: ual_call { "method": "level.get_current" }
```

---

## 6. Desinstalar

```bash
node scripts/install-dsh-plugin.mjs --profile web --remove --yes
```

El script elimina tanto la dependencia como la entrada de bundle, y luego ejecuta el instalador
real para que pnpm sincronice `node_modules`. El directorio espejo
`<profile>/.vendor` se conserva y se reconstruye en la próxima instalación; bórralo a mano
si quieres que desaparezca.

---

## Reglas duras para la IA

1. **No** edites las `peerDependencies` de este proyecto para hacer pasar una instalación —
   eso ocultaría una incompatibilidad de versión real.
2. **No** edites a mano `<profile>/package.json`; el script lo hace y
   comprueba el bloqueo.
3. **No** trates `--accept-risk` como automáticamente ejecutable; necesita confirmación
   humana.
4. Si la salida de cualquier paso difiere de lo descrito, **detente e informa de la
   salida tal cual**; no «pruebes una solución y vuelvas a ejecutar».
5. Cada paso de aquí puede reverificarse con comandos de solo lectura (`--status`,
   `--dump-config`, `ual_status`).
