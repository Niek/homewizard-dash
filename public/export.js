function csvCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value);
  let text = String(value);
  if (/^[=+\-@\t\r\n]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}

export function toCsv(data) {
  const rows = [
    ['date', 'meter', 'serial_number', 'usage_kwh'],
    ...data.days.map(day => [day.date, data.device.name, data.device.serial, day.usageKwh]),
  ];
  return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
