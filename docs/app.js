"use strict";
/* Auchan Fuel Tracker - web app logic.
 * Pure functions (parse / analyse / recommend / draw chart) are exported for the Node tests.
 * Browser-only code is at the bottom, inside init(). */

const CONFIG = {
  dataUrl: null,            // null = auto-detect from the GitHub Pages address (see dataUrls())
  statusUrl: null,
  branch: "main",
  dataPath: "data/prices.csv",
  statusPath: "data/status.json",
  minPoints: 5,             // days of data needed before a recommendation is given
  trendPoints: 7,           // trend = slope over the last N data points
  flatThreshold: 0.3,       // HUF/day: slope inside +-this counts as "flat"
  stableRange: 5,           // HUF: 30-day range below this = "prices barely move"
  nearLow: 0.2,             // bottom 20% of the 30-day range = "near the low"
  nearHigh: 0.8,            // top 20% = "expensive"
  staleDays: 2,             // warn if newest data is older than this
  stations: [{ key: "dunakeszi", name: "Dunakeszi" }, { key: "fot", name: "Fót" }],
  fuels: [{ key: "95", label: "95" }, { key: "premium", label: "Pro 100" }],
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const GEOM = { W: 360, H: 290, L: 40, R: 12, T: 14, B: 30 };

// ---------- data ----------
function allSeries(cfg = CONFIG) {
  const out = [];
  cfg.stations.forEach((st, si) => cfg.fuels.forEach((f, fi) =>
    out.push({ col: `${st.key}_${f.key}`, label: `${st.name} ${f.label}`, station: st.key, stationName: st.name,
               fuel: f.key, cls: `s${si * 2 + fi}`, dashed: fi === 1 })));
  return out;
}

function parseCsv(text) {
  const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.trim());
  if (lines.length < 1) return [];
  const header = lines[0].split(",").map((h) => h.trim());
  const rows = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    const row = { date: (cells[0] || "").trim(), v: {} };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date)) continue;
    header.slice(1).forEach((h, i) => {
      const x = parseFloat(cells[i + 1]);
      row.v[h] = Number.isFinite(x) ? x : null;
    });
    rows.push(row);
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

function daysBetween(isoA, isoB) {
  const t = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  return Math.round((t(isoB) - t(isoA)) / 86400000);
}

function fmtDate(iso) { return `${+iso.slice(8, 10)} ${MONTHS[+iso.slice(5, 7) - 1]}`; }

/** For one fuel: the cheapest station on every day that has data. */
function bestSeries(rows, fuel, cfg = CONFIG) {
  const best = [];
  rows.forEach((row, idx) => {
    const c = cfg.stations
      .map((s) => ({ station: s.name, price: row.v[`${s.key}_${fuel}`] }))
      .filter((x) => x.price != null);
    if (!c.length) return;
    const min = Math.min(...c.map((x) => x.price));
    best.push({ idx, date: row.date, price: min, stations: c.filter((x) => x.price === min).map((x) => x.station), all: c });
  });
  return best;
}

function slopeOf(points) { // least squares, points = [[x, y], ...] -> y change per x
  if (points.length < 3) return null;
  const mx = points.reduce((a, p) => a + p[0], 0) / points.length;
  const my = points.reduce((a, p) => a + p[1], 0) / points.length;
  const den = points.reduce((a, p) => a + (p[0] - mx) ** 2, 0);
  return den ? points.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0) / den : 0;
}

function trendWord(slope, cfg = CONFIG) {
  if (slope == null) return { sym: "·", word: "not enough data" };
  if (slope > cfg.flatThreshold) return { sym: "▲", word: "rising" };
  if (slope < -cfg.flatThreshold) return { sym: "▼", word: "falling" };
  return { sym: "▬", word: "flat" };
}

