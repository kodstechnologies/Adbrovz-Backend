/**
 * Builds the socket/FCM payload for new_booking_request events.
 * Sensitive fields are redacted until the vendor accepts.
 */
const buildNewBookingRequestPayload = (populatedBooking, radiusInKm = 5) => {
    let totalDurationMins = 0;
    if (populatedBooking.services?.length) {
        populatedBooking.services.forEach((item) => {
            totalDurationMins += (item.service?.approxCompletionTime || 0) * (item.quantity || 1);
        });
    }

    const servicesMapped = (populatedBooking.services || []).map((item) => {
        const serviceDetailsObj = item.service
            ? (item.service.toObject ? item.service.toObject() : item.service)
            : null;
        if (serviceDetailsObj) {
            serviceDetailsObj.id = serviceDetailsObj._id ? serviceDetailsObj._id.toString() : '';
            delete serviceDetailsObj._id;
        }
        return {
            quantity: item.quantity,
            adminPrice: item.adminPrice,
            vendorPrice: item.vendorPrice,
            finalPrice: item.finalPrice,
            isPriceConfirmed: item.isPriceConfirmed,
            id: item._id ? item._id.toString() : '',
            service: serviceDetailsObj
        };
    });

    const baseObj = populatedBooking.toObject ? populatedBooking.toObject() : { ...populatedBooking };
    delete baseObj._id;
    delete baseObj.__v;
    delete baseObj.id;

    const payload = {
        id: String(populatedBooking._id),
        bookingID: populatedBooking.bookingID,
        ...baseObj,
        services: servicesMapped,
        totalDurationMins,
        radius: radiusInKm
    };

    if (payload.user) {
        payload.user.id = payload.user._id?.toString();
        delete payload.user._id;
        payload.user.phoneNumber = '••••••••••';
        if (payload.user.email) payload.user.email = '••••••••••';
    }
    if (payload.category) {
        payload.category.id = payload.category._id?.toString();
        delete payload.category._id;
    }
    if (payload.location) {
        payload.location.address = 'Location visible after acceptance';
    }
    if (payload.user && payload.location) {
        payload.user.latitude = payload.location.latitude;
        payload.user.longitude = payload.location.longitude;
    }

    return payload;
};

module.exports = { buildNewBookingRequestPayload };
