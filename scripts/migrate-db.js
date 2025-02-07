// scripts/migrate-db.js

const sqlite3 = require('sqlite3').verbose();
const { getSettings } = require('./settings');
const { logMessage } = require('./logging');

function migrateDatabase() {
  const DATABASE_PATH = getSettings().DATABASE_PATH;
  if (!DATABASE_PATH) {
    console.error("DATABASE_PATH is not defined.");
    process.exit(1);
  }

  const db = new sqlite3.Database(DATABASE_PATH, (err) => {
    if (err) {
      console.error("Error opening database:", err.message);
      process.exit(1);
    }
    logMessage('Connected to trades DB for migration.', {}, 'info');
  });

  db.serialize(() => {
    db.all("PRAGMA table_info(trades)", [], (err, columns) => {
      if (err) {
        console.error("Error retrieving table info:", err.message);
        process.exit(1);
      }

      const existingColumns = columns.map(col => col.name);
      const migrationQueries = [];

      if (!existingColumns.includes('state')) {
        migrationQueries.push("ALTER TABLE trades ADD COLUMN state TEXT DEFAULT 'Holding'");
      }
      if (!existingColumns.includes('profitThreshold')) {
        migrationQueries.push("ALTER TABLE trades ADD COLUMN profitThreshold REAL");
      }
      if (!existingColumns.includes('stopLossThreshold')) {
        migrationQueries.push("ALTER TABLE trades ADD COLUMN stopLossThreshold REAL");
      }
      if (!existingColumns.includes('buyPriceInETH')) {
        migrationQueries.push("ALTER TABLE trades ADD COLUMN buyPriceInETH TEXT");
      }

      if (migrationQueries.length === 0) {
        console.log("Database schema is up-to-date.");
        db.close();
        process.exit(0);
      } else {
        let completed = 0;
        migrationQueries.forEach(query => {
          console.log("Running migration query:", query);
          db.run(query, (err) => {
            if (err) {
              console.error("Migration error:", err.message);
            } else {
              console.log("Migration query executed successfully.");
            }
            completed++;
            if (completed === migrationQueries.length) {
              console.log("Database migration complete.");
              db.close();
            }
          });
        });
      }
    });
  });
}

migrateDatabase();
