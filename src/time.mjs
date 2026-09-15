// Shared time contract. A provider reading counts as current for fifteen minutes,
// and may run up to a minute ahead of us before it reads as clock skew. Every
// surface that decides whether a measurement is still showable uses these values.
export const MINUTE = 60000;
export const HOUR = 3600000;
export const DAY = 86400000;
export const STALE_MS = 15 * MINUTE;
export const SKEW_MS = MINUTE;

export const iso = ms => Number.isFinite(ms) && ms > 0 && ms < 8.64e15 ? new Date(ms).toISOString() : null;

// OpenCodex records some timestamps in seconds and others in milliseconds.
export const epochIso = value => typeof value === 'number' ? iso(value < 1e11 ? value * 1000 : value) : null;

export const expired = (measuredAt, now) =>
  !Number.isFinite(measuredAt) || now - measuredAt > STALE_MS || measuredAt > now + SKEW_MS;
