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
  /* Accounts that use NABRA without paying — the owner's own, plus anyone
     comped deliberately. Comma-separated emails, matched case-insensitively
     when the account is created. Any account can also be comped later from
     the admin panel, so this list is a convenience, not the only way in. */
  FREE_ACCESS_EMAILS: process.env.FREE_ACCESS_EMAILS || "mohamedtata071@gmail.com",
  /* How long a session lasts when the customer ticks "keep me signed in".
     Without the tick the cookie dies with the browser, which is what a
     shared or office machine needs. */
  SESSION_DAYS_REMEMBER: Number(process.env.SESSION_DAYS_REMEMBER || 30),
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
  /* Vapi's API. Only ever overridden to point a test or staging run at a
     stand-in; production must leave it alone. */
  VAPI_BASE: process.env.VAPI_BASE || "https://api.vapi.ai",
  /* First admin, created on boot if missing. CHANGE THE PASSWORD AFTER LOGIN. */
  ADMIN_EMAIL: process.env.ADMIN_EMAIL || "admin@nabra.local",
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || "",
  /* NABRA's own phone line. Empty by default and the site shows no number at
     all: a number nobody answers is worse than none. Set it from the admin
     panel's Deployment tab when the line is actually live. */
  NABRA_PHONE: process.env.NABRA_PHONE || "",
  NABRA_PHONE_NOTE: process.env.NABRA_PHONE_NOTE || "",
  /* The on-site assistant answers through this server so the key is never in
     anyone's browser. Without it the widget says it is unavailable rather than
     making something up. */
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "",
  ASK_MODEL: process.env.ASK_MODEL || "claude-sonnet-4-5",
  /* Static files live next to this script. */
  DIR: __dirname,
  SESSION_DAYS: 30,
};

/* Emails that get NABRA on the house, normalised once so every later
   comparison is a cheap Set lookup rather than a string split. */
const COMP_EMAILS = new Set(
  String(CFG.FREE_ACCESS_EMAILS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean));

/* ------------------------------------------------------------ billing truth
   One function decides whether an account may use the product. Everything
   else — the page gates, the API gate, the console, the admin panel — asks
   this, so there is exactly one place where "may they" is answered and no
   route can drift into letting an unpaid account through by accident.

     comp      → on the house, full access, never billed, never nagged
     active    → paid and in good standing
     pending   → signed up, has not paid yet
     suspended → was paying, is not now

   `paid` is deliberately false for pending. That is the paywall. */
function billing(t) {
  if (!t) return { paid: false, state: "none", comp: false, payable: false };
  const comp = !!t.comp;
  const state = comp ? "comp" : t.status;
  return {
    paid: comp || t.status === "active",
    state, comp,
    plan: t.plan, cycle: t.cycle,
    /* Can they actually pay right now? Only if cards are switched on. With
       payments off there is nothing to click, and the console says so
       instead of showing a button that cannot work. */
    payable: !comp && t.status !== "active" && cfg("PAYMENTS_MODE") === "paymob",
  };
}

if (CFG.SECRET === "dev-only-change-me") console.warn("⚠  SESSION_SECRET is the dev default — set a real one before going live.");
if (!CFG.DATABASE_URL) console.warn("⚠  DATABASE_URL not set — the gateway will not start without Postgres (Neon works).");

const pool = new Pool({ connectionString: CFG.DATABASE_URL, ssl: CFG.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false } });
const q = (text, params) => pool.query(text, params);

/* ============================================================
   SCHEMA — created on boot, safe to re-run
   ============================================================ */
