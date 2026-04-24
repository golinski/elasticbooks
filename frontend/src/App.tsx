import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
} from "react";
import { fetchBooks, fetchStats } from "./api";
import type {
  Book,
  BooksResponse,
  StatsResponse,
  SearchParams,
  SortField,
  FacetFilterKey,
  FacetBucket,
} from "./types";

// ─── URL state helpers ────────────────────────────────────────────────────────

const DEFAULT_PARAMS: SearchParams = {
  q: "", title: "", author: "", series: "", genre: "", keyword: "", publisher: "",
  author_filter: [], series_filter: [], genre_filter: [], publisher_filter: [],
  keyword_filter: [],
  year_from: "", year_to: "",
  sort: "title", dir: "asc", page: 1, size: 40,
};

function parseQS(): SearchParams {
  const p = new URLSearchParams(window.location.search);
  return {
    q:         p.get("q")         ?? "",
    title:     p.get("title")     ?? "",
    author:    p.get("author")    ?? "",
    series:    p.get("series")    ?? "",
    genre:     p.get("genre")     ?? "",
    keyword:   p.get("keyword")   ?? "",
    publisher: p.get("publisher") ?? "",
    author_filter:    p.getAll("author_filter"),
    series_filter:    p.getAll("series_filter"),
    genre_filter:     p.getAll("genre_filter"),
    publisher_filter: p.getAll("publisher_filter"),
    keyword_filter:   p.getAll("keyword_filter"),
    year_from: p.get("year_from") ?? "",
    year_to:   p.get("year_to")   ?? "",
    sort:      (p.get("sort")  as SortField) ?? "title",
    dir:       (p.get("dir")   as "asc" | "desc") ?? "asc",
    page:      parseInt(p.get("page") ?? "1", 10),
    size:      parseInt(p.get("size") ?? "40", 10),
  };
}

function toQS(s: SearchParams): string {
  const p = new URLSearchParams();
  const set = (k: string, v: string) => { if (v) p.set(k, v); };
  set("q",         s.q);
  set("title",     s.title);
  set("author",    s.author);
  set("series",    s.series);
  set("genre",     s.genre);
  set("keyword",   s.keyword);
  set("publisher", s.publisher);
  s.author_filter.forEach((v)    => p.append("author_filter",    v));
  s.series_filter.forEach((v)    => p.append("series_filter",    v));
  s.genre_filter.forEach((v)     => p.append("genre_filter",     v));
  s.publisher_filter.forEach((v) => p.append("publisher_filter", v));
  s.keyword_filter.forEach((v)   => p.append("keyword_filter",   v));
  set("year_from", s.year_from);
  set("year_to",   s.year_to);
  if (s.sort !== "title") p.set("sort", s.sort);
  if (s.dir  !== "asc")   p.set("dir",  s.dir);
  if (s.page > 1)         p.set("page", String(s.page));
  if (s.size !== 40)      p.set("size", String(s.size));
  return p.toString();
}

// ─── Constants ────────────────────────────────────────────────────────────────

const PLACEHOLDER =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='220' viewBox='0 0 160 220'%3E%3Crect width='160' height='220' fill='%231e1e28'/%3E%3Ctext x='80' y='115' text-anchor='middle' fill='%235a5650' font-size='13' font-family='serif'%3ENo cover%3C/text%3E%3C/svg%3E";

const SORT_OPTIONS: Array<{ v: SortField; l: string }> = [
  { v: "title",      l: "Title" },
  { v: "author",     l: "Author" },
  { v: "pub_year",   l: "Year" },
  { v: "series",     l: "Series" },
  { v: "rating",     l: "Rating" },
  { v: "popularity", l: "Popularity (# ratings)" },
  { v: "cdate",      l: "Date added" },
  { v: "score",      l: "Relevance score" },
];

