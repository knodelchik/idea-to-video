/**
 * The verbatim gate. The product's one hard rule — the spoken line is the script's line word for word — is
 * checked here by code: both sides are normalised the same way, then aligned token by token.
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

/** Replace digit runs with English words. Order matters: times and ordinals before plain numbers. */
function spellNumbers(s: string): string {
  return (
    s
      // Clock times: 3:15 → three fifteen, 10:05 → ten oh five, 7:00 → seven o'clock.
      .replace(/(?<![\d:])(\d{1,2}):([0-5]\d)(?![\d:])/g, (m, h: string, mm: string) => {
        const hw = digitsToWords(h);
        if (hw === undefined) return m;
        const mins = Number(mm);
        if (mins === 0) return ` ${hw} o'clock `;
        return ` ${hw} ${mins < 10 ? `oh ${ONES[mins]}` : numberToWords(mins)} `;
      })
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

/** [singular, plural, sub-unit singular, sub-unit plural]. */
const CURRENCY: Record<string, readonly [string, string, string, string]> = {
  $: ["dollar", "dollars", "cent", "cents"],
  "€": ["euro", "euros", "cent", "cents"],
  "£": ["pound", "pounds", "penny", "pence"],
};

/** Symbols that are read aloud as one word. Dropping them would let a missing spoken word pass the gate. */
const SYMBOL_WORDS: Record<string, string> = { "&": "and", "%": "percent", "+": "plus", "=": "equals", "@": "at", "°": "degrees" };

/** Punctuation-category characters that are spoken; kept as their own token (like \p{S}) instead of dropped. */
const SPOKEN_PUNCT = "#§‰";

/**
 * Turn spoken symbols into words while digits are still digits, so spellNumbers handles the amounts:
 * "$3.50" → "3 dollars 50 cents", "50%" → "50 percent", "-5" → "minus 5", "&" → "and".
 */
function spellSymbols(s: string): string {
  return (
    s
      // Prefix currency, optional 2-digit sub-unit. Anything else ("$3.505") is left alone and fails strictly.
      .replace(/([$€£]) ?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?(?![\d.,]*\d)/gu, (_m, sym: string, whole: string, frac?: string) => {
        const [one, many, subOne, subMany] = CURRENCY[sym]!;
        const n = Number(whole.replace(/,/g, ""));
        const c = frac === undefined ? 0 : Number(frac);
        const parts: string[] = [];
        if (n > 0 || c === 0) parts.push(whole, n === 1 ? one : many);
        if (c > 0) parts.push(String(c), c === 1 ? subOne : subMany);
        return ` ${parts.join(" ")} `;
      })
      // A minus sign: a hyphen/minus directly before a digit and not inside a word or range ("3-5" stays a range).
      .replace(/(^|[^\p{L}\p{N}])[-−](?=\d)/gu, "$1 minus ")
      .replace(/[&%+=@°]/g, (c) => ` ${SYMBOL_WORDS[c]} `)
  );
}

/**
 * Canonical form for comparison: NFKC, lowercase, one apostrophe, spoken symbols and digits spelled out,
 * punctuation dropped (intra-word apostrophes kept so "it's" ≠ "its"), dashes as spaces, single spaces.
 * Any other symbol (\p{S}, plus #§‰) becomes its own token: it can never silently disappear, so a script
 * line containing one only passes if the ASR emits the same symbol, i.e. it fails strictly.
 */
export function normalize(text: string): string {
  let s = text.normalize("NFKC").toLowerCase();
  s = s.replace(/[’ʼ‘`]/g, "'");
  s = spellSymbols(s);
  s = spellNumbers(s);
  // Hyphens and every dash variant separate words.
  s = s.replace(/[-‐‑‒–—―−]/g, " ");
  // Keep an apostrophe only between two letters/digits; drop the remaining punctuation; isolate symbols.
  s = s.replace(/(?<=[\p{L}\p{N}])'(?=[\p{L}\p{N}])/gu, "\u0000");
  s = s.replace(new RegExp(`[^\\p{L}\\p{N}\\p{M}\\p{S}${SPOKEN_PUNCT}\\s\\u0000]`, "gu"), " ");
  s = s.replace(new RegExp(`[\\p{S}${SPOKEN_PUNCT}]\\p{M}*`, "gu"), " $& ");
  s = s.replace(/\u0000/g, "'");
  return s.replace(/\s+/g, " ").trim();
}

function tokens(text: string): string[] {
  const n = normalize(text);
  return n === "" ? [] : n.split(" ");
}

/** Spoken word count: counted after normalisation, so "3:15" is two words and "$5" is two. */
export function wordCount(text: string): number {
  return tokens(text).length;
}

/**
 * Word-level Levenshtein alignment of `heard` against `expected`.
 * wer = (S + D + I) / N. With an empty expected line, any heard word is a full failure (wer = 1).
 * pass is strictly wer === 0: a single word-level difference never passes.
 */
export function compareWords(expected: string, heard: string): VerbatimResult {
  const e = tokens(expected);
  const h = tokens(heard);
  const rows = e.length + 1;
  const cols = h.length + 1;
  // dist[i][j] = edit distance between e[0..i) and h[0..j)
  const dist: number[][] = Array.from({ length: rows }, (_, i) =>
    Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const same = e[i - 1] === h[j - 1] ? 0 : 1;
      dist[i]![j] = Math.min(dist[i - 1]![j - 1]! + same, dist[i - 1]![j]! + 1, dist[i]![j - 1]! + 1);
    }
  }

  // Backtrace from the end; prefer match/sub, then del, then ins, so the alignment is deterministic.
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
  ops.reverse();

  const wer = e.length === 0 ? (h.length === 0 ? 0 : 1) : ops.length / e.length;
  return { expected: e.join(" "), heard: h.join(" "), wer, ops, pass: ops.length === 0 };
}

/**
 * Lines the idea quotes: text inside "…", “…”, «…» or „…“ (also „…”), exactly as written.
 * Single quotes are never delimiters — they are apostrophes far more often than quotes.
 */
export function extractQuotedLines(idea: string): string[] {
  const re = /"([^"]*)"|“([^”]*)”|«([^»]*)»|„([^“”]*)[“”]/g;
  const out: string[] = [];
  for (const m of idea.matchAll(re)) {
    const inner = m[1] ?? m[2] ?? m[3] ?? m[4] ?? "";
    if (inner !== "") out.push(inner);
  }
  return out;
}
