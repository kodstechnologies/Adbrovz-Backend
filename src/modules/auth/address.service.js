const mongoose = require('mongoose');
const Address = require('../../models/address.model');
const User = require('../../models/User.model');
const ApiError = require('../../utils/ApiError');
const MESSAGES = require('../../constants/messages');

const formatAddress = (doc) => ({
  id: doc._id.toString(),
  title: doc.title,
  address: doc.address,
  phoneNo: doc.phoneNo,
  isDefault: doc.isDefault,
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
});

const setDefaultAddress = async (userId, addressId) => {
  await Address.updateMany(
    { user: userId, _id: { $ne: addressId } },
    { $set: { isDefault: false } }
  );
  await Address.findByIdAndUpdate(addressId, { isDefault: true });
};

const getUserAddressOrThrow = async (userId, addressId) => {
  if (!mongoose.Types.ObjectId.isValid(addressId)) {
    throw new ApiError(400, 'Invalid address id');
  }

  const address = await Address.findOne({ _id: addressId, user: userId });
  if (!address) {
    throw new ApiError(404, 'Address not found');
  }

  return address;
};

const addUserAddress = async (userId, payload) => {
  const user = await User.findById(userId);
  if (!user) {
    throw new ApiError(404, MESSAGES.USER.NOT_FOUND);
  }

  const existingCount = await Address.countDocuments({ user: userId });
  const shouldBeDefault = existingCount === 0 || payload.isDefault === true;

  const address = await Address.create({
    user: userId,
    title: payload.title,
    address: payload.address,
    phoneNo: payload.phoneNo,
    isDefault: shouldBeDefault,
  });

  if (shouldBeDefault && existingCount > 0) {
    await setDefaultAddress(userId, address._id);
  }

  user.addresses = user.addresses || [];
  user.addresses.push(address._id);
  await user.save();

  const saved = await Address.findById(address._id);
  return formatAddress(saved);
};

const ensureSingleDefault = async (userId) => {
  const defaults = await Address.find({ user: userId, isDefault: true }).sort({ updatedAt: -1, createdAt: -1 });
  if (defaults.length <= 1) return defaults[0] || null;

  const keep = defaults[0];
  await Address.updateMany(
    { user: userId, _id: { $ne: keep._id } },
    { $set: { isDefault: false } }
  );
  return keep;
};

const getUserAddresses = async (userId, { addressId, defaultAddress = false } = {}) => {
  const user = await User.findById(userId);
  if (!user) {
    throw new ApiError(404, MESSAGES.USER.NOT_FOUND);
  }

  await ensureSingleDefault(userId);

  if (addressId) {
    const address = await getUserAddressOrThrow(userId, addressId);
    return { addresses: [formatAddress(address)] };
  }

  const query = { user: userId };
  if (defaultAddress) {
    query.isDefault = true;
  }

  const rows = await Address.find(query).sort({ isDefault: -1, createdAt: -1 });
  const addresses = rows.map((item) => formatAddress(item));

  return { addresses };
};

const updateUserAddress = async (userId, addressId, payload) => {
  const address = await getUserAddressOrThrow(userId, addressId);

  if (payload.title !== undefined) address.title = payload.title;
  if (payload.address !== undefined) address.address = payload.address;
  if (payload.phoneNo !== undefined) address.phoneNo = payload.phoneNo;

  if (payload.isDefault === true) {
    address.isDefault = true;
    await address.save();
    await setDefaultAddress(userId, address._id);
  } else if (payload.isDefault === false && address.isDefault) {
    const other = await Address.findOne({ user: userId, _id: { $ne: address._id } }).sort({ createdAt: 1 });
    if (other) {
      address.isDefault = false;
      await address.save();
      await setDefaultAddress(userId, other._id);
    } else {
      await address.save();
    }
  } else {
    await address.save();
  }

  const updated = await Address.findById(address._id);
  return formatAddress(updated);
};

const deleteUserAddress = async (userId, addressId) => {
  const address = await getUserAddressOrThrow(userId, addressId);
  const wasDefault = address.isDefault;

  await User.findByIdAndUpdate(userId, { $pull: { addresses: address._id } });
  await Address.findByIdAndDelete(address._id);

  if (wasDefault) {
    const nextDefault = await Address.findOne({ user: userId }).sort({ createdAt: 1 });
    if (nextDefault) {
      await setDefaultAddress(userId, nextDefault._id);
    }
  }

  return { message: 'Address deleted successfully' };
};

module.exports = {
  addUserAddress,
  getUserAddresses,
  updateUserAddress,
  deleteUserAddress,
};
