import { toCsv } from './export.js';
import { loadRangePages } from './range.js';

const $ = id => document.getElementById(id);
const timezone = 'Europe/Amsterdam';
const number = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const time = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dateLabel = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });
const shortDate = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' });
const dateObject = date => new Date(date + 'T12:00:00Z');
let today;
let current;
let ready = false;
let activeRequest;
let sequence = 0;
const rangeCache = new Map();

async function api(path, signal) {
  const response = await fetch(path, { signal });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Could not load energy data.');
  return body;
}

function query() {
  return new URLSearchParams({ from: $('from').value, to: $('to').value, device: $('device').value });
}

function controls(loading = false) {
  for (const id of ['device', 'from', 'to', 'today', 'last-week', 'this-month', 'this-year']) $(id).disabled = !ready;
  $('refresh').classList.toggle('is-loading', loading);
  $('refresh').disabled = loading;
  $('export').disabled = loading || !current;
}

function showError(message) {
  $('error').textContent = message;
  $('error').hidden = false;
}

async function loadRange({ refresh = false } = {}) {
  activeRequest?.abort();
  activeRequest = new AbortController();
  const version = ++sequence;
  current = undefined;
  $('range-content').hidden = true;
  $('error').hidden = true;
  $('updated').textContent = '';
  if (!ready || !$('filters').reportValidity()) {
    $('status').textContent = 'Choose a start and end date.';
    controls();
    return;
  }
  const params = query();
  const from = params.get('from'), to = params.get('to');
  if (from > to || (dateObject(to) - dateObject(from)) / 86400000 >= 366) {
    showError(from > to ? 'The start date must be on or before the end date.' : 'Choose a range of up to 366 days.');
    $('status').textContent = 'Adjust the date range to continue.';
    controls();
    return;
  }
  $('status').textContent = 'Loading daily usage…';
  controls(true);
  try {
    const key = params.toString();
    const cached = rangeCache.get(key);
    if (!refresh && cached && cached.expires > Date.now()) {
      current = cached.data;
    } else {
      const signal = activeRequest.signal;
      const data = await loadRangePages(from, to, pageRange => {
        const pageQuery = new URLSearchParams(params);
        pageQuery.set('from', pageRange.from);
        pageQuery.set('to', pageRange.to);
        return api('/api/range?' + pageQuery, signal);
      }, loaded => {
        if (version === sequence) $('status').textContent = loaded + ' days loaded…';
      });
      if (version !== sequence) return;
      current = data;
      if (rangeCache.size >= 12) rangeCache.delete(rangeCache.keys().next().value);
      rangeCache.set(key, { data, expires: Date.now() + (to === today ? 60000 : 3600000) });
    }
    history.replaceState(null, '', '?' + params);
    render(current);
  } catch (error) {
    if (version !== sequence || error.name === 'AbortError') return;
    $('status').textContent = 'Usage could not be loaded.';
    activeRequest.abort();
    showError(error.message);
  } finally {
    if (version === sequence) controls();
  }
}

function render(data) {
  $('range-content').hidden = false;
  $('meter-title').textContent = data.device.name + ' · ' + data.device.serial;
  $('range-title').textContent = data.from === data.to ? dateLabel.format(dateObject(data.from))
    : dateLabel.format(dateObject(data.from)) + ' – ' + dateLabel.format(dateObject(data.to));
  const available = data.days.filter(day => day.usageKwh !== null);
  const total = available.reduce((sum, day) => sum + day.usageKwh, 0);
  $('usage').textContent = available.length ? number.format(total) : '—';
  const missing = data.days.length - available.length;
  $('coverage').textContent = (missing ? 'Subtotal for ' + available.length + ' of ' + data.days.length + ' days. Missing days are blank in CSV.'
    : data.days.length + (data.days.length === 1 ? ' day' : ' days') + ' in this range.')
    + (data.to === today ? ' Today is still in progress.' : '');
  $('status').textContent = available.length ? 'Daily usage loaded.' : 'No usage data is available for this range.';
  $('updated').textContent = 'Retrieved ' + time.format(new Date(data.fetchedAt));
  const fragment = document.createDocumentFragment();
  for (const day of data.days) {
    const tr = document.createElement('tr');
    const values = [dateLabel.format(dateObject(day.date)), day.usageKwh === null ? 'No data' : day.date === today ? 'In progress' : 'Complete',
      day.usageKwh === null ? '—' : number.format(day.usageKwh)];
    values.forEach((value, index) => {
      const td = document.createElement('td');
      td.textContent = value;
      if (index === 1) td.className = 'has-text-grey';
      if (index === 2) td.className = 'has-text-right';
      tr.append(td);
    });
    fragment.append(tr);
  }
  $('readings-body').replaceChildren(fragment);
  renderChart(data);
}

