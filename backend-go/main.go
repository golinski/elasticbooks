package main

import (
	"bytes"
	"encoding/json"
	"fmt"
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

// ─── ES client (thin HTTP wrapper) ───────────────────────────────────────────

var httpClient = &http.Client{Timeout: 30 * time.Second}

func esRequest(method, path string, body any) (*http.Response, error) {
	var buf *bytes.Buffer
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		buf = bytes.NewBuffer(b)
	} else {
		buf = &bytes.Buffer{}
	}
	req, err := http.NewRequest(method, esURL+path, buf)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	return httpClient.Do(req)
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
		return []M{{"ratingNum": M{"order": dir, "missing": "_last"}}}
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
	writeJSON(w, http.StatusOK, M{
		"total": esResp.Hits.Total.Value,
		"page":  pageNum,
		"size":  sizeNum,
		"books": books,
		"facets": M{
			"authors":    aggBuckets(aggs, "authors"),
			"series":     aggBuckets(aggs, "series"),
			"genres":     aggBuckets(aggs, "genres"),
			"publishers": aggBuckets(aggs, "publishers"),
			"pub_years":  aggBuckets(aggs, "pub_years"),
			"keywords":   aggBuckets(aggs, "keywords"),
		},
	})
}

func handleBookByID(w http.ResponseWriter, r *http.Request) {
	// Path: /api/books/{id}
	id := strings.TrimPrefix(r.URL.Path, "/api/books/")
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
