/**
 * The verbatim gate. The product's one hard rule — the spoken line is the script's line word for word — is
 * checked here by code: both sides are normalised the same way, then aligned token by token.
 *
 * "Same spoken words must pass": a span such as `1987`, `$4.50`, `3:15` or `24/7` can be said (and written by ASR)
 * several ways, so it becomes a set of *readings*. Two texts match iff some reading of one equals some reading of the
 * other, token for token. Nothing else is fuzzy: a missing, added or changed word always fails.
 * Pure, dependency-free.
 */
import type { VerbatimOp, VerbatimResult } from "./schemas.ts";

const ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function below1000(n: number): string {
  const parts: string[] = [];
  const h = Math.floor(n / 100);
  const rest = n % 100;
  if (h > 0) parts.push(`${ONES[h]} hundred`);
  if (rest > 0 || h === 0) {
    if (rest < 20) parts.push(ONES[rest]!);
    else parts.push(TENS[Math.floor(rest / 10)]! + (rest % 10 ? ` ${ONES[rest % 10]}` : ""));
  }
  return parts.join(" ");
}

/** English cardinal for 0–999 999, without "and" (ASR engines rarely emit it). `undefined` outside the range. */
export function numberToWords(n: number): string | undefined {
  if (!Number.isInteger(n) || n < 0 || n > 999_999) return undefined;
  const th = Math.floor(n / 1000);
  const rest = n % 1000;
  if (th === 0) return below1000(rest);
  return rest === 0 ? `${below1000(th)} thousand` : `${below1000(th)} thousand ${below1000(rest)}`;
}

const ORDINAL_IRREGULAR: Record<string, string> = {
  one: "first", two: "second", three: "third", five: "fifth", eight: "eighth", nine: "ninth", twelve: "twelfth",
};

/** "twenty one" → "twenty first": only the last word changes. */
function toOrdinal(cardinal: string): string {
  const words = cardinal.split(" ");
  const last = words.pop()!;
  const ord = ORDINAL_IRREGULAR[last] ?? (last.endsWith("y") ? `${last.slice(0, -1)}ieth` : `${last}th`);
  return [...words, ord].join(" ");
}

function digitsToWords(digits: string): string | undefined {
  return numberToWords(Number(digits));
}

// --- spans with several accepted readings ---

/**
 * Upper bound on readings per side. Each alternative span multiplies the count; a span that would push the product
 * past the cap contributes only its canonical (first) reading (see `readings`). 32 covers five two-way spans in one line,
 * well beyond any line that fits a 15 s shot, and keeps the alignment at ≤ 32 × 32 small DPs.
 */
export const MAX_READINGS = 32;

/** Year reading of 1100–2099 ("nineteen eighty seven", "two thousand five", "twenty twenty six"). */
function yearReadings(n: number): string[] {
  const hi = Math.floor(n / 100);
  const lo = n % 100;
  if (n >= 2000 && n <= 2009) return lo === 0 ? ["two thousand"] : [`two thousand ${ONES[lo]}`, `twenty oh ${ONES[lo]}`];
  const head = numberToWords(hi)!;
  if (lo === 0) return [`${head} hundred`];
  return [lo < 10 ? `${head} oh ${ONES[lo]}` : `${head} ${numberToWords(lo)}`];
}

/** [singular, plural, sub-unit singular, sub-unit plural]. */
const CURRENCY: Record<string, readonly [string, string, string, string]> = {
  $: ["dollar", "dollars", "cent", "cents"],
  "€": ["euro", "euros", "cent", "cents"],
  "£": ["pound", "pounds", "penny", "pence"],
};

