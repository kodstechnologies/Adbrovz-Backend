const Service = require('../../../models/Service.model.js');

/**
 * Constructs a Date object representing a specific IST time.
 */
const _getScheduledDateTimeIST = (date, timeString) => {
    if (!date || !timeString) return null;
    const dateObj = new Date(date);
    if (isNaN(dateObj.getTime())) return null;
    const istDateStr = dateObj.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

    const timeStr = String(timeString).trim();

    // Handle both 24-hour ("14:30") and 12-hour ("02:30 PM") formats
    let hours, minutes;
    const ampmMatch = timeStr.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (ampmMatch) {
        hours = parseInt(ampmMatch[1], 10);
        minutes = parseInt(ampmMatch[2], 10);
        const meridiem = ampmMatch[3].toUpperCase();
        if (meridiem === 'PM' && hours !== 12) hours += 12;
        if (meridiem === 'AM' && hours === 12) hours = 0;
    } else {
        const parts = timeStr.split(':').map(Number);
        hours = parts[0];
        minutes = parts[1] ?? 0;
    }

    if (isNaN(hours) || isNaN(minutes)) return null;

    const isoStr = `${istDateStr}T${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:00+05:30`;
    const result = new Date(isoStr);
    return isNaN(result.getTime()) ? null : result;
};

/**
 * Returns { start, end } for a booking's scheduled window, or null if invalid.
 */
const getBookingTimeRange = async (booking) => {
    const start = _getScheduledDateTimeIST(booking.scheduledDate, booking.scheduledTime);
    if (!start) return null;

    let totalDurationMins = 0;

    if (booking.services?.length) {
        for (const s of booking.services) {
            const svc = s.service;
            if (svc && typeof svc === 'object') {
                totalDurationMins += (svc.approxCompletionTime || 60) * (s.quantity || 1);
            } else {
                const fullSvc = await Service.findById(svc).select('approxCompletionTime');
                totalDurationMins += (fullSvc?.approxCompletionTime || 60) * (s.quantity || 1);
            }
        }
    }

    if (booking.proposedServices?.length) {
        for (const s of booking.proposedServices) {
            const svc = s.service;
            if (svc && typeof svc === 'object') {
                totalDurationMins += (svc.approxCompletionTime || 30) * (s.quantity || 1);
            } else {
                const fullSvc = await Service.findById(svc).select('approxCompletionTime');
                totalDurationMins += (fullSvc?.approxCompletionTime || 30) * (s.quantity || 1);
            }
        }
    }

    if (totalDurationMins === 0) totalDurationMins = 60;

    return {
        start,
        end: new Date(start.getTime() + totalDurationMins * 60000)
    };
};

module.exports = {
    _getScheduledDateTimeIST,
    getBookingTimeRange
};
