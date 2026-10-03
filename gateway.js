/* ============================================================================
   NABRA GATEWAY — one service, three doors
   ----------------------------------------------------------------------------
   /        the public site (nabra-voice-ai.html)
   /app     each customer's own console (nabra-dashboard.html + their identity)
   /admin   your operations panel (admin-panel.html) — admins only

   The buy flow this file implements:

     site checkout sheet  →  POST /api/checkout/start   (plan + consent)
                          →  /signup  (name, email, password — plan carried over)
                          →  POST /api/auth/signup
                                PAYMENTS_MODE=off     → account active now
                                PAYMENTS_MODE=paymob  → hosted card page → webhook activates
                          →  session cookie set → redirect /app
                          →  the buyer is standing in their own dashboard.

   Run:   node gateway.js       (needs DATABASE_URL; creates its own tables)
   Deps:  npm i express pg      (nothing else — sessions are HMAC-signed cookies,
                                 passwords are scrypt — both from node:crypto)
   ============================================================================ */

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const CFG = {
  PORT: process.env.PORT || 3000,
  /* REQUIRED in production. Sessions are signed with this. */
  SECRET: process.env.SESSION_SECRET || "dev-only-change-me",
  DATABASE_URL: process.env.DATABASE_URL || "",
  /* off | paymob   — "off" activates accounts immediately (your launch mode) */
  PAYMENTS_MODE: process.env.PAYMENTS_MODE || "off",
  PAYMOB_API_KEY: process.env.PAYMOB_API_KEY || "",
  PAYMOB_INTEGRATION_ID: process.env.PAYMOB_INTEGRATION_ID || "",
  PAYMOB_IFRAME_ID: process.env.PAYMOB_IFRAME_ID || "",
  PAYMOB_HMAC: process.env.PAYMOB_HMAC || "",
  /* Vapi — verify inbound webhooks with this shared token (set the same
     value as a header credential on the Server URL in the Vapi dashboard). */
  VAPI_WEBHOOK_TOKEN: process.env.VAPI_WEBHOOK_TOKEN || "",

  /* --- social sign-in. Each provider is optional: if its keys are absent the
     button simply does not appear, so the page never offers a broken option. */
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || "",
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || "",

  /* --- email. Used to confirm an address at signup. With no provider set,
     nothing is sent and accounts are treated as confirmed, so a missing key
     never silently locks every new customer out. */
  EMAIL_PROVIDER: process.env.EMAIL_PROVIDER || "",      // resend | brevo
  EMAIL_API_KEY: process.env.EMAIL_API_KEY || "",
  EMAIL_FROM: process.env.EMAIL_FROM || "",              // e.g. NABRA <hello@yourdomain>

  /* Vapi private API key — needed to push the cost guards below onto assistants. */
  VAPI_API_KEY: process.env.VAPI_API_KEY || "",
  /* COST GUARDS — end dead air, never a live conversation.
     You are billed per connected minute (Vapi + model + voice), including
     minutes of silence, so the goal is to hang up on nobody-there and noise
     while letting a real conversation run as long as it wants.

     MAX_CALL_SECONDS is NOT a conversation limit — it is a runaway guard.
     It has to be set: if you leave it out, Vapi applies its own 600-second
     default and your best qualification call dies at ten minutes with
     endedReason "max-duration-exceeded". One hour is far past any real
     booking or qualification call, so in practice only a stuck line hits it.

     SILENCE_TIMEOUT_SECONDS is the guard that actually fires: no caller
     audio for this long and the call ends. This is also what catches
     unintelligible noise — if the transcriber cannot make words out of it,
     Vapi registers no caller speech, so noise counts as silence and the
     timeout ends the call. Keep it generous enough for a caller who pauses
     to think or check something. */
  MAX_CALL_SECONDS: parseInt(process.env.MAX_CALL_SECONDS || "3600", 10),
  SILENCE_TIMEOUT_SECONDS: parseInt(process.env.SILENCE_TIMEOUT_SECONDS || "30", 10),
  /* Where the FX engine runs; /api/fx/* is proxied there. */
  FX_SERVICE_URL: process.env.FX_SERVICE_URL || "http://localhost:3100",
  /* First admin, created on boot if missing. CHANGE THE PASSWORD AFTER LOGIN. */
  ADMIN_EMAIL: process.env.ADMIN_EMAIL || "admin@nabra.local",
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || "",
  /* Static files live next to this script. */
  DIR: __dirname,
  SESSION_DAYS: 30,
};

if (CFG.SECRET === "dev-only-change-me") console.warn("⚠  SESSION_SECRET is the dev default — set a real one before going live.");
if (!CFG.DATABASE_URL) console.warn("⚠  DATABASE_URL not set — the gateway will not start without Postgres (Neon works).");

const pool = new Pool({ connectionString: CFG.DATABASE_URL, ssl: CFG.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false } });
const q = (text, params) => pool.query(text, params);

/* ============================================================
   SCHEMA — created on boot, safe to re-run
   ============================================================ */
