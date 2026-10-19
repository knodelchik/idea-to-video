# F15 — A small hosted web demo behind one access code

## Goal
A reviewer opens a URL, types the access code they were given, and sees:
1. **A gallery** of the finished runs. Each card plays the video and shows a run inspector: idea, script, shots, and
   every attempt with its stage, ok/reason, judge score, cost and time. It also shows WER with expected vs heard text,
   the fallback ladder (keyframe refused → portraits only…) and the subtitles.
2. **A form** that runs the pipeline on their own idea. Mock (free, about 10 s) is the default; live is an explicit
   choice. The page shows progress live and the result with its inspector.

It builds on F16 (observability): the inspector shows the run's trace and the page shows metrics across runs.

It is hosted on the author's Oracle VPS, behind the Traefik that Coolify already runs there. The goal is to make the
harness thinking visible: nothing is silent, every cent and retry is on record.

## Scope
### Server (`src/web/server.ts`, Node `http`, no framework; `pnpm web`)
- **Config from env:**
  - `ACCESS_CODE` (required; the server refuses to start without it);
  - `SESSION_SECRET` (required);
  - `PORT` (default 8080);
  - `RUNS_DIR` (default `runs`);
  - `EXAMPLES_DIR` (default `examples`);
  - `WEB_LIVE` (`1` allows live runs; default off → mock only);
  - `MAX_COST_USD` per run (default 3; passed to the CLI);
  - provider keys are read by the CLI child as today.
- **Auth:**
  - `POST /login` with `{code}`. Compare with `crypto.timingSafeEqual` on equal-length hashes. On success set an
    HttpOnly, Secure, SameSite=Lax cookie holding `exp.HMAC(SESSION_SECRET, exp)`, valid 7 days.
  - Rate-limit failed logins per IP: 5 per 15 minutes, then 429.
  - Every other route except `GET /login`, `GET /health` and static CSS/JS needs the cookie: 401 for the API, a
    redirect for pages.
- **Runs:**
  - `POST /api/runs {idea, mode}`. Validate the idea (1–800 chars, trimmed). `mode` is `mock|live`; `live` returns
    403 unless `WEB_LIVE=1`.
  - **One run at a time:** 409 "a video is being made, try again in a few minutes" while one is running.
  - Spawn `tsx src/cli.ts <idea> --<mode> --json` with `child_process.spawn` (argument array, never a shell string),
    with `MAX_COST_USD` in env. Return `{runId}` as soon as the child prints its run id (or pass the id in), so the
    page can follow it.
- `GET /api/runs`: finished runs (from `RUNS_DIR` manifests) plus examples (from `EXAMPLES_DIR/*.manifest.json`),
  newest first. Each has title, idea, ok, seconds, costUsd, WER, a thumbnail time and its video URL.
- `GET /api/runs/:id`: the manifest JSON (validated with `RunManifest`; ids must match `^[\w-]+$`, and resolved paths
  must stay inside the dir — no traversal).
- `GET /api/runs/:id/events`: Server-Sent Events. Poll the run's manifest every second and send each new attempt as
  an event, then `done` with the result. The stream closes on done or when the client leaves.
- `GET /media/:id/final.mp4` and `GET /media/examples/:file.mp4` with HTTP Range support (for video seeking) and
  auth.
- `GET /api/runs/:id/trace`: the run's `trace.jsonl` as a JSON array (F16), same auth and path rules.
- `GET /api/metrics`: `metrics()` from F16 over `RUNS_DIR` plus the examples.
- `GET /health` → `ok`.

### Page (`src/web/public/` — `index.html`, `app.js`, `app.css`; plain JS, no build step)
- **Login screen:** a code field and a button.
- **Main page, top:** "Make a video". A textarea with 3 clickable example ideas (the castle storyboard, the
  mother/son dialogue, the watchmaker numbers) and a Mock/Live switch. Live is disabled with a note when the server
  says live is off. A short line explains mock vs live, and that live costs about $1–2 and takes 5–10 min.
- **Progress:** a live list of attempts as they arrive (stage, shot, ok ✓/✗, reason, $), the running cost, and
  elapsed time.
- **Gallery** of cards. Clicking a card opens the inspector:
  - the video (9:16);
  - the idea;
  - characters;
  - shots with camera, cuts and line;
  - verbatim (expected vs heard, WER, ignored words);
  - a timeline table of every attempt with failed rows highlighted;
  - totals: cost, time, attempts per stage.
- **Trace tab in the inspector (F16):** the run's model calls as a timeline grouped by node and shot (kind,
  provider and model, ms, $, ok). Clicking a row shows the request and the response: prompt, rubric, finish reason,
  truncated text.
