// Run:  node --test tests/test_app.js   (Node 18+; no packages needed)
const test = require("node:test");
const assert = require("node:assert");
const A = require("../docs/app.js");

const mk = (vals95, vals100 = null) => vals95.map((v, i) => ({
  date: new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10),
  v: { dunakeszi_95: v, fot_95: v == null ? null : v + 2, dunakeszi_premium: vals100 ? vals100[i] : 700, fot_premium: 700 },
}));
const rec = (arr) => A.recommend(A.bestSeries(mk(arr), "95"));

test("parseCsv handles blanks, CRLF and sorts by date", () => {
  const rows = A.parseCsv("date,dunakeszi_95,fot_95\r\n2026-11-02,630,\r\n2026-11-01,627,629\r\nbad,1,2\r\n");
  assert.deepStrictEqual(rows.map((r) => r.date), ["2026-11-01", "2026-11-02"]);
  assert.strictEqual(rows[1].v.fot_95, null);
  assert.strictEqual(rows[0].v.fot_95, 629);
  assert.deepStrictEqual(A.parseCsv("date,a\n"), []);
});

test("bestSeries picks the cheaper station and skips empty days", () => {
  const best = A.bestSeries(mk([630, null, 628]), "95");
  assert.strictEqual(best.length, 2);
  assert.deepStrictEqual(best[0].stations, ["Dunakeszi"]);
  assert.strictEqual(best[1].price, 628);
});

test("not enough data -> NODATA", () => {
  const r = rec([630, 629, 628]);
  assert.strictEqual(r.verdict, "NODATA");
  assert.match(r.reason, /3 of 5/);
});

test("steady prices -> NEUTRAL", () => assert.strictEqual(rec(Array(20).fill(630)).verdict, "NEUTRAL"));

test("falling prices -> WAIT", () => {
  const r = rec(Array.from({ length: 20 }, (_, i) => 650 - i * 2));
  assert.strictEqual(r.verdict, "WAIT");
  assert.strictEqual(r.stats.trend.word, "falling");
});

test("bounced off the low and flat -> BUY", () => {
  const arr = [660, 655, 650, 645, 640, 635, 630, 628, 628, 629, 628, 629, 628, 629, 628];
  const r = rec(arr);
  assert.strictEqual(r.verdict, "BUY");
  assert.match(r.title, /low/i);
});

test("rising from mid-range -> BUY", () => {
  const arr = [640, 650, 645, 640, 645, 650, 655, 650, 645, 640, 642, 644, 646, 648, 650, 652];
  const r = rec([...arr, 654, 656]);
  assert.ok(["BUY", "NEUTRAL"].includes(r.verdict));
});

test("rising to the high -> NEUTRAL, flat at the high -> WAIT", () => {
  const base = [620, 622, 621, 620, 623, 622, 621, 620];
  assert.strictEqual(rec([...base, 624, 628, 632, 636, 640, 644, 648]).verdict, "NEUTRAL");
  assert.strictEqual(rec([...base, 648, 648, 648, 648, 648, 648, 648]).verdict, "WAIT");
});

test("cheapest-station text handles ties and differences", () => {
  const tie = A.recommend(A.bestSeries([...mk(Array(6).fill(630))].map((r) => ({ ...r, v: { ...r.v, fot_95: 630 } })), "95"));
  assert.match(tie.cheapest, /Same price/);
  assert.match(rec(Array.from({ length: 8 }, (_, i) => 630 + (i % 3))).cheapest, /Dunakeszi at \d+ Ft \(Fót \+2\)/);
});

test("slope and trend words", () => {
  assert.strictEqual(A.slopeOf([[0, 1], [1, 3], [2, 5]]), 2);
  assert.strictEqual(A.slopeOf([[0, 1], [1, 1]]), null);
  assert.strictEqual(A.trendWord(1).word, "rising");
  assert.strictEqual(A.trendWord(-1).word, "falling");
  assert.strictEqual(A.trendWord(0.1).word, "flat");
});

test("chart: 4 lines, gap breaks the line, markers present", () => {
  const rows = A.demoRows(30, "2026-11-03");
  assert.strictEqual(rows.length, 30);
  const svg = A.buildChartSvg(rows);
  assert.strictEqual((svg.match(/<path class="line/g) || []).length, 4);
  assert.strictEqual((svg.match(/M\d/g) || []).length, 4 * 3, "each line is split into 3 pieces by the 2 gaps");
  assert.match(svg, /mk-low/); assert.match(svg, /mk-high/); assert.match(svg, /mk-star/); assert.match(svg, /class="gap"/);
  assert.doesNotMatch(svg, /NaN|undefined/);
});

test("chart: empty, single-row and all-null inputs do not crash", () => {
  assert.match(A.buildChartSvg([]), /No data yet/);
  assert.doesNotMatch(A.buildChartSvg(mk([630])), /NaN/);
  assert.match(A.buildChartSvg([{ date: "2026-11-01", v: {} }, { date: "2026-11-02", v: { fot_95: null } }]), /No data yet/);
  assert.doesNotMatch(A.buildChartSvg(mk(Array(6).fill(630))), /NaN/); // identical prices
});

test("daysBetween and fmtDate", () => {
  assert.strictEqual(A.daysBetween("2026-10-30", "2026-11-02"), 3);
  assert.strictEqual(A.fmtDate("2026-11-03"), "3 Nov");
});
