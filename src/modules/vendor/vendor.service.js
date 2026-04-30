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
const config = require('../../config/env');
const { emitToVendor } = require('../../socket');
const { parseArrayInput } = require('../../utils/dataParser');
const adminService = require('../admin/admin.service');


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
    if (s.startsWith('approve') || s.startsWith('verify') || s === 'verified') return 'approved';
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
    const charge = toNumber(item.membershipCharge || item.membershipFee);
    if (charge > 0) return charge;

    // Specific fallback for subcategories
    if (type === 'subcategory' && item.price > 0) return toNumber(item.price);

    // Last resort fallback to serviceCharge (commonly used in admin panel as registration fee)
    return toNumber(item.serviceCharge);
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
    const gstPercent = (gstSetting !== undefined && gstSetting !== null) ? Number(gstSetting) : 18;

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
        validityDays: plan.validityDays,
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
        .select('selectedCategories selectedSubcategories selectedServiceTypes selectedServices membership.durationMonths membership.membershipId categorySubscriptions')
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

    const paymentHistory = await PaymentRecord.find({ vendor: vendorId, status: 'COMPLETED' })
        .sort({ createdAt: -1 })
        .populate('planId', 'name price validityDays')
        .lean();

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
        membershipId: vendor.membership?.membershipId || null
    };
};


/**
 * Create Razorpay order for membership payment
 * vendorId is extracted from token (req.user), NOT from URL
 */
