// scrape.mjs — ENA degalų kainų scraper
// 1) Parsina ena.lt/dk-visa-informacija → {data, url} poros
// 2) Kiekvienai naujai datai atsisiunčia xlsx per ?download=1
// 3) Atnaujina data.json (kaupia istoriją, append nuo paleidimo dienos)
//
// Naudoja tik įmontuotą fetch (Node 20+) + xlsx paketą.

import XLSX from 'xlsx';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const ENA_PAGE = 'https://www.ena.lt/dk-visa-informacija/';
const DATA_FILE = 'data.json';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Nuo kada kaupti. Jei nori viską nuo pradžių — pakeisk į '2026-01-01'.
// Pirmas paleidimas užsifiksuos prie šios datos; vėliau ima viską, kas naujesnė.
const START_FROM = process.env.START_FROM || new Date().toISOString().slice(0, 10);

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function fetchText(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'lt,en' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} @ ${url}`);
  return r.text();
}

async function fetchBuffer(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/octet-stream,*/*' },
    redirect: 'follow'
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  // Patikra: ar tikrai xlsx (PK signature 0x50 0x4B)
  if (buf[0] !== 0x50 || buf[1] !== 0x4B) {
    throw new Error(`Ne xlsx (gavom ${buf.length}B, pirmi baitai ${buf[0]},${buf[1]}) — tikėtina login HTML`);
  }
  return buf;
}

// --- ENA HTML → {date,url} poros ---
// 2 žingsniai: (1) rask kiekvieną SharePoint URL, (2) netoliese (title) rask datą.
// Atsparu formatui: su ?e=, be jo, su **bold** wrap, &amp; entity.
function extractLinks(html) {
  const out = new Map();
  const urlRe = /https:\/\/ltenergagen\.sharepoint\.com\/[^\s)"'<>]+/g;
  let m;
  while ((m = urlRe.exec(html))) {
    const url = cleanUrl(m[0]);
    const tail = html.slice(m.index, m.index + url.length + 80);
    const dm = tail.match(/(\d{4}-\d{2}-\d{2})/);
    if (dm) out.set(dm[1], url);
  }
  return [...out.entries()].map(([date, url]) => ({ date, url })).sort((a, b) => a.date.localeCompare(b.date));
}

function cleanUrl(u) {
  return u.replace(/&amp;/g, '&').replace(/["'\\).]+$/, '').trim();
}
function downloadUrl(u) {
  if (/[?&]download=1/.test(u)) return u;
  return u + (u.includes('?') ? '&' : '?') + 'download=1';
}

// --- xlsx → eilutės ---
function parseXlsx(buf, fallbackDate) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' });
  let hi = -1;
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
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
    date: col(/data/)
  };
  const out = [];
  for (const r of rows.slice(hi + 1)) {
    const raw = String(r[ci.price] ?? '').replace(/[^\d.,]/g, '').replace(',', '.');
    const price = parseFloat(raw);
    if (!price || isNaN(price) || price <= 0) continue;
    let date = ci.date >= 0 ? String(r[ci.date] ?? '').trim() : '';
    const dm = date.match(/(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
    date = dm ? `${dm[1]}-${dm[2].padStart(2,'0')}-${dm[3].padStart(2,'0')}` : fallbackDate;
    out.push({
      date,
      brand: ci.brand >= 0 ? String(r[ci.brand] ?? '').trim() : '',
      muni: ci.muni >= 0 ? String(r[ci.muni] ?? '').trim() : '',
      addr: ci.addr >= 0 ? String(r[ci.addr] ?? '').trim() : '',
      type: String(r[ci.type] ?? '').trim() || '?',
      price: +price.toFixed(3)
    });
  }
  return out;
}

// --- main ---
async function main() {
  log('Pradžia. START_FROM =', START_FROM);

  // esama istorija
  let db = { updated: null, days: {} };
  if (existsSync(DATA_FILE)) {
    try { db = JSON.parse(readFileSync(DATA_FILE, 'utf8')); } catch { log('data.json sugadintas, kuriu naują'); }
    if (!db.days) db.days = {};
  }
  const have = new Set(Object.keys(db.days));
  log('Jau turima dienų:', have.size);

  // ENA puslapis
  const html = await fetchText(ENA_PAGE);
  const links = extractLinks(html);
  log('Rasta nuorodų ENA puslapyje:', links.length);
  if (!links.length) { log('KLAIDA: nuorodų nerasta — galbūt pasikeitė puslapio struktūra'); process.exit(1); }

  // filtruojam: tik naujesnės/lygios START_FROM ir dar neturimos
  const todo = links.filter(l => l.date >= START_FROM && !have.has(l.date));
  log('Naujų dienų traukti:', todo.length, todo.map(t => t.date).join(', ') || '(nėra)');

  let ok = 0, fail = 0;
  for (const { date, url } of todo) {
    try {
      const buf = await fetchBuffer(downloadUrl(url));
      const rows = parseXlsx(buf, date);
      if (!rows.length) { log(`  ${date}: 0 eilučių, praleidžiu`); fail++; continue; }
      db.days[date] = rows;
      log(`  ${date}: ✓ ${rows.length} įrašų`);
      ok++;
    } catch (e) {
      log(`  ${date}: ✗ ${e.message}`);
      fail++;
    }
    await new Promise(r => setTimeout(r, 800)); // mandagi pauzė
  }

  db.updated = new Date().toISOString();
  db.source = ENA_PAGE;
  writeFileSync(DATA_FILE, JSON.stringify(db));
  log(`Baigta. Sėkmingai: ${ok}, nepavyko: ${fail}, viso dienų: ${Object.keys(db.days).length}`);

  // jei nieko naujo nepavyko ir buvo ką traukti — nenutraukiam (gali būti laikinas SharePoint trikdis)
  if (todo.length && ok === 0) {
    log('ĮSPĖJIMAS: nepavyko atsisiųsti nė vienos naujos dienos. Tikėtina SharePoint blokuoja datacenter IP.');
    // Neexit'inam su klaida, kad workflow nelūžtų kasdien — tik logas.
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
