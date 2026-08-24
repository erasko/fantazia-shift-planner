import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import pg from 'pg';
import ExcelJS from 'exceljs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3000');
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const AGENT_API_KEY = process.env.AGENT_API_KEY || null;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');

// ─── Postgres ─────────────────────────────────────────────────────────────────

const pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

async function ensureTable() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_store (
      id TEXT PRIMARY KEY DEFAULT 'main',
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

// ─── Store ────────────────────────────────────────────────────────────────────

function lastDayOfMonth(yearMonth) {
  const [y, m] = yearMonth.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

function defaultStore() {
  const now = new Date();
  const month = now.toISOString().slice(0, 7);
  const last = lastDayOfMonth(month);
  return {
    month,
    periodStart: `${month}-01`,
    periodEnd: `${month}-${String(last).padStart(2, '0')}`,
    availabilityDeadline: '',
    defaultOpensAt: '10:00',
    defaultClosesAt: '19:00',
    openDays: [],
    daySettings: {},
    stations: [],
    workers: [],
    operators: [],
    groups: [],
    activeGroup: null,
    submissions: [],
    manualAssignments: {},
    schedule: {},
    schedulePublished: false,
    changeRequests: [],
    hourLogs: [],
    // Per-month archive of period settings, so switching the admin's working
    // month doesn't overwrite another month's dates/open days.
    periods: {},
    // Months whose schedule is visible to workers. Lets an already-published
    // month stay live while availability is collected for the next one.
    publishedMonths: [],
  };
}

// Older stores kept a single flat period plus one schedulePublished flag.
// Fold that into the per-month structures so both shapes work.
function migrateStore(store) {
  if (!store.periods) store.periods = {};
  if (!Array.isArray(store.publishedMonths)) store.publishedMonths = [];

  if (store.month && !store.periods[store.month]) {
    store.periods[store.month] = {
      periodStart: store.periodStart,
      periodEnd: store.periodEnd,
      openDays: store.openDays || [],
      availabilityDeadline: store.availabilityDeadline || '',
    };
  }
  if (store.schedulePublished && store.month && !store.publishedMonths.includes(store.month)) {
    store.publishedMonths.push(store.month);
  }

  for (const sub of store.submissions || []) {
    if (!sub.month) {
      sub.month = sub.unavailableDays?.[0]?.slice(0, 7)
        || sub.submittedAt?.slice(0, 7)
        || store.month;
    }
  }
  return store;
}

let _store = null;

async function loadStore() {
  if (pool) {
    const res = await pool.query("SELECT data FROM app_store WHERE id = 'main'");
    if (res.rows.length) return migrateStore({ ...defaultStore(), ...res.rows[0].data });
    return defaultStore();
  }
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_FILE)) return defaultStore();
  try {
    return migrateStore({ ...defaultStore(), ...JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')) });
  } catch {
    return defaultStore();
  }
}

async function saveStore(store) {
  if (pool) {
    await pool.query(
      `INSERT INTO app_store (id, data, updated_at) VALUES ('main', $1, NOW())
       ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = NOW()`,
      [JSON.stringify(store)]
    );
    return;
  }
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
}

async function getStore() {
  if (!_store) _store = await loadStore();
  return _store;
}

async function mutateStore(fn) {
  const store = await getStore();
  fn(store);
  await saveStore(store);
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

function hashPassword(pwd) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pwd, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(stored, pwd) {
  if (!stored || !pwd) return false;
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  try {
    const attempt = crypto.scryptSync(pwd, salt, 32).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(attempt, 'hex'));
  } catch {
    return false;
  }
}

function generateToken() {
  return crypto.randomBytes(24).toString('hex');
}

const sessions = new Map();
const SESSION_TTL = 12 * 60 * 60 * 1000;

function createSession() {
  const token = generateToken();
  sessions.set(token, { createdAt: Date.now() });
  return token;
}

function getSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL) {
    sessions.delete(token);
    return null;
  }
  return s;
}

function deleteSession(token) {
  sessions.delete(token);
}

// ─── Rate Limiting ────────────────────────────────────────────────────────────

const rateLimits = new Map();

function checkRateLimit(key, max = 5, windowMs = 15 * 60 * 1000) {
  const now = Date.now();
  const entry = rateLimits.get(key) || { count: 0, firstAt: now };
  if (now - entry.firstAt > windowMs) {
    rateLimits.set(key, { count: 1, firstAt: now });
    return true;
  }
  if (entry.count >= max) return false;
  entry.count++;
  rateLimits.set(key, entry);
  return true;
}

// ─── Periods ──────────────────────────────────────────────────────────────────

// The flat month/period/openDays fields describe the month the admin is
// currently working on; `periods` keeps every other month's settings intact.
function snapshotCurrentPeriod(store) {
  if (!store.month) return;
  if (!store.periods) store.periods = {};
  store.periods[store.month] = {
    periodStart: store.periodStart,
    periodEnd: store.periodEnd,
    openDays: store.openDays || [],
    availabilityDeadline: store.availabilityDeadline || '',
  };
}

function activateMonth(store, month) {
  snapshotCurrentPeriod(store);
  const p = store.periods?.[month];
  store.month = month;
  if (p) {
    store.periodStart = p.periodStart;
    store.periodEnd = p.periodEnd;
    store.openDays = p.openDays || [];
    store.availabilityDeadline = p.availabilityDeadline || '';
  } else {
    const last = lastDayOfMonth(month);
    store.periodStart = `${month}-01`;
    store.periodEnd = `${month}-${String(last).padStart(2, '0')}`;
    store.openDays = [];
    store.availabilityDeadline = '';
  }
  store.schedulePublished = isMonthPublished(store, month);
}

function isMonthPublished(store, month) {
  return (store.publishedMonths || []).includes(month);
}

function setMonthPublished(store, month, published) {
  if (!Array.isArray(store.publishedMonths)) store.publishedMonths = [];
  const has = store.publishedMonths.includes(month);
  if (published && !has) store.publishedMonths.push(month);
  if (!published && has) store.publishedMonths = store.publishedMonths.filter((m) => m !== month);
  if (month === store.month) store.schedulePublished = published;
}

function periodFor(store, month) {
  if (month === store.month) {
    return {
      periodStart: store.periodStart,
      periodEnd: store.periodEnd,
      openDays: store.openDays || [],
      availabilityDeadline: store.availabilityDeadline || '',
    };
  }
  return store.periods?.[month] || { periodStart: '', periodEnd: '', openDays: [], availabilityDeadline: '' };
}

// Open days across every published month — what a worker may log hours against.
function publishedOpenDays(store) {
  const days = new Set();
  for (const m of store.publishedMonths || []) {
    for (const d of periodFor(store, m).openDays) days.add(d);
  }
  return days;
}

// ─── Schedule Generation ──────────────────────────────────────────────────────

