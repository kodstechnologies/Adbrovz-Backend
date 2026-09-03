let io;

const DIAGNOSTICS_EVENTS = new Set([
    'new_booking_request',
    'booking_status_updated',
    'booking_accepted_success',
    'booking_rejected_success',
    'booking_created_success',
    'booking_search_update',
    'booking_cancellation',
    'service_approval_response',
    'service_approval_update',
    'extra_service_approval_update'
]);

const setIo = (ioInstance) => { io = ioInstance; };

const emitToDiagnostics = (event, data) => {
    if (io) {
        io.to('diagnostics').emit(event, data);
        console.log(`📡 [DIAGNOSTICS] Direct broadcast: '${event}'`);
    }
};

module.exports = { emitToDiagnostics, DIAGNOSTICS_EVENTS, setIo };