/** "$4.50" → four dollars fifty cents | four dollars and fifty cents | four fifty. `undefined` = out of range. */
function moneyReadings(sym: string, whole: string, frac: string | undefined): string[] | undefined {
  const [one, many, subOne, subMany] = CURRENCY[sym]!;
  const n = Number(whole.replace(/,/g, ""));
  const c = frac === undefined ? 0 : Number(frac);
  const w = numberToWords(n);
  const cw = numberToWords(c)!;
  if (w === undefined) return undefined;
  const units = `${w} ${n === 1 ? one : many}`;
  if (c === 0) return [units];
  const sub = `${cw} ${c === 1 ? subOne : subMany}`;
  if (n === 0) return [sub];
  return [`${units} ${sub}`, `${units} and ${sub}`, c < 10 ? `${w} oh ${cw}` : `${w} ${cw}`];
}

/** "3:15" → three fifteen; "10:05" → ten oh five; "7:00" → seven o'clock | seven. */
function timeReadings(h: string, mm: string): string[] | undefined {
  const hw = digitsToWords(h);
  if (hw === undefined) return undefined;
  const m = Number(mm);
  if (m === 0) return [`${hw} o'clock`, hw];
  return [`${hw} ${m < 10 ? `oh ${ONES[m]}` : numberToWords(m)}`];
}

/**
 * Replace every multi-reading span with a private-use placeholder character (one per span) and collect its
 * readings. Placeholders survive the rest of `normalize` untouched and are expanded at tokenisation.
 */
function markAlternatives(s: string, alts: string[][]): string {
  const mark = (readings: string[] | undefined, original: string): string => {
    if (!readings) return original;
    alts.push([...new Set(readings)]);
    return ` ${String.fromCharCode(PUA + alts.length - 1)} `;
  };
  return (
    s
      // Prefix currency, optional 2-digit sub-unit. Anything else ("$3.505") is left alone and fails strictly.
      .replace(/([$€£]) ?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?(?![\d.,]*\d)/gu, (m, sym: string, whole: string, frac?: string) =>
        mark(moneyReadings(sym, whole, frac), m),
      )
      .replace(/(?<![\d/])24\/7(?![\d/])/g, (m) => mark(["twenty four seven"], m))
      // ASR writes "3.15 AM" for 3:15 a.m.: a dot is a clock separator only right before am/pm.
      .replace(/(?<![\d:.])(\d{1,2})[:.]([0-5]\d)(?=\s*[ap]\.?\s?m(?!\p{L}))/gu, (m, h: string, mm: string) => mark(timeReadings(h, mm), m))
      .replace(/(?<![\d:])(\d{1,2}):([0-5]\d)(?![\d:])/g, (m, h: string, mm: string) => mark(timeReadings(h, mm), m))
      // Bare 4-digit 1100–2099: year reading first (canonical), cardinal second. Not with separators ("1,987").
      .replace(/(?<![\d.,:])(1[1-9]\d\d|20\d\d)(?!\d|[.,:]\d|st|nd|rd|th)/g, (m, d: string) => {
        const n = Number(d);
        return mark([...yearReadings(n), numberToWords(n)!], m);
      })
  );
}

/** First private-use code point used for span placeholders. */
const PUA = 0xe000;
const isPlaceholder = (t: string) => t.length === 1 && t.charCodeAt(0) >= PUA && t.charCodeAt(0) <= 0xf8ff;

/** Replace the remaining digit runs with English words. Order matters: ordinals before plain numbers. */
function spellNumbers(s: string): string {
  return (
    s
      // Ordinals: 1st, 22nd, 3rd, 100th.
      .replace(/(?<![\d.,])(\d+)(st|nd|rd|th)(?![\p{L}\d])/gu, (m, d: string) => {
        const w = digitsToWords(d);
        return w === undefined ? m : ` ${toOrdinal(w)} `;
      })
      // Decimals: 3.5 → three point five (each fractional digit spoken).
      .replace(/(?<![\d.,])(\d+)\.(\d+)(?![\d.,]*\d)/g, (m, i: string, f: string) => {
        const w = digitsToWords(i);
        if (w === undefined) return m;
        return ` ${w} point ${[...f].map((c) => ONES[Number(c)]).join(" ")} `;
      })
      // Integers, optionally with thousands separators: 1,234 → one thousand two hundred thirty four.
      .replace(/(?<!\d)(\d{1,3}(?:,\d{3})+|\d+)(?!\d)/g, (m, d: string) => {
        const w = digitsToWords(d.replace(/,/g, ""));
        return w === undefined ? m : ` ${w} `;
      })
  );
}

