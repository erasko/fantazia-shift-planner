// Smoke test — chráni veci, ktoré sa už raz pokazili.
//
// Nie je to úplné pokrytie a ani sa oň nesnaží. Každá kontrola tu zodpovedá
// konkrétnej chybe z registra v NADVAZNOSTI.md. Keď vyriešiš ďalšiu chybu,
// pridaj sem kontrolu, ktorá by ju bola odhalila — inak sa vráti potichu.
//
// Spustenie:   node test/smoke.mjs
//
// Beží proti vlastnému serveru na dočasnom DATA_DIR, produkčných dát sa
// nedotýka (nemá DATABASE_URL, takže padá na JSON súbor v temp adresári).
//
// POZOR: toto netestuje prehliadač. Chyba, ktorá zhodí vykreslenie karty,
// tu prejde — preto je v kontrolnom zozname aj krok „preklikaj to".

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 3090 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'smoke-test-heslo';
const dataDir = mkdtempSync(path.join(tmpdir(), 'fsp-smoke-'));

let passed = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

let cookie = '';
async function xlsx(url) {
  const res = await fetch(BASE + url, { headers: { Cookie: cookie } });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
  const ws = wb.getWorksheet('Hodiny');
  const rows = [];
  ws.eachRow((row) => rows.push(row.values.slice(1)));
  const [header, ...body] = rows;
  const people = Object.fromEntries(body.map((r) => [r[0], { days: r.slice(1, -1), total: r[r.length - 1] }]));
  return { header, people, filename: res.headers.get('content-disposition') || '' };
}

async function api(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* HTML export */ }
  return { status: res.status, json, text };
}

// ---------------------------------------------------------------- fixture

// Obdobie staviame okolo dnešného dňa, lebo brigádnik smie zapísať hodiny
// len v deň zmeny. Zároveň naschvál presahuje do ďalšieho kalendárneho
// mesiaca — to je prípad, ktorý sa už raz rozbil (1. 11. sa nevygenerovalo).
const today = new Date();
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const TODAY = iso(today);
const MONTH = TODAY.slice(0, 7);

const lastOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0);
const firstOfNext = new Date(today.getFullYear(), today.getMonth() + 1, 1);
const CROSS_DAY = iso(firstOfNext);          // deň v ďalšom mesiaci, ktorý patrí do tohto obdobia
const OPEN_DAYS = [...new Set([TODAY, iso(lastOfMonth), CROSS_DAY])].sort();
const PERIOD_START = iso(new Date(today.getFullYear(), today.getMonth(), 1));

// Deň, ktorý je vnútri obdobia, ale zatiaľ nie je otvorený — otvoríme ho až
// po vygenerovaní rozpisu a overíme, že to export povie.
const EXTRA_DAY = (() => {
  for (let d = new Date(today.getFullYear(), today.getMonth(), 1); iso(d) <= CROSS_DAY; d.setDate(d.getDate() + 1)) {
    if (!OPEN_DAYS.includes(iso(d))) return iso(d);
  }
  throw new Error('nenašiel sa voľný deň v období');
})();

// ------------------------------------------------------------------ štart

