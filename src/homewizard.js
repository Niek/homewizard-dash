import { RANGE_PAGE_DAYS } from '../public/range.js';

export const TIMEZONE = 'Europe/Amsterdam';

export class AppError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
});

export function localDate(value = new Date()) {
  return dateFormatter.format(value);
}

export function validateDate(value, today = localDate()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) {
    throw new AppError('Choose a date in YYYY-MM-DD format.', 400);
  }
  const parsed = new Date(value + 'T12:00:00Z');
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new AppError('Choose a valid calendar date.', 400);
  }
  if (value > today) throw new AppError('Future dates have no readings yet.', 400);
  return value;
}

// Account discovery contains account details and coordinates. Only expose meters.
export function getMeters(locations) {
  if (!Array.isArray(locations)) throw new AppError('Unexpected HomeWizard device response.');
  const meters = new Map();
  for (const home of locations) {
    for (const device of home.devices || []) {
      const id = device.device_id;
      if (!['energymeter', 'p1dongle'].includes(device.type) || typeof id !== 'string') continue;
      meters.set(id, {
        id, name: device.name || 'Energy meter', serial: id.split('/').at(-1), type: device.type,
        measurementType: device.type === 'p1dongle' ? 'main_connection' : 'power_import',
        graphType: device.type === 'p1dongle' ? 'main_connection' : 'electric_car',
      });
    }
  }
  return [...meters.values()];
}

const numberOrNull = value => typeof value === 'number' && Number.isFinite(value) ? value : null;

export function usageFromTotals(totals) {
  const imported = numberOrNull(totals?.import);
  const exported = numberOrNull(totals?.export);
  if (imported === null || exported === null) return null;
  return numberOrNull(Math.abs(imported + exported));
}


export function addDays(date, amount) {
  const value = new Date(date + 'T12:00:00Z');
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

export function dateRange(from, to, today = localDate()) {
  validateDate(from, today);
  validateDate(to, today);
  if (from > to) throw new AppError('The start date must be on or before the end date.', 400);
  const count = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  if (count > 366) throw new AppError('Choose a range of up to 366 days.', 400);
  return Array.from({ length: count }, (_, index) => addDays(from, index));
}

// ISO weeks use the year of their Thursday, including around New Year.
export function weekPath(date) {
  const value = new Date(date + 'T12:00:00Z');
  value.setUTCDate(value.getUTCDate() + 4 - (value.getUTCDay() || 7));
  const year = value.getUTCFullYear();
  const week = Math.ceil(((value - new Date(year + '-01-01T12:00:00Z')) / 86400000 + 1) / 7);
  return year + '/week/' + String(week).padStart(2, '0');
}

export function normalizeDays(dates, responses) {
  const values = new Map();
  for (const response of responses) {
    if (!Array.isArray(response?.values)) throw new AppError('HomeWizard returned an unexpected history format.');
    for (const point of response.values) {
      const stamp = new Date(point.time);
      if (!Number.isFinite(stamp.getTime())) throw new AppError('HomeWizard returned an invalid timestamp.');
      const date = localDate(stamp);
      if (values.has(date)) throw new AppError('HomeWizard returned duplicate daily totals.');
      values.set(date, usageFromTotals(point));
    }
  }
  return dates.map(date => ({ date, usageKwh: values.get(date) ?? null }));
}

// Keep requests moving as soon as a slot is free, without waiting for a batch's
// slowest response. Each Worker request stays within six concurrent fetches.
export async function runConcurrent(tasks, limit = 6) {
  const results = new Array(tasks.length);
  let cursor = 0;
  let stopped = false;
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (!stopped) {
      const index = cursor++;
      if (index >= tasks.length) return;
      try { results[index] = await tasks[index](); }
      catch (error) { stopped = true; throw error; }
    }
  }));
  return results;
}

