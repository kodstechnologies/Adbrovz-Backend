const Vendor = require('../../models/Vendor.model');
const Subcategory = require('../../models/Subcategory.model');
const Category = require('../../models/Category.model');
const CreditPlan = require('../../models/CreditPlan.model');
const Service = require('../../models/Service.model');
const ServiceType = require('../../models/ServiceType.model');
const PaymentRecord = require('../../models/PaymentRecord.model');
const ApiError = require('../../utils/ApiError');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const config = require('../../config/env');
const { emitToVendor } = require('../../socket');

/**
 * Helper to map duration (3, 6, 12 months) to CreditPlan names
 */
const getPlanByDuration = async (months) => {
    const targetDays = months * 30;

    // 1. Try to find by explicit validity days (most accurate)
    let plan = await CreditPlan.findOne({ validityDays: targetDays }).lean();

    // 2. Fallback to name-based lookup if duration-based fails
    if (!plan) {
        let planName = 'Basic';
        if (months === 6) planName = 'Pro';
        if (months === 12) planName = 'Elite';
        plan = await CreditPlan.findOne({ name: planName }).lean();
    }

    if (!plan) {
        // Since we're removing static values, we must throw an error if not found in DB
        const ApiError = require('../../utils/ApiError');
        throw new ApiError(400, `Membership plan for ${months} months is not configured in the Admin Panel. Please contact support.`);
    }

    return {
        id: plan._id,
        name: plan.name,
        price: Number(plan.price),
        validityDays: Number(plan.validityDays)
    };
};

/**
 * Helper to parse array inputs that might be sent as malformed strings
 */
