// ml/trainModel.js

const fs = require("fs");
const path = require("path");
const lgb = require("lightgbm-node");
const csvParse = require("csv-parse/lib/sync");

// Path to the CSV file (must contain header row):
const DATA_PATH = path.join(__dirname, "ml_training_data.csv");

// Read and parse the CSV:
const fileContent = fs.readFileSync(DATA_PATH, "utf-8");
const records = csvParse(fileContent, {
  columns: true,
  skip_empty_lines: true,
});

// Expected CSV columns: route_length, liquidity_usd, z_score, profit_usd, is_profitable
// Convert each row into feature array + label:
const features = [];
const labels = [];
for (const row of records) {
  // parseFloat for numeric fields
  const routeLength = parseFloat(row.route_length);
  const liquidityUsd = parseFloat(row.liquidity_usd);
  const zScore = parseFloat(row.z_score);
  const profitUsd = parseFloat(row.profit_usd);
  const isProfitable = parseInt(row.is_profitable, 10);

  // Push feature vector in the exact order:
  features.push([routeLength, liquidityUsd, zScore, profitUsd]);
  labels.push(isProfitable);
}

// LightGBM training parameters:
const trainData = {
  data: features,
  label: labels,
  params: {
    objective: "binary",
    metric: "auc",
    boosting: "gbdt",
    num_leaves: 31,
    learning_rate: 0.05,
    verbose: -1,
  },
};

// Train and save the model:
lgb.train(trainData, (err, booster) => {
  if (err) {
    console.error("Error during LightGBM training:", err);
    process.exit(1);
  }
  const outputPath = path.join(__dirname, "lightgbm_model.txt");
  booster.saveModel(outputPath, (saveErr) => {
    if (saveErr) {
      console.error("Failed to save model:", saveErr);
      process.exit(1);
    }
    console.log(`Model trained and saved to ${outputPath}`);
  });
});
