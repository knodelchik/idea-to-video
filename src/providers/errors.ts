/**
 * Errors a node must treat differently from "try again". A content-policy rejection (e.g. Seedance's real-face
 * filter) will reject the same input again, so retrying it blindly only burns money and time.
 */
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