async function migrate() {
  // PostgreSQL provides gen_random_bytes() through the pgcrypto extension.
  // Enable it automatically so fresh Railway databases can migrate without manual SQL.
  await q(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

  await q(`
  CREATE TABLE IF NOT EXISTS tenants(
    id            SERIAL PRIMARY KEY,
    name          TEXT NOT NULL,
    email         TEXT UNIQUE NOT NULL,
    pass_hash     TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'customer',     -- customer | admin
    plan          TEXT NOT NULL DEFAULT 'starter',      -- starter | growth | enterprise
    cycle         TEXT NOT NULL DEFAULT 'monthly',
    status        TEXT NOT NULL DEFAULT 'pending',      -- pending | active | suspended
    lang          TEXT NOT NULL DEFAULT 'en',
    vapi_assistant_ids TEXT[] NOT NULL DEFAULT '{}',    -- assistants owned by this tenant
    minutes_used  INTEGER NOT NULL DEFAULT 0,
    consent       JSONB,                                 -- terms version + timestamp from checkout
    oauth_provider TEXT,                                 -- 'google', or null for password accounts
    oauth_sub     TEXT,                                  -- the provider's stable user id
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS calls(
    id          SERIAL PRIMARY KEY,
    tenant_id   INTEGER REFERENCES tenants(id),
    vapi_call_id TEXT UNIQUE,
    assistant_id TEXT,
    agent_id    INTEGER,
    direction   TEXT,
    from_number TEXT,
    duration_s  INTEGER,
    outcome     TEXT,
    summary     TEXT,
    transcript  JSONB,
    payload     JSONB,
    at          TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS provisioning(
    id         SERIAL PRIMARY KEY,
    tenant_id  INTEGER REFERENCES tenants(id),
    kind       TEXT NOT NULL,        -- number_buy | number_connect | port
    detail     TEXT,
    status     TEXT NOT NULL DEFAULT 'queued',   -- queued | in_progress | done
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS agents(
    id            SERIAL PRIMARY KEY,
    tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    channel       TEXT NOT NULL DEFAULT 'voice',      -- voice | whatsapp | web
    direction     TEXT NOT NULL DEFAULT 'inbound',    -- inbound | outbound | both
    status        TEXT NOT NULL DEFAULT 'draft',      -- draft | live | paused
    lang          TEXT NOT NULL DEFAULT 'match',
    business      JSONB NOT NULL DEFAULT '{}',        -- name, type, hours, greeting
    knowledge     TEXT NOT NULL DEFAULT '',
    rules         TEXT NOT NULL DEFAULT '',
    script        TEXT NOT NULL DEFAULT '',           -- outbound script
    transfer_to   TEXT,
    channel_cfg   JSONB NOT NULL DEFAULT '{}',        -- route + trunk host/user (never the password)
    vapi_assistant_id TEXT,
    tested_at     TIMESTAMPTZ,
    deployed_at   TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS agents_tenant ON agents(tenant_id);
  CREATE TABLE IF NOT EXISTS bookings(
    id          SERIAL PRIMARY KEY,
    tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    agent_id    INTEGER REFERENCES agents(id) ON DELETE SET NULL,
    call_id     INTEGER REFERENCES calls(id) ON DELETE SET NULL,
    name        TEXT,
    phone       TEXT,
    starts_at   TIMESTAMPTZ NOT NULL,
    minutes     INTEGER NOT NULL DEFAULT 60,
    party       INTEGER,
    service     TEXT,                                  -- table, viewing, appointment
    status      TEXT NOT NULL DEFAULT 'booked',        -- booked | confirmed | cancelled | done | noshow
    notes       TEXT,
    outside_hours BOOLEAN NOT NULL DEFAULT false,     -- asked for a time the business is shut
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS bookings_tenant_time ON bookings(tenant_id, starts_at);
  CREATE TABLE IF NOT EXISTS orders(
    id          SERIAL PRIMARY KEY,
    tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    agent_id    INTEGER REFERENCES agents(id) ON DELETE SET NULL,
    call_id     INTEGER REFERENCES calls(id) ON DELETE SET NULL,
    name        TEXT,
    phone       TEXT,
    address     TEXT,
    items       TEXT,
    total       NUMERIC(12,2),
    status      TEXT NOT NULL DEFAULT 'new',           -- new | accepted | out | delivered | cancelled
    notes       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS orders_tenant ON orders(tenant_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS notifications(
    id          SERIAL PRIMARY KEY,
    tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    booking_id  INTEGER REFERENCES bookings(id) ON DELETE CASCADE,
    channel     TEXT NOT NULL,                          -- whatsapp
    to_addr     TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'queued',         -- queued | sent | skipped | failed
    detail      TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS notif_tenant ON notifications(tenant_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS leads(
    id          SERIAL PRIMARY KEY,
    tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    agent_id    INTEGER REFERENCES agents(id) ON DELETE SET NULL,
    call_id     INTEGER REFERENCES calls(id) ON DELETE SET NULL,
    name        TEXT,
    phone       TEXT,
    intent      TEXT,
    detail      TEXT,
    status      TEXT NOT NULL DEFAULT 'new',          -- new | qualified | contacted | booked | won | lost
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS leads_tenant ON leads(tenant_id);
  CREATE TABLE IF NOT EXISTS config(
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_by TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS events(
    id        SERIAL PRIMARY KEY,
    tenant_id INTEGER,
    kind      TEXT NOT NULL,
    detail    JSONB,
    at        TIMESTAMPTZ NOT NULL DEFAULT now()
  );`);

  /* Migrations for databases created before social sign-in existed.
     CREATE TABLE IF NOT EXISTS does nothing to a table that is already there,
     so these have to be explicit. All are safe to run repeatedly. */
  await q(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS oauth_provider TEXT`);
  await q(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS oauth_sub TEXT`);
  /* A private token per tenant for the read-only calendar feed, so a customer
     can subscribe from Google, Apple or Outlook without any OAuth dance. */
  await q(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS cal_token TEXT`);
  await q(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false`);
  await q(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS verify_sent_at TIMESTAMPTZ`);
  /* Accounts that existed before confirmation was added are left alone: they
     were created when no confirmation was asked for, and locking them out now
     would punish the earliest customers. */
  await q(`UPDATE tenants SET email_verified = true WHERE created_at < now() - interval '1 minute' AND email_verified = false`);
  await q(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS outside_hours BOOLEAN NOT NULL DEFAULT false`);
  await q(`UPDATE tenants SET cal_token = encode(gen_random_bytes(16),'hex') WHERE cal_token IS NULL`);
  await q(`ALTER TABLE tenants ALTER COLUMN pass_hash DROP NOT NULL`);
  await q(`CREATE UNIQUE INDEX IF NOT EXISTS tenants_oauth ON tenants(oauth_provider, oauth_sub)
           WHERE oauth_provider IS NOT NULL`);

  /* first admin */
  const { rows } = await q(`SELECT 1 FROM tenants WHERE role='admin' LIMIT 1`);
  if (!rows.length) {
    const pw = CFG.ADMIN_PASSWORD || crypto.randomBytes(9).toString("base64url");
    await q(`INSERT INTO tenants(name,email,pass_hash,role,status,plan) VALUES($1,$2,$3,'admin','active','enterprise')`,
      ["NABRA Admin", CFG.ADMIN_EMAIL, hashPw(pw)]);
    console.log(`── first admin created ─────────────────────────────
   email:    ${CFG.ADMIN_EMAIL}
   password: ${CFG.ADMIN_PASSWORD ? "(from ADMIN_PASSWORD env)" : pw + "   ← copy this NOW, it is not shown again"}
────────────────────────────────────────────────────`);
  }
}

/* ============================================================
   PASSWORDS (scrypt) + SESSIONS (HMAC cookie, stateless)
   ============================================================ */
function hashPw(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  return salt + ":" + crypto.scryptSync(pw, salt, 64).toString("hex");
}
/* timingSafeEqual THROWS when the two buffers differ in length, so a
   malformed stored hash or a truncated cookie would crash the request
   instead of simply failing to authenticate. Compare lengths first. */
function safeEq(a, b) {
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function checkPw(pw, stored) {
  const [salt, hash] = String(stored).split(":");
  if (!salt || !hash) return false;
  let expected;
  try { expected = Buffer.from(hash, "hex"); } catch { return false; }
  return safeEq(crypto.scryptSync(pw, salt, 64), expected);
}
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = crypto.createHmac("sha256", CFG.SECRET).update(body).digest("base64url");
  return body + "." + mac;
}
function verify(token) {
  if (!token) return null;
  const [body, mac] = String(token).split(".");
  if (!body || !mac) return null;
  const expect = crypto.createHmac("sha256", CFG.SECRET).update(body).digest("base64url");
  if (!safeEq(Buffer.from(mac), Buffer.from(expect))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    if (p.exp && p.exp < Date.now()) return null;
    return p;
  } catch { return null; }
}
function setSession(res, tenant) {
  const token = sign({ id: tenant.id, role: tenant.role, exp: Date.now() + CFG.SESSION_DAYS * 864e5 });
  res.setHeader("Set-Cookie",
    `nabra_s=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${CFG.SESSION_DAYS * 86400}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`);
}
function readSession(req) {
  const m = /(?:^|;\s*)nabra_s=([^;]+)/.exec(req.headers.cookie || "");
  return m ? verify(m[1]) : null;
}

/* ============================================================
   RUNTIME CONFIG — DB overrides env
   ------------------------------------------------------------
   The admin panel's Deployment tab can Apply these keys straight
   to the server: they land in the config table and take effect
   immediately, no redeploy. Env vars remain the fallback.
   Bootstrap secrets (DATABASE_URL, SESSION_SECRET) stay env-only.
   ============================================================ */
const APPLYABLE = ["PAYMENTS_MODE","PAYMOB_API_KEY","PAYMOB_INTEGRATION_ID","PAYMOB_IFRAME_ID","PAYMOB_HMAC","VAPI_WEBHOOK_TOKEN","VAPI_API_KEY","MAX_CALL_SECONDS","SILENCE_TIMEOUT_SECONDS","FX_SERVICE_URL","SITE_URL","GOOGLE_CLIENT_ID","GOOGLE_CLIENT_SECRET","EMAIL_PROVIDER","EMAIL_API_KEY","EMAIL_FROM"];
let CONF = {};
async function loadConf() {
  try { const { rows } = await q(`SELECT key,value FROM config`); CONF = Object.fromEntries(rows.map(r => [r.key, r.value])); }
  catch (e) { console.error("loadConf:", e.message); }
}
const cfg = k => (CONF[k] !== undefined && CONF[k] !== "") ? CONF[k] : CFG[k];

/* ============================================================
   APP
   ============================================================ */
const app = express();
app.use(express.json({ limit: "2mb" }));
/* Form-encoded bodies, for anything that posts a plain HTML form. */
app.use(express.urlencoded({ extended: false, limit: "1mb" }));

const FILES = {
  site: path.join(CFG.DIR, "nabra-voice-ai.html"),
  dash: path.join(CFG.DIR, "nabra-dashboard.html"),
  admin: path.join(CFG.DIR, "admin-panel.html"),
  legal: path.join(CFG.DIR, "legal-public.html"),
  setup: path.join(CFG.DIR, "agent-setup-demo.html"),
};
const read = f => fs.readFileSync(f, "utf8");

/* inject the identity object right before </body> */
function serveWithBoot(res, file, boot) {
  const html = read(file).replace("</body>",
    `<script>window.NABRA_BOOT=${JSON.stringify(boot).replace(/</g, "\\u003c")}</script></body>`);
  res.setHeader("Content-Type", "text/html; charset=utf-8").end(html);
}

async function currentTenant(req) {
  const s = readSession(req);
  if (!s) return null;
  const { rows } = await q(`SELECT id,name,email,role,plan,cycle,status,lang,vapi_assistant_ids,minutes_used,created_at,email_verified,cal_token FROM tenants WHERE id=$1`, [s.id]);
  const t = rows[0];
  if (!t) return null;
  t._impersonated = !!s.imp;
  t._adminId = s.adm || null;
  return t;
}

/* ------------------------------------------------------------ public site */
const siteUrl = req => (cfg("SITE_URL") || `https://${req.headers.host || "localhost"}`).replace(/\/$/, "");

/* Canonical and share URLs are injected from SITE_URL at request time, so
   the file itself never carries a placeholder or a stale domain. */
app.get("/", (req, res) => {
  const base = siteUrl(req);
  const tags = `<link rel="canonical" href="${base}/">\n<meta property="og:url" content="${base}/">`;
  res.setHeader("Content-Type", "text/html; charset=utf-8")
     .end(read(FILES.site).replace("<!--CANONICAL-->", tags));
});

/* public legal pages — Privacy, Terms, AUP (EN/AR), required by the pack */
app.get("/legal", (req, res) => res.setHeader("Content-Type", "text/html; charset=utf-8").end(read(FILES.legal)));
app.get(["/privacy", "/terms", "/aup"], (req, res) => res.redirect("/legal#" + req.path.slice(1)));

/* ------------------------------------------------------------ checkout → signup */
/* The site's payment sheet posts here after the buyer accepts the terms. */
app.post("/api/checkout/start", (req, res) => {
  const { plan = "growth", cycle = "monthly", consent = {} } = req.body || {};
  const t = sign({ co: { plan, cycle, consent }, exp: Date.now() + 30 * 60e3 }); // 30-minute handoff token
  res.json({ redirect: `/signup?t=${encodeURIComponent(t)}` });
});

app.get("/signup", (req, res) => {
  const p = verify(req.query.t) || {};
  const co = p.co || { plan: "growth", cycle: "monthly" };
  res.setHeader("Content-Type", "text/html; charset=utf-8").end(authPage("signup", co, req.query.t || ""));
});

/* ============================================================
   EMAIL
   ------------------------------------------------------------
   One small adapter rather than a library, so there is nothing
   to install and the provider can change without touching
   anything else. Both of these accept plain HTTPS and have a
   free tier that covers a launch.
   ============================================================ */
const emailOn = () => !!(cfg("EMAIL_PROVIDER") && cfg("EMAIL_API_KEY") && cfg("EMAIL_FROM"));

async function sendEmail(to, subject, html) {
  if (!emailOn()) { console.warn("[email] not configured, skipped:", subject); return { skipped: true }; }
  const from = cfg("EMAIL_FROM"), provider = cfg("EMAIL_PROVIDER").toLowerCase();
  try {
    if (provider === "resend") {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg("EMAIL_API_KEY")}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [to], subject, html }),
      });
      if (!r.ok) throw new Error("resend " + r.status + " " + (await r.text()).slice(0, 180));
      return { sent: true };
    }
    if (provider === "brevo") {
      const m = /<(.+)>/.exec(from);
      const r = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: { "api-key": cfg("EMAIL_API_KEY"), "Content-Type": "application/json" },
        body: JSON.stringify({
          sender: { email: m ? m[1] : from, name: m ? from.replace(/<.*/, "").trim() : "NABRA" },
          to: [{ email: to }], subject, htmlContent: html,
        }),
      });
      if (!r.ok) throw new Error("brevo " + r.status + " " + (await r.text()).slice(0, 180));
      return { sent: true };
    }
    throw new Error("unknown EMAIL_PROVIDER: " + provider);
  } catch (e) { console.error("[email] failed:", e.message); return { failed: e.message }; }
}

/* The confirmation link is a signed token, so nothing has to be stored and a
   stale link simply expires rather than lingering in the database. */
function verifyLink(req, tenant) {
  const tok = sign({ v: tenant.id, e: tenant.email, exp: Date.now() + 48 * 3600e3 });
  return `${siteUrl(req)}/verify?t=${encodeURIComponent(tok)}`;
}

async function sendVerification(req, tenant) {
  const link = verifyLink(req, tenant);
  const name = esc(String(tenant.name || "").split(" ")[0] || "there");
  const html = `
<div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;color:#163466">
  <p style="font-size:1.05rem">Hi ${name},</p>
  <p>Confirm this address and your agent is ready to build.</p>
  <p style="margin:1.6rem 0">
    <a href="${link}" style="background:#163466;color:#fff;text-decoration:none;padding:.8rem 1.4rem;border-radius:99px;display:inline-block">Confirm my email</a>
  </p>
  <p style="color:#4A5F86;font-size:.9rem">The link works for two days. If you did not create a NABRA account, ignore this and nothing happens.</p>
</div>`;
  const res = await sendEmail(tenant.email, "Confirm your email", html);
  await q(`UPDATE tenants SET verify_sent_at = now() WHERE id=$1`, [tenant.id]).catch(() => {});
  return res;
}

app.get("/verify", async (req, res) => {
  const p = verify(String(req.query.t || ""));
  if (!p || !p.v) return res.status(400).type("html").send(
    `<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light only">
     <body style="font-family:system-ui;background:#EEF2F9;color:#163466;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center">
     <div><h1 style="font-weight:600;font-size:1.4rem">That link has expired</h1>
     <p style="color:#4A5F86">Log in and we will send you a fresh one.</p>
     <a href="/login" style="color:#C08A2E">Log in</a></div></body>`);
  const { rows } = await q(`UPDATE tenants SET email_verified=true WHERE id=$1 RETURNING *`, [p.v]);
  if (!rows.length) return res.redirect("/login");
  setSession(res, rows[0]);
  await track(rows[0].id, "email_verified", {});
  const { rows: ag } = await q(`SELECT 1 FROM agents WHERE tenant_id=$1 LIMIT 1`, [rows[0].id]);
  res.redirect(ag.length ? "/app" : "/setup");
});

app.post("/api/me/resend-verification", async (req, res) => {
  const t = await currentTenant(req); if (!t) return res.status(401).json({ error: "no session" });
  if (t.email_verified) return res.json({ ok: true, already: true });
  const r = await sendVerification(req, t);
  res.json({ ok: !r.failed, skipped: !!r.skipped, error: r.failed || null });
});

