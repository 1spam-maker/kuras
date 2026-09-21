// scrape.mjs — ENA degalų kainų scraper (v2, 2026-09)
//
// Pakeitimai v2:
//  - ENA perkėlė nuorodas: dk-visa-informacija (404) → dk-pr-pr-duomenys. Tikrinam kelis URL.
//  - SharePoint atsisiuntimas: rankinis redirect + cookie jar (Node fetch cookie
//    per redirect'us neperneša → grįždavo login HTML). Diagnostika, kai ne xlsx.
//  - Nuorodos be datos title'e: data imama iš paties xlsx (Pateikimo data).
//  - Jei buvo ką traukti ir NIEKO nepavyko → exit 1 (kad GitHub praneštų, ne tyliai).
//  - Niekada neperrašom turimų dienų tuščiu turiniu.

import XLSX from 'xlsx';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const ENA_PAGES = [
  'https://www.ena.lt/dk-pr-pr-duomenys/',
  'https://www.ena.lt/degalu-kainos-degalinese/',
  'https://www.ena.lt/dk-visa-informacija/',
];
const DATA_FILE = 'data.json';
// SharePoint host, kuriame ENA laiko xlsx (regex forma)
const SP_HOST_RE = process.env.SP_HOST_RE || 'ltenergagen\\.sharepoint\\.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const LOOKBACK_DAYS = 14;
const START_FROM = process.env.START_FROM
  || new Date(Date.now() - LOOKBACK_DAYS * 864e5).toISOString().slice(0, 10);
const MAX_PER_RUN = +(process.env.MAX_PER_RUN || 20);

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------- HTTP su cookie jar ir rankiniu redirect ----------
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

