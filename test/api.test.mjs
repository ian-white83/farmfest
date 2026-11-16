import assert from 'node:assert/strict';
import { handle } from '../lib/handler.mjs';
import { localStore, memoryStore } from './local-store.mjs';

const env = { EVENT_CODE: 'FF27', ADMIN_CODE: 'ORG', TREASURER_CODE: 'CASH' };
const { store: fileStore, stop } = await localStore();
let store = fileStore;

async function call(body, headers = {}) {
  const h = { 'x-event-codes': 'ff27', 'content-type': 'application/json', ...headers };
  const req = new Request('http://x/api', body ? { method: 'POST', headers: h, body: JSON.stringify(body) } : { headers: h });
  const res = await handle(req, store, env);
  return { status: res.status, data: await res.json() };
}
const admin = { 'x-admin-code': 'ORG' };
const treas = { 'x-treasurer-code': 'CASH' };
const both = { 'x-event-codes': 'FF27,WINTER' };
const winterOnly = { 'x-event-codes': 'winter' };
let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log('ok -', name); };

try {
  await t('wrong event code is rejected', async () => {
    assert.equal((await call(null, { 'x-event-codes': 'nope' })).status, 401);
  });

  let e1, e2;
  await t('fresh state has one event (code from EVENT_CODE) with 22 jobs', async () => {
    const r = await call();
    assert.equal(r.status, 200);
    assert.equal(r.data.events.length, 1);
    e1 = r.data.events[0].id;
    assert.equal(r.data.events[0].code, 'FF27', 'guests see the code they entered');
    assert.equal(r.data.tasks.length, 22);
  });

  await t('organiser code alone sees everything, including codes', async () => {
    const r = await call(null, { 'x-event-codes': '', ...admin });
    assert.equal(r.status, 200);
    assert.equal(r.data.events[0].code, 'FF27');
  });

  await t('organiser adds a second event with its own code and a copy of the jobs', async () => {
    const bad = await call({ action: 'addEvent', event: { name: 'Winter Fest', code: 'ff27' } }, admin);
    assert.equal(bad.status, 409, 'codes must be unique');
    const r = await call({ action: 'addEvent', event: { name: 'Winter Fest', dates: 'July 2027', code: 'winter' }, copyFrom: e1 }, admin);
    assert.equal(r.status, 200);
    e2 = r.data.eventId;
    assert.equal(r.data.state.events.find((e) => e.id === e2).code, 'WINTER');
    assert.equal(r.data.state.tasks.filter((x) => x.eventId === e2).length, 22);
  });

  await t('guests only see events whose code they hold', async () => {
    const one = await call();
    const w = await call(null, { 'x-event-codes': 'WINTER' });
    assert.ok(w.data.events.every((e) => e.code === 'WINTER'), 'never another event code');
    assert.deepEqual(one.data.events.map((e) => e.name), ['Farm Fest April 2027']);
    assert.ok(one.data.tasks.every((x) => x.eventId === e1 || x.eventId === 'all'));
    const two = await call(null, both);
    assert.equal(two.data.events.length, 2);
    assert.deepEqual(two.data.matchedCodes.sort(), ['FF27', 'WINTER']);
  });

  let ian, karen, shared;
  await t('join an event, then RSVP to a second one', async () => {
    const r = await call({ action: 'join', eventId: e1, person: { name: 'Ian' }, rsvp: { adults: 1, nights: ['Fri', 'Sat'] } });
    ian = r.data.personId;
    assert.equal((await call({ action: 'setRsvp', personId: ian, eventId: e2, rsvp: { adults: 1, nights: ['Sat'] } })).status, 403, 'needs the winter code');
    const ok = await call({ action: 'setRsvp', personId: ian, eventId: e2, rsvp: { adults: 1, nights: ['Sat'] } }, both);
    const me = ok.data.state.people.find((p) => p.id === ian);
    assert.equal(Object.keys(me.rsvps).length, 2);
    assert.equal(me.summary.req, 6, '3 points per event');
    const k = await call({ action: 'join', eventId: e2, person: { name: 'Karen' }, rsvp: { adults: 2, nights: ['Sat'] } }, winterOnly);
    karen = k.data.personId;
  });

  await t('people lists and RSVPs are filtered by code', async () => {
    const aprilOnly = await call();
    assert.ok(!aprilOnly.data.people.some((p) => p.id === karen), 'Karen is only at winter');
    const ianSeen = aprilOnly.data.people.find((p) => p.id === ian);
    assert.deepEqual(Object.keys(ianSeen.rsvps), [e1], 'winter RSVP hidden from april-only viewers');
    assert.equal(ianSeen.payments.length, 0);
  });

  await t('a shared job is visible to every event and counts once', async () => {
    const g = await call({ action: 'addTask', eventId: 'all', title: 'Design the shirts', phase: 'Before', points: 3, slots: 1 }, admin);
    shared = g.data.taskId;
    assert.ok((await call(null, winterOnly)).data.tasks.some((x) => x.id === shared));
    assert.ok((await call()).data.tasks.some((x) => x.id === shared));
    const c = await call({ action: 'claim', taskId: shared, personId: ian });
    assert.equal(c.data.state.people.find((p) => p.id === ian).summary.earned, 3);
  });

  await t("guests can't add jobs to an event they don't hold the code for", async () => {
    assert.equal((await call({ action: 'addTask', eventId: e2, title: 'x' })).status, 403);
    const g = await call({ action: 'addTask', eventId: 'all', title: 'Bring a guitar', points: 8 });
    assert.equal(g.data.state.tasks.find((x) => x.id === g.data.taskId).pending, true);
  });

  await t('admin-only and treasurer-only actions are protected', async () => {
    assert.equal((await call({ action: 'deleteTask', taskId: shared })).status, 403);
    assert.equal((await call({ action: 'updatePaymentInfo', details: 'PayID 123' }, admin)).status, 403);
  });

  await t('payments: report, treasurer confirms, per-event meal costs', async () => {
    const r = await call({ action: 'reportPayment', personId: karen, amount: 60, note: 'buy-in' }, { ...winterOnly, 'x-person-id': karen });
    const pay = r.data.state.people.find((p) => p.id === karen).payments[0];
    const c = await call({ action: 'confirmPayment', personId: karen, paymentId: pay.id, confirmed: true }, treas);
    const k = c.data.state.people.find((p) => p.id === karen).summary;
    assert.equal(k.req, 6, 'two adults x 3');
    assert.equal(k.have, 3, '$60 = 3 points');
    assert.equal(k.status, 'bad');
    const info = await call({ action: 'updatePaymentInfo', details: 'PayID: 0400', mealCosts: { [e2]: 'Asado $35' } }, treas);
    assert.equal(info.data.state.events.find((x) => x.id === e2).mealCosts, 'Asado $35');
  });

  await t('organiser-assigned jobs: guests cannot claim, organisers assign', async () => {
    const bar = (await call()).data.tasks.find((x) => x.title === 'Bar host (one night)' && x.eventId === e1);
    assert.equal(bar.assignOnly, true);
    assert.equal((await call({ action: 'claim', taskId: bar.id, personId: ian })).status, 403);
    assert.equal((await call({ action: 'assign', taskId: bar.id, personId: ian })).status, 403, 'guests cannot assign');
    const r = await call({ action: 'assign', taskId: bar.id, personId: ian }, admin);
    const c = r.data.state.tasks.find((x) => x.id === bar.id).claims[0];
    assert.equal(c.personId, ian); assert.equal(c.assigned, true);
    assert.equal(r.data.state.people.find((p) => p.id === ian).summary.earned, 5, 'shirts 3 + bar 2');
    const g = await call({ action: 'addTask', eventId: e1, title: 'Gate duty', assignOnly: true });
    assert.equal(g.data.state.tasks.find((x) => x.id === g.data.taskId).assignOnly, false, 'only organisers can make assign-only jobs');
    const e = await call({ action: 'editTask', taskId: g.data.taskId, assignOnly: true }, admin);
    assert.equal(e.data.state.tasks.find((x) => x.id === g.data.taskId).assignOnly, true);
  });

  await t('organisers assign several people at once, up to the spots left', async () => {
    const extra = [];
    for (const n of ['Amy', 'Bo', 'Cy', 'Di']) extra.push((await call({ action: 'join', eventId: e1, person: { name: n } })).data.personId);
    const bar = (await call()).data.tasks.find((x) => x.title === 'Bar host (one night)' && x.eventId === e1);
    assert.equal(bar.slots, 4, 'bar seeded with 4 spots');
    assert.equal(bar.claims.length, 1, 'Ian already on it');
    const tooMany = await call({ action: 'assign', taskId: bar.id, personIds: extra }, admin);
    assert.equal(tooMany.status, 409);
    assert.match(tooMany.data.error, /Only 3 spots left/);
    const r = await call({ action: 'assign', taskId: bar.id, personIds: [extra[0], extra[1], extra[2], ian] }, admin);
    assert.equal(r.status, 200, 'people already on the job are skipped');
    assert.equal(r.data.assigned, 3);
    assert.equal(r.data.state.tasks.find((x) => x.id === bar.id).claims.length, 4);
    assert.equal((await call({ action: 'assign', taskId: bar.id, personIds: [extra[3]] }, admin)).status, 409);
    for (const pid of extra) await call({ action: 'removePerson', personId: pid }, admin);
  });

  await t('event dates, day-specific jobs and an organiser-only run sheet', async () => {
    const bad = await call({ action: 'updateEvent', eventId: e1, event: { startDate: '2027-04-04', endDate: '2027-04-02' } }, admin);
    assert.equal(bad.status, 400);
    assert.equal((await call({ action: 'updateEvent', eventId: e1, event: { startDate: '2027-04-02' } })).status, 403);
    const r = await call({ action: 'updateEvent', eventId: e1, event: { startDate: '2027-04-02', endDate: '2027-04-04' } }, admin);
    const ev = r.data.state.events.find((x) => x.id === e1);
    assert.equal(ev.dates, 'Fri 2 to Sun 4 Apr 2027');
    const fri = (await call()).data.tasks.find((x) => x.eventId === e1 && x.title.startsWith('Lead cook, Friday'));
    assert.equal(fri.day, 0); assert.equal(fri.slot, 'Dinner');
    const a = await call({ action: 'addTask', eventId: e1, title: 'Set the tables', phase: 'During', day: '0', slot: 'Dinner' });
    const job = a.data.state.tasks.find((x) => x.id === a.data.taskId);
    assert.equal(job.day, 0); assert.equal(job.slot, 'Dinner');
    const off = await call({ action: 'addTask', eventId: e1, title: 'Day 9', phase: 'During', day: '5' });
    assert.equal(off.data.state.tasks.find((x) => x.id === off.data.taskId).day, null, 'day beyond the event is dropped');
    const moved = await call({ action: 'editTask', taskId: job.id, phase: 'Before' }, admin);
    assert.equal(moved.data.state.tasks.find((x) => x.id === job.id).day, null, 'only During jobs have a day');
    assert.equal((await call({ action: 'setRunSheet', eventId: e1, day: 0, text: '6pm Dinner' })).status, 403, 'guests cannot edit the run sheet');
    await call({ action: 'setRunSheet', eventId: e1, day: 0, text: '3pm Gates open\n6pm Dinner' }, admin);
    assert.equal((await call()).data.events.find((x) => x.id === e1).runSheet[0], '3pm Gates open\n6pm Dinner', 'guests can read it');
    await call({ action: 'deleteTask', taskId: job.id }, admin);
    await call({ action: 'deleteTask', taskId: off.data.taskId }, admin);
  });

  await t('shopping list: add, claim, tick off, scoped by event', async () => {
    const a1 = await call({ action: 'addItem', eventId: e1, name: 'Tonic water', qty: '12 bottles', personId: ian });
    const item = a1.data.itemId;
    assert.equal((await call({ action: 'addItem', eventId: e2, name: 'Ice' })).status, 403, 'needs the winter code');
    const w = await call({ action: 'addItem', eventId: e2, name: 'Ice', qty: '4 bags' }, winterOnly);
    assert.ok(!(await call()).data.shopping.some((x) => x.id === w.data.itemId), 'april-only viewers do not see winter items');
    await call({ action: 'claimItem', itemId: item, personId: ian });
    assert.equal((await call({ action: 'claimItem', itemId: item, personId: karen }, both)).status, 409);
    assert.equal((await call({ action: 'setItemGot', itemId: item, personId: karen, got: true }, both)).status, 403);
    const got = await call({ action: 'setItemGot', itemId: item, personId: ian, got: true });
    assert.equal(got.data.state.shopping.find((x) => x.id === item).got, true);
    assert.equal((await call({ action: 'deleteItem', itemId: item, personId: ian })).status, 403, 'claimed items need an organiser to delete');
    assert.equal((await call({ action: 'deleteItem', itemId: item }, admin)).status, 200);
  });

  await t('reset one event leaves the other alone', async () => {
    const r = await call({ action: 'resetEvent', eventId: e2 }, admin);
    const me = r.data.state.people.find((p) => p.id === ian);
    assert.deepEqual(Object.keys(me.rsvps), [e1]);
    assert.ok(r.data.state.tasks.filter((x) => x.eventId === e2).every((x) => x.claims.length === 0));
  });

  await t('delete an event removes its jobs and RSVPs; the last event cannot be deleted', async () => {
    const r = await call({ action: 'deleteEvent', eventId: e2 }, admin);
    assert.equal(r.data.state.events.length, 1);
    assert.ok(!r.data.state.tasks.some((x) => x.eventId === e2));
    assert.equal((await call({ action: 'deleteEvent', eventId: e1 }, admin)).status, 400);
  });

  await t('v1 data migrates into the first event', async () => {
    store = memoryStore();
    await store.setJSON('state', {
      version: 1,
      event: { name: 'Old Fest', dates: 'Apr', location: 'Farm', whatsappUrl: '', pointsOvernight: 3, pointsDay: 2, dollarsPerPoint: 25 },
      payment: { details: 'PayID x', mealCosts: 'BBQ $30' },
      people: [{ id: 'p1', name: 'Paul', adults: 2, kids: 1, nights: ['Fri'], diet: '', sponsor: '', firstTimer: false, host: true, payments: [] }],
      tasks: [{ id: 't1', title: 'Cook', phase: 'During', points: 8, slots: 1, pending: false, claims: [{ personId: 'p1', notDone: false }] }],
    });
    const r = await call();
    assert.equal(r.status, 200);
    assert.equal(r.data.events[0].name, 'Old Fest');
    assert.equal(r.data.events[0].mealCosts, 'BBQ $30');
    assert.equal(r.data.settings.dollarsPerPoint, 25);
    assert.equal(r.data.people[0].rsvps[r.data.events[0].id].adults, 2);
    assert.equal(r.data.tasks[0].eventId, r.data.events[0].id);
    const w = await call({ action: 'claim', taskId: 't1', personId: 'p1' });
    assert.equal(w.status, 200, 'writes work after migration');
  });

  await t('concurrent claims do not lose writes (atomic store)', async () => {
    store = memoryStore();
    const tasks = (await call()).data.tasks;
    const eid = (await call()).data.events[0].id;
    const people = [];
    for (let i = 0; i < 6; i++) people.push((await call({ action: 'join', eventId: eid, person: { name: 'P' + i } })).data.personId);
    const dishes = tasks.find((x) => x.title === 'Dishes after a meal');
    const rs = await Promise.all(people.map((pid) => call({ action: 'claim', taskId: dishes.id, personId: pid })));
    assert.equal(rs.filter((r) => r.status === 200).length, 4);
    assert.equal((await call()).data.tasks.find((x) => x.id === dishes.id).claims.length, 4);
  });

  console.log(`\n${passed} tests passed`);
} finally {
  await stop();
}
