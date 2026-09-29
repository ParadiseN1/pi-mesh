import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { publishMessage, readMessages, writeJsonAtomic } from "../history.js";
import type { AgentRegistration, Dirs } from "../types.js";
import type { TeamManifest } from "../team.js";
import { PiProcess, type PiEvent } from "./pi-process.js";
import { subscriptionModel } from "./auth-policy.js";

export type RunStatus =
  | "starting"
  | "running"
  | "idle"
  | "stopping"
  | "stopped"
  | "failed"
  | "interrupted";
export interface AgentView {
  name: string;
  status: "starting" | "working" | "waiting" | "stopped" | "error";
  activity: string;
  output: string;
  error?: string;
  model?: string;
  tokens: number;
  toolCalls: number;
  pendingQuestion?: PiEvent;
  sessionFile?: string;
}
export interface TeamRun extends TeamManifest {
  status: RunStatus;
  model: string;
  members: AgentView[];
  error?: string;
  stoppedAt?: string;
  resumedAt?: string;
}
export interface CreateRunInput {
  goal: string;
  cwd: string;
  count: number;
  model?: string;
}

export class TeamController {
  readonly runs = new Map<string, TeamRun>();
  private sessions = new Map<string, Map<string, PiProcess>>();
  private launching = new Map<string, Promise<void>>();

  constructor(
    readonly options: {
      dataDir: string;
      piCommand?: string;
      extensionPath?: string;
      extraArgs?: string[];
      startupTimeout?: number;
    },
  ) {
    mkdirSync(options.dataDir, { recursive: true });
    for (const id of readdirSync(options.dataDir)) {
      try {
        const run = JSON.parse(
          readFileSync(join(options.dataDir, id, "run.json"), "utf8"),
        ) as TeamRun;
        if (run.id !== id || !Array.isArray(run.members)) continue;
        if (["starting", "running", "idle", "stopping"].includes(run.status)) {
          run.status = "interrupted";
          run.members = run.members.map((agent) => ({
            ...agent,
            status: "stopped",
            activity: "Server restarted; history preserved",
          }));
        }
        this.runs.set(id, run);
      } catch {}
    }
  }

  dirs(id: string): Dirs {
    if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error("Invalid run ID");
    const base = join(this.options.dataDir, id);
    return {
      base,
      registry: join(base, "registry"),
      inbox: join(base, "inbox"),
    };
  }

  private save(run: TeamRun): void {
    writeJsonAtomic(join(this.dirs(run.id).base, "run.json"), run);
  }
  get(id: string): TeamRun {
    const run = this.runs.get(id);
    if (!run) throw new Error("Team run not found");
    return run;
  }
  list(): TeamRun[] {
    return [...this.runs.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }

  create(input: CreateRunInput): TeamRun {
    if (
      this.list().some((run) =>
        ["starting", "running", "idle", "stopping"].includes(run.status),
      )
    )
      throw new Error("Stop the current team before starting another one");
    if (
      typeof input.goal !== "string" ||
      !input.goal.trim() ||
      input.goal.length > 30000
    )
      throw new Error("Enter a goal (up to 30000 characters)");
    if (!Number.isInteger(input.count) || input.count < 1 || input.count > 20)
      throw new Error("Choose between 1 and 20 agents");
    if (typeof input.cwd !== "string" || !input.cwd.trim())
      throw new Error("Choose a workspace folder");
    const cwd = resolve(input.cwd);
    if (!existsSync(cwd) || !statSync(cwd).isDirectory())
      throw new Error("Workspace folder does not exist");
    const model = subscriptionModel(input.model);
    const run: TeamRun = {
      id: randomUUID(),
      goal: input.goal.trim(),
      cwd,
      createdAt: new Date().toISOString(),
      agents: Array.from({ length: input.count }, (_, i) => `agent-${i + 1}`),
      status: "starting",
      model,
      members: [],
    };
    run.members = run.agents.map((name) => ({
      name,
      status: "starting",
      activity: "Connecting to Pi",
      output: "",
      tokens: 0,
      toolCalls: 0,
    }));
    const dirs = this.dirs(run.id);
    mkdirSync(dirs.base, { recursive: true });
    writeJsonAtomic(join(dirs.base, "team.json"), {
      id: run.id,
      goal: run.goal,
      cwd,
      agents: run.agents,
      createdAt: run.createdAt,
    });
    this.runs.set(run.id, run);
    this.save(run);
    const launch = this.launch(run).finally(() =>
      this.launching.delete(run.id),
    );
    this.launching.set(run.id, launch);
    return run;
  }

  resume(id: string): TeamRun {
    const run = this.get(id);
    if (!['stopped', 'interrupted', 'failed'].includes(run.status) || this.launching.has(id))
      throw new Error("Wait for the team to finish stopping before resuming");
    if (this.list().some(item => ['starting', 'running', 'idle', 'stopping'].includes(item.status)))
      throw new Error("Stop the current team before resuming another one");
    if (!existsSync(run.cwd) || !statSync(run.cwd).isDirectory())
      throw new Error("Workspace folder does not exist");
    // Resolve every saved session before starting any process. Never silently
    // replace a missing history with a fresh agent.
    const saved = new Map(run.members.map(member => {
      const dir = join(this.dirs(id).base, 'sessions', member.name);
      const candidates = existsSync(dir) ? readdirSync(dir)
        .filter(file => file.endsWith('.jsonl'))
        .map(file => join(dir, file))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs) : [];
      const path = member.sessionFile || candidates[0];
      if (!path || !existsSync(path)) throw new Error(`Missing saved session for ${member.name}`);
      const header = JSON.parse(readFileSync(path, 'utf8').split('\n')[0]);
      if (header.type !== 'session' || typeof header.cwd !== 'string' || realpathSync(header.cwd) !== realpathSync(run.cwd))
        throw new Error(`Invalid saved session for ${member.name}`);
      return [member.name, path] as const;
    }));
    run.model = subscriptionModel(run.model.startsWith('openai-codex/') ? run.model : undefined);
    run.status = 'starting';
    run.error = undefined;
    run.resumedAt = new Date().toISOString();
    run.stoppedAt = undefined;
    for (const member of run.members) {
      member.sessionFile = saved.get(member.name);
      member.status = 'starting';
      member.activity = 'Restoring saved session';
      member.error = undefined;
      member.pendingQuestion = undefined;
    }
    this.save(run);
    const launch = this.launch(run, true).finally(() => this.launching.delete(id));
    this.launching.set(id, launch);
    return run;
  }

