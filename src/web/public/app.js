// idea → video web demo (F15). Plain JS, no build step, no external scripts. Everything from a run is put in the
// page with textContent (never innerHTML), so a manifest can't inject markup.
"use strict";

const EXAMPLES = [
  {
    label: "Castle storyboard",
    idea: '1 кадр: маленька дівчина в червоному плащі відчиняє величезні двері старого замку. 2 кадр: вона заходить у величезну бальну залу, зала видна вся, дівчина маленька на її фоні, і каже: "Hello? Is anyone still here?"',
  },
  {
    label: "Mother and son",
    idea: 'At the kitchen table, a mother slides an envelope to her son. She says: "Open it after I leave." He looks up and asks: "Mom, are you sick?"',
  },
  {
    label: "Watchmaker numbers",
    idea: 'An old watchmaker holds up a stopped pocket watch in his dim workshop. He says quietly: "It stopped in 1987, at 3:15 a.m., and so did I."',
  },
];

// ---------- tiny DOM helpers ----------
const $ = (id) => document.getElementById(id);
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== "string") el[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat()) if (kid !== undefined && kid !== null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}
const usd = (x) => (x === null || x === undefined ? "–" : `$${Number(x).toFixed(x >= 1 ? 2 : 4)}`);
const pct = (x) => `${Math.round((x || 0) * 100)}%`;
const secs = (ms) => (ms >= 60000 ? `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`);
const table = (head, rows) => h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, head.map((x) => h("th", {}, x)))), h("tbody", {}, rows)));

async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: "same-origin", ...opts, headers: { "content-type": "application/json", ...(opts.headers || {}) } });
  if (res.status === 401 && path !== "/login") {
    show("login");
    throw new Error("log in first");
  }
  const body = res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw Object.assign(new Error((body && body.error) || `HTTP ${res.status}`), { status: res.status });
  return body;
}

// ---------- views ----------
let config = { live: false };
const VIEWS = ["login", "make", "gallery", "metrics"];

function show(view) {
  for (const v of VIEWS) $(v).hidden = v !== view;
  $("nav").hidden = view === "login";
  for (const a of document.querySelectorAll("nav a")) a.classList.toggle("active", a.dataset.view === view);
  if (view === "login") {
    if (location.pathname !== "/login") history.replaceState(null, "", "/login");
    $("code").focus();
  }
}

function route() {
  const hash = location.hash.replace(/^#\/?/, "");
  if (hash.startsWith("gallery")) {
    show("gallery");
    loadGallery();
  } else if (hash.startsWith("metrics")) {
    show("metrics");
    loadMetrics();
  } else show("make");
}

async function boot() {
  try {
    config = await api("/api/config");
  } catch {
    show("login");
    return;
  }
  if (location.pathname === "/login") history.replaceState(null, "", "/");
  $("mode-live").disabled = !config.live;
  $("live-off").hidden = config.live;
  route();
  if (config.active) follow(config.active);
}

// ---------- login ----------
$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("login-error").textContent = "";
  try {
    await api("/login", { method: "POST", body: JSON.stringify({ code: $("code").value }) });
    $("code").value = "";
    history.replaceState(null, "", "/");
    await boot();
  } catch (err) {
    $("login-error").textContent = err.message;
  }
});
$("logout").addEventListener("click", async () => {
  await fetch("/logout", { method: "POST" });
  show("login");
});

// ---------- make ----------
for (const ex of EXAMPLES) {
  $("examples").append(h("button", { type: "button", class: "chip", onclick: () => ($("idea").value = ex.idea) }, ex.label));
}

$("run-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("run-error").textContent = "";
  const mode = new FormData(e.target).get("mode");
  if (mode === "live" && !confirm("Live calls paid models: about $1–2 and 5–10 minutes. Go?")) return;
  try {
    const { runId } = await api("/api/runs", { method: "POST", body: JSON.stringify({ idea: $("idea").value, mode }) });
    follow(runId);
  } catch (err) {
    $("run-error").textContent = err.message;
  }
});

