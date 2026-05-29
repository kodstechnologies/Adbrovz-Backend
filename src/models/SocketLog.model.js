const mongoose = require('mongoose');

const socketLogSchema = new mongoose.Schema({
  socketId: { type: String, required: true },
  vendorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', default: null },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  event: { type: String, required: true, enum: ['connect', 'disconnect', 'connection_error', 'engine_error'] },
  reason: { type: String },
  timestamp: { type: Date, default: Date.now }
});

socketLogSchema.index({ socketId: 1, timestamp: -1 });

module.exports = mongoose.model('SocketLog', socketLogSchema);
