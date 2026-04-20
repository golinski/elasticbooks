import express from "express";
import cors from "cors";
import { Client } from "@elastic/elasticsearch";

const app = express();
const PORT = process.env.PORT || 3001;
const ES_URL = process.env.ELASTICSEARCH_URL || "http://localhost:9200";
const INDEX = "books";

const client = new Client({ node: ES_URL });

app.use(cors());
app.use(express.json());

// ─── helpers ────────────────────────────────────────────────────────────────

function buildFilters(query) {
  const must = [];
  const filters = [];

  // Full-text search across all fields
  if (query.q) {
    must.push({
      multi_match: {
        query: query.q,
        fields: [
          "title^3",
          "titleOrig^2",
          "authors^2",
          "series^2",
          "comments",
          "genres",
          "keywords",
          "publisher",
          "translators",
        ],
        type: "best_fields",
        fuzziness: "AUTO",
      },
    });
  }

  // Field-specific searches
  const fieldSearches = {
    title: "title",
    author: "authors",
    series: "series",
    genre: "genres",
    keyword: "keywords",
    publisher: "publisher",
  };
  for (const [param, field] of Object.entries(fieldSearches)) {
    if (query[param]) {
      must.push({
        match: { [field]: { query: query[param], fuzziness: "AUTO" } },
      });
    }
  }

  // Exact filters (facets)
  const termFilters = {
    author_filter: "authors.keyword",
    series_filter: "series.keyword",
    genre_filter: "genres.keyword",
    publisher_filter: "publisher.keyword",
    year_filter: "pub_year",
  };
  for (const [param, field] of Object.entries(termFilters)) {
    if (query[param]) {
      const vals = Array.isArray(query[param]) ? query[param] : [query[param]];
      filters.push({ terms: { [field]: vals } });
    }
  }

  if (query.year_from || query.year_to) {
    const range = {};
    if (query.year_from) range.gte = parseInt(query.year_from);
    if (query.year_to) range.lte = parseInt(query.year_to);
    filters.push({ range: { pub_year: range } });
  }

  const bool = {};
  if (must.length) bool.must = must;
  if (filters.length) bool.filter = filters;

  return Object.keys(bool).length ? { bool } : { match_all: {} };
}

function buildSort(sortBy, sortDir) {
  const dir = sortDir === "desc" ? "desc" : "asc";
  switch (sortBy) {
    case "title":
      return [{ "title.keyword": { order: dir } }];
    case "author":
      return [{ "authors.keyword": { order: dir } }];
    case "pub_year":
      return [{ pub_year: { order: dir } }];
    case "rating":
      return [{ rating: { order: dir, missing: "_last" } }];
    case "series":
      return [
        { "series.keyword": { order: dir, missing: "_last" } },
        { volume: { order: "asc", missing: "_last" } },
      ];
    case "cdate":
      return [{ cdate: { order: dir } }];
    default:
      return [{ _score: { order: "desc" } }, { "title.keyword": { order: "asc" } }];
  }
}

// ─── routes ─────────────────────────────────────────────────────────────────

// Health
app.get("/api/health", async (req, res) => {
  try {
    const health = await client.cluster.health();
    res.json({ status: "ok", es: health.status });
  } catch (e) {
    res.status(503).json({ status: "error", message: e.message });
  }
});

// Search + facets
app.get("/api/books", async (req, res) => {
  try {
    const {
      page = 1,
      size = 40,
      sort = "title",
      dir = "asc",
      ...rest
    } = req.query;

    const from = (parseInt(page) - 1) * parseInt(size);
    const esQuery = buildFilters(rest);
    const sortClause = buildSort(sort, dir);

    const body = {
      from,
      size: parseInt(size),
      query: esQuery,
      sort: sortClause,
      aggs: {
        authors: {
          terms: { field: "authors.keyword", size: 30, min_doc_count: 1 },
        },
        series: {
          terms: { field: "series.keyword", size: 30, min_doc_count: 1 },
        },
        genres: {
          terms: { field: "genres.keyword", size: 30, min_doc_count: 1 },
        },
        publishers: {
          terms: { field: "publisher.keyword", size: 20, min_doc_count: 1 },
        },
        pub_years: {
          terms: { field: "pub_year", size: 50, order: { _key: "asc" } },
        },
      },
      _source: true,
    };

    const result = await client.search({ index: INDEX, body });

    res.json({
      total: result.hits.total.value,
      page: parseInt(page),
      size: parseInt(size),
      books: result.hits.hits.map((h) => ({ ...h._source, _score: h._score })),
      facets: {
        authors: result.aggregations.authors.buckets,
        series: result.aggregations.series.buckets,
        genres: result.aggregations.genres.buckets,
        publishers: result.aggregations.publishers.buckets,
        pub_years: result.aggregations.pub_years.buckets,
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Single book
app.get("/api/books/:id", async (req, res) => {
  try {
    const result = await client.get({ index: INDEX, id: req.params.id });
    res.json(result._source);
  } catch (e) {
    res.status(404).json({ error: "Not found" });
  }
});

// Stats (for homepage overview)
app.get("/api/stats", async (req, res) => {
  try {
    const result = await client.search({
      index: INDEX,
      body: {
        size: 0,
        aggs: {
          total: { value_count: { field: "id" } },
          top_authors: {
            terms: { field: "authors.keyword", size: 10 },
          },
          top_series: {
            terms: { field: "series.keyword", size: 10 },
          },
          top_genres: {
            terms: { field: "genres.keyword", size: 10 },
          },
          years: {
            stats: { field: "pub_year" },
          },
        },
      },
    });

    const aggs = result.aggregations;
    res.json({
      total: result.hits.total.value,
      top_authors: aggs.top_authors.buckets,
      top_series: aggs.top_series.buckets,
      top_genres: aggs.top_genres.buckets,
      year_stats: aggs.years,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Backend running on :${PORT}`);
});
