package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// ─── Config ───────────────────────────────────────────────────────────────────

const index = "books"

var (
	port           = getEnv("PORT", "3001")
	esURL          = getEnv("ELASTICSEARCH_URL", "http://localhost:9200")
	allowedOrigins = parseOrigins(getEnv("ALLOWED_ORIGINS", ""))
)

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func parseOrigins(s string) []string {
	var out []string
	for _, o := range strings.Split(s, ",") {
		if t := strings.TrimSpace(o); t != "" {
			out = append(out, t)
		}
	}
	return out
}

// ─── Debug logging ────────────────────────────────────────────────────────────

// debugMode is set once at startup from the DEBUG environment variable.
// When true, debugLog writes timestamped lines to stderr.
var debugMode = os.Getenv("DEBUG") != ""

func debugLog(format string, args ...any) {
	if debugMode {
		fmt.Fprintf(os.Stderr, "[DEBUG] "+format+"\n", args...)
	}
}

// ─── ES client (thin HTTP wrapper) ───────────────────────────────────────────

var httpClient = &http.Client{Timeout: 30 * time.Second}

func esRequest(method, path string, body any) (*http.Response, error) {
	var buf *bytes.Buffer
	var bodyJSON string
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		bodyJSON = string(b)
		buf = bytes.NewBuffer(b)
	} else {
		buf = &bytes.Buffer{}
	}

	debugLog("ES → %s %s%s  body=%s", method, esURL, path, bodyJSON)

	req, err := http.NewRequest(method, esURL+path, buf)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil {
		debugLog("ES ← error: %v", err)
		return nil, err
	}

	if debugMode {
		// Read the body, log it, then replace it with a fresh reader so the
		// caller can still decode it normally.
		raw, readErr := io.ReadAll(resp.Body)
		resp.Body.Close()
		resp.Body = io.NopCloser(bytes.NewReader(raw))
		if readErr == nil {
			// Truncate very large responses in the log.
			logged := string(raw)
			if len(logged) > 2000 {
				logged = logged[:2000] + "…(truncated)"
			}
			debugLog("ES ← %d  body=%s", resp.StatusCode, logged)
		}
	}

	return resp, nil
}

func esPing() error {
	resp, err := esRequest("GET", "/", nil)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("ES ping status %d", resp.StatusCode)
	}
	return nil
}

func waitForES() {
	const maxAttempts = 40
	const interval = 3 * time.Second
	for i := 1; i <= maxAttempts; i++ {
		if err := esPing(); err == nil {
			log.Printf("Elasticsearch ready (attempt %d)", i)
			return
		}
		log.Printf("Waiting for Elasticsearch… (%d/%d)", i, maxAttempts)
		time.Sleep(interval)
	}
	log.Println("Elasticsearch did not become ready in time — requests will fail until it does.")
}

// ─── JSON helpers ─────────────────────────────────────────────────────────────

// M is a convenience alias for building arbitrary JSON objects.
type M = map[string]any

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// ─── CORS middleware ──────────────────────────────────────────────────────────

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		allowed := origin == "" || len(allowedOrigins) == 0
		if !allowed {
			for _, o := range allowedOrigins {
				if o == origin {
					allowed = true
					break
				}
			}
		}
		if !allowed {
			http.Error(w, "CORS: origin not allowed", http.StatusForbidden)
			return
		}
		if origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Methods", "GET")
			w.Header().Set("Vary", "Origin")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ─── Query building ───────────────────────────────────────────────────────────

