#!/usr/bin/env python3
"""
compare_backends.py — compare Go (port 3002) and Rust (port 3001) backend responses.

Usage:
    python3 scripts/compare_backends.py [--go URL] [--rs URL] [--verbose]

Both backends must be running and pointing at the same Elasticsearch index.
The script runs a set of test cases and reports any differences.

Exit code: 0 if all cases pass, 1 if any differ or error.
"""

import argparse
import json
import sys
import urllib.request
import urllib.parse
from dataclasses import dataclass, field
from typing import Any

# ─── Configuration ────────────────────────────────────────────────────────────

DEFAULT_GO = "http://localhost:3002"
DEFAULT_RS = "http://localhost:3001"

# Fields that are allowed to differ between backends (e.g. floating-point
# score values that may vary slightly due to ES shard routing).
SCORE_TOLERANCE = 0.001   # relative tolerance for _score comparisons
IGNORED_FIELDS: set[str] = set()  # add field names here to skip globally


# ─── Test cases ───────────────────────────────────────────────────────────────

@dataclass
class Case:
    name: str
    path: str          # e.g. "/api/books?q=tolkien"
    check: str = "full"  # "full" | "totals" | "ids" | "stats"
    # "full"   — compare total, book IDs in order, facet bucket keys
    # "totals" — compare only total count
    # "ids"    — compare book IDs in order (ignore facets)
    # "stats"  — for /api/stats, compare top-level counts


CASES: list[Case] = [
    # ── Health ────────────────────────────────────────────────────────────────
    Case("health",
         "/api/health",
         check="totals"),   # just check both return 200 with status=ok

    # ── Stats ─────────────────────────────────────────────────────────────────
    Case("stats",
         "/api/stats",
         check="stats"),

    # ── Default listing ───────────────────────────────────────────────────────
    Case("default listing (title asc, page 1)",
         "/api/books?sort=title&dir=asc&size=20"),

    Case("default listing page 2",
         "/api/books?sort=title&dir=asc&size=20&page=2"),

    # ── Free-text search ──────────────────────────────────────────────────────
    Case("free-text: fantasy",
         "/api/books?q=fantasy&sort=score&dir=desc&size=10"),

    Case("free-text: tolkien",
         "/api/books?q=tolkien&sort=score&dir=desc&size=10"),

    Case("free-text: sanderson magic system",
         "/api/books?q=sanderson+magic+system&sort=score&dir=desc&size=10"),

    # ── Field searches ────────────────────────────────────────────────────────
    Case("author prefix: Sapkowski",
         "/api/books?author=Sapkowski&sort=title&dir=asc&size=20"),

    Case("series prefix: Wiedźmin",
         "/api/books?series=Wiedźmin&sort=series&dir=asc&size=20"),

    Case("title prefix: Droga",
         "/api/books?title=Droga&sort=title&dir=asc&size=10"),

    Case("genre: fantasy",
         "/api/books?genre=fantasy&sort=title&dir=asc&size=20"),

    # ── Facet filters ─────────────────────────────────────────────────────────
    Case("author_filter exact",
         "/api/books?author_filter=Brandon+Sanderson&sort=title&dir=asc&size=20"),

    Case("author_filter multi-value",
         "/api/books?author_filter=Brandon+Sanderson&author_filter=Andrzej+Sapkowski&sort=title&dir=asc&size=20"),

    Case("genre_filter",
         "/api/books?genre_filter=fantasy%2C+science+fiction&sort=title&dir=asc&size=20"),

    # ── Range filters ─────────────────────────────────────────────────────────
    Case("year range 2010-2015",
         "/api/books?year_from=2010&year_to=2015&sort=pub_year&dir=asc&size=20"),

    Case("rating range 800-1000 (8.0-10.0)",
         "/api/books?rating_from=800&rating_to=1000&sort=rating&dir=desc&size=20"),

    Case("readers range",
         "/api/books?rating_num_from=5000&sort=popularity&dir=desc&size=10"),

    # ── Sorting ───────────────────────────────────────────────────────────────
    Case("sort by rating desc",
         "/api/books?sort=rating&dir=desc&size=20"),

    Case("sort by popularity desc",
         "/api/books?sort=popularity&dir=desc&size=20"),

    Case("sort by pub_year asc",
         "/api/books?sort=pub_year&dir=asc&size=20"),

    Case("sort by series asc (volume order)",
         "/api/books?sort=series&dir=asc&size=40"),

    Case("sort by cdate desc",
         "/api/books?sort=cdate&dir=desc&size=20"),

    # ── Pagination ────────────────────────────────────────────────────────────
    Case("size=5 page=3",
         "/api/books?sort=title&dir=asc&size=5&page=3"),

    # ── Combined ──────────────────────────────────────────────────────────────
    Case("author filter + year range",
         "/api/books?author_filter=Brandon+Sanderson&year_from=2010&sort=pub_year&dir=asc&size=20"),

    Case("free-text + genre filter",
         "/api/books?q=magia&genre_filter=fantasy%2C+science+fiction&sort=score&dir=desc&size=10"),

    # ── Single book ───────────────────────────────────────────────────────────
    Case("book by id=1",
         "/api/books/1",
         check="ids"),
]


