package main

// Importer — run by setting the IMPORT=1 environment variable.
// The binary serves HTTP by default; with IMPORT=1 it runs the import and exits.

import (
	"bytes"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

// ─── Env ──────────────────────────────────────────────────────────────────────

var (
	tellicoFile = getEnv("TELLICO_FILE", "../data/collection.tc")
	coversJSON  = getEnv("COVERS_JSON", "../data/covers.json")
)

// ─── Tellico XML types ────────────────────────────────────────────────────────

// tellicoDoc is the root element.
// The namespace must be declared on the struct so Go's xml decoder matches it.
type tellicoDoc struct {
	XMLName    xml.Name          `xml:"http://periapsis.org/tellico/ tellico"`
	Collection tellicoCollection `xml:"http://periapsis.org/tellico/ collection"`
}

type tellicoCollection struct {
	Entries []tellicoEntry `xml:"http://periapsis.org/tellico/ entry"`
}

type tellicoEntry struct {
	ID          string      `xml:"id,attr"`
	Title       string      `xml:"http://periapsis.org/tellico/ title"`
	TitleOrig   string      `xml:"http://periapsis.org/tellico/ titleOrig"`
	Series      string      `xml:"http://periapsis.org/tellico/ series"`
	Volume      string      `xml:"http://periapsis.org/tellico/ volume"`
	Authors     xmlStrings  `xml:"http://periapsis.org/tellico/ authors>author"`
	Editor      string      `xml:"http://periapsis.org/tellico/ editor"`
	Publisher   string      `xml:"http://periapsis.org/tellico/ publisher"`
	PubYear     string      `xml:"http://periapsis.org/tellico/ pub_year"`
	ISBN        string      `xml:"http://periapsis.org/tellico/ isbn"`
	Translators xmlStrings  `xml:"http://periapsis.org/tellico/ translators>translator"`
	Genres      xmlStrings  `xml:"http://periapsis.org/tellico/ genres>genre"`
	Keywords    xmlStrings  `xml:"http://periapsis.org/tellico/ keywords>keyword"`
	Rating      string      `xml:"http://periapsis.org/tellico/ rating"`
	RatingNum   string      `xml:"http://periapsis.org/tellico/ ratingNum"`
	Cover       string      `xml:"http://periapsis.org/tellico/ cover"`
	Comments    string      `xml:"http://periapsis.org/tellico/ comments"`
	URL         string      `xml:"http://periapsis.org/tellico/ url"`
	CDate       tellicoDate `xml:"http://periapsis.org/tellico/ cdate"`
	MDate       tellicoDate `xml:"http://periapsis.org/tellico/ mdate"`
}

// xmlStrings is a named []string so we can use it as a field type.
// encoding/xml accumulates repeated elements into a slice when the field
// is a slice and the tag matches the child element name — this works
// correctly for []string with the "parent>child" path syntax.
type xmlStrings = []string

type tellicoDate struct {
	Year  string `xml:"http://periapsis.org/tellico/ year"`
	Month string `xml:"http://periapsis.org/tellico/ month"`
	Day   string `xml:"http://periapsis.org/tellico/ day"`
}

// ─── BookDoc ──────────────────────────────────────────────────────────────────

type bookDoc struct {
	ID          int      `json:"id"`
	Title       *string  `json:"title"`
	TitleOrig   *string  `json:"titleOrig"`
	Series      *string  `json:"series"`
	Volume      *float64 `json:"volume"`
	Authors     []string `json:"authors"`
	Editor      *string  `json:"editor"`
	Publisher   *string  `json:"publisher"`
	PubYear     *int     `json:"pub_year"`
	ISBN        *string  `json:"isbn"`
	Translators []string `json:"translators"`
	Genres      []string `json:"genres"`
	Keywords    []string `json:"keywords"`
	Rating      *float64 `json:"rating"`
	RatingNum   *int     `json:"ratingNum"`
	Cover       *string  `json:"cover"`
	CoverURL    *string  `json:"cover_url"`
	Comments    *string  `json:"comments"`
	URL         *string  `json:"url"`
	CDate       *string  `json:"cdate"`
	MDate       *string  `json:"mdate"`
}

// ─── Parsing helpers ──────────────────────────────────────────────────────────

func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func parseFloatPtr(s string) *float64 {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return nil
	}
	return &v
}

func parseIntPtr(s string) *int {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	v, err := strconv.Atoi(s)
	if err != nil {
		return nil
	}
	return &v
}

func parseTellicoDate(d tellicoDate) *string {
	y := strings.TrimSpace(d.Year)
	if y == "" {
		return nil
	}
	m := strings.TrimSpace(d.Month)
	day := strings.TrimSpace(d.Day)
	if len(m) == 1 {
		m = "0" + m
	}
	if len(day) == 1 {
		day = "0" + day
	}
	if m == "" {
		m = "01"
	}
	if day == "" {
		day = "01"
	}
	s := fmt.Sprintf("%s-%s-%s", y, m, day)
	return &s
}

