const axios = require("axios");

module.exports = async function score(features) {
  const { data } = await axios.post(process.env.ML_MODEL_ENDPOINT, {
    features,
  });
  return data.probabilities;
};
