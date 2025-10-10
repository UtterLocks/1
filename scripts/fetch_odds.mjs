// scripts/fetch_odds.mjs
// Merges your model CSV (data/cfb.csv) with live Pinnacle lines into data/cfb_live.csv
// Uses team map at data/team_name_map.csv

import fs from "node:fs/promises";

// --- tiny CSV helpers (no external deps) ---
const parseCSV = (text) => {
  const lines = text.replace(/\r/g, "").split("\n").filter(Boolean);
  const head = splitLine(lines[0]).map(s => s.trim());
  return lines.slice(1).map((ln) => {
    const cells = splitLine(ln);
    const row = {};
    head.forEach((h, i) => (row[h] = (cells[i] ?? "").trim()));
    return row;
  });
};
const splitLine = (line) => {
  const out = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (q && line[i + 1] === '"') { cur += '"'; i++; }
      else { q = !q; }
    } else if (ch === "," && !q) { out.push(cur); cur = ""; }
    else { cur += ch; }
  }
  out.push(cur);
  return out;
};
const toCSV = (rows) => {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    const s = v ?? "";
    return /[",\n]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s);
  };
  return [cols.join(","), ...rows.map(r => cols.map(c => esc(r[c])).join(","))].join("\n");
};

// --- config / env ---
const apiKey   = process.env.ODDS_API_KEY;
const timezone = process.env.TIMEZONE || "America/Chicago";
const books    = (process.env.BOOKS || "pinnacle").split(","); // priority order

if (!apiKey) {
  console.error("❌ ODDS_API_KEY secret missing.");
  process.exit(1);
}

// --- paths in your repo (as you shared) ---
const MODEL_CSV = "data/cfb.csv";              // your projections
const MAP_CSV   = "data/team_name_map.csv";    // cfbd_name,odds_name
const OUT_CSV   = "data/cfb_live.csv";         // merged output

// --- helper: number
const num = (x) => {
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
};

// --- 1) load your CSVs ---
const [modelText, mapText] = await Promise.all([
  fs.readFile(MODEL_CSV, "utf8"),
  fs.readFile(MAP_CSV, "utf8"),
]);
const model = parseCSV(modelText);
const nameMapRows = parseCSV(mapText);
const oddsNameToCfbd = new Map(nameMapRows.map(r => [r.odds_name, r.cfbd_name]));

// quick normalizer
const norm = s => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "").trim();

// --- 2) fetch odds (spreads + totals) ---
const url = new URL("https://api.the-odds-api.com/v4/sports/americanfootball_ncaaf/odds");
url.searchParams.set("apiKey", apiKey);
url.searchParams.set("regions", "us,eu");
url.searchParams.set("markets", "spreads,totals");
url.searchParams.set("oddsFormat", "american"); // not used for points, but fine

const res = await fetch(url.toString());
if (!res.ok) {
  console.error(`❌ Odds API HTTP ${res.status}`);
  process.exit(1);
}
const games = await res.json(); // array

// --- 3) build a lookup of lines keyed by (Home, Away) in CFBD names ---
/**
 * We choose the first available bookmaker from your priority list: books[0], then fallback.
 * Spread = Away - Home (same sign convention as your model xSpread)
 * Total  = closing/market total points
 */
const oddsLookup = new Map();

for (const g of games) {
  const homeOddsName = g.home_team;
  const awayOddsName = g.away_team;
  if (!homeOddsName || !awayOddsName) continue;

  const home = oddsNameToCfbd.get(homeOddsName) || homeOddsName;
  const away = oddsNameToCfbd.get(awayOddsName) || awayOddsName;

  // pick preferred book
  const list = Array.isArray(g.bookmakers) ? g.bookmakers : [];
  let picked = null;
  for (const b of books) {
    picked = list.find(x => x?.key === b);
    if (picked) break;
  }
  if (!picked && list.length) picked = list[0];
  if (!picked) continue;

  let spread = null;
  let total  = null;

  for (const mkt of (picked.markets || [])) {
    if (mkt.key === "spreads") {
      // outcomes have { name, point }
      const awayOutcome = (mkt.outcomes || []).find(o => o?.name === awayOddsName);
      const pt = num(awayOutcome?.point);
      if (pt != null) spread = -pt; // convert to Away-Home per your convention
    }
    if (mkt.key === "totals") {
      const overOutcome = (mkt.outcomes || []).find(o => o?.name === "Over");
      const pt = num(overOutcome?.point);
      if (pt != null) total = pt;
    }
  }

  // Only save if we got at least one of spread/total
  if (spread != null || total != null) {
    oddsLookup.set(`${home}__${away}`, { spread, total });
  }
}

// --- 4) merge onto your model, compute edges + bets ---
/**
 * Your rules (deduced from sample):
 *   spread_edge = xSpread - Spread
 *     -> if >0, bet Away; if <0, bet Home
 *   total_edge  = Total - xTotal
 *     -> if >0, bet Under; if <0, bet Over
 * We keep original Home/Away order from your model.
 */
const output = model.map((r) => {
  const key = `${r.Home}__${r.Away}`;
  const live = oddsLookup.get(key) || {};

  // prefer existing logos from your CSV
  const HomeLogo = r.HomeLogo;
  const AwayLogo = r.AwayLogo;

  const xSpread = num(r.xSpread);
  const xTotal  = num(r.xTotal);
  const Spread  = live.spread != null ? live.spread : (r.Spread !== "" ? num(r.Spread) : null);
  const Total   = live.total  != null ? live.total  : (r.Total  !== "" ? num(r.Total)  : null);

  let spreadEdge = null, totalEdge = null, spreadBet = "", totalBet = "";

  if (xSpread != null && Spread != null) {
    spreadEdge = +(xSpread - Spread).toFixed(1);
    spreadBet = spreadEdge > 0 ? r.Away
              : spreadEdge < 0 ? r.Home
              : ""; // push/no edge
  }
  if (xTotal != null && Total != null) {
    totalEdge = +(Total - xTotal).toFixed(1);
    totalBet  = totalEdge > 0 ? "Under"
              : totalEdge < 0 ? "Over"
              : "";
  }

  // Keep all original columns, overwrite the ones we update
  return {
    ...(r["#"] ? { "#": r["#"] } : {}),            // keep existing index if present
    Home: r.Home,
    Away: r.Away,
    Home_Proj: r.Home_Proj,
    Away_Proj: r.Away_Proj,
    xSpread: r.xSpread,
    xTotal: r.xTotal,
    Spread: Spread != null ? Spread.toFixed(1) : "",
    Total:  Total  != null ? Total.toFixed(1)  : "",
    "Spread Edge": spreadEdge != null ? spreadEdge : "",
    "Total Edge":  totalEdge  != null ? totalEdge  : "",
    "Spread Bet": spreadBet,
    "Total Bet":  totalBet,
    HomeLogo,
    AwayLogo
  };
});

// --- 5) write merged CSV for the site ---
await fs.writeFile(OUT_CSV, toCSV(output), "utf8");
console.log("✅ Wrote", OUT_CSV, "with live odds merged.");
