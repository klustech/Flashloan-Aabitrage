import pandas as pd
import lightgbm as lgb
import numpy as np
from pathlib import Path

DATA_PATH = Path(__file__).with_name("ml_training_data.csv")
MODEL_PATH = Path(__file__).with_name("lightgbm_model.txt")

def main():
    df = pd.read_csv(DATA_PATH)

    # additional feature engineering
    df["log_liquidity"] = (df["liquidity_usd"] + 1).apply(np.log)
    df["profit_over_liq"] = df["profit_usd"] / df["liquidity_usd"].replace(0, 1)

    features = df[
        [
            "route_length",
            "liquidity_usd",
            "log_liquidity",
            "z_score",
            "profit_usd",
            "profit_over_liq",
        ]
    ]
    labels = df["is_profitable"]

    train_data = lgb.Dataset(features, label=labels)
    params = {
        "objective": "binary",
        "metric": "auc",
        "learning_rate": 0.05,
        "num_leaves": 31,
        "verbose": -1,
        "seed": 42,
    }

    booster = lgb.train(params, train_data)
    booster.save_model(str(MODEL_PATH))
    print(f"Model saved to {MODEL_PATH}")

if __name__ == "__main__":
    main()
