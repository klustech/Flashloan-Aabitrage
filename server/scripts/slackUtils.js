/**
 * server/scripts/slackUtils.js
 *
 * Stub for sending Slack alerts. In production, replace this
 * with real webhook logic. For now, it simply logs the message.
 */

async function sendSlackAlert(message) {
  // In production, you’d POST to your Slack webhook URL here.
  console.log(`Slack alert: ${message}`);
}

module.exports = { sendSlackAlert };
