const Vendor = require('../../models/Vendor.model');
const Subcategory = require('../../models/Subcategory.model');
const Category = require('../../models/Category.model');
const CreditPlan = require('../../models/CreditPlan.model');
const Service = require('../../models/Service.model');
const ServiceType = require('../../models/ServiceType.model');
const PaymentRecord = require('../../models/PaymentRecord.model');
const Booking = require('../../models/Booking.model');
const ApiError = require('../../utils/ApiError');


const Razorpay = require('razorpay');
const crypto = require('crypto');
const mongoose = require('mongoose');
const config = require('../../config/env');
const { emitToVendor } = require('../../socket');
const { parseArrayInput } = require('../../utils/dataParser');
const adminService = require('../admin/admin.service');
const { sendPush } = require('../../utils/pushNotification');


const ensureCategorySubscriptions = async (vendor) => {
    if (vendor.registrationStep !== 'COMPLETED' && !vendor.isVerified) return;
    
    vendor.categorySubscriptions = vendor.categorySubscriptions || [];
    let modified = false;

    if (vendor.selectedCategories && vendor.selectedCategories.length > 0) {
        const Category = require('../../models/Category.model');
        const now = new Date();
        const renewalDays = (await adminService.getSetting('pricing.service_renewal_days')) || 0;
        
        let expiryDate = vendor.serviceRenewal?.expiryDate || new Date();
        if (expiryDate <= now) {
            expiryDate = new Date();
            expiryDate.setDate(expiryDate.getDate() + Number(renewalDays));
        }

        for (const catId of vendor.selectedCategories) {
            const catIdStr = catId.toString();
            const existingSub = vendor.categorySubscriptions.find(s => s.category && s.category.toString() === catIdStr);
            
            if (!existingSub) {
                const category = await Category.findById(catId).select('membershipCharge membershipFee');
                const fee = category ? (category.membershipCharge || category.membershipFee || 0) : 0;

                vendor.categorySubscriptions.push({
                    category: catId,
                    subcategories: vendor.selectedSubcategories || [],
                    services: vendor.selectedServices || [],
                    startDate: vendor.serviceRenewal?.startDate || now,
                    expiryDate: expiryDate,
                    fee: fee,
                    status: 'ACTIVE'
                });
                modified = true;
            } else {
                let subMod = false;
                if (!existingSub.services || existingSub.services.length === 0) {
                    existingSub.services = vendor.selectedServices || [];
                    subMod = true;
                }
                if (!existingSub.subcategories || existingSub.subcategories.length === 0) {
                    existingSub.subcategories = vendor.selectedSubcategories || [];
                    subMod = true;
                }
                if (subMod) {
                    modified = true;
                }
            }
        }
    }
    
    if (modified) {
        vendor.markModified('categorySubscriptions');
        await vendor.save();
        console.log(`[AUTO-HEAL] Synchronized categorySubscriptions for Vendor ${vendor._id}`);
    }
};

/**
 * Helper to map duration (3, 6, 12 months) to CreditPlan names
 */
const getPlanByDuration = async (months) => {
    // 1. Try name-based mapping first (Legacy support)
    let planName = null;
    if (months === 3) planName = 'Basic';
    else if (months === 6) planName = 'Pro';
    else if (months === 12) planName = 'Elite';

    let plan = null;
    if (planName) {
        plan = await CreditPlan.findOne({ name: planName }).lean();
    }

    // 2. Fallback to explicit validity days lookup
    if (!plan) {
        const targetDays = months * 30;
        plan = await CreditPlan.findOne({ validityDays: targetDays }).lean();
    }

    // 3. Last fallback: Find the plan with the closest validityDays
    if (!plan) {
        const targetDays = months * 10; // Adjust for legacy 3->30 mapping if needed, but better to use exact
        const allPlans = await CreditPlan.find().lean();
        if (allPlans.length > 0) {
            plan = allPlans.reduce((prev, curr) => {
                const prevDiff = Math.abs((prev.durationMonths || (prev.validityDays / 10)) - months);
                const currDiff = Math.abs((curr.durationMonths || (curr.validityDays / 10)) - months);
                return currDiff < prevDiff ? curr : prev;
            });
        }
    }

    if (!plan) {
        throw new ApiError(400, `Membership plan for ${months} months is not configured in the Admin Panel. Please contact support.`);
    }

    return {
        id: plan._id,
        name: plan.name,
        price: Number(plan.price),
        validityDays: Number(plan.validityDays),
        durationMonths: Number(plan.durationMonths || Math.round(plan.validityDays / 30))
    };
};



/**
 * Helper to canonicalize status strings (e.g. "Reject", "reject", "Verified") to match schema enums
 */
const canonicalizeStatus = (status) => {
    if (!status) return 'pending';
    const s = String(status).toLowerCase().trim();
    if (s.startsWith('reject')) return 'rejected';
    if (s.startsWith('approve') || s.startsWith('verify') || s === 'verified') return 'verified';
    return s;
};

const toNumber = (val) => {
    const num = Number(val);
    return isNaN(num) ? 0 : num;
};

const sumHierarchyServiceCharge = ({ category, subcategory, serviceType, service }) =>
    toNumber(category?.serviceCharge) +
    toNumber(subcategory?.serviceCharge) +
    toNumber(serviceType?.serviceCharge) +
    toNumber(service?.serviceCharge);

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
 * Internal helper to auto-derive and populate parent hierarchy (Categories, Subcategories, ServiceTypes)
 * from more specific selections (Services, ServiceTypes).
 */
const _deriveVendorHierarchy = async (vendor) => {
    const categoryIds = new Set(vendor.selectedCategories?.map(id => id.toString()) || []);
    const subcategoryIds = new Set(vendor.selectedSubcategories?.map(id => id.toString()) || []);
    const serviceTypeIds = new Set(vendor.selectedServiceTypes?.map(id => id.toString()) || []);
    const serviceIds = vendor.selectedServices?.map(id => id.toString()) || [];

    // 1. Derive from selectedServices
    if (serviceIds.length > 0) {
        const selectedServiceDocs = await Service.find({ _id: { $in: serviceIds } })
            .select('category subcategory serviceType');
        for (const svc of selectedServiceDocs) {
            if (svc.category) categoryIds.add(svc.category.toString());
            if (svc.subcategory) subcategoryIds.add(svc.subcategory.toString());
            if (svc.serviceType) serviceTypeIds.add(svc.serviceType.toString());
        }
    }

    // 2. Derive from selectedServiceTypes
    const stIds = [...serviceTypeIds];
    if (stIds.length > 0) {
        const selectedTypeDocs = await ServiceType.find({ _id: { $in: stIds } })
            .select('category subcategory');
        for (const type of selectedTypeDocs) {
            if (type.category) categoryIds.add(type.category.toString());
            if (type.subcategory) subcategoryIds.add(type.subcategory.toString());
        }
    }

    // 3. Derive from selectedSubcategories
    const subIds = [...subcategoryIds];
    if (subIds.length > 0) {
        const selectedSubDocs = await Subcategory.find({ _id: { $in: subIds } })
            .select('category');
        for (const sub of selectedSubDocs) {
            if (sub.category) categoryIds.add(sub.category.toString());
        }
    }

    // Update vendor document
    vendor.selectedCategories = [...categoryIds];
    vendor.selectedSubcategories = [...subcategoryIds];
    vendor.selectedServiceTypes = [...serviceTypeIds];
    
    console.log(`[Hierarchy] Derived for vendor ${vendor._id}: cats=${categoryIds.size}, subs=${subcategoryIds.size}, types=${serviceTypeIds.size}`);
};

/**
 * Internal helper to resolve membership fee from any item (Category, Subcategory, etc.)
 * Standardizes the fallback logic: membershipCharge > membershipFee > (price for sub) > serviceCharge
 */
const _getMembershipCharge = (item, type = 'service') => {
    if (!item) return 0;

    // The user requested to use serviceCharge exclusively for registration charges
    const svcCharge = toNumber(item.serviceCharge);
    if (svcCharge > 0) return svcCharge;

    // Fallback to membershipCharge/membershipFee only if serviceCharge is 0
    // but prioritize serviceCharge if it exists.
    const memCharge = toNumber(item.membershipCharge || item.membershipFee);
    
    // If we have a serviceCharge (even if 0), but also have a membershipCharge, 
    // the user's request suggests they want to see the serviceCharge.
    // However, if serviceCharge is 0 and membershipCharge is non-zero, 
    // it was previously falling back to membershipCharge. 
    // We'll keep the fallback but make it lower priority than any non-zero serviceCharge.
    
    if (svcCharge === 0 && memCharge > 0) {
        // Return 0 if they strictly want serviceCharge only, 
        // but usually we need a value if available.
        // Given "serviceCharge this only", I'll return svcCharge (0)
        return svcCharge;
    }

    return svcCharge;
};


/**
 * Internal helper to calculate membership fees consistently across APIs
 */
const _calculateMembershipAmounts = async ({ vendorId, durationMonths, membershipId, categoryId, subcategoryIds, serviceTypeIds, serviceIds }) => {
    let vendor = null;
    if (vendorId) {
        vendor = await Vendor.findById(vendorId).lean();
    }

    let plan = null;
    // Prioritize membershipId (CreditPlan ID) if provided
    if (membershipId) {
        plan = await CreditPlan.findById(membershipId).lean();
    }

    // Fallback to durationMonths if plan not found by ID
    if (!plan) {
        const months = Number(durationMonths || vendor?.membership?.durationMonths || 3);
        plan = await getPlanByDuration(months);
    }

    const baseFee = Number(plan.price || 0);

    let items = {
        categories: [],
        subcategories: [],
        serviceTypes: [],
        services: []
    };

    // 1. Resolve explicit subcategories
    const subIds = parseArrayInput(subcategoryIds || vendor?.selectedSubcategories);
    if (subIds.length > 0) items.subcategories = await Subcategory.find({ _id: { $in: subIds } }).lean();

    // 2. Resolve explicit service types
    const typeIds = parseArrayInput(serviceTypeIds || vendor?.selectedServiceTypes);
    if (typeIds.length > 0) items.serviceTypes = await ServiceType.find({ _id: { $in: typeIds } }).lean();

    // 3. Resolve explicit services
    const svcIds = parseArrayInput(serviceIds || vendor?.selectedServices);
    if (svcIds.length > 0) items.services = await Service.find({ _id: { $in: svcIds } }).lean();

    // 4. Pull parent hierarchy from selected service types and services so
    // membership-detail includes category + subcategory + type + service charges.
    const derivedSubIds = [
        ...items.serviceTypes.map(type => type.subcategory?.toString()).filter(Boolean),
        ...items.services.map(service => service.subcategory?.toString()).filter(Boolean)
    ];

    const missingSubIds = [...new Set(derivedSubIds)].filter(
        id => !items.subcategories.some(sub => sub._id.toString() === id)
    );
    if (missingSubIds.length > 0) {
        const derivedSubcategories = await Subcategory.find({ _id: { $in: missingSubIds } }).lean();
        items.subcategories = [...items.subcategories, ...derivedSubcategories];
    }

    const explicitCategoryIds = [
        ...(categoryId ? [categoryId] : []),
        ...(vendor?.selectedCategories?.map(id => id.toString()) || []),
        ...(vendor?.membership?.category ? [vendor.membership.category.toString()] : [])
    ];
    const derivedCategoryIds = [
        ...items.subcategories.map(sub => sub.category?.toString()).filter(Boolean),
        ...items.serviceTypes.map(type => type.category?.toString()).filter(Boolean),
        ...items.services.map(service => service.category?.toString()).filter(Boolean)
    ];
    const catIds = [...new Set([...explicitCategoryIds, ...derivedCategoryIds])];
    if (catIds.length > 0) items.categories = await Category.find({ _id: { $in: catIds } }).lean();

    const derivedTypeIds = items.services
        .map(service => service.serviceType?.toString())
        .filter(Boolean);
    const missingTypeIds = [...new Set(derivedTypeIds)].filter(
        id => !items.serviceTypes.some(type => type._id.toString() === id)
    );
    if (missingTypeIds.length > 0) {
        const derivedServiceTypes = await ServiceType.find({ _id: { $in: missingTypeIds } }).lean();
        items.serviceTypes = [...items.serviceTypes, ...derivedServiceTypes];
    }

    const categoryById = new Map(items.categories.map(category => [category._id.toString(), category]));
    const subcategoryById = new Map(items.subcategories.map(subcategory => [subcategory._id.toString(), subcategory]));
    const serviceTypeById = new Map(items.serviceTypes.map(serviceType => [serviceType._id.toString(), serviceType]));

    // Legacy serviceCharge fields are still returned for breakdown/debugging,
    // but the registration summary uses the base plan fee plus membership charges.
    let platformSubtotal = 0;
    if (items.categories.length > 0) items.categories.forEach(c => platformSubtotal += toNumber(c.serviceCharge));
    items.subcategories.forEach(s => platformSubtotal += toNumber(s.serviceCharge));
    items.serviceTypes.forEach(t => platformSubtotal += toNumber(t.serviceCharge));
    items.services.forEach(s => platformSubtotal += toNumber(s.serviceCharge));

    const membershipTotal = baseFee;

    // "Service Selections Total" comes from membership charges on selected items.
    let servicesSubtotal = 0;
    if (items.categories.length > 0) items.categories.forEach(c => servicesSubtotal += _getMembershipCharge(c, 'category'));
    items.subcategories.forEach(s => servicesSubtotal += _getMembershipCharge(s, 'subcategory'));
    items.serviceTypes.forEach(t => servicesSubtotal += _getMembershipCharge(t, 'serviceType'));
    items.services.forEach(s => servicesSubtotal += _getMembershipCharge(s, 'service'));

    const gstSetting = await adminService.getSetting('pricing.membership_gst_percent');
    const gstPercent = (gstSetting !== undefined && gstSetting !== null) ? Number(gstSetting) : 0;

    // GST is applied once on the full registration subtotal.
    const combinedSubtotal = membershipTotal + servicesSubtotal;
    const finalGst = Math.round(combinedSubtotal * (gstPercent / 100));
    const grandTotal = combinedSubtotal + finalGst;

    return {
        basePlanFee: baseFee,
        platformSubtotal,
        membershipTotal, // Treated as component in UI
        servicesSubtotal, // "Service Selections Total"
        combinedSubtotal,
        gstPercent,
        finalGst,
        grandTotal,
        durationMonths: Math.max(1, Math.round(plan.validityDays / 30)),
        validityDays: plan.validityDays, planId: plan._id,
        itemBreakdown: [
            {
                id: 'platform_base',
                title: 'Platform Membership Fee',
                type: 'platform',
                serviceCharge: 0,
                ownServiceCharge: 0,
                membershipCharge: membershipTotal
            },
            ...items.categories.map(c => ({
                id: c._id,
                title: c.name,
                type: 'category',
                serviceCharge: toNumber(c.serviceCharge),
                ownServiceCharge: toNumber(c.serviceCharge),
                membershipCharge: _getMembershipCharge(c, 'category')
            })),
            ...items.subcategories.map(s => ({
                id: s._id,
                title: s.name,
                type: 'subcategory',
                serviceCharge: sumHierarchyServiceCharge({
                    category: categoryById.get(s.category?.toString()),
                    subcategory: s
                }),
                ownServiceCharge: toNumber(s.serviceCharge),
                membershipCharge: _getMembershipCharge(s, 'subcategory')
            })),
            ...items.serviceTypes.map(t => ({
                id: t._id,
                title: t.name,
                type: 'serviceType',
                serviceCharge: sumHierarchyServiceCharge({
                    category: categoryById.get(t.category?.toString()),
                    subcategory: subcategoryById.get(t.subcategory?.toString()),
                    serviceType: t
                }),
                ownServiceCharge: toNumber(t.serviceCharge),
                membershipCharge: _getMembershipCharge(t, 'serviceType')
            })),
            ...items.services.map(s => ({
                id: s._id,
                title: s.title,
                type: 'service',
                serviceCharge: sumHierarchyServiceCharge({
                    category: categoryById.get(s.category?.toString()),
                    subcategory: subcategoryById.get(s.subcategory?.toString()),
                    serviceType: serviceTypeById.get(s.serviceType?.toString()),
                    service: s
                }),
                ownServiceCharge: toNumber(s.serviceCharge),
                membershipCharge: _getMembershipCharge(s, 'service')
            }))
        ]
    };
};

/**
 * Get all vendors
 * @returns {Promise<Array>} List of vendors
 */
