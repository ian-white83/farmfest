/* Farm Fest: RSVP, jobs board and chip-in for one or more events. Vanilla JS, no build step. */
(() => {
  'use strict';

  // ---------- local storage (best effort) ----------
  const ls = {
    get(k) { try { return localStorage.getItem('ff.' + k); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem('ff.' + k) : localStorage.setItem('ff.' + k, v); } catch {} },
  };
  const readCodes = () => {
    try { const v = JSON.parse(ls.get('codes') || '[]'); if (Array.isArray(v)) return v; } catch {}
    const old = ls.get('code'); return old ? [old] : [];
  };

  let S = null;                         // server view
  let codes = readCodes();              // event codes this phone holds
  let adminCode = ls.get('admin') || '';
  let treasurerCode = ls.get('treasurer') || '';
  let me = ls.get('me') || '';
  let tab = ls.get('tab') || 'jobs';
  let phase = ls.get('phase') || 'Before';
  let filter = ls.get('filter') || 'all'; // 'all' or an event id
  let screen = 'loading';               // loading | gate | who | join | app
  let busy = false;

  const app = document.getElementById('app');
  const toastEl = document.getElementById('toast');
  const saveCodes = () => { ls.set('codes', JSON.stringify(codes)); ls.set('code', null); };

  // ---------- helpers ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => '$' + (Math.round(n * 100) / 100).toLocaleString('en-AU', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
  const fmtPts = (n) => (Math.round(n * 10) / 10).toString();
  const pl = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  let toastTimer;
  function toast(msg, err) {
    toastEl.textContent = msg;
    toastEl.className = 'show' + (err ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.className = ''), 2600);
  }

  async function api(method, body, codeList = codes) {
    const headers = { 'x-event-codes': codeList.join(',') };
    if (me) headers['x-person-id'] = me;
    if (adminCode) headers['x-admin-code'] = adminCode;
    if (treasurerCode) headers['x-treasurer-code'] = treasurerCode;
    if (body) headers['content-type'] = 'application/json';
    const res = await fetch('/api', { method, headers, body: body ? JSON.stringify(body) : undefined });
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) { const e = new Error(data.error || 'Something went wrong'); e.status = res.status; throw e; }
    return data;
  }

  function accept(view) {
    S = view;
    if (!S.roles.admin && adminCode) { adminCode = ''; ls.set('admin', null); }
    if (!S.roles.treasurer && treasurerCode) { treasurerCode = ''; ls.set('treasurer', null); }
    // Forget codes that no longer match an event (e.g. an organiser changed it).
    const ok = new Set(S.matchedCodes);
    const kept = codes.filter((c) => ok.has(c.trim().toUpperCase()));
    if (kept.length !== codes.length) { codes = kept; saveCodes(); }
    if (filter !== 'all' && !S.events.some((e) => e.id === filter)) { filter = 'all'; ls.set('filter', filter); }
    if (S.events.length === 1) filter = S.events[0].id;
    if (me && !S.people.some((p) => p.id === me)) { me = ''; ls.set('me', null); }
  }

  async function load() {
    try {
      accept(await api('GET'));
      screen = me ? 'app' : 'who';
    } catch (e) {
      if (e.status === 401) { codes = []; saveCodes(); screen = 'gate'; }
      else { toast(e.message, true); if (!S) screen = 'gate'; }
    }
    render();
  }

  async function act(body, okMsg) {
    if (busy) return null;
    busy = true;
    try {
      const r = await api('POST', body);
      if (r.state) accept(r.state);
      if (okMsg) toast(okMsg);
      render();
      return r;
    } catch (e) {
      toast(e.message, true);
      if (e.status === 404 || e.status === 409) load();
      return null;
    } finally { busy = false; }
  }

  // Try a new event code; keep it only if it unlocks an event.
  async function addCode(c) {
    c = String(c || '').trim();
    if (!c) return false;
    const norm = c.toUpperCase();
    if (codes.some((x) => x.toUpperCase() === norm)) { toast('You already have that event'); return true; }
    try {
      const view = await api('GET', null, [...codes, c]);
      if (!view.matchedCodes.includes(norm)) throw Object.assign(new Error("That code doesn't match an event"), { status: 401 });
      codes.push(c); saveCodes();
      accept(view);
      const ev = view.events.find((e) => e.code === norm);
      if (ev) { filter = ev.id; ls.set('filter', filter); }
      return true;
    } catch (e) {
      toast(e.status === 401 ? "That code doesn't match an event" : e.message, true);
      return false;
    }
  }

  // ---------- lookups ----------
  const person = (id) => S.people.find((p) => p.id === id);
  const evById = (id) => S.events.find((e) => e.id === id);
  const evName = (id) => (id === 'all' ? 'All events' : evById(id)?.name || 'Event');
  const scopeEvents = () => (filter === 'all' ? S.events : S.events.filter((e) => e.id === filter));
  const multi = () => S.events.length > 1;
  const taskInScope = (t) => filter === 'all' || t.eventId === 'all' || t.eventId === filter;
  const attendees = (ev) => S.people.filter((p) => p.rsvps[ev.id]);
  const SLOTS = ['Breakfast', 'Morning', 'Lunch', 'Afternoon', 'Dinner', 'Evening'];
  // The days of an event from its start/end dates: [{ i, label: 'Fri 2 Apr', long: 'Friday 2 April' }].
  const eventDays = (ev) => {
    if (!ev || !ev.startDate) return [];
    const out = [], a = Date.parse(ev.startDate + 'T00:00:00Z'), b = Date.parse((ev.endDate || ev.startDate) + 'T00:00:00Z');
    for (let t = a, i = 0; t <= b && i < 7; t += 86400000, i++) {
      const d = new Date(t);
      const f = (o) => d.toLocaleDateString('en-AU', { timeZone: 'UTC', ...o });
      out.push({ i, label: f({ weekday: 'short', day: 'numeric', month: 'short' }), long: f({ weekday: 'long', day: 'numeric', month: 'long' }) });
    }
    return out;
  };
  const taskDay = (t) => (t.day == null || t.eventId === 'all' ? null : eventDays(evById(t.eventId))[t.day] || null);
  const dayOptions = (ev, cur) => `<option value="">Any day</option>` + eventDays(ev).map((d) => `<option value="${d.i}" ${cur === d.i ? 'selected' : ''}>${esc(d.label)}</option>`).join('');
  const slotOptions = (cur) => `<option value="">Any time</option>` + SLOTS.map((x) => `<option ${x === cur ? 'selected' : ''}>${x}</option>`).join('');
  const headcount = (ev) => {
    const ps = attendees(ev);
    const night = (n) => ps.filter((p) => p.rsvps[ev.id].nights.includes(n));
    const sum = (arr, k) => arr.reduce((a, p) => a + (p.rsvps[ev.id][k] || 0), 0);
    return {
      rsvps: ps.length,
      friA: sum(night('Fri'), 'adults'), friK: sum(night('Fri'), 'kids'),
      satA: sum(night('Sat'), 'adults'), satK: sum(night('Sat'), 'kids'),
      total: sum(ps, 'adults') + sum(ps, 'kids'),
    };
  };

  // ---------- rendering ----------
  function render() {
    if (screen === 'loading') { app.innerHTML = `<div class="gate"><p class="muted">Loading…</p></div>`; return; }
    if (screen === 'gate') return renderGate();
    if (screen === 'who') return renderWho();
    if (screen === 'join') return renderJoin();
    renderApp();
  }

  function renderGate() {
    app.innerHTML = `
      <form class="gate stack" data-form="gate">
        <div class="logo" aria-hidden="true">🔥</div>
        <h1>Farm Fest</h1>
        <p class="muted">Enter the event code from the WhatsApp group.</p>
        <div class="field"><label for="gc">Event code</label>
          <input id="gc" name="code" type="text" autocomplete="off" autocapitalize="characters" required></div>
        <button class="btn primary full" type="submit">Let me in</button>
      </form>`;
    app.querySelector('#gc').focus();
  }

  function renderWho() {
    const people = [...S.people].sort((a, b) => a.name.localeCompare(b.name));
    app.innerHTML = `
      <div class="gate stack" style="justify-content:flex-start;padding-top:40px">
        <h1>Who are you?</h1>
        <p class="muted">${S.events.map((e) => esc(e.name)).join(' · ')}</p>
        <button class="btn primary full" data-act="goJoin">I'm new: add me</button>
        ${people.length ? `
          <div class="field"><label for="wf">Or find your name</label>
            <input id="wf" type="text" placeholder="Start typing…" autocomplete="off"></div>
          <div class="card"><ul class="plist" id="wl">
            ${people.map((p) => `<li data-name="${esc(p.name.toLowerCase())}"><span class="spacer">${esc(p.name)}</span>
              <button class="btn sm" data-act="pickMe" data-id="${esc(p.id)}">That's me</button></li>`).join('')}
          </ul></div>` : `<p class="muted small">Nobody has signed up yet. Be the first.</p>`}
        <p class="small muted">Signed up for another Farm Fest and not listed here? <button class="linkish" data-act="gateAgain" style="color:var(--brand)">Enter that event's code</button> instead. Once you're in, "+ Event code" adds more events.</p>
      </div>`;
    const f = app.querySelector('#wf');
    if (f) f.addEventListener('input', () => {
      const q = f.value.trim().toLowerCase();
      app.querySelectorAll('#wl li').forEach((li) => li.classList.toggle('hidden', q && !li.dataset.name.includes(q)));
    });
  }

  function rsvpFields(r, idp) {
    r = r || { adults: 1, kids: 0, nights: ['Fri', 'Sat'], diet: '' };
    return `
      <div class="grid2 field">
        <div><label for="${idp}-ad">Adults</label><input id="${idp}-ad" name="adults" type="number" min="0" max="10" inputmode="numeric" value="${esc(r.adults)}"></div>
        <div><label for="${idp}-kd">Kids</label><input id="${idp}-kd" name="kids" type="number" min="0" max="10" inputmode="numeric" value="${esc(r.kids)}"></div>
      </div>
      <div class="field"><label>Nights staying (none = day visit)</label>
        <div class="checks">
          ${['Fri', 'Sat'].map((n) => `<label class="check"><input type="checkbox" name="nights" value="${n}" ${r.nights.includes(n) ? 'checked' : ''}> ${n} night</label>`).join('')}
        </div></div>
      <div class="field"><label for="${idp}-diet">Dietary needs</label>
        <input id="${idp}-diet" name="diet" type="text" maxlength="120" placeholder="e.g. vegetarian, no pork" value="${esc(r.diet)}"></div>`;
  }
  const readRsvp = (fd) => ({ adults: fd.get('adults'), kids: fd.get('kids'), nights: fd.getAll('nights'), diet: fd.get('diet') });

  function aboutFields(p) {
    p = p || { name: '', sponsor: '', firstTimer: false };
    return `
      <div class="field"><label for="f-name">Your name (or household, e.g. "Karen + Pete")</label>
        <input id="f-name" name="name" type="text" maxlength="60" required value="${esc(p.name)}"></div>
      <div class="field"><label for="f-sp">Who invited you? (your sponsor)</label>
        <input id="f-sp" name="sponsor" type="text" maxlength="60" placeholder="Leave blank if you're a regular" value="${esc(p.sponsor)}"></div>
      <div class="field"><label class="check"><input type="checkbox" name="firstTimer" ${p.firstTimer ? 'checked' : ''}> First Farm Fest</label></div>`;
  }

  function renderJoin() {
    const def = filter !== 'all' ? filter : S.events[0].id;
    app.innerHTML = `
      <form class="gate stack" data-form="join" style="justify-content:flex-start;padding-top:32px">
        <h1>I'm coming</h1>
        ${multi() ? `<div class="field"><label for="j-ev">Which event?</label><select id="j-ev" name="eventId">
          ${S.events.map((e) => `<option value="${esc(e.id)}" ${e.id === def ? 'selected' : ''}>${esc(e.name)} (${esc(e.dates)})</option>`).join('')}</select>
          <p class="small muted">Coming to more than one? Add the others from the Event tab after this.</p></div>`
          : `<p class="muted">${esc(S.events[0].name)} · ${esc(S.events[0].dates)}</p><input type="hidden" name="eventId" value="${esc(def)}">`}
        ${aboutFields()}
        ${rsvpFields(null, 'j')}
        <button class="btn primary full" type="submit">Add me</button>
        <button class="btn ghost full" type="button" data-act="goWho">Back</button>
      </form>`;
  }

  function header() {
    const p = person(me);
    const t = p.summary;
    const pct = t.req ? Math.min(100, (t.have / t.req) * 100) : 100;
    const one = filter !== 'all' ? evById(filter) : null;
    const wa = one?.whatsappUrl;
    const going = S.events.filter((e) => p.rsvps[e.id]).length;
    let line;
    if (p.host) line = 'Host: no points needed. Thank you!';
    else if (!t.req) line = going ? 'No points needed.' : "You haven't RSVP'd yet. Head to the Event tab.";
    else if (t.status === 'ok') line = `✅ ${fmtPts(t.have)} of ${t.req} points. You're all set.`;
    else if (t.status === 'warn') line = `${fmtPts(t.have)} of ${t.req} points. Payment awaiting the treasurer.`;
    else line = `${fmtPts(t.have)} of ${t.req} points. Claim ${fmtPts(t.shortPts)} more, or chip in ${money(t.shortDollars)}.`;
    const title = one ? one.name : 'Farm Fest';
    const sub = one ? `${esc(one.dates)}${one.location ? ' · ' + esc(one.location) : ''}` : `${pl(S.events.length, 'event')} on the go`;
    return `
      <header class="top"><div class="wrap">
        <div class="row">
          <div class="spacer"><h1>${esc(title)}</h1><div class="sub">${sub}</div></div>
          ${wa ? `<a class="wa-btn" href="${esc(wa)}" target="_blank" rel="noopener">💬 Chat</a>` : ''}
        </div>
        <div class="me">
          <div class="row"><span class="who spacer">${esc(p.name)}</span><button class="linkish" data-act="switchMe">Not you?</button></div>
          <div class="small">${line}${t.pending ? ` <span class="badge pending">+${t.pending} pts pending</span>` : ''}${multi() && t.req ? ` <span class="small" style="opacity:.8">(all your events)</span>` : ''}</div>
          <div class="bar ${t.status === 'ok' ? 'done' : ''}"><i style="width:${pct}%"></i></div>
        </div>
      </div></header>`;
  }

  function nav() {
    const items = [['coming', '🏕️', 'Event'], ['jobs', '🪓', 'Jobs'], ['shop', '🛒', 'Shopping'], ['chip', '💸', 'Chip in'], ['org', '⚙️', 'Organise']];
    return `<nav class="tabs">${items.map(([k, ic, l]) => `<button data-act="tab" data-tab="${k}" ${tab === k ? 'aria-current="page"' : ''}><span class="ic" aria-hidden="true">${ic}</span>${l}</button>`).join('')}</nav>`;
  }

  function filterBar() {
    const chips = multi()
      ? [['all', 'All events'], ...S.events.map((e) => [e.id, e.name])].map(([id, name]) =>
        `<button class="chip" data-act="filter" data-id="${esc(id)}" aria-pressed="${filter === id}">${esc(name)}</button>`).join('')
      : '';
    return `<div class="chips">${chips}<button class="chip add" data-act="showAddCode">+ Event code</button></div>
      <form class="row hidden" data-form="addCode" id="addCode" style="margin-bottom:8px">
        <input name="code" type="text" placeholder="Code for another event" autocapitalize="characters" autocomplete="off" aria-label="Event code">
        <button class="btn primary" type="submit">Add</button></form>`;
  }

  function renderApp() {
    const y = window.scrollY;
    // Keep open editors open across re-renders (e.g. after assigning someone).
    const openKeys = new Set([...app.querySelectorAll('details[open][data-key]')].map((d) => d.dataset.key));
    const body = tab === 'coming' ? viewComing() : tab === 'chip' ? viewChip() : tab === 'org' ? viewOrg() : tab === 'shop' ? viewShop() : viewJobs();
    app.innerHTML = header() + nav() + `<main class="wrap">${filterBar()}${body}</main>`;
    app.querySelectorAll('details[data-key]').forEach((d) => { if (openKeys.has(d.dataset.key)) d.open = true; });
    window.scrollTo(0, y);
  }

  // ----- Jobs -----
  function eventTag(t) {
    if (t.eventId === 'all') return multi() ? '<span class="badge all">All events</span>' : '';
    return filter === 'all' && multi() ? `<span class="badge ev">${esc(evName(t.eventId))}</span>` : '';
  }

  function taskCard(t) {
    const mine = t.claims.some((c) => c.personId === me);
    const full = t.claims.length >= t.slots;
    const names = t.claims.map((c) => {
      const p = c.personId && person(c.personId);
      return `<span class="tag ${c.personId === me ? 'me-tag' : ''} ${c.notDone ? 'struck' : ''}">${esc(p ? p.name : 'Someone')}${c.notDone ? ' (not done)' : ''}${c.assigned ? ' · assigned' : ''}</span>`;
    }).join('');
    const open = t.slots - t.claims.length;
    return `<div class="card">
      <div class="row" style="align-items:flex-start">
        <div class="spacer">
          <div class="task-title">${esc(t.title)}</div>
          <div class="small muted">${open > 0 ? `${open} of ${t.slots} slot${t.slots > 1 ? 's' : ''} open` : 'All slots taken'}
            ${t.pending ? ' · <span class="badge pending">points pending</span>' : ''} ${eventTag(t)}${t.slot ? ` <span class="badge when">${esc(t.slot)}</span>` : ''}</div>
        </div>
        <div class="pts ${t.points >= 5 ? 'big' : ''}">${t.points}<span class="u">pts</span></div>
      </div>
      ${names ? `<div class="names">${names}</div>` : ''}
      <div class="row" style="margin-top:10px">
        ${mine ? `<button class="btn sm" data-act="unclaim" data-id="${esc(t.id)}">Drop it</button>`
          : t.assignOnly ? `<span class="badge lock">🔒 An organiser assigns this one</span>`
          : `<button class="btn primary sm" data-act="claim" data-id="${esc(t.id)}" ${full ? 'disabled' : ''}>I'll do it</button>`}
        <span class="spacer"></span>
        <button class="btn ghost sm" data-act="share" data-id="${esc(t.id)}">Share</button>
      </div>
    </div>`;
  }

  function eventOptions(selected, includeAll = true) {
    return (includeAll && multi() ? [['all', 'All events']] : []).concat(S.events.map((e) => [e.id, e.name]))
      .map(([id, n]) => `<option value="${esc(id)}" ${id === selected ? 'selected' : ''}>${esc(n)}</option>`).join('');
  }

  function viewJobs() {
    const scoped = S.tasks.filter(taskInScope);
    const tasks = scoped.filter((t) => t.phase === phase).sort((a, b) => b.points - a.points || a.title.localeCompare(b.title));
    const counts = Object.fromEntries(['Before', 'During', 'After'].map((ph) => [ph, scoped.filter((t) => t.phase === ph && t.claims.length < t.slots).length]));
    // Which events this person may add jobs to: organisers always; attendees only where the event allows it.
    const addable = S.roles.admin ? S.events : S.events.filter((e) => e.guestTasks !== false);
    const canAll = addable.length === S.events.length;
    const inScope = addable.filter((e) => filter === 'all' || e.id === filter);
    const defEv = filter !== 'all' && inScope.length ? filter : multi() && canAll ? 'all' : (inScope[0] || addable[0])?.id;
    const evOpts = (canAll && multi() ? [['all', 'All events']] : []).concat(addable.map((e) => [e.id, e.name]))
      .map(([id, n]) => `<option value="${esc(id)}" ${id === defEv ? 'selected' : ''}>${esc(n)}</option>`).join('');
    const addForm = !inScope.length
      ? `<p class="small muted" style="margin-top:16px">Organisers add the jobs for ${filter === 'all' && multi() ? 'these events' : 'this event'}. If something's missing, ask one of them.</p>`
      : `
      <details class="box" style="margin-top:16px">
        <summary>+ Add a job</summary>
        <form class="stack" data-form="addTask" style="margin-top:12px">
          <div class="field"><label for="t-title">What needs doing?</label><input id="t-title" name="title" type="text" maxlength="120" required></div>
          ${multi() && addable.length + (canAll ? 1 : 0) > 1 ? `<div class="field"><label for="t-ev">For which event?</label><select id="t-ev" name="eventId">${evOpts}</select></div>`
                    : `<input type="hidden" name="eventId" value="${esc(defEv)}">`}
          <div class="grid2">
            <div><label for="t-ph">When</label><select id="t-ph" name="phase">${['Before', 'During', 'After'].map((x) => `<option ${x === phase ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
            <div><label for="t-sl">People needed</label><input id="t-sl" name="slots" type="number" min="1" max="20" value="1" inputmode="numeric"></div>
          </div>
          ${whenFields(phase !== 'During', null, '', defEv === 'all' ? scopeEvents() : [evById(defEv)])}
          <div class="field"><label for="t-pt">Suggested points</label>
            <select id="t-pt" name="points">
              <option value="1">1: quick errand</option><option value="2" selected>2: an hour or so</option>
              <option value="3">3: half a day</option><option value="5">5: full day or lead role</option><option value="8">8: cook a meal for everyone</option>
            </select></div>
          <p class="small muted">${S.roles.admin ? 'You are an organiser, so this goes live straight away.' : 'An organiser will confirm the points. You can still claim it now.'}</p>
          <button class="btn primary full" type="submit">Add job</button>
        </form>
      </details>`;
    return `
      <div class="seg" role="group" aria-label="When">
        ${['Before', 'During', 'After'].map((ph) => `<button data-act="phase" data-ph="${ph}" aria-pressed="${phase === ph}">${ph} <span class="muted small">(${counts[ph]})</span></button>`).join('')}
      </div>
      <p class="small muted">Big jobs earn big points: cooking a dinner is worth 8, a rubbish run 2. Most events need 3 points per adult staying over.</p>
      ${tasks.length ? (phase === 'During' ? duringGroups(tasks) : tasks.map(taskCard).join('')) : `<p class="muted">No jobs here yet.</p>`}
      ${addForm}`;
  }

  // "During" jobs grouped by day (then time of day), with undated jobs last.
  function duringGroups(tasks) {
    if (!tasks.some(taskDay)) return tasks.map(taskCard).join('');
    const groups = new Map();
    for (const t of tasks) {
      const d = taskDay(t);
      const key = d ? t.eventId + '|' + d.i : 'any';
      if (!groups.has(key)) groups.set(key, { d, ev: d && evById(t.eventId), list: [] });
      groups.get(key).list.push(t);
    }
    const order = [...groups.entries()].sort(([ka, a], [kb, b]) => (ka === 'any') - (kb === 'any')
      || S.events.indexOf(a.ev) - S.events.indexOf(b.ev) || (a.d?.i ?? 0) - (b.d?.i ?? 0));
    const slotRank = (t) => (t.slot ? SLOTS.indexOf(t.slot) : SLOTS.length);
    return order.map(([key, g]) => {
      const list = g.list.sort((a, b) => slotRank(a) - slotRank(b) || b.points - a.points);
      const open = list.reduce((n, t) => n + Math.max(0, t.slots - t.claims.length), 0);
      const title = g.d ? `${g.d.long}${filter === 'all' && multi() ? ` <span class="muted small">· ${esc(g.ev.name)}</span>` : ''}` : 'Any day';
      return `<h3 class="dayhead">${title} <span class="muted small">${open ? `${open} spot${open === 1 ? '' : 's'} open` : 'all filled'}</span></h3>${list.map(taskCard).join('')}`;
    }).join('');
  }

  // Day + time-of-day pickers for "During" jobs. Picking a day ties the job to that day's event.
  function whenFields(hidden, day, slot, evs, eventId) {
    const dated = evs.filter((e) => e && eventDays(e).length);
    const dayCtl = !dated.length ? `<select name="day" disabled><option value="">Add event dates first</option></select>`
      : dated.length === 1 ? `<select name="day">${dayOptions(dated[0], day)}</select>`
      : `<select name="day"><option value="">Any day</option>${dated.map((e) => `<optgroup label="${esc(e.name)}">${eventDays(e).map((d) => `<option value="${esc(e.id)}|${d.i}" ${eventId === e.id && day === d.i ? 'selected' : ''}>${esc(d.label)}</option>`).join('')}</optgroup>`).join('')}</select>`;
    return `<div class="grid2 when" ${hidden ? 'hidden' : ''}>
        <div><label>Which day</label>${dayCtl}</div>
        <div><label>Time of day</label><select name="slot">${slotOptions(slot)}</select></div>
      </div>`;
  }
  // Reads the day picker; a "eventId|day" value also says which event the job belongs to.
  function readWhen(fd, body) {
    const v = String(fd.get('day') ?? '');
    if (v.includes('|')) { const [e, d] = v.split('|'); body.eventId = e; body.day = d; } else body.day = v;
    body.slot = fd.get('slot') || '';
    return body;
  }

  // Run sheet for each day of an event. Everyone sees it; only organisers edit it.
  function runSheet(ev) {
    const days = eventDays(ev);
    const admin = S.roles.admin;
    if (!days.length) return admin ? `<p class="small muted">Add start and end dates to this event in Organise to build a run sheet.</p>` : '';
    const rs = ev.runSheet || {};
    const has = days.some((d) => rs[d.i]);
    if (!has && !admin) return '';
    const lines = (txt) => txt.split('\n').filter((l) => l.trim()).map((l) => {
      const m = l.match(/^\s*(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?|\d{1,2}[:.]\d{2})\s*[-–:]?\s+(.*)$/i);
      return m ? `<li><b>${esc(m[1])}</b> ${esc(m[2])}</li>` : `<li>${esc(l)}</li>`;
    }).join('');
    return `<div class="card runsheet">
      <div class="row"><b class="spacer">📋 Run sheet</b>${admin ? '<span class="badge lock">organisers edit</span>' : ''}</div>
      ${days.map((d) => `<div class="rs-day">
        <div class="small" style="font-weight:600">${esc(d.long)}</div>
        ${rs[d.i] ? `<ul class="rs">${lines(rs[d.i])}</ul>` : `<p class="small muted">Nothing planned yet.</p>`}
        ${admin ? `<details class="small" data-key="rs-${esc(ev.id)}-${d.i}"><summary>Edit ${esc(d.label)}</summary>
          <form class="stack" data-form="runSheet" data-ev="${esc(ev.id)}" data-day="${d.i}" style="margin-top:6px">
            <textarea name="text" rows="5" maxlength="2000" placeholder="One line each, e.g.&#10;3pm Gates open&#10;6pm Dinner: Ian's lamb&#10;8pm Fire and bar">${esc(rs[d.i] || '')}</textarea>
            <button class="btn primary sm" type="submit">Save ${esc(d.label)}</button>
          </form></details>` : ''}
      </div>`).join('')}
    </div>`;
  }

  // ----- Event -----
  function eventSection(ev) {
    const p = person(me);
    const mine = p.rsvps[ev.id];
    const h = headcount(ev);
    const ps = attendees(ev).sort((a, b) => a.name.localeCompare(b.name));
    const diets = ps.filter((x) => x.rsvps[ev.id].diet).map((x) => `<li><span class="spacer">${esc(x.name)}</span><span class="muted small">${esc(x.rsvps[ev.id].diet)}</span></li>`).join('');
    const rows = ps.map((x) => {
      const r = x.rsvps[ev.id];
      return `<li><span class="dot ${x.summary.status}"></span>
        <span class="spacer">${esc(x.name)}${x.host ? ' <span class="badge ok">host</span>' : ''}
          <span class="small muted" style="display:block">${pl(r.adults, 'adult')}${r.kids ? `, ${pl(r.kids, 'kid')}` : ''} · ${r.nights.length ? r.nights.join(' + ') : 'Day visit'}${x.sponsor ? ' · via ' + esc(x.sponsor) : ''}</span></span>
        <span class="small muted">${x.summary.req ? `${fmtPts(x.summary.have)}/${x.summary.req}` : ''}</span></li>`;
    }).join('');
    return `
      <section class="evsec">
        <h2>${esc(ev.name)} <span class="muted small">${esc(ev.dates)}</span></h2>
        ${runSheet(ev)}
        ${multi() ? '' : '<h3 class="dayhead">Headcount</h3>'}
        <div class="stats">
          <div class="stat"><b>${h.friA}<small>+${h.friK}</small></b><span>Friday night<br>adults + kids</span></div>
          <div class="stat"><b>${h.satA}<small>+${h.satK}</small></b><span>Saturday night<br>adults + kids</span></div>
          <div class="stat"><b>${h.total}</b><span>Total people<br>all days</span></div>
        </div>
        <div class="card stack" style="margin-top:10px">
          ${mine ? `<div class="row"><span class="badge ok">You're coming</span><span class="small muted spacer">${pl(mine.adults, 'adult')}${mine.kids ? `, ${pl(mine.kids, 'kid')}` : ''} · ${mine.nights.length ? mine.nights.join(' + ') : 'Day visit'}</span></div>`
                 : `<div class="row"><span class="spacer">Not on the list for this one yet.</span></div>`}
          <details ${mine ? '' : 'open'}><summary class="small" style="font-weight:600;cursor:pointer">${mine ? 'Change my RSVP' : "I'm coming"}</summary>
            <form class="stack" data-form="rsvp" data-ev="${esc(ev.id)}" style="margin-top:10px">
              ${rsvpFields(mine, 'r' + ev.id)}
              <button class="btn primary full" type="submit">${mine ? 'Save' : 'Count me in'}</button>
              ${mine ? `<button class="btn ghost full danger" type="button" data-act="unrsvp" data-ev="${esc(ev.id)}">I can't make it</button>` : ''}
            </form>
          </details>
        </div>
        <details class="box" style="margin-top:10px"><summary>Who's coming (${ps.length})</summary>
          <p class="small muted">Green: all set · Amber: payment awaiting check · Red: still short of points</p>
          <ul class="plist">${rows || '<li class="muted">Nobody yet</li>'}</ul>
          ${diets ? `<h3 style="margin-top:12px">Dietary needs</h3><ul class="plist">${diets}</ul>` : ''}
        </details>
      </section>`;
  }

  // Leaderboard: points from jobs plus buy-in money (converted to points), pooled per person.
  function leaderboard() {
    const evIds = new Set(scopeEvents().map((e) => e.id));
    const ps = S.people.filter((p) => !p.host && Object.keys(p.rsvps).some((id) => evIds.has(id)));
    if (!ps.length) return '';
    const score = (p) => p.summary.have + p.summary.pending;
    const levels = [...new Set(ps.map(score).filter((x) => x > 0))].sort((a, b) => b - a).slice(0, 3);
    const names = (list) => {
      const shown = list.slice(0, 3).map((p) => `<span class="${p.id === me ? 'me-name' : ''}">${esc(p.name)}</span>`).join('');
      return shown + (list.length > 3 ? `<span class="muted">+${list.length - 3} more</span>` : '');
    };
    const step = (rank, cls, medal) => {
      const lvl = levels[rank];
      const who = lvl === undefined ? [] : ps.filter((p) => score(p) === lvl).sort((a, b) => a.name.localeCompare(b.name));
      return `<div class="pod ${cls}">
        <div class="pod-names">${who.length ? names(who) : '<span class="muted">Up for grabs</span>'}</div>
        <div class="pod-medal">${medal}</div>
        <div class="pod-block"><b>${rank + 1}</b>${lvl !== undefined ? `<span>${fmtPts(lvl)} pts</span>` : ''}</div>
      </div>`;
    };
    const low = Math.min(...ps.map(score));
    // Tied for last, unless they're also on the podium (e.g. only two people).
    const last = ps.filter((p) => score(p) === low && !(low > 0 && levels.includes(low))).sort((a, b) => a.name.localeCompare(b.name));
    return `
      <h2>🏆 Leaderboard</h2>
      <div class="card">
        <p class="small muted" style="margin-top:0">Points from jobs plus money chipped in ($${S.settings.dollarsPerPoint || 20} = 1 point).</p>
        <div class="podium">${step(1, 'silver', '🥈')}${step(0, 'gold', '🥇')}${step(2, 'bronze', '🥉')}</div>
      </div>
      ${last.length ? `<div class="card shitlist">
        <div class="row"><b class="spacer">💩 The Shit List</b><span class="small muted">${fmtPts(low)} pts</span></div>
        <p class="small muted">${low === 0 ? 'People yet to grab a job or chip in money.' : 'Bringing up the rear. Grab a job to get off this list.'}</p>
        <div class="names">${last.slice(0, 30).map((p) => `<span class="tag ${p.id === me ? 'me-tag' : ''}">💩 ${esc(p.name)}</span>`).join('')}${last.length > 30 ? `<span class="tag">+${last.length - 30} more</span>` : ''}</div>
        ${last.some((p) => p.id === me) ? `<button class="btn primary sm" data-act="tab" data-tab="jobs" style="margin-top:10px">Get me off this list</button>` : ''}
      </div>` : ''}`;
  }

  function viewComing() { // the Event tab
    const p = person(me);
    return scopeEvents().map(eventSection).join('') + leaderboard() + `
      <h2>About me</h2>
      <form class="card stack" data-form="about">${aboutFields(p)}<button class="btn primary full" type="submit">Save</button></form>`;
  }

  // ----- Shopping -----
  function itemCard(x) {
    const who = x.claimedBy === 'someone' ? 'Someone' : x.claimedBy ? person(x.claimedBy)?.name || 'Someone' : '';
    const mine = x.claimedBy === me;
    const canDel = S.roles.admin || (x.byId === me && !x.claimedBy);
    const tag = x.eventId === 'all' ? (multi() ? '<span class="badge all">All events</span>' : '')
      : filter === 'all' && multi() ? `<span class="badge ev">${esc(evName(x.eventId))}</span>` : '';
    return `<div class="card item ${x.got ? 'got' : ''}">
      <div class="row" style="align-items:flex-start">
        <div class="spacer"><div class="task-title">${x.got ? '✅ ' : ''}${esc(x.name)}${x.qty ? ` <span class="muted">× ${esc(x.qty)}</span>` : ''}</div>
          <div class="small muted">${x.note ? esc(x.note) + ' · ' : ''}${who ? (x.got ? `Got by ${esc(who)}` : `${esc(who)} is grabbing it`) : 'Still needed'} ${tag}</div></div>
        ${canDel ? `<button class="btn sm ghost danger" data-act="delItem" data-id="${esc(x.id)}" aria-label="Remove item">✕</button>` : ''}
      </div>
      <div class="row" style="margin-top:8px">
        ${!x.claimedBy ? `<button class="btn primary sm" data-act="grab" data-id="${esc(x.id)}">I'll grab it</button>`
          : mine ? (x.got ? `<button class="btn sm" data-act="got" data-id="${esc(x.id)}" data-v="0">Not got yet</button>`
                          : `<button class="btn primary sm" data-act="got" data-id="${esc(x.id)}" data-v="1">Got it ✓</button><button class="btn sm ghost" data-act="ungrab" data-id="${esc(x.id)}">Drop it</button>`)
          : ''}
      </div>
    </div>`;
  }

  function viewShop() {
    const items = S.shopping.filter(taskInScope);
    const need = items.filter((x) => !x.claimedBy), onIt = items.filter((x) => x.claimedBy && !x.got), got = items.filter((x) => x.got);
    const defEv = filter !== 'all' ? filter : multi() ? 'all' : S.events[0].id;
    const sec = (title, list) => (list.length ? `<h2>${title} (${list.length})</h2>${list.map(itemCard).join('')}` : '');
    return `
      <p class="small muted" style="margin-top:12px">Things we need people to pick up on the way. Tap "I'll grab it" so nobody doubles up, and keep your receipt: log it under Chip in as "Meal or other costs".</p>
      ${sec('Still needed', need)}${sec('Someone is on it', onIt)}${sec('Got it', got)}
      ${items.length ? '' : '<p class="muted">Nothing on the list yet.</p>'}
      <div class="card" style="margin-top:20px">
        <h3 style="margin-bottom:10px">+ Add to the list</h3>
        <form class="stack" data-form="addItem">
          <div class="field"><label for="si-n">Item</label><input id="si-n" name="name" type="text" maxlength="80" required placeholder="e.g. Tonic water"></div>
          <div class="grid2">
            <div><label for="si-q">How many</label><input id="si-q" name="qty" type="text" maxlength="30" placeholder="12 bottles"></div>
            ${multi() ? `<div><label for="si-e">Event</label><select id="si-e" name="eventId">${eventOptions(defEv)}</select></div>` : `<input type="hidden" name="eventId" value="${esc(S.events[0].id)}">`}
          </div>
          <div class="field"><label for="si-o">Note</label><input id="si-o" name="note" type="text" maxlength="120" placeholder="Brand, where to get it…"></div>
          <button class="btn primary full" type="submit">Add item</button>
        </form>
      </div>
`;
  }

  // ----- Chip in -----
  function viewChip() {
    const p = person(me);
    const t = p.summary;
    const dpp = S.settings.dollarsPerPoint;
    const going = S.events.filter((e) => p.rsvps[e.id]);
    const meals = scopeEvents().filter((e) => e.mealCosts);
    const pays = (p.payments || []).map((x) => `<tr><td>${money(x.amount)}</td><td>${x.kind === 'meal' ? 'Meal' : 'Buy-in'}${x.note ? `<div class="small muted">${esc(x.note)}</div>` : ''}</td>
      <td>${x.confirmed ? '<span class="badge ok">confirmed</span>' : '<span class="badge pending">awaiting check</span>'}</td>
      <td>${x.confirmed ? '' : `<button class="btn sm ghost" data-act="cancelPay" data-id="${esc(x.id)}">Remove</button>`}</td></tr>`).join('');
    return `
      <h2>Your buy-in</h2>
      <div class="card stack">
        ${p.host ? `<p>You're a host, so there's nothing to pay. Thank you!</p>` :
          !t.req ? `<p>Nothing needed yet. RSVP to an event on the Event tab.</p>` :
          t.status === 'ok' ? `<p><b>You're all set.</b> ${fmtPts(t.earned)} points from jobs${t.paidOk ? ` plus ${money(t.paidOk)} chipped in` : ''}.</p>` :
          `<p>You need <b>${t.req} points</b> across ${going.length > 1 ? `your ${going.length} events (${going.map((e) => esc(e.name)).join(', ')})` : esc(going[0]?.name || 'your event')}. You have <b>${fmtPts(t.have)}</b>${t.paidWait ? `, plus ${money(t.paidWait)} awaiting check` : ''}.</p>
           ${t.shortPts > 0 ? `<p>Claim ${fmtPts(t.shortPts)} more points of jobs, or chip in <b>${money(t.shortDollars)}</b> to the host fund (${money(dpp)} per point). A mix works too.</p>` : ''}`}
      </div>
      <h2>How to pay</h2>
      <div class="card stack">
        ${S.payment.details ? `<div class="paybox">${esc(S.payment.details)}</div>` : `<p class="muted">The treasurer hasn't added payment details yet.</p>`}
        ${meals.map((e) => `<h3>${multi() ? esc(e.name) + ': ' : ''}meal costs (separate from buy-in)</h3><div class="paybox">${esc(e.mealCosts)}</div>`).join('')}
      </div>
      <h2>I've paid</h2>
      <form class="card stack" data-form="pay">
        <div class="grid2">
          <div><label for="p-am">Amount ($)</label><input id="p-am" name="amount" type="number" min="1" step="0.01" inputmode="decimal" required value="${t.shortDollars || ''}"></div>
          <div><label for="p-kd">What for</label><select id="p-kd" name="kind"><option value="buyin">Buy-in (counts as points)</option><option value="meal">Meal or other costs</option></select></div>
        </div>
        <div class="field"><label for="p-nt">Note (optional)</label><input id="p-nt" name="note" type="text" maxlength="120" placeholder="e.g. Saturday asado for 2"></div>
        <button class="btn primary full" type="submit">Record payment</button>
        <p class="small muted">The treasurer ticks it off once it lands. Only buy-in payments count toward your points.</p>
      </form>
      ${pays ? `<h2>My payments</h2><div class="card"><table class="mini"><tbody>${pays}</tbody></table></div>` : ''}`;
  }

  // ----- WhatsApp update -----
  function updateText(ev, withCode) {
    const h = headcount(ev);
    const open = S.tasks.filter((t) => (t.eventId === ev.id || t.eventId === 'all') && !t.pending && t.claims.length < t.slots)
      .sort((x, y) => y.points - x.points || x.title.localeCompare(y.title));
    const ps = attendees(ev).filter((p) => !p.host);
    const set = ps.filter((p) => p.summary.status === 'ok').length;
    const url = location.origin + (withCode && ev.code ? '/?code=' + encodeURIComponent(ev.code) : '');
    const night = (a, k) => pl(a, 'adult') + (k ? ` + ${pl(k, 'kid')}` : '');
    const lines = [`🔥 *${ev.name}* update`, `📅 ${ev.dates}${ev.location ? ' · ' + ev.location : ''}`, ''];
    lines.push(`🏕️ *Coming:* ${pl(h.rsvps, 'RSVP')} · Fri ${night(h.friA, h.friK)} · Sat ${night(h.satA, h.satK)}`);
    if (open.length) {
      lines.push('', `🪓 *Jobs still open (${open.length}):*`);
      open.slice(0, 5).forEach((t) => {
        const left = t.slots - t.claims.length;
        lines.push(`• ${t.title} (${t.points} pts${left > 1 ? `, ${left} spots` : ''})`);
      });
      if (open.length > 5) lines.push(`…plus ${open.length - 5} more`);
    } else lines.push('', '🪓 Every job is claimed. Legends.');
    const shop = (S.shopping || []).filter((x) => (x.eventId === ev.id || x.eventId === 'all') && !x.claimedBy);
    if (shop.length) {
      lines.push('', `🛒 *Still need someone to pick up:* ${shop.slice(0, 6).map((x) => x.name + (x.qty ? ` (${x.qty})` : '')).join(', ')}${shop.length > 6 ? ` +${shop.length - 6} more` : ''}`);
    }
    if (ps.length) lines.push('', `✅ ${set} of ${ps.length} sign-ups are all set${set < ps.length ? `. ${ps.length - set} still need points or a chip-in.` : '. Many hands, light work.'}`);
    lines.push('', `👉 Claim a job or chip in: ${url}`);
    return lines.join('\n');
  }

  function viewUpdate() {
    const ev = filter !== 'all' ? evById(filter) : S.events[0];
    return `<h2>Post an update</h2>
      <details class="box" id="upd">
        <summary>📣 Write a WhatsApp update</summary>
        <div class="stack" style="margin-top:12px">
          ${multi() ? `<select id="upd-ev" aria-label="Which event">${eventOptions(ev.id, false)}</select>` : ''}
          <textarea id="upd-text" rows="12" aria-label="Update message">${esc(updateText(ev, true))}</textarea>
          <label class="check small"><input type="checkbox" id="upd-code" checked> Include the event code in the link</label>
          <div class="grid2">
            <button class="btn primary" data-act="updSend">Open in WhatsApp</button>
            <button class="btn" data-act="updCopy">Copy text</button>
          </div>
          <p class="small muted">Edit it as you like, then pick the right group in WhatsApp. It shows counts only, never who is short.</p>
        </div>
      </details>`;
  }
  const refreshUpdate = () => {
    const sel = app.querySelector('#upd-ev');
    const ev = sel ? evById(sel.value) : (filter !== 'all' ? evById(filter) : S.events[0]);
    app.querySelector('#upd-text').value = updateText(ev, app.querySelector('#upd-code').checked);
  };

  // ----- Organise -----
  function viewOrg() {
    const r = S.roles;
    let out = viewUpdate();
    if (!r.admin || !r.treasurer) {
      out += `<h2>Unlock</h2><div class="card stack">
        ${!r.admin ? `<form class="row" data-form="adminLogin"><input name="c" type="password" placeholder="Organiser code" autocomplete="off" aria-label="Organiser code"><button class="btn primary" type="submit">Unlock</button></form>` : ''}
        ${!r.treasurer ? `<form class="row" data-form="treasLogin"><input name="c" type="password" placeholder="Treasurer code" autocomplete="off" aria-label="Treasurer code"><button class="btn primary" type="submit">Unlock</button></form>` : ''}
        <p class="small muted">Organisers see every event, manage jobs and events. The treasurer manages payment details and confirms payments.</p>
      </div>`;
    }
    if (r.admin) out += viewOverview();
    if (r.treasurer) out += viewTreasurer();
    if (r.admin) out += viewAdmin();
    if (r.admin || r.treasurer) out += `<p style="margin-top:20px"><button class="btn ghost full" data-act="lock">Lock organiser tools on this phone</button></p>`;
    return out;
  }

  // Birds-eye view across every event.
  function viewOverview() {
    const rows = S.events.map((ev) => {
      const h = headcount(ev);
      const ts = S.tasks.filter((t) => t.eventId === ev.id && !t.pending);
      const slots = ts.reduce((a, t) => a + t.slots, 0), filled = ts.reduce((a, t) => a + t.claims.length, 0);
      const ps = attendees(ev).filter((p) => !p.host);
      const short = ps.filter((p) => p.summary.status !== 'ok').length;
      return `<tr><td><b>${esc(ev.name)}</b><div class="small muted">${esc(ev.dates)} · code ${esc(ev.code)}</div></td>
        <td>${h.total}<div class="small muted">${h.rsvps} RSVPs</div></td>
        <td>${filled}/${slots}<div class="small muted">${ts.filter((t) => t.claims.length < t.slots).length} open</div></td>
        <td>${short ? `<span class="badge bad">${short} short</span>` : '<span class="badge ok">all set</span>'}</td></tr>`;
    }).join('');
    const shared = S.tasks.filter((t) => t.eventId === 'all' && !t.pending);
    const sSlots = shared.reduce((a, t) => a + t.slots, 0), sFilled = shared.reduce((a, t) => a + t.claims.length, 0);
    const pending = S.tasks.filter((t) => t.pending).length;
    return `<h2>All events at a glance</h2>
      <div class="card" style="overflow-x:auto"><table class="mini">
        <thead><tr><th>Event</th><th>People</th><th>Job slots</th><th>Points</th></tr></thead>
        <tbody>${rows}
          ${shared.length ? `<tr><td><b>Shared jobs</b><div class="small muted">count for every event</div></td><td></td><td>${sFilled}/${sSlots}<div class="small muted">${shared.filter((t) => t.claims.length < t.slots).length} open</div></td><td></td></tr>` : ''}
        </tbody></table>
        ${pending ? `<p class="small" style="margin:10px 0 0"><span class="badge pending">${pending} job${pending > 1 ? 's' : ''} waiting for points</span> (see Jobs below)</p>` : ''}
      </div>`;
  }

  function viewTreasurer() {
    const rows = [];
    for (const p of S.people) for (const x of p.payments || []) rows.push({ p, x });
    rows.sort((a, b) => Number(a.x.confirmed) - Number(b.x.confirmed) || b.x.at.localeCompare(a.x.at));
    const total = rows.filter((r) => r.x.confirmed).reduce((a, r) => a + r.x.amount, 0);
    return `
      <h2>Treasurer</h2>
      <form class="card stack" data-form="payInfo">
        <div class="field"><label for="pi-d">Payment details (PayID, BSB/account)</label>
          <textarea id="pi-d" name="details" maxlength="1000" placeholder="PayID: 0400 000 000 (Jane Smith)&#10;Reference: your name">${esc(S.payment.details)}</textarea></div>
        ${S.events.map((e) => `<div class="field"><label for="pi-m-${esc(e.id)}">Meal costs per head${multi() ? ': ' + esc(e.name) : ''}</label>
          <textarea id="pi-m-${esc(e.id)}" name="meal:${esc(e.id)}" maxlength="1000" placeholder="Saturday asado: $35 per adult, pay Delia">${esc(e.mealCosts)}</textarea></div>`).join('')}
        <button class="btn primary full" type="submit">Save payment info</button>
        <p class="small muted">Only people with the treasurer code can change this. Everyone with an event code can read it.</p>
      </form>
      <h3 style="margin:16px 0 8px">Payments (${money(total)} confirmed)</h3>
      <div class="card">${rows.length ? `<table class="mini"><tbody>${rows.map(({ p, x }) => `
        <tr><td>${esc(p.name)}<div class="small muted">${x.kind === 'meal' ? 'Meal' : 'Buy-in'}${x.note ? ' · ' + esc(x.note) : ''}</div></td><td>${money(x.amount)}</td>
        <td><button class="btn sm ${x.confirmed ? 'ghost' : 'primary'}" data-act="confirmPay" data-pid="${esc(p.id)}" data-id="${esc(x.id)}" data-v="${x.confirmed ? '0' : '1'}">${x.confirmed ? 'Undo' : 'Received'}</button></td></tr>`).join('')}
        </tbody></table>` : '<p class="muted">No payments recorded yet.</p>'}</div>`;
  }

  // People to offer when assigning: those coming to the job's event first, then everyone else.
  // Tick several and assign them in one go, up to the open spots.
  function assignPicker(t) {
    const taken = new Set(t.claims.map((c) => c.personId));
    const pool = S.people.filter((p) => !taken.has(p.id)).sort((a, b) => a.name.localeCompare(b.name));
    const going = t.eventId === 'all' ? pool : pool.filter((p) => p.rsvps[t.eventId]);
    const others = pool.filter((p) => !going.includes(p));
    const left = t.slots - t.claims.length;
    if (!pool.length) return '<p class="small muted">Everyone is already on this job.</p>';
    const box = (p) => `<label class="check small"><input type="checkbox" data-pick="${esc(t.id)}" value="${esc(p.id)}"> ${esc(p.name)}</label>`;
    return `<div class="small"><b>Assign people</b> (${left} spot${left === 1 ? '' : 's'} left)</div>
      <div class="checks">${going.map(box).join('')}</div>
      ${others.length ? `<details class="small"><summary>Not RSVP'd to this event (${others.length})</summary><div class="checks" style="margin-top:6px">${others.map(box).join('')}</div></details>` : ''}
      <div><button class="btn sm" type="button" data-act="assign" data-id="${esc(t.id)}" data-left="${left}">Assign ticked</button></div>`;
  }

  function taskRow(t) {
    const opt = (v, cur) => `<option value="${v}" ${Number(cur) === v ? 'selected' : ''}>${v}</option>`;
    return `
      <details class="box" data-key="task-${esc(t.id)}">
        <summary>${esc(t.title)} <span class="muted small">· ${t.phase} · ${t.points} pts · ${t.claims.length}/${t.slots}</span>${t.pending ? ' <span class="badge pending">pending</span>' : ''}</summary>
        <form class="stack" data-form="editTask" data-id="${esc(t.id)}" style="margin-top:10px">
          <input name="title" type="text" maxlength="120" value="${esc(t.title)}" aria-label="Job title">
          ${multi() ? `<select name="eventId" aria-label="Event">${eventOptions(t.eventId)}</select>` : ''}
          <div class="grid2">
            <select name="phase" aria-label="When">${['Before', 'During', 'After'].map((x) => `<option ${x === t.phase ? 'selected' : ''}>${x}</option>`).join('')}</select>
            <select name="points" aria-label="Points">${[1, 2, 3, 4, 5, 6, 7, 8].map((v) => opt(v, t.points)).join('')}</select>
          </div>
          <label class="small">People needed <input name="slots" type="number" min="1" max="20" value="${t.slots}"></label>
          ${t.eventId === 'all' ? '' : whenFields(t.phase !== 'During', t.day, t.slot, [evById(t.eventId)], t.eventId)}
          <label class="check small"><input type="checkbox" name="assignOnly" ${t.assignOnly ? 'checked' : ''}> Organiser assigns (people can't claim it themselves)</label>
          <div class="row wrap-row">
            <button class="btn primary sm" type="submit">${t.pending ? 'Approve and save' : 'Save'}</button>
            <button class="btn danger sm" type="button" data-act="delTask" data-id="${esc(t.id)}">Delete job</button>
          </div>
          ${t.claims.length ? `<div class="small"><b>Doing it</b> (untick if it didn't get done)</div>
            ${t.claims.map((c) => { const p = person(c.personId); return `<div class="row"><label class="check spacer"><input type="checkbox" data-act="notDone" data-tid="${esc(t.id)}" data-pid="${esc(c.personId)}" ${c.notDone ? '' : 'checked'}> ${esc(p ? p.name : '?')} did it${c.assigned ? ' <span class="muted small">(assigned)</span>' : ''}</label><button class="btn sm ghost danger" type="button" data-act="unassign" data-tid="${esc(t.id)}" data-pid="${esc(c.personId)}">Remove</button></div>`; }).join('')}` : ''}
          ${t.claims.length < t.slots ? assignPicker(t) : '<p class="small muted">All spots filled. Raise "People needed" to add more.</p>'}
        </form>
      </details>`;
  }

  function eventForm(e) {
    return `
      <details class="box" data-key="ev-${esc(e.id)}"><summary>${esc(e.name)} <span class="muted small">· ${esc(e.dates)} · code ${esc(e.code)}</span></summary>
        <form class="stack" data-form="event" data-ev="${esc(e.id)}" style="margin-top:10px">
          <div class="field"><label>Event name</label><input name="name" type="text" maxlength="80" value="${esc(e.name)}"></div>
          <div class="grid2">
            <div><label>Start date</label><input name="startDate" type="date" value="${esc(e.startDate || '')}"></div>
            <div><label>End date</label><input name="endDate" type="date" value="${esc(e.endDate || '')}" min="${esc(e.startDate || '')}"></div>
          </div>
          <div class="field"><label>Event code</label><input name="code" type="text" maxlength="20" autocapitalize="characters" value="${esc(e.code)}"></div>
          <div class="field"><label>Location</label><input name="location" type="text" maxlength="120" value="${esc(e.location)}"></div>
          <div class="field"><label>WhatsApp group invite link</label><input name="whatsappUrl" type="url" placeholder="https://chat.whatsapp.com/…" value="${esc(e.whatsappUrl)}"></div>
          <div class="grid2">
            <div><label>Points per adult (overnight)</label><input name="pointsOvernight" type="number" min="0" max="20" value="${e.pointsOvernight}"></div>
            <div><label>Points per adult (day visit)</label><input name="pointsDay" type="number" min="0" max="20" value="${e.pointsDay}"></div>
          </div>
          <div class="field"><label>Points per adult for first-timers</label><input name="pointsFirstTimer" type="number" min="0" max="20" value="${e.pointsFirstTimer ?? e.pointsOvernight}"></div>
          <input type="hidden" name="guestTasks" value="off">
          <label class="check small"><input type="checkbox" name="guestTasks" ${e.guestTasks !== false ? 'checked' : ''}> Attendees can add jobs (untick so only organisers can)</label>
          <button class="btn primary full" type="submit">Save event</button>
          <p class="small muted">Changing the code locks out anyone using the old one until they enter the new one.</p>
          <div class="grid2">
            <button class="btn danger" type="button" data-act="resetEvent" data-ev="${esc(e.id)}">Clear RSVPs and claims</button>
            ${multi() ? `<button class="btn danger" type="button" data-act="deleteEvent" data-ev="${esc(e.id)}">Delete event</button>` : ''}
          </div>
        </form>
      </details>`;
  }

  function viewAdmin() {
    const pendingTasks = S.tasks.filter((t) => t.pending);
    const short = S.people.filter((p) => p.summary.status !== 'ok' && !p.host);
    const groups = [['all', 'Shared jobs (all events)'], ...S.events.map((e) => [e.id, e.name])];
    return `
      <h2>Organiser</h2>
      ${pendingTasks.length ? `<h3 style="margin:8px 0">Jobs waiting for points (${pendingTasks.length})</h3>${pendingTasks.map(taskRow).join('')}` : ''}
      <h3 style="margin:16px 0 8px">Still short (${short.length})</h3>
      <div class="card">${short.length ? `<ul class="plist">${short.map((p) => `<li><span class="dot ${p.summary.status}"></span><span class="spacer">${esc(p.name)}<span class="small muted" style="display:block">${S.events.filter((e) => p.rsvps[e.id]).map((e) => esc(e.name)).join(', ')}</span></span><span class="small muted">${fmtPts(p.summary.have)}/${p.summary.req} pts</span></li>`).join('')}</ul>` : '<p class="muted">Everyone is set.</p>'}</div>
      <div class="row" style="margin-top:10px"><button class="btn full" data-act="csv">Download headcount (CSV, all events)</button></div>

      <h3 style="margin:20px 0 8px">Events (${S.events.length})</h3>
      ${S.events.map(eventForm).join('')}
      <details class="box"><summary>+ Add an event</summary>
        <form class="stack" data-form="addEvent" style="margin-top:10px">
          <div class="field"><label for="ne-n">Event name</label><input id="ne-n" name="name" type="text" maxlength="80" required placeholder="Winter Fest 2027"></div>
          <div class="grid2">
            <div><label for="ne-s">Start date</label><input id="ne-s" name="startDate" type="date"></div>
            <div><label for="ne-e">End date</label><input id="ne-e" name="endDate" type="date"></div>
          </div>
          <div class="field"><label for="ne-c">Event code</label><input id="ne-c" name="code" type="text" maxlength="20" required autocapitalize="characters" placeholder="WINTER27"></div>
          <div class="field"><label for="ne-cp">Start with jobs from</label><select id="ne-cp" name="copyFrom">
            <option value="">The standard Farm Fest list</option>
            ${S.events.map((e) => `<option value="${esc(e.id)}">A copy of ${esc(e.name)}'s jobs</option>`).join('')}
            <option value="none">No jobs</option></select></div>
          <button class="btn primary full" type="submit">Create event</button>
        </form>
      </details>

      <h3 style="margin:20px 0 8px">All jobs (${S.tasks.length})</h3>
      ${groups.map(([id, name]) => {
        const ts = S.tasks.filter((t) => t.eventId === id && !t.pending);
        if (!ts.length && id === 'all') return '';
        return `${multi() || id === 'all' ? `<h3 class="small muted" style="margin:14px 0 6px">${esc(name)}</h3>` : ''}${['Before', 'During', 'After'].map((ph) => ts.filter((t) => t.phase === ph).map(taskRow).join('')).join('')}`;
      }).join('')}
      <details class="box" style="margin-top:10px"><summary>+ Add a job for one or all events</summary>
        <form class="stack" data-form="addTask" style="margin-top:12px">
          <input name="title" type="text" maxlength="120" required placeholder="What needs doing?" aria-label="Job">
          <select name="eventId" aria-label="Event">${eventOptions(multi() ? 'all' : S.events[0].id)}</select>
          <div class="grid2">
            <select name="phase" aria-label="When">${['Before', 'During', 'After'].map((x) => `<option>${x}</option>`).join('')}</select>
            <select name="points" aria-label="Points">${[1, 2, 3, 5, 8].map((v) => `<option value="${v}" ${v === 2 ? 'selected' : ''}>${v} pts</option>`).join('')}</select>
          </div>
          <label class="small">People needed <input name="slots" type="number" min="1" max="20" value="1"></label>
          <label class="check small"><input type="checkbox" name="assignOnly"> Organiser assigns (e.g. serving behind the bar)</label>
          <button class="btn primary full" type="submit">Add job</button>
        </form>
      </details>

      <h3 style="margin:20px 0 8px">Money</h3>
      <form class="card row" data-form="settings"><label class="spacer" for="st-dp" style="margin:0">Dollars per point (all events)</label>
        <input id="st-dp" name="dollarsPerPoint" type="number" min="1" max="500" value="${S.settings.dollarsPerPoint}" style="width:90px">
        <button class="btn primary sm" type="submit">Save</button></form>

      <h3 style="margin:20px 0 8px">People (${S.people.length})</h3>
      ${[...S.people].sort((a, b) => a.name.localeCompare(b.name)).map((p) => `
        <div class="card row"><span class="spacer">${esc(p.name)}<span class="small muted" style="display:block">${S.events.filter((e) => p.rsvps[e.id]).map((e) => esc(e.name)).join(', ') || 'No RSVPs'}</span></span>
          <label class="check small"><input type="checkbox" data-act="host" data-id="${esc(p.id)}" ${p.host ? 'checked' : ''}> Host</label>
          <button class="btn sm danger" data-act="removePerson" data-id="${esc(p.id)}">Remove</button></div>`).join('') || '<p class="muted">Nobody yet.</p>'}`;
  }

  // ---------- events ----------
  app.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const kind = f.dataset.form;
    const fd = new FormData(f);
    if (kind === 'gate') {
      const c = String(fd.get('code') || '').trim();
      screen = 'loading'; render();
      if (await addCode(c)) { screen = me ? 'app' : 'who'; render(); } else { screen = 'gate'; render(); }
    } else if (kind === 'addCode') {
      if (await addCode(fd.get('code'))) { toast('Event added'); render(); }
    } else if (kind === 'join') {
      const r = await act({ action: 'join', eventId: fd.get('eventId'), person: { name: fd.get('name'), sponsor: fd.get('sponsor'), firstTimer: fd.get('firstTimer') === 'on' }, rsvp: readRsvp(fd) }, "You're on the list!");
      if (r?.personId) { me = r.personId; ls.set('me', me); screen = 'app'; tab = 'jobs'; ls.set('tab', tab); await load(); }
    } else if (kind === 'rsvp') {
      act({ action: 'setRsvp', personId: me, eventId: f.dataset.ev, rsvp: readRsvp(fd) }, 'Saved');
    } else if (kind === 'about') {
      act({ action: 'updatePerson', personId: me, person: { name: fd.get('name'), sponsor: fd.get('sponsor'), firstTimer: fd.get('firstTimer') === 'on' } }, 'Saved');
    } else if (kind === 'addTask') {
      const r = await act(readWhen(fd, { action: 'addTask', eventId: fd.get('eventId'), title: fd.get('title'), phase: fd.get('phase'), slots: fd.get('slots'), points: fd.get('points'), assignOnly: fd.get('assignOnly') === 'on', addedBy: person(me)?.name }), 'Job added');
      if (r && tab === 'jobs') { phase = fd.get('phase'); ls.set('phase', phase); render(); }
    } else if (kind === 'pay') {
      act({ action: 'reportPayment', personId: me, amount: fd.get('amount'), kind: fd.get('kind'), note: fd.get('note') }, 'Recorded. The treasurer will confirm it.');
    } else if (kind === 'adminLogin' || kind === 'treasLogin') {
      const c = String(fd.get('c') || '').trim();
      const isAdmin = kind === 'adminLogin';
      const prev = isAdmin ? adminCode : treasurerCode;
      if (isAdmin) adminCode = c; else treasurerCode = c;
      try {
        const r = await api('POST', { action: 'checkRoles' });
        if (!(isAdmin ? r.roles.admin : r.roles.treasurer)) throw new Error('That code is not right');
        ls.set(isAdmin ? 'admin' : 'treasurer', c);
        toast('Unlocked');
        await load();
      } catch (e) {
        if (isAdmin) adminCode = prev; else treasurerCode = prev;
        toast(e.message, true);
      }
    } else if (kind === 'payInfo') {
      const mealCosts = {};
      for (const [k, v] of fd.entries()) if (k.startsWith('meal:')) mealCosts[k.slice(5)] = v;
      act({ action: 'updatePaymentInfo', details: fd.get('details'), mealCosts }, 'Payment info saved');
    } else if (kind === 'editTask') {
      const body = { action: 'editTask', taskId: f.dataset.id, title: fd.get('title'), phase: fd.get('phase'), points: fd.get('points'), slots: fd.get('slots'), assignOnly: fd.get('assignOnly') === 'on', pending: false };
      if (fd.get('eventId')) body.eventId = fd.get('eventId');
      if (fd.has('day') || fd.has('slot')) readWhen(fd, body);
      act(body, 'Job saved');
    } else if (kind === 'runSheet') {
      act({ action: 'setRunSheet', eventId: f.dataset.ev, day: f.dataset.day, text: fd.get('text') }, 'Run sheet saved');
    } else if (kind === 'event') {
      act({ action: 'updateEvent', eventId: f.dataset.ev, event: Object.fromEntries(fd.entries()) }, 'Event saved');
    } else if (kind === 'addEvent') {
      const r = await act({ action: 'addEvent', event: { name: fd.get('name'), startDate: fd.get('startDate'), endDate: fd.get('endDate'), code: fd.get('code') }, copyFrom: fd.get('copyFrom') || undefined }, 'Event created');
      if (r?.eventId) { filter = r.eventId; ls.set('filter', filter); render(); }
    } else if (kind === 'addItem') {
      const r = await act({ action: 'addItem', eventId: fd.get('eventId'), name: fd.get('name'), qty: fd.get('qty'), note: fd.get('note'), personId: me, addedBy: person(me)?.name }, 'Added to the list');
      if (r) { const i = app.querySelector('#si-n'); if (i) i.focus(); }
    } else if (kind === 'settings') {
      act({ action: 'updateSettings', dollarsPerPoint: fd.get('dollarsPerPoint') }, 'Saved');
    }
  });

  app.addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-act]');
    if (!b || b.tagName === 'INPUT') return;
    const a = b.dataset.act;
    if (a === 'tab') { tab = b.dataset.tab; ls.set('tab', tab); window.scrollTo(0, 0); renderApp(); return; }
    if (a === 'filter') { filter = b.dataset.id; ls.set('filter', filter); render(); return; }
    if (a === 'showAddCode') { const f = app.querySelector('#addCode'); f.classList.toggle('hidden'); if (!f.classList.contains('hidden')) f.querySelector('input').focus(); return; }
    if (a === 'phase') { phase = b.dataset.ph; ls.set('phase', phase); render(); return; }
    if (a === 'goJoin') { screen = 'join'; render(); return; }
    if (a === 'goWho') { screen = 'who'; render(); return; }
    if (a === 'gateAgain') { screen = 'gate'; render(); return; }
    if (a === 'pickMe') { me = b.dataset.id; ls.set('me', me); screen = 'app'; await load(); return; }
    if (a === 'switchMe') { me = ''; ls.set('me', null); screen = 'who'; render(); return; }
    if (a === 'claim') { act({ action: 'claim', taskId: b.dataset.id, personId: me }, 'Claimed. Thank you!'); return; }
    if (a === 'unclaim') { act({ action: 'unclaim', taskId: b.dataset.id, personId: me }, 'Dropped'); return; }
    if (a === 'unrsvp') { if (confirmTwice(b, 'Tap again to remove your RSVP')) act({ action: 'setRsvp', personId: me, eventId: b.dataset.ev, rsvp: null }, 'Removed'); return; }
    if (a === 'share') { shareTask(b.dataset.id); return; }
    if (a === 'cancelPay') { act({ action: 'cancelPayment', personId: me, paymentId: b.dataset.id }, 'Removed'); return; }
    if (a === 'confirmPay') { act({ action: 'confirmPayment', personId: b.dataset.pid, paymentId: b.dataset.id, confirmed: b.dataset.v === '1' }, 'Updated'); return; }
    if (a === 'delTask') { if (confirmTwice(b, 'Tap again to delete')) act({ action: 'deleteTask', taskId: b.dataset.id }, 'Job deleted'); return; }
    if (a === 'removePerson') { if (confirmTwice(b, 'Tap again to remove')) act({ action: 'removePerson', personId: b.dataset.id }, 'Removed'); return; }
    if (a === 'resetEvent') { if (confirmTwice(b, 'Tap again: clears RSVPs and claims')) act({ action: 'resetEvent', eventId: b.dataset.ev }, 'Event cleared'); return; }
    if (a === 'deleteEvent') { if (confirmTwice(b, 'Tap again: deletes event and its jobs')) act({ action: 'deleteEvent', eventId: b.dataset.ev }, 'Event deleted'); return; }
    if (a === 'csv') { downloadCsv(); return; }
    if (a === 'assign') {
      const ids = [...app.querySelectorAll('input[data-pick="' + CSS.escape(b.dataset.id) + '"]:checked')].map((x) => x.value);
      if (!ids.length) { toast('Tick someone first', true); return; }
      const left = Number(b.dataset.left);
      if (ids.length > left) { toast(`Only ${left} spot${left === 1 ? '' : 's'} left. Untick some, or raise "People needed"`, true); return; }
      act({ action: 'assign', taskId: b.dataset.id, personIds: ids }, ids.length > 1 ? `Assigned ${ids.length} people` : 'Assigned'); return;
    }
    if (a === 'unassign') { if (confirmTwice(b, 'Tap again')) act({ action: 'unclaim', taskId: b.dataset.tid, personId: b.dataset.pid }, 'Removed'); return; }
    if (a === 'grab') { act({ action: 'claimItem', itemId: b.dataset.id, personId: me }, "Thanks! It's yours"); return; }
    if (a === 'ungrab') { act({ action: 'unclaimItem', itemId: b.dataset.id, personId: me }, 'Dropped'); return; }
    if (a === 'got') { act({ action: 'setItemGot', itemId: b.dataset.id, personId: me, got: b.dataset.v === '1' }, b.dataset.v === '1' ? 'Ticked off' : 'Updated'); return; }
    if (a === 'delItem') { if (confirmTwice(b, 'Tap again')) act({ action: 'deleteItem', itemId: b.dataset.id, personId: me }, 'Removed'); return; }
    if (a === 'updSend') { window.open('https://wa.me/?text=' + encodeURIComponent(app.querySelector('#upd-text').value), '_blank', 'noopener'); return; }
    if (a === 'updCopy') {
      const v = app.querySelector('#upd-text').value;
      (navigator.clipboard ? navigator.clipboard.writeText(v) : Promise.reject()).then(() => toast('Copied'), () => { app.querySelector('#upd-text').select(); toast('Select all and copy'); });
      return;
    }
    if (a === 'lock') { adminCode = ''; treasurerCode = ''; ls.set('admin', null); ls.set('treasurer', null); load(); return; }
  });

  app.addEventListener('change', (ev) => {
    const b = ev.target;
    if (b.id === 'upd-code' || b.id === 'upd-ev') refreshUpdate();
    if (b.name === 'phase' && b.form) { const w = b.form.querySelector('.when'); if (w) w.hidden = b.value !== 'During'; }
    if (b.dataset.act === 'notDone') act({ action: 'setNotDone', taskId: b.dataset.tid, personId: b.dataset.pid, notDone: !b.checked }, b.checked ? 'Marked done' : 'Points removed');
    if (b.dataset.act === 'host') act({ action: 'updatePerson', personId: b.dataset.id, person: { host: b.checked } }, 'Updated');
  });

  // Destructive actions need a second tap instead of a browser dialog.
  function confirmTwice(btn, msg) {
    if (btn.dataset.armed) return true;
    const old = btn.textContent;
    btn.dataset.armed = '1'; btn.textContent = msg;
    setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = old; } }, 3500);
    return false;
  }

  function shareTask(id) {
    const t = S.tasks.find((x) => x.id === id);
    const p = person(me);
    const mine = t.claims.some((c) => c.personId === me);
    const evLabel = t.eventId === 'all' ? 'Farm Fest' : evName(t.eventId);
    const text = mine
      ? `${p.name} is on "${t.title}" (${t.points} pts) for ${evLabel}. Grab a job: ${location.origin}`
      : `Can anyone take "${t.title}" (${t.points} pts) for ${evLabel}? ${location.origin}`;
    window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener');
  }

  function downloadCsv() {
    const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    const rows = [['Event', 'Name', 'Adults', 'Kids', 'Fri', 'Sat', 'Diet', 'Sponsor', 'First timer', 'Points (all events)', 'Required (all events)', 'Buy-in confirmed', 'Buy-in awaiting', 'Jobs']];
    for (const e of S.events) {
      for (const p of attendees(e)) {
        const r = p.rsvps[e.id], t = p.summary;
        const jobs = S.tasks.filter((x) => (x.eventId === e.id || x.eventId === 'all') && x.claims.some((c) => c.personId === p.id && !c.notDone)).map((x) => x.title).join('; ');
        rows.push([e.name, p.name, r.adults, r.kids, r.nights.includes('Fri') ? 'Y' : '', r.nights.includes('Sat') ? 'Y' : '', r.diet, p.sponsor, p.firstTimer ? 'Y' : '', fmtPts(t.earned), t.req, t.paidOk, t.paidWait, jobs]);
      }
    }
    const blob = new Blob([rows.map((r) => r.map(q).join(',')).join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'farmfest-headcount.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // Refresh when the page comes back into view, and every 30 s while open.
  document.addEventListener('visibilitychange', () => { if (!document.hidden && codes.length && screen === 'app') load(); });
  setInterval(() => {
    const typing = document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    const openDetails = app.querySelector('details[open]');
    if (!document.hidden && codes.length && screen === 'app' && !busy && !typing && !openDetails) load();
  }, 30000);

  // ?code=FF27 links (from WhatsApp updates) add that event's code.
  (async () => {
    const qp = new URLSearchParams(location.search).get('code');
    if (qp) { history.replaceState(null, '', location.pathname); }
    if (qp && !codes.some((c) => c.toUpperCase() === qp.trim().toUpperCase())) {
      render();
      if (await addCode(qp)) { screen = me ? 'app' : 'who'; return render(); }
    }
    if (codes.length) { render(); load(); } else { screen = 'gate'; render(); }
  })();
})();