# ─── HTTP helpers ─────────────────────────────────────────────────────────────

def fetch(base: str, path: str) -> tuple[int, Any]:
    url = base.rstrip("/") + path
    try:
        with urllib.request.urlopen(url, timeout=15) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())
    except Exception as e:
        return 0, {"_error": str(e)}


# ─── Comparison helpers ───────────────────────────────────────────────────────

def book_ids(books: list[dict]) -> list[int]:
    return [b.get("id") for b in books]


def facet_keys(facets: dict, name: str) -> list:
    return [b.get("key") for b in facets.get(name, [])]


def scores_close(a: float | None, b: float | None) -> bool:
    if a is None and b is None:
        return True
    if a is None or b is None:
        return False
    if a == 0 and b == 0:
        return True
    return abs(a - b) / max(abs(a), abs(b)) < SCORE_TOLERANCE


def diff_books(go_books: list[dict], rs_books: list[dict]) -> list[str]:
    issues = []
    if len(go_books) != len(rs_books):
        issues.append(f"  book count: go={len(go_books)} rs={len(rs_books)}")
        return issues
    for i, (g, r) in enumerate(zip(go_books, rs_books)):
        if g.get("id") != r.get("id"):
            issues.append(f"  book[{i}] id: go={g.get('id')} rs={r.get('id')}")
        # Check _score within tolerance
        gs, rs_ = g.get("_score"), r.get("_score")
        if gs is not None and rs_ is not None and not scores_close(gs, rs_):
            issues.append(f"  book[{i}] id={g.get('id')} _score: go={gs:.4f} rs={rs_:.4f}")
    return issues


def diff_facets(go_f: dict, rs_f: dict) -> list[str]:
    issues = []
    for name in set(list(go_f.keys()) + list(rs_f.keys())):
        gk = facet_keys(go_f, name)
        rk = facet_keys(rs_f, name)
        if gk != rk:
            issues.append(f"  facet '{name}' keys differ: go={gk[:5]} rs={rk[:5]}")
        # Compare doc_counts
        gb = {b["key"]: b["doc_count"] for b in go_f.get(name, [])}
        rb = {b["key"]: b["doc_count"] for b in rs_f.get(name, [])}
        for k in set(list(gb.keys()) + list(rb.keys())):
            if gb.get(k) != rb.get(k):
                issues.append(f"  facet '{name}' key={k!r}: go={gb.get(k)} rs={rb.get(k)}")
    return issues


