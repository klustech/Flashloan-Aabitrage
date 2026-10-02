function abortError(reason = 'Scan superseded or budget expired') {
  const error = new Error(reason);
  error.name = 'AbortError';
  return error;
}
function checkSignal(signal) {
  if (signal?.aborted) throw abortError();
}
function abortable(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function mapLimit(items, limit, fn, signal) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      checkSignal(signal);
      const index = next++;
      results[index] = await abortable(fn(items[index], index), signal);
    }
  }));
  checkSignal(signal);
  return results;
}
module.exports = { abortError, checkSignal, abortable, mapLimit };
