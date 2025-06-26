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

@app.post("/score")
def score():
    feats = request.json["features"]
    probs = booster.predict(feats, raw_score=False)
    return jsonify(probabilities=probs.tolist())

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=4000)
