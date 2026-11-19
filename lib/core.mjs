// Farm Fest core logic: state shape, migrations, access rules and mutations.
// Storage-agnostic: the Netlify function passes in a Netlify Blobs store.
//
// State (version 2) supports several events running at once:
//   events[]  each with its own code, dates, points rules and meal costs
//   tasks[]   eventId is an event id, or 'all' for jobs shared by every event
//   people[]  one record per person/household; rsvps[eventId] says which events
//             they're coming to. Points are pooled per person: everything they
//             claim counts toward the sum of what each of their events requires.

export const STATE_KEY = 'state';

export const SEED_TASKS = [
  ['Lead cook, Friday dinner (plan, shop, cook for the group)', 'During', 8, 1],
  ['Lead cook, Saturday dinner', 'During', 8, 1],
  ['Firewood and camp clearing working bee', 'Before', 5, 2],
  ['Facility repair day (toilets, slip and slide)', 'Before', 5, 2],
  ['Lead, Sunday breakfast', 'During', 5, 1],
  ['Event captain: date poll, reminders, chase the stragglers', 'Before', 5, 1],
  ['Helper cook, Friday or Saturday dinner', 'During', 3, 4],
  ['Drinks run: keg, spirits, mixers, ice (repaid from host fund)', 'Before', 3, 1],
  ['Pack down and clean the shed and bar', 'After', 3, 3],
  ['Salad or bread for a dinner', 'During', 2, 3],
  ['Helper, Sunday breakfast', 'During', 2, 2],
  ['Morning coffee (one morning)', 'During', 2, 2],
  ['Fire keeper (one night)', 'During', 2, 2],
  ['Bar host (one night)', 'During', 2, 4],
  ['Dishes after a meal', 'During', 2, 4],
  ['Drive a 4WD on the day trip', 'During', 2, 3],
  ["Kids' activity session", 'During', 2, 2],
  ['Rubbish run to the tip (a full car load)', 'After', 2, 3],
  ['Camp supplies: toilet paper, hand wash, bin bags, gas', 'Before', 2, 1],
  ['Logo or merch', 'Before', 2, 1],
  ['Charcoal and ice', 'Before', 1, 1],
  ['Photo album, lost and found', 'After', 1, 2],
];

export const PHASES = ['Before', 'During', 'After'];
// Times of day a "During" job can be pinned to, so e.g. Friday dinner jobs sit together.
export const SLOTS = ['Breakfast', 'Morning', 'Lunch', 'Afternoon', 'Dinner', 'Evening'];
const MAX_DAYS = 7;
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const isoDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !isNaN(Date.parse(v + 'T00:00:00Z')) ? String(v) : '');
const dayMs = 86400000;

// The days of an event, from its start and end dates (empty when no dates are set).
export function eventDays(ev) {
  if (!ev.startDate) return [];
  const a = Date.parse(ev.startDate + 'T00:00:00Z');
  const b = Date.parse((ev.endDate || ev.startDate) + 'T00:00:00Z');
  const out = [];
  for (let t = a, i = 0; t <= b && i < MAX_DAYS; t += dayMs, i++) out.push(new Date(t));
  return out;
}

// "Fri 2 to Sun 4 Apr 2027"
export function formatRange(start, end) {
  const a = new Date(start + 'T00:00:00Z'), b = new Date((end || start) + 'T00:00:00Z');
  const d = (x, withMonth, withYear) => `${DOW[x.getUTCDay()]} ${x.getUTCDate()}${withMonth ? ' ' + MON[x.getUTCMonth()] : ''}${withYear ? ' ' + x.getUTCFullYear() : ''}`;
  if (+a === +b) return d(a, true, true);
  const sameMonth = a.getUTCMonth() === b.getUTCMonth() && a.getUTCFullYear() === b.getUTCFullYear();
  return `${d(a, !sameMonth, a.getUTCFullYear() !== b.getUTCFullYear())} to ${d(b, true, true)}`;
}
const NIGHTS = ['Fri', 'Sat'];
export const ALL = 'all';

const id = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const normCode = (c) => String(c ?? '').trim().toUpperCase();

