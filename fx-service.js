/* ============================================================================
   FX ENGINE — price in USD, bill in EGP
   ----------------------------------------------------------------------------
   Pulls the Central Bank of Egypt daily rate, applies your margin buffer,
   and refuses to move the billing rate on noise. Raises an alert when the
   move is big enough that the buffer no longer protects you.

   Run:  node fx-service.js
   Cron: it schedules itself — CBE publishes on business days only.
   ============================================================================ */

const express = require("express");
const fs = require("fs");
const path = require("path");
const cron = require("node-cron");
const axios = require("axios");

const app = express();
app.use(express.json());

/* ============================================================
   CONFIG
   ============================================================ */
const CFG = {
  PORT: process.env.PORT || 3100,

  /* Your FX margin. Applied on top of the CBE sell rate. */
  BUFFER_PCT: parseFloat(process.env.FX_BUFFER_PCT || "7"),

  /* The billing rate only moves when it drifts this far from the live rate.
     Without this, a customer sees a different EGP price every single day. */
  REPRICE_THRESHOLD_PCT: parseFloat(process.env.FX_REPRICE_PCT || "2"),

  /* Alert ladder — measured day over day on the CBE rate. */
  ALERT_WATCH_PCT: 1.5,   // unusual daily move, worth knowing
  ALERT_WARN_PCT: 3.0,    // eating into the buffer
  ALERT_CRIT_PCT: 7.0,    // buffer is gone — reprice today

  /* Rounding for published EGP prices: 0 = whole pounds, 5 = nearest 5, etc. */
  ROUND_EGP_TO: parseFloat(process.env.FX_ROUND || "5"),

  STORE: path.join(__dirname, "fx-history.json"),

  /* Where alerts go. Any of these can be blank. */
  ALERT_WEBHOOK: process.env.FX_ALERT_WEBHOOK || "",   // Slack / Teams / your own
  ALERT_EMAIL_HOOK: process.env.FX_ALERT_EMAIL || "",  // your transactional email endpoint

  /* Fetch order. First success wins; the rest are fallbacks. */
  SOURCES: ["cbe_official", "provider_a", "provider_b"],
  PROVIDER_A_URL: process.env.FX_PROVIDER_A || "",     // e.g. a CBE-mirroring rates API
  PROVIDER_A_KEY: process.env.FX_PROVIDER_A_KEY || "",
  PROVIDER_B_URL: process.env.FX_PROVIDER_B || "",
  PROVIDER_B_KEY: process.env.FX_PROVIDER_B_KEY || "",
};

/* ============================================================
   STORE
   ============================================================ */
function load() {
  try { return JSON.parse(fs.readFileSync(CFG.STORE, "utf8")); }
  catch { return { history: [], billing: null, alerts: [], overrides: null }; }
}
function save(db) { fs.writeFileSync(CFG.STORE, JSON.stringify(db, null, 2)); }
let db = load();

/* ============================================================
   FETCHERS
   ------------------------------------------------------------
   The CBE has no public JSON API. The official route is reading
   the published rates page. Keep a paid mirror as fallback so a
   markup change on their site never leaves you without a rate.
   ============================================================ */

async function fromCBE() {
  // CBE publishes buy/sell per currency on its rates page.
  const res = await axios.get("https://www.cbe.org.eg/en/economic-research/statistics/cbe-exchange-rates", {
    timeout: 15000,
    headers: { "User-Agent": "Mozilla/5.0 (compatible; fx-sync/1.0)" },
  });
  const html = String(res.data);

  // Locate the USD row, then the two numbers that follow it.
  const usdBlock = html.split(/US\s*Dollar|USD/i)[1] || "";
  const nums = (usdBlock.match(/\d{1,3}\.\d{2,4}/g) || []).map(Number);
  if (nums.length < 2) throw new Error("CBE: USD row not parsed");

  const [buy, sell] = nums;
  if (!isFinite(buy) || !isFinite(sell) || sell < 5 || sell > 500)
    throw new Error("CBE: implausible rate " + sell);

  return { buy, sell, mid: (buy + sell) / 2, source: "cbe_official" };
}

async function fromProvider(url, key, name) {
  if (!url) throw new Error(name + ": not configured");
  const res = await axios.get(url, {
    timeout: 12000,
    headers: key ? { Authorization: `Bearer ${key}` } : {},
  });
  const d = res.data;
  // Normalise the common shapes these APIs return.
  const sell = d.sell ?? d.rates?.USD?.sell ?? d.rates?.USD?.rate ?? d.USD ?? d.rate;
  const buy = d.buy ?? d.rates?.USD?.buy ?? sell;
  if (!isFinite(Number(sell))) throw new Error(name + ": no usable rate");
  return { buy: Number(buy), sell: Number(sell), mid: (Number(buy) + Number(sell)) / 2, source: name };
}