/* ============================================================
   SIGN IN WITH GOOGLE
   ------------------------------------------------------------
   Authorization-code flow. Google redirects back with a code and
   we exchange it server side, so no secret and no token ever
   reaches the browser.

   With no keys configured this is simply switched off and the
   button never renders, rather than appearing and failing. Email
   and password sign-in always works either way.
   ============================================================ */
const googleOn = () => !!(cfg("GOOGLE_CLIENT_ID") && cfg("GOOGLE_CLIENT_SECRET"));

/* The state cookie carries the CSRF value and, if the person came from
   checkout, the signed handoff holding their plan, cycle and consent. */
function setState(res, payload) {
  const token = sign({ ...payload, exp: Date.now() + 10 * 60e3 });
  res.setHeader("Set-Cookie",
    `nabra_o=${token}; Path=/; HttpOnly; Max-Age=600; SameSite=Lax${process.env.NODE_ENV === "production" ? "; Secure" : ""}`);
  return token;
}
function readState(req) {
  const m = /(?:^|;\s*)nabra_o=([^;]+)/.exec(req.headers.cookie || "");
  return m ? verify(m[1]) : null;
}
const clearState = res => res.setHeader("Set-Cookie", "nabra_o=; Path=/; Max-Age=0");

function oauthFail(res, why) {
  /* Never leak provider internals to the browser; log the detail, show a
     plain sentence and a way back. */
  console.warn("[oauth]", why);
  res.status(400).type("html").send(
`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="color-scheme" content="light only"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign-in failed — NABRA</title><style>html{background:#EEF2F9!important;color-scheme:only light!important}
body{background:#EEF2F9;color:#163466;font-family:system-ui,sans-serif;display:grid;place-items:center;
min-height:100vh;margin:0;text-align:center;padding:2rem}a{color:#C08A2E}</style></head><body><div>
<h1 style="font-weight:400;font-size:1.5rem;margin:0 0 .5rem">That sign-in did not complete</h1>
<p style="color:#4A5F86;margin:0 0 1.2rem">Nothing was changed on your account. Please try again, or use your email and password.</p>
<a href="/login">Back to log in</a></div></body></html>`);
}

/* Find or create the account behind a verified social identity.
   Matching is by provider id first, then by email, so somebody who signed up
   with a password and later uses Google on the same address keeps one account
   instead of quietly creating a second. */
async function tenantFromSocial({ provider, sub, email, name, co }) {
  email = String(email || "").toLowerCase().trim();
  if (!email) throw new Error("provider returned no email");

  let { rows } = await q(`SELECT * FROM tenants WHERE oauth_provider=$1 AND oauth_sub=$2`, [provider, sub]);
  if (rows.length) return { tenant: rows[0], created: false };

  ({ rows } = await q(`SELECT * FROM tenants WHERE email=$1`, [email]));
  if (rows.length) {
    await q(`UPDATE tenants SET oauth_provider=$1, oauth_sub=$2 WHERE id=$3`, [provider, sub, rows[0].id]);
    return { tenant: rows[0], created: false };
  }

  const plan = ["starter", "growth", "enterprise"].includes(co && co.plan) ? co.plan : "growth";
  const cycle = ["monthly", "annual"].includes(co && co.cycle) ? co.cycle : "monthly";
  const status = cfg("PAYMENTS_MODE") === "paymob" ? "pending" : "active";
  const ins = await q(
    /* Google has already verified this address, so asking the customer to
       confirm it again would be friction for nothing. */
    `INSERT INTO tenants(name,email,role,plan,cycle,status,consent,oauth_provider,oauth_sub,email_verified)
     VALUES($1,$2,'customer',$3,$4,$5,$6,$7,$8,true) RETURNING *`,
    [String(name || email.split("@")[0]).slice(0, 120), email, plan, cycle, status,
     (co && co.consent) || null, provider, sub]);
  return { tenant: ins.rows[0], created: true };
}

async function finishSocial(res, info) {
  const { tenant, created } = await tenantFromSocial(info);
  if (tenant.status === "suspended") return oauthFail(res, "suspended account");
  clearState(res);
  setSession(res, tenant);
  await track(tenant.id, created ? "signup" : "login", { via: info.provider });
  if (tenant.role === "admin") return res.redirect("/admin");
  const { rows } = await q(`SELECT 1 FROM agents WHERE tenant_id=$1 LIMIT 1`, [tenant.id]);
  res.redirect(rows.length ? "/app" : "/setup");
}

/* ---------------------------------------------------------- Google */
app.get("/auth/google", (req, res) => {
  if (!googleOn()) return oauthFail(res, "google not configured");
  const nonce = crypto.randomBytes(16).toString("hex");
  setState(res, { n: nonce, t: req.query.t || null });
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", cfg("GOOGLE_CLIENT_ID"));
  u.searchParams.set("redirect_uri", siteUrl(req) + "/auth/google/callback");
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid email profile");
  u.searchParams.set("state", nonce);
  u.searchParams.set("prompt", "select_account");
  res.redirect(u.toString());
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    if (!googleOn()) return oauthFail(res, "google not configured");
    const st = readState(req);
    if (!st || !req.query.state || st.n !== req.query.state) return oauthFail(res, "state mismatch");
    if (!req.query.code) return oauthFail(res, "no code returned");

    const body = new URLSearchParams({
      code: String(req.query.code),
      client_id: cfg("GOOGLE_CLIENT_ID"),
      client_secret: cfg("GOOGLE_CLIENT_SECRET"),
      redirect_uri: siteUrl(req) + "/auth/google/callback",
      grant_type: "authorization_code",
    });
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
    });
    if (!r.ok) return oauthFail(res, "google token exchange " + r.status);
    const tok = await r.json();
    /* The id_token arrived over TLS straight from Google's token endpoint in
       response to our authenticated request, so its claims can be read
       directly; there is no third party in between to forge it. */
    const claims = JSON.parse(Buffer.from(String(tok.id_token).split(".")[1], "base64url").toString());
    if (claims.aud !== cfg("GOOGLE_CLIENT_ID")) return oauthFail(res, "audience mismatch");
    if (!/^(https:\/\/)?accounts\.google\.com$/.test(String(claims.iss))) return oauthFail(res, "issuer mismatch");
    if (claims.email_verified === false) return oauthFail(res, "google email not verified");
    await finishSocial(res, {
      provider: "google", sub: claims.sub, email: claims.email,
      name: claims.name, co: (verify(st.t) || {}).co,
    });
  } catch (e) { oauthFail(res, e.message); }
});

app.get("/login", (req, res) => res.setHeader("Content-Type", "text/html; charset=utf-8").end(authPage("login", null, req.query.t || "")));
app.get("/logout", (req, res) => { res.setHeader("Set-Cookie", "nabra_s=; Path=/; Max-Age=0"); res.redirect("/"); });

app.post("/api/auth/signup", async (req, res) => {
  try {
    let { name, email, password, t } = req.body || {};
    name = String(name || "").trim().slice(0, 120);
    email = String(email || "").trim().toLowerCase().slice(0, 254);
    password = String(password || "");
    if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8)
      return res.status(400).json({ error: "Name, a valid email and a password of at least 8 characters are required." });
    const hand = verify(t) || {};
    const co = { ...(hand.co || {}) };
    /* Whitelist what the handoff carried. The token is signed, so forging it
       is hard, but the database and the admin panel should never have to
       trust that. */
    if (!["starter", "growth", "enterprise"].includes(co.plan)) co.plan = "growth";
    if (!["monthly", "annual"].includes(co.cycle)) co.cycle = "monthly";
    if (co.consent === undefined) co.consent = null;
    /* Only Paymob mode collects money, so only Paymob mode should leave an
       account pending. Any other value is test mode and activates directly —
       otherwise a stray value like "test" strands every signup in pending. */
    const status = cfg("PAYMENTS_MODE") === "paymob" ? "pending" : "active";
    let row;
    try {
      row = (await q(
        `INSERT INTO tenants(name,email,pass_hash,plan,cycle,status,consent) VALUES($1,$2,$3,$4,$5,$6,$7)
         RETURNING id,name,email,role,plan,status`,
        [name, email, hashPw(password), co.plan, co.cycle, status, co.consent])).rows[0];
    } catch (e) {
      if (String(e.message).includes("duplicate")) return res.status(409).json({ error: "That email already has an account — log in instead." });
      throw e;
    }
    await q(`INSERT INTO events(tenant_id,kind,detail) VALUES($1,'signup',$2)`, [row.id, JSON.stringify(co)]);
    setSession(res, row);
    /* Sent, not awaited: a slow mail provider should not make signup feel
       broken. If it fails they can resend from inside the app. */
    sendVerification(req, row);

    if (cfg("PAYMENTS_MODE") === "paymob") {
      /* Hand the buyer to Paymob's hosted card page; the webhook below
         activates the account when the charge succeeds. */
      const url = await paymobCheckoutUrl(row, co).catch(e => { console.error("paymob:", e.message); return null; });
      if (url) return res.json({ redirect: url });
      /* If Paymob is misconfigured don't strand the buyer — keep them pending and tell you. */
      await q(`INSERT INTO events(tenant_id,kind,detail) VALUES($1,'paymob_error',NULL)`, [row.id]);
    }
    /* A brand new customer has no agent yet, so send them to build one
       rather than to an empty console. */
    res.json({ redirect: "/setup" });
  } catch (e) { console.error(e); res.status(500).json({ error: "Something went wrong on our side. Try again." }); }
});

/* Brute-force guard. In-memory is fine for one instance; move to the
   database or Redis the day you run more than one. */
const ATTEMPTS = new Map();
function tooManyAttempts(key) {
  const now = Date.now(), win = 15 * 60e3, max = 8;
  const rec = (ATTEMPTS.get(key) || []).filter(t => now - t < win);
  ATTEMPTS.set(key, rec);
  if (ATTEMPTS.size > 5000) ATTEMPTS.clear();   // crude bound on memory
  return rec.length >= max;
}
function noteAttempt(key) {
  const rec = ATTEMPTS.get(key) || [];
  rec.push(Date.now());
  ATTEMPTS.set(key, rec);
}

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  const addr = String(email || "").toLowerCase().trim();
  const key = addr + "|" + (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "");
  if (tooManyAttempts(key))
    return res.status(429).json({ error: "Too many attempts. Wait fifteen minutes and try again." });
  const { rows } = await q(`SELECT * FROM tenants WHERE email=$1`, [addr]);
  const t = rows[0];
  /* An account created through Google has no password. Saying so is
     more useful than "wrong password", and reveals nothing an attacker could
     not learn by trying that provider. */
  if (t && !t.pass_hash && t.oauth_provider) {
    return res.status(401).json({ error: "This account uses Google to sign in. Use the Google button above." });
  }
  if (!t || !checkPw(password || "", t.pass_hash)) {
    noteAttempt(key);
    return res.status(401).json({ error: "Email or password is not right." });
  }
  if (t.status === "suspended") return res.status(403).json({ error: "This account is suspended. Contact support." });
  setSession(res, t);
  if (t.role === "admin") { setSession(res, t); return res.json({ redirect: "/admin" }); }
  /* Customers who have not built an agent go straight to setup. */
  const { rows: ag } = await q(`SELECT 1 FROM agents WHERE tenant_id=$1 LIMIT 1`, [t.id]);
  res.json({ redirect: ag.length ? "/app" : "/setup" });
});