let stream = null;
function follow(runId) {
  if (stream) stream.close();
  const started = Date.now();
  $("progress").hidden = false;
  $("progress-title").textContent = `Running ${runId}…`;
  $("progress-rows").replaceChildren();
  $("progress-result").replaceChildren();
  $("progress-cost").textContent = usd(0);
  $("run-button").disabled = true;
  const timer = setInterval(() => ($("progress-time").textContent = secs(Date.now() - started)), 500);
  stream = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events`);
  stream.addEventListener("attempt", (ev) => {
    const a = JSON.parse(ev.data);
    $("progress-rows").append(
      h("tr", { class: a.ok ? "" : "failed" }, h("td", {}, a.index + 1), h("td", {}, a.stage), h("td", {}, a.shotId || ""), h("td", {}, a.ok ? "✓" : "✗"), h("td", { class: "reason" }, a.reason || ""), h("td", {}, usd(a.costUsd))),
    );
  });
  stream.addEventListener("progress", (ev) => ($("progress-cost").textContent = usd(JSON.parse(ev.data).costUsd)));
  stream.addEventListener("done", async (ev) => {
    const d = JSON.parse(ev.data);
    stream.close();
    stream = null;
    clearInterval(timer);
    $("run-button").disabled = false;
    $("progress-title").textContent = d.ok ? "Done ✓" : "Failed ✗";
    $("progress-cost").textContent = usd(d.costUsd);
    const out = $("progress-result");
    if (!d.ok) out.append(h("p", { class: "bad" }, d.error || "the run failed"));
    try {
      out.append(overview(await api(`/api/runs/${encodeURIComponent(runId)}`), d.videoUrl));
    } catch (err) {
      out.append(h("p", { class: "bad" }, err.message));
    }
  });
  stream.onerror = () => {
    // The browser reconnects by itself; a closed stream after "done" is expected.
    if (stream && stream.readyState === EventSource.CLOSED) {
      clearInterval(timer);
      $("run-button").disabled = false;
    }
  };
}

// ---------- gallery ----------
async function loadGallery() {
  const cards = $("cards");
  cards.replaceChildren(h("p", { class: "muted" }, "Loading…"));
  let runs;
  try {
    runs = await api("/api/runs");
  } catch (err) {
    cards.replaceChildren(h("p", { class: "bad" }, err.message));
    return;
  }
  cards.replaceChildren(
    ...runs.map((r) =>
      h(
        "button",
        { type: "button", class: "card", onclick: () => openInspector(r) },
        r.videoUrl ? h("video", { src: `${r.videoUrl}#t=${r.thumbTime}`, preload: "metadata", muted: true, playsInline: true }) : h("div", { class: "player" }),
        h(
          "div",
          { class: "meta" },
          h("div", { class: "title" }, r.title),
          h(
            "div",
            { class: "row" },
            h("span", { class: `badge ${r.ok ? "" : "accent"}` }, r.ok ? "ok" : "failed"),
            h("span", { class: "badge" }, r.kind === "example" ? "example" : r.mode),
            h("span", { class: "muted" }, usd(r.costUsd)),
            r.seconds ? h("span", { class: "muted" }, `${r.seconds.toFixed(1)} s`) : null,
            r.wer !== null ? h("span", { class: "muted" }, `WER ${r.wer}`) : null,
          ),
        ),
      ),
    ),
  );
  if (!runs.length) cards.append(h("p", { class: "muted" }, "No runs yet."));
}

// ---------- inspector ----------
const dialog = $("inspector");
$("inspector-close").addEventListener("click", () => dialog.close());
dialog.addEventListener("close", () => dialog.querySelectorAll("video").forEach((v) => v.pause()));
for (const b of dialog.querySelectorAll("[data-tab]")) {
  b.addEventListener("click", () => {
    for (const x of dialog.querySelectorAll("[data-tab]")) x.setAttribute("aria-selected", String(x === b));
    $("inspector-overview").hidden = b.dataset.tab !== "overview";
    $("inspector-trace").hidden = b.dataset.tab !== "trace";
  });
}

async function openInspector(item) {
  dialog.querySelector('[data-tab="overview"]').click();
  $("inspector-overview").replaceChildren(h("p", { class: "muted" }, "Loading…"));
  $("inspector-trace").replaceChildren(h("p", { class: "muted" }, "Loading…"));
  dialog.showModal();
  const id = encodeURIComponent(item.id);
  try {
    const [m, spans] = await Promise.all([api(`/api/runs/${id}`), api(`/api/runs/${id}/trace`)]);
    $("inspector-overview").replaceChildren(overview(m, item.videoUrl));
    $("inspector-trace").replaceChildren(traceView(spans));
  } catch (err) {
    $("inspector-overview").replaceChildren(h("p", { class: "bad" }, err.message));
  }
}

const LADDER = [
  { key: "keyframe", label: "keyframe + portraits", re: null },
  { key: "refs", label: "reference-to-video", re: /retrying as reference-to-video$/ },
  { key: "portraits", label: "portraits only", re: /retrying as reference-to-video with the portraits only/ },
  { key: "text", label: "text-to-video", re: /retrying as text-to-video/ },
];

