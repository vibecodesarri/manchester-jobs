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
//   GET /api/board-jobs   -> streams live entry-level jobs aggregated across job boards

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env for local dev (on Render, set these in the dashboard env vars instead).
try {
  const envPath = join(__dirname, ".env");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "").trim();
    }
  }
} catch { /* no .env — fine */ }

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

// ════════════════════════════════════════════════════════════════════════
//  JOB-BOARD AGGREGATOR  — live entry-level jobs across Greater Manchester
//  Primary source: Workable's public board (keyless, multi-employer search).
//  Optional (set env vars): Adzuna, Reed, Jooble — free API keys widen coverage.
// ════════════════════════════════════════════════════════════════════════

// Greater Manchester + immediate commuter towns (lower-case substring match).
const GM_LIST = [
  "manchester", "salford", "trafford", "stockport", "bolton", "bury", "oldham",
  "rochdale", "tameside", "wigan", "altrincham", "sale", "stretford", "urmston",
  "eccles", "swinton", "worsley", "walkden", "irlam", "partington", "timperley",
  "hale", "bowdon", "didsbury", "chorlton", "withington", "fallowfield", "rusholme",
  "levenshulme", "burnage", "gorton", "openshaw", "harpurhey", "moston", "blackley",
  "crumpsall", "cheetham", "hulme", "ardwick", "longsight", "wythenshawe", "northenden",
  "cheadle", "gatley", "heald green", "bramhall", "marple", "romiley", "bredbury",
  "hazel grove", "reddish", "denton", "audenshaw", "droylsden", "failsworth",
  "ashton-under-lyne", "ashton under lyne", "hyde", "dukinfield", "stalybridge",
  "mossley", "chadderton", "royton", "shaw", "middleton", "heywood", "littleborough",
  "milnrow", "prestwich", "whitefield", "radcliffe", "ramsbottom", "tottington",
  "farnworth", "kearsley", "little lever", "westhoughton", "horwich", "blackrod",
  "atherton", "leigh", "tyldesley", "hindley", "golborne", "standish", "orrell",
  "poynton", "wilmslow", "alderley edge", "knutsford", "macclesfield", "glossop",
];
// Word-boundary match so "Glazebury" doesn't match "bury", "Sales" doesn't match "Sale".
const GM_RE = new RegExp(
  "\\b(" + GM_LIST.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")\\b", "i");
const inGM = (city, loc) => GM_RE.test((city || "") + " " + (loc || ""));

// Entry-level vs senior heuristics.
const STRONG_SENIOR = /\b(senior|snr\.?|principal|director|head of|vice[- ]president|vp|chief|c[etf]o|architect)\b/i;
const MID_SENIOR = /\b(manager|supervisor|lead|consultant|specialist|controller|expert|partner)\b/i;
// Words that mark a role as junior even if it also contains "manager" etc.
const ENTRY_OVERRIDE = /\b(assistant|trainee|graduate|apprentice|apprenticeship|junior|jr\.?|intern|entry[- ]?level|no experience|school leaver)\b/i;
// Drop strong-senior titles always; drop manager/supervisor titles unless explicitly junior.
const passEntry = (t) => {
  t = t || "";
  if (STRONG_SENIOR.test(t)) return false;
  if (MID_SENIOR.test(t) && !ENTRY_OVERRIDE.test(t)) return false;
  return true;
};

// Classify a role into a job function + experience level (used by the UI filters).
const ENTRY_SIGNAL = /\b(assistant|trainee|apprentice|apprenticeship|graduate|junior|jr\.?|entry[- ]?level|intern|internship|no experience|crew|team member|school leaver|work experience|level [12]|kitchen porter|healthcare assistant|support worker|domestic|labourer|new to)\b/i;
const CASUAL_SIGNAL = /\b(part[- ]?time|weekend|seasonal|temporary|temp\b|casual|christmas|holiday|bank staff|zero hour)\b/i;
function classify(title) {
  const t = (title || "").toLowerCase();
  let func = "Other";
  if (/\b(driver|driving|hgv|lgv|delivery|courier|chauffeur|van driver|cdl)\b/.test(t)) func = "Driving";
  else if (/\b(warehouse|picker|packer|operative|forklift|fork lift|stockroom|loader|fulfil?ment|goods in)\b/.test(t)) func = "Warehouse";
  else if (/\b(care|carer|caring|support worker|healthcare assistant|nurs|domiciliary|caregiver|home care)\b/.test(t)) func = "Care & Health";
  else if (/\b(barista|waiter|waitress|kitchen|chef|cook|hospitality|bar staff|bartender|bar back|host|hostess|catering|food|restaurant|cafe|coffee|front of house|crew member|team member)\b/.test(t)) func = "Hospitality";
  else if (/\b(sales assistant|retail|store|shop|merchandiser|cashier|sales advisor|sales adviser|fashion|stylist|keyholder|key holder|shop floor|concession)\b/.test(t)) func = "Retail";
  else if (/\b(customer service|customer assistant|customer advisor|customer adviser|call centre|call center|contact centre|customer support|service desk|helpdesk|help desk)\b/.test(t)) func = "Customer Service";
  else if (/\b(admin|administrat|receptionist|clerk|clerical|data entry|office|secretary|coordinator|typist|ward clerk|scheduler|front desk)\b/.test(t)) func = "Admin & Office";
  else if (/\b(cleaner|cleaning|housekeep|domestic|janitor|caretaker)\b/.test(t)) func = "Cleaning";
  else if (/\b(apprentice|apprenticeship|trainee|graduate|intern)\b/.test(t)) func = "Apprentice/Trainee";
  const level = (ENTRY_SIGNAL.test(t) || CASUAL_SIGNAL.test(t)) ? "entry" : "other";
  return { func, level };
}