async function fetchRate() {
  const attempts = [];
  for (const src of CFG.SOURCES) {
    try {
      if (src === "cbe_official") return await fromCBE();
      if (src === "provider_a") return await fromProvider(CFG.PROVIDER_A_URL, CFG.PROVIDER_A_KEY, "provider_a");
      if (src === "provider_b") return await fromProvider(CFG.PROVIDER_B_URL, CFG.PROVIDER_B_KEY, "provider_b");
    } catch (e) { attempts.push(`${src}: ${e.message}`); }
  }
  throw new Error("all sources failed → " + attempts.join(" | "));
}

/* ============================================================
   PRICING MATHS
   ------------------------------------------------------------
   You earn EGP and pay your suppliers in USD, so you are a BUYER
   of dollars. Price off the SELL side — the rate a bank charges
   you to buy USD — not the mid. Using mid quietly gives away the
   spread on every invoice.
   ============================================================ */
const withBuffer = (sell) => sell * (1 + CFG.BUFFER_PCT / 100);

function roundEGP(v) {
  const r = CFG.ROUND_EGP_TO;
  return r > 0 ? Math.ceil(v / r) * r : Math.ceil(v);
}
const pctChange = (a, b) => (b === 0 ? 0 : ((a - b) / b) * 100);

/* ============================================================
   ALERTING
   ============================================================ */
function classify(changePct) {
  const m = Math.abs(changePct);
  if (m >= CFG.ALERT_CRIT_PCT) return "critical";
  if (m >= CFG.ALERT_WARN_PCT) return "warning";
  if (m >= CFG.ALERT_WATCH_PCT) return "watch";
  return null;
}

function alertCopy(level, today, prev, changePct) {
  const dir = changePct > 0 ? "weakened" : "strengthened";
  const abs = Math.abs(changePct).toFixed(2);
  const head = {
    watch: `EGP moved ${abs}% today`,
    warning: `EGP ${dir} ${abs}% — buffer under pressure`,
    critical: `DEVALUATION: EGP ${dir} ${abs}% — reprice today`,
  }[level];

  const body = {
    watch:
      `CBE sell rate ${prev.toFixed(4)} → ${today.toFixed(4)}. Larger than a normal day but inside your ${CFG.BUFFER_PCT}% buffer. No action needed.`,
    warning:
      `CBE sell rate ${prev.toFixed(4)} → ${today.toFixed(4)}. This has consumed roughly ${((Math.abs(changePct) / CFG.BUFFER_PCT) * 100).toFixed(0)}% of your ${CFG.BUFFER_PCT}% buffer. Margin on EGP invoices billed at the old rate is compressed until the billing rate steps up.`,
    critical:
      `CBE sell rate ${prev.toFixed(4)} → ${today.toFixed(4)}. The move is larger than your entire ${CFG.BUFFER_PCT}% buffer, so every EGP invoice issued at the previous rate is now underwater against your USD costs. Step the billing rate today and review any annual contracts locked in EGP.`,
  }[level];

  return { head, body };
}

async function notify(level, payload) {
  const line = `[FX ${level.toUpperCase()}] ${payload.head} — ${payload.body}`;
  console.log(line);

  db.alerts.unshift({ at: new Date().toISOString(), level, ...payload });
  db.alerts = db.alerts.slice(0, 200);
  save(db);

  if (CFG.ALERT_WEBHOOK) {
    try { await axios.post(CFG.ALERT_WEBHOOK, { text: line, level, ...payload }, { timeout: 8000 }); }
    catch (e) { console.error("webhook failed:", e.message); }
  }
  if (CFG.ALERT_EMAIL_HOOK) {
    try { await axios.post(CFG.ALERT_EMAIL_HOOK, { subject: payload.head, body: payload.body, level }, { timeout: 8000 }); }
    catch (e) { console.error("email hook failed:", e.message); }
  }
}

/* ============================================================
   THE DAILY SYNC
   ============================================================ */
