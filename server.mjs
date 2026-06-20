// Manchester Jobs Directory — zero-dependency Node server.
// Serves the site AND does the real scanning server-side (no browser CORS limits).
//
//   node server.mjs            -> http://localhost:5173
//
// Endpoints:
//   GET /                 -> index.html
//   GET /api/stores       -> the brand directory (stores.json)
//   GET /api/scan         -> streams one NDJSON line per brand as it's checked
//   GET /api/scan?only=Workable  (optional) limit to brands on the Workable platform

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 5173;
const stores = JSON.parse(await readFile(join(__dirname, "stores.json"), "utf8"));

// ── Entry-level signal words ──────────────────────────────────────────────
// Used both to filter real Workable listings and to sniff plain careers pages.
const ENTRY_KEYWORDS = [
  "sales assistant", "sales advisor", "retail assistant", "store assistant",
  "customer assistant", "customer advisor", "customer service", "team member",
  "team leader", "crew member", "crew", "barista", "host", "waiter", "waitress",
  "front of house", "kitchen team", "kitchen porter", "cashier", "keyholder",
  "key holder", "stock", "stockroom", "warehouse", "cleaner", "concierge",
  "beauty advisor", "fragrance", "consultant", "concession", "supervisor",
  "trainee", "apprentice", "apprenticeship", "graduate", "intern", "internship",
  "part time", "part-time", "seasonal", "temporary", "christmas", "weekend",
  "entry level", "entry-level", "no experience", "floor staff", "shop floor",
];

const MCR_HINTS = ["manchester", "trafford", "altrincham", "stretford", "salford",
  "stockport", "cheshire", "north west", "united kingdom", "uk", "remote"];

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const matchEntry = (txt) => {
  const t = (txt || "").toLowerCase();
  return ENTRY_KEYWORDS.filter((k) => t.includes(k));
};

// ── fetch with timeout ────────────────────────────────────────────────────
async function timedFetch(url, opts = {}, ms = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "User-Agent": UA, "Accept": "text/html,application/json,*/*" },
      ...opts,
    });
  } finally {
    clearTimeout(timer);
  }
}

// ── Workable: pull real live openings for a company slug ──────────────────
async function workableJobs(slug) {
  const tryParse = (data) => {
    const list = Array.isArray(data?.results) ? data.results
      : Array.isArray(data?.jobs) ? data.jobs
      : Array.isArray(data) ? data : [];
    return list.map((j) => ({
      title: j.title || j.name || "Role",
      location: [j.city || j.location?.city, j.country || j.location?.country]
        .filter(Boolean).join(", "),
      url: j.url || j.shortlink ||
        (j.shortcode ? `https://apply.workable.com/${slug}/j/${j.shortcode}/` : `https://apply.workable.com/${slug}/`),
    }));
  };

  const endpoints = [
    { url: `https://apply.workable.com/api/v3/accounts/${slug}/jobs`,
      opts: { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": UA },
        body: JSON.stringify({ query: "", location: [], department: [], worktype: [], remote: [] }) } },
    { url: `https://apply.workable.com/api/v1/widget/accounts/${slug}?details=true`, opts: {} },
  ];

  for (const ep of endpoints) {
    try {
      const res = await timedFetch(ep.url, ep.opts, 10000);
      if (!res.ok) continue;
      const data = await res.json();
      const jobs = tryParse(data);
      if (jobs.length) return jobs;
    } catch { /* try next endpoint */ }
  }
  return [];
}

