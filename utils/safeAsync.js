function safeAsync(fn, logger) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      if (logger && logger.warn) {
        logger.warn(`safeAsync caught: ${err.message}`);
      }
      return null;
    }
  };
}

module.exports = safeAsync;
