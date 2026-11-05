// brent.mjs — Brent naftos kaina (USD ir EUR už barelį) → brent.json
//
// Brent šaltiniai (pirmas veikiantis):
//  1) ICE Brent artimiausio mėnesio ateities sandoris (BZ=F) per Yahoo Finance — ta kaina,
//     kurią cituoja naujienos; atsinaujina kasdien (paskutinė diena gali būti dienos eigos kaina).
//  2) Tas pats sandoris per Stooq (CB.F).
//  3) Tik jei nėra ankstesnio brent.json: FRED DCOILBRENTEU (EIA „Europe Brent Spot FOB“,
//     oficialus, bet vėluoja 1–2 d. ir dėl spot priemokos gali skirtis nuo ateities sandorio keliais $).
//     Jei 1–2 neveikia, o brent.json jau yra, paliekamas senas (kad eilutė nesimaišytų su spot).
// EUR/USD: ECB oficialus referencinis kursas; ECB nepasiekus — ankstesnio brent.json kursai.
// Klaida nestabdo workflow.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const FROM = '2026-01-01';
const UA = 'Mozilla/5.0 (compatible; kuras-degalu-kainos/1.0; +https://github.com/1spam-maker/kuras)';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Yahoo dienos žvakės laikas – sesijos pradžia arba vidurnaktis Niujorko laiku (vasarą/žiemą skiriasi),
// todėl data imama NY laiku pridėjus 6 val.: abu variantai patenka į teisingą prekybos dieną.
const nyDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const tradeDay = ts => nyDate.format(new Date((ts + 6 * 3600) * 1000));

async function get(url, as = 'text') {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, signal: AbortSignal.timeout(30e3) });
  if (!r.ok) throw new Error(`HTTP ${r.status} @ ${new URL(url).host}`);
  return as === 'json' ? r.json() : r.text();
}
async function retry(fn, n = 3) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) { if (i >= n) throw e; log(`  ${e.message} — kartoju (${i}/${n - 1})`); await sleep(5000 * i); }
  }
}

// ---------- Brent ----------
async function brentYahoo() {
  const p1 = Math.floor(Date.parse(FROM) / 1000), p2 = Math.floor(Date.now() / 1000) + 86400;
  let lastErr;
  for (const host of ['query1', 'query2']) {
    try {
      const j = await get(`https://${host}.finance.yahoo.com/v8/finance/chart/BZ=F?period1=${p1}&period2=${p2}&interval=1d&includePrePost=false`, 'json');
      const r = j?.chart?.result?.[0];
      if (!r?.timestamp) throw new Error('Yahoo: tuščias atsakymas');
      const close = r.indicators?.quote?.[0]?.close || [];
      const out = {};
      r.timestamp.forEach((ts, i) => { const v = close[i]; if (Number.isFinite(v)) out[tradeDay(ts)] = v; });
      // šiandienos (dar neuždarytos) dienos kaina
      const m = r.meta;
      if (Number.isFinite(m?.regularMarketPrice) && m?.regularMarketTime) out[tradeDay(m.regularMarketTime)] = m.regularMarketPrice;
      return out;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

async function brentStooq() {
  const d2 = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const t = await get(`https://stooq.com/q/d/l/?s=cb.f&i=d&d1=${FROM.replace(/-/g, '')}&d2=${d2}`);
  if (!/^Date,/i.test(t)) throw new Error('Stooq: ne CSV');
  const out = {};
  for (const line of t.trim().split('\n').slice(1)) {
    const c = line.split(','), x = parseFloat(c[4]);
    if (/^\d{4}-\d{2}-\d{2}$/.test(c[0]) && Number.isFinite(x)) out[c[0]] = x;
  }
  return out;
}

async function brentFred() {
  const t = await get(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=DCOILBRENTEU&cosd=${FROM}`);
  const out = {};
  for (const line of t.trim().split('\n').slice(1)) {
    const [d, v] = line.split(','); const x = parseFloat(v);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(x)) out[d] = x;
  }
  return out;
}

const FUT = 'ICE Brent ateities sandoris (artimiausias mėn.)';
const prev = existsSync('brent.json') ? JSON.parse(readFileSync('brent.json', 'utf8')) : null;
const prevIsFut = prev?.source?.brent?.startsWith?.('ICE Brent');

const sources = [[`${FUT}, Yahoo Finance BZ=F`, brentYahoo], [`${FUT}, Stooq CB.F`, brentStooq]];
if (!prev || !prevIsFut) sources.push(['FRED DCOILBRENTEU (EIA Europe Brent Spot FOB)', brentFred]);

let brent = null, src = null;
for (const [name, fn] of sources) {
  try { const b = await retry(fn, 2); if (Object.keys(b).length > 20) { brent = b; src = name; break; } log(`${name}: per mažai duomenų`); }
  catch (e) { log(`${name}: ${e.message}`); }
}
if (!brent) { log('Brent duomenų gauti nepavyko — paliekamas senas brent.json'); process.exit(0); }

// ---------- EUR/USD ----------
async function fxEcb() {
  const t = await get(`https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A?format=csvdata&startPeriod=${FROM}`);
  const rows = t.trim().split('\n'), h = rows[0].split(',');
  const iD = h.indexOf('TIME_PERIOD'), iV = h.indexOf('OBS_VALUE');
  const out = {};
  for (const line of rows.slice(1)) { const c = line.split(','); const x = parseFloat(c[iV]); if (Number.isFinite(x)) out[c[iD]] = x; }
  if (Object.keys(out).length < 20) throw new Error('ECB: per mažai kursų');
  return out;
}
// atsarginis: kursai, išvesti iš ankstesnio brent.json (usd/eur)
const fx = {};
for (const [d, [u, e]] of Object.entries(prev?.days || {})) if (u && e) fx[d] = +(u / e).toFixed(4);
let fxSrc = 'ECB EUR/USD';
try { Object.assign(fx, await retry(fxEcb, 3)); }
catch (e) { log(`ECB: ${e.message} — naudojami ankstesni kursai`); fxSrc = 'ECB EUR/USD (paskutiniai turimi)'; }
const fxDates = Object.keys(fx).sort();
if (!fxDates.length) { log('Nėra EUR/USD kurso — paliekamas senas brent.json'); process.exit(0); }
const fxOn = d => { let r = fx[fxDates[0]]; for (const x of fxDates) { if (x > d) break; r = fx[x]; } return r; }; // paskutinis kursas iki tos dienos

const days = {};
for (const d of Object.keys(brent).sort()) if (d >= FROM) days[d] = [+brent[d].toFixed(2), +(brent[d] / fxOn(d)).toFixed(2)];

if (prev && JSON.stringify(prev.days) === JSON.stringify(days)) { log('Brent: nieko naujo.'); process.exit(0); }
writeFileSync('brent.json', JSON.stringify({ updated: new Date().toISOString(), source: { brent: src, fx: fxSrc }, days }));
const ds = Object.keys(days);
log(`Brent: ${ds.length} d. (${ds[0]} … ${ds.at(-1)}), paskutinė ${days[ds.at(-1)][0]} USD / ${days[ds.at(-1)][1]} EUR; šaltinis: ${src}`);
