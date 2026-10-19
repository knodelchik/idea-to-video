/** Web demo config (F15), from env only. Missing secrets stop the server before it listens. */
import { resolve } from "node:path";

export interface WebConfig {
  accessCode: string;
  sessionSecret: string;
  port: number;
  runsDir: string;
  examplesDir: string;
  /** WEB_LIVE=1: the form may start live (paid) runs. Off by default. */
  live: boolean;
  /** Passed to the CLI child as MAX_COST_USD: the per-run hard stop. */
  maxCostUsd: number;
  /**
   * TRUST_PROXY=1: take the client IP for the login limiter from the last X-Forwarded-For entry (the one Traefik
   * appended). Off by default, because without a proxy in front the header is whatever the client sent.
   */
  trustProxy: boolean;
  /** Repo root: where `src/cli.ts`, `node_modules` and `src/web/public` are. */
  root: string;
}

type Env = Record<string, string | undefined>;

function required(env: Env, key: string): string {
  const v = env[key]?.trim();
  if (!v) throw new Error(`${key} is required; the web server will not start without it`);
  return v;
}

function positive(env: Env, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${key} must be a positive number, got "${raw}"`);
  return n;
}

export function configFromEnv(env: Env, root = resolve(import.meta.dirname, "..", "..")): WebConfig {
  const accessCode = required(env, "ACCESS_CODE");
  const sessionSecret = required(env, "SESSION_SECRET");
  const port = positive(env, "PORT", 8080);
  if (!Number.isInteger(port) || port > 65535) throw new Error(`PORT must be a port number, got "${env.PORT}"`);
  return {
    accessCode,
    sessionSecret,
    port,
    runsDir: resolve(root, env.RUNS_DIR?.trim() || "runs"),
    examplesDir: resolve(root, env.EXAMPLES_DIR?.trim() || "examples"),
    live: env.WEB_LIVE?.trim() === "1",
    maxCostUsd: positive(env, "MAX_COST_USD", 3),
    trustProxy: env.TRUST_PROXY?.trim() === "1",
    root,
  };
}
