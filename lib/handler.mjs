import { STATE_KEY, freshState, migrate, applyAction, accessFor, viewFor, HttpError } from './core.mjs';

const json = (status, data) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

// Constant-time-ish string compare so codes can't be guessed by timing.
function same(a, b) {
  if (!a || !b) return false;
  const x = String(a), y = String(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return diff === 0;
}

// Event codes live in the stored state (organisers can change them); the
// organiser and treasurer codes come from environment variables.
export function credentialsFrom(req, env) {
  const h = (k) => (req.headers.get(k) || '').trim();
  const codes = [...h('x-event-codes').split(','), h('x-event-code')].map((c) => c.trim()).filter(Boolean).slice(0, 20);
  return {
    codes,
    admin: same(h('x-admin-code'), (env.ADMIN_CODE || '').trim()),
    treasurer: same(h('x-treasurer-code'), (env.TREASURER_CODE || '').trim()),
    viewerId: h('x-person-id').slice(0, 40),
  };
}

async function load(store, env) {
  let r = await store.getWithMetadata(STATE_KEY, { type: 'json', consistency: 'strong' });
  if (!r || !r.data) {
    // First visit ever: save the seeded state so job ids stay stable.
    await store.setJSON(STATE_KEY, freshState(env), { onlyIfNew: true });
    r = await store.getWithMetadata(STATE_KEY, { type: 'json', consistency: 'strong' });
  }
  let state = r.data, etag = r.etag;
  if (!etag) {
    // Some backends (e.g. the local Blobs server) omit the ETag on reads. Take it
    // from a listing first, then re-read: if a write lands in between, the
    // conditional save fails and we simply retry.
    const { blobs } = await store.list({ prefix: STATE_KEY });
    etag = blobs.find((b) => b.key === STATE_KEY)?.etag || null;
    state = (await store.get(STATE_KEY, { type: 'json', consistency: 'strong' })) || state;
  }
  return { state: migrate(state, env), etag };
}

async function save(store, state, etag) {
  if (!etag) return false;
  const res = await store.setJSON(STATE_KEY, state, { onlyIfMatch: etag });
  return res.modified;
}

export async function handle(req, store, env) {
  try {
    const cred = credentialsFrom(req, env);
    if (req.method !== 'GET' && req.method !== 'POST') return json(405, { error: 'Method not allowed' });

    let body = null;
    if (req.method === 'POST') {
      try { body = await req.json(); } catch { return json(400, { error: 'Bad request' }); }
    }

    // Optimistic concurrency: retry if someone else saved in between.
    for (let attempt = 0; attempt < 12; attempt++) {
      const { state, etag } = await load(store, env);
      const access = accessFor(state, cred);
      if (!access.eventIds.length) return json(401, { error: 'Wrong event code' });
      if (!body) return json(200, viewFor(state, access, cred.viewerId));
      if (body.action === 'checkRoles') return json(200, { roles: { admin: access.admin, treasurer: access.treasurer } });
      const result = applyAction(state, body, access);
      if (await save(store, state, etag)) {
        const after = accessFor(state, cred);
        return json(200, { ok: true, ...result, state: viewFor(state, after.eventIds.length ? after : access, cred.viewerId) });
      }
      await new Promise((r) => setTimeout(r, (30 + Math.random() * 120) * Math.min(attempt + 1, 4)));
    }
    return json(503, { error: 'Busy, please try again' });
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.message });
    console.error(e);
    return json(500, { error: 'Something went wrong' });
  }
}