async function migrate() {
  /* gen_random_bytes() below lives in pgcrypto, which is not enabled by default
     on a fresh Postgres. Without this the first boot dies on the migration. */
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
  /* A setup is one conversation flow inside an agent: Customer Service, Sales,
     Reservations. The agent owns the phone number and the routing; each setup
     owns how that particular conversation goes. */
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

  /* setups references agents, so it has to be created after it: on a brand new
     database the other order fails the whole migration and the gateway never starts. */
  CREATE TABLE IF NOT EXISTS setups(
    id            SERIAL PRIMARY KEY,
    tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    agent_id      INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    greeting      TEXT NOT NULL DEFAULT '',
    instructions  TEXT NOT NULL DEFAULT '',          -- what this flow should do
    knowledge     TEXT NOT NULL DEFAULT '',
    rules         TEXT NOT NULL DEFAULT '',
    business      JSONB NOT NULL DEFAULT '{}',       -- hours, capacity, orders, review
    voice         JSONB NOT NULL DEFAULT '{}',       -- {key} only; provider ids stay server-side
    transfer_to   TEXT,
    intents       TEXT[] NOT NULL DEFAULT '{}',      -- words that mean "this flow"
    dtmf_key      TEXT,                              -- "1" | "2" | "3" ...
    active        BOOLEAN NOT NULL DEFAULT true,
    sort          INTEGER NOT NULL DEFAULT 0,
    vapi_assistant_id TEXT,                          -- a setup may get its own later
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS setups_agent ON setups(agent_id, sort);

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
  );
  /* NABRA's own knowledge about itself, split into sectors that can be edited
     one at a time from the admin panel. One source, three mouths: the Ask NABRA
     widget on the site, NABRA's own phone line, and anyone reading the brief. */
  CREATE TABLE IF NOT EXISTS site_sectors(
    id         SERIAL PRIMARY KEY,
    key        TEXT UNIQUE NOT NULL,
    title      TEXT NOT NULL,
    body       TEXT NOT NULL DEFAULT '',
    sort       INTEGER NOT NULL DEFAULT 0,
    active     BOOLEAN NOT NULL DEFAULT true,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  /* People an outbound agent is to ring, one row per person. The runner below
     claims rows from here and places the call through Vapi. A row is never
     dialled twice at once: claiming moves it to 'calling' inside the same
     transaction that selected it. */
  CREATE TABLE IF NOT EXISTS outbound_queue(
    id           SERIAL PRIMARY KEY,
    tenant_id    INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    agent_id     INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    name         TEXT NOT NULL DEFAULT '',
    phone        TEXT NOT NULL,
    note         TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'waiting',   -- waiting | calling | done | failed | cancelled
    attempts     INTEGER NOT NULL DEFAULT 0,
    last_error   TEXT,
    vapi_call_id TEXT,
    call_id      INTEGER REFERENCES calls(id) ON DELETE SET NULL,
    outcome      TEXT,
    summary      TEXT,
    not_before   TIMESTAMPTZ,                       -- backoff after a failed attempt
    dialled_at   TIMESTAMPTZ,
    finished_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS obq_due    ON outbound_queue(agent_id, status, not_before);
  CREATE INDEX IF NOT EXISTS obq_tenant ON outbound_queue(tenant_id, created_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS obq_vapi ON outbound_queue(vapi_call_id) WHERE vapi_call_id IS NOT NULL;`);

  /* Migrations for databases created before social sign-in existed.
     CREATE TABLE IF NOT EXISTS does nothing to a table that is already there,
     so these have to be explicit. All are safe to run repeatedly. */
  await q(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS oauth_provider TEXT`);
  await q(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS oauth_sub TEXT`);
  /* A private token per tenant for the read-only calendar feed, so a customer
     can subscribe from Google, Apple or Outlook without any OAuth dance. */
  await q(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS cal_token TEXT`);
  /* A DEFAULT, not just the backfill below. The backfill runs once at boot, so
     every tenant who signed up AFTER boot was left with a null token — their
     calendar feed resolved to /cal/null.ics and matched no tenant, which meant
     the booking subscription silently did not work for any real customer.
     A default covers every insert path, including signup. */
  await q(`ALTER TABLE tenants ALTER COLUMN cal_token SET DEFAULT encode(gen_random_bytes(16),'hex')`);
  /* Billing state. `comp` means this account is on the house: it behaves
     exactly like a paid one but is never charged and never asked to pay.
     It is kept separate from `status` on purpose — a comped account is not
     a pending one that someone forgot to invoice, and it should survive any
     future change to how paying accounts are activated. */
  await q(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS comp BOOLEAN NOT NULL DEFAULT false`);
  await q(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS comp_note TEXT`);
  await q(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ`);
  /* The owner's own account, and anyone else on the comp list, gets access
     without paying. Run on every boot so adding an email to the list is
     enough — no manual database work. */
  for (const e of COMP_EMAILS)
    await q(`UPDATE tenants SET comp=true, comp_note=COALESCE(comp_note,'on the house')
              WHERE lower(email)=$1 AND comp=false`, [e]);
  await q(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false`);
  await q(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS verify_sent_at TIMESTAMPTZ`);
  /* which flow took the call, so per-setup numbers are possible later */
  await q(`ALTER TABLE calls  ADD COLUMN IF NOT EXISTS setup_id INTEGER REFERENCES setups(id) ON DELETE SET NULL`);
  await q(`ALTER TABLE leads  ADD COLUMN IF NOT EXISTS setup_id INTEGER REFERENCES setups(id) ON DELETE SET NULL`);
  /* how this agent decides which flow a caller wants */
  await q(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS routing JSONB NOT NULL DEFAULT '{"mode":"hybrid"}'`);
  /* The Vapi phone number this agent dials FROM. It is a provider id, so it is
     set by us when the trunk is connected and never shown to the customer. No
     id means no outbound: the runner skips the agent rather than guessing. */
  await q(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS vapi_phone_number_id TEXT`);
  /* Window, pacing and pause switch for dialling out. Defaults are deliberately
     conservative: nobody's first campaign should ring someone at 7am. */
  await q(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS outbound JSONB NOT NULL DEFAULT
           '{"paused":true,"from":"10:00","to":"18:00","days":[0,1,2,3,4,6],"concurrency":1,"max_attempts":2,"gap_min":45}'`);

  /* Backward compatibility: every agent that predates setups keeps working by
     getting one setup built from the configuration it already has. Nothing is
     moved or deleted, so an older gateway would still read the agent fine. */
  await q(`
    INSERT INTO setups(tenant_id, agent_id, name, description, greeting, knowledge, rules, business, transfer_to, sort)
    SELECT a.tenant_id, a.id, 'Main line', 'Everything this agent already handled',
           COALESCE(a.business->>'greeting',''), a.knowledge, a.rules, a.business, a.transfer_to, 0
      FROM agents a
     WHERE NOT EXISTS (SELECT 1 FROM setups s WHERE s.agent_id = a.id)`);
  /* Accounts that existed before confirmation was added are left alone: they
     were created when no confirmation was asked for, and locking them out now
     would punish the earliest customers. */
  await q(`UPDATE tenants SET email_verified = true WHERE created_at < now() - interval '1 minute' AND email_verified = false`);
  await q(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS outside_hours BOOLEAN NOT NULL DEFAULT false`);
  await q(`UPDATE tenants SET cal_token = encode(gen_random_bytes(16),'hex') WHERE cal_token IS NULL`);
  await q(`ALTER TABLE tenants ALTER COLUMN pass_hash DROP NOT NULL`);
  await q(`CREATE UNIQUE INDEX IF NOT EXISTS tenants_oauth ON tenants(oauth_provider, oauth_sub)
           WHERE oauth_provider IS NOT NULL`);

  /* NABRA's own knowledge, seeded once from what this site actually says.
     Seeded, not hard-coded: every sector is editable from the admin panel
     afterwards, and nothing here is written again once a row exists. */
  await seedSectors();

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
   NABRA'S OWN KNOWLEDGE, IN SECTORS
   ------------------------------------------------------------
   Everything NABRA knows about itself, split so each part can be
   edited on its own without rewriting the lot. The seed below is
   what this website already says — no new claims, and the sector
   on what NABRA does NOT do matters as much as the rest, because
   an agent that oversells is worse than one that says it is not
   sure.

   Seeded once per key. Editing a sector in the admin panel is
   permanent: nothing here overwrites a row that already exists.
   ============================================================ */
const SECTOR_SEED = [
  { key:"what", sort:10, title:"What NABRA is", body:
`NABRA is an AI phone agent for businesses in Egypt. It answers the phone number a business already uses, speaks Egyptian Arabic, Modern Standard Arabic and English, and switches to whichever one the caller is speaking.
It answers on the first ring, at any hour. There is no hold music, no press-one menu by default, and nothing rings out after closing time.
It works in both directions: it answers calls that come in, and it makes calls out from a list.` },

  { key:"inbound", sort:20, title:"What it does on an incoming call", body:
`It greets the caller, works out what they want, and handles it: pricing questions, order status, a booking, a complaint, the ordinary questions a reception or support line gets all day.
It answers from what the business told it — its prices, its menu, its rules — and it is instructed not to invent anything it was not told.
If a call needs a person, it hands over with the context of the conversation rather than making the caller start again. The business decides whether that happens and which number it goes to.` },

  { key:"outbound", sort:30, title:"What it does on an outgoing call", body:
`The agent does not only answer. It calls out too, and this is on every plan, not just the larger ones.
On a call it makes, it qualifies naturally — budget, timing, who decides — and logs what it learned against the lead.
It can book a time, or transfer a hot lead straight to a salesperson.
Calling through a list automatically, on a schedule, is not switched on yet. Say so if anyone asks, and do not describe how a campaign would be set up.` },

  { key:"bookings", sort:40, title:"Bookings, opening hours and capacity", body:
`A business can switch bookings on, and then the agent takes them on the call: the time, the day, how many people, a name and a number.
Opening hours are set day by day. The agent offers a time that works first. If the caller still wants a time the business is closed, the agent takes it as a request rather than a confirmed booking and says so plainly — the business sees those requests in its dashboard, which is also how it finds out there is demand at hours it does not open.
Capacity is seats or tables. With a number set, the agent can say yes or no itself when a slot is full, instead of promising that somebody will check and ring back.
A business can also choose to approve every booking itself. The agent still takes the whole booking, but it never calls it confirmed.
Bookings appear in the dashboard as a calendar, and there is a calendar feed a business can subscribe to from Google, Apple or Outlook.` },

  { key:"orders", sort:50, title:"Orders and delivery zones", body:
`A restaurant or shop can switch orders on, and the same agent on the same number takes delivery and collection orders as well as bookings. It works out which the caller wants from what they say, and asks once if it genuinely cannot tell.
Delivery zones are set up as a list of areas, each with its own fee. An area can be split into zones — New Cairo into Zone 1, Zone 2, Zone 3 — and each zone carries its own fee.
The agent asks which area and zone the address is in, says the fee out loud before taking the order, and reads it back in the total. An address outside every listed area is declined politely, with collection offered instead.
A minimum order can be set, and the agent will not let an order go below it.` },

  { key:"languages", sort:60, title:"Arabic, Masri and English", body:
`The agent speaks Egyptian Arabic, Modern Standard Arabic and English, and follows the caller rather than forcing one language on them.
A business can pick a voice and a dialect for each line, and a different voice for each kind of conversation on the same number if it wants.
A business writing its script can write it in plain Masri. It does not need to be translated or formalised first.` },

  { key:"setups", sort:70, title:"One agent, one number, several conversations", body:
`A business does not need a separate number or a separate agent for each department.
One agent sits on one number and holds several setups — customer service, sales, reservations — and each setup has its own greeting, instructions, knowledge and voice.
Callers reach the right one either by saying what they want, by pressing a key, or by both together.` },

  { key:"connect", sort:80, title:"Getting it onto a business's own line", body:
`A business keeps the number already printed on its vans and invoices. Nothing its customers know has to change.
There is one way on: a SIP trunk. The operator puts a trunk on the number the business already has, including a 16xxx or 19xxx hotline, and points it at us. The number does not change and it stays in the operator's records in the business's own name. Calls run both ways on it, in and out, with no per-minute forwarding charge.
Call forwarding is not offered. It cannot carry outbound calls on the business's own number, and the operator bills for every forwarded minute. There is no call-link option either: a link is not a phone line.
The exact technical steps are shown inside the account after signing up, not on the public site.
Before anything goes live we prove the number really belongs to the business: a code called in from that line, a second code read back on a return call, and then a real test call that has to land on the agent.
Porting a number to us is the only route that needs paperwork — a signed authorisation and a recent operator invoice in the company name. A trunk on the business's own number needs neither.` },

  { key:"start", sort:90, title:"How a business starts", body:
`Four steps. Create the account and pick a plan. Paste in what the team already says on a call. Choose the dialect, the voice, and connect the line. Go live.
Signing up asks for an email and a password, or a Google account, and the email has to be confirmed. No phone number is asked for at sign-up: the phone numbers come later, and they are the agent's, not the customer's.
Setting up the agent is a form, not an engineering project.` },

  { key:"pricing", sort:100, title:"Plans and billing", body:
`Three plans. Every plan answers calls and makes them: outbound is not held back for a higher tier. Starter is one agent on one number, for a small team testing real calls. Growth adds several setups on the same number, live transfer to a sales team, bookings with a calendar feed, and more than one agent and number. Enterprise adds a cloned voice of the business's own, unlimited seats and numbers, custom integrations, an SLA and dedicated onboarding.
Billing is monthly or yearly, by card, cancel any time. Yearly is billed as a bundle and works out two months cheaper.
Customers in Egypt are billed in Egyptian pounds, and VAT is added at checkout.
Quote whatever price the page is showing, exactly as written. If no price is shown, say prices are available on request and offer to take their details. Never invent a figure and never convert one into another currency.` },

  { key:"limits", sort:110, title:"What NABRA does not do, and does not claim", body:
`This sector matters more than the others. Saying "I do not know" is always better than guessing.
It is not a human. It is an AI agent, and if a caller asks, say so straight away rather than letting them believe otherwise.
It does not sell phone lines or numbers. A business brings its own.
It does not read out the SIP or trunk configuration on the public site or over the phone. Those steps live inside the account, after sign-in.
It does not give legal, financial or medical advice.
There is no CRM integration, and no way to import a list of leads from a file or from another system. Leads come from calls, and they live in the dashboard. If someone asks about importing a list, say it is not something we have today rather than describing how it would work.
Outbound is included on every plan, but calling through a whole list on a schedule is not switched on yet: there is no way to upload a list and have it dialled automatically. If someone asks about running a campaign this week, say that plainly and take their details rather than describing how it would work.
It cannot see a particular customer's account, calls or bookings from the public site or from this phone line. Anyone asking about their own account should sign in, or ask to be put through.
If something is not covered in these sectors, say plainly that it is not something you have, and offer to take a name and number or to put the caller through to the team.` },

  { key:"contact", sort:120, title:"Reaching a person", body:
`Almost everything can be settled here without a person, and that is the point of the product.
If a caller has something urgent, or something these sectors do not cover, take their name, their number and what it is about, and say somebody from the team will come back to them. Do not promise a time unless you were given one.` },
];

/* Seeding runs on every boot, and the wording above changes as the product
   does. A sector you have edited is yours and is never touched again; one
   still sitting at exactly the text we shipped gets the newer text, so a
   correction here reaches a running install without anyone editing by hand.
   seeded_body is how the two are told apart. */
async function seedSectors() {
  await q(`ALTER TABLE site_sectors ADD COLUMN IF NOT EXISTS seeded_body TEXT`);
  for (const s of SECTOR_SEED) {
    await q(`INSERT INTO site_sectors(key,title,body,sort,seeded_body) VALUES($1,$2,$3,$4,$3)
             ON CONFLICT (key) DO UPDATE
                SET body        = EXCLUDED.body,
                    title       = EXCLUDED.title,
                    seeded_body = EXCLUDED.seeded_body,
                    updated_at  = now()
              WHERE site_sectors.body = site_sectors.seeded_body`,
      [s.key, s.title, s.body, s.sort]);
  }
  /* Rows seeded before this column existed have no record of what they started
     as. Anything still identical to the current seed is plainly untouched. */
  await q(`UPDATE site_sectors SET seeded_body = body
            WHERE seeded_body IS NULL AND key = ANY($1)`, [SECTOR_SEED.map(s => s.key)]);
}

/* The sectors, assembled into one brief. Used by the Ask NABRA widget on the
   site and by NABRA's own phone agent, so both answer from the same text and
   neither can drift from the other. */
async function siteBrief() {
  const { rows } = await q(
    `SELECT title, body FROM site_sectors WHERE active = true AND body <> '' ORDER BY sort, id`);
  return rows.map(r => `## ${r.title}\n${r.body}`).join("\n\n");
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
/* `remember` is the customer's answer to "keep me signed in".
   Ticked   → a dated cookie that survives closing the browser.
   Unticked → no Max-Age at all, so the cookie is a session cookie and dies
              with the browser. The signed payload gets a matching short
              expiry too, so clearing the cookie is not the only thing
              standing between a borrowed laptop and the account. */
function setSession(res, tenant, remember = true) {
  const days = remember ? Number(cfg("SESSION_DAYS_REMEMBER")) || CFG.SESSION_DAYS : 1;
  const token = sign({ id: tenant.id, role: tenant.role, exp: Date.now() + days * 864e5 });
  const age = remember ? `; Max-Age=${days * 86400}` : "";
  res.setHeader("Set-Cookie",
    `nabra_s=${token}; Path=/; HttpOnly; SameSite=Lax${age}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`);
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
const APPLYABLE = ["PAYMENTS_MODE","PAYMOB_API_KEY","PAYMOB_INTEGRATION_ID","PAYMOB_IFRAME_ID","PAYMOB_HMAC","VAPI_WEBHOOK_TOKEN","VAPI_API_KEY","MAX_CALL_SECONDS","SILENCE_TIMEOUT_SECONDS","FX_SERVICE_URL","SITE_URL","GOOGLE_CLIENT_ID","GOOGLE_CLIENT_SECRET","EMAIL_PROVIDER","EMAIL_API_KEY","EMAIL_FROM",
  /* NABRA's own line, and the key the on-site assistant answers with. The
     number is public by design; the key never leaves the server. */
  "NABRA_PHONE","NABRA_PHONE_NOTE","ANTHROPIC_API_KEY","ASK_MODEL"];
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
  /* index.html is the deployed name; the original name is kept as a fallback
     so the repo works under either, rather than 500ing on a missing file. */
  site: [path.join(CFG.DIR, "index.html"), path.join(CFG.DIR, "nabra-voice-ai.html")]
          .find(p => { try { return fs.existsSync(p); } catch (_) { return false; } })
        || path.join(CFG.DIR, "index.html"),
  dash: path.join(CFG.DIR, "nabra-dashboard.html"),
  admin: path.join(CFG.DIR, "admin-panel.html"),
  legal: path.join(CFG.DIR, "legal-public.html"),
  setup: path.join(CFG.DIR, "agent-setup-demo.html"),
};
const read = f => fs.readFileSync(f, "utf8");

/* inject the identity object right before </body> */
/* The identity object has to exist BEFORE the page's own script runs, because
   that script checks for it on the way in and gives up if it is missing. It
   used to be injected before </body>, which is after the script, so the check
   always failed and a signed-in customer was shown the sample data instead of
   their own calls, agents and bookings. It goes in the head now.
   The </body> branch is a fallback for a file with no head. */
function serveWithBoot(res, file, boot) {
  const tag = `<script>window.NABRA_BOOT=${JSON.stringify(boot).replace(/</g, "\\u003c")}</script>`;
  const src = read(file);
  const html = src.includes("</head>") ? src.replace("</head>", tag + "</head>")
                                       : src.replace("</body>", tag + "</body>");
  res.setHeader("Content-Type", "text/html; charset=utf-8").end(html);
}

async function currentTenant(req) {
  const s = readSession(req);
  if (!s) return null;
  const { rows } = await q(`SELECT id,name,email,role,plan,cycle,status,lang,vapi_assistant_ids,minutes_used,created_at,email_verified,cal_token,comp,comp_note,activated_at FROM tenants WHERE id=$1`, [s.id]);
  const t = rows[0];
  if (!t) return null;
  t._impersonated = !!s.imp;
  t._adminId = s.adm || null;
  return t;
}

/* ============================================================
   THE PAYWALL
   ------------------------------------------------------------
   NABRA is a paid product, so building anything on an account
   that has not paid is refused here rather than in each route.
   The rule is default-deny by method: reading your own account
   is always allowed (an unpaid customer should still see their
   own empty console and the plans), but anything that CREATES
   or CHANGES something needs a live subscription.

   Doing it as one gate in front of /api/me means a new route
   added later is protected the moment it is written. The old
   approach — a status check copied into each handler — leaks
   the first time someone forgets, and a forgotten check is a
   free account.
   ============================================================ */

/* The only writes an unpaid account may make: the ones that help it become
   a paid account, or confirm who it is. */
const BILLING_EXEMPT = new Set(["/resend-verification", "/lang"]);

app.use("/api/me", async (req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD") return next();
  if (BILLING_EXEMPT.has(req.path)) return next();
  const t = await currentTenant(req).catch(() => null);
  if (!t) return res.status(401).json({ error: "no session" });
  /* Staff helping a customer are not stopped by the customer's bill. The
     console still shows that customer's real billing state, so this does
     not hide anything — it just lets support fix a configuration. */
  if (t._impersonated || t.role === "admin") return next();
  const b = billing(t);
  if (b.paid) return next();
  res.status(402).json({
    error: b.state === "suspended"
      ? "This account is paused. Settle the subscription to carry on."
      : "Choose a plan to start building your agent.",
    billing: b, paywall: true,
  });
});

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
     <a href="/login" style="color:#2F6BFF">Log in</a></div></body>`);
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
min-height:100vh;margin:0;text-align:center;padding:2rem}a{color:#2F6BFF}</style></head><body><div>
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
  /* Signing in with Google creates a real, unpaid account — the same as any
     other signup. Only the comp list starts active. */
  const comp = COMP_EMAILS.has(email);
  const ins = await q(
    /* Google has already verified this address, so asking the customer to
       confirm it again would be friction for nothing. */
    `INSERT INTO tenants(name,email,role,plan,cycle,status,consent,oauth_provider,oauth_sub,email_verified,comp,comp_note,activated_at)
     VALUES($1,$2,'customer',$3,$4,$5,$6,$7,$8,true,$9,$10,$11) RETURNING *`,
    [String(name || email.split("@")[0]).slice(0, 120), email, plan, cycle, comp ? "active" : "pending",
     (co && co.consent) || null, provider, sub,
     comp, comp ? "on the house" : null, comp ? new Date() : null]);
  return { tenant: ins.rows[0], created: true };
}

async function finishSocial(res, info) {
  const { tenant, created } = await tenantFromSocial(info);
  clearState(res);
  setSession(res, tenant);
  await track(tenant.id, created ? "signup" : "login", { via: info.provider });
  if (tenant.role === "admin") return res.redirect("/admin");
  res.redirect(await homeFor(tenant));
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
    /* A plan sent straight from the signup form, for buyers who chose there
       rather than arriving from the pricing table. */
    if (["starter", "growth", "enterprise"].includes(req.body.plan)) co.plan = req.body.plan;
    if (["monthly", "annual"].includes(req.body.cycle)) co.cycle = req.body.cycle;
    /* Every new account starts unpaid. The one exception is the comp list —
       the owner's own account and anyone deliberately given NABRA free.
       Note what this does NOT do any more: it no longer activates accounts
       just because card payments happen to be switched off. A real product
       does not hand out full access because its till is unplugged. */
    const comp = COMP_EMAILS.has(email);
    const status = comp ? "active" : "pending";
    let row;
    try {
      row = (await q(
        `INSERT INTO tenants(name,email,pass_hash,plan,cycle,status,consent,comp,comp_note,activated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id,name,email,role,plan,cycle,status,comp`,
        [name, email, hashPw(password), co.plan, co.cycle, status, co.consent,
         comp, comp ? "on the house" : null, comp ? new Date() : null])).rows[0];
    } catch (e) {
      if (String(e.message).includes("duplicate")) return res.status(409).json({ error: "That email already has an account — log in instead." });
      throw e;
    }
    await q(`INSERT INTO events(tenant_id,kind,detail) VALUES($1,'signup',$2)`, [row.id, JSON.stringify(co)]);
    setSession(res, row, req.body.remember !== false);
    /* Sent, not awaited: a slow mail provider should not make signup feel
       broken. If it fails they can resend from inside the app. */
    sendVerification(req, row);

    /* A comped account skips the till entirely and lands in the builder. */
    if (comp) return res.json({ redirect: "/setup" });

    if (cfg("PAYMENTS_MODE") === "paymob") {
      /* Hand the buyer to Paymob's hosted card page; the webhook below
         activates the account when the charge succeeds. */
      const url = await paymobCheckoutUrl(row, co).catch(e => { console.error("paymob:", e.message); return null; });
      if (url) return res.json({ redirect: url });
      /* If Paymob is misconfigured don't strand the buyer — keep them pending and tell you. */
      await q(`INSERT INTO events(tenant_id,kind,detail) VALUES($1,'paymob_error',NULL)`, [row.id]);
    }
    /* Unpaid, so the console — which opens on the plans. Not the marketing
       site: being bounced out to the brochure after signing up is the thing
       that made buying feel impossible. */
    res.json({ redirect: "/app?pay=1" });
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
  /* A lapsed account can still sign in. It lands on its own billing page,
     where it can settle up — locking it out at the door would mean the only
     way back in is email to support. */
  setSession(res, t, req.body.remember !== false);
  if (t.role === "admin") return res.json({ redirect: "/admin" });
  res.json({ redirect: await homeFor(t) });
});

/* Where a customer belongs the moment they sign in. Signing in should never
   land anyone back on the marketing site — they are already a customer, and
   the brochure is not where their work is. */
async function homeFor(t) {
  if (!billing(t).paid) return "/app?pay=1";               // plans first
  const { rows } = await q(`SELECT 1 FROM agents WHERE tenant_id=$1 LIMIT 1`, [t.id]);
  return rows.length ? "/app" : "/setup";                  // build one, or run the ones you have
}

/* ------------------------------------------------------------ the customer console */
app.get("/app", async (req, res) => {
  const t = await currentTenant(req);
  if (!t) return res.redirect("/login");
  if (t.role === "admin" && !t._impersonated) return res.redirect("/admin");
  serveWithBoot(res, FILES.dash, {
    tenant: { id: t.id, name: t.name, email: t.email, plan: t.plan, cycle: t.cycle, status: t.status },
    billing: billing(t), pricing: { plans: PLAN_USD, annualMonthsFree: ANNUAL_MONTHS_FREE, vatPct: 14 },
    lang: t.lang, impersonated: t._impersonated,
  });
});

/* The guided setup a customer walks through after signup: connect a number,
   teach the agent, test it. Same login gate as the console. */
app.get("/setup", async (req, res) => {
  const t = await currentTenant(req);
  if (!t) return res.redirect("/login");
  /* The builder is the product. An account that has not paid is sent to the
     console, which opens on the plans — not to the marketing site, which
     would read as being thrown out of their own account. */
  if (!billing(t).paid && !t._impersonated && t.role !== "admin") return res.redirect("/app?pay=1");
  serveWithBoot(res, FILES.setup, {
    tenant: { id: t.id, name: t.name, email: t.email, plan: t.plan, cycle: t.cycle, status: t.status },
    billing: billing(t), lang: t.lang, impersonated: t._impersonated,
  });
});


/* the dashboard's future data endpoints — wire the demo arrays to these */
app.get("/api/me", async (req, res) => {
  const t = await currentTenant(req);
  if (!t) return res.status(401).json({ error: "no session" });
  res.json({ tenant: t });
});

/* ============================================================
   WHERE LEADS GO
   ------------------------------------------------------------
   Every place a finished call can end up, and whether that
   place is actually switched on for THIS account. Each entry
   reports real state — a saved setting, a real delivery count —
   rather than a promise, so a customer can see at a glance
   where a booking taken at 2am will actually land.
   ============================================================ */
app.get("/api/me/destinations", async (req, res) => {
  const t = await currentTenant(req); if (!t) return res.status(401).json({ error: "no session" });

  const { rows: agents } = await q(
    `SELECT id, name, transfer_to, channel_cfg, business, direction, status FROM agents WHERE tenant_id=$1 ORDER BY id`,
    [t.id]);

  /* what has actually been delivered, not what was configured */
  const { rows: notif } = await q(
    `SELECT channel, status, count(*)::int n FROM notifications WHERE tenant_id=$1 GROUP BY channel, status`, [t.id]);
  const tally = ch => {
    const f = s => (notif.find(x => x.channel === ch && x.status === s) || {}).n || 0;
    return { sent: f("sent"), failed: f("failed"), skipped: f("skipped") };
  };

  const counts = (await q(
    `SELECT (SELECT count(*)::int FROM leads    WHERE tenant_id=$1) AS leads,
            (SELECT count(*)::int FROM bookings WHERE tenant_id=$1) AS bookings,
            (SELECT count(*)::int FROM orders   WHERE tenant_id=$1) AS orders,
            (SELECT count(*)::int FROM calls    WHERE tenant_id=$1) AS calls`, [t.id])).rows[0];

  const waAgents = agents.filter(a => {
    const w = (a.channel_cfg || {}).wa || {};
    return !!(w.phone_number_id && w.template);
  });
  const xferAgents = agents.filter(a => String(a.transfer_to || "").trim());
  const bookAgents = agents.filter(a => (a.business || {}).take_bookings !== false);
  const orderAgents = agents.filter(a => (a.business || {}).take_orders);

  const dest = [
    { key: "dashboard", on: true, kind: "always",
      count: counts.leads + counts.bookings + counts.orders, calls: counts.calls },

    { key: "calendar", on: counts.bookings > 0 || bookAgents.length > 0, kind: "feed",
      url: t.cal_token ? `${siteUrl(req)}/cal/${t.cal_token}.ics` : null, count: counts.bookings },

    { key: "whatsapp", on: waAgents.length > 0, kind: "perAgent",
      agents: waAgents.map(a => a.name), delivered: tally("whatsapp") },

    { key: "email", on: emailOn(), kind: "platform" },

    { key: "transfer", on: xferAgents.length > 0, kind: "perAgent",
      agents: xferAgents.map(a => a.name) },

    { key: "orders", on: orderAgents.length > 0, kind: "perAgent",
      agents: orderAgents.map(a => a.name), count: counts.orders },
  ];

  res.json({ destinations: dest, agents: agents.length });
});

/* ---- what this account still has to do, decided server-side ----
   The console and the setup screen were each working this out on their own,
   which is how two screens start disagreeing about whether an account is
   ready. One answer, computed where the data is. */
app.get("/api/me/next-steps", async (req, res) => {
  const t = await currentTenant(req); if (!t) return res.status(401).json({ error: "no session" });
  const { rows: agents } = await q(`SELECT * FROM agents WHERE tenant_id=$1 ORDER BY id`, [t.id]);
  const a = agents[0] || null;
  const r = a ? readiness(a) : null;
  const miss = k => !!(r && r.outstanding.some(o => o.k === k));

  const calls = (await q(`SELECT count(*)::int n FROM calls WHERE tenant_id=$1`, [t.id])).rows[0].n;
  const prov  = (await q(
    `SELECT status FROM provisioning WHERE tenant_id=$1 ORDER BY id DESC LIMIT 1`, [t.id])).rows[0] || null;

  const steps = [
    { k: "agent",   done: !!a,                                  go: "/setup" },
    { k: "teach",   done: !!a && !miss("knowledge") && !miss("rules") && !miss("greeting"), go: "/setup" },
    { k: "test",    done: !!(a && a.tested_at),                 go: "/setup" },
    { k: "number",  done: !!(a && a.channel_cfg && String(a.channel_cfg.number || "").trim()), go: "/setup" },
    { k: "deploy",  done: !!(a && a.status === "live"),         go: "/setup" },
    { k: "connect", done: !!(prov && prov.status === "done"),   go: null,
      waiting: !!(prov && prov.status !== "done") },
    { k: "first",   done: calls > 0,                            go: null },
  ];
  const done = steps.filter(s => s.done).length;
  res.json({
    steps, done, total: steps.length,
    pct: Math.round(done / steps.length * 100),
    live: !!(a && a.status === "live"),
    plan: t.plan, agentId: a ? a.id : null,
  });
});

app.get("/api/me/calls", async (req, res) => {
  const t = await currentTenant(req);
  if (!t) return res.status(401).json({ error: "no session" });
  /* SELECT * dragged the whole webhook payload — tens of kilobytes per call —
     into the browser for a table that shows five columns. Name the columns, and
     lift the recording link out of the payload rather than shipping all of it. */
  const { rows } = await q(
    `SELECT id, tenant_id, agent_id, setup_id, vapi_call_id, assistant_id, direction,
            from_number, duration_s, outcome, summary, transcript, at,
            COALESCE(payload->>'recordingUrl', payload->'artifact'->>'recordingUrl',
                     payload->'artifact'->>'stereoRecordingUrl') AS recording_url
       FROM calls WHERE tenant_id=$1 ORDER BY at DESC LIMIT 100`, [t.id]);
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
    { k: "channel",   ok: !!(a.channel_cfg && String(a.channel_cfg.number || "").trim()),
                                                                          say: "Add the number your SIP trunk carries" },
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
  /* A SIP trunk on the customer's own number is the only route, so there is
     nothing to choose or guess. Forwarding and the call link were removed:
     forwarding cannot carry outbound on the customer's own number and bills
     them per minute, and a link is not a phone line. */
  d.channel_cfg = { ...(d.channel_cfg || {}), route: "trunk" };
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
  /* A SIP trunk on the customer's own number is the only route now, so every
     deployment queues a line to connect. Agents saved under the old forwarding
     or call-link options are treated as trunks: there is nothing else to be. */
  await q(`INSERT INTO provisioning(tenant_id,kind,detail) VALUES($1,$2,$3)`,
    [t.id, "number_connect",
     `${up[0].name}: SIP trunk on ${(up[0].channel_cfg && up[0].channel_cfg.number) || "number not given"}`]);
  await track(t.id, "deployment_successful", { agent: up[0].id, route: "trunk" });
  res.json({ agent: { ...up[0], readiness: readiness(up[0]) },
             note: "Configuration is live. Your line is queued for connection." });
});

app.post("/api/me/agents/:id/pause", async (req, res) => {
  const t = await currentTenant(req); if (!t) return res.status(401).json({ error: "no session" });
  const { rows } = await q(`UPDATE agents SET status='paused', updated_at=now() WHERE id=$1 AND tenant_id=$2 RETURNING *`,
    [req.params.id, t.id]);
  if (!rows.length) return res.status(404).json({ error: "That agent does not exist on your account." });
  res.json({ agent: { ...rows[0], readiness: readiness(rows[0]) } });
});

/* What deleting this agent would take with it, so the confirm can say so
   rather than asking someone to agree to something unspecified. Calls,
   bookings, orders and leads survive the delete and keep their history; the
   setups and anything still queued to dial do not. */
app.get("/api/me/agents/:id/impact", async (req, res) => {
  const t = await currentTenant(req); if (!t) return res.status(401).json({ error: "no session" });
  const a = await ownedAgent(t.id, req.params.id);
  if (!a) return res.status(404).json({ error: "That agent does not exist on your account." });
  const c = (await q(
    `SELECT (SELECT count(*)::int FROM setups         WHERE agent_id=$1) AS setups,
            (SELECT count(*)::int FROM calls          WHERE agent_id=$1) AS calls,
            (SELECT count(*)::int FROM bookings       WHERE agent_id=$1) AS bookings,
            (SELECT count(*)::int FROM outbound_queue WHERE agent_id=$1 AND status IN ('waiting','calling')) AS queued`,
    [a.id])).rows[0];
  res.json({ name: a.name, live: a.status === "live", ...c });
});

app.delete("/api/me/agents/:id", async (req, res) => {
  const t = await currentTenant(req); if (!t) return res.status(401).json({ error: "no session" });
  const a = await ownedAgent(t.id, req.params.id);
  if (!a) return res.status(404).json({ error: "That agent does not exist on your account." });
  /* A live agent is answering a real phone line. Deleting it from under a
     caller mid-conversation is not something to do on one click, so it has to
     be paused first — which is one button and makes the intent explicit. */
  if (a.status === "live" && String(req.query.force || "") !== "1")
    return res.status(409).json({
      error: "This agent is live. Pause it first, then delete it.", live: true });
  await q(`DELETE FROM agents WHERE id=$1 AND tenant_id=$2`, [a.id, t.id]);
  await q(`INSERT INTO events(tenant_id,kind,detail) VALUES($1,'agent_deleted',$2)`,
    [t.id, JSON.stringify({ agent: a.id, name: a.name })]);
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

/* ============================================================
   SETUPS  (call flows inside one agent, on one number)
   ------------------------------------------------------------
   Ownership is resolved from the session every time. An agent id
   or setup id arriving from the browser is never trusted: it is
   checked against the signed-in tenant before anything is read
   or written, so changing an id in a request reaches nothing.
   ============================================================ */

/* The voice catalogue. Customers pick a NABRA name; the provider and its
   voice id stay here on the server and never reach the browser. */
const VOICES = {
  lina:  { name: "Lina",  note: "Warm, professional",      provider: "11labs", voice_id: process.env.VOICE_LINA  || "" },
  adam:  { name: "Adam",  note: "Confident, direct",       provider: "11labs", voice_id: process.env.VOICE_ADAM  || "" },
  maya:  { name: "Maya",  note: "Friendly, conversational",provider: "11labs", voice_id: process.env.VOICE_MAYA  || "" },
  omar:  { name: "Omar",  note: "Calm, steady",            provider: "11labs", voice_id: process.env.VOICE_OMAR  || "" },
};
app.get("/api/voices", async (req, res) => {
  /* names only: no provider, no ids */
  res.json({ voices: Object.entries(VOICES).map(([key, v]) => ({ key, name: v.name, note: v.note })) });
});

/* ============================================================
   NABRA'S OWN LINE AND ITS ON-SITE ASSISTANT
   ------------------------------------------------------------
   Both answer out of the same sectors, so the number on the site
   and the chat bubble can never tell a visitor two different
   things.

   The Ask widget used to call api.anthropic.com straight from the
   browser, which could only ever fail — and would have put the key
   in every visitor's devtools the moment one was added. It posts
   here instead, and the key stays on the server.
   ============================================================ */

/* what the public site is allowed to know about our own line */
app.get("/api/site/line", async (req, res) => {
  const phone = String(cfg("NABRA_PHONE") || "").trim();
  res.json({ phone, note: String(cfg("NABRA_PHONE_NOTE") || "").trim(), live: !!phone });
});

/* the brief, readable. Public on purpose: it is a tidied copy of what this
   website already says out loud, and it is useful to see what the agent was
   told rather than guessing from its answers. */
app.get("/api/site/brief", async (req, res) => {
  try {
    const { rows } = await q(
      `SELECT key, title, body FROM site_sectors WHERE active = true AND body <> '' ORDER BY sort, id`);
    res.json({ sectors: rows, updated: true });
  } catch (e) { res.status(500).json({ error: "brief unavailable" }); }
});

/* How the assistant is told to behave, wrapped around whatever the sectors say.
   `prices` is what the visitor's own screen is showing, passed up by the page,
   so the assistant quotes the figure in front of them rather than a stale one.
   The no-handoff rule is deliberate and it is the product's whole argument:
   a business should not need a person on every enquiry. The exception for
   something urgent or genuinely uncovered is real, and it is the only one. */
async function askSystem(lang, prices) {
  const brief = await siteBrief();
  const phone = String(cfg("NABRA_PHONE") || "").trim();
  const tongue = { ar: "Modern Standard Arabic", eg: "Egyptian Arabic (Masri)" }[lang] || "English";
  const priceLine = prices
    ? `THE PRICES ON THE VISITOR'S SCREEN RIGHT NOW: ${prices}. Quote these exactly as written. Do not convert them into another currency and do not round them.`
    : `No prices are showing on the page right now. Say they are available on request and offer no figure of your own.`;

  return `You are the assistant on NABRA's own website. NABRA sells an AI phone agent to businesses in Egypt.

Answer in ${tongue} unless the visitor writes in another language, in which case follow them.

THE ONLY THINGS YOU KNOW ARE BELOW. This is the whole of your knowledge about NABRA.

${brief}

${priceLine}

HOW TO ANSWER
Short and specific. Two or three sentences usually. No markdown, no bullet lists, no headings.
Answer the question that was asked. Do not open with a greeting every time and do not end every answer with a question.
If someone says what business they run, say specifically what the agent would do for that business, using only what you know above.
Write plainly. No marketing language and no exclamation marks.

DO NOT OFFER TO PUT ANYONE THROUGH TO A PERSON. This product exists because a business should not need a human on every enquiry, and offering one argues against the thing you are selling. Do not say a salesperson or the team will follow up, and do not ask for a name, a number or an email so somebody can call them back. Setting the agent up is self-service and takes minutes.
Close on whichever of these fits: the live voice demo on this page, which they can talk to immediately; "Create your agent", which takes them to the plans and then into setup; or simply a straight answer to what they asked, if they are still deciding.
THE ONE EXCEPTION, and it is a real one: if the matter is urgent, or it is something you genuinely do not cover, say so honestly and give them the contact address in the page footer so a person can pick it up. That covers a legal question, a billing dispute, a complaint, an account somebody cannot get into, and anything where waiting would actually cost them something. The test is not whether they would prefer a human. It is whether you can answer. If you can, answer.

WHAT YOU MUST NOT DO
Never state anything that is not in the sections above. Inventing a capability, a price, a client, a statistic or a timescale is the worst thing you can do here.
Never describe how the SIP or trunk configuration is done. Say it is shown inside the account after signing up.
Never claim to be a human. You are NABRA's assistant.
Never claim to see their account, their calls or their bookings.
${phone ? `If someone would rather talk than type, our own agent answers on ${phone}. It is the same product this site is about, so it is also the quickest way to hear it.` : ``}`;
}

app.post("/api/site/ask", async (req, res) => {
  const key = cfg("ANTHROPIC_API_KEY");
  if (!key) return res.status(503).json({ error: "assistant not configured" });

  const b = req.body || {};
  const lang = ["en", "ar", "eg"].includes(b.lang) ? b.lang : "en";
  /* Whatever arrives is a stranger's input: cap the turns and the length so a
     visitor cannot run up a bill or push the brief out of the window. */
  const msgs = (Array.isArray(b.messages) ? b.messages : [])
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-12)
    .map(m => ({ role: m.role, content: m.content.slice(0, 2000) }));
  if (!msgs.length || msgs[msgs.length - 1].role !== "user")
    return res.status(400).json({ error: "last message must be from the visitor" });

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: cfg("ASK_MODEL") || "claude-sonnet-4-5",
        max_tokens: 700,
        system: await askSystem(lang, String(b.prices || "").slice(0, 400)),
        messages: msgs,
      }),
    });
    if (!r.ok) {
      console.error("site/ask upstream:", r.status, (await r.text()).slice(0, 300));
      return res.status(502).json({ error: "assistant unavailable" });
    }
    const j = await r.json();
    const text = (j.content || []).map(x => x.type === "text" ? x.text : "").join("").trim();
    if (!text) return res.status(502).json({ error: "assistant unavailable" });
    res.json({ text });
  } catch (e) {
    console.error("site/ask:", e.message);
    res.status(502).json({ error: "assistant unavailable" });
  }
});