// ── Scan a single brand ───────────────────────────────────────────────────
async function scanStore(store) {
  const out = {
    name: store.name, category: store.category, locations: store.locations,
    careers: store.careers, status: "unknown", code: null, ms: null,
    platform: null, roles: [], hints: [], note: "",
  };
  const t0 = process.hrtime.bigint();

  // Workable brands -> real listings via API
  const wm = store.careers.match(/apply\.workable\.com\/([^/?#]+)/i);
  if (wm && wm[1].toLowerCase() !== "api") {
    out.platform = "Workable";
    try {
      const jobs = await workableJobs(wm[1].replace(/\/$/, ""));
      const entry = jobs.filter(
        (j) => matchEntry(j.title).length ||
          MCR_HINTS.some((h) => (j.location || "").toLowerCase().includes(h))
      );
      const chosen = (entry.length ? entry : jobs).slice(0, 12);
      out.roles = chosen;
      out.status = "live";
      out.code = 200;
      out.note = jobs.length
        ? `${jobs.length} open role${jobs.length === 1 ? "" : "s"} found via Workable`
        : "Live careers page — no current openings listed";
      out.ms = Number(process.hrtime.bigint() - t0) / 1e6;
      return out;
    } catch { /* fall through to generic reachability */ }
  }

  // Generic reachability + page keyword sniff
  try {
    const res = await timedFetch(store.careers, {}, 12000);
    out.code = res.status;
    out.ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (res.ok) {
      out.status = "live";
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("text/html") || ct.includes("json") || ct === "") {
        const body = (await res.text()).slice(0, 600000);
        const text = body.replace(/<[^>]+>/g, " ");
        out.hints = [...new Set(matchEntry(text))].slice(0, 10);
      }
      out.note = out.hints.length
        ? "Live — page is advertising these entry-level roles (click through to apply)"
        : "Live careers page";
    } else if ([401, 403, 429, 503].includes(res.status)) {
      out.status = "blocked";
      out.note = `Up but blocks automated checks (HTTP ${res.status}) — opens fine in your browser`;
    } else if (res.status === 404) {
      out.status = "blocked";
      out.note = "Checker got HTTP 404 — page may have moved or blocks bots; open in browser to confirm";
    } else {
      out.status = "blocked";
      out.note = `HTTP ${res.status} to the checker — verify in your browser`;
    }
  } catch (err) {
    out.ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const code = err.cause?.code || err.code || "";
    if (["ENOTFOUND", "EAI_AGAIN"].includes(code)) {
      out.status = "down";        // domain genuinely doesn't resolve
      out.note = `Domain not found (${code})`;
    } else if (err.name === "AbortError") {
      out.status = "blocked";
      out.note = "Timed out after 12s — slow or anti-bot; open in your browser";
    } else {
      out.status = "blocked";     // connection reset etc. — almost always anti-bot, not dead
      out.note = `Couldn't auto-verify (${code || err.name}) — likely anti-bot; open in your browser`;
    }
  }
  return out;
}

// ── small concurrency pool that yields results as they finish ─────────────
async function* scanAll(list, concurrency = 8) {
  const queue = list.map((s, i) => ({ s, i }));
  let next = 0;
  // simple promise-based pool that yields each result the moment it lands
  let resolveOne;
  let pending = 0;
  const ready = [];
  const wake = () => { if (resolveOne) { const r = resolveOne; resolveOne = null; r(); } };

  const launch = () => {
    while (pending < concurrency && next < queue.length) {
      const { s, i } = queue[next++];
      pending++;
      scanStore(s).then((res) => { ready.push({ ...res, i }); pending--; wake(); launch(); })
        .catch(() => { ready.push({ name: s.name, status: "down", i, note: "scan error" }); pending--; wake(); launch(); });
    }
  };
  launch();

  let done = 0;
  while (done < queue.length) {
    if (ready.length === 0) await new Promise((r) => (resolveOne = r));
    while (ready.length) { done++; yield ready.shift(); }
  }
}

// ── HTTP server ───────────────────────────────────────────────────────────
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".ico": "image/x-icon", ".svg": "image/svg+xml" };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/api/stores") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(stores));
    return;
  }

  if (url.pathname === "/api/scan") {
    const only = url.searchParams.get("only");
    let list = stores;
    if (only === "workable") list = stores.filter((s) => /apply\.workable\.com/i.test(s.careers));
    res.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Total": String(list.length),
    });
    res.write(JSON.stringify({ type: "meta", total: list.length }) + "\n");
    try {
      for await (const r of scanAll(list, 8)) {
        res.write(JSON.stringify({ type: "result", ...r }) + "\n");
      }
      res.write(JSON.stringify({ type: "done" }) + "\n");
    } catch (e) {
      res.write(JSON.stringify({ type: "error", message: String(e) }) + "\n");
    }
    res.end();
    return;
  }

  // static files
  let pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  pathname = pathname.replace(/\.\.+/g, ""); // basic traversal guard
  const ext = pathname.slice(pathname.lastIndexOf("."));
  try {
    const data = await readFile(join(__dirname, pathname));
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("404 Not Found");
  }
});

server.listen(PORT, () => {
  console.log(`\n  🛍️  Manchester Jobs Directory running`);
  console.log(`  ➜  http://localhost:${PORT}\n`);
  console.log(`  Press Ctrl+C to stop.\n`);
});
