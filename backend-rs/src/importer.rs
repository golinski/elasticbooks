/// Data importer: parses the Tellico XML file and bulk-indexes into Elasticsearch.
///
/// Run by setting `IMPORT=1` in the environment.
use anyhow::{anyhow, Context, Result};
use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tracing::{debug, info, warn};

use crate::{
    config::Config,
    es::{es_json, es_raw, wait_for_es_import, INDEX},
};

// ─── Tellico XML types ────────────────────────────────────────────────────────
//
// quick-xml with the `serialize` feature uses serde Deserialize to map XML
// elements to structs. The `#[serde(rename = "...")]` attribute maps the XML
// element name to the Rust field name.
//
// The Tellico namespace (http://periapsis.org/tellico/) is declared on the
// root element and inherited by all children. quick-xml strips the namespace
// prefix during deserialization, so we do NOT need to include it in field names.
//
// Repeated child elements (e.g. multiple <author> inside <authors>) are
// collected into a Vec<String> automatically by serde when the field is a Vec.

#[derive(Debug, Deserialize)]
#[serde(rename = "tellico")]
struct TellicoDoc {
    collection: TellicoCollection,
}

#[derive(Debug, Deserialize)]
struct TellicoCollection {
    #[serde(rename = "entry", default)]
    entries: Vec<TellicoEntry>,
}

#[derive(Debug, Deserialize)]
struct TellicoEntry {
    /// The `id` attribute on <entry id="1">
    #[serde(rename = "@id")]
    id: String,

    #[serde(default)]
    title: String,
    #[serde(rename = "titleOrig", default)]
    title_orig: String,
    #[serde(default)]
    series: String,
    #[serde(default)]
    volume: String,

    /// <authors><author>Name</author></authors>
    /// quick-xml flattens this: the outer <authors> wrapper is transparent
    /// when the inner element name matches the Vec element type's rename.
    #[serde(default)]
    authors: AuthorList,

    #[serde(default)]
    editor: String,
    #[serde(default)]
    publisher: String,
    #[serde(rename = "pub_year", default)]
    pub_year: String,
    #[serde(default)]
    isbn: String,

    #[serde(default)]
    translators: TranslatorList,
    #[serde(default)]
    genres: GenreList,
    #[serde(default)]
    keywords: KeywordList,

    #[serde(default)]
    rating: String,
    #[serde(rename = "readersNum", default)]
    readers_num: String,
    #[serde(default)]
    cover: String,
    #[serde(default)]
    comments: String,
    #[serde(default)]
    url: String,

    #[serde(default)]
    cdate: TellicoDate,
    #[serde(default)]
    mdate: TellicoDate,
}

// Wrapper structs for the nested list elements.
// Tellico uses <authors><author>X</author><author>Y</author></authors>.
// quick-xml needs a wrapper struct to represent the outer element.

#[derive(Debug, Deserialize, Default)]
struct AuthorList {
    #[serde(rename = "author", default)]
    items: Vec<String>,
}

#[derive(Debug, Deserialize, Default)]
struct TranslatorList {
    #[serde(rename = "translator", default)]
    items: Vec<String>,
}

#[derive(Debug, Deserialize, Default)]
struct GenreList {
    #[serde(rename = "genre", default)]
    items: Vec<String>,
}

#[derive(Debug, Deserialize, Default)]
struct KeywordList {
    #[serde(rename = "keyword", default)]
    items: Vec<String>,
}

#[derive(Debug, Deserialize, Default)]
struct TellicoDate {
    #[serde(default)]
    year: String,
    #[serde(default)]
    month: String,
    #[serde(default)]
    day: String,
}

// ─── BookDoc ──────────────────────────────────────────────────────────────────
//
// `Option<T>` fields serialise to JSON null when None, and to the value when
// Some. This matches the Go `*T` pointer pattern.

#[derive(Debug, Serialize)]
pub struct BookDoc {
    pub id: i64,
    pub title: Option<String>,
    #[serde(rename = "titleOrig")]
    pub title_orig: Option<String>,
    pub series: Option<String>,
    pub volume: Option<f64>,
    pub authors: Vec<String>,
    pub editor: Option<String>,
    pub publisher: Option<String>,
    pub pub_year: Option<i64>,
    pub isbn: Option<String>,
    pub translators: Vec<String>,
    pub genres: Vec<String>,
    pub keywords: Vec<String>,
    pub rating: Option<f64>,
    #[serde(rename = "readersNum")]
    pub readers_num: Option<i64>,
    pub cover: Option<String>,
    pub cover_url: Option<String>,
    pub comments: Option<String>,
    pub url: Option<String>,
    pub cdate: Option<String>,
    pub mdate: Option<String>,
}

