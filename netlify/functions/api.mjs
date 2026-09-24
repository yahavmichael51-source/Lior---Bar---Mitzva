// Netlify Function serving every /api/* route. Static pages come from /public.
import { getStore } from '@netlify/blobs';
import apiModule from '../../lib/api.js';
import storeModule from '../../lib/blobs-store.js';

const { createApi, MAX_BODY } = apiModule;
const { createBlobsStore } = storeModule;

let handle;

export default async (request, context) => {
  handle ??= createApi(createBlobsStore(getStore({ name: 'rsvp', consistency: 'strong' })), {
    adminPassword: process.env.ADMIN_PASSWORD || '',
    sessionSecret: process.env.SESSION_SECRET,
  });
  const url = new URL(request.url);
  const body = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text();
  const res = await handle({
    method: request.method,
    pathname: url.pathname,
    searchParams: url.searchParams,
    headers: { cookie: request.headers.get('cookie') || '' },
    body: body.length > MAX_BODY ? body.slice(0, MAX_BODY + 1) : body,
    ip: context.ip || 'unknown',
    secure: url.protocol === 'https:',
  });
  return new Response(res.body, { status: res.status, headers: res.headers });
};

export const config = { path: '/api/*' };
