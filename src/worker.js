import { AppError, createHomeWizard, localDate, TIMEZONE } from './homewizard.js';

let client;
let credentials;
function getClient(env) {
  if (!client || credentials?.email !== env.HOMEWIZARD_EMAIL || credentials?.password !== env.HOMEWIZARD_PASSWORD) {
    client = createHomeWizard(env);
    credentials = { email: env.HOMEWIZARD_EMAIL, password: env.HOMEWIZARD_PASSWORD };
  }
  return client;
}

export async function handleRequest(request, env, api = getClient(env)) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (request.method !== 'GET') return Response.json({ error: 'Method not allowed.' }, { status: 405, headers: { ...headers, Allow: 'GET' } });
  try {
    if (url.pathname === '/api/devices') {
      const devices = (await api.meters()).map(({ id, name, serial, type }) => ({ id, name, serial, type }));
      return Response.json({ devices, today: localDate(), timezone: TIMEZONE }, { headers });
    }
    if (url.pathname !== '/api/range') throw new AppError('Not found.', 404);
    const from = url.searchParams.get('from') || localDate();
    const to = url.searchParams.get('to') || from;
    const deviceId = url.searchParams.get('device') || undefined;
    return Response.json(await api.range(from, to, deviceId), { headers });
  } catch (error) {
    // Never return upstream bodies, tokens, passwords or stack traces to visitors.
    return Response.json({ error: error instanceof AppError ? error.message : 'Unable to load energy data. Please try again.' },
      { status: error instanceof AppError ? error.status : 500, headers });
  }
}

export default { fetch(request, env) { return handleRequest(request, env); } };
