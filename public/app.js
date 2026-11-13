/* Farm Fest: RSVP, jobs board and chip-in. Vanilla JS, no build step. */
(() => {
  'use strict';

  // ---------- local storage (best effort) ----------
  const ls = {
    get(k) { try { return localStorage.getItem('ff.' + k); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem('ff.' + k) : localStorage.setItem('ff.' + k, v); } catch {} },
  };

  let S = null;                       // server state
  let code = ls.get('code') || '';    // event code
  let adminCode = ls.get('admin') || '';
  let treasurerCode = ls.get('treasurer') || '';
  let me = ls.get('me') || '';        // person id
  let tab = ls.get('tab') || 'jobs';
  let phase = ls.get('phase') || 'Before';
  let screen = 'loading';             // loading | gate | who | join | app
  let busy = false;

  const app = document.getElementById('app');
  const toastEl = document.getElementById('toast');

  // ---------- helpers ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => '$' + (Math.round(n * 100) / 100).toLocaleString('en-AU', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
  const fmtPts = (n) => (Math.round(n * 10) / 10).toString();
  let toastTimer;
  function toast(msg, err) {
    toastEl.textContent = msg;
    toastEl.className = 'show' + (err ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.className = ''), 2600);
  }

  async function api(method, body) {
    const headers = { 'x-event-code': code };
    if (adminCode) headers['x-admin-code'] = adminCode;
    if (treasurerCode) headers['x-treasurer-code'] = treasurerCode;
    if (body) headers['content-type'] = 'application/json';
    const res = await fetch('/api', { method, headers, body: body ? JSON.stringify(body) : undefined });
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) { const e = new Error(data.error || 'Something went wrong'); e.status = res.status; throw e; }
    return data;
  }

  async function load() {
    try {
      S = await api('GET');
      if (!S.roles.admin && adminCode) { adminCode = ''; ls.set('admin', null); }
      if (!S.roles.treasurer && treasurerCode) { treasurerCode = ''; ls.set('treasurer', null); }
      if (me && !S.people.some((p) => p.id === me)) { me = ''; ls.set('me', null); }
      screen = me ? 'app' : 'who';
    } catch (e) {
      if (e.status === 401) { code = ''; ls.set('code', null); screen = 'gate'; }
      else { toast(e.message, true); if (!S) screen = 'gate'; }
    }
    render();
  }

  async function act(body, okMsg) {
    if (busy) return null;
    busy = true;
    try {
      const r = await api('POST', body);
      if (r.state) S = r.state;
      if (okMsg) toast(okMsg);
      render();
      return r;
    } catch (e) {
      toast(e.message, true);
      if (e.status === 404 || e.status === 409) load();
      return null;
    } finally { busy = false; }
  }

  // ---------- points ----------
  const person = (id) => S.people.find((p) => p.id === id);
  function required(p) {
    if (p.host) return 0;
    let per = p.nights && p.nights.length ? S.event.pointsOvernight : S.event.pointsDay;
    if (p.firstTimer) per = Math.min(per, S.event.pointsFirstTimer ?? per);
    return Math.max(p.adults, 0) * per;
  }
  function tally(p) {
    let earned = 0, pending = 0;
    for (const t of S.tasks) {
      const c = t.claims.find((x) => x.personId === p.id);
      if (!c || c.notDone) continue;
      if (t.pending) pending += t.points; else earned += t.points;
    }
    const dpp = S.event.dollarsPerPoint || 20;
    const buyins = p.payments.filter((x) => x.kind !== 'meal');
    const paidOk = buyins.filter((x) => x.confirmed).reduce((a, x) => a + x.amount, 0);
    const paidWait = buyins.filter((x) => !x.confirmed).reduce((a, x) => a + x.amount, 0);
    const req = required(p);
    const have = earned + paidOk / dpp;
    const haveIncl = have + paidWait / dpp;
    const status = req === 0 || have >= req ? 'ok' : haveIncl >= req ? 'warn' : 'bad';
    const shortPts = Math.max(0, req - haveIncl);
    return { earned, pending, paidOk, paidWait, req, have, status, shortPts, shortDollars: Math.ceil(shortPts * dpp) };
  }

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
          <input id="gc" name="code" type="text" autocomplete="off" autocapitalize="characters" required value="${esc(code)}"></div>
        <button class="btn primary full" type="submit">Let me in</button>
      </form>`;
    app.querySelector('#gc').focus();
  }

  function renderWho() {
    const people = [...S.people].sort((a, b) => a.name.localeCompare(b.name));
    app.innerHTML = `
      <div class="gate stack" style="justify-content:flex-start;padding-top:40px">
        <h1>Who are you?</h1>
        <p class="muted">${esc(S.event.name)} · ${esc(S.event.dates)}</p>
        <button class="btn primary full" data-act="goJoin">I'm new: add me</button>
        ${people.length ? `
          <div class="field"><label for="wf">Or find your name</label>
            <input id="wf" type="text" placeholder="Start typing…" autocomplete="off"></div>
          <div class="card"><ul class="plist" id="wl">
            ${people.map((p) => `<li data-name="${esc(p.name.toLowerCase())}"><span class="spacer">${esc(p.name)}</span>
              <button class="btn sm" data-act="pickMe" data-id="${esc(p.id)}">That's me</button></li>`).join('')}
          </ul></div>` : `<p class="muted small">Nobody has signed up yet. Be the first.</p>`}
      </div>`;
    const f = app.querySelector('#wf');
    if (f) f.addEventListener('input', () => {
      const q = f.value.trim().toLowerCase();
      app.querySelectorAll('#wl li').forEach((li) => li.classList.toggle('hidden', q && !li.dataset.name.includes(q)));
    });
  }

  function rsvpFields(p) {
    p = p || { adults: 1, kids: 0, nights: ['Fri', 'Sat'], diet: '', sponsor: '', firstTimer: false, name: '' };
    return `
      <div class="field"><label for="f-name">Your name (or household, e.g. "Karen + Pete")</label>
        <input id="f-name" name="name" type="text" maxlength="60" required value="${esc(p.name)}"></div>
      <div class="grid2 field">
        <div><label for="f-ad">Adults</label><input id="f-ad" name="adults" type="number" min="0" max="10" inputmode="numeric" value="${esc(p.adults)}"></div>
        <div><label for="f-kd">Kids</label><input id="f-kd" name="kids" type="number" min="0" max="10" inputmode="numeric" value="${esc(p.kids)}"></div>
      </div>
      <div class="field"><label>Nights staying (none = day visit)</label>
        <div class="checks">
          ${['Fri', 'Sat'].map((n) => `<label class="check"><input type="checkbox" name="nights" value="${n}" ${p.nights.includes(n) ? 'checked' : ''}> ${n} night</label>`).join('')}
        </div></div>
      <div class="field"><label for="f-diet">Dietary needs</label>
        <input id="f-diet" name="diet" type="text" maxlength="120" placeholder="e.g. vegetarian, no pork" value="${esc(p.diet)}"></div>
      <div class="field"><label for="f-sp">Who invited you? (your sponsor)</label>
        <input id="f-sp" name="sponsor" type="text" maxlength="60" placeholder="Leave blank if you're a regular" value="${esc(p.sponsor)}"></div>
      <div class="field"><label class="check"><input type="checkbox" name="firstTimer" ${p.firstTimer ? 'checked' : ''}> First Farm Fest</label></div>`;
  }
  function readRsvp(form) {
    const fd = new FormData(form);
    return {
      name: fd.get('name'), adults: fd.get('adults'), kids: fd.get('kids'), nights: fd.getAll('nights'),
      diet: fd.get('diet'), sponsor: fd.get('sponsor'), firstTimer: fd.get('firstTimer') === 'on',
    };
  }

  function renderJoin() {
    app.innerHTML = `
      <form class="gate stack" data-form="join" style="justify-content:flex-start;padding-top:32px">
        <h1>I'm coming</h1>
        <p class="muted">${esc(S.event.name)} · ${esc(S.event.dates)}</p>
        ${rsvpFields()}
        <button class="btn primary full" type="submit">Add me</button>
        <button class="btn ghost full" type="button" data-act="goWho">Back</button>
      </form>`;
  }

  function header() {
    const p = person(me);
    const t = tally(p);
    const pct = t.req ? Math.min(100, (t.have / t.req) * 100) : 100;
    const wa = S.event.whatsappUrl;
    let line;
    if (p.host) line = 'Host: no points needed. Thank you!';
    else if (t.status === 'ok') line = `✅ ${fmtPts(t.have)} of ${t.req} points. You're all set.`;
    else if (t.status === 'warn') line = `${fmtPts(t.have)} of ${t.req} points. Payment awaiting the treasurer.`;
    else line = `${fmtPts(t.have)} of ${t.req} points. Claim ${fmtPts(t.shortPts)} more, or chip in ${money(t.shortDollars)}.`;
    return `
      <header class="top"><div class="wrap">
        <div class="row">
          <div class="spacer"><h1>${esc(S.event.name)}</h1><div class="sub">${esc(S.event.dates)}${S.event.location ? ' · ' + esc(S.event.location) : ''}</div></div>
          ${wa ? `<a class="wa-btn" href="${esc(wa)}" target="_blank" rel="noopener">💬 Chat</a>` : ''}
        </div>
        <div class="me">
          <div class="row"><span class="who spacer">${esc(p.name)}</span><button class="linkish" data-act="switchMe">Not you?</button></div>
          <div class="small">${line}${t.pending ? ` <span class="badge pending">+${t.pending} pts pending</span>` : ''}</div>
          <div class="bar ${t.status === 'ok' ? 'done' : ''}"><i style="width:${pct}%"></i></div>
        </div>
      </div></header>`;
  }

  function nav() {
    const items = [['coming', '🏕️', 'Coming'], ['jobs', '🪓', 'Jobs'], ['chip', '💸', 'Chip in'], ['org', '⚙️', 'Organise']];
    return `<nav class="tabs">${items.map(([k, ic, l]) => `<button data-act="tab" data-tab="${k}" ${tab === k ? 'aria-current="page"' : ''}><span class="ic" aria-hidden="true">${ic}</span>${l}</button>`).join('')}</nav>`;
  }

  function renderApp() {
    const y = window.scrollY;
    const body = tab === 'coming' ? viewComing() : tab === 'chip' ? viewChip() : tab === 'org' ? viewOrg() : viewJobs();
    app.innerHTML = header() + nav() + `<main class="wrap">${body}</main>`;
    window.scrollTo(0, y);
  }

  // ----- Jobs -----
  function taskCard(t) {
    const mine = t.claims.some((c) => c.personId === me);
    const full = t.claims.length >= t.slots;
    const names = t.claims.map((c) => {
      const p = person(c.personId);
      return `<span class="tag ${c.personId === me ? 'me-tag' : ''} ${c.notDone ? 'struck' : ''}">${esc(p ? p.name : '?')}${c.notDone ? ' (not done)' : ''}</span>`;
    }).join('');
    const open = t.slots - t.claims.length;
    return `<div class="card">
      <div class="row" style="align-items:flex-start">
        <div class="spacer">
          <div class="task-title">${esc(t.title)}</div>
          <div class="small muted">${open > 0 ? `${open} of ${t.slots} slot${t.slots > 1 ? 's' : ''} open` : 'All slots taken'}
            ${t.pending ? ' · <span class="badge pending">points pending</span>' : ''}</div>
        </div>
        <div class="pts ${t.points >= 5 ? 'big' : ''}">${t.points}<span class="u">pts</span></div>
      </div>
      ${names ? `<div class="names">${names}</div>` : ''}
      <div class="row" style="margin-top:10px">
        ${mine ? `<button class="btn sm" data-act="unclaim" data-id="${esc(t.id)}">Drop it</button>`
               : `<button class="btn primary sm" data-act="claim" data-id="${esc(t.id)}" ${full ? 'disabled' : ''}>I'll do it</button>`}
        <span class="spacer"></span>
        <button class="btn ghost sm" data-act="share" data-id="${esc(t.id)}">Share</button>
      </div>
    </div>`;
  }

  function viewJobs() {
    const tasks = S.tasks.filter((t) => t.phase === phase).sort((a, b) => b.points - a.points || a.title.localeCompare(b.title));
    const counts = Object.fromEntries(['Before', 'During', 'After'].map((ph) => [ph, S.tasks.filter((t) => t.phase === ph && t.claims.length < t.slots).length]));
    return `
      <div class="seg" role="group" aria-label="When">
        ${['Before', 'During', 'After'].map((ph) => `<button data-act="phase" data-ph="${ph}" aria-pressed="${phase === ph}">${ph} <span class="muted small">(${counts[ph]})</span></button>`).join('')}
      </div>
      <p class="small muted">Big jobs earn big points: cooking a dinner is worth 8, a rubbish run 2. Everyone staying over needs ${S.event.pointsOvernight} points per adult.</p>
      ${tasks.length ? tasks.map(taskCard).join('') : `<p class="muted">No jobs here yet.</p>`}
      <details class="box" style="margin-top:16px">
        <summary>+ Add a job</summary>
        <form class="stack" data-form="addTask" style="margin-top:12px">
          <div class="field"><label for="t-title">What needs doing?</label><input id="t-title" name="title" type="text" maxlength="120" required></div>
          <div class="grid2">
            <div><label for="t-ph">When</label><select id="t-ph" name="phase">${['Before', 'During', 'After'].map((x) => `<option ${x === phase ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
            <div><label for="t-sl">People needed</label><input id="t-sl" name="slots" type="number" min="1" max="20" value="1" inputmode="numeric"></div>
          </div>
          <div class="field"><label for="t-pt">Suggested points</label>
            <select id="t-pt" name="points">
              <option value="1">1: quick errand</option><option value="2" selected>2: an hour or so</option>
              <option value="3">3: half a day</option><option value="5">5: full day or lead role</option><option value="8">8: cook a meal for everyone</option>
            </select></div>
          <p class="small muted">${S.roles.admin ? 'You are an organiser, so this goes live straight away.' : 'An organiser will confirm the points. You can still claim it now.'}</p>
          <button class="btn primary full" type="submit">Add job</button>
        </form>
      </details>`;
  }

  // ----- Coming -----
  function viewComing() {
    const p = person(me);
    const nightCount = (n) => S.people.filter((x) => x.nights.includes(n));
    const sum = (arr, k) => arr.reduce((a, x) => a + (x[k] || 0), 0);
    const fri = nightCount('Fri'), sat = nightCount('Sat');
    const all = S.people;
    const diets = all.filter((x) => x.diet).map((x) => `<li><span class="spacer">${esc(x.name)}</span><span class="muted small">${esc(x.diet)}</span></li>`).join('');
    const people = [...all].sort((a, b) => a.name.localeCompare(b.name)).map((x) => {
      const t = tally(x);
      const nights = x.nights.length ? x.nights.join(' + ') : 'Day visit';
      return `<li><span class="dot ${t.status}" title="${t.status === 'ok' ? 'All set' : t.status === 'warn' ? 'Payment awaiting check' : 'Still short'}"></span>
        <span class="spacer">${esc(x.name)}${x.host ? ' <span class="badge ok">host</span>' : ''}
          <span class="small muted" style="display:block">${x.adults} adult${x.adults === 1 ? '' : 's'}${x.kids ? `, ${x.kids} kid${x.kids === 1 ? '' : 's'}` : ''} · ${nights}${x.sponsor ? ' · via ' + esc(x.sponsor) : ''}</span></span>
        <span class="small muted">${t.req ? `${fmtPts(t.have)}/${t.req}` : ''}</span></li>`;
    }).join('');
    return `
      <h2>Headcount</h2>
      <div class="stats">
        <div class="stat"><b>${sum(fri, 'adults')}<small>+${sum(fri, 'kids')}</small></b><span>Friday night<br>adults + kids</span></div>
        <div class="stat"><b>${sum(sat, 'adults')}<small>+${sum(sat, 'kids')}</small></b><span>Saturday night<br>adults + kids</span></div>
        <div class="stat"><b>${sum(all, 'adults') + sum(all, 'kids')}</b><span>Total people<br>all days</span></div>
      </div>
      <h2>My RSVP</h2>
      <form class="card stack" data-form="rsvp">
        ${rsvpFields(p)}
        <button class="btn primary full" type="submit">Save</button>
      </form>
      ${diets ? `<h2>Dietary needs</h2><div class="card"><ul class="plist">${diets}</ul></div>` : ''}
      <h2>Who's coming (${all.length})</h2>
      <p class="small muted">Green: all set · Amber: payment awaiting check · Red: still short of points</p>
      <div class="card"><ul class="plist">${people || '<li class="muted">Nobody yet</li>'}</ul></div>`;
  }

  // ----- Chip in -----
  function viewChip() {
    const p = person(me);
    const t = tally(p);
    const dpp = S.event.dollarsPerPoint;
    const pays = p.payments.map((x) => `<tr><td>${money(x.amount)}</td><td>${x.kind === 'meal' ? 'Meal' : 'Buy-in'}${x.note ? `<div class="small muted">${esc(x.note)}</div>` : ''}</td>
      <td>${x.confirmed ? '<span class="badge ok">confirmed</span>' : '<span class="badge pending">awaiting check</span>'}</td>
      <td>${x.confirmed ? '' : `<button class="btn sm ghost" data-act="cancelPay" data-id="${esc(x.id)}">Remove</button>`}</td></tr>`).join('');
    return `
      <h2>Your buy-in</h2>
      <div class="card stack">
        ${p.host ? `<p>You're a host, so there's nothing to pay. Thank you!</p>` :
          t.status === 'ok' ? `<p><b>You're all set.</b> ${fmtPts(t.earned)} points from jobs${t.paidOk ? ` plus ${money(t.paidOk)} chipped in` : ''}.</p>` :
          `<p>You need <b>${t.req} points</b> (${p.adults} adult${p.adults === 1 ? '' : 's'} × ${p.adults ? t.req / p.adults : 0}${p.firstTimer ? ', first-timer rate' : ''}). You have <b>${fmtPts(t.have)}</b>${t.paidWait ? `, plus ${money(t.paidWait)} awaiting check` : ''}.</p>
           ${t.shortPts > 0 ? `<p>Claim ${fmtPts(t.shortPts)} more points of jobs, or chip in <b>${money(t.shortDollars)}</b> to the host fund (${money(dpp)} per point). A mix works too.</p>` : ''}`}
      </div>
      <h2>How to pay</h2>
      <div class="card stack">
        ${S.payment.details ? `<div class="paybox">${esc(S.payment.details)}</div>` : `<p class="muted">The treasurer hasn't added payment details yet.</p>`}
        ${S.payment.mealCosts ? `<h3>Meal costs (separate from buy-in)</h3><div class="paybox">${esc(S.payment.mealCosts)}</div>` : ''}
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

  // ----- Organise -----
  function viewOrg() {
    const r = S.roles;
    let out = '';
    if (!r.admin || !r.treasurer) {
      out += `<h2>Unlock</h2><div class="card stack">
        ${!r.admin ? `<form class="row" data-form="adminLogin"><input name="c" type="password" placeholder="Organiser code" autocomplete="off" aria-label="Organiser code"><button class="btn primary" type="submit">Unlock</button></form>` : ''}
        ${!r.treasurer ? `<form class="row" data-form="treasLogin"><input name="c" type="password" placeholder="Treasurer code" autocomplete="off" aria-label="Treasurer code"><button class="btn primary" type="submit">Unlock</button></form>` : ''}
        <p class="small muted">Organisers edit jobs and the event. The treasurer manages payment details and confirms payments.</p>
      </div>`;
    }
    if (r.treasurer) out += viewTreasurer();
    if (r.admin) out += viewAdmin();
    if (r.admin || r.treasurer) out += `<p style="margin-top:20px"><button class="btn ghost full" data-act="lock">Lock organiser tools on this phone</button></p>`;
    return out;
  }

  function viewTreasurer() {
    const rows = [];
    for (const p of S.people) for (const x of p.payments) rows.push({ p, x });
    rows.sort((a, b) => Number(a.x.confirmed) - Number(b.x.confirmed) || b.x.at.localeCompare(a.x.at));
    const total = rows.filter((r) => r.x.confirmed).reduce((a, r) => a + r.x.amount, 0);
    return `
      <h2>Treasurer</h2>
      <form class="card stack" data-form="payInfo">
        <div class="field"><label for="pi-d">Payment details (PayID, BSB/account)</label>
          <textarea id="pi-d" name="details" maxlength="1000" placeholder="PayID: 0400 000 000 (Jane Smith)&#10;Reference: your name">${esc(S.payment.details)}</textarea></div>
        <div class="field"><label for="pi-m">Meal costs per head</label>
          <textarea id="pi-m" name="mealCosts" maxlength="1000" placeholder="Saturday asado: $35 per adult, pay Delia">${esc(S.payment.mealCosts)}</textarea></div>
        <button class="btn primary full" type="submit">Save payment info</button>
        <p class="small muted">Only people with the treasurer code can change this. Everyone with the event code can read it.</p>
      </form>
      <h3 style="margin:16px 0 8px">Payments (${money(total)} confirmed)</h3>
      <div class="card">${rows.length ? `<table class="mini"><tbody>${rows.map(({ p, x }) => `
        <tr><td>${esc(p.name)}<div class="small muted">${x.kind === 'meal' ? 'Meal' : 'Buy-in'}${x.note ? ' · ' + esc(x.note) : ''}</div></td><td>${money(x.amount)}</td>
        <td><button class="btn sm ${x.confirmed ? 'ghost' : 'primary'}" data-act="confirmPay" data-pid="${esc(p.id)}" data-id="${esc(x.id)}" data-v="${x.confirmed ? '0' : '1'}">${x.confirmed ? 'Undo' : 'Received'}</button></td></tr>`).join('')}
        </tbody></table>` : '<p class="muted">No payments recorded yet.</p>'}</div>`;
  }

  function viewAdmin() {
    const e = S.event;
    const short = S.people.map((p) => ({ p, t: tally(p) })).filter((x) => x.t.status !== 'ok');
    const pendingTasks = S.tasks.filter((t) => t.pending);
    const opt = (v, cur) => `<option value="${v}" ${Number(cur) === v ? 'selected' : ''}>${v}</option>`;
    const taskRow = (t) => `
      <details class="box">
        <summary>${esc(t.title)} <span class="muted small">· ${t.phase} · ${t.points} pts · ${t.claims.length}/${t.slots}</span>${t.pending ? ' <span class="badge pending">pending</span>' : ''}</summary>
        <form class="stack" data-form="editTask" data-id="${esc(t.id)}" style="margin-top:10px">
          <input name="title" type="text" maxlength="120" value="${esc(t.title)}" aria-label="Job title">
          <div class="grid2">
            <select name="phase" aria-label="When">${['Before', 'During', 'After'].map((x) => `<option ${x === t.phase ? 'selected' : ''}>${x}</option>`).join('')}</select>
            <select name="points" aria-label="Points">${[1, 2, 3, 4, 5, 6, 7, 8].map((v) => opt(v, t.points)).join('')}</select>
          </div>
          <label class="small">People needed <input name="slots" type="number" min="1" max="20" value="${t.slots}"></label>
          <div class="row wrap-row">
            <button class="btn primary sm" type="submit">${t.pending ? 'Approve and save' : 'Save'}</button>
            <button class="btn danger sm" type="button" data-act="delTask" data-id="${esc(t.id)}">Delete job</button>
          </div>
          ${t.claims.length ? `<div class="small"><b>Claimed by</b> (untick if it didn't get done)</div>
            ${t.claims.map((c) => { const p = person(c.personId); return `<label class="check"><input type="checkbox" data-act="notDone" data-tid="${esc(t.id)}" data-pid="${esc(c.personId)}" ${c.notDone ? '' : 'checked'}> ${esc(p ? p.name : '?')} did it</label>`; }).join(' ')}` : ''}
        </form>
      </details>`;
    return `
      <h2>Organiser</h2>
      ${pendingTasks.length ? `<h3 style="margin:8px 0">Jobs waiting for points (${pendingTasks.length})</h3>${pendingTasks.map(taskRow).join('')}` : ''}
      <h3 style="margin:16px 0 8px">Still short (${short.length})</h3>
      <div class="card">${short.length ? `<ul class="plist">${short.map(({ p, t }) => `<li><span class="dot ${t.status}"></span><span class="spacer">${esc(p.name)}</span><span class="small muted">${fmtPts(t.have)}/${t.req} pts</span></li>`).join('')}</ul>` : '<p class="muted">Everyone is set.</p>'}</div>
      <div class="row" style="margin-top:10px"><button class="btn full" data-act="csv">Download headcount (CSV)</button></div>

      <h3 style="margin:20px 0 8px">All jobs (${S.tasks.length})</h3>
      ${['Before', 'During', 'After'].map((ph) => S.tasks.filter((t) => t.phase === ph && !t.pending).map(taskRow).join('')).join('')}

      <h3 style="margin:20px 0 8px">Event settings</h3>
      <form class="card stack" data-form="event">
        <div class="field"><label for="e-n">Event name</label><input id="e-n" name="name" type="text" maxlength="80" value="${esc(e.name)}"></div>
        <div class="field"><label for="e-d">Dates</label><input id="e-d" name="dates" type="text" maxlength="80" value="${esc(e.dates)}"></div>
        <div class="field"><label for="e-l">Location</label><input id="e-l" name="location" type="text" maxlength="120" value="${esc(e.location)}"></div>
        <div class="field"><label for="e-w">WhatsApp group invite link</label><input id="e-w" name="whatsappUrl" type="url" placeholder="https://chat.whatsapp.com/…" value="${esc(e.whatsappUrl)}"></div>
        <div class="grid2">
          <div><label for="e-po">Points per adult (overnight)</label><input id="e-po" name="pointsOvernight" type="number" min="0" max="20" value="${e.pointsOvernight}"></div>
          <div><label for="e-pd">Points per adult (day visit)</label><input id="e-pd" name="pointsDay" type="number" min="0" max="20" value="${e.pointsDay}"></div>
        </div>
        <div class="field"><label for="e-pf">Points per adult for first-timers (set lower to go easy on newcomers)</label><input id="e-pf" name="pointsFirstTimer" type="number" min="0" max="20" value="${e.pointsFirstTimer ?? e.pointsOvernight}"></div>
        <div class="field"><label for="e-dp">Dollars per point</label><input id="e-dp" name="dollarsPerPoint" type="number" min="1" max="500" value="${e.dollarsPerPoint}"></div>
        <button class="btn primary full" type="submit">Save settings</button>
      </form>

      <h3 style="margin:20px 0 8px">People</h3>
      ${[...S.people].sort((a, b) => a.name.localeCompare(b.name)).map((p) => `
        <div class="card row"><span class="spacer">${esc(p.name)}</span>
          <label class="check small"><input type="checkbox" data-act="host" data-id="${esc(p.id)}" ${p.host ? 'checked' : ''}> Host</label>
          <button class="btn sm danger" data-act="removePerson" data-id="${esc(p.id)}">Remove</button></div>`).join('') || '<p class="muted">Nobody yet.</p>'}

      <h3 style="margin:20px 0 8px">Next event</h3>
      <div class="card stack">
        <p class="small">Clears the guest list, claims and payments, and keeps the job list and payment details. Download the CSV first if you want a record.</p>
        <button class="btn danger full" data-act="newEvent">Start a new event</button>
      </div>`;
  }

  // ---------- events ----------
  app.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const kind = f.dataset.form;
    const fd = new FormData(f);
    if (kind === 'gate') {
      code = String(fd.get('code') || '').trim();
      ls.set('code', code);
      screen = 'loading'; render(); load();
    } else if (kind === 'join') {
      const r = await act({ action: 'join', person: readRsvp(f) }, "You're on the list!");
      if (r?.personId) { me = r.personId; ls.set('me', me); screen = 'app'; tab = 'jobs'; ls.set('tab', tab); render(); }
    } else if (kind === 'rsvp') {
      act({ action: 'updatePerson', personId: me, person: readRsvp(f) }, 'Saved');
    } else if (kind === 'addTask') {
      const r = await act({ action: 'addTask', title: fd.get('title'), phase: fd.get('phase'), slots: fd.get('slots'), points: fd.get('points'), addedBy: person(me)?.name }, 'Job added');
      if (r) { phase = fd.get('phase'); ls.set('phase', phase); render(); }
    } else if (kind === 'pay') {
      act({ action: 'reportPayment', personId: me, amount: fd.get('amount'), kind: fd.get('kind'), note: fd.get('note') }, 'Recorded. The treasurer will confirm it.');
    } else if (kind === 'adminLogin' || kind === 'treasLogin') {
      const c = String(fd.get('c') || '').trim();
      const isAdmin = kind === 'adminLogin';
      const prev = isAdmin ? adminCode : treasurerCode;
      if (isAdmin) adminCode = c; else treasurerCode = c;
      try {
        const r = await api('POST', { action: 'checkRoles' });
        const ok = isAdmin ? r.roles.admin : r.roles.treasurer;
        if (!ok) throw new Error('That code is not right');
        ls.set(isAdmin ? 'admin' : 'treasurer', c);
        toast('Unlocked');
        await load();
      } catch (e) {
        if (isAdmin) adminCode = prev; else treasurerCode = prev;
        toast(e.message, true);
      }
    } else if (kind === 'payInfo') {
      act({ action: 'updatePaymentInfo', details: fd.get('details'), mealCosts: fd.get('mealCosts') }, 'Payment info saved');
    } else if (kind === 'editTask') {
      act({ action: 'editTask', taskId: f.dataset.id, title: fd.get('title'), phase: fd.get('phase'), points: fd.get('points'), slots: fd.get('slots'), pending: false }, 'Job saved');
    } else if (kind === 'event') {
      act({ action: 'updateEvent', event: Object.fromEntries(fd.entries()) }, 'Settings saved');
    }
  });

  app.addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-act]');
    if (!b || b.tagName === 'INPUT') return;
    const a = b.dataset.act;
    if (a === 'tab') { tab = b.dataset.tab; ls.set('tab', tab); window.scrollTo(0, 0); renderApp(); return; }
    if (a === 'phase') { phase = b.dataset.ph; ls.set('phase', phase); render(); return; }
    if (a === 'goJoin') { screen = 'join'; render(); return; }
    if (a === 'goWho') { screen = 'who'; render(); return; }
    if (a === 'pickMe') { me = b.dataset.id; ls.set('me', me); screen = 'app'; render(); return; }
    if (a === 'switchMe') { me = ''; ls.set('me', null); screen = 'who'; render(); return; }
    if (a === 'claim') { act({ action: 'claim', taskId: b.dataset.id, personId: me }, "Claimed. Thank you!"); return; }
    if (a === 'unclaim') { act({ action: 'unclaim', taskId: b.dataset.id, personId: me }, 'Dropped'); return; }
    if (a === 'share') { shareTask(b.dataset.id); return; }
    if (a === 'cancelPay') { act({ action: 'cancelPayment', personId: me, paymentId: b.dataset.id }, 'Removed'); return; }
    if (a === 'confirmPay') { act({ action: 'confirmPayment', personId: b.dataset.pid, paymentId: b.dataset.id, confirmed: b.dataset.v === '1' }, 'Updated'); return; }
    if (a === 'delTask') { if (confirmTwice(b, 'Tap again to delete')) act({ action: 'deleteTask', taskId: b.dataset.id }, 'Job deleted'); return; }
    if (a === 'removePerson') { if (confirmTwice(b, 'Tap again to remove')) act({ action: 'removePerson', personId: b.dataset.id }, 'Removed'); return; }
    if (a === 'newEvent') { if (confirmTwice(b, 'Tap again: this clears all RSVPs')) act({ action: 'newEvent' }, 'New event started'); return; }
    if (a === 'csv') { downloadCsv(); return; }
    if (a === 'lock') { adminCode = ''; treasurerCode = ''; ls.set('admin', null); ls.set('treasurer', null); load(); return; }
  });

  app.addEventListener('change', (ev) => {
    const b = ev.target;
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
    const text = mine
      ? `${p.name} is on "${t.title}" (${t.points} pts) for ${S.event.name}. Grab a job: ${location.origin}`
      : `Can anyone take "${t.title}" (${t.points} pts) for ${S.event.name}? ${location.origin}`;
    window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener');
  }

  function downloadCsv() {
    const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    const rows = [['Name', 'Adults', 'Kids', 'Fri', 'Sat', 'Diet', 'Sponsor', 'First timer', 'Points', 'Required', 'Buy-in confirmed', 'Buy-in awaiting', 'Jobs']];
    for (const p of S.people) {
      const t = tally(p);
      const jobs = S.tasks.filter((x) => x.claims.some((c) => c.personId === p.id && !c.notDone)).map((x) => x.title).join('; ');
      rows.push([p.name, p.adults, p.kids, p.nights.includes('Fri') ? 'Y' : '', p.nights.includes('Sat') ? 'Y' : '', p.diet, p.sponsor, p.firstTimer ? 'Y' : '', fmtPts(t.earned), t.req, t.paidOk, t.paidWait, jobs]);
    }
    const blob = new Blob([rows.map((r) => r.map(q).join(',')).join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'farmfest-headcount.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // Refresh when the page comes back into view, and every 30 s while open.
  document.addEventListener('visibilitychange', () => { if (!document.hidden && code && screen === 'app') load(); });
  setInterval(() => {
    const typing = document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    const openDetails = app.querySelector('details[open]');
    if (!document.hidden && code && screen === 'app' && !busy && !typing && !openDetails) load();
  }, 30000);

  // Allow ?code=FF27 links so the WhatsApp message can carry the code.
  const qp = new URLSearchParams(location.search).get('code');
  if (qp) { code = qp.trim(); ls.set('code', code); history.replaceState(null, '', location.pathname); }

  if (code) { render(); load(); } else { screen = 'gate'; render(); }
})();
