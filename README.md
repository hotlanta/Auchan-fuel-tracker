# Auchan Fuel Tracker: web app (GitHub Actions + GitHub Pages)

## 1. Overview
- **GitHub Actions** runs `scrape_job.py` once a day in the cloud. It reads the 95 and Pro 100 prices for Auchan **Dunakeszi** and **Fót** and commits them to `data/prices.csv` (rolling 30 days).
- **GitHub Pages** hosts the installable web app in `docs/`. On your Android phone it downloads the CSV, draws the 4-line chart, and shows a **BUY NOW / WAIT / NEUTRAL** verdict with the reason.
- Nothing runs on your phone in the background. The app only displays data, so Android battery limits don't matter.

```
GitHub (free)                                      Your phone
 Actions: daily scrape -> data/prices.csv  <-reads-  Web app (installed from Chrome)
 Pages:   docs/ (the app)  ----------------------->  chart + recommendation
```

## 2. What you need
- A free GitHub account (https://github.com/signup) and a **public** repository.
- Chrome on Android. A PC makes the one-time upload easier, but isn't required.

Not needed: Python, Android Studio, Termux, or any paid service.

## 3. Setup (about 15 minutes)
1. **Create the repository.** GitHub → **New repository** → name it e.g. `fuel-tracker` → **Public** → leave "Add a README" unticked → **Create**.
2. **Upload the files.** Unzip this project on a PC. On the new repo page click **uploading an existing file**, then drag in the **contents** of the unzipped folder (`.github`, `data`, `docs`, `tests`, and the files). Click **Commit changes**.
   - Check that `.github/workflows/daily.yml` appears in the file list. If it doesn't (some browsers skip dot-folders): **Add file → Create new file**, type `.github/workflows/daily.yml` as the name, paste the file's contents and commit.
3. **Allow the job to save data.** Repo → **Settings → Actions → General → Workflow permissions → Read and write permissions → Save**.
4. **Run it once.** Repo → **Actions** tab → *Daily fuel price scrape* → **Run workflow**. After 2–4 minutes it should show a green tick, and `data/prices.csv` will have a row for today. (If GitHub asks, click "I understand my workflows, go ahead and enable them".)
5. **Turn on the app.** Repo → **Settings → Pages → Source: Deploy from a branch → Branch `main`, folder `/docs` → Save**. After a minute or two the address appears: `https://YOUR-USERNAME.github.io/fuel-tracker/`
6. **Install on Android.** Open that address in Chrome → ⋮ menu → **Install app** (or **Add to Home screen**). It then opens full screen like a normal app.
7. **Preview first (optional).** Add `?demo` to the address (`.../fuel-tracker/?demo`) to see the app with made-up prices.

The app shows "Collecting data" for the first 5 days. Past prices can't be recovered, so history starts on the day of the first run.

## 4. Using the app
- **95 / Pro 100** switch: the verdict, tiles and statistics follow the selected fuel. The chart always shows all 4 lines (solid = 95, dashed = Pro 100; blue = Dunakeszi, orange = Fót).
- Chart markers: ★ cheapest option on the newest day, ▼ lowest and ▲ highest price in the window, grey band = a day with no data. Touch the chart to read prices for a day.
- **↻** reloads the data. The app also reloads when you return to it.
- Warnings appear if the newest data is more than 2 days old, if today's scrape couldn't read a price, or if you're offline (it then shows the last saved copy).

## 5. How the recommendation works (`recommend()` in `docs/app.js`)
It uses the cheapest station's price for each day, over the last 30 days:

| Situation | Verdict |
|---|---|
| Fewer than 5 days of data | Collecting data |
| 30-day range under 5 Ft | NEUTRAL: prices are steady |
| Trend falling (slope below −0.3 Ft/day over the last 7 data points) | **WAIT** |
| In the bottom 20% of the range and not falling | **BUY NOW** |
| Rising and below the top 20% of the range | **BUY NOW** (fill up before it climbs) |
| In the top 20% and not rising | **WAIT** (expensive vs. recent days) |
| In the top 20% and rising | NEUTRAL: buy only if you need to |
| Anything else | NEUTRAL: mid-range |

This is a simple rule on recent history, **not a forecast**. All thresholds are at the top of `docs/app.js` in `CONFIG`.

## 6. The 30-day rolling logic (`storage.py`)
- One row per calendar date, so a second run on the same day updates that row (no duplicates).
- A failed scrape never erases a good value.
- Missed days become blank rows (gaps), which show as breaks in the chart.
- Rows older than 30 days are deleted, so the table never exceeds 30 rows.
- The date used is **Hungarian local time** (`timezone` in `config.json`), not the server's UTC date.

## 7. Where the data lives
`data/prices.csv` (the table) and `data/status.json` (last run, plus any errors) in your repository. Since the repository is public, anyone can read it. It only contains public fuel prices. The app reads the CSV from `raw.githubusercontent.com`, which can lag by up to ~5 minutes after the job commits.

## 8. Configuration
| What | Where |
|---|---|
| Station URLs, labels (`Pro 100`), retries, timezone | `config.json` |
| Run time | `.github/workflows/daily.yml` → `cron: "23 7 * * *"` (**UTC**; 07:23 UTC = 08:23 in winter, 09:23 in summer in Hungary). Scheduled runs can start a few minutes late. |
| Recommendation thresholds, data address | top of `docs/app.js` (`CONFIG`) |
| Cheaper/other stations | add to `stations` in both `config.json` and `docs/app.js` (the CSV columns must match: `<key>_95`, `<key>_premium`) |

You can edit any file on github.com (✎ pencil icon → Commit). Changes to `docs/` go live a minute or two later. If the app seems stuck on an old version, close it fully and reopen it.

## 9. Troubleshooting
| Symptom | Fix |
|---|---|
| Workflow fails with "permission denied" on push | Step 3 of setup (Read and write permissions) |
| Actions tab shows no workflow | `.github/workflows/daily.yml` wasn't uploaded; create it manually (setup step 2) |
| App: "Could not load data" | The repo must be **public**, and the branch must be `main`. Otherwise set `dataUrl` and `statusUrl` in `docs/app.js` to the raw address of `data/prices.csv`. Don't use a private repo with this design. |
| App says data is N days old | Open **Actions** and look at the latest run. If runs stopped, see section 10. |
| Run log: `'Üzemanyagárak' section not found` | The site layout changed (section 11) |
| Run log: `Fuel '...' not found. Labels on page: [...]` | A label was renamed: update `fuel_labels` in `config.json` |
| Run log: `robots.txt DISALLOWS` | The job skips that page by design. Don't override it |
| A failed run | GitHub emails you about failed workflow runs (check Settings → Notifications → Actions) |

## 10. Things to know about GitHub's schedule
- GitHub's documentation says scheduled workflows in a **public** repository are **disabled automatically after 60 days without repository activity**. The daily data commit should count as activity, but I couldn't verify that. If the app starts showing old data, open **Actions**, select the workflow and click **Enable workflow**. The app's "data is N days old" warning tells you when this happens.
- Check GitHub's current Actions and Pages terms and limits yourself. Public repositories are free at the time of writing.
- The workflow runs as `github-actions[bot]`, using the action versions `actions/checkout@v7` and `actions/setup-python@v6`. If GitHub retires one, the run log will say so; bump the version in `daily.yml`.

## 11. If the site layout changes
1. Open the failed run's log in **Actions**. It lists the labels it did find.
2. Label renamed → edit `fuel_labels` in `config.json`.
3. Heading words changed → edit `SECTION_START` / `SECTION_END` at the top of `scraper.py`. As of 3 Nov 2026 the page text reads `Üzemanyagárak 95 627 Ft Pro 100 697 Ft D 718 Ft … Cím`.
4. Price format changed → edit `PRICE_RE` in `scraper.py`.
5. Add the new page text to `SAMPLE` in `tests/test_python.py` to lock the fix in.

The scraper tries a plain HTTP request first and uses headless Chromium if the prices are built by JavaScript. The workflow installs Chromium on every run.

## 12. Tests
**On GitHub:** run the workflow (setup step 4) and open `data/prices.csv`. Then open the app, and use `?demo` to check the display.

**On a PC (optional):**
```
node --test tests/test_app.js                      # 13 tests: CSV parsing, recommendation rules, chart
pip install requests beautifulsoup4 tzdata
python -m unittest discover -s tests -v            # 11 tests: parser, 30-day logic, the daily job
python scrape_job.py --dry-run                     # live scrape, saves nothing
python -m http.server 8000                         # then open http://localhost:8000/docs/?demo
```
Manual check of gaps: edit `data/prices.csv` on GitHub, delete yesterday's row, and run the workflow → the next run adds a blank gap row, and the chart shows a grey band.

## 13. Compliance
One request per station per day, an identifying user agent, and `robots.txt` checked on every run. This is for personal use. Read Auchan's terms of use yourself and stop if they don't allow it.