const parseArrayInput = (input) => {
    if (!input) return [];

    // Convert to string to handle concatenated or multiline junk
    const str = String(input);

    // 1. If it contains MongoDB-style ObjectIDs, extract them all directly
    const idMatches = str.match(/[a-fA-F0-9]{24}/g);
    if (idMatches && idMatches.length > 0) {
        return [...new Set(idMatches)];
    }

    // 2. Fallback for non-ID fields
    const cleaned = str.replace(/[\[\]\n\r'"+\s]/g, '');
    if (!cleaned) return [];

    return cleaned.split(',').filter(s => s.length > 0);
};

/**
 * Helper to canonicalize status strings (e.g. "Reject", "reject", "Verified") to match schema enums
 */
const canonicalizeStatus = (status) => {
    if (!status) return 'pending';
    const s = String(status).toLowerCase().trim();
    if (s.startsWith('reject')) return 'rejected';
    if (s.startsWith('approve') || s.startsWith('verify') || s === 'verified') return 'approved';
    return s;
};

// Lazy init — avoids crash on startup when RAZORPAY keys are not set
const getRazorpay = () => {
    if (!config.RAZORPAY_KEY_ID || !config.RAZORPAY_KEY_SECRET) {
        const ApiError = require('../../utils/ApiError');
        throw new ApiError(500, 'Razorpay credentials are not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env');
    }
    return new Razorpay({
        key_id: config.RAZORPAY_KEY_ID,
        key_secret: config.RAZORPAY_KEY_SECRET,
    });
};

/**
 * Internal helper to calculate membership fees consistently across APIs
 */
const _calculateMembershipAmounts = async ({ vendorId, durationMonths, categoryId, subcategoryIds, serviceTypeIds, serviceIds }) => {
    let vendor = null;
    if (vendorId) {
        vendor = await Vendor.findById(vendorId).lean();
    }

    const months = Number(durationMonths || vendor?.membership?.durationMonths || 3);
    const plan = await getPlanByDuration(months);
    const baseFee = Number(plan.price || 0);

    let items = {
        category: null,
        subcategories: [],
        serviceTypes: [],
        services: []
    };

    // 1. Resolve All Categories
    const catIds = [...new Set([
        ...(categoryId ? [categoryId] : []),
        ...(vendor?.selectedCategories?.map(id => id.toString()) || []),
        ...(vendor?.membership?.category ? [vendor.membership.category.toString()] : [])
    ])];
    if (catIds.length > 0) items.categories = await Category.find({ _id: { $in: catIds } }).lean();

    // 2. Resolve Subcategories
    const subIds = parseArrayInput(subcategoryIds || vendor?.selectedSubcategories);
    if (subIds.length > 0) items.subcategories = await Subcategory.find({ _id: { $in: subIds } }).lean();

    // 3. Resolve Service Types
    const typeIds = parseArrayInput(serviceTypeIds || vendor?.selectedServiceTypes);
    if (typeIds.length > 0) items.serviceTypes = await ServiceType.find({ _id: { $in: typeIds } }).lean();

    // 4. Resolve Services
    const svcIds = parseArrayInput(serviceIds || vendor?.selectedServices);
    if (svcIds.length > 0) items.services = await Service.find({ _id: { $in: svcIds } }).lean();

    // Platform Part (Subtotal for "Platform Membership Fee")
    let platformSubtotal = 0;
    if (items.categories.length > 0) items.categories.forEach(c => platformSubtotal += Number(c.serviceCharge || 0));
    items.subcategories.forEach(s => platformSubtotal += Number(s.serviceCharge || 0));
    items.serviceTypes.forEach(t => platformSubtotal += Number(t.serviceCharge || 0));
    items.services.forEach(s => platformSubtotal += Number(s.serviceCharge || 0));

    // Membership component (Base Plan + Platform Charges)
    const membershipBasePart = baseFee + platformSubtotal;
    const membershipGst = Math.round(membershipBasePart * 0.18);
    const membershipTotal = membershipBasePart + membershipGst; // This is the "₹24" part in screenshot

    // Service Selection Part (Subtotal for "Service Selections Total")
    let servicesSubtotal = 0;
    if (items.categories.length > 0) items.categories.forEach(c => servicesSubtotal += Number(c.membershipCharge || 0));
    items.subcategories.forEach(s => servicesSubtotal += (Number(s.membershipCharge || s.price || 0)));
    items.serviceTypes.forEach(t => servicesSubtotal += Number(t.membershipCharge || 0));
    items.services.forEach(s => servicesSubtotal += Number(s.membershipCharge || 0));

    // Grand Calculation (Following UI logic from screenshot)
    const combinedSubtotal = membershipTotal + servicesSubtotal; // 24 + 159 = 183
    const finalGst = Math.round(combinedSubtotal * 0.18); // 18% of 183 = 33
    const grandTotal = combinedSubtotal + finalGst; // 216

    return {
        basePlanFee: baseFee,
        platformSubtotal,
        membershipTotal, // Treated as component in UI
        servicesSubtotal, // "Service Selections Total"
        combinedSubtotal,
        finalGst,
        grandTotal,
        durationMonths: months,
        validityDays: plan.validityDays,
        itemBreakdown: [
            ...items.categories.map(c => ({ id: c._id, title: c.name, type: 'category', serviceCharge: c.serviceCharge, membershipCharge: c.membershipCharge })),
            ...items.subcategories.map(s => ({ id: s._id, title: s.name, type: 'subcategory', serviceCharge: s.serviceCharge, membershipCharge: s.membershipCharge || s.price })),
            ...items.serviceTypes.map(t => ({ id: t._id, title: t.name, type: 'serviceType', serviceCharge: t.serviceCharge, membershipCharge: t.membershipCharge })),
            ...items.services.map(s => ({ id: s._id, title: s.title, type: 'service', serviceCharge: s.serviceCharge, membershipCharge: s.membershipCharge }))
        ]
    };
};

/**
 * Get all vendors
 * @returns {Promise<Array>} List of vendors
 */
const getAllVendors = async () => {
    return await Vendor.find()
        .populate('membership.category', 'name serviceCharge membershipCharge renewalCharge membershipRenewalCharge membershipFee')
        .populate('creditPlan.planId', 'name')
        .populate('selectedCategories', 'name serviceCharge membershipCharge renewalCharge membershipRenewalCharge membershipFee')
        .populate({
            path: 'selectedSubcategories',
            select: 'name serviceCharge price membershipFee membershipCharge renewalCharge serviceRenewalCharge membershipRenewalCharge category',
            populate: { 
                path: 'category', 
                select: 'name serviceCharge membershipCharge membershipFee' 
            }
        })
        .populate({
            path: 'selectedServiceTypes',
            select: 'name serviceCharge category subcategory',
            populate: [
                { path: 'category', select: 'name serviceCharge membershipCharge membershipFee' },
                { path: 'subcategory', select: 'name serviceCharge membershipCharge membershipFee' }
            ]
        })
        .populate({
            path: 'selectedServices',
            select: 'title serviceCharge membershipFee membershipCharge renewalCharge serviceRenewalCharge subcategory category serviceType',
            populate: [
                { path: 'category', select: 'name serviceCharge membershipCharge membershipFee' },
                { path: 'subcategory', select: 'name serviceCharge membershipCharge membershipFee' },
                { path: 'serviceType', select: 'name serviceCharge membershipCharge' }
            ]
        })
        .populate({
            path: 'categorySubscriptions.category',
            select: 'name membershipCharge membershipFee'
        })
        .sort({ createdAt: -1 });
};

/**
 * Get membership info for registration
 */
const getMembershipInfo = async ({ serviceIds, subcategoryIds, categoryId, durationMonths, vendorId }) => {
    const calc = await _calculateMembershipAmounts({
        vendorId,
        durationMonths,
        categoryId,
        subcategoryIds,
        serviceIds
    });

    const plansInfo = await getMembershipPlans(calc.platformSubtotal);

    return {
        vendorId,
        subtotal: calc.membershipTotal, // UI expects membership total as the platform part
        basePlanFee: calc.basePlanFee,
        totalServiceFee: calc.platformSubtotal,
        gstPercent: 18,
        gstAmount: calc.finalGst, // Total GST for the grand payment
        totalFee: calc.grandTotal,  // Full 216 amount
        duration: `${calc.validityDays} days`,
        durationMonths: calc.durationMonths,
        plans: plansInfo,
        services: calc.itemBreakdown,
        serviceSelectionsTotal: calc.servicesSubtotal
    };
};

/**
 * Get membership details for a specific vendor based on their saved selectedServices
 */
const getVendorMembershipDetails = async (vendorId, overrides = {}) => {
    const calc = await _calculateMembershipAmounts({
        vendorId,
        durationMonths: overrides.durationMonths,
        categoryId: overrides.categoryId,
        subcategoryIds: overrides.subcategoryIds,
        serviceTypeIds: overrides.serviceTypeIds,
        serviceIds: overrides.serviceIds
    });

    const plansInfo = await getMembershipPlans(calc.platformSubtotal);

    return {
        vendorId,
        subtotal: calc.membershipTotal,
        basePlanFee: calc.basePlanFee,
        totalServiceFee: calc.platformSubtotal,
        gstPercent: 18,
        gstAmount: calc.finalGst,
        totalFee: calc.grandTotal,
        duration: `${calc.validityDays} days`,
        durationMonths: calc.durationMonths,
        plans: plansInfo,
        services: calc.itemBreakdown,
        serviceSelectionsTotal: calc.servicesSubtotal
    };
};

/**
 * Create Razorpay order for membership payment
 * vendorId is extracted from token (req.user), NOT from URL
 */
const createMembershipOrder = async (vendorId, { durationMonths, amount } = {}) => {
    const vendor = await Vendor.findById(vendorId);
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    // Update durationMonths if provided
    if (durationMonths) {
        vendor.membership.durationMonths = Number(durationMonths);
        await vendor.save();
    }

    // Calculate full fee using the centralized helper
    const calc = await _calculateMembershipAmounts({ vendorId, durationMonths });
    const totalFee = calc.grandTotal;

    if (totalFee <= 0) {
        throw new ApiError(400, 'Membership fee must be greater than 0');
    }

    // Razorpay amount is in paise (multiply by 100)
    let razorpayOrder;
    try {
        razorpayOrder = await getRazorpay().orders.create({
            amount: Math.round(totalFee * 100),
            currency: 'INR',
            receipt: `m_${vendor._id.toString().slice(-10)}_${Date.now()}`,
            notes: {
                vendorId: vendor._id.toString(),
                vendorName: vendor.name,
                purpose: 'membership',
            },
        });
    } catch (error) {
        console.error('Razorpay Order Creation Error:', error);
        const errorMsg = error.error?.description || error.message || 'Failed to create payment order with Razorpay';
        throw new ApiError(400, `Payment Error: ${errorMsg}`);
    }

    return {
        vendorId: vendor._id,
        vendorName: vendor.name,
        totalFee,
        duration: `${calc.validityDays} days`,
        status: razorpayOrder.status,  // 'created'
        razorpayKeyId: config.RAZORPAY_KEY_ID,
        razorpayOrder: {
            id: razorpayOrder.id,
            amount: razorpayOrder.amount,
            amountInRupees: razorpayOrder.amount / 100,
            currency: razorpayOrder.currency,
            receipt: razorpayOrder.receipt,
            status: razorpayOrder.status,
        },
        services: calc.itemBreakdown,
        serviceSelectionsTotal: calc.servicesSubtotal
    };
};

/**
 * Step 2: Select services and calculate membership fee
 * Accepts all field name variations from the app frontend:
 *   categoryId / selectedCategory
 *   subcategoryIds / selectedSubcategories
 *   serviceTypeIds / selectedType / selectedServiceTypes
 *   serviceIds / selectedService / selectedServices
 */
const selectServices = async (vendorId, body) => {
    const vendor = await Vendor.findById(vendorId);
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    // Normalize field names — accept every variation the frontend might send
    const categoryId = body.categoryId || body.selectedCategory || body.category;
    const subcategoryIds = body.subcategoryIds || body.selectedSubcategories || body.subcategories;
    const serviceTypeIds = body.serviceTypeIds || body.selectedType || body.selectedServiceTypes || body.serviceTypes;
    const serviceIds = body.serviceIds || body.selectedService || body.selectedServices || body.services;
    const durationMonths = Number(body.durationMonths || 3);

    console.log('[selectServices] Normalized inputs:', {
        categoryId,
        subcategoryIds,
        serviceTypeIds,
        serviceIds,
        durationMonths
    });

    if (durationMonths % 3 !== 0) {
        throw new ApiError(400, 'Duration must be in multiples of 3 months');
    }

    // Save Selections to Vendor
    if (categoryId) {
        const category = await Category.findById(categoryId);
        if (category) {
            vendor.membership.category = category._id;
            const catIdStr = String(category._id);
            if (!vendor.selectedCategories.map(id => String(id)).includes(catIdStr)) {
                vendor.selectedCategories.push(category._id);
            }
        }
    }

    if (subcategoryIds) {
        vendor.selectedSubcategories = parseArrayInput(subcategoryIds);
    }
    if (serviceTypeIds) {
        vendor.selectedServiceTypes = parseArrayInput(serviceTypeIds);
    }
    if (serviceIds) {
        vendor.selectedServices = parseArrayInput(serviceIds);
    }

    // Use centralized calculator for response
    const calc = await _calculateMembershipAmounts({
        vendorId,
        durationMonths,
        categoryId,
        subcategoryIds,
        serviceTypeIds,
        serviceIds
    });

    // Update vendor with calculation result
    vendor.membership.fee = calc.grandTotal;
    vendor.membership.durationMonths = durationMonths;
    vendor.membership.subtotal = calc.combinedSubtotal;
    vendor.membership.gstAmount = calc.finalGst;
    vendor.registrationStep = 'SERVICES_SELECTED';

    await vendor.save();

    return {
        totalPrice: calc.grandTotal,
        durationMonths,
        membershipTotal: calc.membershipTotal,
        serviceSelectionsTotal: calc.servicesSubtotal,
        gstAmount: calc.finalGst,
        itemBreakdown: calc.itemBreakdown
    };
};

/**
 * Step 3: Purchase Membership (Demo)
 */
const purchaseMembership = async (vendorId) => {
    const vendor = await Vendor.findById(vendorId);
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    if (vendor.registrationStep !== 'SERVICES_SELECTED' && vendor.registrationStep !== 'PENDING') {
        throw new ApiError(400, 'Please select services before purchasing membership');
    }

    if (vendor.isVerified) {
        vendor.membership.startDate = new Date();
        const adminService = require('../admin/admin.service');
        const durationMonths = vendor.membership.durationMonths || 3;
        const plan = await getPlanByDuration(durationMonths);
        const validityDays = plan.validityDays || (durationMonths * 30);

        const now = new Date();
        const baseMemDate = (vendor.membership.expiryDate && vendor.membership.expiryDate > now)
            ? vendor.membership.expiryDate
            : now;
        const expiryDate = new Date(baseMemDate);
        expiryDate.setDate(expiryDate.getDate() + Number(validityDays));
        vendor.membership.expiryDate = expiryDate;

        vendor.serviceRenewal = vendor.serviceRenewal || {};
        vendor.serviceRenewal.startDate = vendor.serviceRenewal.startDate || now;
        const baseRenDate = (vendor.serviceRenewal.expiryDate && vendor.serviceRenewal.expiryDate > now)
            ? vendor.serviceRenewal.expiryDate
            : now;
        const renExpiry = new Date(baseRenDate);
        renExpiry.setDate(renExpiry.getDate() + 30);
        vendor.serviceRenewal.expiryDate = renExpiry;

        vendor.registrationStep = 'COMPLETED';
    } else {
        vendor.registrationStep = 'MEMBERSHIP_PAID';
    }

    // Ensure membership metadata is populated if missing
    if (!vendor.membership.fee || !vendor.membership.category) {
        try {
            const memDetails = await getVendorMembershipDetails(vendorId);
            if (!vendor.membership.fee) vendor.membership.fee = memDetails.totalFee;
            if (!vendor.membership.category && memDetails.services.length > 0) {
                const Service = require('../../models/Service.model');
                const Subcategory = require('../../models/Subcategory.model');
                const firstItem = memDetails.services[0];
                if (firstItem.type === 'subcategory') {
                    const sub = await Subcategory.findById(firstItem.id).select('category');
                    vendor.membership.category = sub?.category;
                } else {
                    const svc = await Service.findById(firstItem.id).select('category');
                    vendor.membership.category = svc?.category;
                }
            }
        } catch (err) {
            console.error('Error auto-populating membership metadata:', err.message);
        }
    }

    await vendor.save();

    return {
        message: vendor.isVerified
            ? 'Membership payment successful. Your plan is now active.'
            : 'Membership payment successful. Your account is being reviewed by Admin. Plan will start once verified.'
    };
};

/**
 * Get available membership plans (3, 6, 12 months) from settings
 */
const getMembershipPlans = async (serviceMembershipFee = 0) => {
    const adminService = require('../admin/admin.service');
    const tiers = await CreditPlan.find({
        name: { $in: ['Basic', 'Pro', 'Elite'] }
    }).lean();

    const planConfigs = [
        { duration: 3, name: 'Basic' },
        { duration: 6, name: 'Pro' },
        { duration: 12, name: 'Elite' }
    ];
    const gstPercent = await adminService.getSetting('pricing.membership_gst_percent') || 0;

    const result = [];
    for (const config of planConfigs) {
        const plan = tiers.find(t => t.name === config.name) || {
            price: config.duration === 3 ? 1000 : (config.duration === 6 ? 2000 : 4000),
            validityDays: config.duration * 30
        };

        const baseFee = plan.price || 0;
        const validityDays = plan.validityDays || (config.duration * 30);
        const serviceFee = Number(serviceMembershipFee);

        const subtotal = baseFee + serviceFee;
        const gstAmount = Math.round(subtotal * (gstPercent / 100));
        const totalFee = Number(subtotal + gstAmount);

        result.push({
            durationMonths: config.duration,
            label: `${config.name} (${validityDays} Days)`,
            baseFee,
            ServiceFee: serviceFee,
            validityDays: Number(validityDays),
            gstAmount,
            totalFee,
            gstPercent
        });
    }

    return result;
};

/**
 * Get all categories with subcategories and services (Registration Menu)
 */
const getCategoryRegistrationData = async () => {
    const categories = await Category.find().lean();
    const subcategories = await Subcategory.find().lean();
    const services = await Service.find().lean();

    return categories.map(cat => {
        const catSubcategories = subcategories
            .filter(sub => sub.category && sub.category.toString() === cat._id.toString())
            .map(sub => {
                const subServices = services
                    .filter(svc => svc.subcategory && svc.subcategory.toString() === sub._id.toString())
                    .map(svc => ({
                        id: svc._id,
                        name: svc.title,
                        membershipFee: svc.membershipFee || 0
                    }));

                return {
                    id: sub._id,
                    name: sub.name,
                    membershipFee: sub.price || 0,
                    serviceRenewalCharge: sub.serviceRenewalCharge || 0,
                    renewalCharge: sub.renewalCharge || 0,
                    services: subServices
                };
            });

        const catServices = services
            .filter(svc => svc.category && svc.category.toString() === cat._id.toString() && !svc.subcategory)
            .map(svc => ({
                id: svc._id,
                name: svc.title,
                membershipFee: svc.membershipFee || 0
            }));

        return {
            id: cat._id,
            name: cat.name,
            membershipFee: 0,
            serviceRenewalCharge: cat.serviceRenewalCharge || 0,
            renewalCharge: cat.renewalCharge || 0,
            subcategories: catSubcategories,
            services: catServices
        };
    });
};

/**
 * Get categories available for purchase (Excluding already selected ones)
 */
const getAvailablePurchaseCategories = async (vendorId) => {
    const vendor = await Vendor.findById(vendorId).select('selectedCategories');
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    const allCategories = await Category.find({}).lean();
    const allSubcategories = await Subcategory.find({}).lean();
    const allServices = await Service.find({}).lean();
    const allServiceTypes = await ServiceType.find({}).lean();

    const selectedCategoryIds = (vendor.selectedCategories || []).map(id => id.toString());

    return allCategories
        .filter(cat => !selectedCategoryIds.includes(cat._id.toString()))
        .map(cat => {
            const catIdStr = cat._id.toString();
            
            // Start with category's own service charge
            let totalSvcCharge = Number(cat.serviceCharge || 0);
            
            // Add all subcategories' service charges
            allSubcategories
                .filter(sub => sub.category && sub.category.toString() === catIdStr)
                .forEach(sub => {
                    totalSvcCharge += Number(sub.serviceCharge || 0);
                });
                
            // Add all service types' service charges
            allServiceTypes
                .filter(st => st.category && st.category.toString() === catIdStr)
                .forEach(st => {
                    totalSvcCharge += Number(st.serviceCharge || 0);
                });
                
            // Add all services' service charges
            allServices
                .filter(svc => svc.category && svc.category.toString() === catIdStr)
                .forEach(svc => {
                    totalSvcCharge += Number(svc.serviceCharge || 0);
                });

            // Calculate GST consistent with getAddCategoryFeeDetails (18%)
            const gstAmount = Math.round(totalSvcCharge * 0.18);
            const totalWithGst = totalSvcCharge + gstAmount;

            return {
                id: cat._id,
                name: cat.name,
                amount: totalWithGst
            };
        });
};

/**
 * Internal helper to format verification status payload for both API and Socket responses
 */
const _getVerificationPayload = (vendor) => {
    const docTypesFields = ['photo', 'idProof', 'addressProof', 'workProof', 'bankProof', 'policeVerification'];
    const documentStatuses = {};
    docTypesFields.forEach(doc => {
        const d = vendor.documents?.[doc];
        documentStatuses[doc] = {
            status: (d && typeof d === 'object') ? (d.status || 'pending') : 'pending',
            reason: (d && typeof d === 'object') ? (d.reason || null) : null,
            url: (d && typeof d === 'object') ? (d.url || '') : (typeof d === 'string' ? d : '')
        };
    });

    return {
        isVerified: vendor.isVerified,
        documentStatus: vendor.documentStatus,
        registrationStep: vendor.registrationStep,
        isSuspended: vendor.isSuspended,
        documents: documentStatuses,
        status: vendor.status // Uses the virtual status
    };
};

/**
 * Admin: Verify Vendor Document
 */
const verifyDocument = async (vendorId, { docType, status, reason }) => {
    const vendor = await Vendor.findById(vendorId);
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    // Migrate ALL documents to object structure if they are strings (Database Cleanup)
    const docTypes = ['photo', 'idProof', 'addressProof', 'workProof', 'bankProof', 'policeVerification'];
    docTypes.forEach(type => {
        const val = vendor.documents[type];
        if (typeof val === 'string' && val !== undefined) {
            vendor.set(`documents.${type}`, { url: val, status: 'pending' });
        }
    });

    // Apply the specific verification update (normalized to lowercase)
    const lowerStatus = canonicalizeStatus(status);
    const currentDoc = vendor.documents[docType]; // Now guaranteed to be object or migrated
    // Map 'approved' to 'verified' for internal consistency if needed
    const isApprovedOrVerified = lowerStatus === 'approved';
    const newReason = isApprovedOrVerified ? null : (reason || (vendor.documents[docType]?.reason) || null);

    const url = (currentDoc && typeof currentDoc === 'object' ? currentDoc.url : (typeof currentDoc === 'string' ? currentDoc : '')) || '';

    // Use vendor.set for deep object persistence reliability
    vendor.set(`documents.${docType}`, {
        url,
        status: lowerStatus,
        reason: newReason
    });

    // CRITICAL: Ensure Mongoose detects the change in the nested 'documents' object
    vendor.markModified('documents');

    // Check if any document is explicitly rejected
    const allDocTypes = ['photo', 'idProof', 'addressProof', 'workProof', 'bankProof', 'policeVerification'];
    const hasRejectedDocs = allDocTypes.some(doc => {
        const d = vendor.documents[doc];
        // Use canonicalizeStatus to handle variations like 'Reject', 'rejected', etc.
        return d && typeof d === 'object' && canonicalizeStatus(d.status) === 'rejected';
    });

    // Check if all required documents (photo, idProof, addressProof) are verified or approved
    const requiredDocs = ['photo', 'idProof', 'addressProof'];
    const allRequiredVerified = requiredDocs.every(doc => {
        const d = vendor.documents[doc];
        return d && typeof d === 'object' && (d.status === 'verified' || d.status === 'approved');
    });

    console.log(`DEBUG Check: Vendor ${vendorId} - Doc: ${docType} -> ${status}. All Req Verified: ${allRequiredVerified}, Has Rejections: ${hasRejectedDocs}`);

    let message;

    if (lowerStatus === 'rejected') {
        vendor.isVerified = false;
        vendor.documentStatus = 'rejected';
        message = `Your ${docType} has been rejected. Reason: ${reason || 'Please provide a valid document.'}`;
    } else if (hasRejectedDocs) {
        vendor.isVerified = false;
        vendor.documentStatus = 'rejected';
        message = `Your ${docType} has been ${lowerStatus}.`;
    } else if (allRequiredVerified) {
        vendor.isVerified = true;
        vendor.documentStatus = 'approved';
        message = "Congratulations! Your account is now fully verified.";

        // Set registrationStep and startDate IF already paid or moved past selection
        const hasPaid = ['MEMBERSHIP_PAID', 'PLAN_PAID', 'SERVICES_SELECTED'].includes(vendor.registrationStep) || vendor.membership?.expiryDate;

        if (hasPaid && vendor.registrationStep !== 'COMPLETED') {
            const startDate = new Date();
            const durationMonths = vendor.membership.durationMonths || 3;
            const expiryDate = new Date();
            expiryDate.setMonth(expiryDate.getMonth() + durationMonths);

            vendor.membership.startDate = vendor.membership.startDate || startDate;
            vendor.membership.expiryDate = vendor.membership.expiryDate || expiryDate;

            vendor.serviceRenewal = vendor.serviceRenewal || {};
            vendor.serviceRenewal.startDate = vendor.serviceRenewal.startDate || startDate;
            const renExpiryDate = new Date();
            renExpiryDate.setDate(renExpiryDate.getDate() + 30);
            vendor.serviceRenewal.expiryDate = vendor.serviceRenewal.expiryDate || renExpiryDate;

            vendor.registrationStep = 'COMPLETED';
        }
    } else {
        vendor.isVerified = false;
        // Keep as pending if not all required docs are approved/verified
        vendor.documentStatus = 'pending';
        message = `Your ${docType} has been ${lowerStatus}.`;
    }

    await vendor.save();

    const payload = _getVerificationPayload(vendor);
    payload.message = message;

    emitToVendor(vendor._id, 'verification_status_response', payload);

    return {
        vendor,
        message,
        isVerified: vendor.isVerified
    };
};

/**
 * Admin: Verify All Documents
 */
const verifyAllDocuments = async (vendorId) => {
    const vendor = await Vendor.findById(vendorId);
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    const docs = ['photo', 'idProof', 'addressProof', 'workProof', 'bankProof', 'policeVerification'];
    docs.forEach(doc => {
        const val = vendor.documents[doc];
        if (typeof val === 'string' && val) {
            vendor.set(`documents.${doc}`, { url: val, status: 'verified', reason: null });
        } else if (val && typeof val === 'object' && val.url) {
            vendor.set(`documents.${doc}.status`, 'verified');
            vendor.set(`documents.${doc}.reason`, null);
        }
    });

    vendor.markModified('documents');

    vendor.isVerified = true;
    vendor.documentStatus = 'approved';

    // Set registrationStep and startDate IF already paid or moved past selection
    const hasPaid = ['MEMBERSHIP_PAID', 'PLAN_PAID', 'SERVICES_SELECTED'].includes(vendor.registrationStep) || vendor.membership?.expiryDate;

    if (hasPaid && vendor.registrationStep !== 'COMPLETED') {
        const startDate = new Date();
        const durationMonths = vendor.membership.durationMonths || 3;
        const expiryDate = new Date();
        expiryDate.setMonth(expiryDate.getMonth() + durationMonths);

        vendor.membership.startDate = vendor.membership.startDate || startDate;
        vendor.membership.expiryDate = vendor.membership.expiryDate || expiryDate;

        vendor.serviceRenewal = vendor.serviceRenewal || {};
        vendor.serviceRenewal.startDate = vendor.serviceRenewal.startDate || startDate;
        const renExpiryDate = new Date();
        renExpiryDate.setDate(renExpiryDate.getDate() + 30);
        vendor.serviceRenewal.expiryDate = vendor.serviceRenewal.expiryDate || renExpiryDate;

        vendor.registrationStep = 'COMPLETED';
    }

    await vendor.save();

    const message = "Account is now fully verified via Admin 'Verify All' action!";
    const payload = _getVerificationPayload(vendor);
    payload.message = message;

    emitToVendor(vendor._id, 'verification_status_response', payload);

    return {
        vendor,
        message,
        isVerified: vendor.isVerified
    };
};

/**
 * Admin: Toggle Suspension
 */
const toggleVendorSuspension = async (vendorId, { isSuspended }) => {
    const vendor = await Vendor.findById(vendorId);
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    vendor.isSuspended = isSuspended;
    await vendor.save();

    const message = isSuspended ? 'Your account has been suspended.' : 'Your account has been reactivated.';
    const payload = _getVerificationPayload(vendor);
    payload.message = message;

    emitToVendor(vendor._id, 'verification_status_response', payload);

    return vendor;
};

/**
 * Admin: Reject Vendor (Account Level)
 */
const rejectVendorAccount = async (vendorId, { reason }) => {
    const vendor = await Vendor.findById(vendorId);
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    vendor.isVerified = false;
    vendor.documentStatus = 'rejected';

    const docTypes = ['photo', 'idProof', 'addressProof', 'workProof', 'bankProof', 'policeVerification'];

    // Always set ALL document slots to rejected (whether they have URLs or not)
    // This ensures the status virtual correctly returns 'REJECTED' regardless of upload state
    docTypes.forEach(type => {
        const val = vendor.documents[type];
        let existingUrl = '';

        if (typeof val === 'string') {
            existingUrl = val || '';
        } else if (val && typeof val === 'object') {
            existingUrl = val.url || '';
        }

        vendor.set(`documents.${type}`, {
            url: existingUrl,
            status: 'rejected',
            reason: reason || 'Account rejected by admin'
        });
    });

    vendor.markModified('documents');
    await vendor.save();

    const message = `Your account has been rejected. Reason: ${reason || 'No reason provided'}`;
    const payload = _getVerificationPayload(vendor);
    payload.message = message;

    emitToVendor(vendor._id, 'verification_status_response', payload);

    return vendor;
};

/**
 * Admin: Verify Vendor (Legacy/Fallback)
 */
const verifyVendor = async (vendorId, { status, documentStatus, reason }) => {
    // Admin panel sends { documentStatus: 'approved' }, fallback to status
    const effectiveStatus = status || documentStatus;
    if (effectiveStatus === 'approved') return await verifyAllDocuments(vendorId);
    return await rejectVendorAccount(vendorId, { reason });
};

/**
 * Step 4: Purchase Credit Plan (Demo/Production)
 */
const purchaseCreditPlan = async (vendorId, { planId }) => {
    const vendor = await Vendor.findById(vendorId);
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    if (!vendor.isVerified) {
        throw new ApiError(400, 'Your documents must be verified by Admin before purchasing a credit plan');
    }

    if (vendor.registrationStep !== 'COMPLETED') {
        throw new ApiError(400, 'Please complete your registration before purchasing a credit plan');
    }

    const plan = await CreditPlan.findById(planId);
    if (!plan) throw new ApiError(404, 'Credit plan not found');

    vendor.creditPlan = {
        planId: plan._id,
        expiryDate: new Date(Date.now() + plan.validityDays * 24 * 60 * 60 * 1000),
        dailyLimit: plan.dailyLimit || 5,
    };

    await vendor.save();

    return { message: 'Credit plan purchased successfully. You can now receive lead calls.' };
};

/**
 * Vendor: Toggle Online/Offline Status
 */
const toggleOnlineStatus = async (vendorId, isOnline) => {
    const vendor = await Vendor.findById(vendorId);
    if (!vendor) {
        console.error(`[DB ERROR] Vendor not found with ID: ${vendorId}`);
        throw new ApiError(404, 'Vendor not found');
    }

    if (!vendor.isVerified || vendor.documentStatus !== 'approved') {
        throw new ApiError(403, 'Your account must be approved before going online');
    }

    if (vendor.isSuspended) {
        throw new ApiError(403, 'Your account is suspended. Please contact support.');
    }

    // Fix boolean parsing for string inputs safely
    const targetStatus = isOnline === true || isOnline === 'true';

    // Use findByIdAndUpdate for reliable atomic DB write
    const updated = await Vendor.findByIdAndUpdate(
        vendorId,
        { isOnline: targetStatus },
        { new: true, runValidators: true }
    );

    if (!updated) {
        throw new ApiError(500, 'Failed to update vendor status in database');
    }

    console.log(`[DB SUCCESS] Vendor ${vendorId} (${vendor.vendorID}) isOnline updated to: ${updated.isOnline}`);

    return {
        vendorId: updated._id,
        vendorID: updated.vendorID,
        isOnline: updated.isOnline,
        message: `You are now ${updated.isOnline ? 'online' : 'offline'}`,
    };
};

/**
 * Get vendor profile by ID
 */
const getVendorProfile = async (vendorId) => {
    const vendor = await Vendor.findById(vendorId);
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    // Calculate metrics
    const mongoose = require('mongoose');
    const Booking = require('../../models/Booking.model');
    const vendorIdObj = new mongoose.Types.ObjectId(vendorId);
    
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    const [completedBookingsThisMonth, totalCompletedBookingCounts] = await Promise.all([
        Booking.find({
            vendor: vendorIdObj,
            status: 'completed',
            updatedAt: { $gte: startOfMonth, $lte: endOfMonth }
        }).select('pricing services'),
        Booking.countDocuments({ vendor: vendorIdObj, status: 'completed' })
    ]);

    let monthlyEarnings = 0;
    completedBookingsThisMonth.forEach(booking => {
        if (booking.pricing && booking.pricing.totalPrice) {
            monthlyEarnings += booking.pricing.totalPrice;
        } else if (booking.services && booking.services.length > 0) {
            booking.services.forEach(s => {
                monthlyEarnings += (s.finalPrice || s.adminPrice || 0) * (s.quantity || 1);
            });
        }
    });

    return {
        id: vendor._id,
        image: vendor.documents?.photo?.url || '',
        name: vendor.name,
        mobileNumber: vendor.phoneNumber,
        mail: vendor.email,
        address: vendor.address || '',
        city: vendor.workCity,
        state: vendor.workState,
        zipcode: vendor.zipcode || (vendor.workPincodes && vendor.workPincodes[0]) || '',
        country: vendor.country || 'India',
        coins: vendor.coins || 0,
        isOnline: vendor.isOnline || false,
        monthlyEarnings,
        totalCompletedBookingCounts,
    };
};

/**
 * Update vendor profile
 */
const updateVendorProfile = async (vendorId, profileData) => {
    const vendor = await Vendor.findById(vendorId);
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    // Map input fields to model fields if necessary
    if (profileData.name) vendor.name = profileData.name;
    if (profileData.mobileNumber) vendor.phoneNumber = profileData.mobileNumber;
    if (profileData.mail) vendor.email = profileData.mail;
    if (profileData.address) vendor.address = profileData.address;
    if (profileData.city) vendor.workCity = profileData.city;
    if (profileData.state) vendor.workState = profileData.state;
    if (profileData.zipcode) vendor.zipcode = profileData.zipcode;
    if (profileData.country) vendor.country = profileData.country;

    // Handle image separately via controller/middleware if it's a file
    if (profileData.image) {
        vendor.set('documents.photo.url', profileData.image);
    }

    await vendor.save();

    return getVendorProfile(vendorId);
};

/**
 * Verify Razorpay membership payment signature
 * On success — activates vendor membership
 */
const verifyMembershipPayment = async (vendorId, { razorpay_order_id, razorpay_payment_id, razorpay_signature }) => {
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
        throw new ApiError(400, 'razorpay_order_id, razorpay_payment_id and razorpay_signature are required');
    }

    // Verify signature: HMAC SHA256 of "order_id|payment_id" using key_secret
    const body = `${razorpay_order_id}|${razorpay_payment_id}`;
    const expectedSignature = crypto
        .createHmac('sha256', config.RAZORPAY_KEY_SECRET)
        .update(body)
        .digest('hex');

    if (expectedSignature !== razorpay_signature) {
        throw new ApiError(400, 'Invalid payment signature. Payment verification failed.');
    }

    // Signature valid — activate vendor membership
    const vendor = await Vendor.findById(vendorId);
    if (!vendor) throw new ApiError(404, 'Vendor not found');


    if (vendor.isVerified) {
        const now = new Date();
        vendor.membership.startDate = vendor.membership.startDate || now;
        const expiryDate = new Date(vendor.membership.startDate);
        expiryDate.setMonth(expiryDate.getMonth() + (vendor.membership.durationMonths || 3));
        vendor.membership.expiryDate = expiryDate;

        // Initialize service renewal window
        vendor.serviceRenewal = vendor.serviceRenewal || {};
        vendor.serviceRenewal.startDate = vendor.serviceRenewal.startDate || now;
        const renExpiry = new Date(vendor.serviceRenewal.startDate);
        renExpiry.setDate(renExpiry.getDate() + 30);
        vendor.serviceRenewal.expiryDate = vendor.serviceRenewal.expiryDate || renExpiry;

        // Initialize category subscriptions for registration categories
        if (vendor.selectedCategories && vendor.selectedCategories.length > 0) {
            const categoryExpiry = new Date(now);
            categoryExpiry.setDate(categoryExpiry.getDate() + 30); // Service expires in 1 month (30 days)

            for (const catId of vendor.selectedCategories) {
                const existingSub = vendor.categorySubscriptions.find(s => s.category.toString() === catId.toString());
                if (!existingSub) {
                    const Category = require('../../models/Category.model');
                    const category = await Category.findById(catId).select('membershipCharge membershipFee');
                    const fee = category ? (category.membershipCharge || category.membershipFee || 0) : 0;

                    vendor.categorySubscriptions.push({
                        category: catId,
                        startDate: now,
                        expiryDate: categoryExpiry,
                        fee: fee,
                        status: 'ACTIVE'
                    });
                }
            }
        }

        vendor.registrationStep = 'COMPLETED';
    } else {
        vendor.registrationStep = 'MEMBERSHIP_PAID';
    }

    // Ensure membership metadata is populated if missing
    if (!vendor.membership.fee || !vendor.membership.category) {
        try {
            const memDetails = await getVendorMembershipDetails(vendor._id);
            if (!vendor.membership.fee) vendor.membership.fee = memDetails.totalFee;
            if (!vendor.membership.category && memDetails.services.length > 0) {
                const Service = require('../../models/Service.model');
                const Subcategory = require('../../models/Subcategory.model');
                const firstItem = memDetails.services[0];
                if (firstItem.type === 'subcategory') {
                    const sub = await Subcategory.findById(firstItem.id).select('category');
                    vendor.membership.category = sub?.category;
                } else {
                    const svc = await Service.findById(firstItem.id).select('category');
                    vendor.membership.category = svc?.category;
                }
            }
        } catch (err) {
            console.error('Error auto-populating membership metadata:', err.message);
        }
    }

    await vendor.save();

    // Emit real-time membership activation to vendor via socket
    const docTypes = ['photo', 'idProof', 'addressProof', 'workProof', 'bankProof', 'policeVerification'];
    const documentStatuses = {};
    docTypes.forEach(doc => {
        const d = vendor.documents?.[doc];
        documentStatuses[doc] = {
            status: (d && typeof d === 'object') ? (d.status || 'pending') : 'pending',
            reason: (d && typeof d === 'object') ? (d.reason || null) : null,
        };
    });

    emitToVendor(vendor._id, 'membership_activated', {
        membership: {
            startDate: vendor.membership.startDate,
            expiryDate: vendor.membership.expiryDate,
            durationMonths: vendor.membership.durationMonths || 3,
        },
        documentStatus: vendor.documentStatus,
        isVerified: vendor.isVerified,
        documents: documentStatuses,
        message: 'Membership activated successfully!',
    });

    return {
        success: true,
        message: 'Payment verified. Membership activated successfully.',
        isVerified: vendor.isVerified,
        documentStatus: vendor.documentStatus,
        membership: {
            startDate: vendor.membership.startDate,
            expiryDate: vendor.membership.expiryDate,
            durationMonths: vendor.membership.durationMonths || 3,
            isActive: true,
        },
        payment: {
            razorpay_order_id,
            razorpay_payment_id,
            status: 'paid',
        },
    };
};

/**
 * Get vendor verification status
 */
const getVerificationStatus = async (vendorId) => {
    const vendor = await Vendor.findById(vendorId);
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    return _getVerificationPayload(vendor);
};

/**
 * Delete vendor account
 */
const deleteVendorAccount = async (vendorId) => {
    const vendor = await Vendor.findById(vendorId);
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    const Booking = require('../../models/Booking.model');
    const activeBookingsCount = await Booking.countDocuments({
        vendor: vendorId,
        status: { $in: ['pending', 'on_the_way', 'arrived', 'ongoing'] }
    });

    if (activeBookingsCount > 0) {
        throw new ApiError(400, 'You cannot delete your account while you have active or pending bookings. Please complete or cancel them first.');
    }

    // Clean up related data
    await Booking.deleteMany({ vendor: vendorId, status: { $in: ['cancelled', 'completed'] } });

    await Vendor.findByIdAndDelete(vendorId);

    return { message: 'Account deleted successfully' };
};

/**
 * Get vendor dashboard metrics
 * @param {string} vendorId
 * @returns {Promise<Object>} Dashboard metrics
 */
const getDashboardMetrics = async (vendorId) => {
    const mongoose = require('mongoose');
    const Booking = require('../../models/Booking.model');
    const vendorIdObj = new mongoose.Types.ObjectId(vendorId);

    // Get current month start and end dates
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    // 1. Get vendor credits (coins)
    const vendor = await Vendor.findById(vendorIdObj).select('coins');
    const credits = vendor?.coins || 0;

    // 2. Get pending jobs (Awaiting Confirmation)
    const pendingJobs = await Booking.countDocuments({
        vendor: vendorIdObj,
        status: 'pending_acceptance'
    });

    // 3. Get ongoing jobs (In Progress)
    const ongoingJobs = await Booking.countDocuments({
        vendor: vendorIdObj,
        status: { $in: ['pending', 'on_the_way', 'arrived', 'ongoing'] }
    });

    // 4. Get completed jobs THIS MONTH
    const completedBookingsThisMonth = await Booking.find({
        vendor: vendorIdObj,
        status: 'completed',
        updatedAt: { $gte: startOfMonth, $lte: endOfMonth }
    }).select('pricing services');

    const jobsCompletedThisMonth = completedBookingsThisMonth.length;

    // 5. Calculate earnings THIS MONTH
    let earningsThisMonth = 0;
    completedBookingsThisMonth.forEach(booking => {
        if (booking.pricing && booking.pricing.totalPrice) {
            earningsThisMonth += booking.pricing.totalPrice;
        } else if (booking.services && booking.services.length > 0) {
            // Fallback to summing up service prices
            booking.services.forEach(s => {
                earningsThisMonth += (s.finalPrice || s.adminPrice || 0) * (s.quantity || 1);
            });
        }
    });

    // 6. Job Progress: (Completed This Month / Total Active Jobs This Month) * 100
    const totalActiveBookingsThisMonth = await Booking.countDocuments({
        vendor: vendorIdObj,
        status: { $in: ['pending_acceptance', 'pending', 'on_the_way', 'arrived', 'ongoing', 'completed'] },
        createdAt: { $gte: startOfMonth, $lte: endOfMonth }
    });

    let jobProgress = 0;
    if (totalActiveBookingsThisMonth > 0) {
        jobProgress = Math.round((jobsCompletedThisMonth / totalActiveBookingsThisMonth) * 100);
    }

    return {
        earnings: {
            amount: earningsThisMonth,
            growth: "+0%" // Mock data. Can be updated to calculate real MoM growth later
        },
        jobsCompleted: {
            count: jobsCompletedThisMonth,
            growth: "This Month"
        },
        pendingJobs: {
            count: pendingJobs,
            description: "Awaiting Confirmation"
        },
        ongoingJobs: {
            count: ongoingJobs,
            description: "In Progress"
        },
        credits: {
            amount: credits,
            description: "Available for vendors"
        },
        jobProgress: {
            percentage: jobProgress,
            description: `${jobProgress}% jobs completed this month`
        }
    };
};


/**
 * Vendor: Reupload rejected documents
 */
const reuploadDocuments = async (vendorId, uploadedDocs) => {
    const vendor = await Vendor.findById(vendorId);
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    const docTypes = ['photo', 'idProof', 'addressProof', 'workProof', 'bankProof', 'policeVerification'];
    let updated = false;

    // Normalize keys (mobile might send "Photo" vs "photo")
    const normalizedUploadedDocs = {};
    Object.keys(uploadedDocs).forEach(key => {
        normalizedUploadedDocs[key.toLowerCase()] = uploadedDocs[key];
    });

    // Also update other profile fields if provided
    if (uploadedDocs.name) vendor.name = uploadedDocs.name;
    if (uploadedDocs.email) vendor.email = uploadedDocs.email;
    if (uploadedDocs.address) vendor.address = uploadedDocs.address;
    if (uploadedDocs.workCity) vendor.workCity = uploadedDocs.workCity;
    if (uploadedDocs.workState) vendor.workState = uploadedDocs.workState;
    if (uploadedDocs.zipcode) vendor.zipcode = uploadedDocs.zipcode;

    // Update array fields (workPincodes, categories, subcategories, service types, services)
    if (uploadedDocs.workPincodes) vendor.workPincodes = uploadedDocs.workPincodes;
    if (uploadedDocs.selectedCategories) vendor.selectedCategories = uploadedDocs.selectedCategories;
    if (uploadedDocs.selectedSubcategories) vendor.selectedSubcategories = uploadedDocs.selectedSubcategories;
    if (uploadedDocs.selectedServiceTypes || uploadedDocs.selectedType) vendor.selectedServiceTypes = uploadedDocs.selectedServiceTypes || uploadedDocs.selectedType;
    if (uploadedDocs.selectedServices) vendor.selectedServices = uploadedDocs.selectedServices;

    docTypes.forEach(doc => {
        // Use lowercase check for uploadedDocs keys
        const incomingUrl = normalizedUploadedDocs[doc.toLowerCase()];

        if (incomingUrl) {
            // Update the document URL and change status back to 'pending'
            vendor.set(`documents.${doc}`, {
                url: incomingUrl,
                status: 'pending',
                reason: null
            });
            updated = true;
        }
    });

    if (updated || Object.keys(uploadedDocs).length > 0) {
        vendor.markModified('documents');

        // If there are still rejected documents, keep status rejected, else pending
        const hasRejectedDocs = docTypes.some(type => {
            const d = vendor.documents[type];
            return d && typeof d === 'object' && canonicalizeStatus(d.status) === 'rejected';
        });

        if (hasRejectedDocs) {
            vendor.documentStatus = 'rejected';
        } else {
            vendor.documentStatus = 'pending';
        }

        await vendor.save();
    }

    const payload = _getVerificationPayload(vendor);
    payload.message = "Documents uploaded successfully and are pending verification.";

    emitToVendor(vendor._id, 'verification_status_response', payload);

    return { vendor, isVerified: vendor.isVerified, payload };
};

/**
 * Get Subscription Status for Mobile App
 */
const getSubscriptionStatus = async (vendorId) => {
    const vendor = await Vendor.findById(vendorId).populate('selectedCategories selectedSubcategories selectedServiceTypes selectedServices membership.category');
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    const now = new Date();
    const memExp = vendor.membership?.expiryDate ? new Date(vendor.membership.expiryDate) : null;
    const isMemActive = memExp ? memExp > now : false;

    const renExp = vendor.serviceRenewal?.expiryDate ? new Date(vendor.serviceRenewal.expiryDate) : null;
    const isRenActive = renExp ? renExp > now : false;

    let daysRemaining = 0;
    if (isRenActive) {
        const diff = renExp - now;
        daysRemaining = Math.ceil(diff / (1000 * 60 * 60 * 24));
    }

    // Accumulate all hierarchy IDs
    const categoryIds = new Set();
    const subcategoryIds = new Set();
    const serviceTypeIds = new Set();
    const serviceIds = new Set();

    if (vendor.membership?.category) categoryIds.add(String(vendor.membership.category._id || vendor.membership.category));
    if (vendor.selectedCategories) vendor.selectedCategories.forEach(c => categoryIds.add(String(c._id || c)));
    if (vendor.selectedSubcategories) vendor.selectedSubcategories.forEach(s => subcategoryIds.add(String(s._id || s)));
    if (vendor.selectedServiceTypes) vendor.selectedServiceTypes.forEach(st => serviceTypeIds.add(String(st._id || st)));
    if (vendor.selectedServices) vendor.selectedServices.forEach(s => serviceIds.add(String(s._id || s)));

    const query = { $or: [] };
    if (categoryIds.size > 0) query.$or.push({ category: { $in: Array.from(categoryIds) } });
    if (subcategoryIds.size > 0) query.$or.push({ subcategory: { $in: Array.from(subcategoryIds) } });
    if (serviceTypeIds.size > 0) query.$or.push({ serviceType: { $in: Array.from(serviceTypeIds) } });
    if (serviceIds.size > 0) query.$or.push({ _id: { $in: Array.from(serviceIds) } });

    let finalServices = [];
    if (query.$or.length > 0) {
        const Service = require('../../models/Service.model');
        finalServices = await Service.find(query);
    }

    // Determine the list of services across all levels of hierarchy
    let serviceList = finalServices.map(svc => ({
        serviceId: svc.title,
        isActive: isRenActive,
        daysRemaining: daysRemaining
    }));

    // Remove duplicates by serviceId name if any
    const uniqueMap = new Map();
    serviceList.forEach(s => uniqueMap.set(s.serviceId, s));
    serviceList = Array.from(uniqueMap.values());

    // Summary
    const activeServiceCount = serviceList.filter(s => s.isActive).length;
    const expiredServiceCount = serviceList.filter(s => !s.isActive).length;

    // Permissions
    // Remove documentStatus === 'approved' check if they just want to know if plan allows go-online
    const canGoOnline = isMemActive && isRenActive;

    return {
        membership: {
            isActive: isMemActive
        },
        services: serviceList,
        summary: {
            activeServiceCount,
            expiredServiceCount
        },
        permissions: {
            canGoOnline
        }
    };
};

/**
 * Unified Renewal API: Check both Service Charge and Membership Renewal Charge
 */
const getServiceRenewalFeeDetails = async (vendorId) => {
    const vendor = await Vendor.findById(vendorId)
        .populate('selectedCategories selectedSubcategories membership.category');
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    const categoryIds = new Set();
    const subcategoryIds = new Set();
    const serviceTypeIds = new Set();
    const serviceIds = new Set();

    // Gather IDs from vendor's selections
    if (vendor.selectedCategories) {
        vendor.selectedCategories.forEach(c => categoryIds.add(String(c._id || c)));
    }
    if (vendor.membership?.category) {
        categoryIds.add(String(vendor.membership.category._id || vendor.membership.category));
    }
    if (vendor.selectedSubcategories) {
        vendor.selectedSubcategories.forEach(s => {
            subcategoryIds.add(String(s._id || s));
            if (s.category) categoryIds.add(String(s.category._id || s.category));
        });
    }

    // Capture individual services and their hierarchy
    if (vendor.selectedServices && vendor.selectedServices.length > 0) {
        const fullServices = await Service.find({ _id: { $in: vendor.selectedServices } });
        fullServices.forEach(svc => {
            serviceIds.add(String(svc._id));
            if (svc.serviceType) serviceTypeIds.add(String(svc.serviceType));
            if (svc.subcategory) subcategoryIds.add(String(svc.subcategory));
            if (svc.category) categoryIds.add(String(svc.category));
        });
    }

    const categories = await Category.find({ _id: { $in: Array.from(categoryIds) } });
    const subcategories = await Subcategory.find({ _id: { $in: Array.from(subcategoryIds) } });
    const ServiceType = require('../../models/ServiceType.model');
    const serviceTypes = await ServiceType.find({ _id: { $in: Array.from(serviceTypeIds) } });
    const services = await Service.find({ _id: { $in: Array.from(serviceIds) } });

    // 1. Calculate Service Renewal Fee - include everything that has a charge
    let serviceSubtotal = 0;
    categories.forEach(c => serviceSubtotal += (c.serviceRenewalCharge || c.renewalCharge || 0));
    subcategories.forEach(s => serviceSubtotal += (s.serviceRenewalCharge || s.renewalCharge || 0));
    serviceTypes.forEach(st => serviceSubtotal += (st.serviceRenewalCharge || 0));
    services.forEach(s => serviceSubtotal += (s.serviceRenewalCharge || 0));

    const totalFee = serviceSubtotal;

    // Build breakdown filtering out 0 charges and omitting empty arrays
    const breakdown = {};
    
    const catList = categories.map(c => ({ id: c._id, name: c.name, charge: c.serviceRenewalCharge || c.renewalCharge || 0 })).filter(c => c.charge > 0);
    if (catList.length > 0) breakdown.categories = catList;

    const subList = subcategories.map(s => ({ id: s._id, name: s.name, charge: s.serviceRenewalCharge || s.renewalCharge || 0 })).filter(s => s.charge > 0);
    if (subList.length > 0) breakdown.subcategories = subList;

    const typeList = serviceTypes.map(st => ({ id: st._id, name: st.name, charge: st.serviceRenewalCharge || 0 })).filter(t => t.charge > 0);
    if (typeList.length > 0) breakdown.serviceTypes = typeList;

    const svcList = services.map(s => ({ id: s._id, name: s.title, charge: s.serviceRenewalCharge || 0 })).filter(s => s.charge > 0);
    if (svcList.length > 0) breakdown.services = svcList;

    return {
        vendorId: vendor._id,
        totalFee,
        serviceRenewal: {
            fee: serviceSubtotal,
            expiryDate: vendor.serviceRenewal?.expiryDate || null,
            breakdown
        },
        razorpayKeyId: config.RAZORPAY_KEY_ID
    };
};

/**
 * Membership Renewal: Calculate fee based on duration
 */
const getMembershipRenewalFeeDetails = async (vendorId, { planId, durationMonths } = {}) => {
    const vendor = await Vendor.findById(vendorId)
        .populate('selectedCategories selectedSubcategories membership.category');
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    const adminService = require('../admin/admin.service');
    
    let plan;
    if (planId) {
        const planDoc = await CreditPlan.findById(planId).lean();
        if (!planDoc) throw new ApiError(404, 'Membership plan not found');
        plan = {
            id: planDoc._id,
            name: planDoc.name,
            price: Number(planDoc.price),
            validityDays: Number(planDoc.validityDays)
        };
    } else {
        plan = await getPlanByDuration(Number(durationMonths || 3));
    }

    const basePlanPrice = plan.price;
    const validityDays = plan.validityDays;

    // Gather IDs to calculate hierarchical membership charges
    const categoryIds = new Set();
    const subcategoryIds = new Set();
    const serviceTypeIds = new Set();
    const serviceIds = new Set();

    if (vendor.selectedCategories) {
        vendor.selectedCategories.forEach(c => categoryIds.add(String(c._id || c)));
    }
    if (vendor.membership?.category) {
        categoryIds.add(String(vendor.membership.category._id || vendor.membership.category));
    }
    if (vendor.selectedSubcategories) {
        vendor.selectedSubcategories.forEach(s => {
            subcategoryIds.add(String(s._id || s));
            if (s.category) categoryIds.add(String(s.category._id || s.category));
        });
    }
    if (vendor.selectedServices && vendor.selectedServices.length > 0) {
        const fullServices = await Service.find({ _id: { $in: vendor.selectedServices } });
        fullServices.forEach(svc => {
            serviceIds.add(String(svc._id));
            if (svc.serviceType) serviceTypeIds.add(String(svc.serviceType));
            if (svc.subcategory) subcategoryIds.add(String(svc.subcategory));
            if (svc.category) categoryIds.add(String(svc.category));
        });
    }

    const categories = await Category.find({ _id: { $in: Array.from(categoryIds) } });
    const subcategories = await Subcategory.find({ _id: { $in: Array.from(subcategoryIds) } });
    
    const ServiceType = require('../../models/ServiceType.model');
    const serviceTypes = await ServiceType.find({ _id: { $in: Array.from(serviceTypeIds) } });
    const services = await Service.find({ _id: { $in: Array.from(serviceIds) } });

    // Calculate hierarchical Membership Renewal Fee
    let membershipHierarchicalSubtotal = 0;
    categories.forEach(c => membershipHierarchicalSubtotal += (c.membershipRenewalCharge || 0));
    subcategories.forEach(s => membershipHierarchicalSubtotal += (s.membershipRenewalCharge || 0));
    serviceTypes.forEach(st => membershipHierarchicalSubtotal += (st.membershipRenewalCharge || 0));
    services.forEach(s => membershipHierarchicalSubtotal += (s.membershipRenewalCharge || 0));

    const subtotal = basePlanPrice + membershipHierarchicalSubtotal;
    const gstPercent = 0; // No GST for renewal as per user request
    const gstAmount = 0;
    const totalFee = subtotal;

    // Build breakdown for hierarchical charges
    const breakdown = {
        basePlan: { name: plan.name || 'Basic', price: basePlanPrice }
    };
    
    const catList = categories.map(c => ({ id: c._id, name: c.name, charge: c.membershipRenewalCharge || 0 })).filter(c => c.charge > 0);
    if (catList.length > 0) breakdown.categories = catList;

    const subList = subcategories.map(s => ({ id: s._id, name: s.name, charge: s.membershipRenewalCharge || 0 })).filter(s => s.charge > 0);
    if (subList.length > 0) breakdown.subcategories = subList;

    const typeList = serviceTypes.map(st => ({ id: st._id, name: st.name, charge: st.membershipRenewalCharge || 0 })).filter(t => t.charge > 0);
    if (typeList.length > 0) breakdown.serviceTypes = typeList;

    const svcList = services.map(s => ({ id: s._id, name: s.title, charge: s.membershipRenewalCharge || 0 })).filter(s => s.charge > 0);
    if (svcList.length > 0) breakdown.services = svcList;

    return {
        vendorId: vendor._id,
        planId: plan.id,
        subtotal,
        gstPercent,
        gstAmount,
        totalFee,
        durationMonths: plan.validityDays / 30, // Rough estimate
        validityDays,
        razorpayKeyId: config.RAZORPAY_KEY_ID,
        breakdown
    };
};

/**
 * Membership Renewal: Create order
 */
const createMembershipRenewalOrder = async (vendorId, { planId, durationMonths } = {}) => {
    const feeDetails = await getMembershipRenewalFeeDetails(vendorId, { planId, durationMonths });

    if (feeDetails.totalFee <= 0) {
        throw new ApiError(400, 'Renewal fee is zero. Cannot create payment order.');
    }

    let razorpayOrder;
    try {
        razorpayOrder = await getRazorpay().orders.create({
            amount: Math.round(feeDetails.totalFee * 100),
            currency: 'INR',
            receipt: `m_ren_${vendorId.toString().slice(-10)}_${Date.now()}`,
        });

        // Log the pending payment record
        await PaymentRecord.create({
            vendor: vendorId,
            orderId: razorpayOrder.id,
            purpose: 'MEMBERSHIP_RENEWAL',
            amount: feeDetails.subtotal,
            gstAmount: feeDetails.gstAmount,
            totalAmount: feeDetails.totalFee,
            planId: feeDetails.planId,
            validityDays: feeDetails.validityDays,
            metadata: feeDetails.breakdown,
            status: 'PENDING'
        });
    } catch (error) {
        console.error('Razorpay Membership Renewal Order Error:', error);
        const errorMsg = error.error?.description || error.message || 'Failed to create payment order with Razorpay';
        throw new ApiError(400, `Payment Error: ${errorMsg}`);
    }

    return {
        vendorId: vendorId.toString(),
        planId: feeDetails.planId,
        totalFee: feeDetails.totalFee,
        razorpayKeyId: feeDetails.razorpayKeyId,
        razorpayOrder: {
            id: razorpayOrder.id,
            amount: razorpayOrder.amount,
            amountInRupees: razorpayOrder.amount / 100,
            currency: razorpayOrder.currency,
            status: razorpayOrder.status,
        }
    };
};

/**
 * Membership Renewal: Verify payment
 */
const verifyMembershipRenewalPayment = async (vendorId, { razorpay_order_id, razorpay_payment_id, razorpay_signature, planId, durationMonths }) => {
    const generated_signature = crypto
        .createHmac('sha256', config.RAZORPAY_KEY_SECRET)
        .update(razorpay_order_id + '|' + razorpay_payment_id)
        .digest('hex');

    if (generated_signature !== razorpay_signature) {
        throw new ApiError(400, 'Invalid payment signature');
    }

    const vendor = await Vendor.findById(vendorId);
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    const now = new Date();
    
    let plan;
    if (planId) {
        const planDoc = await CreditPlan.findById(planId).lean();
        if (!planDoc) throw new ApiError(404, 'Membership plan not found');
        plan = {
            id: planDoc._id,
            name: planDoc.name,
            price: Number(planDoc.price),
            validityDays: Number(planDoc.validityDays)
        };
    } else {
        plan = await getPlanByDuration(Number(durationMonths || 3));
    }
    
    const validityDays = plan.validityDays;

    // Extend membership expiry
    const baseDate = (vendor.membership.expiryDate && vendor.membership.expiryDate > now)
        ? vendor.membership.expiryDate
        : now;

    const newExpiryDate = new Date(baseDate);
    newExpiryDate.setDate(newExpiryDate.getDate() + validityDays);

    vendor.membership.expiryDate = newExpiryDate;
    vendor.membership.durationMonths = plan.validityDays / 30; // Rough estimate
    
    // Update payment record history
    try {
        await PaymentRecord.findOneAndUpdate(
            { orderId: razorpay_order_id },
            { 
                status: 'COMPLETED',
                paymentId: razorpay_payment_id,
                previousExpiryDate: baseDate,
                newExpiryDate: newExpiryDate
            }
        );
    } catch (paymentErr) {
        console.error('Failed to update PaymentRecord on verification:', paymentErr.message);
    }

    await vendor.save();

    return {
        success: true,
        message: `Membership renewal payment verified successfully. Validity extended by ${validityDays} days.`,
        expiryDate: vendor.membership.expiryDate,
        planId: plan.id
    };
};

/**
 * Service Renewal: Create order
 */
const createServiceRenewalOrder = async (vendorId) => {
    const feeDetails = await getServiceRenewalFeeDetails(vendorId);

    if (feeDetails.totalFee <= 0) {
        throw new ApiError(400, 'Renewal fee is zero. Cannot create payment order.');
    }

    let razorpayOrder;
    try {
        razorpayOrder = await getRazorpay().orders.create({
            amount: Math.round(feeDetails.totalFee * 100),
            currency: 'INR',
            receipt: `ren_${vendorId.toString().slice(-10)}_${Date.now()}`,
            notes: {
                vendorId: vendorId.toString(),
                purpose: 'service_renewal',
            },
        });

        // Log the pending payment record
        await PaymentRecord.create({
            vendor: vendorId,
            orderId: razorpayOrder.id,
            purpose: 'SERVICE_RENEWAL',
            amount: feeDetails.subtotal,
            gstAmount: feeDetails.gstAmount,
            totalAmount: feeDetails.totalFee,
            validityDays: 30, // Service renewal is always 30 days
            status: 'PENDING'
        });
    } catch (error) {
        console.error('Razorpay Service Renewal Order Error:', error);
        const errorMsg = error.error?.description || error.message || 'Failed to create payment order with Razorpay';
        throw new ApiError(400, `Payment Error: ${errorMsg}`);
    }

    return {
        ...feeDetails,
        status: razorpayOrder.status,
        razorpayOrder: {
            id: razorpayOrder.id,
            amount: razorpayOrder.amount,
            amountInRupees: razorpayOrder.amount / 100,
            currency: razorpayOrder.currency,
            receipt: razorpayOrder.receipt,
            status: razorpayOrder.status,
        }
    };
};

/**
 * Service Renewal: Verify payment
 */
const verifyServiceRenewalPayment = async (vendorId, { razorpay_order_id, razorpay_payment_id, razorpay_signature }) => {
    const generated_signature = crypto
        .createHmac('sha256', config.RAZORPAY_KEY_SECRET)
        .update(razorpay_order_id + '|' + razorpay_payment_id)
        .digest('hex');

    if (generated_signature !== razorpay_signature) {
        throw new ApiError(400, 'Invalid payment signature');
    }

    const vendor = await Vendor.findById(vendorId);
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    const now = new Date();
    vendor.serviceRenewal = vendor.serviceRenewal || {};

    // Extend expiry by 30 days
    const baseDate = (vendor.serviceRenewal.expiryDate && vendor.serviceRenewal.expiryDate > now)
        ? vendor.serviceRenewal.expiryDate
        : now;

    const newExpiryDate = new Date(baseDate);
    newExpiryDate.setDate(newExpiryDate.getDate() + 30);

    vendor.serviceRenewal.expiryDate = newExpiryDate;

    // Recalculate fee to keep it updated just in case
    try {
        const feeDetails = await getServiceRenewalFeeDetails(vendorId);
        vendor.serviceRenewal.fee = feeDetails.totalFee;
    } catch (e) { 
        console.error('Error in service renewal extension:', e);
    }

    // Update payment record history
    try {
        await PaymentRecord.findOneAndUpdate(
            { orderId: razorpay_order_id },
            { 
                status: 'COMPLETED',
                paymentId: razorpay_payment_id,
                previousExpiryDate: baseDate,
                newExpiryDate: newExpiryDate
            }
        );
    } catch (paymentErr) {
        console.error('Failed to update PaymentRecord on service verification:', paymentErr.message);
    }

    await vendor.save();

    return { 
        message: 'Service renewal payment verified successfully. Validity extended.', 
        expiryDate: vendor.serviceRenewal.expiryDate
    };
};

/**
 * API 1: List all membership plans with vendor context (expiry and renewal totals)
 */
const getMembershipPlansWithStatus = async (vendorId) => {
    const vendor = await Vendor.findById(vendorId);
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    const plans = [
        { duration: 3, name: 'Basic' },
        { duration: 6, name: 'Pro' },
        { duration: 12, name: 'Elite' }
    ];

    const allPlans = [];
    let currentPlan = null;
    const currentDuration = vendor.membership?.durationMonths || 0;

    for (const p of plans) {
        const feeDetails = await getMembershipRenewalFeeDetails(vendorId, { durationMonths: p.duration });
        const isCurrent = currentDuration === p.duration;
        
        const planObj = {
            id: feeDetails.planId,
            name: p.name,
            isCurrent,
            renewal: feeDetails.subtotal, // Subtotal includes base plan + hierarchy
            validityDays: feeDetails.validityDays
        };

        if (isCurrent) {
            currentPlan = {
                ...planObj,
                currentExpiryDate: vendor.membership?.expiryDate || null
            };
        } else {
            allPlans.push(planObj);
        }
    }

    return {
        currentPlan,
        plans: allPlans
    };
};

/**
 * API 2: Renewal Membership without GST
 */
const getMembershipRenewalFeeNoGst = async (vendorId, { durationMonths = 3 } = {}) => {
    const details = await getMembershipRenewalFeeDetails(vendorId, { durationMonths });
    return {
        ...details,
        totalFee: details.subtotal, // Total is just the subtotal (no GST)
        gstAmount: 0,
        message: 'Renewal fee calculated without GST'
    };
};

/**
 * API 3: Hierarchical Renewal Charges Only (Cat, SubCat, Type, Service)
 */
const getHierarchicalMembershipCharges = async (vendorId) => {
    const vendor = await Vendor.findById(vendorId)
        .populate('selectedCategories selectedSubcategories membership.category');
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    const categoryIds = new Set();
    const subcategoryIds = new Set();
    const serviceTypeIds = new Set();
    const serviceIds = new Set();

    if (vendor.selectedCategories) vendor.selectedCategories.forEach(c => categoryIds.add(String(c._id || c)));
    if (vendor.membership?.category) categoryIds.add(String(vendor.membership.category._id || vendor.membership.category));
    if (vendor.selectedSubcategories) {
        vendor.selectedSubcategories.forEach(s => {
            subcategoryIds.add(String(s._id || s));
            if (s.category) categoryIds.add(String(s.category._id || s.category));
        });
    }
    if (vendor.selectedServices && vendor.selectedServices.length > 0) {
        const fullServices = await Service.find({ _id: { $in: vendor.selectedServices } });
        fullServices.forEach(svc => {
            serviceIds.add(String(svc._id));
            if (svc.serviceType) serviceTypeIds.add(String(svc.serviceType));
            if (svc.subcategory) subcategoryIds.add(String(svc.subcategory));
            if (svc.category) categoryIds.add(String(svc.category));
        });
    }

    const categories = await Category.find({ _id: { $in: Array.from(categoryIds) } });
    const subcategories = await Subcategory.find({ _id: { $in: Array.from(subcategoryIds) } });
    const ServiceType = require('../../models/ServiceType.model');
    const serviceTypes = await ServiceType.find({ _id: { $in: Array.from(serviceTypeIds) } });
    const services = await Service.find({ _id: { $in: Array.from(serviceIds) } });

    let hierarchicalTotal = 0;
    const breakdown = {};

    const catList = categories.map(c => {
        const charge = c.membershipRenewalCharge || 0;
        hierarchicalTotal += charge;
        return { name: c.name, charge };
    }).filter(c => c.charge > 0);
    if (catList.length > 0) breakdown.categories = catList;

    const subList = subcategories.map(s => {
        const charge = s.membershipRenewalCharge || 0;
        hierarchicalTotal += charge;
        return { name: s.name, charge };
    }).filter(s => s.charge > 0);
    if (subList.length > 0) breakdown.subcategories = subList;

    const typeList = serviceTypes.map(st => {
        const charge = st.membershipRenewalCharge || 0;
        hierarchicalTotal += charge;
        return { name: st.name, charge };
    }).filter(t => t.charge > 0);
    if (typeList.length > 0) breakdown.serviceTypes = typeList;

    const svcList = services.map(s => {
        const charge = s.membershipRenewalCharge || 0;
        hierarchicalTotal += charge;
        return { name: s.title, charge };
    }).filter(s => s.charge > 0);
    if (svcList.length > 0) breakdown.services = svcList;

    return {
        vendorId: vendor._id,
        hierarchicalTotal,
        breakdown
    };
};

/**
 * Add Category: Calculate fee details
 */
const getAddCategoryFeeDetails = async (vendorId, { categoryId, subcategoryIds = [], serviceIds = [] } = {}) => {
    if (!categoryId) throw new ApiError(400, 'categoryId is required');

    const category = await Category.findById(categoryId).lean();
    if (!category) throw new ApiError(404, 'Category not found');

    const parsedSubcategoryIds = parseArrayInput(subcategoryIds);
    const parsedServiceIds = parseArrayInput(serviceIds);

    const subcategories = await Subcategory.find({ _id: { $in: parsedSubcategoryIds } }).lean();
    const services = await Service.find({ _id: { $in: parsedServiceIds } }).lean();

    let totalFee = Number(category.serviceCharge || 0);
    const breakdown = {
        category: { id: category._id, name: category.name, charge: totalFee },
        subcategories: [],
        services: []
    };

    subcategories.forEach(sub => {
        const charge = Number(sub.serviceCharge || 0);
        totalFee += charge;
        if (charge > 0) breakdown.subcategories.push({ id: sub._id, name: sub.name, charge });
    });

    services.forEach(svc => {
        const charge = Number(svc.serviceCharge || 0);
        totalFee += charge;
        if (charge > 0) breakdown.services.push({ id: svc._id, name: svc.title, charge });
    });

    // Extra category purchases use 18% GST consistent with registration
    const gstPercent = 18;
    const gstAmount = Math.round(totalFee * (gstPercent / 100));
    const totalWithGst = totalFee + gstAmount;

    return {
        vendorId,
        categoryId,
        totalCharge: totalFee, // Subtotal of service charges
        gstAmount,
        totalWithGst,
        razorpayKeyId: config.RAZORPAY_KEY_ID,
        breakdown
    };
};

/**
 * Add Category: Create order
 */
const createAddCategoryOrder = async (vendorId, { categoryId, subcategoryIds = [], serviceIds = [] } = {}) => {
    const feeDetails = await getAddCategoryFeeDetails(vendorId, { categoryId, subcategoryIds, serviceIds });

    const totalToPay = feeDetails.totalWithGst;

    if (totalToPay <= 0) {
        throw new ApiError(400, 'Total fee for adding category is zero. Cannot create payment order.');
    }

    let razorpayOrder;
    try {
        razorpayOrder = await getRazorpay().orders.create({
            amount: Math.round(totalToPay * 100),
            currency: 'INR',
            receipt: `add_cat_${vendorId.toString().slice(-10)}_${Date.now()}`,
            notes: {
                vendorId: vendorId.toString(),
                purpose: 'category_purchase',
            },
        });

        // Log the pending payment record
        await PaymentRecord.create({
            vendor: vendorId,
            orderId: razorpayOrder.id,
            purpose: 'CATEGORY_PURCHASE',
            amount: feeDetails.totalCharge,
            totalAmount: totalToPay,
            status: 'PENDING',
            metadata: {
                ...feeDetails.breakdown,
                selectedSubcategories: subcategoryIds,
                selectedServices: serviceIds,
                categoryId: categoryId
            }
        });
    } catch (error) {
        console.error('Razorpay Add Category Order Error:', error);
        const errorMsg = error.error?.description || error.message || 'Failed to create payment order with Razorpay';
        throw new ApiError(400, `Payment Error: ${errorMsg}`);
    }

    return {
        ...feeDetails,
        status: razorpayOrder.status,
        razorpayOrder: {
            id: razorpayOrder.id,
            amount: razorpayOrder.amount,
            amountInRupees: razorpayOrder.amount / 100,
            currency: razorpayOrder.currency,
            status: razorpayOrder.status,
        }
    };
};

/**
 * Add Category: Verify payment and activate
 */
const verifyAddCategoryPayment = async (vendorId, { razorpay_order_id, razorpay_payment_id, razorpay_signature, isAdminBypass = false, categoryId, selectedSubcategories, selectedServices }) => {
    if (!isAdminBypass) {
        const generated_signature = crypto
            .createHmac('sha256', config.RAZORPAY_KEY_SECRET)
            .update(razorpay_order_id + '|' + razorpay_payment_id)
            .digest('hex');

        if (generated_signature !== razorpay_signature) {
            throw new ApiError(400, 'Invalid payment signature');
        }
    }

    let finalCategoryId = categoryId;
    let finalSubcategories = selectedSubcategories;
    let finalServices = selectedServices;

    const paymentRecord = await PaymentRecord.findOne({ orderId: razorpay_order_id });
    
    if (!paymentRecord && !isAdminBypass) {
        throw new ApiError(404, 'Payment record not found');
    }

    if (paymentRecord && paymentRecord.metadata) {
        finalCategoryId = finalCategoryId || paymentRecord.metadata.categoryId;
        finalSubcategories = finalSubcategories || paymentRecord.metadata.selectedSubcategories;
        finalServices = finalServices || paymentRecord.metadata.selectedServices;
    }

    const vendor = await Vendor.findById(vendorId);
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    // Add unique selections to vendor profile
    if (finalCategoryId) {
        const catIdStr = String(finalCategoryId);
        if (!vendor.selectedCategories.map(id => String(id)).includes(catIdStr)) {
            vendor.selectedCategories.push(finalCategoryId);
        }
    }

    if (finalSubcategories && Array.isArray(finalSubcategories)) {
        finalSubcategories.forEach(subId => {
            const subIdStr = String(subId);
            if (!vendor.selectedSubcategories.map(id => String(id)).includes(subIdStr)) {
                vendor.selectedSubcategories.push(subId);
            }
        });
    }

    if (finalServices && Array.isArray(finalServices)) {
        finalServices.forEach(svcId => {
            const svcIdStr = String(svcId);
            if (!vendor.selectedServices.map(id => String(id)).includes(svcIdStr)) {
                vendor.selectedServices.push(svcId);
            }
        });
    }

    // Update categorySubscriptions for the newly added category
    if (finalCategoryId) {
        const catIdStr = String(finalCategoryId);
        const now = new Date();
        const expiryDate = new Date(now);
        expiryDate.setDate(expiryDate.getDate() + 30); // Service expires in 1 month (30 days)

        const Category = require('../../models/Category.model');
        const category = await Category.findById(finalCategoryId).select('membershipCharge membershipFee');
        const fee = category ? (category.membershipCharge || category.membershipFee || 0) : 0;

        const existingSubIndex = vendor.categorySubscriptions.findIndex(s => s.category.toString() === catIdStr);
        if (existingSubIndex > -1) {
            vendor.categorySubscriptions[existingSubIndex].expiryDate = expiryDate;
            vendor.categorySubscriptions[existingSubIndex].status = 'ACTIVE';
            vendor.categorySubscriptions[existingSubIndex].fee = fee;
        } else {
            vendor.categorySubscriptions.push({
                category: finalCategoryId,
                startDate: now,
                expiryDate: expiryDate,
                fee: fee,
                status: 'ACTIVE'
            });
        }
    }

    // Ensure category is in selectedCategories for notifications/broadcasts
    if (finalCategoryId && !vendor.selectedCategories.some(id => id.toString() === String(finalCategoryId))) {
        vendor.selectedCategories.push(finalCategoryId);
    }

    // Update payment record if it exists
    if (paymentRecord) {
        paymentRecord.status = 'COMPLETED';
        paymentRecord.paymentId = razorpay_payment_id;
        await paymentRecord.save();
    } else if (isAdminBypass) {
        // Create a record for admin activation audit trail
        await PaymentRecord.create({
            vendor: vendorId,
            orderId: razorpay_order_id,
            paymentId: razorpay_payment_id,
            purpose: 'CATEGORY_PURCHASE',
            amount: 0,
            totalAmount: 0,
            status: 'COMPLETED',
            metadata: {
                categoryId: finalCategoryId,
                selectedSubcategories: finalSubcategories,
                selectedServices: finalServices,
                notes: 'Activated by Admin'
            }
        });
    }

    await vendor.save();

    return {
        success: true,
        message: 'New category and services added successfully.',
        vendor: {
            selectedCategories: vendor.selectedCategories,
            selectedSubcategories: vendor.selectedSubcategories,
            selectedServices: vendor.selectedServices
        }
    };
};


module.exports = {
    getAllVendors,
    getMembershipInfo,
    getVendorMembershipDetails,
    createMembershipOrder,
    verifyMembershipPayment,
    selectServices,
    purchaseMembership,
    purchaseCreditPlan,
    verifyVendor,
    verifyDocument,
    verifyAllDocuments,
    toggleVendorSuspension,
    rejectVendorAccount,
    toggleOnlineStatus,
    getVendorProfile,
    updateVendorProfile,
    getVerificationStatus,
    deleteVendorAccount,
    getDashboardMetrics,
    getMembershipPlans,
    getCategoryRegistrationData,
    reuploadDocuments,
    getSubscriptionStatus,
    getServiceRenewalFeeDetails,
    createServiceRenewalOrder,
    verifyServiceRenewalPayment,
    getMembershipRenewalFeeDetails,
    createMembershipRenewalOrder,
    verifyMembershipRenewalPayment,
    getMembershipPlansWithStatus,
    getMembershipRenewalFeeNoGst,
    getHierarchicalMembershipCharges,
    getAddCategoryFeeDetails,
    createAddCategoryOrder,
    verifyAddCategoryPayment,
    getAvailablePurchaseCategories,
};

