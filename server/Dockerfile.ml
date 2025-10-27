FROM python:3.10-slim

WORKDIR /usr/src/app

# Install minimal runtime dependencies
RUN pip install --no-cache-dir flask gunicorn joblib lightgbm pydantic

# Copy scorer and model
COPY ml/ml_scorer.py ./ml_scorer.py
COPY ml/lightgbm_model.txt ./lightgbm_model.txt

EXPOSE 4000

CMD ["python", "ml_scorer.py"]