const FIELD_SEARCHES: Array<[keyof SearchParams, string]> = [
  ["title",     "Title"],
  ["author",    "Author"],
  ["series",    "Series"],
  ["genre",     "Genre"],
  ["keyword",   "Tag / Keyword"],
  ["publisher", "Publisher"],
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatPopularity(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

// ─── Cloudinary responsive helpers ───────────────────────────────────────────
// Width buckets served as separate <source> elements inside a <picture>.
// Heights are derived from the 2:3 portrait ratio.
const CL_WIDTH_BUCKETS = [120, 160, 200, 273, 360, 480, 640, 800] as const;
type ClBucket = (typeof CL_WIDTH_BUCKETS)[number];
const COVER_RATIO = 3 / 2;

function clUrl(url: string, w: ClBucket): string {
  if (!url.includes("res.cloudinary.com")) return url;
  const h = Math.round(w * COVER_RATIO);
  return url.replace("http://", "https://").replace(/\/upload\//, `/upload/c_fit,w_${w},h_${h}/`) + ".avif";
}

interface CoverPictureProps {
  url: string;
  alt: string;
  // Sizes attribute forwarded to <img> so the browser picks the right source.
  // Defaults to "100vw" if omitted.
  sizes?: string;
  className?: string;
  onError?: () => void;
  onClick?: React.MouseEventHandler<HTMLImageElement>;
  style?: React.CSSProperties;
  loading?: "lazy" | "eager";
}

/** Renders a <picture> with one <source> per Cloudinary width bucket. */
function CoverPicture({
  url,
  alt,
  sizes = "100vw",
  className,
  onError,
  onClick,
  style,
  loading = "lazy",
}: CoverPictureProps) {
  const isCloudinary = url.includes("res.cloudinary.com");

  if (!isCloudinary) {
    return (
      <img
        src={url}
        alt={alt}
        sizes={sizes}
        className={className}
        onError={onError}
        onClick={onClick}
        style={style}
        loading={loading}
      />
    );
  }

  // Build a srcSet string covering all buckets — the browser will pick based
  // on the rendered width reported by `sizes`.
  const srcSet = CL_WIDTH_BUCKETS
    .map((w) => `${clUrl(url, w)} ${w}w`)
    .join(", ");

  // Fallback src: smallest bucket (good for old browsers / bots).
  const fallbackSrc = clUrl(url, CL_WIDTH_BUCKETS[0]);

  return (
    <picture>
      <source srcSet={srcSet} sizes={sizes} type="image/avif" />
      <img
        src={fallbackSrc}
        alt={alt}
        className={className}
        onError={onError}
        onClick={onClick}
        style={style}
        loading={loading}
      />
    </picture>
  );
}

// ─── BookCard ─────────────────────────────────────────────────────────────────

interface BookCardProps {
  book: Book;
  onClick: (book: Book) => void;
  sortMode: SortField;
}

function BookCard({ book, onClick, sortMode }: BookCardProps) {
  const [imgErr, setImgErr] = useState(false);
  const coverUrl = !imgErr && book.cover_url ? book.cover_url : null;

  let badge: React.ReactNode = null;
  if (sortMode === "score" && book._score != null) {
    badge = (
      <span className="rating-badge score-badge" title={`Relevance score: ${book._score}`}>
        ★{book._score.toFixed(2)}
      </span>
    );
  } else if (sortMode === "popularity" && book.ratingNum != null) {
    badge = (
      <span className="rating-badge popularity-badge" title={`${book.ratingNum.toLocaleString()} ratings`}>
        ♥{formatPopularity(book.ratingNum)}
      </span>
    );
  } else if (book.rating != null) {
    badge = (
      <span className="rating-badge" title={`Rating: ${(book.rating / 10).toFixed(1)}`}>
        {(book.rating / 10).toFixed(1)}
      </span>
    );
  }

  return (
    <div className="book-card" onClick={() => onClick(book)}>
      <div className="cover-wrap">
        <CoverPicture
          url={coverUrl ?? PLACEHOLDER}
          alt={book.title ?? "Unknown"}
          sizes="(max-width:600px) 130px, 160px"
          onError={() => setImgErr(true)}
          loading="lazy"
        />
        {book.volume != null && (
          <span className="vol-badge">#{book.volume}</span>
        )}
        {badge}
      </div>
      <div className="card-title">{book.title}</div>
      <div className="card-author">
        {(book.authors ?? []).join(", ") || "—"}
      </div>
    </div>
  );
}

// ─── FacetSection ─────────────────────────────────────────────────────────────

interface FacetSectionProps {
  title: string;
  buckets: FacetBucket[];
  selected: string[];
  onToggle: (value: string) => void;
  limit?: number;
}

function FacetSection({ title, buckets, selected, onToggle, limit = 10 }: FacetSectionProps) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? buckets : buckets.slice(0, limit);

  return (
    <div className="facet-section">
      <div className="facet-title">{title}</div>
      {shown.map((b) => (
        <label key={String(b.key)} className="facet-item">
          <input
            type="checkbox"
            checked={selected.includes(String(b.key))}
            onChange={() => onToggle(String(b.key))}
          />
          <span className="facet-key">{String(b.key)}</span>
          <span className="facet-count">{b.doc_count}</span>
        </label>
      ))}
      {buckets.length > limit && (
        <button className="facet-more" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show less" : `+${buckets.length - limit} more`}
        </button>
      )}
    </div>
  );
}

// ─── Modal ────────────────────────────────────────────────────────────────────

interface ModalProps {
  book: Book;
  onClose: () => void;
  onFilterAuthor: (author: string) => void;
  onFilterSeries: (series: string) => void;
}

function Modal({ book, onClose, onFilterAuthor, onFilterSeries }: ModalProps) {
  const [imgErr, setImgErr] = useState(false);
  const [lightbox, setLightbox] = useState(false);
  const modalCoverUrl = !imgErr && book.cover_url ? book.cover_url : null;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <>
      <div className="modal-overlay" onClick={onClose} />
      <div className="modal">
        <button className="modal-close" onClick={onClose}>✕</button>
        <div className="modal-body">
          <div className="modal-cover">
            <CoverPicture
              url={modalCoverUrl ?? PLACEHOLDER}
              alt={book.title ?? "Cover"}
              sizes="180px"
              onError={() => setImgErr(true)}
              onClick={() => { if (book.cover_url) setLightbox(true); }}
              style={{ cursor: book.cover_url ? "zoom-in" : "default" }}
            />
          </div>
          <div className="modal-info">
            <h2 className="modal-title">{book.title}</h2>
            {book.titleOrig && book.titleOrig !== book.title && (
              <div className="modal-orig">{book.titleOrig}</div>
            )}

            {(book.authors?.length ?? 0) > 0 && (
              <div className="modal-row">
                <span className="modal-label">Author</span>
                <span>
                  {book.authors.map((a, i) => (
                    <React.Fragment key={a}>
                      {i > 0 && ", "}
                      <button
                        className="link-btn"
                        onClick={() => { onFilterAuthor(a); onClose(); }}
                      >
                        {a}
                      </button>
                    </React.Fragment>
                  ))}
                </span>
              </div>
            )}

            {book.series && (
              <div className="modal-row">
                <span className="modal-label">Series</span>
                <button
                  className="link-btn"
                  onClick={() => { onFilterSeries(book.series!); onClose(); }}
                >
                  {book.series}{book.volume != null && ` #${book.volume}`}
                </button>
              </div>
            )}

            {book.publisher && (
              <div className="modal-row">
                <span className="modal-label">Publisher</span>
                <span>{book.publisher}</span>
              </div>
            )}

            {book.pub_year && (
              <div className="modal-row">
                <span className="modal-label">Year</span>
                <span>{book.pub_year}</span>
              </div>
            )}

            {(book.genres?.length ?? 0) > 0 && (
              <div className="modal-row">
                <span className="modal-label">Genre</span>
                <span>{book.genres.join(", ")}</span>
              </div>
            )}

            {(book.translators?.length ?? 0) > 0 && (
              <div className="modal-row">
                <span className="modal-label">Translator</span>
                <span>{book.translators.join(", ")}</span>
              </div>
            )}

            {book.isbn && (
              <div className="modal-row">
                <span className="modal-label">ISBN</span>
                <span>{book.isbn}</span>
              </div>
            )}

            {book.rating != null && (
              <div className="modal-row">
                <span className="modal-label">Rating</span>
                <span>
                  {(book.rating / 10).toFixed(1)}
                  {book.ratingNum != null && (
                    <span className="modal-ratingnum">
                      {" "}({book.ratingNum.toLocaleString()} ratings)
                    </span>
                  )}
                </span>
              </div>
            )}

            {book.comments && (
              <div className="modal-comments">
                <div className="modal-label">Description</div>
                <div
                  className="modal-blurb"
                  dangerouslySetInnerHTML={{ __html: book.comments }}
                />
              </div>
            )}

            {book.url && (
              <div className="modal-row" style={{ marginTop: "auto" }}>
                <a href={book.url} target="_blank" rel="noreferrer">
                  View on lubimyczytac.pl ↗
                </a>
              </div>
            )}
          </div>
        </div>
      </div>

      {lightbox && book.cover_url && (
        <div
          className="lightbox"
          onClick={() => setLightbox(false)}
          title="Click to close"
        >
          <img src={book.cover_url} alt={book.title ?? "Cover"} />
        </div>
      )}
    </>
  );
}

// ─── Pagination ───────────────────────────────────────────────────────────────

interface PaginationProps {
  page: number;
  total: number;
  size: number;
  onChange: (page: number) => void;
}

function Pagination({ page, total, size, onChange }: PaginationProps) {
  const pages = Math.ceil(total / size);
  if (pages <= 1) return null;

  const around = 2;
  const nums = new Set([1, pages]);
  for (let i = Math.max(1, page - around); i <= Math.min(pages, page + around); i++) nums.add(i);
  const sorted = [...nums].sort((a, b) => a - b);

  const items: Array<number | "…"> = [];
  let prev = 0;
  for (const n of sorted) {
    if (n - prev > 1) items.push("…");
    items.push(n);
    prev = n;
  }

  return (
    <div className="pagination">
      <button disabled={page === 1} onClick={() => onChange(page - 1)}>‹</button>
      {items.map((item, i) =>
        item === "…" ? (
          <span key={`e${i}`} className="pg-ellipsis">…</span>
        ) : (
          <button
            key={item}
            className={item === page ? "pg-active" : ""}
            onClick={() => onChange(item as number)}
          >
            {item}
          </button>
        )
      )}
      <button disabled={page === pages} onClick={() => onChange(page + 1)}>›</button>
    </div>
  );
}

// ─── StatsPanel ───────────────────────────────────────────────────────────────

interface StatsPanelProps {
  stats: StatsResponse;
  onFilter: (key: FacetFilterKey, value: string) => void;
}

function StatsPanel({ stats, onFilter }: StatsPanelProps) {
  return (
    <div className="stats-panel">
      <div className="stats-total">{stats.total.toLocaleString()} books</div>
      <div className="stats-cols">
        <div className="stats-col">
          <div className="stats-heading">Top Authors</div>
          {stats.top_authors.map((b) => (
            <button key={String(b.key)} className="stats-item" onClick={() => onFilter("author_filter", String(b.key))}>
              <span>{String(b.key)}</span>
              <span className="stats-count">{b.doc_count}</span>
            </button>
          ))}
        </div>
        <div className="stats-col">
          <div className="stats-heading">Top Series</div>
          {stats.top_series.map((b) => (
            <button key={String(b.key)} className="stats-item" onClick={() => onFilter("series_filter", String(b.key))}>
              <span>{String(b.key)}</span>
              <span className="stats-count">{b.doc_count}</span>
            </button>
          ))}
        </div>
        <div className="stats-col">
          <div className="stats-heading">Top Genres</div>
          {stats.top_genres.map((b) => (
            <button key={String(b.key)} className="stats-item" onClick={() => onFilter("genre_filter", String(b.key))}>
              <span>{String(b.key)}</span>
              <span className="stats-count">{b.doc_count}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Chip ─────────────────────────────────────────────────────────────────────

interface ChipProps {
  label: string;
  onRemove: () => void;
}

function Chip({ label, onRemove }: ChipProps) {
  return (
    <span className="chip">
      {label}
      <button onClick={onRemove}>✕</button>
    </span>
  );
}

// ─── App ─────────────────────────────────────────────────────────────────────

export default function App() {
  const [params, setParams] = useState<SearchParams>(parseQS);
  const [data, setData] = useState<BooksResponse | null>(null);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Book | null>(null);
  const [showStats, setShowStats] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const searchRef = useRef<HTMLInputElement>(null);

  // Sync URL ↔ state
  useEffect(() => {
    const qs = toQS(params);
    const url = qs ? `?${qs}` : window.location.pathname;
    window.history.pushState(null, "", url);
  }, [params]);

  useEffect(() => {
    const onPop = () => setParams(parseQS());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Fetch books
  useEffect(() => {
    setLoading(true);
    setError(null);
    fetchBooks(params)
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Unknown error"))
      .finally(() => setLoading(false));
  }, [params]);

  // Fetch stats once
  useEffect(() => {
    fetchStats().then(setStats).catch(() => {/* silent */});
  }, []);

  const update = useCallback((patch: Partial<SearchParams>) => {
    setParams((p) => ({ ...p, ...patch, page: 1 }));
  }, []);

  const toggleFacet = useCallback((key: FacetFilterKey, value: string) => {
    setParams((p) => {
      const cur = p[key] as string[];
      const next = cur.includes(value)
        ? cur.filter((v) => v !== value)
        : [...cur, value];
      return { ...p, [key]: next, page: 1 };
    });
  }, []);

  const clearAll = useCallback(() => {
    setParams({ ...DEFAULT_PARAMS });
  }, []);

  const hasFilters = useMemo(() =>
    params.q || params.title || params.author || params.series ||
    params.genre || params.keyword || params.publisher ||
    params.author_filter.length || params.series_filter.length ||
    params.genre_filter.length || params.publisher_filter.length ||
    params.keyword_filter.length || params.year_from || params.year_to,
    [params]
  );

  const facets = data?.facets;

  return (
    <div className="app">
      {/* Header */}
      <header className="header">
        <div className="header-left">
          <button
            className="sidebar-toggle"
            onClick={() => setSidebarOpen((v) => !v)}
            title="Toggle sidebar"
          >
            ☰
          </button>
          <h1 className="logo" onClick={() => { clearAll(); setShowStats(false); }}>
            📚 Bookshelf
          </h1>
        </div>

        <div className="header-search">
          <input
            ref={searchRef}
            type="search"
            placeholder="Search everything…"
            value={params.q}
            onChange={(e) => update({ q: e.target.value })}
            className="search-input"
          />
        </div>

        <div className="header-right">
          <button
            className={`header-btn ${showStats ? "active" : ""}`}
            onClick={() => setShowStats((v) => !v)}
          >
            Stats
          </button>
          {hasFilters && (
            <button className="header-btn danger" onClick={clearAll}>
              Clear filters
            </button>
          )}
        </div>
      </header>

      {showStats && stats && (
        <StatsPanel
          stats={stats}
          onFilter={(key, val) => { update({ [key]: [val] }); setShowStats(false); }}
        />
      )}

      <div className="layout">
        {/* Sidebar */}
        {sidebarOpen && (
          <aside className="sidebar">
            {/* Field-specific search */}
            <div className="facet-section">
              <div className="facet-title">Search by field</div>
              {FIELD_SEARCHES.map(([k, label]) => (
                <div key={k} className="field-search">
                  <input
                    type="search"
                    placeholder={label}
                    value={params[k] as string}
                    onChange={(e) => update({ [k]: e.target.value })}
                    className="field-input"
                  />
                </div>
              ))}
            </div>

            {/* Year range */}
            <div className="facet-section">
              <div className="facet-title">Year range</div>
              <div className="year-range">
                <input
                  type="number"
                  placeholder="From"
                  value={params.year_from}
                  onChange={(e) => update({ year_from: e.target.value })}
                  className="year-input"
                />
                <span>–</span>
                <input
                  type="number"
                  placeholder="To"
                  value={params.year_to}
                  onChange={(e) => update({ year_to: e.target.value })}
                  className="year-input"
                />
              </div>
            </div>

            {/* Facets from results */}
            {facets && (
              <>
                <FacetSection
                  title="Authors"
                  buckets={facets.authors}
                  selected={params.author_filter}
                  onToggle={(v) => toggleFacet("author_filter", v)}
                />
                <FacetSection
                  title="Series"
                  buckets={facets.series}
                  selected={params.series_filter}
                  onToggle={(v) => toggleFacet("series_filter", v)}
                />
                <FacetSection
                  title="Genres"
                  buckets={facets.genres}
                  selected={params.genre_filter}
                  onToggle={(v) => toggleFacet("genre_filter", v)}
                />
                <FacetSection
                  title="Publishers"
                  buckets={facets.publishers}
                  selected={params.publisher_filter}
                  onToggle={(v) => toggleFacet("publisher_filter", v)}
                />
                {(facets.keywords?.length ?? 0) > 0 && (
                  <FacetSection
                    title="Tags / Keywords"
                    buckets={facets.keywords}
                    selected={params.keyword_filter}
                    onToggle={(v) => toggleFacet("keyword_filter", v)}
                  />
                )}
              </>
            )}
          </aside>
        )}

        {/* Main content */}
        <main className="main">
          {/* Toolbar */}
          <div className="toolbar">
            <div className="toolbar-left">
              {data && (
                <span className="result-count">
                  {data.total.toLocaleString()} books
                  {loading && " (refreshing…)"}
                </span>
              )}
            </div>
            <div className="toolbar-right">
              <label className="sort-label">
                Sort:
                <select
                  value={params.sort}
                  onChange={(e) => update({ sort: e.target.value as SortField })}
                  className="sort-select"
                >
                  {SORT_OPTIONS.map((o) => (
                    <option key={o.v} value={o.v}>{o.l}</option>
                  ))}
                </select>
              </label>
              <button
                className="dir-btn"
                title={params.dir === "asc" ? "Ascending" : "Descending"}
                onClick={() => update({ dir: params.dir === "asc" ? "desc" : "asc" })}
              >
                {params.dir === "asc" ? "↑ Asc" : "↓ Desc"}
              </button>
              <label className="sort-label">
                Per page:
                <select
                  value={params.size}
                  onChange={(e) => update({ size: parseInt(e.target.value, 10), page: 1 })}
                  className="sort-select"
                >
                  {[20, 40, 80, 120].map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </label>
            </div>
          </div>

          {/* Active filter chips */}
          {hasFilters && (
            <div className="active-filters">
              {params.q         && <Chip label={`"${params.q}"`}                  onRemove={() => update({ q: "" })} />}
              {params.title     && <Chip label={`title: ${params.title}`}         onRemove={() => update({ title: "" })} />}
              {params.author    && <Chip label={`author: ${params.author}`}       onRemove={() => update({ author: "" })} />}
              {params.series    && <Chip label={`series: ${params.series}`}       onRemove={() => update({ series: "" })} />}
              {params.genre     && <Chip label={`genre: ${params.genre}`}         onRemove={() => update({ genre: "" })} />}
              {params.keyword   && <Chip label={`keyword: ${params.keyword}`}     onRemove={() => update({ keyword: "" })} />}
              {params.publisher && <Chip label={`publisher: ${params.publisher}`} onRemove={() => update({ publisher: "" })} />}
              {params.author_filter.map((v)    => <Chip key={v} label={`author = ${v}`}    onRemove={() => toggleFacet("author_filter",    v)} />)}
              {params.series_filter.map((v)    => <Chip key={v} label={`series = ${v}`}    onRemove={() => toggleFacet("series_filter",    v)} />)}
              {params.genre_filter.map((v)     => <Chip key={v} label={`genre = ${v}`}     onRemove={() => toggleFacet("genre_filter",     v)} />)}
              {params.publisher_filter.map((v) => <Chip key={v} label={`publisher = ${v}`} onRemove={() => toggleFacet("publisher_filter", v)} />)}
              {params.keyword_filter.map((v)   => <Chip key={v} label={`tag: ${v}`}        onRemove={() => toggleFacet("keyword_filter",   v)} />)}
              {(params.year_from || params.year_to) && (
                <Chip
                  label={`year: ${params.year_from || "…"}–${params.year_to || "…"}`}
                  onRemove={() => update({ year_from: "", year_to: "" })}
                />
              )}
            </div>
          )}

          {error && <div className="error-msg">Error: {error}</div>}

          {/* Grid */}
          {!error && (
            <div className={`book-grid ${loading ? "grid-loading" : ""}`}>
              {data?.books.map((book) => (
                <BookCard
                  key={book.id}
                  book={book}
                  onClick={setSelected}
                  sortMode={params.sort}
                />
              ))}
              {data?.books.length === 0 && !loading && (
                <div className="empty">No books found.</div>
              )}
            </div>
          )}

          {data && (
            <Pagination
              page={params.page}
              total={data.total}
              size={params.size}
              onChange={(p) => setParams((s) => ({ ...s, page: p }))}
            />
          )}
        </main>
      </div>

      {selected && (
        <Modal
          book={selected}
          onClose={() => setSelected(null)}
          onFilterAuthor={(a) => update({ author_filter: [a] })}
          onFilterSeries={(s) => update({ series_filter: [s] })}
        />
      )}

      <style>{styles}</style>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = `
.app {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

/* Header */
.header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 16px;
  height: 56px;
  background: var(--bg2);
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  z-index: 100;
}
.header-left { display: flex; align-items: center; gap: 10px; }
.logo {
  font-size: 1.25rem;
  font-weight: bold;
  color: var(--accent);
  cursor: pointer;
  white-space: nowrap;
}
.sidebar-toggle {
  font-size: 1.2rem;
  color: var(--text2);
  padding: 4px 6px;
  border-radius: 4px;
}
.sidebar-toggle:hover { background: var(--border); }
.header-search { flex: 1; max-width: 480px; }
.search-input {
  width: 100%;
  background: var(--bg3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text);
  padding: 7px 12px;
  outline: none;
  transition: border-color .15s;
}
.search-input:focus { border-color: var(--accent); }
.header-right { display: flex; gap: 8px; margin-left: auto; }
.header-btn {
  padding: 6px 12px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  color: var(--text2);
  font-size: .875rem;
  background: var(--bg3);
  transition: all .15s;
}
.header-btn:hover, .header-btn.active { border-color: var(--accent); color: var(--accent); }
.header-btn.danger { border-color: var(--danger); color: var(--danger); }

/* Stats panel */
.stats-panel {
  background: var(--bg2);
  border-bottom: 1px solid var(--border);
  padding: 16px 20px;
}
.stats-total {
  font-size: 1.5rem;
  color: var(--accent);
  margin-bottom: 12px;
  font-weight: bold;
}
.stats-cols { display: flex; gap: 24px; flex-wrap: wrap; }
.stats-col { min-width: 180px; }
.stats-heading {
  font-size: .75rem;
  text-transform: uppercase;
  letter-spacing: .08em;
  color: var(--text3);
  margin-bottom: 6px;
}
.stats-item {
  display: flex;
  justify-content: space-between;
  width: 100%;
  padding: 3px 0;
  color: var(--text2);
  font-size: .875rem;
  text-align: left;
  gap: 8px;
}
.stats-item:hover { color: var(--accent); }
.stats-count {
  color: var(--text3);
  font-size: .8rem;
  white-space: nowrap;
}

/* Layout */
.layout { display: flex; flex: 1; min-height: 0; }

/* Sidebar */
.sidebar {
  width: 220px;
  min-width: 220px;
  background: var(--bg2);
  border-right: 1px solid var(--border);
  overflow-y: auto;
  padding-bottom: 24px;
}
.facet-section { border-bottom: 1px solid var(--border); padding: 12px 14px; }
.facet-title {
  font-size: .7rem;
  text-transform: uppercase;
  letter-spacing: .1em;
  color: var(--text3);
  margin-bottom: 8px;
  font-weight: 600;
}
.facet-item {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 3px 0;
  cursor: pointer;
  font-size: .875rem;
}
.facet-item:hover .facet-key { color: var(--accent); }
.facet-key { flex: 1; color: var(--text2); word-break: break-word; }
.facet-count {
  color: var(--text3);
  font-size: .75rem;
  min-width: 24px;
  text-align: right;
}
.facet-more {
  margin-top: 4px;
  color: var(--accent2);
  font-size: .8rem;
  padding: 2px 0;
}
.facet-more:hover { color: var(--accent); }
input[type="checkbox"] { accent-color: var(--accent); }

.field-search { margin-bottom: 6px; }
.field-input {
  width: 100%;
  background: var(--bg3);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text);
  padding: 5px 8px;
  font-size: .8rem;
  outline: none;
}
.field-input:focus { border-color: var(--accent); }
.field-input::placeholder { color: var(--text3); }

.year-range { display: flex; align-items: center; gap: 6px; }
.year-input {
  width: 70px;
  background: var(--bg3);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text);
  padding: 5px 8px;
  font-size: .8rem;
  outline: none;
}
.year-input:focus { border-color: var(--accent); }

/* Main */
.main { flex: 1; overflow-y: auto; padding: 0 16px 32px; }

/* Toolbar */
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 0;
  gap: 12px;
  flex-wrap: wrap;
  position: sticky;
  top: 0;
  background: var(--bg);
  z-index: 10;
  border-bottom: 1px solid var(--border);
  margin-bottom: 12px;
}
.toolbar-left { color: var(--text2); font-size: .9rem; }
.result-count { color: var(--text2); }
.toolbar-right { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.sort-label { font-size: .85rem; color: var(--text2); display: flex; align-items: center; gap: 5px; }
.sort-select {
  background: var(--bg3);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text);
  padding: 4px 8px;
  font-size: .85rem;
}
.dir-btn {
  background: var(--bg3);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text2);
  padding: 4px 10px;
  font-size: .85rem;
}
.dir-btn:hover { border-color: var(--accent); color: var(--accent); }

/* Active filter chips */
.active-filters { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px 3px 10px;
  background: var(--bg3);
  border: 1px solid var(--accent2);
  border-radius: 20px;
  font-size: .8rem;
  color: var(--text);
}
.chip button {
  color: var(--text3);
  font-size: .7rem;
  padding: 0 2px;
  line-height: 1;
}
.chip button:hover { color: var(--danger); }

/* Book grid */
.book-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(var(--card-w), 1fr));
  gap: 16px;
  transition: opacity .15s;
}
.grid-loading { opacity: .5; pointer-events: none; }

.book-card {
  cursor: pointer;
  border-radius: var(--radius);
  overflow: hidden;
  background: var(--bg2);
  border: 1px solid var(--border);
  transition: transform .15s, border-color .15s, box-shadow .15s;
}
.book-card:hover {
  transform: translateY(-3px);
  border-color: var(--accent);
  box-shadow: 0 6px 20px rgba(0,0,0,.4);
}
.cover-wrap {
  position: relative;
  aspect-ratio: 2/3;
  background: var(--bg3);
  overflow: hidden;
}
.cover-wrap img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.vol-badge {
  position: absolute;
  top: 6px;
  left: 6px;
  background: rgba(0,0,0,.75);
  color: var(--accent);
  font-size: .7rem;
  padding: 2px 6px;
  border-radius: 10px;
  font-weight: bold;
}
.rating-badge {
  position: absolute;
  top: 6px;
  right: 6px;
  background: rgba(0,0,0,.75);
  color: #f0c040;
  font-size: .7rem;
  padding: 2px 6px;
  border-radius: 10px;
}
.score-badge { color: #7ecfff; }
.popularity-badge { color: #ff8fa3; }
.card-title {
  padding: 7px 8px 2px;
  font-size: .82rem;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 500;
}
.card-author {
  padding: 0 8px 8px;
  font-size: .75rem;
  color: var(--text3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.empty { color: var(--text2); padding: 40px 0; text-align: center; font-size: 1.1rem; }
.error-msg { color: var(--danger); padding: 24px; text-align: center; }

/* Pagination */
.pagination {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 4px;
  margin-top: 28px;
  flex-wrap: wrap;
}
.pagination button {
  min-width: 34px;
  height: 34px;
  padding: 0 8px;
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text2);
  font-size: .875rem;
}
.pagination button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.pagination button:disabled { opacity: .35; cursor: default; }
.pagination .pg-active { border-color: var(--accent); color: var(--accent); background: var(--bg3); }
.pg-ellipsis { color: var(--text3); padding: 0 4px; }

/* Modal */
.modal-overlay {
  position: fixed; inset: 0;
  background: rgba(0,0,0,.7);
  z-index: 200;
  backdrop-filter: blur(2px);
}
.modal {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 201;
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: 12px;
  width: min(860px, 94vw);
  max-height: 90vh;
  overflow-y: auto;
  box-shadow: 0 20px 60px rgba(0,0,0,.7);
}
.modal-close {
  position: sticky;
  top: 12px;
  float: right;
  margin: 12px 12px 0 0;
  width: 30px; height: 30px;
  border-radius: 50%;
  background: var(--bg3);
  color: var(--text2);
  border: 1px solid var(--border);
  display: flex; align-items: center; justify-content: center;
  font-size: .85rem;
  z-index: 1;
}
.modal-close:hover { color: var(--danger); border-color: var(--danger); }
.modal-body { display: flex; gap: 24px; padding: 20px 24px 24px; clear: both; }
.modal-cover { flex-shrink: 0; width: 180px; }
.modal-cover img {
  width: 100%;
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0,0,0,.5);
  display: block;
}
.modal-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 10px; }
.modal-title { font-size: 1.3rem; color: var(--text); line-height: 1.3; }
.modal-orig { color: var(--text3); font-style: italic; font-size: .9rem; margin-top: -6px; }
.modal-row { display: flex; gap: 10px; align-items: baseline; font-size: .9rem; }
.modal-label { color: var(--text3); min-width: 80px; font-size: .8rem; text-transform: uppercase; letter-spacing: .05em; flex-shrink: 0; }
.modal-ratingnum { color: var(--text3); font-size: .8rem; }
.modal-comments { font-size: .875rem; }
.modal-blurb { color: var(--text2); line-height: 1.6; margin-top: 5px; }
.link-btn { color: var(--accent2); text-align: left; }
.link-btn:hover { color: var(--accent); text-decoration: underline; }

/* Lightbox */
.lightbox {
  position: fixed; inset: 0;
  background: rgba(0,0,0,.92);
  z-index: 300;
  display: flex; align-items: center; justify-content: center;
  cursor: zoom-out;
}
.lightbox img {
  max-width: 90vw;
  max-height: 90vh;
  object-fit: contain;
  border-radius: 4px;
  box-shadow: 0 0 60px rgba(0,0,0,.8);
}

@media (max-width: 600px) {
  .sidebar { width: 180px; min-width: 180px; }
  .modal-body { flex-direction: column; }
  .modal-cover { width: 120px; }
  :root { --card-w: 130px; }
}
`;