function renderChart(data) {
  const chart = $('chart');
  chart.replaceChildren();
  const valid = data.days.filter(day => day.usageKwh !== null);
  if (!valid.length) {
    const empty = document.createElement('p');
    empty.className = 'chart-empty';
    empty.textContent = 'No usage data for this range.';
    chart.append(empty);
    return;
  }
  const width = Math.max(280, chart.clientWidth), height = 250;
  const margin = { left: 48, right: 12, top: 15, bottom: 30 };
  const max = Math.max(1, ...valid.map(day => day.usageKwh)) * 1.1;
  const plotHeight = height - margin.top - margin.bottom;
  const slot = (width - margin.left - margin.right) / data.days.length;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Daily usage in kilowatt-hours. Exact values are in the daily totals table.');
  function element(tag, attributes, text, parent = svg) {
    const node = document.createElementNS(svg.namespaceURI, tag);
    Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, value));
    if (text !== undefined) node.textContent = text;
    parent.append(node);
    return node;
  }
  for (let i = 0; i <= 4; i++) {
    const value = max * i / 4;
    const y = margin.top + plotHeight * (1 - i / 4);
    element('line', { x1: margin.left, x2: width - margin.right, y1: y, y2: y, stroke: '#e9edef' });
    element('text', { x: margin.left - 9, y: y + 4, 'text-anchor': 'end', fill: '#78848b', 'font-size': 11 }, value.toFixed(1));
  }
  data.days.forEach((day, index) => {
    if (day.usageKwh === null) return;
    const barWidth = Math.min(48, slot * .72);
    const barHeight = day.usageKwh / max * plotHeight;
    const bar = element('rect', { x: margin.left + slot * (index + .5) - barWidth / 2,
      y: margin.top + plotHeight - barHeight, width: barWidth, height: barHeight,
      rx: Math.min(2, barWidth / 4), fill: day.date === today ? '#82c7bd' : '#168b7b' });
    element('title', {}, day.date + ': ' + number.format(day.usageKwh) + ' kWh', bar);
  });
  const ticks = Math.min(data.days.length, width < 500 ? 3 : 6);
  for (let i = 0; i < ticks; i++) {
    const index = ticks === 1 ? 0 : Math.round(i * (data.days.length - 1) / (ticks - 1));
    element('text', { x: margin.left + slot * (index + .5), y: height - 6, fill: '#78848b', 'font-size': 11,
      'text-anchor': ticks === 1 ? 'middle' : i === 0 ? 'start' : i === ticks - 1 ? 'end' : 'middle' }, shortDate.format(dateObject(data.days[index].date)));
  }
  chart.append(svg);
}

function download() {
  if (!current) return;
  const url = URL.createObjectURL(new Blob([toCsv(current)], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'homewizard-' + current.from + '-to-' + current.to + '.csv';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function preset(from) {
  $('from').value = from;
  $('to').value = today;
  loadRange();
}

$('filters').addEventListener('submit', event => { event.preventDefault(); ready ? loadRange({ refresh: true }) : start(); });
for (const id of ['from', 'to', 'device']) $(id).addEventListener('change', loadRange);
$('today').addEventListener('click', () => preset(today));
$('last-week').addEventListener('click', () => {
  const date = dateObject(today);
  date.setUTCDate(date.getUTCDate() - 6);
  preset(date.toISOString().slice(0, 10));
});
$('this-month').addEventListener('click', () => preset(today.slice(0, 7) + '-01'));
$('this-year').addEventListener('click', () => preset(today.slice(0, 4) + '-01-01'));
$('export').addEventListener('click', download);
new ResizeObserver(() => { if (current) renderChart(current); }).observe($('chart'));

async function start() {
  controls(true);
  try {
    const data = await api('/api/devices');
    today = data.today;
    const params = new URLSearchParams(location.search);
    for (const id of ['from', 'to']) {
      $(id).max = today;
      $(id).value = params.get(id) || params.get('date') || (id === 'from' ? today.slice(0, 7) + '-01' : today);
    }
    $('device').replaceChildren(...data.devices.map(device => {
      const option = document.createElement('option');
      option.value = device.id;
      option.textContent = device.name + ' · ' + device.serial;
      return option;
    }));
    if (!data.devices.length) throw new Error('No supported energy meters were found in this account.');
    if (data.devices.some(device => device.id === params.get('device'))) $('device').value = params.get('device');
    ready = true;
    await loadRange();
  } catch (error) {
    $('status').textContent = 'Unable to connect.';
    showError(error.message);
    controls();
  }
}
start();
