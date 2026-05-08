import logging
import re
from dataclasses import dataclass
from bs4 import BeautifulSoup
from app.scrapers.base import BaseScraper

logger = logging.getLogger(__name__)

DOMAIN = "www.psacard.com"
CERT_URL = "https://www.psacard.com/cert/{cert}"


@dataclass
class PSACertData:
    cert_number: str
    card_name: str | None = None
    grade: str | None = None
    set_name: str | None = None
    year: str | None = None
    variety: str | None = None
    population: int | None = None
    pop_higher: int | None = None


class PSAScraper(BaseScraper):

    async def lookup_cert(self, cert_number: str) -> PSACertData:
        cert_clean = re.sub(r"\D", "", cert_number)
        url = CERT_URL.format(cert=cert_clean)
        logger.info("PSA cert lookup: %s", url)
        html = await self.fetch_page(url, DOMAIN, rate_seconds=2.0)
        return self._parse_cert(html, cert_clean)

    def _parse_cert(self, html: str, cert_number: str) -> PSACertData:
        soup = BeautifulSoup(html, "lxml")
        result = PSACertData(cert_number=cert_number)

        # PSA cert page has a table with cert details
        cert_table = soup.find("table", {"class": re.compile(r"cert", re.I)}) or \
                     soup.find("div", {"class": re.compile(r"cert-detail", re.I)})

        def find_value(label_text: str) -> str | None:
            label = soup.find(string=re.compile(label_text, re.I))
            if label and label.parent:
                sibling = label.parent.find_next_sibling()
                if sibling:
                    return sibling.get_text(strip=True)
            # Try th/td table format
            for th in soup.find_all("th"):
                if re.search(label_text, th.get_text(strip=True), re.I):
                    td = th.find_next_sibling("td")
                    if td:
                        return td.get_text(strip=True)
            return None

        result.card_name = find_value(r"subject|card name|name")
        result.grade = find_value(r"grade")
        result.set_name = find_value(r"set|series")
        result.year = find_value(r"year")
        result.variety = find_value(r"variety|edition")

        pop_text = find_value(r"pop(?:ulation)?(?!\s*higher)")
        if pop_text:
            try:
                result.population = int(re.sub(r"\D", "", pop_text))
            except ValueError:
                pass

        pop_higher = find_value(r"pop.*higher|higher")
        if pop_higher:
            try:
                result.pop_higher = int(re.sub(r"\D", "", pop_higher))
            except ValueError:
                pass

        # Fallback: try meta tags or h1 for card name
        if not result.card_name:
            h1 = soup.find("h1")
            if h1:
                result.card_name = h1.get_text(strip=True)

        return result
