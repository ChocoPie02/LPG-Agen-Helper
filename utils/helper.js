import fs from 'fs/promises';
import path from 'path';
import readline from 'readline';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

export function delay(seconds) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

export function delayMs(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureFile(filePath, content = '') {
  if (!(await fileExists(filePath))) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf8');
  }
}

export async function readLines(filePath) {
  if (!(await fileExists(filePath))) {
    return [];
  }

  const raw = await fs.readFile(filePath, 'utf8');
  return raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function readJson(filePath, fallback = null) {
  if (!(await fileExists(filePath))) {
    return fallback;
  }

  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

export async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function loadCsvRecords(filePath) {
  if (!(await fileExists(filePath))) {
    return [];
  }

  const raw = await fs.readFile(filePath, 'utf8');
  const lines = raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return [];
  }

  const rows = lines.map(parseCsvLine);
  const header = rows[0].map((item) => normalizeHeader(item));

  if (!header.includes('nik')) {
    throw new Error('data.csv wajib memiliki kolom nik.');
  }

  return rows.slice(1).map((cells, index) => {
    const record = Object.fromEntries(header.map((key, cellIndex) => [key, (cells[cellIndex] || '').trim()]));
    record.rowNumber = index + 2;
    return record;
  });
}

function parseCsvLine(line) {
  const result = [];
  let current = '';
  let insideQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"') {
      if (insideQuotes && next === '"') {
        current += '"';
        index += 1;
        continue;
      }

      insideQuotes = !insideQuotes;
      continue;
    }

    if (char === ',' && !insideQuotes) {
      result.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  result.push(current);
  return result;
}

function normalizeHeader(value) {
  return value.trim().toLowerCase().replace(/\s+/gu, '_');
}

export function pickRandom(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return null;
  }

  return items[Math.floor(Math.random() * items.length)];
}

export function shuffle(items) {
  const cloned = [...items];
  for (let index = cloned.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [cloned[index], cloned[swapIndex]] = [cloned[swapIndex], cloned[index]];
  }
  return cloned;
}

export function shuffleAvoidingRecent(items, recentValues = [], getValue = (item) => item, recentWindow = recentValues.length) {
  const shuffled = shuffle(items);
  const safeWindow = Math.max(Number(recentWindow) || 0, 0);
  if (safeWindow === 0 || recentValues.length === 0) {
    return shuffled;
  }

  const recentSet = new Set(recentValues.slice(-safeWindow));
  const preferred = [];
  const deferred = [];

  for (const item of shuffled) {
    const value = getValue(item);
    if (recentSet.has(value)) {
      deferred.push(item);
    } else {
      preferred.push(item);
    }
  }

  return [...preferred, ...deferred];
}

export function rememberRecentValue(recentValues, value, limit = 10) {
  const normalized = Array.isArray(recentValues) ? [...recentValues] : [];
  const safeLimit = Math.max(Number(limit) || 0, 0);
  if (!value || safeLimit === 0) {
    return normalized;
  }

  const filtered = normalized.filter((item) => item !== value);
  filtered.push(value);
  return filtered.slice(-safeLimit);
}

export function createProxyAgent(proxy) {
  if (!proxy) {
    return null;
  }

  if (proxy.startsWith('http://') || proxy.startsWith('https://')) {
    return new HttpsProxyAgent(proxy);
  }

  if (proxy.startsWith('socks4://') || proxy.startsWith('socks5://')) {
    return new SocksProxyAgent(proxy);
  }

  return null;
}

export async function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function promptChoice(question, choices) {
  const label = choices.map((choice, index) => `${index + 1}. ${choice}`).join('\n');
  const raw = await prompt(`${question}\n${label}\n> `);
  const asNumber = Number(raw);

  if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= choices.length) {
    return choices[asNumber - 1];
  }

  const matched = choices.find((choice) => choice.toLowerCase() === raw.toLowerCase());
  if (matched) {
    return matched;
  }

  throw new Error('Pilihan tidak valid.');
}

export async function upsertEnvValue(envFilePath, key, value) {
  const normalizedValue = String(value ?? '').replace(/\r?\n/gu, ' ').trim();
  const line = `${key}=${normalizedValue}`;
  process.env[key] = normalizedValue;

  if (!(await fileExists(envFilePath))) {
    await fs.writeFile(envFilePath, `${line}\n`, 'utf8');
    return;
  }

  const raw = await fs.readFile(envFilePath, 'utf8');
  const pattern = new RegExp(`^${escapeForRegex(key)}=.*$`, 'mu');

  if (pattern.test(raw)) {
    const updated = raw.replace(pattern, line);
    await fs.writeFile(envFilePath, updated.endsWith('\n') ? updated : `${updated}\n`, 'utf8');
    return;
  }

  const prefix = raw.endsWith('\n') || raw.length === 0 ? raw : `${raw}\n`;
  await fs.writeFile(envFilePath, `${prefix}${line}\n`, 'utf8');
}

function escapeForRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function parseNik(value) {
  return String(value || '').replace(/\D/gu, '');
}

export function getErrorMessage(error, fallback = 'Terjadi kesalahan.') {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (error && typeof error === 'object' && typeof error.message === 'string' && error.message) {
    return error.message;
  }

  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }

  return fallback;
}

export function isDebugErrorsEnabled() {
  return /^(1|true|yes|on)$/iu.test(String(process.env.DEBUG_ERRORS || '').trim());
}

export function isValidNik(value) {
  return /^\d{16}$/u.test(parseNik(value));
}

