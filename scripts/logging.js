// scripts/logging.js

const fs = require('fs');
const path = require('path');

let settings;
const excludedMessages = [
    'WebSocket ping sent',
    'Attempting to reconnect',
    'WebSocket connection established',
    'WS Provider initialized',
];

/**
 * Logs to console and a file.
 */
function logMessage(message, data = {}, level = 'info') {
    try {
        if (!settings) {
            settings = require('./settings').getSettings();
        }

        if (excludedMessages.some((excluded) => message.includes(excluded))) {
            return;
        }

        const timestamp = new Date().toISOString();
        const logEntry = { timestamp, level, message, data };

        // Console
        switch (level) {
            case 'info':
                console.log(JSON.stringify(logEntry, null, 2));
                break;
            case 'error':
                console.error(JSON.stringify(logEntry, null, 2));
                break;
            case 'warn':
                console.warn(JSON.stringify(logEntry, null, 2));
                break;
            default:
                console.log(JSON.stringify(logEntry, null, 2));
        }

        // File
        const logFilePath = typeof settings.LOG_FILE === 'string'
            ? path.resolve(settings.LOG_FILE)
            : path.resolve('./logs/default.log');

        const logDir = path.dirname(logFilePath);
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }

        fs.appendFile(logFilePath, JSON.stringify(logEntry) + '\n', (err) => {
            if (err) {
                console.error(`Failed writing log: ${err.message}`);
            }
        });
    } catch (err) {
        console.error('Critical log error:', err.message, { message, data, level });
    }
}

function getLogs(limit = 100) {
    try {
        if (!settings) {
            settings = require('./settings').getSettings();
        }
        if (typeof settings.LOG_FILE !== 'string') {
            throw new Error('LOG_FILE not configured.');
        }

        const logFilePath = path.resolve(settings.LOG_FILE);
        if (!fs.existsSync(logFilePath)) {
            return [];
        }

        const logData = fs.readFileSync(logFilePath, 'utf-8');
        const logs = logData.split('\n')
            .filter((line) => line.trim() !== '')
            .map((line) => JSON.parse(line));

        return logs.slice(-limit).reverse();
    } catch (err) {
        console.error(`getLogs error: ${err.message}`);
        return [];
    }
}

function clearLogs() {
    try {
        if (!settings) {
            settings = require('./settings').getSettings();
        }
        if (typeof settings.LOG_FILE !== 'string') {
            throw new Error('LOG_FILE not configured.');
        }

        const logFilePath = path.resolve(settings.LOG_FILE);
        if (fs.existsSync(logFilePath)) {
            fs.truncateSync(logFilePath, 0);
            console.log('Log file cleared.');
        } else {
            console.warn('Log file not found.');
        }
    } catch (err) {
        console.error(`clearLogs error: ${err.message}`);
    }
}

function configureExclusions(newExclusions) {
    if (Array.isArray(newExclusions)) {
        excludedMessages.splice(0, excludedMessages.length, ...newExclusions);
    } else {
        console.warn('Invalid exclusions array.');
    }
}

module.exports = {
    logMessage,
    getLogs,
    clearLogs,
    configureExclusions,
};
