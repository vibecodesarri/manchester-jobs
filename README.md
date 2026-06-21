# 🛍️ Manchester Jobs Directory

A live website of retail / hospitality / services brands hiring across Greater Manchester
(Trafford Centre, Arndale, Market Street, Piccadilly, Altrincham, Manchester Airport),
with a **one-click live scanner** that checks which careers sites are online right now and
pulls actual **entry-level openings** where the brand exposes them.

## Run it

Double-click **`start.bat`** — it launches the server and opens the site automatically.

Or from a terminal:

```
node server.mjs
```

Then open **http://localhost:5173**.

Requires Node.js 18+ (you have v24). No `npm install` — zero dependencies.

## What the Scan button actually does

Browsers can't fetch other companies' careers sites directly (CORS blocks it), so the scan
runs **server-side** in `server.mjs`. For every brand it:

| Result | Meaning |
|--------|---------|
| 🟢 **Live** | Careers page responded 200 OK. |
| 🟡 **Blocks bots** | Site is up (403/429/503 to an automated checker) but **works fine in your browser** — click through. |
| 🔴 **Down** | No response / timed out. |

- Brands on the **Workable** job platform (AllSaints, Selfridges, CeX, Kurt Geiger, Wagamama,
  Barburrito, etc.) return **real live role titles + apply links**, filtered toward entry-level / Manchester.
- Other live pages are sniffed for **entry-level keywords** (barista, sales assistant, team member,
  apprentice…) shown as hints — always click through to confirm and apply.

## Live Job Board (second tab)

The **Live Job Board** tab searches job boards live for **entry-level openings across
Greater Manchester** and lists them with apply links. It runs server-side (no browser
CORS limits), filters to Greater Manchester + entry-level roles, and de-duplicates.

Always-on, **no API key needed**:
- **Workable** public board (`jobs.workable.com`) — multi-employer, multi-keyword search
- **NHS Jobs** national XML feed — healthcare assistants, admin, apprentices, domestics, etc.

Optional — set these environment variables to unlock more (each is a free key):
- `ADZUNA_APP_ID` + `ADZUNA_APP_KEY` — free at https://developer.adzuna.com (best UK coverage)
- `REED_API_KEY` — free at https://www.reed.co.uk/developers
- `JOOBLE_KEY` — free at https://jooble.org/api/about
- `GEMINI_API_KEY` — Google AI Studio key; powers the **Cover Letter** generator

## Other tabs
- **🗺️ Map** — every entry-level job plotted across Greater Manchester (Leaflet + clustering).
- **✍️ Cover Letter** — enter your details, Gemini drafts a tailored UK cover letter, edit it,
  and export a formatted PDF. Needs `GEMINI_API_KEY`.

On Render, add these under **Environment → Environment Variables** and redeploy.
Locally: `set ADZUNA_APP_ID=... ` (PowerShell: `$env:ADZUNA_APP_ID="..."`) before `node server.mjs`.

## Files

- `index.html` — the website (Store Directory + Live Job Board tabs)
- `server.mjs` — zero-dependency Node server: careers scanner + job-board aggregator
- `stores.json` — the brand directory (edit to add/remove brands)
- `render.yaml` — one-click Render deploy blueprint
- `start.bat` — double-click launcher
- `DEPLOY.md` — full deployment guide
