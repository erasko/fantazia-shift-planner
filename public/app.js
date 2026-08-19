(function () {
  'use strict';

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
    agentHistory: [],
  };

  // ─── Utils ────────────────────────────────────────────────────────────────
  const app = document.getElementById('app');

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function fmtShort(iso) {
    if (!iso) return '';
    const d = new Date(iso + 'T12:00:00');
    const days = ['Ne','Po','Ut','St','Šv','Pi','So'];
    return `${d.getDate()}. ${d.getMonth()+1}. (${days[d.getDay()]})`;
  }

  function fmtFull(iso) {
    if (!iso) return '';
    const d = new Date(iso + 'T12:00:00');
    const months = ['jan','feb','mar','apr','máj','jún','júl','aug','sep','okt','nov','dec'];
    const days = ['Ne','Po','Ut','St','Šv','Pi','So'];
    return `${d.getDate()}. ${months[d.getMonth()]} ${d.getFullYear()} (${days[d.getDay()]})`;
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

    const noticeHtml = published
      ? `<div class="notice-published">✓ Rozpis bol zverejnený. Zmeny dostupnosti sú uzamknuté.</div>`
      : locked
        ? `<div class="notice-locked">⏰ Deadline na odovzdanie uplynul. Môžeš podať žiadosť o zmenu.</div>`
        : '';

    const calHtml = buildCalendar(d.periodStart, d.periodEnd, d.openDays, [...S.selectedDays], 'worker');

    // Confirmed schedule
    let schedHtml = '';
    if (published) {
      const shifts = d.confirmedSchedule || [];
      schedHtml = `<div class="card"><div class="section-title">Tvoj rozpis</div>${
        shifts.length === 0
          ? '<p class="text-muted">V tomto období nemáš žiadne pridelené zmeny.</p>'
          : `<ul class="shifts-list">${shifts.map(s => `
              <li class="shift-item">
                <span class="shift-date">${fmtShort(s.date)}</span>
                <span class="shift-stn">${esc(s.stationName)}</span>
                <span class="shift-time">${esc(s.opensAt)}–${esc(s.closesAt)}</span>
              </li>`).join('')}</ul>`
      }</div>`;
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
          <div class="section-title">Moja dostupnosť${locked ? ' (uzamknutá)' : ''}</div>
          ${!locked ? `<p class="text-muted" style="margin-bottom:10px">Klikni na deň keď <strong>NEMÔŽEŠ</strong> pracovať (červená). Ostatné dni = dostupný.</p>` : ''}
          ${calHtml}
          ${d.submittedAt ? `<p class="text-muted" style="margin-top:8px">Naposledy odoslané: ${new Date(d.submittedAt).toLocaleString('sk-SK')}</p>` : ''}
          ${!locked ? `
            <div class="actions">
              <button class="btn btn-primary" id="sub-btn">Odoslať dostupnosť</button>
            </div>
            <div id="sub-msg" style="margin-top:8px"></div>` : ''}
        </div>
        ${schedHtml}
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

    const stations = d.stations || [];
    const openDays = (d.openDays || []).slice().sort();
    const sched = d.schedule || {};

    const thead = `<tr><th>Dátum</th>${stations.map(s => `<th>${esc(s.name)}</th>`).join('')}</tr>`;
    const tbody = openDays.map(date => {
      const cells = stations.map(st => {
        const cell = sched[date]?.[st.id] || {};
        if (cell.hidden) {
          return `<td class="sched-cell" style="background:#f5f5f5;color:#aaa;font-size:.8rem;text-align:center">—</td>`;
        }
        const names = (cell.workers || []);
        const time = `${cell.opensAt || ''}–${cell.closesAt || ''}`;
        const label = cell.stationName && cell.stationName !== st.name ? `<div style="font-size:.7rem;font-weight:600;color:var(--orange-dark);margin-bottom:2px">${esc(cell.stationName)}</div>` : '';
        return `<td class="sched-cell">
          ${label}
          <div class="text-muted" style="font-size:.75rem;margin-bottom:3px">${esc(time)}</div>
          ${names.map(n => `<span class="worker-chip">${esc(n)}</span>`).join('') || '<span class="text-muted">—</span>'}
        </td>`;
      }).join('');
      return `<tr><td><strong>${fmtShort(date)}</strong></td>${cells}</tr>`;
    }).join('');

    app.innerHTML = header + `
      <div class="container">
        <div class="card">
          <div class="sched-wrap">
            <table class="sched-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table>
          </div>
        </div>
      </div>`;
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
        <td><input type="time" class="dh-open" data-date="${date}" value="${esc(ds.opensAt || d.defaultOpensAt || '10:00')}" style="width:110px"></td>
        <td><input type="time" class="dh-close" data-date="${date}" value="${esc(ds.closesAt || d.defaultClosesAt || '19:00')}" style="width:110px"></td>
      </tr>`;
    }).join('');

    const stRows = S.localStations.map((st, i) => `
      <tr>
        <td><input type="text" class="st-name" data-i="${i}" value="${esc(st.name)}" placeholder="Meno stanoviska"></td>
        <td><input type="number" class="st-req" data-i="${i}" value="${st.required||1}" min="1" max="20" style="width:70px"></td>
        <td><input type="time" class="st-open" data-i="${i}" value="${esc(st.opensAt||'')}" style="width:105px"></td>
        <td><input type="time" class="st-close" data-i="${i}" value="${esc(st.closesAt||'')}" style="width:105px"></td>
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
          ${w.hasPassword?'<br><span class="badge badge-info" style="margin-top:3px">Má heslo</span>':''}</td>
        <td style="white-space:nowrap">${link} <button class="btn btn-danger btn-sm w-rm" data-i="${i}">×</button></td>
      </tr>`;
    }).join('');

    const opRows = S.localOperators.map((o, i) => {
      const link = o.token ? `<a href="/operator/${esc(o.token)}" target="_blank" class="btn btn-secondary btn-sm">Odkaz ↗</a>` : '';
      return `<tr>
        <td><input type="text" class="op-name" data-i="${i}" value="${esc(o.name)}" placeholder="Meno prevádzku"></td>
        <td><input type="password" class="op-pwd" data-i="${i}" placeholder="Nové heslo">
          ${o.hasPassword?'<br><span class="badge badge-info" style="margin-top:3px">Má heslo</span>':''}</td>
        <td style="white-space:nowrap">${link} <button class="btn btn-danger btn-sm op-rm" data-i="${i}">×</button></td>
      </tr>`;
    }).join('');

    return `
      <div id="set-msg"></div>
      <div class="card">
        <div class="section-title">Plánovacie obdobie</div>
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
            <input type="time" id="cfg-open" value="${esc(d.defaultOpensAt||'10:00')}">
          </div>
          <div class="form-group">
            <label>Štandardný čas do</label>
            <input type="time" id="cfg-close" value="${esc(d.defaultClosesAt||'19:00')}">
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
    return `
      ${rows ? `<table style="margin-bottom:12px;width:auto"><thead><tr><th>Deň</th><th>Stanovisko</th><th>Počet</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="text-muted" style="margin-bottom:10px">Žiadne výnimky.</p>'}
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
        <div class="form-group" style="margin:0">
          <label>Deň</label><select id="ov-date" style="width:140px">${dayOpts}</select>
        </div>
        <div class="form-group" style="margin:0">
          <label>Stanovisko</label><select id="ov-stn" style="width:140px">${stnOpts}</select>
        </div>
        <div class="form-group" style="margin:0">
          <label>Počet ľudí</label><input type="number" id="ov-req" value="1" min="0" max="10" style="width:70px">
        </div>
        <div class="form-group" style="margin:0">
          <label>Zlúčiť s (voliteľné)</label><input type="text" id="ov-label" placeholder="napr. Bumpers + Space Cars" style="width:200px">
        </div>
        <button class="btn btn-secondary btn-sm" id="ov-add" style="align-self:flex-end">+ Pridať výnimku</button>
      </div>`;
  }

  function attachSettings() {
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
          <td><input type="time" class="dh-open" data-date="${date}" value="${ds.opensAt||defOpen}" style="width:110px"></td>
          <td><input type="time" class="dh-close" data-date="${date}" value="${ds.closesAt||defClose}" style="width:110px"></td>
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
          <td><input type="time" class="st-open" data-i="${i}" value="${esc(st.opensAt||'')}" style="width:105px"></td>
          <td><input type="time" class="st-close" data-i="${i}" value="${esc(st.closesAt||'')}" style="width:105px"></td>
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
            ${w.hasPassword?'<br><span class="badge badge-info" style="margin-top:3px">Má heslo</span>':''}</td>
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
            ${o.hasPassword?'<br><span class="badge badge-info" style="margin-top:3px">Má heslo</span>':''}</td>
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
            delete S.stationOverrides[date][sid];
            if (!Object.keys(S.stationOverrides[date]).length) delete S.stationOverrides[date];
          }
          refreshOverridesCard();
        });
      });
      document.getElementById('ov-add')?.addEventListener('click', () => {
        const date = document.getElementById('ov-date')?.value;
        const sid  = document.getElementById('ov-stn')?.value;
        const req  = Number(document.getElementById('ov-req')?.value ?? 1);
        const lbl  = document.getElementById('ov-label')?.value?.trim() || '';
        if (!date || !sid) return;
        if (!S.stationOverrides[date]) S.stationOverrides[date] = {};
        S.stationOverrides[date][sid] = { required: req, mergedLabel: lbl };
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
        const password = document.querySelector(`.w-pwd[data-i="${i}"]`)?.value || '';
        const allowedStations = [];
        document.querySelectorAll(`.w-st[data-wi="${i}"]`).forEach(cb => { if (cb.checked) allowedStations.push(cb.dataset.sid); });
        return { id: w.id, name, password, allowedStations };
      }).filter(w => w.name);

      const operators = S.localOperators.map((o, i) => ({
        id: o.id,
        name:     document.querySelector(`.op-name[data-i="${i}"]`)?.value?.trim() || '',
        password: document.querySelector(`.op-pwd[data-i="${i}"]`)?.value || '',
      })).filter(o => o.name);

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
        ? `<span class="badge badge-success">✓ ${new Date(w.submittedAt).toLocaleDateString('sk-SK')}</span>`
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
          return `<td class="sched-cell" style="background:#f5f5f5;color:#aaa;font-size:.8rem;text-align:center">—</td>`;
        }
        const stationLabel = info?.stationName || st.name;
        const wids = dayEdits[st.id] || [];
        const chips = wids.map(wid => {
          const w = (d.workers||[]).find(x => x.id === wid);
          const name = workerMap.get(wid) || wid;
          const unavail = (w?.unavailableDays||[]).includes(date);
          return `<span class="worker-chip${unavail ? ' worker-chip-warn' : ''}"${unavail ? ` title="⚠ ${esc(name)} nahlásil(a) tento deň ako nedostupný"` : ''}>${unavail ? '⚠ ' : ''}${esc(name)}<span class="chip-x" data-date="${date}" data-st="${esc(st.id)}" data-wid="${esc(wid)}">×</span></span>`;
        }).join('');

        const addable = (d.workers||[]).filter(w =>
          (w.allowedStations||[]).includes(st.id) && !assignedToday.has(w.id)
        );
        const addSel = addable.length
          ? `<div class="add-worker-row">
              <select class="add-w-sel" data-date="${date}" data-st="${esc(st.id)}" style="width:auto;padding:4px 6px;font-size:.78rem">
                <option value="">+ Pridať...</option>
                ${addable.map(w => `<option value="${esc(w.id)}"${(w.unavailableDays||[]).includes(date) ? ' data-unavail="1"' : ''}>${(w.unavailableDays||[]).includes(date) ? '⚠ ' : ''}${esc(w.name)}${(w.unavailableDays||[]).includes(date) ? ' (nedostupný)' : ''}</option>`).join('')}
              </select>
            </div>` : '';

        return `<td class="sched-cell">${chips}${addSel}</td>`;
      }).join('');

      const free = (swnDay._free||[]);
      const freeHtml = free.length
        ? free.map(w => `<span class="free-chip">${esc(w.name)}</span>`).join('')
        : '<span class="text-muted">—</span>';

      return `<tr>
        <td style="white-space:nowrap"><strong>${fmtShort(date)}</strong></td>
        ${stCells}
        <td class="sched-cell">${freeHtml}</td>
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
    document.getElementById('gen-btn')?.addEventListener('click', async () => {
      const btn = document.getElementById('gen-btn');
      btn.disabled = true; btn.textContent = 'Generujem...';
      try {
        S.data = await api('PUT', '/api/schedule');
        syncLocal(); S.tab = 'schedule'; renderPanel();
      } catch (e) {
        setMsg('sched-msg', `<div class="alert alert-error">Chyba: ${esc(e.message)}</div>`);
        btn.disabled = false; btn.textContent = '⟳ Generovať rozpis';
      }
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
        : `<span class="text-muted">${r.resolvedAt ? new Date(r.resolvedAt).toLocaleDateString('sk-SK') : ''}</span>`;
      return `<tr>
        <td><strong>${esc(r.workerName)}</strong></td>
        <td>${new Date(r.requestedAt).toLocaleDateString('sk-SK')}</td>
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

  // ─── AGENT TAB ────────────────────────────────────────────────────────────
  function buildAgent() {
    const msgs = S.agentHistory.map(m => {
      if (m.role === 'user') {
        return `<div style="display:flex;justify-content:flex-end;margin-bottom:8px">
          <div style="background:var(--brand-navy);color:#fff;padding:9px 14px;border-radius:14px 14px 4px 14px;max-width:75%;font-size:.88rem">${esc(m.text)}</div>
        </div>`;
      }
      return `<div style="display:flex;justify-content:flex-start;margin-bottom:8px">
        <div style="background:#f0f4ff;color:var(--text);padding:9px 14px;border-radius:14px 14px 14px 4px;max-width:85%;font-size:.88rem;white-space:pre-wrap">${esc(m.text)}</div>
      </div>`;
    }).join('');

    return `
      <div class="card">
        <div class="section-title">🤖 Claude Agent — asistent pre rozvrh</div>
        <p class="text-muted" style="margin-bottom:14px">Pýtaj sa na brigádnikov, rozpis, dostupnosť... Agent vidí živé dáta z appky.</p>
        <div id="agent-chat" style="min-height:200px;max-height:420px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:12px;background:#fafafa">
          ${msgs || '<p class="text-muted" style="text-align:center;padding:30px 0">Začni konverzáciu — napíš otázku dole.</p>'}
        </div>
        <div style="display:flex;gap:8px">
          <input type="text" id="agent-input" placeholder="Napr.: Kto je dostupný 5. septembra?" style="flex:1">
          <button class="btn btn-primary" id="agent-send">Odoslať</button>
        </div>
        <div id="agent-msg" style="margin-top:6px"></div>
      </div>`;
  }

  function attachAgent() {
    const chatEl = document.getElementById('agent-chat');
    if (chatEl) chatEl.scrollTop = chatEl.scrollHeight;

    async function sendMessage() {
      const inp = document.getElementById('agent-input');
      const question = inp?.value?.trim();
      if (!question) return;
      inp.value = '';
      const btn = document.getElementById('agent-send');
      btn.disabled = true; btn.textContent = '...';

      S.agentHistory.push({ role: 'user', text: question });
      document.getElementById('tab-content').innerHTML = buildAgent();
      attachAgent();
      const chat = document.getElementById('agent-chat');
      if (chat) chat.scrollTop = chat.scrollHeight;

      try {
        const r = await api('POST', '/api/agent-chat', { question });
        S.agentHistory.push({ role: 'assistant', text: r.answer });
      } catch (e) {
        S.agentHistory.push({ role: 'assistant', text: `Chyba: ${e.message}` });
      }
      document.getElementById('tab-content').innerHTML = buildAgent();
      attachAgent();
    }

    document.getElementById('agent-send')?.addEventListener('click', sendMessage);
    document.getElementById('agent-input')?.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
    setTimeout(() => document.getElementById('agent-input')?.focus(), 50);
  }

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
