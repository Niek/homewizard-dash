import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, createHomeWizard, dateRange, getMeters, localDate, normalizeDays, usageFromTotals, validateDate, weekPath } from '../src/homewizard.js';
import { handleRequest } from '../src/worker.js';
import { toCsv } from '../public/export.js';

const locations = [{ latitude: 52, accounts: [{ email: 'private@example.com' }],
  devices: [{ device_id: 'energymeter/0123456789ab', type: 'energymeter', name: 'Charger' }] }];
const meter = getMeters(locations)[0];
const now = () => Date.parse('2026-10-26T12:00:00Z');
const credentials = { HOMEWIZARD_EMAIL: 'private@example.com', HOMEWIZARD_PASSWORD: 'test-secret' };
const reply = (value, status = 200) => new Response(JSON.stringify(value), { status });
const sample = { values: [
  { time: '2026-10-23T22:00:00Z', import: 0, export: 17.59 },
  { time: '2026-10-24T22:00:00Z', import: 0, export: 22.56 },
  { time: '2026-10-25T23:00:00Z', import: 0, export: 0 },
] };

test('dates use Amsterdam and reject impossible, future, reversed and oversized ranges', () => {
  assert.equal(localDate(new Date('2026-10-25T23:30:00Z')), '2026-10-26');
  assert.equal(validateDate('2026-10-25', '2026-10-26'), '2026-10-25');
  for (const date of ['2026-02-30', '2026-13-01', '../2026-01-01', '2026-10-27', 'x']) {
    assert.throws(() => validateDate(date, '2026-10-26'));
  }
  assert.throws(() => dateRange('2026-10-25', '2026-10-24'));
  assert.throws(() => dateRange('2025-01-01', '2026-10-24'));
  assert.equal(dateRange('2024-01-01', '2024-12-31').length, 366);
  assert.deepEqual(dateRange('2026-10-25', '2026-10-25'), ['2026-10-25']);
});

test('calendar ranges retain every day across both DST changes and leap day', () => {
  assert.deepEqual(dateRange('2026-10-24', '2026-10-26'), ['2026-10-24', '2026-10-25', '2026-10-26']);
  assert.deepEqual(dateRange('2026-03-28', '2026-03-30'), ['2026-03-28', '2026-03-29', '2026-03-30']);
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.deepEqual(normalizeDays(dateRange('2026-10-24', '2026-10-26'), [sample]).map(d => d.usageKwh), [17.59, 22.56, 0]);
});

test('ISO week paths use the correct year at New Year', () => {
  assert.equal(weekPath('2021-01-01'), '2020/week/53');
  assert.equal(weekPath('2024-12-30'), '2025/week/01');
  assert.equal(weekPath('2026-10-25'), '2026/week/43');
  assert.equal(weekPath('2026-10-26'), '2026/week/44');
});

test('missing usage stays null and zero stays zero', () => {
  const days = normalizeDays(dateRange('2026-10-23', '2026-10-26'), [sample]);
  assert.deepEqual(days.map(d => d.usageKwh), [null, 17.59, 22.56, 0]);
  assert.equal(normalizeDays(['2026-10-25'], [{ values: [{ time: '2026-10-24T22:00:00Z', import: 9, export: null }] }])[0].usageKwh, null);
  assert.throws(() => normalizeDays(['2026-10-25'], [{}]));
  assert.throws(() => normalizeDays(['2026-10-25'], [{ values: [{ time: 'invalid' }] }]));
  assert.throws(() => normalizeDays(['2026-10-25'], [sample, sample]), /duplicate/);
});

test('usage is the absolute sum of import and export for either meter direction', () => {
  for (const [imported, exported, usage] of [
    [12.5, 0, 12.5], [0, 12.5, 12.5], [0, -12.5, 12.5], [-12.5, 0, 12.5],
    [3, 5, 8], [3, -5, 2], [0, 0, 0],
  ]) {
    assert.equal(usageFromTotals({ import: imported, export: exported }), usage);
    const days = normalizeDays(['2026-10-25'], [{ values: [{ time: '2026-10-24T22:00:00Z', import: imported, export: exported }] }]);
    assert.equal(days[0].usageKwh, usage);
  }
  for (const totals of [{ import: null, export: 0 }, { import: 0 }, { import: Infinity, export: 0 }]) {
    assert.equal(usageFromTotals(totals), null);
  }
});

