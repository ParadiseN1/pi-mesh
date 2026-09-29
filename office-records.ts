import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  linkSync,
  unlinkSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import {
  join,
  resolve,
  relative,
  isAbsolute,
  extname,
  basename,
} from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { archiveMessage, enqueueMessage, wasDelivered } from "./history.js";
import type { Dirs, MeshMessage } from "./types.js";
import type { TeamManifest } from "./team.js";

export type Purpose = "knowledge" | "work" | "delivery";
export interface StoredFile {
  path: string;
  source: string;
  hash: string;
  bytes: number;
  mime: string;
}
export interface Resource {
  type: "file" | "directory" | "url" | "note";
  path?: string;
  entry?: string;
  url?: string;
  text?: string;
  files?: StoredFile[];
}
export interface Check {
  label: string;
  outcome: "passed" | "failed" | "not_run";
  evidence: string;
  by: string;
  at: string;
  digest: string;
}
export interface Artifact {
  id: string;
  revision: number;
  title: string;
  summary: string;
  purpose: Purpose[];
  state: "draft" | "ready" | "superseded";
  limitations: string;
  resources: Resource[];
  digest: string;
  checks: Check[];
  related: string[];
  by: string;
  updatedBy: string;
  at: string;
  updatedAt: string;
  provenance: string;
}
export interface Answer {
  id: string;
  text: string;
  by: string;
  at: string;
  message: MeshMessage;
}
export interface Question {
  id: string;
  revision: number;
  title: string;
  question: string;
  reason: string;
  options: string[];
  recommendation: string;
  blocking: boolean;
  assumption: string;
  related: string[];
  by: string;
  subscribers: string[];
  status: "open" | "answered" | "resolved" | "withdrawn";
  answers: Answer[];
  resolution: string;
  deferred: boolean;
  at: string;
  updatedAt: string;
}
export interface Criterion {
  id: string;
  text: string;
  verification: string;
  met: boolean;
  evidence: string[];
  evidenceRevisions?: { id: string; revision: number }[];
}
export interface Agreement {
  revision: number;
  summary: string;
  criteria: Criterion[];
  exclusions: string;
  by: string;
  at: string;
  reviews: { by: string; stance: "agree" | "object"; note: string }[];
}
export interface Delivery {
  revision: number;
  title: string;
  summary: string;
  agreementRevision: number;
  artifacts: { id: string; revision: number }[];
  completed: string;
  remaining: string;
  next: string;
  state: "draft" | "ready" | "needs_attention";
  by: string;
  at: string;
}
interface Records {
  revision: number;
  artifacts: Record<string, Artifact[]>;
  questions: Record<string, Question[]>;
  agreements: Agreement[];
  deliveries: Delivery[];
  claim?: { by: string; until: number };
}
const empty = (): Records => ({
  revision: 0,
  artifacts: {},
  questions: {},
  agreements: [],
  deliveries: [],
});
const last = <T>(items: T[]): T | undefined => items.at(-1);
const now = () => new Date().toISOString();
const hash = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
function text(
  value: unknown,
  label: string,
  required = true,
  max = 12000,
): string {
  if (value === undefined && !required) return "";
  if (
    typeof value !== "string" ||
    value.length > max ||
    (required && !value.trim())
  )
    throw new Error(
      `${label} must contain ${required ? "1" : "0"}–${max} characters`,
    );
  return value.trim();
}
function choice<T extends string>(
  v: unknown,
  choices: readonly T[],
  label: string,
): T {
  if (!choices.includes(v as T)) throw new Error(`Invalid ${label}`);
  return v as T;
}
function strings(v: unknown, label: string, max = 50): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > max) throw new Error(`Invalid ${label}`);
  return [...new Set(v.map((x) => text(x, label, true, 2000)))];
}
function expected(actual: number, supplied: unknown) {
  if (actual !== supplied)
    throw new Error(
      `Revision conflict: expected ${actual}. Read the latest record and retry.`,
    );
}
export function mime(path: string): string {
  return (
    (
      {
        ".html": "text/html",
        ".htm": "text/html",
        ".pdf": "application/pdf",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".svg": "image/svg+xml",
        ".mp4": "video/mp4",
        ".webm": "video/webm",
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
        ".json": "application/json",
        ".css": "text/css",
        ".js": "text/javascript",
      } as Record<string, string>
    )[extname(path).toLowerCase()] ||
    (/\.(md|txt|ts|tsx|jsx|py|yaml|yml|toml|csv|srt|sh|log)$/i.test(path)
      ? "text/plain"
      : "application/octet-stream")
  );
}
const excluded = (name: string) =>
  /^(\.git|\.pi|\.ssh|\.aws|\.env(?:\..*)?|node_modules|__pycache__|\.DS_Store|auth\.json)$/i.test(
    name,
  );

