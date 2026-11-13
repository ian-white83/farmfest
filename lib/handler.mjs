import { STATE_KEY, freshState, applyAction, publicView, HttpError } from './core.mjs';

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

export function rolesFrom(req, env) {
  const h = (k) => req.headers.get(k) || '';
  const eventCode = (env.EVENT_CODE || '').trim();
  const guest = same(h('x-event-code').trim().toUpperCase(), eventCode.toUpperCase());
  const admin = guest && same(h('x-admin-code').trim(), (env.ADMIN_CODE || '').trim());
  const treasurer = guest && same(h('x-treasurer-code').trim(), (env.TREASURER_CODE || '').trim());
  return { guest, admin, treasurer };
}

async function load(store) {
  let r = await store.getWithMetadata(STATE_KEY, { type: 'json', consistency: 'strong' });
  if (!r || !r.data) {
    // First visit ever: save the seeded state so job ids stay stable.
    await store.setJSON(STATE_KEY, freshState(), { onlyIfNew: true });
    r = await store.getWithMetadata(STATE_KEY, { type: 'json', consistency: 'strong' });
  }
  if (r.etag) return { state: r.data, etag: r.etag };
  // Some backends (e.g. the local Blobs server) omit the ETag on reads. Take it
  // from a listing first, then re-read: if a write lands in between, the
  // conditional save fails and we simply retry.
  const { blobs } = await store.list({ prefix: STATE_KEY });
  const etag = blobs.find((b) => b.key === STATE_KEY)?.etag;
  const again = await store.get(STATE_KEY, { type: 'json', consistency: 'strong' });
  return { state: again || r.data, etag: etag || null };
}

async function save(store, state, etag) {
  if (!etag) return false;
  const opts = { onlyIfMatch: etag };
  const res = await store.setJSON(STATE_KEY, state, opts);
  return res.modified;
}

export async function handle(req, store, env) {
  try {
    if (!env.EVENT_CODE) return json(500, { error: 'Site not set up: EVENT_CODE is missing' });
    const roles = rolesFrom(req, env);
    if (!roles.guest) return json(401, { error: 'Wrong event code' });

    if (req.method === 'GET') {
      const { state } = await load(store);
      return json(200, publicView(state, roles));
    }
    if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

    let body;
    try { body = await req.json(); } catch { return json(400, { error: 'Bad request' }); }
    if (body?.action === 'checkRoles') return json(200, { roles: { admin: roles.admin, treasurer: roles.treasurer } });

    // Optimistic concurrency: retry if someone else saved in between.
    for (let attempt = 0; attempt < 12; attempt++) {
      const { state, etag } = await load(store);
      const result = applyAction(state, body, roles);
      if (await save(store, state, etag)) return json(200, { ok: true, ...result, state: publicView(state, roles) });
      await new Promise((r) => setTimeout(r, (30 + Math.random() * 120) * Math.min(attempt + 1, 4)));
    }
    return json(503, { error: 'Busy, please try again' });
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.message });
    console.error(e);
    return json(500, { error: 'Something went wrong' });
  }
}
