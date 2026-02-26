const Vendor = require('../../models/Vendor.model');
const Subcategory = require('../../models/Subcategory.model');
const Category = require('../../models/Category.model');
const CreditPlan = require('../../models/CreditPlan.model');
const Service = require('../../models/Service.model');
const ApiError = require('../../utils/ApiError');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const config = require('../../config/env');

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
        .sort({ createdAt: -1 });
};

/**
 * Get membership info for registration
 */
const getMembershipInfo = async ({ serviceIds, subcategoryIds, vendorId }) => {
    let itemList = [];
    let isSubcategory = false;

    const parsedServiceIds = parseArrayInput(serviceIds);
    const parsedSubcategoryIds = parseArrayInput(subcategoryIds);

    // 1. Priorities: Explicit subcategoryIds > Explicit serviceIds > Vendor's saved data
    if (parsedSubcategoryIds.length > 0) {
        itemList = await Subcategory.find({ _id: { $in: parsedSubcategoryIds } });
        isSubcategory = true;
    } else if (parsedServiceIds.length > 0) {
        itemList = await Service.find({ _id: { $in: parsedServiceIds } });
    } else if (vendorId) {
        const vendor = await Vendor.findById(vendorId).populate('selectedServices').populate('selectedSubcategories');
        if (vendor) {
            if (vendor.selectedSubcategories && vendor.selectedSubcategories.length > 0) {
                itemList = vendor.selectedSubcategories;
                isSubcategory = true;
            } else if (vendor.selectedServices && vendor.selectedServices.length > 0) {
                itemList = vendor.selectedServices;
            }

            // Fallback for string IDs if populate failed or wasn't used correctly
            if (itemList.length > 0 && typeof itemList[0] === 'string') {
                if (isSubcategory) {
                    itemList = await Subcategory.find({ _id: { $in: itemList } });
                } else {
                    itemList = await Service.find({ _id: { $in: itemList } });
                }
            }
        }
    }

    if (itemList.length === 0) {
        throw new ApiError(400, 'No valid services/subcategories selected or found for vendor');
    }

    // Fetch global base membership fee
    const adminService = require('../admin/admin.service');
    const baseFee = await adminService.getSetting('pricing.vendor_base_membership_fee') || 0;

    const itemsFee = itemList.reduce((sum, item) => sum + (isSubcategory ? (item.price || 0) : (item.membershipFee || 0)), 0);
    const totalFee = itemsFee + baseFee;

    return {
        totalFee,
        vendorBaseMembershipFee: baseFee,
        duration: "3 months",
        services: itemList.map(item => ({
            id: item._id,
            title: isSubcategory ? item.name : item.title,
            type: isSubcategory ? 'subcategory' : 'service'
        }))
    };
};

/**
 * Get membership details for a specific vendor based on their saved selectedServices
 */
const getVendorMembershipDetails = async (vendorId, overrides = {}) => {
    const vendor = await Vendor.findById(vendorId).populate('selectedServices').populate('selectedSubcategories');
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    let itemList = [];
    let isSubcategory = false;

    const parsedServiceIds = parseArrayInput(overrides.serviceIds);
    const parsedSubcategoryIds = parseArrayInput(overrides.subcategoryIds);

    // Priority: Query overrides > Saved subcategories > Saved services
    if (parsedSubcategoryIds.length > 0) {
        itemList = await Subcategory.find({ _id: { $in: parsedSubcategoryIds } });
        isSubcategory = true;
    } else if (parsedServiceIds.length > 0) {
        itemList = await Service.find({ _id: { $in: parsedServiceIds } });
    } else {
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
    }

    // Fetch global base membership fee
    const adminService = require('../admin/admin.service');
    const baseFee = await adminService.getSetting('pricing.vendor_base_membership_fee') || 0;

    const itemsFee = itemList.reduce((sum, item) => sum + (isSubcategory ? (item.price || 0) : (item.membershipFee || 0)), 0);
    const totalFee = itemsFee + baseFee;

    return {
        vendorId: vendor._id,
        totalFee,
        vendorBaseMembershipFee: baseFee,
        duration: "3 months",
        razorpayKeyId: config.RAZORPAY_KEY_ID,
        services: itemList.map(item => ({
            id: item._id,
            title: isSubcategory ? item.name : item.title,
            type: isSubcategory ? 'subcategory' : 'service'
        }))
    };
};

