/**
 * Blocking as plain words (F18), shared by the video prompts and the judge rubrics so both describe the same staging.
 * Pure. Directions are relative to the camera and to a goal in frame, never just "runs toward the train"
 * (live 2026-10-19: the castle and train runs went the wrong way).
 */
import type { Blocking, Character, Movement, Place, Script, Shot, Subject } from "../schemas.ts";

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
/** A target opens its own sentence ("The open door … is visible"). */
const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** How a character is named: plain, or with its `@Image N (Name)` tag when its portrait is a reference. */
export type Naming = (c: Character) => string;
export const plain: Naming = (c) => oneLine(c.name);

export const where = (p: Place): string => `the ${p.position} ${p.side}`;

export const FACING: Record<Subject["facing"], string> = {
  camera: "facing the camera",
  away: "facing away",
  left: "facing left",
  right: "facing right",
};

const MOVE: Record<Movement["direction"], string> = {
  "toward camera": "moves toward the camera",
  "away from camera": "moves away from the camera",
  "left to right": "moves left to right across the frame",
  "right to left": "moves right to left across the frame",
  none: "holds position",
};

/** A subject's name as the caller names characters (a name without a character is used as written). */
const subjectName = (script: Script, name: Naming, who: string): string => {
  const c = script.characters.find((x) => x.name === who);
  return c ? name(c) : oneLine(who);
};

/** The movement's goal as a place in frame: "the open carriage door in the background right", or "". */
export const goalOf = (m: Movement | null): string =>
  m?.target && m.targetPosition ? `${oneLine(m.target)} in ${where(m.targetPosition)}` : "";

/** One movement as a phrase: "moves away from the camera in real time toward the open door in the background right". */
export function movementPhrase(m: Movement): string {
  const goal = goalOf(m);
  if (m.direction === "none") return `holds position${m.target ? `, eyes on ${oneLine(m.target)}` : ""}`;
  return `${MOVE[m.direction]} ${m.pace === "slow-motion" ? "in slow motion" : "in real time"}${goal ? ` toward ${goal}` : ""}`;
}

/**
 * Staging sentences: "Olena in the foreground left, facing away, moves away from the camera in real time toward the
 * open carriage door in the background right." Then "<target> is visible in <place>." so the goal is in frame.
 */
export function stagingSentences(b: Blocking, script: Script, name: Naming = plain): string[] {
  const m = b.movement;
  const out = b.subjects.map((s) => {
    const placed = `${subjectName(script, name, s.name)} in ${where(s)}, ${FACING[s.facing]}`;
    return m && m.who === s.name ? `${placed}, ${movementPhrase(m)}.` : `${placed}.`;
  });
  if (m?.target && m.targetPosition) out.push(`${capital(oneLine(m.target).replace(/[.\s]+$/, ""))} is visible in ${where(m.targetPosition)}.`);
  return out;
}

/** "Only X speaks; Y stays silent with closed lips." (the train bug: a listener's lips moving to the speaker's line). */
export function speakingSentence(b: Blocking, script: Script, name: Naming = plain): string {
  const others = b.subjects.filter((s) => s.name !== b.speaking).map((s) => subjectName(script, name, s.name));
  const silent = others.length ? `${others.join(" and ")} ${others.length === 1 ? "stays" : "stay"} silent with closed lips.` : "";
  if (b.speaking === null) return others.length ? `Nobody speaks here; ${silent}` : "Nobody speaks here.";
  const who = subjectName(script, name, b.speaking);
  return others.length ? `Only ${who} speaks; ${silent}` : `Only ${who} speaks.`;
}

/** The script asked for slow motion somewhere in this shot (only allowed when the idea asked, scriptProblems). */
export const slowMotionIn = (shot: Shot): boolean =>
  [shot.blocking, ...(shot.cuts ?? []).map((c) => c.blocking)].some((b) => b.movement?.pace === "slow-motion");

/** Every shot (live 2026-10-19: a run rendered in slow motion). Slow motion only when the script asks for it. */
export const paceSentence = (shot: Shot): string =>
  slowMotionIn(shot) ? "Slow motion only where the staging says so, as the idea asks." : "Real-time speed, natural pace, no slow motion.";

/** The blocking of the opening frame: the first cut's, else the shot's. */
export const openingBlocking = (shot: Shot): Blocking => shot.cuts?.[0]?.blocking ?? shot.blocking;

/** The keyframe is a still: where everyone stands at the start, and the movement's goal already in frame. */
export function openingStaging(shot: Shot): string {
  const b = openingBlocking(shot);
  const placed = b.subjects.map((s) => `${oneLine(s.name)} in ${where(s)}, ${FACING[s.facing]}`);
  const m = b.movement;
  const goal = m?.target && m.targetPosition ? [`${oneLine(m.target)} visible in ${where(m.targetPosition)}`] : [];
  const parts = [...placed, ...goal];
  return parts.length ? `Staging: ${parts.join("; ")}.` : "";
}
