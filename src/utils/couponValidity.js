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

/**
 * null / 0 / undefined => unlimited
 */
const getUsageLimitPerUser = (coupon) => {
  const limit = Number(coupon?.usageLimitPerUser);
  if (!Number.isFinite(limit) || limit <= 0) return null;
  return Math.floor(limit);
};

const countCouponUsesByAccount = async (couponCode, accountId, options = {}) => {
  if (!couponCode || !accountId) return 0;
  const role = String(options.role || 'user').toLowerCase();

  if (role === 'vendor') {
    const PaymentRecord = require('../models/PaymentRecord.model');
    const mongoose = require('mongoose');
    const code = String(couponCode).toUpperCase();
    const or = [
      { 'metadata.couponCode': code },
      { 'metadata.code': code },
      { 'metadata.couponId': code },
    ];
    if (options.couponId) {
      const couponIdStr = String(options.couponId);
      or.push({ 'metadata.couponId': couponIdStr });
      if (mongoose.Types.ObjectId.isValid(couponIdStr) && couponIdStr.length === 24) {
        or.push({ 'metadata.couponId': new mongoose.Types.ObjectId(couponIdStr) });
      }
    }
    return PaymentRecord.countDocuments({
      vendor: accountId,
      status: 'COMPLETED',
      $or: or,
    });
  }

  const Booking = require('../models/Booking.model');
  return Booking.countDocuments({
    user: accountId,
    'pricing.couponCode': String(couponCode).toUpperCase(),
    status: { $nin: ['cancelled', 'auto_cancelled'] },
  });
};

/**
 * Returns an error message when the account has exhausted their per-person limit, else null.
 */
const getCouponUsageLimitMessage = async (coupon, accountId, role = 'user') => {
  const limit = getUsageLimitPerUser(coupon);
  if (!limit || !accountId) return null;

  const used = await countCouponUsesByAccount(coupon.code, accountId, {
    role,
    couponId: coupon._id,
  });
  if (used >= limit) {
    return 'You have already used this coupon';
  }
  return null;
};

module.exports = {
  getCouponWindow,
  isCouponCurrentlyValid,
  getCouponStatusMessage,
  daysBetween,
  getAudienceType,
  isAccountEligibleForCoupon,
  getUsageLimitPerUser,
  countCouponUsesByAccount,
  getCouponUsageLimitMessage,
};
