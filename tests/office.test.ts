import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  publishMessage,
  readMessages,
  enqueueMessage,
  wasDelivered,
} from "../history.js";
import { processInbox, startWatcher, stopWatcher } from "../messaging.js";
import { TeamController } from "../dashboard/controller.js";
import { startDashboard } from "../dashboard/server.js";
import { teamContext } from "../team.js";
import { DEFAULT_MODEL } from "../dashboard/auth-policy.js";
import { deskPositions } from "../dashboard/public/office.js";
import type { Dirs, MeshState } from "../types.js";

let root: string;
let dirs: Dirs;
let controller: TeamController | undefined;
let dashboard: ReturnType<typeof startDashboard> | undefined;
const states: MeshState[] = [];

it("keeps desks and their clickable status areas inside the room without overlap at every supported team size", () => {
  for (let count = 1; count <= 20; count++) {
    const desks = deskPositions(count).map(({ x, y, scale }) => ({
      left: x - 62 * scale, right: x + 62 * scale,
      top: y - 58 * scale, bottom: y + 97 * scale,
    }));
    expect(desks).toHaveLength(count);
    for (let i = 0; i < desks.length; i++) {
      const a = desks[i];
      expect(a.left >= 0 && a.right <= 960 && a.top > 204 && a.bottom <= 620).toBe(true);
      for (const b of desks.slice(i + 1)) {
        expect(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top).toBe(true);
      }
    }
  }
});
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-office-test-"));
  dirs = {
    base: root,
    registry: join(root, "registry"),
    inbox: join(root, "inbox"),
  };
});
afterEach(async () => {
  states.splice(0).forEach(stopWatcher);
  await dashboard?.stop();
  dashboard = undefined;
  await controller?.close();
  controller = undefined;
  rmSync(root, { recursive: true, force: true });
});
function receiver(): MeshState {
  const state = {
    agentName: "agent-2",
    registered: true,
    chatHistory: new Map(),
    unreadCounts: new Map(),
    watcherRetries: 0,
  } as MeshState;
  states.push(state);
  return state;
}
async function until(check: () => boolean, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Condition did not become true");
    await Bun.sleep(20);
  }
}
function makeController(extraArgs: string[] = []) {
  controller = new TeamController({
    dataDir: join(root, "runs"),
    piCommand: resolve(import.meta.dir, "fixtures/pi-rpc.mjs"),
    extraArgs,
    startupTimeout: 2000,
  });
  return controller;
}

describe("durable team messages", () => {
  it("archives one broadcast, delivers once to each inbox, and keeps history after consumption", () => {
    const message = publishMessage(dirs, "agent-1", "#global", "Shared plan", [
      "agent-2",
      "agent-3",
      "agent-2",
    ]);
    expect(readdirSync(join(root, "messages"))).toHaveLength(1);
    expect(readdirSync(join(dirs.inbox, "agent-3"))).toHaveLength(1);
    const state = receiver();
    let received = 0;
    processInbox(state, dirs, () => received++);
    expect(received).toBe(1);
    expect(wasDelivered(dirs, message.id, "agent-2")).toBe(true);
    enqueueMessage(dirs, message, "agent-2");
    processInbox(state, dirs, () => received++);
    expect(received).toBe(1);
    expect(readdirSync(join(dirs.inbox, "agent-2"))).toHaveLength(0);
    expect(readMessages(dirs)[0].text).toBe("Shared plan");
  });
  it("retries a temporarily failed delivery even when no further filesystem events arrive", async () => {
    const message = publishMessage(
      dirs,
      "agent-1",
      "agent-2",
      "Please review",
      ["agent-2"],
    );
    const state = receiver();
    let attempts = 0;
    const started = Date.now();
    startWatcher(state, dirs, () => {
      attempts++;
      if (Date.now() - started < 300) throw new Error("Busy");
    });
    expect(wasDelivered(dirs, message.id, "agent-2")).toBe(false);
    await until(() => wasDelivered(dirs, message.id, "agent-2"));
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
  });
  it("limits agent history to global and their own DMs while the owner can see all", () => {
    publishMessage(dirs, "agent-1", "#global", "Global", []);
    publishMessage(dirs, "agent-1", "agent-2", "Private A", []);
    publishMessage(dirs, "agent-2", "agent-3", "Private B", []);
    expect(
      readMessages(dirs, { viewer: "agent-1" })
        .map((m) => m.text)
        .sort(),
    ).toEqual(["Global", "Private A"]);
    expect(
      readMessages(dirs, { viewer: "agent-1", peer: "agent-3" }),
    ).toHaveLength(0);
    expect(readMessages(dirs)).toHaveLength(3);
    expect(readMessages(dirs, { globalOnly: true })).toHaveLength(1);
  });
  it("rejects traversal identities and quarantines corrupt incoming records", () => {
    expect(() =>
      publishMessage(dirs, "human", "../outside", "bad", []),
    ).toThrow();
    expect(() =>
      publishMessage(dirs, "human", "#global", "bad", ["../../outside"]),
    ).toThrow();
    const inbox = join(dirs.inbox, "agent-2");
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(inbox, "bad.json"), "{broken");
    writeFileSync(
      join(inbox, "unsafe.json"),
      JSON.stringify({ id: "../../escape", from: "human", text: "bad" }),
    );
    processInbox(receiver(), dirs, () => {
      throw new Error("Must not deliver");
    });
    expect(readdirSync(inbox)).toHaveLength(0);
    expect(readdirSync(join(root, "rejected", "agent-2"))).toHaveLength(2);
  });
});

