(function () {
  'use strict';

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js'));
  }

  // ─── State ────────────────────────────────────────────────────────────────
  const S = {
    view: null, token: null, data: null,
    authed: false,
    tab: 'settings',
    selectedDays: new Set(),  // worker: unavailable days
    openDays: new Set(),      // admin: open days
    daySettings: {},
    stationOverrides: {},     // { date: { stationId: { required, mergedLabel } } }
    localStations: [],
    localWorkers: [],
    localOperators: [],
    localGroups: [],
    activeGroup: null,
    schedEdits: {},
    opTab: 'dnes',
    msgType: 'availability',
  };

  // ─── Utils ────────────────────────────────────────────────────────────────
  const app = document.getElementById('app');

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // 24h time input — native <input type=time> follows OS/browser locale (can show AM/PM),
  // so we use a plain text field with our own formatting instead.
  function timeInputHTML(cls, dataAttrs, value, style) {
    return `<input type="text" inputmode="numeric" maxlength="5" placeholder="HH:MM" class="time-input ${cls}" ${dataAttrs} value="${esc(value || '')}"${style ? ` style="${style}"` : ''}>`;
  }

  function showGenerateConfirmModal({ onKeep, onDiscard }) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(12,35,114,0.45);display:flex;align-items:center;justify-content:center;z-index:1000;padding:16px';
    overlay.innerHTML = `
      <div class="card" style="max-width:440px;width:100%;margin:0">
        <div class="section-title">Máš ručné úpravy v rozpise</div>
        <p style="margin-bottom:16px;font-size:.9rem">Niektoré zmeny si už uložil(a) ručne. Čo chceš urobiť pri generovaní nového rozpisu?</p>
        <div style="display:flex;flex-direction:column;gap:8px">
          <button class="btn btn-primary" id="gm-keep" style="width:100%">Zachovať ručné úpravy</button>
          <button class="btn btn-danger" id="gm-discard" style="width:100%">Zahodiť ručné úpravy a vygenerovať úplne nový</button>
          <button class="btn btn-secondary" id="gm-cancel" style="width:100%">Zrušiť</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('#gm-keep').addEventListener('click', () => { close(); onKeep(); });
    overlay.querySelector('#gm-discard').addEventListener('click', () => { close(); onDiscard(); });
    overlay.querySelector('#gm-cancel').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  }

  function fmtShort(iso) {
    if (!iso) return '';
    const d = new Date(iso + 'T12:00:00');
    const days = ['Ne','Po','Ut','St','Šv','Pi','So'];
    return `${d.getDate()}. ${d.getMonth()+1}. (${days[d.getDay()]})`;
  }

  function localTodayISO() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  }

  function fmtFull(iso) {
    if (!iso) return '';
    const d = new Date(iso + 'T12:00:00');
    const months = ['jan','feb','mar','apr','máj','jún','júl','aug','sep','okt','nov','dec'];
    const days = ['Ne','Po','Ut','St','Šv','Pi','So'];
    return `${d.getDate()}. ${months[d.getMonth()]} ${d.getFullYear()} (${days[d.getDay()]})`;
  }

  function fmtDateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getDate())}.${pad(d.getMonth()+1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function fmtDateOnly(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getDate())}.${pad(d.getMonth()+1)}.${d.getFullYear()}`;
  }

  // ─── API ──────────────────────────────────────────────────────────────────
  async function api(method, url, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
    return data;
  }

  function setMsg(id, html) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  }

  // ─── Calendar Builder ─────────────────────────────────────────────────────
  // mode: 'worker' | 'open-days'
  function buildCalendar(periodStart, periodEnd, openDays, markedDays, mode) {
    const start = new Date(periodStart + 'T12:00:00');
    const end   = new Date(periodEnd   + 'T12:00:00');
    const openSet   = new Set(openDays   || []);
    const markedSet = new Set(markedDays || []);

    const firstMon = new Date(start);
    const dow = firstMon.getDay();
    firstMon.setDate(firstMon.getDate() - (dow === 0 ? 6 : dow - 1));

    const DAY_NAMES = ['Po','Ut','St','Šv','Pi','So','Ne'];
    let h = '<div class="calendar">';
    DAY_NAMES.forEach(d => { h += `<div class="cal-header">${d}</div>`; });

    const cur = new Date(firstMon);
    while (cur <= end) {
      const iso = cur.toISOString().slice(0, 10);
      const inPeriod = cur >= start && cur <= end;
      const n = cur.getDate();

      if (!inPeriod) {
        h += '<div class="cal-day empty"></div>';
      } else if (mode === 'worker') {
        const isOpen = openSet.has(iso);
        const isMarked = markedSet.has(iso);
        if (!isOpen) {
          h += `<div class="cal-day closed"><span class="cal-num">${n}</span></div>`;
        } else if (isMarked) {
          h += `<div class="cal-day unavailable" data-date="${iso}"><span class="cal-num">${n}</span><span class="cal-lbl">Nemôžem</span></div>`;
        } else {
          h += `<div class="cal-day available" data-date="${iso}"><span class="cal-num">${n}</span><span class="cal-lbl">Môžem</span></div>`;
        }
      } else {
        const isOpen = openSet.has(iso);
        h += `<div class="cal-day open-toggle${isOpen ? ' is-open' : ''}" data-date="${iso}"><span class="cal-num">${n}</span></div>`;
      }

      cur.setDate(cur.getDate() + 1);
    }
    return h + '</div>';
  }

  // ─── WORKER VIEW ──────────────────────────────────────────────────────────
  async function initWorker() {
    try {
      S.data = await api('GET', `/api/worker/${S.token}`);
      if (S.data.hasPassword && !S.authed) { renderWorkerLogin(); return; }
      S.selectedDays = new Set(S.data.unavailableDays || []);
      renderWorkerMain();
    } catch (e) {
      app.innerHTML = `<div class="container"><div class="alert alert-error">Chyba: ${esc(e.message)}</div></div>`;
    }
  }

  function renderWorkerLogin() {
    const d = S.data;
    app.innerHTML = `
      <div class="login-wrap">
        <div class="login-card">
          <img src="/assets/fantazia-logo.svg" class="logo" onerror="this.style.display='none'">
          <h2>Fantázia Shift Planner</h2>
          <p class="sub">Vitaj, <strong>${esc(d.workerName)}</strong>! Zadaj heslo.</p>
          <div id="err" class="alert alert-error" style="display:none"></div>
          <div class="form-group"><input type="password" id="pwd" placeholder="Heslo" autocomplete="current-password"></div>
          <button class="btn btn-primary" style="width:100%" id="pbtn">Vstúpiť</button>
        </div>
      </div>`;
    const btn = document.getElementById('pbtn');
    const inp = document.getElementById('pwd');
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') btn.click(); });
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await api('POST', `/api/worker/${S.token}/access`, { password: inp.value });
        S.authed = true;
        S.selectedDays = new Set(S.data.unavailableDays || []);
        renderWorkerMain();
      } catch (e) {
        const el = document.getElementById('err');
        if (el) { el.textContent = e.message; el.style.display = 'block'; }
        btn.disabled = false;
      }
    });
    setTimeout(() => inp.focus(), 50);
  }

  function renderWorkerMain() {
    const d = S.data;
    const locked = d.locked;
    const published = d.scheduleVisible;

    const noticeHtml = locked
      ? (published
          ? `<div class="notice-published">✓ Rozpis bol zverejnený. Zmeny dostupnosti sú uzamknuté.</div>`
          : `<div class="notice-locked">⏰ Deadline na odovzdanie uplynul. Môžeš podať žiadosť o zmenu.</div>`)
      : `<div class="notice-locked" style="background:#e8f4fd;border-color:#bfe0f5;color:#1a5276">📋 Vyplň dostupnosť na <strong>${esc(d.month)}</strong> — nižšie v kalendári.</div>`;

    const calHtml = buildCalendar(d.periodStart, d.periodEnd, d.openDays, [...S.selectedDays], 'worker');

    // Confirmed schedule + hours entry
    function findMyLog(date, stationId) {
      return (d.myHourLogs || []).find(h => h.date === date && h.stationId === stationId && !h.substituteFor);
    }
    function buildShiftHoursBlock(s) {
      const log = findMyLog(s.date, s.stationId);
      const today = localTodayISO();

      // Already reported — locked. Only an explicit correction re-opens it.
      if (log) {
        const statusBadge = log.status === 'approved'
          ? '<span class="badge badge-success">✓ Schválené</span>'
          : '<span class="badge badge-warning">⏳ Čaká na schválenie</span>';
        return `<div style="margin-top:6px" data-corr-wrap="${s.date}|${esc(s.stationId)}">
          ${statusBadge}
          <span class="text-muted" style="font-size:.8rem;margin-left:6px">Nahlásil(a) si ${esc(log.reportedStart)}–${esc(log.reportedEnd)}</span>
          <button class="btn btn-secondary btn-sm hrs-corr" data-date="${s.date}" data-st="${esc(s.stationId)}" style="margin-left:8px">Poslať opravu</button>
        </div>`;
      }

      // Not reported yet — entry only on the day of the shift.
      if (s.date > today) {
        return `<div style="margin-top:6px"><span class="text-muted" style="font-size:.82rem">Hodiny zapíšeš v deň zmeny.</span></div>`;
      }
      if (s.date < today) {
        return `<div style="margin-top:6px"><span class="badge badge-danger">Hodiny neboli zapísané</span>
          <span class="text-muted" style="font-size:.8rem;margin-left:6px">Kontaktuj prevádzkara.</span></div>`;
      }
      return `<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:6px">
        ${timeInputHTML('hrs-start', `data-date="${s.date}" data-st="${esc(s.stationId)}"`, s.opensAt, 'width:90px')}
        <span>–</span>
        ${timeInputHTML('hrs-end', `data-date="${s.date}" data-st="${esc(s.stationId)}"`, s.closesAt, 'width:90px')}
        <button class="btn btn-secondary btn-sm hrs-save" data-date="${s.date}" data-st="${esc(s.stationId)}">Zapísať hodiny</button>
      </div>`;
    }

    let schedHtml = '';
    if (published) {
      const shifts = d.confirmedSchedule || [];
      const schedMonths = [...new Set(shifts.map(s => s.month).filter(Boolean))];
      const monthLabel = schedMonths.length ? ` — ${schedMonths.map(esc).join(', ')}` : '';
      schedHtml = `<div class="card"><div class="section-title">Tvoj rozpis${monthLabel}</div>${
        shifts.length === 0
          ? '<p class="text-muted">V tomto období nemáš žiadne pridelené zmeny.</p>'
          : `<ul class="shifts-list">${shifts.map(s => `
              <li class="shift-item" style="flex-direction:column;align-items:flex-start">
                <div style="display:flex;align-items:center;gap:12px;width:100%">
                  <span class="shift-date">${fmtShort(s.date)}</span>
                  <span class="shift-stn">${esc(s.stationName)}</span>
                  <span class="shift-time">${esc(s.opensAt)}–${esc(s.closesAt)}</span>
                </div>
                ${buildShiftHoursBlock(s)}
              </li>`).join('')}</ul>`
      }</div>`;
    }

    // Substitution — worker reports hours for someone else's shift (today only)
    let subHtml = '';
    if (published && d.fullSchedule) {
      const today = localTodayISO();
      const canSubToday = Boolean(d.fullSchedule[today]);
      const mySubLogs = (d.myHourLogs || []).filter(h => h.substituteFor);
      const subLogRows = mySubLogs.map(h => {
        const badge = h.status === 'approved'
          ? '<span class="badge badge-success">✓ Schválené</span>'
          : '<span class="badge badge-warning">⏳ Čaká na schválenie</span>';
        return `<div style="margin-bottom:6px">${fmtShort(h.date)} — zastúpil(a) si <strong>${esc(h.substituteForName||'?')}</strong> (nahlásil(a) si ${esc(h.reportedStart)}–${esc(h.reportedEnd)}) ${badge}</div>`;
      }).join('');

      const subForm = canSubToday ? `
        <div class="form-row">
          <div class="form-group"><label>Stanovisko</label><select id="sub-station"></select></div>
          <div class="form-group"><label>Za koho</label><select id="sub-for"></select></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label>Od</label>${timeInputHTML('sub-start', '', d.defaultOpensAt || '10:00')}</div>
          <div class="form-group"><label>Do</label>${timeInputHTML('sub-end', '', d.defaultClosesAt || '19:00')}</div>
        </div>
        <input type="hidden" id="sub-date" value="${esc(today)}">
        <button class="btn btn-primary btn-sm" id="sub-save">Zapísať zástup</button>
        <div id="sub-hrs-msg" style="margin-top:8px"></div>`
        : '<p class="text-muted">Dnes nie je otvorený deň — zástup zapíšeš v deň, keď zaňho pracuješ.</p>';

      subHtml = `<div class="card">
        <div class="section-title">Zastúpil(a) si niekoho dnes?</div>
        <p class="text-muted" style="margin-bottom:10px">Ak si dnes pracoval(a) namiesto iného brigádnika na jeho zmene, zapíš to tu.</p>
        ${subForm}
        ${subLogRows ? `<div style="margin-top:14px">${subLogRows}</div>` : ''}
      </div>`;
    }

    // Change request form (when locked)
    const crHtml = locked ? `
      <div class="card">
        <div class="section-title">Žiadosť o zmenu dostupnosti</div>
        <p class="text-muted" style="margin-bottom:10px">Admin schváli alebo zamietne tvoju žiadosť.</p>
        <div class="form-group">
          <label>Dôvod žiadosti</label>
          <textarea id="cr-reason" rows="3" placeholder="Napíš dôvod žiadosti..."></textarea>
        </div>
        <div class="form-group">
          <label>Dni kedy nemôžeš (YYYY-MM-DD, oddeliť čiarkou)</label>
          <input type="text" id="cr-days" placeholder="2026-06-10, 2026-06-15">
        </div>
        <button class="btn btn-primary" id="cr-btn">Odoslať žiadosť</button>
        <div id="cr-msg" style="margin-top:8px"></div>
      </div>` : '';

    app.innerHTML = `
      <div class="header">
        <img src="/assets/fantazia-logo.svg" class="logo" onerror="this.style.display='none'">
        <div class="header-text">
          <h1>Fantázia Shift Planner</h1>
          <div class="subtitle">Vitaj, ${esc(d.workerName)} &mdash; ${esc(d.periodStart)} – ${esc(d.periodEnd)}</div>
        </div>
      </div>
      <div class="container">
        ${noticeHtml}
        <div class="card">
          <div class="section-title">Moja dostupnosť — ${esc(d.month)}${locked ? ' (uzamknutá)' : ''}</div>
          ${!locked ? `<p class="text-muted" style="margin-bottom:10px">Klikni na deň keď <strong>NEMÔŽEŠ</strong> pracovať (červená). Ostatné dni = dostupný.</p>` : ''}
          ${calHtml}
          ${d.submittedAt ? `<p class="text-muted" style="margin-top:8px">Naposledy odoslané: ${fmtDateTime(d.submittedAt)}</p>` : ''}
          ${!locked ? `
            <div class="actions">
              <button class="btn btn-primary" id="sub-btn">Odoslať dostupnosť</button>
            </div>
            <div id="sub-msg" style="margin-top:8px"></div>` : ''}
        </div>
        ${schedHtml}
        ${subHtml}
        ${crHtml}
      </div>`;

    // Calendar click handler
    if (!locked) {
      app.querySelectorAll('.cal-day.available, .cal-day.unavailable').forEach(cell => {
        cell.addEventListener('click', () => {
          const date = cell.dataset.date;
          const wasUnavail = S.selectedDays.has(date);
          if (wasUnavail) {
            S.selectedDays.delete(date);
            cell.classList.replace('unavailable', 'available');
            cell.querySelector('.cal-lbl').textContent = 'Môžem';
          } else {
            S.selectedDays.add(date);
            cell.classList.replace('available', 'unavailable');
            cell.querySelector('.cal-lbl').textContent = 'Nemôžem';
          }
        });
      });

      document.getElementById('sub-btn')?.addEventListener('click', async () => {
        const btn = document.getElementById('sub-btn');
        btn.disabled = true; btn.textContent = 'Odosiela sa...';
        try {
          await api('PUT', `/api/worker/${S.token}/submission`, { unavailableDays: [...S.selectedDays] });
          setMsg('sub-msg', '<div class="alert alert-success">✓ Dostupnosť bola odoslaná!</div>');
          S.data.submittedAt = new Date().toISOString();
        } catch (e) {
          setMsg('sub-msg', `<div class="alert alert-error">Chyba: ${esc(e.message)}</div>`);
        }
        btn.disabled = false; btn.textContent = 'Odoslať dostupnosť';
      });
    }

    document.getElementById('cr-btn')?.addEventListener('click', async () => {
      const reason = document.getElementById('cr-reason').value.trim();
      const daysRaw = document.getElementById('cr-days').value.trim();
      const days = daysRaw ? daysRaw.split(',').map(x => x.trim()).filter(Boolean) : [];
      if (!reason) { setMsg('cr-msg', '<div class="alert alert-error">Zadaj dôvod.</div>'); return; }
      const btn = document.getElementById('cr-btn');
      btn.disabled = true;
      try {
        await api('POST', `/api/worker/${S.token}/change-request`, { reason, days });
        setMsg('cr-msg', '<div class="alert alert-success">✓ Žiadosť bola odoslaná.</div>');
        document.getElementById('cr-reason').value = '';
        document.getElementById('cr-days').value = '';
      } catch (e) {
        setMsg('cr-msg', `<div class="alert alert-error">Chyba: ${esc(e.message)}</div>`);
      }
      btn.disabled = false;
    });

    // Own shift hours entry
    document.querySelectorAll('.hrs-save').forEach(btn => {
      btn.addEventListener('click', async () => {
        const { date, st } = btn.dataset;
        const start = document.querySelector(`.hrs-start[data-date="${date}"][data-st="${st}"]`)?.value;
        const end = document.querySelector(`.hrs-end[data-date="${date}"][data-st="${st}"]`)?.value;
        if (!start || !end) return;
        btn.disabled = true;
        try {
          S.data = await api('POST', `/api/worker/${S.token}/hours`, { date, stationId: st, start, end });
          renderWorkerMain();
        } catch (e) {
          alert('Chyba: ' + e.message);
          btn.disabled = false;
        }
      });
    });

    // Correction — re-open an already-reported entry for a new approval
    document.querySelectorAll('.hrs-corr').forEach(btn => {
      btn.addEventListener('click', () => {
        const { date, st } = btn.dataset;
        const wrap = document.querySelector(`[data-corr-wrap="${date}|${st}"]`);
        if (!wrap) return;
        wrap.innerHTML = `
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            <span class="text-muted" style="font-size:.8rem">Oprava:</span>
            ${timeInputHTML('hrs-start', `data-date="${date}" data-st="${st}"`, '', 'width:90px')}
            <span>–</span>
            ${timeInputHTML('hrs-end', `data-date="${date}" data-st="${st}"`, '', 'width:90px')}
            <button class="btn btn-primary btn-sm hrs-save" data-date="${date}" data-st="${st}">Odoslať opravu</button>
          </div>
          <p class="text-muted" style="font-size:.78rem;margin-top:4px">Opravu musí znova schváliť prevádzkar.</p>`;
        wrap.querySelector('.hrs-save').addEventListener('click', async (e) => {
          const b = e.currentTarget;
          const start = wrap.querySelector('.hrs-start')?.value;
          const end = wrap.querySelector('.hrs-end')?.value;
          if (!start || !end) return;
          b.disabled = true;
          try {
            S.data = await api('POST', `/api/worker/${S.token}/hours`, { date, stationId: st, start, end });
            renderWorkerMain();
          } catch (err) {
            alert('Chyba: ' + err.message);
            b.disabled = false;
          }
        });
      });
    });

    // Substitution — station/worker dropdowns for today
    function refreshSubForOptions() {
      const stSel = document.getElementById('sub-station');
      const forSel = document.getElementById('sub-for');
      const dateEl = document.getElementById('sub-date');
      if (!stSel || !forSel || !dateEl) return;
      const info = d.fullSchedule?.[dateEl.value]?.[stSel.value];
      const workers = (info?.workers || []).filter(w => w.id !== d.workerId);
      forSel.innerHTML = workers.length
        ? workers.map(w => `<option value="${esc(w.id)}">${esc(w.name)}</option>`).join('')
        : '<option value="">— nikto priradený —</option>';
    }
    (function initSubStations() {
      const stSel = document.getElementById('sub-station');
      const dateEl = document.getElementById('sub-date');
      if (!stSel || !dateEl) return;
      const stations = d.fullSchedule?.[dateEl.value] || {};
      stSel.innerHTML = Object.entries(stations).map(([sid, info]) =>
        `<option value="${esc(sid)}">${esc(info.stationName)}</option>`).join('');
      refreshSubForOptions();
    })();
    document.getElementById('sub-station')?.addEventListener('change', refreshSubForOptions);

    document.getElementById('sub-save')?.addEventListener('click', async () => {
      const date = document.getElementById('sub-date')?.value;
      const stationId = document.getElementById('sub-station')?.value;
      const substituteFor = document.getElementById('sub-for')?.value;
      const start = document.querySelector('.sub-start')?.value;
      const end = document.querySelector('.sub-end')?.value;
      if (!date || !stationId || !substituteFor) {
        setMsg('sub-hrs-msg', '<div class="alert alert-error">Vyber deň, stanovisko a za koho zastupuješ.</div>');
        return;
      }
      if (!start || !end) {
        setMsg('sub-hrs-msg', '<div class="alert alert-error">Zadaj čas.</div>');
        return;
      }
      const btn = document.getElementById('sub-save');
      btn.disabled = true;
      try {
        S.data = await api('POST', `/api/worker/${S.token}/hours`, { date, stationId, substituteFor, start, end });
        renderWorkerMain();
      } catch (e) {
        setMsg('sub-hrs-msg', `<div class="alert alert-error">Chyba: ${esc(e.message)}</div>`);
        btn.disabled = false;
      }
    });
  }

  // ─── OPERATOR VIEW ────────────────────────────────────────────────────────
  async function initOperator() {
    try {
      S.data = await api('GET', `/api/operator/${S.token}`);
      if (S.data.hasPassword && !S.authed) { renderOperatorLogin(); return; }
      renderOperatorMain();
    } catch (e) {
      app.innerHTML = `<div class="container"><div class="alert alert-error">Chyba: ${esc(e.message)}</div></div>`;
    }
  }

  function renderOperatorLogin() {
    app.innerHTML = `
      <div class="login-wrap">
        <div class="login-card">
          <img src="/assets/fantazia-logo.svg" class="logo" onerror="this.style.display='none'">
          <h2>Fantázia Shift Planner</h2>
          <p class="sub">Prevádzkový náhľad &mdash; zadaj heslo</p>
          <div id="err" class="alert alert-error" style="display:none"></div>
          <div class="form-group"><input type="password" id="pwd" placeholder="Heslo"></div>
          <button class="btn btn-primary" style="width:100%" id="pbtn">Vstúpiť</button>
        </div>
      </div>`;
    const btn = document.getElementById('pbtn');
    const inp = document.getElementById('pwd');
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') btn.click(); });
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await api('POST', `/api/operator/${S.token}/access`, { password: inp.value });
        S.authed = true; renderOperatorMain();
      } catch (e) {
        const el = document.getElementById('err');
        if (el) { el.textContent = e.message; el.style.display = 'block'; }
        btn.disabled = false;
      }
    });
    setTimeout(() => inp.focus(), 50);
  }

  function buildOperatorSchedule() {
    const d = S.data;
    const stations = d.stations || [];
    const openDays = (d.openDays || []).slice().sort();
    const sched = d.schedule || {};

    const thead = `<tr><th>Dátum</th>${stations.map(s => `<th>${esc(s.name)}</th>`).join('')}<th>Voľní</th></tr>`;
    const tbody = openDays.map(date => {
      const cells = stations.map(st => {
        const cell = sched[date]?.[st.id] || {};
        if (cell.hidden) {
          return `<td class="sched-cell" data-label="${esc(st.name)}" style="background:#f5f5f5;color:#aaa;font-size:.8rem;text-align:center">—</td>`;
        }
        const names = (cell.workers || []);
        const time = `${cell.opensAt || ''}–${cell.closesAt || ''}`;
        const label = cell.stationName && cell.stationName !== st.name ? `<div style="font-size:.7rem;font-weight:600;color:var(--orange-dark);margin-bottom:2px">${esc(cell.stationName)}</div>` : '';
        return `<td class="sched-cell" data-label="${esc(cell.stationName || st.name)}">
          ${label}
          <div class="text-muted" style="font-size:.75rem;margin-bottom:3px">${esc(time)}</div>
          ${names.map(n => `<span class="worker-chip">${esc(n)}</span>`).join('') || '<span class="text-muted">—</span>'}
        </td>`;
      }).join('');
      const free = d.freeWorkers?.[date] || [];
      const freeCell = `<td class="sched-cell" data-label="Voľní">${
        free.length
          ? free.map(w => `<span class="free-chip" title="${esc(w.stations.join(' · '))} · ${w.shifts} zmien">${esc(w.name)}</span>`).join('')
          : '<span class="text-muted">—</span>'
      }</td>`;
      return `<tr><td class="sched-date"><strong>${fmtShort(date)}</strong></td>${cells}${freeCell}</tr>`;
    }).join('');

    return `
      <div class="card">
        <div class="sched-wrap">
          <table class="sched-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table>
        </div>
      </div>`;
  }

  function operatorHourRows(logs) {
    const stationMap = new Map((S.data.stations || []).map(s => [s.id, s.name]));
    return logs.map(h => {
      const whoLabel = h.substituteFor
        ? `${esc(h.workerName)} <span class="text-muted" style="font-size:.78rem">(zastúpil ${esc(h.substituteForName || '?')})</span>`
        : esc(h.workerName);
      const stnName = esc(stationMap.get(h.stationId) || h.stationId);

      if (h.status === 'approved') {
        return `<tr>
          <td>${fmtShort(h.date)}</td>
          <td>${stnName}</td>
          <td>${whoLabel}</td>
          <td><span class="badge badge-success">✓ ${esc(h.approvedStart)}–${esc(h.approvedEnd)}</span></td>
          <td class="text-muted" style="font-size:.8rem">${esc(h.approvedByName || '')}</td>
        </tr>`;
      }

      return `<tr>
        <td>${fmtShort(h.date)}</td>
        <td>${stnName}</td>
        <td>${whoLabel}</td>
        <td>
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            ${timeInputHTML('ap-start', `data-id="${esc(h.id)}"`, h.plannedStart, 'width:80px')}
            <span>–</span>
            ${timeInputHTML('ap-end', `data-id="${esc(h.id)}"`, h.plannedEnd, 'width:80px')}
            <button class="btn btn-success btn-sm ap-hrs-btn" data-id="${esc(h.id)}">Schváliť</button>
          </div>
        </td>
        <td></td>
      </tr>`;
    }).join('');
  }

  const OP_HOURS_TABLE_HEAD = '<thead><tr><th>Dátum</th><th>Stanovisko</th><th>Brigádnik</th><th>Tvoje schválenie</th><th>Schválil</th></tr></thead>';
  const OP_HOURS_NOTE = 'Časy zadávaš nezávisle podľa vlastnej vedomosti o odpracovaných hodinách — systém ti nezobrazuje, čo nahlásil brigádnik.';

  function buildOperatorToday() {
    const d = S.data;
    const today = localTodayISO();
    const stations = d.stations || [];
    const sched = d.schedule?.[today];

    const schedCard = !sched
      ? `<div class="card"><div class="section-title">${fmtFull(today)}</div><p class="text-muted">Dnes nie je otvorený deň.</p></div>`
      : `<div class="card">
          <div class="section-title">Dnes na stanoviskách &mdash; ${fmtFull(today)}</div>
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px">
            ${stations.map(st => {
              const cell = sched[st.id];
              if (!cell || cell.hidden) return '';
              const names = cell.workers || [];
              return `<div style="border:1px solid var(--border);border-radius:8px;padding:12px">
                <div style="font-weight:700;color:var(--orange-dark);margin-bottom:2px">${esc(cell.stationName || st.name)}</div>
                <div class="text-muted" style="font-size:.78rem;margin-bottom:6px">${esc(cell.opensAt||'')}–${esc(cell.closesAt||'')}</div>
                ${names.map(n => `<span class="worker-chip">${esc(n)}</span>`).join('') || '<span class="text-muted">—</span>'}
              </div>`;
            }).join('')}
          </div>
        </div>`;

    const todayLogs = (d.hourLogs || [])
      .filter(h => h.date === today)
      .sort((a, b) => (a.status === b.status ? 0 : a.status === 'pending' ? -1 : 1));

    const hoursCard = `<div class="card">
      <div class="section-title">Hodiny na schválenie &mdash; dnes</div>
      <p class="text-muted" style="margin-bottom:12px;font-size:.84rem">${OP_HOURS_NOTE}</p>
      <div id="op-hrs-msg"></div>
      ${todayLogs.length
        ? `<div style="overflow-x:auto"><table>${OP_HOURS_TABLE_HEAD}<tbody>${operatorHourRows(todayLogs)}</tbody></table></div>`
        : '<p class="text-muted">Dnes zatiaľ nikto nenahlásil hodiny.</p>'}
    </div>`;

    const freeToday = d.freeWorkers?.[today];
    const freeCard = !sched ? '' : `<div class="card">
      <div class="section-title">Voľní dnes <span class="text-muted" style="font-size:.8rem;font-weight:400">(ak treba náhradu)</span></div>
      ${freeToday && freeToday.length
        ? `<p class="text-muted" style="margin-bottom:10px;font-size:.84rem">Zoradení od najmenej odpracovaných zmien. Nezobrazujú sa tí, čo nahlásili, že dnes nemôžu.</p>
           <div style="display:flex;flex-direction:column;gap:8px">
             ${freeToday.map(w => `
               <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 10px;border:1px solid var(--border);border-radius:8px">
                 <strong style="color:var(--text)">${esc(w.name)}</strong>
                 <span class="badge badge-info">${w.shifts} ${w.shifts === 1 ? 'zmena' : (w.shifts >= 2 && w.shifts <= 4 ? 'zmeny' : 'zmien')}</span>
                 <span class="text-muted" style="font-size:.82rem">${w.stations.length ? esc(w.stations.join(' · ')) : 'žiadne stanovisko'}</span>
               </div>`).join('')}
           </div>`
        : '<p class="text-muted">Dnes nie je nikto voľný — všetci sú buď v rozpise, alebo nahlásili, že nemôžu.</p>'}
    </div>`;

    return schedCard + freeCard + hoursCard;
  }

  function buildOperatorHours() {
    const d = S.data;
    const logs = [...(d.hourLogs || [])].sort((a, b) => {
      if (a.status !== b.status) return a.status === 'pending' ? -1 : 1;
      return a.date.localeCompare(b.date);
    });

    if (!logs.length) {
      return `<div class="card"><p class="text-muted">Zatiaľ nikto nenahlásil odpracované hodiny.</p></div>`;
    }

    return `
      <div class="card">
        <p class="text-muted" style="margin-bottom:12px;font-size:.84rem">${OP_HOURS_NOTE}</p>
        <div id="op-hrs-msg"></div>
        <div style="overflow-x:auto">
          <table>${OP_HOURS_TABLE_HEAD}<tbody>${operatorHourRows(logs)}</tbody></table>
        </div>
      </div>`;
  }

  function attachOperatorHours() {
    document.querySelectorAll('.ap-hrs-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const start = document.querySelector(`.ap-start[data-id="${id}"]`)?.value;
        const end = document.querySelector(`.ap-end[data-id="${id}"]`)?.value;
        if (!start || !end) return;
        btn.disabled = true;
        try {
          const r = await api('POST', `/api/operator/${S.token}/hours/${id}/approve`, { start, end });
          S.data.hourLogs = r.hourLogs;
          renderOperatorMain();
        } catch (e) {
          setMsg('op-hrs-msg', `<div class="alert alert-error">Chyba: ${esc(e.message)}</div>`);
          btn.disabled = false;
        }
      });
    });
  }

  function renderOperatorMain() {
    const d = S.data;
    const header = `
      <div class="header">
        <img src="/assets/fantazia-logo.svg" class="logo" onerror="this.style.display='none'">
        <div class="header-text">
          <h1>Fantázia Shift Planner</h1>
          <div class="subtitle">Prevádzkový náhľad &mdash; ${esc(d.month)}</div>
        </div>
      </div>`;

    if (!d.schedulePublished) {
      app.innerHTML = header + `<div class="container"><div class="alert alert-warning">Rozpis zatiaľ nebol zverejnený.</div></div>`;
      return;
    }

    const pendingCount = (d.hourLogs || []).filter(h => h.status === 'pending').length;
    const tabs = [
      { id: 'dnes', label: 'Aktuálny deň' },
      { id: 'rozpis', label: 'Rozpis' },
      { id: 'hodiny', label: pendingCount ? `Hodiny (${pendingCount})` : 'Hodiny' },
    ];

    const content = S.opTab === 'hodiny' ? buildOperatorHours()
      : S.opTab === 'rozpis' ? buildOperatorSchedule()
      : buildOperatorToday();

    app.innerHTML = header + `
      <div class="container">
        <div class="tabs" id="op-tabs">
          ${tabs.map(t => `<button class="tab-btn${S.opTab===t.id?' active':''}" data-tab="${t.id}">${t.label}</button>`).join('')}
        </div>
        <div id="op-tab-content">${content}</div>
      </div>`;

    document.getElementById('op-tabs').addEventListener('click', e => {
      const b = e.target.closest('[data-tab]');
      if (!b) return;
      S.opTab = b.dataset.tab;
      renderOperatorMain();
    });

    if (S.opTab === 'hodiny' || S.opTab === 'dnes') attachOperatorHours();
  }

  // ─── ADMIN VIEW ───────────────────────────────────────────────────────────
  async function initAdmin() {
    try {
      const sess = await api('GET', '/api/session');
      if (!sess.loggedIn) { renderAdminLogin(); return; }
      S.data = await api('GET', '/api/admin');
      syncLocal();
      renderPanel();
    } catch (e) {
      app.innerHTML = `<div class="container"><div class="alert alert-error">Chyba: ${esc(e.message)}</div></div>`;
    }
  }

  function syncLocal() {
    const d = S.data;
    S.localStations  = JSON.parse(JSON.stringify(d.stations  || []));
    S.localWorkers   = JSON.parse(JSON.stringify(d.workers   || []));
    S.localOperators = JSON.parse(JSON.stringify(d.operators || []));
    S.localGroups    = JSON.parse(JSON.stringify(d.groups    || []));
    S.activeGroup    = d.activeGroup || null;
    S.openDays    = new Set(d.openDays || []);
    S.daySettings = JSON.parse(JSON.stringify(d.daySettings || {}));
    S.stationOverrides = {};
    for (const [date, ds] of Object.entries(S.daySettings)) {
      if (ds.stationOverrides) S.stationOverrides[date] = JSON.parse(JSON.stringify(ds.stationOverrides));
    }
    // Init schedule edits from scheduleWithNames
    S.schedEdits = {};
    for (const [date, st] of Object.entries(d.scheduleWithNames || {})) {
      S.schedEdits[date] = {};
      for (const [sid, info] of Object.entries(st)) {
        if (sid.startsWith('_')) continue;
        S.schedEdits[date][sid] = [...(info.workerIds || [])];
      }
    }
  }

  function renderAdminLogin() {
    app.innerHTML = `
      <div class="login-wrap">
        <div class="login-card">
          <img src="/assets/fantazia-logo.svg" class="logo" onerror="this.style.display='none'">
          <h2>Fantázia Shift Planner</h2>
          <p class="sub">Admin prístup</p>
          <div id="err" class="alert alert-error" style="display:none"></div>
          <div class="form-group"><input type="password" id="pwd" placeholder="Admin heslo" autocomplete="current-password"></div>
          <button class="btn btn-primary" style="width:100%" id="lbtn">Prihlásiť sa</button>
        </div>
      </div>`;
    const btn = document.getElementById('lbtn');
    const inp = document.getElementById('pwd');
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') btn.click(); });
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await api('POST', '/api/login', { password: inp.value });
        S.data = await api('GET', '/api/admin');
        syncLocal(); renderPanel();
      } catch (e) {
        const el = document.getElementById('err');
        if (el) { el.textContent = e.message; el.style.display = 'block'; }
        btn.disabled = false;
      }
    });
    setTimeout(() => inp.focus(), 50);
  }

  function pendingCount() {
    return (S.data.changeRequests || []).filter(r => r.status === 'pending').length;
  }

  function renderPanel() {
    const pc = pendingCount();
    const tabs = [
      { id: 'settings',    label: 'Nastavenia' },
      { id: 'submissions', label: 'Odpovede' },
      { id: 'schedule',    label: 'Rozpis' },
      { id: 'skupiny',     label: 'Skupiny' },
      { id: 'hodiny',      label: 'Hodiny' },
      { id: 'requests',    label: pc ? `Žiadosti (${pc})` : 'Žiadosti' },
      { id: 'exports',     label: 'Exporty' },
      { id: 'agent',       label: '🤖 Agent' },
    ];
    app.innerHTML = `
      <div class="header">
        <img src="/assets/fantazia-logo.svg" class="logo" onerror="this.style.display='none'">
        <div class="header-text">
          <h1>Fantázia Shift Planner</h1>
          <div class="subtitle">Admin — ${esc(S.data.month)}</div>
        </div>
        <button class="btn btn-secondary btn-sm" id="logout-btn">Odhlásiť</button>
      </div>
      <div class="container">
        <div class="tabs" id="tabs">
          ${tabs.map(t => `<button class="tab-btn${S.tab===t.id?' active':''}" data-tab="${t.id}">${t.label}</button>`).join('')}
        </div>
        <div id="tab-content"></div>
      </div>`;

    document.getElementById('logout-btn').addEventListener('click', async () => {
      await api('POST', '/api/logout');
      renderAdminLogin();
    });
    document.getElementById('tabs').addEventListener('click', e => {
      const b = e.target.closest('[data-tab]');
      if (!b) return;
      S.tab = b.dataset.tab;
      renderPanel();
    });
    renderTab();
  }

  function renderTab() {
    const el = document.getElementById('tab-content');
    if (!el) return;
    switch (S.tab) {
      case 'settings':    el.innerHTML = buildSettings();    attachSettings();    break;
      case 'submissions': el.innerHTML = buildSubmissions(); attachSubmissions(); break;
      case 'schedule':    el.innerHTML = buildSchedule();    attachSchedule();    break;
      case 'skupiny':     el.innerHTML = buildSkupiny();     attachSkupiny();     break;
      case 'hodiny':      el.innerHTML = buildAdminHours();                       break;
      case 'requests':    el.innerHTML = buildRequests();    attachRequests();    break;
      case 'exports':     el.innerHTML = buildExports();                          break;
      case 'agent':       el.innerHTML = buildAgent();       attachAgent();       break;
    }
  }

  // ─── SETTINGS TAB ─────────────────────────────────────────────────────────
  function buildSettings() {
    const d = S.data;
    const calHtml = buildCalendar(d.periodStart, d.periodEnd, [...S.openDays], [], 'open-days');
    const sortedOpen = [...S.openDays].sort();

    const dayRows = sortedOpen.map(date => {
      const ds = S.daySettings[date] || {};
      return `<tr>
        <td>${fmtShort(date)}</td>
        <td>${timeInputHTML('dh-open', `data-date="${date}"`, ds.opensAt || d.defaultOpensAt || '10:00', 'width:110px')}</td>
        <td>${timeInputHTML('dh-close', `data-date="${date}"`, ds.closesAt || d.defaultClosesAt || '19:00', 'width:110px')}</td>
      </tr>`;
    }).join('');

    const stRows = S.localStations.map((st, i) => `
      <tr>
        <td><input type="text" class="st-name" data-i="${i}" value="${esc(st.name)}" placeholder="Meno stanoviska"></td>
        <td><input type="number" class="st-req" data-i="${i}" value="${st.required||1}" min="1" max="20" style="width:70px"></td>
        <td>${timeInputHTML('st-open', `data-i="${i}"`, st.opensAt||'', 'width:105px')}</td>
        <td>${timeInputHTML('st-close', `data-i="${i}"`, st.closesAt||'', 'width:105px')}</td>
        <td><button class="btn btn-danger btn-sm st-rm" data-i="${i}">×</button></td>
      </tr>`).join('');

    const wRows = S.localWorkers.map((w, i) => {
      const checks = S.localStations.map(st => `
        <label class="stn-check-lbl">
          <input type="checkbox" class="w-st" data-wi="${i}" data-sid="${esc(st.id)}"
            ${(w.allowedStations||[]).includes(st.id)?'checked':''}>
          ${esc(st.name||'?')}
        </label>`).join('');
      const link = w.token ? `<a href="/worker/${esc(w.token)}" target="_blank" class="btn btn-secondary btn-sm" title="Skopírovať odkaz">Odkaz ↗</a>` : '';
      return `<tr>
        <td><input type="text" class="w-name" data-i="${i}" value="${esc(w.name)}" placeholder="Meno"></td>
        <td><div class="stn-checks">${checks || '<span class="text-muted">Najprv pridaj stanoviská</span>'}</div></td>
        <td><input type="password" class="w-pwd" data-i="${i}" placeholder="Nové heslo">
          ${w.hasPassword?`<br><span class="badge badge-info" style="margin-top:3px">Má heslo</span> <label style="font-size:.72rem;cursor:pointer"><input type="checkbox" class="w-pwd-clear" data-i="${i}"> zrušiť</label>`:''}</td>
        <td style="white-space:nowrap">${link} <button class="btn btn-danger btn-sm w-rm" data-i="${i}">×</button></td>
      </tr>`;
    }).join('');

    const opRows = S.localOperators.map((o, i) => {
      const link = o.token ? `<a href="/operator/${esc(o.token)}" target="_blank" class="btn btn-secondary btn-sm">Odkaz ↗</a>` : '';
      return `<tr>
        <td><input type="text" class="op-name" data-i="${i}" value="${esc(o.name)}" placeholder="Meno prevádzku"></td>
        <td><input type="password" class="op-pwd" data-i="${i}" placeholder="Nové heslo">
          ${o.hasPassword?`<br><span class="badge badge-info" style="margin-top:3px">Má heslo</span> <label style="font-size:.72rem;cursor:pointer"><input type="checkbox" class="op-pwd-clear" data-i="${i}"> zrušiť</label>`:''}</td>
        <td style="white-space:nowrap">${link} <button class="btn btn-danger btn-sm op-rm" data-i="${i}">×</button></td>
      </tr>`;
    }).join('');

    const known = d.knownMonths || [];
    const pubMonths = d.publishedMonths || [];
    const otherPublished = pubMonths.filter(m => m !== d.month);
    const monthChips = known.length > 1
      ? `<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:12px">
          <span class="text-muted" style="font-size:.82rem">Mesiace:</span>
          ${known.map(m => `<button class="btn btn-sm month-jump${m === d.month ? ' btn-primary' : ' btn-secondary'}" data-month="${esc(m)}">${esc(m)}${pubMonths.includes(m) ? ' ✓' : ''}</button>`).join('')}
        </div>`
      : '';
    const otherPubNote = otherPublished.length
      ? `<div class="alert alert-success" style="margin-bottom:12px">✓ Zverejnené a viditeľné pre brigádnikov: <strong>${otherPublished.map(esc).join(', ')}</strong> — zostáva im viditeľné, aj keď tu pripravuješ iný mesiac.</div>`
      : '';

    return `
      <div id="set-msg"></div>
      <div class="card">
        <div class="section-title">Plánovacie obdobie</div>
        ${monthChips}
        ${otherPubNote}
        <div class="form-row">
          <div class="form-group">
            <label>Mesiac (YYYY-MM)</label>
            <input type="text" id="cfg-month" value="${esc(d.month)}" placeholder="2026-06">
          </div>
          <div class="form-group">
            <label>Začiatok</label>
            <input type="date" id="cfg-start" value="${esc(d.periodStart)}">
          </div>
          <div class="form-group">
            <label>Koniec</label>
            <input type="date" id="cfg-end" value="${esc(d.periodEnd)}">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Deadline (dátum a čas)</label>
            <input type="datetime-local" id="cfg-deadline" value="${esc(d.availabilityDeadline||'')}">
          </div>
          <div class="form-group">
            <label>Štandardný čas od</label>
            ${timeInputHTML('', 'id="cfg-open"', d.defaultOpensAt||'10:00')}
          </div>
          <div class="form-group">
            <label>Štandardný čas do</label>
            ${timeInputHTML('', 'id="cfg-close"', d.defaultClosesAt||'19:00')}
          </div>
        </div>
      </div>

      <div class="card">
        <div class="section-title">Otvorené dni</div>
        <p class="text-muted" style="margin-bottom:8px">Klikni na deň aby si ho otvoril / zatvoril.</p>
        ${calHtml}
        ${sortedOpen.length ? `
          <div class="section-title">Časy pre jednotlivé dni</div>
          <table style="width:auto"><thead><tr><th>Deň</th><th>Od</th><th>Do</th></tr></thead>
          <tbody id="dh-body">${dayRows}</tbody></table>` : ''}
      </div>

      <div class="card" id="overrides-card">
        <div class="section-title">Výnimky stanovísk <span class="text-muted" style="font-size:.8rem;font-weight:400">(napr. piatok — menej ľudí, zlúčenie)</span></div>
        ${buildOverridesUI()}
      </div>

      <div class="card">
        <div class="section-title">Stanoviská</div>
        <div style="overflow-x:auto;margin-bottom:10px">
          <table><thead><tr><th>Meno</th><th>Počet ľudí</th><th>Čas od</th><th>Čas do</th><th></th></tr></thead>
          <tbody id="st-body">${stRows}</tbody></table>
        </div>
        <button class="btn btn-secondary btn-sm" id="add-st">+ Pridať stanovisko</button>
      </div>

      <div class="card">
        <div class="section-title">Brigádnici</div>
        <div style="overflow-x:auto;margin-bottom:10px">
          <table><thead><tr><th>Meno</th><th>Povolené stanoviská</th><th>Heslo</th><th></th></tr></thead>
          <tbody id="w-body">${wRows}</tbody></table>
        </div>
        <button class="btn btn-secondary btn-sm" id="add-w">+ Pridať brigádnika</button>
      </div>

      <div class="card">
        <div class="section-title">Prevádzkar</div>
        <div style="overflow-x:auto;margin-bottom:10px">
          <table><thead><tr><th>Meno</th><th>Heslo</th><th></th></tr></thead>
          <tbody id="op-body">${opRows}</tbody></table>
        </div>
        <button class="btn btn-secondary btn-sm" id="add-op">+ Pridať prevádzku</button>
      </div>

      <div class="actions">
        <button class="btn btn-primary" id="save-cfg">Uložiť nastavenia</button>
      </div>`;
  }

  function buildOverridesUI() {
    const sortedOpen = [...S.openDays].sort();
    if (!sortedOpen.length || !S.localStations.length) {
      return '<p class="text-muted">Najprv nastav otvorené dni a stanoviská.</p>';
    }
    // build list of existing overrides
    let rows = '';
    for (const date of sortedOpen) {
      const ov = S.stationOverrides[date] || {};
      for (const [sid, cfg] of Object.entries(ov)) {
        const stn = S.localStations.find(s => s.id === sid);
        if (!stn) continue;
        if (cfg.required === 0 && cfg._mergedInto) continue; // hide auto-generated hidden half, shown alongside primary row
        const reqLabel = cfg.required === 0 ? '<span class="badge badge-warning">Skryté/Zlúčené</span>'
          : `<span class="badge badge-info">${cfg.required} os.</span>`;
        const merged = cfg.mergedLabel ? `→ <em>${esc(cfg.mergedLabel)}</em>` : '';
        rows += `<tr>
          <td>${fmtShort(date)}</td>
          <td>${esc(stn.name)} ${merged}</td>
          <td>${reqLabel}</td>
          <td><button class="btn btn-danger btn-sm ov-rm" data-date="${esc(date)}" data-sid="${esc(sid)}">×</button></td>
        </tr>`;
      }
    }
    const dayOpts = sortedOpen.map(d => `<option value="${esc(d)}">${fmtShort(d)}</option>`).join('');
    const stnOpts = S.localStations.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
    const stnOpts2 = `<option value="">— nespájať —</option>` + S.localStations.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
    return `
      ${rows ? `<table style="margin-bottom:12px;width:auto"><thead><tr><th>Deň</th><th>Stanovisko</th><th>Počet</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="text-muted" style="margin-bottom:10px">Žiadne výnimky.</p>'}
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
        <div class="form-group" style="margin:0">
          <label>Deň</label><select id="ov-date" style="width:140px">${dayOpts}</select>
        </div>
        <div class="form-group" style="margin:0">
          <label>Ponechané stanovisko</label><select id="ov-stn" style="width:150px">${stnOpts}</select>
        </div>
        <div class="form-group" style="margin:0">
          <label>Počet ľudí</label><input type="number" id="ov-req" value="1" min="0" max="10" style="width:70px">
        </div>
        <div class="form-group" style="margin:0">
          <label>Zlúčiť so stanoviskom</label><select id="ov-merge" style="width:170px">${stnOpts2}</select>
        </div>
        <button class="btn btn-secondary btn-sm" id="ov-add" style="align-self:flex-end">+ Pridať výnimku</button>
      </div>
      <p class="text-muted" style="margin-top:8px;font-size:.8rem">Ak vyberieš "Zlúčiť so stanoviskom", ono sa v tento deň v rozpise skryje a jeho brigádnici sa spočítajú do ponechaného stanoviska.</p>`;
  }

  function attachSettings() {
    // Switch the working month — each month keeps its own dates and open days
    document.querySelectorAll('.month-jump').forEach(btn => {
      btn.addEventListener('click', async () => {
        const month = btn.dataset.month;
        if (month === S.data.month) return;
        btn.disabled = true;
        try {
          S.data = await api('PUT', '/api/config', { month });
          syncLocal(); S.tab = 'settings'; renderPanel();
        } catch (e) {
          setMsg('set-msg', `<div class="alert alert-error">Chyba: ${esc(e.message)}</div>`);
          btn.disabled = false;
        }
      });
    });

    // Open-days calendar toggle
    document.querySelectorAll('.cal-day.open-toggle').forEach(cell => {
      cell.addEventListener('click', () => {
        const date = cell.dataset.date;
        if (S.openDays.has(date)) {
          S.openDays.delete(date);
          cell.classList.remove('is-open');
        } else {
          S.openDays.add(date);
          cell.classList.add('is-open');
        }
        rebuildDayHours();
      });
    });

    function rebuildDayHours() {
      const body = document.getElementById('dh-body');
      if (!body) return;
      const defOpen  = document.getElementById('cfg-open')?.value  || S.data.defaultOpensAt  || '10:00';
      const defClose = document.getElementById('cfg-close')?.value || S.data.defaultClosesAt || '19:00';
      const sorted = [...S.openDays].sort();
      body.innerHTML = sorted.map(date => {
        const ds = S.daySettings[date] || {};
        return `<tr>
          <td>${fmtShort(date)}</td>
          <td>${timeInputHTML('dh-open', `data-date="${date}"`, ds.opensAt||defOpen, 'width:110px')}</td>
          <td>${timeInputHTML('dh-close', `data-date="${date}"`, ds.closesAt||defClose, 'width:110px')}</td>
        </tr>`;
      }).join('');
    }

    // Stations
    function rebuildStations() {
      const body = document.getElementById('st-body');
      if (!body) return;
      body.innerHTML = S.localStations.map((st, i) => `
        <tr>
          <td><input type="text" class="st-name" data-i="${i}" value="${esc(st.name)}" placeholder="Meno stanoviska"></td>
          <td><input type="number" class="st-req" data-i="${i}" value="${st.required||1}" min="1" max="20" style="width:70px"></td>
          <td>${timeInputHTML('st-open', `data-i="${i}"`, st.opensAt||'', 'width:105px')}</td>
          <td>${timeInputHTML('st-close', `data-i="${i}"`, st.closesAt||'', 'width:105px')}</td>
          <td><button class="btn btn-danger btn-sm st-rm" data-i="${i}">×</button></td>
        </tr>`).join('');
      body.querySelectorAll('.st-rm').forEach(btn => {
        btn.addEventListener('click', () => {
          S.localStations.splice(+btn.dataset.i, 1);
          rebuildStations(); rebuildWorkers();
        });
      });
    }
    document.getElementById('st-body')?.querySelectorAll('.st-rm').forEach(btn => {
      btn.addEventListener('click', () => { S.localStations.splice(+btn.dataset.i, 1); rebuildStations(); rebuildWorkers(); });
    });
    document.getElementById('add-st')?.addEventListener('click', () => {
      S.localStations.push({ id: 'st_' + Date.now(), name: '', required: 1, opensAt: '', closesAt: '' });
      rebuildStations(); rebuildWorkers();
    });

    // Workers
    function rebuildWorkers() {
      const body = document.getElementById('w-body');
      if (!body) return;
      body.innerHTML = S.localWorkers.map((w, i) => {
        const checks = S.localStations.map(st => `
          <label class="stn-check-lbl">
            <input type="checkbox" class="w-st" data-wi="${i}" data-sid="${esc(st.id)}"
              ${(w.allowedStations||[]).includes(st.id)?'checked':''}>
            ${esc(st.name||'?')}
          </label>`).join('');
        const link = w.token ? `<a href="/worker/${esc(w.token)}" target="_blank" class="btn btn-secondary btn-sm">Odkaz ↗</a>` : '';
        return `<tr>
          <td><input type="text" class="w-name" data-i="${i}" value="${esc(w.name)}" placeholder="Meno"></td>
          <td><div class="stn-checks">${checks||'<span class="text-muted">Pridaj stanoviská</span>'}</div></td>
          <td><input type="password" class="w-pwd" data-i="${i}" placeholder="Nové heslo">
            ${w.hasPassword?`<br><span class="badge badge-info" style="margin-top:3px">Má heslo</span> <label style="font-size:.72rem;cursor:pointer"><input type="checkbox" class="w-pwd-clear" data-i="${i}"> zrušiť</label>`:''}</td>
          <td style="white-space:nowrap">${link} <button class="btn btn-danger btn-sm w-rm" data-i="${i}">×</button></td>
        </tr>`;
      }).join('');
      body.querySelectorAll('.w-rm').forEach(btn => {
        btn.addEventListener('click', () => { S.localWorkers.splice(+btn.dataset.i, 1); rebuildWorkers(); });
      });
    }
    document.getElementById('w-body')?.querySelectorAll('.w-rm').forEach(btn => {
      btn.addEventListener('click', () => { S.localWorkers.splice(+btn.dataset.i, 1); rebuildWorkers(); });
    });
    document.getElementById('add-w')?.addEventListener('click', () => {
      S.localWorkers.push({ id: null, name: '', token: null, hasPassword: false, allowedStations: [] });
      rebuildWorkers();
    });

    // Operators
    function rebuildOperators() {
      const body = document.getElementById('op-body');
      if (!body) return;
      body.innerHTML = S.localOperators.map((o, i) => {
        const link = o.token ? `<a href="/operator/${esc(o.token)}" target="_blank" class="btn btn-secondary btn-sm">Odkaz ↗</a>` : '';
        return `<tr>
          <td><input type="text" class="op-name" data-i="${i}" value="${esc(o.name)}" placeholder="Meno prevádzku"></td>
          <td><input type="password" class="op-pwd" data-i="${i}" placeholder="Nové heslo">
            ${o.hasPassword?`<br><span class="badge badge-info" style="margin-top:3px">Má heslo</span> <label style="font-size:.72rem;cursor:pointer"><input type="checkbox" class="op-pwd-clear" data-i="${i}"> zrušiť</label>`:''}</td>
          <td style="white-space:nowrap">${link} <button class="btn btn-danger btn-sm op-rm" data-i="${i}">×</button></td>
        </tr>`;
      }).join('');
      body.querySelectorAll('.op-rm').forEach(btn => {
        btn.addEventListener('click', () => { S.localOperators.splice(+btn.dataset.i, 1); rebuildOperators(); });
      });
    }
    document.getElementById('op-body')?.querySelectorAll('.op-rm').forEach(btn => {
      btn.addEventListener('click', () => { S.localOperators.splice(+btn.dataset.i, 1); rebuildOperators(); });
    });
    document.getElementById('add-op')?.addEventListener('click', () => {
      S.localOperators.push({ id: null, name: '', token: null, hasPassword: false });
      rebuildOperators();
    });

    // Station overrides
    function refreshOverridesCard() {
      const card = document.getElementById('overrides-card');
      if (card) card.innerHTML = buildOverridesUI();
      attachOverrideHandlers();
    }
    function attachOverrideHandlers() {
      document.querySelectorAll('.ov-rm').forEach(btn => {
        btn.addEventListener('click', () => {
          const { date, sid } = btn.dataset;
          if (S.stationOverrides[date]) {
            const cfg = S.stationOverrides[date][sid];
            delete S.stationOverrides[date][sid];
            // also remove the auto-hidden merge partner, if this was a merge primary
            if (cfg?.mergeWith) delete S.stationOverrides[date][cfg.mergeWith];
            if (!Object.keys(S.stationOverrides[date]).length) delete S.stationOverrides[date];
          }
          refreshOverridesCard();
        });
      });
      document.getElementById('ov-add')?.addEventListener('click', () => {
        const date = document.getElementById('ov-date')?.value;
        const sid  = document.getElementById('ov-stn')?.value;
        const req  = Number(document.getElementById('ov-req')?.value ?? 1);
        const mergeSid = document.getElementById('ov-merge')?.value || '';
        if (!date || !sid) return;
        if (mergeSid && mergeSid === sid) { alert('Nemôžeš zlúčiť stanovisko samo so sebou.'); return; }
        let lbl = '';
        if (mergeSid) {
          const primary = S.localStations.find(s => s.id === sid);
          const secondary = S.localStations.find(s => s.id === mergeSid);
          lbl = `${primary?.name || ''} + ${secondary?.name || ''}`;
        }
        if (!S.stationOverrides[date]) S.stationOverrides[date] = {};
        S.stationOverrides[date][sid] = { required: req, mergedLabel: lbl, mergeWith: mergeSid || null };
        if (mergeSid) {
          S.stationOverrides[date][mergeSid] = { required: 0, mergedLabel: '', _mergedInto: sid };
        }
        refreshOverridesCard();
      });
    }
    attachOverrideHandlers();

    // Save
    document.getElementById('save-cfg')?.addEventListener('click', async () => {
      const btn = document.getElementById('save-cfg');
      btn.disabled = true; btn.textContent = 'Ukladám...';

      // Read stations from DOM
      const stations = S.localStations.map((st, i) => ({
        id: st.id,
        name: document.querySelector(`.st-name[data-i="${i}"]`)?.value?.trim() || '',
        required: Number(document.querySelector(`.st-req[data-i="${i}"]`)?.value) || 1,
        opensAt:  document.querySelector(`.st-open[data-i="${i}"]`)?.value  || '',
        closesAt: document.querySelector(`.st-close[data-i="${i}"]`)?.value || '',
      })).filter(s => s.name);

      const workers = S.localWorkers.map((w, i) => {
        const name = document.querySelector(`.w-name[data-i="${i}"]`)?.value?.trim() || '';
        const pwdTyped = document.querySelector(`.w-pwd[data-i="${i}"]`)?.value || '';
        const clearPwd = document.querySelector(`.w-pwd-clear[data-i="${i}"]`)?.checked;
        const allowedStations = [];
        document.querySelectorAll(`.w-st[data-wi="${i}"]`).forEach(cb => { if (cb.checked) allowedStations.push(cb.dataset.sid); });
        const obj = { id: w.id, name, allowedStations };
        if (clearPwd) obj.password = null;
        else if (pwdTyped) obj.password = pwdTyped;
        return obj;
      }).filter(w => w.name);

      const operators = S.localOperators.map((o, i) => {
        const name = document.querySelector(`.op-name[data-i="${i}"]`)?.value?.trim() || '';
        const pwdTyped = document.querySelector(`.op-pwd[data-i="${i}"]`)?.value || '';
        const clearPwd = document.querySelector(`.op-pwd-clear[data-i="${i}"]`)?.checked;
        const obj = { id: o.id, name };
        if (clearPwd) obj.password = null;
        else if (pwdTyped) obj.password = pwdTyped;
        return obj;
      }).filter(o => o.name);

      const daySettings = {};
      document.querySelectorAll('.dh-open').forEach(inp => {
        const date = inp.dataset.date;
        if (!daySettings[date]) daySettings[date] = {};
        daySettings[date].opensAt = inp.value;
      });
      document.querySelectorAll('.dh-close').forEach(inp => {
        const date = inp.dataset.date;
        if (!daySettings[date]) daySettings[date] = {};
        daySettings[date].closesAt = inp.value;
      });
      // merge station overrides into daySettings
      for (const [date, ovs] of Object.entries(S.stationOverrides)) {
        if (!daySettings[date]) daySettings[date] = {};
        daySettings[date].stationOverrides = ovs;
      }

      try {
        const updated = await api('PUT', '/api/config', {
          month:                document.getElementById('cfg-month')?.value?.trim()  || S.data.month,
          periodStart:          document.getElementById('cfg-start')?.value           || S.data.periodStart,
          periodEnd:            document.getElementById('cfg-end')?.value             || S.data.periodEnd,
          availabilityDeadline: document.getElementById('cfg-deadline')?.value        || '',
          defaultOpensAt:       document.getElementById('cfg-open')?.value            || '10:00',
          defaultClosesAt:      document.getElementById('cfg-close')?.value           || '19:00',
          openDays: [...S.openDays].sort(),
          daySettings, stations, workers, operators, groups: S.localGroups, activeGroup: S.activeGroup,
        });
        S.data = updated;
        syncLocal();
        setMsg('set-msg', '<div class="alert alert-success">✓ Nastavenia boli uložené.</div>');
        S.tab = 'settings';
        renderPanel();
        document.getElementById('set-msg').innerHTML = '<div class="alert alert-success">✓ Nastavenia boli uložené.</div>';
      } catch (e) {
        setMsg('set-msg', `<div class="alert alert-error">Chyba: ${esc(e.message)}</div>`);
        btn.disabled = false; btn.textContent = 'Uložiť nastavenia';
      }
    });
  }

  // ─── SUBMISSIONS TAB ──────────────────────────────────────────────────────
  function buildSubmissions() {
    const workers = S.data.workers || [];
    const submitted = workers.filter(w => w.submitted).length;
    const rows = workers.map(w => {
      const badge = w.submitted
        ? `<span class="badge badge-success">✓ ${fmtDateOnly(w.submittedAt)}</span>`
        : `<span class="badge badge-warning">Neodoslané</span>`;
      const days = (w.unavailableDays||[]).map(d =>
        `<span style="background:#fadbd8;color:#922b21;border-radius:10px;padding:1px 7px;font-size:.75rem;margin:2px;display:inline-block">${fmtShort(d)}</span>`
      ).join('') || '<span class="text-muted">—</span>';
      return `<tr>
        <td><strong>${esc(w.name)}</strong></td>
        <td>${badge}</td>
        <td>${days}</td>
        <td>${w.submitted && w.submissionId
          ? `<button class="btn btn-danger btn-sm del-sub" data-sid="${esc(w.submissionId)}" data-name="${esc(w.name)}">Vymazať</button>`
          : ''}</td>
      </tr>`;
    }).join('');

    return `
      <div class="card">
        <div class="alert alert-info" style="margin-bottom:14px">${submitted} z ${workers.length} brigádnikov odovzdalo dostupnosť</div>
        <div id="sub-msg2"></div>
        <table>
          <thead><tr><th>Meno</th><th>Stav</th><th>Nedostupné dni</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  function attachSubmissions() {
    document.querySelectorAll('.del-sub').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm(`Vymazať odpoveď od ${btn.dataset.name}?`)) return;
        btn.disabled = true;
        try {
          await api('DELETE', `/api/submissions/${btn.dataset.sid}`);
          S.data = await api('GET', '/api/admin');
          syncLocal(); S.tab = 'submissions'; renderPanel();
        } catch (e) {
          setMsg('sub-msg2', `<div class="alert alert-error">Chyba: ${esc(e.message)}</div>`);
          btn.disabled = false;
        }
      });
    });
  }

  // ─── SCHEDULE TAB ─────────────────────────────────────────────────────────
  function buildSchedule() {
    const d = S.data;
    const stations = d.stations || [];
    const openDays = [...(d.openDays||[])].sort();

    if (!openDays.length) {
      return `<div class="card"><div class="alert alert-warning">Najprv nastav otvorené dni v záložke Nastavenia.</div></div>`;
    }

    const pubBadge = d.schedulePublished
      ? `<span class="badge badge-success">✓ Zverejnený</span>`
      : `<span class="badge badge-warning">Nezverejnený</span>`;

    const workerMap = new Map((d.workers||[]).map(w => [w.id, w.name]));

    const thead = `<tr>
      <th>Dátum</th>
      ${stations.map(s => `<th>${esc(s.name)}</th>`).join('')}
      <th>Voľní</th>
    </tr>`;

    const tbody = openDays.map(date => {
      // Ensure schedEdits for this date is initialized
      if (!S.schedEdits[date]) S.schedEdits[date] = {};
      const dayEdits = S.schedEdits[date];
      const swnDay = d.scheduleWithNames?.[date] || {};

      // Workers assigned anywhere today
      const assignedToday = new Set();
      stations.forEach(st => {
        if (swnDay[st.id]?.hidden) return;
        if (!dayEdits[st.id]) dayEdits[st.id] = [...(swnDay[st.id]?.workerIds||[])];
        dayEdits[st.id].forEach(id => assignedToday.add(id));
      });

      const stCells = stations.map(st => {
        const info = swnDay[st.id];
        if (info?.hidden) {
          return `<td class="sched-cell" data-label="${esc(st.name)}" style="background:#f5f5f5;color:#aaa;font-size:.8rem;text-align:center">—</td>`;
        }
        const stationLabel = info?.stationName || st.name;
        const labelHtml = stationLabel !== st.name
          ? `<div style="font-size:.72rem;font-weight:700;color:var(--orange-dark);margin-bottom:3px">${esc(stationLabel)}</div>`
          : '';
        const wids = dayEdits[st.id] || [];
        const chips = wids.map(wid => {
          const w = (d.workers||[]).find(x => x.id === wid);
          const name = workerMap.get(wid) || wid;
          const unavail = (w?.unavailableDays||[]).includes(date);
          return `<span class="worker-chip${unavail ? ' worker-chip-warn' : ''}"${unavail ? ` title="⚠ ${esc(name)} nahlásil(a) tento deň ako nedostupný"` : ''}>${unavail ? '⚠ ' : ''}${esc(name)}<span class="chip-x" data-date="${date}" data-st="${esc(st.id)}" data-wid="${esc(wid)}">×</span></span>`;
        }).join('');

        const mergeIds = new Set([st.id, ...(info?.mergeWith ? [info.mergeWith] : [])]);
        const addable = (d.workers||[]).filter(w =>
          (w.allowedStations||[]).some(sid => mergeIds.has(sid)) && !assignedToday.has(w.id)
        );
        const addSel = addable.length
          ? `<div class="add-worker-row">
              <select class="add-w-sel" data-date="${date}" data-st="${esc(st.id)}" style="width:auto;padding:4px 6px;font-size:.78rem">
                <option value="">+ Pridať...</option>
                ${addable.map(w => `<option value="${esc(w.id)}"${(w.unavailableDays||[]).includes(date) ? ' data-unavail="1"' : ''}>${(w.unavailableDays||[]).includes(date) ? '⚠ ' : ''}${esc(w.name)}${(w.unavailableDays||[]).includes(date) ? ' (nedostupný)' : ''}</option>`).join('')}
              </select>
            </div>` : '';

        return `<td class="sched-cell" data-label="${esc(stationLabel)}">${labelHtml}${chips}${addSel}</td>`;
      }).join('');

      const free = (swnDay._free||[]);
      const freeHtml = free.length
        ? free.map(w => `<span class="free-chip">${esc(w.name)}</span>`).join('')
        : '<span class="text-muted">—</span>';

      return `<tr>
        <td class="sched-date" style="white-space:nowrap"><strong>${fmtShort(date)}</strong></td>
        ${stCells}
        <td class="sched-cell" data-label="Voľní">${freeHtml}</td>
      </tr>`;
    }).join('');

    const groupOpts = `<option value="">Všetci brigádnici</option>` +
      (d.groups||[]).map(g => `<option value="${esc(g.id)}"${S.activeGroup===g.id?' selected':''}>${esc(g.name)} (${(g.workerIds||[]).length} os.)</option>`).join('');

    return `
      <div class="card">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap">
          <label style="font-weight:600;white-space:nowrap">Aktívna skupina:</label>
          <select id="active-group-sel" style="width:220px">${groupOpts}</select>
          <button class="btn btn-secondary btn-sm" id="set-group-btn">Nastaviť</button>
          ${S.activeGroup ? `<span class="badge badge-info">Filtruje: ${esc((d.groups||[]).find(g=>g.id===S.activeGroup)?.name||'')}</span>` : '<span class="text-muted" style="font-size:.84rem">Všetci</span>'}
        </div>
        <div class="actions" style="margin-bottom:14px">
          <button class="btn btn-secondary" id="gen-btn">⟳ Generovať rozpis</button>
          <button class="btn btn-primary" id="save-sched">Uložiť zmeny</button>
          ${d.schedulePublished
            ? `<button class="btn btn-danger" id="unpub-btn">Zrušiť zverejnenie</button>`
            : `<button class="btn btn-success" id="pub-btn">✓ Zverejniť</button>`}
          ${pubBadge}
        </div>
        <div id="sched-msg"></div>
        <div class="sched-wrap">
          <table class="sched-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table>
        </div>
      </div>`;
  }

  function attachSchedule() {
    // Remove worker chip
    document.querySelectorAll('.chip-x').forEach(btn => {
      btn.addEventListener('click', () => {
        const { date, st, wid } = btn.dataset;
        if (!S.schedEdits[date]) S.schedEdits[date] = {};
        if (!S.schedEdits[date][st]) S.schedEdits[date][st] = [...(S.data.scheduleWithNames?.[date]?.[st]?.workerIds||[])];
        S.schedEdits[date][st] = S.schedEdits[date][st].filter(id => id !== wid);
        document.getElementById('tab-content').innerHTML = buildSchedule();
        attachSchedule();
      });
    });

    // Add worker from dropdown
    document.querySelectorAll('.add-w-sel').forEach(sel => {
      sel.addEventListener('change', () => {
        if (!sel.value) return;
        const opt = sel.options[sel.selectedIndex];
        if (opt?.dataset.unavail) {
          const name = opt.textContent.replace('⚠ ', '').replace(' (nedostupný)', '');
          if (!confirm(`⚠ ${name} nahlásil(a) tento deň ako nedostupný. Naozaj ho/ju chceš pridať do rozpisu?`)) {
            sel.value = '';
            return;
          }
        }
        const { date, st } = sel.dataset;
        if (!S.schedEdits[date]) S.schedEdits[date] = {};
        if (!S.schedEdits[date][st]) S.schedEdits[date][st] = [...(S.data.scheduleWithNames?.[date]?.[st]?.workerIds||[])];
        if (!S.schedEdits[date][st].includes(sel.value)) S.schedEdits[date][st].push(sel.value);
        document.getElementById('tab-content').innerHTML = buildSchedule();
        attachSchedule();
      });
    });

    // Set active group
    document.getElementById('set-group-btn')?.addEventListener('click', async () => {
      const btn = document.getElementById('set-group-btn');
      btn.disabled = true;
      try {
        const gid = document.getElementById('active-group-sel')?.value || null;
        await api('PUT', '/api/config', { activeGroup: gid || null });
        S.activeGroup = gid || null;
        S.data.activeGroup = gid || null;
        S.tab = 'schedule'; renderPanel();
      } catch (e) {
        setMsg('sched-msg', `<div class="alert alert-error">Chyba: ${esc(e.message)}</div>`);
        btn.disabled = false;
      }
    });

    // Generate schedule
    function hasManualAssignments() {
      const ma = S.data.manualAssignments?.[S.data.month] || {};
      return Object.values(ma).some(dayAssign => Object.keys(dayAssign || {}).length > 0);
    }

    async function runGenerate(discardManual) {
      const btn = document.getElementById('gen-btn');
      btn.disabled = true; btn.textContent = 'Generujem...';
      try {
        S.data = await api('PUT', '/api/schedule', { discardManual });
        syncLocal(); S.tab = 'schedule'; renderPanel();
      } catch (e) {
        setMsg('sched-msg', `<div class="alert alert-error">Chyba: ${esc(e.message)}</div>`);
        btn.disabled = false; btn.textContent = '⟳ Generovať rozpis';
      }
    }

    document.getElementById('gen-btn')?.addEventListener('click', () => {
      if (!hasManualAssignments()) { runGenerate(false); return; }
      showGenerateConfirmModal({
        onKeep: () => runGenerate(false),
        onDiscard: () => runGenerate(true),
      });
    });

    // Save manual assignments
    document.getElementById('save-sched')?.addEventListener('click', async () => {
      const btn = document.getElementById('save-sched');
      btn.disabled = true; btn.textContent = 'Ukladám...';
      try {
        S.data = await api('PUT', '/api/manual-assignments', { assignments: S.schedEdits });
        syncLocal(); S.tab = 'schedule'; renderPanel();
      } catch (e) {
        setMsg('sched-msg', `<div class="alert alert-error">Chyba: ${esc(e.message)}</div>`);
        btn.disabled = false; btn.textContent = 'Uložiť zmeny';
      }
    });

    // Publish
    document.getElementById('pub-btn')?.addEventListener('click', async () => {
      const btn = document.getElementById('pub-btn');
      btn.disabled = true;
      try {
        await api('PUT', '/api/schedule-publication', { published: true });
        S.data.schedulePublished = true; S.tab = 'schedule'; renderPanel();
      } catch (e) {
        setMsg('sched-msg', `<div class="alert alert-error">Chyba: ${esc(e.message)}</div>`);
        btn.disabled = false;
      }
    });

    // Unpublish
    document.getElementById('unpub-btn')?.addEventListener('click', async () => {
      if (!confirm('Naozaj zrušiť zverejnenie?')) return;
      const btn = document.getElementById('unpub-btn');
      btn.disabled = true;
      try {
        await api('PUT', '/api/schedule-publication', { published: false });
        S.data.schedulePublished = false; S.tab = 'schedule'; renderPanel();
      } catch (e) {
        setMsg('sched-msg', `<div class="alert alert-error">Chyba: ${esc(e.message)}</div>`);
        btn.disabled = false;
      }
    });
  }

  // ─── REQUESTS TAB ─────────────────────────────────────────────────────────
  function buildRequests() {
    const reqs = S.data.changeRequests || [];
    if (!reqs.length) return `<div class="card"><p class="text-muted">Žiadne žiadosti o zmenu.</p></div>`;

    const rows = reqs.map(r => {
      const badge = { pending: '<span class="badge badge-warning">Čaká</span>', approved: '<span class="badge badge-success">Schválená</span>', rejected: '<span class="badge badge-danger">Zamietnutá</span>' }[r.status] || r.status;
      const acts = r.status === 'pending'
        ? `<button class="btn btn-success btn-sm ap-btn" data-id="${esc(r.id)}">Schváliť</button>
           <button class="btn btn-danger btn-sm rj-btn" data-id="${esc(r.id)}" style="margin-left:4px">Zamietnuť</button>`
        : `<span class="text-muted">${r.resolvedAt ? fmtDateOnly(r.resolvedAt) : ''}</span>`;
      return `<tr>
        <td><strong>${esc(r.workerName)}</strong></td>
        <td>${fmtDateOnly(r.requestedAt)}</td>
        <td>${(r.days||[]).map(d => fmtShort(d)).join(', ') || '—'}</td>
        <td>${esc(r.reason)}</td>
        <td>${badge}</td>
        <td style="white-space:nowrap">${acts}</td>
      </tr>`;
    }).join('');

    return `
      <div class="card">
        <div id="req-msg"></div>
        <table>
          <thead><tr><th>Brigádnik</th><th>Podané</th><th>Dni</th><th>Dôvod</th><th>Stav</th><th>Akcia</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  function attachRequests() {
    document.querySelectorAll('.ap-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await api('POST', `/api/change-requests/${btn.dataset.id}/approve`);
          S.data = await api('GET', '/api/admin');
          syncLocal(); S.tab = 'requests'; renderPanel();
        } catch (e) {
          setMsg('req-msg', `<div class="alert alert-error">Chyba: ${esc(e.message)}</div>`);
          btn.disabled = false;
        }
      });
    });
    document.querySelectorAll('.rj-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await api('POST', `/api/change-requests/${btn.dataset.id}/reject`);
          S.data = await api('GET', '/api/admin');
          syncLocal(); S.tab = 'requests'; renderPanel();
        } catch (e) {
          setMsg('req-msg', `<div class="alert alert-error">Chyba: ${esc(e.message)}</div>`);
          btn.disabled = false;
        }
      });
    });
  }

  // ─── EXPORTS TAB ──────────────────────────────────────────────────────────
  function buildExports() {
    return `
      <div class="card">
        <div class="section-title">Exporty dát</div>
        <p class="text-muted" style="margin-bottom:18px">Stiahni dáta vo vybranom formáte.</p>
        <div style="display:flex;flex-direction:column;gap:10px;max-width:380px">
          <a href="/api/export/schedule-print" target="_blank" class="btn btn-primary" style="background:#1a3a6b;color:#f99300">🖨 Rozpis — tlač / PDF (ako vzor)</a>
          <a href="/api/export/schedule.xlsx" class="btn btn-primary">⬇ Rozpis (Excel .xlsx)</a>
          <a href="/api/export/schedule.csv" class="btn btn-secondary">⬇ Rozpis (.csv)</a>
          <a href="/api/export/submissions.csv" class="btn btn-secondary">⬇ Odpovede brigádnikov (.csv)</a>
          <a href="/api/export/hours.csv" class="btn btn-secondary">⬇ Plánované hodiny podľa rozpisu (.csv)</a>
          <a href="/api/export/actual-hours.xlsx" class="btn btn-secondary">⬇ Skutočné odpracované hodiny + rozpory (Excel .xlsx)</a>
          <a href="/api/export/backup.json" class="btn btn-secondary">⬇ Záloha všetkých dát (.json)</a>
        </div>
      </div>`;
  }

  // ─── SKUPINY TAB ──────────────────────────────────────────────────────────
  function buildSkupiny() {
    const workers = S.data.workers || [];
    if (!workers.length) {
      return `<div class="card"><div class="alert alert-warning">Najprv pridaj brigádnikov v záložke Nastavenia.</div></div>`;
    }

    const groupCards = S.localGroups.map((grp, gi) => {
      const inGroup = new Set(grp.workerIds || []);
      const rows = workers.map(w => `
        <label style="display:flex;align-items:center;gap:8px;padding:4px 0;cursor:pointer">
          <input type="checkbox" class="grp-w" data-gi="${gi}" data-wid="${esc(w.id)}" ${inGroup.has(w.id)?'checked':''}>
          <span>${esc(w.name)}</span>
        </label>`).join('');
      const isActive = S.activeGroup === grp.id;
      return `
        <div class="card" style="border:2px solid ${isActive ? 'var(--orange)' : 'var(--border)'}">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
            <input type="text" class="grp-name" data-gi="${gi}" value="${esc(grp.name)}" placeholder="Názov skupiny" style="flex:1;font-weight:600">
            ${isActive ? '<span class="badge badge-success">Aktívna</span>' : ''}
            <button class="btn btn-danger btn-sm grp-rm" data-gi="${gi}">× Odstrániť</button>
          </div>
          <div style="columns:3;column-gap:10px">${rows}</div>
        </div>`;
    }).join('');

    return `
      <div id="grp-msg"></div>
      <div style="display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap;align-items:center">
        <button class="btn btn-secondary" id="add-grp">+ Nová skupina</button>
        <button class="btn btn-primary" id="save-grps">Uložiť skupiny</button>
        <span class="text-muted" style="font-size:.84rem">Skupiny určujú kto sa plánuje do rozpisu. Aktívnu skupinu nastavíš v záložke Rozpis.</span>
      </div>
      ${groupCards || '<div class="card"><p class="text-muted">Zatiaľ žiadne skupiny. Klikni na "Nová skupina".</p></div>'}`;
  }

  function attachSkupiny() {
    function rebuildSkupiny() {
      const el = document.getElementById('tab-content');
      if (el) { el.innerHTML = buildSkupiny(); attachSkupiny(); }
    }

    document.getElementById('add-grp')?.addEventListener('click', () => {
      S.localGroups.push({ id: 'grp_' + Date.now(), name: '', workerIds: [] });
      rebuildSkupiny();
    });

    document.querySelectorAll('.grp-rm').forEach(btn => {
      btn.addEventListener('click', () => {
        const gi = +btn.dataset.gi;
        const grp = S.localGroups[gi];
        if (S.activeGroup === grp?.id) S.activeGroup = null;
        S.localGroups.splice(gi, 1);
        rebuildSkupiny();
      });
    });

    document.querySelectorAll('.grp-w').forEach(cb => {
      cb.addEventListener('change', () => {
        const gi = +cb.dataset.gi;
        const wid = cb.dataset.wid;
        if (!S.localGroups[gi].workerIds) S.localGroups[gi].workerIds = [];
        if (cb.checked) {
          if (!S.localGroups[gi].workerIds.includes(wid)) S.localGroups[gi].workerIds.push(wid);
        } else {
          S.localGroups[gi].workerIds = S.localGroups[gi].workerIds.filter(id => id !== wid);
        }
      });
    });

    document.getElementById('save-grps')?.addEventListener('click', async () => {
      const btn = document.getElementById('save-grps');
      btn.disabled = true; btn.textContent = 'Ukladám...';
      const groups = S.localGroups.map((g, gi) => ({
        id: g.id,
        name: document.querySelector(`.grp-name[data-gi="${gi}"]`)?.value?.trim() || g.name,
        workerIds: g.workerIds || [],
      })).filter(g => g.name);
      try {
        await api('PUT', '/api/config', { groups, activeGroup: S.activeGroup });
        S.data = await api('GET', '/api/admin');
        syncLocal(); S.tab = 'skupiny'; renderPanel();
        document.getElementById('grp-msg').innerHTML = '<div class="alert alert-success">✓ Skupiny boli uložené.</div>';
      } catch (e) {
        setMsg('grp-msg', `<div class="alert alert-error">Chyba: ${esc(e.message)}</div>`);
        btn.disabled = false; btn.textContent = 'Uložiť skupiny';
      }
    });
  }

  // ─── ADMIN HOURS TAB ──────────────────────────────────────────────────────
  function hoursFromRange(start, end) {
    const toMin = t => { const [h, m] = (t || '0:00').split(':').map(Number); return (h||0)*60 + (m||0); };
    const mins = toMin(end) - toMin(start);
    return mins > 0 ? mins / 60 : 0;
  }

  function buildAdminHours() {
    const d = S.data;
    const logs = d.hourLogs || [];
    const stationMap = new Map((d.stations || []).map(s => [s.id, s.name]));

    if (!logs.length) {
      return `<div class="card"><p class="text-muted">Zatiaľ neboli nahlásené žiadne odpracované hodiny.</p></div>`;
    }

    // Per-worker approved totals
    const totals = new Map();
    for (const h of logs) {
      if (h.status !== 'approved') continue;
      const hrs = hoursFromRange(h.approvedStart, h.approvedEnd);
      const cur = totals.get(h.workerName) || { shifts: 0, hours: 0 };
      cur.shifts += 1; cur.hours += hrs;
      totals.set(h.workerName, cur);
    }
    const totalRows = [...totals.entries()]
      .sort((a, b) => b[1].hours - a[1].hours)
      .map(([name, v]) => `<tr><td>${esc(name)}</td><td>${v.shifts}</td><td><strong>${v.hours.toFixed(1)} h</strong></td></tr>`)
      .join('');

    const discrepancies = logs.filter(h =>
      h.status === 'approved' && (h.reportedStart !== h.approvedStart || h.reportedEnd !== h.approvedEnd)
    );
    const pending = logs.filter(h => h.status === 'pending');

    const detailRows = [...logs]
      .sort((a, b) => b.date.localeCompare(a.date))
      .map(h => {
        const stn = esc(stationMap.get(h.stationId) || h.stationId);
        const who = h.substituteFor
          ? `${esc(h.workerName)} <span class="text-muted" style="font-size:.76rem">(za ${esc(h.substituteForName||'?')})</span>`
          : esc(h.workerName);
        if (h.status !== 'approved') {
          return `<tr>
            <td>${fmtShort(h.date)}</td><td>${stn}</td><td>${who}</td>
            <td>${esc(h.reportedStart)}–${esc(h.reportedEnd)}</td>
            <td><span class="badge badge-warning">⏳ Čaká</span></td>
            <td>—</td><td>—</td>
          </tr>`;
        }
        const mismatch = (h.reportedStart !== h.approvedStart || h.reportedEnd !== h.approvedEnd);
        const diffH = hoursFromRange(h.approvedStart, h.approvedEnd) - hoursFromRange(h.reportedStart, h.reportedEnd);
        return `<tr${mismatch ? ' style="background:#fdf3f2"' : ''}>
          <td>${fmtShort(h.date)}</td><td>${stn}</td><td>${who}</td>
          <td>${esc(h.reportedStart)}–${esc(h.reportedEnd)}</td>
          <td>${esc(h.approvedStart)}–${esc(h.approvedEnd)}</td>
          <td>${mismatch
            ? `<span class="badge badge-danger">⚠ Nezhoda ${diffH > 0 ? '+' : ''}${diffH.toFixed(1)} h</span>`
            : '<span class="badge badge-success">✓ Zhoda</span>'}</td>
          <td class="text-muted" style="font-size:.8rem">${esc(h.approvedByName || '')}</td>
        </tr>`;
      }).join('');

    return `
      <div class="card">
        <div class="section-title">Súhrn schválených hodín &mdash; ${esc(d.month)}</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">
          ${pending.length ? `<span class="badge badge-warning">⏳ ${pending.length} čaká na schválenie</span>` : ''}
          ${discrepancies.length ? `<span class="badge badge-danger">⚠ ${discrepancies.length} nezhôd</span>` : '<span class="badge badge-success">✓ Žiadne nezhody</span>'}
        </div>
        ${totalRows
          ? `<div style="overflow-x:auto"><table style="width:auto">
              <thead><tr><th>Brigádnik</th><th>Zmeny</th><th>Schválené hodiny</th></tr></thead>
              <tbody>${totalRows}</tbody></table></div>`
          : '<p class="text-muted">Zatiaľ nič schválené.</p>'}
        <div class="actions">
          <a href="/api/export/actual-hours.xlsx" class="btn btn-primary">⬇ Exportovať mesačný výkaz (Excel)</a>
        </div>
      </div>

      <div class="card">
        <div class="section-title">Detail všetkých záznamov</div>
        <p class="text-muted" style="margin-bottom:10px;font-size:.84rem">Nezhoda znamená, že prevádzkar schválil iný čas, než brigádnik nahlásil. Prevádzkar nahlásený čas nevidí — schvaľuje nezávisle.</p>
        <div style="overflow-x:auto">
          <table>
            <thead><tr><th>Dátum</th><th>Stanovisko</th><th>Brigádnik</th><th>Nahlásil</th><th>Schválené</th><th>Kontrola</th><th>Schválil</th></tr></thead>
            <tbody>${detailRows}</tbody>
          </table>
        </div>
      </div>`;
  }

  // ─── AGENT TAB ────────────────────────────────────────────────────────────

  // Ready-to-send WhatsApp texts, built locally from the loaded admin data —
  // no API key and no cost, since there's nothing here an LLM does better
  // than a template with the right facts filled in.
  const MSG_TYPES = {
    availability: 'Výzva na vyplnenie dostupnosti',
    schedule:     'Rozpis je zverejnený',
    hours:        'Pripomienka — zapíš si hodiny',
  };

  function workerLink(w) {
    return `${location.origin}/worker/${w.token}`;
  }

  function deadlineText(d) {
    if (!d.availabilityDeadline) return null;
    const dt = new Date(d.availabilityDeadline);
    if (isNaN(dt)) return null;
    const pad = n => String(n).padStart(2, '0');
    return `${pad(dt.getDate())}.${pad(dt.getMonth() + 1)}.${dt.getFullYear()}`;
  }

  function shiftsForWorker(d, wid) {
    const out = [];
    for (const [date, st] of Object.entries(d.scheduleWithNames || {})) {
      for (const [sid, info] of Object.entries(st)) {
        if (sid.startsWith('_') || info.hidden) continue;
        if ((info.workerIds || []).includes(wid)) {
          out.push({ date, station: info.stationName, from: info.opensAt, to: info.closesAt });
        }
      }
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }

  // Shifts already past whose hours were never logged — who needs a nudge.
  // Today is excluded: the shift may still be running, and the worker can
  // still log it themselves until midnight.
  function missingHourShifts(d, wid) {
    const today = localTodayISO();
    const logged = new Set((d.hourLogs || [])
      .filter(h => h.workerId === wid)
      .map(h => `${h.date}|${h.stationId}`));
    return shiftsForWorker(d, wid).filter(s => {
      if (s.date >= today) return false;
      const info = d.scheduleWithNames?.[s.date] || {};
      const sid = Object.keys(info).find(k => !k.startsWith('_') && info[k].stationName === s.station);
      return sid ? !logged.has(`${s.date}|${sid}`) : false;
    });
  }

  function buildMessageFor(d, w, type) {
    const link = workerLink(w);
    if (type === 'availability') {
      const dl = deadlineText(d);
      return `Ahoj ${w.name}, otvor si prosím svoj odkaz a vyplň, kedy v ${d.month} NEMÔŽEŠ pracovať.`
        + (dl ? `\nUzávierka je ${dl}.` : '')
        + `\n\n${link}\n\nVďaka! Cyril`;
    }
    if (type === 'schedule') {
      const sh = shiftsForWorker(d, w.id);
      if (!sh.length) {
        return `Ahoj ${w.name}, rozpis na ${d.month} je zverejnený — tento raz na teba nevyšla žiadna zmena.\n\n${link}\n\nCyril`;
      }
      const list = sh.map(s => `• ${fmtShort(s.date)} — ${s.station}, ${s.from}–${s.to}`).join('\n');
      return `Ahoj ${w.name}, rozpis na ${d.month} je zverejnený. Máš ${sh.length} ${sh.length === 1 ? 'zmenu' : (sh.length <= 4 ? 'zmeny' : 'zmien')}:\n\n${list}\n\nCelý rozpis: ${link}\n\nCyril`;
    }
    const miss = missingHourShifts(d, w.id);
    const list = miss.map(s => `• ${fmtShort(s.date)} — ${s.station}`).join('\n');
    return `Ahoj ${w.name}, chýbajú mi od teba zapísané hodiny za:\n\n${list}\n\nHodiny sa dajú zapísať len v deň zmeny, takže mi ich prosím pošli správou alebo sa ozvi prevádzkarovi.\n\nCyril`;
  }

  function messageRecipients(d, type) {
    const workers = (d.workers || []).filter(w => w.token);
    if (type !== 'hours') return workers;
    return workers.filter(w => missingHourShifts(d, w.id).length > 0);
  }

  function buildMessages() {
    const d = S.data;
    const type = S.msgType || 'availability';
    const recips = messageRecipients(d, type);

    const opts = Object.entries(MSG_TYPES)
      .map(([k, label]) => `<option value="${k}"${k === type ? ' selected' : ''}>${label}</option>`).join('');

    const cards = recips.map((w, i) => {
      const text = buildMessageFor(d, w, type);
      return `<div style="border:1px solid var(--border);border-radius:8px;padding:10px 12px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <strong style="flex:1">${esc(w.name)}</strong>
          <button class="btn btn-secondary btn-sm msg-copy" data-i="${i}">Kopírovať</button>
        </div>
        <textarea class="msg-body" data-i="${i}" rows="${Math.min(12, text.split('\n').length + 1)}"
          style="width:100%;font-size:.82rem;font-family:inherit;resize:vertical">${esc(text)}</textarea>
      </div>`;
    }).join('');

    const empty = type === 'hours'
      ? 'Nikomu nechýbajú zapísané hodiny — všetci to majú v poriadku.'
      : 'Žiadni brigádnici s osobným odkazom.';

    return `
      <div class="card">
        <div class="section-title">📨 Správy pre brigádnikov <span class="text-muted" style="font-size:.78rem;font-weight:400">(lokálne, bez AI)</span></div>
        <p class="text-muted" style="margin-bottom:12px;font-size:.86rem">
          Hotové texty aj s osobným odkazom každého brigádnika — skopíruj a pošli cez WhatsApp.
        </p>
        <div class="form-row" style="align-items:flex-end">
          <div class="form-group" style="max-width:320px">
            <label>Typ správy</label>
            <select id="msg-type">${opts}</select>
          </div>
          <div class="form-group" style="flex:none">
            <button class="btn btn-secondary" id="msg-copy-all">Kopírovať všetky</button>
          </div>
        </div>
        <div id="msg-msg"></div>
        ${recips.length
          ? `<div style="display:flex;flex-direction:column;gap:10px;margin-top:6px">${cards}</div>`
          : `<p class="text-muted">${empty}</p>`}
      </div>`;
  }

  function attachMessages() {
    document.getElementById('msg-type')?.addEventListener('change', e => {
      S.msgType = e.target.value;
      document.getElementById('tab-content').innerHTML = buildAgent();
      attachAgent();
    });

    async function copyText(text, okMsg) {
      try {
        await navigator.clipboard.writeText(text);
        setMsg('msg-msg', `<div class="alert alert-success">✓ ${okMsg}</div>`);
      } catch {
        setMsg('msg-msg', '<div class="alert alert-error">Kopírovanie zlyhalo — označ text a skopíruj ručne.</div>');
      }
    }

    document.querySelectorAll('.msg-copy').forEach(btn => {
      btn.addEventListener('click', () => {
        const ta = document.querySelector(`.msg-body[data-i="${btn.dataset.i}"]`);
        if (ta) copyText(ta.value, 'Správa skopírovaná.');
      });
    });

    document.getElementById('msg-copy-all')?.addEventListener('click', () => {
      const all = [...document.querySelectorAll('.msg-body')].map(t => t.value).join('\n\n———\n\n');
      if (all) copyText(all, 'Všetky správy skopírované.');
    });
  }

  function computeShiftCounts(d) {
    const counts = new Map();
    for (const w of d.workers || []) counts.set(w.id, 0);
    for (const st of Object.values(d.scheduleWithNames || {})) {
      for (const [sid, info] of Object.entries(st)) {
        if (sid.startsWith('_') || info.hidden) continue;
        (info.workerIds || []).forEach(wid => counts.set(wid, (counts.get(wid) || 0) + 1));
      }
    }
    return counts;
  }

  function buildQuickOverview() {
    const d = S.data;
    const workers = d.workers || [];
    const openDays = [...(d.openDays || [])].sort();

    if (!openDays.length || !workers.length) {
      return `<div class="card"><p class="text-muted">Najprv nastav otvorené dni a brigádnikov, potom vygeneruj rozpis.</p></div>`;
    }

    const counts = computeShiftCounts(d);
    const wh = d.workerHours || {};
    const countRows = [...counts.entries()]
      .map(([wid, c]) => ({ name: (workers.find(w => w.id === wid) || {}).name || wid, count: c, hours: wh[wid]?.hours || 0 }))
      .sort((a, b) => b.hours - a.hours)
      .map(r => `<tr><td>${esc(r.name)}</td><td><span class="badge badge-info">${r.count} zmien</span></td><td><span class="badge badge-success">${r.hours.toFixed(1)} h</span></td></tr>`)
      .join('');

    const dateOpts = openDays.map(dt => `<option value="${esc(dt)}">${fmtShort(dt)}</option>`).join('');
    const workerOpts = workers.map(w => `<option value="${esc(w.id)}">${esc(w.name)}</option>`).join('');

    return `
      <div class="card">
        <div class="section-title">📊 Rýchly prehľad <span class="text-muted" style="font-size:.78rem;font-weight:400">(lokálne, bez AI — okamžité)</span></div>
        <div class="form-row">
          <div class="form-group">
            <label>Kto robí v deň...</label>
            <select id="qa-date-sel">${dateOpts}</select>
          </div>
          <div class="form-group">
            <label>Kedy pracuje...</label>
            <select id="qa-worker-sel">${workerOpts}</select>
          </div>
        </div>
        <div id="qa-result" style="margin-top:6px"></div>

        <div class="section-title" style="margin-top:18px">Zmeny a odpracované hodiny v mesiaci</div>
        <div style="overflow-x:auto">
          <table style="width:auto"><thead><tr><th>Brigádnik</th><th>Zmeny</th><th>Hodiny</th></tr></thead><tbody>${countRows}</tbody></table>
        </div>
      </div>`;
  }

  function renderQuickAnswers() {
    const d = S.data;
    const dateSel = document.getElementById('qa-date-sel');
    const workerSel = document.getElementById('qa-worker-sel');
    const out = document.getElementById('qa-result');
    if (!out) return;

    let html = '';

    if (dateSel?.value) {
      const date = dateSel.value;
      const swnDay = d.scheduleWithNames?.[date] || {};
      const rows = (d.stations || []).map(st => {
        const info = swnDay[st.id];
        if (!info || info.hidden) return '';
        const names = (info.workerNames || []);
        return `<div style="margin-bottom:4px"><strong>${esc(info.stationName || st.name)}:</strong> ${names.length ? names.map(esc).join(', ') : '<span class="text-muted">nikto priradený</span>'}</div>`;
      }).join('');
      const free = (swnDay._free || []).map(w => esc(w.name)).join(', ');
      html += `<div class="alert alert-info" style="margin-bottom:10px"><strong>${fmtFull(date)}</strong><br>${rows}${free ? `<div style="margin-top:4px"><strong>Voľní:</strong> ${free}</div>` : ''}</div>`;
    }

    if (workerSel?.value) {
      const wid = workerSel.value;
      const wname = (d.workers || []).find(w => w.id === wid)?.name || wid;
      const shifts = [];
      for (const [date, st] of Object.entries(d.scheduleWithNames || {})) {
        for (const [sid, info] of Object.entries(st)) {
          if (sid.startsWith('_') || info.hidden) continue;
          if ((info.workerIds || []).includes(wid)) {
            shifts.push({ date, station: info.stationName });
          }
        }
      }
      shifts.sort((a, b) => a.date.localeCompare(b.date));
      html += `<div class="alert alert-info"><strong>${esc(wname)}</strong> — ${shifts.length} zmien tento mesiac<br>${
        shifts.length ? shifts.map(s => `${fmtShort(s.date)}: ${esc(s.station)}`).join('<br>') : '<span class="text-muted">Žiadne priradené zmeny.</span>'
      }</div>`;
    }

    out.innerHTML = html;
  }

  function attachQuickOverview() {
    document.getElementById('qa-date-sel')?.addEventListener('change', renderQuickAnswers);
    document.getElementById('qa-worker-sel')?.addEventListener('change', renderQuickAnswers);
    renderQuickAnswers();
  }

  function buildAgent() {
    return `
      ${buildQuickOverview()}
      ${buildMessages()}`;
  }

  function attachAgent() {
    attachQuickOverview();
    attachMessages();
  }

  // ─── Global 24h time input formatting ───────────────────────────────────────
  document.addEventListener('input', (e) => {
    const el = e.target;
    if (!el.classList || !el.classList.contains('time-input')) return;
    let digits = el.value.replace(/[^0-9]/g, '').slice(0, 4);
    let v = digits;
    if (digits.length >= 3) v = digits.slice(0, 2) + ':' + digits.slice(2);
    el.value = v;
  });
  document.addEventListener('blur', (e) => {
    const el = e.target;
    if (!el.classList || !el.classList.contains('time-input')) return;
    const m = el.value.match(/^(\d{1,2}):?(\d{0,2})$/);
    if (!m || !el.value) return;
    const h = Math.min(23, parseInt(m[1] || '0', 10));
    const mi = Math.min(59, parseInt(m[2] || '0', 10));
    el.value = String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
  }, true);

  // ─── ROUTER ───────────────────────────────────────────────────────────────
  function init() {
    const path = location.pathname;
    const wm = path.match(/^\/worker\/([a-zA-Z0-9]+)/);
    const om = path.match(/^\/operator\/([a-zA-Z0-9]+)/);
    if (wm) {
      S.view = 'worker'; S.token = wm[1]; initWorker();
    } else if (om) {
      S.view = 'operator'; S.token = om[1]; initOperator();
    } else {
      S.view = 'admin'; initAdmin();
    }
  }

  window.addEventListener('load', init);
})();