// ─── Parsing helpers ──────────────────────────────────────────────────────────

fn opt_str(s: &str) -> Option<String> {
    let t = s.trim();
    if t.is_empty() { None } else { Some(t.to_owned()) }
}

fn opt_f64(s: &str) -> Option<f64> {
    let t = s.trim();
    if t.is_empty() { return None; }
    t.parse().ok()
}

fn opt_i64(s: &str) -> Option<i64> {
    let t = s.trim();
    if t.is_empty() { return None; }
    t.parse().ok()
}

fn filter_empty(v: Vec<String>) -> Vec<String> {
    v.into_iter().filter(|s| !s.trim().is_empty()).collect()
}

fn parse_date(d: &TellicoDate) -> Option<String> {
    let y = d.year.trim();
    if y.is_empty() {
        return None;
    }
    let m = d.month.trim();
    let day = d.day.trim();
    let m = if m.len() == 1 { format!("0{m}") } else if m.is_empty() { "01".into() } else { m.to_owned() };
    let day = if day.len() == 1 { format!("0{day}") } else if day.is_empty() { "01".into() } else { day.to_owned() };
    Some(format!("{y}-{m}-{day}"))
}

// ─── ES index management ──────────────────────────────────────────────────────

async fn index_exists(client: &Client, es_url: &str) -> Result<bool> {
    let url = format!("{es_url}/{INDEX}");
    let resp = client
        .head(&url)
        .send()
        .await
        .context("HEAD index request failed")?;
    Ok(resp.status().as_u16() == 200)
}

async fn delete_index(client: &Client, es_url: &str) -> Result<()> {
    let url = format!("{es_url}/{INDEX}");
    let (status, body) = es_json(client, Method::DELETE, &url, None).await?;
    if status >= 400 {
        return Err(anyhow!("delete index: HTTP {status}: {body}"));
    }
    Ok(())
}

async fn create_index(client: &Client, es_url: &str) -> Result<()> {
    let mapping = json!({
        "settings": {
            "analysis": {
                "analyzer": {
                    "text_analyzer": {
                        "type": "custom",
                        "tokenizer": "standard",
                        "filter": ["lowercase", "asciifolding"]
                    }
                }
            },
            "number_of_shards": 1,
            "number_of_replicas": 0
        },
        "mappings": {
            "properties": {
                "id":          { "type": "integer" },
                "title":       { "type": "text", "analyzer": "text_analyzer", "fields": { "keyword": { "type": "keyword" } } },
                "titleOrig":   { "type": "text", "analyzer": "text_analyzer", "fields": { "keyword": { "type": "keyword" } } },
                "series":      { "type": "text", "analyzer": "text_analyzer", "fields": { "keyword": { "type": "keyword" } } },
                "volume":      { "type": "float" },
                "authors":     { "type": "text", "analyzer": "text_analyzer", "fields": { "keyword": { "type": "keyword" } } },
                "editor":      { "type": "text", "analyzer": "text_analyzer", "fields": { "keyword": { "type": "keyword" } } },
                "publisher":   { "type": "text", "analyzer": "text_analyzer", "fields": { "keyword": { "type": "keyword" } } },
                "pub_year":    { "type": "integer" },
                "isbn":        { "type": "keyword" },
                "translators": { "type": "text", "analyzer": "text_analyzer", "fields": { "keyword": { "type": "keyword" } } },
                "genres":      { "type": "text", "analyzer": "text_analyzer", "fields": { "keyword": { "type": "keyword" } } },
                "keywords":    { "type": "text", "analyzer": "text_analyzer", "fields": { "keyword": { "type": "keyword" } } },
                "rating":      { "type": "float" },
                "readersNum":  { "type": "integer" },
                "cover":       { "type": "keyword" },
                "cover_url":   { "type": "keyword", "index": false },
                "comments":    { "type": "text", "analyzer": "text_analyzer" },
                "url":         { "type": "keyword", "index": false },
                "cdate":       { "type": "date", "format": "yyyy-MM-dd" },
                "mdate":       { "type": "date", "format": "yyyy-MM-dd" }
            }
        }
    });

    let url = format!("{es_url}/{INDEX}");
    let (status, body) = es_json(client, Method::PUT, &url, Some(&mapping)).await?;
    if status >= 400 {
        return Err(anyhow!("create index: HTTP {status}: {body}"));
    }
    Ok(())
}