- **Metrics page:** the F16 numbers as compact cards plus small bars:
  - success rate, verbatim on the first take, $ per video, p50/p90 per stage;
  - fallback and rung rates, judge score distribution, top failure reasons.
- Phone-friendly (a 16 px gutter, no horizontal scroll). Dark theme matching the note (black, white, one accent).
- No external scripts.

### Deploy (`deploy/`)
- **`Dockerfile`:**
  - base `node:22-bookworm-slim`, which must build on linux/arm64;
  - apt `ffmpeg fonts-dejavu-core`;
  - pnpm via corepack, `pnpm install --frozen-lockfile --prod=false`;
  - copy the repo minus `.env`, `runs`, `node_modules`, `.git` (via `.dockerignore`);
  - `CMD ["pnpm","web"]`.
- **`docker-compose.yml`:**
  - one service `itv-web` with `restart: unless-stopped`, `env_file: .env` and volume `./runs:/app/runs`;
  - on the external `coolify` network, with Traefik labels in the same shape as the author's other apps:
    `Host(${APP_DOMAIN})`, entrypoint https, tls, certresolver letsencrypt, service port 8080.
- **`deploy/README.md`:**
  - which env vars go in the server's `.env`: keys, `ACCESS_CODE`, `SESSION_SECRET`, `WEB_LIVE`, `APP_DOMAIN`;
  - how to build and start;
  - the server's quirks: no rsync, so `tar | ssh`; Coolify prunes unused images nightly, so the container must keep
    running.
- Never copy `.env` into the image; the build must fail if `.env` would be included.

### Tests (`tests/web.test.ts`)
- Run the server in-process on a random port, with `ACCESS_CODE=test-code` and temp dirs.
- Use a fake runner instead of spawning the CLI: inject a `startRun` function that writes a manifest over time.

## Acceptance
1. **Auth:**
   - without the cookie, `/api/runs` → 401;
   - a wrong code → 401;
   - the 6th wrong code within 15 min → 429;
   - the right code sets a cookie with `HttpOnly`, `Secure` and `SameSite=Lax`, after which `/api/runs` → 200;
   - a forged or expired cookie → 401;
   - the server refuses to start without `ACCESS_CODE` or `SESSION_SECRET`.
2. **Runs:**
   - `POST /api/runs` with mode live and `WEB_LIVE` unset → 403;
   - an empty or 801-char idea → 400;
   - a second POST while one runs → 409;
   - the runner is called with the idea as one argument (no shell);
   - `MAX_COST_USD` reaches the child env.
3. **SSE:** `/api/runs/:id/events` delivers attempts in order and a final `done` with `ok` and the video URL.
4. **Paths:** `/api/runs/..%2F..%2Fetc` → 400/404; media serving answers a Range request with 206 and the right
   `Content-Range`.
5. `/api/runs/:id/trace` returns the spans of a run; `/api/metrics` returns the F16 object.
6. `/api/runs` lists the examples from `EXAMPLES_DIR` with their costs and WER.
7. A real mock run through the real CLI, one test marked slow, ends with a playable `final.mp4` served under
   `/media/<id>/final.mp4`.
8. `docker build -f deploy/Dockerfile .` succeeds locally if Docker is available. Otherwise
   `deploy/Dockerfile` and `docker-compose.yml` pass a static check in a test: base image, ffmpeg, no `.env`, the
   coolify network, the labels.
9. `pnpm verify` green; F01–F16 tests still pass.

## Decisions
- **Files:** `src/web/config.ts` (env → `WebConfig`; throws without `ACCESS_CODE` / `SESSION_SECRET`),
  `auth.ts` (cookie sign/verify, `LoginLimiter`), `runs.ts` (safe ids, manifests, gallery, F16 records),
  `media.ts` (`parseRange`, `sendFile`), `runner.ts` (`runSpec`, `spawnRunner`), `server.ts` (routes, SSE, `main`).
  `createWebServer(cfg, { startRun, pollMs, now, log })` is what tests use; `pnpm web` runs `main()`.
- **Passing the run id in, not parsing it out:** the CLI gained `--run-id <id>` (`^[\w-]+$`, refused with `--resume`,
  and `runPipeline` refuses an id whose manifest already exists). The server makes the id (same format as
  `newRunId`) and returns `{runId}` at once with 202. The rejected alternative was reading the id from the child's
  stdout: `--json` prints only at the end, so it would have meant a new early log line plus parsing.
- **`--` ends the CLI's flags:** the child gets `… --<mode> --json --run-id <id> -- <idea>`. Without it, an idea
  typed as `--live …` would be parsed as the live flag. That would be a paid run started from the mock form, so this
  is a security fix and not just style. The spec's order (`<idea> --<mode> --json`) is otherwise the same command.
