/**
 * F15 web demo: the server runs in-process on a random port with temp dirs. Runs use a fake `startRun` that writes a
 * manifest over time, except the one slow test that drives the real CLI in mock mode.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli.ts";
import { probe } from "../src/media/ffmpeg.ts";
import type { Attempt, RunManifest } from "../src/schemas.ts";
import { codeMatches, LoginLimiter, signSession, verifySession } from "../src/web/auth.ts";
import { configFromEnv, type WebConfig } from "../src/web/config.ts";
import { parseRange } from "../src/web/media.ts";
import { runSpec, spawnRunner, type RunSpec, type StartRun } from "../src/web/runner.ts";
import { createWebServer, main as webMain } from "../src/web/server.ts";

const ROOT = join(import.meta.dirname, "..");
const SECRET = "test-session-secret-0123456789";
const SLOW = 180_000;

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "itv-web-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

let n = 0;
async function dirs() {
  const base = join(tmp, `case-${++n}`);
  const runsDir = join(base, "runs");
  const examplesDir = join(base, "examples");
  await mkdir(runsDir, { recursive: true });
  await mkdir(examplesDir, { recursive: true });
  return { runsDir, examplesDir };
}

function config(over: Partial<WebConfig> & { runsDir: string; examplesDir: string }): WebConfig {
  return {
    accessCode: "test-code",
    sessionSecret: SECRET,
    port: 0,
    live: false,
    maxCostUsd: 3,
    trustProxy: false,
    root: ROOT,
    ...over,
  };
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function start(cfg: WebConfig, deps: Parameters<typeof createWebServer>[1] = {}) {
  const server = createWebServer(cfg, { pollMs: 25, log: () => {}, ...deps });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, base };
}

async function login(base: string, code = "test-code") {
  return fetch(`${base}/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
}

/** The `name=value` part of the session cookie the server set. */
async function cookieOf(base: string): Promise<string> {
  const res = await login(base);
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

function manifest(over: Partial<RunManifest> = {}): RunManifest {
  return {
    runId: "r1",
    idea: 'A man says: "Hello there."',
    mode: "mock",
    createdAt: "2026-10-19T10:00:00.000Z",
    attempts: [],
    costUsd: 0,
    ok: true,
    final: { path: "final.mp4", seconds: 12, width: 720, height: 1280, hasAudio: true },
    verbatim: { expected: "hello there", heard: "hello there", wer: 0, ops: [], pass: true },
    ...over,
  };
}

const attempt = (stage: string, ok = true, extra: Partial<Attempt> = {}): Attempt => ({
  stage,
  n: 1,
  provider: "mock",
  ok,
  costUsd: 0.01,
  ms: 5,
  ...extra,
});

async function writeRun(runsDir: string, m: RunManifest, video?: Buffer) {
  await mkdir(join(runsDir, m.runId), { recursive: true });
  await writeFile(join(runsDir, m.runId, "manifest.json"), JSON.stringify(m));
  if (video) await writeFile(join(runsDir, m.runId, "final.mp4"), video);
}

/** Reads an SSE stream to the end: [{event, data}]. */
async function readSse(res: Response): Promise<{ event: string; data: unknown }[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((b) => b.trim() && !b.startsWith(":"))
    .map((b) => {
      const lines = b.split("\n");
      const event = lines.find((l) => l.startsWith("event: "))?.slice(7) ?? "message";
      const data = lines.filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
      return { event, data: JSON.parse(data) as unknown };
    });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("config (1)", () => {
  it("refuses to start without ACCESS_CODE or SESSION_SECRET", async () => {
    expect(() => configFromEnv({ SESSION_SECRET: SECRET })).toThrow(/ACCESS_CODE/);
    expect(() => configFromEnv({ ACCESS_CODE: "x" })).toThrow(/SESSION_SECRET/);
    expect(() => configFromEnv({ ACCESS_CODE: "  ", SESSION_SECRET: SECRET })).toThrow(/ACCESS_CODE/);
    const errs: string[] = [];
    expect(await webMain({ SESSION_SECRET: SECRET }, (l) => errs.push(l))).toBe(1);
    expect(errs.join("\n")).toMatch(/ACCESS_CODE/);
  });

  it("reads defaults and overrides from env", () => {
    const c = configFromEnv({ ACCESS_CODE: "c", SESSION_SECRET: SECRET });
    expect(c).toMatchObject({ port: 8080, live: false, maxCostUsd: 3 });
    expect(c.runsDir).toMatch(/runs$/);
    expect(c.examplesDir).toMatch(/examples$/);
    const d = configFromEnv({ ACCESS_CODE: "c", SESSION_SECRET: SECRET, PORT: "9000", WEB_LIVE: "1", MAX_COST_USD: "1.5", RUNS_DIR: "/tmp/r" });
    expect(d).toMatchObject({ port: 9000, live: true, maxCostUsd: 1.5, runsDir: "/tmp/r" });
    expect(() => configFromEnv({ ACCESS_CODE: "c", SESSION_SECRET: SECRET, MAX_COST_USD: "lots" })).toThrow(/MAX_COST_USD/);
  });
});

describe("auth (1)", () => {
  it("signs and verifies sessions; forged, tampered and expired ones fail", () => {
    const now = 1_000_000;
    const v = signSession(SECRET, now + 1000);
    expect(verifySession(SECRET, v, now)).toBe(true);
    expect(verifySession(SECRET, v, now + 1001)).toBe(false);
    expect(verifySession("other-secret-0123456789", v, now)).toBe(false);
    expect(verifySession(SECRET, v.replace(/^\d+/, String(now + 10_000_000)), now)).toBe(false);
    expect(verifySession(SECRET, "garbage", now)).toBe(false);
    expect(verifySession(SECRET, undefined, now)).toBe(false);
    expect(codeMatches("test-code", "test-code")).toBe(true);
    expect(codeMatches("test-cod", "test-code")).toBe(false);
    expect(codeMatches("", "test-code")).toBe(false);
  });

  it("limits failed logins: 5 per 15 minutes per IP", () => {
    const l = new LoginLimiter(5, 15 * 60_000);
    for (let i = 0; i < 5; i++) {
      expect(l.blocked("a", i)).toBe(false);
      l.fail("a", i);
    }
    expect(l.blocked("a", 10)).toBe(true);
    expect(l.blocked("b", 10)).toBe(false);
    expect(l.blocked("a", 15 * 60_000 + 5)).toBe(false); // the oldest failures aged out
  });

  it("protects the API and pages; the right code sets a HttpOnly, Secure, SameSite=Lax cookie", async () => {
    const { base } = await start(config(await dirs()));
    expect((await fetch(`${base}/api/runs`)).status).toBe(401);
    const page = await fetch(`${base}/`, { redirect: "manual" });
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toBe("/login");
    expect((await fetch(`${base}/login`)).status).toBe(200);
    expect(await (await fetch(`${base}/health`)).text()).toBe("ok");
    expect((await fetch(`${base}/app.js`)).status).toBe(200);
    expect((await fetch(`${base}/app.css`)).status).toBe(200);

    expect((await login(base, "wrong")).status).toBe(401);
    const ok = await login(base);
    expect(ok.status).toBe(200);
    const set = ok.headers.get("set-cookie")!;
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/Secure/i);
    expect(set).toMatch(/SameSite=Lax/i);
    expect(set).toMatch(/Max-Age=604800/);
    const cookie = set.split(";")[0]!;
    expect((await fetch(`${base}/api/runs`, { headers: { cookie } })).status).toBe(200);
    expect((await fetch(`${base}/`, { headers: { cookie }, redirect: "manual" })).status).toBe(200);
  });

  it("the 6th wrong code within 15 min is 429, even if the 6th is right", async () => {
    const { base } = await start(config(await dirs()));
    for (let i = 0; i < 5; i++) expect((await login(base, `wrong-${i}`)).status).toBe(401);
    expect((await login(base, "wrong-6")).status).toBe(429);
    expect((await login(base, "test-code")).status).toBe(429);
  });

  it("a forged or expired cookie is 401", async () => {
    const { base } = await start(config(await dirs()));
    const forged = `itv_session=${signSession("not-the-secret-0123456789", Date.now() + 60_000)}`;
    const expired = `itv_session=${signSession(SECRET, Date.now() - 1)}`;
    const tampered = `itv_session=${Date.now() + 60_000}.${"0".repeat(64)}`;
    for (const cookie of [forged, expired, tampered]) {
      expect((await fetch(`${base}/api/runs`, { headers: { cookie } })).status).toBe(401);
    }
  });
});

/** A fake runner: writes the manifest of a run in three steps, then finishes. */
function fakeRunner(calls: RunSpec[], opts: { stepMs?: number; ok?: boolean } = {}): StartRun {
  return (spec) => {
    calls.push(spec);
    const runsDir = spec.env.RUNS_DIR!;
    const done = (async () => {
      const steps: Attempt[] = [
        attempt("script"),
        attempt("video", false, { shotId: "s1", reason: "verbatim miss: heard \"hello their\"" }),
        attempt("video", true, { shotId: "s1", n: 2 }),
      ];
      for (let i = 1; i <= steps.length; i++) {
        await sleep(opts.stepMs ?? 30);
        const last = i === steps.length;
        const ok = last && (opts.ok ?? true);
        await writeRun(
          runsDir,
          manifest({
            runId: spec.runId,
            idea: spec.idea,
            mode: spec.mode,
            attempts: steps.slice(0, i),
            costUsd: 0.01 * i,
            ok,
            ...(last ? {} : { final: undefined, verbatim: undefined }),
          }),
          last ? Buffer.alloc(2000, 7) : undefined,
        );
      }
      return { code: 0, output: "" };
    })();
    return { done };
  };
}

describe("runs (2)", () => {
  it("validates the idea and the mode", async () => {
    const calls: RunSpec[] = [];
    const { base } = await start(config(await dirs()), { startRun: fakeRunner(calls) });
    const cookie = await cookieOf(base);
    const post = (body: unknown) =>
      fetch(`${base}/api/runs`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await post({ idea: "a fine idea", mode: "live" })).status).toBe(403);
    expect((await post({ idea: "", mode: "mock" })).status).toBe(400);
    expect((await post({ idea: "   ", mode: "mock" })).status).toBe(400);
    expect((await post({ idea: "x".repeat(801), mode: "mock" })).status).toBe(400);
    expect((await post({ idea: "fine", mode: "turbo" })).status).toBe(400);
    expect((await fetch(`${base}/api/runs`, { method: "POST", headers: { cookie }, body: "{not json" })).status).toBe(400);
    expect(calls).toHaveLength(0);
    // 800 chars after trimming is fine.
    expect((await post({ idea: `  ${"x".repeat(800)}  `, mode: "mock" })).status).toBe(202);
    expect(calls[0]!.idea).toBe("x".repeat(800));
  });

  it("allows live only with WEB_LIVE=1", async () => {
    const calls: RunSpec[] = [];
    const { base } = await start(config({ ...(await dirs()), live: true }), { startRun: fakeRunner(calls) });
    const cookie = await cookieOf(base);
    const res = await fetch(`${base}/api/runs`, { method: "POST", headers: { cookie }, body: JSON.stringify({ idea: "an idea", mode: "live" }) });
    expect(res.status).toBe(202);
    expect(calls[0]!.mode).toBe("live");
    expect(calls[0]!.args).toContain("--live");
  });

  it("runs one at a time, passes the idea as one argument and MAX_COST_USD in the env", async () => {
    const calls: RunSpec[] = [];
    const d = await dirs();
    const { base } = await start(config({ ...d, maxCostUsd: 1.25 }), { startRun: fakeRunner(calls, { stepMs: 80 }) });
    const cookie = await cookieOf(base);
    const idea = `A spy whispers: "--live; rm -rf ~ $(whoami) \`id\`" and leaves.`;
    const post = () => fetch(`${base}/api/runs`, { method: "POST", headers: { cookie }, body: JSON.stringify({ idea, mode: "mock" }) });
    const first = await post();
    expect(first.status).toBe(202);
    const { runId } = (await first.json()) as { runId: string };
    expect(runId).toMatch(/^[\w-]+$/);

    const second = await post();
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: string }).error).toMatch(/a video is being made, try again in a few minutes/);

    const spec = calls[0]!;
    expect(calls).toHaveLength(1);
    expect(spec.args.filter((a) => a === idea)).toHaveLength(1);
    // The idea comes after "--", so even "--live" inside it can never become a flag.
    expect(spec.args.slice(-2)).toEqual(["--", idea]);
    expect(spec.args).toEqual(expect.arrayContaining(["src/cli.ts", "--mock", "--json", "--run-id", runId]));
    expect(spec.args).not.toContain("--live");
    expect(spec.command).not.toMatch(/(^|\/)(sh|bash|zsh)$/);
    expect(spec.env.MAX_COST_USD).toBe("1.25");
    expect(spec.env.RUNS_DIR).toBe(d.runsDir);
    // The server's own secrets never reach the child.
    expect(spec.env.ACCESS_CODE).toBeUndefined();
    expect(spec.env.SESSION_SECRET).toBeUndefined();

    // After the run ends the next one is accepted.
    await readSse(await fetch(`${base}/api/runs/${runId}/events`, { headers: { cookie } }));
    await sleep(20);
    expect((await post()).status).toBe(202);
  });

  it("the default runner spawns without a shell: the idea arrives as one argv entry", async () => {
    const out = join(tmp, "argv.json");
    const idea = `He says: "$(touch /tmp/pwned) ; echo hi > x" 'quoted' * ?`;
    const script = "require('fs').writeFileSync(process.env.OUT, JSON.stringify({ argv: process.argv.slice(1), max: process.env.MAX_COST_USD }))";
    const { done } = spawnRunner({
      runId: "r",
      idea,
      mode: "mock",
      command: process.execPath,
      args: ["-e", script, "--", idea],
      env: { ...process.env, OUT: out, MAX_COST_USD: "2" },
      cwd: tmp,
    });
    expect((await done).code).toBe(0);
    const got = JSON.parse(await readFile(out, "utf8")) as { argv: string[]; max: string };
    expect(got.argv).toContain(idea);
    expect(got.max).toBe("2");
  });

  it("runSpec builds the CLI command; the CLI accepts --run-id and --", () => {
    const cfg = config({ runsDir: "/r", examplesDir: "/e", maxCostUsd: 3 });
    const s = runSpec(cfg, "--live idea", "mock", "id-1", { PATH: "/bin", ACCESS_CODE: "x", SESSION_SECRET: "y", FAL_KEY: "k" });
    expect(s.env).toMatchObject({ PATH: "/bin", FAL_KEY: "k", MAX_COST_USD: "3", RUNS_DIR: "/r" });
    const cliArgs = s.args.slice(s.args.indexOf("src/cli.ts") + 1);
    expect(parseArgs(cliArgs)).toEqual({ idea: "--live idea", mode: "mock", json: true, runId: "id-1" });
    expect(() => parseArgs(["idea", "--run-id", "../x"])).toThrow(/--run-id/);
    expect(() => parseArgs(["--resume", "r1", "--run-id", "x"])).toThrow(/--run-id/);
  });
});

