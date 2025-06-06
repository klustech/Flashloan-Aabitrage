/**
 * server/mlScorer.js
 *
 * A minimal ML‐scoring stub—always returns 0.0 for each feature vector.
 * This prevents "Cannot find module 'lightgbm-node'" errors.
 */

const express = require("express");
const bodyParser = require("body-parser");

const ML_PORT = process.env.ML_PORT || 4000;
const app = express();
app.use(bodyParser.json());

app.post("/score", (req, res) => {
  const features = req.body.features || [];
  // Return 0.0 for each feature vector
  const probabilities = features.map(() => 0.0);
  res.json({ probabilities });
});

app.listen(ML_PORT, () => {
  console.log(`⚙️  ML service (stub) listening on port ${ML_PORT}`);
});
