# pi-mesh

<a href="https://zerodha.tech"><img src="https://zerodha.tech/static/images/github-badge.svg" alt="Zerodha Tech"></a>
<a href="https://www.npmjs.com/package/pi-mesh"><img src="https://img.shields.io/npm/v/pi-mesh" alt="npm"></a>

Coordinate multiple [Pi](https://github.com/badlogic/pi-mono) agents working in the same project. See who's around, claim files so you don't step on each other, and send messages between sessions.

The extension coordinates through files on disk. This fork also includes **Mesh Office**, an optional local web panel with a pixel-art room and a shared chat board.

## Mesh Office

Use Pi 0.84+ and Bun 1.3+. Configure a working model in Pi first, then start the panel from this fork:

```bash
git clone https://github.com/ParadiseN1/pi-mesh.git
cd pi-mesh
bun install --frozen-lockfile
bun run office
```

Open **http://127.0.0.1:4317**. Choose a workspace, enter a shared goal, and select 1–20 agents and a model. Every agent receives the same goal, the exact team count, and the full roster. The launcher waits for all peers to connect before delivering the goal. Agents decide how to divide work and coordinate; there is no built-in leader, task planner, or dependency scheduler.

- Click the wall board to open Global Chat. Expand it to fill the browser window.
- Click a character to see its status, last result, file reservations, and conversations, or send it a message.
- Inspect agent-to-agent DMs in the sidebar. The human owner can see every conversation; each agent's history tool exposes Global Chat and its own DMs.
- Working characters animate, and a small envelope appears after an outgoing message. Reduced-motion preferences disable these animations.
- Send a message to wake an idle agent. Stop the team from the office when finished.
- Reopen previous rooms or export their complete message history.

The panel starts real Pi processes with the chosen workspace and existing Pi credentials. Agents share that folder and the usual Pi coding tools. Unrelated extensions, skills, and prompt templates are disabled for managed runs. File reservations still apply to `edit` and `write`; shell commands can bypass them. Review workspace configuration before using it with agents.

`Waiting` means a turn has ended, not that the shared goal is complete. An incoming message can start another turn. The app does not enforce a token budget or detect conversational loops. Use **Stop team** to end a run. Stopping the server stops its managed agents; an interrupted run is preserved for inspection and is not automatically resumed after a restart.

Data is stored in `.pi/mesh-office/runs/<run-id>/`: the goal and roster, agent state, Pi session transcripts, durable messages, inboxes, and delivery receipts. The panel displays the latest 1,000 messages; export includes the full history. A receipt confirms that a message was queued into a Pi session, not that the model read or acted on it. Delivery retries after a temporary failure. A crash between queuing and writing a receipt can cause a duplicate delivery.

The server binds to loopback and requires a same-origin session token for mutations. It has no remote login or multi-user access control. DMs are private routing within a team, not secrets from the workspace owner.

Optional environment variables:

| Variable | Purpose |
|---|---|
| `PORT` | Panel port, default `4317` |
| `PI_MESH_PI_BIN` | Path to the Pi executable if it is not on `PATH` |
| `PI_MESH_WORKSPACE` | Default workspace shown in the form |
| `PI_MESH_DASHBOARD_DATA` | Override the directory containing run folders |

Run `bun test` and `bun run typecheck` to check the source. Lifecycle tests use explicitly labelled subprocess fixtures without an LLM. See [docs/mesh-office.md](docs/mesh-office.md) for implementation and validation details.

## Extension-only install

```bash
pi install git:github.com/ParadiseN1/pi-mesh
```

## Setup

Add `.pi/pi-mesh.json` to your project:

```json
{
  "autoRegister": true
}
```

That's it. Start two Pi sessions in the same project and they'll find each other.

## What you get

**Six tools** for agents to coordinate:

| Tool | What it does |
|------|-------------|
| `mesh_peers` | List who's active, what they're working on, what model they're running |
| `mesh_reserve` | Claim files before editing. Other agents get blocked and told who to talk to |
| `mesh_release` | Let go of files when you're done |
| `mesh_send` | Message another agent. Normal messages wait politely; urgent ones interrupt |
| `mesh_manage` | Rename yourself, set status, check agent details, view the activity feed |
| `mesh_history` | Retrieve Global Chat and your own persistent direct-message history |

**An overlay** you open with `/mesh` - three tabs showing agents, activity feed, and a chat with `@mention` tab-completion.

**Automatic tracking** of edits, commits, and test runs. Status is derived from activity ("just shipped", "debugging...", "on fire").

## Quick example

```typescript
// Who's here?
mesh_peers({})

// I'm going to work on auth
mesh_reserve({ paths: ["src/auth/"], reason: "Refactoring auth" })

// Let the other agent know
mesh_send({ to: "zero-2", message: "Auth refactor done, interfaces changed" })

// Something urgent
mesh_send({ to: "zero-2", message: "Stop! Don't touch config.ts", urgent: true })

// Done, release files
mesh_release({})
```

## How it works

Everything lives in `.pi/mesh/`:

```
.pi/mesh/
├── registry/          # One JSON file per agent
├── inbox/{name}/      # Messages as JSON files, watched with fs.watch
├── messages/         # Durable message history, one atomic file per message
├── deliveries/       # Receipts for messages queued into Pi
└── feed.jsonl         # Append-only activity log
```

Agents register when they start, unregister when they stop. If an agent crashes, stale entries get cleaned up on the next `mesh_peers` call via PID checking.

Messages use Pi's delivery system: normal messages queue until the recipient finishes their current turn, urgent ones steer the active turn. Filesystem notifications trigger delivery, with a periodic inbox sweep for missed events and retries.

Reservations are enforced by hooking Pi's `edit` and `write` tools. When an agent tries to edit a reserved file, the tool call gets blocked and the agent sees who reserved it and why.

Ordinary non-interactive sessions skip automatic registration. Managed Mesh Office RPC sessions register explicitly in their own isolated team directory.

## Overlay

Open with `/mesh`. Tab switches between panels, arrow keys scroll, Esc closes.

| Tab | Shows |
|-----|-------|
| Agents | Live status of all peers - model, branch, current activity, reservations |
| Feed | Scrollable timeline of joins, edits, commits, messages |
| Chat | Type `@name message` to DM, or just type to broadcast. Tab-complete names |

## Configuration

Full config with defaults:

```json
{
  "autoRegister": false,
  "autoRegisterPaths": [],
  "contextMode": "full",
  "feedRetention": 50,
  "stuckThreshold": 900,
  "autoStatus": true
}
```

| Setting | What it does | Default |
|---------|-------------|---------|
| autoRegister | Join mesh when Pi starts | false |
| autoRegisterPaths | Only auto-join in these folders (trailing `*` wildcards) | [] |
| contextMode | How much context to inject: "full", "minimal", "none" | "full" |
| feedRetention | Max events kept in the activity feed | 50 |
| stuckThreshold | Seconds idle before an agent is marked stuck | 900 |
| autoStatus | Generate status from activity automatically | true |

Config is loaded from: project `.pi/pi-mesh.json` > user `~/.pi/agent/pi-mesh.json` > `~/.pi/agent/settings.json` "mesh" key > defaults.

The library defaults to `autoRegister: false`. Set it to `true` in your project config if you want all agents to coordinate.

## Agent naming

Names follow the pattern `{type}-{N}` where type comes from `PI_AGENT` env var (defaults to "agent") and N increments. So you get `zero-1`, `zero-2`, `lite-1`, etc.

Override with `PI_AGENT_NAME` env var, or rename at runtime:

```typescript
mesh_manage({ action: "rename", name: "auth-worker" })
```

Mesh Office keeps the initial `agent-1` through `agent-N` identities stable for the run. Use a custom status to describe an agent's current responsibility.

## Lifecycle Hooks

pi-mesh supports lifecycle hooks for reacting to mesh events without forking the package. Specify a module path in your config:

```json
{
  "autoRegister": true,
  "hooksModule": "./mesh-hooks.ts"
}
```

The module should export a `createHooks` function:

```typescript
import type { MeshConfig, MeshLifecycleHooks } from "pi-mesh/types";

export function createHooks(config: MeshConfig): MeshLifecycleHooks {
  return {
    onRegistered(state, ctx, actions) {
      // Called after successful mesh registration.
      // Use actions.rename("new-name") to trigger a mesh rename.
    },
    onRenamed(state, ctx, result) {
      // Called after a successful rename (from mesh_manage or actions.rename).
    },
    onPollTick(state, ctx, actions) {
      // Called on an interval while registered (default 2s).
      // Can call actions.rename() to sync external name changes into mesh.
    },
    onShutdown(state) {
      // Called during session shutdown, before unregister.
    },
  };
}
```

All hooks are optional. The poll interval defaults to 2 seconds and can be customized by setting `state.hookState.pollIntervalMs` in `onRegistered` (read once when the timer starts; not dynamic at runtime).

Hooks receive `MeshState` which includes an optional `hookState: Record<string, unknown>` bag for storing custom state across calls.

`onRegistered` and `onPollTick` receive a `HookActions` object with:
- `actions.rename(newName)` — rename this agent in the mesh registry. Handles watcher cycling internally and fires `onRenamed` on success. Returns `RenameResult` so hooks can handle failures (e.g., revert a tmux window on collision).

## Limitations

- **`bash` bypasses reservations.** Only `edit` and `write` are hooked. A `sed -i` through bash won't be caught.
- **Concurrent feed writes** can produce partial JSON lines. Malformed lines are skipped on read.
- **PID checking** doesn't work across container boundaries.
- **Crashed agents** leave stale registrations until the next `mesh_peers` cleans them up.

## Documentation

Full docs at [rhnvrm.github.io/pi-mesh](https://rhnvrm.github.io/pi-mesh/).

## Credits

Inspired by [pi-messenger](https://github.com/nicobailon/pi-messenger) by Nico Bailon. pi-mesh focuses on coordination only - presence, messaging, reservations - without the crew/task layer.

## License

MIT
