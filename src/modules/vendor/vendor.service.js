const Vendor = require('../../models/Vendor.model');
const Subcategory = require('../../models/Subcategory.model');
const Category = require('../../models/Category.model');
const CreditPlan = require('../../models/CreditPlan.model');
const Service = require('../../models/Service.model');
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
 * Get all vendors
 * @returns {Promise<Array>} List of vendors
 */
const getAllVendors = async () => {
    return await Vendor.find()
        .populate('membership.category', 'name')
        .populate('creditPlan.planId', 'name')
        .populate('selectedSubcategories', 'name price')
        .populate('selectedServices', 'title adminPrice membershipFee')
        .sort({ createdAt: -1 });
};

/**
 * Get membership info for registration
 */
const getMembershipInfo = async ({ serviceIds, subcategoryIds, categoryId, durationMonths, vendorId }) => {
    let itemList = [];
    let isSubcategory = false;
    let category = null;

    const parsedServiceIds = parseArrayInput(serviceIds);
    const parsedSubcategoryIds = parseArrayInput(subcategoryIds);

    // 1. Priorities: Explicit subcategoryIds > Explicit categoryId > Explicit serviceIds > Vendor's saved data
    if (parsedSubcategoryIds.length > 0) {
        itemList = await Subcategory.find({ _id: { $in: parsedSubcategoryIds } }).populate('category');
        isSubcategory = true;
        if (itemList.length > 0) category = itemList[0].category;
    } else if (categoryId) {
        category = await Category.findById(categoryId);
        if (!category) throw new ApiError(404, 'Category not found');
    } else if (parsedServiceIds.length > 0) {
        itemList = await Service.find({ _id: { $in: parsedServiceIds } }).populate('category');
        if (itemList.length > 0) category = itemList[0].category;
    } else if (vendorId) {
        const vendor = await Vendor.findById(vendorId).populate('selectedServices').populate('selectedSubcategories').populate('membership.category');
        if (vendor) {
            category = vendor.membership?.category;
            if (vendor.selectedSubcategories && vendor.selectedSubcategories.length > 0) {
                itemList = vendor.selectedSubcategories;
                isSubcategory = true;
            } else if (vendor.selectedServices && vendor.selectedServices.length > 0) {
                itemList = vendor.selectedServices;
            }

            // Fallback for string IDs if populate failed or wasn't used correctly
            if (itemList.length > 0 && typeof itemList[0] === 'string') {
                if (isSubcategory) {
                    itemList = await Subcategory.find({ _id: { $in: itemList } }).populate('category');
                } else {
                    itemList = await Service.find({ _id: { $in: itemList } }).populate('category');
                }
            }
        }
    }

    if (itemList.length === 0 && !category) {
        throw new ApiError(400, 'No valid services/subcategories or category selected or found for vendor');
    }

    // Fetch global base membership fee based on duration from CreditPlan collection
    const adminService = require('../admin/admin.service');
    const selectedDuration = Number(durationMonths || 3);
    const plan = await getPlanByDuration(selectedDuration);
    const baseFee = Number(plan.price || 0);
    const gstPercent = Number(await adminService.getSetting('pricing.membership_gst_percent') || 0);

    // Only use base plan fee for membership
    const subtotal = baseFee;
    const gstAmount = Math.round(subtotal * (gstPercent / 100));
    const totalFee = Number(subtotal + gstAmount);

    const validityDays = plan.validityDays || (selectedDuration * 30);
    const plans = await getMembershipPlans();

    return {
        subtotal,
        gstAmount,
        totalFee,
        categoryMembershipFee: category?.concurrencyFee || category?.membershipFee || 0,
        categoryRenewalCharge: category?.renewalCharge || 0,
        duration: `${validityDays} days`,
        durationMonths: selectedDuration,
        plans,
        services: itemList.map(item => ({
            id: item._id,
            title: isSubcategory ? item.name : item.title,
            type: isSubcategory ? 'subcategory' : 'service',
            membershipFee: item.membershipFee || 0
        }))
    };
};

/**
 * Get membership details for a specific vendor based on their saved selectedServices
 */
