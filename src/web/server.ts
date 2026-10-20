/**
 * pnpm web — the hosted demo (F15). Node `http`, no framework: one access code, a gallery of runs with an inspector,
 * a form that starts one run at a time (mock by default), live progress over SSE, and the F16 trace and metrics.
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { metrics } from "../obs/metrics.ts";
import type { RunManifest } from "../schemas.ts";
import { clearedCookie, codeMatches, cookieValue, LoginLimiter, sessionCookie, verifySession } from "./auth.ts";
import { configFromEnv, type WebConfig } from "./config.ts";
import { sendFile } from "./media.ts";
import { parseTrace } from "../obs/metrics-cli.ts";
import { explainFailure } from "./explain.ts";
import { continueSpec, pidAlive, runSpec, spawnRunner, type Mode, type RunResult, type RunSpec, type StartRun } from "./runner.ts";
import {
  BadManifest,
  callEvent,
  findRun,
  gallery,
  hasCheckpoint as checkpointOnDisk,
  inside,
  isFinished,
  loadAll,
  mtimeOf,
  provenExamples,
  readManifest,
  readNewLines,
  readRunTrace,
  records,
  RUN_MEDIA_RE,
  runMediaUrl,
  runView,
  sourcesOf,
  type Liveness,
  type ShownStatus,
} from "./runs.ts";

export const IDEA_MAX = 800;
export const BUSY = "a video is being made, try again in a few minutes";

export interface WebDeps {
  startRun?: StartRun;
  /** How often SSE re-reads a manifest. */
  pollMs?: number;
  now?: () => number;
  log?: (line: string) => void;
  /** Is there a checkpoint to continue this run from (F20)? Default: look in `<runsDir>/checkpoints.sqlite`. */
  hasCheckpoint?: (runId: string) => Promise<boolean>;
}

/**
 * The failure panel's data (F20): the plain-words explanation plus playable URLs for the take that was not shipped and
 * the shots that passed. An interrupted run with no error of its own is explained as interrupted.
 */
export function failureView(id: string, m: RunManifest) {
  const x = explainFailure(m.error ? m : { ...m, error: "interrupted: the run's process ended before it finished" });
  const { bestTake, finished, ...rest } = x;
  const bestTakeUrl = runMediaUrl(id, bestTake);
  return {
    ...rest,
    ...(bestTakeUrl ? { bestTakeUrl } : {}),
    finished: finished.flatMap((f) => {
      const url = runMediaUrl(id, f.path);
      return url ? [{ shotId: f.shotId, url }] : [];
    }),
  };
}

/** Same shape as the CLI's ids (20261019-142233-a1b2c3), so web runs sort with the others. */
export function newWebRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "x-frame-options": "DENY",
  // No external scripts, styles or media: everything comes from this origin.
  "content-security-policy": "default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
};

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }).end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, limit = 16 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, "request body too large");
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "body must be JSON");
  }
}

/** A malformed escape ("%E0%A4%A") is the client's error, not a 500. */
function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new HttpError(400, "bad path");
  }
}

const field = (body: unknown, key: string): unknown => (typeof body === "object" && body !== null ? (body as Record<string, unknown>)[key] : undefined);

function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  const xff = req.headers["x-forwarded-for"];
  if (trustProxy && typeof xff === "string" && xff.trim()) return xff.split(",").at(-1)!.trim();
  return req.socket.remoteAddress ?? "unknown";
}

/** What the `done` event (and a finished run in the list) tells the page. */
export function doneEvent(id: string, m: RunManifest | undefined, result?: RunResult, status: ShownStatus = m?.ok ? "done" : "failed") {
  const why = result
    ? `run exited (code ${result.code}) without a final video: ${result.output.trim().split("\n").at(-1) ?? ""}`
    : status === "interrupted"
      ? "the run's process ended before it finished (interrupted)"
      : "run ended without a final video";
  return {
    runId: id,
    status,
    ok: m?.ok ?? false,
    videoUrl: m?.ok && m.final ? `/media/${id}/final.mp4` : null,
    costUsd: m?.costUsd ?? 0,
    seconds: m?.final?.seconds ?? null,
    wer: m?.verbatim?.wer ?? null,
    ...(m?.error ? { error: m.error } : !m?.ok ? { error: why } : {}),
  };
}