// Guard against non-UK results (Jooble is global and will match "Manchester, NH" etc.).
// Match a US state only in the ", XX" suffix position so UK strings aren't clipped.
const US_RE = /,\s*(A[KLRZ]|C[AOT]|D[CE]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])\b|\b(USA|United States)\b/;
const looksUK = (loc) => !US_RE.test(loc || "");

const WORKABLE_QUERIES = [
  "", "entry level", "trainee", "apprentice", "junior", "graduate",
  "sales assistant", "customer assistant", "customer service", "team member",
  "crew", "barista", "kitchen", "warehouse operative", "cleaner", "receptionist",
  "care assistant", "support worker", "administrator", "retail", "part time",
  "call centre", "hospitality", "no experience", "weekend", "bartender",
  "waiter", "host", "stock assistant", "data entry", "office junior",
];
const KEYED_QUERIES = [
  "entry level", "apprentice", "trainee", "graduate", "sales assistant",
  "customer service", "warehouse", "care assistant", "cleaner", "receptionist",
  "hospitality", "admin assistant",
];
const JOOBLE_QUERIES = [
  "entry level", "apprentice", "trainee", "assistant", "customer service",
  "warehouse", "care assistant", "hospitality",
];
// NHS entry-level role keywords (avoid the blank query so we skip consultants/qualified nurses).
const NHS_QUERIES = [
  "healthcare assistant", "support worker", "apprentice", "administrator",
  "receptionist", "domestic", "porter", "catering assistant", "clerical",
  "trainee", "nursing assistant", "ward clerk",
];

const stripTags = (s) => (s || "").replace(/<[^>]+>/g, "").trim();
const snippet = (s, n = 380) => {
  const t = stripTags(String(s || "")).replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n).trim() + "…" : t;
};

// Minimal XML helpers (zero-dependency) for the NHS feed.
const xmlField = (block, tag) => {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim() : "";
};
const prettySalary = (s) => {
  const nums = (s.match(/[\d.]+/g) || []).map(Number).filter((n) => n > 0);
  if (!nums.length) return "";
  const hourly = nums.every((n) => n < 100); // sub-£100 figures are hourly rates
  const fmt = (n) => hourly ? `£${(+n.toFixed(2)).toString()}` : (n >= 1000 ? `£${Math.round(n / 1000)}k` : `£${Math.round(n)}`);
  const body = nums.length > 1 ? `${fmt(nums[0])}–${fmt(nums[1])}` : fmt(nums[0]);
  return hourly ? body + "/hr" : body;
};
// Format a salary range, handling hourly rates and empty/zero values.
const money = (min, max) => {
  min = +min || 0; max = +max || 0;
  if (!min && !max) return "";
  const hourly = (min && min < 200) || (max && max < 200);
  const f = (n) => hourly ? `£${+n.toFixed(2)}` : `£${Math.round(n / 1000)}k`;
  if (min && max && max > min) return hourly ? `${f(min)}–${f(max)}/hr` : `${f(min)}–${f(max)}`;
  const v = min || max;
  return hourly ? `${f(v)}/hr` : f(v);
};
// NHS location fields sometimes carry placeholder text; clean to a usable town/postcode.
const cleanLoc = (loc) =>
  (loc || "").replace(/the area below is where the role is located:?/i, "")
    .replace(/^[\s,]+|[\s,]+$/g, "").trim() || "Manchester area";