  private async launch(run: TeamRun, resume = false): Promise<void> {
    const processes = new Map<string, PiProcess>();
    this.sessions.set(run.id, processes);
    const dirs = this.dirs(run.id);
    try {
      for (const member of run.members) {
        const args = [
          "--mode",
          "rpc",
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "-e",
          this.options.extensionPath || resolve(import.meta.dir, "../index.ts"),
          "--session-dir",
          join(dirs.base, "sessions", member.name),
          "--name",
          `${run.id.slice(0, 8)} / ${member.name}`,
        ];
        args.push(...(this.options.extraArgs ?? []));
        args.push("--provider", "openai-codex", "--model", subscriptionModel(run.model));
        if (resume) args.push("--session", member.sessionFile!);
        const session = new PiProcess({
          command: this.options.piCommand || process.env.PI_MESH_PI_BIN || "pi",
          args,
          cwd: run.cwd,
          env: {
            PI_MESH_DIR: dirs.base,
            PI_MESH_TEAM: "1",
            PI_AGENT_NAME: member.name,
            PI_AGENT: "agent",
          },
          onEvent: (event) => this.onEvent(run, member, event),
          onExit: (error) => {
            if (["stopping", "stopped", "failed"].includes(run.status)) {
              member.status = "stopped";
              member.activity = "Stopped";
            } else {
              member.status = "error";
              member.error = error;
              member.activity = "Session closed";
              if (
                run.status !== "starting" &&
                [...processes.values()].every((process) => process.exited)
              ) {
                run.status = "failed";
                run.error = "All agent sessions have closed";
              } else this.updateRunStatus(run);
            }
            this.save(run);
          },
        });
        processes.set(member.name, session);
      }
      await Promise.all(
        [...processes.entries()].map(async ([name, session]) => {
          const state = await session.request(
            "get_state",
            {},
            this.options.startupTimeout ?? 40000,
          );
          const member = run.members.find((item) => item.name === name)!;
          member.model = state?.model
            ? `${state.model.provider}/${state.model.id}`
            : undefined;
          if (member.model !== run.model)
            throw new Error(`${name}: expected subscription model ${run.model}, received ${member.model || 'no model'}`);
          if (resume && resolve(state?.sessionFile || '') !== resolve(member.sessionFile!))
            throw new Error(`${name}: Pi did not restore the saved session`);
          member.sessionFile = state?.sessionFile;
          if (!existsSync(join(dirs.registry, `${name}.json`)))
            throw new Error(
              `${name}: pi-mesh did not register. Check the Pi version and extension errors.`,
            );
        }),
      );
      if (run.status !== "starting") return;
      run.status = "running";
      this.save(run);
      // Restore the latest conversation instead of repeating the original goal.
      for (const session of processes.values())
        session.send("prompt", {
          message: resume
            ? "The human has resumed this same team after pausing it to switch to ChatGPT subscription authentication. Your conversation, shared workspace, and team chat are preserved. Continue the latest human request and agreed responsibilities from your existing history. Check mesh_history and the current files for any work or messages you missed. Do not restart completed work. If your part is complete, report only meaningful updates and wait for a concrete request."
            : run.goal,
          ...(resume ? { streamingBehavior: "followUp" } : {}),
        });
    } catch (error) {
      if (run.status === "stopping" || run.status === "stopped") return;
      run.status = "failed";
      run.error = error instanceof Error ? error.message : String(error);
      await Promise.allSettled(
        [...processes.values()].map((session) => session.stop()),
      );
      this.save(run);
    }
  }

