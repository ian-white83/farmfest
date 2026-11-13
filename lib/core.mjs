// Farm Fest core logic: state shape, seed data, permissions and mutations.
// Storage-agnostic: the Netlify function passes in a Netlify Blobs store.

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
  ['Bar host (one night)', 'During', 2, 2],
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
const NIGHTS = ['Fri', 'Sat'];

const id = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export function freshState(prev) {
  return {
    version: 1,
    event: {
      name: prev?.event?.name || 'Farm Fest April 2027',
      dates: prev?.event?.dates || 'April 2027 (dates TBC)',
      location: prev?.event?.location || "Paul's farm, Capertee",
      whatsappUrl: prev?.event?.whatsappUrl || '',
      pointsOvernight: prev?.event?.pointsOvernight ?? 3,
      pointsDay: prev?.event?.pointsDay ?? 2,
      pointsFirstTimer: prev?.event?.pointsFirstTimer ?? 3,
      dollarsPerPoint: prev?.event?.dollarsPerPoint ?? 20,
    },
    payment: { details: prev?.payment?.details || '', mealCosts: '' },
    people: [],
    tasks: SEED_TASKS.map(([title, phase, points, slots]) => ({
      id: id(), title, phase, points, slots, pending: false, addedBy: 'seed', claims: [],
    })),
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
const need = (roles, role) => {
  if (!roles[role]) throw new HttpError(403, role === 'admin' ? 'Organiser code needed' : 'Treasurer code needed');
};

function personFields(src, p = {}) {
  const nights = Array.isArray(src.nights) ? src.nights.filter((n) => NIGHTS.includes(n)) : p.nights || [];
  return {
    name: src.name !== undefined ? str(src.name, 60, true) : p.name,
    adults: src.adults !== undefined ? int(src.adults, 0, 10, 1) : p.adults ?? 1,
    kids: src.kids !== undefined ? int(src.kids, 0, 10, 0) : p.kids ?? 0,
    nights,
    diet: src.diet !== undefined ? str(src.diet, 120) : p.diet || '',
    sponsor: src.sponsor !== undefined ? str(src.sponsor, 60) : p.sponsor || '',
    firstTimer: src.firstTimer !== undefined ? !!src.firstTimer : !!p.firstTimer,
  };
}

// ---------- mutations ----------
// Each returns nothing and mutates s in place; throws HttpError on bad input.
export function applyAction(s, body, roles) {
  const a = body.action;
  switch (a) {
    case 'join': {
      const f = personFields(body.person || {});
      if (s.people.some((p) => p.name.toLowerCase() === f.name.toLowerCase()))
        throw new HttpError(409, 'That name is already on the list. Pick it instead, or add a surname.');
      if (s.people.length >= 300) throw new HttpError(400, 'The list is full');
      const p = { id: id(), ...f, host: false, payments: [], createdAt: new Date().toISOString() };
      s.people.push(p);
      return { personId: p.id };
    }
    case 'updatePerson': {
      const p = findPerson(s, body.personId);
      const f = personFields(body.person || {}, p);
      if (f.name.toLowerCase() !== p.name.toLowerCase() && s.people.some((x) => x.id !== p.id && x.name.toLowerCase() === f.name.toLowerCase()))
        throw new HttpError(409, 'Someone else already has that name');
      Object.assign(p, f);
      if (roles.admin && body.person?.host !== undefined) p.host = !!body.person.host;
      return {};
    }
    case 'removePerson': {
      need(roles, 'admin');
      const pid = body.personId;
      s.people = s.people.filter((p) => p.id !== pid);
      s.tasks.forEach((t) => { t.claims = t.claims.filter((c) => c.personId !== pid); });
      return {};
    }
    case 'claim': {
      const p = findPerson(s, body.personId);
      const t = findTask(s, body.taskId);
      if (t.claims.some((c) => c.personId === p.id)) return {};
      if (t.claims.length >= t.slots) throw new HttpError(409, 'All slots on that job are taken');
      t.claims.push({ personId: p.id, notDone: false, at: new Date().toISOString() });
      return {};
    }
    case 'unclaim': {
      const t = findTask(s, body.taskId);
      t.claims = t.claims.filter((c) => c.personId !== body.personId);
      return {};
    }
    case 'addTask': {
      const t = {
        id: id(),
        title: str(body.title, 120, true),
        phase: PHASES.includes(body.phase) ? body.phase : 'During',
        points: int(body.points, 1, 8, 2),
        slots: int(body.slots, 1, 20, 1),
        pending: !roles.admin,
        addedBy: str(body.addedBy, 60) || 'organiser',
        claims: [],
      };
      if (s.tasks.length >= 200) throw new HttpError(400, 'Too many jobs');
      s.tasks.push(t);
      return { taskId: t.id };
    }
    case 'editTask': {
      need(roles, 'admin');
      const t = findTask(s, body.taskId);
      if (body.title !== undefined) t.title = str(body.title, 120, true);
      if (body.phase !== undefined && PHASES.includes(body.phase)) t.phase = body.phase;
      if (body.points !== undefined) t.points = int(body.points, 1, 8, t.points);
      if (body.slots !== undefined) t.slots = Math.max(int(body.slots, 1, 20, t.slots), 1);
      if (body.pending !== undefined) t.pending = !!body.pending;
      return {};
    }
    case 'deleteTask': {
      need(roles, 'admin');
      s.tasks = s.tasks.filter((t) => t.id !== body.taskId);
      return {};
    }
    case 'setNotDone': {
      need(roles, 'admin');
      const t = findTask(s, body.taskId);
      const c = t.claims.find((x) => x.personId === body.personId);
      if (!c) throw new HttpError(404, 'Claim not found');
      c.notDone = !!body.notDone;
      return {};
    }
    case 'updateEvent': {
      need(roles, 'admin');
      const e = body.event || {};
      const ev = s.event;
      if (e.name !== undefined) ev.name = str(e.name, 80, true);
      if (e.dates !== undefined) ev.dates = str(e.dates, 80);
      if (e.location !== undefined) ev.location = str(e.location, 120);
      if (e.whatsappUrl !== undefined) {
        const u = str(e.whatsappUrl, 300);
        if (u && !/^https:\/\/(chat\.whatsapp\.com|wa\.me|whatsapp\.com)\//.test(u))
          throw new HttpError(400, 'Use a WhatsApp invite link (https://chat.whatsapp.com/...)');
        ev.whatsappUrl = u;
      }
      if (e.pointsOvernight !== undefined) ev.pointsOvernight = int(e.pointsOvernight, 0, 20, 3);
      if (e.pointsDay !== undefined) ev.pointsDay = int(e.pointsDay, 0, 20, 2);
      if (e.pointsFirstTimer !== undefined) ev.pointsFirstTimer = int(e.pointsFirstTimer, 0, 20, 3);
      if (e.dollarsPerPoint !== undefined) ev.dollarsPerPoint = int(e.dollarsPerPoint, 1, 500, 20);
      return {};
    }
    case 'newEvent': {
      need(roles, 'admin');
      const keepTasks = s.tasks.map((t) => ({ ...t, claims: [] }));
      const next = freshState(s);
      if (body.keepTasks !== false) next.tasks = keepTasks;
      next.payment.details = s.payment.details;
      Object.keys(s).forEach((k) => delete s[k]);
      Object.assign(s, next);
      return {};
    }
    case 'reportPayment': {
      const p = findPerson(s, body.personId);
      if (p.payments.length >= 20) throw new HttpError(400, 'Too many payments recorded');
      p.payments.push({ id: id(), kind: body.kind === 'meal' ? 'meal' : 'buyin', amount: money(body.amount), note: str(body.note, 120), at: new Date().toISOString(), confirmed: false });
      return {};
    }
    case 'cancelPayment': {
      const p = findPerson(s, body.personId);
      const pay = p.payments.find((x) => x.id === body.paymentId);
      if (pay?.confirmed && !roles.treasurer) throw new HttpError(403, 'Confirmed payments can only be removed by the treasurer');
      p.payments = p.payments.filter((x) => x.id !== body.paymentId);
      return {};
    }
    case 'confirmPayment': {
      need(roles, 'treasurer');
      const p = findPerson(s, body.personId);
      const pay = p.payments.find((x) => x.id === body.paymentId);
      if (!pay) throw new HttpError(404, 'Payment not found');
      pay.confirmed = !!body.confirmed;
      return {};
    }
    case 'updatePaymentInfo': {
      need(roles, 'treasurer');
      if (body.details !== undefined) s.payment.details = str(body.details, 1000);
      if (body.mealCosts !== undefined) s.payment.mealCosts = str(body.mealCosts, 1000);
      return {};
    }
    default:
      throw new HttpError(400, 'Unknown action');
  }
}

// What a guest is allowed to see. Payment details are only sent once the
// event code is verified (the whole API is behind it).
export function publicView(s, roles) {
  return { ...s, roles: { admin: !!roles.admin, treasurer: !!roles.treasurer } };
}