let server;
let serverLog = '';
function startServer() {
  server = spawn('node', [path.join(root, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, ADMIN_PASSWORD: PASSWORD, DATABASE_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
}
startServer();

// Server drží stav v pamäti. Na nasimulovanie dát, ktoré cez API už vzniknúť
// nemôžu (napr. preklep v mesiaci spred opravy), ho zastavíme, upravíme súbor
// a spustíme znova.
async function withStoreFile(edit) {
  server.kill();
  await new Promise((r) => server.once('exit', r));
  const file = path.join(dataDir, 'store.json');
  const store = JSON.parse(readFileSync(file, 'utf8'));
  edit(store);
  writeFileSync(file, JSON.stringify(store));
  startServer();
  if (!await waitForServer()) throw new Error('Server sa po reštarte nespustil');
  cookie = '';
  await api('POST', '/api/login', { password: PASSWORD });
}

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return true; } catch { /* ešte nebeží */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function finish(code) {
  server.kill();
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* nevadí */ }
  process.exit(code);
}

try {
  if (!await waitForServer()) {
    console.error('Server sa nespustil:\n' + serverLog);
    finish(1);
  }

  await api('POST', '/api/login', { password: PASSWORD });

  const cfg = await api('PUT', '/api/config', {
    month: MONTH,
    periodStart: PERIOD_START,
    periodEnd: CROSS_DAY,
    openDays: OPEN_DAYS,
    defaultOpensAt: '10:00',
    defaultClosesAt: '19:00',
    stations: [
      { id: 'st-main', name: 'Hlavné', required: 1 },
      { id: 'st-kasa', name: 'Kasa', required: 1, offsetStart: -60 },
    ],
    workers: [
      { id: 'w-anna', name: 'Anna', allowedStations: ['st-main', 'st-kasa'] },
      { id: 'w-boris', name: 'Boris', allowedStations: ['st-main', 'st-kasa'] },
    ],
    operators: [{ id: 'op-1', name: 'Ondrej' }],
  });
  if (cfg.status !== 200) { console.error('Nepodarilo sa nastaviť konfiguráciu:', cfg.status, cfg.text); finish(1); }

  const workerToken = cfg.json.workers.find((w) => w.id === 'w-anna').token;
  const operatorToken = cfg.json.operators.find((o) => o.id === 'op-1').token;

  // ------------------------------------------------ 1. obdobie cez dva mesiace
  console.log('\nObdobie cez dva kalendárne mesiace');

  await api('PUT', '/api/schedule', {});
  let admin = await api('GET', '/api/admin');
  const sched = admin.json.schedule?.[MONTH] || {};
  check('deň v ďalšom mesiaci sa vygeneroval', Object.keys(sched).includes(CROSS_DAY),
    `dni v rozpise: ${Object.keys(sched).sort().join(', ')}`);
  check('rozpis neobsahuje dni mimo obdobia',
    Object.keys(sched).every((d) => d >= OPEN_DAYS[0] && d <= CROSS_DAY));

  // ------------------------------------------------------- 2. zverejnenie
  console.log('\nZverejnenie rozpisu');

  await api('PUT', '/api/schedule-publication', { published: true });
  let worker = await api('GET', `/api/worker/${workerToken}`);
  check('brigádnik vidí zverejnený rozpis', worker.json.scheduleVisible === true);
  check('brigádnik vidí aj deň z ďalšieho mesiaca',
    !!worker.json.fullSchedule && Object.keys(worker.json.fullSchedule).includes(CROSS_DAY),
    `vidí: ${Object.keys(worker.json.fullSchedule || {}).sort().join(', ')}`);

  // -------------------------------------------- 3. obojstranne slepý zápis
  console.log('\nObojstranne slepý zápis hodín');

  // Kto je dnes na stanovisku — hodiny si zapisuje ten, kto je v rozpise.
  const todayStations = sched[TODAY] || {};
  const stationId = Object.keys(todayStations).find((s) => (todayStations[s] || []).includes('w-anna'));
  check('Anna je dnes v rozpise (predpoklad ďalších kontrol)', !!stationId,
    `dnešok: ${JSON.stringify(todayStations)}`);

  if (stationId) {
    const rep = await api('POST', `/api/worker/${workerToken}/hours`,
      { date: TODAY, stationId, start: '10:05', end: '19:20' });
    check('brigádnik zapísal hodiny', rep.status === 200, rep.text.slice(0, 120));

    const op = await api('GET', `/api/operator/${operatorToken}`);
    const opLogs = op.json.hourLogs || [];
    check('prevádzkar vidí záznam na schválenie', opLogs.length > 0);
    // Polia sa volajú presne takto — kedysi tu boli kontroly na neexistujúce
    // názvy, ktoré by prešli aj pri úniku.
    check('prevádzkar NEVIDÍ, čo brigádnik nahlásil',
      opLogs.every((h) => h.reportedStart === undefined && h.reportedEnd === undefined),
      JSON.stringify(opLogs[0] || {}));
    check('prevádzkar dostáva mená bez tokenov',
      Array.isArray(op.json.workers) && op.json.workers.length > 0
        && op.json.workers.every((w) => w.token === undefined && w.passwordHash === undefined),
      JSON.stringify(op.json.workers?.[0] || {}));

    // Prevádzkar schváli iný čas, než brigádnik nahlásil.
    const approve = await api('POST', `/api/operator/${operatorToken}/hours/${opLogs[0].id}/approve`,
      { start: '10:00', end: '19:00' });
    check('prevádzkar schválil hodiny', approve.status === 200, approve.text.slice(0, 120));

    worker = await api('GET', `/api/worker/${workerToken}`);
    const myLogs = worker.json.myHourLogs || [];
    check('brigádnik NEVIDÍ, čo prevádzkar schválil',
      myLogs.every((h) => h.approvedStart === undefined && h.approvedEnd === undefined),
      JSON.stringify(myLogs[0] || {}));
    check('brigádnik vidí svoj vlastný nahlásený čas',
      myLogs.some((h) => h.reportedStart === '10:05'));
  }

  // --------------------------------------------------------- 4. export
  console.log('\nTlačový export');

  let print = await api('GET', '/api/export/schedule-print');
  check('export sa vráti a nie je prázdny', print.status === 200 && print.text.length > 500);
  check('export obsahuje mená', /class="worker-cell"/.test(print.text));
  check('export obsahuje deň z ďalšieho mesiaca',
    print.text.includes(`${firstOfNext.getDate()}. ${firstOfNext.getMonth() + 1}.`));
  check('vygenerovaný export nehlási nevygenerované dni', !print.text.includes('<div class="gen-notice">'));

  // Deň otvorený AŽ PO generovaní sa nesmie vytlačiť ako prázdny riadok bez
  // vysvetlenia — presne to vyzeralo ako „prázdny export ako vzor".
  await api('PUT', '/api/config', { openDays: [...OPEN_DAYS, EXTRA_DAY].sort() });
  print = await api('GET', '/api/export/schedule-print');
  check('deň pridaný po generovaní je v exporte označený', print.text.includes('<div class="gen-notice">'));

  await api('PUT', '/api/schedule', {});
  print = await api('GET', '/api/export/schedule-print');
  check('po opätovnom vygenerovaní hláška zmizne', !print.text.includes('<div class="gen-notice">'));

  // ------------------------------------------- 5. export hodín po obdobiach
  console.log('\nExport hodín — každé obdobie samostatne');

  // Deň v ďalšom kalendárnom mesiaci patrí do TOHTO obdobia (víkend je celok),
  // takže jeho hodiny musia ísť do výkazu tohto obdobia, nie do ďalšieho.
  const manual = await api('POST', '/api/hour-logs',
    { personType: 'worker', personId: 'w-boris', stationId: 'st-main', date: CROSS_DAY, start: '10:00', end: '14:00' });
  check('admin pridal hodiny na deň z ďalšieho mesiaca', manual.status === 200, manual.text.slice(0, 120));

  const dd = (d) => `${d.slice(8, 10)}.${d.slice(5, 7)}.`;
  let rep1 = await xlsx(`/api/export/actual-hours.xlsx?month=${MONTH}`);
  check('výkaz obdobia obsahuje deň z ďalšieho mesiaca', rep1.header.includes(dd(CROSS_DAY)), rep1.header.join(' '));
  check('výkaz obdobia: Anna 9 h, Boris 4 h',
    rep1.people.Anna?.total === 9 && rep1.people.Boris?.total === 4, JSON.stringify(rep1.people));
  check('stĺpce dní sa sčítajú do „Spolu"',
    Object.values(rep1.people).every((p) => p.days.reduce((a, b) => a + (Number(b) || 0), 0) === p.total));
  check('názov súboru nesie obdobie', rep1.filename.includes(MONTH), rep1.filename);

  // Presne to, čo spraví admin: prepne sa na ďalší mesiac, aby ho pripravil.
  const NEXT = CROSS_DAY.slice(0, 7);
  const dayAfterCross = iso(new Date(firstOfNext.getFullYear(), firstOfNext.getMonth(), 2));
  await api('PUT', '/api/config', { month: NEXT });
  await api('PUT', '/api/config', { periodStart: dayAfterCross, openDays: [dayAfterCross] });

  const repNext = await xlsx('/api/export/actual-hours.xlsx');
  check('nové obdobie začína prázdne — žiadne hodiny z minulého',
    Object.keys(repNext.people).length === 0, JSON.stringify(repNext.people));

  const repOld = await xlsx(`/api/export/actual-hours.xlsx?month=${MONTH}`);
  check('po prepnutí na nový mesiac je výkaz starého obdobia nezmenený',
    JSON.stringify(repOld.people) === JSON.stringify(rep1.people) && repOld.header.join() === rep1.header.join(),
    JSON.stringify(repOld.people));

  const planned = await api('GET', `/api/export/hours.csv?month=${MONTH}`);
  const annaPlanned = planned.text.split('\n').find((l) => l.startsWith('"Anna"'));
  check('plánované hodiny starého obdobia ostanú dostupné', !!annaPlanned && !annaPlanned.startsWith('"Anna",0,'), annaPlanned);

  // ------------------------------------- 6. prepnutie mesiaca cez formulár
  console.log('\nPrepnutie mesiaca cez formulár Nastavení');

  // Formulár posiela vždy celú stránku — a pri prepnutí mesiaca na nej ešte
  // boli otvorené dni a dátumy STARÉHO mesiaca. Tie sa kedysi zapísali do
  // nového mesiaca: odtiaľ hláška „N otvorených dní je mimo tohto obdobia".
  admin = await api('GET', '/api/admin');
  const before = { month: admin.json.month, start: admin.json.periodStart, days: admin.json.openDays };
  const [ny, nm] = before.month.split('-').map(Number);
  const NEXT2 = iso(new Date(ny, nm, 1)).slice(0, 7);
  await api('PUT', '/api/config', {
    month: NEXT2, periodStart: before.start, periodEnd: admin.json.periodEnd, openDays: before.days,
  });
  admin = await api('GET', '/api/admin');
  check('nový mesiac nezdedí otvorené dni starého', admin.json.month === NEXT2 && admin.json.openDays.length === 0,
    `mesiac ${admin.json.month}, dni: ${admin.json.openDays.join(', ')}`);
  check('nový mesiac nezdedí dátumy starého', String(admin.json.periodStart).startsWith(NEXT2),
    `začiatok ${admin.json.periodStart}`);
  check('starý mesiac si svoje dni ponechal',
    JSON.stringify([...(admin.json.periods?.[before.month]?.openDays || [])].sort()) === JSON.stringify([...before.days].sort()));

  // Keď admin pri prepnutí rovno napíše dátumy nového mesiaca, platia.
  const NEXT3 = iso(new Date(ny, nm + 1, 1)).slice(0, 7);
  await api('PUT', '/api/config', { month: NEXT3, periodStart: `${NEXT3}-03`, periodEnd: `${NEXT3}-27` });
  admin = await api('GET', '/api/admin');
  check('dátumy napísané pre nový mesiac sa uložia',
    admin.json.periodStart === `${NEXT3}-03` && admin.json.periodEnd === `${NEXT3}-27`,
    `${admin.json.periodStart} – ${admin.json.periodEnd}`);

  // ----------------------------------------------- 7. preklep v mesiaci
  console.log('\nPreklep v mesiaci (napr. 2026-111)');

  const bad = await api('PUT', '/api/config', { month: '2026-111' });
  check('neplatný mesiac sa odmietne', bad.status === 400, `${bad.status} ${bad.text.slice(0, 80)}`);
  admin = await api('GET', '/api/admin');
  check('po odmietnutí sa nič nezmenilo', admin.json.month === NEXT3, admin.json.month);

  // Stav, ktorý v produkcii vznikol ešte pred touto opravou: aktuálny mesiac
  // má neplatný názov a brigádnik naň už stihol odoslať dostupnosť.
  const TYPO = `${NEXT3.slice(0, 4)}-1${NEXT3.slice(5)}`;
  await withStoreFile((st) => {
    st.periods[TYPO] = { ...st.periods[NEXT3] };
    delete st.periods[NEXT3];
    st.month = TYPO;
    st.submissions.push({ id: 'sub-typo', workerId: 'w-anna', workerName: 'Anna', month: TYPO,
      unavailableDays: [`${NEXT3}-10`], submittedAt: new Date().toISOString() });
  });
  await api('PUT', '/api/config', {
    month: NEXT3, periodStart: `${NEXT3}-03`, periodEnd: `${NEXT3}-27`, openDays: [`${NEXT3}-10`, `${NEXT3}-11`],
  });
  admin = await api('GET', '/api/admin');
  check('oprava preklepu prepne na správny mesiac', admin.json.month === NEXT3, admin.json.month);
  check('oprava preklepu nenechá pokazené obdobie', !admin.json.periods?.[TYPO],
    Object.keys(admin.json.periods || {}).join(', '));
  check('oprava preklepu zachová dátumy a otvorené dni',
    admin.json.periodStart === `${NEXT3}-03` && admin.json.openDays.join() === `${NEXT3}-10,${NEXT3}-11`,
    `${admin.json.periodStart}, dni ${admin.json.openDays.join(', ')}`);
  check('dostupnosť odoslaná pod preklepom sa presunie',
    (admin.json.submissions || []).find((x) => x.id === 'sub-typo')?.month === NEXT3);

  // A keď sa admin z preklepu prepol inam (napr. kliknutím na iný mesiac),
  // pokazené obdobie ostane v archíve — musí sa dať zmazať.
  await withStoreFile((st) => { st.periods[TYPO] = { periodStart: '', periodEnd: '', openDays: [] }; });
  const del = await api('DELETE', `/api/periods/${TYPO}`);
  admin = await api('GET', '/api/admin');
  check('obdobie s pokazeným názvom sa dá zmazať', del.status === 200 && !admin.json.periods?.[TYPO],
    `${del.status} ${del.text.slice(0, 80)}`);

  // ---------------------------------------------------------- 8. výsledok
  console.log('\n' + '─'.repeat(50));
  if (failures.length) {
    console.log(`${passed} v poriadku, ${failures.length} CHÝB:\n`);
    failures.forEach((f) => console.log('  ✗ ' + f));
    finish(1);
  }
  console.log(`Všetkých ${passed} kontrol prešlo.`);
  finish(0);
} catch (err) {
  console.error('\nTest spadol:', err);
  console.error(serverLog.slice(-2000));
  finish(1);
}
