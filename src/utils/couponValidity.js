/**
 * Resolve a coupon's validity window.
 * New coupons use startDate/endDate; older ones fall back to createdAt + validityDays.
 */
const startOfDay = (value) => {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
};

const endOfDay = (value) => {
  const date = new Date(value);
  date.setHours(23, 59, 59, 999);
  return date;
};

const getCouponWindow = (coupon) => {
  if (coupon.startDate && coupon.endDate) {
    return {
      start: startOfDay(coupon.startDate),
      end: endOfDay(coupon.endDate),
    };
  }

  const start = startOfDay(coupon.createdAt || Date.now());
  const end = endOfDay(coupon.createdAt || Date.now());
  end.setDate(end.getDate() + (coupon.validityDays || 0));
  return { start, end };
};

const isCouponCurrentlyValid = (coupon, now = new Date()) => {
  const { start, end } = getCouponWindow(coupon);
  return now >= start && now <= end;
};

const getCouponStatusMessage = (coupon, now = new Date()) => {
  const { start, end } = getCouponWindow(coupon);
  if (now < start) return 'Coupon is not active yet';
  if (now > end) return 'Coupon has expired';
  return null;
};

const daysBetween = (startDate, endDate) => {
  const start = startOfDay(startDate);
  const end = startOfDay(endDate);
  return Math.max(1, Math.round((end - start) / (1000 * 60 * 60 * 24)) + 1);
};

const idOf = (value) => (value && (value._id || value.id || value)).toString();

const getAudienceType = (coupon) => coupon.audienceType || 'user';

const isAccountEligibleForCoupon = (coupon, accountId, role = 'user') => {
  const audience = getAudienceType(coupon);
  const normalizedRole = String(role || 'user').toLowerCase();

  if (audience === 'vendor') {
    if (normalizedRole !== 'vendor') return false;
    if (coupon.isForAllVendors) return true;
    return (coupon.applicableVendors || []).some((vendor) => idOf(vendor) === String(accountId));
  }

  if (normalizedRole === 'vendor') return false;
  if (coupon.isForAllUsers) return true;
  return (coupon.applicableUsers || []).some((user) => idOf(user) === String(accountId));
};

module.exports = {
  getCouponWindow,
  isCouponCurrentlyValid,
  getCouponStatusMessage,
  daysBetween,
  getAudienceType,
  isAccountEligibleForCoupon,
};
