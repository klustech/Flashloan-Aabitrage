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

        db.run(`
            CREATE TABLE IF NOT EXISTS trades (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                tokenAddress TEXT NOT NULL,
                pairAddress TEXT,
                amountIn TEXT NOT NULL,
                txHash TEXT NOT NULL,
                type TEXT NOT NULL
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
        const { timestamp, tokenAddress, pairAddress, amountIn, txHash, type } = trade;
        if (!db) {
            logMessage('DB not initialized.', {}, 'error');
            return reject(new Error('DB not ready.'));
        }

        db.run(`
            INSERT INTO trades (timestamp, tokenAddress, pairAddress, amountIn, txHash, type)
            VALUES (?, ?, ?, ?, ?, ?)
        `, [timestamp, tokenAddress, pairAddress || '', amountIn, txHash, type], function (err) {
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
    closeDatabase,
};
