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
#                     most people came, with the Tiny model (78 MB) baked in so
#                     captions work the moment the server starts, with or
#                     without a Groq key. Tiny is the one model a 512 MB server
#                     can run; a bigger one is downloaded from Settings onto the
#                     /data volume, so it survives a rebuild. With GROQ_API_KEY
#                     set, speech is heard in the cloud first and Tiny only
#                     covers what the cloud cannot.
#   MediaPipe   yes — bin/ai is copied, and auto-reframe runs in the BROWSER
#                     anyway, so the server never needs a GPU for it.
#   voice       yes — DeepFilterNet, the network Studio sound and Remove
#   cleaner           background noise run on, fetched for this processor and
#                     checked against a pinned SHA-256 (src/main/deepfilter.js).
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
      git build-essential cmake ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git clone --depth 1 --branch ${WHISPER_REF} https://github.com/ggerganov/whisper.cpp.git \
    && cd whisper.cpp \
    && cmake -B build -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON \
         -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF \
    && cmake --build build --config Release -j"$(nproc)" --target whisper-cli
# BUILD_SHARED_LIBS=OFF: whisper.cpp builds shared libraries by default on
# Linux, so whisper-cli wanted libwhisper.so.1 and three libggml*.so from this
# stage's build folder, which is not in the final image. Only the binary is
# copied, so it could not even start ("error while loading shared libraries").
# Static, it needs nothing but libc, libstdc++ and libgomp.
# GGML_NATIVE=OFF: -march=native would tune it to whichever CPU happened to run
# the BUILD, and a server on an older one then dies on an illegal instruction.
# Off, it targets AVX2/FMA, which every x86 cloud machine has.

# The Tiny speech model. Without a model file the engine above is just a binary:
# the studio said "The speech model is missing from this install" and no caption
# started. A short or failed transfer fails the BUILD (the checksum), so a
# truncated model that whisper would load and turn into gibberish never ships.
# The checksum is the one whisper.cpp publishes for it (models/README.md).
ARG TINY_MODEL_URL=https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin
ARG TINY_MODEL_SHA1=c78c86eb1a8faa21b369bcd33207cc90d64ae9df
RUN curl -fsSL --retry 5 --retry-delay 3 --retry-all-errors -o /src/ggml-tiny.en.bin "${TINY_MODEL_URL}" \
    && echo "${TINY_MODEL_SHA1}  /src/ggml-tiny.en.bin" | sha1sum -c -

# ── the voice cleaner ────────────────────────────────────────────────────────
# DeepFilterNet, which Studio sound and Remove background noise run on (see
# src/main/deepfilter.js for why: on a dirty church recording it scores 1.94 on
# PESQ where the old ffmpeg chain scored 1.22 — below the untouched audio). A
# single program with its model built in, for this machine's processor: x86-64
# or arm64 (Oracle's Ampere). The checksums are the ones deepfilter.js pins, so
# a short or altered download fails the BUILD rather than reaching a sermon.
FROM debian:bookworm-slim AS voice
ARG DEEPFILTER_VERSION=0.5.6
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
RUN set -e; \
    case "$(dpkg --print-architecture)" in \
      amd64) T=x86_64-unknown-linux-musl;  S=70775e251eee44c0f2451a1e833326cf8bcbbe304d3e7cd12851e6fce72ef7da ;; \
      arm64) T=aarch64-unknown-linux-gnu;  S=14e02a1c0028f3ca0bdf83b62b3336e56ba0556894ef295a95e8573f06557166 ;; \
      *) echo "no voice cleaner for $(dpkg --print-architecture)"; exit 1 ;; \
    esac; \
    curl -fsSL --retry 5 --retry-delay 3 --retry-all-errors -o /deep-filter \
      "https://github.com/Rikorose/DeepFilterNet/releases/download/v${DEEPFILTER_VERSION}/deep-filter-${DEEPFILTER_VERSION}-${T}"; \
    echo "${S}  /deep-filter" | sha256sum -c -; \
    chmod +x /deep-filter

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
# procps is pgrep, which scripts/cloud-update.sh asks before restarting: without
# it "is something exporting?" always answered no.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 ca-certificates fontconfig tini ffmpeg libgomp1 procps \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, so a code change does not re-download ffmpeg.
COPY package.json package-lock.json ./
# Electron is a devDependency and is 200 MB of desktop app this image will never
# open a window with — the shim is the whole point. --omit=dev leaves it out.
RUN npm ci --omit=dev --no-audit --no-fund
# The Viral Montage's narrator: Kokoro, a real-sounding voice run on this
# server's own CPU (src/main/voiceover.js). Server-only — the desktop app does
# not carry it — and optional: if it cannot be installed the build goes on and
# montages are made without a narrator. Its model (~90 MB) is fetched the first
# time a voice is asked for and kept in /data/kokoro. The other platforms'
# runtime binaries are dropped (they are most of its size).
RUN (npm install --no-save --omit=dev --no-audit --no-fund kokoro-js@1.2.1 \
      && rm -rf node_modules/onnxruntime-node/bin/napi-v3/darwin node_modules/onnxruntime-node/bin/napi-v3/win32) \
    || echo "kokoro-js could not be installed — the narrator will be unavailable"

# The app itself. Only what a server runs: src/, the offline AI assets, the
# caption fonts, and the licences.
COPY src/ ./src/
COPY bin/ai/ ./bin/ai/
COPY bin/fonts/ ./bin/fonts/
# The RNNoise model: the fallback voice chain. It was never copied, so on the
# server Studio sound fell all the way back to afftdn — the squeak.
COPY bin/rnnoise/ ./bin/rnnoise/
COPY legal/ ./legal/

# The voice cleaner, where src/main/deepfilter.js looks for it in this image —
# started once, so one that cannot load fails the build, not a sermon.
COPY --from=voice /deep-filter /app/bin/deepfilter/deep-filter
RUN /app/bin/deepfilter/deep-filter --version > /dev/null

# whisper.cpp, named the way src/main/captioner.js looks for it on Linux.
#
# TWO names, deliberately: the captioner tries `whisper-cli-<arch>` first and
# plain `whisper-cli` second (see cliCandidates), and the arch-suffixed one is
# what an x64 and an arm64 drop would use to sit side by side. Copying to both
# means this image works whichever rule wins.
COPY --from=whisper /src/whisper.cpp/build/bin/whisper-cli /app/bin/whisper/whisper-cli
COPY --from=whisper /src/ggml-tiny.en.bin /app/bin/whisper/ggml-tiny.en.bin
RUN chmod +x /app/bin/whisper/whisper-cli \
    && ln -sf whisper-cli "/app/bin/whisper/whisper-cli-$(node -p 'process.arch')" \
    && /app/bin/whisper/whisper-cli --help > /dev/null
# (that last line starts the engine once: an image whose engine cannot load its
# libraries fails here, at build time, not on the first caption)

# Recordings go in /media, everything the app keeps goes in /data — both are
# volumes so a rebuilt image keeps the church's library, its saved sessions and
# any bigger speech model it downloaded.
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