function isAvailabilityLocked(store) {
  if (!store.availabilityDeadline) return false;
  return new Date() > new Date(store.availabilityDeadline);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function getShiftHours(store, date, station) {
  const ds = store.daySettings?.[date] || {};
  const opensAt = station?.opensAt || ds.opensAt || store.defaultOpensAt || '10:00';
  const closesAt = station?.closesAt || ds.closesAt || store.defaultClosesAt || '19:00';
  const [oh, om] = opensAt.split(':').map(Number);
  const [ch, cm] = closesAt.split(':').map(Number);
  const mins = (ch * 60 + cm) - (oh * 60 + om);
  return mins > 0 ? mins / 60 : 0;
}

function hhmmToMinutes(hhmm) {
  const [h, m] = (hhmm || '0:00').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function hoursBetween(start, end) {
  const mins = hhmmToMinutes(end) - hhmmToMinutes(start);
  return mins > 0 ? mins / 60 : 0;
}

// Hour logs shown to an operator must never reveal what the worker reported —
// only the operator's own independently-entered time counts, so discrepancies
// (visible only in the admin export) can't be colluded around. Strip the
// reported time server-side and offer the *planned* schedule time instead,
// so the approval form isn't pre-filled with the worker's claim.
function sanitizeHourLogsForOperator(store) {
  const stationMap = new Map(store.stations.map((s) => [s.id, s]));
  return (store.hourLogs || []).map((h) => {
    const station = stationMap.get(h.stationId);
    const ds = store.daySettings?.[h.date] || {};
    const plannedStart = station?.opensAt || ds.opensAt || store.defaultOpensAt || '10:00';
    const plannedEnd = station?.closesAt || ds.closesAt || store.defaultClosesAt || '19:00';
    return {
      id: h.id,
      date: h.date,
      stationId: h.stationId,
      workerId: h.workerId,
      workerName: h.workerName,
      substituteFor: h.substituteFor,
      substituteForName: h.substituteForName,
      status: h.status,
      plannedStart,
      plannedEnd,
      approvedStart: h.approvedStart,
      approvedEnd: h.approvedEnd,
      approvedByName: h.approvedByName,
      approvedAt: h.approvedAt,
    };
  });
}

// A worker must never see what the operator approved — otherwise they'd learn
// the operator's pattern (e.g. "always rounds down 15 min") and adjust future
// reports around it. They only see their own reported value and the status.
function sanitizeHourLogsForWorker(store, workerId) {
  return (store.hourLogs || [])
    .filter((h) => h.workerId === workerId)
    .map((h) => ({
      id: h.id,
      date: h.date,
      stationId: h.stationId,
      workerId: h.workerId,
      workerName: h.workerName,
      substituteFor: h.substituteFor,
      substituteForName: h.substituteForName,
      reportedStart: h.reportedStart,
      reportedEnd: h.reportedEnd,
      status: h.status,
    }));
}

// Lean per-date/station schedule table (id + name) used by workers to pick
// who they're substituting for, and by operators to label hour-log entries.
function publicScheduleTable(store, month = store.month) {
  const sched = effectiveSchedule(store, month);
  const table = {};
  for (const date of [...periodFor(store, month).openDays].sort()) {
    const dayOv = store.daySettings?.[date]?.stationOverrides || {};
    table[date] = {};
    for (const station of store.stations) {
      const ov = dayOv[station.id];
      const needed = ov !== undefined ? (ov.required ?? station.required ?? 1) : (station.required || 1);
      if (needed === 0) continue;
      const wids = sched[date]?.[station.id] || [];
      table[date][station.id] = {
        stationName: ov?.mergedLabel || station.name,
        workers: wids.map((id) => ({ id, name: store.workers.find((w) => w.id === id)?.name || id })),
      };
    }
  }
  return table;
}

// Latest submission per worker, scoped to one month — a worker filling in
// October must not overwrite the September availability a published schedule
// was built from.
function latestSubmissionsFor(store, month) {
  const latest = new Map();
  for (const sub of store.submissions || []) {
    if (month && (sub.month || '') !== month) continue;
    const ex = latest.get(sub.workerId);
    if (!ex || sub.submittedAt > ex.submittedAt) latest.set(sub.workerId, sub);
  }
  return latest;
}

function generateSchedule(store) {
  const latestSub = latestSubmissionsFor(store, store.month);

  const unavailable = new Map();
  for (const [wid, sub] of latestSub) {
    unavailable.set(wid, new Set(sub.unavailableDays || []));
  }

  const assignHours = new Map();
  for (const w of store.workers) assignHours.set(w.id, 0);

  const groupFilter = (() => {
    if (!store.activeGroup) return null;
    const grp = (store.groups || []).find(g => g.id === store.activeGroup);
    return grp ? new Set(grp.workerIds || []) : null;
  })();

  const assignments = {};
  const assignedOnDay = {};

  for (const date of [...store.openDays].sort()) {
    assignments[date] = {};
    assignedOnDay[date] = new Set();

    const dayOverrides = store.daySettings?.[date]?.stationOverrides || {};

    for (const station of store.stations) {
      assignments[date][station.id] = [];
      const ov = dayOverrides[station.id];
      const needed = ov !== undefined ? (ov.required ?? station.required ?? 1) : (station.required || 1);
      if (needed === 0) continue;

      const mergeIds = new Set([station.id, ...(ov?.mergeWith ? [ov.mergeWith] : [])]);
      const eligible = store.workers.filter((w) => {
        if (groupFilter && !groupFilter.has(w.id)) return false;
        if (!(w.allowedStations || []).some((sid) => mergeIds.has(sid))) return false;
        if ((unavailable.get(w.id) || new Set()).has(date)) return false;
        if (assignedOnDay[date].has(w.id)) return false;
        return true;
      });

      eligible.sort((a, b) => (assignHours.get(a.id) || 0) - (assignHours.get(b.id) || 0));

      const shiftHours = getShiftHours(store, date, station);
      for (let i = 0; i < Math.min(needed, eligible.length); i++) {
        const w = eligible[i];
        assignments[date][station.id].push(w.id);
        assignedOnDay[date].add(w.id);
        assignHours.set(w.id, (assignHours.get(w.id) || 0) + shiftHours);
      }
    }
  }

  return assignments;
}

// ─── Data Views ───────────────────────────────────────────────────────────────

function effectiveSchedule(store, month = store.month) {
  const gen = store.schedule?.[month] || {};
  const manual = store.manualAssignments?.[month] || {};
  const merged = {};
  const allDates = new Set([...Object.keys(gen), ...Object.keys(manual)]);
  for (const date of allDates) {
    merged[date] = { ...(gen[date] || {}) };
    for (const [sid, wids] of Object.entries(manual[date] || {})) {
      merged[date][sid] = wids;
    }
  }
  return merged;
}

// Shifts across every published month, so a worker keeps seeing September's
// roster while the admin collects availability for October.
function workerScheduleData(store, worker) {
  const months = store.publishedMonths || [];
  if (!months.length) return null;
  const shifts = [];
  for (const month of months) {
    const sched = effectiveSchedule(store, month);
    for (const [date, stations] of Object.entries(sched)) {
      const dayOv = store.daySettings?.[date]?.stationOverrides || {};
      for (const [stationId, workerIds] of Object.entries(stations)) {
        if (!workerIds.includes(worker.id)) continue;
        const station = store.stations.find((s) => s.id === stationId);
        const ov = dayOv[stationId];
        const needed = ov !== undefined ? (ov.required ?? station?.required ?? 1) : (station?.required || 1);
        if (needed === 0) continue;
        const ds = store.daySettings?.[date] || {};
        const opensAt = station?.opensAt || ds.opensAt || store.defaultOpensAt || '10:00';
        const closesAt = station?.closesAt || ds.closesAt || store.defaultClosesAt || '19:00';
        shifts.push({ date, month, stationId, stationName: ov?.mergedLabel || station?.name || stationId, opensAt, closesAt });
      }
    }
  }
  return shifts.sort((a, b) => a.date.localeCompare(b.date));
}

function publicWorkerStore(store, worker) {
  // Availability always refers to the month the admin is currently collecting.
  const latestSub = (store.submissions || [])
    .filter((s) => s.workerId === worker.id && (s.month || '') === store.month)
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))[0];

  const pendingRequests = (store.changeRequests || []).filter(
    (r) => r.workerId === worker.id && r.status === 'pending'
  ).length;

  const collectingPublished = isMonthPublished(store, store.month);
  const publishedTables = {};
  for (const m of store.publishedMonths || []) {
    Object.assign(publishedTables, publicScheduleTable(store, m));
  }

  return {
    workerName: worker.name,
    workerId: worker.id,
    hasPassword: !!worker.passwordHash,
    month: store.month,
    periodStart: store.periodStart,
    periodEnd: store.periodEnd,
    openDays: store.openDays,
    daySettings: store.daySettings,
    defaultOpensAt: store.defaultOpensAt,
    defaultClosesAt: store.defaultClosesAt,
    stations: store.stations.map((s) => ({ id: s.id, name: s.name, opensAt: s.opensAt, closesAt: s.closesAt })),
    availabilityDeadline: store.availabilityDeadline,
    locked: isAvailabilityLocked(store) || collectingPublished,
    scheduleVisible: (store.publishedMonths || []).length > 0,
    unavailableDays: latestSub?.unavailableDays || [],
    submittedAt: latestSub?.submittedAt || null,
    confirmedSchedule: workerScheduleData(store, worker),
    pendingRequests,
    fullSchedule: Object.keys(publishedTables).length ? publishedTables : null,
    myHourLogs: sanitizeHourLogsForWorker(store, worker.id),
  };
}

