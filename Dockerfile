# Builds the WASM sim and the server, then the client, and ships both in a slim image that
# serves the game on $PORT (8080): the client at / and the WebSocket at /ws.

FROM rust:1.99.1-bookworm AS rust
ARG TARGETARCH
RUN rustup target add wasm32-unknown-unknown \
 && arch=$([ "$TARGETARCH" = "arm64" ] && echo aarch64 || echo x86_64) \
 && curl -sSfL "https://github.com/rustwasm/wasm-pack/releases/download/v0.15.0/wasm-pack-v0.15.0-${arch}-unknown-linux-musl.tar.gz" \
    | tar -xz --strip-components=1 -C /usr/local/bin "wasm-pack-v0.15.0-${arch}-unknown-linux-musl/wasm-pack"
WORKDIR /src
COPY Cargo.toml Cargo.lock tuning.json classes.json weapons.json ./
COPY maps maps
COPY sim sim
COPY server server
# Bake the bots' nav fresh, whatever maps/nav.json was committed with: walking it at startup
# instead stalls the server for minutes on Fly's shared CPU (see sim/src/bot.rs).
RUN cargo test -p sim --release --lib bake_nav -- --ignored
# The release profile's opt-level "s" sizes the wasm; the server builds at 3, ~1.7x faster a tick.
RUN wasm-pack build sim --target web --release --no-pack -- --features wasm \
 && CARGO_PROFILE_RELEASE_OPT_LEVEL=3 cargo build -p server --release

FROM node:22-bookworm-slim AS web
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.js tuning.json classes.json weapons.json ./
COPY guide guide
COPY maps maps
COPY web web
COPY --from=rust /src/sim/pkg sim/pkg
RUN npx vite build

FROM debian:bookworm-slim
RUN useradd --system --no-create-home game
WORKDIR /app
COPY --from=rust /src/target/release/server ./server
COPY --from=web /src/dist ./dist
ENV PORT=8080 STATIC_DIR=/app/dist
EXPOSE 8080
USER game
CMD ["/app/server"]