/** The real-face fallback ladder per shot, from the video attempts' reasons. */
function ladder(m) {
  const refusals = m.attempts.filter((a) => a.stage === "video" && /refused as a possible real person/.test(a.reason || ""));
  if (!refusals.length) return null;
  const byShot = {};
  for (const a of refusals) (byShot[a.shotId || "?"] ||= []).push(a.reason);
  return h(
    "div",
    {},
    Object.entries(byShot).map(([shot, reasons]) =>
      h(
        "div",
        { class: "ladder" },
        h("strong", {}, shot),
        LADDER.map((r, i) => [i ? h("span", { class: "muted" }, "→") : null, h("span", { class: `step ${i === 0 || reasons.some((x) => r.re && r.re.test(x)) ? "used" : ""}` }, r.label)]),
        h("span", { class: "muted small" }, `(${reasons.length} refusal${reasons.length > 1 ? "s" : ""})`),
      ),
    ),
  );
}

function verbatimView(m) {
  const v = m.verbatim;
  if (!v) return h("p", { class: "muted" }, "No final verbatim check (the run did not get there).");
  const missed = new Set(v.ops.map((o) => (o.expected || "").toLowerCase()).filter(Boolean));
  const words = (m.spoken?.expected ?? v.expected).split(/\s+/);
  return h(
    "dl",
    { class: "kv" },
    h("dt", {}, "expected"),
    h("dd", { class: "diff" }, words.map((w, i) => [i ? " " : "", h("span", { class: missed.has(w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "")) ? "miss" : "" }, w)])),
    h("dt", {}, "heard"),
    h("dd", {}, m.spoken?.heard ?? v.heard),
    h("dt", {}, "WER"),
    h("dd", { class: v.pass ? "ok" : "bad" }, `${v.wer} ${v.pass ? "✓ word for word" : "✗"}`),
    v.ops.length ? [h("dt", {}, "misses"), h("dd", {}, v.ops.map((o) => `${o.type}: ${o.expected ?? "∅"} → ${o.heard ?? "∅"}`).join("; "))] : null,
    v.ignored?.length ? [h("dt", {}, "ignored"), h("dd", {}, v.ignored.join(", "))] : null,
  );
}

function shotsView(m) {
  if (!m.script) return h("p", { class: "muted" }, "No script.");
  return m.script.shots.map((s) => {
    const out = m.shots?.[s.id];
    return h(
      "div",
      { class: "shot" },
      h(
        "div",
        { class: "row" },
        h("strong", {}, s.id),
        h("span", { class: "badge" }, s.camera),
        h("span", { class: "muted" }, `${s.seconds} s`),
        out ? h("span", { class: `badge ${out.audio === "native" || out.audio === "silent" ? "" : "accent"}` }, out.audio) : null,
        out?.keyframeScore ? h("span", { class: "muted small" }, `keyframe ${out.keyframeScore}/10`) : null,
        out?.clipScore ? h("span", { class: "muted small" }, `clip ${out.clipScore}/10`) : null,
        out?.needsReview ? h("span", { class: "badge accent" }, "needs review") : null,
      ),
      h("div", {}, s.visual),
      s.cuts ? h("ol", { class: "small" }, s.cuts.map((c) => h("li", {}, `${c.camera}: ${c.visual}`))) : null,
      s.line ? h("div", { class: "line" }, `${s.speaker ? `${s.speaker}: ` : ""}“${s.line}”`) : h("div", { class: "muted small" }, "silent"),
    );
  });
}

function totals(m) {
  const per = {};
  for (const a of m.attempts) {
    const t = (per[a.stage] ||= { n: 0, failed: 0, usd: 0, ms: 0 });
    t.n++;
    t.failed += a.ok ? 0 : 1;
    t.usd += a.costUsd;
    t.ms += a.ms;
  }
  const ms = m.attempts.reduce((s, a) => s + a.ms, 0);
  return [
    h("p", {}, `${usd(m.costUsd)} · ${secs(ms)} of model/tool time · ${m.attempts.length} attempts`),
    table(
      ["stage", "attempts", "failed", "$", "time"],
      Object.entries(per).map(([k, t]) => h("tr", {}, h("td", {}, k), h("td", {}, t.n), h("td", { class: t.failed ? "bad" : "" }, t.failed), h("td", {}, usd(t.usd)), h("td", {}, secs(t.ms)))),
    ),
  ];
}