func buildFilters(q url.Values) M {
	var must []M
	var filters []M

	// Full-text search
	if v := q.Get("q"); v != "" {
		must = append(must, M{
			"multi_match": M{
				"query":     v,
				"fields":    []string{"title^3", "titleOrig^2", "authors^2", "series^2", "comments", "genres", "keywords", "publisher", "translators"},
				"type":      "best_fields",
				"fuzziness": "AUTO",
			},
		})
	}

	// Field-specific prefix searches
	fieldMap := [][2]string{
		{"title", "title"},
		{"author", "authors"},
		{"series", "series"},
		{"genre", "genres"},
		{"keyword", "keywords"},
		{"publisher", "publisher"},
		{"tag", "keywords"},
	}
	for _, pair := range fieldMap {
		if v := q.Get(pair[0]); v != "" {
			must = append(must, M{
				"match_phrase_prefix": M{
					pair[1]: M{"query": v, "max_expansions": 50},
				},
			})
		}
	}

	// Facet filters
	facetMap := [][2]string{
		{"author_filter", "authors.keyword"},
		{"series_filter", "series.keyword"},
		{"genre_filter", "genres.keyword"},
		{"publisher_filter", "publisher.keyword"},
		{"keyword_filter", "keywords.keyword"},
	}
	for _, pair := range facetMap {
		vals := q[pair[0]] // []string, multi-value
		if len(vals) == 0 {
			continue
		}
		clauses := make([]M, len(vals))
		for i, v := range vals {
			clauses[i] = M{"prefix": M{pair[1]: M{"value": v}}}
		}
		if len(clauses) == 1 {
			filters = append(filters, clauses[0])
		} else {
			filters = append(filters, M{"bool": M{"should": clauses, "minimum_should_match": 1}})
		}
	}

	// Year exact filter
	if yearVals := q["year_filter"]; len(yearVals) > 0 {
		nums := make([]int, 0, len(yearVals))
		for _, v := range yearVals {
			if n, err := strconv.Atoi(v); err == nil {
				nums = append(nums, n)
			}
		}
		if len(nums) > 0 {
			filters = append(filters, M{"terms": M{"pub_year": nums}})
		}
	}

	// Year range
	if from, to := q.Get("year_from"), q.Get("year_to"); from != "" || to != "" {
		rng := M{}
		if from != "" {
			if n, err := strconv.Atoi(from); err == nil {
				rng["gte"] = n
			}
		}
		if to != "" {
			if n, err := strconv.Atoi(to); err == nil {
				rng["lte"] = n
			}
		}
		if len(rng) > 0 {
			filters = append(filters, M{"range": M{"pub_year": rng}})
		}
	}

	// Rating range (params are in 0–1000 integer scale, matching ES storage)
	if from, to := q.Get("rating_from"), q.Get("rating_to"); from != "" || to != "" {
		rng := M{}
		if from != "" {
			if n, err := strconv.Atoi(from); err == nil {
				rng["gte"] = n
			}
		}
		if to != "" {
			if n, err := strconv.Atoi(to); err == nil {
				rng["lte"] = n
			}
		}
		if len(rng) > 0 {
			filters = append(filters, M{"range": M{"rating": rng}})
		}
	}

	// Number-of-ratings range
	if from, to := q.Get("rating_num_from"), q.Get("rating_num_to"); from != "" || to != "" {
		rng := M{}
		if from != "" {
			if n, err := strconv.Atoi(from); err == nil {
				rng["gte"] = n
			}
		}
		if to != "" {
			if n, err := strconv.Atoi(to); err == nil {
				rng["lte"] = n
			}
		}
		if len(rng) > 0 {
			filters = append(filters, M{"range": M{"ratingNum": rng}})
		}
	}

	// Date-added year range
	if from, to := q.Get("cdate_from"), q.Get("cdate_to"); from != "" || to != "" {
		rng := M{}
		if from != "" {
			rng["gte"] = from + "-01-01"
		}
		if to != "" {
			rng["lte"] = to + "-12-31"
		}
		if len(rng) > 0 {
			filters = append(filters, M{"range": M{"cdate": rng}})
		}
	}

	bool := M{}
	if len(must) > 0 {
		bool["must"] = must
	}
	if len(filters) > 0 {
		bool["filter"] = filters
	}
	if len(bool) > 0 {
		return M{"bool": bool}
	}
	return M{"match_all": M{}}
}

// buildFiltersExcluding builds the ES query like buildFilters but omits the
// range filter for the specified histogram field. Used so each histogram agg
// shows the distribution for all other active filters, but not its own range.
func buildFiltersExcluding(q url.Values, exclude string) M {
	// Clone the values map without the excluded keys
	clone := make(url.Values)
	for k, v := range q {
		clone[k] = v
	}
	switch exclude {
	case "rating":
		delete(clone, "rating_from")
		delete(clone, "rating_to")
	case "ratingNum":
		delete(clone, "rating_num_from")
		delete(clone, "rating_num_to")
	case "cdate":
		delete(clone, "cdate_from")
		delete(clone, "cdate_to")
	}
	return buildFilters(clone)
}

// histInterval computes a sensible ES histogram interval given the field's
// approximate range and the requested number of buckets.
func histInterval(field string, buckets int) any {
	if buckets < 1 {
		buckets = 20
	}
	switch field {
	case "rating":
		// rating stored as raw Tellico value 0–1000
		return 1000.0 / float64(buckets)
	case "ratingNum", "readersNum":
		// readersNum can span 0–100k+; use a round interval
		intervals := []int{1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000}
		target := 200000 / buckets // assume max ~200k readers
		best := intervals[len(intervals)-1]
		for _, iv := range intervals {
			if iv >= target {
				best = iv
				break
			}
		}
		return best
	default:
		return 10
	}
}

