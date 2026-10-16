/**
 * Errors a node must treat differently from "try again". A content-policy rejection (e.g. Seedance's real-face
 * filter) will reject the same input again, so retrying it blindly only burns money and time.
 */
import { formatIssues, JudgeVerdict } from "../schemas.ts";

export class PolicyRejectedError extends Error {
  constructor(
    readonly provider: string,
    /** The vendor's code or message, kept verbatim for the manifest. */
    readonly detail: string,
  ) {
    super(`${provider}: rejected by content policy: ${detail}`);
    this.name = "PolicyRejectedError";
  }
}

/**
 * A judge answered, but not in the `JudgeVerdict` shape. It carries the cost (the call was paid for) and the raw
 * reply so the caller can record a failed judge attempt. It never counts as a pass.
 */
export class JudgeOutputError extends Error {
  constructor(
    readonly provider: string,
    readonly problem: string,
    readonly raw: unknown,
    readonly costUsd: number,
  ) {
    super(`${provider}: judge output invalid: ${problem}`);
    this.name = "JudgeOutputError";
  }
}

/** Raw judge reply → verdict, or JudgeOutputError. The mock and live judges share it, so they fail the same way. */
export function parseVerdict(provider: string, raw: unknown, costUsd: number): JudgeVerdict {
  const parsed = JudgeVerdict.safeParse(raw);
  if (!parsed.success) throw new JudgeOutputError(provider, formatIssues(parsed.error).replace(/\n/g, "; "), raw, costUsd);
  return parsed.data;
}

/** A live capability has no key / adapter configured. Names the env var a human would set. */
export class NotConfiguredError extends Error {
  constructor(
    readonly capability: string,
    readonly envVar: string,
  ) {
    super(`live ${capability} provider is not configured: set ${envVar}`);
    this.name = "NotConfiguredError";
  }
}
