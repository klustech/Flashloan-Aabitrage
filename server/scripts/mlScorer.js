const axios = require("axios");

module.exports = async function score(features) {
  try {
    const { data } = await axios.post(process.env.ML_MODEL_ENDPOINT, {
      features,
    });
    return data.probabilities;
  } catch (err) {
    console.error(`ML scorer error: ${err.message}`);
    return features.map(() => 0); // fallback zero probability
  }
};
