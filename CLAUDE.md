# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build, Test, Lint Commands

```bash
bun install                  # Install dependencies
bun run start               # Run the gateway in foreground
bun run start:backend       # Run with proxy support (recommended for production)
bun run typecheck           # TypeScript type checking
bun run lint                # ESLint
bun test                    # Run all tests
bun test test/path/to/file.test.ts  # Run single test file
bun run verify              # Full verification: typecheck + lint + test
bun run test:stability      # Integration stability suite (restart/recovery/transcripts)
bun run cli status          # Check runtime status via CLI
bun run cli doctor          # Run operational diagnostics
```

## Architecture Overview

**Platform Registry Pattern**: `src/platforms/platformRegistry.js` is the abstraction boundary between core bridge logic and chat integrations. Platforms (Discord, Feishu) register with capabilities like `attachments`, `buttons`, `repoBootstrap`, `autoDiscovery`. Core code queries capabilities via `platformSupports(platformId, capabilityName)` rather than branching on platform names.

**Turn Runner** (`src/codex/turnRunner.js`): Per-route FIFO queue managing Codex turns. Each route (Discord channel or Feishu chat) has its own queue, ensuring no overlapping turns. Handles reconnection retries, thread resume/start, and turn lifecycle. Uses `TURN_PHASE` from `src/turns/lifecycle.js`.

**Codex RPC Client** (`src/codexRpcClient.js`): JSON-RPC over stdio to `codex app-server`. Emits `notification`, `serverRequest`, `exit` events. Initialize handshake must complete before any turn operations.

**Route Binding Model**:
- Discord routes: raw text channel ID
- Feishu routes: `feishu:<chat_id>` prefix
- Each route maps to a setup object with `cwd`, `model`, `mode`, and write policy
- Thread bindings persist in `data/state.json`

**Configuration Flow**:
1. `loadConfig.js` merges `config/channels.json` with env overrides
2. Env vars take precedence: `CODEX_APPROVAL_POLICY`, `CODEX_SANDBOX_MODE`, `DISCORD_ALLOWED_USER_IDS`, `FEISHU_ALLOWED_OPEN_IDS`
3. Agent definitions in `channels.json > agents` with capability flags like `supportsImageInput`

**Runtime Bootstrap Sequence** (see `src/app/mainRuntime.js` → `runBridgeProcess.js`):
1. Load `.env`, `config/channels.json`, `data/state.json`
2. Start backend HTTP server if enabled
3. Start `codex app-server` and complete `initialize` handshake
4. Start enabled platforms via platform registry
5. Register Discord slash commands if Discord enabled
6. Start Feishu transport (webhook or long-connection)
7. Reconcile in-flight turn recovery state
8. Bootstrap Discord managed channels from Codex `thread/list`
9. Start heartbeat writes, mark `/readyz` healthy

**State Files** (in `data/`):
- `state.json`: Route → Codex thread bindings
- `bridge-heartbeat.json`: Liveness metadata for `cli status`
- `inflight-turns.json`: Recovery metadata for active turns across restarts
- `restart-request.json` / `restart-ack.json`: Supervisor restart coordination

## Key Patterns

**Message Flow**: Platform → Command Router → Turn Queue → Codex RPC → Notification Runtime → Platform reply

**Platform Adapters** (`src/platforms/discordPlatform.js`, `src/platforms/feishuPlatform.js`): Implement `platformId`, `enabled`, `capabilities`, `start()`, `stop()`, `fetchChannelByRouteId()`, `handleInboundMessage()`, `handleInboundInteraction()`.

**Notification Runtime** (`src/turns/notificationRuntime.js`): Consumes Codex notifications, manages status messages, renders summaries, handles attachments via `src/attachments/service.js`.

**Approval Runtime** (`src/approvals/serverRequestRuntime.js`): Intercepts approval requests from Codex server requests, routes back to originating platform.

## Environment Variables

Key env vars (see `.env.example` for full list):
- `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_ALLOWED_USER_IDS`
- `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `FEISHU_TRANSPORT`
- `WORKSPACE_ROOT` - Base path for repo channels
- `CODEX_BIN` - Path to codex executable
- `CODEX_APPROVAL_POLICY` - `never` | `untrusted` | `on-failure` | `on-request`
- `CODEX_SANDBOX_MODE` - `read-only` | `workspace-write` | `danger-full-access`
- `BACKEND_HTTP_ENABLED`, `BACKEND_HTTP_HOST`, `BACKEND_HTTP_PORT`