// ---------- recommendation ----------
/** Simple rule-based advice from recent history. NOT a forecast. */
function recommend(best, cfg = CONFIG) {
  const n = best.length;
  if (n < cfg.minPoints) {
    return { verdict: "NODATA", title: "Collecting data",
      reason: `${n} of ${cfg.minPoints} days recorded so far. Advice starts once there is enough history.`, stats: { n } };
  }
  const vals = best.map((b) => b.price);
  const cur = vals[n - 1], low = Math.min(...vals), high = Math.max(...vals);
  const avg = vals.reduce((a, b) => a + b, 0) / n, range = high - low;
  const pos = range > 0 ? (cur - low) / range : 0.5;
  const slope = slopeOf(best.slice(-cfg.trendPoints).map((b) => [b.idx, b.price]));
  const t = trendWord(slope, cfg);
  const stats = { n, cur, low, high, avg, range, pos, slope, trend: t };
  const spd = slope == null ? "" : `${Math.abs(slope).toFixed(1)} Ft/day`;
  const where = pos <= 0 ? `${cur} Ft is the lowest price of the last 30 days (high: ${high}).`
    : pos >= 1 ? `${cur} Ft is the highest price of the last 30 days (low: ${low}).`
    : `${cur} Ft is ${Math.round(pos * 100)}% of the way from the 30-day low (${low}) to the high (${high}).`;

  let verdict, title, reason;
  if (range < cfg.stableRange) {
    verdict = "NEUTRAL"; title = "Prices are steady";
    reason = `Prices moved only ${range} Ft over ${n} days. Fill up whenever it suits you.`;
  } else if (slope < -cfg.flatThreshold) {
    verdict = "WAIT"; title = "Prices are falling";
    reason = `Down about ${spd} recently, so it may keep dropping. ${where}` +
      (pos <= cfg.nearLow ? " Already near the low: wait only if your tank allows." : "");
  } else if (pos <= cfg.nearLow) {
    verdict = "BUY"; title = "Near the 30-day low";
    reason = `${where} The trend is ${t.word}, so it is no longer dropping.`;
  } else if (slope > cfg.flatThreshold && pos < cfg.nearHigh) {
    verdict = "BUY"; title = "Rising: fill up soon";
    reason = `Up about ${spd} recently and not yet at the high. ${where}`;
  } else if (pos >= cfg.nearHigh) {
    if (slope > cfg.flatThreshold) {
      verdict = "NEUTRAL"; title = "High and still rising";
      reason = `${where} Buy only if you need to; waiting is unlikely to help.`;
    } else {
      verdict = "WAIT"; title = "Expensive right now";
      reason = `${where} The trend is ${t.word}. Prices have been lower recently.`;
    }
  } else {
    verdict = "NEUTRAL"; title = "Mid-range";
    reason = `${where} Trend: ${t.word}. No strong reason to buy or wait.`;
  }
  const last = best[n - 1];
  const others = last.all.filter((x) => !last.stations.includes(x.station));
  let cheapest;
  if (!others.length) cheapest = last.stations.length > 1 ? `Same price at both stations: ${cur} Ft` : `${last.stations[0]}: ${cur} Ft`;
  else cheapest = `Cheapest: ${last.stations.join(" / ")} at ${cur} Ft (${others.map((o) => `${o.station} +${o.price - cur}`).join(", ")})`;
  return { verdict, title, reason, cheapest, asOf: last.date, stats };
}

// ---------- chart ----------
function niceTicks(min, max) {
  const span = Math.max(max - min, 10);
  const step = span <= 20 ? 5 : span <= 50 ? 10 : span <= 120 ? 20 : 50;
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + 1e-9; v += step) ticks.push(v);
  if (ticks.length < 2) ticks.push(ticks[0] + step); // all prices identical: still need a y-range
  return ticks;
}

