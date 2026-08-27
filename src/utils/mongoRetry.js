const isTransientMongoError = (err) => {
  const name = String(err?.name || '');
  const message = String(err?.message || '');
  return (
    name === 'MongoNetworkError' ||
    name === 'MongoServerSelectionError' ||
    name === 'MongoTimeoutError' ||
    name === 'PoolClearedOnNetworkError' ||
    message.includes('server monitor timeout') ||
    message.includes('interrupted due to server monitor') ||
    message.includes('connection timed out') ||
    err?.code === 'ECONNRESET'
  );
};

const withMongoRetry = async (fn, attempts = 3) => {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isTransientMongoError(err) || i === attempts - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, 400 * (i + 1)));
    }
  }
  throw lastError;
};

module.exports = {
  isTransientMongoError,
  withMongoRetry,
};