/* ------------------------------------------------------------ the customer console */
app.get("/app", async (req, res) => {
  const t = await currentTenant(req);
  if (!t) return res.redirect("/login");
  if (t.role === "admin" && !t._impersonated) return res.redirect("/admin");
  if (t.status === "suspended") return res.redirect("/login");
  serveWithBoot(res, FILES.dash, {
    tenant: { id: t.id, name: t.name, email: t.email, plan: t.plan, cycle: t.cycle, status: t.status },
    lang: t.lang, impersonated: t._impersonated,
  });
});

/* The guided setup a customer walks through after signup: connect a number,
   teach the agent, test it. Same login gate as the console. */
app.get("/setup", async (req, res) => {
  const t = await who(req);
  if (!t) return res.redirect("/login");
  if (t.status === "suspended") return res.redirect("/login");
  serveWithBoot(res, FILES.setup, {
    tenant: { id: t.id, name: t.name, email: t.email, plan: t.plan, cycle: t.cycle, status: t.status },
    lang: t.lang, impersonated: t._impersonated,
  });
});


/* the dashboard's future data endpoints — wire the demo arrays to these */
app.get("/api/me", async (req, res) => {
  const t = await currentTenant(req);
  if (!t) return res.status(401).json({ error: "no session" });
  res.json({ tenant: t });
});
app.get("/api/me/calls", async (req, res) => {
  const t = await currentTenant(req);
  if (!t) return res.status(401).json({ error: "no session" });
  const { rows } = await q(`SELECT * FROM calls WHERE tenant_id=$1 ORDER BY at DESC LIMIT 100`, [t.id]);
  res.json({ calls: rows });
});

/* ============================================================
   AGENTS — the customer's own agents, scoped to their tenant
   ------------------------------------------------------------
   Every query filters on tenant_id from the session, never from
   anything the browser sends, so one customer cannot read or
   write another's agent by guessing an id.
   ============================================================ */

/* What is still missing before this agent can answer a real call.
   Honest by design: it reports what is true, never a flattering score. */
function readiness(a) {
  const checks = [
    { k: "name",      ok: !!(a.name && a.name.trim()),                    say: "Give the agent a name" },
    { k: "business",  ok: !!(a.business && a.business.name),              say: "Add your business name and what you do" },
    { k: "greeting",  ok: !!(a.business && a.business.greeting),          say: "Write the greeting callers hear" },
    { k: "knowledge", ok: (a.knowledge || "").trim().length > 80,         say: "Add what the agent needs to know, or upload your menu" },
    { k: "rules",     ok: !!(a.rules || "").trim(),                       say: "Set the rules it must not cross" },
    { k: "script",    ok: a.direction === "inbound" || !!(a.script || "").trim(), say: "Write or generate the outbound script" },
    { k: "channel",   ok: !!(a.channel_cfg && a.channel_cfg.route),       say: "Choose how calls reach the agent" },
    { k: "tested",    ok: !!a.tested_at,                                  say: "Test the agent at least once" },
  ];
  const done = checks.filter(c => c.ok).length;
  return {
    score: Math.round((done / checks.length) * 100),
    ready: done === checks.length,
    outstanding: checks.filter(c => !c.ok).map(c => ({ k: c.k, say: c.say })),
  };
}

const AGENT_FIELDS = ["name","channel","direction","lang","business","knowledge","rules","script","transfer_to","channel_cfg"];
function cleanAgent(body) {
  const out = {};
  for (const f of AGENT_FIELDS) if (body[f] !== undefined) out[f] = body[f];
  /* never store a trunk password: it belongs to the operator, not to us */
  if (out.channel_cfg && typeof out.channel_cfg === "object") {
    const c = { ...out.channel_cfg };
    delete c.pass; delete c.password; delete c.secret;
    out.channel_cfg = c;
  }
  if (out.channel && !["voice","whatsapp","web"].includes(out.channel)) delete out.channel;
  if (out.direction && !["inbound","outbound","both"].includes(out.direction)) delete out.direction;
  for (const k of ["name","knowledge","rules","script","transfer_to","lang"])
    if (typeof out[k] === "string") out[k] = out[k].slice(0, 20000);
  return out;
}

app.get("/api/me/agents", async (req, res) => {
  const t = await currentTenant(req); if (!t) return res.status(401).json({ error: "no session" });
  const { rows } = await q(`SELECT * FROM agents WHERE tenant_id=$1 ORDER BY updated_at DESC`, [t.id]);
  res.json({ agents: rows.map(a => ({ ...a, readiness: readiness(a) })) });
});

app.post("/api/me/agents", async (req, res) => {
  const t = await currentTenant(req); if (!t) return res.status(401).json({ error: "no session" });
  const d = cleanAgent(req.body || {});
  if (!d.name) return res.status(400).json({ error: "The agent needs a name before it can be saved." });
  /* Same default the setup screen applies, so an agent created through the
     API alone lands on the right route: an Egyptian account gets the trunk,
     which is the only route carrying inbound and outbound on their own
     +20 number. Anything the client actually sent always wins. */
  if (!d.channel_cfg || !d.channel_cfg.route) {
    const eg = ["ar", "eg"].includes(t.lang) ||
               /^\+?20/.test(String((d.channel_cfg && d.channel_cfg.number) || "").replace(/[^\d+]/g, ""));
    d.channel_cfg = { ...(d.channel_cfg || {}), route: eg ? "trunk" : "web" };
  }
  const { rows } = await q(
    `INSERT INTO agents(tenant_id,name,channel,direction,lang,business,knowledge,rules,script,transfer_to,channel_cfg)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [t.id, d.name, d.channel || "voice", d.direction || "inbound", d.lang || "match",
     JSON.stringify(d.business || {}), d.knowledge || "", d.rules || "", d.script || "",
     d.transfer_to || null, JSON.stringify(d.channel_cfg || {})]);
  await track(t.id, "agent_created", { agent: rows[0].id, channel: rows[0].channel });
  res.json({ agent: { ...rows[0], readiness: readiness(rows[0]) } });
});

app.patch("/api/me/agents/:id", async (req, res) => {
  const t = await currentTenant(req); if (!t) return res.status(401).json({ error: "no session" });
  const d = cleanAgent(req.body || {});
  const keys = Object.keys(d);
  if (!keys.length) return res.status(400).json({ error: "Nothing to update." });
  const sets = keys.map((k, i) => `${k}=$${i + 3}`).join(",");
  const vals = keys.map(k => (k === "business" || k === "channel_cfg") ? JSON.stringify(d[k]) : d[k]);
  const { rows } = await q(
    `UPDATE agents SET ${sets}, updated_at=now() WHERE id=$1 AND tenant_id=$2 RETURNING *`,
    [req.params.id, t.id, ...vals]);
  if (!rows.length) return res.status(404).json({ error: "That agent does not exist on your account." });
  await track(t.id, "agent_configured", { agent: rows[0].id });
  res.json({ agent: { ...rows[0], readiness: readiness(rows[0]) } });
});

app.post("/api/me/agents/:id/tested", async (req, res) => {
  const t = await currentTenant(req); if (!t) return res.status(401).json({ error: "no session" });
  const { rows } = await q(`UPDATE agents SET tested_at=now(), updated_at=now() WHERE id=$1 AND tenant_id=$2 RETURNING *`,
    [req.params.id, t.id]);
  if (!rows.length) return res.status(404).json({ error: "That agent does not exist on your account." });
  await track(t.id, "test_successful", { agent: rows[0].id });
  res.json({ agent: { ...rows[0], readiness: readiness(rows[0]) } });
});

/* Deploy means: this configuration is complete and the customer has asked
   for it to go live. It does NOT claim a phone line exists — that still
   depends on the trunk, which is why provisioning gets a row for you. */
app.post("/api/me/agents/:id/deploy", async (req, res) => {
  const t = await currentTenant(req); if (!t) return res.status(401).json({ error: "no session" });
  if (t.status !== "active") return res.status(402).json({ error: "Your subscription is not active yet." });
  /* Confirmed before it goes live, not before they can build. Deploying is the
     point where a real caller could reach this agent. */
  if (!t.email_verified) return res.status(403).json({
    error: "Confirm your email before the agent goes live. Check your inbox, or send the link again from your account.",
    needsVerify: true });
  const { rows } = await q(`SELECT * FROM agents WHERE id=$1 AND tenant_id=$2`, [req.params.id, t.id]);
  if (!rows.length) return res.status(404).json({ error: "That agent does not exist on your account." });
  const r = readiness(rows[0]);
  if (!r.ready) return res.status(400).json({ error: "This agent is not ready yet.", readiness: r });
  const { rows: up } = await q(`UPDATE agents SET status='live', deployed_at=now(), updated_at=now() WHERE id=$1 RETURNING *`, [rows[0].id]);
  const route = (up[0].channel_cfg && up[0].channel_cfg.route) || "web";
  if (route !== "web")
    await q(`INSERT INTO provisioning(tenant_id,kind,detail) VALUES($1,$2,$3)`,
      [t.id, route === "trunk" ? "number_connect" : "number_connect",
       `${up[0].name}: ${route} on ${(up[0].channel_cfg && up[0].channel_cfg.number) || "number not given"}`]);
  await track(t.id, "deployment_successful", { agent: up[0].id, route });
  res.json({ agent: { ...up[0], readiness: readiness(up[0]) },
             note: route === "web" ? "Live now on your call link."
                                   : "Configuration is live. Your line is queued for connection." });
});

app.post("/api/me/agents/:id/pause", async (req, res) => {
  const t = await currentTenant(req); if (!t) return res.status(401).json({ error: "no session" });
  const { rows } = await q(`UPDATE agents SET status='paused', updated_at=now() WHERE id=$1 AND tenant_id=$2 RETURNING *`,
    [req.params.id, t.id]);
  if (!rows.length) return res.status(404).json({ error: "That agent does not exist on your account." });
  res.json({ agent: { ...rows[0], readiness: readiness(rows[0]) } });
});

app.delete("/api/me/agents/:id", async (req, res) => {
  const t = await currentTenant(req); if (!t) return res.status(401).json({ error: "no session" });
  const { rowCount } = await q(`DELETE FROM agents WHERE id=$1 AND tenant_id=$2`, [req.params.id, t.id]);
  if (!rowCount) return res.status(404).json({ error: "That agent does not exist on your account." });
  res.json({ ok: true });
});

/* The agent is told the opening hours and should refuse out-of-hours requests,
   but it is a language model and this is someone's diary. The rule is enforced
   here as well: a booking outside the hours stays a lead and is flagged, rather
   than appearing as a real appointment nobody will be there for. */
const DAYKEYS = ["sun","mon","tue","wed","thu","fri","sat"];
function withinHours(agent, when) {
  const b = (agent && agent.business) || {};
  const h = b.open_hours;
  if (!h) return { ok: true };                       // no hours set, nothing to enforce
  const d = new Date(when);
  const day = h[DAYKEYS[d.getUTCDay()]];
  if (!day || day.shut) return { ok: false, why: "closed that day" };
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  const toMin = s => { const [H, M] = String(s || "").split(":").map(Number); return (H || 0) * 60 + (M || 0); };
  let open = toMin(day.open), close = toMin(day.close);
  const last = Number(b.last_booking_min || 0);
  if (close <= open) close += 24 * 60;               // a closing time past midnight
  const t = mins < open ? mins + 24 * 60 : mins;
  if (t < open || t > close - last) return { ok: false, why: "outside opening hours" };
  const lead = Number(b.lead_time_min || 0);
  if (lead && d.getTime() < Date.now() + lead * 60000) return { ok: false, why: "too soon" };
  return { ok: true };
}

/* ============================================================
   BOOKING CONFIRMATIONS ON WHATSAPP
   ------------------------------------------------------------
   Sent from the CUSTOMER's own WhatsApp Business number, not
   ours, so the guest sees the restaurant or the agency they
   actually called. That means the customer supplies three things
   from their Meta Business account, which they set in the app:
     phone_number_id, a permanent token, and an APPROVED template.

   Meta requires a pre-approved template for any message a
   business sends first. A booking confirmation is a "utility"
   template, which is permitted in Egypt; it is the calling API,
   not messaging, that Meta blocks here. Without those three
   values nothing is sent and the attempt is recorded as skipped,
   because silently doing nothing is how people discover at the
   worst moment that confirmations were never going out.
   ============================================================ */
async function confirmOnWhatsApp(tenantId, booking, agent) {
  const cfg2 = ((agent && agent.channel_cfg) || {}).wa || {};
  const to = String(booking.phone || "").replace(/[^\d]/g, "");
  const note = (status, detail) => q(
    `INSERT INTO notifications(tenant_id,booking_id,channel,to_addr,status,detail) VALUES($1,$2,'whatsapp',$3,$4,$5)`,
    [tenantId, booking.id, to || "unknown", status, detail]).catch(() => {});

  if (!to) return note("skipped", "no phone number captured on the call");
  if (!cfg2.phone_number_id || !cfg2.token || !cfg2.template)
    return note("skipped", "WhatsApp not connected for this agent");

  const when = new Date(booking.starts_at);
  const vars = [
    booking.name || "there",
    when.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }),
    when.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
    String(booking.party || ""),
  ].filter(v => v !== "");

  try {
    const r = await fetch(`https://graph.facebook.com/v21.0/${cfg2.phone_number_id}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg2.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp", to,
        type: "template",
        template: {
          name: cfg2.template,
          language: { code: cfg2.lang || "ar" },
          components: [{ type: "body", parameters: vars.map(text => ({ type: "text", text })) }],
        },
      }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      /* Meta's own error text is the only useful thing here, so keep it. */
      const msg = (body.error && (body.error.error_user_msg || body.error.message)) || ("HTTP " + r.status);
      return note("failed", msg);
    }
    return note("sent", (body.messages && body.messages[0] && body.messages[0].id) || "ok");
  } catch (e) { return note("failed", e.message); }
}

