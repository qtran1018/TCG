"""
httpx vs Playwright scraper comparison for PriceCharting.

Tests whether httpx (plain HTTP, no browser) can fetch PriceCharting pages
and parse the same price data as the existing Playwright-based scraper.

Run inside the backend container:
    python /scripts/test_httpx_pricecharting.py

Or from the host:
    docker exec tcg_backend python /scripts/test_httpx_pricecharting.py
"""

import asyncio
import json
import re
import time
import unicodedata
from dataclasses import dataclass, field

import httpx
from bs4 import BeautifulSoup

# ---------------------------------------------------------------------------
# 11 test cards:
#   - 5 Suicune variants actually scanned and price-fetched by the app
#   - 3 classic high-value cards (baseline — PC definitely has these)
#   - 2 cards the user reported as returning no price data (negative cache test)
#   - 1 recent set card to test newer catalogue coverage
# ---------------------------------------------------------------------------
TEST_CARDS = [
    # --- scanned + priced -----------------------------------------------
    ("Suicune",         "Aquapolis",            "H25", "https://www.pricecharting.com/game/pokemon-aquapolis/suicune-H25"),
    ("Suicune",         "Neo Revelation",       "14",  "https://www.pricecharting.com/game/pokemon-neo-revelation/suicune-14"),
    ("Suicune",         "POP Series 2",         "4",   "https://www.pricecharting.com/game/pokemon-pop-series-2/suicune-holo-4"),
    ("Suicune",         "Prismatic Evolutions", "24",  "https://www.pricecharting.com/game/pokemon-prismatic-evolutions/suicune-24"),
    ("Suicune",         "Secret Wonders",       "19",  "https://www.pricecharting.com/game/pokemon-secret-wonders/suicune-19"),
    # --- classics (high-confidence PC hits) --------------------------------
    ("Charizard",       "Base Set",             "4",   "https://www.pricecharting.com/game/pokemon-base-set/charizard-4"),
    ("Mewtwo",          "Base Set",             "10",  "https://www.pricecharting.com/game/pokemon-base-set/mewtwo-10"),
    ("Gengar",          "Fossil",               "5",   "https://www.pricecharting.com/game/pokemon-fossil/gengar-5"),
    # --- cards user reported as no-price -----------------------------------
    ("Bewear",          "Burning Shadows",      "112", "https://www.pricecharting.com/game/pokemon-burning-shadows/bewear-112"),
    ("Clauncher",       "XY",                   "36",  "https://www.pricecharting.com/game/pokemon-xy/clauncher-36"),
    # --- recent set --------------------------------------------------------
    ("Pikachu",         "Prismatic Evolutions", "67",  "https://www.pricecharting.com/game/pokemon-prismatic-evolutions/pikachu-67"),
    # --- additional mix (vintage, mid-era, modern) -------------------------
    ("Blastoise",       "Base Set",             "2",   "https://www.pricecharting.com/game/pokemon-base-set/blastoise-2"),
    ("Venusaur",        "Base Set",             "15",  "https://www.pricecharting.com/game/pokemon-base-set/venusaur-15"),
    ("Lugia",           "Neo Genesis",          "9",   "https://www.pricecharting.com/game/pokemon-neo-genesis/lugia-9"),
    ("Ho-Oh",           "Neo Revelation",       "7",   "https://www.pricecharting.com/game/pokemon-neo-revelation/ho-oh-7"),
    ("Umbreon",         "Neo Discovery",        "13",  "https://www.pricecharting.com/game/pokemon-neo-discovery/umbreon-13"),
    ("Rayquaza",        "Celestial Storm",      "109", "https://www.pricecharting.com/game/pokemon-celestial-storm/rayquaza-gx-109"),
    ("Charizard",       "Evolutions",           "11",  "https://www.pricecharting.com/game/pokemon-evolutions/charizard-11"),
    ("Umbreon",         "Prismatic Evolutions", "95",  "https://www.pricecharting.com/game/pokemon-prismatic-evolutions/umbreon-ex-95"),
    ("Espeon",          "Prismatic Evolutions", "65",  "https://www.pricecharting.com/game/pokemon-prismatic-evolutions/espeon-65"),
]

# Rotate through realistic Chrome user-agents (same pool as Playwright scraper)
USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
]

# Headers that mimic a real browser navigation to a direct PriceCharting URL
BROWSER_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate",
    "DNT": "1",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Cache-Control": "max-age=0",
    "Connection": "keep-alive",
}

# ---------------------------------------------------------------------------
# Parsing helpers (copied verbatim from pricecharting.py so results are
# directly comparable to what the Playwright scraper returns)
# ---------------------------------------------------------------------------

