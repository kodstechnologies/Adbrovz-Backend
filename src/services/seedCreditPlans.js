require('dotenv').config();
const mongoose = require('mongoose');
const CreditPlan = require('../models/CreditPlan.model');
const config = require('../config/env');

const seedCreditPlans = async () => {
    try {
        await mongoose.connect(config.MONGODB_URI);
        console.log('Connected to MongoDB');

        const plans = [
            {
                name: 'Basic',
                price: 500,
                validityDays: 30,
                dailyLimit: 5,
                description: 'Basic plan with 5 service calls per day'
            },
            {
                name: 'Pro',
                price: 1000,
                validityDays: 30,
                dailyLimit: 10,
                description: 'Professional plan with 10 service calls per day'
            },
            {
                name: 'Elite',
                price: 2000,
                validityDays: 30,
                dailyLimit: 15,
                description: 'Elite plan with 15 service calls per day'
            }
        ];

        for (const planData of plans) {
            await CreditPlan.findOneAndUpdate(
                { name: planData.name },
                planData,
                { upsert: true, new: true }
            );
            console.log(`✅ Seeded/Updated Credit Plan: ${planData.name}`);
        }

        console.log('\n✅ Credit Plans seeding completed!');
        process.exit(0);
    } catch (error) {
        console.error('Error seeding Credit Plans:', error);
        process.exit(1);
    }
};

seedCreditPlans();