app.get("/api/me/notifications", async (req, res) => {
  const t = await currentTenant(req); if (!t) return res.status(401).json({ error: "no session" });
  const { rows } = await q(`SELECT * FROM notifications WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100`, [t.id]);
  res.json({ notifications: rows });
});

/* ============================================================
   CAPACITY
   ------------------------------------------------------------
   A restaurant with ten tables and forty covers can confirm a
   booking itself, as long as something counts what is already
   taken at that hour. This is that counter. Without it the agent
   would have to say "we will call you back", which is the thing
   this product exists to avoid.

   Capacity lives on the agent's business config:
     seats      total covers at any one time
     tables     total tables at any one time
     slot_min   how long a booking holds its table
   Any of them may be absent, and an absent limit is not enforced.
   ============================================================ */
async function capacityCheck(tenantId, agent, startsAt, minutes, party) {
  const b = (agent && agent.business) || {};
  const seats = Number(b.seats) || 0, tables = Number(b.tables) || 0;
  if (!seats && !tables) return { ok: true, unlimited: true };

  const start = new Date(startsAt);
  const dur = Number(minutes) || Number(b.slot_min) || 60;
  const end = new Date(start.getTime() + dur * 60000);

  /* Everything that overlaps this window and still counts against the room.
     A cancelled booking frees its table; a request has not taken one yet. */
  const { rows } = await q(
    `SELECT party, minutes, starts_at FROM bookings
      WHERE tenant_id=$1 AND status NOT IN ('cancelled','noshow','requested')
        AND starts_at < $3 AND (starts_at + (COALESCE(minutes,60) || ' minutes')::interval) > $2`,
    [tenantId, start.toISOString(), end.toISOString()]);

  const takenSeats = rows.reduce((a, r) => a + (Number(r.party) || 0), 0);
  const takenTables = rows.length;
  const want = Number(party) || 0;

  if (seats && want && takenSeats + want > seats)
    return { ok: false, why: "full", seatsLeft: Math.max(0, seats - takenSeats), tablesLeft: tables ? Math.max(0, tables - takenTables) : null };
  if (tables && takenTables + 1 > tables)
    return { ok: false, why: "no table free", seatsLeft: seats ? Math.max(0, seats - takenSeats) : null, tablesLeft: 0 };

  return { ok: true, seatsLeft: seats ? seats - takenSeats - want : null, tablesLeft: tables ? tables - takenTables - 1 : null };
}

/* What the agent calls mid-call to decide whether it can say yes. */
app.get("/api/me/availability", async (req, res) => {
  const t = await currentTenant(req); if (!t) return res.status(401).json({ error: "no session" });
  const at = new Date(String(req.query.at || ""));
  if (isNaN(at.getTime())) return res.status(400).json({ error: "A valid time is required." });
  const party = parseInt(req.query.party || "0", 10);
  const mins = parseInt(req.query.minutes || "0", 10) || null;
  let agent = null;
  if (req.query.agent_id) {
    const { rows } = await q(`SELECT business FROM agents WHERE id=$1 AND tenant_id=$2`, [req.query.agent_id, t.id]);
    agent = rows[0] || null;
  }
  const hrs = withinHours(agent, at);
  const cap = await capacityCheck(t.id, agent, at, mins, party);
  res.json({
    canBook: hrs.ok && cap.ok,
    openNow: hrs.ok, why: hrs.ok ? (cap.ok ? null : cap.why) : hrs.why,
    seatsLeft: cap.seatsLeft ?? null, tablesLeft: cap.tablesLeft ?? null,
  });
});

/* ------------------------------------------------------------ bookings */
app.get("/api/me/bookings", async (req, res) => {
  const t = await currentTenant(req); if (!t) return res.status(401).json({ error: "no session" });
  const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 7 * 864e5);
  const to   = req.query.to   ? new Date(String(req.query.to))   : new Date(Date.now() + 60 * 864e5);
  if (isNaN(from) || isNaN(to)) return res.status(400).json({ error: "Bad date range." });
  const { rows } = await q(
    `SELECT b.*, a.name AS agent_name
       FROM bookings b LEFT JOIN agents a ON a.id = b.agent_id
      WHERE b.tenant_id=$1 AND b.starts_at BETWEEN $2 AND $3
      ORDER BY b.starts_at`, [t.id, from.toISOString(), to.toISOString()]);
  res.json({ bookings: rows, calendarUrl: `${siteUrl(req)}/cal/${t.cal_token}.ics` });
});

