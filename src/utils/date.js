// Oman is UTC+4 year-round (no daylight saving), so "today in Oman" can be
// computed with a fixed offset instead of needing a timezone database —
// this keeps the OCR service's Docker image lightweight (no tzdata
// dependency) and keeps a single, unambiguous definition of "today" that
// doesn't depend on the server host's own configured timezone.
const OMAN_OFFSET_MS = 4 * 60 * 60 * 1000;

function todayInOman() {
  return new Date(Date.now() + OMAN_OFFSET_MS).toISOString().slice(0, 10);
}

module.exports = { todayInOman };
