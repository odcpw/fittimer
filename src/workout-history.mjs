/**
 * Small, defensive local history store for completed and interrupted workouts.
 * The app deliberately keeps this independent from the interval engine so a
 * service-worker update cannot change or invalidate a user's local log.
 */
export const WORKOUT_HISTORY_KEY = 'fittimer.workout-history.v1';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function validDate(date) {
  return date instanceof Date && !Number.isNaN(date.getTime());
}

function dateFromValue(value) {
  if (value instanceof Date) return validDate(value) ? new Date(value.getTime()) : null;
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    ? date
    : null;
}

export function formatDateKey(value = new Date()) {
  const date = dateFromValue(value) ?? (value instanceof Date ? null : new Date(value));
  if (!validDate(date)) return null;
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part, index) => index === 0 ? String(part).padStart(4, '0') : String(part).padStart(2, '0'))
    .join('-');
}

function normalizeEntry(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
  if (typeof entry.routine !== 'string' || entry.routine.trim() === '') return null;
  const date = formatDateKey(entry.date);
  if (!date) return null;

  if (entry.finished === true) {
    return { routine: entry.routine, date, finished: true };
  }

  if (Number.isInteger(entry.abortedAtInterval) && entry.abortedAtInterval > 0) {
    return { routine: entry.routine, date, abortedAtInterval: entry.abortedAtInterval };
  }
  return null;
}

function storageOrNull(storage) {
  if (storage) return storage;
  try {
    return typeof window !== 'undefined' ? window.localStorage ?? null : null;
  } catch {
    return null;
  }
}

export function normalizeHistory(entries) {
  if (!Array.isArray(entries)) return [];
  return entries.map(normalizeEntry).filter(Boolean);
}

export function loadWorkoutHistory(storage = undefined) {
  const store = storageOrNull(storage);
  if (!store || typeof store.getItem !== 'function') return [];
  try {
    const raw = store.getItem(WORKOUT_HISTORY_KEY);
    if (!raw) return [];
    return normalizeHistory(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function saveWorkoutHistory(entries, storage = undefined) {
  const store = storageOrNull(storage);
  if (!store || typeof store.setItem !== 'function') return false;
  try {
    store.setItem(WORKOUT_HISTORY_KEY, JSON.stringify(normalizeHistory(entries)));
    return true;
  } catch {
    return false;
  }
}

export function appendWorkoutHistory(entry, { storage = undefined, now = new Date() } = {}) {
  const normalized = normalizeEntry({ ...entry, date: entry?.date ?? formatDateKey(now) });
  if (!normalized) return null;
  const entries = loadWorkoutHistory(storage);
  entries.push(normalized);
  saveWorkoutHistory(entries, storage);
  return normalized;
}

export function completionDates(entries) {
  return new Set(normalizeHistory(entries).filter((entry) => entry.finished).map((entry) => entry.date));
}

export function abortedDates(entries) {
  return new Set(normalizeHistory(entries).filter((entry) => entry.abortedAtInterval).map((entry) => entry.date));
}

export function currentStreak(entries, today = new Date()) {
  const completed = completionDates(entries);
  let date = dateFromValue(today);
  if (!date) return 0;

  let streak = 0;
  while (completed.has(formatDateKey(date))) {
    streak += 1;
    date.setDate(date.getDate() - 1);
  }
  return streak;
}

export function buildMonthCalendar(month = new Date(), entries = []) {
  const anchor = dateFromValue(month);
  if (!anchor) throw new TypeError('month must be a valid date');
  const year = anchor.getFullYear();
  const monthIndex = anchor.getMonth();
  const first = new Date(year, monthIndex, 1);
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const leadingBlankDays = first.getDay();
  const cellCount = Math.ceil((leadingBlankDays + daysInMonth) / 7) * 7;
  const completed = completionDates(entries);
  const aborted = abortedDates(entries);
  const cells = Array.from({ length: cellCount }, (_, index) => {
    const date = new Date(year, monthIndex, index - leadingBlankDays + 1);
    const dateKey = formatDateKey(date);
    return Object.freeze({
      date: dateKey,
      day: date.getDate(),
      inMonth: date.getMonth() === monthIndex,
      completed: completed.has(dateKey),
      aborted: aborted.has(dateKey),
    });
  });

  return Object.freeze({
    year,
    month: monthIndex,
    label: `${MONTH_NAMES[monthIndex]} ${year}`,
    cells: Object.freeze(cells),
  });
}

export function historySummary(entries) {
  const normalized = normalizeHistory(entries);
  return Object.freeze({
    completed: normalized.filter((entry) => entry.finished).length,
    aborted: normalized.filter((entry) => entry.abortedAtInterval).length,
  });
}
