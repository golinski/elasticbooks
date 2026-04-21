import express, { Request, Response } from "express";
import cors from "cors";
import { Client } from "@elastic/elasticsearch";
import type {
  SearchQuery,
  SortField,
  SortDir,
  BooksResponse,
  StatsResponse,
} from "./types";

const app = express();
const PORT = process.env.PORT ?? 3001;
const ES_URL = process.env.ELASTICSEARCH_URL ?? "http://localhost:9200";
const INDEX = "books";

const client = new Client({ node: ES_URL });

app.use(cors());
app.use(express.json());

// ─── helpers ─────────────────────────────────────────────────────────────────

type EsQuery = Record<string, unknown>;

function toArray(val: string | string[] | undefined): string[] {
  if (!val) return [];
  return Array.isArray(val) ? val : [val];
}

function buildFilters(query: SearchQuery): EsQuery {
  const must: EsQuery[] = [];
  const filters: EsQuery[] = [];

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

  // Field-specific prefix searches
  const fieldSearches: Record<string, string> = {
    title: "title",
    author: "authors",
    series: "series",
    genre: "genres",
    keyword: "keywords",
    publisher: "publisher",
    tag: "keywords",
  };

  for (const [param, field] of Object.entries(fieldSearches)) {
    const val = query[param as keyof SearchQuery] as string | undefined;
    if (val) {
      must.push({
        match_phrase_prefix: {
          [field]: { query: val, max_expansions: 50 },
        },
      });
    }
  }

  // Facet filters — prefix on .keyword subfield
  const facetFilterFields: Record<string, string> = {
    author_filter: "authors.keyword",
    series_filter: "series.keyword",
    genre_filter: "genres.keyword",
    publisher_filter: "publisher.keyword",
    keyword_filter: "keywords.keyword",
  };

  for (const [param, keywordField] of Object.entries(facetFilterFields)) {
    const vals = toArray(query[param as keyof SearchQuery] as string | string[] | undefined);
    if (vals.length === 0) continue;

    const clauses: EsQuery[] = vals.map((v) => ({
      prefix: { [keywordField]: { value: v } },
    }));

    filters.push(
      clauses.length === 1
        ? clauses[0]
        : { bool: { should: clauses, minimum_should_match: 1 } }
    );
  }

  // Year filter (exact values)
  const yearFilterVals = toArray(query.year_filter);
  if (yearFilterVals.length > 0) {
    filters.push({ terms: { pub_year: yearFilterVals.map(Number) } });
  }

  // Year range
  if (query.year_from || query.year_to) {
    const range: Record<string, number> = {};
    if (query.year_from) range.gte = parseInt(query.year_from, 10);
    if (query.year_to) range.lte = parseInt(query.year_to, 10);
    filters.push({ range: { pub_year: range } });
  }

  const bool: Record<string, EsQuery[]> = {};
  if (must.length) bool.must = must;
  if (filters.length) bool.filter = filters;

  return Object.keys(bool).length > 0 ? { bool } : { match_all: {} };
}

function buildSort(sortBy: string, sortDir: string): EsQuery[] {
  const dir: SortDir = sortDir === "desc" ? "desc" : "asc";

  switch (sortBy as SortField) {
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
    case "score":
      return [{ _score: { order: dir } }, { "title.keyword": { order: "asc" } }];
    case "popularity":
      return [{ ratingNum: { order: dir, missing: "_last" } }];
    default:
      return [{ _score: { order: "desc" } }, { "title.keyword": { order: "asc" } }];
  }
}

// ─── routes ──────────────────────────────────────────────────────────────────

app.get("/api/health", async (_req: Request, res: Response) => {
  try {
    const health = await client.cluster.health();
    res.json({ status: "ok", es: health.status });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(503).json({ status: "error", message: msg });
  }
});

app.get("/api/books", async (req: Request<object, BooksResponse, object, SearchQuery>, res: Response) => {
  try {
    const { page = "1", size = "40", sort = "title", dir = "asc", ...rest } = req.query;

    const pageNum = parseInt(page, 10);
    const sizeNum = parseInt(size, 10);
    const from = (pageNum - 1) * sizeNum;
    const esQuery = buildFilters(rest);
    const sortClause = buildSort(sort, dir);

    const result = await client.search({
      index: INDEX,
      body: {
        from,
        size: sizeNum,
        query: esQuery,
        sort: sortClause,
        aggs: {
          authors:    { terms: { field: "authors.keyword",   size: 30, min_doc_count: 1 } },
          series:     { terms: { field: "series.keyword",    size: 30, min_doc_count: 1 } },
          genres:     { terms: { field: "genres.keyword",    size: 30, min_doc_count: 1 } },
          publishers: { terms: { field: "publisher.keyword", size: 20, min_doc_count: 1 } },
          pub_years:  { terms: { field: "pub_year",          size: 50, order: { _key: "asc" } } },
          keywords:   { terms: { field: "keywords.keyword",  size: 30, min_doc_count: 1 } },
        },
        _source: true,
      } as any,
    });

    const aggs = result.aggregations as Record<string, { buckets: unknown[] }>;

    res.json({
      total: (result.hits.total as { value: number }).value,
      page: pageNum,
      size: sizeNum,
      books: result.hits.hits.map((h: any) => ({ ...h._source, _score: h._score ?? null })),
      facets: {
        authors:    aggs.authors.buckets,
        series:     aggs.series.buckets,
        genres:     aggs.genres.buckets,
        publishers: aggs.publishers.buckets,
        pub_years:  aggs.pub_years.buckets,
        keywords:   aggs.keywords.buckets,
      },
    });
  } catch (e) {
    console.error(e);
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: msg });
  }
});

app.get("/api/books/:id", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const result = await client.get({ index: INDEX, id: req.params.id });
    res.json(result._source);
  } catch {
    res.status(404).json({ error: "Not found" });
  }
});

app.get("/api/stats", async (_req: Request, res: Response<StatsResponse>) => {
  try {
    const result = await client.search({
      index: INDEX,
      body: {
        size: 0,
        aggs: {
          top_authors: { terms: { field: "authors.keyword",  size: 10 } },
          top_series:  { terms: { field: "series.keyword",   size: 10 } },
          top_genres:  { terms: { field: "genres.keyword",   size: 10 } },
          years:       { stats: { field: "pub_year" } },
        },
      } as any,
    });

    const aggs = result.aggregations as Record<string, { buckets?: unknown[]; min?: number; max?: number; avg?: number; count?: number }>;

    res.json({
      total: (result.hits.total as { value: number }).value,
      top_authors: aggs.top_authors.buckets as StatsResponse["top_authors"],
      top_series:  aggs.top_series.buckets  as StatsResponse["top_series"],
      top_genres:  aggs.top_genres.buckets  as StatsResponse["top_genres"],
      year_stats: {
        min:   aggs.years.min   ?? null,
        max:   aggs.years.max   ?? null,
        avg:   aggs.years.avg   ?? null,
        count: aggs.years.count ?? 0,
      },
    });
  } catch (e) {
    console.error(e);
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: msg } as unknown as StatsResponse);
  }
});

app.listen(PORT, () => {
  console.log(`Backend running on :${PORT}`);
});
