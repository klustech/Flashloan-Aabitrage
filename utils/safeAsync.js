/**
 * Wraps an async function to catch and log errors, returning null on failure.
 * @param {Function} fn - The async function to wrap
 * @param {Object} logger - Logger with warn method (optional)
 * @param {Object} options - Optional configuration
 * @param {*} options.defaultValue - Value to return on error (default: null)
 * @param {boolean} options.rethrow - Whether to rethrow after logging (default: false)
 * @returns {Function} Wrapped async function
 */
function safeAsync(fn, logger, options = {}) {
  const { defaultValue = null, rethrow = false } = options;

  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      if (logger && typeof logger.warn === "function") {
        logger.warn(`safeAsync caught: ${err.message}`);
      }
      if (rethrow) {
        throw err;
      }
      return defaultValue;
    }
  };
}

module.exports = safeAsync;