// ---------- ENA HTML → nuorodos ----------
function cleanUrl(u) {
  return u.replace(/&amp;/g, '&').replace(/["'\\).]+$/, '').trim();
}
function downloadUrl(u) {
  if (/[?&]download=1/.test(u)) return u;
  return u + (u.includes('?') ? '&' : '?') + 'download=1';
}
// Grąžina [{url, date|null}]. Data — iš title po nuorodos, jei yra.
function extractLinks(html) {
  const out = new Map(); // url (be ?e=) → {url, date}
  const urlRe = new RegExp('https?://' + SP_HOST_RE + '/[^\\s)"\'<>]+', 'g');
  let m;
  while ((m = urlRe.exec(html))) {
    const url = cleanUrl(m[0]);
    const key = url.split('?')[0];
    if (out.has(key) && out.get(key).date) continue;
    const tail = html.slice(m.index + m[0].length, m.index + m[0].length + 120);
    const dm = tail.match(/(\d{4}-\d{2}-\d{2})/);
    out.set(key, { url, date: dm ? dm[1] : null });
  }
  return [...out.values()];
}

// ---------- xlsx → eilutės ----------
function parseXlsx(buf, fallbackDate) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' });
  let hi = -1;
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const r = rows[i].map(c => String(c).toLowerCase());
    if (r.some(c => /degal/.test(c)) && r.some(c => /kaina/.test(c))) { hi = i; break; }
  }
  if (hi < 0) throw new Error('Antraštės nerastos xlsx faile');
  const H = rows[hi].map(h => String(h).trim().toLowerCase());
  const col = (...pats) => H.findIndex(h => pats.some(p => p.test(h)));
  const ci = {
    brand: col(/[i\u012f]mon/, /tinkl/, /pavadinim/),
    muni: col(/savivaldyb/),
    addr: col(/adres/),
    type: col(/tipas/, /r[u\u016b]\u0161/),
    price: col(/kaina/),
    date: col(/data/),
  };
  const out = [];
  for (const r of rows.slice(hi + 1)) {
    const raw = String(r[ci.price] ?? '').replace(/[^\d.,]/g, '').replace(',', '.');
    const price = parseFloat(raw);
    if (!price || isNaN(price) || price <= 0) continue;
    let date = '';
    if (ci.date >= 0) {
      const v = r[ci.date];
      if (v instanceof Date) date = v.toISOString().slice(0, 10);
      else {
        const dm = String(v ?? '').match(/(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
        if (dm) date = `${dm[1]}-${dm[2].padStart(2, '0')}-${dm[3].padStart(2, '0')}`;
      }
    }
    out.push({
      date: date || fallbackDate || '',
      brand: ci.brand >= 0 ? String(r[ci.brand] ?? '').trim() : '',
      muni: ci.muni >= 0 ? String(r[ci.muni] ?? '').trim() : '',
      addr: ci.addr >= 0 ? String(r[ci.addr] ?? '').trim() : '',
      type: String(r[ci.type] ?? '').trim() || '?',
      price: +price.toFixed(3),
    });
  }
  return out;
}

// ---------- main ----------
async function main() {
  log('Pradžia. START_FROM =', START_FROM);

  let db = { updated: null, days: {}, seenUrls: [] };
  if (existsSync(DATA_FILE)) {
    try { db = JSON.parse(readFileSync(DATA_FILE, 'utf8')); } catch { log('data.json sugadintas, kuriu naują'); }
  }
  if (db.seed) { log('Seed failas — valau demo'); db = { updated: null, days: {}, seenUrls: [] }; }
  db.days ??= {}; db.seenUrls ??= [];
  const have = new Set(Object.keys(db.days));
  const seen = new Set(db.seenUrls);
  log('Turima dienų:', have.size, have.size ? `(${[...have].sort()[0]} … ${[...have].sort().pop()})` : '');

  // ENA puslapis — pirmas, kuris atsidaro ir turi nuorodų
  let links = [], pageUsed = null;
  for (const p of ENA_PAGES) {
    try {
      const html = await fetchText(p);
      const l = extractLinks(html);
      log(`${p} → nuorodų: ${l.length}`);
      if (l.length) { links = l; pageUsed = p; break; }
    } catch (e) { log(`${p} → ${e.message}`); }
  }
  if (!links.length) { log('KLAIDA: nuorodų nerasta nė viename ENA puslapyje'); process.exit(1); }

  // Kandidatai: (a) su data ≥ START_FROM ir dar neturima; (b) be datos ir URL dar nematytas
  const todo = links.filter(l =>
    l.date ? (l.date >= START_FROM && !have.has(l.date)) : !seen.has(l.url.split('?')[0])
  ).slice(0, MAX_PER_RUN);
  log('Traukti:', todo.length, todo.map(t => t.date || '(data iš failo)').join(', ') || '(nėra)');

  let ok = 0, fail = 0, firstErr = null;
  for (const { url, date } of todo) {
    const key = url.split('?')[0];
    try {
      const buf = await fetchXlsx(downloadUrl(url));
      const rows = parseXlsx(buf, date);
      const realDate = rows[0]?.date || date;
      if (!rows.length || !realDate) { log(`  ${date || key.slice(-12)}: 0 eilučių, praleidžiu`); fail++; continue; }
      if (!date && (realDate < START_FROM || have.has(realDate))) {
        seen.add(key); log(`  ${realDate}: (iš failo) jau turima / per sena — žymiu matytą`); continue;
      }
      db.days[realDate] = rows; have.add(realDate); seen.add(key);
      log(`  ${realDate}: ✓ ${rows.length} įrašų`);
      ok++;
    } catch (e) {
      log(`  ${date || key.slice(-12)}: ✗ ${e.message}`);
      firstErr ??= e.message; fail++;
    }
    await new Promise(r => setTimeout(r, 700));
  }

  db.updated = new Date().toISOString();
  db.source = pageUsed;
  db.seenUrls = [...seen].slice(-400);
  writeFileSync(DATA_FILE, JSON.stringify(db));
  log(`Baigta. Sėkmingai: ${ok}, nepavyko: ${fail}, viso dienų: ${Object.keys(db.days).length}`);

  if (todo.length && ok === 0) {
    console.error('\nKLAIDA: buvo ką traukti, bet nepavyko nė vienas atsisiuntimas.');
    console.error('Pirma klaida:', firstErr);
    process.exit(1);
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
