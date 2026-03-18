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
        .populate('selectedSubcategories', 'name price')
        .populate('selectedServices', 'title adminPrice membershipFee')
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
    const baseFeeSetting = await adminService.getSetting('pricing.vendor_base_membership_fee') || 0;

    const durationMonths = Number(overrides?.durationMonths || 3);
    const multiplier = durationMonths / 3;

    const itemsFee = itemList.reduce((sum, item) => sum + (isSubcategory ? (item.price || 0) : (item.membershipFee || 0)), 0);
    const totalFee = (itemsFee + baseFeeSetting) * multiplier;

    return {
        totalFee,
        vendorBaseMembershipFee: baseFeeSetting,
        duration: `${durationMonths} months`,
        durationMonths,
        services: itemList.map(item => ({
            id: item._id,
            title: isSubcategory ? item.name : item.title,
            type: isSubcategory ? 'subcategory' : 'service',
            membershipFee: isSubcategory ? (item.price || 0) : (item.membershipFee || 0)
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
    const baseFeeSetting = await adminService.getSetting('pricing.vendor_base_membership_fee') || 0;

    const durationMonths = Number(overrides.durationMonths || vendor.membership.durationMonths || 3);
    const multiplier = durationMonths / 3;

    const itemsFee = itemList.reduce((sum, item) => sum + (isSubcategory ? (item.price || 0) : (item.membershipFee || 0)), 0);
    const totalFee = (itemsFee + baseFeeSetting) * multiplier;

    return {
        vendorId: vendor._id,
        totalFee,
        vendorBaseMembershipFee: baseFeeSetting,
        duration: `${durationMonths} months`,
        durationMonths,
        razorpayKeyId: config.RAZORPAY_KEY_ID,
        services: itemList.map(item => ({
            id: item._id,
            title: isSubcategory ? item.name : item.title,
            type: isSubcategory ? 'subcategory' : 'service',
            membershipFee: isSubcategory ? (item.price || 0) : (item.membershipFee || 0)
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
    const baseFeeSetting = await adminService.getSetting('pricing.vendor_base_membership_fee') || 0;
    
    const durationMonths = Number(vendor.membership.durationMonths || 3);
    const multiplier = durationMonths / 3;

    const itemsFee = itemList.reduce((sum, item) => sum + (isSubcategory ? (item.price || 0) : (item.membershipFee || 0)), 0);
    const totalFee = (itemsFee + baseFeeSetting) * multiplier;

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
        vendorBaseMembershipFee: baseFeeSetting,
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

    // Fetch global base membership fee
    const adminService = require('../admin/admin.service');
    const baseFeeSetting = await adminService.getSetting('pricing.vendor_base_membership_fee') || 0;

    // Calculate total price: (Sum of subcategory prices + base fee) * (durationMonths / 3)
    const basePrice = subcategories.reduce((sum, sub) => sum + (sub.price || 0), 0);
    const totalPrice = (basePrice + baseFeeSetting) * (durationMonths / 3);

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

    // Apply the specific verification update
    const currentDoc = vendor.documents[docType]; // Now guaranteed to be object or migrated
    // Map 'approved' to 'verified' for internal consistency if needed
    const isApprovedOrVerified = status === 'verified' || status === 'approved';
    const newReason = isApprovedOrVerified ? null : (reason || (vendor.documents[docType]?.reason) || null);

    const url = (currentDoc && typeof currentDoc === 'object' ? currentDoc.url : (typeof currentDoc === 'string' ? currentDoc : '')) || '';

    // Use vendor.set for deep object persistence reliability
    vendor.set(`documents.${docType}`, {
        url,
        status,
        reason: newReason
    });

    // CRITICAL: Ensure Mongoose detects the change in the nested 'documents' object
    vendor.markModified('documents');

    // Check if all required documents (photo, idProof, addressProof) are verified or approved
    const requiredDocs = ['photo', 'idProof', 'addressProof'];
    const allVerified = requiredDocs.every(doc => {
        const d = vendor.documents[doc];
        return d && typeof d === 'object' && (d.status === 'verified' || d.status === 'approved');
    });

    console.log(`DEBUG Check: Vendor ${vendorId} - Doc: ${docType} -> ${status}. All Req Verified: ${allVerified}`);

    if (allVerified) {
        vendor.isVerified = true;
        vendor.documentStatus = 'approved';
        vendor.registrationStep = 'COMPLETED';

        // Start membership if not already started
        if (!vendor.membership.startDate) {
            const startDate = new Date();
            const durationMonths = vendor.membership.durationMonths || 3;
            const expiryDate = new Date();
            expiryDate.setMonth(expiryDate.getMonth() + durationMonths);

            vendor.membership.startDate = startDate;
            vendor.membership.expiryDate = expiryDate;
        }
    } else if (status === 'rejected') {
        vendor.isVerified = false;
        vendor.documentStatus = 'rejected';
    } else {
        vendor.isVerified = false;
        // Keep as pending if not all required docs are approved/verified
        vendor.documentStatus = 'pending';
    }

    await vendor.save();

    const message = allVerified 
        ? "Congratulations! Your account is now fully verified." 
        : (status === 'rejected' 
            ? `Your ${docType} has been rejected. Reason: ${reason || 'Please provide a valid document.'}` 
            : `Your ${docType} has been ${status}.`);

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
    vendor.registrationStep = 'COMPLETED';

    // Start membership if not already started
    if (!vendor.membership.startDate) {
        const startDate = new Date();
        const durationMonths = vendor.membership.durationMonths || 3;
        const expiryDate = new Date();
        expiryDate.setMonth(expiryDate.getMonth() + durationMonths);

        vendor.membership.startDate = startDate;
        vendor.membership.expiryDate = expiryDate;
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

    // Mark all pending/verified docs as rejected too if needed
    const docs = ['photo', 'idProof', 'addressProof'];
    docs.forEach(doc => {
        if (vendor.documents[doc]) {
            vendor.documents[doc].status = 'rejected';
            vendor.documents[doc].reason = reason;
        }
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


    vendor.membership.startDate = new Date();
    const expiryDate = new Date();
    expiryDate.setMonth(expiryDate.getMonth() + (vendor.membership.durationMonths || 3));
    vendor.membership.expiryDate = expiryDate;
    vendor.registrationStep = 'COMPLETED';

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
};

