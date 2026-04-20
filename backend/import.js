import { Client } from "@elastic/elasticsearch";
import { XMLParser } from "fast-xml-parser";
import { readFileSync } from "fs";
import { resolve } from "path";

const ES_URL = process.env.ELASTICSEARCH_URL || "http://localhost:9200";
const TELLICO_FILE =
  process.env.TELLICO_FILE || resolve("../data/collection.tc");
const COVERS_JSON =
  process.env.COVERS_JSON || resolve("../data/covers.json");

const INDEX = "books";

const client = new Client({ node: ES_URL });

// Wait for ES to be ready
async function waitForES(retries = 30) {
  for (let i = 0; i < retries; i++) {
    try {
      await client.ping();
      console.log("Elasticsearch is ready");
      return;
    } catch {
      console.log(`Waiting for Elasticsearch... (${i + 1}/${retries})`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error("Elasticsearch not reachable");
}

async function createIndex() {
  const exists = await client.indices.exists({ index: INDEX });
  if (exists) {
    console.log(`Index "${INDEX}" already exists, deleting...`);
    await client.indices.delete({ index: INDEX });
  }

  await client.indices.create({
    index: INDEX,
    body: {
      settings: {
        analysis: {
          analyzer: {
            text_analyzer: {
              type: "custom",
              tokenizer: "standard",
              filter: ["lowercase", "asciifolding"],
            },
          },
        },
        number_of_shards: 1,
        number_of_replicas: 0,
      },
      mappings: {
        properties: {
          id: { type: "integer" },
          title: {
            type: "text",
            analyzer: "text_analyzer",
            fields: { keyword: { type: "keyword" } },
          },
          titleOrig: {
            type: "text",
            analyzer: "text_analyzer",
            fields: { keyword: { type: "keyword" } },
          },
          series: {
            type: "text",
            analyzer: "text_analyzer",
            fields: { keyword: { type: "keyword" } },
          },
          volume: { type: "float" },
          authors: {
            type: "text",
            analyzer: "text_analyzer",
            fields: { keyword: { type: "keyword" } },
          },
          editor: {
            type: "text",
            analyzer: "text_analyzer",
            fields: { keyword: { type: "keyword" } },
          },
          publisher: {
            type: "text",
            analyzer: "text_analyzer",
            fields: { keyword: { type: "keyword" } },
          },
          pub_year: { type: "integer" },
          isbn: { type: "keyword" },
          translators: {
            type: "text",
            analyzer: "text_analyzer",
            fields: { keyword: { type: "keyword" } },
          },
          genres: {
            type: "text",
            analyzer: "text_analyzer",
            fields: { keyword: { type: "keyword" } },
          },
          keywords: {
            type: "text",
            analyzer: "text_analyzer",
            fields: { keyword: { type: "keyword" } },
          },
          rating: { type: "float" },
          ratingNum: { type: "integer" },
          cover: { type: "keyword" },
          cover_url: { type: "keyword", index: false },
          comments: { type: "text", analyzer: "text_analyzer" },
          url: { type: "keyword", index: false },
          cdate: { type: "date", format: "yyyy-MM-dd" },
          mdate: { type: "date", format: "yyyy-MM-dd" },
        },
      },
    },
  });
  console.log(`Index "${INDEX}" created`);
}

function parseDate(d) {
  if (!d) return null;
  try {
    const y = d.year;
    const m = String(d.month).padStart(2, "0");
    const day = String(d.day).padStart(2, "0");
    return `${y}-${m}-${day}`;
  } catch {
    return null;
  }
}

function toArray(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  return [val];
}

function parseEntry(entry, coversMap) {
  const authors = toArray(entry.authors?.author).filter(Boolean);
  const translators = toArray(entry.translators?.translator).filter(Boolean);
  const genres = toArray(entry.genres?.genre).filter(Boolean);
  const keywords = toArray(entry.keywords?.keyword).filter(Boolean);

  const coverFile = entry.cover || null;
  let coverUrl = null;
  if (coverFile && coversMap[coverFile]) {
    coverUrl = coversMap[coverFile];
  }

  return {
    id: parseInt(entry["@_id"], 10),
    title: entry.title || null,
    titleOrig: entry.titleOrig || null,
    series: entry.series || null,
    volume: entry.volume != null ? parseFloat(entry.volume) : null,
    authors,
    editor: entry.editor || null,
    publisher: entry.publisher || null,
    pub_year: entry.pub_year ? parseInt(entry.pub_year, 10) : null,
    isbn: entry.isbn || null,
    translators,
    genres,
    keywords,
    rating: entry.rating ? parseFloat(entry.rating) / 10 : null,
    ratingNum: entry.ratingNum ? parseInt(entry.ratingNum, 10) : null,
    cover: coverFile,
    cover_url: coverUrl,
    comments: entry.comments || null,
    url: entry.url || null,
    cdate: parseDate(entry.cdate),
    mdate: parseDate(entry.mdate),
  };
}

async function importData() {
  await waitForES();
  await createIndex();

  console.log(`Reading ${TELLICO_FILE}...`);
  const xml = readFileSync(TELLICO_FILE, "utf-8");

  let coversMap = {};
  try {
    coversMap = JSON.parse(readFileSync(COVERS_JSON, "utf-8"));
    console.log(`Loaded ${Object.keys(coversMap).length} cover mappings`);
  } catch (e) {
    console.warn("Could not load covers JSON:", e.message);
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    htmlEntities: true,
    processEntities: {
      enabled: true,
      maxTotalExpansions: 10000000,
      maxEntityCount: 10000000,
    },
    isArray: (name) =>
      [
        "entry",
        "author",
        "translator",
        "genre",
        "keyword",
        "editor",
      ].includes(name),
  });

  const parsed = parser.parse(xml);
  const entries = parsed?.tellico?.collection?.entry || [];
  console.log(`Found ${entries.length} entries`);

  const BATCH = 500;
  let indexed = 0;

  for (let i = 0; i < entries.length; i += BATCH) {
    const batch = entries.slice(i, i + BATCH);
    const ops = batch.flatMap((e) => [
      { index: { _index: INDEX, _id: String(e["@_id"]) } },
      parseEntry(e, coversMap),
    ]);
    const result = await client.bulk({ body: ops, refresh: false });
    if (result.errors) {
      const errs = result.items
        .filter((x) => x.index?.error)
        .map((x) => x.index.error);
      console.error("Bulk errors:", errs.slice(0, 3));
    }
    indexed += batch.length;
    console.log(`Indexed ${indexed}/${entries.length}`);
  }

  await client.indices.refresh({ index: INDEX });
  console.log("Import complete!");
}

importData().catch((e) => {
  console.error(e);
  process.exit(1);
});
