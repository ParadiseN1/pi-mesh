import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Dirs, MeshMessage } from "./types.js";

export function validAgentName(name: string): boolean {
  return (
    typeof name === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,49}$/.test(name)
  );
}

// A separate, atomically published file per event avoids concurrent JSONL appends.
export function writeJsonAtomic(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(temporary, path);
}

export function archiveMessage(dirs: Dirs, message: MeshMessage): void {
  const directory = join(dirs.base, "messages");
  mkdirSync(directory, { recursive: true });
  writeJsonAtomic(
    join(
      directory,
      `${message.timestamp.replace(/[:.]/g, "-")}_${message.id}.json`,
    ),
    message,
  );
}

export function enqueueMessage(
  dirs: Dirs,
  message: MeshMessage,
  recipient: string,
): void {
  if (!validAgentName(recipient)) throw new Error("Invalid recipient name");
  const directory = join(dirs.inbox, recipient);
  mkdirSync(directory, { recursive: true });
  writeJsonAtomic(
    join(
      directory,
      `${message.timestamp.replace(/[:.]/g, "-")}_${message.id}.json`,
    ),
    { ...message, to: recipient },
  );
}

export function publishMessage(
  dirs: Dirs,
  from: string,
  to: string,
  text: string,
  recipients: string[],
  options: { urgent?: boolean; replyTo?: string } = {},
): MeshMessage {
  if (!validAgentName(from) || (to !== "#global" && !validAgentName(to)))
    throw new Error("Invalid message identity");
  if (typeof text !== "string" || !text.trim() || text.length > 50000)
    throw new Error("Message must contain 1–50000 characters");
  if (recipients.some((name) => !validAgentName(name)))
    throw new Error("Invalid recipient name");
  const message: MeshMessage = {
    id: randomUUID(),
    from,
    to,
    text,
    timestamp: new Date().toISOString(),
    urgent: options.urgent ?? false,
    replyTo: options.replyTo ?? null,
    channel: to === "#global" ? "global" : "direct",
    recipients: [...new Set(recipients)],
  };
  archiveMessage(dirs, message);
  for (const recipient of message.recipients!)
    enqueueMessage(dirs, message, recipient);
  return message;
}

export function readMessages(
  dirs: Dirs,
  options: {
    viewer?: string;
    peer?: string;
    globalOnly?: boolean;
    limit?: number;
  } = {},
): MeshMessage[] {
  const directory = join(dirs.base, "messages");
  if (!existsSync(directory)) return [];
  const limit = Number.isNaN(options.limit)
    ? 100
    : Math.max(1, Math.floor(options.limit ?? 100));
  const messages: MeshMessage[] = [];
  for (const file of readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .reverse()) {
    try {
      const message = JSON.parse(
        readFileSync(join(directory, file), "utf8"),
      ) as MeshMessage;
      if (!message.id || typeof message.text !== "string") continue;
      const global = message.channel === "global";
      if (options.globalOnly && !global) continue;
      if (
        options.viewer &&
        !global &&
        message.from !== options.viewer &&
        message.to !== options.viewer
      )
        continue;
      if (
        options.peer &&
        (global ||
          (message.from !== options.peer && message.to !== options.peer))
      )
        continue;
      messages.push(message);
      if (messages.length >= limit) break;
    } catch {
      /* Ignore incomplete or corrupt historical records, never delete them. */
    }
  }
  return messages.reverse();
}

function receiptPath(dirs: Dirs, id: string, agent: string): string {
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(id) || !validAgentName(agent))
    throw new Error("Invalid receipt identity");
  return join(dirs.base, "deliveries", `${id}_${agent}.json`);
}

export function wasDelivered(dirs: Dirs, id: string, agent: string): boolean {
  return existsSync(receiptPath(dirs, id, agent));
}

export function markDelivered(dirs: Dirs, id: string, agent: string): void {
  mkdirSync(join(dirs.base, "deliveries"), { recursive: true });
  writeJsonAtomic(receiptPath(dirs, id, agent), {
    id,
    agent,
    queuedAt: new Date().toISOString(),
  });
}
