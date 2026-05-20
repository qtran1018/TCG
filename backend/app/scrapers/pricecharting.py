import json
import logging
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from bs4 import BeautifulSoup
from app.scrapers.base import BaseScraper

logger = logging.getLogger(__name__)

DOMAIN = "www.pricecharting.com"
SEARCH_URL = "https://www.pricecharting.com/search-products?q={query}&type=prices"
ITEM_URL = "https://www.pricecharting.com{path}"


@dataclass
class PCSearchResult:
    title: str
    url: str
    pricecharting_id: str
    loose_price: float | None
    cib_price: float | None
    new_price: float | None
    console: str | None


@dataclass
class SaleRecord:
    date: str
    title: str
    price: float | None
    url: str | None = None


@dataclass
class PricePoint:
    date: str   # "YYYY-MM"
    price: float


@dataclass
class PCPrices:
    pricecharting_id: str
    loose: float | None = None
    cib: float | None = None
    graded_7: float | None = None
    graded_8: float | None = None
    graded_9: float | None = None
    graded_10: float | None = None
    currency: str = "USD"
    recent_sales: list[SaleRecord] = field(default_factory=list)
    price_history_ungraded: list[PricePoint] = field(default_factory=list)
    price_history_graded: list[PricePoint] = field(default_factory=list)


def _parse_price(text: str | None) -> float | None:
    if not text:
        return None
    cleaned = re.sub(r"[^\d.]", "", text.strip())
    try:
        return float(cleaned) if cleaned else None
    except ValueError:
        return None


def _parse_price_cell(cell) -> float | None:
    """Parse a price from a table cell, preferring the accepted price over a struck-out list price."""
    # Best offer layout: accepted price span + listed-price-inline span — take the accepted one
    accepted = cell.find("span", title="best offer accepted price")
    if accepted:
        return _parse_price(accepted.get_text(strip=True))
    # Remove the list price span so it doesn't pollute get_text()
    for listed in cell.find_all("span", class_="listed-price-inline"):
        listed.decompose()
    return _parse_price(cell.get_text(strip=True))


def _normalize_url(href: str) -> str:
    """Handle relative paths, protocol-relative, and malformed hrefs from PriceCharting."""
    if re.match(r'https?://', href):
        return href
    if href.startswith('https//'):
        return 'https://' + href[7:]
    if href.startswith('http//'):
        return 'http://' + href[6:]
    if href.startswith('//'):
        return 'https:' + href
    return f"https://www.pricecharting.com{href if href.startswith('/') else '/' + href}"


def _extract_id_from_url(url: str) -> str:
    parts = url.rstrip("/").split("/")
    return parts[-1] if parts else url


def _parse_chart_series(series: list) -> list[PricePoint]:
    """Convert [[timestamp_ms, price_cents], ...] to PricePoint list, skipping zeros."""
    points = []
    for ts_ms, cents in series:
        if cents == 0:
            continue
        date = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).strftime("%Y-%m")
        points.append(PricePoint(date=date, price=round(cents / 100, 2)))
    return points


def _slugify(text: str) -> str:
    text = text.lower().strip()
    text = re.sub(r"[&+']", "", text)
    text = re.sub(r"[^a-z0-9\s-]", "", text)
    text = re.sub(r"\s+", "-", text)
    return re.sub(r"-+", "-", text).strip("-")


