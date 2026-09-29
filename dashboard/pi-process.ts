import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { subscriptionEnvironment } from "./auth-policy.js";

export type PiEvent = Record<string, any>;

export class PiProcess {
  readonly process: ChildProcessWithoutNullStreams;
  private pending = new Map<
    string,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private buffer = "";
  private errors = "";
  exited = false;

  constructor(options: {
    command: string;
    args: string[];
    cwd: string;
    env?: NodeJS.ProcessEnv;
    onEvent: (event: PiEvent) => void;
    onExit: (error: string) => void;
  }) {
    this.process = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: subscriptionEnvironment(options.env),
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    this.process.stdout.setEncoding("utf8");
    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (chunk: string) => {
      this.errors = (this.errors + chunk).slice(-4000);
    });
    this.process.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        let event: PiEvent;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (
          event.type === "response" &&
          event.id &&
          this.pending.has(event.id)
        ) {
          const request = this.pending.get(event.id)!;
          this.pending.delete(event.id);
          clearTimeout(request.timer);
          if (event.success) request.resolve(event.data);
          else
            request.reject(new Error(event.error || `${event.command} failed`));
        }
        options.onEvent(event);
      }
      if (this.buffer.length > 2_000_000) this.buffer = "";
    });
    const exit = (error: string) => {
      if (this.exited) return;
      this.exited = true;
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error(error));
      }
      this.pending.clear();
      options.onExit(error);
    };
    this.process.on("error", (error) => exit(error.message));
    this.process.on("exit", (code, signal) =>
      exit(this.errors.trim() || `Pi exited (${signal || code || "closed"})`),
    );
    this.process.stdin.on("error", () => {});
  }

  send(type: string, data: Record<string, unknown> = {}): void {
    if (this.exited || !this.process.stdin.writable)
      throw new Error("Pi session is no longer running");
    this.process.stdin.write(JSON.stringify({ ...data, type }) + "\n");
  }

  request(
    type: string,
    data: Record<string, unknown> = {},
    timeout = 40000,
  ): Promise<any> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi did not answer ${type}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send(type, { ...data, id });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async stop(): Promise<void> {
    if (this.exited) return;
    try {
      this.send("abort");
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
    const terminate = (signal: NodeJS.Signals) => {
      if (this.exited || !this.process.pid) return;
      try {
        if (process.platform === "win32") this.process.kill(signal);
        else process.kill(-this.process.pid, signal);
      } catch {}
    };
    terminate("SIGTERM");
    await new Promise<void>((resolve) => {
      if (this.exited) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        terminate("SIGKILL");
        resolve();
      }, 2000);
      this.process.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
