/**
 * server/scripts/slackUtils.js
 *
 * Sends Slack alerts using an Incoming Webhook. If no webhook URL is set via
 * the SLACK_WEBHOOK_URL environment variable, messages are printed to stdout so
 * development environments continue to function.
 */

const fetch = require("node-fetch");

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

async function sendSlackAlert(message) {
  if (!SLACK_WEBHOOK_URL) {
    console.log(`Slack alert: ${message}`);
    return;
  }
  try {
    const res = await fetch(SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message }),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`Slack alert failed: ${res.status} ${text}`);
    }
  } catch (err) {
    console.error("Slack alert error:", err);
  }
}

module.exports = { sendSlackAlert };
