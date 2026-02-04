#!/usr/bin/env python3
"""
ml/train_model.py

LightGBM model training pipeline for arbitrage route scoring.
Trains a binary classifier to predict arbitrage success probability.

Usage:
    python train_model.py                          # Use default CSV
    python train_model.py --csv data.csv           # Custom CSV
    python train_model.py --db-url postgres://...  # Load from DB
    python train_model.py --synthetic 10000        # Generate synthetic data
"""

import argparse
import json
import logging
import os
import pickle
import sys
from datetime import datetime
from pathlib import Path
from typing import Optional, Dict, Any

import pandas as pd
import numpy as np

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger('ml_trainer')

# Default paths
DATA_PATH = Path(__file__).with_name("ml_training_data.csv")
MODEL_PATH = Path(__file__).with_name("lightgbm_model.txt")
MODEL_PKL_PATH = Path(__file__).with_name("lightgbm_model.pkl")
METRICS_PATH = Path(__file__).with_name("training_metrics.json")


def load_data_from_db(db_url: str, days: int = 30) -> pd.DataFrame:
    """Load training data from PostgreSQL database."""
    try:
        import psycopg2
        from psycopg2.extras import RealDictCursor
    except ImportError:
        logger.error("psycopg2 not installed. Run: pip install psycopg2-binary")
        sys.exit(1)

    logger.info(f"Loading data from database (last {days} days)")

    conn = psycopg2.connect(db_url)
    cursor = conn.cursor(cursor_factory=RealDictCursor)

    query = """
        SELECT
            route,
            profit,
            status,
            timestamp,
            CASE WHEN status = 'success' AND profit::numeric > 0 THEN 1 ELSE 0 END as is_profitable
        FROM trades
        WHERE timestamp > NOW() - INTERVAL '%s days'
        ORDER BY timestamp DESC
    """

    cursor.execute(query, (days,))
    rows = cursor.fetchall()
    cursor.close()
    conn.close()

    logger.info(f"Loaded {len(rows)} trades from database")
    return extract_features_from_trades(rows)


def extract_features_from_trades(trades: list) -> pd.DataFrame:
    """Extract features from trade records."""
    records = []

    for trade in trades:
        try:
            route = trade.get('route', '{}')
            if isinstance(route, str):
                route = json.loads(route) if route else {}

            hops = route.get('hops', [])
            hop_count = len(hops) if hops else 2

            # Calculate liquidity (minimum across hops)
            liquidities = [h.get('liquidity', h.get('reserveUSD', 100000)) for h in hops]
            liquidity = min(liquidities) if liquidities else 100000

            # Calculate total fees
            fee_bips = sum(h.get('feeBps', h.get('fee', 30)) for h in hops)

            # Check for specific tokens
            tokens = set()
            for h in hops:
                tokens.add(h.get('tokenA', '').lower())
                tokens.add(h.get('tokenB', '').lower())

            weth_addr = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
            dai_addr = '0x6b175474e89094c44da98b954eedeCAE3686f72e'
            usdc_addr = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'

            has_weth = 1 if weth_addr in tokens else 0
            has_stable = 1 if (dai_addr in tokens or usdc_addr in tokens) else 0

            # Check DEX types
            dex_types = [h.get('dex', 'uniswap_v2') for h in hops]
            dex_uniswap = 1 if any('uniswap' in d for d in dex_types) else 0

            # Get profit
            profit = float(trade.get('profit', 0)) if trade.get('profit') else 0

            records.append({
                'route_length': hop_count,
                'liquidity_usd': liquidity,
                'fee_bips': fee_bips,
                'z_score': route.get('zScore', 0),
                'profit_usd': profit,
                'has_weth': has_weth,
                'has_stable': has_stable,
                'dex_uniswap': dex_uniswap,
                'volatility': route.get('volatility', 2.0),
                'gas_cost': route.get('estimatedGasCost', 200000),
                'is_profitable': trade.get('is_profitable', 1 if profit > 0 else 0)
            })

        except Exception as e:
            logger.warning(f"Error parsing trade: {e}")
            continue

    return pd.DataFrame(records)


def generate_synthetic_data(n_samples: int = 10000) -> pd.DataFrame:
    """Generate synthetic training data for initial model."""
    logger.info(f"Generating {n_samples} synthetic training samples")

    np.random.seed(42)

    data = {
        'route_length': np.random.choice([2, 3, 4], n_samples, p=[0.5, 0.35, 0.15]),
        'liquidity_usd': np.random.exponential(500000, n_samples).clip(10000, 10000000),
        'fee_bips': np.random.normal(90, 30, n_samples).clip(30, 300),
        'z_score': np.random.normal(0, 1.5, n_samples),
        'profit_usd': np.random.exponential(5, n_samples).clip(0, 100),
        'has_weth': np.random.choice([0, 1], n_samples, p=[0.3, 0.7]),
        'has_stable': np.random.choice([0, 1], n_samples, p=[0.2, 0.8]),
        'dex_uniswap': np.random.choice([0, 1], n_samples, p=[0.2, 0.8]),
        'volatility': np.random.exponential(2, n_samples).clip(0.1, 15),
        'gas_cost': np.random.normal(200000, 50000, n_samples).clip(100000, 500000),
    }

    df = pd.DataFrame(data)

    # Generate success labels based on feature relationships
    success_prob = (
        0.2 +
        0.15 * (df['liquidity_usd'] / df['liquidity_usd'].max()) +
        0.15 * (1 - (df['route_length'] - 2) / 2) +
        0.1 * (1 - df['volatility'] / df['volatility'].max()) +
        0.1 * (df['z_score'].clip(-2, 2) + 2) / 4 +
        0.1 * df['has_weth'] +
        0.1 * df['has_stable'] +
        0.1 * df['dex_uniswap']
    )
    success_prob = success_prob.clip(0.05, 0.85)
    df['is_profitable'] = (np.random.random(n_samples) < success_prob).astype(int)

    logger.info(f"Generated data with {df['is_profitable'].mean():.2%} success rate")
    return df