function newEvent(fields = {}) {
  return {
    id: fields.id || id(),
    code: normCode(fields.code) || 'FF' + Math.floor(Math.random() * 90 + 10),
    name: fields.name || 'Farm Fest',
    dates: fields.dates || 'Dates TBC',
    location: fields.location ?? "Paul's farm, Capertee",
    whatsappUrl: fields.whatsappUrl || '',
    pointsOvernight: fields.pointsOvernight ?? 3,
    pointsDay: fields.pointsDay ?? 2,
    pointsFirstTimer: fields.pointsFirstTimer ?? 3,
    guestTasks: fields.guestTasks ?? true, // attendees can add jobs (organisers always can)
    mealCosts: fields.mealCosts || '',
    startDate: fields.startDate || '',
    endDate: fields.endDate || '',
    runSheet: fields.runSheet || {}, // { dayIndex: "6pm Dinner\n8pm Fire" }
  };
}

// Jobs an organiser hands out to someone trusted rather than first-come claiming.
const ASSIGN_ONLY = new Set(['Bar host (one night)']);
// Seeded jobs that belong to a particular day (0 = first day, usually Friday).
const SEED_WHEN = {
  'Lead cook, Friday dinner (plan, shop, cook for the group)': [0, 'Dinner'],
  'Lead cook, Saturday dinner': [1, 'Dinner'],
  'Lead, Sunday breakfast': [2, 'Breakfast'],
  'Helper, Sunday breakfast': [2, 'Breakfast'],
};
const seedTasks = (eventId) =>
  SEED_TASKS.map(([title, phase, points, slots]) => ({
    id: id(), eventId, title, phase, points, slots, pending: false, assignOnly: ASSIGN_ONLY.has(title), addedBy: 'seed', claims: [],
    day: SEED_WHEN[title]?.[0] ?? null, slot: SEED_WHEN[title]?.[1] || '',
  }));

export function freshState(env = {}) {
  const ev = newEvent({ id: 'e1', code: env.EVENT_CODE || 'FF27', name: 'Farm Fest April 2027', dates: 'April 2027 (dates TBC)' });
  return { version: 2, settings: { dollarsPerPoint: 20 }, payment: { details: '' }, events: [ev], people: [], tasks: seedTasks(ev.id), shopping: [] };
}

// v1 (single event) -> v2. Everything that existed belonged to the one event.
export function migrate(s, env = {}) {
  if (!s) return s;
  if (s.version === 2) {
    if (!s.shopping) s.shopping = [];
    s.events.forEach((e) => { e.guestTasks ??= true; e.startDate ??= ''; e.endDate ??= ''; e.runSheet ??= {}; });
    s.tasks.forEach((t) => { t.day ??= SEED_WHEN[t.title]?.[0] ?? null; t.slot ??= SEED_WHEN[t.title]?.[1] || ''; });
    return s;
  }
  const old = s.event || {};
  const ev = newEvent({ ...old, id: 'e1', code: env.EVENT_CODE || 'FF27', mealCosts: s.payment?.mealCosts || '' });
  return {
    version: 2,
    settings: { dollarsPerPoint: old.dollarsPerPoint ?? 20 },
    payment: { details: s.payment?.details || '' },
    events: [ev],
    people: (s.people || []).map((p) => ({
      id: p.id, name: p.name, sponsor: p.sponsor || '', firstTimer: !!p.firstTimer, host: !!p.host,
      payments: (p.payments || []).map((x) => ({ kind: 'buyin', ...x })), createdAt: p.createdAt,
      rsvps: { [ev.id]: { adults: p.adults ?? 1, kids: p.kids ?? 0, nights: p.nights || [], diet: p.diet || '' } },
    })),
    tasks: (s.tasks || []).map((t) => ({ ...t, eventId: ev.id })),
    shopping: [],
  };
}