// Who could cover a shift on each published day — for when someone drops out
// last minute and the operator needs to find a replacement to call. Excludes
// anyone already rostered that day or who reported being unavailable.
function operatorFreeWorkers(store) {
  const stationName = new Map(store.stations.map((s) => [s.id, s.name]));

  // Rostered shift count across all published months, so the least-loaded
  // person is offered first rather than the same few being called repeatedly.
  const shiftCount = new Map();
  for (const w of store.workers) shiftCount.set(w.id, 0);
  for (const month of store.publishedMonths || []) {
    const sched = effectiveSchedule(store, month);
    for (const stations of Object.values(sched)) {
      for (const wids of Object.values(stations)) {
        for (const id of wids) shiftCount.set(id, (shiftCount.get(id) || 0) + 1);
      }
    }
  }

  const result = {};
  for (const month of store.publishedMonths || []) {
    const sched = effectiveSchedule(store, month);
    const latestSub = latestSubmissionsFor(store, month);
    for (const date of [...periodFor(store, month).openDays].sort()) {
      const assigned = new Set();
      for (const st of store.stations) {
        for (const id of sched[date]?.[st.id] || []) assigned.add(id);
      }
      result[date] = store.workers
        .filter((w) => {
          if (assigned.has(w.id)) return false;
          if (latestSub.get(w.id)?.unavailableDays?.includes(date)) return false;
          return true;
        })
        .map((w) => ({
          id: w.id,
          name: w.name,
          stations: (w.allowedStations || []).map((sid) => stationName.get(sid)).filter(Boolean),
          shifts: shiftCount.get(w.id) || 0,
        }))
        .sort((a, b) => a.shifts - b.shifts || a.name.localeCompare(b.name, 'sk'));
    }
  }
  return result;
}

// Every published month, so the operator keeps seeing the live roster even
// once the admin has moved on to planning the next month.
function operatorScheduleView(store) {
  const workerMap = new Map(store.workers.map((w) => [w.id, w.name]));
  const result = {};
  for (const month of store.publishedMonths || []) {
    const sched = effectiveSchedule(store, month);
    for (const date of [...periodFor(store, month).openDays].sort()) {
      result[date] = {};
      const dayOv = store.daySettings?.[date]?.stationOverrides || {};
      for (const station of store.stations) {
        const ov = dayOv[station.id];
        const needed = ov !== undefined ? (ov.required ?? station.required ?? 1) : (station.required || 1);
        const wids = sched[date]?.[station.id] || [];
        result[date][station.id] = {
          stationName: ov?.mergedLabel || station.name,
          hidden: needed === 0,
          opensAt: station.opensAt || store.daySettings?.[date]?.opensAt || store.defaultOpensAt,
          closesAt: station.closesAt || store.daySettings?.[date]?.closesAt || store.defaultClosesAt,
          workers: wids.map((id) => workerMap.get(id) || id),
        };
      }
    }
  }
  return result;
}