/* ---- the sectors, edited from the admin panel ---- */
app.get("/api/admin/sectors", async (req, res) => {
  const a = await requireAdmin(req, res); if (!a) return;
  const { rows } = await q(`SELECT id,key,title,body,sort,active,updated_at FROM site_sectors ORDER BY sort, id`);
  res.json({ sectors: rows, phone: String(cfg("NABRA_PHONE") || ""), note: String(cfg("NABRA_PHONE_NOTE") || "") });
});

app.post("/api/admin/sectors", async (req, res) => {
  const a = await requireAdmin(req, res); if (!a) return;
  const b = req.body || {};
  /* "Ramadan Hours!!" → "ramadan-hours": runs collapse and the ends are
     trimmed, so two titles that only differ in punctuation collide properly
     instead of quietly becoming two sectors saying the same thing. */
  const key = String(b.key || "").trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  const title = String(b.title || "").trim().slice(0, 120);
  if (!title) return res.status(400).json({ error: "a title is required" });
  /* An Arabic title slugs to nothing, which is not a reason to refuse it.
     Give it a key of its own and keep the title the customer-facing part. */
  const id = key || ("sector-" + Date.now().toString(36));
  const { rows } = await q(
    `INSERT INTO site_sectors(key,title,body,sort) VALUES($1,$2,$3,$4)
     ON CONFLICT (key) DO NOTHING RETURNING *`,
    [id, title, String(b.body || "").slice(0, 20000), parseInt(b.sort, 10) || 900]);
  if (!rows[0]) return res.status(409).json({ error: "a sector with that key already exists" });
  res.json({ sector: rows[0] });
});