app.post("/api/me/bookings", async (req, res) => {
  const t = await currentTenant(req); if (!t) return res.status(401).json({ error: "no session" });
  const b = req.body || {};
  const at = new Date(b.starts_at);
  if (isNaN(at.getTime())) return res.status(400).json({ error: "A valid date and time is required." });
  let outside = false;
  if (b.agent_id) {
    const { rows: ac } = await q(`SELECT business FROM agents WHERE id=$1 AND tenant_id=$2`, [b.agent_id, t.id]);
    outside = !withinHours(ac[0], at).ok;   /* the owner may book outside their own hours; it is their diary */
  }
  const { rows } = await q(
    `INSERT INTO bookings(tenant_id,agent_id,name,phone,starts_at,minutes,party,service,notes,outside_hours,status)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [t.id, b.agent_id || null, String(b.name || "").slice(0,120), String(b.phone || "").slice(0,40),
     at.toISOString(), Number(b.minutes) || 60, b.party ? parseInt(b.party,10) : null,
     String(b.service || "").slice(0,60) || null, String(b.notes || "").slice(0,2000) || null,
     outside, outside ? "requested" : "booked"]);
  res.json({ booking: rows[0] });
});

app.patch("/api/me/bookings/:id", async (req, res) => {
  const t = await currentTenant(req); if (!t) return res.status(401).json({ error: "no session" });
  const b = req.body || {};
  const ok = ["requested","booked","confirmed","cancelled","done","noshow"];
  const sets = [], vals = [];
  if (b.status) { if (!ok.includes(b.status)) return res.status(400).json({ error: "Unknown status." });
                  sets.push(`status=$${sets.length+3}`); vals.push(b.status); }
  if (b.starts_at) { const at=new Date(b.starts_at); if (isNaN(at)) return res.status(400).json({error:"Bad date."});
                     sets.push(`starts_at=$${sets.length+3}`); vals.push(at.toISOString()); }
  if (b.notes != null) { sets.push(`notes=$${sets.length+3}`); vals.push(String(b.notes).slice(0,2000)); }
  if (!sets.length) return res.status(400).json({ error: "Nothing to update." });
  const { rows } = await q(`UPDATE bookings SET ${sets.join(",")} WHERE id=$1 AND tenant_id=$2 RETURNING *`,
    [req.params.id, t.id, ...vals]);
  if (!rows.length) return res.status(404).json({ error: "That booking is not on your account." });

  /* Confirming by hand is the moment the guest should hear from you. This is
     also the only confirmation an owner in review mode ever sends. */
  if (b.status === "confirmed") {
    const { rows: ag3 } = rows[0].agent_id
      ? await q(`SELECT channel_cfg FROM agents WHERE id=$1`, [rows[0].agent_id]) : { rows: [] };
    confirmOnWhatsApp(t.id, rows[0], ag3[0] || null);
  }
  res.json({ booking: rows[0] });
});

/* ------------------------------------------------------------ orders */
app.get("/api/me/orders", async (req, res) => {
  const t = await currentTenant(req); if (!t) return res.status(401).json({ error: "no session" });
  const { rows } = await q(
    `SELECT o.*, a.name AS agent_name FROM orders o LEFT JOIN agents a ON a.id=o.agent_id
      WHERE o.tenant_id=$1 ORDER BY o.created_at DESC LIMIT 300`, [t.id]);
  res.json({ orders: rows });
});

app.patch("/api/me/orders/:id", async (req, res) => {
  const t = await currentTenant(req); if (!t) return res.status(401).json({ error: "no session" });
  const ok = ["new","accepted","out","delivered","cancelled"];
  if (!ok.includes(req.body && req.body.status)) return res.status(400).json({ error: "Unknown status." });
  const { rows } = await q(`UPDATE orders SET status=$3 WHERE id=$1 AND tenant_id=$2 RETURNING *`,
    [req.params.id, t.id, req.body.status]);
  if (!rows.length) return res.status(404).json({ error: "That order is not on your account." });
  res.json({ order: rows[0] });
});

/* The calendar feed. Read-only, guessed-token-proof, and it works in Google,
   Apple and Outlook without asking anyone for permission to touch their diary. */
app.get("/cal/:token.ics", async (req, res) => {
  const tok = String(req.params.token || "");
  if (tok.length < 24) return res.status(404).end();
  const { rows: tr } = await q(`SELECT id,name FROM tenants WHERE cal_token=$1`, [tok]);
  if (!tr.length) return res.status(404).end();
  const { rows } = await q(
    `SELECT * FROM bookings WHERE tenant_id=$1 AND status NOT IN ('cancelled','requested')
       AND starts_at > now() - interval '60 days' ORDER BY starts_at`, [tr[0].id]);
  const z = d => new Date(d).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const esc = s => String(s || "").replace(/[\\;,]/g, m => "\\" + m).replace(/\n/g, "\\n");
  const lines = ["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//NABRA//bookings//EN","CALSCALE:GREGORIAN",
                 "METHOD:PUBLISH", `X-WR-CALNAME:${esc(tr[0].name)} · NABRA`];
  for (const b of rows) {
    lines.push("BEGIN:VEVENT", `UID:nabra-${b.id}@nabra`, `DTSTAMP:${z(b.created_at)}`,
      `DTSTART:${z(b.starts_at)}`,
      `DTEND:${z(new Date(new Date(b.starts_at).getTime() + (b.minutes || 60) * 60000))}`,
      `SUMMARY:${esc([b.name || "Booking", b.party ? `(${b.party})` : "", b.service || ""].filter(Boolean).join(" "))}`,
      `DESCRIPTION:${esc([b.phone, b.notes].filter(Boolean).join(" · "))}`,
      `STATUS:${b.status === "confirmed" ? "CONFIRMED" : "TENTATIVE"}`, "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  res.type("text/calendar").send(lines.join("\r\n"));
});

/* ------------------------------------------------------------ leads */
app.get("/api/me/leads", async (req, res) => {
  const t = await currentTenant(req); if (!t) return res.status(401).json({ error: "no session" });
  const { rows } = await q(`SELECT * FROM leads WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 500`, [t.id]);
  res.json({ leads: rows });
});

app.post("/api/me/leads/:id/status", async (req, res) => {
  const t = await currentTenant(req); if (!t) return res.status(401).json({ error: "no session" });
  const ok = ["new","qualified","contacted","booked","won","lost"];
  if (!ok.includes(req.body && req.body.status)) return res.status(400).json({ error: "Unknown status." });
  const { rows } = await q(`UPDATE leads SET status=$3 WHERE id=$1 AND tenant_id=$2 RETURNING *`,
    [req.params.id, t.id, req.body.status]);
  if (!rows.length) return res.status(404).json({ error: "That lead does not exist on your account." });
  res.json({ lead: rows[0] });
});

/* ------------------------------------------------------------ analytics
   The site already fires these events in the browser; this is where they
   land, so the funnel can actually be measured. */
async function track(tenantId, kind, detail) {
  try { await q(`INSERT INTO events(tenant_id,kind,detail) VALUES($1,$2,$3)`,
    [tenantId || null, String(kind).slice(0, 60), JSON.stringify(detail || {})]); }
  catch (e) { console.warn("track failed:", e.message); }
}
const EVENT_KINDS = ["visitor","demo_started","signup","agent_created","agent_configured",
  "integration_connected","test_started","test_successful","deployment_started",
  "deployment_successful","first_conversation","first_lead","subscription_started","checkout_opened"];
app.post("/api/events", async (req, res) => {
  const kind = String((req.body && req.body.kind) || "");
  if (!EVENT_KINDS.includes(kind)) return res.status(400).json({ error: "Unknown event." });
  const s = readSession(req);
  await track(s && s.id, kind, (req.body && req.body.detail) || {});
  res.json({ ok: true });
});

/* ------------------------------------------------------------ admin */
async function requireAdmin(req, res) {
  const s = readSession(req);
  if (!s) { res.redirect("/login"); return null; }
  const id = s.adm || s.id;                       // an impersonating admin is still an admin
  const { rows } = await q(`SELECT * FROM tenants WHERE id=$1 AND role='admin'`, [id]);
  if (!rows.length) { res.status(403).end("Admins only."); return null; }
  return rows[0];
}
app.get("/admin", async (req, res) => {
  const a = await requireAdmin(req, res); if (!a) return;
  serveWithBoot(res, FILES.admin, { admin: { name: a.name, email: a.email } });
});
app.get("/api/admin/stats", async (req, res) => {
  const a = await requireAdmin(req, res); if (!a) return;
  const [tn, mins, calls, pend] = await Promise.all([
    q(`SELECT status,plan,cycle,count(*)::int n FROM tenants WHERE role='customer' GROUP BY status,plan,cycle`),
    q(`SELECT coalesce(sum(minutes_used),0)::int m FROM tenants WHERE role='customer'`),
    q(`SELECT count(*)::int n FROM calls WHERE at > now()-interval '24 hours'`),
    q(`SELECT count(*)::int n FROM provisioning WHERE status!='done'`),
  ]);
  res.json({ tenants: tn.rows, minutes: mins.rows[0].m, calls24h: calls.rows[0].n, provisioningOpen: pend.rows[0].n });
});
app.get("/api/admin/tenants", async (req, res) => {
  const a = await requireAdmin(req, res); if (!a) return;
  const { rows } = await q(`SELECT id,name,email,plan,cycle,status,lang,vapi_assistant_ids,minutes_used,created_at
                            FROM tenants WHERE role='customer' ORDER BY created_at DESC`);
  res.json({ tenants: rows });
});
app.post("/api/admin/tenants/:id/status", async (req, res) => {
  const a = await requireAdmin(req, res); if (!a) return;
  const { status } = req.body || {};
  if (!["active", "suspended", "pending"].includes(status)) return res.status(400).json({ error: "bad status" });
  await q(`UPDATE tenants SET status=$1 WHERE id=$2 AND role='customer'`, [status, req.params.id]);
  await q(`INSERT INTO events(tenant_id,kind,detail) VALUES($1,'status_change',$2)`, [req.params.id, JSON.stringify({ by: a.email, status })]);
  res.json({ ok: true });
});
/* Push the cost guards onto a Vapi assistant. Silent no-op without an API key,
   so nothing breaks if you haven't set one yet — but then the caps are NOT in
   force and a stuck call bills until the caller's carrier drops it. */
async function applyCallLimits(assistantId) {
  if (!cfg("VAPI_API_KEY") || !assistantId) return { skipped: true };
  const r = await fetch(`https://api.vapi.ai/assistant/${assistantId}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${cfg("VAPI_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      /* runaway guard only — must be sent, or Vapi falls back to 600s */
      maxDurationSeconds: Number(cfg("MAX_CALL_SECONDS")) || 3600,
      /* the guard that does the real work: dead air and untranscribable noise */
      silenceTimeoutSeconds: Number(cfg("SILENCE_TIMEOUT_SECONDS")) || 30,
      /* strip background noise before it reaches the transcriber, so a noisy
         but real caller is understood instead of being treated as silence */
      backgroundDenoisingEnabled: true,
      /* let the agent hang up itself once it has said goodbye, rather than
         holding the line open until a timeout fires */
      endCallFunctionEnabled: true,
    }),
  });
  if (!r.ok) throw new Error("vapi PATCH " + assistantId + " → " + r.status);
  return { applied: true };
}

app.post("/api/admin/tenants/:id/assistants", async (req, res) => {
  /* attach the Vapi assistant id(s) you created for this customer —
     this mapping is how end-of-call webhooks find the right tenant */
  const a = await requireAdmin(req, res); if (!a) return;
  const ids = (req.body && req.body.ids || []).map(String);
  await q(`UPDATE tenants SET vapi_assistant_ids=$1 WHERE id=$2`, [ids, req.params.id]);
  /* optional: bind the first assistant to a named agent row so calls and
     leads attribute correctly. Pass agentId in the body to use it. */
  if (req.body && req.body.agentId && ids[0])
    await q(`UPDATE agents SET vapi_assistant_id=$1 WHERE id=$2 AND tenant_id=$3`,
      [ids[0], req.body.agentId, req.params.id]);
  /* every assistant gets the caps the moment it is attached */
  const limits = [];
  for (const id of ids) {
    try { limits.push({ id, ...(await applyCallLimits(id)) }); }
    catch (e) { limits.push({ id, error: e.message }); }
  }
  res.json({ ok: true, limits });
});

/* Re-push the caps to every assistant on file — run after changing the numbers. */
app.post("/api/admin/call-limits/apply", async (req, res) => {
  const a = await requireAdmin(req, res); if (!a) return;
  const { rows } = await q(`SELECT unnest(vapi_assistant_ids) id FROM tenants WHERE role='customer'`);
  const out = [];
  for (const r of rows) {
    try { out.push({ id: r.id, ...(await applyCallLimits(r.id)) }); }
    catch (e) { out.push({ id: r.id, error: e.message }); }
  }
  res.json({ ok: true, maxCallSeconds: Number(cfg("MAX_CALL_SECONDS")), silenceTimeoutSeconds: Number(cfg("SILENCE_TIMEOUT_SECONDS")), results: out });
});
app.post("/api/admin/impersonate/:id", async (req, res) => {
  const a = await requireAdmin(req, res); if (!a) return;
  const { rows } = await q(`SELECT * FROM tenants WHERE id=$1 AND role='customer'`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "no such tenant" });
  const token = sign({ id: rows[0].id, role: "customer", imp: true, adm: a.id, exp: Date.now() + 2 * 3600e3 });
  res.setHeader("Set-Cookie", `nabra_s=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=7200${process.env.NODE_ENV === "production" ? "; Secure" : ""}`);
  await q(`INSERT INTO events(tenant_id,kind,detail) VALUES($1,'impersonated',$2)`, [rows[0].id, JSON.stringify({ by: a.email })]);
  res.json({ redirect: "/app" });
});
app.get("/api/admin/provisioning", async (req, res) => {
  const a = await requireAdmin(req, res); if (!a) return;
  const { rows } = await q(`SELECT p.*, t.name tenant FROM provisioning p JOIN tenants t ON t.id=p.tenant_id
                            ORDER BY p.created_at DESC LIMIT 100`);
  res.json({ items: rows });
});
app.post("/api/admin/provisioning/:id/status", async (req, res) => {
  const a = await requireAdmin(req, res); if (!a) return;
  await q(`UPDATE provisioning SET status=$1 WHERE id=$2`, [req.body.status || "done", req.params.id]);
  res.json({ ok: true });
});
app.get("/api/admin/events", async (req, res) => {
  const a = await requireAdmin(req, res); if (!a) return;
  const { rows } = await q(`SELECT e.*, t.name tenant FROM events e LEFT JOIN tenants t ON t.id=e.tenant_id
                            ORDER BY e.at DESC LIMIT 60`);
  res.json({ events: rows });
});

app.get("/api/admin/config", async (req, res) => {
  const a = await requireAdmin(req, res); if (!a) return;
  const out = {};
  for (const k of APPLYABLE) {
    const v = cfg(k);
    out[k] = { set: !!v, source: CONF[k] !== undefined && CONF[k] !== "" ? "applied" : (CFG[k] ? "env" : "none"),
               hint: v ? (String(v).length > 6 ? "…" + String(v).slice(-4) : "set") : "" };
  }
  res.json({ config: out });
});
app.post("/api/admin/config", async (req, res) => {
  /* the Deployment tab's Apply button. Values are stored server-side and
     used immediately; they are never echoed back in full. */
  const a = await requireAdmin(req, res); if (!a) return;
  const body = req.body || {}, applied = [];
  for (const [k, v] of Object.entries(body)) {
    if (!APPLYABLE.includes(k)) continue;
    if (typeof v !== "string") continue;
    await q(`INSERT INTO config(key,value,updated_by) VALUES($1,$2,$3)
             ON CONFLICT (key) DO UPDATE SET value=$2, updated_by=$3, updated_at=now()`, [k, v, a.email]);
    applied.push(k);
  }
  await loadConf();
  if (applied.length) await q(`INSERT INTO events(tenant_id,kind,detail) VALUES(NULL,'config_applied',$1)`,
    [JSON.stringify({ by: a.email, keys: applied })]);
  res.json({ ok: true, applied });
});