describe("SSE (3)", () => {
  it("delivers attempts in order, then done with ok and the video URL", async () => {
    const calls: RunSpec[] = [];
    const { base } = await start(config(await dirs()), { startRun: fakeRunner(calls) });
    const cookie = await cookieOf(base);
    const res = await fetch(`${base}/api/runs`, { method: "POST", headers: { cookie }, body: JSON.stringify({ idea: "an idea", mode: "mock" }) });
    const { runId } = (await res.json()) as { runId: string };
    const sse = await fetch(`${base}/api/runs/${runId}/events`, { headers: { cookie } });
    expect(sse.headers.get("content-type")).toMatch(/text\/event-stream/);
    const events = await readSse(sse);
    const attempts = events.filter((e) => e.event === "attempt").map((e) => e.data as Attempt & { index: number });
    expect(attempts.map((a) => [a.index, a.stage, a.ok])).toEqual([
      [0, "script", true],
      [1, "video", false],
      [2, "video", true],
    ]);
    expect(attempts[1]!.reason).toMatch(/verbatim miss/);
    const last = events.at(-1)!;
    expect(last.event).toBe("done");
    expect(last.data).toMatchObject({ ok: true, runId, videoUrl: `/media/${runId}/final.mp4`, costUsd: 0.03 });
    // The finished run is now in the gallery.
    const list = (await (await fetch(`${base}/api/runs`, { headers: { cookie } })).json()) as { id: string }[];
    expect(list.map((r) => r.id)).toContain(runId);
  });

  it("reports a failed run as done with ok false, and an unknown run as 404", async () => {
    const calls: RunSpec[] = [];
    const { base } = await start(config(await dirs()), { startRun: fakeRunner(calls, { ok: false }) });
    const cookie = await cookieOf(base);
    const res = await fetch(`${base}/api/runs`, { method: "POST", headers: { cookie }, body: JSON.stringify({ idea: "an idea", mode: "mock" }) });
    const { runId } = (await res.json()) as { runId: string };
    const events = await readSse(await fetch(`${base}/api/runs/${runId}/events`, { headers: { cookie } }));
    expect(events.at(-1)).toMatchObject({ event: "done", data: { ok: false, videoUrl: null } });
    expect((await fetch(`${base}/api/runs/nope-123/events`, { headers: { cookie } })).status).toBe(404);
    expect((await fetch(`${base}/api/runs/${runId}/events`)).status).toBe(401);
  });
});

