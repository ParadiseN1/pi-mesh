import { afterEach, beforeEach, expect, it } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OfficeRecords, mime } from "../office-records.js";
import { createBundle } from "../dashboard/bundle.js";
import { markDelivered, readMessages } from "../history.js";
import { TeamController } from "../dashboard/controller.js";
import { startDashboard } from "../dashboard/server.js";
import { registerOfficeTools } from "../office-tools.js";
import { teamContext } from "../team.js";
let root: string,
  store: OfficeRecords,
  server: ReturnType<typeof startDashboard> | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "office-records-"));
  const cwd = join(root, "workspace");
  mkdirSync(cwd);
  writeFileSync(join(cwd, "report.md"), "# Original");
  const base = join(root, "runs", "test-run");
  mkdirSync(base, { recursive: true });
  const team = {
    id: "test-run",
    cwd,
    agents: ["agent-1", "agent-2"],
    goal: "Create a report",
    createdAt: new Date().toISOString(),
  };
  writeFileSync(join(base, "team.json"), JSON.stringify(team));
  writeFileSync(
    join(base, "run.json"),
    JSON.stringify({
      ...team,
      status: "stopped",
      model: "openai-codex/gpt-6-astra",
      members: team.agents.map((name) => ({
        name,
        status: "stopped",
        output: "",
        activity: "Paused",
        tokens: 0,
        toolCalls: 0,
      })),
    }),
  );
  store = new OfficeRecords(
    { base, registry: join(base, "registry"), inbox: join(base, "inbox") },
    team,
  );
});
afterEach(async () => {
  await server?.stop();
  server = undefined;
  rmSync(root, { recursive: true, force: true });
});
const artifact = (extra: any = {}) =>
  store.artifacts(
    {
      action: "register",
      title: "Report",
      summary: "For the owner",
      purpose: ["knowledge", "delivery"],
      state: "ready",
      resources: [{ type: "file", path: "report.md" }],
      ...extra,
    },
    "agent-1",
  );
const question = (extra: any = {}) =>
  store.questions(
    {
      action: "ask",
      title: "Which market?",
      question: "Which market should we use?",
      reason: "Copy depends on it",
      blocking: true,
      ...extra,
    },
    "agent-1",
  );
const agreement = (a: any) =>
  store.delivery(
    {
      action: "propose",
      revision: 0,
      summary: "Deliver a report",
      criteria: [
        {
          text: "Report delivered",
          verification: "Read the report",
          met: true,
          evidence: [a.id],
        },
      ],
    },
    "agent-1",
  );
const handoff = (a: any, extra: any = {}) =>
  store.delivery(
    {
      action: "finalize",
      revision: 0,
      agreementRevision: 1,
      title: "Delivery",
      summary: "Requested report",
      completed: "Created report",
      remaining: "",
      artifacts: [a.id],
      ...extra,
    },
    "agent-1",
  );