func buildSort(sortBy, sortDir string) []M {
	dir := "asc"
	if sortDir == "desc" {
		dir = "desc"
	}
	switch sortBy {
	case "title":
		return []M{{"title.keyword": M{"order": dir}}}
	case "author":
		return []M{{"authors.keyword": M{"order": dir}}}
	case "pub_year":
		return []M{{"pub_year": M{"order": dir}}}
	case "rating":
		return []M{{"rating": M{"order": dir, "missing": "_last"}}}
	case "series":
		return []M{
			{"series.keyword": M{"order": dir, "missing": "_last"}},
			{"volume": M{"order": "asc", "missing": "_last"}},
		}
	case "cdate":
		return []M{{"cdate": M{"order": dir}}}
	case "score":
		return []M{{"_score": M{"order": dir}}, {"title.keyword": M{"order": "asc"}}}
	case "popularity":
		return []M{{"readersNum": M{"order": dir, "missing": "_last"}}}
	default:
		return []M{{"_score": M{"order": "desc"}}, {"title.keyword": M{"order": "asc"}}}
	}
}

// ─── ES response shapes ───────────────────────────────────────────────────────

type aggEntry struct {
	Buckets []struct {
		Key      any `json:"key"`
		DocCount int `json:"doc_count"`
	} `json:"buckets"`
	Min   *float64 `json:"min"`
	Max   *float64 `json:"max"`
	Avg   *float64 `json:"avg"`
	Count *int     `json:"count"`
	// Captures nested agg keys (e.g. the inner "hist" inside a filter agg).
	Extra map[string]json.RawMessage `json:"-"`
}

func (a *aggEntry) UnmarshalJSON(data []byte) error {
	type plain aggEntry
	if err := json.Unmarshal(data, (*plain)(a)); err != nil {
		return err
	}
	return json.Unmarshal(data, &a.Extra)
}

type esSearchResponse struct {
	Hits struct {
		Total struct {
			Value int `json:"value"`
		} `json:"total"`
		Hits []struct {
			Source json.RawMessage `json:"_source"`
			Score  *float64        `json:"_score"`
		} `json:"hits"`
	} `json:"hits"`
	Aggregations map[string]aggEntry `json:"aggregations"`
}

type facetBucket struct {
	Key      any `json:"key"`
	DocCount int `json:"doc_count"`
}

func aggBuckets(aggs map[string]aggEntry, name string) []facetBucket {
	agg, ok := aggs[name]
	if !ok {
		return []facetBucket{}
	}
	out := make([]facetBucket, len(agg.Buckets))
	for i, b := range agg.Buckets {
		out[i] = facetBucket{Key: b.Key, DocCount: b.DocCount}
	}
	return out
}

// nestedAggBuckets extracts buckets from a filter-wrapped histogram agg.
// ES shape: aggs[outer] = { doc_count, [inner]: { buckets: [...] } }
func nestedAggBuckets(aggs map[string]aggEntry, outer, inner string) []facetBucket {
	outerAgg, ok := aggs[outer]
	if !ok || outerAgg.Extra == nil {
		return []facetBucket{}
	}
	innerRaw, ok := outerAgg.Extra[inner]
	if !ok {
		return []facetBucket{}
	}
	var innerAgg aggEntry
	if err := json.Unmarshal(innerRaw, &innerAgg); err != nil {
		return []facetBucket{}
	}
	out := make([]facetBucket, len(innerAgg.Buckets))
	for i, b := range innerAgg.Buckets {
		out[i] = facetBucket{Key: b.Key, DocCount: b.DocCount}
	}
	return out
}