def compare(case: Case, go_status: int, go_body: Any,
            rs_status: int, rs_body: Any, verbose: bool) -> list[str]:
    issues = []

    # Status codes must match
    if go_status != rs_status:
        issues.append(f"  HTTP status: go={go_status} rs={rs_status}")
        return issues

    if isinstance(go_body, dict) and "_error" in go_body:
        issues.append(f"  go fetch error: {go_body['_error']}")
    if isinstance(rs_body, dict) and "_error" in rs_body:
        issues.append(f"  rs fetch error: {rs_body['_error']}")
    if issues:
        return issues

    if case.check == "totals":
        # For /api/health just check both say ok
        if case.path == "/api/health":
            gs = go_body.get("status")
            rs = rs_body.get("status")
            if gs != "ok":
                issues.append(f"  go health status: {gs}")
            if rs != "ok":
                issues.append(f"  rs health status: {rs}")
        return issues

    if case.check == "stats":
        gt = go_body.get("total")
        rt = rs_body.get("total")
        if gt != rt:
            issues.append(f"  total: go={gt} rs={rt}")
        for key in ("top_authors", "top_series", "top_genres"):
            gk = [b.get("key") for b in go_body.get(key, [])]
            rk = [b.get("key") for b in rs_body.get(key, [])]
            if gk != rk:
                issues.append(f"  {key} keys: go={gk} rs={rk}")
        return issues

    if case.check == "ids":
        # Single book endpoint — compare the whole document minus _score
        g = {k: v for k, v in go_body.items() if k != "_score"}
        r = {k: v for k, v in rs_body.items() if k != "_score"}
        if g != r:
            issues.append(f"  document differs:\n    go={json.dumps(g, ensure_ascii=False)[:200]}"
                          f"\n    rs={json.dumps(r, ensure_ascii=False)[:200]}")
        return issues

    # "full" check
    gt, rt = go_body.get("total"), rs_body.get("total")
    if gt != rt:
        issues.append(f"  total: go={gt} rs={rt}")

    gp, rp = go_body.get("page"), rs_body.get("page")
    if gp != rp:
        issues.append(f"  page: go={gp} rs={rp}")

    gs, rs_ = go_body.get("size"), rs_body.get("size")
    if gs != rs_:
        issues.append(f"  size: go={gs} rs={rs_}")

    go_books = go_body.get("books", [])
    rs_books = rs_body.get("books", [])
    issues.extend(diff_books(go_books, rs_books))

    go_facets = go_body.get("facets", {})
    rs_facets = rs_body.get("facets", {})
    issues.extend(diff_facets(go_facets, rs_facets))

    return issues


# ─── Runner ───────────────────────────────────────────────────────────────────

def run(go_base: str, rs_base: str, verbose: bool) -> int:
    passed = 0
    failed = 0
    errors = 0

    col_w = max(len(c.name) for c in CASES) + 2

    print(f"\nComparing backends:")
    print(f"  Go   → {go_base}")
    print(f"  Rust → {rs_base}")
    print(f"\n{'Case':<{col_w}}  Result")
    print("─" * (col_w + 10))

    for case in CASES:
        go_status, go_body = fetch(go_base, case.path)
        rs_status, rs_body = fetch(rs_base, case.path)

        issues = compare(case, go_status, go_body, rs_status, rs_body, verbose)

        if go_status == 0 or rs_status == 0:
            status = "ERROR"
            errors += 1
        elif issues:
            status = "FAIL"
            failed += 1
        else:
            status = "PASS"
            passed += 1

        print(f"  {case.name:<{col_w}}  {status}")

        if issues:
            for line in issues:
                print(line)

        if verbose and not issues:
            # Show a brief summary of what was compared
            if isinstance(go_body, dict) and "total" in go_body:
                print(f"    total={go_body['total']}  books={len(go_body.get('books', []))}")

    print("─" * (col_w + 10))
    print(f"\n  {passed} passed  {failed} failed  {errors} errors  "
          f"({len(CASES)} total)\n")

    return 0 if (failed == 0 and errors == 0) else 1


# ─── Entry point ──────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--go",      default=DEFAULT_GO, help="Go backend base URL")
    parser.add_argument("--rs",      default=DEFAULT_RS, help="Rust backend base URL")
    parser.add_argument("--verbose", action="store_true", help="Show extra detail for passing cases")
    args = parser.parse_args()

    sys.exit(run(args.go, args.rs, args.verbose))


if __name__ == "__main__":
    main()
