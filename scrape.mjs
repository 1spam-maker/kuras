// scrape.mjs — ENA degalų kainų scraper (v3, 2026-09-21)
//
// v3: nuo 2026-09-09 ENA skelbia VIENĄ suvestinį metų Excel failą
//     („2026 m. degalų kainos (nuo 2026-04-08)"), o ne atskirus dienos failus.
//     Kiekvieną paleidimą parsisiunčiam jį visą ir atstatom visą istoriją.
//  - Parseris supranta 3 išdėstymus: ilgas (datos stulpelis), lapas-per-dieną,
//    platus (datos kaip stulpelių antraštės).
//  - data.json kompaktiškas (v2 formatas): degalinių žodynas + [degalinė, tipas, kaina*1000].
//  - Degalinių indeksai stabilūs tarp paleidimų (mažesni git diff'ai).
//  - Jei neišparsinta nė viena eilutė → exit 1 su diagnostika.

import XLSX from 'xlsx';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ENA_PAGES = [
  'https://www.ena.lt/dk-pr-pr-duomenys/',
  'https://www.ena.lt/degalu-kainos-degalinese/',
];
const DATA_FILE = 'data.json';
const SP_HOST_RE = process.env.SP_HOST_RE || 'ltenergagen\\.sharepoint\\.com';
const MAX_FILES = +(process.env.MAX_FILES || 5);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const pad = n => String(n).padStart(2, '0');

// ---------- HTTP: rankinis redirect + cookie jar (SharePoint be to grąžina login HTML) ----------
const BROWSER_HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'lt-LT,lt;q=0.9,en;q=0.8',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
};

async function fetchFollow(url, { maxRedirects = 10 } = {}) {
  const jar = new Map();
  let cur = url;
  const trail = [];
  for (let i = 0; i <= maxRedirects; i++) {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const r = await fetch(cur, {
      redirect: 'manual',
      headers: { ...BROWSER_HEADERS, ...(cookie ? { Cookie: cookie } : {}) },
    });
    const setCookies = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
    for (const c of setCookies) {
      const kv = c.split(';')[0]; const eq = kv.indexOf('=');
      if (eq > 0) jar.set(kv.slice(0, eq).trim(), kv.slice(eq + 1).trim());
    }
    trail.push(`${r.status} ${new URL(cur).host}${new URL(cur).pathname.slice(0, 40)}`);
    if ([301, 302, 303, 307, 308].includes(r.status)) {
      const loc = r.headers.get('location');
      if (!loc) throw new Error(`Redirect ${r.status} be Location`);
      cur = new URL(loc, cur).toString();
      continue;
    }
    return { res: r, trail, finalUrl: cur };
  }
  throw new Error('Per daug redirect\'ų: ' + trail.join(' → '));
}