const createMembershipOrder = async (vendorId, { durationMonths, amount, membershipId } = {}) => {
    const vendor = await Vendor.findById(vendorId);
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    // Update durationMonths if provided
    if (durationMonths) {
        vendor.membership.durationMonths = Number(durationMonths);
        await vendor.save();
    }
    
    if (membershipId) {
        vendor.membership = vendor.membership || {};
        vendor.membership.membershipId = membershipId;
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
    const gstPercent = (gstSetting !== undefined && gstSetting !== null) ? Number(gstSetting) : 18; // Use 18 as consistent default


    const result = [];
    for (const plan of tiers) {
        const baseFee = (plan.price || 0);
        const validityDays = plan.validityDays || 30;
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
                        membershipFee: _getMembershipCharge(svc, 'service')
                    }));

                return {
                    id: sub._id,
                    name: sub.name,
                    membershipFee: _getMembershipCharge(sub, 'subcategory'),
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
                membershipFee: _getMembershipCharge(svc, 'service')
            }));

        return {
            id: cat._id,
            name: cat.name,
            membershipFee: _getMembershipCharge(cat, 'category'),
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
/**
 * Internal helper to calculate prorated amount based on remaining days of membership or category subscription.
 * Calculation: (Amount / 30) * RemainingDays
 */
const _calculateProration = (vendor, categoryId, amount) => {
    if (amount <= 0) return { amount: 0, remainingDays: 0, factor: 0 };
    
    const now = new Date();
    let expiryDate = null;

    // 1. Check if there's an existing active category subscription for this category
    if (categoryId && vendor.categorySubscriptions) {
        const catSub = vendor.categorySubscriptions.find(s => 
            s.category && s.category.toString() === categoryId.toString() && 
            s.expiryDate > now && 
            s.status === 'ACTIVE'
        );
        if (catSub) expiryDate = catSub.expiryDate;
    }

    // 2. Fallback to main membership expiry if category not found or expired
    if (!expiryDate) {
        if (vendor.membership?.expiryDate && vendor.membership.expiryDate > now) {
            expiryDate = vendor.membership.expiryDate;
        }
    }

    // 3. If no active period found, no proration possible (assume full 30 days)
    if (!expiryDate) {
        return { 
            amount, 
            remainingDays: 30, 
            factor: 1, 
            isProrated: false 
        };
    }

    const diffTime = expiryDate - now;
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    
    // Calculate factor based on a standard 30-day billing cycle
    // We cap the factor at 1.0 (full price) even if they have >30 days remaining,
    // as service charges are typically for 30-day blocks.
    const factor = Math.max(0, Math.min(1, diffDays / 30));
    
    return {
        amount: Math.round(amount * factor),
        remainingDays: diffDays,
        factor,
        expiryDate,
        isProrated: factor < 1
    };
};

const getAvailablePurchaseCategories = async (vendorId) => {
    const vendor = await Vendor.findById(vendorId);
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    const allCategories = await Category.find({}).lean();
    const allSubcategories = await Subcategory.find({}).lean();
    const allServices = await Service.find({}).lean();
    const allServiceTypes = await ServiceType.find({}).lean();

    const selectedServiceIds = (vendor.selectedServices || []).map(id => id.toString());

    const result = [];

    for (const svc of allServices) {
        const svcIdStr = svc._id.toString();
        
        const catId = svc.category?.toString();
        const subId = svc.subcategory?.toString();
        const typeId = svc.serviceType?.toString();

        const cat = allCategories.find(c => c._id.toString() === catId);
        const sub = allSubcategories.find(s => s._id.toString() === subId);
        const st = allServiceTypes.find(t => t._id.toString() === typeId);

        const servicePrice = _getMembershipCharge(svc, 'service');
        const categoryCharge = _getMembershipCharge(cat, 'category');
        const subCategoryCharge = _getMembershipCharge(sub, 'subcategory');
        const typeCharge = _getMembershipCharge(st, 'serviceType');

        result.push({
            id: svc._id,
            name: svc.title,
            pricing: {
                servicePrice,
                categoryCharge,
                subCategoryCharge,
                typeCharge,
                total: servicePrice + categoryCharge + subCategoryCharge + typeCharge
            }
        });
    }

    return result;
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
            const plan = await getPlanByDuration(durationMonths);
            const validityDays = plan.validityDays || (durationMonths * 30);

            const expiryDate = new Date(startDate);
            expiryDate.setDate(expiryDate.getDate() + Number(validityDays));

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
        const plan = await getPlanByDuration(durationMonths);
        const validityDays = plan.validityDays || (durationMonths * 30);

        const expiryDate = new Date(startDate);
        expiryDate.setDate(expiryDate.getDate() + Number(validityDays));

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
const verifyMembershipPayment = async (vendorId, { razorpay_order_id, razorpay_payment_id, razorpay_signature, membershipId }) => {
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

    if (membershipId) {
        vendor.membership = vendor.membership || {};
        vendor.membership.membershipId = membershipId;
    }

    if (vendor.isVerified) {
        const now = new Date();
        const durationMonths = vendor.membership.durationMonths || 3;
        const plan = await getPlanByDuration(durationMonths);
        const validityDays = plan.validityDays || (durationMonths * 30);

        vendor.membership.startDate = vendor.membership.startDate || now;
        const expiryDate = new Date(vendor.membership.startDate);
        expiryDate.setDate(expiryDate.getDate() + Number(validityDays));
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

    // Ensure membership metadata is populated if missing
    if (!vendor.membership.totalAmount || !vendor.membership.category) {
        try {
            const memDetails = await getVendorMembershipDetails(vendor._id, { membershipId });
            if (!vendor.membership.membershipFee) vendor.membership.membershipFee = memDetails.basePlanFee;
            if (!vendor.membership.serviceFee) vendor.membership.serviceFee = memDetails.serviceSelectionsTotal;
            if (!vendor.membership.gstAmount) vendor.membership.gstAmount = memDetails.gstAmount;
            if (!vendor.membership.totalAmount) vendor.membership.totalAmount = memDetails.totalFee;
            if (!vendor.membership.subtotal) vendor.membership.subtotal = memDetails.subtotal;
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

    // Calculate totalFee
    let serviceSubtotal = 0;
    categories.forEach(c => serviceSubtotal += (c.serviceRenewalCharge || c.renewalCharge || 0));
    subcategories.forEach(s => serviceSubtotal += (s.serviceRenewalCharge || s.renewalCharge || 0));
    serviceTypes.forEach(st => serviceSubtotal += (st.serviceRenewalCharge || 0));
    services.forEach(s => serviceSubtotal += (s.serviceRenewalCharge || 0));

    // Build the hierarchical breakdown
    const hierarchy = categories.map(cat => {
        const catId = String(cat._id);
        const catRenewal = cat.serviceRenewalCharge || cat.renewalCharge || 0;

        const subList = subcategories
            .filter(sub => String(sub.category) === catId)
            .map(sub => {
                const subId = String(sub._id);
                const subRenewal = sub.serviceRenewalCharge || sub.renewalCharge || 0;

                const typeList = serviceTypes
                    .filter(st => String(st.subcategory) === subId)
                    .map(st => {
                        const stId = String(st._id);
                        const stRenewal = st.serviceRenewalCharge || 0;

                        const svcList = services
                            .filter(svc => String(svc.serviceType) === stId)
                            .map(svc => ({
                                id: svc._id,
                                title: svc.title,
                                renewalAmount: svc.serviceRenewalCharge || 0
                            }))
                            .filter(s => s.renewalAmount > 0);

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
                        renewalAmount: svc.serviceRenewalCharge || 0
                    }))
                    .filter(s => s.renewalAmount > 0);

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
                renewalAmount: svc.serviceRenewalCharge || 0
            }))
            .filter(s => s.renewalAmount > 0);

        return {
            id: cat._id,
            name: cat.name,
            renewalAmount: catRenewal,
            subcategories: subList,
            services: independentServices
        };
    }).filter(c => c.renewalAmount > 0 || (c.subcategories && c.subcategories.length > 0) || (c.services && c.services.length > 0));

    return {
        vendorId: vendor._id,
        subtotal: serviceSubtotal,
        gstPercent: 0,
        gstAmount: 0,
        totalFee: serviceSubtotal,
        serviceRenewal: {
            fee: serviceSubtotal,
            expiryDate: vendor.serviceRenewal?.expiryDate || null,
            breakdown: hierarchy
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

    const vendor = await Vendor.findById(vendorId).lean();
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    const category = await Category.findById(categoryId).lean();
    if (!category) throw new ApiError(404, 'Category not found');

    const parsedSubcategoryIds = parseArrayInput(subcategoryIds);
    const parsedServiceIds = parseArrayInput(serviceIds);

    const subcategories = await Subcategory.find({ _id: { $in: parsedSubcategoryIds } }).lean();
    const services = await Service.find({ _id: { $in: parsedServiceIds } }).lean();

    const isCatOwned = (vendor.selectedCategories || []).map(id => id.toString()).includes(categoryId.toString());
    
    // Category Charge (0 if already owned)
    const categoryBaseCharge = _getMembershipCharge(category, 'category');
    const categoryProration = isCatOwned ? { amount: 0, remainingDays: 0 } : _calculateProration(vendor, categoryId, categoryBaseCharge);
    
    let totalFee = categoryProration.amount;
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
        const baseCharge = _getMembershipCharge(sub, 'subcategory');
        const proration = _calculateProration(vendor, categoryId, baseCharge);
        
        totalFee += proration.amount;
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
        const baseCharge = _getMembershipCharge(svc, 'service');
        const proration = _calculateProration(vendor, categoryId, baseCharge);
        
        totalFee += proration.amount;
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
    const gstPercent = (gstSetting !== undefined && gstSetting !== null) ? Number(gstSetting) : 18;
    const gstAmount = Math.round(totalFee * (gstPercent / 100));
    const totalWithGst = totalFee + gstAmount;
    return {
        vendorId,
        categoryId,
        totalCharge: totalFee, // Subtotal of service charges
        gstAmount,
        totalWithGst,
        subtotal: totalFee,
        totalServiceFee: additionalSelectionsTotal,
        serviceSelectionsTotal: additionalSelectionsTotal,
        totalFee: totalWithGst,
        platformSubtotal: totalFee,
        gstPercent,
        basePlanFee: 0,
        itemBreakdown,
        razorpayKeyId: config.RAZORPAY_KEY_ID,
        breakdown,
        prorationContext: {
            remainingDays: categoryProration.remainingDays || 0,
            expiryDate: categoryProration.expiryDate
        }
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
                categoryId: categoryId,
                isProrated: (feeDetails.prorationContext?.remainingDays || 30) < 30,
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
        let expiryDate = new Date(now);
        expiryDate.setDate(expiryDate.getDate() + 30); // Default 1 month

        // Align with prorated expiry if provided in payment record
        if (paymentRecord && paymentRecord.metadata && paymentRecord.metadata.alignedExpiryDate) {
            const alignedDate = new Date(paymentRecord.metadata.alignedExpiryDate);
            if (alignedDate > now) {
                expiryDate = alignedDate;
            }
        }

        // Use the total amount paid from the payment record if available for accuracy
        const fee = paymentRecord ? paymentRecord.totalAmount : 0;

        const existingSubIndex = vendor.categorySubscriptions.findIndex(s => s.category.toString() === catIdStr);
        if (existingSubIndex > -1) {
            vendor.categorySubscriptions[existingSubIndex].expiryDate = expiryDate;
            vendor.categorySubscriptions[existingSubIndex].status = 'ACTIVE';
            vendor.categorySubscriptions[existingSubIndex].fee = (vendor.categorySubscriptions[existingSubIndex].fee || 0) + fee;
            vendor.categorySubscriptions[existingSubIndex].subcategories = Array.from(new Set([...(vendor.categorySubscriptions[existingSubIndex].subcategories || []), ...(finalSubcategories || [])]));
            vendor.categorySubscriptions[existingSubIndex].services = Array.from(new Set([...(vendor.categorySubscriptions[existingSubIndex].services || []), ...(finalServices || [])]));
        } else {
            vendor.categorySubscriptions.push({
                category: finalCategoryId,
                subcategories: finalSubcategories || [],
                services: finalServices || [],
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
        vendor.deletionRequest.status = 'APPROVED';
        vendor.deletedAt = new Date();
        await vendor.save();
        return { message: 'Deletion request accepted. Vendor account is now marked as deleted.' };
    } else if (action === 'REJECT') {
        vendor.deletionRequest.isRequested = false;
        vendor.deletionRequest.status = 'REJECTED';
        await vendor.save();
        return { message: 'Deletion request rejected.' };
    } else {
        throw new ApiError(400, 'Invalid action. Use ACCEPT or REJECT.');
    }
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
    createAddCategoryOrder,
    verifyAddCategoryPayment,
    getAvailablePurchaseCategories,
};