// nestedAggBuckets2 extracts buckets from a global → filter → histogram agg.
// ES shape: aggs[outer] = { doc_count, [mid]: { doc_count, [inner]: { buckets } } }
func nestedAggBuckets2(aggs map[string]aggEntry, outer, mid, inner string) []facetBucket {
	outerAgg, ok := aggs[outer]
	if !ok || outerAgg.Extra == nil {
		return []facetBucket{}
	}
	midRaw, ok := outerAgg.Extra[mid]
	if !ok {
		return []facetBucket{}
	}
	var midAgg aggEntry
	if err := json.Unmarshal(midRaw, &midAgg); err != nil {
		return []facetBucket{}
	}
	if midAgg.Extra == nil {
		return []facetBucket{}
	}
	innerRaw, ok := midAgg.Extra[inner]
	if !ok {
		return []facetBucket{}
	}
	var innerAgg aggEntry
	if err := json.Unmarshal(innerRaw, &innerAgg); err != nil {
		return []facetBucket{}
	}
	out := make([]facetBucket, len(innerAgg.Buckets))
	for i, b := range innerAgg.Buckets {
		out[i] = facetBucket{Key: b.Key, DocCount: b.DocCount}
	}
	return out
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

func handleHealth(w http.ResponseWriter, r *http.Request) {
	resp, err := esRequest("GET", "/_cluster/health", nil)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, M{"status": "error", "message": err.Error()})
		return
	}
	defer resp.Body.Close()
	var health M
	_ = json.NewDecoder(resp.Body).Decode(&health)
	writeJSON(w, http.StatusOK, M{"status": "ok", "es": health["status"]})
}

func handleBooks(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	debugLog("→ GET /api/books  raw_query=%q", r.URL.RawQuery)

	pageNum, _ := strconv.Atoi(firstOr(q.Get("page"), "1"))
	sizeNum, _ := strconv.Atoi(firstOr(q.Get("size"), "40"))
	if pageNum < 1 {
		pageNum = 1
	}
	if sizeNum < 1 {
		sizeNum = 40
	}
	from := (pageNum - 1) * sizeNum

	sortBy := firstOr(q.Get("sort"), "title")
	sortDir := firstOr(q.Get("dir"), "asc")

	debugLog("  page=%d size=%d from=%d sort=%s dir=%s", pageNum, sizeNum, from, sortBy, sortDir)

	histBuckets, _ := strconv.Atoi(firstOr(q.Get("hist_buckets"), "30"))
	if histBuckets < 5 {
		histBuckets = 5
	}
	if histBuckets > 200 {
		histBuckets = 200
	}

	body := M{
		"from":  from,
		"size":  sizeNum,
		"query": buildFilters(q),
		"sort":  buildSort(sortBy, sortDir),
		"aggs": M{
			"authors":    M{"terms": M{"field": "authors.keyword", "size": 30, "min_doc_count": 1}},
			"series":     M{"terms": M{"field": "series.keyword", "size": 30, "min_doc_count": 1}},
			"genres":     M{"terms": M{"field": "genres.keyword", "size": 30, "min_doc_count": 1}},
			"publishers": M{"terms": M{"field": "publisher.keyword", "size": 20, "min_doc_count": 1}},
			"pub_years":  M{"terms": M{"field": "pub_year", "size": 50, "order": M{"_key": "asc"}}},
			"keywords":   M{"terms": M{"field": "keywords.keyword", "size": 30, "min_doc_count": 1}},
			// Histogram aggs use global + filter so they are independent of the
		// main query. Each one applies all active filters EXCEPT its own range,
		// so the histogram shape reflects the full dataset narrowed by other
		// filters (author, genre, etc.) but not by the histogram's own range.
		"rating_hist": M{"global": M{}, "aggs": M{
			"filtered": M{"filter": buildFiltersExcluding(q, "rating"), "aggs": M{
				"hist": M{"histogram": M{
					"field":           "rating",
					"interval":        10,
					"min_doc_count":   0,
					"extended_bounds": M{"min": 0, "max": 1000},
				}},
			}},
		}},
		"rating_num_hist": M{"global": M{}, "aggs": M{
			"filtered": M{"filter": buildFiltersExcluding(q, "ratingNum"), "aggs": M{
				"hist": M{"histogram": M{
					"field":           "readersNum",
					"interval":        histInterval("readersNum", histBuckets),
					"min_doc_count":   0,
					"extended_bounds": M{"min": 0, "max": 500000},
				}},
			}},
		}},
		"cdate_hist": M{"global": M{}, "aggs": M{
			"filtered": M{"filter": buildFiltersExcluding(q, "cdate"), "aggs": M{
				"hist": M{"date_histogram": M{
					"field":             "cdate",
					"calendar_interval": "year",
					"min_doc_count":     0,
					"extended_bounds":   M{"min": "2000-01-01", "max": "2030-01-01"},
				}},
			}},
		}},
		},
	}

	resp, err := esRequest("POST", "/"+index+"/_search", body)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, M{"error": err.Error()})
		return
	}
	defer resp.Body.Close()

	var esResp esSearchResponse
	if err := json.NewDecoder(resp.Body).Decode(&esResp); err != nil {
		writeJSON(w, http.StatusInternalServerError, M{"error": err.Error()})
		return
	}

	// Merge _score into each _source document
	books := make([]json.RawMessage, 0, len(esResp.Hits.Hits))
	for _, hit := range esResp.Hits.Hits {
		// Unmarshal source, inject _score, re-marshal
		var doc M
		if err := json.Unmarshal(hit.Source, &doc); err != nil {
			continue
		}
		if hit.Score != nil {
			doc["_score"] = *hit.Score
		} else {
			doc["_score"] = nil
		}
		b, _ := json.Marshal(doc)
		books = append(books, b)
	}

	aggs := esResp.Aggregations
	debugLog("← /api/books  total=%d returned=%d", esResp.Hits.Total.Value, len(books))
	writeJSON(w, http.StatusOK, M{
		"total": esResp.Hits.Total.Value,
		"page":  pageNum,
		"size":  sizeNum,
		"books": books,
		"facets": M{
			"authors":         aggBuckets(aggs, "authors"),
			"series":          aggBuckets(aggs, "series"),
			"genres":          aggBuckets(aggs, "genres"),
			"publishers":      aggBuckets(aggs, "publishers"),
			"pub_years":       aggBuckets(aggs, "pub_years"),
			"keywords":        aggBuckets(aggs, "keywords"),
			// Nested: global → filtered → hist → buckets
			"rating_hist":     nestedAggBuckets2(aggs, "rating_hist", "filtered", "hist"),
			"rating_num_hist": nestedAggBuckets2(aggs, "rating_num_hist", "filtered", "hist"),
			"cdate_hist":      nestedAggBuckets2(aggs, "cdate_hist", "filtered", "hist"),
		},
	})
}