export function createHomeWizard(env, { fetchImpl = fetch, now = Date.now } = {}) {
  let token = null;
  let tokenExpires = 0;
  let authPending;
  let metersCache;
  let metersPending;
  const weekCache = new Map();
  const pendingWeeks = new Map();

  async function send(url, options = {}) {
    try {
      return await fetchImpl(url, {
        ...options, redirect: 'manual', signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new AppError('HomeWizard could not be reached. Try again shortly.');
    }
  }

  async function json(response) {
    try {
      const data = await response.json();
      if (data?.error) throw new Error('Upstream API error');
      return data;
    } catch {
      throw new AppError('HomeWizard returned an unreadable response.');
    }
  }

  async function authenticate() {
    if (token && now() < tokenExpires) return token;
    if (!authPending) authPending = (async () => {
      if (!env.HOMEWIZARD_EMAIL || !env.HOMEWIZARD_PASSWORD) {
        throw new AppError('HomeWizard credentials have not been configured.', 503);
      }
      const bytes = new TextEncoder().encode(env.HOMEWIZARD_EMAIL + ':' + env.HOMEWIZARD_PASSWORD);
      const basic = btoa(String.fromCharCode(...bytes));
      const response = await send('https://api.homewizardeasyonline.com/v1/auth/account/token', {
        headers: { Authorization: 'Basic ' + basic, Accept: 'application/json' },
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new AppError(response.status === 429
          ? 'HomeWizard is rate limiting requests. Try again later.'
          : 'HomeWizard login failed. Check the configured credentials.', 502);
      }
      const data = await json(response);
      if (typeof data.access_token !== 'string' || !data.access_token) {
        throw new AppError('HomeWizard did not return an access token.');
      }
      token = data.access_token;
      tokenExpires = now() + Math.max(0, (Number(data.expires_in) || 3600) * 1000 - 60000);
      return token;
    })().finally(() => { authPending = undefined; });
    return authPending;
  }

  async function api(url, options = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const accessToken = await authenticate();
      const response = await send(url, {
        ...options, headers: {
          Accept: 'application/json', 'Content-Type': 'application/json',
          Authorization: 'Bearer ' + accessToken,
        },
      });
      if (response.status === 401 && attempt === 0) {
        await response.body?.cancel();
        // Do not invalidate a token refreshed by another request.
        if (token === accessToken) { token = null; tokenExpires = 0; }
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new AppError(response.status === 429
          ? 'HomeWizard is rate limiting requests. Try again later.'
          : 'HomeWizard could not return these readings (HTTP ' + response.status + ').');
      }
      return json(response);
    }
  }

  async function meters() {
    if (metersCache && now() < metersCache.expires) return metersCache.data;
    if (!metersPending) metersPending = (async () => {
      const data = getMeters(await api('https://homes.api.homewizard.com/locations'));
      metersCache = { data, expires: now() + 300000 };
      return data;
    })().finally(() => { metersPending = undefined; });
    return metersPending;
  }

  async function week(path, meter) {
    const key = meter.id + ':' + path;
    const cached = weekCache.get(key);
    if (cached && now() < cached.expires) return cached.data;
    if (pendingWeeks.has(key)) return pendingWeeks.get(key);
    const pending = (async () => {
      const data = await api('https://tsdb-reader.homewizard.com/devices/date/' + path, {
        method: 'POST', body: JSON.stringify({
          devices: [{ identifier: meter.id, measurementType: meter.measurementType }],
          type: meter.graphType, tz: TIMEZONE, fill: null, three_phases: false,
          values: true, wattage: false,
        }),
      });
      if (!Array.isArray(data?.values)) throw new AppError('HomeWizard returned an unexpected history format.');
      if (weekCache.size >= 64) weekCache.delete(weekCache.keys().next().value);
      const currentWeek = weekPath(localDate(new Date(now())));
      weekCache.set(key, { data, expires: now() + (path === currentWeek ? 60000 : 3600000) });
      return data;
    })().finally(() => pendingWeeks.delete(key));
    pendingWeeks.set(key, pending);
    return pending;
  }

  async function range(from, to, deviceId) {
    const dates = dateRange(from, to, localDate(new Date(now())));
    const devices = await meters();
    const meter = deviceId ? devices.find(item => item.id === deviceId) : devices[0];
    if (!meter) throw new AppError(deviceId ? 'Meter not found in this account.' : 'No supported energy meters were found.', 404);
    // At most 19 weekly requests per page, leaving room for auth and retries
    // under the Workers Free subrequest limit. The page loads the next batch.
    const page = dates.slice(0, RANGE_PAGE_DAYS);
    const paths = [...new Set(page.map(weekPath))];
    const today = localDate(new Date(now()));
    const hasToday = page.includes(today);
    const tasks = paths.map(path => () => week(path, meter));
    if (hasToday) tasks.unshift(async () => {
      // Fetch today's fresh total alongside history, rather than after it.
      const latest = await api('https://tsdb-reader.homewizard.com/devices/date/' + today.replaceAll('-', '/'), {
        method: 'POST', body: JSON.stringify({
          devices: [{ identifier: meter.id, measurementType: meter.measurementType }],
          type: meter.graphType, tz: TIMEZONE, fill: null, three_phases: false,
          values: false, wattage: false,
        }),
      });
      if (!latest?.total || typeof latest.total !== 'object') throw new AppError('HomeWizard returned an unexpected daily total.');
      return latest;
    });
    const responses = await runConcurrent(tasks);
    const latest = hasToday ? responses.shift() : null;
    const days = normalizeDays(page, responses);
    if (hasToday) days.find(day => day.date === today).usageKwh = usageFromTotals(latest.total);
    return {
      from, to: page.at(-1), nextFrom: dates[RANGE_PAGE_DAYS] || null, timezone: TIMEZONE,
      device: { id: meter.id, name: meter.name, serial: meter.serial, type: meter.type },
      days, fetchedAt: new Date(now()).toISOString(),
    };
  }

  return { meters, range };
}