async function fetchText(url) {
  const { res } = await fetchFollow(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} @ ${url}`);
  return res.text();
}

async function fetchXlsx(url) {
  const { res, trail, finalUrl } = await fetchFollow(url);
  const buf = Buffer.from(await res.arrayBuffer());
  const ct = res.headers.get('content-type') || '';
  if (!res.ok || buf[0] !== 0x50 || buf[1] !== 0x4B) {
    const head = buf.slice(0, 160).toString('utf8').replace(/\s+/g, ' ');
    throw new Error(
      `Ne xlsx. status=${res.status} ct=${ct.slice(0, 40)} bytes=${buf.length}` +
      ` | trail: ${trail.join(' → ')} | final: ${finalUrl.slice(0, 90)} | head: ${head}`
    );
  }
  return buf;
}

// ---------- ENA HTML → SharePoint nuorodos ----------
function cleanUrl(u) {
  return u.replace(/&amp;/g, '&').replace(/["'\\).]+$/, '').trim();
}
function downloadUrl(u) {
  if (/[?&]download=1/.test(u)) return u;
  return u + (u.includes('?') ? '&' : '?') + 'download=1';
}
function extractLinks(html) {
  const out = new Map();
  const urlRe = new RegExp('https?://' + SP_HOST_RE + '/[^\\s)"\'<>]+', 'g');
  let m;
  while ((m = urlRe.exec(html))) {
    const url = cleanUrl(m[0]);
    const key = url.split('?')[0];
    if (out.has(key)) continue;
    const tail = html.slice(m.index + m[0].length, m.index + m[0].length + 200);
    const ta = tail.match(/title="([^"]*)"/);
    const title = (ta ? ta[1] : tail.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').slice(0, 90).trim();
    out.set(key, { url, title });
  }
  return [...out.values()];
}

// ---------- xlsx → eilutės ----------
const DATE_RE = /(\d{4})[-./](\d{1,2})[-./](\d{1,2})/;
function toISO(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') {
    if (v > 40000 && v < 60000) { const d = XLSX.SSF.parse_date_code(v); return `${d.y}-${pad(d.m)}-${pad(d.d)}`; }
    return null;
  }
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const m = String(v).match(DATE_RE);
  return m ? `${m[1]}-${pad(m[2])}-${pad(m[3])}` : null;
}
function toPrice(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^\d.,]/g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0.1 && n < 10 ? n : null;
}
const str = v => String(v ?? '').trim();

function parseWorkbook(buf) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const out = [];
  const diag = [];
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, blankrows: false, defval: '', raw: true });
    let hi = -1, dateCols = [];
    for (let i = 0; i < Math.min(rows.length, 30); i++) {
      const low = rows[i].map(c => String(c).toLowerCase());
      const hasType = low.some(c => /degal|tipas|r[uū]š/.test(c));
      const hasPrice = low.some(c => /kaina/.test(c));
      const dc = rows[i].map((c, j) => (toISO(c) ? j : -1)).filter(j => j >= 0);
      if (hasType && (hasPrice || dc.length >= 2)) { hi = i; dateCols = dc.length >= 2 ? dc : []; break; }
    }
    if (hi < 0) { diag.push(`[${name}] antraštė nerasta (pirma eil.: ${JSON.stringify(rows[0] || []).slice(0, 100)})`); continue; }

    const H = rows[hi].map(h => String(h).trim().toLowerCase());
    const col = (...pats) => H.findIndex((h, j) => !dateCols.includes(j) && pats.some(p => p.test(h)));
    const ci = {
      brand: col(/[iį]mon/, /tinkl/, /pavadinim/),
      muni: col(/savivaldyb/),
      addr: col(/adres/),
      type: col(/tipas/, /r[uū]š/) >= 0 ? col(/tipas/, /r[uū]š/) : col(/degal/),
      price: col(/kaina/),
      date: col(/data/),
    };
    const sheetDate = toISO(name) || toISO(rows.slice(0, hi).flat().join(' '));
    const format = dateCols.length ? 'platus' : ci.date >= 0 ? 'ilgas' : sheetDate ? 'lapas-per-dieną' : 'nežinomas';
    let n = 0;
    for (const r of rows.slice(hi + 1)) {
      const base = { brand: str(r[ci.brand]), muni: str(r[ci.muni]), addr: str(r[ci.addr]), type: str(r[ci.type]) };
      if (!base.type) continue;
      if (format === 'platus') {
        for (const j of dateCols) {
          const price = toPrice(r[j]);
          if (price) { out.push({ ...base, date: toISO(rows[hi][j]), price }); n++; }
        }
      } else {
        const price = toPrice(r[ci.price]);
        const date = (ci.date >= 0 ? toISO(r[ci.date]) : null) || sheetDate;
        if (price && date) { out.push({ ...base, date, price }); n++; }
      }
    }
    diag.push(`[${name}] formatas=${format} antraštė=eil.${hi + 1} stulpeliai=${JSON.stringify(ci)} eilučių=${n}`);
  }
  return { rows: out, diag };
}

// ---------- kompaktiškas data.json (v2) ----------
function loadDb() {
  if (existsSync(DATA_FILE)) {
    try {
      const d = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
      if (d.v === 2) return d;
    } catch { log('data.json sugadintas — kuriu naują'); }
  }
  return { v: 2, stations: [], types: [], days: {} };
}

function mergeRows(db, rows) {
  const sIdx = new Map(db.stations.map((s, i) => [s.join('|'), i]));
  const tIdx = new Map(db.types.map((t, i) => [t, i]));
  const byDate = new Map();
  for (const r of rows) {
    const sk = `${r.brand}|${r.muni}|${r.addr}`;
    if (!sIdx.has(sk)) { sIdx.set(sk, db.stations.length); db.stations.push([r.brand, r.muni, r.addr]); }
    if (!tIdx.has(r.type)) { tIdx.set(r.type, db.types.length); db.types.push(r.type); }
    const s = sIdx.get(sk), t = tIdx.get(r.type);
    if (!byDate.has(r.date)) byDate.set(r.date, new Map());
    byDate.get(r.date).set(s * 100 + t, [s, t, Math.round(r.price * 1000)]); // dublikatai: paskutinis laimi
  }
  for (const [date, m] of byDate) {
    db.days[date] = [...m.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  }
  db.days = Object.fromEntries(Object.entries(db.days).sort(([a], [b]) => a.localeCompare(b)));
  return byDate.size;
}

// ---------- main ----------
async function main() {
  log('Pradžia (v3)');
  const db = loadDb();
  log('Turima dienų:', Object.keys(db.days).length);

  let links = [], pageUsed = null;
  for (const p of ENA_PAGES) {
    try {
      const l = extractLinks(await fetchText(p));
      log(`${p} → SharePoint nuorodų: ${l.length}`);
      if (l.length) { links = l; pageUsed = p; break; }
    } catch (e) { log(`${p} → ${e.message}`); }
  }
  if (!links.length) { console.error('KLAIDA: SharePoint nuorodų nerasta nė viename ENA puslapyje'); process.exit(1); }

  let all = [], ok = 0, firstErr = null;
  for (const { url, title } of links.slice(0, MAX_FILES)) {
    log(`Failas: "${title}"`);
    try {
      const buf = await fetchXlsx(downloadUrl(url));
      log(`  atsisiųsta ${(buf.length / 1024).toFixed(0)} KB`);
      const { rows, diag } = parseWorkbook(buf);
      diag.forEach(d => log('  ' + d));
      all = all.concat(rows);
      ok++;
    } catch (e) {
      log(`  ✗ ${e.message}`);
      firstErr ??= e.message;
    }
  }

  if (!all.length) {
    console.error(`\nKLAIDA: neišparsinta nė viena kainų eilutė (failų atsisiųsta: ${ok}).`);
    if (firstErr) console.error('Pirma klaida:', firstErr);
    process.exit(1);
  }

  const touched = mergeRows(db, all);
  db.updated = new Date().toISOString();
  db.source = pageUsed;
  const json = JSON.stringify(db);
  writeFileSync(DATA_FILE, json);

  const dates = Object.keys(db.days);
  const last = dates[dates.length - 1];
  log(`Baigta. Eilučių: ${all.length}, atnaujinta dienų: ${touched}, viso dienų: ${dates.length} (${dates[0]} … ${last})`);
  log(`Paskutinė diena ${last}: ${db.days[last].length} kainų, degalinių žodyne: ${db.stations.length}, tipai: ${db.types.join(', ')}`);
  log(`data.json: ${(json.length / 1024).toFixed(0)} KB`);
}

export { parseWorkbook, mergeRows, extractLinks, toISO, toPrice };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error('FATAL:', e); process.exit(1); });
}
