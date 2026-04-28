/// Runtime configuration read from environment variables.
/// All fields are read once at startup; changing env vars after launch has no effect.
#[derive(Clone, Debug)]
pub struct Config {
    /// TCP port the HTTP server listens on. Default: 3001.
    pub port: u16,
    /// Base URL of the Elasticsearch node. Default: http://localhost:9200.
    pub es_url: String,
    /// Allowed CORS origins. Empty = allow all (permissive, good for local dev).
    pub allowed_origins: Vec<String>,
    /// Path to the Tellico XML file (importer only).
    pub tellico_file: String,
    /// Path to the covers JSON file (importer only).
    pub covers_json: String,
}

impl Config {
    pub fn from_env() -> Self {
        Self {
            port: env_var("PORT", "3001")
                .parse()
                .expect("PORT must be a valid port number"),
            es_url: env_var("ELASTICSEARCH_URL", "http://localhost:9200"),
            allowed_origins: parse_origins(&env_var("ALLOWED_ORIGINS", "")),
            tellico_file: env_var("TELLICO_FILE", "../data/collection.tc"),
            covers_json: env_var("COVERS_JSON", "../data/covers.json"),
        }
    }
}

fn env_var(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_owned())
}

fn parse_origins(s: &str) -> Vec<String> {
    s.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}