// ── Source: Workable public board (no key) ────────────────────────────────
async function workableSearch(query) {
  const url = "https://jobs.workable.com/api/v1/jobs?location=" +
    encodeURIComponent("Manchester, United Kingdom") +
    (query ? "&query=" + encodeURIComponent(query) : "");
  const res = await timedFetch(url, { headers: { Accept: "application/json" } }, 12000);
  if (!res.ok) throw new Error("Workable HTTP " + res.status);
  const data = await res.json();
  return (data.jobs || []).map((j) => ({
    id: "wk_" + (j.id || j.url),
    title: j.title,
    company: j.company?.title || j.company || "",
    location: j.location?.city || j.location?.countryName || "Manchester area",
    city: (j.location?.city || "").toLowerCase(),
    url: j.url,
    source: "Workable",
    posted: j.created || j.published || null,
    type: [j.workplace, j.employmentType].filter(Boolean).join(" · "),
    remote: (j.workplace || "").toLowerCase().includes("remote"),
    salary: "",
    description: snippet(j.description),
  }));
}

// ── Source: Adzuna (free key: ADZUNA_APP_ID + ADZUNA_APP_KEY) ──────────────
async function adzunaSearch(query) {
  const id = process.env.ADZUNA_APP_ID, key = process.env.ADZUNA_APP_KEY;
  if (!id || !key) return [];
  const url = `https://api.adzuna.com/v1/api/jobs/gb/search/1?app_id=${id}&app_key=${key}` +
    `&where=manchester&distance=20&results_per_page=50&max_days_old=45&what=${encodeURIComponent(query)}`;
  const res = await timedFetch(url, { headers: { Accept: "application/json" } }, 12000);
  if (!res.ok) throw new Error("Adzuna HTTP " + res.status);
  const data = await res.json();
  return (data.results || []).map((j) => ({
    id: "az_" + j.id,
    title: stripTags(j.title),
    company: j.company?.display_name || "",
    location: j.location?.display_name || "Manchester",
    city: (j.location?.area?.slice(-1)[0] || "").toLowerCase(),
    url: j.redirect_url,
    source: "Adzuna",
    posted: j.created || null,
    type: j.contract_time || j.contract_type || "",
    remote: false,
    salary: money(j.salary_min, j.salary_max),
    description: snippet(j.description),
  }));
}

// ── Source: Reed Jobseeker API (free key: REED_API_KEY) ────────────────────
async function reedSearch(query) {
  const rk = process.env.REED_API_KEY;
  if (!rk) return [];
  const url = `https://www.reed.co.uk/api/1.0/search?keywords=${encodeURIComponent(query)}` +
    `&locationName=Manchester&distanceFromLocation=15&resultsToTake=100`;
  const auth = "Basic " + Buffer.from(rk + ":").toString("base64");
  const res = await timedFetch(url, { headers: { Authorization: auth, Accept: "application/json" } }, 12000);
  if (!res.ok) throw new Error("Reed HTTP " + res.status);
  const data = await res.json();
  return (data.results || []).map((j) => ({
    id: "rd_" + j.jobId,
    title: j.jobTitle,
    company: j.employerName || "",
    location: j.locationName || "Manchester",
    city: (j.locationName || "").toLowerCase(),
    url: j.jobUrl,
    source: "Reed",
    posted: j.date || null,
    type: j.jobType || "",
    remote: false,
    salary: money(j.minimumSalary, j.maximumSalary),
    description: snippet(j.jobDescription),
  }));
}