test('CSV has exactly one daily row, serial, quoted names and empty missing usage', () => {
  const data = { device: { ...meter, name: '=SUM(1,2)"' }, days: normalizeDays(dateRange('2026-10-23', '2026-10-26'), [sample]) };
  const csv = toCsv(data);
  assert.equal(csv.trim().split('\r\n').length, 5);
  assert.ok(csv.startsWith('\uFEFF"date","meter","serial_number","usage_kwh"'));
  assert.ok(csv.includes('"' + "'=SUM(1,2)" + '"""'));
  assert.ok(csv.includes('"0123456789ab",\r\n'));
  assert.ok(csv.includes('"0123456789ab",22.56\r\n'));
  assert.ok(csv.endsWith(',0\r\n'));
  assert.ok(!csv.includes('power_w'));
});

test('ranges fetch weekly daily totals, cache results and reject unknown meters', async () => {
  const requests = [];
  let authCalls = 0;
  const api = createHomeWizard(credentials, { now, fetchImpl: async (url, options) => {
    if (url.includes('/account/token')) { authCalls++; return reply({ access_token: 'fake', expires_in: 3600 }); }
    if (url.endsWith('/locations')) return reply(locations);
    if (url.endsWith('/2026/10/26')) return reply({ total: { import: 0, export: 20.35 } });
    requests.push({ url, body: JSON.parse(options.body) });
    return reply({ values: sample.values.filter(row => weekPath(localDate(new Date(row.time))) === url.split('/devices/date/')[1]) });
  } });
  const data = await api.range('2026-10-24', '2026-10-26');
  assert.deepEqual(data.days.map(day => day.usageKwh), [17.59, 22.56, 20.35]);
  assert.equal(data.device.serial, '0123456789ab');
  assert.equal(requests.length, 2);
  assert.ok(requests.every(({body}) => body.values === true && body.wattage === false && body.fill === null && body.tz === 'Europe/Amsterdam'));
  assert.equal(requests[0].body.devices[0].measurementType, 'power_import');
  await api.range('2026-10-24', '2026-10-26');
  assert.equal(requests.length, 2);
  assert.equal(authCalls, 1);
  await assert.rejects(api.range('2026-10-25', '2026-10-25', 'energymeter/other'), /not found/);
});

test('long ranges paginate without missing or duplicate dates and bound upstream requests', async () => {
  let calls = 0;
  const api = createHomeWizard(credentials, { now, fetchImpl: async url => {
    calls++;
    if (url.includes('/account/token')) return reply({ access_token: 'fake', expires_in: 3600 });
    if (url.endsWith('/locations')) return reply(locations);
    return reply(url.endsWith('/2026/10/26') ? { total: { import: 0, export: 0 } } : { values: [] });
  } });
  let next = '2025-10-26';
  const dates = [];
  let pages = 0;
  do {
    calls = 0;
    const page = await api.range(next, '2026-10-26');
    assert.ok(calls <= 22);
    dates.push(...page.days.map(day => day.date));
    next = page.nextFrom;
    pages++;
  } while (next);
  assert.equal(pages, 3);
  assert.deepEqual(dates, dateRange('2025-10-26', '2026-10-26'));
  assert.equal(new Set(dates).size, 366);
});

test('current-week cache refreshes after one minute', async () => {
  let clock = now(), calls = 0;
  const api = createHomeWizard(credentials, { now: () => clock, fetchImpl: async url => {
    if (url.includes('/account/token')) return reply({ access_token: 'fake', expires_in: 3600 });
    if (url.endsWith('/locations')) return reply(locations);
    if (!url.endsWith('/2026/10/26')) calls++;
    return reply(url.endsWith('/2026/10/26') ? { total: { import: 0, export: 0 } } : { values: [] });
  } });
  await api.range('2026-10-26', '2026-10-26');
  await api.range('2026-10-26', '2026-10-26');
  assert.equal(calls, 1);
  clock += 60001;
  await api.range('2026-10-26', '2026-10-26');
  assert.equal(calls, 2);
});

test('a rejected token is renewed once', async () => {
  let authCalls = 0;
  const api = createHomeWizard(credentials, { now, fetchImpl: async (url, options) => {
    if (url.includes('/account/token')) return reply({ access_token: 'token-' + ++authCalls, expires_in: 3600 });
    if (options.headers.Authorization === 'Bearer token-1') return reply({}, 401);
    return reply(locations);
  } });
  assert.equal((await api.meters()).length, 1);
  assert.equal(authCalls, 2);
});

