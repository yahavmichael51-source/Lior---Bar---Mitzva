// Netlify Function serving every /api/* route. Static pages come from /public.
import { getStore } from '@netlify/blobs';
import apiModule from '../../lib/api.js';
import storeModule from '../../lib/blobs-store.js';

const { createApi, MAX_BODY } = apiModule;
const { createBlobsStore } = storeModule;

// Netlify's recommended way to read environment variables in functions is Netlify.env;
// process.env is the fallback for the local test simulation.
function env(key) {
  return globalThis.Netlify?.env?.get(key) ?? process.env[key];
}

function adminAccounts() {
  return [
    { username: env('ADMIN_USERNAME'), password: env('ADMIN_PASSWORD') },
    { username: env('ADMIN_USERNAME_2'), password: env('ADMIN_PASSWORD_2') },
  ];
}

export default async (request, context) => {
  // Created per request (not cached): the Blobs connection details belong to this invocation.
  const db = createBlobsStore(
    getStore({ name: 'rsvp', consistency: 'strong' }),
    getStore({ name: 'rsvp' })
  );
  const handle = createApi(db, { admins: adminAccounts(), sessionSecret: env('SESSION_SECRET') });
  const url = new URL(request.url);
  const body = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text();
  const res = await handle({
    method: request.method,
    pathname: url.pathname,
    searchParams: url.searchParams,
    headers: { cookie: request.headers.get('cookie') || '', editToken: request.headers.get('x-edit-token') || '' },
    body: body.length > MAX_BODY ? body.slice(0, MAX_BODY + 1) : body,
    ip: context.ip || 'unknown',
    secure: url.protocol === 'https:',
  });
  return new Response(res.body, { status: res.status, headers: res.headers });
};

export const config = { path: '/api/*' };
