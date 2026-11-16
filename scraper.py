"""Fetch an Auchan station page and extract the 95 / premium prices.

Strategy:
  1. Plain HTTP request (fast, light).
  2. If the prices are not in the raw HTML (the page is built by JavaScript),
     fall back to a headless Chromium browser (Playwright).

The page text we parse looks like (single line, after whitespace collapsing):
    "... Üzemanyagárak 95 627 Ft Pro 100 697 Ft D 718 Ft Smart D 748 Ft ... Cím ..."
"""
import logging
import re
from urllib import robotparser
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup

log = logging.getLogger("fuel.scraper")

SECTION_START = "Üzemanyagárak"   # heading just before the price list
SECTION_END = "Cím"               # heading right after it

# <label> <price> Ft   where price is "627" or "1 027" (thousands separator).
PRICE_RE = re.compile(
    r"(?P<label>[^\s](?:.*?[^\s])?)\s+(?P<price>\d{1,2} \d{3}|\d{3,4})\s*Ft\b"
)


class ScrapeError(Exception):
    """Raised when a page cannot be fetched or parsed."""


def _norm(label: str) -> str:
    return re.sub(r"\s+", "", label).lower()


def html_to_text(html: str) -> str:
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()
    return re.sub(r"\s+", " ", soup.get_text(" ")).strip()


def parse_prices(text: str, fuel_labels: dict, lo: int, hi: int) -> dict:
    """Return {"95": int|None, "premium": int|None} found in the page text."""
    text = re.sub(r"\s+", " ", text)
    start = text.find(SECTION_START)
    if start < 0:
        raise ScrapeError(f"'{SECTION_START}' section not found (site layout changed or JS not rendered)")
    start += len(SECTION_START)
    end = text.find(f" {SECTION_END} ", start)
    section = text[start:end if end > 0 else start + 600]

    found = {_norm(m["label"]): int(m["price"].replace(" ", "")) for m in PRICE_RE.finditer(section)}
    log.debug("Raw labels found: %s", found)

    result = {}
    for key, names in fuel_labels.items():
        value = next((found[_norm(n)] for n in names if _norm(n) in found), None)
        if value is not None and not (lo <= value <= hi):
            log.error("Price %s for '%s' outside sane range %s-%s; ignored", value, key, lo, hi)
            value = None
        if value is None:
            log.error("Fuel '%s' (labels %s) not found. Labels on page: %s", key, names, list(found))
        result[key] = value
    if all(v is None for v in result.values()):
        raise ScrapeError(f"No tracked fuel found. Labels on page: {list(found)}")
    return result


def fetch_text_http(url: str, ua: str, timeout: int) -> str:
    r = requests.get(url, headers={"User-Agent": ua, "Accept-Language": "hu,en;q=0.8"}, timeout=timeout)
    r.raise_for_status()
    return html_to_text(r.text)


def fetch_text_browser(url: str, ua: str, timeout: int) -> str:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as e:
        raise ScrapeError("Playwright is not installed (run setup.bat)") from e
    ms = timeout * 1000
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            page = browser.new_page(user_agent=ua)
            page.goto(url, wait_until="domcontentloaded", timeout=ms)
            page.wait_for_function(
                f"document.body.innerText.includes('{SECTION_START}') && /\\d{{3}}\\s*Ft/.test(document.body.innerText)",
                timeout=ms,
            )
            return page.inner_text("body")
        except Exception as e:  # playwright raises its own TimeoutError
            raise ScrapeError(f"Browser fetch failed: {e}") from e
        finally:
            browser.close()


def scrape_station(url: str, cfg: dict) -> dict:
    """Fetch + parse one station. Tries HTTP first, then the browser."""
    ua, timeout = cfg["user_agent"], cfg["request_timeout_s"]
    args = (cfg["fuel_labels"], cfg["price_min_huf"], cfg["price_max_huf"])
    try:
        log.info("HTTP fetch: %s", url)
        return parse_prices(fetch_text_http(url, ua, timeout), *args)
    except (requests.RequestException, ScrapeError) as e:
        log.warning("HTTP method failed (%s)", e)
        if not cfg.get("use_browser_fallback", True):
            raise ScrapeError(str(e)) from e
    log.info("Browser fetch: %s", url)
    return parse_prices(fetch_text_browser(url, ua, timeout), *args)


def robots_allows(url: str, ua: str, timeout: int = 15) -> bool:
    """Check robots.txt. Unreachable robots.txt -> warn and allow (one GET/day)."""
    p = urlparse(url)
    robots_url = f"{p.scheme}://{p.netloc}/robots.txt"
    try:
        r = requests.get(robots_url, headers={"User-Agent": ua}, timeout=timeout)
    except requests.RequestException as e:
        log.warning("Could not read robots.txt (%s); continuing", e)
        return True
    if r.status_code != 200:
        log.warning("robots.txt returned HTTP %s; continuing", r.status_code)
        return True
    rp = robotparser.RobotFileParser()
    rp.parse(r.text.splitlines())
    ok = rp.can_fetch(ua, url)
    if not ok:
        log.error("robots.txt DISALLOWS %s for our user agent", url)
    return ok