  private onEvent(run: TeamRun, member: AgentView, event: PiEvent): void {
    if (["stopped", "failed", "stopping"].includes(run.status)) return;
    let changed = true;
    if (event.type === "agent_start") {
      member.status = "working";
      member.activity = "Thinking";
      member.error = undefined;
    } else if (event.type === "tool_execution_start") {
      member.status = "working";
      member.activity = event.toolName || "Working";
      member.toolCalls++;
    } else if (event.type === "agent_settled") {
      if (member.status !== "error") member.status = "waiting";
      member.activity = member.error
        ? "Needs attention"
        : "Waiting for a message";
    } else if (event.type === "agent_end" && !event.willRetry) {
      // Older Pi releases do not emit agent_settled. Verify their actual queue state.
      void this.sessions
        .get(run.id)
        ?.get(member.name)
        ?.request("get_state", {}, 10000)
        .then((state) => {
          if (
            !state.isStreaming &&
            !state.isCompacting &&
            !state.pendingMessageCount &&
            member.status === "working"
          ) {
            member.status = "waiting";
            member.activity = "Waiting for a message";
            this.updateRunStatus(run);
            this.save(run);
          }
        })
        .catch(() => {});
    } else if (
      event.type === "message_end" &&
      event.message?.role === "assistant"
    ) {
      const message = event.message;
      const output = (message.content || [])
        .filter((item: any) => item.type === "text")
        .map((item: any) => item.text)
        .join("\n");
      if (output) member.output = output.slice(-30000);
      member.tokens += message.usage?.totalTokens || 0;
      if (message.stopReason === "error") {
        member.status = "error";
        member.error = message.errorMessage || "Model request failed";
      }
    } else if (
      event.type === "extension_error" ||
      (event.type === "response" && !event.success)
    ) {
      member.error = event.error || event.message || "Pi request failed";
      member.status = "error";
    } else if (
      event.type === "extension_ui_request" &&
      ["confirm", "select", "input", "editor"].includes(event.method)
    ) {
      member.pendingQuestion = event;
      member.activity = "Waiting for your answer";
    } else changed = false;
    if (changed) {
      this.updateRunStatus(run);
      this.save(run);
    }
  }

  private updateRunStatus(run: TeamRun): void {
    if (run.status !== "running" && run.status !== "idle") return;
    run.status = run.members.some((member) => member.status === "working")
      ? "running"
      : "idle";
  }

  snapshot(id?: string) {
    const run = id ? this.get(id) : this.list()[0];
    if (!run) return { runs: [], run: null, messages: [] };
    const dirs = this.dirs(run.id);
    const members = run.members.map((member) => {
      let registration: AgentRegistration | undefined;
      try {
        registration = JSON.parse(
          readFileSync(join(dirs.registry, `${member.name}.json`), "utf8"),
        );
      } catch {}
      return {
        ...member,
        statusMessage: registration?.statusMessage || "",
        reservations: registration?.reservations || [],
        filesModified: registration?.session?.filesModified || [],
        lastActivityAt: registration?.activity?.lastActivityAt,
      };
    });
    return {
      runs: this.list().map(({ id, goal, createdAt, status, agents }) => ({
        id,
        goal,
        createdAt,
        status,
        count: agents.length,
      })),
      run: { ...run, members },
      messages: readMessages(dirs, { limit: 1000 }),
    };
  }

  send(id: string, input: { to: string; text: string; urgent?: boolean }) {
    const run = this.get(id);
    if (!["running", "idle"].includes(run.status))
      throw new Error("This team is not running");
    if (input.to !== "#global" && !run.agents.includes(input.to))
      throw new Error("Unknown recipient");
    const processes = this.sessions.get(id)!;
    const recipients = (
      input.to === "#global" ? run.agents : [input.to]
    ).filter((name) => processes.has(name) && !processes.get(name)!.exited);
    if (!recipients.length) throw new Error("No active recipients");
    return publishMessage(
      this.dirs(id),
      "human",
      input.to,
      input.text,
      recipients,
      { urgent: input.urgent === true },
    );
  }

  answer(
    id: string,
    name: string,
    answer: { value?: string; confirmed?: boolean; cancelled?: boolean },
  ): void {
    const run = this.get(id);
    const member = run.members.find((item) => item.name === name);
    if (!member?.pendingQuestion)
      throw new Error("No pending question for this agent");
    const session = this.sessions.get(id)?.get(name);
    if (!session) throw new Error("Agent session is not running");
    session.send("extension_ui_response", {
      id: member.pendingQuestion.id,
      ...answer,
    });
    member.pendingQuestion = undefined;
    this.save(run);
  }

  async stop(id: string): Promise<void> {
    const run = this.get(id);
    if (["stopped", "failed", "interrupted"].includes(run.status)) return;
    run.status = "stopping";
    this.save(run);
    await Promise.allSettled(
      [...(this.sessions.get(id)?.values() ?? [])].map((session) =>
        session.stop(),
      ),
    );
    run.status = "stopped";
    run.stoppedAt = new Date().toISOString();
    for (const member of run.members) {
      member.status = "stopped";
      member.activity = "Stopped";
      member.pendingQuestion = undefined;
    }
    this.save(run);
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.list().map((run) => this.stop(run.id)));
  }
}
