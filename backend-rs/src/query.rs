/// Elasticsearch query and sort builders.
///
/// All functions return `serde_json::Value` (the `json!` macro produces these).
/// This mirrors the Go approach of using `map[string]any` — flexible but not
/// type-checked at compile time. The trade-off is acceptable because the ES
/// query DSL is inherently dynamic.
use serde_json::{json, Value};
use std::collections::HashMap;

/// Multi-value query parameters arrive as repeated keys:
///   ?author_filter=A&author_filter=B
/// axum's `Query<HashMap<String,String>>` only keeps the last value, so we
/// use a raw `axum::extract::RawQuery` and parse manually. This type alias
/// makes the intent clear at the call site.
pub type MultiParams = HashMap<String, Vec<String>>;

/// Parse the raw query string into a map of key → list of values.
pub fn parse_multi(raw: Option<&str>) -> MultiParams {
    let mut map: MultiParams = HashMap::new();
    let Some(qs) = raw else { return map };
    for pair in qs.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        let key = percent_decode(k);
        let val = percent_decode(v);
        map.entry(key).or_default().push(val);
    }
    map
}

/// Percent-decoder for query string values.
/// Handles `+` as space and `%XX` hex sequences, including multi-byte
/// UTF-8 characters encoded as consecutive `%XX%XX...` sequences.
fn percent_decode(s: &str) -> String {
    let mut bytes: Vec<u8> = Vec::with_capacity(s.len());
    let src = s.as_bytes();
    let mut i = 0;
    while i < src.len() {
        if src[i] == b'+' {
            bytes.push(b' ');
            i += 1;
        } else if src[i] == b'%' && i + 2 < src.len() {
            if let Some(byte) = decode_hex(src[i + 1], src[i + 2]) {
                bytes.push(byte);
                i += 3;
            } else {
                bytes.push(b'%');
                i += 1;
            }
        } else {
            bytes.push(src[i]);
            i += 1;
        }
    }
    // from_utf8_lossy handles the case where the bytes are valid UTF-8
    // (the common case) with zero allocation; it only allocates if there
    // are invalid sequences, replacing them with U+FFFD.
    String::from_utf8_lossy(&bytes).into_owned()
}

fn decode_hex(hi: u8, lo: u8) -> Option<u8> {
    let h = (hi as char).to_digit(16)? as u8;
    let l = (lo as char).to_digit(16)? as u8;
    Some((h << 4) | l)
}

/// Convenience: get the first value for a key, or empty string.
pub fn get_one<'a>(params: &'a MultiParams, key: &str) -> &'a str {
    params
        .get(key)
        .and_then(|v| v.first())
        .map(String::as_str)
        .unwrap_or("")
}