// ---------- validation helpers ----------
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const str = (v, max = 200, required = false) => {
  const s = (v ?? '').toString().trim().slice(0, max);
  if (required && !s) throw new HttpError(400, 'Missing a required field');
  return s;
};
const int = (v, min, max, dflt) => {
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.min(max, Math.max(min, n));
};
const money = (v) => {
  const n = Math.round(Number(v) * 100) / 100;
  if (!Number.isFinite(n) || n <= 0 || n > 10000) throw new HttpError(400, 'Enter an amount between $1 and $10,000');
  return n;
};
const findPerson = (s, pid) => {
  const p = s.people.find((x) => x.id === pid);
  if (!p) throw new HttpError(404, 'Person not found. Pick your name again.');
  return p;
};
const findTask = (s, tid) => {
  const t = s.tasks.find((x) => x.id === tid);
  if (!t) throw new HttpError(404, 'That job no longer exists');
  return t;
};
const findEvent = (s, eid) => {
  const e = s.events.find((x) => x.id === eid);
  if (!e) throw new HttpError(404, 'That event no longer exists');
  return e;
};
const need = (access, role) => {
  if (!access[role]) throw new HttpError(403, role === 'admin' ? 'Organiser code needed' : 'Treasurer code needed');
};
const canSeeEvent = (access, eid) => access.all || access.eventIds.includes(eid);
const canSeeTask = (access, t) => t.eventId === ALL || canSeeEvent(access, t.eventId);
const findItem = (s, access, iid) => {
  const it = s.shopping.find((x) => x.id === iid);
  if (!it || !(it.eventId === ALL || canSeeEvent(access, it.eventId))) throw new HttpError(404, 'That item is no longer on the list');
  return it;
};
const needEvent = (s, access, eid) => {
  const e = findEvent(s, eid);
  if (!canSeeEvent(access, eid)) throw new HttpError(403, "You need that event's code first");
  return e;
};

function rsvpFields(src = {}, prev = {}) {
  return {
    adults: src.adults !== undefined ? int(src.adults, 0, 10, 1) : prev.adults ?? 1,
    kids: src.kids !== undefined ? int(src.kids, 0, 10, 0) : prev.kids ?? 0,
    nights: Array.isArray(src.nights) ? src.nights.filter((n) => NIGHTS.includes(n)) : prev.nights || [],
    diet: src.diet !== undefined ? str(src.diet, 120) : prev.diet || '',
  };
}

