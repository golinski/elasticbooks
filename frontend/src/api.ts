import type { BooksResponse, StatsResponse, SearchParams } from "./types";

export async function fetchBooks(params: SearchParams): Promise<BooksResponse> {
  const qs = new URLSearchParams();
  (Object.entries(params) as [string, unknown][]).forEach(([k, v]) => {
    if (Array.isArray(v)) {
      v.forEach((x: unknown) => qs.append(k, String(x)));
    } else if (v !== "" && v != null) {
      qs.set(k, String(v));
    }
  });
  const r = await fetch(`${import.meta.env.VITE_API_URL ?? ''}/api/books?${qs}`);
  if (!r.ok) throw new Error("API error");
  return r.json() as Promise<BooksResponse>;
}

export async function fetchStats(): Promise<StatsResponse> {
  const r = await fetch(`${import.meta.env.VITE_API_URL ?? ''}/api/stats`);
  if (!r.ok) throw new Error("API error");
  return r.json() as Promise<StatsResponse>;
}
