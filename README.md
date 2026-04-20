# 📚 Bookshelf

A full-stack ebook collection viewer built on Elasticsearch + React, designed for Tellico collections with tens of thousands of items.

## Features

- **Fast full-text search** across title, author, series, description, genre, keywords
- **Field-specific search** — search only in title, author, series, genre, publisher
- **Faceted filtering** — drill down by author, series, genre, publisher with counts
- **Year range filter**
- **Sorting** — title, author, year, series (with volume order), rating, date added — ascending & descending
- **Book grid** with cover images, volume badges, ratings
- **Modal** with full book details — click author/series to filter
- **Lightbox** — click cover in modal for full-resolution zoom
- **URL state** — all filters, search, sort, page persisted in query params; shareable & browser-history-aware
- **Stats panel** — top 10 authors, series, genres with counts
- **Pagination** with configurable page size (20/40/80/120)

## Structure

```
bookshelf/
├── docker-compose.yml
├── data/               ← put your files here
│   ├── collection.tc   ← your Tellico XML file
│   └── covers.json     ← cloudinary mapping (filename → URL)
├── backend/
│   ├── Dockerfile
│   ├── package.json
│   ├── server.js       ← Express API
│   └── import.js       ← Tellico → Elasticsearch importer
└── frontend/
    ├── Dockerfile
    ├── nginx.conf
    └── src/
        ├── App.jsx
        └── ...
```

## Quick Start

### 1. Place your data files

```bash
mkdir -p data
cp /path/to/your/collection.tc data/collection.tc
cp /path/to/covers.json data/covers.json
```

### 2. Start the stack

```bash
docker compose up -d
```

This starts Elasticsearch, the backend API, and the frontend. Wait ~30 seconds for Elasticsearch to be healthy.

### 3. Import your collection

```bash
docker compose run --rm importer
```

This parses the Tellico XML and bulk-indexes everything into Elasticsearch. For 50,000 books it takes ~2–3 minutes.

### 4. Open the app

Visit **http://localhost:3000**

---

## Re-importing

To re-import after updating your collection file:

```bash
docker compose run --rm importer
```

The importer drops and recreates the index each time.

## API Endpoints

| Endpoint | Description |
|---|---|
| `GET /api/books` | Search + facets. See parameters below. |
| `GET /api/books/:id` | Single book by ID |
| `GET /api/stats` | Top authors/series/genres, total count |
| `GET /api/health` | Health check |

### `/api/books` parameters

| Param | Description |
|---|---|
| `q` | Full-text search (all fields) |
| `title` | Search in title field only |
| `author` | Search in author field only |
| `series` | Search in series field only |
| `genre` | Search in genre field only |
| `publisher` | Search in publisher field only |
| `author_filter` | Exact author filter (repeatable) |
| `series_filter` | Exact series filter (repeatable) |
| `genre_filter` | Exact genre filter (repeatable) |
| `publisher_filter` | Exact publisher filter (repeatable) |
| `year_from` / `year_to` | Year range |
| `sort` | `title`, `author`, `pub_year`, `series`, `rating`, `cdate` |
| `dir` | `asc` or `desc` |
| `page` | Page number (default: 1) |
| `size` | Page size (default: 40) |

## Covers JSON format

```json
{
  "ab5b062b572aff31c59cc0bba5384ede.jpeg": "https://res.cloudinary.com/...",
  "d8df3abe30e315e4306f5d5ced0470ad.jpeg": "https://res.cloudinary.com/..."
}
```

Keys are the filenames stored in Tellico's `<cover>` elements.

## Scaling

The Elasticsearch index is configured with 1 shard / 0 replicas for a single-node setup. For very large collections (100k+), increase the JVM heap in `docker-compose.yml`:

```yaml
environment:
  - "ES_JAVA_OPTS=-Xms1g -Xmx2g"
```