/* ------------------------------------------------------------ Vapi webhook */
/* Set the assistant's (or account's) Server URL to  https://yourdomain/api/vapi/webhook
   and add a header credential  x-nabra-token: <VAPI_WEBHOOK_TOKEN>.
   We store end-of-call reports against the tenant that owns the assistant. */
app.post("/api/vapi/webhook", async (req, res) => {
  if (cfg("VAPI_WEBHOOK_TOKEN") && req.headers["x-nabra-token"] !== cfg("VAPI_WEBHOOK_TOKEN"))
    return res.status(401).json({ error: "bad token" });
  const msg = (req.body && req.body.message) || {};
  if (msg.type !== "end-of-call-report") return res.json({ ok: true });     // ignore other event types for now
  try {
    const call = msg.call || {};
    const assistantId = call.assistantId || (msg.assistant && msg.assistant.id) || null;
    const { rows } = assistantId
      ? await q(`SELECT id FROM tenants WHERE $1 = ANY(vapi_assistant_ids)`, [assistantId])
      : { rows: [] };
    const tenantId = rows.length ? rows[0].id : null;
    const durS = Math.round(Number(msg.durationSeconds || call.durationSeconds || 0));
    await q(`INSERT INTO calls(tenant_id,vapi_call_id,assistant_id,direction,from_number,duration_s,outcome,summary,transcript,payload)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             ON CONFLICT (vapi_call_id) DO NOTHING`,
      [tenantId, call.id || null, assistantId, call.type || null,
       (call.customer && call.customer.number) || null, durS,
       msg.analysis && msg.analysis.successEvaluation || null,
       msg.summary || (msg.analysis && msg.analysis.summary) || null,
       JSON.stringify(msg.artifact && msg.artifact.messages || msg.transcript || null),
       JSON.stringify(msg)]);
    if (tenantId && durS) await q(`UPDATE tenants SET minutes_used = minutes_used + $1 WHERE id=$2`, [Math.ceil(durS / 60), tenantId]);

    /* Link the call to the agent that took it, then keep anything the agent
       structured about the caller. Vapi returns this in analysis.structuredData
       when the assistant is configured to extract it; if it is not there we
       store nothing rather than inventing a lead. */
    let agentRow = null;
    if (tenantId && assistantId) {
      const { rows: ar } = await q(`SELECT id FROM agents WHERE tenant_id=$1 AND vapi_assistant_id=$2`, [tenantId, assistantId]);
      agentRow = ar[0] || null;
      if (agentRow) await q(`UPDATE calls SET agent_id=$1 WHERE vapi_call_id=$2`, [agentRow.id, call.id || null]);
    }
    const sd = (msg.analysis && msg.analysis.structuredData) || null;
    if (tenantId && sd && (sd.name || sd.phone)) {
      const { rows: cr } = await q(`SELECT id FROM calls WHERE vapi_call_id=$1`, [call.id || null]);
      await q(`INSERT INTO leads(tenant_id,agent_id,call_id,name,phone,intent,detail)
               VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [tenantId, agentRow ? agentRow.id : null, cr.length ? cr[0].id : null,
         sd.name || null,
         sd.phone || (call.customer && call.customer.number) || null,
         sd.intent || null,
         sd.summary || msg.summary || null]);
      await track(tenantId, "first_lead", { call: call.id || null });

      /* An order is a different shape of call: items and an address, no time.
         Only captured when the owner switched orders on for this agent. */
      let agentBiz = null;
      if (agentRow) {
        const { rows: ab } = await q(`SELECT business FROM agents WHERE id=$1`, [agentRow.id]);
        agentBiz = (ab[0] && ab[0].business) || null;
      }
      if (agentBiz && agentBiz.take_orders && (sd.items || sd.order)) {
        const { rows: cr3 } = await q(`SELECT id FROM calls WHERE vapi_call_id=$1`, [call.id || null]);
        await q(`INSERT INTO orders(tenant_id,agent_id,call_id,name,phone,address,items,total,notes)
                 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [tenantId, agentRow ? agentRow.id : null, cr3.length ? cr3[0].id : null,
           sd.name || null, sd.phone || (call.customer && call.customer.number) || null,
           sd.address || null, sd.items || sd.order || null,
           sd.total != null && !isNaN(Number(sd.total)) ? Number(sd.total) : null,
           sd.summary || null]);
        await track(tenantId, "order_created", { call: call.id || null });
      }

      /* If the agent captured a time, this was a booking, not just an enquiry.
         Parsing is deliberately strict: a time we cannot read with confidence
         becomes a lead with a note rather than a wrong entry in someone's
         diary, because a booking at the wrong hour is worse than none. */
      const when = sd.when || sd.datetime || sd.time || null;
      if (when) {
        const at = new Date(when);
        let agentCfg = null;
        if (agentRow) {
          const { rows: ac } = await q(`SELECT business FROM agents WHERE id=$1`, [agentRow.id]);
          agentCfg = ac[0] || null;
        }
        const hrs = withinHours(agentCfg, at);
        const party = sd.people ? parseInt(sd.people, 10) || null : null;
        const cap = await capacityCheck(tenantId, agentCfg, at, Number(sd.minutes) || 60, party);
        /* Some owners want every booking to pass their eye first. With review
           on, the agent still takes the booking, but it is held as a request
           and no confirmation goes out until the owner approves it. */
        const needsReview = !!(agentCfg && agentCfg.business && agentCfg.business.review_bookings);
        const fits = hrs.ok && cap.ok && !needsReview;
        if (!isNaN(at.getTime()) && at.getFullYear() > 2020) {
          /* A request for a time the business is shut is still worth having: it
             is unmet demand, and a restaurant that sees ten of them at 1am may
             decide to open later. It is saved as a request, never as confirmed,
             and marked so the owner can tell the two apart at a glance. */
          const { rows: cr2 } = await q(`SELECT id FROM calls WHERE vapi_call_id=$1`, [call.id || null]);
          await q(`INSERT INTO bookings(tenant_id,agent_id,call_id,name,phone,starts_at,minutes,party,service,notes,status,outside_hours)
                   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [tenantId, agentRow ? agentRow.id : null, cr2.length ? cr2[0].id : null,
             sd.name || null, sd.phone || (call.customer && call.customer.number) || null,
             at.toISOString(), Number(sd.minutes) || 60,
             sd.people ? parseInt(sd.people, 10) || null : null,
             sd.service || sd.intent || null,
             fits ? (sd.summary || null)
                  : [sd.summary,
                     needsReview && hrs.ok && cap.ok ? "Waiting for your approval"
                       : (hrs.ok ? `Over capacity: ${cap.why}` : `Asked for a time the business is ${hrs.why}`)]
                      .filter(Boolean).join(" · "),
             fits ? "booked" : "requested",
             !hrs.ok]);
          await track(tenantId, fits ? "booking_created" : (hrs.ok ? "booking_over_capacity" : "booking_outside_hours"),
                      { call: call.id || null, why: hrs.why || cap.why || null });

          /* A request is not a booking, so only a real one gets a confirmation.
             Telling someone their table is confirmed when it is not would be
             worse than sending nothing. */
          if (fits) {
            const { rows: nb } = await q(
              `SELECT * FROM bookings WHERE tenant_id=$1 ORDER BY id DESC LIMIT 1`, [tenantId]);
            const { rows: ag2 } = agentRow
              ? await q(`SELECT channel_cfg FROM agents WHERE id=$1`, [agentRow.id]) : { rows: [] };
            if (nb.length) confirmOnWhatsApp(tenantId, nb[0], ag2[0] || null);
          }
        } else {
          console.warn("[booking] unparseable time, kept as lead only:", when);
        }
      }
    }
    /* Cost-guard visibility: if a call ended on a cap, or ran long with no cap
       in force, say so in the log — repeated hits mean the numbers need tuning
       or a customer is being billed for silence. */
    const ended = String(msg.endedReason || call.endedReason || "");
    const cap = Number(cfg("MAX_CALL_SECONDS")) || 3600;
    if (/silence/i.test(ended))
      console.warn(`[cost-guard] call ${call.id} ended on silence after ${durS}s — working as intended`);
    else if (/max-duration|exceeded/i.test(ended))
      console.warn(`[cost-guard] call ${call.id} hit the RUNAWAY GUARD at ${durS}s. A real conversation should never reach this. ` +
                   `If it was genuine, raise MAX_CALL_SECONDS; if the number is 600 you are on Vapi's default and the guards were never applied to assistant ${assistantId}.`);
    else if (durS >= cap)
      console.warn(`[cost-guard] call ${call.id} ran ${durS}s ≥ ${cap}s — check the guards reached assistant ${assistantId}`);
  } catch (e) { console.error("vapi webhook:", e.message); }
  res.json({ ok: true });
});

/* ------------------------------------------------------------ Paymob (card payments, Egypt) */
async function paymobCheckoutUrl(tenant, co) {
  /* Auth → order → payment key → hosted iframe URL. Amounts in EGP piastres.
     Get the EGP price from your FX-driven price list before calling this. */
  const price = await fxConvertUSD(planUSD(co.plan, co.cycle));
  const auth = await pfetch("https://accept.paymob.com/api/auth/tokens", { api_key: cfg("PAYMOB_API_KEY") });
  const order = await pfetch("https://accept.paymob.com/api/ecommerce/orders",
    { auth_token: auth.token, amount_cents: Math.round(price.egp * 100), currency: "EGP", items: [] });
  const key = await pfetch("https://accept.paymob.com/api/acceptance/payment_keys", {
    auth_token: auth.token, amount_cents: Math.round(price.egp * 100), currency: "EGP",
    order_id: order.id, integration_id: Number(cfg("PAYMOB_INTEGRATION_ID")),
    billing_data: { email: tenant.email, first_name: tenant.name, last_name: "-", phone_number: "-",
      apartment: "-", floor: "-", street: "-", building: "-", city: "Cairo", country: "EG", state: "-" },
  });
  await q(`UPDATE tenants SET consent = consent || $1 WHERE id=$2`,
    [JSON.stringify({ paymob_order: order.id }), tenant.id]);
  return `https://accept.paymob.com/api/acceptance/iframes/${cfg("PAYMOB_IFRAME_ID")}?payment_token=${key.token}`;
}
async function pfetch(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(url + " → " + r.status);
  return r.json();
}
const ANNUAL_MONTHS_FREE = 2; /* yearly bundle = pay (12 - this) months.
                                 KEEP IN LOCKSTEP with PRICING.annualMonthsFree in nabra-voice-ai.html */
const PLAN_USD = { starter: 49, growth: 129, enterprise: 399 }; /* keep in lockstep with the PRICING object in nabra-voice-ai.html */
function planUSD(plan, cycle) {
  const usd = PLAN_USD[plan] || PLAN_USD.growth;
  return cycle === "annual" ? usd * (12 - ANNUAL_MONTHS_FREE) : usd;
}
/* One source of truth for the UIs: the dashboard and admin panel read prices
   from here instead of carrying their own copies. */
app.get("/api/pricing", (req, res) => {
  res.json({ plans: PLAN_USD, annualMonthsFree: ANNUAL_MONTHS_FREE, vatPct: 14 });
});
app.post("/api/pay/webhook", async (req, res) => {
  /* Paymob transaction-processed callback. Verify their HMAC, then activate. */
  try {
    const obj = req.body && req.body.obj || {};
    if (cfg("PAYMOB_HMAC")) {
      const fields = ["amount_cents","created_at","currency","error_occured","has_parent_transaction","id","integration_id",
        "is_3d_secure","is_auth","is_capture","is_refunded","is_standalone_payment","is_voided","order.id","owner",
        "pending","source_data.pan","source_data.sub_type","source_data.type","success"];
      const flat = k => k.split(".").reduce((o, kk) => (o || {})[kk], obj);
      const mac = crypto.createHmac("sha512", cfg("PAYMOB_HMAC")).update(fields.map(f => String(flat(f))).join("")).digest("hex");
      if (mac !== req.query.hmac) return res.status(401).end();
    }
    if (obj.success === true && obj.order && obj.order.id) {
      const { rows } = await q(`SELECT id FROM tenants WHERE consent->>'paymob_order' = $1`, [String(obj.order.id)]);
      if (rows.length) {
        await q(`UPDATE tenants SET status='active' WHERE id=$1`, [rows[0].id]);
        await q(`INSERT INTO events(tenant_id,kind,detail) VALUES($1,'payment_success',$2)`,
          [rows[0].id, JSON.stringify({ order: obj.order.id, amount_cents: obj.amount_cents })]);
      }
    }
  } catch (e) { console.error("pay webhook:", e.message); }
  res.json({ ok: true });
});

/* ------------------------------------------------------------ FX proxy */
app.get("/api/fx/:what(current|convert|history)", async (req, res) => {
  try {
    const u = new URL("/api/fx/" + req.params.what, cfg("FX_SERVICE_URL"));
    for (const [k, v] of Object.entries(req.query)) u.searchParams.set(k, v);
    const r = await fetch(u); res.status(r.status).json(await r.json());
  } catch { res.status(502).json({ error: "FX service unreachable" }); }
});
async function fxConvertUSD(usd) {
  try {
    const r = await fetch(new URL("/api/fx/convert?usd=" + usd, cfg("FX_SERVICE_URL")));
    if (r.ok) return r.json();
  } catch {}
  throw new Error("FX service unreachable — cannot price in EGP");
}

/* ------------------------------------------------------------ crawlers
   Generated rather than static so they always carry the real domain,
   and so the private areas are never advertised to a crawler. */
app.get("/robots.txt", (req, res) => {
  res.type("text/plain").send(
`User-agent: *
Allow: /$
Allow: /legal
Disallow: /app
Disallow: /admin
Disallow: /setup
Disallow: /signup
Disallow: /login
Disallow: /api/

Sitemap: ${siteUrl(req)}/sitemap.xml
`);
});
app.get("/sitemap.xml", (req, res) => {
  const base = siteUrl(req);
  const today = new Date().toISOString().slice(0, 10);
  const pages = [["/", "1.0"], ["/legal", "0.5"]];
  res.type("application/xml").send(
`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages.map(([p, pr]) => `  <url><loc>${base}${p}</loc><lastmod>${today}</lastmod><priority>${pr}</priority></url>`).join("\n")}
</urlset>
`);
});

app.get("/health", (req, res) => res.json({ ok: true, payments: cfg("PAYMENTS_MODE") }));

/* ------------------------------------------------------------ auth pages (inline, brand-matched) */
/* Only providers with keys configured are offered, so a button on this page
   always leads somewhere. The checkout handoff token rides along so a person
   who signed in socially keeps the plan they chose. */
function socialBlock(isUp, tok) {
  const q = tok ? "?t=" + encodeURIComponent(tok) : "";
  const verb = isUp ? "Sign up" : "Log in";
  const btns = [];
  if (googleOn()) btns.push(
    `<a href="/auth/google${q}"><svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#4285F4" d="M45 24c0-1.6-.1-2.7-.4-3.9H24v7.1h12c-.2 1.9-1.5 4.7-4.4 6.6l6.7 5.2C42.2 35.5 45 30.3 45 24z"/><path fill="#34A853" d="M24 46c5.9 0 10.9-2 14.5-5.3l-6.9-5.4c-1.8 1.3-4.3 2.2-7.6 2.2-5.8 0-10.7-3.8-12.5-9.900l-7.1 5.5C8.1 40.8 15.4 46 24 46z"/><path fill="#FBBC05" d="M11.5 27.6c-.5-1.4-.7-2.9-.7-4.4s.3-3 .7-4.4l-7.1-5.5C2.9 16.4 2 20.1 2 24s.9 7.6 2.4 10.7l7.1-7.1z"/><path fill="#EA4335" d="M24 10.4c4.1 0 6.9 1.8 8.5 3.3l6.2-6.1C34.9 4.1 29.9 2 24 2 15.4 2 8.1 7.2 4.4 13.3l7.1 5.5C13.3 14.2 18.2 10.4 24 10.4z"/></svg>${verb} with Google</a>`);
  if (!btns.length) return "";
  return `<div class="soc">${btns.join("")}</div><div class="or">or with email</div>`;
}

function authPage(kind, co, tok) {
  const isUp = kind === "signup";
  /* Someone who arrived here without choosing a plan should not discover later
   that one was picked for them. Name it, and offer the way back. */
const planLine = isUp && co
  ? `<p class="plan">Plan: <b>${esc(co.plan)}</b> · billed ${esc(co.cycle)}, invoiced in EGP` +
    `${tok ? "" : ` &nbsp;<a href="/#plans" class="chg">Change</a>`}</p>`
  : "";
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${isUp ? "Create your account" : "Log in"} — NABRA</title>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:ital,wght@0,400;0,500;0,600;0,700;0,800&family=Chivo+Mono:wght@400&display=swap" rel="stylesheet">
<style>
:root{--bone:#EEF2F9;--fg:#163466;--mute:#4A5F86;--rule:rgba(22,52,102,.12);--ember:#C08A2E}
*{box-sizing:border-box;margin:0}body{background:var(--bone);color:var(--fg);font-family:'Plus Jakarta Sans',sans-serif;
display:grid;place-items:center;min-height:100vh;padding:1.5rem}
.card{width:100%;max-width:400px;border:1px solid var(--rule);border-radius:16px;padding:2rem;background:#fff}
h1{font-family:'Plus Jakarta Sans',system-ui,sans-serif;font-weight:700;letter-spacing:-.03em;font-size:1.65rem;margin-bottom:.4rem}
.brand{display:flex;align-items:center;gap:.5rem;margin-bottom:1.6rem;font-family:'Plus Jakarta Sans',system-ui,sans-serif;font-weight:800;letter-spacing:-.02em;font-size:1.15rem}
.brand i{width:6px;height:6px;border-radius:50%;background:var(--ember)}
.plan{font-size:.82rem;color:var(--mute);margin-bottom:1.2rem}
label{display:block;font-family:'Chivo Mono',monospace;font-size:.58rem;letter-spacing:.15em;text-transform:uppercase;color:var(--mute);margin:.9rem 0 .3rem}
input{width:100%;border:1px solid var(--rule);border-radius:9px;padding:.6rem .8rem;font:inherit;font-size:.9rem;background:var(--bone)}
input:focus{outline:none;border-color:var(--fg)}
.soc{display:grid;gap:.55rem;margin-bottom:.2rem}
.soc a{display:flex;align-items:center;justify-content:center;gap:.6rem;padding:.68rem 1rem;border-radius:9px;
  border:1px solid var(--rule);text-decoration:none;font-size:.92rem;font-weight:500;background:#fff;color:var(--fg)}
.soc a:hover{border-color:var(--fg)}
.soc svg{width:17px;height:17px;flex:none}
.or{display:flex;align-items:center;gap:.7rem;margin:1.1rem 0 .2rem;color:var(--mute);
  font-family:'Chivo Mono',monospace;font-size:.58rem;letter-spacing:.15em;text-transform:uppercase}
.or::before,.or::after{content:"";flex:1;height:1px;background:var(--rule)}
button{width:100%;margin-top:1.3rem;padding:.7rem;border:none;border-radius:999px;background:var(--fg);color:#fff;font:inherit;font-weight:500;cursor:pointer}
.err{color:var(--ember);font-size:.8rem;margin-top:.8rem;display:none}
.plan .chg{color:var(--fg);text-decoration:underline;font-weight:500}
.alt{font-size:.8rem;color:var(--mute);margin-top:1.2rem;text-align:center}.alt a{color:var(--fg)}
</style></head><body><div class="card">
<div class="brand">نبرة NABRA <i></i></div>
<h1>${isUp ? "Create your account" : "Welcome back"}</h1>
${planLine}
${socialBlock(isUp, tok)}
${isUp ? `<label>Business name</label><input id="n" autocomplete="organization">` : ""}
<label>Email</label><input id="e" type="email" autocomplete="email">
<label>Password</label><input id="p" type="password" autocomplete="${isUp ? "new-password" : "current-password"}" minlength="8">
<button id="go">${isUp ? "Create account →" : "Log in →"}</button>
<p class="err" id="err"></p>
<p class="alt">${isUp ? `Already with us? <a href="/login">Log in</a>` : `New here? <a href="/signup">Create an account</a> &nbsp;·&nbsp; <a href="/">See the plans</a>`}</p>
</div><script>
document.getElementById("go").addEventListener("click", async ()=>{
  const err=document.getElementById("err"); err.style.display="none";
  const body=${isUp
    ? `{name:document.getElementById("n").value,email:document.getElementById("e").value,password:document.getElementById("p").value,t:${JSON.stringify(tok || "")}}`
    : `{email:document.getElementById("e").value,password:document.getElementById("p").value}`};
  const r=await fetch("/api/auth/${isUp ? "signup" : "login"}",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  const j=await r.json().catch(()=>({}));
  if(r.ok && j.redirect){ location.href=j.redirect; }
  else { err.textContent=j.error||"Something went wrong."; err.style.display="block"; }
});
document.addEventListener("keydown",e=>{ if(e.key==="Enter") document.getElementById("go").click(); });
</script></body></html>`;
}
const esc = s => String(s).replace(/[<>&"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));

/* Anything unmatched. Kept deliberately plain: no stack traces, no hints
   about which private routes exist. */
app.use((req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "No such endpoint." });
  res.status(404).type("html").send(
`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="color-scheme" content="light only">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Not found — NABRA</title>
<style>html{background:#EEF2F9!important;color-scheme:only light!important}
body{background:#EEF2F9!important;color:#163466!important;font-family:system-ui,sans-serif;
display:grid;place-items:center;min-height:100vh;margin:0;text-align:center;padding:2rem}
a{color:#C08A2E}</style></head><body><div>
<h1 style="font-weight:400;font-size:1.6rem;margin:0 0 .5rem">This page does not exist</h1>
<p style="color:#4A5F86;margin:0 0 1.2rem">The link may be old, or mistyped.</p>
<a href="/">Back to the site</a></div></body></html>`);
});

/* ------------------------------------------------------------ boot */
migrate()
  .then(loadConf)
  .then(() => app.listen(CFG.PORT, () => console.log(`NABRA gateway on :${CFG.PORT} — payments: ${CFG.PAYMENTS_MODE}`)))
  .catch(e => { console.error("migrate failed:", e.message); process.exit(1); });

module.exports = { app, sign, verify, hashPw, checkPw };
