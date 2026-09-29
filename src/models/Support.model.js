const mongoose = require('mongoose');

const supportSchema = new mongoose.Schema({
  phone: {
    type: String,
    required: true,
    trim: true,
  },
});

const Support = mongoose.model('Support', supportSchema);
module.exports = Support;
