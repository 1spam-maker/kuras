// brent.mjs — Brent naftos kaina (USD ir EUR už barelį) → brent.json
//
// Šaltiniai (oficialūs, be API rakto):
//  - Brent: FRED DCOILBRENTEU (JAV Federalinis rezervas; EIA „Europe Brent Spot Price FOB“).
//           Atsarginis: EIA istorinis XLS (RBRTEd.xls).
//           EIA duomenis skelbia kartą per savaitę, todėl paskutinės dienos gali vėluoti iki ~1 sav.
//  - EUR/USD: ECB oficialus referencinis kursas.
// Klaida nestabdo workflow: paliekamas senas brent.json.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import XLSX from 'xlsx';

const FROM = '2026-01-01';
const UA = 'kuras-degalu-kainos/1.0 (+https://github.com/1spam-maker/kuras)';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function get(url, as = 'text') {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status} @ ${new URL(url).host}`);
  return as === 'buf' ? Buffer.from(await r.arrayBuffer()) : r.text();
}

async function brentFred() {
  const t = await get(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=DCOILBRENTEU&cosd=${FROM}`);
  const out = {};
  for (const line of t.trim().split('\n').slice(1)) {
    const [d, v] = line.split(',');
    const x = parseFloat(v);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(x)) out[d] = x;
  }
  return out;
}

async function brentEia() {
  const wb = XLSX.read(await get('https://www.eia.gov/dnav/pet/hist_xls/RBRTEd.xls', 'buf'), { type: 'buffer', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames.find(n => /data\s*1/i.test(n)) || wb.SheetNames[1] || wb.SheetNames[0]];
  const out = {};
  for (const [d, v] of XLSX.utils.sheet_to_json(ws, { header: 1, raw: true })) {
    let iso = null;
    if (d instanceof Date) iso = d.toISOString().slice(0, 10);
    else if (typeof d === 'number' && d > 40000) { const p = XLSX.SSF.parse_date_code(d); iso = `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; }
    if (iso && iso >= FROM && Number.isFinite(+v)) out[iso] = +v;
  }
  return out;
}

async function fxEcb() {
  const t = await get(`https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A?format=csvdata&startPeriod=${FROM}`);
  const rows = t.trim().split('\n'), h = rows[0].split(',');
  const iD = h.indexOf('TIME_PERIOD'), iV = h.indexOf('OBS_VALUE');
  const out = {};
  for (const line of rows.slice(1)) { const c = line.split(','); const x = parseFloat(c[iV]); if (Number.isFinite(x)) out[c[iD]] = x; }
  return out;
}

let brent = null, src = null;
for (const [name, fn] of [['FRED DCOILBRENTEU (EIA Europe Brent Spot FOB)', brentFred], ['EIA RBRTEd', brentEia]]) {
  try { const b = await fn(); if (Object.keys(b).length > 20) { brent = b; src = name; break; } log(`${name}: per mažai duomenų`); }
  catch (e) { log(`${name}: ${e.message}`); }
}
if (!brent) { log('Brent duomenų gauti nepavyko — paliekamas senas brent.json'); process.exit(0); }

let fx = {};
try { fx = await fxEcb(); } catch (e) { log(`ECB: ${e.message}`); }
const fxDates = Object.keys(fx).sort();
const fxOn = d => { let r = null; for (const x of fxDates) { if (x > d) break; r = fx[x]; } return r; }; // paskutinis kursas iki tos dienos

const days = {};
for (const d of Object.keys(brent).sort()) {
  const k = fxOn(d);
  days[d] = [+brent[d].toFixed(2), k ? +(brent[d] / k).toFixed(2) : null];
}

const prev = existsSync('brent.json') ? JSON.parse(readFileSync('brent.json', 'utf8')) : null;
if (prev && JSON.stringify(prev.days) === JSON.stringify(days)) { log('Brent: nieko naujo.'); process.exit(0); }
writeFileSync('brent.json', JSON.stringify({ updated: new Date().toISOString(), source: { brent: src, fx: 'ECB EUR/USD' }, days }));
const ds = Object.keys(days);
log(`Brent: ${ds.length} d. (${ds[0]} … ${ds.at(-1)}), paskutinė ${days[ds.at(-1)][0]} USD / ${days[ds.at(-1)][1]} EUR; šaltinis: ${src}`);
