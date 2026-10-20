/**
 * Graph steps a finished run can be redone from (`--redo`), in order. Its own module so the web demo (F20) can name
 * steps without loading the graph and its checkpointer.
 */
export const REDO_STEPS = ["writeScript", "cast", "drawKeyframes", "shot", "assemble", "burnSubtitles", "finalGate"] as const;
export type RedoStep = (typeof REDO_STEPS)[number];