app.patch("/api/admin/sectors/:id", async (req, res) => {
  const a = await requireAdmin(req, res); if (!a) return;
  const b = req.body || {}, sets = [], vals = [];
  const put = (col, v) => { vals.push(v); sets.push(`${col}=$${vals.length}`); };
  if (b.title != null)  put("title",  String(b.title).trim().slice(0, 120));
  if (b.body != null)   put("body",   String(b.body).slice(0, 20000));
  if (b.sort != null)   put("sort",   parseInt(b.sort, 10) || 0);
  if (b.active != null) put("active", !!b.active);
  if (!sets.length) return res.status(400).json({ error: "nothing to change" });
  sets.push(`updated_at = now()`);
  vals.push(req.params.id);
  const { rows } = await q(`UPDATE site_sectors SET ${sets.join(",")} WHERE id=$${vals.length} RETURNING *`, vals);
  if (!rows[0]) return res.status(404).json({ error: "no such sector" });
  res.json({ sector: rows[0] });
});

app.delete("/api/admin/sectors/:id", async (req, res) => {
  const a = await requireAdmin(req, res); if (!a) return;
  await q(`DELETE FROM site_sectors WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
});

/* Restores any seeded sector that was deleted. It never touches one that is
   still there, so edits are safe. */
app.post("/api/admin/sectors/restore", async (req, res) => {
  const a = await requireAdmin(req, res); if (!a) return;
  const before = (await q(`SELECT count(*)::int n FROM site_sectors`)).rows[0].n;
  await seedSectors();
  const after = (await q(`SELECT count(*)::int n FROM site_sectors`)).rows[0].n;
  res.json({ ok: true, restored: after - before });
});

/* What NABRA's own phone agent is told. Admin-only: it is the prompt, and
   there is no reason for it to be a public endpoint. */
app.get("/api/admin/line-prompt", async (req, res) => {
  const a = await requireAdmin(req, res); if (!a) return;
  res.json({ prompt: await nabraLinePrompt() });
});

/* The prompt behind our own number. Same sectors as the website assistant,
   with the part that only makes sense out loud on a phone call. */
async function nabraLinePrompt() {
  const brief = await siteBrief();
  return `You are the agent that answers NABRA's own phone line. NABRA sells an AI phone agent to businesses in Egypt, and you are an example of the product you are describing. Say so if anyone asks: you are an AI, not a person.

Greet in Egyptian Arabic and switch to English or Modern Standard Arabic the moment the caller does.

WORK OUT WHY THEY ARE CALLING, from what they say, in the first few seconds. There is no press-one menu. A caller usually wants one of these:

SALES — what it costs, whether it would work for their business, how it handles their kind of calls. Answer from what you know, take their name, their business and their number, and say somebody will follow up. Do not quote a price you were not given.
SETTING IT UP — they already have an account and want to know how to connect a number, write the knowledge, or go live. Explain what the steps are in general terms, then tell them the exact configuration is in their account after they sign in. Never read out SIP or trunk settings on this call.
A WALKTHROUGH — they want to be shown the product. Take their name, their number, their business and a time that suits them, and say we will come back to them to confirm it.
SUPPORT — something is not working. Get their name, their number, what they were doing and what happened, and say the team will come back to them.
SOMETHING ELSE — anything the knowledge below does not cover. Say plainly that it is not something you have, take their name and number, and say a person will come back to them.

If they ask for a specific person, or say it is urgent, take their name, number and what it is about and say you will pass it to the team straight away. Do not transfer them mid-call unless you were set up to.

EVERYTHING YOU KNOW ABOUT NABRA IS BELOW. Nothing outside it is yours to say.

${brief}

ON THE PHONE
Keep every answer to a couple of sentences. A caller cannot skim.
Read a number, a price or an email slowly and offer to repeat it.
Never invent a price, a date, a customer name or a feature.
Never claim to see their account.
At the end, read back the name and number you took, and confirm what happens next.`;
}

async function ownedAgent(tenantId, agentId) {
  const { rows } = await q(`SELECT * FROM agents WHERE id=$1 AND tenant_id=$2`, [agentId, tenantId]);
  return rows[0] || null;
}

app.get("/api/me/agents/:id/setups", async (req, res) => {
  const t = await currentTenant(req); if (!t) return res.status(401).json({ error: "no session" });
  const a = await ownedAgent(t.id, req.params.id);
  if (!a) return res.status(404).json({ error: "That agent is not on your account." });
  const { rows } = await q(`SELECT * FROM setups WHERE agent_id=$1 ORDER BY sort, id`, [a.id]);
  res.json({ setups: rows, routing: a.routing || { mode: "hybrid" } });
});

app.post("/api/me/agents/:id/setups", async (req, res) => {
  const t = await currentTenant(req); if (!t) return res.status(401).json({ error: "no session" });
  const a = await ownedAgent(t.id, req.params.id);
  if (!a) return res.status(404).json({ error: "That agent is not on your account." });
  const b = req.body || {};
  const name = String(b.name || "").trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: "Give the setup a name, such as Sales or Reservations." });
  const { rows: n } = await q(`SELECT COALESCE(MAX(sort),-1)+1 AS s FROM setups WHERE agent_id=$1`, [a.id]);
  const { rows } = await q(
    `INSERT INTO setups(tenant_id,agent_id,name,description,greeting,instructions,knowledge,rules,business,voice,transfer_to,intents,dtmf_key,sort)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [t.id, a.id, name, String(b.description||"").slice(0,300), String(b.greeting||"").slice(0,600),
     String(b.instructions||"").slice(0,8000), String(b.knowledge||"").slice(0,20000),
     String(b.rules||"").slice(0,8000), b.business || {},
     VOICES[b.voice_key] ? { key: b.voice_key } : {},
     String(b.transfer_to||"").slice(0,40) || null,
     Array.isArray(b.intents) ? b.intents.map(s=>String(s).slice(0,40)).slice(0,20) : [],
     b.dtmf_key ? String(b.dtmf_key).slice(0,1) : null, n[0].s]);
  res.json({ setup: rows[0] });
});

