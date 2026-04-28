# ── Stage 1: build ────────────────────────────────────────────────────────────
# Use the official Rust image. We pin to a specific minor version for
# reproducibility; bump this line to upgrade.
FROM rust:1.95-slim AS builder

WORKDIR /app

# Install musl toolchain for a fully static binary (no libc dependency).
# This lets us use a scratch final image.
RUN rustup target add x86_64-unknown-linux-musl \
 && apt-get update -qq \
 && apt-get install -y --no-install-recommends musl-tools \
 && rm -rf /var/lib/apt/lists/*

# Copy manifests first and build a dummy main so that dependency compilation
# is cached in a Docker layer. Rebuilding after source-only changes skips this
# expensive step.
COPY Cargo.toml Cargo.lock* ./
RUN mkdir src \
 && echo 'fn main(){}' > src/main.rs \
 && cargo build --release --target x86_64-unknown-linux-musl \
 && rm -rf src

# Now copy the real source and build the final binary.
# Only this layer is invalidated when source files change.
COPY src ./src
RUN touch src/main.rs \
 && cargo build --release --target x86_64-unknown-linux-musl

# ── Stage 2: minimal runtime image ────────────────────────────────────────────
# scratch has no shell, no libc, no utilities — just the binary.
# Final image size: ~8 MB.
FROM scratch

# CA certificates are needed for HTTPS connections to Elasticsearch.
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/

COPY --from=builder /app/target/x86_64-unknown-linux-musl/release/bookshelf /bookshelf

EXPOSE 3001
ENTRYPOINT ["/bookshelf"]
