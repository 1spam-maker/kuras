// super3.mjs — Viada „SUPER trečiadieniai“ → super3.json
//
// Kiekvieną trečiadienį 00:00 Viada paskelbia fiksuotas degalų kainas su „ViadaPLUS“
// (puslapis https://www.viada.lt/akcija/super-treciadieniai/ veikia tik trečiadienį, kitomis dienomis 404).
// Skriptas leidžiamas kartu su kitais; ką nors daro tik trečiadienį (Vilniaus laiku).
// super3.json: { updated, saltinis, days: { "YYYY-MM-DD": { "Dyzelinas": 2.159, "95 benzinas": 1.769, "SND": 0.869 } } }
// Klaida nestabdo workflow.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const URL_ = 'https://www.viada.lt/akcija/super-treciadieniai/';
const UA = 'Mozilla/5.0 (compatible; kuras-degalu-kainos/1.0; +https://github.com/1spam-maker/kuras)';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// Iš puslapio teksto: „Dyzelinas (D ir D MULTI FX) – 2,159 Eur/l“, „Visas benzinas (95 ir 98) – 1,769 Eur/l“,
// „Žymėtas dyzelinas (Dž) – 1,589 Eur/l“, „Dujos (LPG) – 0,869 Eur/l“.
export function parseSuper(html) {
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&#8211;|&ndash;/g, '–').replace(/&#8212;|&mdash;/g, '—')
    .replace(/\s+/g, ' ');
  const out = {};
  const re = /([A-ZĄČĘĖĮŠŲŪŽa-ząčęėįšųūž][^–—:€]{1,70}?)\s*[–—:-]\s*(\d[.,]\d{2,3})\s*(?:Eur|EUR|€)/g;
  for (const [, label, num] of text.matchAll(re)) {
    const l = label.toLowerCase(), v = parseFloat(num.replace(',', '.'));
    if (!(v > 0.3 && v < 4)) continue;
    let t = null;
    if (/žymėt|\bdž\b/.test(l)) continue;                        // žymėtas dyzelinas – ENA jo neskelbia
    if (/dyzelin/.test(l)) t = 'Dyzelinas';
    else if (/benzin/.test(l) && (/95|visas/.test(l) || !/98/.test(l))) t = '95 benzinas';
    else if (/dujos|lpg|snd/.test(l)) t = 'SND';
    if (t && !(t in out)) out[t] = v;
  }
  return out;
}

const vilnius = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Vilnius' });
async function main() {
  const now = new Date(), today = vilnius.format(now);
  const wd = new Date(today + 'T12:00:00Z').getUTCDay();
  if (wd !== 3 && !process.env.SUPER_FORCE) { log('Ne trečiadienis — Super trečiadienių netikrinu.'); return; }

  const r = await fetch(URL_, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30e3) });
  if (!r.ok) { log(`Viada super trečiadieniai: HTTP ${r.status}`); return; }
  const html = await r.text();
  if (/Page not found|Puslapis nerastas/i.test(html.slice(0, 5000))) { log('Viada: puslapis nerastas (dar nepaskelbta?)'); return; }
  const prices = parseSuper(html);
  if (!Object.keys(prices).length) { log('Viada: kainų puslapyje neradau — formatas pasikeitė?'); return; }

  const j = existsSync('super3.json') ? JSON.parse(readFileSync('super3.json', 'utf8')) : { days: {} };
  if (JSON.stringify(j.days[today]) === JSON.stringify(prices)) { log('Super trečiadienis: nieko naujo.'); return; }
  j.days[today] = prices;
  j.updated = now.toISOString();
  j.saltinis = URL_;
  writeFileSync('super3.json', JSON.stringify(j, null, 1) + '\n');
  log(`Super trečiadienis ${today}: ${JSON.stringify(prices)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => log('Super trečiadieniai:', e.message));
