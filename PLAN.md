# Agent Webhook Bridge — Plan

> Llevar la funcionalidad de `/webhook` de free-code (recibir eventos/triggers externos que
> despiertan al agente) a **cualquier** coding agent — Claude Code, Cursor, Codex CLI, etc. —
> sin depender de que ese agente tenga una API de extensión propia.

Fecha del plan: 2026-07-02
Estado: **borrador para discusión**, sin implementar.

---

## 1. Objetivo

Hoy free-code puede recibir un `POST` externo (de Flowise, CI, GitHub, lo que sea) y:
- encolarlo para que el agente lo lea cuando quiera (`queue`), o
- **despertar al agente inmediatamente** e inyectarle el evento como mensaje (`trigger`).

Quiero el mismo comportamiento pero para agentes que **no son free-code** — Claude Code "pelado",
Cursor, Codex CLI — sin tener que forkearlos ni depender de que ellos agreguen la feature.

## 2. Cómo lo resuelve free-code (referencia)

Archivo clave: `packages/coding-agent/default-extensions/webhook-receiver/` (`_server.ts`,
`_registry.ts`, `index.ts`, `_config.ts`). Resumen del diseño:

- Un servidor HTTP local (`127.0.0.1:8787+`) expone `POST /hook/:name`.
- Cada hook tiene secreto compartido (`X-Webhook-Secret`) u opcionalmente HMAC (`X-Signature`).
- Modo `queue`: el evento se guarda en memoria; el agente lo drena con tools
  (`poll_webhook_events`, `wait_for_webhook_event`).
- Modo `trigger`: el evento se inyecta con `sendUserMessage()` — una función que **solo existe
  porque webhook-receiver está cargado como extensión interna del propio proceso del agente**, no
  como un servidor MCP externo.

El propio doc de free-code lo dice explícito (`web-docs/webhooks.html`):

> "An MCP server can't start an agent turn — it only answers when called. Waking the agent from
> an incoming event needs the extension API (`sendUserMessage()`)."

Esa frase es la restricción central de todo este plan: **un MCP server nunca puede "despertar" a
un agente por su cuenta**, porque el protocolo MCP es estrictamente petición→respuesta iniciado
por el cliente (el agente). Ningún agente de terceros nos va a dar un equivalente a
`sendUserMessage()` vía MCP. Hay que rodear esa limitación distinto para cada agente.

## 3. Qué puede hacer cada agente hoy (investigado)

| Agente | CLI headless / one-shot | Soporte MCP | Forma de "despertar" sin extensión propia |
|---|---|---|---|
| **Claude Code** | `claude -p "prompt"` (print mode) o `claude --resume <sessionId> "prompt"` si el evento trae `sessionId` | Sí, cliente MCP estándar | **Hooks nativos**: `Stop` puede bloquear el fin de turno y `UserPromptSubmit`/`Stop` pueden inyectar `additionalContext` desde un script externo. Esto permite un "auto-poll" real dentro de una sesión viva, sin spawnear procesos nuevos. |
| **Cursor** | `cursor-agent -p "prompt"` / `cursor --headless "prompt" --branch ...` | Sí, mismo `mcp.json` que el editor | MCP en modo headless/print es poco confiable — hay bugs reportados (MCP no responde en print mode). La vía confiable es **spawnear** `cursor-agent -p` desde afuera cuando llega un evento. |
| **Codex CLI** | `codex exec "prompt"` (no interactivo) | Sí, vía `config.toml` | En `codex exec` las tool calls de MCP quedan auto-canceladas porque no hay TTY para aprobarlas, salvo que se use `--dangerously-bypass-approvals-and-sandbox` (riesgoso). La vía confiable también es **spawnear** `codex exec` desde afuera con el evento ya embebido en el prompt. |

Conclusión: no existe un mecanismo único. Necesitamos un **broker central** más **adaptadores por
agente**, y el adaptador "de verdad confiable" para Cursor y Codex es *lanzar un proceso nuevo*
cuando llega un evento (equivalente a `trigger`), no pedirle al agente que haga polling por MCP
dentro de una sesión ya abierta. Para Claude Code sí hay una vía nativa dentro de una sesión viva
(hooks), que es estrictamente mejor cuando aplica.

## 4. Arquitectura propuesta

```
                         ┌─────────────────────────────┐
  sistema externo  POST  │   agent-webhook-bridge       │
  (GitHub, CI,     ───▶  │   broker daemon (siempre     │
   Flowise, ...)         │   corriendo, no vive dentro  │
                         │   de ninguna sesión de agente)│
                         │                              │
                         │  - HTTP :8787 /hook/:name    │
                         │  - cola persistente (sqlite)  │
                         │  - modos: queue | trigger     │
                         │  - auth: secret / HMAC        │
                         └──────────────┬───────────────┘
                                        │
                 ┌──────────────────────┼───────────────────────┐
                 │                      │                       │
        (A) MCP adapter         (B) hook adapter          (C) spawn adapter
        (pull, "queue")         (Claude Code, live)        (push, "trigger")
                 │                      │                       │
        agente llama tools     Stop/UserPromptSubmit     lanza `claude -p` o
        poll_events/           hook lee la cola y         `claude --resume <sid>`
        wait_for_event         devuelve additionalContext (según header
        cuando el usuario                                 `sessionId`),
        se lo pide                                         `cursor-agent -p`,
                                                            `codex exec` con el
                                                            evento como prompt
```