describe("team process lifecycle", () => {
  it("rejects API models and strips an inherited OpenAI key from child processes", async () => {
    const ctl = makeController();
    expect(() => ctl.create({ count: 1, goal: 'No API', cwd: root, model: 'openai/gpt-6-astra' })).toThrow('subscription');
    expect(ctl.list()).toHaveLength(0);
    const previous = process.env.OPENAI_API_KEY;
    let run;
    try {
      process.env.OPENAI_API_KEY = 'fixture-not-a-real-key';
      run = ctl.create({ count: 1, goal: 'Subscription default', cwd: root });
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
    await until(() => run.status === 'idle');
    expect(run.model).toBe(DEFAULT_MODEL);
    expect(JSON.parse(readFileSync(join(ctl.dirs(run.id).base, 'agent-1.launch.json'), 'utf8')).apiKeyPresent).toBe(false);
  });
  it("does not send a goal when Pi reports a non-subscription model", async () => {
    const ctl = makeController(['--fixture-api-model']);
    const run = ctl.create({count:1, goal:'Never send to API', cwd:root});
    await until(() => run.status === 'failed' && run.members[0].status === 'stopped');
    expect(run.error).toContain('expected subscription model');
    expect(existsSync(join(ctl.dirs(run.id).base, 'agent-1.probe.json'))).toBe(false);
  });
  it("resumes the same saved sessions after a server restart without resetting history or counters", async () => {
    const ctl = makeController();
    const run = ctl.create({count:2, goal:'Original goal', cwd:root});
    await until(() => run.status === 'idle');
    ctl.send(run.id, {to:'agent-1', text:'Latest human follow-up'});
    await until(() => run.members[0].output === 'Received: Latest human follow-up');
    await ctl.stop(run.id);
    const files = run.members.map(m => m.sessionFile!);
    const bytes = files.map(p => readFileSync(p, 'utf8'));
    const previousTokens = run.members.map(m => m.tokens);
    const restored = new TeamController(ctl.options);
    controller = restored;
    const resumed = restored.resume(run.id);
    expect(() => restored.resume(run.id)).toThrow();
    await until(() => resumed.members.every((member, index) =>
      member.status === 'waiting' && member.tokens === previousTokens[index] + 1));
    expect(resumed.id).toBe(run.id);
    expect(resumed.model).toBe(DEFAULT_MODEL);
    expect(resumed.members.map(m => m.sessionFile)).toEqual(files);
    expect(files.map(p => readFileSync(p, 'utf8'))).toEqual(bytes);
    expect(resumed.members.map(m => m.tokens)).toEqual(previousTokens.map(n => n + 1));
    expect(restored.snapshot(run.id).messages[0].text).toBe('Latest human follow-up');
    for (const name of run.agents) {
      const probe = JSON.parse(readFileSync(join(restored.dirs(run.id).base, `${name}.probe.json`), 'utf8'));
      expect(probe.prompt).toContain('Continue the latest human request');
      expect(probe.prompt).not.toBe(run.goal);
      expect(JSON.parse(readFileSync(join(restored.dirs(run.id).base, `${name}.launch.json`), 'utf8')).resumed).toBe(true);
    }
  });
  it("keeps a stopped run unchanged when a saved session is missing", async () => {
    const ctl = makeController();
    const run = ctl.create({count:2, goal:'Preserve history', cwd:root});
    await until(() => run.status === 'idle');
    await ctl.stop(run.id);
    rmSync(run.members[1].sessionFile!);
    expect(() => ctl.resume(run.id)).toThrow('Missing saved session');
    expect(run.status).toBe('stopped');
  });
  it("connects all ten peers before sending the shared goal, wakes on a DM, and stops every process", async () => {
    const ctl = makeController();
    const run = ctl.create({
      count: 10,
      goal: "Negotiate the work together",
      cwd: root,
    });
    await until(() =>
      run.members.every((m) => m.output === "Fixture prompt completed"),
    );
    for (const name of run.agents) {
      const probe = JSON.parse(
        readFileSync(join(ctl.dirs(run.id).base, `${name}.probe.json`), "utf8"),
      );
      expect(probe).toEqual({ allReady: true, prompt: run.goal });
    }
    expect(run.status).toBe("idle");
    const context = teamContext(run, "agent-4");
    for (const name of run.agents) expect(context).toContain(name);
    expect(context).toContain("10");
    expect(() =>
      ctl.create({ count: 1, goal: "Overlap", cwd: root }),
    ).toThrow();
    ctl.send(run.id, { to: "agent-4", text: "Wake up once" });
    await until(() => run.members[3].output === "Received: Wake up once");
    const pids = run.agents.map((name) =>
      Number(readFileSync(join(ctl.dirs(run.id).base, `${name}.pid`), "utf8")),
    );
    await ctl.stop(run.id);
    expect(run.status).toBe("stopped");
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
    const restored = new TeamController(ctl.options);
    expect(restored.snapshot(run.id).messages[0].text).toBe("Wake up once");
    expect(restored.get(run.id).status).toBe("stopped");
  });
  it("cleans up the whole team if one peer cannot start", async () => {
    const ctl = makeController(["--fixture-fail-name", "agent-2"]);
    const run = ctl.create({ count: 3, goal: "Fail safely", cwd: root });
    await until(
      () =>
        run.status === "failed" &&
        run.members.every((m) => ["error", "stopped"].includes(m.status)),
    );
    for (const name of run.agents) {
      const pid = Number(
        readFileSync(join(ctl.dirs(run.id).base, `${name}.pid`), "utf8"),
      );
      expect(() => process.kill(pid, 0)).toThrow();
    }
    expect(
      readdirSync(ctl.dirs(run.id).base).filter((file) =>
        file.endsWith(".probe.json"),
      ),
    ).toHaveLength(0);
  });
  it("stops a team during startup without sending its goal", async () => {
    const ctl = makeController();
    const run = ctl.create({ count: 2, goal: "Cancel startup", cwd: root });
    await ctl.stop(run.id);
    await Bun.sleep(200);
    expect(run.status).toBe("stopped");
    expect(
      readdirSync(ctl.dirs(run.id).base).filter((file) =>
        file.endsWith(".probe.json"),
      ),
    ).toHaveLength(0);
  });
  it("marks an unfinished persisted run interrupted after server restart", () => {
    const dataDir = join(root, "runs");
    const id = "test-run";
    mkdirSync(join(dataDir, id), { recursive: true });
    writeFileSync(
      join(dataDir, id, "run.json"),
      JSON.stringify({
        id,
        status: "running",
        createdAt: "2026-09-29",
        agents: ["agent-1"],
        members: [{ name: "agent-1", status: "working" }],
      }),
    );
    const ctl = new TeamController({ dataDir });
    expect(ctl.get(id).status).toBe("interrupted");
    expect(ctl.get(id).members[0].status).toBe("stopped");
  });
});

it("requires the local session token and matching origin for mutations", async () => {
  const ctl = makeController();
  dashboard = startDashboard({ port: 0, cwd: root, controller: ctl });
  const url = `http://127.0.0.1:${dashboard.server.port}`;
  const body = JSON.stringify({ count: 0, cwd: root, goal: "Invalid count" });
  expect(
    (await fetch(`${url}/api/runs`, { method: "POST", body })).status,
  ).toBe(403);
  const config = (await (await fetch(`${url}/api/config`)).json()) as any;
  expect(
    (
      await fetch(`${url}/api/runs`, {
        method: "POST",
        headers: {
          "x-mesh-token": config.token,
          origin: "https://unrelated.example",
        },
        body,
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await fetch(`${url}/api/runs`, {
        method: "POST",
        headers: { "x-mesh-token": config.token, origin: url },
        body,
      })
    ).status,
  ).toBe(400);
  expect(ctl.list()).toHaveLength(0);
});