export function decodeJwtExpiry(token) {
  try {
    const parts = token.split('.');
    if (parts.length < 2) {
      return null;
    }

    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload.exp ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

export function getDateParts(timeZone = 'Asia/Jakarta', date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  return Object.fromEntries(formatter.formatToParts(date).filter((item) => item.type !== 'literal').map((item) => [item.type, item.value]));
}

export function getTodayKey(timeZone = 'Asia/Jakarta', date = new Date()) {
  const parts = getDateParts(timeZone, date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function compareDateKeys(left, right) {
  return left.localeCompare(right);
}

export function addDays(dateKey, days) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  const nextYear = date.getUTCFullYear();
  const nextMonth = `${date.getUTCMonth() + 1}`.padStart(2, '0');
  const nextDay = `${date.getUTCDate()}`.padStart(2, '0');
  return `${nextYear}-${nextMonth}-${nextDay}`;
}

export function parseStockDateLabel(label, timeZone = 'Asia/Jakarta') {
  if (!label) {
    return null;
  }

  const normalized = label.trim().toLowerCase();
  const today = getTodayKey(timeZone);
  const yesterday = addDays(today, -1);
  const monthMap = {
    januari: '01',
    february: '02',
    februari: '02',
    maret: '03',
    march: '03',
    april: '04',
    mei: '05',
    may: '05',
    juni: '06',
    june: '06',
    juli: '07',
    july: '07',
    agustus: '08',
    august: '08',
    september: '09',
    oktober: '10',
    october: '10',
    november: '11',
    desember: '12',
    december: '12',
  };

  if (normalized === 'hari ini' || normalized === 'today') {
    return today;
  }

  if (normalized === 'kemarin' || normalized === 'yesterday') {
    return yesterday;
  }

  const match = label.trim().match(/^(\d{1,2})\s+([A-Za-zÀ-ÿ]+)\s+(\d{4})$/u);
  if (!match) {
    return null;
  }

  const [, day, monthName, year] = match;
  const month = monthMap[monthName.toLowerCase()];
  if (!month) {
    return null;
  }

  return `${year}-${month}-${String(day).padStart(2, '0')}`;
}

export function isTodayOrYesterday(dateKey, timeZone = 'Asia/Jakarta') {
  if (!dateKey) {
    return false;
  }

  const today = getTodayKey(timeZone);
  const yesterday = addDays(today, -1);
  return dateKey === today || dateKey === yesterday;
}

export function parseWorkTime(value, fallback) {
  const normalized = String(value || fallback || '').trim();
  if (!/^\d{2}:\d{2}$/u.test(normalized)) {
    throw new Error(`Format jam tidak valid: ${normalized}`);
  }
  return normalized;
}

export function getMinutesFromTime(value) {
  const [hour, minute] = value.split(':').map(Number);
  return (hour * 60) + minute;
}

export function getCurrentMinutes(timeZone = 'Asia/Jakarta', date = new Date()) {
  const parts = getDateParts(timeZone, date);
  return (Number(parts.hour) * 60) + Number(parts.minute);
}

export function isWithinWorkHours(startTime, endTime, timeZone = 'Asia/Jakarta', date = new Date()) {
  const current = getCurrentMinutes(timeZone, date);
  return current >= getMinutesFromTime(startTime) && current <= getMinutesFromTime(endTime);
}

export function getSecondsUntilWorkStart(startTime, timeZone = 'Asia/Jakarta', date = new Date()) {
  const current = getCurrentMinutes(timeZone, date);
  const start = getMinutesFromTime(startTime);
  if (current < start) {
    return (start - current) * 60;
  }
  return 0;
}

export function getSecondsUntilNextDay(timeZone = 'Asia/Jakarta', date = new Date()) {
  const parts = getDateParts(timeZone, date);
  const currentSeconds = (Number(parts.hour) * 3600) + (Number(parts.minute) * 60) + Number(parts.second);
  return Math.max((24 * 3600) - currentSeconds, 1);
}

export function getSecondsUntilNextTimeOfDay(timeOfDay, timeZone = 'Asia/Jakarta', date = new Date()) {
  const [targetHour, targetMinute] = timeOfDay.split(':').map(Number);
  const parts = getDateParts(timeZone, date);
  const currentHour = Number(parts.hour);
  const currentMinute = Number(parts.minute);
  const currentSecond = Number(parts.second);

  const currentTotal = (currentHour * 3600) + (currentMinute * 60) + currentSecond;
  const targetTotal = (targetHour * 3600) + (targetMinute * 60);

  if (currentTotal < targetTotal) {
    return Math.max(targetTotal - currentTotal, 1);
  }

  return Math.max((24 * 3600) - currentTotal + targetTotal, 1);
}

export function buildDailyTargets(stockAvailable, totalDays) {
  const targets = [];
  let remaining = Number(stockAvailable);
  const safeDays = Math.max(Number(totalDays) || 1, 1);

  for (let day = 1; day <= safeDays; day += 1) {
    const slotsLeft = safeDays - day + 1;
    const allocation = Math.ceil(remaining / slotsLeft);
    targets.push(allocation);
    remaining -= allocation;
  }

  return targets;
}

export function formatCoordinate(location) {
  if (!location || Number.isNaN(Number(location.latitude)) || Number.isNaN(Number(location.longitude))) {
    return '-,-';
  }
  return `${location.latitude},${location.longitude}`;
}

export function safeNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

export function randomInt(minimum, maximum) {
  const min = Math.ceil(minimum);
  const max = Math.floor(maximum);
  return Math.floor(Math.random() * ((max - min) + 1)) + min;
}