function buildChartSvg(rows, cfg = CONFIG) {
  const { W, H, L, R, T, B } = GEOM;
  const n = rows.length, series = allSeries(cfg);
  const pts = [];
  series.forEach((s) => rows.forEach((r, i) => { if (r.v[s.col] != null) pts.push({ i, v: r.v[s.col], s, date: r.date }); }));
  if (!n || !pts.length) {
    return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="No data"><text x="${W / 2}" y="${H / 2}" text-anchor="middle" class="axis">No data yet</text></svg>`;
  }
  const ticks = niceTicks(Math.min(...pts.map((p) => p.v)), Math.max(...pts.map((p) => p.v)));
  const y0 = ticks[0], y1 = ticks[ticks.length - 1];
  const px = (i) => L + (n === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (n - 1));
  const py = (v) => T + ((y1 - v) * (H - T - B)) / (y1 - y0);
  const f = (x) => x.toFixed(1);
  let out = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Fuel price chart, last ${n} days">`;

  ticks.forEach((t) => {
    out += `<line class="grid" x1="${L}" x2="${W - R}" y1="${f(py(t))}" y2="${f(py(t))}"/>` +
           `<text class="axis" x="${L - 5}" y="${f(py(t) + 3.5)}" text-anchor="end">${t}</text>`;
  });
  const labelIdx = [...new Set(Array.from({ length: Math.min(n, 5) }, (_, k) => (n === 1 ? 0 : Math.round((k * (n - 1)) / (Math.min(n, 5) - 1)))))];
  labelIdx.forEach((i) => { out += `<text class="axis" x="${f(px(i))}" y="${H - 10}" text-anchor="middle">${fmtDate(rows[i].date)}</text>`; });
  // days with no data at all -> grey band
  const bw = n > 1 ? (W - L - R) / (n - 1) : 20;
  rows.forEach((r, i) => {
    if (series.every((s) => r.v[s.col] == null))
      out += `<rect class="gap" x="${f(px(i) - bw / 2)}" y="${T}" width="${f(bw)}" height="${H - T - B}"/>`;
  });
  // lines (broken where data is missing) + dots
  series.forEach((s) => {
    let d = "", pen = false;
    rows.forEach((r, i) => {
      const v = r.v[s.col];
      if (v == null) { pen = false; return; }
      d += `${pen ? "L" : "M"}${f(px(i))} ${f(py(v))}`;
      pen = true;
    });
    out += `<path class="line ${s.cls}${s.dashed ? " dash" : ""}" d="${d}"/>`;
    rows.forEach((r, i) => { if (r.v[s.col] != null) out += `<circle class="dot ${s.cls}" cx="${f(px(i))}" cy="${f(py(r.v[s.col]))}" r="2"/>`; });
  });
  // 30-day low / high (over all lines) and cheapest now
  const lo = pts.reduce((a, p) => (p.v < a.v ? p : a)), hi = pts.reduce((a, p) => (p.v > a.v ? p : a));
  const tri = (x, y, up, cls) => `<polygon class="${cls}" points="${up ? `${f(x)},${f(y - 8)} ${f(x - 6)},${f(y + 3)} ${f(x + 6)},${f(y + 3)}` : `${f(x)},${f(y + 8)} ${f(x - 6)},${f(y - 3)} ${f(x + 6)},${f(y - 3)}`}"/>`;
  out += tri(px(lo.i), py(lo.v), false, "mk-low") + tri(px(hi.i), py(hi.v), true, "mk-high");
  const latest = Math.max(...pts.map((p) => p.i));
  const today = pts.filter((p) => p.i === latest), cheapest = Math.min(...today.map((p) => p.v));
  const sx = px(latest), sy = py(cheapest);
  const star = Array.from({ length: 10 }, (_, k) => { const a = -Math.PI / 2 + (k * Math.PI) / 5, r = k % 2 ? 4.5 : 10; return `${f(sx + r * Math.cos(a))},${f(sy + r * Math.sin(a))}`; }).join(" ");
  out += `<polygon class="mk-star" points="${star}"/>`;
  out += `<line id="cross" class="cross" x1="0" x2="0" y1="${T}" y2="${H - B}" visibility="hidden"/></svg>`;
  return out;
}

// ---------- demo data (open the app with ?demo) ----------
function demoRows(days = 30, endIso = null) {
  const end = endIso ? new Date(endIso + "T00:00:00Z") : new Date();
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const rows = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate() - i));
    const k = days - 1 - i, base = 640 - k * 0.9 + 5 * Math.sin(k / 3);
    const miss = [9, 10, 21].includes(k);
    const r = (x) => (miss ? null : Math.round(x));
    rows.push({ date: d.toISOString().slice(0, 10), v: {
      dunakeszi_95: r(base), dunakeszi_premium: r(base + 70),
      fot_95: r(base + (rnd() < 0.4 ? 3 : 0)), fot_premium: r(base + 70 + (rnd() < 0.4 ? 2 : 0)) } });
  }
  return rows;
}