// ── Source: Jooble (free key: JOOBLE_KEY) ──────────────────────────────────
async function joobleSearch(query) {
  const jk = process.env.JOOBLE_KEY;
  if (!jk) return [];
  const res = await timedFetch(`https://jooble.org/api/${jk}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ keywords: query, location: "Manchester, United Kingdom", page: "1" }),
  }, 12000);
  if (!res.ok) throw new Error("Jooble HTTP " + res.status);
  const data = await res.json();
  return (data.jobs || [])
    .filter((j) => looksUK(j.location))                 // drop "Manchester, NH" etc.
    .map((j) => {
      const loc = (j.location || "").trim();
      return {
        id: "jb_" + (j.id || j.link),
        title: stripTags(j.title),
        company: j.company || "",
        location: (!loc || /^united kingdom$/i.test(loc)) ? "Manchester area" : loc,
        city: loc.toLowerCase(),
        url: j.link,
        source: "Jooble",
        posted: j.updated || null,
        type: j.type || "",
        remote: /remote/i.test(j.title + " " + (j.snippet || "")),
        salary: (j.salary || "").trim(),
        description: snippet(j.snippet),
      };
    });
}

// ── Source: NHS Jobs national feed (no key, XML) ──────────────────────────
async function nhsSearch(query) {
  const url = `https://www.jobs.nhs.uk/api/v1/search_xml?keyword=${encodeURIComponent(query)}` +
    `&location=Manchester&distance=12`;
  const res = await timedFetch(url, { headers: { Accept: "application/xml,text/xml,*/*" } }, 12000);
  if (!res.ok) throw new Error("NHS HTTP " + res.status);
  const xml = await res.text();
  const blocks = xml.match(/<vacancyDetails>[\s\S]*?<\/vacancyDetails>/g) || [];
  return blocks.map((b) => {
    const loc = cleanLoc(xmlField(b, "location"));
    return {
      id: "nhs_" + (xmlField(b, "reference") || xmlField(b, "id")),
      title: xmlField(b, "title"),
      company: xmlField(b, "employer") || "NHS",
      location: loc,
      city: loc.toLowerCase(),
      url: xmlField(b, "url"),
      source: "NHS Jobs",
      posted: xmlField(b, "postDate") || null,
      type: xmlField(b, "type") || "",
      remote: false,
      salary: prettySalary(xmlField(b, "salary")),
      description: snippet(xmlField(b, "description")),
    };
  });
}

function activeSources() {
  const s = ["Workable", "NHS Jobs"];
  if (process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY) s.push("Adzuna");
  if (process.env.REED_API_KEY) s.push("Reed");
  if (process.env.JOOBLE_KEY) s.push("Jooble");
  return s;
}

// Retry on rate-limit (429) with backoff — Adzuna/Jooble free tiers throttle bursts.
async function withRetry(fn, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      if (/HTTP 429|HTTP 503/.test(e.message) && i < tries - 1) {
        await new Promise((r) => setTimeout(r, 1300 * (i + 1)));
        continue;
      }
      throw e;
    }
  }
}

function buildJobTasks() {
  const tasks = [];
  for (const q of WORKABLE_QUERIES) tasks.push({ source: "Workable", q, fn: () => workableSearch(q) });
  for (const q of NHS_QUERIES) tasks.push({ source: "NHS Jobs", q, fn: () => withRetry(() => nhsSearch(q)) });
  if (process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY)
    for (const q of KEYED_QUERIES) tasks.push({ source: "Adzuna", q, fn: () => withRetry(() => adzunaSearch(q)) });
  if (process.env.REED_API_KEY)
    for (const q of KEYED_QUERIES) tasks.push({ source: "Reed", q, fn: () => withRetry(() => reedSearch(q)) });
  if (process.env.JOOBLE_KEY)
    for (const q of JOOBLE_QUERIES) tasks.push({ source: "Jooble", q, fn: () => withRetry(() => joobleSearch(q)) });
  return tasks;
}

// Stream aggregated, deduped, entry-level, Greater-Manchester jobs as batches.
async function* aggregateJobs(concurrency = 8) {
  const tasks = buildJobTasks();
  yield { type: "meta", total: tasks.length, sources: activeSources() };

  const seen = new Set();
  let next = 0, pending = 0, resolveOne;
  const ready = [];
  const wake = () => { if (resolveOne) { const r = resolveOne; resolveOne = null; r(); } };
  const launch = () => {
    while (pending < concurrency && next < tasks.length) {
      const t = tasks[next++]; pending++;
      Promise.resolve().then(t.fn)
        .then((jobs) => { ready.push({ t, jobs }); pending--; wake(); launch(); })
        .catch((err) => { ready.push({ t, jobs: [], error: String(err.message || err) }); pending--; wake(); launch(); });
    }
  };
  launch();

  let done = 0;
  while (done < tasks.length) {
    if (ready.length === 0) await new Promise((r) => (resolveOne = r));
    while (ready.length) {
      const { t, jobs, error } = ready.shift(); done++;
      const fresh = [];
      for (const j of jobs) {
        if (!j || !j.title || !j.url) continue;
        if (!passEntry(j.title)) continue;
        if (j.source === "Workable" && !inGM(j.city, j.location)) continue;
        if (j.source === "Jooble" && !looksUK(j.location)) continue;
        const dkey = (j.title + "|" + j.company).toLowerCase().replace(/\s+/g, " ").trim();
        if (seen.has(dkey)) continue;
        seen.add(dkey);
        const c = classify(j.title);
        j.func = c.func;
        j.level = c.level;
        fresh.push(j);
      }
      yield {
        type: "batch", source: t.source, query: t.q,
        completed: done, total: tasks.length,
        added: fresh.length, totalFound: seen.size, jobs: fresh, error: error || null,
      };
    }
  }
  yield { type: "done", total: seen.size };
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

  if (url.pathname === "/api/board-jobs") {
    res.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache",
    });
    try {
      for await (const m of aggregateJobs(8)) res.write(JSON.stringify(m) + "\n");
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
