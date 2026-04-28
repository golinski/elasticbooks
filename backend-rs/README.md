# Rust Backend — Developer Guide

This document explains how the Rust backend works in enough detail to
understand, modify, and debug it without prior Rust experience. It covers
every source file, the key Rust concepts you will encounter, and step-by-step
debugging with a debugger.

---

## Table of contents

1. [Project layout](#1-project-layout)
2. [Rust concepts you need to know](#2-rust-concepts-you-need-to-know)
3. [How the binary works — two modes](#3-how-the-binary-works--two-modes)
4. [Module walkthrough](#4-module-walkthrough)
   - [config.rs — environment variables](#41-configrs--environment-variables)
   - [es.rs — Elasticsearch HTTP client](#42-esrs--elasticsearch-http-client)
   - [query.rs — ES query and sort builders](#43-queryrs--es-query-and-sort-builders)
   - [handlers.rs — HTTP route handlers](#44-handlersrs--http-route-handlers)
   - [importer.rs — data importer](#45-importerrs--data-importer)
   - [main.rs — wiring it all together](#46-mainrs--wiring-it-all-together)
5. [Building and running locally](#5-building-and-running-locally)
6. [Running with Docker Compose](#6-running-with-docker-compose)
7. [Debugging with a debugger](#7-debugging-with-a-debugger)
   - [VS Code + CodeLLDB (recommended)](#71-vs-code--codelldb-recommended)
   - [Debugging the importer](#72-debugging-the-importer)
   - [Debugging inside Docker](#73-debugging-inside-docker)
   - [Logging as a debugging tool](#74-logging-as-a-debugging-tool)
8. [Common problems and how to diagnose them](#8-common-problems-and-how-to-diagnose-them)

---

## 1. Project layout

```
backend-rs/
├── Cargo.toml        # Package manifest: dependencies, build profiles
├── Cargo.lock        # Exact dependency versions (generated, commit this)
├── Dockerfile        # Two-stage build → ~8 MB scratch image
└── src/
    ├── main.rs       # Entry point: mode dispatch, server setup, CORS, routing
    ├── config.rs     # Config struct read from environment variables
    ├── es.rs         # Thin Elasticsearch HTTP client (reqwest wrapper)
    ├── query.rs      # ES query DSL builder (filters, sort)
    ├── handlers.rs   # Axum route handlers (health, books, stats)
    └── importer.rs   # Data importer: XML parsing + bulk indexing
```

Each `.rs` file is a **module**. Modules are declared in `main.rs` with
`mod config;` etc. — Rust then looks for `src/config.rs` automatically.

---

## 2. Rust concepts you need to know

**Ownership and borrowing.** Rust's central rule: every value has exactly one
owner. When the owner goes out of scope, the value is freed. You can lend a
value temporarily with a reference (`&T` for read-only, `&mut T` for
read-write). The compiler enforces that references never outlive the value they
point to. This is why you see `&str` (borrowed string slice) vs `String`
(owned string) throughout the code.

**`Option<T>` instead of null.** There is no null in Rust. A value that might
be absent is `Option<T>`, which is either `Some(value)` or `None`. It
serialises to JSON `null` when `None` and to the value when `Some`. This is
used for all nullable book fields (`title: Option<String>`, etc.).

**`Result<T, E>` instead of exceptions.** Functions that can fail return
`Result<T, E>` — either `Ok(value)` or `Err(error)`. The `?` operator is
shorthand for "if this is an `Err`, return it from the current function". You
will see `?` after almost every fallible call:

```rust
let resp = client.get(url).send().await?;  // returns early on error
```

**`async`/`await`.** Rust's async model is explicit. An `async fn` returns a
`Future` — a value representing a computation that hasn't run yet. Calling
`.await` on a future runs it. The `tokio` runtime drives all futures
concurrently on a thread pool. This is why `main` is annotated
`#[tokio::main]` — it sets up the runtime.

**`Arc` and `Clone`.** `Arc<T>` is a reference-counted pointer that can be
shared across threads. `reqwest::Client` and `axum`'s `State` both use `Arc`
internally, which is why they are cheap to `.clone()` — cloning just
increments a counter, not the underlying data.

**Traits.** A trait is like an interface. `IntoResponse` is a trait that axum
uses to convert handler return values into HTTP responses. `Serialize` and
`Deserialize` are traits from `serde` that enable JSON/XML conversion.
`#[derive(Serialize)]` on a struct auto-generates the implementation.

**`serde_json::json!` macro.** This macro lets you write JSON literals inline:

```rust
let body = json!({ "query": { "match_all": {} } });
```

The result is a `serde_json::Value` — a dynamically typed JSON value, similar
to Go's `map[string]any`. It is used throughout for ES query building because
the ES DSL is too dynamic to model with static types.

---

## 3. How the binary works — two modes

`main()` in `main.rs` checks the `IMPORT` environment variable:

```rust
if std::env::var("IMPORT").as_deref() == Ok("1") {
    importer::run_import(&config).await?;
    return;
}
// ... otherwise start the HTTP server
```

- **Default:** starts the axum HTTP server on `$PORT` (default 3001).
- **`IMPORT=1`:** calls `run_import`, which parses the Tellico XML, creates
  the ES index, bulk-indexes all books, then exits.

Both modes share the same compiled binary and the same `Config`, `es.rs`
helpers, and `AppState`.

---

## 4. Module walkthrough

### 4.1 `config.rs` — environment variables

`Config::from_env()` reads all configuration at startup into a plain struct:

```rust
pub struct Config {
    pub port: u16,
    pub es_url: String,
    pub allowed_origins: Vec<String>,
    pub tellico_file: String,
    pub covers_json: String,
}
```

`env_var(key, default)` reads an env var and falls back to the default if
unset or empty. `parse_origins` splits `ALLOWED_ORIGINS` on commas and strips
whitespace.

`Config` derives `Clone` so it can be stored in `AppState` and cloned cheaply
when axum distributes it to handler tasks.

### 4.2 `es.rs` — Elasticsearch HTTP client

There is no official ES Rust client. All ES communication uses `reqwest`, a
popular async HTTP client. The module exposes three functions:

**`build_http_client()`** — creates a `reqwest::Client` with a 30-second
timeout. This is called once at startup. `Client` is cheap to clone (it holds
an `Arc` to a connection pool) so it is stored in `AppState` and cloned into
each handler.

**`es_json(client, method, url, body)`** — sends a JSON request and returns
`(status_code, parsed_json_body)`. Used for all ES calls except bulk indexing.
If `body` is `Some(value)`, it is serialised to JSON and sent with
`Content-Type: application/json`. If `None`, no body is sent.

**`es_raw(client, method, url, content_type, bytes)`** — sends a raw byte
body. Used for bulk indexing, which requires `Content-Type: application/x-ndjson`
and a hand-built NDJSON payload (not a JSON object).

**`wait_for_es_server`** — runs in a background `tokio::spawn` task. Pings
`GET /` on ES every 3 seconds, up to 40 attempts. Non-fatal: logs a warning
if ES never becomes ready. The HTTP server starts immediately regardless.

**`wait_for_es_import`** — same logic but fatal: returns `Err` after 30
attempts so the importer exits with an error rather than silently doing nothing.

### 4.3 `query.rs` — ES query and sort builders

**`parse_multi(raw_query)`** — parses the raw query string (e.g.
`"q=tolkien&author_filter=A&author_filter=B"`) into a
`HashMap<String, Vec<String>>`. Axum's built-in `Query<HashMap<String,String>>`
extractor only keeps the last value for repeated keys, which would break
multi-select facet filters. This function handles repeated keys correctly.
It also percent-decodes values (`%20` → space, `+` → space).

**`get_one(params, key)`** — returns the first value for a key, or `""` if
absent. Used for single-value params like `q`, `sort`, `page`.

**`build_filters(params)`** — translates HTTP params into an ES `query` object.
Returns `serde_json::Value`. The logic is identical to the Go version:

- `q` → `multi_match` with field boosts and fuzzy matching
- `title`, `author`, etc. → `match_phrase_prefix` on the respective field
- `author_filter`, `series_filter`, etc. → `prefix` on `.keyword` sub-fields,
  combined with `should` (OR) when multiple values are selected
- `year_from`/`year_to` → `range` on `pub_year`
- No params → `match_all`

**`build_sort(sort_by, sort_dir)`** — returns an ES `sort` array. The `series`
case returns two clauses (series name, then volume) so books within a series
appear in order.

### 4.4 `handlers.rs` — HTTP route handlers

**`AppError`** — a wrapper type that implements axum's `IntoResponse` trait.
Any error that implements `Into<anyhow::Error>` (which covers almost all error
types) can be converted to `AppError` via the `From` impl. This means handlers
can use `?` freely and any error becomes a JSON 500 response:

```rust
pub async fn handle_books(
    State(state): State<AppState>,
    RawQuery(raw_query): RawQuery,
) -> Result<impl IntoResponse> {
    // `?` here converts any error into AppError → JSON 500
    let (_, es_resp) = es_json(&state.client, ...).await?;
    ...
}
```

**`handle_health`** — calls `GET /_cluster/health` on ES and returns the
cluster status. Returns 503 if ES is unreachable.

**`handle_books`** — the main search handler. Parses all query params, builds
the ES query and aggregations body, sends `POST /books/_search`, then:
1. Extracts `hits.total.value` for the total count.
2. For each hit, takes `_source` and injects `_score` into it. This is
   necessary because `_score` lives outside `_source` in the ES response.
3. Extracts each aggregation's `buckets` array via `agg_buckets`.
4. Returns the assembled JSON response.

**`handle_book_by_id`** — fetches `GET /books/_doc/{id}` and returns
`_source` directly. Returns 404 if ES returns 404.

**`handle_stats`** — sends a `size: 0` search (no documents, only
aggregations) with four aggregations: top authors, series, genres, and a
`stats` aggregation on `pub_year` (returns min/max/avg/count in one query).

**`agg_buckets`** — helper that navigates `aggs["name"]["buckets"]` and
returns a reference to the array, or `Value::Null` if missing.

### 4.5 `importer.rs` — data importer

**XML deserialization with `quick-xml`.** The `quick-xml` crate with the
`serialize` feature uses `serde::Deserialize` to map XML to structs. The
`#[serde(rename = "...")]` attribute maps XML element names to Rust field
names. Attributes use `@` prefix: `#[serde(rename = "@id")]` maps the XML
attribute `id="1"` to the `id` field.

The Tellico XML has a default namespace (`xmlns="http://periapsis.org/tellico/"`).
Unlike Go's `encoding/xml`, `quick-xml` strips namespace prefixes during
deserialization, so field names do **not** need to include the namespace URI.

Nested list elements like `<authors><author>X</author></authors>` require a
wrapper struct:

```rust
#[derive(Deserialize, Default)]
struct AuthorList {
    #[serde(rename = "author", default)]
    items: Vec<String>,
}
```

The outer `<authors>` element maps to `AuthorList`, and the repeated `<author>`
children map to `items`. The `#[serde(default)]` attribute means the field
defaults to an empty list if the element is absent.

**`BookDoc`** — the struct that gets serialised to JSON and sent to ES.
`Option<String>` fields serialise to `null` when `None`. `#[serde(rename)]`
maps Rust snake_case names to the camelCase names ES expects
(`title_orig` → `"titleOrig"`).

**Parsing helpers** — `opt_str`, `opt_f64`, `opt_i64` convert empty strings
to `None`. `filter_empty` removes blank strings from `Vec<String>`.
`parse_date` formats the Tellico date struct (`year`/`month`/`day` fields)
into `"yyyy-MM-dd"` strings, zero-padding single-digit months and days.

**Rating scaling** — Tellico stores ratings as integers × 100 (e.g. `889`
means 8.89 stars). The importer divides by 10 to get `88.9`, matching the
original TypeScript importer.

**`bulk_index`** — builds an NDJSON payload by writing alternating action and
document lines into a `Vec<u8>` buffer, then sends it to `POST /_bulk` with
`Content-Type: application/x-ndjson`. After sending, it checks the `errors`
field in the response and logs the first three error reasons if any failed.

**`run_import`** — the top-level import function:
1. Waits for ES to be ready.
2. Deletes the existing index if present (full re-import).
3. Creates the index with the mapping.
4. Loads `covers.json` into a `HashMap<String, String>`.
5. Reads and parses the Tellico XML file.
6. Iterates over entries in batches of 500, calling `bulk_index` for each.
7. Calls `POST /books/_refresh` to make documents immediately searchable.

### 4.6 `main.rs` — wiring it all together

**`AppState`** — the shared state struct injected into every handler:

```rust
#[derive(Clone)]
pub struct AppState {
    pub config: Config,
    pub client: reqwest::Client,
}
```

Axum clones `AppState` for each request. Because `Config` is a plain struct
and `reqwest::Client` holds an `Arc`, cloning is cheap.

**CORS layer** — built with `tower-http`'s `CorsLayer`. If `allowed_origins`
is empty, `CorsLayer::permissive()` allows all origins. Otherwise, only the
listed origins are allowed with `GET` method.

**Router** — four routes registered with `axum::Router`:

```
GET /api/health     → handle_health
GET /api/books      → handle_books
GET /api/books/:id  → handle_book_by_id
GET /api/stats      → handle_stats
```

The CORS layer wraps the entire router via `.layer(cors)`.

**`#[tokio::main]`** — this macro transforms `async fn main()` into a
synchronous `fn main()` that sets up the tokio runtime and runs the async
function inside it. Without this, you cannot use `.await` in `main`.

---

## 5. Building and running locally

**Prerequisites:** Rust 1.78 or later. Install from [rustup.rs](https://rustup.rs).
Check with `rustc --version`.

```bash
cd backend-rs

# Run the server (connects to ES at localhost:9200 by default)
cargo run

# Run with a different ES URL
ELASTICSEARCH_URL=http://myserver:9200 cargo run

# Build an optimised release binary
cargo build --release
./target/release/bookshelf

# Run the importer
IMPORT=1 TELLICO_FILE=../data/collection.tc COVERS_JSON=../data/covers.json cargo run

# Check for compile errors without building a binary (faster)
cargo check
```

`cargo run` compiles in debug mode (fast compile, slow binary, full debug
info). `cargo build --release` compiles with full optimisations (slow compile,
fast binary, stripped debug info). Use `cargo run` during development.

To verify the server is working:

```bash
curl http://localhost:3001/api/health
curl "http://localhost:3001/api/books?q=tolkien&size=5"
curl http://localhost:3001/api/stats
```

**Controlling log output:**

```bash
# Default: info level
cargo run

# Verbose: show debug messages including ES query bodies
RUST_LOG=debug cargo run

# Quiet: only errors
RUST_LOG=error cargo run

# Per-module: debug for handlers only
RUST_LOG=bookshelf::handlers=debug cargo run
```

---

## 6. Running with Docker Compose

```bash
# Start ES + backend
docker compose up

# Start ES + backend + frontend
docker compose --profile localfe up

# Run the importer (re-indexes all data)
docker compose --profile import run --rm importer

# Rebuild the Rust image after code changes
docker compose build backend
docker compose up backend
```

**First build is slow** (~5–10 minutes) because Cargo compiles all
dependencies. Subsequent builds that only change source files are fast (~30
seconds) because the dependency layer is cached in Docker.

The Dockerfile uses a two-stage build:

1. **Builder stage** (`rust:1.78-slim`): compiles a fully static binary
   targeting `x86_64-unknown-linux-musl` (musl libc, no dynamic linking).
   The dependency compilation is cached in a separate layer using a dummy
   `main.rs` trick — only invalidated when `Cargo.toml` changes.
2. **Final stage** (`scratch`): empty image containing only the binary and
   CA certificates. Result: ~8 MB image.

Because the final image is `scratch` (no shell), you cannot `docker exec`
into it. See [section 7.3](#73-debugging-inside-docker) for how to debug
inside Docker.

---

## 7. Debugging with a debugger

Rust's debugger is **LLDB** (via the `CodeLLDB` VS Code extension) or **GDB**.
Both understand Rust's data structures, including `Option`, `Vec`, `HashMap`,
and `String`.

### 7.1 VS Code + CodeLLDB (recommended)

**Install the extension:**

1. Open the Extensions panel (`Ctrl+Shift+X`).
2. Search for `CodeLLDB` (publisher: Vadim Chugunov) and install it.
3. Also install the `rust-analyzer` extension for code navigation and
   inline type hints.

**Create a launch configuration.** Add this to `.vscode/launch.json`
(create the file if it does not exist):

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Rust: Run server",
      "type": "lldb",
      "request": "launch",
      "program": "${workspaceFolder}/backend-rs/target/debug/bookshelf",
      "args": [],
      "cwd": "${workspaceFolder}/backend-rs",
      "env": {
        "PORT": "3001",
        "ELASTICSEARCH_URL": "http://localhost:9200",
        "RUST_LOG": "debug"
      },
      "preLaunchTask": "cargo build (debug)"
    },
    {
      "name": "Rust: Run importer",
      "type": "lldb",
      "request": "launch",
      "program": "${workspaceFolder}/backend-rs/target/debug/bookshelf",
      "args": [],
      "cwd": "${workspaceFolder}/backend-rs",
      "env": {
        "IMPORT": "1",
        "ELASTICSEARCH_URL": "http://localhost:9200",
        "TELLICO_FILE": "${workspaceFolder}/data/collection.tc",
        "COVERS_JSON": "${workspaceFolder}/data/covers.json",
        "RUST_LOG": "debug"
      },
      "preLaunchTask": "cargo build (debug)"
    }
  ]
}
```

Add this to `.vscode/tasks.json` (create if needed) to auto-build before
launching:

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "cargo build (debug)",
      "type": "shell",
      "command": "cargo build",
      "options": { "cwd": "${workspaceFolder}/backend-rs" },
      "group": "build",
      "presentation": { "reveal": "silent" },
      "problemMatcher": "$rustc"
    }
  ]
}
```

**To debug:**

1. Open any `.rs` file in `backend-rs/src/`.
2. Click in the gutter to set a breakpoint — a red dot appears.
3. Press `F5` or go to Run → Start Debugging, select the configuration.
4. The program pauses at your breakpoint. Use:
   - `F10` — step over
   - `F11` — step into
   - `Shift+F11` — step out
   - `F5` — continue to next breakpoint
5. The **Variables** panel shows all locals. `Option<String>` shows as
   `Some("value")` or `None`. `Vec<T>` shows its length and elements.
   `HashMap` shows key-value pairs.
6. The **Debug Console** accepts LLDB expressions. Type a variable name to
   inspect it.

**Useful breakpoint locations:**

| Where to break | What you can inspect |
|---|---|
| Start of `build_filters` in `query.rs` | The `params` HashMap — see exactly what arrived |
| After `es_json` call in `handle_books` | The raw `es_resp` Value before processing |
| Start of `parse_entry_ref` in `importer.rs` | The raw `TellicoEntry` from XML |
| Inside `bulk_index` before `es_raw` | The NDJSON `buf` bytes |

**Inspecting `serde_json::Value` in the debugger:**

`Value` is an enum with variants `Null`, `Bool`, `Number`, `String`, `Array`,
`Object`. In the Variables panel, expand it to see which variant it is and
its contents. For a quick string representation, use the Debug Console:

```
// In the LLDB debug console:
po es_resp   // prints the Debug representation
```

### 7.2 Debugging the importer

The importer is a short-lived process — ideal for breakpoints. Set a
breakpoint in `run_import` after `quick_xml::de::from_str` to inspect the
parsed entries:

```rust
let entries = doc.collection.entries;
info!("Found {} entries", entries.len());  // <-- break here
```

In the Variables panel, expand `entries[0]` to see the first parsed entry.
If a field is empty when it should not be, the `#[serde(rename)]` attribute
on the struct field is likely wrong — compare it against the actual XML
element name.

**Printing the NDJSON bulk payload:**

Set a breakpoint just before `es_raw` in `bulk_index`. In the Debug Console:

```
// Print the first 500 bytes of the buffer as a string
expr String::from_utf8_lossy(&buf[..500.min(buf.len())])
```

You can copy the output and test it manually:

```bash
curl -X POST http://localhost:9200/_bulk \
  -H 'Content-Type: application/x-ndjson' \
  --data-binary @/tmp/payload.ndjson
```

### 7.3 Debugging inside Docker

The production image is `scratch` and cannot be debugged directly. For
debugging in Docker, temporarily change the final stage to `debian:slim`:

```dockerfile
# Replace:
FROM scratch
# With:
FROM debian:12-slim
RUN apt-get update -qq && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
```

Then rebuild and exec in:

```bash
docker compose build backend
docker compose up -d backend
docker compose exec backend bash
```

For remote LLDB debugging, add a debug target to the Dockerfile:

```dockerfile
FROM rust:1.78-slim AS debugger
WORKDIR /app
RUN apt-get update -qq && apt-get install -y --no-install-recommends lldb && rm -rf /var/lib/apt/lists/*
COPY Cargo.toml Cargo.lock* ./
RUN mkdir src && echo 'fn main(){}' > src/main.rs && cargo build && rm -rf src
COPY src ./src
RUN touch src/main.rs && cargo build   # debug build, no --release
EXPOSE 3001
# lldb-server listens on port 1234 for remote connections
CMD ["lldb-server", "platform", "--listen", "*:1234", "--server"]
```

Add to `docker-compose.yml` temporarily:

```yaml
backend:
  build:
    context: ./backend-rs
    target: debugger
  ports:
    - "3001:3001"
    - "1234:1234"
```

Then connect from VS Code with:

```json
{
  "name": "Rust: Attach to Docker",
  "type": "lldb",
  "request": "attach",
  "pid": "${command:pickProcess}",
  "initCommands": [
    "platform select remote-linux",
    "platform connect connect://localhost:1234"
  ]
}
```

### 7.4 Logging as a debugging tool

For many problems, adding a `tracing::debug!` call is faster than setting up
a debugger. The `tracing` crate is already wired up:

```rust
use tracing::debug;

// In any async function:
debug!(?params, "incoming request params");
debug!(total = es_resp["hits"]["total"]["value"].as_i64(), "ES response");
```

The `?` sigil uses the `Debug` formatter. Run with `RUST_LOG=debug` to see
these messages. They are suppressed in production (`RUST_LOG=info`).

To see the exact JSON being sent to ES, add a debug log in `es_json`:

```rust
if let Some(b) = body {
    debug!(body = %serde_json::to_string(b).unwrap_or_default(), "ES request");
    req = req.json(b);
}
```

---

## 8. Common problems and how to diagnose them

**`cargo build` fails with "error[E0432]: unresolved import"**

A module is using something from another module without importing it. Check
the `use` statements at the top of the failing file. The compiler error
message includes the exact path needed.

**`cargo build` fails with "error[E0277]: the trait bound ... is not satisfied"**

A type doesn't implement a required trait. Common causes:
- Forgetting `#[derive(Clone)]` on a struct used in `AppState`
- Forgetting `#[derive(Serialize)]` on a struct passed to `serde_json::to_writer`
- Forgetting `#[derive(Deserialize)]` on a struct used with `quick_xml::de::from_str`

**Server returns 500 on every request**

ES is not ready. Check logs:

```bash
docker compose logs backend
```

You should see `Waiting for Elasticsearch…` lines followed by
`Elasticsearch ready`. If it never becomes ready:

```bash
docker compose logs elasticsearch
curl http://localhost:9200/
```

**Import exits with "Elasticsearch not reachable after 30 attempts"**

Increase `MAX` in `wait_for_es_import` in `es.rs`, or check that the
`ELASTICSEARCH_URL` env var is correct.

**Import exits with "parsing Tellico XML: ..."**

The XML is malformed or the struct definitions don't match the actual XML
structure. Run locally with `RUST_LOG=debug` to see more detail. Common
causes:
- The `#[serde(rename)]` attribute doesn't match the XML element name
  (case-sensitive)
- A field is missing `#[serde(default)]` and the element is absent in some
  entries, causing a deserialization error
- The file is not valid UTF-8 (Tellico files should be UTF-8 but check with
  `file data/collection.tc`)

**All books have empty authors/genres/keywords after import**

The wrapper struct (`AuthorList`, `GenreList`, etc.) field name doesn't match
the XML child element name. Check the `#[serde(rename = "...")]` attribute
against the actual XML. For example, if the XML has `<author>` but the struct
has `#[serde(rename = "Author")]`, it won't match (case-sensitive).

**CORS errors in the browser**

The `Origin` header sent by the browser is not in `ALLOWED_ORIGINS`. Either
add the origin to the env var, or leave it empty to allow all. Verify:

```bash
curl -v -H "Origin: https://yoursite.com" http://localhost:3001/api/books 2>&1 | grep -i "access-control"
```

**Binary is large / want to check what's in it**

```bash
cargo build --release
ls -lh target/release/bookshelf
# List symbols (requires binutils)
nm target/release/bookshelf | head -30
```

The `[profile.release]` section in `Cargo.toml` sets `strip = true` (removes
debug symbols), `lto = true` (link-time optimisation), and `codegen-units = 1`
(single codegen unit for maximum optimisation). Remove `strip = true` if you
need a debuggable release binary.

**Compile times are slow**

First build always compiles all dependencies (~5 minutes). Subsequent builds
only recompile changed files. To speed up incremental builds, install
`mold` (a fast linker):

```bash
# Linux
sudo apt install mold
# Add to backend-rs/.cargo/config.toml:
[target.x86_64-unknown-linux-gnu]
linker = "clang"
rustflags = ["-C", "link-arg=-fuse-ld=mold"]
```
