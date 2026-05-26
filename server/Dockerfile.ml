# NOTE: Build this image from the REPOSITORY ROOT context (docker build -f
# server/Dockerfile.ml .) because the ML sources live in /ml at the repo root,
# not under /server. The CI workflows set `context: .` accordingly.
FROM python:3.10-slim

WORKDIR /usr/src/app

# Install runtime dependencies. This image serves the scorer AND is reused by the
# k8s ml-training CronJob to run train_model.py, so install the full ML
# requirement set (pandas/numpy/scikit-learn/psycopg2/lightgbm) plus the scorer's
# flask/gunicorn/joblib/pydantic.
COPY ml/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt joblib pydantic

# Copy scorer, training script and model (repo-root-relative paths).
COPY ml/ml_scorer.py ./ml_scorer.py
COPY ml/train_model.py ./train_model.py
COPY ml/lightgbm_model.txt ./lightgbm_model.txt

# Standardize the ML service port on 3002 (matches k8s ml-deployment + Service).
# ml_scorer.py's __main__ hard-codes gunicorn to :4000, so we launch gunicorn
# directly here and bind it to 3002 instead.
ENV SCORER_PORT=3002
EXPOSE 3002

# Run as a non-root user.
RUN useradd --create-home --uid 10001 appuser
USER appuser

CMD ["gunicorn", "ml_scorer:app", "--bind", "0.0.0.0:3002", "--workers", "2"]