app.patch("/api/me/setups/:id", async (req, res) => {
  const t = await currentTenant(req); if (!t) return res.status(401).json({ error: "no session" });
  const b = req.body || {};
  const sets = [], vals = [];
  const put = (col, v) => { sets.push(`${col}=$${sets.length + 3}`); vals.push(v); };
  if (b.name != null)         put("name", String(b.name).trim().slice(0,80));
  if (b.description != null)  put("description", String(b.description).slice(0,300));
  if (b.greeting != null)     put("greeting", String(b.greeting).slice(0,600));
  if (b.instructions != null) put("instructions", String(b.instructions).slice(0,8000));
  if (b.knowledge != null)    put("knowledge", String(b.knowledge).slice(0,20000));
  if (b.rules != null)        put("rules", String(b.rules).slice(0,8000));
  if (b.business != null)     put("business", b.business);
  if (b.voice_key != null)    put("voice", VOICES[b.voice_key] ? { key: b.voice_key } : {});
  if (b.transfer_to != null)  put("transfer_to", String(b.transfer_to).slice(0,40) || null);
  if (b.intents != null)      put("intents", Array.isArray(b.intents) ? b.intents.map(s=>String(s).slice(0,40)).slice(0,20) : []);
  if (b.dtmf_key != null)     put("dtmf_key", b.dtmf_key ? String(b.dtmf_key).slice(0,1) : null);
  if (b.active != null)       put("active", !!b.active);
  if (b.sort != null)         put("sort", parseInt(b.sort,10) || 0);
  if (!sets.length) return res.status(400).json({ error: "Nothing to update." });
  sets.push("updated_at=now()");
  const { rows } = await q(`UPDATE setups SET ${sets.join(",")} WHERE id=$1 AND tenant_id=$2 RETURNING *`,
    [req.params.id, t.id, ...vals]);
  if (!rows.length) return res.status(404).json({ error: "That setup is not on your account." });
  res.json({ setup: rows[0] });
});

app.delete("/api/me/setups/:id", async (req, res) => {
  const t = await currentTenant(req); if (!t) return res.status(401).json({ error: "no session" });
  const { rows: cnt } = await q(
    `SELECT COUNT(*)::int AS n FROM setups WHERE agent_id=(SELECT agent_id FROM setups WHERE id=$1 AND tenant_id=$2)`,
    [req.params.id, t.id]);
  if (cnt[0] && cnt[0].n <= 1)
    return res.status(400).json({ error: "An agent needs at least one setup. Rename this one instead of deleting it." });
  const { rowCount } = await q(`DELETE FROM setups WHERE id=$1 AND tenant_id=$2`, [req.params.id, t.id]);
  if (!rowCount) return res.status(404).json({ error: "That setup is not on your account." });
  res.json({ ok: true });
});

