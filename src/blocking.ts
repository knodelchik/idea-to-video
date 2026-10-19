/**
 * Blocking and continuity checks (F18). Pure; each message names the field and the fix, since it goes straight back
 * to the script writer like the duration check. What a model could get wrong but code can see is checked here; what
 * needs reading the story (a goal not visible, a confusing first shot) is the continuity critic's job.
 */
import type { Blocking, Cut, Script, Shot } from "./schemas.ts";

/** The idea asks for slow motion: the only case a movement may be "slow-motion" (live 2026-10-19: a slow-mo run). */
const SLOW_MOTION = /\bslow[\s-]?mo(?:tion)?\b/i;
export const asksForSlowMotion = (idea: string): boolean => SLOW_MOTION.test(idea);

/** `continuity.from` says the character turned: the one excuse for flipping screen direction (the 180° rule). */
const TURNED = /\b(turn(?:s|ed|ing)?|spins?|spun|wheels? around|reverses?|doubles? back|comes? back)\b/i;

const spokenLine = (shot: Shot): boolean => shot.line.trim() !== "";
const list = (xs: string[]): string => JSON.stringify(xs);

/** Subjects match the frame's onScreen one to one; movement.who and speaking are on screen. */
function frameProblems(where: string, b: Blocking, onScreen: string[]): string[] {
  const out: string[] = [];
  const named = b.subjects.map((s) => s.name);
  for (const who of onScreen) {
    if (!named.includes(who)) out.push(`${where}: "${who}" is on screen but has no blocking.subjects entry; add { name, position, side, facing }`);
  }
  for (const who of named) {
    if (!onScreen.includes(who)) out.push(`${where}: blocking.subjects has "${who}", who is not in onScreen ${list(onScreen)}`);
  }
  const dup = named.find((x, i) => named.indexOf(x) !== i);
  if (dup !== undefined) out.push(`${where}: blocking.subjects lists "${dup}" twice; one entry per on-screen character`);
  if (b.movement && !onScreen.includes(b.movement.who)) {
    out.push(`${where}: blocking.movement.who "${b.movement.who}" is not on screen ${list(onScreen)}`);
  }
  if (b.speaking !== null && !onScreen.includes(b.speaking)) {
    out.push(`${where}: blocking.speaking "${b.speaking}" is not on screen ${list(onScreen)}; only someone in frame can move their lips`);
  }
  return out;
}

function paceProblems(where: string, b: Blocking, slowOk: boolean): string[] {
  if (slowOk || b.movement?.pace !== "slow-motion") return [];
  return [`${where}: blocking.movement.pace is "slow-motion" but the idea does not ask for slow motion; use "real-time"`];
}

/**
 * Who speaks where (the train bug: the conductor's line over a reaction cut, her lips moving). On a spoken shot the
 * speaker is `speaking` in the cut(s) that hold the line; cuts with someone else or nobody speaking come only after
 * the line has ended; and nobody else faces the camera while the line is heard, unless seen from behind.
 */
function speakingProblems(shot: Shot): string[] {
  const out: string[] = [];
  const at = `shot ${shot.id}`;
  const speaker = spokenLine(shot) ? (shot.speaker ?? null) : null;
  if (shot.blocking.speaking !== speaker) {
    out.push(
      speaker === null
        ? `${at}: the shot is silent, so blocking.speaking must be null, got "${shot.blocking.speaking}"`
        : `${at}: "${speaker}" says the line, so blocking.speaking must be "${speaker}", got ${JSON.stringify(shot.blocking.speaking)}`,
    );
  }
  const cuts = shot.cuts ?? [];
  if (cuts.length === 0) return out;
  const cut = (i: number) => `${at} cut ${i + 1}`;
  if (speaker === null) {
    cuts.forEach((c, i) => {
      if (c.blocking.speaking !== null) out.push(`${cut(i)}: the shot has no line, so blocking.speaking must be null, got "${c.blocking.speaking}"`);
    });
    return out;
  }
  const holds = cuts.map((c) => c.blocking.speaking === speaker);
  const last = holds.lastIndexOf(true);
  if (last < 0) {
    out.push(`${at}: no cut holds the line; set blocking.speaking to "${speaker}" in the cut where "${speaker}" says it (usually cut 1)`);
  }
  cuts.forEach((c, i) => {
    const s = c.blocking.speaking;
    if (s !== null && s !== speaker) {
      out.push(`${cut(i)}: blocking.speaking is "${s}", but only "${speaker}" speaks in this shot; a listener stays silent (speaking: null)`);
    }
    // An insert (nobody on screen) shows no face, so the line may run over it; only a cut with people is a reaction.
    if (!holds[i] && i < last && c.onScreen.length > 0) {
      out.push(
        `${cut(i)}: a cut where "${speaker}" is not speaking comes before cut ${last + 1}, which still holds the line; a reaction cut may only come after the line has ended, so move it after the line`,
      );
    }
    if (holds[i]) out.push(...faceProblems(cut(i), c, speaker));
  });
  return out;
}

/** "A line is never heard over a cut where another character's face is on screen, unless shown from behind." */
function faceProblems(where: string, c: Cut, speaker: string): string[] {
  return c.blocking.subjects
    .filter((s) => s.name !== speaker && s.facing !== "away")
    .map(
      (s) =>
        `${where}: "${speaker}"'s line is heard over this cut, but "${s.name}" faces ${s.facing === "camera" ? "the camera" : s.facing}; a viewer reads that face as the voice. Show "${s.name}" from behind (facing "away"), or move this cut after the line with speaking: null`,
    );
}

/** s1 starts the story; later shots say how they follow; screen direction holds unless someone turned. */
function continuityProblems(script: Script): string[] {
  const out: string[] = [];
  script.shots.forEach((shot, i) => {
    const { from, screenDirection } = shot.continuity;
    if (i === 0) {
      if (from.trim().toLowerCase() !== "start") out.push(`shot ${shot.id}: continuity.from must be "start" for the first shot, got ${JSON.stringify(from)}`);
      return;
    }
    const prev = script.shots[i - 1]!;
    if (from.trim().toLowerCase() === "start") {
      out.push(`shot ${shot.id}: continuity.from must say how this shot follows the last moment of ${prev.id}, not "start"`);
    }
    const a = prev.continuity.screenDirection;
    if (a !== "neutral" && screenDirection !== "neutral" && a !== screenDirection && !TURNED.test(from)) {
      out.push(
        `shot ${shot.id}: screenDirection "${screenDirection}" reverses ${prev.id}'s "${a}" with no turn in continuity.from; keep "${a}" (the 180° rule), or say in continuity.from that the character turned`,
      );
    }
  });
  return out;
}

export function blockingProblems(script: Script, idea: string): string[] {
  const slowOk = asksForSlowMotion(idea);
  const out: string[] = [];
  for (const shot of script.shots) {
    const at = `shot ${shot.id}`;
    out.push(...frameProblems(at, shot.blocking, shot.onScreen), ...paceProblems(at, shot.blocking, slowOk));
    (shot.cuts ?? []).forEach((c, i) => {
      const where = `${at} cut ${i + 1}`;
      out.push(...frameProblems(where, c.blocking, c.onScreen), ...paceProblems(where, c.blocking, slowOk));
    });
    out.push(...speakingProblems(shot));
  }
  out.push(...continuityProblems(script));
  return out;
}
