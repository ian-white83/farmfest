import { getStore } from '@netlify/blobs';
import { handle } from '../../lib/handler.mjs';

export default async (req) => {
  const store = getStore({ name: 'farmfest', consistency: 'strong' });
  return handle(req, store, process.env);
};

export const config = { path: '/api' };