const getVendorMembershipDetails = async (vendorId, overrides = {}) => {
    const vendor = await Vendor.findById(vendorId).populate('selectedServices').populate('selectedSubcategories').populate('membership.category');
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    let itemList = [];
    let isSubcategory = false;
    let category = null;

    const parsedServiceIds = parseArrayInput(overrides.serviceIds);
    const parsedSubcategoryIds = parseArrayInput(overrides.subcategoryIds);
    const categoryId = overrides.categoryId;

    // Priority: Query overrides > Saved data
    if (parsedSubcategoryIds.length > 0) {
        itemList = await Subcategory.find({ _id: { $in: parsedSubcategoryIds } }).populate('category');
        isSubcategory = true;
        if (itemList.length > 0) category = itemList[0].category;
    } else if (categoryId) {
        category = await Category.findById(categoryId);
    } else if (parsedServiceIds.length > 0) {
        itemList = await Service.find({ _id: { $in: parsedServiceIds } }).populate('category');
        if (itemList.length > 0) category = itemList[0].category;
    } else {
        category = vendor.membership?.category;
        if (vendor.selectedSubcategories && vendor.selectedSubcategories.length > 0) {
            itemList = vendor.selectedSubcategories;
            isSubcategory = true;
        } else if (vendor.selectedServices && vendor.selectedServices.length > 0) {
            itemList = vendor.selectedServices;
        }

        // Fallback for string IDs if populate failed
        if (itemList.length > 0 && typeof itemList[0] === 'string') {
            if (isSubcategory) {
                itemList = await Subcategory.find({ _id: { $in: itemList } }).populate('category');
            } else {
                itemList = await Service.find({ _id: { $in: itemList } }).populate('category');
            }
        }
    }

    // Fetch global base membership fee based on duration from CreditPlan collection
    const adminService = require('../admin/admin.service');
    const durationMonths = Number(overrides.durationMonths || vendor.membership.durationMonths || 3);
    const plan = await getPlanByDuration(durationMonths);
    const baseFee = Number(plan.price || 0);
    const gstPercent = Number(await adminService.getSetting('pricing.membership_gst_percent') || 0);

    // Only use base plan fee for membership
    const subtotal = baseFee;
    const gstAmount = Math.round(subtotal * (gstPercent / 100));
    const totalFee = Number(subtotal + gstAmount);

    const validityDays = plan.validityDays || (durationMonths * 30);
    const plans = await getMembershipPlans();

    return {
        vendorId: vendor._id,
        subtotal,
        gstAmount,
        totalFee,
        duration: `${validityDays} days`,
        durationMonths,
        razorpayKeyId: config.RAZORPAY_KEY_ID,
        plans,
        services: itemList.map(item => ({
            id: item._id,
            title: isSubcategory ? item.name : item.title,
            type: isSubcategory ? 'subcategory' : 'service',
            membershipFee: 0 // Service fees are no longer added individually
        }))
    };
};

/**
 * Create Razorpay order for membership payment
 * vendorId is extracted from token (req.user), NOT from URL
 */
const createMembershipOrder = async (vendorId, { durationMonths, amount } = {}) => {
    const vendor = await Vendor.findById(vendorId)
        .populate('selectedServices')
        .populate('selectedSubcategories')
        .populate('membership.category');
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    // Update durationMonths if provided
    if (durationMonths) {
        vendor.membership.durationMonths = Number(durationMonths);
        await vendor.save();
    }

    let itemList = [];
    let isSubcategory = false;

    if (vendor.selectedSubcategories && vendor.selectedSubcategories.length > 0) {
        itemList = vendor.selectedSubcategories;
        isSubcategory = true;
    } else if (vendor.selectedServices && vendor.selectedServices.length > 0) {
        itemList = vendor.selectedServices;
    }

    // Fallback for string IDs if populate failed
    if (itemList.length > 0 && typeof itemList[0] === 'string') {
        if (isSubcategory) {
            itemList = await Subcategory.find({ _id: { $in: itemList } });
        } else {
            itemList = await Service.find({ _id: { $in: itemList } });
        }
    }

    const adminService = require('../admin/admin.service');
    const effectiveDuration = Number(durationMonths || vendor.membership.durationMonths || 3);
    const plan = await getPlanByDuration(effectiveDuration);

    // Use provided amount if present, otherwise use plan price from DB
    const baseFee = amount ? Number(amount) : Number(plan.price || 0);
    const gstPercent = Number(await adminService.getSetting('pricing.membership_gst_percent') || 0);

    // Only use base plan fee for membership
    const subtotal = baseFee;
    const gstAmount = Math.round(subtotal * (gstPercent / 100));
    const totalFee = Number(subtotal + gstAmount);

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

    const validityDays = plan.validityDays || (durationMonths * 30);

    return {
        vendorId: vendor._id,
        vendorName: vendor.name,
        totalFee,
        duration: `${validityDays} days`,
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
        services: itemList.map(item => ({
            id: item._id,
            title: isSubcategory ? item.name : item.title,
            membershipFee: 0,
            type: isSubcategory ? 'subcategory' : 'service'
        })),
    };
};

