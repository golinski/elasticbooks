import type { BooksResponse, StatsResponse, SearchParams } from "./types";

export async function fetchBooks(
  params: SearchParams,
  extra?: Record<string, string>,
): Promise<BooksResponse> {
  const qs = new URLSearchParams();
  (Object.entries(params) as [string, unknown][]).forEach(([k, v]) => {
    if (Array.isArray(v)) {
      v.forEach((x: unknown) => qs.append(k, String(x)));
    } else if (v !== "" && v != null) {
      qs.set(k, String(v));
    }
  });
  if (extra) {
    Object.entries(extra).forEach(([k, v]) => { if (v) qs.set(k, v); });
  }
  const r = await fetch(`/api/books?${qs}`);
  if (!r.ok) throw new Error("API error");
  return r.json() as Promise<BooksResponse>;
}

export async function fetchStats(): Promise<StatsResponse> {
  const r = await fetch("/api/stats");
  if (!r.ok) throw new Error("API error");
  return r.json() as Promise<StatsResponse>;
}
