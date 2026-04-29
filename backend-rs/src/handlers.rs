/// HTTP route handlers.
///
/// Each handler receives the shared `AppState` (config + HTTP client),
/// extracts parameters from the request, calls ES, and returns JSON.
///
/// Axum handlers are async functions. They return `impl IntoResponse`, which
/// axum converts into an HTTP response. We use `Json(value)` for success and
/// a plain tuple `(StatusCode, Json(value))` for errors.
use axum::{
    extract::{Path, RawQuery, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use reqwest::Method;
use serde_json::{json, Value};
use tracing::{debug, error};

use crate::{
    es::{es_json, INDEX},
    query::{build_filters, build_filters_excluding, build_sort, get_one, hist_interval, parse_multi},
    AppState,
};

// ─── Error helper ─────────────────────────────────────────────────────────────

/// Convert any error into a JSON 500 response and log it.
/// The `?` operator in handlers propagates `AppError` automatically.
pub struct AppError(anyhow::Error);

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        error!("handler error: {:?}", self.0);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": self.0.to_string() })),
        )
            .into_response()
    }
}

impl<E: Into<anyhow::Error>> From<E> for AppError {
    fn from(e: E) -> Self {
        AppError(e.into())
    }
}

type Result<T> = std::result::Result<T, AppError>;

// ─── GET /api/health ──────────────────────────────────────────────────────────

pub async fn handle_health(State(state): State<AppState>) -> Result<impl IntoResponse> {
    let url = format!("{}/{}", state.config.es_url, "_cluster/health");
    let (status, body) = es_json(&state.client, Method::GET, &url, None).await?;
    if status >= 400 {
        return Ok((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "status": "error", "message": body })),
        )
            .into_response());
    }
    let es_status = body.get("status").cloned().unwrap_or(Value::Null);
    Ok(Json(json!({ "status": "ok", "es": es_status })).into_response())
}

// ─── GET /api/books ───────────────────────────────────────────────────────────

pub async fn handle_books(
    State(state): State<AppState>,
    RawQuery(raw_query): RawQuery,
) -> Result<impl IntoResponse> {
    let params = parse_multi(raw_query.as_deref());

    let page: usize = get_one(&params, "page").parse().unwrap_or(1).max(1);
    let size: usize = get_one(&params, "size").parse().unwrap_or(40).max(1);
    let from = (page - 1) * size;
    let sort_by = get_one(&params, "sort");
    let sort_by = if sort_by.is_empty() { "title" } else { sort_by };
    let sort_dir = get_one(&params, "dir");
    let sort_dir = if sort_dir.is_empty() { "asc" } else { sort_dir };

    debug!(
        raw_query = raw_query.as_deref().unwrap_or(""),
        page, size, from, sort_by, sort_dir,
        "→ GET /api/books"
    );

    let hist_buckets: usize = get_one(&params, "hist_buckets").parse().unwrap_or(30).max(5).min(200);

    let rating_interval    = hist_interval("rating",    hist_buckets);
    let rating_num_interval = hist_interval("ratingNum", hist_buckets);

    let body = json!({
        "from": from,
        "size": size,
        "query": build_filters(&params),
        "sort": build_sort(sort_by, sort_dir),
        "aggs": {
            "authors":    { "terms": { "field": "authors.keyword",   "size": 30, "min_doc_count": 1 } },
            "series":     { "terms": { "field": "series.keyword",    "size": 30, "min_doc_count": 1 } },
            "genres":     { "terms": { "field": "genres.keyword",    "size": 30, "min_doc_count": 1 } },
            "publishers": { "terms": { "field": "publisher.keyword", "size": 20, "min_doc_count": 1 } },
            "pub_years":  { "terms": { "field": "pub_year",          "size": 50, "order": { "_key": "asc" } } },
            "keywords":   { "terms": { "field": "keywords.keyword",  "size": 30, "min_doc_count": 1 } },
            // Each histogram is wrapped in a filter that excludes its own range,
            // so the histogram shape stays stable while the user drags the handles.
            "rating_hist": {
                "filter": build_filters_excluding(&params, &["rating_from", "rating_to"]),
                "aggs": { "hist": { "histogram": { "field": "rating", "interval": rating_interval, "min_doc_count": 1 } } }
            },
            "rating_num_hist": {
                "filter": build_filters_excluding(&params, &["rating_num_from", "rating_num_to"]),
                "aggs": { "hist": { "histogram": { "field": "readersNum", "interval": rating_num_interval, "min_doc_count": 1 } } }
            },
            "cdate_hist": {
                "filter": build_filters_excluding(&params, &["cdate_from", "cdate_to"]),
                "aggs": { "hist": { "date_histogram": { "field": "cdate", "calendar_interval": "year", "min_doc_count": 1 } } }
            }
        }
    });

    let url = format!("{}/{}/_search", state.config.es_url, INDEX);
    let (_, mut es_resp) = es_json(&state.client, Method::POST, &url, Some(&body)).await?;

    let total = es_resp["hits"]["total"]["value"]
        .as_i64()
        .unwrap_or(0);

    // Inject _score into each _source document
    let books: Vec<Value> = es_resp["hits"]["hits"]
        .as_array_mut()
        .map(|hits| {
            hits.iter_mut()
                .map(|hit| {
                    let score = hit["_score"].clone();
                    let mut doc = hit["_source"].take();
                    doc["_score"] = score;
                    doc
                })
                .collect()
        })
        .unwrap_or_default();

    let aggs = &es_resp["aggregations"];
    debug!(total, returned = books.len(), "← /api/books");

    Ok(Json(json!({
        "total": total,
        "page":  page,
        "size":  size,
        "books": books,
        "facets": {
            "authors":         agg_buckets(aggs, "authors"),
            "series":          agg_buckets(aggs, "series"),
            "genres":          agg_buckets(aggs, "genres"),
            "publishers":      agg_buckets(aggs, "publishers"),
            "pub_years":       agg_buckets(aggs, "pub_years"),
            "keywords":        agg_buckets(aggs, "keywords"),
            "rating_hist":     nested_agg_buckets(aggs, "rating_hist",     "hist"),
            "rating_num_hist": nested_agg_buckets(aggs, "rating_num_hist", "hist"),
            "cdate_hist":      nested_agg_buckets(aggs, "cdate_hist",      "hist"),
        }
    }))
    .into_response())
}

