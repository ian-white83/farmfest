import assert from 'node:assert/strict';
import { handle } from '../lib/handler.mjs';
import { localStore, memoryStore } from './local-store.mjs';

const env = { EVENT_CODE: 'FF27', ADMIN_CODE: 'ORG', TREASURER_CODE: 'CASH' };
const { store: fileStore, stop } = await localStore();
let store = fileStore;

async function call(body, headers = {}) {
  const h = { 'x-event-code': 'ff27', 'content-type': 'application/json', ...headers };
  const req = new Request('http://x/api', body ? { method: 'POST', headers: h, body: JSON.stringify(body) } : { headers: h });
  const res = await handle(req, store, env);
  return { status: res.status, data: await res.json() };
}
const admin = { 'x-admin-code': 'ORG' };
const treas = { 'x-treasurer-code': 'CASH' };
let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log('ok -', name); };

try {
  await t('wrong event code is rejected', async () => {
    const r = await handle(new Request('http://x/api', { headers: { 'x-event-code': 'nope' } }), store, env);
    assert.equal(r.status, 401);
  });

  await t('fresh state has 22 seeded jobs', async () => {
    const r = await call();
    assert.equal(r.status, 200);
    assert.equal(r.data.tasks.length, 22);
    assert.equal(r.data.roles.admin, false);
  });

  let ian, karen, tasks;
  await t('join and duplicate names', async () => {
    const r = await call({ action: 'join', person: { name: 'Ian', adults: 1, nights: ['Fri', 'Sat'] } });
    assert.equal(r.status, 200); ian = r.data.personId;
    const d = await call({ action: 'join', person: { name: 'ian' } });
    assert.equal(d.status, 409);
    const k = await call({ action: 'join', person: { name: 'Karen + Pete', adults: 2, kids: 2, nights: ['Sat'] } });
    karen = k.data.personId; tasks = k.data.state.tasks;
  });

  const pizza = () => tasks.find((x) => x.title.startsWith('Lead cook, Friday'));
  await t('claim respects slots', async () => {
    assert.equal((await call({ action: 'claim', taskId: pizza().id, personId: ian })).status, 200);
    const full = await call({ action: 'claim', taskId: pizza().id, personId: karen });
    assert.equal(full.status, 409);
  });

  await t('guest-added task is pending; admin task is live', async () => {
    const g = await call({ action: 'addTask', title: 'Bring a guitar', phase: 'During', points: 8, slots: 1 });
    assert.equal(g.data.state.tasks.find((x) => x.id === g.data.taskId).pending, true);
    const a = await call({ action: 'addTask', title: 'Mow camp area', phase: 'Before', points: 3, slots: 1 }, admin);
    assert.equal(a.data.state.tasks.find((x) => x.id === a.data.taskId).pending, false);
  });

  await t('admin-only actions are blocked for guests', async () => {
    const r = await call({ action: 'deleteTask', taskId: pizza().id });
    assert.equal(r.status, 403);
    const p = await call({ action: 'updatePaymentInfo', details: 'PayID 123' }, admin);
    assert.equal(p.status, 403, 'organiser code is not the treasurer code');
  });

  await t('captain can mark a claim not done', async () => {
    const r = await call({ action: 'setNotDone', taskId: pizza().id, personId: ian, notDone: true }, admin);
    assert.equal(r.data.state.tasks.find((x) => x.id === pizza().id).claims[0].notDone, true);
  });

  await t('payments: report, treasurer confirms, guest cannot remove confirmed', async () => {
    const r = await call({ action: 'reportPayment', personId: karen, amount: 60, note: 'buy-in' });
    const pay = r.data.state.people.find((p) => p.id === karen).payments[0];
    assert.equal(pay.confirmed, false);
    assert.equal((await call({ action: 'confirmPayment', personId: karen, paymentId: pay.id, confirmed: true })).status, 403);
    const c = await call({ action: 'confirmPayment', personId: karen, paymentId: pay.id, confirmed: true }, treas);
    assert.equal(c.data.state.people.find((p) => p.id === karen).payments[0].confirmed, true);
    assert.equal((await call({ action: 'cancelPayment', personId: karen, paymentId: pay.id })).status, 403);
    const info = await call({ action: 'updatePaymentInfo', details: 'PayID: 0400 000 000' }, treas);
    assert.equal(info.data.state.payment.details, 'PayID: 0400 000 000');
  });

  await t('WhatsApp link must be a WhatsApp URL', async () => {
    assert.equal((await call({ action: 'updateEvent', event: { whatsappUrl: 'https://evil.example' } }, admin)).status, 400);
    assert.equal((await call({ action: 'updateEvent', event: { whatsappUrl: 'https://chat.whatsapp.com/abc' } }, admin)).status, 200);
  });

  await t('concurrent claims do not lose writes (atomic store)', async () => {
    store = memoryStore();
    tasks = (await call()).data.tasks;
    const people = [];
    for (let i = 0; i < 6; i++) people.push((await call({ action: 'join', person: { name: 'P' + i } })).data.personId);
    const dishes = tasks.find((x) => x.title === 'Dishes after a meal');
    const rs = await Promise.all(people.map((pid) => call({ action: 'claim', taskId: dishes.id, personId: pid })));
    const ok = rs.filter((r) => r.status === 200).length;
    if (ok !== 4) console.log(rs.map((r) => r.status + ' ' + (r.data.error || '')));
    const s = (await call()).data;
    const claims = s.tasks.find((x) => x.id === dishes.id).claims.length;
    assert.equal(claims, 4, 'four slots filled');
    assert.equal(ok, 4);
  });

  store = fileStore;
  await t('new event clears people but keeps jobs and payment details', async () => {
    const r = await call({ action: 'newEvent' }, admin);
    assert.equal(r.data.state.people.length, 0);
    assert.ok(r.data.state.tasks.length >= 24);
    assert.ok(r.data.state.tasks.every((x) => x.claims.length === 0));
    assert.equal(r.data.state.payment.details, 'PayID: 0400 000 000');
  });

  console.log(`\n${passed} tests passed`);
} finally {
  await stop();
}
