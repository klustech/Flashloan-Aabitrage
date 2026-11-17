// Exit after a fatal process-level error.
//
// Node terminates on an uncaught exception or unhandled rejection unless a
// listener is installed. server/scripts/server.js and server/botLogic.js install
// listeners to log and alert, which on their own would keep the process running
// in an unknown state. They call this afterwards to restore the exit.
//
// Exiting fails closed: trading state is held in memory and a restarted process
// starts STOPPED (or PAPER), never LIVE, and systemd restarts the service
// (ops/systemd, Restart=on-failure). The short delay lets the log transports and
// the alert flush. Under NODE_ENV=test the test runner owns the process, so the
// listeners only log, as before.
function createFatalExit({
  env = process.env,
  exit = (code) => process.exit(code),
  delayMs = 1000,
} = {}) {
  let exiting = false;
  return function exitAfterFatal() {
    if (env.NODE_ENV === "test" || exiting) return false;
    exiting = true;
    process.exitCode = 1;
    setTimeout(() => exit(1), delayMs);
    return true;
  };
}

// One shared instance so a second fatal error does not schedule another exit.
const exitAfterFatal = createFatalExit();

module.exports = { createFatalExit, exitAfterFatal };
