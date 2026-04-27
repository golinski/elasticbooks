# Go Backend — Developer Guide

This document explains how the Go backend works in enough detail to understand,
modify, and debug it without prior Go experience. It covers the server, the
importer, the build system, and step-by-step debugging with a debugger.

---

## Table of contents

1. [Project layout](#1-project-layout)
2. [Go basics you need to know](#2-go-basics-you-need-to-know)
3. [How the binary works — two modes](#3-how-the-binary-works--two-modes)
4. [Server — detailed walkthrough](#4-server--detailed-walkthrough)
   - [Startup and configuration](#41-startup-and-configuration)
   - [The Elasticsearch HTTP client](#42-the-elasticsearch-http-client)
   - [CORS middleware](#43-cors-middleware)
   - [Query building](#44-query-building)
   - [Route handlers](#45-route-handlers)
   - [Response serialisation](#46-response-serialisation)
5. [Importer — detailed walkthrough](#5-importer--detailed-walkthrough)
   - [XML parsing and the namespace problem](#51-xml-parsing-and-the-namespace-problem)
   - [Data conversion](#52-data-conversion)
   - [Index setup](#53-index-setup)
   - [Bulk indexing](#54-bulk-indexing)
6. [Building and running locally](#6-building-and-running-locally)
7. [Running with Docker Compose](#7-running-with-docker-compose)
8. [Debugging with a debugger](#8-debugging-with-a-debugger)
   - [VS Code + Delve (recommended)](#81-vs-code--delve-recommended)
   - [Debugging the importer](#82-debugging-the-importer)
   - [Debugging inside Docker](#83-debugging-inside-docker)
9. [Common problems and how to diagnose them](#9-common-problems-and-how-to-diagnose-them)

---

## 1. Project layout

```
backend-go/
├── main.go      # HTTP server: routes, query building, ES communication
├── import.go    # Data importer: XML parsing, index setup, bulk indexing
├── go.mod       # Module declaration (no external dependencies)
└── Dockerfile   # Two-stage build → tiny scratch image
```

Both `.go` files belong to `package main`, so they compile into a single binary.
There is no separate `import` binary — the same executable switches behaviour
based on the `IMPORT` environment variable.

---

## 2. Go basics you need to know

**Everything is compiled.** Unlike Node, there is no interpreter. You run
`go build` to produce a binary, then run that binary. `go run .` does both
steps in one command (useful during development).

**Errors are values.** Go does not throw exceptions. Every function that can
fail returns an `error` as its last return value. The caller checks it:

```go
resp, err := esRequest("GET", "/", nil)
if err != nil {
    // something went wrong — handle it here
    return err
}
// safe to use resp here
```

If you see `log.Fatal(err)` or `log.Fatalf(...)`, that means the error is
unrecoverable — it prints the message and exits with code 1.

**Pointers for nullable values.** Go has no `null` for basic types. To
represent "this field might be absent", the code uses pointer types: `*string`,
`*int`, `*float64`. A nil pointer serialises to JSON `null`. A non-nil pointer
serialises to the value it points to. That is why `bookDoc` has fields like
`Title *string` instead of `Title string`.

**`defer` runs at function exit.** You will see `defer resp.Body.Close()`
immediately after opening an HTTP response. This guarantees the body is closed
when the surrounding function returns, regardless of which return path is taken.
Forgetting `defer resp.Body.Close()` leaks a connection.

**`any` is an alias for `interface{}`.** It means "any type". The `M` type
alias (`type M = map[string]any`) is used throughout to build arbitrary JSON
objects without defining a struct for every ES query shape.

**Goroutines.** `go someFunc()` runs `someFunc` concurrently in the background.
The server uses this for `waitForES()` so the HTTP server starts immediately
while ES connectivity is checked in the background.

---

## 3. How the binary works — two modes

`main()` in `main.go` is the entry point:

```go
func main() {
    if os.Getenv("IMPORT") == "1" {
        runImport()   // defined in import.go — runs and exits
        return
    }

    go waitForES()    // background goroutine, non-blocking

    // ... start HTTP server
}
```

- **Default (no `IMPORT`):** starts the HTTP server on `$PORT` (default 3001).
- **`IMPORT=1`:** calls `runImport()`, which parses the Tellico XML file,
  creates the Elasticsearch index, bulk-indexes all books, then exits.

The two modes share the same compiled binary and the same helper functions
(`esRequest`, `esPing`, `getEnv`, etc.).

---

## 4. Server — detailed walkthrough

### 4.1 Startup and configuration

```go
var (
    port           = getEnv("PORT", "3001")
    esURL          = getEnv("ELASTICSEARCH_URL", "http://localhost:9200")
    allowedOrigins = parseOrigins(getEnv("ALLOWED_ORIGINS", ""))
)
```

These three package-level variables are initialised once when the program
starts. `getEnv` reads an environment variable and falls back to the second
argument if the variable is empty or unset.

`parseOrigins` splits a comma-separated string like
`https://mysite.com,https://other.com` into a `[]string`. If `ALLOWED_ORIGINS`
is empty, `allowedOrigins` is an empty slice, which the CORS middleware treats
as "allow all origins" (useful for local development).

`waitForES()` runs in a goroutine. It pings `GET /` on the ES URL every 3
seconds, up to 40 attempts (~2 minutes). The HTTP server starts and accepts
requests immediately — if ES is not yet ready, the first few requests will
return a 500 error, but the server does not crash or refuse to start.

### 4.2 The Elasticsearch HTTP client

There is no official ES client library. Instead, the code uses a plain
`*http.Client` with a 30-second timeout:

```go
var httpClient = &http.Client{Timeout: 30 * time.Second}
```

All ES communication goes through `esRequest`:

```go
func esRequest(method, path string, body any) (*http.Response, error)
```

- `method`: `"GET"`, `"POST"`, `"PUT"`, `"DELETE"`, `"HEAD"`
- `path`: the ES path, e.g. `"/books/_search"` — the base URL is prepended
- `body`: any Go value. If non-nil, it is JSON-marshalled and sent as the
  request body with `Content-Type: application/json`. If nil, an empty body
  is sent.

The function returns the raw `*http.Response`. **The caller is always
responsible for closing `resp.Body`** — either with `defer resp.Body.Close()`
or by reading it fully. Forgetting this leaks a TCP connection.

### 4.3 CORS middleware

`corsMiddleware` wraps the router and runs before every request:

1. Reads the `Origin` header from the request.
2. If `allowedOrigins` is empty, all origins are allowed.
3. If the origin is not in the list, responds with `403 Forbidden`.
4. For allowed origins, sets `Access-Control-Allow-Origin` and
   `Access-Control-Allow-Methods: GET`.
5. Handles `OPTIONS` preflight requests by returning `204 No Content`
   immediately (browsers send these before cross-origin requests).

### 4.4 Query building

`buildFilters(q url.Values) M` translates HTTP query parameters into an
Elasticsearch `query` object. `url.Values` is Go's type for parsed query
strings — it is a `map[string][]string` (each key can have multiple values,
which is how `author_filter=A&author_filter=B` works).

The function builds two slices:

- **`must`** — conditions that must match (full-text search, field prefix
  searches). All `must` clauses are ANDed together.
- **`filters`** — exact/range conditions applied after scoring (facet
  selections, year range). Filters do not affect relevance scores.

If both slices are empty (no search parameters), it returns
`{"match_all": {}}` which matches every document.

**Full-text search (`q` parameter):**
Uses ES `multi_match` across multiple fields with boost weights
(`title^3` means title matches count three times more than unweighted fields).
`fuzziness: AUTO` allows minor typos.

**Field prefix searches (`title`, `author`, `series`, etc.):**
Uses `match_phrase_prefix` which matches documents where the field starts with
the given phrase. `max_expansions: 50` limits how many terms ES will expand
the prefix to (a performance guard).

**Facet filters (`author_filter`, `series_filter`, etc.):**
Each filter value becomes a `prefix` query on the `.keyword` sub-field (exact,
case-sensitive). Multiple values for the same filter are combined with `should`
(OR logic) — selecting two authors shows books by either author.

`buildSort(sortBy, sortDir string) []M` returns an ES `sort` array. Each case
returns a slice of sort clauses. The `series` case returns two clauses:
series name first, then volume number — this is what makes books within a
series appear in order.

### 4.5 Route handlers

The router is set up in `newRouter()` using Go's standard `http.ServeMux`.
One subtlety: `"/api/books/"` (with trailing slash) is a prefix match in
`ServeMux` — it catches both `/api/books/` and `/api/books/123`. The handler
checks the path to decide whether to call `handleBooks` or `handleBookByID`.

**`handleBooks`** — `GET /api/books`

1. Parses `page`, `size`, `sort`, `dir` from query params with safe defaults.
2. Calls `buildFilters` and `buildSort` to construct the ES query body.
3. Sends `POST /books/_search` to ES with the query, sort, and six aggregations
   (authors, series, genres, publishers, pub_years, keywords).
4. Decodes the ES response into `esSearchResponse`.
5. For each hit, unmarshals `_source` into a `map[string]any`, injects the
   `_score` field, and re-marshals to `json.RawMessage`. This is necessary
   because `_score` lives outside `_source` in the ES response.
6. Calls `aggBuckets` to extract each aggregation's bucket list.
7. Writes the final JSON response.

**`handleBookByID`** — `GET /api/books/:id`

Strips the `/api/books/` prefix from the path to get the ID, then fetches
`GET /books/_doc/{id}` from ES. Returns the `_source` field directly.

**`handleStats`** — `GET /api/stats`

Sends a `size: 0` search (no documents, only aggregations) with four
aggregations: top 10 authors, series, genres, and a `stats` aggregation on
`pub_year` (which returns min, max, avg, count in one query).

**`handleHealth`** — `GET /api/health`

Calls `GET /_cluster/health` on ES and returns the cluster status. Useful for
checking whether ES is reachable from the backend container.

### 4.6 Response serialisation

`writeJSON` sets the `Content-Type` header, writes the HTTP status code, then
encodes the value as JSON directly to the response writer. Note that
`w.WriteHeader(status)` must be called before writing the body — once you
start writing the body, the status code is locked in.

`aggBuckets` converts ES aggregation buckets (which use `any` for the key
because pub_year buckets have integer keys while others have string keys) into
`[]facetBucket` for the response.

---

## 5. Importer — detailed walkthrough

### 5.1 XML parsing and the namespace problem

The Tellico file is an XML document with a default namespace:

```xml
<tellico xmlns="http://periapsis.org/tellico/" syntaxVersion="11">
  <collection ...>
    <entry id="1">
      <title>Droga królów</title>
      <authors>
        <author>Brandon Sanderson</author>
      </authors>
      ...
```

Go's `encoding/xml` package is strict about namespaces. When a default
namespace is declared on the root element, **every child element inherits that
namespace**. If your struct tags do not include the namespace URI, the decoder
will not match the elements and all fields will be empty.

That is why every XML struct tag in this code includes the full namespace:

```go
type tellicoEntry struct {
    Title   string `xml:"http://periapsis.org/tellico/ title"`
    Authors []string `xml:"http://periapsis.org/tellico/ authors>author"`
    // ...
}
```

The `authors>author` path syntax tells the decoder: "find `<authors>` children,
then collect all `<author>` text nodes inside them into this slice". This
handles both the single-author and multi-author cases automatically.

The `id` attribute uses `xml:"id,attr"` — the `,attr` suffix tells the decoder
to read from an XML attribute rather than a child element.

**If you add a new field from the XML and it comes back empty**, the most
likely cause is a missing or wrong namespace in the struct tag.

### 5.2 Data conversion

`parseEntry(e tellicoEntry, covers map[string]string) bookDoc` converts one
parsed XML entry into the `bookDoc` struct that gets stored in Elasticsearch.

Key conversions:

- **Nullable fields** use pointer helpers. `strPtr("")` returns `nil`;
  `strPtr("some value")` returns a pointer to that string. This ensures empty
  XML elements become JSON `null` rather than `""`.

- **Rating scaling.** Tellico stores ratings as integers multiplied by 100
  (e.g. `889` means 8.89 stars). The code divides by 10 to get `88.9`, which
  is what Elasticsearch stores. This matches the original TypeScript importer's
  behaviour (`parseFloat(rating) / 10`).

- **Cover URL lookup.** The XML stores only a filename (e.g.
  `ab5b062b572aff31c59cc0bba5384ede.jpeg`). The `covers.json` file maps these
  filenames to full Cloudinary URLs. `parseEntry` looks up the filename in the
  `covers` map and stores the URL (or `nil` if not found).

- **`filterEmpty`** removes blank strings from slices. This prevents empty
  `<author></author>` elements from appearing as `""` in the authors array.

### 5.3 Index setup

Before indexing, the importer:

1. **Checks if the index exists** with `HEAD /books`. A 200 response means it
   exists; 404 means it does not.
2. **Deletes the existing index** if present (`DELETE /books`). This is a
   full re-import — all existing data is wiped.
3. **Creates the index with a mapping** (`PUT /books` with a JSON body).

The mapping defines how each field is stored and indexed:

- `text` fields (title, authors, etc.) are analysed — tokenised, lowercased,
  and ASCII-folded (so "Ó" matches "O"). They also have a `.keyword` sub-field
  for exact sorting and faceting.
- `keyword` fields (isbn, cover, url) are stored as-is, not analysed.
- `date` fields use `yyyy-MM-dd` format.
- `number_of_replicas: 0` — no replicas needed for a single-node setup.

The `text_analyzer` uses `asciifolding` so that searching for "Sanderson"
also matches "Śanderson" (Polish diacritics are normalised).

### 5.4 Bulk indexing

ES's bulk API accepts NDJSON (Newline-Delimited JSON) — alternating lines of
action metadata and document data:

```
{"index":{"_index":"books","_id":"1"}}
{"id":1,"title":"Droga królów",...}
{"index":{"_index":"books","_id":"2"}}
{"id":2,"title":"Słowa światłości",...}
```

`esBulk` builds this format using `json.NewEncoder` writing into a
`bytes.Buffer`. Each call to `enc.Encode(v)` writes one JSON line followed by
a newline — exactly what the bulk API requires.

The request uses `Content-Type: application/x-ndjson` (not `application/json`).
Using the wrong content type causes ES to reject the request with a 400 error.

Books are sent in batches of 500. After all batches are done, `refreshIndex`
calls `POST /books/_refresh` to make the newly indexed documents immediately
searchable (ES buffers writes and flushes them periodically; refresh forces an
immediate flush).

---

## 6. Building and running locally

**Prerequisites:** Go 1.23 or later. Check with `go version`.

```bash
# Run the server (connects to ES at localhost:9200 by default)
cd backend-go
go run .

# Run with a different ES URL
ELASTICSEARCH_URL=http://myserver:9200 go run .

# Build a binary
go build -o server .
./server

# Run the importer
IMPORT=1 TELLICO_FILE=../data/collection.tc COVERS_JSON=../data/covers.json go run .
```

`go run .` compiles and runs in one step. It is slower than running a
pre-built binary but convenient during development. The `.` means "compile
all `.go` files in the current directory".

To verify the server is working:

```bash
curl http://localhost:3001/api/health
curl "http://localhost:3001/api/books?q=tolkien&size=5"
curl http://localhost:3001/api/stats
```

---

## 7. Running with Docker Compose

```bash
# Start ES + backend
docker compose up

# Start ES + backend + frontend
docker compose --profile localfe up

# Run the importer (re-indexes all data)
docker compose --profile import run --rm importer

# Rebuild the Go image after code changes
docker compose build backend
docker compose up backend
```

The Dockerfile uses a two-stage build:

1. **Builder stage** (`golang:1.23-alpine`): compiles the binary with
   `CGO_ENABLED=0` (no C dependencies) and `-ldflags="-s -w"` (strips debug
   symbols to reduce binary size).
2. **Final stage** (`scratch`): an empty image containing only the binary and
   CA certificates. The result is ~8 MB vs ~180 MB for a Node image.

Because the final image is `scratch` (no shell, no utilities), you cannot
`docker exec` into it. For debugging inside Docker, see
[section 8.3](#83-debugging-inside-docker).

---

## 8. Debugging with a debugger

Go's debugger is **Delve** (`dlv`). It understands goroutines, can inspect
Go-specific data structures, and integrates with VS Code.

### 8.1 VS Code + Delve (recommended)

**Install the Go extension and Delve:**

1. Install the [Go extension for VS Code](https://marketplace.visualstudio.com/items?itemName=golang.go).
2. Open the Command Palette (`Ctrl+Shift+P`) → `Go: Install/Update Tools` →
   select `dlv` → click OK.

**Create a launch configuration.** Add this to `.vscode/launch.json`
(create the file if it does not exist):

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Go: Run server",
      "type": "go",
      "request": "launch",
      "mode": "auto",
      "program": "${workspaceFolder}/backend-go",
      "env": {
        "PORT": "3001",
        "ELASTICSEARCH_URL": "http://localhost:9200"
      },
      "args": []
    },
    {
      "name": "Go: Run importer",
      "type": "go",
      "request": "launch",
      "mode": "auto",
      "program": "${workspaceFolder}/backend-go",
      "env": {
        "IMPORT": "1",
        "ELASTICSEARCH_URL": "http://localhost:9200",
        "TELLICO_FILE": "${workspaceFolder}/data/collection.tc",
        "COVERS_JSON": "${workspaceFolder}/data/covers.json"
      },
      "args": []
    }
  ]
}
```

**To debug:**

1. Open `main.go` or `import.go`.
2. Click in the gutter (left of the line numbers) to set a breakpoint — a red
   dot appears.
3. Press `F5` or go to Run → Start Debugging, and select the configuration.
4. The program pauses at your breakpoint. Use:
   - `F10` — step over (execute current line, stay in same function)
   - `F11` — step into (follow a function call)
   - `Shift+F11` — step out (run until current function returns)
   - `F5` — continue to next breakpoint
5. The **Variables** panel shows all local variables and their current values.
   Pointer variables show the address; hover over them to see the pointed-to
   value, or expand them in the panel.
6. The **Debug Console** accepts Delve expressions — type a variable name to
   inspect it, or call `len(someSlice)` etc.

**Useful breakpoint locations:**

| Where to break | What you can inspect |
|---|---|
| Start of `buildFilters` | The raw `url.Values` map — see exactly what query params arrived |
| After `esRequest` in `handleBooks` | The raw ES response before decoding |
| Start of `parseEntry` | The raw `tellicoEntry` struct from XML |
| Inside `esBulk` | The NDJSON buffer before it is sent |

### 8.2 Debugging the importer

The importer is a short-lived process, so breakpoints work well. Set a
breakpoint in `parseEntry` to inspect how a specific book is being converted,
or in `runImport` after `xml.Unmarshal` to check how many entries were parsed:

```go
entries := doc.Collection.Entries
log.Printf("Found %d entries", len(entries))  // <-- break here
```

In the Variables panel, expand `entries[0]` to see the first parsed entry and
verify the XML fields were decoded correctly. If a field is empty when it
should not be, the XML namespace tag is likely wrong.

**Checking the raw ES bulk request:**

Set a breakpoint just before `httpClient.Do(req)` in `esBulk`. In the Debug
Console, type:

```
buf.String()
```

This prints the full NDJSON payload that is about to be sent to ES. You can
copy it and test it manually:

```bash
curl -X POST http://localhost:9200/_bulk \
  -H 'Content-Type: application/x-ndjson' \
  --data-binary @/tmp/bulk_payload.ndjson
```

### 8.3 Debugging inside Docker

The production image is `scratch` and cannot be debugged directly. For
debugging in a Docker environment, temporarily switch to a debug-friendly image
by editing the Dockerfile's final stage:

```dockerfile
# Replace this:
FROM scratch

# With this (temporarily):
FROM alpine:3.20
RUN apk add --no-cache curl
```

Then rebuild and exec into the container:

```bash
docker compose build backend
docker compose up -d backend
docker compose exec backend sh
```

For remote Delve debugging inside Docker, add a debug build target to the
Dockerfile and expose port 2345:

```dockerfile
FROM golang:1.23-alpine AS debugger
WORKDIR /app
COPY go.mod .
RUN go mod download
# Install delve
RUN go install github.com/go-delve/delve/cmd/dlv@latest
COPY . .
# Build with debug info (no -ldflags stripping)
RUN CGO_ENABLED=0 go build -gcflags="all=-N -l" -o server .
EXPOSE 3001 2345
ENTRYPOINT ["dlv", "exec", "./server", "--headless", "--listen=:2345", \
            "--api-version=2", "--accept-multiclient", "--"]
```

Add to `docker-compose.yml` temporarily:

```yaml
backend:
  build:
    context: ./backend-go
    target: debugger
  ports:
    - "3001:3001"
    - "2345:2345"   # Delve remote port
```

Then add a remote attach configuration to `.vscode/launch.json`:

```json
{
  "name": "Go: Attach to Docker",
  "type": "go",
  "request": "attach",
  "mode": "remote",
  "remotePath": "/app",
  "port": 2345,
  "host": "127.0.0.1"
}
```

Start the container, then press F5 with the "Attach to Docker" configuration
selected. VS Code connects to Delve running inside the container and you can
set breakpoints normally.

---

## 9. Common problems and how to diagnose them

**Server returns 500 on every request**

ES is not ready yet. Check the logs:

```bash
docker compose logs backend
```

You should see `Waiting for Elasticsearch… (1/40)` lines followed eventually
by `Elasticsearch ready`. If it never becomes ready, check ES:

```bash
docker compose logs elasticsearch
curl http://localhost:9200/
```

**Import exits with "elasticsearch not reachable"**

The importer waits up to 30 × 2s = 60 seconds. If ES takes longer, increase
`maxAttempts` in `waitForESImport()` in `import.go`.

**Import exits with "parsing XML: ..."**

The Tellico file is malformed or has an unexpected structure. Run the importer
locally with `go run .` and check the full error message. Common causes:
encoding issues (the file must be UTF-8) or a different Tellico schema version.

**All books have empty authors/genres/keywords after import**

The XML namespace tags are wrong. Verify the namespace URI in the Tellico file:

```bash
head -3 data/collection.tc
```

The `xmlns=` value must match the namespace prefix in every struct tag in
`import.go`. If the Tellico version changes the namespace, update all
`xml:"http://periapsis.org/tellico/ ..."` tags.

**Sorting by series does not order books by volume**

`buildSort` for `"series"` returns two clauses: series name, then volume.
If volumes appear out of order, check that the `volume` field in ES is stored
as `float` (not `keyword`). You can verify with:

```bash
curl http://localhost:9200/books/_mapping | python3 -m json.tool | grep -A2 volume
```

**CORS errors in the browser**

The `Origin` header sent by the browser is not in `ALLOWED_ORIGINS`. Either
add the origin to the environment variable, or leave `ALLOWED_ORIGINS` empty
to allow all origins. Check what origin the browser is sending:

```bash
curl -v -H "Origin: https://yoursite.com" http://localhost:3001/api/books 2>&1 | grep -i "access-control"
```

**`go build` fails with "undefined: fmt"**

`fmt` is imported in `import.go` but not in `main.go`. If you move code
between files, make sure each file only imports what it uses. Run
`go build ./...` from the `backend-go` directory — the compiler will tell you
exactly which file has the problem.

**Binary is too large / want to inspect what is in it**

```bash
go build -o server .
ls -lh server          # check size
go tool nm server | head -50   # list symbols
```

The `-ldflags="-s -w"` flags in the Dockerfile strip the symbol table and
DWARF debug info, reducing size by ~30%. Remove those flags if you need a
debuggable binary.
