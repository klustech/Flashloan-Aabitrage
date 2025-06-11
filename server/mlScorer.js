/**
 * server/mlScorer.js
 *
 * Simple logistic regression scoring service. Weights are read from a JSON file
 * defined by ML_WEIGHTS_FILE or fall back to model_weights.json in this
 * directory.
 */

const fs = require("fs");
const path = require("path");
const express = require("express");
const bodyParser = require("body-parser");

const ML_PORT = process.env.ML_PORT || 4000;
const WEIGHTS_PATH =
  process.env.ML_WEIGHTS_FILE || path.join(__dirname, "model_weights.json");

let bias = 0;
let weights = [];

function loadWeights() {
  try {
    const data = JSON.parse(fs.readFileSync(WEIGHTS_PATH, "utf-8"));
    bias = data.bias || 0;
    weights = Array.isArray(data.weights) ? data.weights : [];
    console.log(`Loaded ML weights from ${WEIGHTS_PATH}`);
  } catch (err) {
    console.warn(
      `Failed to load ML weights from ${WEIGHTS_PATH}, using zeros: ${err.message}`
    );
    bias = 0;
    weights = [];
  }
}

loadWeights();

function logistic(z) {
  return 1 / (1 + Math.exp(-z));
}

const app = express();
app.use(bodyParser.json());

app.post("/score", (req, res) => {
  const features = req.body.features || [];
  const probabilities = features.map((vec) => {
    if (!weights.length) return 0.0;
    const z = weights.reduce((sum, w, i) => sum + w * (vec[i] || 0), bias);
    return logistic(z);
  });
  res.json({ probabilities });
});

app.listen(ML_PORT, () => {
  console.log(`⚙️  ML service listening on port ${ML_PORT}`);
});
