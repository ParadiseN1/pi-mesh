#!/usr/bin/env node
// Subprocess fixture: exercises the launcher protocol without an LLM or credentials.
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const base = process.env.PI_MESH_DIR;
const name = process.env.PI_AGENT_NAME;
const team = JSON.parse(readFileSync(join(base, "team.json"), "utf8"));
const args = process.argv;
const flag = (key) => args[args.indexOf(key) + 1];
const selectedModel = flag('--model').split('/');
const sessionDir = flag('--session-dir');
mkdirSync(sessionDir, { recursive: true });
const sessionFile = args.includes('--session') ? flag('--session') : join(sessionDir, 'fixture.jsonl');
if (!args.includes('--session')) writeFileSync(sessionFile, JSON.stringify({type:'session', id:name, cwd:process.cwd()}) + '\n');
else if (!existsSync(sessionFile)) throw new Error('Missing restored session');
writeFileSync(join(base, `${name}.launch.json`), JSON.stringify({sessionFile, resumed:args.includes('--session'), apiKeyPresent:Boolean(process.env.OPENAI_API_KEY)}));
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");
mkdirSync(join(base, "registry"), { recursive: true });
mkdirSync(join(base, "inbox", name), { recursive: true });
writeFileSync(join(base, `${name}.pid`), String(process.pid));
const ready = new Promise((resolve) =>
  setTimeout(
    () => {
      if (
        args.includes("--fixture-fail-name") &&
        flag("--fixture-fail-name") === name
      )
        process.exit(7);
      writeFileSync(
        join(base, "registry", `${name}.json`),
        JSON.stringify({
          name,
          pid: process.pid,
          statusMessage: "Fixture only",
        }),
      );
      resolve();
    },
    name === team.agents.at(-1) ? 150 : 5,
  ),
);
const finish = (text) => {
  emit({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      usage: { totalTokens: 1 },
    },
  });
  emit({ type: "agent_settled" });
};
createInterface({ input: process.stdin }).on("line", async (line) => {
  const command = JSON.parse(line);
  await ready;
  if (command.type === "get_state")
    emit({
      type: "response",
      id: command.id,
      success: true,
      data: {
        model: { provider: args.includes('--fixture-api-model') ? 'openai' : selectedModel[0], id: selectedModel[1] },
        sessionFile,
        isStreaming: false,
        pendingMessageCount: 0,
      },
    });
  if (command.type === "prompt") {
    writeFileSync(
      join(base, `${name}.probe.json`),
      JSON.stringify({
        prompt: command.message,
        allReady: team.agents.every((peer) =>
          existsSync(join(base, "registry", `${peer}.json`)),
        ),
      }),
    );
    emit({ type: "agent_start" });
    finish("Fixture prompt completed");
  }
});
setInterval(() => {
  for (const file of readdirSync(join(base, "inbox", name)).filter((file) =>
    file.endsWith(".json"),
  )) {
    const path = join(base, "inbox", name, file);
    const message = JSON.parse(readFileSync(path, "utf8"));
    mkdirSync(join(base, 'deliveries'), { recursive: true });
    writeFileSync(join(base, 'deliveries', `${message.id}_${name}.json`), JSON.stringify({id:message.id,agent:name,queuedAt:new Date().toISOString()}));
    unlinkSync(path);
    emit({ type: "agent_start" });
    finish(`Received: ${message.text}`);
  }
}, 25);