func handleBookByID(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/books/")
	debugLog("→ GET /api/books/%s", id)
	if id == "" {
		http.NotFound(w, r)
		return
	}
	resp, err := esRequest("GET", "/"+index+"/_doc/"+id, nil)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, M{"error": err.Error()})
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		writeJSON(w, http.StatusNotFound, M{"error": "Not found"})
		return
	}
	var result struct {
		Source json.RawMessage `json:"_source"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&result)
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(result.Source)
}

func handleStats(w http.ResponseWriter, r *http.Request) {
	debugLog("→ GET /api/stats")
	body := M{
		"size": 0,
		"aggs": M{
			"top_authors": M{"terms": M{"field": "authors.keyword", "size": 10}},
			"top_series":  M{"terms": M{"field": "series.keyword", "size": 10}},
			"top_genres":  M{"terms": M{"field": "genres.keyword", "size": 10}},
			"years":       M{"stats": M{"field": "pub_year"}},
		},
	}

	resp, err := esRequest("POST", "/"+index+"/_search", body)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, M{"error": err.Error()})
		return
	}
	defer resp.Body.Close()

	var esResp esSearchResponse
	if err := json.NewDecoder(resp.Body).Decode(&esResp); err != nil {
		writeJSON(w, http.StatusInternalServerError, M{"error": err.Error()})
		return
	}

	aggs := esResp.Aggregations
	years := aggs["years"]

	writeJSON(w, http.StatusOK, M{
		"total":       esResp.Hits.Total.Value,
		"top_authors": aggBuckets(aggs, "top_authors"),
		"top_series":  aggBuckets(aggs, "top_series"),
		"top_genres":  aggBuckets(aggs, "top_genres"),
		"year_stats": M{
			"min":   years.Min,
			"max":   years.Max,
			"avg":   years.Avg,
			"count": years.Count,
		},
	})
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

func firstOr(v, fallback string) string {
	if v != "" {
		return v
	}
	return fallback
}

// ─── Router ───────────────────────────────────────────────────────────────────

func newRouter() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		handleHealth(w, r)
	})

	mux.HandleFunc("/api/books/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		// /api/books/ with trailing slash but no id → list
		if r.URL.Path == "/api/books/" || r.URL.Path == "/api/books" {
			handleBooks(w, r)
			return
		}
		handleBookByID(w, r)
	})

	mux.HandleFunc("/api/books", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		handleBooks(w, r)
	})

	mux.HandleFunc("/api/stats", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		handleStats(w, r)
	})

	return corsMiddleware(mux)
}

// ─── Main ─────────────────────────────────────────────────────────────────────

func main() {
	if os.Getenv("IMPORT") == "1" {
		runImport()
		return
	}

	go waitForES()

	addr := ":" + port
	log.Printf("Backend running on %s", addr)
	srv := &http.Server{
		Addr:         addr,
		Handler:      newRouter(),
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  60 * time.Second,
	}
	if err := srv.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}
