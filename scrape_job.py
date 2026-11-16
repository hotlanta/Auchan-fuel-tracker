"""Daily job run by GitHub Actions: scrape both stations -> update data/prices.csv (+ data/status.json).

Exit code: 0 = at least one price recorded (a warning is printed if some are missing)
           1 = nothing could be recorded (the workflow is then marked as failed -> GitHub emails you)

Local test:  python scrape_job.py --dry-run
"""
import argparse
import datetime as dt
import json
import logging
import sys
import time
from pathlib import Path
from zoneinfo import ZoneInfo

import scraper
import storage

ROOT = Path(__file__).resolve().parent
log = logging.getLogger("fuel")


def scrape_with_retries(url: str, cfg: dict):
    """Return (prices_dict_or_None, last_error_text_or_None)."""
    last = None
    for attempt in range(1, cfg["retries"] + 1):
        try:
            return scraper.scrape_station(url, cfg), None
        except Exception as e:  # network, parse, browser... never crash the whole run
            last = str(e)
            log.error("Attempt %d/%d failed for %s: %s", attempt, cfg["retries"], url, e)
            if attempt < cfg["retries"]:
                time.sleep(cfg["retry_delay_s"])
    return None, last


def run(root: Path, dry_run: bool = False, today: dt.date = None) -> int:
    cfg = json.loads((root / "config.json").read_text(encoding="utf-8"))
    columns = storage.columns_for(cfg)
    today = today or dt.datetime.now(ZoneInfo(cfg["timezone"])).date()  # Hungarian date, not UTC
    log.info("=== Run for %s (%s) ===", today, cfg["timezone"])

    values, errors = {}, {}
    for i, (key, st) in enumerate(cfg["stations"].items()):
        if i:
            time.sleep(cfg["pause_between_stations_s"])
        res, err = None, None
        if scraper.robots_allows(st["url"], cfg["user_agent"]):
            res, err = scrape_with_retries(st["url"], cfg)
        else:
            err = "robots.txt disallows this page"
        res = res or {}
        values[f"{key}_95"], values[f"{key}_premium"] = res.get("95"), res.get("premium")
        if err:
            errors[key] = err
        log.info("%s -> 95: %s | premium: %s", st["name"], res.get("95"), res.get("premium"))

    missing = [k for k, v in values.items() if v is None]
    if dry_run:
        print("DRY RUN, nothing saved:", values)
        return 0 if len(missing) < len(values) else 1

    storage.update_table(root / "data" / "prices.csv", columns, today, values, cfg["window_days"])
    status = {"run_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
              "date": today.isoformat(), "missing": missing, "errors": errors}
    (root / "data" / "status.json").write_text(json.dumps(status, indent=2, ensure_ascii=False), encoding="utf-8")

    if len(missing) == len(values):
        print("::error::No prices could be read today. See the log above.")
        return 1
    if missing:
        print(f"::warning::Some prices are missing today: {', '.join(missing)}")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--root", default=str(ROOT))
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(message)s", stream=sys.stdout)
    return run(Path(a.root), a.dry_run)


if __name__ == "__main__":
    sys.exit(main())
