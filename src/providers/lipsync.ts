/**
 * Fallback lip-sync: put a verified voice track onto an existing clip. `LIPSYNC_PROVIDER=fal-kling` (paid, fal)
 * or `command` (an open-source model run locally, e.g. LatentSync, via `LIPSYNC_CMD`; free).
 */
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";
import { probe as ffprobe } from "../media/ffmpeg.ts";
import { NotConfiguredError } from "./errors.ts";
import { falClient, falUpload, falVideoUrl, rethrowFalPolicy, type FalLike } from "./fal.ts";
import { download, type FetchLike } from "./http.ts";
import type { LipsyncProvider } from "./types.ts";

type Env = Record<string, string | undefined>;
type Probe = (path: string) => Promise<{ seconds: number }>;

export const KLING_LIPSYNC_ENDPOINT = "fal-ai/kling-video/lipsync/audio-to-video";
/** fal: $0.014 per second of input video, billed in 5 s steps (docs/research/voice-lipsync-asr.md, fal model page). */
export const KLING_LIPSYNC_USD_PER_SECOND = 0.014;
export const klingLipsyncCost = (videoSeconds: number): number =>
  Math.ceil(videoSeconds / 5) * 5 * KLING_LIPSYNC_USD_PER_SECOND;
/** fal model page: input video must be 2–10 s. Longer clips are trimmed by the caller (talkingShot). */
export const KLING_LIPSYNC_MAX_SECONDS = 10;

export class FalKlingLipsync implements LipsyncProvider {
  readonly name = "fal-kling-lipsync";
  readonly maxSeconds = KLING_LIPSYNC_MAX_SECONDS;
  /** Without probing: the longest clip it accepts, billed in 5 s steps. */
  estimateUsd(): number {
    return klingLipsyncCost(KLING_LIPSYNC_MAX_SECONDS);
  }
  constructor(private readonly deps: { fal: FalLike; fetch?: FetchLike; probe?: Probe }) {}

  async sync({ video, audio, out }: { video: string; audio: string; out: string }) {
    const { fal } = this.deps;
    const { seconds } = await (this.deps.probe ?? ffprobe)(video);
    const input = { video_url: await falUpload(fal, video), audio_url: await falUpload(fal, audio) };
    const { data } = await fal.subscribe(KLING_LIPSYNC_ENDPOINT, { input }).catch((e: unknown) => rethrowFalPolicy(this.name, e));
    await download(this.name, falVideoUrl(KLING_LIPSYNC_ENDPOINT, data), out, this.deps.fetch ?? (globalThis.fetch as FetchLike));
    return { path: out, costUsd: klingLipsyncCost(seconds) };
  }
}

export type Runner = (cmd: string, args: string[]) => Promise<void>;
const exec = promisify(execFile);
const defaultRunner: Runner = async (cmd, args) => {
  await exec(cmd, args, { maxBuffer: 64 * 1024 * 1024 });
};

/**
 * `LIPSYNC_CMD` → argv. Split on whitespace (no shell, so paths can't inject anything), honouring "…" / '…'
 * for arguments with spaces; `{video}`, `{audio}`, `{out}` are substituted inside each argument.
 */
export function commandArgv(template: string, vars: { video: string; audio: string; out: string }): string[] {
  const parts = [...template.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]!);
  for (const k of ["video", "audio", "out"] as const) {
    if (!parts.some((p) => p.includes(`{${k}}`))) throw new Error(`LIPSYNC_CMD must contain {${k}}: ${template}`);
  }
  return parts.map((p) => p.replace(/\{(video|audio|out)\}/g, (_m, k: "video" | "audio" | "out") => vars[k]));
}

export class CommandLipsync implements LipsyncProvider {
  readonly name = "command-lipsync";
  /** A local model has no API limit; set one (LIPSYNC_MAX_SECONDS) when it has a practical cap, e.g. VRAM. */
  readonly maxSeconds: number;
  constructor(private readonly opts: { template: string; run?: Runner; maxSeconds?: number }) {
    commandArgv(opts.template, { video: "", audio: "", out: "" }); // fail at startup, not mid-run
    this.maxSeconds = opts.maxSeconds ?? Infinity;
  }

  async sync(req: { video: string; audio: string; out: string }) {
    const [cmd, ...args] = commandArgv(this.opts.template, req);
    await (this.opts.run ?? defaultRunner)(cmd!, args);
    await access(req.out).catch(() => {
      throw new Error(`${this.name}: command finished but did not write ${req.out}`);
    });
    return { path: req.out, costUsd: 0 };
  }
}

export function lipsyncFromEnv(env: Env, deps: { fal?: FalLike; fetch?: FetchLike; run?: Runner } = {}): LipsyncProvider {
  const which = (env.LIPSYNC_PROVIDER || "fal-kling").toLowerCase();
  if (which === "command") {
    if (!env.LIPSYNC_CMD) throw new NotConfiguredError("lipsync", "LIPSYNC_CMD (e.g. 'latentsync {video} {audio} {out}')");
    const max = env.LIPSYNC_MAX_SECONDS ? Number(env.LIPSYNC_MAX_SECONDS) : Infinity;
    if (!(max > 0)) throw new Error(`LIPSYNC_MAX_SECONDS must be a positive number, got "${env.LIPSYNC_MAX_SECONDS}"`);
    return new CommandLipsync({ template: env.LIPSYNC_CMD, maxSeconds: max, ...(deps.run ? { run: deps.run } : {}) });
  }
  if (which === "fal-kling") {
    if (!env.FAL_KEY && !deps.fal) throw new NotConfiguredError("lipsync", "FAL_KEY");
    return new FalKlingLipsync({ fal: deps.fal ?? falClient(env.FAL_KEY!), ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  }
  throw new Error(`LIPSYNC_PROVIDER: unknown "${which}"; known: fal-kling, command`);
}

/**
 * Stands in for a lip-sync provider whose key is missing. Lip-sync is only the fallback after native speech fails the
 * gate, so a live run must not refuse to start without its key; the NotConfiguredError is thrown when (and only when)
 * the fallback actually calls `sync`, and the node records it as a failed lipsync attempt.
 */
export class UnconfiguredLipsync implements LipsyncProvider {
  /** No trim before the call that is going to fail anyway. */
  readonly maxSeconds = Infinity;
  constructor(
    readonly name: string,
    private readonly error: NotConfiguredError,
    /** What the configured provider would cost, so budget planning doesn't treat the fallback as free. */
    private readonly estimate: number,
  ) {}
  estimateUsd(): number {
    return this.estimate;
  }
  async sync(): Promise<never> {
    throw this.error;
  }
}

/** lipsyncFromEnv, but a missing key is deferred to the first `sync`. Typos and bad numbers still fail at startup. */
export function lipsyncOrDeferred(env: Env, deps: Parameters<typeof lipsyncFromEnv>[1] = {}): LipsyncProvider {
  try {
    return lipsyncFromEnv(env, deps);
  } catch (e) {
    if (!(e instanceof NotConfiguredError)) throw e;
    const which = (env.LIPSYNC_PROVIDER || "fal-kling").toLowerCase();
    return new UnconfiguredLipsync(`${which}-lipsync (not configured)`, e, which === "fal-kling" ? klingLipsyncCost(KLING_LIPSYNC_MAX_SECONDS) : 0);
  }
}
