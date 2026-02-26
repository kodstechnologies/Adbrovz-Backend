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
    'bookings.vendor_search_radius_km': {
        value: 5,
        description: 'Primary radius for searching vendors around a location.',
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
    'pricing.vendor_base_membership_fee': {
        value: 1000,
        description: 'Base global membership fee for vendors.',
    },
    'pricing.travel_charge': {
        value: 50,
        description: 'Base travel fee applied when a vendor marks arrived.',
    },
    'pricing.travel_charge_per_km': {
        value: 10,
        description: 'Additional charge per kilometer beyond free tier.',
    },
    'pricing.travel_charge_free_tier_km': {
        value: 5,
        description: 'Distance in KM up to which no travel charge is applied.',
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
};

module.exports = {
    DEFAULT_SETTINGS,
};