def train_model(df: pd.DataFrame) -> tuple:
    """Train LightGBM model with enhanced features."""
    try:
        import lightgbm as lgb
        from sklearn.model_selection import train_test_split
        from sklearn.metrics import roc_auc_score, accuracy_score, precision_score, recall_score
    except ImportError as e:
        logger.error(f"Missing dependency: {e}. Run: pip install lightgbm scikit-learn")
        sys.exit(1)

    logger.info("Preparing features for training")

    # Feature engineering
    df["log_liquidity"] = (df["liquidity_usd"] + 1).apply(np.log)
    df["profit_over_liq"] = df["profit_usd"] / df["liquidity_usd"].replace(0, 1)
    df["fee_pct"] = df["fee_bips"] / 10_000.0

    feature_cols = [
        "route_length",
        "liquidity_usd",
        "log_liquidity",
        "z_score",
        "profit_usd",
        "profit_over_liq",
        "fee_pct",
        "has_weth",
        "has_stable",
        "dex_uniswap",
    ]

    # Add optional columns if present
    optional_cols = ["volatility", "gas_cost"]
    for col in optional_cols:
        if col in df.columns:
            feature_cols.append(col)

    X = df[feature_cols]
    y = df["is_profitable"]

    # Split data
    X_train, X_val, y_train, y_val = train_test_split(
        X, y, test_size=0.2, random_state=42, stratify=y
    )

    logger.info(f"Training: {len(X_train)} samples, Validation: {len(X_val)} samples")

    # Create datasets
    train_data = lgb.Dataset(X_train, label=y_train, feature_name=feature_cols)
    val_data = lgb.Dataset(X_val, label=y_val, feature_name=feature_cols, reference=train_data)

    # Training parameters
    params = {
        "objective": "binary",
        "metric": "auc",
        "boosting_type": "gbdt",
        "learning_rate": 0.05,
        "num_leaves": 31,
        "feature_fraction": 0.8,
        "bagging_fraction": 0.8,
        "bagging_freq": 5,
        "verbose": -1,
        "seed": 42,
        "n_estimators": 100,
    }

    # Train
    booster = lgb.train(
        params,
        train_data,
        valid_sets=[train_data, val_data],
        valid_names=['train', 'valid'],
    )

    # Evaluate
    y_pred_proba = booster.predict(X_val)
    y_pred = (y_pred_proba > 0.5).astype(int)

    metrics = {
        'auc': float(roc_auc_score(y_val, y_pred_proba)),
        'accuracy': float(accuracy_score(y_val, y_pred)),
        'precision': float(precision_score(y_val, y_pred, zero_division=0)),
        'recall': float(recall_score(y_val, y_pred, zero_division=0)),
        'feature_importance': dict(zip(feature_cols, map(float, booster.feature_importance()))),
        'trained_at': datetime.utcnow().isoformat(),
        'train_samples': len(X_train),
        'val_samples': len(X_val),
        'positive_rate': float(y.mean()),
    }

    logger.info(f"Validation AUC: {metrics['auc']:.4f}")
    logger.info(f"Validation Accuracy: {metrics['accuracy']:.4f}")
    logger.info(f"Feature importance: {metrics['feature_importance']}")

    return booster, metrics, feature_cols


def save_model(booster, metrics: dict, feature_cols: list, output_path: Path):
    """Save model in multiple formats."""
    # Save native LightGBM format
    booster.save_model(str(output_path))
    logger.info(f"Model saved to {output_path}")

    # Save pickle format with metadata
    pkl_path = output_path.with_suffix('.pkl')
    with open(pkl_path, 'wb') as f:
        pickle.dump({
            'model': booster,
            'feature_columns': feature_cols,
            'metadata': metrics
        }, f)
    logger.info(f"Model with metadata saved to {pkl_path}")

    # Save metrics
    metrics_path = output_path.with_name('training_metrics.json')
    with open(metrics_path, 'w') as f:
        json.dump(metrics, f, indent=2)
    logger.info(f"Metrics saved to {metrics_path}")


def main():
    parser = argparse.ArgumentParser(description='Train arbitrage route scoring model')
    parser.add_argument('--csv', help='CSV file with training data')
    parser.add_argument('--db-url', help='PostgreSQL connection URL')
    parser.add_argument('--synthetic', type=int, help='Generate N synthetic samples')
    parser.add_argument('--output', default=str(MODEL_PATH), help='Output model path')
    parser.add_argument('--days', type=int, default=30, help='Days of data from DB')

    args = parser.parse_args()

    # Load or generate data
    if args.db_url:
        df = load_data_from_db(args.db_url, args.days)
    elif args.csv:
        df = pd.read_csv(args.csv)
    elif args.synthetic:
        df = generate_synthetic_data(args.synthetic)
    elif DATA_PATH.exists():
        logger.info(f"Using default CSV: {DATA_PATH}")
        df = pd.read_csv(DATA_PATH)
    else:
        logger.info("No data source found, generating synthetic data")
        df = generate_synthetic_data(10000)

    if len(df) < 100:
        logger.error(f"Insufficient data: {len(df)} samples (need 100+)")
        sys.exit(1)

    # Train model
    booster, metrics, feature_cols = train_model(df)

    # Save model
    output_path = Path(args.output)
    save_model(booster, metrics, feature_cols, output_path)

    logger.info("Training complete!")


if __name__ == "__main__":
    main()
