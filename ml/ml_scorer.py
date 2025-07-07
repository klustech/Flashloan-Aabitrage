import joblib, json
from flask import Flask, request, jsonify
from pathlib import Path

MODEL_PATH = Path(__file__).with_name("lightgbm_model.txt")
# ↓ convert the .txt booster into a joblib once so reloads are fast
if MODEL_PATH.with_suffix(".pkl").exists():
    booster = joblib.load(MODEL_PATH.with_suffix(".pkl"))
else:
    import lightgbm as lgb
    booster = lgb.Booster(model_file=str(MODEL_PATH))
    joblib.dump(booster, MODEL_PATH.with_suffix(".pkl"))

app = Flask(__name__)

# Determine how many features the loaded model expects
try:
    NUM_FEATURES = booster.num_feature()
except AttributeError:
    NUM_FEATURES = 0

@app.post("/score")
def score():
    feats = request.json["features"]

    # Ensure each feature vector matches the model's feature count.
    processed = []
    for f in feats:
        if NUM_FEATURES and len(f) != NUM_FEATURES:
            if len(f) > NUM_FEATURES:
                f = f[:NUM_FEATURES]
            else:
                f = f + [0.0] * (NUM_FEATURES - len(f))
        processed.append(f)

    probs = booster.predict(
        processed,
        raw_score=False,
        predict_disable_shape_check=True,
    )
    return jsonify(probabilities=probs.tolist())

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=4000)
