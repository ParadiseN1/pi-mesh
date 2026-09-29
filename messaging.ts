/**
 * Pi Mesh - Messaging
 *
 * File-based inbox with fs.watch for delivery.
 */

import * as fs from "node:fs";
import { join } from "node:path";
import type {
  MeshState,
  Dirs,
  MeshMessage,
} from "./types.js";
import * as registry from "./registry.js";
import { publishMessage, validAgentName, markDelivered, wasDelivered } from "./history.js";
import { readTeam } from "./team.js";

// =============================================================================
// Guard against concurrent processing
// =============================================================================

let isProcessingMessages = false;
let pendingProcessArgs: {
  state: MeshState;
  dirs: Dirs;
  deliverFn: (msg: MeshMessage) => void;
} | null = null;

// =============================================================================
// Send
// =============================================================================

function ensureDirSync(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Validate that a recipient exists and is alive.
 */
export function validateRecipient(
  name: string,
  dirs: Dirs
): { valid: boolean; error?: string } {
  if (!validAgentName(name)) return { valid: false, error: "invalid_name" };
  if (name === "human" && readTeam(dirs)) return { valid: true };
  const regPath = join(dirs.registry, `${name}.json`);
  if (!fs.existsSync(regPath)) return { valid: false, error: "not_found" };

  try {
    const reg = JSON.parse(fs.readFileSync(regPath, "utf-8"));
    if (!registry.isProcessAlive(reg.pid)) {
      try {
        fs.unlinkSync(regPath);
      } catch {
        // Ignore
      }
      return { valid: false, error: "not_active" };
    }
  } catch {
    return { valid: false, error: "invalid_registration" };
  }

  return { valid: true };
}

/**
 * Send a message to a specific agent.
 */
export function sendMessage(
  state: MeshState,
  dirs: Dirs,
  to: string,
  text: string,
  urgent: boolean = false,
  replyTo?: string
): MeshMessage {
  return publishMessage(dirs, state.agentName, to, text,
    to === "human" && readTeam(dirs) ? [] : [to], { urgent, replyTo });
}

/**
 * Broadcast a message to all active agents.
 */
export function broadcastMessage(
  state: MeshState,
  dirs: Dirs,
  text: string,
  urgent: boolean = false
): MeshMessage[] {
  const agents = registry.getActiveAgents(state, dirs);
  const message = publishMessage(dirs, state.agentName, "#global", text, agents.map((agent) => agent.name), { urgent });
  return agents.map((agent) => ({ ...message, to: agent.name }));
}

// =============================================================================
// Receive
// =============================================================================

/**
 * Process all pending messages in inbox.
 */
export function processInbox(
  state: MeshState,
  dirs: Dirs,
  deliverFn: (msg: MeshMessage) => void
): void {
  if (!state.registered) return;

  // Guard against concurrent processing
  if (isProcessingMessages) {
    pendingProcessArgs = { state, dirs, deliverFn };
    return;
  }

  isProcessingMessages = true;

  try {
    const inbox = join(dirs.inbox, state.agentName);
    if (!fs.existsSync(inbox)) return;

    let files: string[];
    try {
      files = fs
        .readdirSync(inbox)
        .filter((f) => f.endsWith(".json"))
        .sort();
    } catch {
      return;
    }

    for (const file of files) {
      const msgPath = join(inbox, file);
      let msg: MeshMessage;
      try {
        const content = fs.readFileSync(msgPath, "utf-8");
        msg = JSON.parse(content);
        if (typeof msg.id !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(msg.id) || typeof msg.text !== "string" || !validAgentName(msg.from)) throw new Error("Invalid message");
      } catch {
        const rejected = join(dirs.base, "rejected", state.agentName);
        fs.mkdirSync(rejected, { recursive: true });
        try { fs.renameSync(msgPath, join(rejected, file)); } catch { /* Retry on the next inbox check. */ }
        continue;
      }

      try {
        if (wasDelivered(dirs, msg.id, state.agentName)) {
          fs.unlinkSync(msgPath);
          continue;
        }
        // A receipt means queued into Pi's session, not that the model has acted.
        deliverFn(msg);
        markDelivered(dirs, msg.id, state.agentName);

        // Store in chat history
        let history = state.chatHistory.get(msg.from);
        if (!history) {
          history = [];
          state.chatHistory.set(msg.from, history);
        }
        history.push(msg);
        if (history.length > 50) history.shift();

        // Track unread
        const current = state.unreadCounts.get(msg.from) ?? 0;
        state.unreadCounts.set(msg.from, current + 1);

        fs.unlinkSync(msgPath);
      } catch {
        // Keep undelivered messages for the watcher/turn-end retry.
      }
    }
  } finally {
    isProcessingMessages = false;

    // Re-process if new calls came in
    if (pendingProcessArgs) {
      const args = pendingProcessArgs;
      pendingProcessArgs = null;
      processInbox(args.state, args.dirs, args.deliverFn);
    }
  }
}

// =============================================================================
// Watcher
// =============================================================================

/**
 * Start fs.watch on inbox directory for message delivery.
 */
export function startWatcher(
  state: MeshState,
  dirs: Dirs,
  deliverFn: (msg: MeshMessage) => void
): void {
  if (!state.registered) return;
  if (state.watcher) return;
  if (state.watcherRetries >= 5) return;

  const inbox = join(dirs.inbox, state.agentName);
  ensureDirSync(inbox);

  // Process any pending messages first
  processInbox(state, dirs, deliverFn);
  // Recover a missed filesystem event or a temporarily unavailable Pi session.
  if (!state.inboxSweepTimer) {
    state.inboxSweepTimer = setInterval(() => processInbox(state, dirs, deliverFn), 2000);
    state.inboxSweepTimer.unref();
  }

  function scheduleRetry(): void {
    state.watcherRetries++;
    if (state.watcherRetries < 5) {
      const delay = Math.min(
        1000 * Math.pow(2, state.watcherRetries - 1),
        30000
      );
      state.watcherRetryTimer = setTimeout(() => {
        state.watcherRetryTimer = null;
        startWatcher(state, dirs, deliverFn);
      }, delay);
    }
  }

  try {
    state.watcher = fs.watch(inbox, () => {
      // Debounce rapid events
      if (state.watcherDebounceTimer) {
        clearTimeout(state.watcherDebounceTimer);
      }
      state.watcherDebounceTimer = setTimeout(() => {
        state.watcherDebounceTimer = null;
        processInbox(state, dirs, deliverFn);
      }, 50);
    });
  } catch {
    scheduleRetry();
    return;
  }

  state.watcher.on("error", () => {
    stopWatcher(state);
    scheduleRetry();
  });

  state.watcherRetries = 0;
}

/**
 * Stop the inbox watcher.
 */
export function stopWatcher(state: MeshState): void {
  if (state.inboxSweepTimer) {
    clearInterval(state.inboxSweepTimer);
    state.inboxSweepTimer = undefined;
  }
  if (state.watcherDebounceTimer) {
    clearTimeout(state.watcherDebounceTimer);
    state.watcherDebounceTimer = null;
  }
  if (state.watcherRetryTimer) {
    clearTimeout(state.watcherRetryTimer);
    state.watcherRetryTimer = null;
  }
  if (state.watcher) {
    state.watcher.close();
    state.watcher = null;
  }
}

/**
 * Recover watcher if it died (e.g., after session fork).
 */
export function recoverWatcherIfNeeded(
  state: MeshState,
  dirs: Dirs,
  deliverFn: (msg: MeshMessage) => void
): void {
  if (state.registered && !state.watcher && !state.watcherRetryTimer) {
    state.watcherRetries = 0;
    startWatcher(state, dirs, deliverFn);
  }
}