it("keeps unknown formats downloadable without pretending they are text", () => {
  expect(mime("brief.pdf")).toBe("application/pdf");
  expect(mime("README.md")).toBe("text/plain");
  expect(mime("assets.zip")).toBe("application/octet-stream");
});
it("a successful recheck supersedes failure while preserving check history", () => {
  let a = artifact();
  for (const outcome of ["failed", "passed"])
    a = store.artifacts(
      {
        action: "check",
        id: a.id,
        revision: a.revision,
        label: "Content review",
        outcome,
        evidence:
          outcome === "failed"
            ? "Missing section"
            : "Section added and verified",
      },
      "agent-2",
    );
  expect(a.checks.map((c: any) => c.outcome)).toEqual(["failed", "passed"]);
  agreement(a);
  store.delivery({ action: "claim" }, "agent-1");
  expect(handoff(a).state).toBe("ready");
});
it("changing supporting evidence invalidates readiness even when primary files stay unchanged", () => {
  const primary = artifact();
  const support = artifact({
    purpose: ["knowledge"],
    title: "Supporting evidence",
  });
  agreement(support);
  store.delivery({ action: "claim" }, "agent-1");
  expect(handoff(primary).state).toBe("ready");
  store.artifacts(
    {
      action: "update",
      id: support.id,
      revision: support.revision,
      summary: "Revised findings",
    },
    "agent-2",
  );
  expect(store.view().delivery?.effectiveState).toBe("needs_attention");
  expect(store.view().delivery?.issues).toContain(
    "Criterion evidence has changed; review the agreement",
  );
});
it("separates purpose and readiness; preserves files and rejects stale edits", () => {
  const a = artifact({ state: "draft" });
  expect(a.purpose).toEqual(["knowledge", "delivery"]);
  writeFileSync(join(store.team.cwd, "report.md"), "# Updated");
  const b = store.artifacts(
    {
      action: "update",
      id: a.id,
      revision: 1,
      state: "ready",
      resources: [{ type: "file", path: "report.md" }],
    },
    "agent-2",
  );
  expect(store.file(a.id, 1, 0, "report.md").data.toString()).toBe(
    "# Original",
  );
  expect(store.file(a.id, 2, 0, "report.md").data.toString()).toBe("# Updated");
  expect(b.by).toBe("agent-1");
  expect(b.updatedBy).toBe("agent-2");
  expect(() =>
    store.artifacts(
      { action: "update", id: a.id, revision: 1, title: "Stale" },
      "agent-1",
    ),
  ).toThrow("Revision conflict");
});
it("rejects workspace escapes, sensitive files, symlinks and credential URLs", () => {
  writeFileSync(join(root, "outside"), "private");
  writeFileSync(join(store.team.cwd, ".env"), "private");
  symlinkSync(join(root, "outside"), join(store.team.cwd, "alias"));
  for (const path of ["../outside", ".env", "alias", join(root, "outside")])
    expect(() => artifact({ resources: [{ type: "file", path }] })).toThrow();
  for (const url of ["javascript:alert(1)", "https://user:secret@example.com"])
    expect(() => artifact({ resources: [{ type: "url", url }] })).toThrow();
  expect(() => store.artifacts({ action: "list" }, "outsider")).toThrow();
});
it("snapshots a directory entry and skips secrets", () => {
  mkdirSync(join(store.team.cwd, "docs"));
  writeFileSync(join(store.team.cwd, "docs", "index.html"), "<h1>Report</h1>");
  writeFileSync(join(store.team.cwd, "docs", ".env"), "secret");
  const a = artifact({
    resources: [{ type: "directory", path: "docs", entry: "index.html" }],
  });
  expect(a.resources[0].files).toHaveLength(1);
  expect(() =>
    artifact({
      resources: [{ type: "directory", path: "docs", entry: "missing" }],
    }),
  ).toThrow("Entry file");
});
it("preserves simultaneous registrations from ten independent processes", async () => {
  const code = `import {OfficeRecords} from ${JSON.stringify(join(import.meta.dir, "../office-records.ts"))};const s=new OfficeRecords(JSON.parse(process.argv[1]),JSON.parse(process.argv[2]));s.artifacts({action:'register',title:'Peer '+process.argv[3],summary:'Concurrent',purpose:['knowledge'],resources:[{type:'note',text:'Output'}]},'agent-1');`;
  const ps = Array.from({ length: 10 }, (_, i) =>
    Bun.spawn(
      [
        process.execPath,
        "-e",
        code,
        JSON.stringify(store.dirs),
        JSON.stringify(store.team),
        String(i),
      ],
      { stdout: "pipe", stderr: "pipe" },
    ),
  );
  for (const p of ps) {
    const e = await new Response(p.stderr).text();
    expect(await p.exited, e).toBe(0);
  }
  expect(store.view().artifacts).toHaveLength(10);
  expect(store.read().revision).toBe(10);
});
it("persists paused answers, retries notifications once and serves late subscribers", () => {
  const q = question();
  expect(() =>
    store.questions(
      { action: "answer", id: q.id, revision: 1, text: "US" },
      "agent-2",
    ),
  ).toThrow("Only the human");
  const a = store.questions(
    { action: "answer", id: q.id, revision: 1, text: "US" },
    "human",
  );
  expect(readMessages(store.dirs)).toHaveLength(1);
  expect(readdirSync(join(store.dirs.inbox, "agent-1"))).toHaveLength(1);
  const restarted = new OfficeRecords(store.dirs, store.team);
  expect(restarted.view().questions[0].answers[0].text).toBe("US");
  markDelivered(store.dirs, a.answers[0].id, "agent-1");
  rmSync(join(store.dirs.inbox, "agent-1"), { recursive: true });
  restarted.flushAnswers();
  expect(readMessages(store.dirs)).toHaveLength(1);
  const joined = restarted.questions(
    { action: "join", id: q.id, revision: 2 },
    "agent-2",
  );
  expect(joined.subscribers).toEqual(["agent-1", "agent-2"]);
  expect(readdirSync(join(store.dirs.inbox, "agent-2"))).toHaveLength(1);
  const resolved = restarted.questions(
    { action: "resolve", id: q.id, revision: 3, reason: "Applied to copy" },
    "agent-2",
  );
  expect(resolved.status).toBe("resolved");
  const changed = restarted.questions(
    { action: "answer", id: q.id, revision: 4, text: "Canada" },
    "human",
  );
  expect(changed.answers).toHaveLength(2);
  expect(changed.status).toBe("answered");
});
it("does not interpret suggestions, deferrals or unanswered work as completion", () => {
  const a = artifact();
  agreement(a);
  store.delivery({ action: "claim" }, "agent-1");
  const q = question({ options: ["US", "UK"] });
  expect(q.answers).toHaveLength(0);
  store.questions({ action: "defer", id: q.id, revision: 1 }, "human");
  expect(() => handoff(a)).toThrow("Blocking questions");
  store.questions(
    { action: "answer", id: q.id, revision: 2, text: "US" },
    "human",
  );
  expect(() => handoff(a)).toThrow("Blocking questions");
  store.questions(
    { action: "resolve", id: q.id, revision: 3, reason: "Used US" },
    "agent-1",
  );
  expect(handoff(a).state).toBe("ready");
});
it("requires a claim and rejects competing handoff writers", () => {
  const a = artifact();
  agreement(a);
  expect(() => handoff(a)).toThrow("Claim the handoff");
  store.delivery({ action: "claim" }, "agent-1");
  expect(() => store.delivery({ action: "claim" }, "agent-2")).toThrow(
    "assembling",
  );
  expect(handoff(a).revision).toBe(1);
  expect(() => handoff(a)).toThrow("Revision conflict");
});
it("blocks objections, remaining work and failed checks but allows honest partial delivery", () => {
  const a = artifact();
  agreement(a);
  store.delivery({ action: "claim" }, "agent-1");
  store.delivery(
    { action: "review", revision: 1, stance: "object", note: "Review needed" },
    "agent-2",
  );
  expect(() => handoff(a)).toThrow("objection");
  store.delivery(
    { action: "review", revision: 1, stance: "agree", note: "Reviewed" },
    "agent-2",
  );
  expect(() => handoff(a, { remaining: "Appendix" })).toThrow("remaining");
  const c = store.artifacts(
    {
      action: "check",
      id: a.id,
      revision: 1,
      label: "Review",
      outcome: "failed",
      evidence: "Missing source",
    },
    "agent-2",
  );
  expect(() => handoff(c)).toThrow("failed check");
  expect(
    handoff(c, { state: "needs_attention", remaining: "Fix source" }).state,
  ).toBe("needs_attention");
});
it("pins handoff versions and flags later artifact and agreement revisions", () => {
  const a = artifact();
  agreement(a);
  store.delivery({ action: "claim" }, "agent-1");
  handoff(a);
  expect(store.view().delivery?.effectiveState).toBe("ready");
  store.artifacts(
    { action: "update", id: a.id, revision: 1, title: "New title" },
    "agent-1",
  );
  expect(store.view().delivery?.effectiveState).toBe("needs_attention");
  expect(store.view().delivery?.artifacts[0].revision).toBe(1);
  store.delivery(
    {
      action: "propose",
      revision: 1,
      summary: "New scope",
      criteria: [{ text: "New request", verification: "Test it" }],
    },
    "agent-1",
  );
  expect(store.view().delivery?.issues).toContain(
    "Completion agreement has changed",
  );
});
it("exports a valid portable ZIP with preserved content and labeled external links", async () => {
  const a = artifact({
    resources: [
      { type: "file", path: "report.md" },
      { type: "url", url: "https://example.com" },
    ],
  });
  agreement(a);
  store.delivery({ action: "claim" }, "agent-1");
  handoff(a);
  writeFileSync(join(store.team.cwd, "report.md"), "changed");
  const f = join(root, "bundle.zip");
  writeFileSync(f, createBundle(store, { delivery: 1 }));
  const p = Bun.spawn(
    [
      "python3",
      "-c",
      `import zipfile,sys,json;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;assert z.read('artifacts/${a.id}/resource-1/report.md')==b'# Original';assert b'not included offline' in z.read('index.html');assert json.loads(z.read('manifest.json'))['delivery']['revision']==1`,
      f,
    ],
    { stderr: "pipe" },
  );
  const e = await new Response(p.stderr).text();
  expect(await p.exited, e).toBe(0);
});
it("serves only registered snapshots with a sandbox and authenticated mutations", async () => {
  writeFileSync(
    join(store.team.cwd, "preview.html"),
    '<script>parent.document.title="bad"</script>',
  );
  const a = artifact({ resources: [{ type: "file", path: "preview.html" }] });
  server = startDashboard({
    port: 0,
    controller: new TeamController({ dataDir: join(root, "runs") }),
  });
  expect(Object.keys(server.controller.records("test-run").team).sort()).toEqual(
    ["agents", "createdAt", "cwd", "goal", "id"],
  );
  const u = `http://127.0.0.1:${server.server.port}`;
  const r = await fetch(
    `${u}/api/runs/test-run/artifacts/${a.id}/1/0/preview.html`,
  );
  expect(r.status).toBe(200);
  expect(r.headers.get("content-security-policy")).toContain(
    "sandbox allow-scripts",
  );
  expect(r.headers.get("content-security-policy")).not.toContain(
    "allow-same-origin",
  );
  expect(
    (await fetch(`${u}/api/runs/test-run/artifacts/${a.id}/1/0/missing`))
      .status,
  ).toBe(400);
  expect(
    (
      await fetch(`${u}/api/runs/test-run/records/questions`, {
        method: "POST",
        body: "{}",
      })
    ).status,
  ).toBe(403);
  const { token } = await (await fetch(`${u}/api/config`)).json();
  const q = question();
  const answer = await fetch(`${u}/api/runs/test-run/records/questions`, {
    method: "POST",
    headers: { "x-mesh-token": token, "content-type": "application/json" },
    body: JSON.stringify({
      action: "answer",
      id: q.id,
      revision: 1,
      text: "US",
    }),
  });
  expect(answer.status).toBe(200);
  const s = await (await fetch(`${u}/api/state`)).json();
  expect(s.run.status).toBe("stopped");
  expect(s.office.questions[0].status).toBe("answered");
});
it("registers callable tools and explains them in peer context", async () => {
  const tools: any[] = [];
  registerOfficeTools(
    { registerTool: (t: any) => tools.push(t) } as any,
    () => ({ records: store, actor: "agent-1" }),
  );
  expect(tools.map((t) => t.name)).toEqual([
    "mesh_artifact",
    "mesh_question",
    "mesh_delivery",
  ]);
  const r = await tools[0].execute("call", {
    action: "register",
    title: "Tool output",
    summary: "Test",
    purpose: ["knowledge"],
    resources: [{ type: "note", text: "Shared" }],
  });
  expect(JSON.parse(r.content[0].text).by).toBe("agent-1");
  for (const t of tools)
    expect(teamContext(store.team, "agent-1")).toContain(t.name);
});
