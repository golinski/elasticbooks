/// Thin Elasticsearch client built on top of `reqwest`.
///
/// We deliberately avoid the official ES Rust client to keep dependencies
/// minimal and the image small. All we need is JSON over HTTP.
use anyhow::{anyhow, Context, Result};
use reqwest::Client;
use serde_json::Value;
use std::time::Duration;
use tracing::{debug, info, warn};

pub const INDEX: &str = "books";

/// Shared HTTP client. `reqwest::Client` is cheap to clone (it holds an `Arc`
/// internally) so we pass it around by value.
pub fn build_http_client() -> Client {
    Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .expect("failed to build HTTP client")
}

/// Ping ES by hitting `GET /`. Returns Ok(()) when ES responds with 2xx.
pub async fn ping(client: &Client, es_url: &str) -> Result<()> {
    let resp = client
        .get(es_url)
        .send()
        .await
        .context("ES ping: connection failed")?;
    if resp.status().is_success() {
        Ok(())
    } else {
        Err(anyhow!("ES ping: HTTP {}", resp.status()))
    }
}

/// Retry loop used by the server (non-fatal: logs and continues).
/// Runs in a background task so the HTTP server starts immediately.
pub async fn wait_for_es_server(client: Client, es_url: String) {
    const MAX: u32 = 40;
    const INTERVAL: Duration = Duration::from_secs(3);
    for attempt in 1..=MAX {
        if ping(&client, &es_url).await.is_ok() {
            info!("Elasticsearch ready (attempt {attempt})");
            return;
        }
        warn!("Waiting for Elasticsearch… ({attempt}/{MAX})");
        tokio::time::sleep(INTERVAL).await;
    }
    warn!("Elasticsearch did not become ready in time — requests will fail until it does.");
}

/// Retry loop used by the importer (fatal: returns Err after exhausting retries).
pub async fn wait_for_es_import(client: &Client, es_url: &str) -> Result<()> {
    const MAX: u32 = 30;
    const INTERVAL: Duration = Duration::from_secs(2);
    for attempt in 1..=MAX {
        if ping(client, es_url).await.is_ok() {
            info!("Elasticsearch is ready (attempt {attempt})");
            return Ok(());
        }
        warn!("Waiting for Elasticsearch... ({attempt}/{MAX})");
        tokio::time::sleep(INTERVAL).await;
    }
    Err(anyhow!("Elasticsearch not reachable after {MAX} attempts"))
}

/// Send a JSON request to ES and return the parsed response body.
/// Used by the importer for index management calls.
pub async fn es_json(
    client: &Client,
    method: reqwest::Method,
    url: &str,
    body: Option<&Value>,
) -> Result<(u16, Value)> {
    let mut req = client.request(method.clone(), url);
    if let Some(b) = body {
        debug!(method = %method, url, body = %b, "ES →");
        req = req.json(b);
    } else {
        debug!(method = %method, url, "ES →");
    }
    let resp = req.send().await.context("ES request failed")?;
    let status = resp.status().as_u16();
    let json: Value = resp.json().await.context("ES response not valid JSON")?;
    // Truncate large responses in the log (e.g. full search results).
    if tracing::enabled!(tracing::Level::DEBUG) {
        let s = json.to_string();
        let preview = if s.len() > 2000 { &s[..2000] } else { &s };
        debug!(status, body = preview, "ES ←");
    }
    Ok((status, json))
}

/// Send a raw bytes body (used for NDJSON bulk requests).
pub async fn es_raw(
    client: &Client,
    method: reqwest::Method,
    url: &str,
    content_type: &str,
    body: Vec<u8>,
) -> Result<(u16, Value)> {
    debug!(method = %method, url, content_type, payload_bytes = body.len(), "ES → (raw)");
    let resp = client
        .request(method, url)
        .header("Content-Type", content_type)
        .body(body)
        .send()
        .await
        .context("ES raw request failed")?;
    let status = resp.status().as_u16();
    let json: Value = resp.json().await.context("ES response not valid JSON")?;
    debug!(status, "ES ← (raw)");
    Ok((status, json))
}