describe("paths and media (4)", () => {
  it("rejects traversal and bad ids", async () => {
    const d = await dirs();
    await writeRun(d.runsDir, manifest({ runId: "good-1" }));
    const { base } = await start(config(d));
    const cookie = await cookieOf(base);
    // A real folder whose name is not a plain id must still be refused by the id rule, not found by accident.
    await writeRun(d.runsDir, manifest({ runId: "a.b" }), Buffer.alloc(10));
    const cases: [string, number[]][] = [
      ["/api/runs/..%2F..%2Fetc", [400]],
      ["/api/runs/..%2F..%2Fetc/trace", [400]],
      ["/api/runs/..%2F..%2Fetc/events", [400]],
      ["/api/runs/a.b", [400]],
      ["/api/runs/%E0%A4%A", [400]],
      ["/api/runs/%2E%2E/events", [400, 404]], // the URL parser folds %2E%2E into ".." itself
      ["/media/..%2Fx/final.mp4", [404]],
      ["/media/a.b/final.mp4", [404]],
      ["/media/examples/..%2F..%2Fpackage.json", [404]],
      ["/media/examples/..%2F..%2Fx.mp4", [404]],
    ];
    for (const [p, want] of cases) {
      const s = (await fetch(`${base}${p}`, { headers: { cookie } })).status;
      expect(want, `${p} → ${s}`).toContain(s);
    }
    const ok = await fetch(`${base}/api/runs/good-1`, { headers: { cookie } });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as RunManifest).runId).toBe("good-1");
    expect((await fetch(`${base}/api/runs/missing`, { headers: { cookie } })).status).toBe(404);
  });

  it("an invalid manifest is not served as a run", async () => {
    const d = await dirs();
    await mkdir(join(d.runsDir, "bad"), { recursive: true });
    await writeFile(join(d.runsDir, "bad", "manifest.json"), JSON.stringify({ runId: "bad" }));
    const { base } = await start(config(d));
    const cookie = await cookieOf(base);
    expect((await fetch(`${base}/api/runs/bad`, { headers: { cookie } })).status).toBe(500);
    const list = (await (await fetch(`${base}/api/runs`, { headers: { cookie } })).json()) as unknown[];
    expect(list).toEqual([]);
  });

  it("parses Range headers", () => {
    expect(parseRange(undefined, 1000)).toBeNull();
    expect(parseRange("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=900-", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange("bytes=990-2000", 1000)).toEqual({ start: 990, end: 999 });
    expect(parseRange("bytes=1000-", 1000)).toBe("unsatisfiable");
    expect(parseRange("bytes=5-1", 1000)).toBe("unsatisfiable");
    expect(parseRange("items=0-1", 1000)).toBeNull();
  });

  it("answers a Range request with 206 and the right Content-Range, behind auth", async () => {
    const d = await dirs();
    const video = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
    await writeRun(d.runsDir, manifest({ runId: "vid-1" }), video);
    await writeFile(join(d.examplesDir, "01-ex.mp4"), video);
    const { base } = await start(config(d));
    const cookie = await cookieOf(base);
    expect((await fetch(`${base}/media/vid-1/final.mp4`)).status).toBe(401);
    for (const url of ["/media/vid-1/final.mp4", "/media/examples/01-ex.mp4"]) {
      const r = await fetch(`${base}${url}`, { headers: { cookie, range: "bytes=100-199" } });
      expect(r.status).toBe(206);
      expect(r.headers.get("content-range")).toBe("bytes 100-199/1000");
      expect(r.headers.get("content-type")).toBe("video/mp4");
      expect(r.headers.get("accept-ranges")).toBe("bytes");
      expect(Buffer.from(await r.arrayBuffer())).toEqual(video.subarray(100, 200));
    }
    const full = await fetch(`${base}/media/vid-1/final.mp4`, { headers: { cookie } });
    expect(full.status).toBe(200);
    expect(full.headers.get("content-length")).toBe("1000");
    const bad = await fetch(`${base}/media/vid-1/final.mp4`, { headers: { cookie, range: "bytes=5000-" } });
    expect(bad.status).toBe(416);
    expect(bad.headers.get("content-range")).toBe("bytes */1000");
  });
});