export function createWebServer(cfg: WebConfig, deps: WebDeps = {}): Server {
  const startRun = deps.startRun ?? spawnRunner;
  const pollMs = deps.pollMs ?? 1000;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((l: string) => process.stderr.write(`${l}\n`));
  const limiter = new LoginLimiter(5, 15 * 60 * 1000);
  const publicDir = join(cfg.root, "src", "web", "public");
  const hasCheckpoint = deps.hasCheckpoint ?? ((id: string) => checkpointOnDisk(cfg.runsDir, id));
  // F20: read once at start, from the example manifests themselves, so the chips can't drift from what passed live.
  const examples = provenExamples(cfg.examplesDir, log);

  /** The one run in progress. Later runs get 409 until it ends. */
  let active: { runId: string; pid?: number } | null = null;
  /** How runs this process started ended (for a run that died before writing a manifest). */
  const results = new Map<string, RunResult>();

  /** F19: is a run alive? Ours: by its child (exited, or its pid gone). Not ours: undefined, `shownStatus` uses age. */
  const liveness = (id: string, mtimeMs: number | undefined): Liveness => {
    const alive = active?.runId === id ? (active.pid === undefined || pidAlive(active.pid)) : results.has(id) ? false : undefined;
    return { ...(alive !== undefined ? { alive } : {}), ...(mtimeMs !== undefined ? { mtimeMs } : {}), now: now() };
  };

  const authed = (req: IncomingMessage) => verifySession(cfg.sessionSecret, cookieValue(req.headers.cookie), now());

  async function login(req: IncomingMessage, res: ServerResponse) {
    const ip = clientIp(req, cfg.trustProxy);
    if (limiter.blocked(ip, now())) return json(res, 429, { error: "too many wrong codes; try again in 15 minutes" });
    const code = field(await readBody(req), "code");
    if (typeof code !== "string" || !codeMatches(code, cfg.accessCode)) {
      limiter.fail(ip, now());
      log(`login failed from ${ip}`);
      return json(res, 401, { error: "wrong code" });
    }
    json(res, 200, { ok: true }, { "set-cookie": sessionCookie(cfg.sessionSecret, now()) });
  }

  async function postRun(req: IncomingMessage, res: ServerResponse) {
    const body = await readBody(req);
    const rawIdea = field(body, "idea");
    const mode = field(body, "mode") ?? "mock";
    const idea = typeof rawIdea === "string" ? rawIdea.trim() : "";
    if (idea.length < 1 || idea.length > IDEA_MAX) throw new HttpError(400, `the idea must be 1–${IDEA_MAX} characters`);
    if (mode !== "mock" && mode !== "live") throw new HttpError(400, "mode must be mock or live");
    if (mode === "live" && !cfg.live) throw new HttpError(403, "live runs are off on this server (WEB_LIVE is not 1)");
    if (active) throw new HttpError(409, BUSY);

    const runId = newWebRunId(new Date(now()));
    launch(runSpec(cfg, idea, mode as Mode, runId), `started (${mode})`);
    json(res, 202, { runId });
  }

  /** Take the one-run lock and start the child; the lock is released when it exits. */
  function launch(spec: RunSpec, what: string): void {
    const { runId } = spec;
    active = { runId };
    log(`run ${runId} ${what}`);
    let handle;
    try {
      handle = startRun(spec);
    } catch (e) {
      active = null;
      throw e;
    }
    if (handle.pid !== undefined) active.pid = handle.pid;
    void handle.done
      .catch((e: unknown): RunResult => ({ code: null, output: (e as Error).message }))
      .then((r) => {
        results.set(runId, r);
        log(`run ${runId} exited with code ${r.code}${r.code === 0 ? "" : `: ${r.output.trim().split("\n").slice(-3).join(" | ")}`}`);
        if (active?.runId === runId) active = null;
      });
  }

  /** F20: continue a failed or interrupted run from the step its failure points at (same lock as a new run). */
  async function postContinue(res: ServerResponse, id: string) {
    if (active) throw new HttpError(409, BUSY);
    const found = await findRun(cfg.runsDir, cfg.examplesDir, id);
    if (found === null) throw new HttpError(400, "bad run id");
    if (found === undefined) throw new HttpError(404, "no such run");
    if (found.source.kind !== "run") throw new HttpError(400, "examples can't be continued");
    const m = found.manifest;
    const { status } = runView(m, liveness(id, await mtimeOf(found.source.manifest)));
    if (status !== "failed" && status !== "interrupted") throw new HttpError(400, `only a failed or interrupted run can be continued; this one is ${status}`);
    if (m.mode === "live" && !cfg.live) throw new HttpError(403, "live runs are off on this server (WEB_LIVE is not 1)");
    if (!(await hasCheckpoint(id))) throw new HttpError(400, "this run has no checkpoint to continue from");
    // The lock is checked again: the awaits above let another request in.
    if (active) throw new HttpError(409, BUSY);
    const f = failureView(id, m);
    launch(continueSpec(cfg, m, f.step, f.freshTakes), `continued from ${f.step ?? "its checkpoint"}${f.freshTakes ? " with fresh takes" : ""}`);
    json(res, 202, { runId: id, step: f.step, freshTakes: f.freshTakes, estimateUsd: f.estimateUsd });
  }

  async function events(req: IncomingMessage, res: ServerResponse, id: string) {
    const sources = sourcesOf(cfg.runsDir, cfg.examplesDir, id);
    if (!sources) throw new HttpError(400, "bad run id");
    const known = active?.runId === id || results.has(id) || (await findRun(cfg.runsDir, cfg.examplesDir, id).catch(() => true));
    if (!known) throw new HttpError(404, "no such run");

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write(": stream open\n\n");
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    let sent = 0;
    // F19: the trace is written live, per provider call; the manifest only per finished node (one node can take
    // minutes). Tailing it fills the gaps between attempts.
    const tracePath = join(sources[0]!.dir, "trace.jsonl");
    let traceOffset = 0;
    let calls = 0;
    let closed = false;
    req.on("close", () => (closed = true));

    while (!closed) {
      const ours = active?.runId === id;
      let m: RunManifest | undefined;
      let mtimeMs: number | undefined;
      for (const s of sources) {
        try {
          m = await readManifest(s.manifest);
        } catch (e) {
          if (!(e instanceof BadManifest)) throw e; // half-written: read it again on the next tick
        }
        if (m) {
          mtimeMs = await mtimeOf(s.manifest);
          break;
        }
      }
      if (m) for (; sent < m.attempts.length; sent++) send("attempt", { index: sent, ...m.attempts[sent] });
      const tail = await readNewLines(tracePath, traceOffset);
      traceOffset = tail.offset;
      for (const span of parseTrace(tail.lines.join("\n"))) if (span.kind !== "node") send("call", callEvent(span, calls++));
      const view = m ? runView(m, liveness(id, mtimeMs)) : undefined;
      if (m && view) send("progress", { costUsd: m.costUsd, attempts: m.attempts.length, ...view });
      // Keep following while it runs: our child, or (F19) a run with a status that someone else started.
      const following = ours || (m?.status !== undefined && view?.status === "running");
      // While our child runs, a finished manifest is the one it is about to replace (F20 Continue starts from a
      // `failed` one): follow until the child exits, then report what it left.
      if ((m && isFinished(m) && !ours) || !following) {
        send("done", doneEvent(id, m, results.get(id), view?.status === "running" ? "interrupted" : view?.status));
        break;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    res.end();
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    const method = req.method ?? "GET";
    const get = method === "GET" || method === "HEAD";

    // Public routes.
    if (get && path === "/health") return void res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    if (get && (path === "/app.js" || path === "/app.css")) {
      return sendFile(req, res, join(publicDir, path.slice(1)), path.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8", "no-cache");
    }
    if (get && path === "/login") return sendFile(req, res, join(publicDir, "index.html"), "text/html; charset=utf-8", "no-cache");
    if (method === "POST" && path === "/login") return login(req, res);
    if (method === "POST" && path === "/logout") return json(res, 200, { ok: true }, { "set-cookie": clearedCookie });

    if (!authed(req)) {
      if (path.startsWith("/api/") || path.startsWith("/media/")) return json(res, 401, { error: "log in first" });
      return void res.writeHead(302, { location: "/login" }).end();
    }

    if (get && path === "/") return sendFile(req, res, join(publicDir, "index.html"), "text/html; charset=utf-8", "no-cache");
    if (get && path === "/api/config") {
      return json(res, 200, { live: cfg.live, maxCostUsd: cfg.maxCostUsd, ideaMax: IDEA_MAX, active: active?.runId ?? null, examples: await examples });
    }
    if (path === "/api/runs") {
      if (method === "POST") return postRun(req, res);
      if (get) return json(res, 200, gallery(await loadAll(cfg.runsDir, cfg.examplesDir, log), (x) => runView(x.manifest, liveness(x.id, x.mtimeMs))));
    }
    if (get && path === "/api/metrics") {
      // A run in progress is not a failure yet (F19): it joins the numbers when it ends.
      const all = (await loadAll(cfg.runsDir, cfg.examplesDir, log)).filter((x) => x.manifest.status !== "running");
      return json(res, 200, metrics(await records(all)));
    }

    const run = /^\/api\/runs\/([^/]+)(?:\/(events|trace|continue))?$/.exec(path);
    if (method === "POST" && run?.[2] === "continue") return postContinue(res, decode(run[1]!));
    if (get && run && run[2] !== "continue") {
      const id = decode(run[1]!);
      if (run[2] === "events") return events(req, res, id);
      const found = await findRun(cfg.runsDir, cfg.examplesDir, id);
      if (found === null) throw new HttpError(400, "bad run id");
      if (found === undefined) throw new HttpError(404, "no such run");
      if (run[2] === "trace") return json(res, 200, found.source.kind === "run" ? await readRunTrace(found.source.dir) : []);
      // The manifest plus how it looks now (F19): `status` may read "interrupted", which no manifest says of itself.
      // F20: a failed or interrupted run also carries `failure`, the explanation the page shows instead of a raw error.
      const view = runView(found.manifest, liveness(id, await mtimeOf(found.source.manifest)));
      const failed = view.status === "failed" || view.status === "interrupted";
      return json(res, 200, { ...found.manifest, ...view, ...(failed ? { failure: failureView(id, found.manifest) } : {}) });
    }

    const media = /^\/media\/([^/]+)\/([^/]+)$/.exec(path);
    if (get && media) {
      const [a, b] = [decode(media[1]!), decode(media[2]!)];
      // A run's files: final.mp4 and (F20) its shot takes, by exact name pattern; never anything else in the folder.
      const file = a === "examples" ? (b.endsWith(".mp4") ? inside(cfg.examplesDir, b.slice(0, -4), ".mp4") : null) : RUN_MEDIA_RE.test(b) ? inside(cfg.runsDir, a) : null;
      if (!file) throw new HttpError(404, "not found");
      return sendFile(req, res, a === "examples" ? file : join(file, b), "video/mp4");
    }

    throw new HttpError(404, "not found");
  }

  return createServer((req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    route(req, res).catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status : 500;
      if (!(e instanceof HttpError)) log(`error on ${req.method} ${req.url}: ${(e as Error).stack ?? String(e)}`);
      if (res.headersSent) return void res.end();
      json(res, status, { error: e instanceof HttpError ? e.message : e instanceof BadManifest ? "this run's manifest is unreadable" : "server error" });
    });
  });
}

export async function main(env: Record<string, string | undefined> = process.env, err: (l: string) => void = (l) => process.stderr.write(`${l}\n`)): Promise<number> {
  let cfg: WebConfig;
  try {
    cfg = configFromEnv(env);
  } catch (e) {
    err(`web: ${(e as Error).message}`);
    return 1;
  }
  const server = createWebServer(cfg, { log: err });
  await new Promise<void>((r) => server.listen(cfg.port, r));
  err(`web: listening on :${cfg.port} (runs ${cfg.runsDir}, examples ${cfg.examplesDir}, live ${cfg.live ? "ON" : "off"}, MAX_COST_USD $${cfg.maxCostUsd})`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const code = await main();
  if (code !== 0) process.exit(code);
}
