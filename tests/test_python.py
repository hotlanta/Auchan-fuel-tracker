"""Run:  python -m unittest discover -s tests -v   (from the project folder)"""
import datetime as dt
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import scrape_job, scraper, storage  # noqa: E402

CFG = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
COLS = storage.columns_for(CFG)
D = dt.date
SAMPLE = ("Válassz benzinkutat Üzemanyagárak 95 627 Ft Pro 100 697 Ft D 718 Ft Smart D 748 Ft "
          "PB palack 23kg 14 950 Ft PB palack 11.5kg 7475 Ft Cím 2151 Fót, Fehérkő utca 1.")


def vals(a=None, b=None, c=None, d=None):
    return dict(zip(COLS[1:], (a, b, c, d)))


class ParserTests(unittest.TestCase):
    args = (CFG["fuel_labels"], CFG["price_min_huf"], CFG["price_max_huf"])

    def test_live_sample(self):
        self.assertEqual(scraper.parse_prices(SAMPLE, *self.args), {"95": 627, "premium": 697})

    def test_html(self):
        html = "<div><script>x=1</script><span>Üzemanyagárak</span><b>95</b><i>627&nbsp;Ft</i><b>Pro 100</b><i>697 Ft</i><h3>Cím</h3></div>"
        self.assertEqual(scraper.parse_prices(scraper.html_to_text(html), *self.args), {"95": 627, "premium": 697})

    def test_layout_change_raises(self):
        with self.assertRaises(scraper.ScrapeError):
            scraper.parse_prices("different page", *self.args)

    def test_missing_premium(self):
        self.assertEqual(scraper.parse_prices("Üzemanyagárak 95 627 Ft D 718 Ft Cím", *self.args), {"95": 627, "premium": None})


class RollingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.csv = Path(self.tmp.name) / "prices.csv"

    def tearDown(self):
        self.tmp.cleanup()

    def test_duplicate_run_one_row(self):
        storage.update_table(self.csv, COLS, D(2026, 11, 1), vals(1, 2, 3, 4))
        rows = storage.update_table(self.csv, COLS, D(2026, 11, 1), vals(1, 2, 3, 4))
        self.assertEqual(len(rows), 1)

    def test_rerun_fills_but_never_erases(self):
        storage.update_table(self.csv, COLS, D(2026, 11, 1), vals(627, 697, None, None))
        r = storage.update_table(self.csv, COLS, D(2026, 11, 1), vals(None, None, 630, 700))[D(2026, 11, 1)]
        self.assertEqual((r["dunakeszi_95"], r["fot_95"]), ("627", "630"))

    def test_gaps(self):
        storage.update_table(self.csv, COLS, D(2026, 11, 1), vals(1, 2, 3, 4))
        rows = storage.update_table(self.csv, COLS, D(2026, 11, 4), vals(5, 6, 7, 8))
        self.assertEqual(sorted(rows), [D(2026, 11, d) for d in (1, 2, 3, 4)])
        self.assertEqual(rows[D(2026, 11, 2)]["fot_95"], "")

    def test_window_30(self):
        start = D(2026, 9, 1)
        for i in range(45):
            rows = storage.update_table(self.csv, COLS, start + dt.timedelta(days=i), vals(600 + i, 700, 600, 700))
            self.assertLessEqual(len(rows), 30)
        self.assertEqual(min(rows), start + dt.timedelta(days=15))


class JobTests(unittest.TestCase):
    """Runs scrape_job.run() against a temp copy of the repo layout with a fake scraper."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "data").mkdir()
        (self.root / "config.json").write_text((ROOT / "config.json").read_text(encoding="utf-8"), encoding="utf-8")
        self.today = D(2026, 11, 3)

    def tearDown(self):
        self.tmp.cleanup()

    def _run(self, side_effect):
        with mock.patch.object(scraper, "robots_allows", return_value=True), \
             mock.patch.object(scraper, "scrape_station", side_effect=side_effect), \
             mock.patch("time.sleep"):
            return scrape_job.run(self.root, today=self.today)

    def test_success_writes_csv_and_status(self):
        code = self._run(lambda url, cfg: {"95": 627, "premium": 697})
        self.assertEqual(code, 0)
        self.assertIn("2026-11-03,627,697,627,697", (self.root / "data" / "prices.csv").read_text(encoding="utf-8"))
        st = json.loads((self.root / "data" / "status.json").read_text(encoding="utf-8"))
        self.assertEqual((st["date"], st["missing"]), ("2026-11-03", []))

    def test_one_station_fails_is_partial_success(self):
        def fake(url, cfg):
            if "fot" in url:
                raise scraper.ScrapeError("layout changed")
            return {"95": 627, "premium": 697}
        code = self._run(fake)
        self.assertEqual(code, 0)
        st = json.loads((self.root / "data" / "status.json").read_text(encoding="utf-8"))
        self.assertEqual(st["missing"], ["fot_95", "fot_premium"])
        self.assertIn("layout changed", st["errors"]["fot"])

    def test_total_failure_returns_1_but_records_gap_row(self):
        def boom(url, cfg):
            raise scraper.ScrapeError("down")
        self.assertEqual(self._run(boom), 1)
        self.assertIn("2026-11-03,,,,", (self.root / "data" / "prices.csv").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
