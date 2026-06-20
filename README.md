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

## Files

- `index.html` — the website (UI, filters, scan view)
- `server.mjs` — zero-dependency Node server + scanner
- `stores.json` — the brand directory (edit to add/remove brands)
- `start.bat` — double-click launcher
