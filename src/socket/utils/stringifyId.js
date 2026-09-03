const stringifyId = (id) => {
    if (!id) return null;
    if (typeof id === 'string') return id;
    if (typeof id === 'object') {
        if (id._id) return id._id.toString();
        if (id.id) return id.id.toString();
        if (id.userId) return id.userId.toString();
    }
    return id.toString();
};

module.exports = { stringifyId };