test('upstream error bodies and credentials never reach visitors', async () => {
  const api = createHomeWizard(credentials, { now, fetchImpl: async () => reply({ password: 'test-secret', access_token: 'sensitive-token' }, 500) });
  const response = await handleRequest(new Request('https://example.test/api/range?from=2026-10-25'), {}, api);
  const body = await response.text();
  assert.equal(response.status, 502);
  assert.ok(!body.includes('test-secret'));
  assert.ok(!body.includes('sensitive-token'));
});

test('device API exposes only meter fields and range routes are read-only', async () => {
  const api = { meters: async () => getMeters(locations), range: async (from, to, id) => ({ from, to, id }) };
  const data = await (await handleRequest(new Request('https://example.test/api/devices'), {}, api)).json();
  assert.deepEqual(Object.keys(data.devices[0]), ['id', 'name', 'serial', 'type']);
  assert.ok(!JSON.stringify(data).includes('private@example.com'));
  assert.equal((await handleRequest(new Request('https://example.test/api/range', { method: 'POST' }), {}, api)).status, 405);
  assert.equal((await handleRequest(new Request('https://example.test/api/unknown'), {}, api)).status, 404);
  const response = await handleRequest(new Request('https://example.test/api/range?from=2026-10-24&to=2026-10-26&device=test'), {}, api);
  assert.deepEqual(await response.json(), { from: '2026-10-24', to: '2026-10-26', id: 'test' });
});

test('parallel page loading preserves chronological order when requests finish out of order', async () => {
  const { loadRangePages, splitRange } = await import('../public/range.js');
  const ranges = splitRange('2025-10-26', '2026-10-26');
  assert.equal(ranges.length, 3);
  const resolvePages = [];
  const progress = [];
  const result = loadRangePages('2025-10-26', '2026-10-26', range => new Promise(resolve => {
    resolvePages.push(() => resolve({ ...range, nextFrom: null, fetchedAt: range.to + 'T12:00:00Z',
      days: dateRange(range.from, range.to).map(date => ({ date, usageKwh: 1 })) }));
  }), count => progress.push(count));
  assert.equal(resolvePages.length, 3, 'all pages start before any completes');
  resolvePages[2](); resolvePages[0](); resolvePages[1]();
  const data = await result;
  assert.deepEqual(data.days.map(day => day.date), dateRange('2025-10-26', '2026-10-26'));
  assert.equal(data.fetchedAt, '2026-10-26T12:00:00Z');
  assert.equal(progress.at(-1), 366);
  assert.equal(toCsv({ ...data, device: meter }).trim().split('\r\n').length, 367);
});

test('an incomplete or failed page never produces a partial export', async () => {
  const { loadRangePages } = await import('../public/range.js');
  await assert.rejects(loadRangePages('2026-01-01', '2026-10-26', async () => ({ nextFrom: '2026-02-01', days: [] })), /not loaded completely/);
  await assert.rejects(loadRangePages('2026-01-01', '2026-10-26', async () => { throw new Error('upstream failed'); }), /upstream failed/);
});

test('the request pool frees individual slots without waiting for the entire batch', async () => {
  const { runConcurrent } = await import('../src/homewizard.js');
  const resolvers = [];
  let active = 0, peak = 0, started = 0;
  const tasks = Array.from({ length: 8 }, (_, index) => () => {
    active++; started++; peak = Math.max(peak, active);
    return new Promise(resolve => { resolvers[index] = () => { active--; resolve(index); }; });
  });
  const pending = runConcurrent(tasks);
  assert.equal(started, 6);
  resolvers[1](); await Promise.resolve();
  assert.equal(started, 7, 'a fast request frees a slot while request 0 is still pending');
  resolvers[2](); await Promise.resolve();
  assert.equal(started, 8);
  for (const index of [0, 3, 4, 5, 6, 7]) resolvers[index]();
  assert.deepEqual(await pending, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(peak, 6);
});

test('concurrent pages share a single authentication and device discovery', async () => {
  const { loadRangePages } = await import('../public/range.js');
  let auth = 0, discovery = 0;
  const api = createHomeWizard(credentials, { now, fetchImpl: async url => {
    if (url.includes('/account/token')) { auth++; return reply({ access_token: 'fake', expires_in: 3600 }); }
    if (url.endsWith('/locations')) { discovery++; return reply(locations); }
    return reply(url.endsWith('/2026/10/26') ? { total: { import: 0, export: 0 } } : { values: [] });
  } });
  const data = await loadRangePages('2026-01-01', '2026-10-26', ({ from, to }) => api.range(from, to));
  assert.equal(data.days.length, 299);
  assert.equal(auth, 1);
  assert.equal(discovery, 1);
});
