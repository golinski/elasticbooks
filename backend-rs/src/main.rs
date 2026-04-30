/// Bookshelf backend — Rust edition.
///
/// Single binary, two modes:
///   - Default:   HTTP server (axum + tokio)
///   - IMPORT=1:  Data importer (parse Tellico XML → bulk-index into ES)
mod config;
mod es;
mod handlers;
mod importer;
mod query;

use axum::{
    routing::get,
    Router,
};
use std::net::SocketAddr;
use tokio::net::TcpListener;
use tower_http::cors::{AllowOrigin, CorsLayer};
use axum::http::{HeaderValue, Method};
use tracing::info;
use tracing_subscriber::{fmt, EnvFilter};

pub use config::Config;
pub use es::{build_http_client, HistBounds};

/// Shared state injected into every handler by axum's `State` extractor.
#[derive(Clone)]
pub struct AppState {
    pub config: Config,
    pub client: reqwest::Client,
    pub hist_bounds: HistBounds,
}

#[tokio::main]
async fn main() {
    // If DEBUG is set, force RUST_LOG=debug regardless of what it was before.
    // This makes `DEBUG=1 ./bookshelf` produce verbose output without needing
    // to know about RUST_LOG.
    if std::env::var("DEBUG").is_ok_and(|v| !v.is_empty()) {
        // Only override if not already set to something more specific.
        if std::env::var("RUST_LOG").is_err() {
            std::env::set_var("RUST_LOG", "debug");
        }
    }

    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(
            EnvFilter::try_from_env("RUST_LOG").unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let config = Config::from_env();

    // ── Import mode ───────────────────────────────────────────────────────────
    if std::env::var("IMPORT").as_deref() == Ok("1") {
        if let Err(e) = importer::run_import(&config).await {
            eprintln!("Import failed: {e:?}");
            std::process::exit(1);
        }
        return;
    }

    // ── Server mode ───────────────────────────────────────────────────────────
    let client = build_http_client();

    // Probe ES in the background — the HTTP server starts immediately.
    tokio::spawn(es::wait_for_es_server(client.clone(), config.es_url.clone()));

    // Load histogram bounds (best-effort; uses defaults if not yet populated).
    let hist_bounds = es::load_hist_bounds(&client, &config.es_url).await;
    tracing::info!(readers_num_max = hist_bounds.readers_num_max, "Histogram bounds loaded");

    let state = AppState {
        config: config.clone(),
        client,
        hist_bounds,
    };

    // Build CORS layer.
    // If allowed_origins is empty, allow any origin (permissive / local dev).
    // Otherwise restrict to the listed origins.
    let cors = if config.allowed_origins.is_empty() {
        CorsLayer::permissive()
    } else {
        let origins: Vec<HeaderValue> = config
            .allowed_origins
            .iter()
            .filter_map(|o| o.parse().ok())
            .collect();
        CorsLayer::new()
            .allow_origin(AllowOrigin::list(origins))
            .allow_methods([Method::GET])
    };

    let app = Router::new()
        .route("/api/health",     get(handlers::handle_health))
        .route("/api/books",      get(handlers::handle_books))
        .route("/api/books/:id",  get(handlers::handle_book_by_id))
        .route("/api/stats",      get(handlers::handle_stats))
        .layer(cors)
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], config.port));
    info!("Backend running on {addr}");

    let listener = TcpListener::bind(addr).await.expect("failed to bind port");
    axum::serve(listener, app).await.expect("server error");
}
