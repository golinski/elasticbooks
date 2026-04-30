// ─── Book ─────────────────────────────────────────────────────────────────────

export interface Book {
  id: number;
  title: string | null;
  titleOrig: string | null;
  series: string | null;
  volume: number | null;
  authors: string[];
  editor: string | null;
  publisher: string | null;
  pub_year: number | null;
  isbn: string | null;
  translators: string[];
  genres: string[];
  keywords: string[];
  rating: number | null;
  readersNum: number | null;
  cover: string | null;
  cover_url: string | null;
  comments: string | null;
  url: string | null;
  cdate: string | null;
  mdate: string | null;
  _score: number | null;
}

// ─── Facets ───────────────────────────────────────────────────────────────────

export interface FacetBucket {
  key: string | number;
  doc_count: number;
}

export interface Facets {
  authors: FacetBucket[];
  series: FacetBucket[];
  genres: FacetBucket[];
  publishers: FacetBucket[];
  pub_years: FacetBucket[];
  keywords: FacetBucket[];
  rating_hist: FacetBucket[];
  readers_hist: FacetBucket[];
  cdate_hist: FacetBucket[];
}

// ─── API responses ────────────────────────────────────────────────────────────

export interface BooksResponse {
  total: number;
  page: number;
  size: number;
  books: Book[];
  facets: Facets;
}

export interface StatsResponse {
  total: number;
  top_authors: FacetBucket[];
  top_series: FacetBucket[];
  top_genres: FacetBucket[];
  year_stats: {
    min: number | null;
    max: number | null;
    avg: number | null;
    count: number;
  };
}

// ─── Search params ────────────────────────────────────────────────────────────

export type SortField =
  | "title"
  | "author"
  | "pub_year"
  | "series"
  | "rating"
  | "popularity"
  | "cdate"
  | "score";

export type SortDir = "asc" | "desc";

export type FacetFilterKey =
  | "author_filter"
  | "series_filter"
  | "genre_filter"
  | "publisher_filter"
  | "keyword_filter";

export interface SearchParams {
  q: string;
  title: string;
  author: string;
  series: string;
  genre: string;
  keyword: string;
  publisher: string;
  author_filter: string[];
  series_filter: string[];
  genre_filter: string[];
  publisher_filter: string[];
  keyword_filter: string[];
  year_from: string;
  year_to: string;
  rating_from: string;
  rating_to: string;
  readers_from: string;
  readers_to: string;
  cdate_from: string;
  cdate_to: string;
  sort: SortField;
  dir: SortDir;
  page: number;
  size: number;
}
