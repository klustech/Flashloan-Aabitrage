// scripts/retry.js

/**
 * Executes a function with retries and exponential backoff.
 * Handles 429 Too Many Requests and other transient errors.
 *
 * @param {Function} fn - The asynchronous function to execute.
 * @param {number} retries - Number of retry attempts.
 * @param {number} delay - Initial delay in milliseconds.
 * @returns {Promise<*>} - The result of the function if successful.
 */
async function executeWithRetry(fn, retries = 5, delay = 1000) {
    try {
        return await fn();
    } catch (error) {
        if (retries > 0) {
            if (error.code === 429) { // Rate limiting
                console.warn(`Rate limited. Retrying in ${delay}ms...`);
                await new Promise(res => setTimeout(res, delay));
                return executeWithRetry(fn, retries - 1, delay * 2);
            } else if (
                error.code === 'ECONNRESET' ||
                error.code === 'ETIMEDOUT' ||
                error.code === 'SERVER_ERROR'
            ) {
                console.warn(`Transient error (${error.code}). Retrying in ${delay}ms...`);
                await new Promise(res => setTimeout(res, delay));
                return executeWithRetry(fn, retries - 1, delay * 2);
            } else {
                console.error(`Error: ${error.message}. Retries left: ${retries}`);
                await new Promise(res => setTimeout(res, delay));
                return executeWithRetry(fn, retries - 1, delay * 2);
            }
        } else {
            console.error(`All retry attempts failed. Error: ${error.message}`);
            throw error;
        }
    }
}

module.exports = { executeWithRetry };

