# idea-to-video web demo (F15). Build from the repo root: docker build -f deploy/Dockerfile .
# Multi-arch base: builds on the linux/arm64 Oracle VPS as well as amd64.
FROM node:22-bookworm-slim

# ffmpeg/ffprobe for the pipeline; DejaVu for burned-in subtitles and subtitle cards. python3/make/g++ only so that
# better-sqlite3 (LangGraph checkpoints) can compile if no prebuilt binary matches the platform.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core fonts-liberation ca-certificates python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# The pnpm that wrote pnpm-lock.yaml; no interactive download prompt in a build.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@11.21.0 --activate

# Dependencies first, so a code change doesn't reinstall them. tsx is a devDependency and runs the app, so dev deps stay.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod=false

COPY . .

# Secrets come from the container env (compose env_file), never from the image: fail if a .env slipped into the context.
RUN test -z "$(find . -path ./node_modules -prune -o \( -name .env -o -name '.env.*' ! -name .env.example \) -print)" || { echo "refusing to build: a .env file is in the build context (check .dockerignore)" >&2; exit 1; }

ENV PORT=8080 RUNS_DIR=/app/runs EXAMPLES_DIR=/app/examples
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["pnpm", "web"]
