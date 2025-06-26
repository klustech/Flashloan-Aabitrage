import pandas as pd
import lightgbm as lgb
from pathlib import Path

DATA_PATH = Path(__file__).with_name("ml_training_data.csv")
MODEL_PATH = Path(__file__).with_name("lightgbm_model.txt")

def main():
    df = pd.read_csv(DATA_PATH)
    features = df[["route_length", "liquidity_usd", "z_score", "profit_usd"]]
    labels = df["is_profitable"]

    train_data = lgb.Dataset(features, label=labels)
    params = {
        "objective": "binary",
        "metric": "auc",
        "learning_rate": 0.05,
        "num_leaves": 31,
        "verbose": -1,
    }

    booster = lgb.train(params, train_data)
    booster.save_model(str(MODEL_PATH))
    print(f"Model saved to {MODEL_PATH}")

if __name__ == "__main__":
    main()