async fn refresh_index(client: &Client, es_url: &str) -> Result<()> {
    let url = format!("{es_url}/{INDEX}/_refresh");
    es_json(client, Method::POST, &url, None).await?;
    Ok(())
}

// ─── Histogram bounds ─────────────────────────────────────────────────────────

/// Round n up to a "nice" number for use as a histogram upper bound.
/// E.g. 123456 → 200000, 45000 → 50000, 8200 → 10000.
fn round_up_nice(n: i64) -> i64 {
    if n <= 0 { return 1000; }
    let mut magnitude = 1i64;
    while magnitude * 10 <= n {
        magnitude *= 10;
    }
    ((n + magnitude - 1) / magnitude) * magnitude
}

/// Query the actual max of readersNum and cdate range, round up, and store in books_meta.
async fn compute_and_store_hist_bounds(client: &Client, es_url: &str) {
    let url = format!("{es_url}/{INDEX}/_search");
    let body = json!({
        "size": 0,
        "aggs": {
            "readers_max": { "max": { "field": "readersNum" } },
            "cdate_min":   { "min": { "field": "cdate" } },
            "cdate_max":   { "max": { "field": "cdate" } }
        }
    });
    let (_, result) = match es_json(client, Method::POST, &url, Some(&body)).await {
        Ok(r) => r,
        Err(e) => { warn!("Could not query hist bounds: {e}"); return; }
    };

    let readers_max = result["aggregations"]["readers_max"]["value"]
        .as_f64()
        .map(|v| round_up_nice(v as i64))
        .unwrap_or(100_000);

    // ES returns date stats as "value_as_string" in yyyy-MM-dd format
    let cdate_min = result["aggregations"]["cdate_min"]["value_as_string"]
        .as_str()
        .and_then(|s| if s.len() >= 4 { Some(format!("{}-01-01", &s[..4])) } else { None })
        .unwrap_or_else(|| "2000-01-01".into());

    let cdate_max = result["aggregations"]["cdate_max"]["value_as_string"]
        .as_str()
        .and_then(|s| if s.len() >= 4 { s[..4].parse::<i64>().ok() } else { None })
        .map(|y| format!("{}-01-01", y + 1))
        .unwrap_or_else(|| "2030-01-01".into());

    info!("Histogram bounds: readersNum max={readers_max}, cdate {cdate_min}–{cdate_max}");

    let store_url = format!("{es_url}/{}/_doc/{}", crate::es::META_INDEX, crate::es::META_ID);
    let doc = json!({
        "readersNum_max": readers_max,
        "cdate_min": cdate_min,
        "cdate_max": cdate_max
    });
    if let Err(e) = es_json(client, Method::PUT, &store_url, Some(&doc)).await {
        warn!("Could not store hist bounds: {e}");
    }
}

// ─── Bulk indexing ────────────────────────────────────────────────────────────

/// Build an NDJSON bulk payload and send it to ES.
///
/// The ES bulk API requires alternating lines:
///   {"index":{"_index":"books","_id":"1"}}
///   {"id":1,"title":"..."}
///
/// Each line must be terminated with a newline. The Content-Type must be
/// `application/x-ndjson` — using `application/json` causes a 400 error.
async fn bulk_index(client: &Client, es_url: &str, docs: &[BookDoc]) -> Result<()> {
    let mut buf = Vec::new();
    for doc in docs {
        let meta = json!({
            "index": { "_index": INDEX, "_id": doc.id.to_string() }
        });
        serde_json::to_writer(&mut buf, &meta)?;
        buf.push(b'\n');
        serde_json::to_writer(&mut buf, doc)?;
        buf.push(b'\n');
    }

    let url = format!("{es_url}/_bulk");
    let (_, result) = es_raw(client, Method::POST, &url, "application/x-ndjson", buf).await?;

    if result["errors"].as_bool().unwrap_or(false) {
        let empty = vec![];
        let reasons: Vec<&str> = result["items"]
            .as_array()
            .unwrap_or(&empty)
            .iter()
            .filter_map(|item| {
                item.as_object()?.values().next()?.get("error")?.get("reason")?.as_str()
            })
            .take(3)
            .collect();
        warn!("Bulk errors (first {}): {:?}", reasons.len(), reasons);
    }
    Ok(())
}