if (typeof module !== "undefined") {
  module.exports = { CONFIG, GEOM, allSeries, parseCsv, daysBetween, fmtDate, bestSeries, slopeOf, trendWord,
                     recommend, buildChartSvg, niceTicks, demoRows };
}

// ====================== browser-only part ======================
function dataUrls() {
  if (CONFIG.dataUrl) return { csv: CONFIG.dataUrl, status: CONFIG.statusUrl };
  const h = location.hostname;
  if (h.endsWith(".github.io")) {            // https://OWNER.github.io/REPO/  ->  raw file in the same repo
    const owner = h.split(".")[0], repo = location.pathname.split("/")[1];
    const base = `https://raw.githubusercontent.com/${owner}/${repo}/${CONFIG.branch}/`;
    return { csv: base + CONFIG.dataPath, status: base + CONFIG.statusPath };
  }
  return { csv: "../" + CONFIG.dataPath, status: "../" + CONFIG.statusPath }; // local test: serve repo root, open /docs/
}

function init() {
  const $ = (id) => document.getElementById(id);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage may be unavailable */ } },
  };
  const state = { rows: [], fuel: store.get("fuel.fuel") || "95", banners: [], status: null };
  const isDemo = new URLSearchParams(location.search).has("demo");

  async function load() {
    state.banners = [];
    if (isDemo) {
      state.rows = demoRows();
      state.banners.push(["info", "DEMO DATA. These are made-up prices to preview the app."]);
      return;
    }
    const u = dataUrls(), bust = `?t=${Math.floor(Date.now() / 600000)}`;
    try {
      const r = await fetch(u.csv + bust, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const text = await r.text();
      state.rows = parseCsv(text);
      store.set("fuel.csv", text); store.set("fuel.csvAt", new Date().toISOString());
    } catch (e) {
      const saved = store.get("fuel.csv");
      if (saved) {
        state.rows = parseCsv(saved);
        state.banners.push(["warn", `Offline or GitHub unreachable. Showing data saved on ${(store.get("fuel.csvAt") || "").slice(0, 10)}.`]);
      } else {
        state.rows = [];
        state.banners.push(["warn", `Could not load data (${e.message}). Check the data address in app.js and that the repository is public.`]);
      }
    }
    try {
      const s = await fetch(u.status + bust, { cache: "no-store" });
      state.status = s.ok ? await s.json() : null;
    } catch (e) { state.status = null; }
  }

  function banners() {
    const list = state.banners.slice();
    const rows = state.rows;
    const lastWithData = [...rows].reverse().find((r) => Object.values(r.v).some((x) => x != null));
    if (!isDemo && lastWithData) {
      const today = new Date().toISOString().slice(0, 10);
      const age = daysBetween(lastWithData.date, today);
      if (age > CONFIG.staleDays) list.push(["warn", `Latest prices are from ${fmtDate(lastWithData.date)} (${age} days ago). The daily job may have stopped: check the Actions tab in your GitHub repository.`]);
    }
    if (!isDemo && !rows.length && !list.length) list.push(["info", "No data yet. In GitHub: Actions → Daily fuel price scrape → Run workflow."]);
    const st = state.status, names = Object.fromEntries(allSeries().map((s) => [s.col, s.label]));
    if (st && st.missing && st.missing.length && lastWithData && st.date === lastWithData.date)
      list.push(["warn", `Today's scrape could not read: ${st.missing.map((c) => names[c] || c).join(", ")}.`]);
    $("banners").innerHTML = list.map(([k, m]) => `<div class="banner ${k}">${m}</div>`).join("");
  }

  function render() {
    banners();
    document.querySelectorAll("#fuelSwitch button").forEach((b) => b.classList.toggle("active", b.dataset.fuel === state.fuel));
    const fuelLabel = CONFIG.fuels.find((f) => f.key === state.fuel).label;
    const best = bestSeries(state.rows, state.fuel), rec = recommend(best);
    const badge = { BUY: "BUY NOW", WAIT: "WAIT", NEUTRAL: "NEUTRAL", NODATA: "…" }[rec.verdict];
    $("verdict").className = `card verdict ${rec.verdict.toLowerCase()}`;
    $("vbadge").textContent = badge;
    $("vtitle").textContent = `${fuelLabel}: ${rec.title}`;
    $("vreason").textContent = rec.reason;
    $("vwhere").textContent = rec.cheapest || "";
    const s = rec.stats, last = best[best.length - 1];
    const tile = (k, v, sub = "") => `<div class="tile"><span>${k}</span><b>${v}</b><small>${sub}</small></div>`;
    const stationTile = (st) => {
      const lastRow = [...state.rows].reverse().find((r) => r.v[`${st.key}_${state.fuel}`] != null);
      return lastRow ? tile(st.name, `${lastRow.v[`${st.key}_${state.fuel}`]} Ft`, fmtDate(lastRow.date)) : tile(st.name, "–", "no data");
    };
    $("tiles").innerHTML = CONFIG.stations.map(stationTile).join("") +
      (s.low != null ? tile("30-day low", `${s.low} Ft`) + tile("30-day high", `${s.high} Ft`) +
        tile("Average", `${s.avg.toFixed(0)} Ft`) + tile("Trend", `${s.trend.sym} ${s.trend.word}`, s.slope == null ? "" : `${s.slope >= 0 ? "+" : ""}${s.slope.toFixed(1)} Ft/day`)
        : tile("30-day low", "–") + tile("30-day high", "–") + tile("Average", "–") + tile("Trend", "–"));
    $("updated").textContent = last ? `Updated ${fmtDate(last.date)}` : "";

    $("chart").innerHTML = buildChartSvg(state.rows);
    $("legend").innerHTML = allSeries().map((sr) => {
      const r = [...state.rows].reverse().find((x) => x.v[sr.col] != null);
      return `<span class="lg"><i class="${sr.cls}${sr.dashed ? " dash" : ""}"></i>${sr.label}${r ? ` <b>${r.v[sr.col]}</b>` : ""}</span>`;
    }).join("");
    $("readout").textContent = "Touch the chart to see prices for a day.   ★ cheapest now  ▼ low  ▲ high";
    bindChart();
  }

  function bindChart() {
    const box = $("chart"), svg = box.querySelector("svg"), cross = svg && svg.querySelector("#cross");
    if (!svg || !cross || !state.rows.length) return;
    const { W, L, R } = GEOM, n = state.rows.length;
    const show = (ev) => {
      const rect = svg.getBoundingClientRect();
      const x = ((ev.clientX - rect.left) / rect.width) * W;
      const i = Math.max(0, Math.min(n - 1, n === 1 ? 0 : Math.round(((x - L) / (W - L - R)) * (n - 1))));
      const cx = L + (n === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (n - 1));
      cross.setAttribute("x1", cx); cross.setAttribute("x2", cx); cross.setAttribute("visibility", "visible");
      const r = state.rows[i];
      $("readout").textContent = `${fmtDate(r.date)}:  ` + allSeries().map((s) => `${s.label} ${r.v[s.col] ?? "–"}`).join("  ·  ");
    };
    box.onpointerdown = show; box.onpointermove = (e) => { if (e.buttons || e.pointerType === "touch") show(e); };
  }

  document.querySelectorAll("#fuelSwitch button").forEach((b) => b.addEventListener("click", () => {
    state.fuel = b.dataset.fuel; store.set("fuel.fuel", state.fuel); render();
  }));
  $("refresh").addEventListener("click", async () => { $("refresh").classList.add("spin"); await load(); render(); $("refresh").classList.remove("spin"); });
  document.addEventListener("visibilitychange", async () => { if (!document.hidden) { await load(); render(); } });

  load().then(render);
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) navigator.serviceWorker.register("sw.js").catch(() => {});
}

if (typeof document !== "undefined") init();