def _parse_price(text: str | None) -> float | None:
    if not text:
        return None
    cleaned = re.sub(r"[^\d.]", "", text.strip())
    try:
        return float(cleaned) if cleaned else None
    except ValueError:
        return None


def _parse_price_cell(cell) -> float | None:
    accepted = cell.find("span", title="best offer accepted price")
    if accepted:
        return _parse_price(accepted.get_text(strip=True))
    for listed in cell.find_all("span", class_="listed-price-inline"):
        listed.decompose()
    return _parse_price(cell.get_text(strip=True))


def _parse_prices(html: str, url: str) -> dict:
    soup = BeautifulSoup(html, "lxml")
    result = {"loose": None, "graded_10": None, "sales": 0, "chart_points": 0}

    full_prices = soup.find(id="full-prices")
    if full_prices:
        for row in full_prices.find_all("tr"):
            cells = row.find_all(["th", "td"])
            if len(cells) < 2:
                continue
            label = cells[0].get_text(strip=True).lower()
            val = _parse_price_cell(cells[1])
            if label == "ungraded":
                result["loose"] = val
            elif label == "psa 10":
                result["graded_10"] = val

    if result["loose"] is None:
        el = soup.find(id="used_price")
        if el:
            result["loose"] = _parse_price_cell(el)

    chart_match = re.search(r"VGPC\.chart_data\s*=\s*(\{.*?\});", html, re.DOTALL)
    if chart_match:
        try:
            chart_data = json.loads(chart_match.group(1))
            result["chart_points"] = len([p for p in chart_data.get("used", []) if p[1] != 0])
        except Exception:
            pass

    sales_tables = soup.find_all("table", class_=lambda c: c and "hoverable-rows" in c and "sortable" in c)
    for t in sales_tables:
        tbody = t.find("tbody") or t
        result["sales"] += len(tbody.find_all("tr"))

    return result


def _detect_block(html: str, status: int) -> str | None:
    """Return a description if the response looks blocked/challenged."""
    if status == 403:
        return "403 Forbidden"
    if status == 429:
        return "429 Rate limited"
    if status >= 500:
        return f"{status} Server error"
    if "Just a moment" in html or "cf-browser-verification" in html:
        return "Cloudflare JS challenge"
    if "Enable JavaScript" in html or "Please enable cookies" in html:
        return "JS/cookie gate"
    if len(html) < 2000:
        return f"Suspiciously short response ({len(html)} bytes)"
    return None


# ---------------------------------------------------------------------------
# Main test
# ---------------------------------------------------------------------------

async def test_one(client: httpx.AsyncClient, name: str, set_name: str,
                   number: str, url: str, index: int) -> dict:
    ua = USER_AGENTS[index % len(USER_AGENTS)]
    headers = {**BROWSER_HEADERS, "User-Agent": ua}

    t0 = time.monotonic()
    try:
        resp = await client.get(url, headers=headers, follow_redirects=True, timeout=20.0)
        elapsed = time.monotonic() - t0
        html = resp.text
        status = resp.status_code
    except httpx.TimeoutException:
        return {"name": name, "set": set_name, "number": number,
                "status": "TIMEOUT", "elapsed": time.monotonic() - t0,
                "block": "Request timed out", "prices": None}
    except Exception as e:
        return {"name": name, "set": set_name, "number": number,
                "status": "ERROR", "elapsed": time.monotonic() - t0,
                "block": str(e), "prices": None}

    block = _detect_block(html, status)
    prices = None if block else _parse_prices(html, url)

    return {
        "name": name,
        "set": set_name,
        "number": number,
        "url": url,
        "status": status,
        "elapsed": round(elapsed, 2),
        "block": block,
        "prices": prices,
    }


RUNS = 3
# Cards expected to have no price data (legitimate negatives — not failures)
EXPECTED_NO_PRICE = {"Bewear/112", "Clauncher/36"}