/** Symbols that are read aloud as one word. Dropping them would let a missing spoken word pass the gate. */
const SYMBOL_WORDS: Record<string, string> = { "&": "and", "%": "percent", "+": "plus", "=": "equals", "@": "at", "°": "degrees" };

/** Punctuation-category characters that are spoken; kept as their own token (like \p{S}) instead of dropped. */
const SPOKEN_PUNCT = "#§‰";

/** "50%" → "50 percent", "-5" → "minus 5", "&" → "and" (digits still digits, so spellNumbers handles them). */
function spellSymbols(s: string): string {
  return (
    s
      // A minus sign: a hyphen/minus directly before a digit and not inside a word or range ("3-5" stays a range).
      .replace(/(^|[^\p{L}\p{N}])[-−](?=\d)/gu, "$1 minus ")
      .replace(/[&%+=@°]/g, (c) => ` ${SYMBOL_WORDS[c]} `)
  );
}

/** Written abbreviations and how they are said. Applied to both sides, so "Dr." matches a heard "Doctor". */
const ABBREVIATIONS: Record<string, string> = { dr: "doctor", mr: "mister", mrs: "missus", ms: "miz" };

/**
 * Lowercase, NFKC, diacritics folded (Zoë → zoe: ASR often drops accents), one apostrophe. Private-use characters
 * (\p{Co}, e.g. the Apple logo U+F8FF) become spaces first: they are never words, and the BMP private-use range is
 * reserved for span placeholders, so a literal one must never be read as span #n.
 */