// ─── GET /api/books/:id ───────────────────────────────────────────────────────

pub async fn handle_book_by_id(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse> {
    debug!(id, "→ GET /api/books/:id");
    let url = format!("{}/{}/_doc/{}", state.config.es_url, INDEX, id);
    let (status, body) = es_json(&state.client, Method::GET, &url, None).await?;
    if status == 404 {
        return Ok((
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Not found" })),
        )
            .into_response());
    }
    let source = body["_source"].clone();
    Ok(Json(source).into_response())
}

// ─── GET /api/stats ───────────────────────────────────────────────────────────

pub async fn handle_stats(State(state): State<AppState>) -> Result<impl IntoResponse> {
    debug!("→ GET /api/stats");
    let body = json!({
        "size": 0,
        "aggs": {
            "top_authors": { "terms": { "field": "authors.keyword", "size": 10 } },
            "top_series":  { "terms": { "field": "series.keyword",  "size": 10 } },
            "top_genres":  { "terms": { "field": "genres.keyword",  "size": 10 } },
            "years":       { "stats": { "field": "pub_year" } }
        }
    });

    let url = format!("{}/{}/_search", state.config.es_url, INDEX);
    let (_, es_resp) = es_json(&state.client, Method::POST, &url, Some(&body)).await?;

    let total = es_resp["hits"]["total"]["value"].as_i64().unwrap_or(0);
    let aggs = &es_resp["aggregations"];
    let years = &aggs["years"];

    Ok(Json(json!({
        "total":       total,
        "top_authors": agg_buckets(aggs, "top_authors"),
        "top_series":  agg_buckets(aggs, "top_series"),
        "top_genres":  agg_buckets(aggs, "top_genres"),
        "year_stats": {
            "min":   years["min"],
            "max":   years["max"],
            "avg":   years["avg"],
            "count": years["count"]
        }
    }))
    .into_response())
}

// ─── Helper ───────────────────────────────────────────────────────────────────

/// Extract the `buckets` array from an aggregation by name.
fn agg_buckets<'a>(aggs: &'a Value, name: &str) -> &'a Value {
    aggs.get(name)
        .and_then(|a| a.get("buckets"))
        .unwrap_or(&Value::Null)
}

/// Extract buckets from a filter-wrapped histogram agg.
/// ES shape: aggs[outer] = { doc_count, [inner]: { buckets: [...] } }
fn nested_agg_buckets<'a>(aggs: &'a Value, outer: &str, inner: &str) -> &'a Value {
    aggs.get(outer)
        .and_then(|o| o.get(inner))
        .and_then(|i| i.get("buckets"))
        .unwrap_or(&Value::Null)
}
