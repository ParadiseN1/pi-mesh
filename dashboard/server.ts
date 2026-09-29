import { randomBytes } from "node:crypto";
import { resolve, join } from "node:path";
import { TeamController } from "./controller.js";
import { PiProcess } from "./pi-process.js";
import { readMessages } from "../history.js";
import { DEFAULT_MODEL } from "./auth-policy.js";
import { createBundle } from "./bundle.js";

export function startDashboard(
  options: {
    port?: number;
    dataDir?: string;
    cwd?: string;
    controller?: TeamController;
  } = {},
) {
  const defaultCwd = resolve(options.cwd || process.cwd());
  const controller =
    options.controller ||
    new TeamController({
      dataDir: options.dataDir || resolve(defaultCwd, ".pi/mesh-office/runs"),
    });
  const token = randomBytes(24).toString("hex");
  const assets = new Map([
    ["/", "index.html"],
    ["/app.js", "app.js"],
    ["/office.js", "office.js"],
    ["/style.css", "style.css"],
    ["/records.js", "records.js"],
    ["/records.css", "records.css"],
    ["/pdf.mjs", "../../node_modules/pdfjs-dist/build/pdf.mjs"],
    ["/pdf.worker.mjs", "../../node_modules/pdfjs-dist/build/pdf.worker.mjs"],
  ]);
  let modelCache:
    { models: { id: string; name: string }[]; error?: string } | undefined;
  let modelProbe: Promise<any> | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 4317,
    idleTimeout: 0,
    maxRequestBodySize: 100000,
    async fetch(request) {
      const url = new URL(request.url);
      const expectedHost = `127.0.0.1:${server.port}`;
      if (url.host !== expectedHost && url.host !== `localhost:${server.port}`)
        return new Response("Invalid host", { status: 403 });
      if (request.method !== "GET") {
        if (
          request.headers.get("x-mesh-token") !== token ||
          (request.headers.get("origin") &&
            request.headers.get("origin") !== url.origin)
        ) {
          return Response.json(
            { error: "Refresh this page to reconnect" },
            { status: 403 },
          );
        }
      }
      const json = (value: unknown, status = 200) =>
        Response.json(value, {
          status,
          headers: { "Cache-Control": "no-store" },
        });
      try {
        if (request.method === "GET" && assets.has(url.pathname)) {
          return new Response(
            Bun.file(
              join(import.meta.dir, "public", assets.get(url.pathname)!),
            ),
            {
              headers: {
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
                "Content-Security-Policy":
                  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' blob: data:; worker-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'",
              },
            },
          );
        }
        if (url.pathname === "/api/config" && request.method === "GET")
          return json({
            token,
            defaultCwd,
            maxAgents: 20,
            defaultModel: DEFAULT_MODEL,
            authentication: "chatgpt-subscription",
          });
        if (url.pathname === "/api/state" && request.method === "GET")
          return json(
            controller.snapshot(url.searchParams.get("run") || undefined),
          );
        if (url.pathname === "/api/models" && request.method === "GET") {
          if (!modelProbe)
            modelProbe = (async () => {
              const probe = new PiProcess({
                command:
                  controller.options.piCommand ||
                  process.env.PI_MESH_PI_BIN ||
                  "pi",
                args: [
                  "--mode",
                  "rpc",
                  "--no-session",
                  "--no-extensions",
                  "--no-skills",
                  "--no-prompt-templates",
                  "--no-context-files",
                  "--no-approve",
                  "--provider",
                  "openai-codex",
                  "--model",
                  DEFAULT_MODEL,
                ],
                cwd: defaultCwd,
                onEvent: () => {},
                onExit: () => {},
              });
              try {
                const result = await probe.request(
                  "get_available_models",
                  {},
                  15000,
                );
                return {
                  models: (result?.models || [])
                    .filter((model: any) => model.provider === "openai-codex")
                    .map((model: any) => ({
                      id: `${model.provider}/${model.id}`,
                      name: `${model.name || model.id} · ${model.provider}`,
                    })),
                };
              } catch (error) {
                return {
                  models: [],
                  error: error instanceof Error ? error.message : String(error),
                };
              } finally {
                await probe.stop();
              }
            })().then((result) => (modelCache = result));
          return json(modelCache || (await modelProbe));
        }
        if (url.pathname === "/api/events" && request.method === "GET") {
          let timer: ReturnType<typeof setInterval>;
          const stream = new ReadableStream({
            start(streamController) {
              const send = () => {
                try {
                  streamController.enqueue(
                    new TextEncoder().encode(
                      `data: ${JSON.stringify(controller.snapshot(url.searchParams.get("run") || undefined))}\n\n`,
                    ),
                  );
                } catch {
                  clearInterval(timer);
                  try {
                    streamController.close();
                  } catch {}
                }
              };
              timer = setInterval(send, 900);
              send();
              request.signal.addEventListener(
                "abort",
                () => {
                  clearInterval(timer);
                  try {
                    streamController.close();
                  } catch {}
                },
                { once: true },
              );
            },
            cancel() {
              clearInterval(timer);
            },
          });
          return new Response(stream, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            },
          });
        }
        const recordAction = url.pathname.match(
          /^\/api\/runs\/([a-zA-Z0-9-]+)\/records\/(artifacts|questions|delivery)$/,
        );
        if (recordAction && request.method === "POST") {
          const records = controller.records(recordAction[1]);
          const method = recordAction[2] as
            "artifacts" | "questions" | "delivery";
          return json(records[method](await request.json(), "human"));
        }
        const content = url.pathname.match(
          /^\/api\/runs\/([a-zA-Z0-9-]+)\/artifacts\/([a-zA-Z0-9-]+)\/(\d+)\/(\d+)\/(.+)$/,
        );
        if (content && request.method === "GET") {
          const [, runId, artifactId, revision, resource, name] = content;
          const { file, data } = controller
            .records(runId)
            .file(
              artifactId,
              Number(revision),
              Number(resource),
              decodeURIComponent(name),
            );
          return new Response(new Uint8Array(data), {
            headers: {
              "Content-Type":
                file.mime +
                (file.mime.startsWith("text/") ? "; charset=utf-8" : ""),
              "Content-Disposition": `${url.searchParams.has("download") ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(file.path.split("/").at(-1)!)}`,
              "Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
              "Content-Security-Policy":
                "sandbox allow-scripts allow-downloads; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; font-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'",
            },
          });
        }
        const bundle = url.pathname.match(
          /^\/api\/runs\/([a-zA-Z0-9-]+)\/bundle$/,
        );
        if (bundle && request.method === "GET") {
          const data = createBundle(controller.records(bundle[1]), {
            artifact: url.searchParams.get("artifact") || undefined,
            revision: url.searchParams.has("revision")
              ? Number(url.searchParams.get("revision"))
              : undefined,
            delivery: url.searchParams.has("delivery")
              ? Number(url.searchParams.get("delivery"))
              : undefined,
          });
          return new Response(new Uint8Array(data), {
            headers: {
              "Content-Type": "application/zip",
              "Content-Disposition": `attachment; filename="mesh-delivery-${bundle[1].slice(0, 8)}.zip"`,
              "Cache-Control": "no-store",
            },
          });
        }
        if (url.pathname === "/api/runs" && request.method === "POST")
          return json(controller.create(await request.json()), 201);
        const match = url.pathname.match(
          /^\/api\/runs\/([a-zA-Z0-9-]+)\/(stop|resume|messages|answer|export)$/,
        );
        if (match) {
          const [, id, action] = match;
          if (action === "resume" && request.method === "POST")
            return json(controller.resume(id));
          if (action === "stop" && request.method === "POST") {
            await controller.stop(id);
            return json({ ok: true });
          }
          if (action === "messages" && request.method === "POST")
            return json(controller.send(id, await request.json()));
          if (action === "answer" && request.method === "POST") {
            const body = (await request.json()) as any;
            controller.answer(id, body.agent, body.answer);
            return json({ ok: true });
          }
          if (action === "export" && request.method === "GET")
            return new Response(
              JSON.stringify(
                {
                  ...controller.snapshot(id),
                  messages: readMessages(controller.dirs(id), {
                    limit: Infinity,
                  }),
                },
                null,
                2,
              ),
              {
                headers: {
                  "Content-Type": "application/json",
                  "Content-Disposition": `attachment; filename="mesh-team-${id.slice(0, 8)}.json"`,
                },
              },
            );
        }
        return json({ error: "Not found" }, 404);
      } catch (error) {
        return json(
          { error: error instanceof Error ? error.message : "Request failed" },
          400,
        );
      }
    },
  });
  return {
    server,
    controller,
    async stop() {
      await controller.close();
      server.stop(true);
    },
  };
}

if (import.meta.main) {
  const dashboard = startDashboard({
    port: Number(process.env.PORT || 4317),
    dataDir: process.env.PI_MESH_DASHBOARD_DATA,
    cwd: process.env.PI_MESH_WORKSPACE,
  });
  console.log(
    `Mesh Office is ready at http://127.0.0.1:${dashboard.server.port}`,
  );
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, async () => {
      if (stopping) return;
      stopping = true;
      await dashboard.stop();
      process.exit(0);
    });
}
