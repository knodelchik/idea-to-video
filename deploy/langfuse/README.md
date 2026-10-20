# Self-hosted Langfuse (v4) next to the demo

The traces from the hosted demo go to this Langfuse on the same VPS, behind Coolify's Traefik.

```sh
# on the server, in ~/langfuse
./setup.sh                       # writes .env with random secrets (never printed); set LANGFUSE_DOMAIN in it
docker compose up -d
# create the first account in the UI, then close sign-up:
#   AUTH_DISABLE_SIGNUP=true in .env  →  docker compose up -d langfuse-web
```

The app sends traces when `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` and `LANGFUSE_BASE_URL` are set.

Three traps hit on a 2-vCPU / 11 GB ARM box:
1. **Shared `coolify` network.** The name `postgres` resolved to *another app's* Postgres there, which gave P1000 auth
   failed. So all backing services have unique names (`lf-*`).
2. **Node heap.** At a 1 GB limit the web container ran out of heap on start. It now has 2 GB and
   `--max-old-space-size=1536`; ClickHouse runs with `clickhouse-low-memory.xml`.
3. **Two networks.** Next.js binds to `$HOSTNAME`, so Traefik got a 502 until `HOSTNAME=0.0.0.0`.