describe("trace, metrics and the gallery (5, 6)", () => {
  async function seeded() {
    const d = await dirs();
    await writeRun(d.runsDir, manifest({ runId: "20261019-100000-aaaaaa", createdAt: "2026-10-19T10:00:00.000Z", attempts: [attempt("script")], costUsd: 0.01 }));
    // An unfinished run (no ok, no error) is not in the gallery.
    await writeRun(d.runsDir, manifest({ runId: "20261019-110000-bbbbbb", createdAt: "2026-10-19T11:00:00.000Z", ok: false, final: undefined }));
    const span = { id: "a1", runId: "20261019-100000-aaaaaa", node: "writeScript", kind: "llm", provider: "mock", startedAt: "2026-10-19T10:00:00.000Z", ms: 3, ok: true, costUsd: 0, request: { prompt: "p" }, response: { text: "t" } };
    await writeFile(join(d.runsDir, "20261019-100000-aaaaaa", "trace.jsonl"), `${JSON.stringify(span)}\n${JSON.stringify({ ...span, id: "a2", kind: "node" })}\n{"partial`);
    // Real example manifests (one pre-F11 legacy script) with their videos.
    for (const f of ["01-barista", "03-watchmaker-numbers"]) {
      await copyFile(join(ROOT, "examples", `${f}.manifest.json`), join(d.examplesDir, `${f}.manifest.json`));
      await writeFile(join(d.examplesDir, `${f}.mp4`), Buffer.alloc(10));
    }
    return d;
  }

  it("/api/runs/:id/trace returns the spans; a run without a trace gives []", async () => {
    const d = await seeded();
    const { base } = await start(config(d));
    const cookie = await cookieOf(base);
    const spans = (await (await fetch(`${base}/api/runs/20261019-100000-aaaaaa/trace`, { headers: { cookie } })).json()) as { id: string }[];
    expect(spans.map((s) => s.id)).toEqual(["a1", "a2"]);
    const none = await fetch(`${base}/api/runs/01-barista/trace`, { headers: { cookie } });
    expect(none.status).toBe(200);
    expect(await none.json()).toEqual([]);
    expect((await fetch(`${base}/api/runs/20261019-100000-aaaaaa/trace`)).status).toBe(401);
  });

  it("/api/metrics returns the F16 metrics over runs and examples", async () => {
    const d = await seeded();
    const { base } = await start(config(d));
    const cookie = await cookieOf(base);
    const m = (await (await fetch(`${base}/api/metrics`, { headers: { cookie } })).json()) as Record<string, unknown>;
    expect(m).toMatchObject({ runs: 4, traced: 1 });
    for (const k of ["successRate", "verbatimFirstTakeRate", "costPerVideoUsd", "wallMs", "fallbacks", "judge", "topFailures", "modelCalls"]) {
      expect(m).toHaveProperty(k);
    }
  });

  it("/api/runs lists finished runs and the examples, newest first, with cost and WER", async () => {
    const d = await seeded();
    const { base } = await start(config(d));
    const cookie = await cookieOf(base);
    const list = (await (await fetch(`${base}/api/runs`, { headers: { cookie } })).json()) as {
      id: string;
      kind: string;
      title: string;
      idea: string;
      ok: boolean;
      seconds: number | null;
      costUsd: number;
      wer: number | null;
      thumbTime: number;
      videoUrl: string | null;
      createdAt: string;
    }[];
    // Run 10:00 on 10-19, watchmaker 07:18 on 10-19, barista on 10-18; the unfinished 11:00 run is left out.
    expect(list.map((r) => r.id)).toEqual(["20261019-100000-aaaaaa", "03-watchmaker-numbers", "01-barista"]);
    const ex = list.find((r) => r.id === "01-barista")!;
    const raw = JSON.parse(await readFile(join(ROOT, "examples", "01-barista.manifest.json"), "utf8")) as RunManifest & { script: { title: string } };
    expect(ex).toMatchObject({ kind: "example", ok: true, costUsd: raw.costUsd, wer: 0, videoUrl: "/media/examples/01-barista.mp4", title: raw.script.title, idea: raw.idea });
    expect(ex.seconds).toBeGreaterThan(0);
    expect(ex.thumbTime).toBeGreaterThan(0);
    expect(ex.thumbTime).toBeLessThan(ex.seconds!);
    const run = list.find((r) => r.kind === "run")!;
    expect(run).toMatchObject({ costUsd: 0.01, wer: 0, videoUrl: "/media/20261019-100000-aaaaaa/final.mp4" });
    // An example's manifest is served by id too.
    expect((await fetch(`${base}/api/runs/03-watchmaker-numbers`, { headers: { cookie } })).status).toBe(200);
  });

  it("/api/config says whether live is allowed and the page assets have no external scripts", async () => {
    const { base } = await start(config({ ...(await dirs()), live: false }));
    const cookie = await cookieOf(base);
    expect(await (await fetch(`${base}/api/config`, { headers: { cookie } })).json()).toMatchObject({ live: false, maxCostUsd: 3 });
    const html = await (await fetch(`${base}/login`)).text();
    for (const m of html.matchAll(/<script[^>]*src="([^"]+)"/g)) expect(m[1]).toMatch(/^\/[\w.-]+$/);
    expect(html).not.toMatch(/https?:\/\//);
  });
});

describe("real mock run through the CLI (7)", () => {
  it("slow: POST → SSE → a playable final.mp4 under /media/<id>/final.mp4", { timeout: SLOW }, async () => {
    const d = await dirs();
    const { base } = await start(config(d), { pollMs: 250 });
    const cookie = await cookieOf(base);
    const idea = `A man on a rooftop calls his brother. He says: "I kept the watch. I kept everything."`;
    const res = await fetch(`${base}/api/runs`, { method: "POST", headers: { cookie }, body: JSON.stringify({ idea, mode: "mock" }) });
    expect(res.status).toBe(202);
    const { runId } = (await res.json()) as { runId: string };
    const events = await readSse(await fetch(`${base}/api/runs/${runId}/events`, { headers: { cookie } }));
    expect(events.filter((e) => e.event === "attempt").length).toBeGreaterThan(0);
    const done = events.at(-1)!;
    expect(done.event).toBe("done");
    expect(done.data).toMatchObject({ ok: true, videoUrl: `/media/${runId}/final.mp4` });
    const video = await fetch(`${base}/media/${runId}/final.mp4`, { headers: { cookie } });
    expect(video.status).toBe(200);
    const file = join(tmp, `${runId}.mp4`);
    await writeFile(file, Buffer.from(await video.arrayBuffer()));
    const p = await probe(file);
    expect(p.hasVideo).toBe(true);
    expect(p.hasAudio).toBe(true);
    expect(p.height).toBeGreaterThan(p.width);
    expect(p.seconds).toBeGreaterThanOrEqual(8);
    expect(p.seconds).toBeLessThanOrEqual(30);
  });
});

describe("deploy (8): static checks (no Docker on this machine)", () => {
  const read = (p: string) => readFile(join(ROOT, p), "utf8");

  it("Dockerfile: base image, ffmpeg, pnpm, no .env, CMD", async () => {
    const df = await read("deploy/Dockerfile");
    expect(df).toMatch(/^FROM node:22-bookworm-slim\b/m);
    expect(df).toMatch(/apt-get install[^\n]*ffmpeg[^\n]*fonts-dejavu-core/);
    expect(df).toMatch(/corepack enable/);
    expect(df).toMatch(/pnpm install --frozen-lockfile --prod=false/);
    expect(df).toMatch(/^CMD \["pnpm", ?"web"\]$/m);
    // No line copies .env in, and the build fails if one slipped through the context.
    expect(df).not.toMatch(/^(COPY|ADD)[^\n]*\.env/m);
    expect(df).toMatch(/\.env[^\n]*exit 1/);
    const ignore = (await read(".dockerignore")).split("\n").map((l) => l.trim());
    for (const p of ["**/.env", "**/.env.*", "runs", "node_modules", ".git"]) expect(ignore).toContain(p);
  });

  it("docker-compose.yml: one service on the coolify network with Traefik labels", async () => {
    const dc = await read("deploy/docker-compose.yml");
    expect(dc).toMatch(/^\s{2}itv-web:/m);
    expect(dc).toMatch(/restart: unless-stopped/);
    expect(dc).toMatch(/env_file:\s*\n?\s*-?\s*\.env/);
    expect(dc).toMatch(/- \.\/runs:\/app\/runs/);
    expect(dc).toMatch(/networks:\s*\n\s+coolify:\s*\n\s+external: true/);
    expect(dc).toMatch(/traefik\.enable=true/);
    expect(dc).toMatch(/traefik\.http\.routers\.itv-web\.rule=Host\(`\$\{APP_DOMAIN\}`\)/);
    expect(dc).toMatch(/traefik\.http\.routers\.itv-web\.entrypoints=https/);
    expect(dc).toMatch(/traefik\.http\.routers\.itv-web\.tls=true/);
    expect(dc).toMatch(/traefik\.http\.routers\.itv-web\.tls\.certresolver=letsencrypt/);
    expect(dc).toMatch(/traefik\.http\.services\.itv-web\.loadbalancer\.server\.port=8080/);
    expect(dc).not.toMatch(/ports:/); // only reachable through Traefik
  });

  it("README documents env vars and the server's quirks", async () => {
    const r = await read("deploy/README.md");
    for (const k of ["ACCESS_CODE", "SESSION_SECRET", "WEB_LIVE", "APP_DOMAIN", "MAX_COST_USD", "FAL_KEY", "GEMINI_API_KEY"]) expect(r).toContain(k);
    expect(r).toMatch(/tar[^\n]*\|[^\n]*ssh/);
    expect(r).toMatch(/prune/i);
  });

  it("pnpm web is wired", async () => {
    const pkg = JSON.parse(await read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts.web).toMatch(/src\/web\/server\.ts/);
  });
});