> Nota (Claude Code, adaptador de spawn): si la request del webhook trae un header `sessionId`,
> se relanza esa sesión existente (`claude --resume <sessionId> "<prompt>"`); si no viene ese
> header, se arranca una sesión nueva (`claude -p "<prompt>"`).

### 4.1 Broker daemon (el corazón, agnóstico de agente)

- Es básicamente un **puerto standalone del `webhook-receiver` de free-code**, pero:
  - corre como proceso propio (systemd user service / launchd / pm2), no dentro de un agente,
  - persiste la cola en disco (SQLite) en vez de memoria, porque acá el consumidor puede tardar
    minutos u horas en levantarse (a diferencia de una sesión de free-code que ya está viva),
  - por cada hook registrado, guarda además **qué adaptador de salida usar** (`mcp`, `spawn:claude`,
    `spawn:cursor`, `spawn:codex`, o una combinación).
- Reusa el modelo de seguridad de free-code: bind a `127.0.0.1`, secreto obligatorio por hook,
  HMAC opcional, límite de tamaño de body, y `publicBaseUrl` + túnel (`cloudflared`/`ngrok`) para
  fuentes que no corren en la máquina local.

### 4.2 Adaptador MCP (modo `queue`, pull)

- Server MCP mínimo (`list_hooks`, `poll_events`, `wait_for_event`, `ack_event`) que habla con el
  broker por HTTP local.
- Se instala una vez en `~/.claude/mcp.json` (Claude Code) o `~/.cursor/mcp.json` (Cursor) /
  `~/.codex/config.toml` (Codex).
- Sirve para el caso "estoy con el agente trabajando y en algún momento le pido que revise si
  llegó algo", o para que el propio agente, dentro de una tarea larga, chequee la cola cada tanto
  por instrucción explícita del usuario/system prompt. **No** resuelve el "despertar solo".

### 4.3 Adaptador de hooks (modo casi-`trigger`, solo Claude Code, sesión viva)

- Un hook `Stop` (y opcionalmente `UserPromptSubmit`) configurado en `~/.claude/settings.json`
  que ejecuta un script corto: pregunta al broker "¿hay algo pendiente para este hook?", y si hay,
  devuelve `additionalContext` con el payload y bloquea el `Stop` para forzar que Claude siga
  trabajando sobre ese evento.
- Efecto práctico: mientras haya una sesión de Claude Code abierta e inactiva entre turnos, el
  hook la "reengancha" con el evento nuevo — sin spawnear un proceso nuevo. Es lo más parecido al
  `sendUserMessage()` real que existe fuera de free-code.
- Limitación: solo actúa en los bordes de turno (`Stop`), no en medio de una ejecución larga, y
  solo aplica a Claude Code.

### 4.4 Adaptador de spawn (modo `trigger` real, universal)

- Un **runner** (proceso separado, parte del broker o un worker satélite) que:
  1. escucha la cola en modo `trigger` (o hace long-poll contra el broker),
  2. arma un prompt a partir del payload del evento (con una plantilla configurable por hook),
  3. invoca la CLI del agente correspondiente en modo headless:
     - **Claude Code**: si la request entrante trae el header `sessionId`, se relanza esa sesión con
       `claude --resume <sessionId> "<prompt>"`; si no viene ese header, se arranca una sesión nueva
       con `claude -p "<prompt>" --output-format json`.
     - `cursor-agent -p "<prompt>" --force` o `cursor --headless "<prompt>" --branch ...` (Cursor)
     - `codex exec "<prompt>"` (Codex CLI)
  4. guarda el resultado/log y, opcionalmente, notifica de vuelta (Slack, otro webhook, etc.).
- Esto es universal porque **no depende de que el agente esté corriendo** — el broker lo levanta
  bajo demanda. Es el equivalente real a "trigger" para Cursor y Codex, y sirve también como
  fallback para Claude Code cuando no hay sesión interactiva abierta.
- Riesgo a mitigar: ejecutar cambios en el repo sin supervisión humana. Hay que decidir por hook
  si se corre en modo "propone cambios" (sin `--force`/auto-approve) o autónomo, y en qué
  directorio/branch aterriza cada invocación (evitar pisar trabajo en curso del usuario).

## 5. Modelo de datos (calcado de free-code, con persistencia)