/// Build the ES `query` object from HTTP query parameters.
pub fn build_filters(params: &MultiParams) -> Value {
    let mut must: Vec<Value> = Vec::new();
    let mut filters: Vec<Value> = Vec::new();

    // ── Full-text search ──────────────────────────────────────────────────────
    let q = get_one(params, "q");
    if !q.is_empty() {
        must.push(json!({
            "multi_match": {
                "query": q,
                "fields": [
                    "title^3", "titleOrig^2", "authors^2", "series^2",
                    "comments", "genres", "keywords", "publisher", "translators"
                ],
                "type": "best_fields",
                "fuzziness": "AUTO"
            }
        }));
    }

    // ── Field-specific prefix searches ────────────────────────────────────────
    let field_map: &[(&str, &str)] = &[
        ("title", "title"),
        ("author", "authors"),
        ("series", "series"),
        ("genre", "genres"),
        ("keyword", "keywords"),
        ("publisher", "publisher"),
        ("tag", "keywords"),
    ];
    for &(param, field) in field_map {
        let v = get_one(params, param);
        if !v.is_empty() {
            must.push(json!({
                "match_phrase_prefix": {
                    field: { "query": v, "max_expansions": 50 }
                }
            }));
        }
    }

    // ── Facet filters ─────────────────────────────────────────────────────────
    let facet_map: &[(&str, &str)] = &[
        ("author_filter", "authors.keyword"),
        ("series_filter", "series.keyword"),
        ("genre_filter", "genres.keyword"),
        ("publisher_filter", "publisher.keyword"),
        ("keyword_filter", "keywords.keyword"),
    ];
    for &(param, kw_field) in facet_map {
        let vals = params.get(param).map(Vec::as_slice).unwrap_or(&[]);
        if vals.is_empty() {
            continue;
        }
        let clauses: Vec<Value> = vals
            .iter()
            .map(|v| json!({ "prefix": { kw_field: { "value": v } } }))
            .collect();
        if clauses.len() == 1 {
            filters.push(clauses.into_iter().next().unwrap());
        } else {
            filters.push(json!({
                "bool": { "should": clauses, "minimum_should_match": 1 }
            }));
        }
    }

    // ── Year exact filter ─────────────────────────────────────────────────────
    let year_vals: Vec<i64> = params
        .get("year_filter")
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter_map(|v| v.parse().ok())
        .collect();
    if !year_vals.is_empty() {
        filters.push(json!({ "terms": { "pub_year": year_vals } }));
    }

    // ── Year range ────────────────────────────────────────────────────────────
    let year_from = get_one(params, "year_from");
    let year_to = get_one(params, "year_to");
    if !year_from.is_empty() || !year_to.is_empty() {
        let mut rng = serde_json::Map::new();
        if let Ok(n) = year_from.parse::<i64>() {
            rng.insert("gte".into(), json!(n));
        }
        if let Ok(n) = year_to.parse::<i64>() {
            rng.insert("lte".into(), json!(n));
        }
        if !rng.is_empty() {
            filters.push(json!({ "range": { "pub_year": rng } }));
        }
    }

    // ── Rating range (user enters display-scale 0–10; ES stores rating as 0–1000, so multiply by 10) ──
    let rating_from = get_one(params, "rating_from");
    let rating_to   = get_one(params, "rating_to");
    if !rating_from.is_empty() || !rating_to.is_empty() {
        let mut rng = serde_json::Map::new();
        if let Ok(f) = rating_from.parse::<f64>() {
            rng.insert("gte".into(), json!(f * 10.0));
        }
        if let Ok(f) = rating_to.parse::<f64>() {
            rng.insert("lte".into(), json!(f * 10.0));
        }
        if !rng.is_empty() {
            filters.push(json!({ "range": { "rating": rng } }));
        }
    }

    // ── Number-of-ratings range ───────────────────────────────────────────────
    let rn_from = get_one(params, "rating_num_from");
    let rn_to   = get_one(params, "rating_num_to");
    if !rn_from.is_empty() || !rn_to.is_empty() {
        let mut rng = serde_json::Map::new();
        if let Ok(n) = rn_from.parse::<i64>() {
            rng.insert("gte".into(), json!(n));
        }
        if let Ok(n) = rn_to.parse::<i64>() {
            rng.insert("lte".into(), json!(n));
        }
        if !rng.is_empty() {
            filters.push(json!({ "range": { "ratingNum": rng } }));
        }
    }

    // ── Date-added year range ─────────────────────────────────────────────────
    let cd_from = get_one(params, "cdate_from");
    let cd_to   = get_one(params, "cdate_to");
    if !cd_from.is_empty() || !cd_to.is_empty() {
        let mut rng = serde_json::Map::new();
        if !cd_from.is_empty() {
            rng.insert("gte".into(), json!(format!("{cd_from}-01-01")));
        }
        if !cd_to.is_empty() {
            rng.insert("lte".into(), json!(format!("{cd_to}-12-31")));
        }
        if !rng.is_empty() {
            filters.push(json!({ "range": { "cdate": rng } }));
        }
    }

    // ── Assemble bool query ───────────────────────────────────────────────────
    if must.is_empty() && filters.is_empty() {
        return json!({ "match_all": {} });
    }
    let mut bool_clause = serde_json::Map::new();
    if !must.is_empty() {
        bool_clause.insert("must".into(), json!(must));
    }
    if !filters.is_empty() {
        bool_clause.insert("filter".into(), json!(filters));
    }
    json!({ "bool": bool_clause })
}

/// Build the ES `query` object from HTTP query parameters,
/// optionally excluding specific range keys (used for self-excluding histogram aggs).
pub fn build_filters_excluding(params: &MultiParams, exclude: &[&str]) -> Value {
    if exclude.is_empty() {
        return build_filters(params);
    }
    let mut filtered = params.clone();
    for key in exclude {
        filtered.remove(*key);
    }
    build_filters(&filtered)
}

/// Compute a sensible histogram interval for a given field and bucket count.
pub fn hist_interval(field: &str, buckets: usize) -> f64 {
    let b = buckets.max(1) as f64;
    match field {
        "rating"    => (1000.0 / b).max(1.0),
        "ratingNum" => {
            // Pick a round interval targeting ~buckets bars across 0–200k
            let target = (200_000.0 / b) as i64;
            let candidates = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000];
            *candidates.iter().find(|&&c| c >= target).unwrap_or(&25000) as f64
        }
        _ => 1.0,
    }
}

/// Build the ES `sort` array from sort field and direction strings.
pub fn build_sort(sort_by: &str, sort_dir: &str) -> Value {
    let dir = if sort_dir == "desc" { "desc" } else { "asc" };
    match sort_by {
        "title" => json!([{ "title.keyword": { "order": dir } }]),
        "author" => json!([{ "authors.keyword": { "order": dir } }]),
        "pub_year" => json!([{ "pub_year": { "order": dir } }]),
        "rating" => json!([{ "rating": { "order": dir, "missing": "_last" } }]),
        "series" => json!([
            { "series.keyword": { "order": dir, "missing": "_last" } },
            { "volume": { "order": "asc", "missing": "_last" } }
        ]),
        "cdate" => json!([{ "cdate": { "order": dir } }]),
        "score" => json!([
            { "_score": { "order": dir } },
            { "title.keyword": { "order": "asc" } }
        ]),
        "popularity" => json!([{ "ratingNum": { "order": dir, "missing": "_last" } }]),
        _ => json!([
            { "_score": { "order": "desc" } },
            { "title.keyword": { "order": "asc" } }
        ]),
    }
}
