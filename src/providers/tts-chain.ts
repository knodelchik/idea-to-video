/**
 * TTS providers in order (env TTS_PROVIDERS). A transient failure (429/5xx/network) moves to the next engine
 * and says so in `notes`; anything else is a bug and is thrown.
 */
import { isTransient } from "./http.ts";
import type { TtsProvider, TtsRequest, TtsResult } from "./types.ts";

export class TtsChain implements TtsProvider {
  readonly name: string;
  constructor(readonly providers: TtsProvider[]) {
    if (providers.length === 0) throw new Error("TtsChain: no providers");
    this.name = providers.length === 1 ? providers[0]!.name : `chain(${providers.map((p) => p.name).join(",")})`;
  }

  /** Any engine in the chain may end up speaking, so budget for the dearest. */
  estimateUsd(req: TtsRequest): number {
    return Math.max(0, ...this.providers.map((p) => p.estimateUsd?.(req) ?? 0));
  }

  async speak(req: TtsRequest): Promise<TtsResult> {
    const notes: string[] = [];
    for (const [i, p] of this.providers.entries()) {
      try {
        const r = await p.speak(req);
        const all = [...notes, ...(r.notes ?? [])];
        return { ...r, provider: r.provider ?? p.name, ...(all.length ? { notes: all } : {}) };
      } catch (e) {
        if (!isTransient(e) || i === this.providers.length - 1) {
          if (notes.length && e instanceof Error) e.message = `${e.message} (after: ${notes.join("; ")})`;
          throw e;
        }
        notes.push(`${p.name} failed (${e instanceof Error ? e.message : String(e)}), fell back to ${this.providers[i + 1]!.name}`);
      }
    }
    throw new Error("unreachable");
  }
}