function fold(text: string): string {
  return text
    .replace(/\p{Co}/gu, " ")
    .normalize("NFKC")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .normalize("NFC")
    .replace(/[’ʼ‘`]/g, "'");
}

/** One position in a normalised text: its accepted readings (a plain word has exactly one). */
type Segment = string[][];

function segments(text: string): Segment[] {
  const alts: string[][] = [];
  let s = markAlternatives(joinSpelledLetters(fold(text)), alts);
  s = spellSymbols(s);
  s = spellNumbers(s);
  // Hyphens and every dash variant separate words.
  s = s.replace(/[-‐‑‒–—―−]/g, " ");
  // Keep an apostrophe only between two letters/digits; drop the remaining punctuation; isolate symbols.
  s = s.replace(/(?<=[\p{L}\p{N}])'(?=[\p{L}\p{N}])/gu, "\u0000");
  s = s.replace(new RegExp(`[^\\p{L}\\p{N}\\p{S}${SPOKEN_PUNCT}\\s\\u0000\\uE000-\\uF8FF]`, "gu"), " ");
  s = s.replace(new RegExp(`[\\p{S}${SPOKEN_PUNCT}]`, "gu"), " $& ");
  s = s.replace(/\u0000/g, "'");
  const raw = s.split(/\s+/).filter(Boolean);

  const out: Segment[] = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i]!;
    if (isPlaceholder(t)) {
      out.push(alts[t.charCodeAt(0) - PUA]!.map((r) => r.split(" ")));
      continue;
    }
    // Space-separated single letters ("the f b i", "3 a m") are ambiguous: spelled letters or real words
    // ("am I a fool"). They are never merged; the run becomes a span whose readings include the spelled form.
    if (/^\p{L}$/u.test(t) && /^\p{L}$/u.test(raw[i + 1] ?? "")) {
      const run = [t];
      while (/^\p{L}$/u.test(raw[i + 1] ?? "")) run.push(raw[++i]!);
      out.push(letterRunReadings(run));
      continue;
    }
    out.push([[ABBREVIATIONS[t] ?? t]]);
  }
  return out;
}

const isWordLetter = (t: string) => t === "a" || t === "i";

/**
 * Readings of a spaced single-letter run: as written (canonical), fully spelled ("f b i" → fbi), and — since "a"
 * and "i" are also words — spelled with a leading/trailing a/i kept apart ("f b i i" → "fbi i").
 */
function letterRunReadings(run: string[]): Segment {
  const rs: string[][] = [run, [run.join("")]];
  if (run.length > 2 && isWordLetter(run[0]!)) rs.push([run[0]!, run.slice(1).join("")]);
  if (run.length > 2 && isWordLetter(run.at(-1)!)) rs.push([run.slice(0, -1).join(""), run.at(-1)!]);
  const seen = new Set<string>();
  return rs.filter((r) => !seen.has(r.join(" ")) && seen.add(r.join(" ")));
}

/**
 * Written forms that unambiguously spell one word, joined before punctuation is dropped: dotted initialisms
 * ("F.B.I." → fbi, "a.m." / "p.m." → am / pm) and hyphenated letters ("F-B-I" → fbi). Only these patterns: a
 * following "I" or "a" is a separate word and must stay one ("At 3 a.m. I left" vs "At 3 AM I left").
 */
function joinSpelledLetters(s: string): string {
  return s
    .replace(/(?<![\p{L}.])\p{L}(?:\.\p{L})+\.?(?![\p{L}\p{N}])/gu, (m) => m.replace(/\./g, ""))
    .replace(/(?<![\p{L}\p{N}-])\p{L}(?:-\p{L})+(?![\p{L}\p{N}-])/gu, (m) => m.replace(/-/g, ""));
}

/**
 * Every reading of a text; the first is the canonical one. Each span expands only if the running product stays
 * ≤ MAX_READINGS; otherwise that span contributes its canonical reading alone. Spans are judged one by one, so a
 * later span with fewer readings may still expand after an earlier, larger one was capped.
 */
function readings(segs: Segment[]): string[][] {
  let out: string[][] = [[]];
  for (const seg of segs) {
    const opts = out.length * seg.length <= MAX_READINGS ? seg : [seg[0]!];
    out = out.flatMap((prefix) => opts.map((o) => prefix.concat(o)));
  }
  return out;
}

/**
 * Canonical form for comparison: NFKC, diacritics folded, lowercase, one apostrophe, spoken symbols, numbers and
 * abbreviations spelled out (first reading of each span), punctuation dropped (intra-word apostrophes kept so
 * "it's" ≠ "its"), dashes as spaces, single spaces. Any other symbol (\p{S}, plus #§‰) becomes its own token: it
 * can never silently disappear, so a line containing one only passes if the ASR emits the same symbol.
 */
export function normalize(text: string): string {
  return readings(segments(text))[0]!.join(" ");
}

/** Spoken word count of the canonical reading: "3:15" is two words, "$5" two, "1987" three. */
export function wordCount(text: string): number {
  return segments(text).reduce((n, seg) => n + seg[0]!.length, 0);
}

/** Word-level Levenshtein alignment; ops in order. Prefers match/sub, then del, then ins (deterministic). */
function align(e: string[], h: string[]): VerbatimOp[] {
  const rows = e.length + 1;
  const cols = h.length + 1;
  const dist: number[][] = Array.from({ length: rows }, (_, i) =>
    Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const same = e[i - 1] === h[j - 1] ? 0 : 1;
      dist[i]![j] = Math.min(dist[i - 1]![j - 1]! + same, dist[i - 1]![j]! + 1, dist[i]![j - 1]! + 1);
    }
  }
  const ops: VerbatimOp[] = [];
  let i = e.length;
  let j = h.length;
  while (i > 0 || j > 0) {
    const d = dist[i]![j]!;
    if (i > 0 && j > 0) {
      const same = e[i - 1] === h[j - 1];
      if (dist[i - 1]![j - 1]! + (same ? 0 : 1) === d) {
        if (!same) ops.push({ type: "sub", expected: e[i - 1]!, heard: h[j - 1]! });
        i--;
        j--;
        continue;
      }
    }
    if (i > 0 && dist[i - 1]![j]! + 1 === d) {
      ops.push({ type: "del", expected: e[i - 1]! });
      i--;
      continue;
    }
    ops.push({ type: "ins", heard: h[j - 1]! });
    j--;
  }
  return ops.reverse();
}

/** Laughter as ASR spells it: ha, haha, hahah, heh, hehe. Not "he". */
const LAUGHTER = /^(?:(?:ha)+h?|heh|(?:he){2,}h?)$/;
/**
 * Non-speech actions allowed between asterisks: "*sighs*", "*laughs softly*", "*clears throat*". Any other starred
 * text is emphasis on real words ("I *really* mean it") and stays spoken: treating every `*…*` as a tag would
 * silently drop a user's word from the expected text and from the TTS/video input.
 */
// Suffixes per stem shape, so no stem + suffix forms a real word ("grin"+"d" = grind, "nod"+"es" = nodes).
const ACTION = [
  "(?:laugh|sigh|cough|gasp|sniff|yawn|groan|scoff|snort|gulp|wink)(?:s|ed|ing)?",
  "(?:sneeze|pause|smile|giggle|chuckle|whistle)[sd]?",
  "sneezing|pausing|smiling|giggling|chuckling|whistling",
  "(?:sob|hum|grin|shrug|nod)s?|sobbed|sobbing|hummed|humming|grinned|grinning|shrugged|shrugging|nodded|nodding",
  "cry|cries|cried|crying",
  "clears? (?:(?:his|her|their|my) )?throat",
].join("|");
/** `*action*` with an optional "-ly" adverb before or after; group 1 is the action text. */
const STAR_ACTION = String.raw`\*\s*((?:\p{L}+ly )?(?:${ACTION})(?: \p{L}+ly)?)\s*\*`;

/** Bracketed non-speech in a transcript: "[laughs]", "(sighs)", "*coughs*" (known actions only), "<music>". */
const NON_SPEECH = new RegExp(String.raw`\[[^\][]*\]|\([^()]*\)|${STAR_ACTION}|<[^<>]*>`, "giu");

export interface CompareOpts {
  /** The line carries a laugh tag: heard laughter outside the expected words is ignored (and reported). */
  laughter?: boolean;
}

/**
 * Compare what was heard with what was expected. pass iff some reading of `expected` equals some reading of
 * `heard` token for token (strict: wer === 0). WER and ops are reported against the closest pair:
 * wer = (S + D + I) / N; with an empty expected line any heard word is a full failure (wer = 1).
 * Bracketed non-speech in `heard` is never a word; it is dropped and listed in `ignored`.
 */
export function compareWords(expected: string, heard: string, opts: CompareOpts = {}): VerbatimResult {
  const dropped: string[] = [];
  const cleanHeard = heard.replace(NON_SPEECH, (m) => {
    dropped.push(m.trim());
    return " ";
  });
  const es = readings(segments(expected));
  const hs = readings(segments(cleanHeard));

  let best: { e: string[]; h: string[]; ops: VerbatimOp[]; laughs: string[] } | undefined;
  search: for (const e of es) {
    for (const h of hs) {
      let ops = align(e, h);
      const laughs: string[] = [];
      if (opts.laughter) {
        ops = ops.filter((o) => {
          const laugh = o.type === "ins" && LAUGHTER.test(o.heard!);
          if (laugh) laughs.push(o.heard!);
          return !laugh;
        });
      }
      if (!best || ops.length < best.ops.length) best = { e, h, ops, laughs };
      if (ops.length === 0) break search;
    }
  }
  const { e, h, ops, laughs } = best!;
  const wer = e.length === 0 ? (ops.length === 0 ? 0 : 1) : ops.length / e.length;
  const ignored = [...dropped.filter(Boolean), ...laughs];
  return {
    expected: e.join(" "),
    heard: h.join(" "),
    wer,
    ops,
    pass: ops.length === 0,
    ...(ignored.length ? { ignored } : {}),
  };
}

/** Pictographs (emoji) with their modifiers / joiners / variation selectors: decoration, never words. */
const EMOJI = /(?:\p{Extended_Pictographic}|\p{Emoji_Modifier})[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️]*/gu;

/**
 * Separate delivery tags and emoji from the words: "[whispers] I kept it. <sigh> 🚀" → spoken "I kept it.", tags
 * ["whispers", "sigh"], emoji ["🚀"]. Tags (ElevenLabs `[…]`, Gemini `<…>`, known `*actions*`) are
 * performance directions and emoji are decoration; neither is a word the listener hears, so neither may reach compareWords as
 * expected text.
 */
export function splitDelivery(line: string): { spoken: string; tags: string[]; emoji?: string[] } {
  const tags: string[] = [];
  const emoji: string[] = [];
  const spoken = line
    .replace(new RegExp(String.raw`\[([^\][]*)\]|<([^<>]*)>|${STAR_ACTION}`, "giu"), (_m, sq?: string, ang?: string, star?: string) => {
      const tag = (sq ?? ang ?? star ?? "").trim();
      if (tag) tags.push(tag);
      return " ";
    })
    .replace(EMOJI, (m) => {
      emoji.push(m);
      return " ";
    })
    .replace(/️/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return { spoken, tags, ...(emoji.length ? { emoji } : {}) };
}

/** Does a line's delivery include laughing ("[laughs]", "<chuckles>")? */
export const hasLaughTag = (tags: string[]): boolean => tags.some((t) => /laugh|chuckl|giggl/i.test(t));

/**
 * The gate's comparison for a script line (or several joined): delivery tags and emoji are removed from the
 * expected words, and a laugh tag lets heard laughter through (reported in `ignored`, never silently).
 */
export function compareLine(line: string, heard: string): VerbatimResult {
  const { spoken, tags } = splitDelivery(line);
  return compareWords(spoken, heard, { laughter: hasLaughTag(tags) });
}

/** Letters outside the Latin script ("Мамо" → М, а, м, о), deduplicated. Accented Latin letters are Latin. */
export function nonLatinLetters(text: string): string[] {
  return [...new Set([...text.matchAll(/\p{L}/gu)].map((m) => m[0]))].filter((c) => !/\p{Script=Latin}/u.test(c));
}

export const NESTED_QUOTES = "nested double quotes: use single quotes inside the line";

/** The idea's quoting can't be read unambiguously. Raised before any model call. */
export class QuoteError extends Error {
  constructor(message = NESTED_QUOTES) {
    super(message);
    this.name = "QuoteError";
  }
}

/**
 * Lines the idea quotes: text inside "…", “…”, «…» or „…“ (also „…”), exactly as written.
 * Single quotes are never delimiters — they are apostrophes far more often than quotes.
 * Nested double quotes can't be paired reliably ("When I say "stop," you stop.") so they throw QuoteError: an odd
 * number of straight quotes, a fragment that opens or closes on whitespace when there are several, two quotes
 * with only whitespace between them, or an opening curly/guillemet quote inside a fragment of the same style.
 */
export function extractQuotedLines(idea: string): string[] {
  return quoteSpans(idea).map((q) => q.text);
}

/** extractQuotedLines with where each quote sits in the idea (start/end include the quote marks). */
export function quoteSpans(idea: string): { text: string; start: number; end: number }[] {
  const re = /"([^"]*)"|“([^”]*)”|«([^»]*)»|„([^“”]*)[“”]/g;
  if ((idea.match(/"/g)?.length ?? 0) % 2 === 1) throw new QuoteError();
  const matches = [...idea.matchAll(re)];
  const out: { text: string; start: number; end: number }[] = [];
  let prevEnd = -1;
  for (const m of matches) {
    const inner = m[1] ?? m[2] ?? m[3] ?? m[4] ?? "";
    if (/[“«„]/.test(inner)) throw new QuoteError();
    if (prevEnd >= 0 && idea.slice(prevEnd, m.index).trim() === "") throw new QuoteError();
    if (matches.length > 1 && m[1] !== undefined && /^\s|\s$/.test(inner)) throw new QuoteError();
    prevEnd = m.index + m[0].length;
    if (inner !== "") out.push({ text: inner, start: m.index, end: prevEnd });
  }
  return out;
}