class PricechartingScraper(BaseScraper):

    def build_game_url(self, name: str, set_name: str, card_number: str, game: str = "pokemon", language: str = "en") -> str:
        num = card_number.split("/")[0].lstrip("0") or "0"
        name_slug = _slugify(name)
        set_slug = _slugify(set_name)
        if game == "pokemon":
            if language == "ja":
                return f"https://www.pricecharting.com/game/pokemon-japanese-{set_slug}/{name_slug}-{num}"
            return f"https://www.pricecharting.com/game/pokemon-{set_slug}/{name_slug}-{num}"
        return f"https://www.pricecharting.com/game/{set_slug}/{name_slug}-{num}"

    async def search(self, query: str, max_results: int = 10) -> list[PCSearchResult]:
        url = SEARCH_URL.format(query=query.replace(" ", "+"))
        logger.info("Pricecharting search: %s", url)
        html = await self.fetch_page(url, DOMAIN)
        return self._parse_search(html, max_results)

    def _parse_search(self, html: str, max_results: int) -> list[PCSearchResult]:
        soup = BeautifulSoup(html, "lxml")
        table = soup.find("table", {"id": "games_table"})
        if not table:
            # Some searches redirect directly to a single product page
            return []

        results: list[PCSearchResult] = []
        rows = table.find("tbody").find_all("tr") if table.find("tbody") else []

        for row in rows[:max_results]:
            cells = row.find_all("td")
            if len(cells) < 2:
                continue

            link = cells[0].find("a")
            if not link:
                continue

            href = link.get("href", "")
            title = link.get_text(strip=True)
            console_tag = cells[0].find("span", class_="console")
            console = console_tag.get_text(strip=True) if console_tag else None

            prices = [_parse_price(c.get_text(strip=True)) for c in cells[1:4]]

            results.append(PCSearchResult(
                title=title,
                url=_normalize_url(href),
                pricecharting_id=_extract_id_from_url(href),
                loose_price=prices[0] if len(prices) > 0 else None,
                cib_price=prices[1] if len(prices) > 1 else None,
                new_price=prices[2] if len(prices) > 2 else None,
                console=console,
            ))

        return results

    async def get_prices(self, pricecharting_url: str, recent_sales_limit: int = 10) -> PCPrices:
        pc_id = _extract_id_from_url(pricecharting_url)
        logger.info("Fetching prices for: %s", pricecharting_url)
        html = await self.fetch_page(pricecharting_url, DOMAIN)
        return self._parse_prices(html, pc_id, recent_sales_limit)

    def _parse_prices(self, html: str, pc_id: str, recent_sales_limit: int = 10) -> PCPrices:
        soup = BeautifulSoup(html, "lxml")
        prices = PCPrices(pricecharting_id=pc_id)

        full_prices = soup.find(id="full-prices")
        if full_prices:
            for row in full_prices.find_all("tr"):
                cells = row.find_all(["th", "td"])
                if len(cells) < 2:
                    continue
                label = cells[0].get_text(strip=True).lower()
                val = _parse_price_cell(cells[1])
                if label == "ungraded":
                    prices.loose = val
                elif label == "grade 7":
                    prices.graded_7 = val
                elif label == "grade 8":
                    prices.graded_8 = val
                elif label == "grade 9":
                    prices.graded_9 = val
                elif label == "psa 10":
                    prices.graded_10 = val

        # Fallback: used_price element for ungraded if full-prices table absent
        if prices.loose is None:
            el = soup.find(id="used_price")
            if el:
                prices.loose = _parse_price_cell(el)

        # Trend chart data embedded as VGPC.chart_data = {...}
        chart_match = re.search(r"VGPC\.chart_data\s*=\s*(\{.*?\});", html, re.DOTALL)
        if chart_match:
            try:
                chart_data = json.loads(chart_match.group(1))
                prices.price_history_ungraded = _parse_chart_series(chart_data.get("used", []))
                prices.price_history_graded = _parse_chart_series(chart_data.get("graded", []))
            except json.JSONDecodeError:
                logger.warning("Failed to parse VGPC chart_data JSON for %s", pc_id)
            except Exception:
                logger.exception("Unexpected error parsing chart data for %s", pc_id)

        # Recent sales — collect from ALL hoverable/sortable tables (eBay + TCGPlayer)
        all_rows: list[tuple[str, str, float | None, str | None]] = []  # (date, title, price, url)
        sales_tables = soup.find_all("table", class_=lambda c: c and "hoverable-rows" in c and "sortable" in c)
        for sales_table in sales_tables:
            tbody = sales_table.find("tbody") or sales_table
            for row in tbody.find_all("tr"):
                cells = row.find_all("td")
                if len(cells) < 4:
                    continue
                # Prefer a direct marketplace URL (eBay, TCGPlayer, Mercari, Yahoo) anywhere
                # in the row; if none exist, fall back to whatever link sits in the title
                # cell. PriceCharting Japanese pages often only have PC-internal offer
                # links — those redirect to the actual marketplace listing when opened,
                # so keeping them is more useful than dropping the link entirely.
                sale_url = None
                for cell in cells:
                    for anchor in cell.find_all("a", href=True):
                        normalized = _normalize_url(anchor["href"])
                        if any(d in normalized for d in ("ebay.", "tcgplayer.", "mercari.", "yahoo.")):
                            sale_url = normalized
                            break
                    if sale_url:
                        break
                if not sale_url:
                    fallback = cells[2].find("a", href=True)
                    if fallback:
                        sale_url = _normalize_url(fallback["href"])
                all_rows.append((
                    cells[0].get_text(strip=True),
                    cells[2].get_text(strip=True),
                    _parse_price_cell(cells[3]),
                    sale_url,
                ))
        for date, title, price, url in all_rows[:recent_sales_limit]:
            prices.recent_sales.append(SaleRecord(date=date, title=title, price=price, url=url))

        return prices