/**
 * Step 2: Select services and calculate membership fee
 */
const selectServices = async (vendorId, { categoryId, subcategoryIds, durationMonths }) => {
    const vendor = await Vendor.findById(vendorId);
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    if (durationMonths % 3 !== 0) {
        throw new ApiError(400, 'Duration must be in multiples of 3 months');
    }

    let subcategories = [];
    let category = null;

    if (subcategoryIds) {
        const parsedSubcategoryIds = parseArrayInput(subcategoryIds);
        // Fetch subcategories to get prices and categories
        subcategories = await Subcategory.find({ _id: { $in: parsedSubcategoryIds } }).populate('category', 'name');
        if (subcategories.length > 0) {
            category = subcategories[0].category;
            vendor.selectedSubcategories = parsedSubcategoryIds;
        }
    }

    if (!category && categoryId) {
        category = await Category.findById(categoryId);
        if (!category) throw new ApiError(404, 'Category not found');

        // Ensure category is also in selectedCategories
        if (!vendor.selectedCategories.includes(category._id)) {
            vendor.selectedCategories.push(category._id);
        }
    }

    if (!category && subcategories.length === 0) {
        throw new ApiError(400, 'No valid category or subcategories selected');
    }

    // Fetch global base membership fee based on duration
    const adminService = require('../admin/admin.service');
    const plan = await getPlanByDuration(durationMonths);
    const baseFee = Number(plan.price || 0);
    const gstPercent = Number(await adminService.getSetting('pricing.membership_gst_percent') || 0);

    // Subtotal is strictly the duration-based base fee (items are included in plan)
    const subtotal = baseFee;
    const gstAmount = Math.round(subtotal * (gstPercent / 100));
    const totalPrice = Number(subtotal + gstAmount);

    // Update vendor
    vendor.membership.category = category._id; // Set primary category for dashboard
    vendor.membership.fee = totalPrice;
    vendor.membership.durationMonths = durationMonths;
    vendor.membership.subtotal = subtotal; // Optional: store subtotal
    vendor.membership.gstAmount = gstAmount; // Optional: store GST
    vendor.membership.renewalCharge = category.renewalCharge || 0;
    vendor.serviceRenewal = {
        fee: category.renewalCharge || 0,
    };
    vendor.registrationStep = 'SERVICES_SELECTED';

    await vendor.save();

    return {
        totalPrice,
        durationMonths,
        categoryMembershipFee: category.membershipFee || 0,
        categoryRenewalCharge: category.renewalCharge || 0,
        subcategories: subcategories.map(s => ({
            id: s._id,
            name: s.name,
            price: 0,
            membershipFee: s.membershipFee || 0,
            serviceRenewalCharge: s.serviceRenewalCharge || 0,
            renewalCharge: s.renewalCharge || 0,
            category: s.category?.name || 'Unknown Category'
        })),
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
const getMembershipPlans = async () => {
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

        const gstAmount = Math.round(baseFee * (gstPercent / 100));
        result.push({
            durationMonths: config.duration,
            label: `${config.name} (${validityDays} Days)`,
            baseFee,
            validityDays: Number(validityDays),
            gstAmount,
            totalFee: baseFee + gstAmount,
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
        vendor.membership.startDate = new Date();
        const expiryDate = new Date();
        expiryDate.setMonth(expiryDate.getMonth() + (vendor.membership.durationMonths || 3));
        vendor.membership.expiryDate = expiryDate;
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

    // Update array fields (workPincodes, categories, subcategories, services)
    if (uploadedDocs.workPincodes) vendor.workPincodes = uploadedDocs.workPincodes;
    if (uploadedDocs.selectedCategories) vendor.selectedCategories = uploadedDocs.selectedCategories;
    if (uploadedDocs.selectedSubcategories) vendor.selectedSubcategories = uploadedDocs.selectedSubcategories;
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
    const vendor = await Vendor.findById(vendorId).populate('selectedServices selectedSubcategories');
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

    // Determine the list of services (using subcategories if present, else services)
    let serviceList = [];
    if (vendor.selectedSubcategories && vendor.selectedSubcategories.length > 0) {
        serviceList = vendor.selectedSubcategories.map(sub => ({
            serviceId: sub.name,
            isActive: isRenActive,
            daysRemaining: daysRemaining
        }));
    } else if (vendor.selectedServices && vendor.selectedServices.length > 0) {
        serviceList = vendor.selectedServices.map(svc => ({
            serviceId: svc.title,
            isActive: isRenActive,
            daysRemaining: daysRemaining
        }));
    }

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

    // 2. Calculate Membership Renewal Fee (Categorical)
    let membershipSubtotal = 0;
    categories.forEach(c => membershipSubtotal += (c.membershipRenewalCharge || 0));
    subcategories.forEach(s => membershipSubtotal += (s.membershipRenewalCharge || 0));

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
        membershipExpiryDate: vendor.membership?.expiryDate || null,
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
const getMembershipRenewalFeeDetails = async (vendorId, { durationMonths = 3 } = {}) => {
    const vendor = await Vendor.findById(vendorId);
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    const adminService = require('../admin/admin.service');
    const plan = await getPlanByDuration(Number(durationMonths));
    const baseFee = Number(plan.price || 0);
    const validityDays = Number(plan.validityDays || (durationMonths * 30));

    const gstPercent = Number(await adminService.getSetting('pricing.membership_gst_percent') || 0);
    const gstAmount = Math.round(baseFee * (gstPercent / 100));
    const totalFee = Number(baseFee + gstAmount);

    return {
        vendorId: vendor._id,
        subtotal: baseFee,
        gstPercent,
        gstAmount,
        totalFee,
        durationMonths: Number(durationMonths),
        validityDays,
        razorpayKeyId: config.RAZORPAY_KEY_ID,
        planName: durationMonths === 6 ? 'Pro' : (durationMonths === 12 ? 'Elite' : 'Basic')
    };
};

/**
 * Membership Renewal: Create order
 */
const createMembershipRenewalOrder = async (vendorId, { durationMonths = 3 } = {}) => {
    const feeDetails = await getMembershipRenewalFeeDetails(vendorId, { durationMonths });

    if (feeDetails.totalFee <= 0) {
        throw new ApiError(400, 'Renewal fee is zero. Cannot create payment order.');
    }

    let razorpayOrder;
    try {
        razorpayOrder = await getRazorpay().orders.create({
            amount: Math.round(feeDetails.totalFee * 100),
            currency: 'INR',
            receipt: `m_ren_${vendorId.toString().slice(-10)}_${Date.now()}`,
            notes: {
                vendorId: vendorId.toString(),
                purpose: 'membership_renewal',
                durationMonths: String(durationMonths)
            },
        });
    } catch (error) {
        console.error('Razorpay Membership Renewal Order Error:', error);
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
 * Membership Renewal: Verify payment
 */
const verifyMembershipRenewalPayment = async (vendorId, { razorpay_order_id, razorpay_payment_id, razorpay_signature, durationMonths = 3 }) => {
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
    const plan = await getPlanByDuration(Number(durationMonths));
    const validityDays = Number(plan.validityDays || (durationMonths * 30));

    // Extend membership expiry
    const baseDate = (vendor.membership.expiryDate && vendor.membership.expiryDate > now)
        ? vendor.membership.expiryDate
        : now;

    const newExpiryDate = new Date(baseDate);
    newExpiryDate.setDate(newExpiryDate.getDate() + validityDays);

    vendor.membership.expiryDate = newExpiryDate;
    vendor.membership.durationMonths = Number(durationMonths);

    await vendor.save();

    return {
        message: `Membership renewal payment verified successfully. Validity extended by ${validityDays} days.`,
        expiryDate: vendor.membership.expiryDate
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

    // Also extend membership expiry if this is a unified renewal
    try {
        const feeDetails = await getServiceRenewalFeeDetails(vendorId);
        if (feeDetails.membershipRenewal.fee > 0) {
            const memBaseDate = (vendor.membership.expiryDate && vendor.membership.expiryDate > now)
                ? vendor.membership.expiryDate
                : now;
            const newMemExpiry = new Date(memBaseDate);
            newMemExpiry.setDate(newMemExpiry.getDate() + 30); // Extend by 30 days default or similar
            vendor.membership.expiryDate = newMemExpiry;
        }
        vendor.serviceRenewal.fee = feeDetails.totalFee;
    } catch (e) { 
        console.error('Error in unified renewal extension:', e);
    }

    await vendor.save();

    return { 
        message: 'Renewal payment verified successfully. Validity extended.', 
        serviceExpiryDate: vendor.serviceRenewal.expiryDate,
        membershipExpiryDate: vendor.membership.expiryDate
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
};