/* How this agent decides which flow a caller wants. */
app.patch("/api/me/agents/:id/routing", async (req, res) => {
  const t = await currentTenant(req); if (!t) return res.status(401).json({ error: "no session" });
  const a = await ownedAgent(t.id, req.params.id);
  if (!a) return res.status(404).json({ error: "That agent is not on your account." });
  const b = req.body || {};
  const modes = ["ai", "dtmf", "hybrid"];
  if (b.mode && !modes.includes(b.mode)) return res.status(400).json({ error: "Unknown routing mode." });
  const routing = Object.assign({ mode: "hybrid" }, a.routing || {}, 
    b.mode ? { mode: b.mode } : {}, b.menu_greeting != null ? { menu_greeting: String(b.menu_greeting).slice(0,600) } : {});
  const { rows } = await q(`UPDATE agents SET routing=$3, updated_at=now() WHERE id=$1 AND tenant_id=$2 RETURNING routing`,
    [a.id, t.id, routing]);
  res.json({ routing: rows[0].routing });
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
  res.json({ bookings: rows,
             calendarUrl: t.cal_token ? `${siteUrl(req)}/cal/${t.cal_token}.ics` : null });
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
  const { rows } = await q(`SELECT id,name,email,plan,cycle,status,lang,vapi_assistant_ids,minutes_used,created_at,
                                   comp,comp_note,activated_at,email_verified
                            FROM tenants WHERE role='customer' ORDER BY created_at DESC`);
  res.json({ tenants: rows });
});
app.post("/api/admin/tenants/:id/status", async (req, res) => {
  const a = await requireAdmin(req, res); if (!a) return;
  const { status } = req.body || {};
  if (!["active", "suspended", "pending"].includes(status)) return res.status(400).json({ error: "bad status" });
  await q(`UPDATE tenants SET status=$1,
                  activated_at = CASE WHEN $1='active' THEN COALESCE(activated_at, now()) ELSE activated_at END
            WHERE id=$2 AND role='customer'`, [status, req.params.id]);
  /* Suspending has to actually stop the service, or a lapsed account keeps
     answering calls on your Vapi bill. Paused, not deleted: paying up and
     pressing deploy brings everything back exactly as it was. */
  if (status === "suspended")
    await q(`UPDATE agents SET status='paused' WHERE tenant_id=$1 AND status='live'`, [req.params.id]);
  await q(`INSERT INTO events(tenant_id,kind,detail) VALUES($1,'status_change',$2)`, [req.params.id, JSON.stringify({ by: a.email, status })]);
  res.json({ ok: true });
});
/* Give an account NABRA on the house, or take that away again. Separate
   from status on purpose: comping is a commercial decision you make, not a
   payment state the till reports. */
app.post("/api/admin/tenants/:id/comp", async (req, res) => {
  const a = await requireAdmin(req, res); if (!a) return;
  const on = req.body.comp !== false;
  const note = String(req.body.note || (on ? "on the house" : "")).slice(0, 200);
  /* Taking the comp away puts them back at the till. Leaving them 'active'
     would mean an account you stopped comping keeps full access for free,
     which is the hole the comp flag exists to avoid. A real payment flips
     them back to active through the webhook. */
  await q(`UPDATE tenants SET comp=$1, comp_note=$2,
                  status = CASE WHEN $1 THEN 'active'
                                WHEN status='active' THEN 'pending' ELSE status END,
                  activated_at = CASE WHEN $1 THEN COALESCE(activated_at, now()) ELSE activated_at END
            WHERE id=$3 AND role='customer'`, [on, note || null, req.params.id]);
  await q(`INSERT INTO events(tenant_id,kind,detail) VALUES($1,'comp_change',$2)`,
    [req.params.id, JSON.stringify({ by: a.email, comp: on, note })]);
  res.json({ ok: true });
});

/* Push the cost guards onto a Vapi assistant. Silent no-op without an API key,
   so nothing breaks if you haven't set one yet — but then the caps are NOT in
   force and a stuck call bills until the caller's carrier drops it. */
async function applyCallLimits(assistantId) {
  if (!cfg("VAPI_API_KEY") || !assistantId) return { skipped: true };
  const r = await fetch(`${cfg("VAPI_BASE")}/assistant/${assistantId}`, {
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


/* ============================================================
   OUTBOUND — PLACING THE CALLS
   ------------------------------------------------------------
   Inbound works because Vapi rings our webhook. Outbound is the
   other way round: something here has to ask Vapi to dial, and
   this is that something.

   An agent can dial when all of these are true, and the queue
   screen says plainly which one is missing:
     · it is live and its direction is outbound
     · it has a Vapi assistant id (the agent itself)
     · it has a Vapi phone number id (the trunk, set by us)
     · outbound is not paused, and the clock is inside its window

   Everything is per agent, so one customer's campaign can never
   consume another's concurrency.
   ============================================================ */

const DIAL = {
  tickMs:        20_000,   /* how often we look for work */
  stuckMin:      30,       /* a 'calling' row with no webhook this long is unstuck */
  backoffMin:    20,       /* wait this long before a second attempt */
  maxPerTick:    10,       /* ceiling per agent per tick, so one agent cannot hog a tick */
};

/* Cairo wall-clock, because a calling window means the hours where the person
   being rung actually lives, not wherever this container happens to run. */
function cairoNow() {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Cairo", hour12: false,
    weekday: "short", hour: "2-digit", minute: "2-digit",
  });
  const p = Object.fromEntries(f.formatToParts(new Date()).map(x => [x.type, x.value]));
  const days = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { day: days[p.weekday], mins: Number(p.hour) * 60 + Number(p.minute) };
}

const hhmm = s => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "").trim());
  return m ? Math.min(1439, Number(m[1]) * 60 + Number(m[2])) : null;
};

/* Is this agent allowed to dial right now? Returns a reason when it is not, so
   the dashboard can say why instead of showing a queue that silently does
   nothing. */
function dialWindow(ob) {
  const o = ob || {};
  if (o.paused !== false) return { ok: false, why: "Outbound is paused." };
  const from = hhmm(o.from) ?? 600, to = hhmm(o.to) ?? 1080;
  const days = Array.isArray(o.days) && o.days.length ? o.days : [0, 1, 2, 3, 4, 6];
  const now = cairoNow();
  if (!days.includes(now.day)) return { ok: false, why: "Not a calling day." };
  const inside = from <= to ? (now.mins >= from && now.mins < to)
                            : (now.mins >= from || now.mins < to);   /* a window over midnight */
  if (!inside) return { ok: false, why: `Outside the calling window (${o.from || "10:00"}–${o.to || "18:00"} Cairo time).` };
  return { ok: true };
}

/* Everything that would stop this agent dialling, in the order a customer
   would fix them. Used by the runner and by the queue screen, so the two can
   never disagree about why nothing is happening. */
function dialBlockers(agent) {
  const out = [];
  if (!cfg("VAPI_API_KEY"))          out.push("The platform is not connected to Vapi yet.");
  if (agent.direction !== "outbound") out.push("This agent is set to answer calls, not make them.");
  if (agent.status !== "live")        out.push("The agent is not deployed.");
  if (!agent.vapi_assistant_id)       out.push("The agent has no voice assistant yet.");
  if (!agent.vapi_phone_number_id)    out.push("Your line is not connected yet, so there is no number to call from.");
  if (!String(agent.script || "").trim()) out.push("There is no outbound script.");
  const w = dialWindow(agent.outbound);
  if (!w.ok) out.push(w.why);
  return out;
}

/* Ask Vapi to place one call. Returns its call id, or throws with something a
   human can read. */
async function vapiDial({ assistantId, phoneNumberId, to, row, agent }) {
  const r = await fetch(`${cfg("VAPI_BASE")}/call`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg("VAPI_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      assistantId,
      phoneNumberId,
      customer: { number: to, name: row.name || undefined },
      /* read back in the webhook, so the finished call lands on the right row
         without us having to match on phone numbers */
      metadata: { nabra_queue_id: row.id, nabra_tenant_id: row.tenant_id, nabra_agent_id: row.agent_id },
      /* anything the customer wrote about this person, given to the agent for
         this call only. The script itself lives on the assistant. */
      assistantOverrides: row.note
        ? { variableValues: { lead_name: row.name || "", lead_note: row.note } }
        : { variableValues: { lead_name: row.name || "" } },
    }),
  });
  const text = await r.text();
  if (!r.ok) {
    let why = text.slice(0, 300);
    try { const j = JSON.parse(text); why = (Array.isArray(j.message) ? j.message.join("; ") : j.message) || why; } catch (_) {}
    throw new Error(`Vapi refused the call (${r.status}): ${why}`);
  }
  let j = {}; try { j = JSON.parse(text); } catch (_) {}
  return j.id || null;
}

/* One pass over one agent's queue. */
async function dialAgent(agent) {
  if (dialBlockers(agent).length) return 0;
  const ob = agent.outbound || {};
  const concurrency = Math.max(1, Math.min(10, Number(ob.concurrency) || 1));

  const { rows: busy } = await q(
    `SELECT count(*)::int n FROM outbound_queue WHERE agent_id=$1 AND status='calling'`, [agent.id]);
  const room = Math.min(concurrency - busy[0].n, DIAL.maxPerTick);
  if (room <= 0) return 0;

  /* Claim the rows and mark them 'calling' in the same transaction. SKIP LOCKED
     means a second gateway instance takes different rows rather than waiting,
     and never the same person twice. */
  const c = await pool.connect();
  let claimed = [];
  try {
    await c.query("BEGIN");
    const { rows } = await c.query(
      `SELECT * FROM outbound_queue
        WHERE agent_id=$1 AND status='waiting' AND (not_before IS NULL OR not_before <= now())
        ORDER BY id
        LIMIT $2
        FOR UPDATE SKIP LOCKED`, [agent.id, room]);
    if (rows.length) {
      await c.query(`UPDATE outbound_queue SET status='calling', attempts=attempts+1,
                            dialled_at=now(), updated_at=now()
                      WHERE id = ANY($1)`, [rows.map(r => r.id)]);
      claimed = rows;
    }
    await c.query("COMMIT");
  } catch (e) {
    try { await c.query("ROLLBACK"); } catch (_) {}
    console.error("[outbound] claim failed:", e.message);
    return 0;
  } finally { c.release(); }

  let placed = 0;
  for (const row of claimed) {
    try {
      const callId = await vapiDial({
        assistantId: agent.vapi_assistant_id,
        phoneNumberId: agent.vapi_phone_number_id,
        to: row.phone, row, agent,
      });
      await q(`UPDATE outbound_queue SET vapi_call_id=$1, last_error=NULL, updated_at=now() WHERE id=$2`,
        [callId, row.id]);
      placed++;
    } catch (e) {
      const maxA = Math.max(1, Number(ob.max_attempts) || 2);
      const done = row.attempts + 1 >= maxA;
      await q(`UPDATE outbound_queue
                  SET status=$1, last_error=$2, not_before=$3, updated_at=now(),
                      finished_at = CASE WHEN $1='failed' THEN now() ELSE finished_at END
                WHERE id=$4`,
        [done ? "failed" : "waiting", String(e.message).slice(0, 400),
         done ? null : new Date(Date.now() + DIAL.backoffMin * 60_000), row.id]);
      console.error(`[outbound] row ${row.id}:`, e.message);
    }
  }
  return placed;
}

/* Rows that were dialled but whose call never reported back. Without this they
   would hold a concurrency slot for ever and the queue would quietly stall. */
async function unstickOutbound() {
  const { rows } = await q(
    `UPDATE outbound_queue
        SET status = CASE WHEN attempts >= 2 THEN 'failed' ELSE 'waiting' END,
            last_error = 'No result came back from the call, so it was released.',
            not_before = now() + interval '10 minutes',
            updated_at = now()
      WHERE status='calling' AND dialled_at < now() - ($1 || ' minutes')::interval
      RETURNING id`, [String(DIAL.stuckMin)]);
  if (rows.length) console.warn(`[outbound] released ${rows.length} stuck row(s)`);
}

let dialTimer = null, dialling = false;
async function dialTick() {
  if (dialling) return;                 /* a slow tick must not overlap the next */
  dialling = true;
  try {
    await unstickOutbound();
    if (!cfg("VAPI_API_KEY")) return;
    const { rows: agents } = await q(
      `SELECT a.* FROM agents a
         JOIN tenants t ON t.id = a.tenant_id
        WHERE a.direction='outbound' AND a.status='live'
          AND a.vapi_assistant_id IS NOT NULL AND a.vapi_phone_number_id IS NOT NULL
          AND t.status='active'
          AND EXISTS (SELECT 1 FROM outbound_queue o
                       WHERE o.agent_id=a.id AND o.status='waiting'
                         AND (o.not_before IS NULL OR o.not_before <= now()))`);
    for (const a of agents) {
      try { await dialAgent(a); }
      catch (e) { console.error(`[outbound] agent ${a.id}:`, e.message); }
    }
  } catch (e) {
    console.error("[outbound] tick:", e.message);
  } finally { dialling = false; }
}

