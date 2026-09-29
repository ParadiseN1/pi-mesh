import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { OfficeRecords } from "./office-records.js";
const optionalText = (description: string) =>
  Type.Optional(Type.String({ description }));
const revision = Type.Optional(
  Type.Integer({
    minimum: 0,
    description:
      "Expected current record revision. Read the record first. Use 0 for the first agreement or handoff.",
  }),
);
const ids = (description: string) =>
  Type.Optional(Type.Array(Type.String(), { description }));

export function registerOfficeTools(
  pi: ExtensionAPI,
  context: () => { records: OfficeRecords; actor: string },
) {
  const register = (
    name: string,
    description: string,
    parameters: any,
    method: "artifacts" | "questions" | "delivery",
  ) =>
    pi.registerTool({
      name,
      label: name.replace("mesh_", "Mesh "),
      description,
      parameters,
      async execute(_id, params) {
        try {
          const { records, actor } = context();
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(records[method](params, actor), null, 2),
              },
            ],
            details: {},
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  error instanceof Error
                    ? error.message
                    : "Office operation failed",
              },
            ],
            details: {},
            isError: true,
          };
        }
      },
    });
  register(
    "mesh_artifact",
    "Register useful work on the shared shelves. Purpose (knowledge/work/delivery), readiness, and evidence are separate. register stores immutable local file snapshots; it does not publish online. list/get discover peer work. update requires its current revision. check records evidence against the current resource digest.",
    Type.Object({
      action: Type.Union(
        ["register", "update", "check", "list", "get"].map((v) =>
          Type.Literal(v),
        ),
      ),
      id: optionalText("Artifact ID for get/update/check"),
      revision,
      title: optionalText("Short artifact title"),
      summary: optionalText("Why this artifact matters"),
      purpose: Type.Optional(
        Type.Array(
          Type.Union(
            ["knowledge", "work", "delivery"].map((v) => Type.Literal(v)),
          ),
        ),
      ),
      state: Type.Optional(
        Type.Union(
          ["draft", "ready", "superseded"].map((v) => Type.Literal(v)),
        ),
      ),
      limitations: optionalText(
        "Known limitations; ready is relative to the promised output",
      ),
      related: ids("Related artifact IDs"),
      provenance: optionalText(
        "Origin; explicitly label material collected after a run",
      ),
      resources: Type.Optional(
        Type.Array(
          Type.Object({
            type: Type.Union(
              ["file", "directory", "url", "note"].map((v) => Type.Literal(v)),
            ),
            path: optionalText(
              "Workspace-relative local file or directory; no secrets or symlinks",
            ),
            entry: optionalText("Preferred entry file within a directory"),
            url: optionalText("HTTP(S) URL, stored as a reference only"),
            text: optionalText("Stored note content"),
          }),
        ),
      ),
      label: optionalText("Check name, for check action"),
      outcome: Type.Optional(
        Type.Union(["passed", "failed", "not_run"].map((v) => Type.Literal(v))),
      ),
      evidence: optionalText("Check evidence and its limits, for check action"),
    }),
    "artifacts",
  );
  register(
    "mesh_question",
    "Ask the human through a durable Questions board. List existing questions before asking; join a question instead of duplicating it. ask returns immediately so independent work can continue. Answers arrive as messages and survive Pause/Resume. resolve requires an answer and a reason explaining how it was incorporated. Only the human can answer or defer questions.",
    Type.Object({
      action: Type.Union(
        ["ask", "list", "get", "join", "resolve", "withdraw"].map((v) =>
          Type.Literal(v),
        ),
      ),
      id: optionalText("Question ID"),
      revision,
      title: optionalText("Short question title"),
      question: optionalText("Self-contained question"),
      reason: optionalText(
        "Why the answer matters, or why this question is resolved/withdrawn",
      ),
      options: ids(
        "Optional suggested answers; human can always use free text",
      ),
      recommendation: optionalText("Recommended answer and reason"),
      blocking: Type.Optional(
        Type.Boolean({
          description:
            "True only if dependent work cannot proceed without this answer",
        }),
      ),
      assumption: optionalText(
        "Assumption for independent work; never assume permission from silence",
      ),
      related: ids("Relevant artifact IDs"),
    }),
    "questions",
  );
  register(
    "mesh_delivery",
    "Negotiate completion as equal peers. get retrieves current agreement and handoff. propose records criteria and evidence without changing the human goal. review records agreement or objection. claim takes a 10-minute handoff lease. draft/finalize require the lease, current handoff revision and agreementRevision. Ready requires met criteria, artifact evidence, ready primary deliveries, no objections, no remaining work, and no unresolved blocking questions. Use needs_attention for partial delivery. Idle is not completion.",
    Type.Object({
      action: Type.Union(
        ["get", "propose", "review", "claim", "draft", "finalize"].map((v) =>
          Type.Literal(v),
        ),
      ),
      revision,
      summary: optionalText("Agreement or handoff summary"),
      exclusions: optionalText(
        "Explicit exclusions; ask the human before reducing requested scope",
      ),
      criteria: Type.Optional(
        Type.Array(
          Type.Object({
            text: Type.String(),
            verification: Type.String(),
            met: Type.Optional(Type.Boolean()),
            evidence: ids("Artifact IDs supporting this criterion"),
          }),
        ),
      ),
      stance: Type.Optional(
        Type.Union([Type.Literal("agree"), Type.Literal("object")]),
      ),
      note: optionalText("Reason for agreement or objection"),
      agreementRevision: Type.Optional(Type.Integer()),
      artifacts: ids("Primary artifact IDs for the human"),
      title: optionalText("Handoff title"),
      completed: optionalText("What was completed"),
      remaining: optionalText("Unfinished work"),
      next: optionalText("Next human action"),
      state: Type.Optional(
        Type.Union([Type.Literal("ready"), Type.Literal("needs_attention")]),
      ),
    }),
    "delivery",
  );
}