func filterEmpty(ss []string) []string {
	out := make([]string, 0, len(ss))
	for _, s := range ss {
		if strings.TrimSpace(s) != "" {
			out = append(out, s)
		}
	}
	return out
}

func parseEntry(e tellicoEntry, covers map[string]string) bookDoc {
	id, _ := strconv.Atoi(strings.TrimSpace(e.ID))

	// rating is stored as integer * 100 in Tellico (e.g. 889 = 8.89 stars).
	// Divide by 10 to match what the original TS importer stored in ES.
	var rating *float64
	if r := parseFloatPtr(e.Rating); r != nil {
		v := *r / 10.0
		rating = &v
	}

	coverFile := strPtr(e.Cover)
	var coverURL *string
	if coverFile != nil {
		if u, ok := covers[*coverFile]; ok && u != "" {
			coverURL = &u
		}
	}

	return bookDoc{
		ID:          id,
		Title:       strPtr(e.Title),
		TitleOrig:   strPtr(e.TitleOrig),
		Series:      strPtr(e.Series),
		Volume:      parseFloatPtr(e.Volume),
		Authors:     filterEmpty([]string(e.Authors)),
		Editor:      strPtr(e.Editor),
		Publisher:   strPtr(e.Publisher),
		PubYear:     parseIntPtr(e.PubYear),
		ISBN:        strPtr(e.ISBN),
		Translators: filterEmpty([]string(e.Translators)),
		Genres:      filterEmpty([]string(e.Genres)),
		Keywords:    filterEmpty([]string(e.Keywords)),
		Rating:      rating,
		RatingNum:   parseIntPtr(e.RatingNum),
		Cover:       coverFile,
		CoverURL:    coverURL,
		Comments:    strPtr(e.Comments),
		URL:         strPtr(e.URL),
		CDate:       parseTellicoDate(e.CDate),
		MDate:       parseTellicoDate(e.MDate),
	}
}

// ─── ES index management ──────────────────────────────────────────────────────

func indexExists() (bool, error) {
	resp, err := esRequest("HEAD", "/"+index, nil)
	if err != nil {
		return false, err
	}
	resp.Body.Close()
	return resp.StatusCode == http.StatusOK, nil
}

func deleteIndex() error {
	resp, err := esRequest("DELETE", "/"+index, nil)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("delete index: HTTP %d", resp.StatusCode)
	}
	return nil
}

func createIndexMapping() error {
	mapping := M{
		"settings": M{
			"analysis": M{
				"analyzer": M{
					"text_analyzer": M{
						"type":      "custom",
						"tokenizer": "standard",
						"filter":    []string{"lowercase", "asciifolding"},
					},
				},
			},
			"number_of_shards":   1,
			"number_of_replicas": 0,
		},
		"mappings": M{
			"properties": M{
				"id":          M{"type": "integer"},
				"title":       M{"type": "text", "analyzer": "text_analyzer", "fields": M{"keyword": M{"type": "keyword"}}},
				"titleOrig":   M{"type": "text", "analyzer": "text_analyzer", "fields": M{"keyword": M{"type": "keyword"}}},
				"series":      M{"type": "text", "analyzer": "text_analyzer", "fields": M{"keyword": M{"type": "keyword"}}},
				"volume":      M{"type": "float"},
				"authors":     M{"type": "text", "analyzer": "text_analyzer", "fields": M{"keyword": M{"type": "keyword"}}},
				"editor":      M{"type": "text", "analyzer": "text_analyzer", "fields": M{"keyword": M{"type": "keyword"}}},
				"publisher":   M{"type": "text", "analyzer": "text_analyzer", "fields": M{"keyword": M{"type": "keyword"}}},
				"pub_year":    M{"type": "integer"},
				"isbn":        M{"type": "keyword"},
				"translators": M{"type": "text", "analyzer": "text_analyzer", "fields": M{"keyword": M{"type": "keyword"}}},
				"genres":      M{"type": "text", "analyzer": "text_analyzer", "fields": M{"keyword": M{"type": "keyword"}}},
				"keywords":    M{"type": "text", "analyzer": "text_analyzer", "fields": M{"keyword": M{"type": "keyword"}}},
				"rating":      M{"type": "float"},
				"ratingNum":   M{"type": "integer"},
				"cover":       M{"type": "keyword"},
				"cover_url":   M{"type": "keyword", "index": false},
				"comments":    M{"type": "text", "analyzer": "text_analyzer"},
				"url":         M{"type": "keyword", "index": false},
				"cdate":       M{"type": "date", "format": "yyyy-MM-dd"},
				"mdate":       M{"type": "date", "format": "yyyy-MM-dd"},
			},
		},
	}

	resp, err := esRequest("PUT", "/"+index, mapping)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("create index: HTTP %d: %s", resp.StatusCode, body)
	}
	return nil
}