function startDialler() {
  if (dialTimer) return;
  dialTimer = setInterval(dialTick, DIAL.tickMs);
  if (dialTimer.unref) dialTimer.unref();
  console.log(`outbound dialler running every ${DIAL.tickMs / 1000}s`);
}

/* ---- the customer's view of their queue ---- */

/* "Mona, +20 100 123 4567, called last week" — one person per line, in
   whatever order the columns happen to be, because asking a restaurant owner
   to produce a correctly ordered CSV is asking them not to bother. */
function parsePeople(text) {
  const out = [], seen = new Set();
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/[,;\t]/).map(x => x.trim()).filter(Boolean);
    if (!parts.length) continue;
    /* the phone is whichever field looks like a phone */
    let pi = parts.findIndex(x => /^[+()\d][\d\s()+-]{6,}$/.test(x));
    if (pi < 0) continue;                                   /* no number, nothing to dial */
    const phone = parts[pi].replace(/[^\d+]/g, "");
    if (phone.replace(/\D/g, "").length < 7) continue;
    const rest = parts.filter((_, i) => i !== pi);
    const key = phone;
    if (seen.has(key)) continue;                            /* the same person twice in one paste */
    seen.add(key);
    out.push({ name: (rest[0] || "").slice(0, 120), phone: phone.slice(0, 32), note: rest.slice(1).join(", ").slice(0, 400) });
  }
  return out;
}

app.get("/api/me/agents/:id/outbound", async (req, res) => {
  const t = await currentTenant(req); if (!t) return res.status(401).json({ error: "no session" });
  const a = await ownedAgent(t.id, req.params.id);
  if (!a) return res.status(404).json({ error: "That agent does not exist on your account." });
  const { rows: counts } = await q(
    `SELECT status, count(*)::int n FROM outbound_queue WHERE agent_id=$1 GROUP BY status`, [a.id]);
  const { rows: list } = await q(
    `SELECT id,name,phone,note,status,attempts,outcome,summary,last_error,dialled_at,finished_at,created_at
       FROM outbound_queue WHERE agent_id=$1 ORDER BY
         CASE status WHEN 'calling' THEN 0 WHEN 'waiting' THEN 1 ELSE 2 END, id DESC
      LIMIT 300`, [a.id]);
  res.json({
    queue: list,
    counts: Object.fromEntries(counts.map(c => [c.status, c.n])),
    settings: a.outbound || {},
    /* why nothing is dialling, if nothing is dialling */
    blockers: dialBlockers(a),
    direction: a.direction,
  });
});

app.post("/api/me/agents/:id/outbound", async (req, res) => {
  const t = await currentTenant(req); if (!t) return res.status(401).json({ error: "no session" });
  const a = await ownedAgent(t.id, req.params.id);
  if (!a) return res.status(404).json({ error: "That agent does not exist on your account." });
  const b = req.body || {};
  const people = Array.isArray(b.people)
    ? b.people.map(p => ({ name: String(p.name || "").slice(0, 120),
                           phone: String(p.phone || "").replace(/[^\d+]/g, "").slice(0, 32),
                           note: String(p.note || "").slice(0, 400) }))
               .filter(p => p.phone.replace(/\D/g, "").length >= 7)
    : parsePeople(b.text);
  if (!people.length)
    return res.status(400).json({ error: "No phone numbers were found in that. One person per line, with the number anywhere on the line." });
  if (people.length > 2000)
    return res.status(400).json({ error: "That is more than 2,000 people in one go. Split it up." });

  /* Somebody already waiting is not queued twice, so pasting the same list
     again adds only what is new rather than ringing everyone a second time. */
  const { rows } = await q(
    `INSERT INTO outbound_queue(tenant_id,agent_id,name,phone,note)
     SELECT $1,$2,x.name,x.phone,x.note
       FROM jsonb_to_recordset($3::jsonb) AS x(name text, phone text, note text)
      WHERE NOT EXISTS (
        SELECT 1 FROM outbound_queue o
         WHERE o.agent_id=$2 AND o.phone=x.phone AND o.status IN ('waiting','calling'))
     RETURNING id`,
    [t.id, a.id, JSON.stringify(people)]);
  res.json({ added: rows.length, seen: people.length, skipped: people.length - rows.length });
});

app.patch("/api/me/agents/:id/outbound", async (req, res) => {
  const t = await currentTenant(req); if (!t) return res.status(401).json({ error: "no session" });
  const a = await ownedAgent(t.id, req.params.id);
  if (!a) return res.status(404).json({ error: "That agent does not exist on your account." });
  const b = req.body || {}, cur = a.outbound || {};
  const next = { ...cur };
  if (b.paused != null)      next.paused = !!b.paused;
  if (b.from && hhmm(b.from)!=null) next.from = b.from;
  if (b.to   && hhmm(b.to)!=null)   next.to   = b.to;
  if (Array.isArray(b.days)) next.days = b.days.map(Number).filter(d => d >= 0 && d <= 6);
  if (b.concurrency != null) next.concurrency  = Math.max(1, Math.min(10, parseInt(b.concurrency, 10) || 1));
  if (b.max_attempts != null)next.max_attempts = Math.max(1, Math.min(5,  parseInt(b.max_attempts, 10) || 2));
  const { rows } = await q(`UPDATE agents SET outbound=$1, updated_at=now() WHERE id=$2 RETURNING *`,
    [JSON.stringify(next), a.id]);
  res.json({ settings: rows[0].outbound, blockers: dialBlockers(rows[0]) });
});

app.post("/api/me/outbound/:rowId/cancel", async (req, res) => {
  const t = await currentTenant(req); if (!t) return res.status(401).json({ error: "no session" });
  const { rows } = await q(
    `UPDATE outbound_queue SET status='cancelled', finished_at=now(), updated_at=now()
      WHERE id=$1 AND tenant_id=$2 AND status='waiting' RETURNING id`, [req.params.rowId, t.id]);
  if (!rows.length) return res.status(404).json({ error: "Nothing waiting with that id. A call already placed cannot be unmade." });
  res.json({ ok: true });
});

app.post("/api/me/agents/:id/outbound/clear", async (req, res) => {
  const t = await currentTenant(req); if (!t) return res.status(401).json({ error: "no session" });
  const a = await ownedAgent(t.id, req.params.id);
  if (!a) return res.status(404).json({ error: "That agent does not exist on your account." });
  /* only what has not been dialled: a call that happened stays on the record */
  const { rows } = await q(
    `UPDATE outbound_queue SET status='cancelled', finished_at=now(), updated_at=now()
      WHERE agent_id=$1 AND status='waiting' RETURNING id`, [a.id]);
  res.json({ cancelled: rows.length });
});

/* ---- the one thing only we can set: which Vapi number the agent dials from ---- */
app.post("/api/admin/agents/:id/phone-number", async (req, res) => {
  const adm = await requireAdmin(req, res); if (!adm) return;
  const id = String((req.body || {}).vapi_phone_number_id || "").trim();
  const { rows } = await q(`UPDATE agents SET vapi_phone_number_id=$1, updated_at=now() WHERE id=$2 RETURNING id, name, tenant_id`,
    [id || null, req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "no such agent" });
  await q(`INSERT INTO events(tenant_id,kind,detail) VALUES($1,'outbound_number_set',$2)`,
    [rows[0].tenant_id, JSON.stringify({ by: adm.email, agent: rows[0].id, set: !!id })]);
  res.json({ ok: true, agent: rows[0], set: !!id });
});

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

    /* A call we placed ourselves carries its queue row id. That row already
       records whose campaign it was, so it answers the ownership question even
       when the tenant's assistant list has drifted. We read the tenant from
       OUR row rather than from the webhook body: the body is remote input, and
       the row is not forgeable. */
    const qid = Number((call.metadata && call.metadata.nabra_queue_id) || 0);
    const { rows: qr } = qid
      ? await q(`SELECT * FROM outbound_queue WHERE id=$1`, [qid])
      : { rows: [] };
    const qrow = qr[0] || null;

    const tenantId = rows.length ? rows[0].id : (qrow ? qrow.tenant_id : null);
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
      const { rows: ar } = await q(`SELECT * FROM agents WHERE tenant_id=$1 AND vapi_assistant_id=$2`, [tenantId, assistantId]);
      agentRow = ar[0] || null;
    }
    /* A call we placed knows its agent outright, which also covers the case
       where two agents share one assistant id. */
    if (!agentRow && qrow) {
      const { rows: ar } = await q(`SELECT * FROM agents WHERE id=$1`, [qrow.agent_id]);
      agentRow = ar[0] || null;
    }
    if (agentRow) await q(`UPDATE calls SET agent_id=$1 WHERE vapi_call_id=$2`, [agentRow.id, call.id || null]);
    /* If this call was one we placed, close its queue row. The id travels on
       the call's own metadata, so there is no guessing from phone numbers and
       no chance of crediting the result to the wrong person. */
    if (qrow) {
      {
        const { rows: cr } = await q(`SELECT id FROM calls WHERE vapi_call_id=$1`, [call.id || null]);
        const outcome = msg.endedReason || (msg.analysis && msg.analysis.successEvaluation) || null;
        /* Vapi reports why it ended; some reasons mean nobody was reached, and
           those are worth another go rather than being written off as done. */
        const unreached = /no-answer|busy|voicemail|customer-did-not-answer|failed|rejected/i.test(String(msg.endedReason || ""));
        const maxA = Math.max(1, Number(((agentRow && agentRow.outbound) || {}).max_attempts) || 2);
        const retry = unreached && qrow.attempts < maxA;
        await q(`UPDATE outbound_queue
                    SET status=$1, outcome=$2, summary=$3, call_id=$4,
                        not_before=$5, finished_at=$6, updated_at=now()
                  WHERE id=$7`,
          [retry ? "waiting" : "done",
           outcome, msg.summary || (msg.analysis && msg.analysis.summary) || null,
           cr.length ? cr[0].id : null,
           retry ? new Date(Date.now() + (Number(((agentRow && agentRow.outbound) || {}).gap_min) || 45) * 60_000) : null,
           retry ? null : new Date(), qid]);
      }
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

      /* Which flow handled this call. Vapi can report it as structured data or
         as its own assistant id when a setup eventually has one of its own;
         otherwise fall back to the agent's first active setup, which is the
         correct answer for every single-flow agent. */
      let setupId = null;
      if (agentRow) {
        const want = (sd && (sd.setup || sd.department || sd.flow)) || null;
        const { rows: su } = await q(
          `SELECT id, name, vapi_assistant_id FROM setups WHERE agent_id=$1 AND active ORDER BY sort, id`,
          [agentRow.id]);
        if (su.length) {
          const byAssistant = su.find(s => s.vapi_assistant_id && s.vapi_assistant_id === assistantId);
          const byName = want ? su.find(s => s.name.toLowerCase() === String(want).toLowerCase()) : null;
          setupId = (byAssistant || byName || su[0]).id;
        }
      }

      if (setupId && call.id) {
        await q(`UPDATE calls SET setup_id=$2, agent_id=COALESCE(agent_id,$3) WHERE vapi_call_id=$1`,
          [call.id, setupId, agentRow ? agentRow.id : null]).catch(() => {});
      }

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

/* ============================================================
   BILLING
   ------------------------------------------------------------
   What this account owes, and the one button that fixes it.
   Prices come back as the single figure the customer will be
   charged. How that figure is reached from the USD list is not
   in the response — that is a commercial matter, not something
   a buyer needs, and anything in a response is public.
   ============================================================ */
app.get("/api/billing", async (req, res) => {
  const t = await currentTenant(req);
  if (!t) return res.status(401).json({ error: "no session" });
  const b = billing(t);
  /* Each plan with its real monthly and yearly price in the currency the
     card will actually be charged in. If FX is unreachable the USD figure
     still goes out, so the plans never render blank. */
  const plans = {};
  for (const k of Object.keys(PLAN_USD)) {
    const row = { usd: PLAN_USD[k], usdAnnual: planUSD(k, "annual") };
    try {
      row.egp = Math.round((await fxConvertUSD(PLAN_USD[k])).egp);
      row.egpAnnual = Math.round((await fxConvertUSD(planUSD(k, "annual"))).egp);
    } catch { /* leave the EGP figures off rather than guess at them */ }
    plans[k] = row;
  }
  res.json({ ...b, plans, annualMonthsFree: ANNUAL_MONTHS_FREE, vatPct: 14,
             verified: !!t.email_verified });
});

/* Start a payment. Returns the hosted card page to send the buyer to. */
app.post("/api/billing/checkout", async (req, res) => {
  const t = await currentTenant(req);
  if (!t) return res.status(401).json({ error: "no session" });
  const b = billing(t);
  if (b.comp) return res.status(400).json({ error: "This account does not get billed." });
  const co = {
    plan: ["starter", "growth", "enterprise"].includes(req.body.plan) ? req.body.plan : t.plan,
    cycle: ["monthly", "annual"].includes(req.body.cycle) ? req.body.cycle : t.cycle,
  };
  /* Remember what they picked even if the card page fails to open, so the
     choice is not lost and support can see what they were trying to buy. */
  await q(`UPDATE tenants SET plan=$1, cycle=$2 WHERE id=$3`, [co.plan, co.cycle, t.id]);
  if (cfg("PAYMENTS_MODE") !== "paymob")
    return res.status(503).json({
      error: "Card payments are not switched on yet. Your plan is saved — we will email you the moment you can pay.",
      saved: co });
  try {
    const url = await paymobCheckoutUrl(t, co);
    await q(`INSERT INTO events(tenant_id,kind,detail) VALUES($1,'checkout_started',$2)`, [t.id, JSON.stringify(co)]);
    res.json({ redirect: url });
  } catch (e) {
    console.error("paymob:", e.message);
    await q(`INSERT INTO events(tenant_id,kind,detail) VALUES($1,'paymob_error',NULL)`, [t.id]);
    res.status(502).json({ error: "The card page would not open. Try again in a moment." });
  }
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
        await q(`UPDATE tenants SET status='active', activated_at=COALESCE(activated_at,now()) WHERE id=$1`, [rows[0].id]);
        await q(`INSERT INTO events(tenant_id,kind,detail) VALUES($1,'payment_success',$2)`,
          [rows[0].id, JSON.stringify({ order: obj.order.id, amount_cents: obj.amount_cents })]);
      }
    }
  } catch (e) { console.error("pay webhook:", e.message); }
  res.json({ ok: true });
});

