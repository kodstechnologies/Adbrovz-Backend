const Vendor = require('../../models/Vendor.model');
const Subcategory = require('../../models/Subcategory.model');
const Category = require('../../models/Category.model');
const CreditPlan = require('../../models/CreditPlan.model');
const ApiError = require('../../utils/ApiError');

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
 * Step 2: Select services and calculate membership fee
 */
const selectServices = async (vendorId, { subcategoryIds, durationMonths }) => {
    const vendor = await Vendor.findById(vendorId);
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    if (durationMonths % 3 !== 0) {
        throw new ApiError(400, 'Duration must be in multiples of 3 months');
    }

    // Fetch subcategories to get prices and categories
    const subcategories = await Subcategory.find({ _id: { $in: subcategoryIds } }).populate('category', 'name');
    if (subcategories.length === 0) {
        throw new ApiError(400, 'No valid subcategories selected');
    }

    // Calculate total price: Sum of subcategory prices * (durationMonths / 3)
    const basePrice = subcategories.reduce((sum, sub) => sum + (sub.price || 0), 0);
    const totalPrice = basePrice * (durationMonths / 3);

    // Update vendor
    vendor.selectedSubcategories = subcategoryIds;
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

module.exports = {
    getAllVendors,
    selectServices,
    purchaseMembership,
    purchaseCreditPlan,
    verifyVendor,
    verifyDocument,
    verifyAllDocuments,
    toggleVendorSuspension,
    rejectVendorAccount,
};

