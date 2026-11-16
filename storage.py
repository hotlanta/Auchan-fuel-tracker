"""Rolling N-day price table stored as CSV (one row per calendar day).

Rules
 * Exactly one row per date -> a repeat run on the same day updates that row.
 * Days with no data are kept as rows with empty cells (a visible gap).
 * A re-run never erases a good value with a failed (empty) one.
 * Table keeps only the latest `window_days` calendar days.
 * File is written atomically (temp file + rename) so it can't be half-written.
"""
import csv
import datetime as dt
import logging
import os
from pathlib import Path

log = logging.getLogger("fuel.storage")


def columns_for(cfg: dict) -> list:
    cols = ["date"]
    for key in cfg["stations"]:
        cols += [f"{key}_95", f"{key}_premium"]
    return cols


def read_table(path: Path, columns: list) -> dict:
    """Return {date: {col: str}}; empty dict if file is missing."""
    rows = {}
    if not Path(path).exists():
        return rows
    with open(path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            try:
                d = dt.date.fromisoformat(row["date"])
            except (KeyError, ValueError):
                log.warning("Skipping row with bad date: %s", row)
                continue
            rows[d] = {c: (row.get(c) or "") for c in columns if c != "date"}
    return rows


def write_table(path: Path, columns: list, rows: dict) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    with open(tmp, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(columns)
        for d in sorted(rows):
            w.writerow([d.isoformat()] + [rows[d].get(c, "") for c in columns if c != "date"])
    os.replace(tmp, path)


def update_table(path: Path, columns: list, today: dt.date, values: dict, window_days: int = 30) -> dict:
    """Apply today's scraped values (col -> int|None) and return the new table."""
    value_cols = [c for c in columns if c != "date"]
    rows = read_table(path, columns)
    window_start = today - dt.timedelta(days=window_days - 1)

    # 1. Record gaps: blank rows for every missed day between last row and today.
    if rows:
        last = max(rows)
        if last > today:
            log.warning("Newest row (%s) is after today (%s): PC clock changed? No gap-filling.", last, today)
        else:
            d = max(last + dt.timedelta(days=1), window_start)
            while d < today:
                if d not in rows:
                    rows[d] = {c: "" for c in value_cols}
                    log.warning("Missed day recorded as gap: %s", d)
                d += dt.timedelta(days=1)

    # 2. Upsert today's row (never overwrite a good value with None).
    row = rows.setdefault(today, {c: "" for c in value_cols})
    for col, val in values.items():
        if col not in row:
            log.error("Unknown column %s ignored", col)
        elif val is not None:
            if row[col] and row[col] != str(val):
                log.info("Updating %s %s: %s -> %s", today, col, row[col], val)
            row[col] = str(val)

    # 3. Trim to the rolling window.
    for d in [d for d in rows if d < window_start]:
        del rows[d]
        log.info("Dropped old row %s", d)

    write_table(path, columns, rows)
    return rows
