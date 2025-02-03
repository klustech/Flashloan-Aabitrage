// scripts/database.js

const sqlite3 = require('sqlite3').verbose();
const { logMessage } = require('./logging');
const { getSettings } = require('./settings');

let db;

function initDatabase() {
    if (db) {
        logMessage('Database already initialized.', {}, 'info');
        return db;
    }

    const DATABASE_PATH = getSettings().DATABASE_PATH;
    if (!DATABASE_PATH) {
        logMessage('DATABASE_PATH not defined.', {}, 'error');
        throw new Error('DATABASE_PATH is required.');
    }

    db = new sqlite3.Database(DATABASE_PATH, (err) => {
        if (err) {
            logMessage(`DB error: ${err.message}`, {}, 'error');
            process.exit(1);
        }
        logMessage('Connected to trades DB.', {}, 'info');

        // Create trades table with additional columns for dynamic TP/SL adjustments.
        db.run(`
            CREATE TABLE IF NOT EXISTS trades (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                tokenAddress TEXT NOT NULL,
                pairAddress TEXT,
                amountIn TEXT NOT NULL,
                txHash TEXT NOT NULL,
                type TEXT NOT NULL,
                profitThreshold REAL,
                stopLossThreshold REAL
            )
        `, (err2) => {
            if (err2) {
                logMessage(`Error creating trades table: ${err2.message}`, {}, 'error');
                process.exit(1);
            }
            logMessage('Trades table ready.', {}, 'info');
        });
    });

    return db;
}

function insertTrade(trade) {
    return new Promise((resolve, reject) => {
        const { timestamp, tokenAddress, pairAddress, amountIn, txHash, type, profitThreshold, stopLossThreshold } = trade;
        if (!db) {
            logMessage('DB not initialized.', {}, 'error');
            return reject(new Error('DB not ready.'));
        }

        db.run(`
            INSERT INTO trades (timestamp, tokenAddress, pairAddress, amountIn, txHash, type, profitThreshold, stopLossThreshold)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [timestamp, tokenAddress, pairAddress || '', amountIn, txHash, type, profitThreshold || null, stopLossThreshold || null], function (err) {
            if (err) {
                logMessage(`Insert trade fail: ${err.message}`, {}, 'error');
                return reject(err);
            }
            logMessage(`Trade inserted (ID: ${this.lastID}).`, {}, 'info');
            resolve();
        });
    });
}

function getAllTrades(limit = 100) {
    return new Promise((resolve, reject) => {
        if (!db) {
            logMessage('DB not initialized.', {}, 'error');
            return reject(new Error('DB not ready.'));
        }

        db.all(`
            SELECT * FROM trades
            ORDER BY id DESC
            LIMIT ?
        `, [limit], (err, rows) => {
            if (err) {
                logMessage(`Fetch trades fail: ${err.message}`, {}, 'error');
                return reject(err);
            }
            resolve(rows);
        });
    });
}

/**
 * Updates an existing trade with new dynamic TP/SL values.
 * @param {number} tradeId - The ID of the trade to update.
 * @param {Object} updates - Object with keys: profitThreshold, stopLossThreshold.
 */
function updateTrade(tradeId, updates) {
    return new Promise((resolve, reject) => {
        if (!db) {
            logMessage('DB not initialized.', {}, 'error');
            return reject(new Error('DB not ready.'));
        }

        const { profitThreshold, stopLossThreshold } = updates;
        db.run(`
            UPDATE trades
            SET profitThreshold = ?,
                stopLossThreshold = ?
            WHERE id = ?
        `, [profitThreshold, stopLossThreshold, tradeId], function (err) {
            if (err) {
                logMessage(`Update trade fail: ${err.message}`, {}, 'error');
                return reject(err);
            }
            logMessage(`Trade ${tradeId} updated (Rows affected: ${this.changes}).`, {}, 'info');
            resolve();
        });
    });
}

function closeDatabase() {
    if (db) {
        db.close((err) => {
            if (err) {
                logMessage(`Close DB error: ${err.message}`, {}, 'error');
            } else {
                logMessage('DB closed.', {}, 'info');
            }
        });
        db = null;
    } else {
        logMessage('DB already closed.', {}, 'info');
    }
}

module.exports = {
    initDatabase,
    insertTrade,
    getAllTrades,
    updateTrade,
    closeDatabase,
};