`~/.agent-webhook-bridge/hooks.json`
```json
{
  "hooks": {
    "ci-failures": {
      "mode": "trigger",
      "secret": "…",
      "hmacSecret": null,
      "consumers": ["spawn:claude"],
      "promptTemplate": "Un build falló en CI. Log:\n\n{{payload}}\n\nInvestigá la causa.",
      "workdir": "/home/lenovo/Documentos/free-code/free-code"
    },
    "flowise": {
      "mode": "queue",
      "secret": "…",
      "consumers": ["mcp"]
    }
  }
}
```

Cola persistente en SQLite (`events` table: `id, hook, payload, received_at, delivered_at,
consumer, status`) para poder reintentar entregas y no perder eventos si el broker se reinicia.

## 6. Estructura del proyecto propuesto

```
agent-webhook-bridge/
├── PLAN.md                 (este documento)
├── broker/                 (servidor HTTP + cola SQLite + registry de hooks)
├── adapters/
│   ├── mcp-server/         (adapter (A): tools poll_events/wait_for_event/ack_event)
│   ├── claude-hook/         (adapter (B): script para Stop/UserPromptSubmit hook)
│   └── spawn-runner/        (adapter (C): worker que invoca claude -p / cursor-agent -p / codex exec)
├── cli/                     (comando `awb` para registrar hooks, ver estado, probar con curl)
└── install/                 (systemd user unit / launchd plist, instaladores de config por agente)
```

## 7. Roadmap por fases

1. **MVP (broker + spawn adapter, un solo agente)**
   Broker standalone con persistencia SQLite + spawn adapter para Claude Code (`claude -p`).
   Validar end-to-end con `curl` igual que el test de free-code.
2. **Adaptador MCP (modo queue)**
   Server MCP mínimo, instalable en Claude Code y Cursor.
3. **Soporte Cursor y Codex en spawn adapter**
   Agregar `cursor-agent -p` y `codex exec`, manejar sus particularidades de aprobación/sandbox.
4. **Claude Code hook adapter (modo casi-trigger en sesión viva)**
   Script de `Stop`/`UserPromptSubmit` + doc de instalación en `settings.json`.
5. **Endurecimiento**
   Reintentos, dead-letter para eventos que fallan repetidamente, límites de concurrencia (no
   spawnear 10 `codex exec` en paralelo sobre el mismo repo), logging, túnel opcional.
6. **CLI/UX + instaladores**
   `awb add <name> --consumer spawn:claude --trigger`, systemd unit, docs.

## 8. Riesgos / cosas a validar antes de programar

- **Concurrencia de escritura sobre un repo**: si dos eventos disparan dos `codex exec`/`claude -p`
  sobre el mismo working dir al mismo tiempo, van a pisarse. Hay que serializar por `workdir` o
  usar worktrees efímeros por evento.
- **Aprobación/sandbox en modo headless**: Codex CLI cancela tool calls MCP sin TTY salvo bypass
  explícito; hay que decidir el nivel de autonomía por hook (autoedit vs. dry-run vs. bypass) en
  vez de asumir uno solo.
- **Costo**: cada evento en modo spawn dispara una sesión completa de agente (tokens). Para fuentes
  ruidosas conviene modo `queue` + resumen, no `trigger` por evento.
- **Seguridad**: igual que free-code, bind local por defecto, secreto obligatorio, HMAC para
  fuentes externas, y nunca loggear el payload crudo si puede traer secretos de terceros (ej. logs
  de CI con tokens).

## 9. Decisiones abiertas (para el usuario)

- Lenguaje/runtime del broker: ¿Node/TypeScript (reusar casi 1:1 el código de
  `webhook-receiver` de free-code) o Python?
- ¿Qué agente priorizamos para el MVP: Claude Code, Cursor o Codex?
- Supervisión del daemon: ¿systemd user service, `pm2`, o simplemente un script que el usuario
  arranca a mano?
- ¿Se distribuye como paquete instalable (npm/pipx) o se queda como script local para uso propio?

## 10. Referencias

- `packages/coding-agent/default-extensions/webhook-receiver/` — implementación de referencia
  dentro de free-code.
- `web-docs/webhooks.html` — doc pública de free-code sobre `/webhook`.
- [Non-interactive mode – Codex](https://developers.openai.com/codex/noninteractive)
- [Model Context Protocol – Codex](https://developers.openai.com/codex/mcp)
- [codex exec: MCP tool calls auto-cancelled headless (GitHub issue #24135)](https://github.com/openai/codex/issues/24135)
- [Using Headless CLI – Cursor Docs](https://cursor.com/docs/cli/headless)
- [MCP – Cursor Docs](https://cursor.com/docs/cli/mcp)
- [MCP not working in cursor CLI print mode (Cursor forum)](https://forum.cursor.com/t/mcp-not-working-in-cursor-cli-print-mode/132780)
- [Hooks reference – Claude Code Docs](https://code.claude.com/docs/en/hooks)