async def run_once(client: httpx.AsyncClient, run_num: int) -> dict:
    """Run a full pass over TEST_CARDS. Returns per-card results keyed by 'Name/number'."""
    print(f"\n{'─' * 100}")
    print(f"  RUN {run_num}/{RUNS}")
    print(f"{'─' * 100}")
    print(f"  {'#':<3} {'Card':<30} {'Set':<25} {'#':<5} {'Status':<8} {'Time':>6}  {'Result'}")

    results = {}
    for i, (name, set_name, number, url) in enumerate(TEST_CARDS):
        if i > 0:
            await asyncio.sleep(0.5)

        r = await test_one(client, name, set_name, number, url, i + (run_num - 1) * len(TEST_CARDS))
        key = f"{name}/{number}"
        label = f"{name:<28}"
        setlabel = f"{set_name:<23}"

        if r["block"]:
            outcome = f"BLOCKED: {r['block']}"
            results[key] = "blocked"
        elif r["prices"] is None:
            outcome = "(parse error)"
            results[key] = "parse_error"
        else:
            p = r["prices"]
            if p["loose"] is not None:
                psa10 = f"  PSA10=${p['graded_10']:.2f}" if p["graded_10"] else ""
                chart = f"  chart={p['chart_points']}pts" if p["chart_points"] else ""
                sales = f"  sales={p['sales']}" if p["sales"] else ""
                outcome = f"loose=${p['loose']:.2f}{psa10}{chart}{sales}"
                results[key] = "priced"
            else:
                outcome = "no price data"
                results[key] = "no_price"

        print(f"  {i+1:<3} {label} {setlabel} {number:<5} {str(r['status']):<8} {r.get('elapsed',0):>5.2f}s  {outcome}")

    return results


async def main():
    print("=" * 100)
    print(f"httpx PriceCharting stress test — {RUNS} runs × {len(TEST_CARDS)} cards — 0.5s inter-request delay")
    print("=" * 100)

    # Failure tracker: key → list of run numbers where it failed unexpectedly
    fail_log: dict[str, list[int]] = {}

    async with httpx.AsyncClient(http2=False) as client:
        # Homepage warm-up
        try:
            print("\nWarming up: fetching homepage...")
            t0 = time.monotonic()
            warmup = await client.get(
                "https://www.pricecharting.com",
                headers={**BROWSER_HEADERS, "User-Agent": USER_AGENTS[0]},
                follow_redirects=True,
                timeout=15.0,
            )
            print(f"  Homepage: HTTP {warmup.status_code}  ({time.monotonic() - t0:.2f}s)")
            block = _detect_block(warmup.text, warmup.status_code)
            if block:
                print(f"  *** BLOCKED ON HOMEPAGE: {block}")
                return
        except Exception as e:
            print(f"  Homepage fetch failed: {e}")
            return

        all_run_results = []
        for run_num in range(1, RUNS + 1):
            results = await run_once(client, run_num)
            all_run_results.append(results)

            for key, outcome in results.items():
                is_expected_no_price = key in EXPECTED_NO_PRICE
                failed = (
                    outcome in ("blocked", "parse_error") or
                    (outcome == "no_price" and not is_expected_no_price)
                )
                if failed:
                    fail_log.setdefault(key, []).append(run_num)

            # 3s cooldown between full runs (not between individual cards)
            if run_num < RUNS:
                print(f"\n  (3s cooldown before run {run_num + 1}...)")
                await asyncio.sleep(3.0)

    # ── Final report ──────────────────────────────────────────────────────────
    print(f"\n{'=' * 100}")
    print("AGGREGATE RESULTS")
    print(f"{'=' * 100}")

    header = f"  {'Card/Number':<35}"
    for r in range(1, RUNS + 1):
        header += f"  Run{r:<5}"
    header += "  Failures"
    print(header)
    print(f"  {'─' * 70}")

    total_priced = 0
    total_requests = 0
    for name, set_name, number, url in TEST_CARDS:
        key = f"{name}/{number}"
        is_expected_no_price = key in EXPECTED_NO_PRICE
        row = f"  {key:<35}"
        for run_results in all_run_results:
            outcome = run_results.get(key, "?")
            symbol = {"priced": "OK", "no_price": "n/a" if is_expected_no_price else "FAIL",
                      "blocked": "BLOK", "parse_error": "ERR"}.get(outcome, "?")
            row += f"  {symbol:<7}"
            if outcome == "priced":
                total_priced += 1
            total_requests += 1
        failures = fail_log.get(key, [])
        row += f"  {len(failures)}/{RUNS} fails" if failures else "  clean"
        print(row)

    print(f"  {'─' * 70}")
    print(f"\n  Total priced (excl. expected no-price): {total_priced}/{total_requests - len(EXPECTED_NO_PRICE) * RUNS}")
    print(f"  Cards with unexpected failures:         {len(fail_log)}")
    if fail_log:
        print("\n  FAILURES:")
        for key, runs in sorted(fail_log.items()):
            print(f"    {key} — failed on run(s) {runs}")
    else:
        print("\n  No unexpected failures across all runs.")

    n = len(TEST_CARDS)
    print(f"\n  Est. wall time per run (0.5s delay): ~{(n - 1) * 0.5 + n * 0.7:.0f}s")
    print(f"  Est. wall time per run (Playwright 3s): ~{n * 5:.0f}s")


if __name__ == "__main__":
    asyncio.run(main())
