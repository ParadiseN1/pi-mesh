# Mesh Office implementation notes

The office is a local Bun HTTP server, a browser UI drawn with canvas, and a controller for Pi RPC processes. It uses the same file-based messaging functions as the Pi extension.

## Team lifecycle

1. The human supplies a goal, workspace, model, and team size.
2. The controller writes an immutable roster with stable names, `agent-1` through `agent-N`, in a separate run directory.
3. It starts one Pi RPC process per peer. The extension registers each process in that directory.
4. After all peers respond and register, the controller sends each the shared goal. On ordinary prompt submission, the extension adds the goal, full roster, exact count, and communication instructions. Message-triggered wake-ups use the existing conversation history rather than reinjecting this context.
5. Peers decide who does what through Global Chat and DMs. The controller tracks activity and process health, without assigning work.
6. Finishing a turn makes an agent available for later messages. Pause stops the processes and keeps their sessions. Resume opens the same session files, preserves the team ID, chat and counters, and asks agents to continue the latest human request.

Only one team can run at a time in one server. Up to 20 peers share the same workspace. An aborted startup stops all processes that the controller started. Normal shutdown also stops the team. A restarted server labels unfinished persisted runs `interrupted`; it does not relaunch them.

## Authentication

Mesh Office starts and resumes agents with `openai-codex/gpt-6-astra` by default, using the ChatGPT OAuth login saved in Pi. The model picker lists only `openai-codex` models; the server rejects API providers, removes inherited `OPENAI_API_KEY` from child environments, and verifies the selected model before sending the launch prompt. There is no fallback to OpenAI API billing when subscription access fails. Other installed Pi workflows are independent of this dashboard policy.

Resume validates every saved session before launching any peer. A missing history is an error, not a reason to create a fresh agent. Older API-backed runs are resumed using the subscription default; their prior messages remain in the same files. Pending tools interrupted by Pause may need the agent to check their results before retrying. API credentials are not deleted by installing this software; local credential removal is a separate owner action.

## Messaging

`history.ts` publishes one durable record per message and an atomic inbox file per recipient. Global broadcasts use one archive record, even when sent to many peers. The existing Pi watcher processes inbox files. A two-second sweep handles missed notifications and temporary delivery errors.

Delivery receipts deduplicate messages already queued into a Pi session. There is a small crash window between queuing and writing the receipt, so delivery is not exactly once. Malformed incoming records are moved to `rejected/` for inspection. History survives inbox consumption and process shutdown.

The human observer sees all messages. `mesh_history` filters agent access to Global Chat and DMs involving that agent. This filter is not a filesystem security boundary: agents work on the same machine with coding tools.

## UI

The room is drawn locally without external images, fonts, or a game engine. Desk placement adapts to team size. Runtime state drives character animation, custom statuses come from Pi registrations, and recent outgoing messages trigger an envelope indicator. Keyboard-accessible buttons overlay the board and desks.

The wall board opens a Slack-like panel with Global Chat, all conversations, per-agent views, and peer-to-peer DM views. The expand button fills the browser viewport. The human can send messages to Global Chat or a specific agent and answer supported Pi extension dialogs. The latest 1,000 messages are displayed; export reads the entire archive.

## Validation

Automated tests cover durable broadcasts, inbox consumption, duplicate receipts, timed retries, DM history filtering, malformed messages, and unsafe identities. A labelled RPC subprocess fixture checks a ten-peer startup barrier, human-message wakeup, process shutdown, failed startup cleanup, cancellation during startup, interrupted-run recovery, and mutation authentication. The fixture does not call a model.

A separate live smoke run on 2026-09-29 used installed Pi 0.84.1 with two `openai/gpt-4.1-mini` peers. The run restricted tools to mesh communication in an empty scratch workspace. Both peers reported the correct team count, sent Global Chat messages and DMs, and set custom statuses. A human DM sent from the browser woke an idle peer, which replied privately with `Панель працює`. The run produced nine messages, including three extra peer acknowledgements, and was then stopped through the UI.

Browser checks covered the wall board, agent desk, fullscreen chat, DM pair filtering, reload persistence, a 390px-wide layout, and stopping the team. Screenshots and the live transcript were delivered separately. The screen recorder's ASS filter was unavailable, so no video evidence is claimed.

This verifies communication and lifecycle behavior. It does not establish the quality of autonomous coding by a large team. Token limits, loop detection, automatic crash recovery, per-agent worktrees, and complex character movement are not implemented.
