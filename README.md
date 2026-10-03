# NABRA

AI voice agents that answer and make calls for Egyptian businesses, on the
business's own telephone line. Priced in USD, invoiced in EGP.

---

## What is in this repository

| File | What it is |
|---|---|
| `gateway.js` | The whole backend. Express, one service. Serves every page, owns the database, auth, payments, agents, leads, the Vapi webhook. |
| `fx-service.js` | Separate service. Reads the CBE rate daily, applies your margin, holds a sticky billing rate, raises devaluation alerts. |
| `nabra-voice-ai.html` | The public site. Trilingual: English, Arabic, Masri. |
| `agent-setup-demo.html` | Guided setup: connect a line, teach the agent, test it, deploy. Served at `/setup`. |
| `nabra-dashboard.html` | The customer console. Served at `/app`. |
| `admin-panel.html` | Your operations panel. Served at `/admin`. |
| `legal-public.html` | Terms and privacy customers agree to. Served at `/legal`. |
| `NABRA-HANDBOOK.html` | **Every guide, in one file.** Launch day, build guide, four-week plan, legal pack, product audit. Open it locally and use the tabs. |

The handbook is **internal**. The gateway does not serve it. Keep it out of any
public folder, and do not commit it to a public repository.

---

## Stack

- Node 20+, Express, `pg`. No framework, no build step, no bundler.
- PostgreSQL (Neon).
- Hosting: Railway, two services from one repo — `npm start` and `npm run fx`.
- The HTML files are single-file and dependency-free apart from Google Fonts.

There is deliberately no front-end build. Edit an HTML file, push, done.

---

## Running it locally

```bash
npm install
cp .env.example .env        # then fill it in
node gateway.js             # http://localhost:3000
node fx-service.js          # http://localhost:3100, separate terminal
```

The schema creates itself on first boot. Watch for `schema ready` in the logs.

---

## Routes

**Public**

| Route | What |
|---|---|
| `/` | The site |
| `/legal` | Terms and privacy |
| `/login`, `/signup` | Auth |
| `/robots.txt`, `/sitemap.xml` | Generated from `SITE_URL` |
| `/health` | Uptime check. Returns `{ok:true}` |

**Signed in**

| Route | What |
|---|---|
| `/app` | Customer console |
| `/setup` | Guided agent setup |
| `/admin` | Your panel (role `admin` only) |

**API** — everything under `/api/me/*` is scoped to the session's tenant.
`/api/admin/*` re-reads the role from the database rather than trusting the
cookie. `/api/vapi/webhook` and `/api/pay/webhook` are verified by shared
secret and HMAC respectively.

---

## Sign-in

Two ways in:

| Method | Needs | If not configured |
|---|---|---|
| Email and password | Nothing | Always available |
| Google | `GOOGLE_CLIENT_ID` + secret | Button does not render |

Email signups receive a confirmation link. It is required before an agent can be
**deployed**, not before the customer can sign in and build one, so nobody is
stopped at the door. Google sign-ins are already confirmed by Google and are
never asked again. With no email provider configured nothing is sent and accounts
are treated as confirmed, so a missing key cannot lock out every new customer.

Google uses the authorization-code flow: the browser never sees a token or a
secret, and the code is exchanged server side over TLS. Accounts are matched by
Google id first and then by email, so someone who signs up with a password and
later uses Google on the same address keeps **one** account rather than
creating a second. Trying a password on a Google-created account returns a
message saying to use the Google button.

Redirect URI to register in Google Cloud Console:

```
https://YOURDOMAIN/auth/google/callback
```

## Environment

See `.env.example`. Four things are load-bearing and easy to get wrong:

1. **`SESSION_SECRET`** — changing it logs everyone out. Set it once, keep it in
   a password manager, never rotate casually.
2. **`PAYMENTS_MODE`** — anything other than `paymob` skips the charge entirely.
   That is test mode. It must be `paymob` before you take real money.
3. **`VAPI_API_KEY`** — without it the call cost guards are never pushed to your
   assistants, and Vapi's own 600-second default cuts calls at ten minutes.
4. **`ADMIN_EMAIL` / `ADMIN_PASSWORD`** — bootstrap only. Delete both from
   Railway once you have logged in.

---

## Deploying

Push to `main`; Railway builds and deploys. `railway.json` sets the health check
to `/health` so a broken boot does not replace a working deployment.

The FX engine is a **second service from the same repo** with start command
`npm run fx`. Give the gateway its URL in `FX_SERVICE_URL`.

Full step-by-step, including every external account: open `DEPLOY.html`.

---

## Before taking real money

Open `LAUNCH.html` and work the gates. The short version:

- Real prices in **both** `PRICING.plans` (site) and `PLAN_USD` (gateway).
- `PAYMENTS_MODE=paymob`, and one real card charged and refunded.
- Written confirmation from Paymob that card tokenisation is on, or
  subscriptions cannot renew.
- Every `[BRACKET]` filled in `legal-public.html`, both languages.
- The telecoms memorandum from your lawyer, in writing.

---

## The one architectural idea

You never own the phone line. The customer buys a SIP trunk from their own
Egyptian operator; the line stays in their name, on their contract; your
software answers it. That is why no telecoms licence is required in your own
name, and why nothing here sells phone numbers. Keep it that way until a lawyer
tells you otherwise in writing.
