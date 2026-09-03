const mongoose = require('mongoose');
const Booking = require('../../../models/Booking.model');
const Vendor = require('../../../models/Vendor.model');
const Service = require('../../../models/Service.model');
const { ELIGIBLE_VENDOR_REGISTRATION_STEPS } = require('./search.config');
const { getBookingTimeRange } = require('./booking.time');

const toServiceObjectIds = (booking) => {
    const rawIds = (booking.services || [])
        .map((item) => item.service?._id || item.service?.id || item.service)
        .filter(Boolean);
    return [...new Set(rawIds.map((id) => String(id)))].map((id) => new mongoose.Types.ObjectId(id));
};

const buildVendorServiceMatchFilter = (serviceObjectIds) => {
    if (!serviceObjectIds.length) return null;
    return {
        $or: [
            { approvedServices: { $all: serviceObjectIds } },
            { selectedServices: { $all: serviceObjectIds } }
        ]
    };
};

const resolveCategoryIds = async (booking) => {
    if (booking.category) {
        return [booking.category.toString()];
    }
    const serviceIds = booking.services.map((s) => s.service);
    const services = await Service.find({ _id: { $in: serviceIds } }).select('category');
    return [...new Set(services.map((s) => s.category.toString()))];
};

const getBusyVendorIds = async (booking) => {
    const busyVendorIds = [];
    const newBookingRange = await getBookingTimeRange(booking);
    if (!newBookingRange) return busyVendorIds;

    const activeBookings = await Booking.find({
        vendor: { $exists: true, $ne: null },
        scheduledDate: booking.scheduledDate
    }).populate('services.service');

    for (const activeBooking of activeBookings) {
        const activeRange = await getBookingTimeRange(activeBooking);
        if (activeRange && activeRange.start < newBookingRange.end && activeRange.end > newBookingRange.start) {
            busyVendorIds.push(activeBooking.vendor.toString());
        }
    }

    return busyVendorIds;
};

const buildCategoryServiceFilter = async (booking, categoryIds) => {
    const serviceObjectIds = toServiceObjectIds(booking);
    const serviceMatchFilter = buildVendorServiceMatchFilter(serviceObjectIds);

    if (serviceMatchFilter) {
        return [serviceMatchFilter];
    }

    const servicesInCategories = await Service.find({ category: { $in: categoryIds } }).select('_id');
    const serviceIdsInCategories = servicesInCategories.map((s) => s._id);

    const filters = [{ selectedCategories: { $in: categoryIds } }];
    if (serviceIdsInCategories.length > 0) {
        filters.push({ selectedServices: { $in: serviceIdsInCategories } });
        filters.push({ approvedServices: { $in: serviceIdsInCategories } });
    }
    return filters;
};

const buildGeoQuery = (booking, radiusInKm, categoryOrServiceFilter, excludedVendorIds) => {
    const geoQuery = {
        isVerified: true,
        isSuspended: false,
        isBlocked: false,
        isLocked: { $ne: true },
        registrationStep: { $in: ELIGIBLE_VENDOR_REGISTRATION_STEPS },
        deletedAt: null,
        'liveLocation.coordinates.0': { $ne: 0 },
        'liveLocation.coordinates.1': { $ne: 0 },
        $and: [
            {
                $or: [
                    { 'membership.expiryDate': { $exists: false } },
                    { 'membership.expiryDate': { $gt: new Date() } }
                ]
            },
            {
                $or: [
                    { 'serviceRenewal.expiryDate': { $exists: false } },
                    { 'serviceRenewal.expiryDate': { $gt: new Date() } }
                ]
            },
            { $or: categoryOrServiceFilter }
        ],
        liveLocation: {
            $nearSphere: {
                $geometry: {
                    type: 'Point',
                    coordinates: [booking.location.longitude, booking.location.latitude]
                },
                $maxDistance: radiusInKm * 1000
            }
        }
    };

    if (excludedVendorIds.length > 0) {
        geoQuery._id = { $nin: [...new Set(excludedVendorIds)] };
    }

    return geoQuery;
};

/**
 * Finds eligible nearby vendors for a booking at the given wave radius.
 */
const findEligibleVendors = async (booking, radiusInKm) => {
    const ignoredVendors = [
        ...(booking.rejectedVendors || []),
        ...(booking.laterVendors || [])
    ].map((id) => id.toString());

    const categoryIds = await resolveCategoryIds(booking);
    const busyVendorIds = await getBusyVendorIds(booking);
    const categoryOrServiceFilter = await buildCategoryServiceFilter(booking, categoryIds);
    const excludedVendorIds = [...ignoredVendors, ...busyVendorIds];

    const geoQuery = buildGeoQuery(booking, radiusInKm, categoryOrServiceFilter, excludedVendorIds);
    const vendors = await Vendor.find(geoQuery).select('_id name fcmToken categorySubscriptions membership');

    return { vendors, categoryIds, geoQuery };
};

module.exports = {
    toServiceObjectIds,
    buildVendorServiceMatchFilter,
    findEligibleVendors
};
