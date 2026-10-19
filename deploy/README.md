# Deploying the web demo (F15)

One container, `itv-web`, behind the Traefik that Coolify already runs on the Oracle VPS (linux/arm64). Traefik
terminates TLS (Let's Encrypt) and routes `APP_DOMAIN` to port 8080 on the external `coolify` network. The container
publishes no port of its own.

## 1. The server's `.env` (next to `docker-compose.yml`, in `deploy/`)

It is read by compose (`env_file: .env`) at start. It is **never** copied into the image: `.dockerignore` keeps it
out of the build context, and the Dockerfile fails the build if a `.env` gets in anyway.

```dotenv
# --- web ---
APP_DOMAIN=itv.example.com          # Host(`…`) rule for Traefik; DNS must point at the VPS
ACCESS_CODE=                        # the one code reviewers type; long and random: openssl rand -base64 18
SESSION_SECRET=                     # signs the session cookie; openssl rand -hex 32. Changing it logs everyone out
WEB_LIVE=0                          # 1 = the form may start live (paid) runs. Leave 0 unless you are watching
MAX_COST_USD=3                      # hard stop per run, passed to the CLI child
# PORT=8080  RUNS_DIR=/app/runs  EXAMPLES_DIR=/app/examples   (image defaults)

# --- provider keys (only needed with WEB_LIVE=1; same names as the repo's .env.example) ---
GEMINI_API_KEY=
FAL_KEY=
GROQ_API_KEY=
ARK_API_KEY=
OPENROUTER_API_KEY=
ELEVENLABS_API_KEY=
# plus any model/provider choices from .env.example (IMAGE_PROVIDER, SEEDANCE_TRANSPORT, …)
```

The server refuses to start without `ACCESS_CODE` or `SESSION_SECRET`. Compose sets `TRUST_PROXY=1` so the login
rate limit (5 wrong codes per 15 min per IP) sees the client's IP from Traefik's `X-Forwarded-For`, not Traefik's.

## 2. Ship the code

The VPS has **no rsync**, so copy with `tar | ssh` (from the repo root, without secrets, runs or node_modules):

```sh
tar --exclude=.env --exclude='.env.*' --exclude=runs --exclude=node_modules --exclude=.git -czf - . \
  | ssh ubuntu@<vps> 'mkdir -p ~/itv && tar -xzf - -C ~/itv'
```

Then put the `.env` above in `~/itv/deploy/.env` on the server (once; it is not part of the tarball).

## 3. Build and start

```sh
ssh ubuntu@<vps>
cd ~/itv/deploy
docker compose up -d --build        # builds deploy/Dockerfile with the repo root as context
docker compose logs -f itv-web      # "web: listening on :8080 (… live off …)"
curl -fsS https://$APP_DOMAIN/health   # ok
```

Runs land in `~/itv/deploy/runs` (volume `./runs:/app/runs`), so they survive rebuilds. The gallery also shows
`examples/` baked into the image.

To update: repeat step 2, then `docker compose up -d --build`.

## Quirks of this server

- **No rsync**: use `tar | ssh` as above.
- **Coolify prunes unused images nightly.** An image with no running container is deleted, so the container must
  keep running (`restart: unless-stopped`). After a `docker compose down` the next `up` may need `--build`.
- The base image is `node:22-bookworm-slim`, which is multi-arch, so the same Dockerfile builds on the arm64 VPS.
  `python3 make g++` are in the image only so `better-sqlite3` can compile if no prebuilt arm64 binary matches.
- Live runs are spawned as `node --import tsx src/cli.ts --live …` children that read the provider keys from the
  container env, the same way `pnpm make` reads them from `.env`.