/** Shared by Pi tools and HTTP actions. Revisions are immutable and committed using an atomic hard link. */
export class OfficeRecords {
  readonly root: string;
  constructor(
    readonly dirs: Dirs,
    readonly team: TeamManifest,
  ) {
    this.root = join(dirs.base, "office-records");
    mkdirSync(join(this.root, "revisions"), { recursive: true });
    mkdirSync(join(this.root, "blobs"), { recursive: true });
  }
  read(): Records {
    const files = readdirSync(join(this.root, "revisions"))
      .filter((f) => /^\d{10}\.json$/.test(f))
      .sort();
    return files.length
      ? JSON.parse(
          readFileSync(join(this.root, "revisions", files.at(-1)!), "utf8"),
        )
      : empty();
  }
  private commit<T>(change: (state: Records) => T): T {
    for (let attempt = 0; attempt < 30; attempt++) {
      const state = this.read();
      const result = change(state);
      state.revision++;
      const target = join(
        this.root,
        "revisions",
        `${String(state.revision).padStart(10, "0")}.json`,
      );
      const temp = join(this.root, "revisions", `${randomUUID()}.tmp`);
      writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
      try {
        linkSync(temp, target);
        return result;
      } catch (error: any) {
        if (error.code !== "EEXIST") throw error;
      } finally {
        unlinkSync(temp);
      }
    }
    throw new Error("Records are busy. Retry the operation.");
  }
  private actor(actor: string) {
    if (actor !== "human" && !this.team.agents.includes(actor))
      throw new Error("Unknown team member");
  }
  private inputResource(input: any): Resource {
    if (!input || typeof input !== "object")
      throw new Error("Invalid resource");
    const type = choice(
      input.type,
      ["file", "directory", "url", "note"] as const,
      "resource type",
    );
    if (type === "note")
      return { type, text: text(input.text, "Note", true, 50000) };
    if (type === "url") {
      const url = new URL(text(input.url, "URL", true, 5000));
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error("Use an HTTP(S) URL without credentials");
      return { type, url: url.href };
    }
    const path = text(input.path, "Workspace-relative path", true, 2000);
    if (
      isAbsolute(path) ||
      path.split(/[\\/]/).some((p) => p === ".." || excluded(p))
    )
      throw new Error("Choose a non-sensitive path inside this workspace");
    const workspace = realpathSync(this.team.cwd);
    const target = resolve(workspace, path);
    const within = (p: string) => {
      const rel = relative(workspace, realpathSync(p));
      return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
    };
    if (!within(target) || lstatSync(target).isSymbolicLink())
      throw new Error(
        "Resource must stay inside the workspace without symlinks",
      );
    if ((type === "directory") !== lstatSync(target).isDirectory())
      throw new Error("Resource type does not match the path");
    const files: StoredFile[] = [];
    let bytes = 0;
    const visit = (p: string, name: string) => {
      const stat = lstatSync(p);
      if (stat.isSymbolicLink())
        throw new Error("Directory snapshots cannot include symlinks");
      if (!within(p)) throw new Error("File escaped the workspace");
      if (stat.isDirectory()) {
        for (const child of readdirSync(p).sort())
          if (!excluded(child))
            visit(join(p, child), name ? `${name}/${child}` : child);
      } else if (stat.isFile()) {
        if (
          files.length >= 2000 ||
          stat.size > 50 * 1024 * 1024 ||
          bytes + stat.size > 100 * 1024 * 1024
        )
          throw new Error(
            "Snapshot limit: 2000 files, 50 MB per file, 100 MB per resource. Register large media as a URL.",
          );
        const data = readFileSync(p);
        const digest = hash(data);
        bytes += data.length;
        const dest = join(this.root, "blobs", digest);
        if (!existsSync(dest)) {
          const temp = `${dest}.${randomUUID()}.tmp`;
          writeFileSync(temp, data, { mode: 0o600 });
          try {
            linkSync(temp, dest);
          } catch (e: any) {
            if (e.code !== "EEXIST") throw e;
          } finally {
            unlinkSync(temp);
          }
        }
        files.push({
          path: name,
          source: relative(workspace, p),
          hash: digest,
          bytes: data.length,
          mime: mime(p),
        });
      } else throw new Error("Only ordinary files can be registered");
    };
    visit(target, type === "file" ? basename(target) : "");
    if (!files.length) throw new Error("The resource has no files");
    const entry = input.entry
      ? text(input.entry, "Entry path", true, 2000)
      : type === "file"
        ? basename(target)
        : files.find((f) => f.path === "index.html")?.path ||
          files.find((f) => /README\.md$/i.test(f.path))?.path ||
          files[0].path;
    if (!files.some((f) => f.path === entry))
      throw new Error("Entry file is not in this resource");
    return { type, path, entry, files };
  }
  artifact(id: string, revision?: number): Artifact {
    const versions = this.read().artifacts[id] || [];
    const a =
      revision === undefined
        ? last(versions)
        : versions.find((v) => v.revision === revision);
    if (!a) throw new Error("Artifact version not found");
    return a;
  }
  file(id: string, revision: number, resource: number, path: string) {
    const artifact = this.artifact(id, revision);
    const file = artifact.resources[resource]?.files?.find(
      (f) => f.path === path,
    );
    if (!file || !/^[a-f0-9]{64}$/.test(file.hash))
      throw new Error("Registered file not found");
    const data = readFileSync(join(this.root, "blobs", file.hash));
    if (hash(data) !== file.hash)
      throw new Error("Stored file failed its integrity check");
    return { file, data };
  }
  artifacts(action: any, actor: string): any {
    this.actor(actor);
    if (action.action === "list")
      return Object.values(this.read().artifacts).map((v) => last(v));
    if (action.action === "get")
      return this.artifact(action.id, action.revision);
    const operation = choice(
      action.action,
      ["register", "update", "check"] as const,
      "artifact action",
    );
    const resources =
      action.resources === undefined
        ? undefined
        : (() => {
            if (
              !Array.isArray(action.resources) ||
              !action.resources.length ||
              action.resources.length > 10
            )
              throw new Error("Provide 1–10 resources");
            const prepared = action.resources.map((r: any) =>
              this.inputResource(r),
            );
            if (
              prepared
                .flatMap((r: Resource) => r.files || [])
                .reduce((n: number, f: StoredFile) => n + f.bytes, 0) >
              100 * 1024 * 1024
            )
              throw new Error("An artifact snapshot must fit in 100 MB");
            return prepared;
          })();
    return this.commit((state) => {
      const old =
        operation === "register"
          ? undefined
          : last(state.artifacts[action.id] || []);
      if (operation !== "register") {
        if (!old) throw new Error("Artifact not found");
        expected(old.revision, action.revision);
      }
      if (!old && Object.keys(state.artifacts).length >= 500)
        throw new Error("This run has reached 500 artifacts");
      const a: Artifact = old
        ? structuredClone(old)
        : {
            id: randomUUID(),
            revision: 0,
            title: "",
            summary: "",
            purpose: [],
            state: "draft",
            limitations: "",
            resources: [],
            checks: [],
            related: [],
            digest: "",
            by: actor,
            updatedBy: actor,
            at: now(),
            updatedAt: now(),
            provenance: "Registered during the run",
          };
      if (operation === "check") {
        a.checks.push({
          label: text(action.label, "Check label", true, 300),
          outcome: choice(
            action.outcome,
            ["passed", "failed", "not_run"] as const,
            "check outcome",
          ),
          evidence: text(action.evidence, "Check evidence"),
          by: actor,
          at: now(),
          digest: a.digest,
        });
      } else {
        a.title = text(action.title ?? a.title, "Artifact title", true, 200);
        a.summary = text(
          action.summary ?? a.summary,
          "Artifact summary",
          true,
          5000,
        );
        a.purpose = strings(action.purpose ?? a.purpose, "Purpose", 3).map(
          (p) =>
            choice(p, ["knowledge", "work", "delivery"] as const, "purpose"),
        );
        if (!a.purpose.length) throw new Error("Choose at least one purpose");
        a.state = choice(
          action.state ?? a.state,
          ["draft", "ready", "superseded"] as const,
          "artifact state",
        );
        a.limitations = text(
          action.limitations ?? a.limitations,
          "Limitations",
          false,
        );
        a.provenance = text(
          action.provenance ?? a.provenance,
          "Provenance",
          false,
          2000,
        );
        a.related = strings(action.related ?? a.related, "Related artifacts");
        if (a.related.some((id) => !state.artifacts[id]))
          throw new Error("Related artifact not found");
        a.resources = resources ?? a.resources;
        if (!a.resources.length)
          throw new Error("Provide at least one resource");
        a.digest = hash(JSON.stringify(a.resources));
      }
      a.revision++;
      a.updatedBy = actor;
      a.updatedAt = now();
      (state.artifacts[a.id] ??= []).push(a);
      return a;
    });
  }
  questions(action: any, actor: string): any {
    this.actor(actor);
    if (action.action === "list") return this.view().questions;
    if (action.action === "get") {
      const q = last(this.read().questions[action.id] || []);
      if (!q) throw new Error("Question not found");
      return q;
    }
    const op = choice(
      action.action,
      ["ask", "join", "answer", "resolve", "withdraw", "defer"] as const,
      "question action",
    );
    const result = this.commit((state) => {
      const old =
        op === "ask" ? undefined : last(state.questions[action.id] || []);
      if (op !== "ask") {
        if (!old) throw new Error("Question not found");
        expected(old.revision, action.revision);
      }
      if (!old && Object.keys(state.questions).length >= 500)
        throw new Error("This run has reached 500 questions");
      const q: Question = old
        ? structuredClone(old)
        : {
            id: randomUUID(),
            revision: 0,
            title: text(action.title, "Question title", true, 200),
            question: text(action.question, "Question"),
            reason: text(action.reason, "Reason"),
            options: strings(action.options, "Options", 8),
            recommendation: text(
              action.recommendation,
              "Recommendation",
              false,
            ),
            blocking: action.blocking === true,
            assumption: text(action.assumption, "Assumption", false),
            related: strings(action.related, "Related artifacts"),
            by: actor,
            subscribers: actor === "human" ? [] : [actor],
            status: "open",
            answers: [],
            resolution: "",
            deferred: false,
            at: now(),
            updatedAt: now(),
          };
      if (q.related.some((id) => !state.artifacts[id]))
        throw new Error("Related artifact not found");
      if (op === "join") {
        if (actor !== "human" && !q.subscribers.includes(actor))
          q.subscribers.push(actor);
        // A late subscriber receives the current answer with the same event ID.
        if (q.answers.length)
          q.answers.at(-1)!.message.recipients = [...q.subscribers];
      }
      if (op === "answer") {
        if (actor !== "human")
          throw new Error("Only the human can answer owner questions");
        if (q.status === "withdrawn")
          throw new Error("This question was withdrawn");
        const value = text(action.text, "Answer");
        const id = randomUUID();
        q.answers.push({
          id,
          text: value,
          by: actor,
          at: now(),
          message: {
            id,
            from: "human",
            to: "#global",
            text: `Answer to question ${q.id}: ${q.title}\n\n${value}\n\nUse mesh_question get to read the decision. Continue dependent work and resolve this question when incorporated.`,
            timestamp: now(),
            urgent: false,
            replyTo: null,
            channel: "global",
            recipients: [...q.subscribers],
          },
        });
        q.status = "answered";
        q.resolution = "";
        q.deferred = false;
      }
      if (op === "resolve" || op === "withdraw") {
        if (
          actor !== "human" &&
          actor !== q.by &&
          !q.subscribers.includes(actor)
        )
          throw new Error("Join this question before resolving it");
        if (op === "resolve" && q.status !== "answered")
          throw new Error("Only an answered question can be resolved");
        q.resolution = text(action.reason, "Resolution reason");
        q.status = op === "resolve" ? "resolved" : "withdrawn";
      }
      if (op === "defer") {
        if (actor !== "human" || q.status !== "open")
          throw new Error("Only the human can defer an open question");
        q.deferred = !q.deferred;
      }
      q.revision++;
      q.updatedAt = now();
      (state.questions[q.id] ??= []).push(q);
      return q;
    });
    this.flushAnswers();
    return result;
  }
  flushAnswers(): string[] {
    const errors: string[] = [];
    // The answer itself is the durable outbox. Receipts prevent a restart from waking peers again.
    for (const versions of Object.values(this.read().questions))
      for (const answer of last(versions)!.answers) {
        try {
          const m = answer.message;
          const name = `${m.timestamp.replace(/[:.]/g, "-")}_${m.id}.json`;
          if (!existsSync(join(this.dirs.base, "messages", name)))
            archiveMessage(this.dirs, m);
          for (const peer of m.recipients || [])
            if (
              !wasDelivered(this.dirs, m.id, peer) &&
              !existsSync(join(this.dirs.inbox, peer, name))
            )
              enqueueMessage(this.dirs, m, peer);
        } catch (e: any) {
          errors.push(e.message);
        }
      }
    return errors;
  }
  delivery(action: any, actor: string): any {
    this.actor(actor);
    if (action.action === "get") return this.view();
    return this.commit((state) => {
      const agreement = last(state.agreements);
      if (action.action === "propose") {
        expected(agreement?.revision || 0, action.revision);
        if (
          !Array.isArray(action.criteria) ||
          !action.criteria.length ||
          action.criteria.length > 40
        )
          throw new Error("Provide 1–40 completion criteria");
        const criteria: Criterion[] = action.criteria.map(
          (c: any, i: number) => ({
            id: String(i + 1),
            text: text(c.text, "Criterion"),
            verification: text(c.verification, "Verification method"),
            met: c.met === true,
            evidence: strings(c.evidence, "Evidence artifacts"),
          }),
        );
        if (criteria.some((c) => c.evidence.some((id) => !state.artifacts[id])))
          throw new Error("Evidence artifact not found");
        for (const criterion of criteria)
          criterion.evidenceRevisions = criterion.evidence.map((id) => ({
            id,
            revision: last(state.artifacts[id])!.revision,
          }));
        const next: Agreement = {
          revision: (agreement?.revision || 0) + 1,
          summary: text(action.summary, "Agreement summary"),
          criteria,
          exclusions: text(action.exclusions, "Exclusions", false),
          by: actor,
          at: now(),
          reviews: [],
        };
        state.agreements.push(next);
        return next;
      }
      if (action.action === "review") {
        if (!agreement) throw new Error("Propose a completion agreement first");
        expected(agreement.revision, action.revision);
        agreement.reviews = agreement.reviews.filter((r) => r.by !== actor);
        agreement.reviews.push({
          by: actor,
          stance: choice(
            action.stance,
            ["agree", "object"] as const,
            "review stance",
          ),
          note: text(action.note, "Review note"),
        });
        return agreement;
      }
      if (action.action === "claim") {
        if (
          state.claim &&
          state.claim.until > Date.now() &&
          state.claim.by !== actor
        )
          throw new Error(`${state.claim.by} is assembling the handoff`);
        state.claim = { by: actor, until: Date.now() + 10 * 60 * 1000 };
        return state.claim;
      }
      if (action.action !== "draft" && action.action !== "finalize")
        throw new Error("Invalid delivery action");
      if (
        !state.claim ||
        state.claim.by !== actor ||
        state.claim.until < Date.now()
      )
        throw new Error("Claim the handoff before editing it");
      const previous = last(state.deliveries);
      expected(previous?.revision || 0, action.revision);
      if (!agreement) throw new Error("Propose a completion agreement first");
      expected(agreement.revision, action.agreementRevision);
      const ids = strings(action.artifacts, "Primary artifacts", 20);
      if (!ids.length) throw new Error("Select at least one primary artifact");
      const references = ids.map((id) => {
        const a = last(state.artifacts[id] || []);
        if (!a) throw new Error("Primary artifact not found");
        return { id, revision: a.revision };
      });
      const d: Delivery = {
        revision: (previous?.revision || 0) + 1,
        title: text(action.title, "Delivery title", true, 200),
        summary: text(action.summary, "Delivery summary"),
        agreementRevision: agreement.revision,
        artifacts: references,
        completed: text(action.completed, "Completed work"),
        remaining: text(action.remaining, "Remaining work", false),
        next: text(action.next, "Next action", false),
        state:
          action.action === "draft"
            ? "draft"
            : action.state === "needs_attention"
              ? "needs_attention"
              : "ready",
        by: actor,
        at: now(),
      };
      const problems = this.issues(state, d);
      if (d.state === "ready" && problems.length)
        throw new Error(`Delivery needs attention: ${problems.join("; ")}`);
      if (d.state === "ready")
        for (const ref of references) {
          const a = last(state.artifacts[ref.id])!;
          a.resources.forEach((r, i) =>
            r.files?.forEach((f) => this.file(a.id, a.revision, i, f.path)),
          );
        }
      state.deliveries.push(d);
      return d;
    });
  }
  private issues(state: Records, delivery: Delivery): string[] {
    const problems: string[] = [];
    const agreement = last(state.agreements);
    if (!agreement || agreement.revision !== delivery.agreementRevision)
      problems.push("Completion agreement has changed");
    if (agreement?.criteria.some((c) => !c.met))
      problems.push("Completion criteria remain open");
    if (agreement?.criteria.some((c) => c.met && !c.evidence.length))
      problems.push("Completed criteria need artifact evidence");
    if (
      agreement?.criteria.some(
        (c) =>
          c.met &&
          c.evidenceRevisions?.some(
            (ref) =>
              last(state.artifacts[ref.id] || [])?.revision !== ref.revision,
          ),
      )
    )
      problems.push("Criterion evidence has changed; review the agreement");
    if (agreement?.reviews.some((r) => r.stance === "object"))
      problems.push("An agreement objection is unresolved");
    if (
      Object.values(state.questions).some((v) => {
        const q = last(v)!;
        return q.blocking && ["open", "answered"].includes(q.status);
      })
    )
      problems.push("Blocking questions remain unresolved");
    if (delivery.remaining.trim())
      problems.push("The handoff lists remaining work");
    for (const ref of delivery.artifacts) {
      const a = last(state.artifacts[ref.id] || []);
      if (!a || a.revision !== ref.revision) {
        problems.push("A primary artifact has changed");
        continue;
      }
      if (a.state !== "ready" || !a.purpose.includes("delivery"))
        problems.push(`${a.title} is not ready on Deliveries`);
      if (
        [
          ...new Map(
            a.checks
              .filter((c) => c.digest === a.digest)
              .map((c) => [c.label, c]),
          ).values(),
        ].some((c) => c.outcome === "failed")
      )
        problems.push(`${a.title} has a failed check`);
      for (const r of a.resources)
        for (const f of r.files || [])
          if (!existsSync(join(this.root, "blobs", f.hash)))
            problems.push(`Missing stored file: ${f.path}`);
    }
    return [...new Set(problems)];
  }
  view() {
    const s = this.read();
    const d = last(s.deliveries);
    const issues = d ? this.issues(s, d) : [];
    return {
      revision: s.revision,
      artifacts: Object.values(s.artifacts).map((v) => ({
        ...last(v)!,
        revisions: v.map((a) => a.revision),
      })),
      questions: Object.values(s.questions).map((v) => {
        const q = last(v)!;
        const a = last(q.answers);
        return {
          ...q,
          deliveryReceipts: a
            ? (a.message.recipients || []).map((peer) => ({
                peer,
                delivered: wasDelivered(this.dirs, a.id, peer),
              }))
            : [],
        };
      }),
      agreement: last(s.agreements) || null,
      agreementHistory: s.agreements,
      delivery: d
        ? {
            ...d,
            issues,
            effectiveState:
              d.state === "ready" && issues.length
                ? "needs_attention"
                : d.state,
          }
        : null,
      deliveryHistory: s.deliveries,
      claim: s.claim && s.claim.until > Date.now() ? s.claim : null,
    };
  }
}
