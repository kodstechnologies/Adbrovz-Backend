const { stringifyId } = require('../utils/stringifyId');

const registerVerificationHandlers = (io, socket) => {
    socket.on('verify_vendor_document', async (data) => {
        try {
            const vendorId = stringifyId(data?.vendorId);
            const { docType, status, reason } = data || {};
            if (!vendorId) throw new Error('Vendor ID is required');
            const vendorService = require('../../modules/vendor/vendor.service');
            const result = await vendorService.verifyDocument(vendorId, { docType, status, reason });
            socket.emit('verify_vendor_document_success', result);
        } catch (error) {
            socket.emit('verification_error', { action: 'verify_vendor_document', message: error.message });
        }
    });

    socket.on('get_verification_status', async (data) => {
        try {
            const vendorId = stringifyId(data?.vendorId || socket.vendorId);
            if (!vendorId) throw new Error('Vendor ID is required');
            const vendorService = require('../../modules/vendor/vendor.service');
            const result = await vendorService.getVerificationStatus(vendorId);
            socket.emit('verification_status_response', result);
        } catch (error) {
            socket.emit('verification_error', { action: 'get_verification_status', message: error.message });
        }
    });

    socket.on('verify_all_vendor_documents', async (data) => {
        try {
            const vendorId = stringifyId(data?.vendorId);
            if (!vendorId) throw new Error('Vendor ID is required');
            const vendorService = require('../../modules/vendor/vendor.service');
            const result = await vendorService.verifyAllDocuments(vendorId);
            socket.emit('verify_all_vendor_documents_success', result);
        } catch (error) {
            socket.emit('verification_error', { action: 'verify_all_vendor_documents', message: error.message });
        }
    });
};

module.exports = { registerVerificationHandlers };
