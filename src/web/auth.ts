/**
 * One shared access code (F15). A session is `exp.HMAC-SHA256(secret, exp)` in an HttpOnly cookie: stateless, so a
 * restart keeps people logged in, and changing SESSION_SECRET logs everyone out.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const COOKIE = "itv_session";
export const SESSION_MS = 7 * 24 * 60 * 60 * 1000;

const sha256 = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

/** Equal-length hashes go into timingSafeEqual, so neither the code nor its length leaks through timing. */
export function codeMatches(given: string, expected: string): boolean {
  return timingSafeEqual(sha256(given), sha256(expected)) && expected.length > 0;
}

const mac = (secret: string, exp: string): string => createHmac("sha256", secret).update(exp).digest("hex");

export function signSession(secret: string, expMs: number): string {
  const exp = String(Math.floor(expMs));
  return `${exp}.${mac(secret, exp)}`;
}

export function verifySession(secret: string, value: string | undefined, nowMs: number): boolean {
  const m = /^(\d{1,16})\.([0-9a-f]{64})$/.exec(value ?? "");
  if (!m) return false;
  const good = Buffer.from(mac(secret, m[1]!), "hex");
  if (!timingSafeEqual(good, Buffer.from(m[2]!, "hex"))) return false;
  return Number(m[1]) > nowMs;
}

export function sessionCookie(secret: string, nowMs: number): string {
  return `${COOKIE}=${signSession(secret, nowMs + SESSION_MS)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MS / 1000}`;
}

export const clearedCookie = `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

export function cookieValue(header: string | undefined, name = COOKIE): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

/**
 * Failed logins per IP in a sliding window. Once `max` failures sit in the window every login from that IP is
 * refused (429), the right code included: otherwise guessing just continues one try at a time.
 */
export class LoginLimiter {
  private readonly fails = new Map<string, number[]>();
  constructor(
    readonly max = 5,
    readonly windowMs = 15 * 60 * 1000,
  ) {}

  private recent(ip: string, now: number): number[] {
    const xs = (this.fails.get(ip) ?? []).filter((t) => now - t < this.windowMs);
    if (xs.length) this.fails.set(ip, xs);
    else this.fails.delete(ip);
    return xs;
  }

  blocked(ip: string, now: number): boolean {
    return this.recent(ip, now).length >= this.max;
  }

  fail(ip: string, now: number): void {
    this.fails.set(ip, [...this.recent(ip, now), now]);
  }
}
