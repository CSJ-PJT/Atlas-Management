import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

const MONTHS = new Map([
  ['Jan', 0], ['Feb', 1], ['Mar', 2], ['Apr', 3], ['May', 4], ['Jun', 5],
  ['Jul', 6], ['Aug', 7], ['Sep', 8], ['Oct', 9], ['Nov', 10], ['Dec', 11],
]);

const STATIC_PATH = /(?:^|\/)assets\/|\.(?:css|js|mjs|map|png|jpe?g|gif|svg|ico|webp|woff2?|ttf|webmanifest)$/i;

function parseNginxTime(value) {
  const match = value.match(/^(\d{1,2})\/([A-Z][a-z]{2})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/);
  if (!match || !MONTHS.has(match[2])) return null;
  const [, day, month, year, hour, minute, second, sign, offsetHour, offsetMinute] = match;
  const offset = (Number(offsetHour) * 60 + Number(offsetMinute)) * (sign === '+' ? 1 : -1);
  return new Date(Date.UTC(
    Number(year), MONTHS.get(month), Number(day), Number(hour), Number(minute) - offset, Number(second),
  ));
}

export function classifyService(requestPath) {
  if (requestPath === '/') return 'portal';
  if (requestPath.startsWith('/travel/') || requestPath.startsWith('/api/')) return 'travel';
  if (requestPath.startsWith('/jobs/')) return 'incruit';
  if (requestPath.startsWith('/learn/') || requestPath.startsWith('/atlas/') || requestPath.startsWith('/run/')) return 'learn';
  if (requestPath.startsWith('/health/')) return 'health';
  if (requestPath.startsWith('/sketchfy/')) return 'sketchfy';
  if (requestPath.startsWith('/world/')) return 'world';
  if (requestPath.startsWith('/archiveos/')) return 'archiveos';
  if (requestPath.startsWith('/archive/')) return 'archive';
  return 'other';
}

export function parseAccessLine(line) {
  const match = line.match(/^(\S+) \S+ \S+ \[([^\]]+)] "([A-Z]+) (\S+) HTTP\/[^"]+" (\d{3}) (?:\d+|-) /);
  if (!match) return null;
  const [, ip, rawTime, method, target, rawStatus] = match;
  const time = parseNginxTime(rawTime);
  if (!time || !Number.isFinite(time.getTime()) || !target.startsWith('/')) return null;
  let requestPath;
  try {
    requestPath = new URL(target, 'https://atlas.invalid').pathname;
  } catch {
    return null;
  }
  if (requestPath.startsWith('/atlas-admin-api/') || STATIC_PATH.test(requestPath)) return null;
  return {
    ip,
    time: time.toISOString(),
    method,
    path: requestPath,
    status: Number(rawStatus),
    service: classifyService(requestPath),
  };
}

async function readLogFile(filePath) {
  const bytes = await readFile(filePath);
  return filePath.endsWith('.gz') ? gunzipSync(bytes).toString('utf8') : bytes.toString('utf8');
}

export async function loadUsage(logDirectory, {
  days = 7,
  service = 'all',
  page = 1,
  pageSize = 50,
  now = Date.now(),
} = {}) {
  const safeDays = Math.min(30, Math.max(1, Number(days) || 7));
  const safePageSize = Math.min(100, Math.max(1, Number(pageSize) || 50));
  const safePage = Math.max(1, Number(page) || 1);
  const cutoff = now - safeDays * 24 * 60 * 60 * 1_000;
  const fileNames = (await readdir(logDirectory))
    .filter((name) => name === 'access.log' || /^access\.log-[0-9]{8}(?:\.gz)?$/.test(name))
    .sort();
  const records = [];

  for (const fileName of fileNames) {
    const content = await readLogFile(path.join(logDirectory, fileName));
    for (const line of content.split(/\r?\n/)) {
      const record = parseAccessLine(line);
      if (!record || Date.parse(record.time) < cutoff) continue;
      if (service !== 'all' && record.service !== service) continue;
      records.push(record);
    }
  }

  records.sort((left, right) => Date.parse(right.time) - Date.parse(left.time));
  const total = records.length;
  const totalPages = Math.max(1, Math.ceil(total / safePageSize));
  const boundedPage = Math.min(safePage, totalPages);
  const offset = (boundedPage - 1) * safePageSize;
  return {
    days: safeDays,
    page: boundedPage,
    pageSize: safePageSize,
    total,
    totalPages,
    uniqueIpCount: new Set(records.map(({ ip }) => ip)).size,
    records: records.slice(offset, offset + safePageSize),
  };
}
