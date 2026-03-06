const mongoose = require('mongoose');

const MONGODB_URI = "mongodb+srv://adityaprasadtripathy20_db_user:0SJ3JqKGzOYtTDsK@cluster0.fhbj9mn.mongodb.net/";

async function test() {
    try {
        await mongoose.connect(MONGODB_URI);
        console.log("Connected to MongoDB.");

        const Booking = require('./src/models/Booking.model.js');
        const count = await Booking.countDocuments();
        console.log("Total bookings in DB:", count);

        const firstBooking = await Booking.findOne().populate('user').populate('vendor');
        console.log("First booking sample:", JSON.stringify(firstBooking, null, 2));

    } catch (err) {
        console.error("Error:", err);
    } finally {
        mongoose.disconnect();
    }
}

test();