func refreshIndex() error {
	resp, err := esRequest("POST", "/"+index+"/_refresh", nil)
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}

// ─── Bulk indexing ────────────────────────────────────────────────────────────

// esBulk sends an NDJSON bulk request. The ES bulk API requires each action
// line and document line to be newline-terminated JSON — not a JSON array.
func esBulk(docs []bookDoc) error {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)

	for i := range docs {
		// Action line
		meta := map[string]any{
			"index": map[string]string{
				"_index": index,
				"_id":    strconv.Itoa(docs[i].ID),
			},
		}
		if err := enc.Encode(meta); err != nil {
			return err
		}
		// Document line
		if err := enc.Encode(docs[i]); err != nil {
			return err
		}
	}

	req, err := http.NewRequest("POST", esURL+"/_bulk", &buf)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-ndjson")
	debugLog("bulk POST /_bulk  payload_bytes=%d", buf.Len())

	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	var result struct {
		Errors bool `json:"errors"`
		Items  []map[string]struct {
			Error *struct {
				Reason string `json:"reason"`
			} `json:"error"`
		} `json:"items"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return err
	}
	if result.Errors {
		var reasons []string
		for _, item := range result.Items {
			for _, v := range item {
				if v.Error != nil {
					reasons = append(reasons, v.Error.Reason)
					if len(reasons) >= 3 {
						goto done
					}
				}
			}
		}
	done:
		log.Printf("Bulk errors (first %d): %v", len(reasons), reasons)
	}
	return nil
}

// ─── Wait for ES (import mode uses a tighter loop) ────────────────────────────

func waitForESImport() error {
	const maxAttempts = 30
	const interval = 2 * time.Second
	for i := 1; i <= maxAttempts; i++ {
		if err := esPing(); err == nil {
			log.Printf("Elasticsearch is ready (attempt %d)", i)
			return nil
		}
		log.Printf("Waiting for Elasticsearch... (%d/%d)", i, maxAttempts)
		time.Sleep(interval)
	}
	return fmt.Errorf("elasticsearch not reachable after %d attempts", maxAttempts)
}

// ─── Main import logic ────────────────────────────────────────────────────────

func runImport() {
	if err := waitForESImport(); err != nil {
		log.Fatal(err)
	}

	// ── Index setup ──────────────────────────────────────────────────────────
	exists, err := indexExists()
	if err != nil {
		log.Fatalf("checking index: %v", err)
	}
	if exists {
		log.Printf("Index %q already exists, deleting...", index)
		if err := deleteIndex(); err != nil {
			log.Fatalf("deleting index: %v", err)
		}
	}
	if err := createIndexMapping(); err != nil {
		log.Fatalf("creating index: %v", err)
	}
	log.Printf("Index %q created", index)

	// ── Load covers map ──────────────────────────────────────────────────────
	covers := map[string]string{}
	if data, err := os.ReadFile(coversJSON); err != nil {
		log.Printf("Warning: could not load covers JSON: %v", err)
	} else if err := json.Unmarshal(data, &covers); err != nil {
		log.Printf("Warning: could not parse covers JSON: %v", err)
	} else {
		log.Printf("Loaded %d cover mappings", len(covers))
	}

	// ── Parse XML ────────────────────────────────────────────────────────────
	log.Printf("Reading %s...", tellicoFile)
	xmlData, err := os.ReadFile(tellicoFile)
	if err != nil {
		log.Fatalf("reading tellico file: %v", err)
	}

	var doc tellicoDoc
	if err := xml.Unmarshal(xmlData, &doc); err != nil {
		log.Fatalf("parsing XML: %v", err)
	}
	entries := doc.Collection.Entries
	log.Printf("Found %d entries", len(entries))

	// ── Bulk index in batches ────────────────────────────────────────────────
	const batchSize = 500
	indexed := 0

	for i := 0; i < len(entries); i += batchSize {
		end := i + batchSize
		if end > len(entries) {
			end = len(entries)
		}
		batch := entries[i:end]

		docs := make([]bookDoc, len(batch))
		for j, e := range batch {
			docs[j] = parseEntry(e, covers)
			debugLog("  entry id=%s title=%q authors=%v", e.ID, e.Title, []string(e.Authors))
		}

		debugLog("bulk sending %d docs (batch %d)", len(docs), i/batchSize+1)
		if err := esBulk(docs); err != nil {
			log.Fatalf("bulk indexing batch %d: %v", i/batchSize+1, err)
		}
		indexed += len(batch)
		log.Printf("Indexed %d/%d", indexed, len(entries))
	}

	if err := refreshIndex(); err != nil {
		log.Printf("Warning: refresh failed: %v", err)
	}
	log.Println("Import complete!")
}