function adminView(store) {
  const workerMap = new Map(store.workers.map((w) => [w.id, w.name]));
  const sched = effectiveSchedule(store);
  const latestSub = latestSubmissionsFor(store, store.month);

  const scheduleWithNames = {};
  for (const date of store.openDays) {
    scheduleWithNames[date] = { _free: [] };
    const assigned = new Set();

    const dayOv = store.daySettings?.[date]?.stationOverrides || {};
    for (const station of store.stations) {
      const ov = dayOv[station.id];
      const needed = ov !== undefined ? (ov.required ?? station.required ?? 1) : (station.required || 1);
      const wids = sched[date]?.[station.id] || [];
      wids.forEach((id) => assigned.add(id));
      scheduleWithNames[date][station.id] = {
        stationName: ov?.mergedLabel || station.name,
        needed,
        hidden: needed === 0,
        mergeWith: ov?.mergeWith || null,
        opensAt: station.opensAt || store.daySettings?.[date]?.opensAt || store.defaultOpensAt,
        closesAt: station.closesAt || store.daySettings?.[date]?.closesAt || store.defaultClosesAt,
        workerIds: wids,
        workerNames: wids.map((id) => workerMap.get(id) || id),
      };
    }

    scheduleWithNames[date]._free = store.workers
      .filter((w) => {
        if (assigned.has(w.id)) return false;
        const sub = latestSub.get(w.id);
        if (sub?.unavailableDays?.includes(date)) return false;
        return true;
      })
      .map((w) => ({ id: w.id, name: w.name }));
  }

  return {
    ...store,
    workers: store.workers.map((w) => ({
      id: w.id,
      name: w.name,
      token: w.token,
      hasPassword: !!w.passwordHash,
      allowedStations: w.allowedStations || [],
      submitted: latestSub.has(w.id),
      submittedAt: latestSub.get(w.id)?.submittedAt || null,
      submissionId: latestSub.get(w.id)?.id || null,
      unavailableDays: latestSub.get(w.id)?.unavailableDays || [],
    })),
    operators: (store.operators || []).map((o) => ({
      id: o.id,
      name: o.name,
      token: o.token,
      hasPassword: !!o.passwordHash,
    })),
    scheduleWithNames,
    workerHours: Object.fromEntries([...computeWorkerHours(store)].map(([wid, v]) => [wid, v])),
    changeRequests: store.changeRequests || [],
    // Only months worth offering as a switch target: the current one, any
    // published one, and any that actually has days set up.
    knownMonths: [...new Set([
      store.month,
      ...(store.publishedMonths || []),
      ...Object.entries(store.periods || {})
        .filter(([, p]) => (p.openDays || []).length > 0)
        .map(([m]) => m),
    ])].filter(Boolean).sort(),
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

function computeWorkerHours(store) {
  const sched = effectiveSchedule(store);
  const hours = new Map();
  for (const w of store.workers) hours.set(w.id, { shifts: 0, hours: 0 });
  for (const date of Object.keys(sched)) {
    const dayOv = store.daySettings?.[date]?.stationOverrides || {};
    for (const station of store.stations) {
      const ov = dayOv[station.id];
      const needed = ov !== undefined ? (ov.required ?? station.required ?? 1) : (station.required || 1);
      if (needed === 0) continue;
      const wids = sched[date]?.[station.id] || [];
      const shiftHours = getShiftHours(store, date, station);
      for (const wid of wids) {
        const entry = hours.get(wid) || { shifts: 0, hours: 0 };
        entry.shifts += 1;
        entry.hours += shiftHours;
        hours.set(wid, entry);
      }
    }
  }
  return hours;
}

function exportHoursCSV(store) {
  const hours = computeWorkerHours(store);
  const lines = ['Meno,Počet zmien,Odpracované hodiny'];
  for (const w of store.workers) {
    const entry = hours.get(w.id) || { shifts: 0, hours: 0 };
    lines.push([`"${w.name}"`, entry.shifts, entry.hours.toFixed(1)].join(','));
  }
  return lines.join('\n');
}

// Actual reported+approved hours report (worker × day grid + discrepancy sheet)
async function exportActualHoursXLSX(store) {
  const wb = new ExcelJS.Workbook();
  const logs = store.hourLogs || [];
  const approvedLogs = logs.filter((h) => h.status === 'approved');
  const sortedDays = [...store.openDays].sort();

  const ws = wb.addWorksheet('Hodiny');
  const headerRow = ['Brigádnik', ...sortedDays.map((d) => d.slice(8, 10) + '.' + d.slice(5, 7) + '.'), 'Spolu'];
  ws.addRow(headerRow);
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF6B35' } };

  for (const w of store.workers) {
    const byDay = new Map();
    let total = 0;
    for (const log of approvedLogs) {
      if (log.workerId !== w.id) continue;
      const h = hoursBetween(log.approvedStart, log.approvedEnd);
      byDay.set(log.date, (byDay.get(log.date) || 0) + h);
      total += h;
    }
    if (total === 0) continue;
    const row = [w.name, ...sortedDays.map((d) => (byDay.has(d) ? Number(byDay.get(d).toFixed(1)) : '')), Number(total.toFixed(1))];
    ws.addRow(row);
  }
  ws.columns.forEach((col, i) => { col.width = i === 0 ? 22 : 8; });
  ws.getColumn(headerRow.length).font = { bold: true };

  const wsDisc = wb.addWorksheet('Rozpory');
  wsDisc.addRow(['Brigádnik', 'Dátum', 'Stanovisko', 'Nahlásené', 'Schválené', 'Rozdiel (h)', 'Schválil']);
  wsDisc.getRow(1).font = { bold: true };
  wsDisc.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF6B35' } };

  const stationMap = new Map(store.stations.map((s) => [s.id, s.name]));
  for (const log of approvedLogs) {
    if (log.reportedStart === log.approvedStart && log.reportedEnd === log.approvedEnd) continue;
    const reportedH = hoursBetween(log.reportedStart, log.reportedEnd);
    const approvedH = hoursBetween(log.approvedStart, log.approvedEnd);
    wsDisc.addRow([
      log.workerName,
      log.date,
      stationMap.get(log.stationId) || log.stationId,
      `${log.reportedStart}–${log.reportedEnd}`,
      `${log.approvedStart}–${log.approvedEnd}`,
      Number((approvedH - reportedH).toFixed(1)),
      log.approvedByName || '',
    ]);
  }
  wsDisc.columns.forEach((col) => { col.width = 20; });

  return wb.xlsx.writeBuffer();
}

function exportSubmissionsCSV(store) {
  const latestSub = new Map();
  for (const sub of store.submissions) {
    const ex = latestSub.get(sub.workerId);
    if (!ex || sub.submittedAt > ex.submittedAt) latestSub.set(sub.workerId, sub);
  }
  const lines = ['Meno,Odoslané,Nedostupné dni'];
  for (const w of store.workers) {
    const sub = latestSub.get(w.id);
    lines.push([
      `"${w.name}"`,
      sub ? `"${sub.submittedAt.slice(0, 10)}"` : '"Neodoslané"',
      sub ? `"${(sub.unavailableDays || []).join(', ')}"` : '""',
    ].join(','));
  }
  return lines.join('\n');
}

function exportScheduleCSV(store) {
  const sched = effectiveSchedule(store);
  const workerMap = new Map(store.workers.map((w) => [w.id, w.name]));
  const lines = ['Dátum,Stanovisko,Čas,Brigádnici'];
  for (const date of [...store.openDays].sort()) {
    const dayOv = store.daySettings?.[date]?.stationOverrides || {};
    for (const station of store.stations) {
      const ov = dayOv[station.id];
      const needed = ov !== undefined ? (ov.required ?? station.required ?? 1) : (station.required || 1);
      if (needed === 0) continue;
      const wids = sched[date]?.[station.id] || [];
      const opensAt = station.opensAt || store.daySettings?.[date]?.opensAt || store.defaultOpensAt;
      const closesAt = station.closesAt || store.daySettings?.[date]?.closesAt || store.defaultClosesAt;
      lines.push([
        `"${date}"`,
        `"${ov?.mergedLabel || station.name}"`,
        `"${opensAt}–${closesAt}"`,
        `"${wids.map((id) => workerMap.get(id) || id).join(', ')}"`,
      ].join(','));
    }
  }
  return lines.join('\n');
}

async function exportScheduleXLSX(store) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Rozpis');
  const sched = effectiveSchedule(store);
  const workerMap = new Map(store.workers.map((w) => [w.id, w.name]));

  ws.addRow(['Dátum', 'Stanovisko', 'Od', 'Do', 'Brigádnici']);
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF6B35' } };

  for (const date of [...store.openDays].sort()) {
    const dayOv = store.daySettings?.[date]?.stationOverrides || {};
    for (const station of store.stations) {
      const ov = dayOv[station.id];
      const needed = ov !== undefined ? (ov.required ?? station.required ?? 1) : (station.required || 1);
      if (needed === 0) continue;
      const wids = sched[date]?.[station.id] || [];
      const opensAt = station.opensAt || store.daySettings?.[date]?.opensAt || store.defaultOpensAt;
      const closesAt = station.closesAt || store.daySettings?.[date]?.closesAt || store.defaultClosesAt;
      ws.addRow([
        date,
        ov?.mergedLabel || station.name,
        opensAt,
        closesAt,
        wids.map((id) => workerMap.get(id) || id).join(', '),
      ]);
    }
  }

  ws.columns.forEach((col) => { col.width = 22; });
  return wb.xlsx.writeBuffer();
}

// ─── PDF Print Export (HTML) ──────────────────────────────────────────────────

function exportSchedulePrintHTML(store) {
  const sched = effectiveSchedule(store);
  const workerMap = new Map(store.workers.map((w) => [w.id, w.name]));

  const PASTEL = [
    '#FFD6D6','#D5F5E3','#D6EAF8','#FDEBD0','#E8DAEF',
    '#D1F2EB','#FCF3CF','#FADBD8','#EBF5FB','#F9EBEA',
    '#D4EFDF','#D2B4DE','#AED6F1','#FAD7A0','#A9DFBF',
    '#F1948A','#85C1E9','#82E0AA','#F8C471','#BB8FCE',
  ];
  const workerColors = new Map();
  let ci = 0;
  for (const w of store.workers) {
    workerColors.set(w.id, PASTEL[ci++ % PASTEL.length]);
  }
  // also assign colors by name for workers not in store (legacy data)
  const nameColors = new Map();
  for (const [id, color] of workerColors) {
    nameColors.set(workerMap.get(id), color);
  }

  const DAY_SK = ['Nedeľa','Pondelok','Utorok','Streda','Štvrtok','Piatok','Sobota'];
  const MONTH_SK = ['január','február','marec','apríl','máj','jún','júl','august','september','október','november','december'];

  const sortedDays = [...store.openDays].sort();
  if (!sortedDays.length) return '<p>Žiadne otvorené dni.</p>';

  // Group by ISO week (Mon=start)
  function isoWeekKey(iso) {
    const d = new Date(iso + 'T12:00:00');
    const day = d.getDay() || 7;
    const mon = new Date(d); mon.setDate(d.getDate() - day + 1);
    return mon.toISOString().slice(0, 10);
  }
  const weekMap = new Map();
  for (const date of sortedDays) {
    const key = isoWeekKey(date);
    if (!weekMap.has(key)) weekMap.set(key, []);
    weekMap.get(key).push(date);
  }

  function fmtDay(iso) {
    const d = new Date(iso + 'T12:00:00');
    return `${d.getDate()}. ${d.getMonth() + 1}.`;
  }
  function fmtDayName(iso) {
    const d = new Date(iso + 'T12:00:00');
    return DAY_SK[d.getDay()];
  }

  const firstDay = new Date(sortedDays[0] + 'T12:00:00');
  const monthLabel = `${MONTH_SK[firstDay.getMonth()].toUpperCase()} ${firstDay.getFullYear()}`;

  let pages = '';
  let pageNum = 1;
  for (const [, days] of weekMap) {
    const fromDate = new Date(days[0] + 'T12:00:00');
    const toDate   = new Date(days[days.length - 1] + 'T12:00:00');
    const from = fmtDay(days[0]);
    const to   = fmtDay(days[days.length - 1]);
    const fromYear = fromDate.getFullYear();
    const toYear   = toDate.getFullYear();
    const weekHeader = fromYear === toYear
      ? `TÝŽDEŇ ${from} ${fromYear} &mdash; ${to} ${toYear}`
      : `TÝŽDEŇ ${from} ${fromYear} &mdash; ${to} ${toYear}`;

    // skip stations that are hidden on every day of this week
    const stationsToShow = store.stations.filter((station) => {
      return !days.every((d) => {
        const ov = store.daySettings?.[d]?.stationOverrides?.[station.id];
        return ov !== undefined && (ov.required ?? 1) === 0;
      });
    });

    let colHeaders = `<th class="stn-col">Deň</th>`;
    for (const station of stationsToShow) {
      // station label: use mergedLabel from any day that has it (first found)
      const stnLabel = days.reduce((lbl, d) => {
        return lbl || store.daySettings?.[d]?.stationOverrides?.[station.id]?.mergedLabel || null;
      }, null) || station.name;
      colHeaders += `<th>${stnLabel}</th>`;
    }

    let rows = '';
    for (const d of days) {
      const rowCells = stationsToShow.map((station) => {
        const ov = store.daySettings?.[d]?.stationOverrides?.[station.id];
        const needed = ov !== undefined ? (ov.required ?? station.required ?? 1) : (station.required || 1);
        if (needed === 0) return `<td class="col-empty" title="Zlúčené/zatvorené"></td>`;
        const wids = sched[d]?.[station.id] || [];
        if (wids.length === 0) return `<td></td>`;
        const parts = wids.map((id) => {
          const name = workerMap.get(id) || id;
          const color = workerColors.get(id) || nameColors.get(name) || '#F5F5F5';
          return `<span class="worker-cell" style="background:${color}">${name}</span>`;
        });
        return `<td>${parts.join('')}</td>`;
      });

      rows += `<tr><td class="stn-name"><span class="day-name">${fmtDayName(d)}</span><br>${fmtDay(d)}</td>${rowCells.join('')}</tr>`;
    }

    pages += `
    <div class="week-page">
      <h1 class="doc-title">FLP - ROZPIS ${monthLabel}</h1>
      <div class="week-header">${weekHeader}</div>
      <table><thead><tr>${colHeaders}</tr></thead><tbody>${rows}</tbody></table>
      <div class="page-footer">Strana ${pageNum}</div>
    </div>`;
    pageNum++;
  }

  // Legend page
  let legendRows = '';
  for (const [id, color] of workerColors) {
    const name = workerMap.get(id);
    if (!name) continue;
    legendRows += `<tr><td class="legend-name" style="background:${color}">${name}</td><td style="background:${color}"></td></tr>`;
  }

  const legendPage = `
  <div class="week-page">
    <h1 class="doc-title">FLP - FARBY BRIGÁDNIKOV</h1>
    <table class="legend-table">
      <thead><tr><th>Brigádnik</th><th>Farba</th></tr></thead>
      <tbody>${legendRows}</tbody>
    </table>
    <div class="page-footer">Strana ${pageNum}</div>
  </div>`;

  return `<!DOCTYPE html>
<html lang="sk">
<head>
<meta charset="UTF-8">
<title>FLP - Rozpis ${monthLabel}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, Helvetica, sans-serif; background: #fff; color: #1a3a6b; }

  .no-print { display: flex; gap: 10px; padding: 14px 20px; background: #f0f4ff; border-bottom: 2px solid #1a3a6b; }
  .no-print button { padding: 8px 20px; background: #1a3a6b; color: #fff; border: none; border-radius: 6px; font-size: 14px; cursor: pointer; font-weight: bold; }
  .no-print button:hover { background: #0c2372; }
  .no-print span { align-self: center; font-size: 13px; color: #555; }

  .week-page { padding: 28px 36px 20px; page-break-after: always; }
  .week-page:last-child { page-break-after: auto; }

  .doc-title { text-align: center; font-size: 22px; font-weight: bold; color: #1a3a6b; margin-bottom: 18px; letter-spacing: .5px; }

  .week-header { background: #1a3a6b; color: #fff; text-align: center; font-size: 14px; font-weight: bold; padding: 10px 0; border-radius: 4px 4px 0 0; letter-spacing: .3px; }

  table { width: 100%; border-collapse: collapse; border: 1.5px solid #5b8fc0; }
  thead tr th { background: #4a7fad; color: #fff; font-size: 12px; font-weight: bold; text-align: center; padding: 8px 6px; border: 1px solid #5b8fc0; }
  th.stn-col { width: 130px; }
  tbody tr td { padding: 6px 6px; border: 1px solid #c8d8e8; text-align: center; vertical-align: middle; font-size: 11.5px; }
  td.stn-name { font-weight: bold; background: #f0f4fa; text-align: left; padding-left: 10px; }

  .worker-cell { display: block; font-weight: bold; padding: 3px 5px; border-radius: 3px; margin: 2px auto; font-size: 11px; }
  .day-name { font-size: 11px; display: block; }

  .legend-table { max-width: 500px; margin: 0 auto; }
  .legend-table th { font-size: 13px; padding: 10px 14px; }
  .legend-table td { padding: 7px 14px; font-size: 12px; }
  td.legend-name { font-weight: bold; text-align: center; }

  .col-empty { background: #f8f9fa !important; border-color: #e0e4ea !important; }
  th.col-empty { background: #3a6a9a !important; }

  .page-footer { text-align: center; font-size: 11px; color: #888; margin-top: 14px; }

  @media print {
    .no-print { display: none !important; }
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .week-page { padding: 12px 16px 8px; }
    .doc-title { font-size: 17px; margin-bottom: 10px; }
    @page { size: A4 landscape; margin: 10mm 12mm; }
  }
</style>
</head>
<body>
<div class="no-print">
  <button onclick="window.print()">🖨 Tlačiť / Uložiť ako PDF</button>
  <span>V dialógu tlačiarne zvoľ "Uložiť ako PDF" · Orientácia: Na šírku (Landscape)</span>
</div>
${pages}
${legendPage}
</body>
</html>`;
}

// ─── HTTP Utilities ───────────────────────────────────────────────────────────

function getCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v || '');
  }
  return null;
}

function parseBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
  });
}

function respond(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function requireAdmin(req, res) {
  if (!getSession(getCookie(req, 'session'))) {
    respond(res, 401, { error: 'Nie si prihlásený' });
    return false;
  }
  return true;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

// ─── Request Handler ──────────────────────────────────────────────────────────

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();

  // Health
  if (req.method === 'GET' && p === '/api/health') {
    return respond(res, 200, { ok: true, storage: pool ? 'postgres' : 'json' });
  }

  // Public config
  if (req.method === 'GET' && p === '/api/public-config') {
    const store = await getStore();
    return respond(res, 200, {
      month: store.month,
      periodStart: store.periodStart,
      periodEnd: store.periodEnd,
      availabilityDeadline: store.availabilityDeadline,
    });
  }

  // Login / Logout / Session
  if (req.method === 'POST' && p === '/api/login') {
    if (!checkRateLimit(`login:${ip}`, 10, 15 * 60 * 1000)) {
      return respond(res, 429, { error: 'Príliš veľa pokusov. Skúste o 15 minút.' });
    }
    const body = await parseBody(req);
    if (body.password !== ADMIN_PASSWORD) {
      return respond(res, 401, { error: 'Nesprávne heslo' });
    }
    const token = createSession();
    res.setHeader('Set-Cookie', `session=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=43200`);
    return respond(res, 200, { ok: true });
  }

  if (req.method === 'POST' && p === '/api/logout') {
    const token = getCookie(req, 'session');
    if (token) deleteSession(token);
    res.setHeader('Set-Cookie', 'session=; HttpOnly; Path=/; Max-Age=0');
    return respond(res, 200, { ok: true });
  }

  if (req.method === 'GET' && p === '/api/session') {
    return respond(res, 200, { loggedIn: Boolean(getSession(getCookie(req, 'session'))) });
  }

  // Worker — GET info
  const workerM = p.match(/^\/api\/worker\/([a-zA-Z0-9]+)$/);
  if (workerM) {
    const store = await getStore();
    const worker = store.workers.find((w) => w.token === workerM[1]);
    if (!worker) return respond(res, 404, { error: 'Odkaz neexistuje' });
    if (req.method === 'GET') return respond(res, 200, publicWorkerStore(store, worker));
    return respond(res, 405, { error: 'Method Not Allowed' });
  }

  // Worker — access (password check)
  const workerAccessM = p.match(/^\/api\/worker\/([a-zA-Z0-9]+)\/access$/);
  if (workerAccessM && req.method === 'POST') {
    const store = await getStore();
    const worker = store.workers.find((w) => w.token === workerAccessM[1]);
    if (!worker) return respond(res, 404, { error: 'Odkaz neexistuje' });
    if (!worker.passwordHash) return respond(res, 200, { ok: true });
    if (!checkRateLimit(`waccess:${worker.id}:${ip}`, 5, 15 * 60 * 1000)) {
      return respond(res, 429, { error: 'Príliš veľa pokusov' });
    }
    const body = await parseBody(req);
    if (!verifyPassword(worker.passwordHash, body.password || '')) {
      return respond(res, 401, { error: 'Nesprávne heslo' });
    }
    return respond(res, 200, { ok: true });
  }

  // Worker — submit availability
  const workerSubM = p.match(/^\/api\/worker\/([a-zA-Z0-9]+)\/submission$/);
  if (workerSubM && req.method === 'PUT') {
    const store = await getStore();
    const worker = store.workers.find((w) => w.token === workerSubM[1]);
    if (!worker) return respond(res, 404, { error: 'Odkaz neexistuje' });
    if (isMonthPublished(store, store.month) || isAvailabilityLocked(store)) {
      return respond(res, 403, { error: 'Odovzdávanie dostupnosti je uzamknuté' });
    }
    const body = await parseBody(req);
    await mutateStore((s) => {
      s.submissions.push({
        id: generateToken(),
        workerId: worker.id,
        workerName: worker.name,
        month: s.month,
        unavailableDays: Array.isArray(body.unavailableDays) ? body.unavailableDays : [],
        submittedAt: new Date().toISOString(),
      });
    });
    return respond(res, 200, { ok: true });
  }

  // Worker — change request
  const changeReqM = p.match(/^\/api\/worker\/([a-zA-Z0-9]+)\/change-request$/);
  if (changeReqM && req.method === 'POST') {
    const store = await getStore();
    const worker = store.workers.find((w) => w.token === changeReqM[1]);
    if (!worker) return respond(res, 404, { error: 'Odkaz neexistuje' });
    const body = await parseBody(req);
    await mutateStore((s) => {
      if (!s.changeRequests) s.changeRequests = [];
      s.changeRequests.push({
        id: generateToken(),
        workerId: worker.id,
        workerName: worker.name,
        days: body.days || [],
        reason: body.reason || '',
        status: 'pending',
        requestedAt: new Date().toISOString(),
      });
    });
    return respond(res, 200, { ok: true });
  }

  // Worker — report hours worked (own shift, or as a substitute for someone else)
  const workerHoursM = p.match(/^\/api\/worker\/([a-zA-Z0-9]+)\/hours$/);
  if (workerHoursM && req.method === 'POST') {
    const store = await getStore();
    const worker = store.workers.find((w) => w.token === workerHoursM[1]);
    if (!worker) return respond(res, 404, { error: 'Odkaz neexistuje' });
    if (!(store.publishedMonths || []).length) return respond(res, 400, { error: 'Rozpis ešte nie je zverejnený' });
    const body = await parseBody(req);
    const date = body.date;
    const stationId = body.stationId;
    const substituteFor = body.substituteFor || null;
    const start = body.start;
    const end = body.end;
    if (!date || !stationId || !start || !end) return respond(res, 400, { error: 'Chýbajú údaje' });
    if (!publishedOpenDays(store).has(date)) return respond(res, 400, { error: 'Neplatný dátum' });

    const existing = (store.hourLogs || []).find(
      (h) => h.date === date && h.stationId === stationId && h.workerId === worker.id
    );
    // First-time entries can only be logged on the actual day of the shift.
    // Corrections to an already-reported entry (pending or approved) are
    // always allowed — they just re-open it for a fresh operator approval.
    if (!existing && date !== todayISO()) {
      return respond(res, 400, { error: 'Hodiny môžeš zapísať len v deň zmeny.' });
    }

    await mutateStore((s) => {
      if (!s.hourLogs) s.hourLogs = [];
      const substituteWorker = substituteFor ? s.workers.find((w) => w.id === substituteFor) : null;
      const entry = {
        id: existing ? existing.id : generateToken(),
        date,
        stationId,
        workerId: worker.id,
        workerName: worker.name,
        substituteFor: substituteFor || null,
        substituteForName: substituteWorker?.name || null,
        reportedStart: start,
        reportedEnd: end,
        reportedAt: new Date().toISOString(),
        status: 'pending',
        approvedStart: null,
        approvedEnd: null,
        approvedBy: null,
        approvedByName: null,
        approvedAt: null,
      };
      const idx = s.hourLogs.findIndex((h) => h.id === entry.id);
      if (idx >= 0) s.hourLogs[idx] = entry;
      else s.hourLogs.push(entry);
    });

    const fresh = await getStore();
    const freshWorker = fresh.workers.find((w) => w.id === worker.id);
    return respond(res, 200, publicWorkerStore(fresh, freshWorker));
  }

  // Operator — GET schedule
  const operatorM = p.match(/^\/api\/operator\/([a-zA-Z0-9]+)$/);
  if (operatorM && req.method === 'GET') {
    const store = await getStore();
    const op = (store.operators || []).find((o) => o.token === operatorM[1]);
    if (!op) return respond(res, 404, { error: 'Odkaz neexistuje' });
    return respond(res, 200, {
      operatorId: op.id,
      operatorName: op.name,
      hasPassword: !!op.passwordHash,
      schedulePublished: (store.publishedMonths || []).length > 0,
      month: (store.publishedMonths || []).join(', ') || store.month,
      stations: store.stations,
      openDays: [...publishedOpenDays(store)].sort(),
      schedule: operatorScheduleView(store),
      freeWorkers: operatorFreeWorkers(store),
      hourLogs: sanitizeHourLogsForOperator(store),
    });
  }

  // Operator — access
  const operatorAccessM = p.match(/^\/api\/operator\/([a-zA-Z0-9]+)\/access$/);
  if (operatorAccessM && req.method === 'POST') {
    const store = await getStore();
    const op = (store.operators || []).find((o) => o.token === operatorAccessM[1]);
    if (!op) return respond(res, 404, { error: 'Odkaz neexistuje' });
    if (!op.passwordHash) return respond(res, 200, { ok: true });
    if (!checkRateLimit(`oaccess:${op.id}:${ip}`, 5, 15 * 60 * 1000)) {
      return respond(res, 429, { error: 'Príliš veľa pokusov' });
    }
    const body = await parseBody(req);
    if (!verifyPassword(op.passwordHash, body.password || '')) {
      return respond(res, 401, { error: 'Nesprávne heslo' });
    }
    return respond(res, 200, { ok: true });
  }

  // Operator — approve an hour log entry
  const opApproveM = p.match(/^\/api\/operator\/([a-zA-Z0-9]+)\/hours\/([^/]+)\/approve$/);
  if (opApproveM && req.method === 'POST') {
    const store = await getStore();
    const op = (store.operators || []).find((o) => o.token === opApproveM[1]);
    if (!op) return respond(res, 404, { error: 'Odkaz neexistuje' });
    const body = await parseBody(req);
    const start = body.start;
    const end = body.end;
    if (!start || !end) return respond(res, 400, { error: 'Chýba čas' });

    await mutateStore((s) => {
      const entry = (s.hourLogs || []).find((h) => h.id === opApproveM[2]);
      if (!entry) return;
      entry.approvedStart = start;
      entry.approvedEnd = end;
      entry.approvedBy = op.id;
      entry.approvedByName = op.name;
      entry.approvedAt = new Date().toISOString();
      entry.status = 'approved';
    });

    const fresh = await getStore();
    return respond(res, 200, { ok: true, hourLogs: sanitizeHourLogsForOperator(fresh) });
  }

  // Admin — full store
  if (req.method === 'GET' && p === '/api/admin') {
    if (!requireAdmin(req, res)) return;
    return respond(res, 200, adminView(await getStore()));
  }

  // Admin — save config
  if (req.method === 'PUT' && p === '/api/config') {
    if (!requireAdmin(req, res)) return;
    const body = await parseBody(req);
    await mutateStore((s) => {
      // Switching months archives the current one and restores the target's
      // own dates — it no longer wipes the period or unpublishes anything.
      if (body.month !== undefined && body.month !== s.month) {
        activateMonth(s, body.month);
      }

      if (body.periodStart !== undefined) s.periodStart = body.periodStart;
      if (body.periodEnd !== undefined) s.periodEnd = body.periodEnd;
      if (body.availabilityDeadline !== undefined) s.availabilityDeadline = body.availabilityDeadline;
      if (body.defaultOpensAt !== undefined) s.defaultOpensAt = body.defaultOpensAt;
      if (body.defaultClosesAt !== undefined) s.defaultClosesAt = body.defaultClosesAt;
      if (Array.isArray(body.openDays)) s.openDays = body.openDays;
      if (body.daySettings !== undefined) s.daySettings = body.daySettings;
      snapshotCurrentPeriod(s);

      if (Array.isArray(body.stations)) {
        const existById = new Map(s.stations.map((st) => [st.id, st]));
        s.stations = body.stations.map((st) => {
          const ex = existById.get(st.id) || {};
          return {
            id: st.id || crypto.randomBytes(6).toString('hex'),
            name: st.name,
            required: Number(st.required) || 1,
            opensAt: st.opensAt !== undefined ? st.opensAt : (ex.opensAt || ''),
            closesAt: st.closesAt !== undefined ? st.closesAt : (ex.closesAt || ''),
          };
        });
      }

      if (Array.isArray(body.workers)) {
        const existById = new Map(s.workers.map((w) => [w.id, w]));
        s.workers = body.workers.map((w) => {
          const ex = existById.get(w.id) || {};
          const updated = {
            id: w.id || crypto.randomBytes(8).toString('hex'),
            name: w.name,
            token: ex.token || generateToken(),
            passwordHash: ex.passwordHash || null,
            allowedStations: w.allowedStations || [],
          };
          if (w.password) updated.passwordHash = hashPassword(w.password);
          else if (w.password === null) updated.passwordHash = null;
          return updated;
        });
      }

      if (Array.isArray(body.groups)) s.groups = body.groups;
      if (body.activeGroup !== undefined) s.activeGroup = body.activeGroup;

      if (Array.isArray(body.operators)) {
        const existById = new Map((s.operators || []).map((o) => [o.id, o]));
        s.operators = body.operators.map((o) => {
          const ex = existById.get(o.id) || {};
          const updated = {
            id: o.id || crypto.randomBytes(8).toString('hex'),
            name: o.name,
            token: ex.token || generateToken(),
            passwordHash: ex.passwordHash || null,
          };
          if (o.password) updated.passwordHash = hashPassword(o.password);
          else if (o.password === null) updated.passwordHash = null;
          return updated;
        });
      }
    });
    return respond(res, 200, adminView(await getStore()));
  }

  // Admin — generate schedule
  if (req.method === 'PUT' && p === '/api/schedule') {
    if (!requireAdmin(req, res)) return;
    const body = await parseBody(req);
    await mutateStore((s) => {
      if (!s.schedule) s.schedule = {};
      s.schedule[s.month] = generateSchedule(s);
      setMonthPublished(s, s.month, false);
      if (body.discardManual) {
        if (!s.manualAssignments) s.manualAssignments = {};
        s.manualAssignments[s.month] = {};
      }
    });
    return respond(res, 200, adminView(await getStore()));
  }

  // Admin — manual assignments
  if (req.method === 'PUT' && p === '/api/manual-assignments') {
    if (!requireAdmin(req, res)) return;
    const body = await parseBody(req);
    await mutateStore((s) => {
      if (!s.manualAssignments) s.manualAssignments = {};
      if (!s.manualAssignments[s.month]) s.manualAssignments[s.month] = {};
      for (const [date, stations] of Object.entries(body.assignments || {})) {
        if (!s.manualAssignments[s.month][date]) s.manualAssignments[s.month][date] = {};
        for (const [stationId, workerIds] of Object.entries(stations)) {
          s.manualAssignments[s.month][date][stationId] = workerIds;
        }
      }
      setMonthPublished(s, s.month, false);
    });
    return respond(res, 200, adminView(await getStore()));
  }

  // Admin — publish / unpublish the month currently being edited
  if (req.method === 'PUT' && p === '/api/schedule-publication') {
    if (!requireAdmin(req, res)) return;
    const body = await parseBody(req);
    await mutateStore((s) => {
      snapshotCurrentPeriod(s);
      setMonthPublished(s, s.month, Boolean(body.published));
    });
    return respond(res, 200, { ok: true, schedulePublished: Boolean(body.published) });
  }

  // Admin — delete submission
  const delSubM = p.match(/^\/api\/submissions\/([^/]+)$/);
  if (delSubM && req.method === 'DELETE') {
    if (!requireAdmin(req, res)) return;
    await mutateStore((s) => { s.submissions = s.submissions.filter((sub) => sub.id !== delSubM[1]); });
    return respond(res, 200, { ok: true });
  }

  // Admin — approve change request
  const approveM = p.match(/^\/api\/change-requests\/([^/]+)\/approve$/);
  if (approveM && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    await mutateStore((s) => {
      const cr = (s.changeRequests || []).find((r) => r.id === approveM[1]);
      if (!cr) return;
      cr.status = 'approved';
      cr.resolvedAt = new Date().toISOString();
      const worker = s.workers.find((w) => w.id === cr.workerId);
      if (worker) {
        s.submissions.push({
          id: generateToken(),
          workerId: worker.id,
          workerName: worker.name,
          unavailableDays: cr.days || [],
          submittedAt: new Date().toISOString(),
        });
      }
    });
    return respond(res, 200, { ok: true });
  }

  // Admin — reject change request
  const rejectM = p.match(/^\/api\/change-requests\/([^/]+)\/reject$/);
  if (rejectM && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    await mutateStore((s) => {
      const cr = (s.changeRequests || []).find((r) => r.id === rejectM[1]);
      if (cr) { cr.status = 'rejected'; cr.resolvedAt = new Date().toISOString(); }
    });
    return respond(res, 200, { ok: true });
  }

  // Exports
  if (req.method === 'GET' && p === '/api/export/submissions.csv') {
    if (!requireAdmin(req, res)) return;
    const store = await getStore();
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="submissions.csv"' });
    return res.end('﻿' + exportSubmissionsCSV(store));
  }

  if (req.method === 'GET' && p === '/api/export/hours.csv') {
    if (!requireAdmin(req, res)) return;
    const store = await getStore();
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="hodiny.csv"' });
    return res.end('﻿' + exportHoursCSV(store));
  }

  if (req.method === 'GET' && p === '/api/export/actual-hours.xlsx') {
    if (!requireAdmin(req, res)) return;
    const store = await getStore();
    const buffer = await exportActualHoursXLSX(store);
    res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="skutocne-hodiny.xlsx"' });
    return res.end(buffer);
  }

  if (req.method === 'GET' && p === '/api/export/schedule.csv') {
    if (!requireAdmin(req, res)) return;
    const store = await getStore();
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="schedule.csv"' });
    return res.end('﻿' + exportScheduleCSV(store));
  }

  if (req.method === 'GET' && p === '/api/export/schedule.xlsx') {
    if (!requireAdmin(req, res)) return;
    const store = await getStore();
    const buffer = await exportScheduleXLSX(store);
    res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="schedule.xlsx"' });
    return res.end(buffer);
  }

  // Agent data endpoint — read-only, requires AGENT_API_KEY header
  if (req.method === 'GET' && p === '/api/agent-data') {
    const key = req.headers['x-agent-key'];
    if (!AGENT_API_KEY || key !== AGENT_API_KEY) {
      return respond(res, 401, { error: 'Neplatný agent kľúč' });
    }
    const store = await getStore();
    const sched = effectiveSchedule(store);
    const workerMap = new Map(store.workers.map((w) => [w.id, w.name]));
    const latestSub = new Map();
    for (const sub of store.submissions) {
      const ex = latestSub.get(sub.workerId);
      if (!ex || sub.submittedAt > ex.submittedAt) latestSub.set(sub.workerId, sub);
    }
    const scheduleTable = {};
    for (const date of store.openDays) {
      scheduleTable[date] = {};
      for (const station of store.stations) {
        const wids = sched[date]?.[station.id] || [];
        scheduleTable[date][station.name] = wids.map((id) => workerMap.get(id) || id);
      }
    }
    const hoursMap = computeWorkerHours(store);
    return respond(res, 200, {
      month: store.month,
      periodStart: store.periodStart,
      periodEnd: store.periodEnd,
      schedulePublished: store.schedulePublished,
      stations: store.stations.map((s) => s.name),
      shiftCounts: store.workers.map((w) => ({
        name: w.name,
        shifts: hoursMap.get(w.id)?.shifts || 0,
        hours: Number((hoursMap.get(w.id)?.hours || 0).toFixed(1)),
      })).sort((a, b) => b.hours - a.hours),
      workers: store.workers.map((w) => ({
        name: w.name,
        submitted: !!latestSub.get(w.id),
        unavailableDays: latestSub.get(w.id)?.unavailableDays || [],
      })),
      schedule: scheduleTable,
      changeRequests: store.changeRequests.map((r) => ({
        worker: r.workerName, days: r.days, reason: r.reason, status: r.status,
      })),
    });
  }

  // Claude agent chat
  if (req.method === 'POST' && p === '/api/agent-chat') {
    if (!requireAdmin(req, res)) return;
    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    if (!ANTHROPIC_API_KEY) return respond(res, 503, { error: 'ANTHROPIC_API_KEY nie je nastavený v prostredí servera.' });
    const body = await parseBody(req);
    const question = (body.question || '').trim();
    if (!question) return respond(res, 400, { error: 'Chýba otázka' });

    const store = await getStore();
    const sched = effectiveSchedule(store);
    const workerMap = new Map(store.workers.map(w => [w.id, w.name]));
    const latestSub = new Map();
    for (const sub of store.submissions) {
      const ex = latestSub.get(sub.workerId);
      if (!ex || sub.submittedAt > ex.submittedAt) latestSub.set(sub.workerId, sub);
    }

    const schedLines = [];
    for (const date of [...store.openDays].sort()) {
      for (const st of store.stations) {
        const wids = sched[date]?.[st.id] || [];
        schedLines.push(`${date} | ${st.name}: ${wids.map(id => workerMap.get(id) || id).join(', ') || '—'}`);
      }
    }

    const workerLines = store.workers.map(w => {
      const sub = latestSub.get(w.id);
      return `${w.name}: ${sub ? `nedostupný: ${(sub.unavailableDays||[]).join(', ') || 'žiadne'}` : 'neodovzdal'}`;
    });

    const activeGroupName = store.activeGroup
      ? (store.groups || []).find(g => g.id === store.activeGroup)?.name || store.activeGroup
      : 'všetci';

    const hoursMap = computeWorkerHours(store);
    const hoursLines = store.workers
      .map(w => ({ name: w.name, ...(hoursMap.get(w.id) || { shifts: 0, hours: 0 }) }))
      .sort((a, b) => b.hours - a.hours)
      .map(r => `${r.name}: ${r.shifts} zmien, ${r.hours.toFixed(1)} hodín`);

    const systemPrompt = `Si asistent pre správu smien v zábavnom parku Fantázia. Odpovedaj stručne v slovenčine.

MESIAC: ${store.month} | OBDOBIE: ${store.periodStart} – ${store.periodEnd}
STANOVISKÁ: ${store.stations.map(s => s.name).join(', ')}
BRIGÁDNICI (${store.workers.length}): ${store.workers.map(w => w.name).join(', ')}
SKUPINY: ${(store.groups||[]).map(g => `${g.name} (${(g.workerIds||[]).length} os.): ${(g.workerIds||[]).map(id => workerMap.get(id)||id).join(', ')}`).join(' | ') || 'žiadne'}
AKTÍVNA SKUPINA: ${activeGroupName}
POČET ZMIEN A HODÍN ZA MESIAC (už spočítané, použi tieto čísla, nepočítaj znova zo surového rozpisu nižšie):
${hoursLines.join('\n') || 'Rozpis ešte nebol vygenerovaný.'}
ROZPIS (${store.schedulePublished ? 'zverejnený' : 'nezverejnený'}):
${schedLines.join('\n') || 'Rozpis ešte nebol vygenerovaný.'}
DOSTUPNOSŤ:
${workerLines.join('\n')}`;

    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1024, system: systemPrompt, messages: [{ role: 'user', content: question }] }),
      });
      const data = await r.json();
      if (!r.ok) return respond(res, 502, { error: data.error?.message || 'Chyba Anthropic API' });
      return respond(res, 200, { answer: data.content?.[0]?.text || '' });
    } catch (e) {
      return respond(res, 500, { error: e.message });
    }
  }

  if (req.method === 'GET' && p === '/api/export/schedule-print') {
    if (!requireAdmin(req, res)) return;
    const store = await getStore();
    const html = exportSchedulePrintHTML(store);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  if (req.method === 'GET' && p === '/api/export/backup.json') {
    if (!requireAdmin(req, res)) return;
    const store = await getStore();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="backup.json"' });
    return res.end(JSON.stringify(store, null, 2));
  }

  if (req.method === 'GET' && p === '/api/admin/codex-backups') {
    if (!requireAdmin(req, res)) return;
    if (!pool) return json(res, 400, { error: 'No database connection' });
    try {
      const r = await pool.query(`
        SELECT id, reason, created_at,
               data->'workers' as workers,
               data->'stations' as stations,
               data->'month' as month
        FROM app_backups ORDER BY created_at DESC LIMIT 20
      `);
      const store = await pool.query(`SELECT data FROM app_store WHERE id = 'main'`);
      return json(res, 200, {
        backups: r.rows,
        currentStore: store.rows[0]?.data || null
      });
    } catch(e) {
      return json(res, 500, { error: e.message });
    }
  }

  // Static files
  const publicDir = path.join(__dirname, 'public');
  let filePath = p.startsWith('/api/') ? null : path.join(publicDir, p === '/' ? 'index.html' : p);

  if (filePath) {
    if (!filePath.startsWith(publicDir + path.sep) && filePath !== publicDir) {
      return respond(res, 403, { error: 'Forbidden' });
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      return fs.createReadStream(filePath).pipe(res);
    }
    // SPA fallback for client-side routes
    if (!p.includes('.')) {
      const idx = path.join(publicDir, 'index.html');
      if (fs.existsSync(idx)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return fs.createReadStream(idx).pipe(res);
      }
    }
  }

  respond(res, 404, { error: 'Nenájdené' });
}

// ─── Start ────────────────────────────────────────────────────────────────────

async function start() {
  if (pool) await ensureTable();
  const server = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res);
    } catch (err) {
      console.error('Chyba požiadavky:', err);
      if (!res.headersSent) respond(res, 500, { error: 'Interná chyba servera' });
    }
  });
  server.listen(PORT, HOST, () => {
    console.log(`Fantazia Shift Planner running at http://${HOST}:${PORT}`);
    console.log(`Storage: ${pool ? 'postgres' : 'json'}`);
  });
}

start().catch((err) => { console.error('Startup error:', err); process.exit(1); });