function overview(m, videoUrl) {
  const s = m.script;
  return h(
    "div",
    { class: "inspect" },
    h("div", {}, videoUrl ? h("video", { class: "player", src: videoUrl, controls: true, playsInline: true, preload: "metadata" }) : h("div", { class: "player" })),
    h(
      "div",
      {},
      h("h2", {}, s?.title ?? m.runId),
      h("div", { class: "row" }, h("span", { class: `badge ${m.ok ? "" : "accent"}` }, m.ok ? "ok" : "failed"), h("span", { class: "badge" }, m.mode), h("span", { class: "muted small mono" }, m.runId)),
      m.error ? h("p", { class: "bad" }, m.error) : null,
      h("h3", {}, "Idea"),
      h("p", {}, m.idea),
      s ? [h("h3", {}, "Characters"), s.characters.map((c) => h("p", { class: "small" }, h("strong", {}, c.name), ` — ${c.look} `, h("span", { class: "muted" }, `(${c.voiceDescription})`)))] : null,
      h("h3", {}, "Shots"),
      shotsView(m),
      h("h3", {}, "Verbatim"),
      verbatimView(m),
      ladder(m) ? [h("h3", {}, "Fallback ladder (real-face refusals)"), ladder(m)] : null,
      m.subtitles ? [h("h3", {}, `Subtitles (${m.subtitles.timing ?? "asr"} timing)`), table(["from", "to", "text"], m.subtitles.cues.map((c) => h("tr", {}, h("td", {}, c.start.toFixed(2)), h("td", {}, c.end.toFixed(2)), h("td", {}, c.text))))] : null,
      m.notes?.length ? [h("h3", {}, "Notes"), m.notes.map((n) => h("p", { class: "small" }, n))] : null,
      h("h3", {}, "Totals"),
      totals(m),
      h("h3", {}, "Every attempt"),
      table(
        ["#", "stage", "shot", "n", "provider", "", "reason", "score", "$", "time"],
        m.attempts.map((a, i) =>
          h(
            "tr",
            { class: a.ok ? "" : "failed" },
            h("td", {}, i + 1),
            h("td", {}, a.stage),
            h("td", {}, a.shotId || ""),
            h("td", {}, a.n),
            h("td", { class: "small" }, a.provider),
            h("td", {}, a.ok ? "✓" : "✗"),
            h("td", { class: "reason" }, a.reason || ""),
            h("td", {}, a.score ?? ""),
            h("td", {}, usd(a.costUsd)),
            h("td", {}, secs(a.ms)),
          ),
        ),
      ),
    ),
  );
}

