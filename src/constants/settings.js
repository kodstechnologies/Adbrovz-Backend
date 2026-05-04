const DEFAULT_SETTINGS = {
    'bookings.window_days': {
        value: 7,
        description: 'How many days in advance users can book a service.',
    },
    'bookings.reschedule_limit': {
        value: 2,
        description: 'Maximum number of times a user can reschedule a booking.',
    },
    'bookings.cancellation_lock_mins': {
        value: 60,
        description: 'Duration before service when cancellation is locked.',
    },
    'bookings.grace_period_mins': {
        value: 30,
        description: 'Time vendor has to arrive after scheduled time.',
    },
    'bookings.daily_leads_limit': {
        value: 5,
        description: 'Maximum number of leads a vendor can receive per day.',
    },
    'vendors.concurrency_limit': {
        value: 3,
        description: 'Maximum number of active jobs a vendor can have simultaneously.',
    },
    'pricing.signup_referral_coins': {
        value: 100,
        description: 'Coins given to a user when they sign up using a referral.',
    },
    'pricing.signup_welcome_coins': {
        value: 50,
        description: 'Coins given to a new user upon registration.',
    },
    'pricing.vendor_signup_welcome_coins': {
        value: 500,
        description: 'Coins given to a new vendor upon registration.',
    },
    'pricing.vendor_concurrency_fee': {
        value: 500,
        description: 'Global fee added to membership for multi-task capability.',
    },
    'pricing.membership_base_fee_3': {
        value: 1000,
        description: 'Base membership fee for 3 months duration.',
    },
    'pricing.membership_base_fee_6': {
        value: 2000,
        description: 'Base membership fee for 6 months duration.',
    },
    'pricing.membership_base_fee_12': {
        value: 4000,
        description: 'Base membership fee for 12 months duration.',
    },
    'pricing.membership_gst_percent': {
        value: 18,
        description: 'GST percentage for vendor membership fee.',
    },
    'pricing.travel_charge_per_km': {
        value: 10,
        description: 'Charge per kilometer applied to the total distance.',
    },
    'app.min_version': {
        value: '1.0.0',
        description: 'Minimum required app version for force updates.',
    },
    'app.latest_version': {
        value: '1.0.0',
        description: 'Latest app version to show update prompts.',
    },
    'data.archive_retention_days': {
        value: 90,
        description: 'How long to keep historical booking data.',
    },
    'data.notification_retention_days': {
        value: 30,
        description: 'How long to keep in-app notifications.',
    },
    'bookings.cancel_limit': {
        value: 1,
        description: 'Maximum number of times a user can cancel a booking.',
    },
    'bookings.search_timeout_mins': {
        value: 2,
        description: 'Minutes to search for vendors before showing Try Again to the user.',
    },
    'pricing.accept_lead_coin_cost': {
        value: 10,
        description: 'Coins deducted from vendor when accepting a lead.',
    },
    'pricing.credit_restore_rule': {
        value: 'manual',
        description: 'How credits are restored during booking cancellations (manual, auto, prorated).',
    },
    'pricing.service_renewal_days': {
        value: 30,
        description: 'Default renewal period for services.',
    },
    'notifications.radius_row1_mins': {
        value: 5,
        description: 'Notification time window for row 1 (minutes).',
    },
    'notifications.radius_row1_km': {
        value: 2,
        description: 'Notification radius for row 1 (kilometers).',
    },
    'notifications.radius_row2_mins': {
        value: 10,
        description: 'Notification time window for row 2 (minutes).',
    },
    'notifications.radius_row2_km': {
        value: 5,
        description: 'Notification radius for row 2 (kilometers).',
    },
    'notifications.radius_row3_mins': {
        value: 15,
        description: 'Notification time window for row 3 (minutes).',
    },
    'notifications.radius_row3_km': {
        value: 10,
        description: 'Notification radius for row 3 (kilometers).',
    },
    'pricing.booking_gst_percent': {
        value: 18,
        description: 'GST percentage applied to booking total price.',
    },
};

module.exports = {
    DEFAULT_SETTINGS,
};
