const mongoose = require('mongoose');
const config = require('./src/config/env');
const Vendor = require('./src/models/Vendor.model');
const Booking = require('./src/models/Booking.model');
const bookingService = require('./src/modules/booking/booking.service');

async function triggerNotification() {
    try {
        await mongoose.connect(config.MONGODB_URI);
        console.log('Connected to MongoDB');

        const phoneNumber = '7857052455';
        const bookingID = '69eb22e3f3c6399b4fd23c46';

        const vendor = await Vendor.findOne({ phoneNumber });
        if (!vendor) {
            console.error(`Vendor with phone ${phoneNumber} not found`);
            process.exit(1);
        }
        console.log(`Found Vendor: ${vendor.name} (${vendor._id})`);

        let booking = await Booking.findOne({ 
            $or: [{ _id: bookingID }, { bookingID: bookingID }] 
        });
        
        if (!booking) {
            console.error(`Booking ${bookingID} not found`);
            process.exit(1);
        }
        console.log(`Found Booking: ${booking.bookingID} (${booking._id})`);

        // Force reset notifiedVendors for testing if needed
        // await Booking.findByIdAndUpdate(booking._id, { $pull: { notifiedVendors: vendor._id } });

        // Trigger searchVendors with broadcast=true
        // This will find vendors nearby OR fallback to category search
        // Since we want to trigger for THIS specific vendor, we might need a more direct emit if they aren't in range
        
        const { getVendorSockets, getIo } = require('./src/socket');
        const io = getIo(); // This might fail if server is not running in this process
        
        // Wait, if I run this as a separate script, it won't have access to the running socket server's `io` instance.
        // I should probably use a webhook or just trigger it via a temporary route if I can.
        
        // Alternative: The user says "do immediately trigger api".
        // Maybe I should add a temporary route to trigger this?
        
        console.log('Script ended. Use a temporary route or a more direct approach if socket server is needed.');

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await mongoose.disconnect();
    }
}

triggerNotification();
