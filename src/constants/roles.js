const ROLES = {
  USER: 'user',
  VENDOR: 'vendor',
  SUB_ADMIN: 'sub_admin',
  ADMIN: 'admin',
  SUPER_ADMIN: 'super_admin',
};

const ROLE_HIERARCHY = {
  [ROLES.USER]: 1,
  [ROLES.VENDOR]: 2,
  [ROLES.SUB_ADMIN]: 3,
  [ROLES.ADMIN]: 4,
  [ROLES.SUPER_ADMIN]: 5,
};

module.exports = {
  ROLES,
  ROLE_HIERARCHY,
};