- **`node --import tsx src/cli.ts`** (`process.execPath`, argument array, `shell: false`) rather than
  `node_modules/.bin/tsx`. Under pnpm that path is a `sh` shim; going through it is still safe (`"$@"`), but
  spawning node directly keeps a shell out of the path entirely. `tsx` is already a dependency.
- **`RUNS_DIR` in the CLI:** `main()` now reads `env.RUNS_DIR` (default `runs`), so the child writes where the
  server reads. The child env is `process.env` minus `ACCESS_CODE` / `SESSION_SECRET`, plus `MAX_COST_USD` and
  `RUNS_DIR`.
- **"Finished"** = `ok` or `error` set. In-flight manifests have `ok: false` and no error. SSE re-reads the
  manifest every `pollMs` (1 s), sends `attempt` (with `index`) for each new attempt and `progress` (`costUsd`).
  It ends with `done` when the manifest is finished or the server's child has exited. A child that died without a
  manifest gets `done` with `ok: false` and the tail of its output. A half-written manifest (a non-atomic
  `writeFile`) is just read again on the next tick.
- **Auth:** the code check is `timingSafeEqual(sha256(given), sha256(code))`. The cookie is
  `itv_session=<expMs>.<hex HMAC-SHA256(secret, expMs)>`, HttpOnly, Secure, SameSite=Lax, Max-Age 7 days. Once 5
  failures fall in the 15-min window, **every** login from that IP gets 429, the right code included; otherwise
  guessing just goes on. `/logout` clears the cookie.
- **Client IP behind Traefik:** new optional `TRUST_PROXY=1` (compose sets it) takes the *last* `X-Forwarded-For`
  entry, the one Traefik appended. A client can prepend fake entries but can't change the last one. Off by default,
  because without a proxy the header is client-controlled. Without this flag, every login would come from
  Traefik's IP and one bad guesser would lock everyone out.
- **Ids and paths:** every URL id goes through `inside(dir, id)`: `^[\w-]+$` **and** the resolved path stays under
  the dir. `/api/runs/:id` tries the run folder, then `EXAMPLES_DIR/<id>.manifest.json`. A manifest that fails
  `RunManifest` is 500 for that id and is left out of the gallery and metrics with a log line. Malformed `%`
  escapes are 400.
- **Gallery:** `GalleryItem { id, kind: run|example, title (script title or idea), idea, mode, ok, seconds, costUsd,
  wer, thumbTime (middle of shot 1), videoUrl, createdAt, attempts }`. Finished runs plus all examples, by
  `createdAt` desc.
- **Page:** one `index.html` serves both `/login` and `/` (the JS picks the view). Views are hash routes: `#/` make,
  `#/gallery`, `#/metrics`. The inspector is a `<dialog>` with Run / Trace tabs. All run data goes in via
  `textContent`. The CSP is `default-src 'self'` with no inline scripts or styles (bar widths are set through
  CSSOM), plus `X-Frame-Options: DENY` and `nosniff`. Live mode asks for a `confirm()` with the cost before posting.
- **Deploy:** `.dockerignore` at the repo root (the context of `docker build -f deploy/Dockerfile .`) excludes
  `**/.env*` (except `.env.example`), `runs`, `node_modules`, `.git`. The Dockerfile also `find`s any `.env` and
  `exit 1`s, which is the "build must fail" guard. pnpm is pinned through corepack to 11.21.0 (the version that
  wrote the lockfile), with `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`. `python3 make g++` are added so `better-sqlite3`
  can compile on arm64 if no prebuild matches. Compose publishes no ports (Traefik only) and adds
  `traefik.docker.network=coolify`.
- **Docker is not installed on this machine**, so acceptance 8 is met by the static test (base image, ffmpeg,
  corepack/pnpm, no `COPY .env`, the `.env` guard, `.dockerignore`, coolify network, labels). I did not guess the
  exact Traefik labels of the author's other apps; they are the standard Coolify/Traefik v2+ shape the spec lists.
- **Not verified in a real browser:** this session could not keep a server running. The page's HTTP side
  (`/login`, assets, CSP-safe markup, all APIs) is covered by tests and `app.js` passes `node --check`. The DOM
  behaviour should get a manual look on first deploy.
- **No new dependencies.** References (stable APIs, used from knowledge and **not re-fetched in this session**;
  the behaviour that matters is pinned by tests): Node `http`, `crypto.timingSafeEqual`, `child_process.spawn`
  (nodejs.org/api, v22); MDN Server-Sent Events and HTTP Range requests (206/416); Docker `.dockerignore`
  (docs.docker.com/build/concepts/context/#dockerignore-files); Traefik Docker labels
  (doc.traefik.io/traefik/routing/providers/docker/). Worth reading before the first real deploy: the Traefik
  labels and corepack's pnpm pin.