// ─── Main import logic ────────────────────────────────────────────────────────

pub async fn run_import(config: &Config) -> Result<()> {
    let client = crate::es::build_http_client();

    wait_for_es_import(&client, &config.es_url).await?;

    // ── Index setup ──────────────────────────────────────────────────────────
    if index_exists(&client, &config.es_url).await? {
        info!("Index {:?} already exists, deleting...", INDEX);
        delete_index(&client, &config.es_url).await?;
    }
    create_index(&client, &config.es_url).await?;
    info!("Index {:?} created", INDEX);

    // ── Load covers map ──────────────────────────────────────────────────────
    let covers: std::collections::HashMap<String, String> =
        match std::fs::read_to_string(&config.covers_json) {
            Ok(data) => serde_json::from_str(&data).unwrap_or_else(|e| {
                warn!("Could not parse covers JSON: {e}");
                Default::default()
            }),
            Err(e) => {
                warn!("Could not load covers JSON: {e}");
                Default::default()
            }
        };
    info!("Loaded {} cover mappings", covers.len());

    // ── Parse XML ────────────────────────────────────────────────────────────
    info!("Reading {}...", config.tellico_file);
    let xml_data = std::fs::read_to_string(&config.tellico_file)
        .with_context(|| format!("reading {}", config.tellico_file))?;

    let doc: TellicoDoc = quick_xml::de::from_str(&xml_data)
        .context("parsing Tellico XML")?;

    let entries = doc.collection.entries;
    info!("Found {} entries", entries.len());

    // ── Bulk index in batches ────────────────────────────────────────────────
    const BATCH_SIZE: usize = 500;
    let total = entries.len();
    let mut indexed = 0usize;

    for chunk in entries.chunks(BATCH_SIZE) {
        let docs: Vec<BookDoc> = chunk
            .iter()
            .map(|e| {
                let doc = parse_entry_ref(e, &covers);
                debug!(
                    id = doc.id,
                    title = ?doc.title,
                    authors = ?doc.authors,
                    "parsed entry"
                );
                doc
            })
            .collect();

        debug!(batch_docs = docs.len(), "bulk sending batch");
        bulk_index(&client, &config.es_url, &docs).await?;
        indexed += chunk.len();
        info!("Indexed {indexed}/{total}");
    }

    if let Err(e) = refresh_index(&client, &config.es_url).await {
        warn!("Refresh failed: {e}");
    }
    compute_and_store_hist_bounds(&client, &config.es_url).await;
    info!("Import complete!");
    Ok(())
}

/// Parse a `TellicoEntry` reference into a `BookDoc` by cloning fields.
/// This avoids consuming the entry so we can iterate over a slice.
fn parse_entry_ref(
    e: &TellicoEntry,
    covers: &std::collections::HashMap<String, String>,
) -> BookDoc {
    let id: i64 = e.id.trim().parse().unwrap_or(0);
    // Rating stored as-is from Tellico (integer * 100, e.g. 889 = 8.89 stars).
    // Frontend divides by 100 for display.
    let rating = opt_f64(&e.rating);
    let cover = opt_str(&e.cover);
    let cover_url = cover
        .as_deref()
        .and_then(|f| covers.get(f))
        .filter(|u| !u.is_empty())
        .cloned();

    BookDoc {
        id,
        title: opt_str(&e.title),
        title_orig: opt_str(&e.title_orig),
        series: opt_str(&e.series),
        volume: opt_f64(&e.volume),
        authors: filter_empty(e.authors.items.clone()),
        editor: opt_str(&e.editor),
        publisher: opt_str(&e.publisher),
        pub_year: opt_i64(&e.pub_year),
        isbn: opt_str(&e.isbn),
        translators: filter_empty(e.translators.items.clone()),
        genres: filter_empty(e.genres.items.clone()),
        keywords: filter_empty(e.keywords.items.clone()),
        rating,
        readers_num: opt_i64(&e.readers_num),
        cover,
        cover_url,
        comments: opt_str(&e.comments),
        url: opt_str(&e.url),
        cdate: parse_date(&e.cdate),
        mdate: parse_date(&e.mdate),
    }
}