function eventFields(s, src, ev, isNew) {
  if (src.name !== undefined || isNew) ev.name = str(src.name, 80, true);
  if (src.dates !== undefined) ev.dates = str(src.dates, 80);
  if (src.startDate !== undefined || src.endDate !== undefined) {
    const a = isoDate(src.startDate ?? ev.startDate);
    let b = isoDate(src.endDate ?? ev.endDate) || a;
    if (!a && b) throw new HttpError(400, 'Pick a start date too');
    if (a && b < a) throw new HttpError(400, 'The end date is before the start date');
    if (a && (Date.parse(b) - Date.parse(a)) / dayMs >= MAX_DAYS) throw new HttpError(400, `An event can run for up to ${MAX_DAYS} days`);
    ev.startDate = a; ev.endDate = a ? b : '';
    ev.dates = a ? formatRange(a, b) : (src.dates !== undefined ? ev.dates : 'Dates TBC');
  }
  if (src.location !== undefined) ev.location = str(src.location, 120);
  if (src.code !== undefined || isNew) {
    const c = normCode(src.code);
    if (!/^[A-Z0-9-]{3,20}$/.test(c)) throw new HttpError(400, 'Event code: 3 to 20 letters or numbers');
    if (s.events.some((x) => x !== ev && x.code === c)) throw new HttpError(409, 'Another event already uses that code');
    ev.code = c;
  }
  if (src.whatsappUrl !== undefined) {
    const u = str(src.whatsappUrl, 300);
    if (u && !/^https:\/\/(chat\.whatsapp\.com|wa\.me|whatsapp\.com)\//.test(u))
      throw new HttpError(400, 'Use a WhatsApp invite link (https://chat.whatsapp.com/...)');
    ev.whatsappUrl = u;
  }
  if (src.pointsOvernight !== undefined) ev.pointsOvernight = int(src.pointsOvernight, 0, 20, 3);
  if (src.pointsDay !== undefined) ev.pointsDay = int(src.pointsDay, 0, 20, 2);
  if (src.pointsFirstTimer !== undefined) ev.pointsFirstTimer = int(src.pointsFirstTimer, 0, 20, 3);
  if (src.guestTasks !== undefined) ev.guestTasks = src.guestTasks === true || src.guestTasks === 'on';
}

// Which day and time of day a "During" job is for. Only event-specific jobs can have a day.
function taskWhen(s, t, body) {
  if (body.day !== undefined) t.day = body.day === '' || body.day === null ? null : int(body.day, 0, MAX_DAYS - 1, 0);
  if (body.slot !== undefined) t.slot = SLOTS.includes(body.slot) ? body.slot : '';
  if (t.phase !== 'During') { t.day = null; t.slot = ''; }
  if (t.eventId === ALL) t.day = null;
  if (t.day !== null) {
    const ev = s.events.find((e) => e.id === t.eventId);
    if (!ev || t.day >= eventDays(ev).length) t.day = null;
  }
}

// ---------- points ----------
export function summarise(s, p) {
  let earned = 0, pending = 0, req = 0;
  for (const t of s.tasks) {
    const c = t.claims.find((x) => x.personId === p.id);
    if (!c || c.notDone) continue;
    if (t.pending) pending += t.points; else earned += t.points;
  }
  if (!p.host) {
    for (const [eid, r] of Object.entries(p.rsvps || {})) {
      const ev = s.events.find((e) => e.id === eid);
      if (!ev) continue;
      let per = r.nights.length ? ev.pointsOvernight : ev.pointsDay;
      if (p.firstTimer) per = Math.min(per, ev.pointsFirstTimer ?? per);
      req += Math.max(r.adults, 0) * per;
    }
  }
  const dpp = s.settings.dollarsPerPoint || 20;
  const buy = (p.payments || []).filter((x) => x.kind !== 'meal');
  const paidOk = buy.filter((x) => x.confirmed).reduce((a, x) => a + x.amount, 0);
  const paidWait = buy.filter((x) => !x.confirmed).reduce((a, x) => a + x.amount, 0);
  const have = earned + paidOk / dpp;
  const status = req === 0 || have >= req ? 'ok' : have + paidWait / dpp >= req ? 'warn' : 'bad';
  const shortPts = Math.max(0, req - have - paidWait / dpp);
  return { earned, pending, req, paidOk, paidWait, have, status, shortPts, shortDollars: Math.ceil(shortPts * dpp) };
}

// ---------- mutations ----------
export function applyAction(s, body, access) {
  switch (body.action) {
    case 'join': {
      const ev = needEvent(s, access, body.eventId);
      const name = str(body.person?.name, 60, true);
      if (s.people.some((p) => p.name.toLowerCase() === name.toLowerCase()))
        throw new HttpError(409, "That name is already taken. If it's you, add the code for your other event, or add a surname.");
      if (s.people.length >= 400) throw new HttpError(400, 'The list is full');
      const p = {
        id: id(), name, sponsor: str(body.person?.sponsor, 60), firstTimer: !!body.person?.firstTimer, host: false,
        payments: [], createdAt: new Date().toISOString(), rsvps: { [ev.id]: rsvpFields(body.rsvp) },
      };
      s.people.push(p);
      return { personId: p.id };
    }
    case 'updatePerson': {
      const p = findPerson(s, body.personId);
      const src = body.person || {};
      if (src.name !== undefined) {
        const n = str(src.name, 60, true);
        if (s.people.some((x) => x.id !== p.id && x.name.toLowerCase() === n.toLowerCase())) throw new HttpError(409, 'Someone else already has that name');
        p.name = n;
      }
      if (src.sponsor !== undefined) p.sponsor = str(src.sponsor, 60);
      if (src.firstTimer !== undefined) p.firstTimer = !!src.firstTimer;
      if (src.host !== undefined) { need(access, 'admin'); p.host = !!src.host; }
      return {};
    }
    case 'setRsvp': {
      const p = findPerson(s, body.personId);
      const ev = needEvent(s, access, body.eventId);
      if (body.rsvp === null) delete p.rsvps[ev.id];
      else p.rsvps[ev.id] = rsvpFields(body.rsvp, p.rsvps[ev.id]);
      return {};
    }
    case 'removePerson': {
      need(access, 'admin');
      s.people = s.people.filter((p) => p.id !== body.personId);
      s.tasks.forEach((t) => { t.claims = t.claims.filter((c) => c.personId !== body.personId); });
      return {};
    }
    case 'claim': {
      const p = findPerson(s, body.personId);
      const t = findTask(s, body.taskId);
      if (!canSeeTask(access, t)) throw new HttpError(403, "You need that event's code first");
      if (t.claims.some((c) => c.personId === p.id)) return {};
      if (t.assignOnly && !access.admin) throw new HttpError(403, 'An organiser assigns this job');
      if (t.claims.length >= t.slots) throw new HttpError(409, 'All slots on that job are taken');
      t.claims.push({ personId: p.id, notDone: false, at: new Date().toISOString() });
      return {};
    }
    case 'assign': {
      // Organisers can assign one person (personId) or several at once (personIds).
      need(access, 'admin');
      const t = findTask(s, body.taskId);
      const ids = [...new Set([].concat(body.personIds || [], body.personId || []).map(String))].slice(0, 20);
      if (!ids.length) throw new HttpError(400, 'Pick someone to assign');
      const people = ids.map((pid) => findPerson(s, pid)).filter((p) => !t.claims.some((c) => c.personId === p.id));
      const room = t.slots - t.claims.length;
      if (people.length > room) {
        throw new HttpError(409, room > 0
          ? `Only ${room} spot${room === 1 ? '' : 's'} left on that job. Pick fewer people or raise "People needed".`
          : 'All slots are taken. Remove someone or add a slot first.');
      }
      const at = new Date().toISOString();
      people.forEach((p) => t.claims.push({ personId: p.id, notDone: false, assigned: true, at }));
      return { assigned: people.length };
    }
    case 'unclaim': {
      const t = findTask(s, body.taskId);
      t.claims = t.claims.filter((c) => c.personId !== body.personId);
      return {};
    }
    case 'addTask': {
      const eventId = body.eventId === ALL ? ALL : needEvent(s, access, body.eventId).id;
      if (!access.admin) {
        // A shared job needs every event the attendee holds to allow attendee jobs.
        const evs = eventId === ALL ? s.events.filter((e) => access.eventIds.includes(e.id)) : [findEvent(s, eventId)];
        if (evs.some((e) => e.guestTasks === false)) throw new HttpError(403, 'Only organisers can add jobs to this event');
      }
      if (s.tasks.length >= 400) throw new HttpError(400, 'Too many jobs');
      const t = {
        id: id(), eventId,
        title: str(body.title, 120, true),
        phase: PHASES.includes(body.phase) ? body.phase : 'During',
        points: int(body.points, 1, 8, 2),
        slots: int(body.slots, 1, 20, 1),
        pending: !access.admin,
        assignOnly: !!(access.admin && body.assignOnly),
        addedBy: str(body.addedBy, 60) || 'organiser',
        claims: [],
        day: null, slot: '',
      };
      taskWhen(s, t, body);
      s.tasks.push(t);
      return { taskId: t.id };
    }
    case 'editTask': {
      need(access, 'admin');
      const t = findTask(s, body.taskId);
      if (body.title !== undefined) t.title = str(body.title, 120, true);
      if (body.phase !== undefined && PHASES.includes(body.phase)) t.phase = body.phase;
      if (body.points !== undefined) t.points = int(body.points, 1, 8, t.points);
      if (body.slots !== undefined) t.slots = int(body.slots, 1, 20, t.slots);
      if (body.pending !== undefined) t.pending = !!body.pending;
      if (body.assignOnly !== undefined) t.assignOnly = !!body.assignOnly;
      if (body.eventId !== undefined) t.eventId = body.eventId === ALL ? ALL : findEvent(s, body.eventId).id;
      taskWhen(s, t, body);
      return {};
    }
    case 'deleteTask': {
      need(access, 'admin');
      s.tasks = s.tasks.filter((t) => t.id !== body.taskId);
      return {};
    }
    case 'setNotDone': {
      need(access, 'admin');
      const c = findTask(s, body.taskId).claims.find((x) => x.personId === body.personId);
      if (!c) throw new HttpError(404, 'Claim not found');
      c.notDone = !!body.notDone;
      return {};
    }
    case 'addEvent': {
      need(access, 'admin');
      if (s.events.length >= 10) throw new HttpError(400, 'Ten events at once is the limit');
      const ev = newEvent();
      eventFields(s, body.event || {}, ev, true);
      s.events.push(ev);
      // Start the new event with a copy of another event's jobs (unclaimed), or the standard list.
      const from = body.copyFrom && s.events.find((e) => e.id === body.copyFrom);
      const tasks = from
        ? s.tasks.filter((t) => t.eventId === from.id).map((t) => ({ ...t, id: id(), eventId: ev.id, claims: [], pending: false }))
        : body.copyFrom === 'none' ? [] : seedTasks(ev.id);
      s.tasks.push(...tasks);
      return { eventId: ev.id };
    }
    case 'setRunSheet': {
      need(access, 'admin');
      const ev = findEvent(s, body.eventId);
      const day = int(body.day, 0, MAX_DAYS - 1, 0);
      const text = String(body.text ?? '').replace(/\r/g, '').trim().slice(0, 2000);
      if (text) ev.runSheet[day] = text; else delete ev.runSheet[day];
      return {};
    }
    case 'updateEvent': {
      need(access, 'admin');
      eventFields(s, body.event || {}, findEvent(s, body.eventId), false);
      return {};
    }
    case 'resetEvent': {
      need(access, 'admin');
      const ev = findEvent(s, body.eventId);
      s.people.forEach((p) => { delete p.rsvps[ev.id]; });
      s.tasks.filter((t) => t.eventId === ev.id).forEach((t) => { t.claims = []; });
      s.shopping = s.shopping.filter((x) => x.eventId !== ev.id);
      return {};
    }
    case 'deleteEvent': {
      need(access, 'admin');
      const ev = findEvent(s, body.eventId);
      if (s.events.length === 1) throw new HttpError(400, "You can't delete the only event. Reset it instead.");
      s.events = s.events.filter((e) => e.id !== ev.id);
      s.tasks = s.tasks.filter((t) => t.eventId !== ev.id);
      s.shopping = s.shopping.filter((x) => x.eventId !== ev.id);
      s.people.forEach((p) => { delete p.rsvps[ev.id]; });
      return {};
    }
    // ----- shopping list -----
    case 'addItem': {
      const eventId = body.eventId === ALL ? ALL : needEvent(s, access, body.eventId).id;
      if (s.shopping.length >= 400) throw new HttpError(400, 'The shopping list is full');
      const item = {
        id: id(), eventId, name: str(body.name, 80, true), qty: str(body.qty, 30), note: str(body.note, 120),
        addedBy: str(body.addedBy, 60), byId: str(body.personId, 40), claimedBy: null, got: false, at: new Date().toISOString(),
      };
      s.shopping.push(item);
      return { itemId: item.id };
    }
    case 'claimItem': {
      const p = findPerson(s, body.personId);
      const item = findItem(s, access, body.itemId);
      if (item.claimedBy && item.claimedBy !== p.id) throw new HttpError(409, 'Someone is already grabbing that');
      item.claimedBy = p.id;
      return {};
    }
    case 'unclaimItem': {
      const item = findItem(s, access, body.itemId);
      if (item.claimedBy === body.personId || access.admin) { item.claimedBy = null; item.got = false; }
      return {};
    }
    case 'setItemGot': {
      const item = findItem(s, access, body.itemId);
      if (!access.admin && item.claimedBy !== body.personId) throw new HttpError(403, 'Only the person grabbing it can tick it off');
      item.got = !!body.got;
      return {};
    }
    case 'deleteItem': {
      const item = findItem(s, access, body.itemId);
      if (!access.admin && !(item.byId && item.byId === body.personId && !item.claimedBy))
        throw new HttpError(403, 'Only organisers, or whoever added it before anyone claims it, can remove it');
      s.shopping = s.shopping.filter((x) => x.id !== item.id);
      return {};
    }
    case 'updateSettings': {
      need(access, 'admin');
      if (body.dollarsPerPoint !== undefined) s.settings.dollarsPerPoint = int(body.dollarsPerPoint, 1, 500, 20);
      return {};
    }
    case 'reportPayment': {
      const p = findPerson(s, body.personId);
      if (p.payments.length >= 30) throw new HttpError(400, 'Too many payments recorded');
      p.payments.push({ id: id(), kind: body.kind === 'meal' ? 'meal' : 'buyin', amount: money(body.amount), note: str(body.note, 120), at: new Date().toISOString(), confirmed: false });
      return {};
    }
    case 'cancelPayment': {
      const p = findPerson(s, body.personId);
      const pay = p.payments.find((x) => x.id === body.paymentId);
      if (pay?.confirmed && !access.treasurer) throw new HttpError(403, 'Confirmed payments can only be removed by the treasurer');
      p.payments = p.payments.filter((x) => x.id !== body.paymentId);
      return {};
    }
    case 'confirmPayment': {
      need(access, 'treasurer');
      const pay = findPerson(s, body.personId).payments.find((x) => x.id === body.paymentId);
      if (!pay) throw new HttpError(404, 'Payment not found');
      pay.confirmed = !!body.confirmed;
      return {};
    }
    case 'updatePaymentInfo': {
      need(access, 'treasurer');
      if (body.details !== undefined) s.payment.details = str(body.details, 1000);
      if (body.mealCosts && typeof body.mealCosts === 'object') {
        for (const [eid, v] of Object.entries(body.mealCosts)) {
          const ev = s.events.find((e) => e.id === eid);
          if (ev) ev.mealCosts = str(v, 1000);
        }
      }
      return {};
    }
    default:
      throw new HttpError(400, 'Unknown action');
  }
}

// ---------- access ----------
// Which events a request can see: those whose code it sent, or all of them for
// organisers and the treasurer.
export function accessFor(s, { codes = [], admin = false, treasurer = false }) {
  const wanted = new Set(codes.map(normCode).filter(Boolean));
  const matched = s.events.filter((e) => wanted.has(e.code));
  const all = admin || treasurer;
  return { admin, treasurer, all, eventIds: all ? s.events.map((e) => e.id) : matched.map((e) => e.id), matchedCodes: matched.map((e) => e.code) };
}

// What the browser receives: only the events it may see, jobs for those events
// plus shared jobs, people coming to those events (and the viewer), and
// payments only for the viewer unless they're the treasurer.
export function viewFor(s, access, viewerId) {
  const visible = new Set(access.eventIds);
  // Guests only get back the codes they already entered.
  const events = s.events.filter((e) => visible.has(e.id)).map((e) => (access.admin || access.matchedCodes.includes(e.code) ? { ...e } : { ...e, code: undefined }));
  const people = s.people
    .filter((p) => p.id === viewerId || access.all || Object.keys(p.rsvps).some((eid) => visible.has(eid)))
    .map((p) => ({
      id: p.id, name: p.name, sponsor: p.sponsor, firstTimer: p.firstTimer, host: p.host,
      rsvps: Object.fromEntries(Object.entries(p.rsvps).filter(([eid]) => visible.has(eid))),
      payments: access.treasurer || p.id === viewerId ? p.payments : [],
      summary: summarise(s, p),
    }));
  const known = new Set(people.map((p) => p.id));
  const tasks = s.tasks
    .filter((t) => t.eventId === ALL || visible.has(t.eventId))
    .map((t) => ({ ...t, claims: t.claims.map((c) => (known.has(c.personId) ? c : { ...c, personId: null })) }));
  const shopping = (s.shopping || [])
    .filter((x) => x.eventId === ALL || visible.has(x.eventId))
    .map((x) => ({ ...x, claimedBy: x.claimedBy && !known.has(x.claimedBy) ? 'someone' : x.claimedBy }));
  return {
    version: s.version, settings: s.settings, payment: s.payment, events, people, tasks, shopping,
    roles: { admin: access.admin, treasurer: access.treasurer },
    matchedCodes: access.matchedCodes,
  };
}