async function sync({ force = false } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const last = db.history[0];

  if (!force && last && last.date === today) {
    return { skipped: "already have today", rate: last };
  }

  let live;
  try {
    live = await fetchRate();
  } catch (e) {
    // CBE is closed at weekends and on public holidays — carry the last
    // published rate forward rather than dropping to zero.
    if (last) {
      console.warn("fetch failed, carrying forward:", e.message);
      return { carriedForward: true, rate: last };
    }
    await notify("warning", {
      head: "No FX rate available",
      body: "Every source failed and there is no stored rate to carry forward. Billing conversions are frozen until a rate lands.",
    });
    throw e;
  }

  const buffered = withBuffer(live.sell);
  const change = last ? pctChange(live.sell, last.sell) : 0;

  const entry = {
    date: today,
    at: new Date().toISOString(),
    buy: live.buy,
    sell: live.sell,
    mid: live.mid,
    buffered,
    bufferPct: CFG.BUFFER_PCT,
    source: live.source,
    changePct: change,
  };

  db.history.unshift(entry);
  db.history = db.history.slice(0, 400);

  /* --- billing rate: sticky, so customers are not repriced daily --- */
  if (!db.billing) {
    db.billing = { rate: buffered, setOn: today, reason: "first run" };
  } else {
    const drift = pctChange(buffered, db.billing.rate);
    const level = classify(change);

    if (level === "critical" || Math.abs(drift) >= CFG.REPRICE_THRESHOLD_PCT) {
      const from = db.billing.rate;
      db.billing = {
        rate: buffered,
        setOn: today,
        previous: from,
        reason: level === "critical" ? "devaluation step" : `drift ${drift.toFixed(2)}%`,
      };
      console.log(`billing rate stepped ${from.toFixed(4)} → ${buffered.toFixed(4)}`);
    }
  }

  save(db);

  const level = classify(change);
  if (level) await notify(level, alertCopy(level, live.sell, last.sell, change));

  return { rate: entry, billing: db.billing, alert: level };
}

/* CBE publishes on business days. Check mid-morning Cairo time, then again
   in the afternoon in case the morning publish was late. */
cron.schedule("0 10,15 * * 0-4", () => sync().catch(e => console.error("sync:", e.message)), {
  timezone: "Africa/Cairo",
});

/* ============================================================
   API
   ============================================================ */

// What the billing system should actually use right now.
app.get("/api/fx/current", (req, res) => {
  const latest = db.history[0];
  if (!latest) return res.status(503).json({ error: "no rate yet" });
  res.json({
    date: latest.date,
    cbe: { buy: latest.buy, sell: latest.sell, mid: latest.mid },
    bufferPct: CFG.BUFFER_PCT,
    liveBuffered: latest.buffered,
    billingRate: db.billing?.rate ?? latest.buffered,
    billingSetOn: db.billing?.setOn,
    driftFromBilling: db.billing ? pctChange(latest.buffered, db.billing.rate) : 0,
    changePct: latest.changePct,
    source: latest.source,
    stale: latest.date !== new Date().toISOString().slice(0, 10),
  });
});

// Convert a USD price to the EGP you publish and invoice.
app.get("/api/fx/convert", (req, res) => {
  const usd = parseFloat(req.query.usd);
  if (!isFinite(usd)) return res.status(400).json({ error: "usd required" });
  const rate = db.billing?.rate ?? db.history[0]?.buffered;
  if (!rate) return res.status(503).json({ error: "no rate yet" });
  const raw = usd * rate;
  res.json({ usd, rate, egp: roundEGP(raw), egpExact: raw, roundedTo: CFG.ROUND_EGP_TO });
});

app.get("/api/fx/history", (req, res) => {
  const n = Math.min(parseInt(req.query.days) || 90, 400);
  res.json({ history: db.history.slice(0, n) });
});

app.get("/api/fx/alerts", (req, res) => res.json({ alerts: db.alerts.slice(0, 50) }));

// Force a check now.
app.post("/api/fx/sync", async (req, res) => {
  try { res.json(await sync({ force: true })); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// Pin the billing rate by hand — for the day you decide to hold a price.
app.post("/api/fx/pin", (req, res) => {
  const { rate, note } = req.body || {};
  if (!isFinite(Number(rate))) return res.status(400).json({ error: "rate required" });
  db.billing = { rate: Number(rate), setOn: new Date().toISOString().slice(0, 10), reason: note || "manual pin", manual: true };
  save(db);
  res.json({ billing: db.billing });
});

app.get("/health", (req, res) => res.json({ ok: true, points: db.history.length }));

app.listen(CFG.PORT, () => {
  console.log(`FX engine on :${CFG.PORT} — buffer ${CFG.BUFFER_PCT}%, reprice at ${CFG.REPRICE_THRESHOLD_PCT}% drift`);
  sync().catch(e => console.error("initial sync:", e.message));
});

module.exports = { app, sync, withBuffer, roundEGP, pctChange, classify };