const getAllVendors = async () => {
    const vendors = await Vendor.find()
        .populate('membership.category', 'name serviceCharge membershipCharge renewalCharge membershipRenewalCharge membershipFee')
        .populate('membership.membershipId', 'name price durationMonths validityDays')
        .populate('creditPlan.planId', 'name')
        .populate('selectedCategories', 'name serviceCharge membershipCharge renewalCharge membershipRenewalCharge membershipFee')
        .populate('categorySubscriptions.category', 'name serviceCharge membershipCharge')
        .populate('categorySubscriptions.subcategories', 'name serviceCharge price')
        .populate('categorySubscriptions.services', 'title serviceCharge')
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

    // 1. Post-process to derive hierarchy if missing
    const processedVendors = vendors.map(vendorDoc => {
        const vendor = vendorDoc.toJSON();

        const categoriesMap = new Map();
        const subcategoriesMap = new Map();
        const serviceTypesMap = new Map();

        // Helper to add to maps if not exists
        const addToMap = (map, item) => {
            if (item && item._id && !map.has(item._id.toString())) {
                map.set(item._id.toString(), item);
            }
        };

        // 1. Collect from explicit selections
        (vendor.selectedCategories || []).forEach(item => addToMap(categoriesMap, item));
        (vendor.selectedSubcategories || []).forEach(item => addToMap(subcategoriesMap, item));
        (vendor.selectedServiceTypes || []).forEach(item => addToMap(serviceTypesMap, item));

        // 2. Derive from selectedServices
        (vendor.selectedServices || []).forEach(service => {
            if (service.category) addToMap(categoriesMap, service.category);
            if (service.subcategory) addToMap(subcategoriesMap, service.subcategory);
            if (service.serviceType) addToMap(serviceTypesMap, service.serviceType);
        });

        // 3. Derive from selectedServiceTypes
        (vendor.selectedServiceTypes || []).forEach(type => {
            if (type.category) addToMap(categoriesMap, type.category);
            if (type.subcategory) addToMap(subcategoriesMap, type.subcategory);
        });

        // 4. Derive from selectedSubcategories
        (vendor.selectedSubcategories || []).forEach(sub => {
            if (sub.category) addToMap(categoriesMap, sub.category);
        });

        // Update arrays with derived data
        vendor.selectedCategories = Array.from(categoriesMap.values());
        vendor.selectedSubcategories = Array.from(subcategoriesMap.values());
        vendor.selectedServiceTypes = Array.from(serviceTypesMap.values());

        // Ensure membership category name is available for the UI
        if (!vendor.membership?.category && vendor.selectedCategories.length > 0) {
            vendor.membership = vendor.membership || {};
            vendor.membership.category = vendor.selectedCategories[0]; // Use first category as primary
        }

        // Flatten membership fields for the UI
        if (vendor.membership) {
            vendor.membershipFee = vendor.membership.membershipFee || vendor.membership.fee;
            vendor.membershipServiceFee = vendor.membership.serviceFee;
            vendor.membershipGst = vendor.membership.gstAmount;
            vendor.membershipSubtotal = vendor.membership.subtotal;
            vendor.membershipTotal = vendor.membership.totalAmount;
            vendor.membershipStart = vendor.membership.startDate;
            vendor.membershipExpiry = vendor.membership.expiryDate;
            if (vendor.membership.membershipId) {
                vendor.membershipPlan = vendor.membership.membershipId.name;
            }
        }

        const hasPendingDeletionApproval = Boolean(vendor.deletionRequest?.isRequested) && vendor.deletionRequest?.status === 'PENDING';
        const hasPendingServiceApproval = (vendor.serviceApprovalStatus || 'pending') === 'pending';
        const hasPendingExtraServiceApproval = (vendor.extraServiceRequests || []).some((req) => req?.approvalStatus === 'pending');
        const attentionReasons = [];
        if (hasPendingDeletionApproval) attentionReasons.push('DELETION_APPROVAL_PENDING');
        if (hasPendingServiceApproval) attentionReasons.push('SERVICE_APPROVAL_PENDING');
        if (hasPendingExtraServiceApproval) attentionReasons.push('EXTRA_SERVICE_APPROVAL_PENDING');

        // ── Admin UI Highlight for new service requests ──
        const pendingRequestCount = (vendor.extraServiceRequests || []).filter(req => req?.approvalStatus === 'pending').length 
            + (hasPendingServiceApproval ? 1 : 0);

        vendor.hasPendingServiceRequest = pendingRequestCount > 0;
        vendor.pendingRequestCount = pendingRequestCount;

        vendor.hasPendingServiceApproval = hasPendingServiceApproval;
        vendor.hasPendingExtraServiceApproval = hasPendingExtraServiceApproval;
        vendor.serviceApprovalStatus = vendor.serviceApprovalStatus || 'pending';
        vendor.requiresAttention = attentionReasons.length > 0;
        vendor.attentionColor = vendor.requiresAttention ? '#8B0000' : null;
        vendor.profileBorderColor = vendor.attentionColor;
        vendor.borderColor = vendor.attentionColor;
        vendor.attentionReasons = attentionReasons;

        return vendor;
    });

    // 2. Aggregate booking counts for all vendors
    const vendorIds = vendors.map(v => v._id);
    const bookingCounts = await Booking.aggregate([
        { $match: { vendor: { $in: vendorIds } } },
        { $group: { 
            _id: { vendor: "$vendor", status: "$status" }, 
            count: { $sum: 1 } 
        } }
    ]);

    const bookingStatusMap = {};
    bookingCounts.forEach(bc => {
        if (!bc._id.vendor) return;
        const vId = bc._id.vendor.toString();
        const status = bc._id.status;
        if (!bookingStatusMap[vId]) bookingStatusMap[vId] = {};
        bookingStatusMap[vId][status] = bc.count;
    });

    // 3. Attach booking counts to processed vendor objects
    return processedVendors.map(vendor => {
        vendor.bookingStatusCounts = bookingStatusMap[vendor.id] || {};
        return vendor;
    });
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

    const plansInfo = await getMembershipPlans(calc.servicesSubtotal);

    return {
        vendorId,
        subtotal: calc.combinedSubtotal,
        basePlanFee: calc.basePlanFee,
        totalServiceFee: calc.servicesSubtotal,
        platformSubtotal: calc.platformSubtotal,
        gstPercent: calc.gstPercent,
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
 * Get membership detail for a vendor (supports override selections from query/body)
 */
const getVendorMembershipDetails = async (vendorId, overrides = {}) => {
    const vendor = await Vendor.findById(vendorId)
        .select('selectedCategories selectedSubcategories selectedServiceTypes selectedServices membership.durationMonths membership.membershipId categorySubscriptions registrationStep serviceApprovalStatus')
        .populate({ path: 'categorySubscriptions.category', select: 'name' })
        .populate({ path: 'categorySubscriptions.subcategories', select: 'name' })
        .populate({ path: 'categorySubscriptions.services', select: 'title' });
    
    if (!vendor) throw new ApiError(404, 'Vendor not found');


    const normalizedCategoryId = overrides.categoryId || null;
    const normalizedSubcategoryIds = overrides.subcategoryIds || vendor.selectedSubcategories || [];
    const normalizedServiceTypeIds = overrides.serviceTypeIds || overrides.selectedServiceTypes || vendor.selectedServiceTypes || [];
    const normalizedServiceIds = overrides.serviceIds || overrides.selectedService || overrides.selectedServices || vendor.selectedServices || [];
    const normalizedDurationMonths = Number(overrides.durationMonths || vendor.membership?.durationMonths || 3);
    const normalizedMembershipId = overrides.membershipId || vendor.membership?.membershipId || null;

    const calc = await _calculateMembershipAmounts({
        vendorId,
        durationMonths: normalizedDurationMonths,
        membershipId: normalizedMembershipId,
        categoryId: normalizedCategoryId,
        subcategoryIds: normalizedSubcategoryIds,
        serviceTypeIds: normalizedServiceTypeIds,
        serviceIds: normalizedServiceIds
    });

    const plansInfo = await getMembershipPlans(calc.servicesSubtotal, { vendorId });
    const selectedServices = calc.itemBreakdown
        .filter((item) => item.type === 'service')
        .map((item) => ({
            id: item.id,
            title: item.title,
            serviceCharge: item.serviceCharge,
            membershipCharge: item.membershipCharge
        }));

    console.log('DEBUG: PaymentRecord in service:', PaymentRecord, 'typeof find:', typeof PaymentRecord?.find, 'mockImplementation:', PaymentRecord?.find?._isMockFunction);
    const paymentHistory = PaymentRecord && typeof PaymentRecord.find === 'function'
        ? await PaymentRecord.find({ vendor: vendorId, status: 'COMPLETED' })
            .sort({ createdAt: -1 })
            .populate('planId', 'name price validityDays')
            .lean()
        : [];

    const approvedServices = selectedServices.map((service) => ({
        id: service.id,
        name: service.title,
        serviceCharge: service.serviceCharge
    }));

    return {
        vendorId,
        subtotal: calc.combinedSubtotal,
        basePlanFee: calc.basePlanFee,
        membershipAmount: calc.basePlanFee,
        totalServiceFee: calc.servicesSubtotal,
        serviceAmount: calc.servicesSubtotal,
        platformSubtotal: calc.platformSubtotal,
        gstPercent: calc.gstPercent,
        gstAmount: calc.finalGst,
        totalFee: calc.grandTotal,
        totalAmount: calc.grandTotal,
        duration: `${calc.validityDays} days`,
        durationMonths: calc.durationMonths,
        plans: plansInfo,
        services: calc.itemBreakdown,
        serviceSelectionsTotal: calc.servicesSubtotal,
        selectedServices,
        selectedServiceNames: selectedServices.map((service) => service.title),
        selectedCategoryId: normalizedCategoryId,
        selectedSubcategoryIds: parseArrayInput(normalizedSubcategoryIds),
        selectedServiceTypeIds: parseArrayInput(normalizedServiceTypeIds),
        selectedServiceIds: parseArrayInput(normalizedServiceIds),
        categorySubscriptions: vendor.categorySubscriptions || [],
        paymentHistory: paymentHistory || [],
        membershipId: vendor.membership?.membershipId || null,
        approvedServices,
        notApprovedServices: [],
        amount: calc.grandTotal,
        serviceApprovalStatus: vendor.serviceApprovalStatus || 'pending',
        registrationStep: vendor.registrationStep || (vendor.serviceApprovalStatus === 'approved' ? 'SERVICES_APPROVED' : 'PENDING'),
        isServiceVerified: vendor.serviceApprovalStatus === 'approved'
    };
};


/**
 * Create Razorpay order for membership payment
 * vendorId is extracted from token (req.user), NOT from URL
 */
const createMembershipOrder = async (vendorId, { durationMonths, amount, membershipId, planId } = {}) => {
    const vendor = await Vendor.findById(vendorId);
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    // Allow payment if:
    //  • registrationStep is one of the approved/active steps, OR
    //  • admin has explicitly set serviceApprovalStatus to 'approved'
    //    (covers SERVICES_SELECTED step which is set after service selection but before payment)
    const ALLOWED_STEPS = ['SERVICES_APPROVED', 'PENDING', 'MEMBERSHIP_PAID', 'PLAN_PAID', 'COMPLETED', 'SIGNUP_COMPLETED'];
    const isStepAllowed = ALLOWED_STEPS.includes(vendor.registrationStep);
    const isAdminApproved = vendor.serviceApprovalStatus === 'approved';

    if (!isStepAllowed && !isAdminApproved) {
        throw new ApiError(400, 'Please wait for admin service approval before purchasing membership');
    }

    // Accept planId as an alias for membershipId (the app sends planId from the plan selection screen)
    const resolvedMembershipId = membershipId || planId || null;

    // Update durationMonths if provided
    if (durationMonths) {
        vendor.membership.durationMonths = Number(durationMonths);
        await vendor.save();
    }
    
    // Calculate full fee using the centralized helper
    const calc = await _calculateMembershipAmounts({ vendorId, durationMonths, membershipId: resolvedMembershipId });
    const totalFee = calc.grandTotal;

    // Ensure the resolved membershipId is persisted to the vendor
    vendor.membership = vendor.membership || {};
    vendor.membership.membershipId = calc.planId;
    await vendor.save();

    let razorpayOrder;
    try {
        if (totalFee <= 0) {
            razorpayOrder = {
                id: `order_free_${vendor._id.toString().slice(-10)}_${Date.now()}`,
                amount: 0,
                currency: 'INR',
                receipt: `m_${vendor._id.toString().slice(-10)}_${Date.now()}`,
                status: 'created'
            };
        } else {
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
        }
        // Log the pending payment record
        await PaymentRecord.create({
            vendor: vendorId,
            orderId: razorpayOrder.id,
            purpose: 'MEMBERSHIP_PURCHASE',
            amount: calc.combinedSubtotal,
            gstAmount: calc.finalGst,
            totalAmount: calc.grandTotal,
            validityDays: calc.validityDays,
            metadata: {
                services: calc.itemBreakdown,
                serviceSelectionsTotal: calc.servicesSubtotal,
                basePlanFee: calc.basePlanFee,
                durationMonths: durationMonths || calc.durationMonths
            },
            status: 'PENDING'
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

    // ── Intercept already approved/paid vendors ──
    const hasPaid = ['MEMBERSHIP_PAID', 'PLAN_PAID', 'COMPLETED', 'SIGNUP_COMPLETED'].includes(vendor.registrationStep);
    if (hasPaid || vendor.isVerified) {
        console.log(`[selectServices] Vendor ${vendorId} is already active/paid. Routing to extraServiceRequests to prevent membership overwrite.`);
        
        await requestExtraServiceApproval(vendorId, {
            categoryId,
            subcategoryIds: parseArrayInput(subcategoryIds),
            serviceIds: parseArrayInput(serviceIds)
        });

        // Return a mock calculation response to satisfy frontend expectations, 
        // without actually mutating the core membership fees.
        return {
            totalPrice: vendor.membership?.totalAmount || 0,
            durationMonths: vendor.membership?.durationMonths || durationMonths,
            membershipTotal: vendor.membership?.membershipFee || 0,
            serviceSelectionsTotal: vendor.membership?.serviceFee || 0,
            gstAmount: vendor.membership?.gstAmount || 0,
            itemBreakdown: []
        };
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

    // ── Auto-derive parent hierarchy (Categories, Subcategories, etc.) ──
    await _deriveVendorHierarchy(vendor);

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
    vendor.membership.membershipFee = calc.membershipTotal;
    vendor.membership.serviceFee = calc.servicesSubtotal;
    vendor.membership.gstAmount = calc.finalGst;
    vendor.membership.totalAmount = calc.grandTotal;
    vendor.membership.subtotal = calc.combinedSubtotal;
    vendor.membership.fee = calc.grandTotal; // Keep for legacy compatibility
    vendor.membership.durationMonths = durationMonths;
    vendor.registrationStep = 'SERVICES_SELECTED';
    vendor.serviceApprovalStatus = 'pending';

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
 * Admin: Approve and Update Vendor Services
 */
const approveVendorServices = async (vendorId, serviceData) => {
    const vendor = await Vendor.findById(vendorId);
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    // Normalize field names
    const categoryId = serviceData.categoryId || serviceData.selectedCategory || serviceData.category;
    const subcategoryIds = serviceData.subcategoryIds || serviceData.selectedSubcategories || serviceData.subcategories;
    const serviceTypeIds = serviceData.serviceTypeIds || serviceData.selectedType || serviceData.selectedServiceTypes || serviceData.serviceTypes;
    const serviceIds = serviceData.serviceIds || serviceData.selectedService || serviceData.selectedServices || serviceData.services;
    const durationMonths = Number(serviceData.durationMonths || vendor.membership?.durationMonths || 3);

    const originalServiceIds = vendor.selectedServices.map(id => id.toString());
    const newServiceIds = parseArrayInput(serviceIds);

    // Save Selections to Vendor
    const PAID_STEPS = ['COMPLETED', 'MEMBERSHIP_PAID', 'PLAN_PAID', 'SIGNUP_COMPLETED'];
    const vendorAlreadyPaid = PAID_STEPS.includes(vendor.registrationStep) || vendor.isVerified || vendor.registrationStep === 'SERVICES_APPROVED';

    if (vendorAlreadyPaid) {
        // Already paid or verified vendor flow:
        // 1. Merge selections instead of overwriting to keep existing approved/active services
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
            vendor.selectedSubcategories = parseArrayInput(subcategoryIds).map(id => new mongoose.Types.ObjectId(id));
        }
        if (serviceTypeIds) {
            vendor.selectedServiceTypes = parseArrayInput(serviceTypeIds).map(id => new mongoose.Types.ObjectId(id));
        }
        if (serviceIds) {
            vendor.selectedServices = parseArrayInput(serviceIds).map(id => new mongoose.Types.ObjectId(id));
        }
    } else {
        // First-time registration approval flow:
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
            vendor.selectedServices = newServiceIds;
        }
    }

    // For first-time registration approval flow, recalculate and persist membership fee
    if (!vendorAlreadyPaid) {
        // Auto-derive parent hierarchy
        await _deriveVendorHierarchy(vendor);

        // Recalculate membership amounts based on current selections
        const calc = await _calculateMembershipAmounts({
            vendorId,
            durationMonths,
            categoryId,
            subcategoryIds,
            serviceTypeIds,
            serviceIds: newServiceIds
        });

        vendor.membership.membershipFee = calc.membershipTotal;
        vendor.membership.serviceFee = calc.servicesSubtotal;
        vendor.membership.gstAmount = calc.finalGst;
        vendor.membership.totalAmount = calc.grandTotal;
        vendor.membership.subtotal = calc.combinedSubtotal;
        vendor.membership.fee = calc.grandTotal; // Keep for legacy compatibility
        vendor.membership.durationMonths = durationMonths;
        vendor.registrationStep = 'SERVICES_APPROVED';
    }
    // Set approval status and persist changes
    vendor.serviceApprovalStatus = 'approved';
    await vendor.save();

    // Determine approved vs not approved services
    let approvedServices = [];
    let notApprovedServices = [];

    if (vendorAlreadyPaid) {
        const finalServiceIds = vendor.selectedServices.map(id => id.toString());
        const finalServices = await Service.find({ _id: { $in: finalServiceIds } }).lean();
        approvedServices = finalServices.map(svc => ({
            id: svc._id,
            name: svc.name,
            serviceCharge: svc.serviceCharge
        }));
        notApprovedServices = [];
    } else {
        const finalServices = await Service.find({ _id: { $in: newServiceIds } }).lean();
        approvedServices = finalServices.map(svc => ({
            id: svc._id,
            name: svc.name,
            serviceCharge: svc.serviceCharge
        }));

        const originalServices = await Service.find({ _id: { $in: originalServiceIds } }).lean();
        const newServiceIdsSet = new Set(newServiceIds.map(id => id.toString()));
        for (const svc of originalServices) {
            const svcIdStr = svc._id.toString();
            if (!newServiceIdsSet.has(svcIdStr)) {
                notApprovedServices.push({
                    id: svc._id,
                    name: svc.name,
                    serviceCharge: svc.serviceCharge
                });
            }
        }
    }

    // Resolve the definitive membership total (already-paid vendors keep their stored fee)
    const membershipAmount = vendor.membership?.totalAmount || vendor.membership?.fee || 0;

    // Construct Socket payload
    const payload = {
        approvedServices,
        notApprovedServices,
        serviceApprovalStatus: vendor.serviceApprovalStatus || 'pending',
        amount: membershipAmount,
        registrationStep: vendor.registrationStep,
        isServiceVerified: vendor.serviceApprovalStatus === 'approved',
        updatedAt: new Date()
    };

    // Emit Socket events to vendor (legacy + current listener compatibility)
    emitToVendor(vendor._id, 'service_approval_response', payload);
    emitToVendor(vendor._id, 'service_approval_update', payload);

    // Send Push Notification
    try {
        await sendPush(
            vendor._id,
            'Vendor',
            'service_approval',
            'Services Approved',
            'Your services have been approved by the administrator. Please proceed to payment.',
            { registrationStep: vendor.registrationStep, amount: String(membershipAmount) }
        );
    } catch (pushError) {
        console.error('Error sending service approval push notification:', pushError);
    }

    return {
        vendor,
        approvedServices,
        notApprovedServices,
        amount: membershipAmount,
        isServiceVerified: vendor.serviceApprovalStatus === 'approved'
    };
};

/**
 * Vendor: Get Service Approval Status and Amount
 */
const getServiceApprovalStatus = async (vendorId) => {
    const vendor = await Vendor.findById(vendorId).populate('selectedServices');
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    const durationMonths = vendor.membership?.durationMonths || 3;
    const calc = await _calculateMembershipAmounts({
        vendorId,
        durationMonths,
        serviceIds: vendor.selectedServices.map(s => s._id)
    });

    const services = vendor.selectedServices.map(svc => ({
        id: svc._id,
        name: svc.name,
        status: vendor.serviceApprovalStatus || 'pending'
    }));

    const approvedServices = vendor.serviceApprovalStatus === 'approved'
        ? vendor.selectedServices.map((svc) => ({
            id: svc._id,
            name: svc.name,
            serviceCharge: svc.serviceCharge || 0
        }))
        : [];

    const notApprovedServices = vendor.serviceApprovalStatus === 'approved'
        ? []
        : vendor.selectedServices.map((svc) => ({
            id: svc._id,
            name: svc.name,
            serviceCharge: svc.serviceCharge || 0
        }));

    return {
        services,
        approvedServices,
        notApprovedServices,
        amount: calc.grandTotal,
        registrationStep: vendor.registrationStep,
        isServiceVerified: vendor.serviceApprovalStatus === 'approved'
    };
};

/**
 * Step 3: Purchase Membership (Demo)
 */
const purchaseMembership = async (vendorId) => {
    const vendor = await Vendor.findById(vendorId);
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    if (vendor.registrationStep !== 'SERVICES_APPROVED' && vendor.registrationStep !== 'PENDING') {
        throw new ApiError(400, 'Please wait for admin service approval before purchasing membership');
    }

    if (vendor.isVerified) {
        vendor.membership.startDate = new Date();
        const adminService = require('../admin/admin.service');
        const durationMonths = vendor.membership.durationMonths || 3;
        const plan = await getPlanByDuration(durationMonths);
        const validityDays = (plan.validityDays !== undefined && plan.validityDays !== null && plan.validityDays !== '') ? Number(plan.validityDays) : (durationMonths * 30);

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
        
        const _rd1 = await adminService.getSetting('pricing.service_renewal_days');
        const renewalDays = (_rd1 !== undefined && _rd1 !== null && _rd1 !== '') ? Number(_rd1) : 30;
        renExpiry.setDate(renExpiry.getDate() + Number(renewalDays));
        vendor.serviceRenewal.expiryDate = renExpiry;

        vendor.registrationStep = 'COMPLETED';
    } else {
        vendor.registrationStep = 'MEMBERSHIP_PAID';
    }

    // Ensure membership metadata is populated if missing
    if (!vendor.membership.totalAmount || !vendor.membership.category) {
        try {
            const memDetails = await getVendorMembershipDetails(vendorId);
            vendor.membership.membershipFee = memDetails.basePlanFee; 
            vendor.membership.serviceFee = memDetails.totalServiceFee;
            vendor.membership.gstAmount = memDetails.gstAmount;
            vendor.membership.totalAmount = memDetails.totalFee;
            vendor.membership.subtotal = memDetails.subtotal;
            vendor.membership.fee = memDetails.basePlanFee; 
            vendor.membership.durationMonths = memDetails.durationMonths;

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
const getMembershipPlans = async (serviceMembershipFee = 0, options = {}) => {
    const adminService = require('../admin/admin.service');
    const tiers = await CreditPlan.find({
        name: { $in: ['Basic', 'Pro', 'Elite'] }
    }).sort({ price: 1 }).lean();
    
    const vendorId = options?.vendorId;

    let resolvedServiceMembershipFee = serviceMembershipFee;
    if ((resolvedServiceMembershipFee === undefined || resolvedServiceMembershipFee === null) && vendorId) {
        const calc = await _calculateMembershipAmounts({ vendorId });
        resolvedServiceMembershipFee = calc.servicesSubtotal;
    }

    const gstSetting = await adminService.getSetting('pricing.membership_gst_percent');
    const gstPercent = (gstSetting !== undefined && gstSetting !== null) ? Number(gstSetting) : 0; // Use 18 as consistent default


    const result = [];
    for (const plan of tiers) {
        const baseFee = (plan.price || 0);
        const validityDays = (plan.validityDays !== undefined && plan.validityDays !== null && plan.validityDays !== '') ? Number(plan.validityDays) : 30;
        const serviceFee = Number(resolvedServiceMembershipFee || 0);

        const subtotal = baseFee + serviceFee;
        const gstAmount = Math.round(subtotal * (gstPercent / 100));
        const totalFee = Number(subtotal + gstAmount);

        // Approximate duration in months based on validityDays
        const durationMonths = Math.max(1, Math.round(validityDays / 30));

        result.push({
            planId: plan._id,
            name: plan.name,
            durationMonths: durationMonths,
            label: `${plan.name} (${validityDays} Days)`,
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
    const { isCategoryValid, isSubcategoryValid, isServiceTypeValid } = require('../service/service.service');
    const categories = await Category.find({ isActive: { $ne: false } }).lean();
    const subcategories = await Subcategory.find({ isActive: { $ne: false } }).lean();
    const services = await Service.find({ isActive: { $ne: false } }).lean();

    const formatted = [];
    for (const cat of categories) {
        const isCatOk = await isCategoryValid(cat._id);
        if (!isCatOk) continue;

        const catSubcategories = [];
        for (const sub of subcategories) {
            if (sub.category && sub.category.toString() === cat._id.toString()) {
                const isSubOk = await isSubcategoryValid(sub._id);
                if (!isSubOk) continue;

                const subServices = [];
                for (const svc of services) {
                    if (svc.subcategory && svc.subcategory.toString() === sub._id.toString()) {
                        const isTypeOk = svc.serviceType ? await isServiceTypeValid(svc.serviceType) : true;
                        if (isTypeOk) {
                            subServices.push({
                                id: svc._id,
                                name: svc.title,
                                membershipFee: _getMembershipCharge(svc, 'service')
                            });
                        }
                    }
                }

                catSubcategories.push({
                    id: sub._id,
                    name: sub.name,
                    membershipFee: _getMembershipCharge(sub, 'subcategory'),
                    serviceRenewalCharge: sub.serviceRenewalCharge || 0,
                    renewalCharge: sub.renewalCharge || 0,
                    services: subServices
                });
            }
        }

        const catServices = [];
        for (const svc of services) {
            if (svc.category && svc.category.toString() === cat._id.toString() && !svc.subcategory) {
                catServices.push({
                    id: svc._id,
                    name: svc.title,
                    membershipFee: _getMembershipCharge(svc, 'service')
                });
            }
        }

        formatted.push({
            id: cat._id,
            name: cat.name,
            membershipFee: _getMembershipCharge(cat, 'category'),
            serviceRenewalCharge: cat.serviceRenewalCharge || 0,
            renewalCharge: cat.renewalCharge || 0,
            subcategories: catSubcategories,
            services: catServices
        });
    }

    // After building the hierarchical category structure, also attach any approved extra service requests
    // Extra services are stored in vendor.extraServiceRequests and have fields: category, subcategories, services, isPurchased, etc.
    // We expose them as a separate top‑level array `extraServices` so the front‑end can render them clearly.
    const extraServices = [];
    if (vendor.extraServiceRequests && vendor.extraServiceRequests.length) {
        for (const req of vendor.extraServiceRequests) {
            // Only show approved (or purchased) extra services – pending requests are handled elsewhere
            if (req.approvalStatus !== 'approved' && req.approvalStatus !== 'purchased') continue;
            const cat = await Category.findById(req.category).lean();
            const catName = cat ? cat.name : null;
            const subcats = [];
            for (const subId of req.subcategories || []) {
                const sub = await Subcategory.findById(subId).lean();
                if (sub) subcats.push({ id: sub._id, name: sub.name });
            }
            const svcList = [];
            for (const svcId of req.services || []) {
                const svc = await Service.findById(svcId).lean();
                if (svc) svcList.push({ id: svc._id, name: svc.title });
            }
            extraServices.push({
                requestId: req._id,
                category: catName,
                subcategories: subcats,
                services: svcList,
                isPurchased: true,
                payable: req.payable || {}
            });
        }
    }

    // Attach the extra services list to the formatted response
    if (extraServices.length) {
        formatted.push({
            id: null,
            name: 'Extra Services',
            membershipFee: 0,
            serviceRenewalCharge: 0,
            renewalCharge: 0,
            subcategories: [],
            services: [],
            extraServices
        });
    }

    return formatted;
};

/**
 * Get categories available for purchase (Excluding already selected ones)
 */
/**
 * Internal helper to calculate prorated amount based on remaining days of membership or category subscription.
 * Calculation: (Amount / 30) * RemainingDays
 */
const _calculateProration = (vendor, categoryId, amount, renewalDays = 30) => {
    const now = new Date();
    let expiryDate = null;
    let startDate = null;

    const activeExpiries = [];

    // 1. Check if there's an existing active category subscription for this category
    if (categoryId && vendor.categorySubscriptions) {
        const catSub = vendor.categorySubscriptions.find(s => 
            s.category && s.category.toString() === categoryId.toString() && 
            s.expiryDate > now && 
            s.status === 'ACTIVE'
        );
        if (catSub) {
            activeExpiries.push({ expiryDate: new Date(catSub.expiryDate), startDate: catSub.startDate ? new Date(catSub.startDate) : null });
        }
    }

    // 2. Check other active category subscriptions
    if (vendor.categorySubscriptions) {
        vendor.categorySubscriptions.forEach(s => {
            if (s.expiryDate && new Date(s.expiryDate) > now && s.status === 'ACTIVE') {
                activeExpiries.push({ expiryDate: new Date(s.expiryDate), startDate: s.startDate ? new Date(s.startDate) : null });
            }
        });
    }

    // 3. Check main service renewal
    const renExp = vendor.serviceRenewal?.expiryDate ? new Date(vendor.serviceRenewal.expiryDate) : null;
    const renStart = vendor.serviceRenewal?.startDate ? new Date(vendor.serviceRenewal.startDate) : null;
    
    if (renExp && renExp > now) {
        activeExpiries.push({ expiryDate: renExp, startDate: renStart });
    }

    if (activeExpiries.length > 0) {
        // We find the one with the maximum (latest) expiryDate to align to
        let alignedRecord = activeExpiries[0];
        for (let i = 1; i < activeExpiries.length; i++) {
            if (activeExpiries[i].expiryDate > alignedRecord.expiryDate) {
                alignedRecord = activeExpiries[i];
            }
        }
        expiryDate = alignedRecord.expiryDate;
        startDate = alignedRecord.startDate;
    }

    // 4. If no active period found, no proration possible (assume full renewalDays)
    if (!expiryDate) {
        return { 
            amount: amount <= 0 ? 0 : amount, 
            remainingDays: renewalDays, 
            factor: 1, 
            isProrated: false,
            cycleDuration: renewalDays
        };
    }

    const diffTime = expiryDate - now;
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    
    // Calculate total cycle duration from the previously purchased service's dates
    let cycleDuration = renewalDays;
    if (startDate && expiryDate > startDate) {
        const cycleTime = expiryDate - startDate;
        cycleDuration = Math.ceil(cycleTime / (1000 * 60 * 60 * 24));
    }
    
    // Fallback in case cycleDuration is calculated as 0
    if (cycleDuration <= 0) cycleDuration = renewalDays;

    // Calculate factor based on the actual cycle duration of the previously purchased service!
    const factor = Math.max(0, Math.min(1, diffDays / cycleDuration));
    
    return {
        amount: amount <= 0 ? 0 : Math.round(amount * factor),
        remainingDays: diffDays,
        factor,
        expiryDate,
        isProrated: factor < 1,
        cycleDuration
    };
};

const getAvailablePurchaseCategories = async (vendorId) => {
    const vendor = await Vendor.findById(vendorId).lean();
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    const gstSetting = await adminService.getSetting('pricing.membership_gst_percent');
    const gstPercent = (gstSetting !== undefined && gstSetting !== null) ? Number(gstSetting) : 0;

    const allCategories = await Category.find({ isActive: { $ne: false } }).lean();
    const allSubcategories = await Subcategory.find({ isActive: { $ne: false } }).lean();
    const allServices = await Service.find({ isActive: { $ne: false } }).lean();
    const allServiceTypes = await ServiceType.find({ isActive: { $ne: false } }).lean();

    const { isCategoryValid, isSubcategoryValid, isServiceTypeValid } = require('../service/service.service');

    const validCategoryIds = new Set();
    const validSubcategoryIds = new Set();
    const validServiceTypeIds = new Set();

    for (const cat of allCategories) {
        if (await isCategoryValid(cat._id)) {
            validCategoryIds.add(cat._id.toString());
        }
    }
    for (const sub of allSubcategories) {
        if (await isSubcategoryValid(sub._id)) {
            validSubcategoryIds.add(sub._id.toString());
        }
    }
    for (const type of allServiceTypes) {
        if (await isServiceTypeValid(type._id)) {
            validServiceTypeIds.add(type._id.toString());
        }
    }

    const selectedCategoryIds = new Set((vendor.selectedCategories || []).map(id => id.toString()));
    const selectedSubcategoryIds = new Set((vendor.selectedSubcategories || []).map(id => id.toString()));
    const selectedServiceIds = new Set((vendor.selectedServices || []).map(id => id.toString()));

    // Also include categories, subcategories, and services purchased via the "add category" flow (categorySubscriptions)
    for (const catSub of (vendor.categorySubscriptions || [])) {
        if (catSub.category) {
            selectedCategoryIds.add(catSub.category.toString());
        }
        for (const subId of (catSub.subcategories || [])) {
            selectedSubcategoryIds.add(subId.toString());
        }
        for (const svcId of (catSub.services || [])) {
            selectedServiceIds.add(svcId.toString());
        }
    }

    // Derive purchased hierarchy strictly from purchased services.
    // Rule 1: A category/subcategory/type is "purchased" only if at least one of its
    // services is in selectedServiceIds. We do NOT use selectedCategories/selectedSubcategories
    // alone because those are registration selections, not guaranteed purchases.
    const purchasedCategoryIdsFromServices = new Set();
    const purchasedSubcategoryIdsFromServices = new Set();
    const purchasedTypeIdsFromServices = new Set();

    for (const s of allServices) {
        if (selectedServiceIds.has(s._id.toString())) {
            if (s.category) purchasedCategoryIdsFromServices.add(s.category.toString());
            if (s.subcategory) purchasedSubcategoryIdsFromServices.add(s.subcategory.toString());
            if (s.serviceType) purchasedTypeIdsFromServices.add(s.serviceType.toString());
        }
    }

    // Merge with explicit selected IDs for suppression
    const finalPurchasedCategoryIds    = new Set([...selectedCategoryIds,    ...purchasedCategoryIdsFromServices]);
    const finalPurchasedSubcategoryIds = new Set([...selectedSubcategoryIds, ...purchasedSubcategoryIdsFromServices]);
    const finalPurchasedTypeIds        = new Set([...(vendor.selectedServiceTypes || []).map(id => id.toString()), ...purchasedTypeIdsFromServices]);

    const categoryMap = new Map();
    const subcategoryMap = new Map(allSubcategories.map(sub => [sub._id.toString(), sub]));
    const typeMap = new Map(allServiceTypes.map(type => [type._id.toString(), type]));

    const ensureCategory = (cat) => {
        const catId = cat._id.toString();
        if (!categoryMap.has(catId)) {
            categoryMap.set(catId, {
                categoryId: cat._id,
                categoryName: cat.name,
                categoryCharge: _getMembershipCharge(cat, 'category'),
                isPurchased: finalPurchasedCategoryIds.has(catId),
                subCategories: []
            });
        }
        return categoryMap.get(catId);
    };

    const ensureSubcategory = (catNode, sub) => {
        const subId = sub._id.toString();
        let subNode = catNode.subCategories.find(item => item.subcategoryId.toString() === subId);
        if (!subNode) {
            subNode = {
                subcategoryId: sub._id,
                subcategoryName: sub.name,
                subcategoryCharge: _getMembershipCharge(sub, 'subcategory'),
                isPurchased: finalPurchasedSubcategoryIds.has(subId),
                types: []
            };
            catNode.subCategories.push(subNode);
        }
        return subNode;
    };

    const ensureType = (subNode, type) => {
        const typeId = type._id.toString();
        let typeNode = subNode.types.find(item => item.typeId.toString() === typeId);
        if (!typeNode) {
            typeNode = {
                typeId: type._id,
                typeName: type.name,
                typeCharge: _getMembershipCharge(type, 'serviceType'),
                // A type is purchased if it has a purchased service OR was selected during registration
                isPurchased: finalPurchasedTypeIds.has(typeId),
                services: []
            };
            subNode.types.push(typeNode);
        }
        return typeNode;
    };

    for (const service of allServices) {
        const catId = service.category?.toString();
        const subId = service.subcategory?.toString();
        const typeId = service.serviceType?.toString();
        if (!catId || !subId || !typeId) continue;
        if (!validCategoryIds.has(catId) || !validSubcategoryIds.has(subId) || !validServiceTypeIds.has(typeId)) continue;

        const cat = allCategories.find(item => item._id.toString() === catId);
        const sub = subcategoryMap.get(subId);
        const type = typeMap.get(typeId);
        if (!cat || !sub || !type) continue;

        const catNode = ensureCategory(cat);
        const subNode = ensureSubcategory(catNode, sub);
        const typeNode = ensureType(subNode, type);

        const isServicePurchased = selectedServiceIds.has(service._id.toString());
        const serviceRegistrationCharge = _getMembershipCharge(service, 'service');


        // Rule 1: Category/subcategory charges are suppressed if purchased via ANY service.
        // Rule 2: Type charge is suppressed only for THIS type if it has a purchased service;
        //         sibling types with no purchased services still owe their typeCharge.
        // Rule 3: Service charge is suppressed only for THIS specific purchased service.
        const categoryChargeToPay = catNode.isPurchased ? 0 : catNode.categoryCharge;
        const subcategoryChargeToPay = subNode.isPurchased ? 0 : subNode.subcategoryCharge;
        const typeChargeToPay = typeNode.isPurchased ? 0 : typeNode.typeCharge;
        const serviceChargeToPay = isServicePurchased ? 0 : serviceRegistrationCharge;

        const subtotalToPay = categoryChargeToPay + subcategoryChargeToPay + typeChargeToPay + serviceChargeToPay;
        const gstToPay = Math.round(subtotalToPay * (gstPercent / 100));
        const totalToPay = subtotalToPay + gstToPay;

        typeNode.services.push({
            serviceId: service._id,
            serviceName: service.title,
            serviceCharge: serviceRegistrationCharge,
            isPurchased: isServicePurchased,
            isSelectable: !isServicePurchased,
            payable: {
                categoryCharge: categoryChargeToPay,
                subcategoryCharge: subcategoryChargeToPay,
                typeCharge: typeChargeToPay,
                serviceCharge: serviceChargeToPay,
                gstPercent,
                gstAmount: gstToPay,
                subtotal: subtotalToPay,
                total: totalToPay
            }
        });
    }

    return Array.from(categoryMap.values());
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
 * Internal helper to process and store new approved extra service requests during verification
 */
const _processApprovedExtraServices = async (vendor, payload, adminId = null) => {
    if (!payload) return;

    let requests = [];

    if (payload.extraServiceRequests && Array.isArray(payload.extraServiceRequests)) {
        requests = payload.extraServiceRequests;
    } else if (payload.extraServiceRequest && typeof payload.extraServiceRequest === 'object') {
        requests = [payload.extraServiceRequest];
    } else if (payload.serviceIds || payload.services) {
        requests = [{
            categoryId: payload.categoryId || payload.category,
            subcategoryIds: payload.subcategoryIds || payload.subcategories || [],
            serviceIds: payload.serviceIds || payload.services || []
        }];
    }

    if (requests.length === 0) return;

    vendor.extraServiceRequests = vendor.extraServiceRequests || [];

    for (const reqData of requests) {
        const catId = reqData.categoryId || reqData.category || null;
        const subcatIds = parseArrayInput(reqData.subcategoryIds || reqData.subcategories || []);
        const svcIds = parseArrayInput(reqData.serviceIds || reqData.services || []);

        if (!svcIds || svcIds.length === 0) continue;

        vendor.extraServiceRequests.push({
            requestedBy: vendor._id,
            category: catId || undefined,
            subcategories: subcatIds,
            services: svcIds,
            approvalStatus: 'approved',
            adminRemark: reqData.adminRemark || 'Approved during vendor verification',
            reviewedBy: adminId || null,
            reviewedAt: new Date(),
            requestedAt: reqData.requestedAt || new Date()
        });
    }

    vendor.markModified('extraServiceRequests');
};

/**
 * Admin: Verify Vendor Document
 */
const verifyDocument = async (vendorId, payload = {}) => {
    const { docType, status, reason, adminId } = payload;
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

    // Check if all documents that have been uploaded are verified
    // AND that the basic required documents (photo, idProof, addressProof) are present and verified
    const requiredDocs = ['photo', 'idProof', 'addressProof'];
    const allUploadedVerified = Object.keys(vendor.documents).every(doc => {
        const d = vendor.documents[doc];
        if (!d || !d.url) return true; // Ignore missing docs
        return d.status === 'verified' || d.status === 'approved';
    });
    
    const basicReqsPresent = requiredDocs.every(doc => {
        const d = vendor.documents[doc];
        return d && d.url && (d.status === 'verified' || d.status === 'approved');
    });

    const allRequiredVerified = allUploadedVerified && basicReqsPresent;

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

        // Auto-approve existing pending extra service requests
        if (vendor.extraServiceRequests && vendor.extraServiceRequests.length > 0) {
            vendor.extraServiceRequests.forEach(req => {
                if (req.approvalStatus === 'pending') {
                    req.approvalStatus = 'approved';
                    req.reviewedBy = adminId || null;
                    req.reviewedAt = new Date();
                    req.adminRemark = 'Auto-approved during document verification';
                }
            });
            vendor.markModified('extraServiceRequests');
        }

        // Process any new extra service requests passed in the payload
        await _processApprovedExtraServices(vendor, payload, adminId);

        // Set registrationStep and startDate IF already paid or moved past selection
        const hasPaid = ['MEMBERSHIP_PAID', 'PLAN_PAID'].includes(vendor.registrationStep) || vendor.membership?.expiryDate;

        if (hasPaid && vendor.registrationStep !== 'COMPLETED') {
            const startDate = new Date();
            const durationMonths = vendor.membership.durationMonths || 3;
            const plan = await getPlanByDuration(durationMonths);
            const validityDays = (plan.validityDays !== undefined && plan.validityDays !== null && plan.validityDays !== '') ? Number(plan.validityDays) : (durationMonths * 30);

            const expiryDate = new Date(startDate);
            expiryDate.setDate(expiryDate.getDate() + Number(validityDays));

            vendor.membership.startDate = vendor.membership.startDate || startDate;
            vendor.membership.expiryDate = vendor.membership.expiryDate || expiryDate;

            vendor.serviceRenewal = vendor.serviceRenewal || {};
            vendor.serviceRenewal.startDate = vendor.serviceRenewal.startDate || startDate;
            const renExpiryDate = new Date();
            const _rd1 = await adminService.getSetting('pricing.service_renewal_days');
        const renewalDays = (_rd1 !== undefined && _rd1 !== null && _rd1 !== '') ? Number(_rd1) : 30;
            renExpiryDate.setDate(renExpiryDate.getDate() + Number(renewalDays));
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

    // Notify Vendor
    sendPush(vendor._id, 'Vendor', 'verification_update', 'Verification Update', message, { documentStatus: vendor.documentStatus, isVerified: vendor.isVerified });


    const verificationPayload = _getVerificationPayload(vendor);
    verificationPayload.message = message;

    emitToVendor(vendor._id, 'verification_status_response', verificationPayload);

    return {
        vendor,
        message,
        isVerified: vendor.isVerified
    };
};

/**
 * Admin: Verify All Documents
 */
const verifyAllDocuments = async (vendorId, adminId, payload = {}) => {
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

    // Auto-approve existing pending extra service requests
    if (vendor.extraServiceRequests && vendor.extraServiceRequests.length > 0) {
        vendor.extraServiceRequests.forEach(req => {
            if (req.approvalStatus === 'pending') {
                req.approvalStatus = 'approved';
                req.reviewedBy = adminId || null;
                req.reviewedAt = new Date();
                req.adminRemark = 'Auto-approved during verify-all documents';
            }
        });
        vendor.markModified('extraServiceRequests');
    }

    // Process new extra services if any are provided in payload
    await _processApprovedExtraServices(vendor, payload, adminId);

    // Set registrationStep and startDate IF already paid or moved past selection
    const hasPaid = ['MEMBERSHIP_PAID', 'PLAN_PAID'].includes(vendor.registrationStep);
if (hasPaid && vendor.registrationStep !== 'COMPLETED') {
        const startDate = new Date();
        const durationMonths = vendor.membership.durationMonths || 3;
        const plan = await getPlanByDuration(durationMonths);
        const validityDays = (plan.validityDays !== undefined && plan.validityDays !== null && plan.validityDays !== '') ? Number(plan.validityDays) : (durationMonths * 30);

        const expiryDate = new Date(startDate);
        expiryDate.setDate(expiryDate.getDate() + Number(validityDays));

        vendor.membership.startDate = vendor.membership.startDate || startDate;
        vendor.membership.expiryDate = vendor.membership.expiryDate || expiryDate;

        vendor.serviceRenewal = vendor.serviceRenewal || {};
        vendor.serviceRenewal.startDate = vendor.serviceRenewal.startDate || startDate;
        const renExpiryDate = new Date();
        const _rd1 = await adminService.getSetting('pricing.service_renewal_days');
        const renewalDays = (_rd1 !== undefined && _rd1 !== null && _rd1 !== '') ? Number(_rd1) : 30;
        renExpiryDate.setDate(renExpiryDate.getDate() + Number(renewalDays));
        vendor.serviceRenewal.expiryDate = vendor.serviceRenewal.expiryDate || renExpiryDate;

        // Initialize category subscriptions for registration categories if missing
        if (vendor.selectedCategories && vendor.selectedCategories.length > 0) {
            vendor.categorySubscriptions = vendor.categorySubscriptions || [];
            for (const catId of vendor.selectedCategories) {
                const existingSub = vendor.categorySubscriptions.find(s => s.category.toString() === catId.toString());
                if (!existingSub) {
                    const Category = require('../../models/Category.model');
                    const category = await Category.findById(catId).select('membershipCharge membershipFee');
                    const fee = category ? (category.membershipCharge || category.membershipFee || 0) : 0;

                    vendor.categorySubscriptions.push({
                        category: catId,
                        subcategories: vendor.selectedSubcategories || [],
                        services: vendor.selectedServices || [],
                        startDate: startDate,
                        expiryDate: renExpiryDate,
                        fee: fee,
                        status: 'ACTIVE'
                    });
                }
            }
            vendor.markModified('categorySubscriptions');
        }

        vendor.registrationStep = 'COMPLETED';
    }


    await vendor.save();

    // Notify Vendor
    sendPush(vendor._id, 'Vendor', 'verification_update', 'Account Verified', "Congratulations! Your account is now fully verified.", { documentStatus: 'approved', isVerified: true });


    const message = "Account is now fully verified via Admin 'Verify All' action!";
    const verificationPayload = _getVerificationPayload(vendor);
    verificationPayload.message = message;

    emitToVendor(vendor._id, 'verification_status_response', verificationPayload);

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

    // Notify Vendor
    const title = isSuspended ? 'Account Suspended' : 'Account Reactivated';
    const message = isSuspended ? 'Your account has been suspended.' : 'Your account has been reactivated.';
    
    sendPush(vendor._id, 'Vendor', 'account_status', title, message, { isSuspended });
    const verificationPayload = _getVerificationPayload(vendor);
    verificationPayload.message = message;

    emitToVendor(vendor._id, 'verification_status_response', verificationPayload);

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

    // Notify Vendor
    sendPush(vendor._id, 'Vendor', 'verification_update', 'Account Rejected', message, { documentStatus: 'rejected', isVerified: false });


    const message = `Your account has been rejected. Reason: ${reason || 'No reason provided'}`;
    const verificationPayload = _getVerificationPayload(vendor);
    verificationPayload.message = message;

    emitToVendor(vendor._id, 'verification_status_response', verificationPayload);

    return vendor;
};

/**
 * Admin: Verify Vendor (Legacy/Fallback)
 */
const verifyVendor = async (vendorId, payload = {}) => {
    const { status, documentStatus, reason, adminId } = payload;
    // Admin panel sends { documentStatus: 'approved' }, fallback to status
    const effectiveStatus = status || documentStatus;
    if (effectiveStatus === 'approved') return await verifyAllDocuments(vendorId, adminId, payload);
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

    if (targetStatus) {
        const isMembershipExpired = vendor.membership?.expiryDate && new Date(vendor.membership.expiryDate) < new Date();
        const isServiceExpired = vendor.serviceRenewal?.expiryDate && new Date(vendor.serviceRenewal.expiryDate) < new Date();
        
        if (isMembershipExpired || isServiceExpired) {
            throw new ApiError(403, 'Your membership or service has expired. Please renew to go online.');
        }
    }

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

    const isMembershipExpired = vendor.membership?.expiryDate && new Date(vendor.membership.expiryDate) < new Date();
    const isServiceExpired = vendor.serviceRenewal?.expiryDate && new Date(vendor.serviceRenewal.expiryDate) < new Date();
    
    let effectiveIsOnline = vendor.isOnline || false;
    if ((isMembershipExpired || isServiceExpired) && effectiveIsOnline) {
        effectiveIsOnline = false;
        vendor.isOnline = false;
        await vendor.save();
    }

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

    const hasPendingDeletionApproval = Boolean(vendor.deletionRequest?.isRequested) && vendor.deletionRequest?.status === 'PENDING';
    const hasPendingServiceApproval = (vendor.serviceApprovalStatus || 'pending') === 'pending';
    const hasPendingExtraServiceApproval = (vendor.extraServiceRequests || []).some((req) => req?.approvalStatus === 'pending');
    const attentionReasons = [];
    if (hasPendingDeletionApproval) attentionReasons.push('DELETION_APPROVAL_PENDING');
    if (hasPendingServiceApproval) attentionReasons.push('SERVICE_APPROVAL_PENDING');
    if (hasPendingExtraServiceApproval) attentionReasons.push('EXTRA_SERVICE_APPROVAL_PENDING');

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
        isOnline: effectiveIsOnline,
        monthlyEarnings,
        totalCompletedBookingCounts,
        hasPendingServiceApproval,
        hasPendingExtraServiceApproval,
        serviceApprovalStatus: vendor.serviceApprovalStatus || 'pending',
        requiresAttention: attentionReasons.length > 0,
        attentionColor: attentionReasons.length > 0 ? '#8B0000' : null,
        profileBorderColor: attentionReasons.length > 0 ? '#8B0000' : null,
        borderColor: attentionReasons.length > 0 ? '#8B0000' : null,
        attentionReasons
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

    // Update FCM Token if provided in profile data
    if (profileData.fcmToken) {
        vendor.fcmToken = profileData.fcmToken;
    }

    await vendor.save();

    return getVendorProfile(vendorId);
};

/**
 * Verify Razorpay membership payment signature
 * On success — activates vendor membership
 */
const verifyMembershipPayment = async (vendorId, { razorpay_order_id, razorpay_payment_id, razorpay_signature, membershipId, planId }) => {
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

    // Accept planId as an alias for membershipId (app may send either field)
    const resolvedMembershipId = membershipId || planId || vendor.membership?.membershipId || null;

    if (resolvedMembershipId) {
        vendor.membership = vendor.membership || {};
        vendor.membership.membershipId = resolvedMembershipId;
    }

    // Resolve plan: prefer planId/membershipId over durationMonths fallback
    let plan;
    if (resolvedMembershipId) {
        const planDoc = await CreditPlan.findById(resolvedMembershipId).lean();
        if (planDoc) {
            plan = { validityDays: Number(planDoc.validityDays), durationMonths: Math.round(planDoc.validityDays / 30) };
        }
    }
    if (!plan) {
        const durationMonths = vendor.membership?.durationMonths || 3;
        plan = await getPlanByDuration(durationMonths);
    }
    const validityDays = plan.validityDays;

    let expiryDate = null;
    if (vendor.isVerified) {
        const now = new Date();

        vendor.membership.startDate = vendor.membership.startDate || now;
        expiryDate = new Date(vendor.membership.startDate);
        expiryDate.setDate(expiryDate.getDate() + Number(validityDays));
        vendor.membership.expiryDate = expiryDate;

        // Initialize service renewal window
        vendor.serviceRenewal = vendor.serviceRenewal || {};
        vendor.serviceRenewal.startDate = vendor.serviceRenewal.startDate || now;
        const renExpiry = new Date(vendor.serviceRenewal.startDate);
        const renewalDays = (await adminService.getSetting('pricing.service_renewal_days')) || 0;
        renExpiry.setDate(renExpiry.getDate() + Number(renewalDays));
        vendor.serviceRenewal.expiryDate = vendor.serviceRenewal.expiryDate || renExpiry;

        // Initialize category subscriptions for registration categories
        if (vendor.selectedCategories && vendor.selectedCategories.length > 0) {
            const categoryExpiry = new Date(now);
            const _rd3 = await adminService.getSetting('pricing.service_renewal_days');
            const renewalDays = (_rd3 !== undefined && _rd3 !== null && _rd3 !== '') ? Number(_rd3) : 30;
            categoryExpiry.setDate(categoryExpiry.getDate() + Number(renewalDays)); // Service expires based on admin setting

            for (const catId of vendor.selectedCategories) {
                const existingSub = vendor.categorySubscriptions.find(s => s.category.toString() === catId.toString());
                if (!existingSub) {
                    const Category = require('../../models/Category.model');
                    const category = await Category.findById(catId).select('membershipCharge membershipFee');
                    const fee = category ? (category.membershipCharge || category.membershipFee || 0) : 0;

                    vendor.categorySubscriptions.push({
                        category: catId,
                        subcategories: vendor.selectedSubcategories || [],
                        services: vendor.selectedServices || [],
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

    // Find or complete PaymentRecord
    let paymentRecord = await PaymentRecord.findOne({ orderId: razorpay_order_id });
    if (paymentRecord) {
        paymentRecord.status = 'COMPLETED';
        paymentRecord.paymentId = razorpay_payment_id;
        if (expiryDate) {
            paymentRecord.newExpiryDate = expiryDate;
        }
        await paymentRecord.save();
    } else {
        // Populate membership metadata directly from calculated details
        try {
            const memDetails = await getVendorMembershipDetails(vendor._id, { membershipId: resolvedMembershipId });
    await PaymentRecord.create({
        orderId: razorpay_order_id,
        paymentId: razorpay_payment_id,
        vendorId: vendor._id,
        amount: memDetails.subtotal,
        gstAmount: memDetails.gstAmount,
        totalAmount: memDetails.totalFee,
        planId: resolvedMembershipId,
        validityDays: validityDays,
        status: 'COMPLETED',
        ...(expiryDate && { newExpiryDate: expiryDate }),
        metadata: memDetails.services
    });
        } catch (createErr) {
            console.error('Failed to create fallback PaymentRecord:', createErr.message);
        }
    }

    // Unconditionally update/populate membership metadata with correct values
    try {
        const memDetails = await getVendorMembershipDetails(vendor._id, { membershipId: resolvedMembershipId });
        vendor.membership.membershipFee = paymentRecord ? (paymentRecord.amount - (memDetails.serviceSelectionsTotal || 0)) : memDetails.basePlanFee;
        vendor.membership.serviceFee = memDetails.serviceSelectionsTotal;
        vendor.membership.gstAmount = paymentRecord ? paymentRecord.gstAmount : memDetails.gstAmount;
        vendor.membership.totalAmount = paymentRecord ? paymentRecord.totalAmount : memDetails.totalFee;
        vendor.membership.subtotal = paymentRecord ? paymentRecord.amount : memDetails.subtotal;
        vendor.membership.fee = paymentRecord ? paymentRecord.totalAmount : memDetails.totalFee;
        
        if (paymentRecord?.validityDays) {
            vendor.membership.durationMonths = Math.round(paymentRecord.validityDays / 30);
        } else {
            vendor.membership.durationMonths = memDetails.durationMonths;
        }

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
        console.error('Error populating/updating membership metadata:', err.message);
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
        throw new ApiError(400, 'You cannot request account deletion while you have active or pending bookings. Please complete or cancel them first.');
    }


    vendor.deletionRequest = {
        isRequested: true,
        requestedAt: new Date(),
        status: 'PENDING'
    };

    await vendor.save();

    return { message: 'your deletion request sended to admin successfully' };
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

    // 1. Get vendor credits (coins) and verification status
    const vendor = await Vendor.findById(vendorIdObj).select('coins isVerified documentStatus');
    
    // If vendor is not verified, they should not see any booking data
    if (!vendor?.isVerified || vendor?.documentStatus !== 'approved') {
        return {
            credits: vendor?.coins || 0,
            pendingJobs: 0,
            ongoingJobs: 0,
            jobsCompletedThisMonth: 0,
            earningsThisMonth: 0,
            jobProgress: 0,
            isVerified: false,
            message: 'Complete your verification to view booking data'
        };
    }

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

    // ── Auto-derive parent hierarchy (Categories, Subcategories, etc.) ──
    await _deriveVendorHierarchy(vendor);

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
    const vendor = await Vendor.findById(vendorId)
        .populate('selectedCategories selectedSubcategories selectedServiceTypes selectedServices membership.category')
        .populate('categorySubscriptions.category')
        .populate('categorySubscriptions.subcategories')
        .populate('categorySubscriptions.services');
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    const now = new Date();
    const memExp = vendor.membership?.expiryDate ? new Date(vendor.membership.expiryDate) : null;
    const isMemActive = memExp ? memExp > now : false;

    const renExp = vendor.serviceRenewal?.expiryDate ? new Date(vendor.serviceRenewal.expiryDate) : null;
    const isRenActive = renExp ? renExp > now : false;

    let daysRemaining = 0;
    // Use membership expiry as primary source for daysRemaining
    if (isMemActive) {
        const diff = memExp - now;
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

    // Accumulate items from categorySubscriptions (additional purchases)
    if (vendor.categorySubscriptions) {
        vendor.categorySubscriptions.forEach(sub => {
            if (sub.category) categoryIds.add(String(sub.category._id || sub.category));
            if (sub.subcategories) sub.subcategories.forEach(s => subcategoryIds.add(String(s._id || s)));
            if (sub.services) sub.services.forEach(s => serviceIds.add(String(s._id || s)));
        });
    }

    const query = { $or: [] };
    if (categoryIds.size > 0) query.$or.push({ category: { $in: Array.from(categoryIds) } });
    if (subcategoryIds.size > 0) query.$or.push({ subcategory: { $in: Array.from(subcategoryIds) } });
    if (serviceTypeIds.size > 0) query.$or.push({ serviceType: { $in: Array.from(serviceTypeIds) } });
    if (serviceIds.size > 0) query.$or.push({ _id: { $in: Array.from(serviceIds) } });

    let finalServices = [];
    if (query.$or.length > 0) {
        const Service = require('../../models/Service.model');
        finalServices = await Service.find({ ...query, isActive: { $ne: false } });
    }

    // Determine the list of services across all levels of hierarchy
    let serviceList = finalServices.map(svc => {
        const catIdStr = svc.category ? svc.category.toString() : '';
        const catSub = vendor.categorySubscriptions?.find(sub => 
            sub.category && (sub.category._id || sub.category).toString() === catIdStr
        );
        
        let active = isMemActive;
        let remaining = daysRemaining;
        
        if (catSub) {
            const subExp = catSub.expiryDate ? new Date(catSub.expiryDate) : null;
            const isSubActive = subExp ? subExp > now : false;

            // Service is active if either membership or catSub covers it
            active = isMemActive || (isSubActive && catSub.status === 'ACTIVE');

            // Use the latest (maximum) expiry date among membership and catSub
            const candidateExpiries = [];
            if (isMemActive && memExp) candidateExpiries.push(memExp);
            if (isSubActive && subExp) candidateExpiries.push(subExp);

            if (candidateExpiries.length > 0) {
                const latestExpiry = new Date(Math.max(...candidateExpiries.map(d => d.getTime())));
                const diff = latestExpiry - now;
                remaining = Math.ceil(diff / (1000 * 60 * 60 * 24));
            } else {
                remaining = 0;
            }
        }
        
        return {
            id: svc._id.toString(),
            serviceId: svc.title,
            name: svc.title,
            title: svc.title,
            isActive: active,
            daysRemaining: remaining,
            category: svc.category ? svc.category.toString() : null,
            subcategory: svc.subcategory ? svc.subcategory.toString() : null,
            serviceType: svc.serviceType ? svc.serviceType.toString() : null
        };
    });

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

    // Gather IDs from vendor's selections (Same logic as before to ensure totalFee is correct)
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

    // Fetch all entities to build the hierarchy
    const [categories, subcategories, serviceTypes, services] = await Promise.all([
        Category.find({ _id: { $in: Array.from(categoryIds) } }).lean(),
        Subcategory.find({ _id: { $in: Array.from(subcategoryIds) } }).lean(),
        require('../../models/ServiceType.model').find({ _id: { $in: Array.from(serviceTypeIds) } }).lean(),
        Service.find({ _id: { $in: Array.from(serviceIds) } }).lean()
    ]);

    // Identify already paid items if the subscription is still active
    const isCurrentlyActive = vendor.serviceRenewal?.expiryDate && new Date(vendor.serviceRenewal.expiryDate) > new Date();
    const alreadyPaidIds = new Set();

    if (isCurrentlyActive) {
        const lastPayment = await PaymentRecord.findOne({
            vendor: vendorId,
            purpose: 'SERVICE_RENEWAL',
            status: 'COMPLETED'
        }).sort({ createdAt: -1 });

        if (lastPayment && lastPayment.metadata) {
            // Recursive helper to extract IDs from breakdown hierarchy
            const extractIds = (items) => {
                if (!items || !Array.isArray(items)) return;
                items.forEach(item => {
                    const id = item.id || item._id;
                    if (id) alreadyPaidIds.add(String(id));
                    if (item.subcategories) extractIds(item.subcategories);
                    if (item.serviceTypes) extractIds(item.serviceTypes);
                    if (item.services) extractIds(item.services);
                });
            };
            // The metadata for SERVICE_RENEWAL is the hierarchy array
            extractIds(lastPayment.metadata);
        }
    }

    // Calculate totalFee
    let serviceSubtotal = 0;
    categories.forEach(c => {
        if (!alreadyPaidIds.has(String(c._id))) {
            serviceSubtotal += (c.serviceRenewalCharge || c.renewalCharge || 0);
        }
    });
    subcategories.forEach(s => {
        if (!alreadyPaidIds.has(String(s._id))) {
            serviceSubtotal += (s.serviceRenewalCharge || s.renewalCharge || 0);
        }
    });
    serviceTypes.forEach(st => {
        if (!alreadyPaidIds.has(String(st._id))) {
            serviceSubtotal += (st.serviceRenewalCharge || 0);
        }
    });
    services.forEach(s => {
        if (!alreadyPaidIds.has(String(s._id))) {
            serviceSubtotal += (s.serviceRenewalCharge || 0);
        }
    });

    // Build the hierarchical breakdown
    const hierarchy = categories.map(cat => {
        const catId = String(cat._id);
        const catRenewal = alreadyPaidIds.has(catId) ? 0 : (cat.serviceRenewalCharge || cat.renewalCharge || 0);

        const subList = subcategories
            .filter(sub => String(sub.category) === catId)
            .map(sub => {
                const subId = String(sub._id);
                const subRenewal = alreadyPaidIds.has(subId) ? 0 : (sub.serviceRenewalCharge || sub.renewalCharge || 0);

                const typeList = serviceTypes
                    .filter(st => String(st.subcategory) === subId)
                    .map(st => {
                        const stId = String(st._id);
                        const stRenewal = alreadyPaidIds.has(stId) ? 0 : (st.serviceRenewalCharge || 0);

                        const svcList = services
                            .filter(svc => String(svc.serviceType) === stId)
                            .map(svc => ({
                                id: svc._id,
                                title: svc.title,
                                renewalAmount: alreadyPaidIds.has(String(svc._id)) ? 0 : (svc.serviceRenewalCharge || 0)
                            }))
                            .filter(s => s.renewalAmount >= 0);

                        return {
                            id: st._id,
                            name: st.name,
                            renewalAmount: stRenewal,
                            services: svcList
                        };
                    })
                    .filter(t => t.renewalAmount > 0 || (t.services && t.services.length > 0));

                const independentServices = services
                    .filter(svc => String(svc.subcategory) === subId && !svc.serviceType)
                    .map(svc => ({
                        id: svc._id,
                        title: svc.title,
                        renewalAmount: alreadyPaidIds.has(String(svc._id)) ? 0 : (svc.serviceRenewalCharge || 0)
                    }))
                    .filter(s => s.renewalAmount >= 0);

                return {
                    id: sub._id,
                    name: sub.name,
                    renewalAmount: subRenewal,
                    serviceTypes: typeList,
                    services: independentServices
                };
            })
            .filter(s => s.renewalAmount > 0 || (s.serviceTypes && s.serviceTypes.length > 0) || (s.services && s.services.length > 0));

        const independentServices = services
            .filter(svc => String(svc.category) === catId && !svc.subcategory)
            .map(svc => ({
                id: svc._id,
                title: svc.title,
                renewalAmount: alreadyPaidIds.has(String(svc._id)) ? 0 : (svc.serviceRenewalCharge || 0)
            }))
            .filter(s => s.renewalAmount >= 0);

        return {
            id: cat._id,
            name: cat.name,
            renewalAmount: catRenewal,
            subcategories: subList,
            services: independentServices
        };
    }).filter(c => c.renewalAmount > 0 || (c.subcategories && c.subcategories.length > 0) || (c.services && c.services.length > 0));

    const gstSetting = await adminService.getSetting('pricing.membership_gst_percent');
    const gstPercent = (gstSetting !== undefined && gstSetting !== null) ? Number(gstSetting) : 0;
    const gstAmount = Math.round(serviceSubtotal * (gstPercent / 100));
    const totalFee = serviceSubtotal + gstAmount;

    return {
        vendorId: vendor._id,
        subtotal: serviceSubtotal,
        gstPercent,
        gstAmount,
        totalFee,
        serviceRenewal: {
            fee: totalFee,
            expiryDate: vendor.serviceRenewal?.expiryDate || null,
            breakdown: hierarchy
        },
        razorpayKeyId: config.RAZORPAY_KEY_ID
    };
};

/**
 * Membership Renewal: Calculate fee based on duration
 */
const getMembershipRenewalFeeDetails = async (vendorId, { planId, membershipId, durationMonths } = {}) => {
    const vendor = await Vendor.findById(vendorId)
        .populate('selectedCategories selectedSubcategories membership.category');
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    const adminService = require('../admin/admin.service');
    
    let plan;
    const resolvedPlanId = planId || membershipId;
    if (resolvedPlanId) {
        const planDoc = await CreditPlan.findById(resolvedPlanId).lean();
        if (!planDoc) throw new ApiError(404, 'Membership plan not found');
        plan = {
            id: planDoc._id,
            name: planDoc.name,
            price: Number(planDoc.price),
            validityDays: Number(planDoc.validityDays)
        };
    } else {
        // If planId is not passed, prefer requested duration, then vendor's current duration,
        // and only then fallback to 3 months.
        plan = await getPlanByDuration(Number(durationMonths || vendor.membership?.durationMonths || 3));
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
    const gstSetting = await adminService.getSetting('pricing.membership_gst_percent');
    const gstPercent = (gstSetting !== undefined && gstSetting !== null) ? Number(gstSetting) : 0;
    const gstAmount = Math.round(subtotal * (gstPercent / 100));
    const totalFee = subtotal + gstAmount;

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
const createMembershipRenewalOrder = async (vendorId, { planId, membershipId, durationMonths } = {}) => {
    const feeDetails = await getMembershipRenewalFeeDetails(vendorId, { planId, membershipId, durationMonths });

    let razorpayOrder;
    try {
        if (feeDetails.totalFee <= 0) {
            razorpayOrder = {
                id: `order_free_${vendorId.toString().slice(-10)}_${Date.now()}`,
                amount: 0,
                currency: 'INR',
                receipt: `m_ren_${vendorId.toString().slice(-10)}_${Date.now()}`,
                status: 'created'
            };
        } else {
            razorpayOrder = await getRazorpay().orders.create({
                amount: Math.round(feeDetails.totalFee * 100),
                currency: 'INR',
                receipt: `m_ren_${vendorId.toString().slice(-10)}_${Date.now()}`,
            });
        }

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

    const membershipAmount = Number(feeDetails?.breakdown?.basePlan?.price || 0);
    const renewalAmount = Math.max(0, Number(feeDetails.subtotal || 0) - membershipAmount);

    return {
        vendorId: vendorId.toString(),
        planId: feeDetails.planId,
        membershipAmount,
        renewalAmount,
        gstAmount: Number(feeDetails.gstAmount || 0),
        totalAmount: Number(feeDetails.totalFee || 0),
        totalFee: feeDetails.totalFee,
        subtotal: Number(feeDetails.subtotal || 0),
        gstPercent: Number(feeDetails.gstPercent || 0),
        validityDays: feeDetails.validityDays,
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
const verifyMembershipRenewalPayment = async (vendorId, { razorpay_order_id, razorpay_payment_id, razorpay_signature, planId, membershipId, durationMonths }) => {
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
    const resolvedPlanId = planId || membershipId;
    if (resolvedPlanId) {
        const planDoc = await CreditPlan.findById(resolvedPlanId).lean();
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

    let razorpayOrder;
    try {
        if (feeDetails.totalFee <= 0) {
            razorpayOrder = {
                id: `order_free_${vendorId.toString().slice(-10)}_${Date.now()}`,
                amount: 0,
                currency: 'INR',
                receipt: `ren_${vendorId.toString().slice(-10)}_${Date.now()}`,
                status: 'created'
            };
        } else {
            razorpayOrder = await getRazorpay().orders.create({
                amount: Math.round(feeDetails.totalFee * 100),
                currency: 'INR',
                receipt: `ren_${vendorId.toString().slice(-10)}_${Date.now()}`,
                notes: {
                    vendorId: vendorId.toString(),
                    purpose: 'service_renewal',
                },
            });
        }

        const adminService = require('../admin/admin.service');
        const _rd = await adminService.getSetting('pricing.service_renewal_days');
        const renewalDays = (_rd !== undefined && _rd !== null && _rd !== '') ? Number(_rd) : 30;

        // Log the pending payment record
        await PaymentRecord.create({
            vendor: vendorId,
            orderId: razorpayOrder.id,
            purpose: 'SERVICE_RENEWAL',
            amount: feeDetails.subtotal,
            gstAmount: feeDetails.gstAmount,
            totalAmount: feeDetails.totalFee,
            validityDays: renewalDays, // Replaced hardcoded 30
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
    const _rd4 = await adminService.getSetting('pricing.service_renewal_days');
    const renewalDays = (_rd4 !== undefined && _rd4 !== null && _rd4 !== '') ? Number(_rd4) : 30;
    newExpiryDate.setDate(newExpiryDate.getDate() + Number(renewalDays));

    vendor.serviceRenewal.expiryDate = newExpiryDate;

    // Align all active category subscriptions in categorySubscriptions to the same newExpiryDate
    if (vendor.categorySubscriptions && Array.isArray(vendor.categorySubscriptions)) {
        vendor.categorySubscriptions.forEach(sub => {
            if (sub.status === 'ACTIVE') {
                sub.expiryDate = newExpiryDate;
            }
        });
    }

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
    const currentMembershipId = vendor.membership?.membershipId?.toString();

    for (const p of plans) {
        const feeDetails = await getMembershipRenewalFeeDetails(vendorId, { durationMonths: p.duration });
        
        const isCurrent = Boolean(currentMembershipId && feeDetails.planId && currentMembershipId === feeDetails.planId.toString());

        const membershipAmount = Number(feeDetails?.breakdown?.basePlan?.price || 0);
        const renewalAmount = Math.max(0, Number(feeDetails.subtotal || 0) - membershipAmount);
        
        const planObj = {
            id: feeDetails.planId,
            name: p.name,
            isCurrent,
            renewal: feeDetails.totalFee, // Backward compatibility
            renewalAmount,
            membershipAmount,
            gstAmount: Number(feeDetails.gstAmount || 0),
            totalAmount: Number(feeDetails.totalFee || 0),
            gstPercent: Number(feeDetails.gstPercent || 0),
            validityDays: feeDetails.validityDays
        };

        allPlans.push(planObj);
    }

    return {
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
const getAddCategoryFeeDetails = async (vendorId, { categoryId, subcategoryIds = [], serviceIds = [], subcategories: payloadSubcategories, services: payloadServices } = {}) => {
    // Support aliases often used by frontend
    if ((!subcategoryIds || !subcategoryIds.length) && payloadSubcategories) subcategoryIds = payloadSubcategories;
    if ((!serviceIds || !serviceIds.length) && payloadServices) serviceIds = payloadServices;

    let parsedServiceIds = parseArrayInput(serviceIds);
    let parsedSubcategoryIds = parseArrayInput(subcategoryIds);

    // Debug log to help troubleshoot derivation issues
    console.log(`🔍 [Derive Category] vendorId=${vendorId} categoryId=${categoryId}, services=${JSON.stringify(serviceIds)}, subcategories=${JSON.stringify(subcategoryIds)}`);

    // If categoryId is missing, derive it from the provided services or subcategories
    if (!categoryId) {
        if (parsedServiceIds.length > 0) {
            const sampleService = await Service.findById(parsedServiceIds[0]).lean();
            if (sampleService) {
                categoryId = sampleService.category;
                console.log(`   ✅ Derived categoryId ${categoryId} from service ${parsedServiceIds[0]}`);
            } else {
                console.log(`   ❌ Could not find service ${parsedServiceIds[0]} to derive category`);
            }
        } else if (parsedSubcategoryIds.length > 0) {
            const sampleSub = await Subcategory.findById(parsedSubcategoryIds[0]).lean();
            if (sampleSub) {
                categoryId = sampleSub.category;
                console.log(`   ✅ Derived categoryId ${categoryId} from subcategory ${parsedSubcategoryIds[0]}`);
            } else {
                console.log(`   ❌ Could not find subcategory ${parsedSubcategoryIds[0]} to derive category`);
            }
        }
    }

    if (!categoryId) {
        console.log('   ❌ Final categoryId is still missing');
        throw new ApiError(400, 'categoryId is required or could not be derived from services/subcategories. Please ensure you are sending valid serviceIds or subcategoryIds.');
    }

    const vendor = await Vendor.findById(vendorId).lean();
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    const category = await Category.findById(categoryId).lean();
    if (!category) throw new ApiError(404, 'Category not found');

    const renewalDaysSetting = await adminService.getSetting('pricing.service_renewal_days');
    const renewalDays = (renewalDaysSetting !== undefined && renewalDaysSetting !== null && renewalDaysSetting !== '') ? Number(renewalDaysSetting) : 30;

    // If subcategoryIds are missing but services are provided, derive the subcategories to ensure hierarchical charges are applied
    if (parsedSubcategoryIds.length === 0 && parsedServiceIds.length > 0) {
        const servicesData = await Service.find({ _id: { $in: parsedServiceIds } }).lean();
        const derivedSubIds = new Set();
        servicesData.forEach(s => {
            if (s.subcategory) derivedSubIds.add(s.subcategory.toString());
        });
        parsedSubcategoryIds = Array.from(derivedSubIds);
    }

    const subcategories = await Subcategory.find({ _id: { $in: parsedSubcategoryIds } }).lean();
    const services = await Service.find({ _id: { $in: parsedServiceIds } }).lean();

    // Build set of already purchased categories, subcategories, services
    const purchasedServiceIds = new Set((vendor.selectedServices || []).map(id => id.toString()));
    const selectedCategoryIds    = new Set((vendor.selectedCategories    || []).map(id => id.toString()));
    const selectedSubcategoryIds = new Set((vendor.selectedSubcategories || []).map(id => id.toString()));

    for (const catSub of (vendor.categorySubscriptions || [])) {
        if (catSub.category) {
            selectedCategoryIds.add(catSub.category.toString());
        }
        for (const subId of (catSub.subcategories || [])) {
            selectedSubcategoryIds.add(subId.toString());
        }
        for (const svcId of (catSub.services || [])) {
            purchasedServiceIds.add(svcId.toString());
        }
    }

    // Derive which categories / subcategories are already paid from services
    const allServices = await Service.find({}).lean();
    const purchasedCategoryIds   = new Set();
    const purchasedSubcategoryIds = new Set();
    for (const s of allServices) {
        if (purchasedServiceIds.has(s._id.toString())) {
            if (s.category)    purchasedCategoryIds.add(s.category.toString());
            if (s.subcategory) purchasedSubcategoryIds.add(s.subcategory.toString());
        }
    }

    const finalPurchasedCategoryIds    = new Set([...selectedCategoryIds,    ...purchasedCategoryIds]);
    const finalPurchasedSubcategoryIds = new Set([...selectedSubcategoryIds, ...purchasedSubcategoryIds]);

    const isCatOwned = finalPurchasedCategoryIds.has(categoryId.toString());
    
    // Category Charge (0 if already owned)
    const categoryBaseCharge = _getMembershipCharge(category, 'category');
    const categoryProration = isCatOwned ? { amount: 0, remainingDays: 0 } : _calculateProration(vendor, categoryId, categoryBaseCharge, renewalDays);
    
    let totalFee = categoryProration.amount;
    let unproratedTotalFee = isCatOwned ? 0 : categoryBaseCharge;
    let additionalSelectionsTotal = 0;
    
    const breakdown = {
        category: { 
            id: category._id, 
            name: category.name, 
            charge: categoryProration.amount, 
            baseCharge: categoryBaseCharge,
            isProrated: categoryProration.isProrated,
            remainingDays: categoryProration.remainingDays
        },
        subcategories: [],
        services: []
    };
    const itemBreakdown = [];

    if (categoryProration.amount > 0) {
        itemBreakdown.push({
            id: category._id,
            title: category.name,
            type: 'category',
            serviceCharge: 0,
            membershipCharge: categoryProration.amount,
            isProrated: categoryProration.isProrated,
            remainingDays: categoryProration.remainingDays
        });
    }

    subcategories.forEach(sub => {
        const isSubOwned = finalPurchasedSubcategoryIds.has(sub._id.toString());
        const baseCharge = isSubOwned ? 0 : _getMembershipCharge(sub, 'subcategory');
        const proration = isSubOwned ? { amount: 0, remainingDays: 0 } : _calculateProration(vendor, categoryId, baseCharge, renewalDays);
        
        totalFee += proration.amount;
        unproratedTotalFee += isSubOwned ? 0 : baseCharge;
        additionalSelectionsTotal += proration.amount;
        
        if (proration.amount > 0) {
            breakdown.subcategories.push({ 
                id: sub._id, 
                name: sub.name, 
                charge: proration.amount,
                isProrated: proration.isProrated
            });
            itemBreakdown.push({
                id: sub._id,
                title: sub.name,
                type: 'subcategory',
                serviceCharge: 0,
                membershipCharge: proration.amount,
                isProrated: proration.isProrated,
                remainingDays: proration.remainingDays
            });
        }
    });

    services.forEach(svc => {
        const isSvcOwned = purchasedServiceIds.has(svc._id.toString());
        const baseCharge = isSvcOwned ? 0 : _getMembershipCharge(svc, 'service');
        const proration = isSvcOwned ? { amount: 0, remainingDays: 0 } : _calculateProration(vendor, categoryId, baseCharge, renewalDays);
        
        totalFee += proration.amount;
        unproratedTotalFee += isSvcOwned ? 0 : baseCharge;
        additionalSelectionsTotal += proration.amount;
        
        if (proration.amount > 0) {
            breakdown.services.push({ 
                id: svc._id, 
                name: svc.title, 
                charge: proration.amount,
                isProrated: proration.isProrated
            });
            itemBreakdown.push({
                id: svc._id,
                title: svc.title,
                type: 'service',
                serviceCharge: 0,
                membershipCharge: proration.amount,
                isProrated: proration.isProrated,
                remainingDays: proration.remainingDays
            });
        }
    });

    // Extra category purchases use dynamic GST consistent with registration
    const gstSetting = await adminService.getSetting('pricing.membership_gst_percent');
    const gstPercent = (gstSetting !== undefined && gstSetting !== null) ? Number(gstSetting) : 0;
    const gstAmount = Math.round(totalFee * (gstPercent / 100));
    const totalWithGst = totalFee + gstAmount;

    const unproratedGstAmount = Math.round(unproratedTotalFee * (gstPercent / 100));
    const unproratedTotalWithGst = unproratedTotalFee + unproratedGstAmount;
    const discountAmount = unproratedTotalWithGst - totalWithGst;

    return {
        vendorId,
        categoryId,
        totalCharge: totalFee, // Subtotal of service charges
        gstAmount,
        totalWithGst,
        remainingDaysCharge: totalFee,
        gstForAmount: gstAmount,
        totalAmount: totalWithGst,
        remainingDays: categoryProration.remainingDays || renewalDays,
        subtotal: totalFee,
        totalServiceFee: additionalSelectionsTotal,
        serviceSelectionsTotal: additionalSelectionsTotal,
        totalFee: totalWithGst,
        platformSubtotal: totalFee,
        gstPercent,
        basePlanFee: 0,
        originalSubtotal: unproratedTotalFee,
        originalGstAmount: unproratedGstAmount,
        originalTotalWithGst: unproratedTotalWithGst,
        discountAmount,
        purchasedDays: categoryProration.remainingDays || renewalDays,
        renewalDays,
        itemBreakdown,
        razorpayKeyId: config.RAZORPAY_KEY_ID,
        breakdown,
        prorationContext: {
            remainingDays: categoryProration.remainingDays || renewalDays,
            expiryDate: categoryProration.expiryDate
        }
    };
};


/**
 * Add Category: Create order
 */
const createAddCategoryOrder = async (vendorId, { categoryId, subcategoryIds = [], serviceIds = [], approvalRequestId, subcategories: payloadSubcategories, services: payloadServices } = {}) => {
    // Support aliases often used by frontend
    if ((!subcategoryIds || !subcategoryIds.length) && payloadSubcategories) subcategoryIds = payloadSubcategories;
    if ((!serviceIds || !serviceIds.length) && payloadServices) serviceIds = payloadServices;

    const vendor = await Vendor.findById(vendorId).select('extraServiceRequests');
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    const payloadIds = new Set((serviceIds || []).map((id) => String(id)));
    let approvedRequest = null;
    if (approvalRequestId) {
        approvedRequest = (vendor.extraServiceRequests || []).find((req) =>
            String(req._id) === String(approvalRequestId) && req.approvalStatus === 'approved'
        );
    } else {
        approvedRequest = (vendor.extraServiceRequests || []).find((req) => {
            if (req.approvalStatus !== 'approved') return false;
            const reqIds = new Set((req.services || []).map((id) => String(id)));
            return reqIds.size === payloadIds.size && [...payloadIds].every(id => reqIds.has(id));
        });
    }

    if (!approvedRequest) {
        throw new ApiError(403, 'Admin approval is required before purchasing extra services');
    }
    const requestedIds = new Set((approvedRequest.services || []).map((id) => String(id)));
    if (!serviceIds?.length || requestedIds.size !== payloadIds.size || [...payloadIds].some((id) => !requestedIds.has(id))) {
        throw new ApiError(403, 'Only approved services can be purchased');
    }

    const feeDetails = await getAddCategoryFeeDetails(vendorId, { categoryId, subcategoryIds, serviceIds });

    const totalToPay = feeDetails.totalWithGst;

    let razorpayOrder;
    try {
        if (totalToPay <= 0) {
            razorpayOrder = {
                id: `order_free_${vendorId.toString().slice(-10)}_${Date.now()}`,
                amount: 0,
                currency: 'INR',
                receipt: `add_cat_${vendorId.toString().slice(-10)}_${Date.now()}`,
                status: 'created'
            };
        } else {
            razorpayOrder = await getRazorpay().orders.create({
                amount: Math.round(totalToPay * 100),
                currency: 'INR',
                receipt: `add_cat_${vendorId.toString().slice(-10)}_${Date.now()}`,
                notes: {
                    vendorId: vendorId.toString(),
                    purpose: 'category_purchase',
                },
            });
        }

        // Log the pending payment record
        await PaymentRecord.create({
            vendor: vendorId,
            orderId: razorpayOrder.id,
            purpose: 'CATEGORY_PURCHASE',
            amount: feeDetails.totalCharge,
            gstAmount: feeDetails.gstAmount,
            totalAmount: totalToPay,
            status: 'PENDING',
            metadata: {
                ...feeDetails.breakdown,
                selectedSubcategories: subcategoryIds,
                selectedServices: serviceIds,
                categoryId: categoryId,
                approvalRequestId: approvedRequest._id,
                isProrated: (feeDetails.prorationContext?.remainingDays || feeDetails.renewalDays) < feeDetails.renewalDays,
                alignedExpiryDate: feeDetails.prorationContext?.expiryDate
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

const requestExtraServiceApproval = async (vendorId, { categoryId, subcategoryIds = [], serviceIds = [], subcategories: payloadSubcategories, services: payloadServices } = {}) => {
    if ((!subcategoryIds || !subcategoryIds.length) && payloadSubcategories) subcategoryIds = payloadSubcategories;
    if ((!serviceIds || !serviceIds.length) && payloadServices) serviceIds = payloadServices;

    if (!serviceIds || !serviceIds.length) {
        throw new ApiError(400, 'At least one service is required for approval request');
    }

    const vendor = await Vendor.findById(vendorId);
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    vendor.extraServiceRequests = vendor.extraServiceRequests || [];

    // Guard: prevent duplicate pending requests for the exact same set of service IDs.
    // Each unique combination of services gets its own request, but the same combo
    // should not stack up with multiple pending entries.
    const normalizedNewIds = parseArrayInput(serviceIds).map(id => String(id)).sort();
    const existingPending = vendor.extraServiceRequests.find(req => {
        if (req.approvalStatus !== 'pending') return false;
        const reqIds = (req.services || []).map(id => String(id)).sort();
        if (reqIds.length !== normalizedNewIds.length) return false;
        return reqIds.every((id, i) => id === normalizedNewIds[i]);
    });

    if (existingPending) {
        // A pending request for these exact services already exists; return it instead of duplicating
        return {
            requestId: existingPending._id,
            requestedBy: existingPending.requestedBy || vendor._id,
            approvalStatus: existingPending.approvalStatus,
            requestedAt: existingPending.requestedAt,
            message: 'Extra service approval request already pending'
        };
    }

    vendor.extraServiceRequests.push({
        requestedBy: vendor._id,
        category: categoryId || undefined,
        subcategories: parseArrayInput(subcategoryIds),
        services: parseArrayInput(serviceIds),
        approvalStatus: 'pending'
    });
    await vendor.save();

    const latestRequest = vendor.extraServiceRequests[vendor.extraServiceRequests.length - 1];
    return {
        requestId: latestRequest._id,
        requestedBy: latestRequest.requestedBy || vendor._id,
        approvalStatus: latestRequest.approvalStatus,
        requestedAt: latestRequest.requestedAt,
        message: 'Extra service approval requested successfully'
    };
};

const getExtraServiceApprovalRequests = async (vendorId) => {
    const vendor = await Vendor.findById(vendorId)
        .select('extraServiceRequests selectedServices')
        .populate('extraServiceRequests.requestedBy', 'name phoneNumber vendorID')
        .populate('extraServiceRequests.category', 'name')
        .populate('extraServiceRequests.subcategories', 'name')
        .populate('extraServiceRequests.services', 'title');
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    const purchasedServiceIds = new Set((vendor.selectedServices || []).map((service) => String(service?._id || service)));
    const visibleRequests = (vendor.extraServiceRequests || []).filter((req) => {
        if (req.approvalStatus !== 'approved') return true;
        const requestServiceIds = (req.services || []).map((service) => String(service?._id || service));
        return !requestServiceIds.some((serviceId) => purchasedServiceIds.has(serviceId));
    });

    return {
        requests: visibleRequests.map((req) => ({
            requestId: req._id,
            requestedBy: req.requestedBy ? {
                id: req.requestedBy._id,
                name: req.requestedBy.name || '',
                phoneNumber: req.requestedBy.phoneNumber || '',
                vendorID: req.requestedBy.vendorID || ''
            } : { id: vendor._id },
            approvalStatus: req.approvalStatus,
            adminRemark: req.adminRemark || '',
            reviewedAt: req.reviewedAt || null,
            requestedAt: req.requestedAt,
            category: req.category ? { id: req.category._id, name: req.category.name } : null,
            services: (req.services || []).map((svc) => ({ id: svc._id, title: svc.title })),
            disapprovedServices: req.approvalStatus === 'disapproved'
                ? (req.services || []).map((svc) => ({ id: svc._id, title: svc.title }))
                : [],
        }))
    };
};

const reviewExtraServiceApprovalRequest = async (adminId, vendorId, requestId, { approvalStatus, adminRemark } = {}) => {
    const normalized = String(approvalStatus || '').toLowerCase();
    if (!['approved', 'disapproved', 'pending'].includes(normalized)) {
        throw new ApiError(400, 'approvalStatus must be approved, disapproved or pending');
    }

    const vendor = await Vendor.findById(vendorId);
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    const request = (vendor.extraServiceRequests || []).id(requestId);
    if (!request) throw new ApiError(404, 'Approval request not found');

    request.approvalStatus = normalized;
    request.adminRemark = adminRemark || '';
    request.reviewedBy = adminId || null;
    request.reviewedAt = new Date();
    await vendor.save();

    const payload = {
        vendorId: vendor._id,
        requestId: request._id,
        requestedBy: request.requestedBy || vendor._id,
        approvalStatus: request.approvalStatus,
        adminRemark: request.adminRemark,
        reviewedAt: request.reviewedAt,
        serviceIds: (request.services || []).map((svcId) => String(svcId)),
        disapprovedServiceIds: request.approvalStatus === 'disapproved'
            ? (request.services || []).map((svcId) => String(svcId))
            : []
    };
    emitToVendor(vendor._id, 'extra_service_approval_update', payload);

    try {
        await sendPush(
            vendor._id,
            'Vendor',
            'extra_service_approval',
            'Extra Service Approval Updated',
            `Your extra service request is ${request.approvalStatus}.`,
            payload
        );
    } catch (err) {
        console.error('Error sending extra service approval push:', err);
    }

    return payload;
};

/**
 * Add Category: Verify payment and activate
 */
const verifyAddCategoryPayment = async (vendorId, { razorpay_order_id, razorpay_payment_id, razorpay_signature, isAdminBypass = false, categoryId, selectedSubcategories, selectedServices, subcategories: payloadSubcategories, services: payloadServices }) => {
    // Support aliases often used by frontend
    if ((!selectedSubcategories || !selectedSubcategories.length) && payloadSubcategories) selectedSubcategories = payloadSubcategories;
    if ((!selectedServices || !selectedServices.length) && payloadServices) selectedServices = payloadServices;

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
        finalSubcategories = finalSubcategories || paymentRecord.metadata.selectedSubcategories || paymentRecord.metadata.subcategoryIds;
        finalServices = finalServices || paymentRecord.metadata.selectedServices || paymentRecord.metadata.serviceIds;
    }

    const vendor = await Vendor.findById(vendorId);
    if (!vendor) throw new ApiError(404, 'Vendor not found');
    if (!isAdminBypass && paymentRecord?.metadata?.approvalRequestId) {
        const approvalReq = (vendor.extraServiceRequests || []).id(paymentRecord.metadata.approvalRequestId);
        if (!approvalReq || approvalReq.approvalStatus !== 'approved') {
            throw new ApiError(403, 'Approval is not valid anymore. Payment cannot be processed.');
        }
        const approvedIds = new Set((approvalReq.services || []).map((id) => String(id)));
        const paidIds = new Set((finalServices || []).map((id) => String(id)));
        if (!paidIds.size || approvedIds.size !== paidIds.size || [...paidIds].some((id) => !approvedIds.has(id))) {
            throw new ApiError(403, 'Payment contains non-approved services.');
        }
    }

    // Add unique selections to vendor profile
    // Identify all categories involved in this purchase
    const categoriesToUpdate = new Map();

    // 1. If we have a single categoryId passed or in metadata, use it as the primary
    if (finalCategoryId) {
        categoriesToUpdate.set(String(finalCategoryId), {
            services: finalServices || [],
            subcategories: finalSubcategories || [],
            // Assign total fees to the primary category for now, or split if metadata allows
            fee: paymentRecord ? paymentRecord.totalAmount : 0,
            subtotal: paymentRecord ? paymentRecord.amount : 0,
            gstAmount: paymentRecord ? paymentRecord.gstAmount : 0
        });
    }

    // 2. If no categoryId but we have services, derive all categories from the services
    if (categoriesToUpdate.size === 0 && finalServices && finalServices.length > 0) {
        const servicesData = await Service.find({ _id: { $in: finalServices } }).lean();
        servicesData.forEach(svc => {
            const catId = String(svc.category);
            if (!categoriesToUpdate.has(catId)) {
                categoriesToUpdate.set(catId, { services: [], subcategories: [], fee: 0, subtotal: 0, gstAmount: 0 });
            }
            categoriesToUpdate.get(catId).services.push(svc._id);
            if (svc.subcategory) {
                const subStr = String(svc.subcategory);
                if (!categoriesToUpdate.get(catId).subcategories.includes(subStr)) {
                    categoriesToUpdate.get(catId).subcategories.push(subStr);
                }
            }
        });
        
        // Also add subcategories from finalSubcategories if they belong to derived categories
        if (finalSubcategories && Array.isArray(finalSubcategories)) {
            const subcategoriesData = await Subcategory.find({ _id: { $in: finalSubcategories } }).lean();
            subcategoriesData.forEach(sub => {
                const catId = String(sub.category);
                if (categoriesToUpdate.has(catId)) {
                    const subStr = String(sub._id);
                    if (!categoriesToUpdate.get(catId).subcategories.includes(subStr)) {
                        categoriesToUpdate.get(catId).subcategories.push(subStr);
                    }
                }
            });
        }
        
        // Also add total fees to the first category if not already set
        if (categoriesToUpdate.size > 0 && paymentRecord) {
            const firstCatId = Array.from(categoriesToUpdate.keys())[0];
            categoriesToUpdate.get(firstCatId).fee = paymentRecord.totalAmount;
            categoriesToUpdate.get(firstCatId).subtotal = paymentRecord.amount;
            categoriesToUpdate.get(firstCatId).gstAmount = paymentRecord.gstAmount;
        }
    }

    // Update vendor profile for each category involved
    const now = new Date();
    const _rd5 = await adminService.getSetting('pricing.service_renewal_days');
    const renewalDays = (_rd5 !== undefined && _rd5 !== null && _rd5 !== '') ? Number(_rd5) : 30;

    for (const [catIdStr, data] of categoriesToUpdate.entries()) {
        const catId = new mongoose.Types.ObjectId(catIdStr);

        // Add to selectedCategories
        if (!vendor.selectedCategories.map(id => String(id)).includes(catIdStr)) {
            vendor.selectedCategories.push(catId);
        }

        // Add services to selectedServices
        if (data.services && Array.isArray(data.services)) {
            data.services.forEach(svcId => {
                const svcIdStr = String(svcId);
                if (!vendor.selectedServices.map(id => String(id)).includes(svcIdStr)) {
                    vendor.selectedServices.push(svcId);
                }
            });
        }

        // Add subcategories to selectedSubcategories
        if (data.subcategories && Array.isArray(data.subcategories)) {
            data.subcategories.forEach(subId => {
                const subIdStr = String(subId);
                if (!vendor.selectedSubcategories.map(id => String(id)).includes(subIdStr)) {
                    vendor.selectedSubcategories.push(subId);
                }
            });
        }

        // Expiry Date Logic
        let expiryDate = new Date(now);
        expiryDate.setDate(expiryDate.getDate() + Number(renewalDays));

        if (paymentRecord && paymentRecord.metadata && paymentRecord.metadata.alignedExpiryDate) {
            const alignedDate = new Date(paymentRecord.metadata.alignedExpiryDate);
            if (alignedDate > now) {
                expiryDate = alignedDate;
            }
        }

        // Update or Push to categorySubscriptions
        const existingSubIndex = vendor.categorySubscriptions.findIndex(s => s.category.toString() === catIdStr);
        if (existingSubIndex > -1) {
            vendor.categorySubscriptions[existingSubIndex].expiryDate = expiryDate;
            vendor.categorySubscriptions[existingSubIndex].status = 'ACTIVE';
            vendor.categorySubscriptions[existingSubIndex].fee = (vendor.categorySubscriptions[existingSubIndex].fee || 0) + data.fee;
            vendor.categorySubscriptions[existingSubIndex].subtotal = (vendor.categorySubscriptions[existingSubIndex].subtotal || 0) + data.subtotal;
            vendor.categorySubscriptions[existingSubIndex].gstAmount = (vendor.categorySubscriptions[existingSubIndex].gstAmount || 0) + data.gstAmount;
            vendor.categorySubscriptions[existingSubIndex].paymentRecordId = paymentRecord ? paymentRecord._id : vendor.categorySubscriptions[existingSubIndex].paymentRecordId;
            
            vendor.categorySubscriptions[existingSubIndex].subcategories = Array.from(new Set([...(vendor.categorySubscriptions[existingSubIndex].subcategories || []), ...(data.subcategories || [])]));
            vendor.categorySubscriptions[existingSubIndex].services = Array.from(new Set([...(vendor.categorySubscriptions[existingSubIndex].services || []), ...(data.services || [])]));
        } else {
            vendor.categorySubscriptions.push({
                category: catId,
                subcategories: data.subcategories || [],
                services: data.services || [],
                startDate: now,
                expiryDate: expiryDate,
                fee: data.fee,
                subtotal: data.subtotal,
                gstAmount: data.gstAmount,
                paymentRecordId: paymentRecord ? paymentRecord._id : null,
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

    const purchasedServiceIds = new Set((vendor.selectedServices || []).map((service) => String(service?._id || service)));
    vendor.extraServiceRequests = (vendor.extraServiceRequests || []).filter((request) => {
        if (paymentRecord?.metadata?.approvalRequestId && String(request._id) === String(paymentRecord.metadata.approvalRequestId)) {
            return false;
        }
        if (request.approvalStatus !== 'approved') {
            return true;
        }
        const requestServiceIds = (request.services || []).map((service) => String(service?._id || service));
        return !requestServiceIds.some((serviceId) => purchasedServiceIds.has(serviceId));
    });

    await vendor.save();

    // Notify Vendor about successful purchase
    const { sendPush } = require('../../utils/pushNotification');
    sendPush(
        vendorId,
        'Vendor',
        'purchase_success',
        'Services Activated',
        'Your newly purchased services are now active and you will start receiving bookings for them.',
        { 
            categoryId: finalCategoryId ? String(finalCategoryId) : undefined,
            serviceCount: finalServices ? finalServices.length : 0 
        }
    );

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


/**
 * Admin: Respond to deletion request
 */


const respondToDeletionRequest = async (vendorId, { action }) => {
    const vendor = await Vendor.findById(vendorId);
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    if (!vendor.deletionRequest?.isRequested) {
        throw new ApiError(400, 'No deletion request found for this vendor');
    }

    if (action === 'ACCEPT') {
        const Booking = require('../../models/Booking.model');
        const Notification = require('../../models/Notification.model');
        const Dispute = require('../../models/Dispute.model');
        const CoinTransaction = require('../../models/CoinTransaction.model');
        const PaymentRecord = require('../../models/PaymentRecord.model');

        // Perform Hard Delete (remove data for admin-initiated deletion)
        await Promise.all([
            Booking.deleteMany({ vendor: vendorId }),
            Notification.deleteMany({ vendor: vendorId }),
            Dispute.deleteMany({ vendor: vendorId }),
            CoinTransaction.deleteMany({ targetId: vendorId }),
            PaymentRecord.deleteMany({ vendor: vendorId })
        ]);

        await Vendor.findByIdAndDelete(vendorId);

        return { message: 'Deletion request accepted. Vendor account and all associated data have been permanently removed.' };
    } else if (action === 'REJECT') {
        vendor.deletionRequest.isRequested = false;
        vendor.deletionRequest.status = 'REJECTED';
        await vendor.save();
        return { message: 'Deletion request rejected.' };
    } else {
        throw new ApiError(400, 'Invalid action. Use ACCEPT or REJECT.');
    }
};

/**
 * Calculate payment detail for a set of serviceIds the vendor wants to purchase.
 *
 * Rules (mirroring getAvailablePurchaseCategories):
 *  1. If a parent (category / subcategory / type) already has a purchased service
 *     → that level's charge is 0.
 *  2. A parent charge is counted AT MOST ONCE across all selected services in this
 *     request — even when multiple services share the same category/sub/type.
 *  3. If a service is already purchased → its serviceCharge is 0.
 *
 * @param {string} vendorId
 * @param {string[]} serviceIds  - IDs of services the vendor wants to buy
 * @returns {{ items, subtotal, gstPercent, gstAmount, total }}
 */
const calculatePurchasePaymentDetail = async (vendorId, serviceIds = []) => {
    const vendor = await Vendor.findById(vendorId).lean();
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    if (!serviceIds.length) {
        return { items: [], subtotal: 0, gstPercent: 18, gstAmount: 0, total: 0 };
    }

    const gstSetting = await adminService.getSetting('pricing.membership_gst_percent');
    const gstPercent = (gstSetting !== undefined && gstSetting !== null) ? Number(gstSetting) : 0;

    const renewalDaysSetting = await adminService.getSetting('pricing.service_renewal_days');
    const adminRenewalDays = (renewalDaysSetting !== undefined && renewalDaysSetting !== null && renewalDaysSetting !== '') ? Number(renewalDaysSetting) : 30;

    // Derive renewalDays from the vendor's actual serviceRenewal cycle dates.
    // This ensures proration aligns to the real service expiry, not just the admin setting.
    const now = new Date();
    const svcRenStart  = vendor.serviceRenewal?.startDate  ? new Date(vendor.serviceRenewal.startDate)  : null;
    const svcRenExpiry = vendor.serviceRenewal?.expiryDate ? new Date(vendor.serviceRenewal.expiryDate) : null;
    const svcRenActive = svcRenExpiry && svcRenExpiry > now;

    let renewalDays = adminRenewalDays; // fallback
    if (svcRenActive && svcRenStart && svcRenExpiry > svcRenStart) {
        // Use actual cycle length from the vendor's serviceRenewal
        renewalDays = Math.ceil((svcRenExpiry - svcRenStart) / (1000 * 60 * 60 * 24));
    }

    // ── 1. Build the same purchased-service set as getAvailablePurchaseCategories ──
    const purchasedServiceIds = new Set((vendor.selectedServices || []).map(id => id.toString()));
    const selectedCategoryIds    = new Set((vendor.selectedCategories    || []).map(id => id.toString()));
    const selectedSubcategoryIds = new Set((vendor.selectedSubcategories || []).map(id => id.toString()));
    const selectedTypeIds        = new Set((vendor.selectedServiceTypes || []).map(id => id.toString()));

    for (const catSub of (vendor.categorySubscriptions || [])) {
        if (catSub.category) {
            selectedCategoryIds.add(catSub.category.toString());
        }
        for (const subId of (catSub.subcategories || [])) {
            selectedSubcategoryIds.add(subId.toString());
        }
        for (const svcId of (catSub.services || [])) {
            purchasedServiceIds.add(svcId.toString());
        }
    }

    // Derive which categories / subcategories / types are already paid
    const allServices = await Service.find({}).lean();
    const purchasedCategoryIds   = new Set();
    const purchasedSubcategoryIds = new Set();
    const purchasedTypeIds        = new Set();
    for (const s of allServices) {
        if (purchasedServiceIds.has(s._id.toString())) {
            if (s.category)    purchasedCategoryIds.add(s.category.toString());
            if (s.subcategory) purchasedSubcategoryIds.add(s.subcategory.toString());
            if (s.serviceType) purchasedTypeIds.add(s.serviceType.toString());
        }
    }

    const finalPurchasedCategoryIds    = new Set([...selectedCategoryIds,    ...purchasedCategoryIds]);
    const finalPurchasedSubcategoryIds = new Set([...selectedSubcategoryIds, ...purchasedSubcategoryIds]);
    const finalPurchasedTypeIds        = new Set([...selectedTypeIds,        ...purchasedTypeIds]);

    // ── 2. Load the requested services with their parent documents ──
    const parsedIds  = serviceIds.map(id => id.toString());
    const targetServices = allServices.filter(s => parsedIds.includes(s._id.toString()));

    const allCategories    = await Category.find({}).lean();
    const allSubcategories = await Subcategory.find({}).lean();
    const allTypes         = await ServiceType.find({}).lean();

    const catMap  = new Map(allCategories.map(c => [c._id.toString(), c]));
    const subMap  = new Map(allSubcategories.map(s => [s._id.toString(), s]));
    const typeMap = new Map(allTypes.map(t => [t._id.toString(), t]));

    // ── 3. Build line items; deduplicate parent charges across services ──
    // Track which parent IDs have already been charged IN THIS REQUEST
    const chargedCategoryIds    = new Set();
    const chargedSubcategoryIds = new Set();
    const chargedTypeIds        = new Set();

    const items = [];
    let subtotal = 0;
    let originalSubtotal = 0;
    // Initialise summary days/expiry from vendor's actual serviceRenewal — not the admin setting.
    // This is the source-of-truth for what the vendor has already paid for.
    let summaryPurchasedDays = svcRenActive
        ? Math.ceil((svcRenExpiry - now) / (1000 * 60 * 60 * 24))
        : renewalDays;
    let summaryExpiryDate = svcRenActive ? svcRenExpiry : null;

    for (const service of targetServices) {
        const catId  = service.category?.toString();
        const subId  = service.subcategory?.toString();
        const typeId = service.serviceType?.toString();

        const cat  = catId  ? catMap.get(catId)   : null;
        const sub  = subId  ? subMap.get(subId)   : null;
        const type = typeId ? typeMap.get(typeId) : null;

        // --- Category charge ---
        // 0 if: already purchased OR already charged in this request
        const catCharge = _getMembershipCharge(cat, 'category');
        let catChargeToPay = 0;
        let catOriginalCharge = 0;
        let catIsProrated = false;
        let catPurchasedDays = renewalDays;
        if (cat && !finalPurchasedCategoryIds.has(catId) && !chargedCategoryIds.has(catId)) {
            const proration = _calculateProration(vendor, catId, catCharge, renewalDays);
            catChargeToPay = proration.amount;
            catOriginalCharge = catCharge;
            catIsProrated = proration.isProrated;
            catPurchasedDays = proration.remainingDays;
            summaryPurchasedDays = proration.remainingDays;
            chargedCategoryIds.add(catId);
        }

        // --- Subcategory charge ---
        const subCharge = _getMembershipCharge(sub, 'subcategory');
        let subChargeToPay = 0;
        let subOriginalCharge = 0;
        let subIsProrated = false;
        let subPurchasedDays = renewalDays;
        if (sub && !finalPurchasedSubcategoryIds.has(subId) && !chargedSubcategoryIds.has(subId)) {
            const proration = _calculateProration(vendor, catId, subCharge, renewalDays);
            subChargeToPay = proration.amount;
            subOriginalCharge = subCharge;
            subIsProrated = proration.isProrated;
            subPurchasedDays = proration.remainingDays;
            summaryPurchasedDays = proration.remainingDays;
            chargedSubcategoryIds.add(subId);
        }

        // --- Type charge ---
        const typeCharge = _getMembershipCharge(type, 'serviceType');
        let typeChargeToPay = 0;
        let typeOriginalCharge = 0;
        let typeIsProrated = false;
        let typePurchasedDays = renewalDays;
        if (type && !finalPurchasedTypeIds.has(typeId) && !chargedTypeIds.has(typeId)) {
            const proration = _calculateProration(vendor, catId, typeCharge, renewalDays);
            typeChargeToPay = proration.amount;
            typeOriginalCharge = typeCharge;
            typeIsProrated = proration.isProrated;
            typePurchasedDays = proration.remainingDays;
            summaryPurchasedDays = proration.remainingDays;
            chargedTypeIds.add(typeId);
        }

        // --- Service charge ---
        const svcCharge = _getMembershipCharge(service, 'service');
        const isServicePurchased = purchasedServiceIds.has(service._id.toString());

        // Skip already-purchased services entirely — do not include in the list.
        // Parent charges already marked in chargedCategoryIds / chargedSubcategoryIds /
        // chargedTypeIds so sibling services in this request don't double-count.
        if (isServicePurchased) continue;

        const svcProration = _calculateProration(vendor, catId, svcCharge, renewalDays);
        const svcChargeToPay = svcProration.amount;
        const svcOriginalCharge = svcCharge;
        const lineSubtotal = catChargeToPay + subChargeToPay + typeChargeToPay + svcChargeToPay;
        const lineOriginalSubtotal = catOriginalCharge + subOriginalCharge + typeOriginalCharge + svcOriginalCharge;
        subtotal += lineSubtotal;
        originalSubtotal += lineOriginalSubtotal;
        summaryPurchasedDays = svcProration.remainingDays;
        if (svcProration.expiryDate) summaryExpiryDate = svcProration.expiryDate;

        // Flat line items — matching requested JSON format
        if (catOriginalCharge > 0) items.push({ purchaseType: 'category', id: cat._id.toString(), name: cat.name, serviceCharge: catChargeToPay, originalCharge: catOriginalCharge, isProrated: catIsProrated, purchasedDays: catPurchasedDays });
        if (subOriginalCharge > 0) items.push({ purchaseType: 'subcategory', id: sub._id.toString(), name: sub.name, serviceCharge: subChargeToPay, originalCharge: subOriginalCharge, isProrated: subIsProrated, purchasedDays: subPurchasedDays });
        if (typeOriginalCharge > 0) items.push({ purchaseType: 'type', id: type._id.toString(), name: type.name, serviceCharge: typeChargeToPay, originalCharge: typeOriginalCharge, isProrated: typeIsProrated, purchasedDays: typePurchasedDays });
        if (svcOriginalCharge > 0) items.push({ purchaseType: 'service', id: service._id.toString(), name: service.title, serviceCharge: svcChargeToPay, originalCharge: svcOriginalCharge, isProrated: svcProration.isProrated, purchasedDays: svcProration.remainingDays });
    }

    const gstAmount = Math.round(subtotal * (gstPercent / 100));
    const totalAmount = subtotal + gstAmount;

    const originalGstAmount = Math.round(originalSubtotal * (gstPercent / 100));
    const originalTotalAmount = originalSubtotal + originalGstAmount;
    const discountAmount = originalTotalAmount - totalAmount;

    return {
        purchasedItems: items,
        paymentSummary: {
            subTotal: subtotal,
            remainingDaysCharge: subtotal,
            gst: {
                percentage: gstPercent,
                amount: gstAmount
            },
            discountAmount,
            totalAmount
        },
        subscriptionDetails: {
            remainingDays: summaryPurchasedDays,
            purchasedDays: summaryPurchasedDays,
            expiryDate: summaryExpiryDate
        },
        originalAmounts: {
            subTotal: originalSubtotal,
            gstAmount: originalGstAmount,
            totalAmount: originalTotalAmount
        },
        // Legacy flat fields for backward compatibility
        remainingDaysCharge: subtotal,
        gstForAmount: gstAmount,
        totalAmount,
        remainingDays: summaryPurchasedDays,
        summary: {
            subTotal: subtotal,
            remainingDaysCharge: subtotal,
            gstForAmount: gstAmount,
            totalAmount,
            remainingDays: summaryPurchasedDays,
            gstPercent,
            gstAmount,
            totalAmount,
            originalSubtotal,
            originalGstAmount,
            originalTotalAmount,
            discountAmount,
            purchasedDays: summaryPurchasedDays,
            expiryDate: summaryExpiryDate
        }
    };
};

/**
 * Purchase Categories: Create order for multi-category selection
 */
const createPurchaseOrder = async (vendorId, { serviceIds = [], approvalRequestId } = {}) => {
    const vendor = await Vendor.findById(vendorId).select('extraServiceRequests');
    if (!vendor) throw new ApiError(404, 'Vendor not found');
    const payloadIds = new Set((serviceIds || []).map((id) => String(id)));
    let approvedRequest = null;
    if (approvalRequestId) {
        approvedRequest = (vendor.extraServiceRequests || []).find((req) =>
            String(req._id) === String(approvalRequestId) && req.approvalStatus === 'approved'
        );
    } else {
        approvedRequest = (vendor.extraServiceRequests || []).find((req) => {
            if (req.approvalStatus !== 'approved') return false;
            const reqIds = new Set((req.services || []).map((id) => String(id)));
            return reqIds.size === payloadIds.size && [...payloadIds].every(id => reqIds.has(id));
        });
    }

    if (!approvedRequest) {
        throw new ApiError(403, 'Admin approval is required before purchasing extra services');
    }
    const requestedIds = new Set((approvedRequest.services || []).map((id) => String(id)));
    if (!serviceIds?.length || requestedIds.size !== payloadIds.size || [...payloadIds].some((id) => !requestedIds.has(id))) {
        throw new ApiError(403, 'Only approved services can be purchased');
    }

    const feeDetails = await calculatePurchasePaymentDetail(vendorId, serviceIds);

    const totalToPay = feeDetails.summary.totalAmount;

    if (totalToPay <= 0) {
        throw new ApiError(400, 'Total fee for the selected services is zero. Cannot create payment order.');
    }

    let razorpayOrder;
    try {
        if (totalToPay <= 0) {
            razorpayOrder = {
                id: `order_free_${vendorId.toString().slice(-10)}_${Date.now()}`,
                amount: 0,
                currency: 'INR',
                receipt: `add_svc_${vendorId.toString().slice(-10)}_${Date.now()}`,
                status: 'created'
            };
        } else {
            razorpayOrder = await getRazorpay().orders.create({
                amount: Math.round(totalToPay * 100),
                currency: 'INR',
                receipt: `add_svc_${vendorId.toString().slice(-10)}_${Date.now()}`,
                notes: {
                    vendorId: vendorId.toString(),
                    purpose: 'multi_category_purchase',
                },
            });
        }

        // Log the pending payment record
        await PaymentRecord.create({
            vendor: vendorId,
            orderId: razorpayOrder.id,
            purpose: 'CATEGORY_PURCHASE',
            amount: feeDetails.summary.subTotal,
            gstAmount: feeDetails.summary.gstAmount,
            totalAmount: totalToPay,
            status: 'PENDING',
            metadata: {
                serviceIds: serviceIds,
                approvalRequestId: approvedRequest._id,
                breakdown: feeDetails.purchasedItems,
                summary: feeDetails.summary,
                alignedExpiryDate: feeDetails.summary.expiryDate
            }
        });

    } catch (error) {
        console.error('Razorpay Purchase Order Error:', error);
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

module.exports = {
    getAllVendors,
    getMembershipInfo,
    getVendorMembershipDetails,
    createMembershipOrder,
    verifyMembershipPayment,
    selectServices,
    approveVendorServices,
    getServiceApprovalStatus,
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
    respondToDeletionRequest,
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
    requestExtraServiceApproval,
    getExtraServiceApprovalRequests,
    reviewExtraServiceApprovalRequest,
    createAddCategoryOrder,
    verifyAddCategoryPayment,
    getAvailablePurchaseCategories,
    calculatePurchasePaymentDetail,
    createPurchaseOrder,
};
