/**
 * Utility functions for phone number normalization and querying.
 */

/**
 * Normalizes a phone number to standard 10 digits (removing +91, 91 prefix, leading 0, spaces, dashes).
 *
 * Examples:
 *   "+919999999900" -> "9999999900"
 *   "+91 99999 99900" -> "9999999900"
 *   "919999999900"  -> "9999999900"
 *   "09999999900"   -> "9999999900"
 *   "9999999900"    -> "9999999900"
 *
 * @param {string|number} phone
 * @returns {string}
 */
const normalizePhoneNumber = (phone) => {
  if (!phone) return '';
  let cleaned = String(phone).trim().replace(/[\s\-\(\)]/g, '');
  if (cleaned.startsWith('+91')) {
    cleaned = cleaned.slice(3);
  } else if (cleaned.startsWith('+')) {
    cleaned = cleaned.slice(1);
  }
  if (cleaned.length === 12 && cleaned.startsWith('91')) {
    cleaned = cleaned.slice(2);
  }
  if (cleaned.length === 11 && cleaned.startsWith('0')) {
    cleaned = cleaned.slice(1);
  }
  return cleaned;
};

/**
 * Generates all plausible phone number representations for MongoDB $in queries.
 * This guarantees matching whether the DB has a 10-digit number or a number with country code.
 *
 * @param {string|number} phone
 * @returns {string[]}
 */
const getPhoneVariants = (phone) => {
  if (!phone) return [];
  const raw = String(phone).trim();
  const normalized = normalizePhoneNumber(phone);
  const variants = new Set(
    [
      raw,
      normalized,
      `+91${normalized}`,
      `91${normalized}`,
      `0${normalized}`,
    ].filter(Boolean)
  );
  return Array.from(variants);
};

module.exports = {
  normalizePhoneNumber,
  getPhoneVariants,
};