// ---------- trace (F16) ----------
function traceView(spans) {
  if (!spans.length) return h("p", { class: "muted" }, "No trace for this run (runs before F16 and the examples have none).");
  const calls = spans.filter((s) => s.kind !== "node");
  const groups = new Map();
  for (const s of calls) {
    const key = `${s.node}${s.shotId ? ` · ${s.shotId}` : ""}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const t0 = Math.min(...spans.map((s) => Date.parse(s.startedAt)));
  const detail = h("div", {});
  return h(
    "div",
    {},
    h("p", { class: "muted small" }, `${calls.length} model calls in ${groups.size} groups. Click a row for the request and the response.`),
    [...groups.entries()].map(([key, xs]) =>
      h(
        "div",
        { class: "group" },
        h("h3", {}, key),
        table(
          ["+s", "kind", "provider / model", "ms", "$", ""],
          xs.map((s) =>
            h(
              "tr",
              { class: `click ${s.ok ? "" : "failed"}`, onclick: () => showSpan(detail, s) },
              h("td", {}, ((Date.parse(s.startedAt) - t0) / 1000).toFixed(1)),
              h("td", {}, s.kind),
              h("td", { class: "small" }, `${s.provider}${s.model ? ` / ${s.model}` : ""}`),
              h("td", {}, s.ms),
              h("td", {}, s.cached ? "cached" : usd(s.costUsd)),
              h("td", {}, s.ok ? "✓" : "✗"),
            ),
          ),
        ),
      ),
    ),
    detail,
  );
}

function showSpan(target, s) {
  const r = s.request || {};
  const out = s.response || {};
  target.replaceChildren(
    h("h3", {}, `${s.kind} · ${s.provider}${s.model ? ` / ${s.model}` : ""} · ${s.node}${s.shotId ? ` · ${s.shotId}` : ""}`),
    s.error ? h("p", { class: "bad" }, s.error) : null,
    r.prompt ? [h("h3", {}, "prompt"), h("pre", {}, String(r.system ? `${r.system}\n\n---\n\n${r.prompt}` : r.prompt))] : null,
    r.rubric ? [h("h3", {}, "rubric"), h("pre", {}, String(r.rubric))] : null,
    out.finishReason ? h("p", {}, `finish reason: ${out.finishReason}`) : null,
    out.text !== undefined ? [h("h3", {}, `response${out.truncated ? ` (truncated, ${out.textLength} chars)` : ""}`), h("pre", {}, String(out.text))] : null,
    h("h3", {}, "request (raw)"),
    h("pre", {}, JSON.stringify(r, null, 2)),
    h("h3", {}, "response (raw)"),
    h("pre", {}, JSON.stringify(out, null, 2)),
  );
  target.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------- metrics (F16) ----------
function tile(big, label) {
  return h("div", { class: "tile" }, h("div", { class: "big" }, big), h("div", { class: "label" }, label));
}
function bars(entries, fmt = (v) => v) {
  const max = Math.max(1, ...entries.map(([, v]) => v));
  return h(
    "div",
    { class: "bars" },
    entries.map(([k, v]) => {
      const fill = h("div", { class: "fill" });
      fill.style.width = `${(v / max) * 100}%`;
      return h("div", { class: "bar" }, h("span", { class: "name", title: k }, k), h("div", { class: "track" }, fill), h("span", {}, fmt(v)));
    }),
  );
}

async function loadMetrics() {
  const body = $("metrics-body");
  body.replaceChildren(h("p", { class: "muted" }, "Loading…"));
  let m;
  try {
    m = await api("/api/metrics");
  } catch (err) {
    body.replaceChildren(h("p", { class: "bad" }, err.message));
    return;
  }
  const f = m.fallbacks;
  body.replaceChildren(
    h(
      "div",
      { class: "tiles" },
      tile(m.runs, `runs (${m.traced} traced)`),
      tile(pct(m.successRate), "success rate"),
      tile(pct(m.verbatimFirstTakeRate), "verbatim on the first take"),
      tile(pct(m.finalWerZeroRate), "final WER = 0"),
      tile(usd(m.costPerVideoUsd), "$ per video"),
      tile(usd(m.costPerSuccessUsd), "$ per successful video"),
      tile(`${(m.wallMs.run.p50 / 1000).toFixed(0)} s`, `p50 per run (p90 ${(m.wallMs.run.p90 / 1000).toFixed(0)} s)`),
      tile(pct(f.ttsRate), "spoken shots on TTS"),
    ),
    h("h2", {}, "Time per stage (p50 / p90)"),
    table(["stage", "p50", "p90", "n"], Object.entries(m.wallMs.stage).map(([k, s]) => h("tr", {}, h("td", {}, k), h("td", {}, secs(s.p50)), h("td", {}, secs(s.p90)), h("td", {}, s.n)))),
    h("h2", {}, "Fallbacks"),
    bars([
      ["real-face refusals", f.realFaceRefusals],
      ["→ reference-to-video", f.ladderRungs.refs],
      ["→ portraits only", f.ladderRungs.portraits],
      ["→ text-to-video", f.ladderRungs.text],
      ["lip-sync shots", f.shotAudio.fallback],
      ["voice-over shots", f.shotAudio.voiceover],
      ["native shots", f.shotAudio.native],
      ["silent-shot speech dropped", f.silentShotSpeechDropped],
    ]),
    h("h2", {}, `Judge scores (mean ${m.judge.mean ?? "–"}, ${m.judge.failures} failures, needs review ${pct(m.judge.needsReviewRate)})`),
    bars(Array.from({ length: 10 }, (_, i) => [String(i + 1), m.judge.scores[String(i + 1)] || 0])),
    h("h2", {}, "Attempts per stage"),
    bars(Object.entries(m.attemptsPerStage).map(([k, v]) => [k, v.total]), (v) => v),
    h("h2", {}, "Top failure reasons"),
    m.topFailures.length ? bars(m.topFailures.map((x) => [x.reason, x.count])) : h("p", { class: "muted" }, "None."),
    h("h2", {}, "Model calls"),
    table(["provider / model", "calls", "cached", "failed", "$"], m.modelCalls.map((c) => h("tr", {}, h("td", { class: "small" }, `${c.provider} / ${c.model}`), h("td", {}, c.calls), h("td", {}, c.cached), h("td", {}, c.failed), h("td", {}, usd(c.costUsd))))),
  );
}

window.addEventListener("hashchange", () => {
  if (!$("login").hidden) return;
  route();
});
boot();
