# ─────────────────────────────────────────────────────────────────────────────
# CHURCH WORK SPACE — CLOUD STUDIO
#
# The Video Studio as a server: the app's own main process, all 199 handlers,
# running under plain Node with no Electron (src/cloud/electron-shim.js), with
# the PWA in front of it. Build it, run it, open it on a phone.
#
#   docker build -t church-cloud-studio .
#   docker run -d --name studio -p 7390:7390 \
#     -e MW_CLOUD_CODE="your-access-code-1234" \
#     -v studio-data:/data -v /path/to/recordings:/media \
#     church-cloud-studio
#
# WHAT IS AND IS NOT IN HERE
#
#   ffmpeg      yes — from the npm package, so it is the same build the desktop
#                     uses and the encoder settings behave identically.
#   whisper     yes — built from source below, because captions are the reason
#                     most people came. The MODELS are not baked in (they are
#                     hundreds of megabytes and the app downloads the one you
#                     choose); they live on the /data volume after that, so they
#                     survive a rebuild.
#   MediaPipe   yes — bin/ai is copied, and auto-reframe runs in the BROWSER
#                     anyway, so the server never needs a GPU for it.
#   NDI,        no  — they drive hardware in a building. The cloud allowlist
#   cameras,          does not expose them and nothing in the page asks.
#   projectors
#
# A cheap VPS has no GPU, so exports fall back to libx264 on the CPU. That is
# slower than the church PC with Quick Sync, not different: same file, same
# settings, more minutes. Give it 2+ cores.
# ─────────────────────────────────────────────────────────────────────────────

# ── whisper.cpp ──────────────────────────────────────────────────────────────
# Built in its own stage so none of the compiler lands in the final image.
FROM debian:bookworm-slim AS whisper
ARG WHISPER_REF=v1.7.4
RUN apt-get update && apt-get install -y --no-install-recommends \
      git build-essential cmake ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git clone --depth 1 --branch ${WHISPER_REF} https://github.com/ggerganov/whisper.cpp.git \
    && cd whisper.cpp \
    && cmake -B build -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON \
    && cmake --build build --config Release -j"$(nproc)"

# ── the studio ───────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim
LABEL org.opencontainers.image.title="Church Work Space — Cloud Studio"
LABEL org.opencontainers.image.description="The church Video Studio, in a browser, from anywhere."

# yt-dlp needs python; the fonts are for caption rendering by ffmpeg.
#
# `ffmpeg` from the distro is here for ARM, and it is not belt-and-braces: the
# npm `ffprobe-static` package ships linux binaries for x64 and ia32 ONLY. The
# free tier worth having (Oracle's Ampere machines) is arm64, and without this
# the app would start, take a recording, and fail at the first probe. The app
# prefers the bundled binary and falls back to PATH (src/main/ffmpeg.js), so on
# x64 the npm build still wins and nothing about the encoding changes.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 ca-certificates fontconfig tini ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, so a code change does not re-download ffmpeg.
COPY package.json package-lock.json ./
# Electron is a devDependency and is 200 MB of desktop app this image will never
# open a window with — the shim is the whole point. --omit=dev leaves it out.
RUN npm ci --omit=dev --no-audit --no-fund

# The app itself. Only what a server runs: src/, the offline AI assets, the
# caption fonts, and the licences.
COPY src/ ./src/
COPY bin/ai/ ./bin/ai/
COPY bin/fonts/ ./bin/fonts/
COPY legal/ ./legal/

# whisper.cpp, named the way src/main/captioner.js looks for it on Linux.
#
# TWO names, deliberately: the captioner tries `whisper-cli-<arch>` first and
# plain `whisper-cli` second (see cliCandidates), and the arch-suffixed one is
# what an x64 and an arm64 drop would use to sit side by side. Copying to both
# means this image works whichever rule wins.
COPY --from=whisper /src/whisper.cpp/build/bin/whisper-cli /app/bin/whisper/whisper-cli
RUN chmod +x /app/bin/whisper/whisper-cli \
    && ln -sf whisper-cli "/app/bin/whisper/whisper-cli-$(node -p 'process.arch')"

# Recordings go in /media, everything the app keeps goes in /data — both are
# volumes so a rebuilt image keeps the church's library, its saved sessions and
# the speech model it downloaded.
ENV MW_CLOUD_DATA=/data \
    MW_CLOUD_MEDIA=/media \
    MW_CLOUD_PORT=7390 \
    MW_CLOUD_HOST=0.0.0.0 \
    NODE_ENV=production
RUN mkdir -p /data /media
VOLUME ["/data", "/media"]
EXPOSE 7390

# ffmpeg runs as children of this process; tini reaps them so a cancelled export
# does not leave a zombie behind for every job.
ENTRYPOINT ["/usr/bin/tini", "--"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.MW_CLOUD_PORT||7390)+'/api/hello',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "src/cloud/server.js"]
