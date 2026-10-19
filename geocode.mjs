// geocode.mjs — degalinių koordinatės žemėlapiui (geo.json)
//
// Kiekvienai aktyviai degalinei (kainų buvo per paskutines 30 d.), kuriai dar nėra koordinačių:
//  1) Photon (OpenStreetMap): adresas → koordinatės (fallback: gyvenvietė + savivaldybė);
//  2) „pritraukimas" prie artimiausios OSM degalinės (amenity=fuel) to paties tinklo —
//     taip vieta tampa tiksli iki degalinės, ne tik iki adreso.
// Rezultatai kaupiami geo.json; kitą kartą ieškoma tik naujų degalinių.
// Mandagus naudojimas: ≤1 užklausa/s, identifikuojantis User-Agent, rezultatai saugomi (cache).
// Klaidos nestabdo workflow — kitą kartą bus bandoma vėl.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const UA = 'kuras-degalu-kainos/1.0 (+https://github.com/1spam-maker/kuras)';
const MAX = +(process.env.GEO_MAX || 1000);
const BUDGET_MS = +(process.env.GEO_BUDGET_MIN || 40) * 60e3;
const RETRY_FAILED_DAYS = 14;
const t0 = Date.now();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const today = new Date().toISOString().slice(0, 10);

const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/^(uab|ab|mb|ii|zub)\s+/, '').replace(/\s+(lietuva|lt)$/, '').replace(/[^a-z0-9]/g, '');
const km = (a, b, c, d) => {
  const r = x => x * Math.PI / 180, h = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};

// ---------- duomenys ----------
const data = JSON.parse(readFileSync('data.json', 'utf8'));
const geo = existsSync('geo.json') ? JSON.parse(readFileSync('geo.json', 'utf8')) : { v: 1, stations: {}, failed: {} };
geo.stations ??= {}; geo.failed ??= {};
const key = s => s.join('|');

const dates = Object.keys(data.days).sort();
const recent = new Set();
for (const d of dates.slice(-22)) for (const [s] of data.days[d]) recent.add(s); // ~30 kalendorinių d.
const todo = [...recent].map(i => data.stations[i]).filter(s => {
  const k = key(s);
  if (geo.stations[k]) return false;
  const f = geo.failed[k];
  return !f || (Date.parse(today) - Date.parse(f)) / 864e5 >= RETRY_FAILED_DAYS;
}).slice(0, MAX);

log(`Aktyvių degalinių: ${recent.size}, su koordinatėmis: ${[...recent].filter(i => geo.stations[key(data.stations[i])]).length}, ieškoti: ${todo.length}`);
if (!todo.length) { log('Nieko naujo.'); process.exit(0); }

// ---------- OSM degalinės (vienas Overpass užklausimas) ----------
async function overpass() {
  const q = '[out:json][timeout:120];area["ISO3166-1"="LT"][admin_level=2]->.a;nwr["amenity"="fuel"](area.a);out center tags;';
  for (const ep of ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']) {
    try {
      const r = await fetch(ep, { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(q) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      return j.elements.map(e => ({ lat: e.lat ?? e.center?.lat, lon: e.lon ?? e.center?.lon, keys: [e.tags.brand, e.tags.name, e.tags.operator].map(norm) }))
        .filter(f => f.lat && f.lon);
    } catch (e) { log(`Overpass ${new URL(ep).host}: ${e.message}`); }
  }
  return [];
}
const OSM = await overpass();
log(`OSM degalinių: ${OSM.length}`);

// ---------- Photon (OSM) ----------
// Nominatim nesupranta LT trumpinių („Nemuno g.“), o OSM Lietuvoje gatvės saugomos būtent taip.
// Photon (komoot, tie patys OSM duomenys) juos randa iki namo numerio.
let lastCall = 0;
async function photon(q) {
  const wait = 1100 - (Date.now() - lastCall); if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  const u = 'https://photon.komoot.io/api/?limit=1&bbox=20.9,53.89,26.84,56.45&q=' + encodeURIComponent(q);
  const r = await fetch(u, { headers: { 'User-Agent': UA } });
  if (r.status === 429 || r.status === 403) throw new Error(`Photon HTTP ${r.status} — stabdau, tęsiu kitą kartą`);
  if (!r.ok) return null;
  const f = (await r.json()).features?.[0];
  if (!f) return null;
  const t = f.properties.type;
  return { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0],
    prec: t === 'house' ? 'adresas' : t === 'street' ? 'gatve' : 'gyvenviete' };
}

// Pritraukimas prie tos pačios įmonės OSM degalinės. Spindulys priklauso nuo paieškos tikslumo;
// toliau nei 1,5 km — tik jei kandidatas vienintelis (kitaip rizika „prilipti“ prie kitos degalinės).
const SNAP_KM = { adresas: 0.35, gatve: 1.5, gyvenviete: 6 };
function snap(brand, g) {
  const nb = norm(brand).slice(0, 5);
  if (nb.length < 3) return null;
  let best = null, cands = 0;
  for (const f of OSM) {
    if (!f.keys.some(k => k.includes(nb))) continue;
    const d = km(g.lat, g.lon, f.lat, f.lon);
    if (d <= SNAP_KM[g.prec]) { cands++; if (!best || d < best.d) best = { ...f, d }; }
  }
  if (best && (best.d <= 1.5 || cands === 1)) return { lat: best.lat, lon: best.lon, prec: 'osm' };
  return null;
}

let ok = 0, fail = 0, stopped = false;
for (const s of todo) {
  if (Date.now() - t0 > BUDGET_MS) { log('Laiko biudžetas baigėsi — likusios kitą kartą.'); break; }
  const [brand, muni, addr] = s;
  const clean = addr.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').replace(/,\s*$/, '').trim();
  const noPc = clean.replace(/,?\s*\d{5}\s*$/, '');
  try {
    let g = await photon(noPc);
    if (!g && noPc.includes('/')) g = await photon(noPc.replace(/\/[^,]*/, ''));
    if (!g) { g = await photon(`${noPc.split(',')[0]}, ${muni}`); if (g) g.prec = 'gyvenviete'; }
    if (!g) { geo.failed[key(s)] = today; fail++; log(`  ✗ ${brand} | ${clean}`); continue; }
    const r = snap(brand, g) || g;
    geo.stations[key(s)] = [+r.lat.toFixed(5), +r.lon.toFixed(5), r.prec];
    delete geo.failed[key(s)];
    ok++;
    if (ok % 100 === 0) log(`  … ${ok} rasta`);
  } catch (e) { log(`  ${e.message}`); stopped = true; break; }
}

geo.updated = new Date().toISOString();
writeFileSync('geo.json', JSON.stringify(geo));
const precCount = {};
for (const v of Object.values(geo.stations)) precCount[v[2]] = (precCount[v[2]] || 0) + 1;
log(`Baigta${stopped ? ' (sustabdyta)' : ''}: rasta ${ok}, nerasta ${fail}. Viso su koordinatėmis: ${Object.keys(geo.stations).length}. Tikslumas: ${JSON.stringify(precCount)}`);