/**
 * Create Razorpay order for membership payment
 * vendorId is extracted from token (req.user), NOT from URL
 */
const createMembershipOrder = async (vendorId) => {
    const vendor = await Vendor.findById(vendorId).populate('selectedServices').populate('selectedSubcategories');
    if (!vendor) throw new ApiError(404, 'Vendor not found');

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
    const baseFee = await adminService.getSetting('pricing.vendor_base_membership_fee') || 0;
    const itemsFee = itemList.reduce((sum, item) => sum + (isSubcategory ? (item.price || 0) : (item.membershipFee || 0)), 0);
    const totalFee = itemsFee + baseFee;

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
        vendorBaseMembershipFee: baseFee,
        duration: '3 months',
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
            membershipFee: isSubcategory ? (item.price || 0) : (item.membershipFee || 0),
            type: isSubcategory ? 'subcategory' : 'service'
        })),
    };
};

/**
 * Step 2: Select services and calculate membership fee
 */
const selectServices = async (vendorId, { subcategoryIds, durationMonths }) => {
    const vendor = await Vendor.findById(vendorId);
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    if (durationMonths % 3 !== 0) {
        throw new ApiError(400, 'Duration must be in multiples of 3 months');
    }

    const parsedSubcategoryIds = parseArrayInput(subcategoryIds);

    // Fetch subcategories to get prices and categories
    const subcategories = await Subcategory.find({ _id: { $in: parsedSubcategoryIds } }).populate('category', 'name');
    if (subcategories.length === 0) {
        throw new ApiError(400, 'No valid subcategories selected');
    }

    // Calculate total price: Sum of subcategory prices * (durationMonths / 3)
    const basePrice = subcategories.reduce((sum, sub) => sum + (sub.price || 0), 0);
    const totalPrice = basePrice * (durationMonths / 3);

    // Update vendor
    vendor.selectedSubcategories = parsedSubcategoryIds;
    vendor.membership.category = subcategories[0].category; // Set primary category for dashboard
    vendor.membership.fee = totalPrice;
    vendor.membership.durationMonths = durationMonths;
    vendor.registrationStep = 'SERVICES_SELECTED';

    await vendor.save();

    return {
        totalPrice,
        durationMonths,
        subcategories: subcategories.map(s => ({
            id: s._id,
            name: s.name,
            price: s.price,
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

    if (vendor.registrationStep !== 'SERVICES_SELECTED') {
        throw new ApiError(400, 'Please select services before purchasing membership');
    }

    vendor.membership.isActive = true;
    vendor.membership.startDate = new Date();
    const expiryDate = new Date();
    expiryDate.setMonth(expiryDate.getMonth() + (vendor.membership.durationMonths || 3));
    vendor.membership.expiryDate = expiryDate;

    // Transition to completed registration after membership, allows home screen access.
    // However, lead calls are still blocked until Admin verification and Plan purchase.
    vendor.isVerified = false;
    vendor.documentStatus = 'pending';
    vendor.registrationStep = 'COMPLETED';

    await vendor.save();

    return { message: 'Membership payment successful. Your account is now being reviewed by Admin.' };
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

    // Apply the specific verification update
    const currentDoc = vendor.documents[docType]; // Now guaranteed to be object or migrated
    const url = typeof currentDoc === 'string' ? currentDoc : (currentDoc?.url || '');
    // Clear reason if verifying, keep/update if rejecting
    const newReason = status === 'verified' ? undefined : (reason || (currentDoc && typeof currentDoc === 'object' ? currentDoc.reason : undefined));

    vendor.set(`documents.${docType}`, {
        url,
        status,
        reason: newReason
    });

    // Check if all required documents (photo, idProof, addressProof) are verified
    const requiredDocs = ['photo', 'idProof', 'addressProof'];
    const allVerified = requiredDocs.every(doc => {
        const d = vendor.documents[doc];
        return d && typeof d === 'object' && d.status === 'verified';
    });

    if (allVerified) {
        vendor.isVerified = true;
        vendor.documentStatus = 'approved';

        // Start membership if not already started
        if (!vendor.membership.startDate) {
            const startDate = new Date();
            const durationMonths = vendor.membership.durationMonths || 3;
            const expiryDate = new Date();
            expiryDate.setMonth(expiryDate.getMonth() + durationMonths);

            vendor.membership.startDate = startDate;
            vendor.membership.expiryDate = expiryDate;
            vendor.membership.isActive = true;
        }
    } else if (status === 'rejected') {
        vendor.isVerified = false;
        vendor.documentStatus = 'rejected';
    } else {
        vendor.isVerified = false;
        vendor.documentStatus = 'pending';
    }

    await vendor.save();
    return vendor;
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
            vendor.set(`documents.${doc}`, { url: val, status: 'verified', reason: undefined });
        } else if (val && typeof val === 'object' && val.url) {
            vendor.set(`documents.${doc}.status`, 'verified');
            vendor.set(`documents.${doc}.reason`, undefined);
        }
    });

    vendor.isVerified = true;
    vendor.documentStatus = 'approved';

    // Start membership if not already started
    if (!vendor.membership.startDate) {
        const startDate = new Date();
        const durationMonths = vendor.membership.durationMonths || 3;
        const expiryDate = new Date();
        expiryDate.setMonth(expiryDate.getMonth() + durationMonths);

        vendor.membership.startDate = startDate;
        vendor.membership.expiryDate = expiryDate;
        vendor.membership.isActive = true;
    }

    await vendor.save();
    return vendor;
};

/**
 * Admin: Toggle Suspension
 */
const toggleVendorSuspension = async (vendorId, { isSuspended }) => {
    const vendor = await Vendor.findById(vendorId);
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    vendor.isSuspended = isSuspended;
    await vendor.save();
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

    // Mark all pending/verified docs as rejected too if needed
    const docs = ['photo', 'idProof', 'addressProof'];
    docs.forEach(doc => {
        if (vendor.documents[doc]) {
            vendor.documents[doc].status = 'rejected';
            vendor.documents[doc].reason = reason;
        }
    });

    await vendor.save();
    return vendor;
};

/**
 * Admin: Verify Vendor (Legacy/Fallback)
 */
const verifyVendor = async (vendorId, { status, reason }) => {
    if (status === 'approved') return await verifyAllDocuments(vendorId);
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
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    if (!vendor.isVerified || vendor.documentStatus !== 'approved') {
        throw new ApiError(403, 'Your account must be approved before going online');
    }

    if (vendor.isSuspended) {
        throw new ApiError(403, 'Your account is suspended. Please contact support.');
    }

    vendor.isOnline = isOnline;
    await vendor.save();

    return {
        isOnline: vendor.isOnline,
        message: `You are now ${vendor.isOnline ? 'online' : 'offline'}`,
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

    vendor.membership.isActive = true;
    vendor.membership.startDate = new Date();
    const expiryDate = new Date();
    expiryDate.setMonth(expiryDate.getMonth() + (vendor.membership.durationMonths || 3));
    vendor.membership.expiryDate = expiryDate;
    vendor.registrationStep = 'COMPLETED';

    await vendor.save();

    return {
        success: true,
        message: 'Payment verified. Membership activated successfully.',
        membership: {
            isActive: vendor.membership.isActive,
            startDate: vendor.membership.startDate,
            expiryDate: vendor.membership.expiryDate,
            durationMonths: vendor.membership.durationMonths || 3,
        },
        payment: {
            razorpay_order_id,
            razorpay_payment_id,
            status: 'paid',
        },
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
};

