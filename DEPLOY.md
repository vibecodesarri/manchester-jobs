# Deploying as a live website (with the working scanner)

Your app has a Node backend (so the **Scan** button works), which means it needs a
host that runs Node — not a plain static host. The free, beginner-friendly choice is
**Render**. It runs `server.mjs`, gives you a public `https://…onrender.com` URL, and
needs no credit card.

Everything is already configured: `package.json` (start script), `render.yaml`
(one-click blueprint), and the server already reads Render's `PORT`. You just need to
get the code onto GitHub, then point Render at it.

---

## Step 1 — Put the code on GitHub

1. Create a free account at https://github.com (skip if you have one).
2. Click **+ → New repository**. Name it e.g. `manchester-jobs`. Leave it **empty**
   (don't add a README/.gitignore — you already have them). Click **Create**.
3. GitHub shows you a URL like `https://github.com/YOURNAME/manchester-jobs.git`.
   In a terminal **inside this folder** (`C:\Users\email\Desktop\Jobs`), run:

   ```bash
   git remote add origin https://github.com/YOURNAME/manchester-jobs.git
   git push -u origin main
   ```

   (It'll ask you to sign in to GitHub the first time — a browser window pops up.)

---

## Step 2 — Deploy on Render

1. Go to https://render.com and **Sign up with GitHub** (one click, authorises Render
   to see your repos).
2. Click **New + → Blueprint**.
3. Select your `manchester-jobs` repo. Render reads `render.yaml` automatically and
   shows a `manchester-jobs` web service on the **Free** plan. Click **Apply**.
4. Wait ~2–3 minutes for the first build. When it's done you get a public URL like
   **`https://manchester-jobs.onrender.com`** — that's your live website. 🎉

> Prefer not to use the blueprint? Use **New + → Web Service** instead, pick the repo,
> set **Build Command** = `npm install`, **Start Command** = `npm start`,
> **Instance Type** = Free, then **Create Web Service**.

---

## Step 3 — Updating the site later

Change anything (e.g. add brands to `stores.json`), then:

```bash
git add -A
git commit -m "Update brands"
git push
```

Render auto-redeploys on every push (`autoDeploy: true`).

---

## Good to know

- **Free-tier sleep:** after 15 min of no traffic the service spins down; the next
  visit takes ~50s to wake, then it's fast again. Fine for a personal/job-hunt site.
  Upgrading to Render's cheapest paid tier removes the sleep.
- **The scanner works in production** unchanged — the fetches run on Render's servers,
  so there's no browser CORS limit.
- **Custom domain (optional):** in the Render service → **Settings → Custom Domains**,
  add e.g. `manchesterjobs.co.uk` and follow the DNS instructions from your registrar.

## Alternatives to Render (also free-ish, run Node)

- **Railway** (railway.app) — similar flow, trial credit then usage-based.
- **Fly.io** (fly.io) — needs the `flyctl` CLI and a card on file, but has a free allowance.
- **Cyclic / Glitch** — no longer recommended (hosting discontinued).