/* ------------------------------------------------------------ FX proxy */
/* The FX engine knows the Central Bank rate, our margin on top, the live
   buffered rate and how far the billing rate has drifted from it. The public
   site needs exactly one of those — the rate we bill at — and the rest is our
   commercial position. Anyone can read a network response, so the proxy drops
   the internals here rather than trusting the page not to display them.
   An admin asking gets the full picture. */
const FX_PUBLIC = ["date", "billingRate", "stale"];
app.get("/api/fx/:what(current|convert|history)", async (req, res) => {
  try {
    const u = new URL("/api/fx/" + req.params.what, cfg("FX_SERVICE_URL"));
    for (const [k, v] of Object.entries(req.query)) u.searchParams.set(k, v);
    const r = await fetch(u);
    const body = await r.json();
    const t = await currentTenant(req).catch(() => null);
    if (r.ok && req.params.what === "current" && !(t && t.role === "admin")) {
      const slim = {};
      for (const k of FX_PUBLIC) if (body[k] !== undefined) slim[k] = body[k];
      return res.status(r.status).json(slim);
    }
    res.status(r.status).json(body);
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
  /* The plans, on the signup page itself. They used to be one line of text
     with a "Change" link back to /#plans, which threw a buyer out of signup
     and onto the marketing site to make the single decision signup exists
     for. Now they choose here, and never leave. */
  const picked = (co && co.plan) || "growth";
  const cycle  = (co && co.cycle) || "monthly";
  const months = 12 - ANNUAL_MONTHS_FREE;
  const BLURB = {
    starter:    "One agent, one number",
    growth:     "Several agents, numbers and setups",
    enterprise: "Your own cloned voice, unlimited numbers",
  };
  const planPick = !isUp ? "" : `
<div class="picker">
  <div class="cyc" role="group" aria-label="Billing period">
    <button type="button" data-cyc="monthly" aria-pressed="${cycle !== "annual"}">Monthly</button>
    <button type="button" data-cyc="annual" aria-pressed="${cycle === "annual"}">Yearly <i>${12 - months} months free</i></button>
  </div>
  ${["starter", "growth", "enterprise"].map(k => `
  <button type="button" class="pk${k === picked ? " on" : ""}" data-plan="${k}" aria-pressed="${k === picked}">
    <span class="pk-l"><b>${k[0].toUpperCase() + k.slice(1)}</b><em>${BLURB[k]}</em></span>
    <span class="pk-p" data-m="${PLAN_USD[k]}" data-y="${PLAN_USD[k] * months}">$${PLAN_USD[k]}<small>/mo</small></span>
  </button>`).join("")}
  <p class="fine">Card required · cancel any time · charged in EGP</p>
</div>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${isUp ? "Create your account" : "Log in"} — NABRA</title>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:ital,wght@0,400;0,500;0,600;0,700;0,800&family=Chivo+Mono:wght@400&display=swap" rel="stylesheet">
<style>
:root{--bone:#EEF2F9;--fg:#163466;--mute:#4A5F86;--rule:rgba(22,52,102,.12);--ember:#2F6BFF}
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
.card{max-width:430px}
.picker{margin:0 0 .4rem}
.cyc{display:inline-flex;gap:3px;padding:3px;background:var(--bone);border-radius:9px;margin-bottom:.7rem;flex-wrap:wrap}
/* The page-wide button rule is a full-width pill with a big top margin:
   right for the submit button, wrong for every control in the picker. */
.cyc button{display:inline-flex;align-items:center;gap:.35rem;border:0;background:transparent;color:var(--mute);
  font:inherit;font-size:.8rem;padding:.35rem .7rem;border-radius:7px;cursor:pointer;width:auto;margin:0}
.cyc button[aria-pressed="true"]{background:#fff;color:var(--fg);box-shadow:0 1px 3px rgba(22,52,102,.1)}
.cyc i{font-style:normal;font-size:.62rem;color:var(--ember)}
.pk{display:flex;align-items:center;justify-content:space-between;gap:.8rem;width:100%;margin:0 0 .4rem !important;padding:.7rem .85rem;
  border:1px solid var(--rule);border-radius:11px;background:#fff;color:var(--fg);font:inherit;text-align:start;cursor:pointer}
.pk:hover{border-color:var(--mute)}
.pk.on{border-color:var(--ember);box-shadow:0 0 0 1px var(--ember);background:rgba(47,107,255,.05)}
.pk-l{display:flex;flex-direction:column;gap:.1rem;min-width:0}
.pk-l b{font-size:.95rem;font-weight:600}
.pk-l em{font-style:normal;font-size:.76rem;color:var(--mute)}
.pk-p{font-size:1.15rem;font-weight:650;white-space:nowrap}
.pk-p small{font-size:.66rem;font-weight:400;color:var(--mute)}
.fine{font-size:.72rem;color:var(--mute);margin:.5rem 0 0}
/* Likewise the label rule, which is small-caps mono for field names. This
   is a sentence the customer reads, not a field name. */
.rem{display:flex;align-items:center;gap:.5rem;margin:1.1rem 0 0;cursor:pointer;
  font-family:'Plus Jakarta Sans',sans-serif;font-size:.84rem;letter-spacing:0;text-transform:none;color:var(--mute)}
.rem input{width:15px;height:15px;flex:none;margin:0;accent-color:var(--ember)}
.alt{font-size:.8rem;color:var(--mute);margin-top:1.2rem;text-align:center}.alt a{color:var(--fg)}
</style></head><body><div class="card">
<div class="brand">نبرة NABRA <i></i></div>
<h1>${isUp ? "Create your account" : "Welcome back"}</h1>
${planPick}
${socialBlock(isUp, tok)}
${isUp ? `<label>Business name</label><input id="n" autocomplete="organization">` : ""}
<label>Email</label><input id="e" type="email" autocomplete="email">
<label>Password</label><input id="p" type="password" autocomplete="${isUp ? "new-password" : "current-password"}" minlength="8">
<label class="rem"><input type="checkbox" id="rem" checked> Keep me signed in</label>
<button id="go">${isUp ? "Create account →" : "Log in →"}</button>
<p class="err" id="err"></p>
<p class="alt">${isUp ? `Already with us? <a href="/login">Log in</a>` : `New here? <a href="/signup">Create an account</a>`}</p>
</div><script>
var PICK=${JSON.stringify(picked)}, CYC=${JSON.stringify(cycle)};
${isUp ? `
/* The picker. Prices are swapped rather than re-fetched, so the figures can
   never disagree with the ones the page was served with. */
var MONTHS=${months};
function paint(){
  document.querySelectorAll("[data-plan]").forEach(function(b){
    var on=b.dataset.plan===PICK;
    b.classList.toggle("on",on); b.setAttribute("aria-pressed",String(on));
    var p=b.querySelector(".pk-p"), y=CYC==="annual";
    p.innerHTML = "$"+Math.round((y?+p.dataset.y/12:+p.dataset.m))+"<small>/mo"+(y?", billed yearly":"")+"</small>";
  });
  document.querySelectorAll("[data-cyc]").forEach(function(b){ b.setAttribute("aria-pressed",String(b.dataset.cyc===CYC)); });
}
document.querySelectorAll("[data-plan]").forEach(function(b){ b.addEventListener("click",function(){ PICK=b.dataset.plan; paint(); }); });
document.querySelectorAll("[data-cyc]").forEach(function(b){ b.addEventListener("click",function(){ CYC=b.dataset.cyc; paint(); }); });
paint();` : ""}
document.getElementById("go").addEventListener("click", async ()=>{
  const err=document.getElementById("err"); err.style.display="none";
  const rem=document.getElementById("rem").checked;
  const body=${isUp
    ? `{name:document.getElementById("n").value,email:document.getElementById("e").value,password:document.getElementById("p").value,t:${JSON.stringify(tok || "")},plan:PICK,cycle:CYC,remember:rem}`
    : `{email:document.getElementById("e").value,password:document.getElementById("p").value,remember:rem}`};
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
a{color:#2F6BFF}</style></head><body><div>
<h1 style="font-weight:400;font-size:1.6rem;margin:0 0 .5rem">This page does not exist</h1>
<p style="color:#4A5F86;margin:0 0 1.2rem">The link may be old, or mistyped.</p>
<a href="/">Back to the site</a></div></body></html>`);
});

/* ------------------------------------------------------------ boot */
migrate()
  .then(loadConf)
  .then(() => app.listen(CFG.PORT, () => console.log(`NABRA gateway on :${CFG.PORT} — payments: ${CFG.PAYMENTS_MODE}`)))
  .then(startDialler)
  .catch(e => { console.error("migrate failed:", e.message); process.exit(1); });

module.exports = { app, sign, verify, hashPw, checkPw };
