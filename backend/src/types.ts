// ─── Book document stored in Elasticsearch ───────────────────────────────────

export interface BookDoc {
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
  ratingNum: number | null;
  cover: string | null;
  cover_url: string | null;
  comments: string | null;
  url: string | null;
  cdate: string | null;
  mdate: string | null;
}

// ─── API response shapes ──────────────────────────────────────────────────────

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
}

export interface BooksResponse {
  total: number;
  page: number;
  size: number;
  books: Array<BookDoc & { _score: number | null }>;
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

// ─── Query params from the HTTP request ──────────────────────────────────────

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

export interface SearchQuery {
  q?: string;
  title?: string;
  author?: string;
  series?: string;
  genre?: string;
  keyword?: string;
  publisher?: string;
  author_filter?: string | string[];
  series_filter?: string | string[];
  genre_filter?: string | string[];
  publisher_filter?: string | string[];
  keyword_filter?: string | string[];
  year_filter?: string | string[];
  year_from?: string;
  year_to?: string;
  page?: string;
  size?: string;
  sort?: string;
  dir?: string;
}
