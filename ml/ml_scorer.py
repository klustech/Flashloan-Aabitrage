import json
import logging
import os
import sys
import time
from collections import defaultdict, deque
from pathlib import Path
from threading import Lock
from typing import List

import joblib
from flask import Flask, jsonify, request
from pydantic import BaseModel, ValidationError, validator
from werkzeug.exceptions import BadRequest

MODEL_PATH = Path(__file__).with_name("lightgbm_model.txt")
SHARED_SECRET = os.getenv("SCORER_SHARED_SECRET")
if not SHARED_SECRET:
    raise RuntimeError("SCORER_SHARED_SECRET must be set for authenticated access")

MAX_BATCH_SIZE = int(os.getenv("SCORER_MAX_BATCH_SIZE", "256"))
FEATURE_MIN_VALUE = float(os.getenv("SCORER_FEATURE_MIN", "-1000000"))
FEATURE_MAX_VALUE = float(os.getenv("SCORER_FEATURE_MAX", "1000000"))
RATE_LIMIT_REQUESTS = int(os.getenv("SCORER_RATE_LIMIT_REQUESTS", "60"))
RATE_LIMIT_WINDOW_SECONDS = int(os.getenv("SCORER_RATE_LIMIT_WINDOW", "60"))

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger("ml_scorer")


def log_structured(level: int, message: str, **fields: object) -> None:
    payload = {"message": message, **fields}
    logger.log(level, json.dumps(payload))


booster = None
NUM_FEATURES = 0


def load_model() -> None:
    global booster, NUM_FEATURES
    try:
        if MODEL_PATH.with_suffix(".pkl").exists():
            booster = joblib.load(MODEL_PATH.with_suffix(".pkl"))
        else:
            import lightgbm as lgb

            booster = lgb.Booster(model_file=str(MODEL_PATH))
            joblib.dump(booster, MODEL_PATH.with_suffix(".pkl"))

        try:
            NUM_FEATURES = booster.num_feature()
        except AttributeError:
            NUM_FEATURES = 0

        log_structured(logging.INFO, "model_loaded", num_features=NUM_FEATURES)
    except Exception as exc:  # pragma: no cover - defensive logging
        booster = None
        NUM_FEATURES = 0
        log_structured(
            logging.ERROR,
            "model_load_failed",
            error=str(exc),
            exception_type=exc.__class__.__name__,
        )


load_model()

app = Flask(__name__)


class RateLimiter:
    def __init__(self, max_calls: int, window_seconds: int) -> None:
        self.max_calls = max_calls
        self.window_seconds = window_seconds
        self._calls: defaultdict[str, deque[float]] = defaultdict(deque)
        self._lock = Lock()

    def allow(self, key: str) -> bool:
        now = time.time()
        cutoff = now - self.window_seconds
        with self._lock:
            calls = self._calls[key]
            while calls and calls[0] <= cutoff:
                calls.popleft()
            if len(calls) >= self.max_calls:
                return False
            calls.append(now)
            return True


rate_limiter = RateLimiter(RATE_LIMIT_REQUESTS, RATE_LIMIT_WINDOW_SECONDS)


class ScoreRequest(BaseModel):
    features: List[List[float]]

    @validator("features")
    def validate_features(cls, features: List[List[float]]) -> List[List[float]]:
        if not isinstance(features, list) or not features:
            raise ValueError("features must be a non-empty list of feature vectors")

        if len(features) > MAX_BATCH_SIZE:
            raise ValueError(
                f"batch size {len(features)} exceeds limit of {MAX_BATCH_SIZE} records"
            )

        validated: List[List[float]] = []
        for index, vector in enumerate(features):
            if not isinstance(vector, list) or not vector:
                raise ValueError(f"feature vector {index} must be a non-empty list")

            if NUM_FEATURES and len(vector) != NUM_FEATURES:
                raise ValueError(
                    f"feature vector {index} must contain exactly {NUM_FEATURES} values"
                )

            converted: List[float] = []
            for position, value in enumerate(vector):
                if not isinstance(value, (int, float)):
                    raise ValueError(
                        f"feature {position} in vector {index} must be numeric"
                    )
                numeric_value = float(value)
                if numeric_value < FEATURE_MIN_VALUE or numeric_value > FEATURE_MAX_VALUE:
                    raise ValueError(
                        "feature value out of allowed range "
                        f"[{FEATURE_MIN_VALUE}, {FEATURE_MAX_VALUE}]"
                    )
                converted.append(numeric_value)
            validated.append(converted)

        return validated


def authenticate() -> str:
    provided = request.headers.get("X-Api-Key", "")
    if not provided or not hmac_compare(provided, SHARED_SECRET):
        log_structured(
            logging.WARNING,
            "authentication_failed",
            remote_addr=request.remote_addr,
        )
        raise PermissionError("invalid or missing shared secret")
    return provided


def hmac_compare(value: str, expected: str) -> bool:
    import secrets

    try:
        return secrets.compare_digest(value, expected)
    except Exception:  # pragma: no cover - defensive
        return False


@app.post("/score")
def score():
    try:
        api_key = authenticate()
    except PermissionError as exc:
        return jsonify(error=str(exc)), 401

    if not rate_limiter.allow(api_key or request.remote_addr or "anonymous"):
        log_structured(
            logging.WARNING,
            "rate_limit_exceeded",
            remote_addr=request.remote_addr,
        )
        return jsonify(error="rate limit exceeded"), 429

    if booster is None:
        log_structured(logging.ERROR, "model_unavailable")
        return jsonify(error="model unavailable"), 503

    try:
        payload = request.get_json(force=True)
    except BadRequest:
        return jsonify(error="invalid JSON payload"), 400

    try:
        score_request = ScoreRequest.parse_obj(payload)
    except ValidationError as exc:
        log_structured(
            logging.WARNING,
            "validation_failed",
            errors=exc.errors(),
        )
        return jsonify(error="invalid request", details=exc.errors()), 400
    except ValueError as exc:
        log_structured(logging.WARNING, "validation_failed", error=str(exc))
        return jsonify(error=str(exc)), 400

    try:
        probs = booster.predict(
            score_request.features,
            raw_score=False,
            predict_disable_shape_check=True,
        )
    except Exception as exc:  # pragma: no cover - defensive
        log_structured(
            logging.ERROR,
            "model_inference_failed",
            error=str(exc),
            exception_type=exc.__class__.__name__,
        )
        return jsonify(error="model inference failed"), 503

    return jsonify(probabilities=probs.tolist())


def run() -> None:
    from gunicorn.app.wsgiapp import run as gunicorn_run

    sys.argv = [
        "gunicorn",
        "ml_scorer:app",
        "--bind",
        "0.0.0.0:4000",
        "--workers",
        os.getenv("SCORER_WORKERS", "2"),
        "--worker-class",
        os.getenv("SCORER_WORKER_CLASS", "sync"),
    ]
    gunicorn_run()


if __name__ == "__main__":
    run()
