---
title: "End-to-end MLOps: from notebook to monitored model"
description: "Data, training with MLflow and aliases, gated promotion, serving, drift with Evidently and orchestration with Airflow 3, anchored in a real churn project."
slug: "mlops-de-ponta-a-ponta"
theme: "mlops"
order: 1
cover: ""
replaces: ["mlops-deployment", "model-monitoring", "data-pipelines-ml"]
---

A model that works in a notebook is the easy part. Putting it into production in a way that is reproducible, monitored and operable by someone else is what we call MLOps, and that gap is where a lot of ML projects quietly die.

To keep this concrete, I will anchor it in one of my projects, `churn-prediction-mlops`: predicting bank customer churn on the public *Churn Modelling* dataset (10,000 customers, available on Kaggle). To be honest about where it stands: today the project has the exploratory analysis, the folder structure and the stack choice (XGBoost, SHAP, MLflow, Streamlit). The next steps listed in its README are exactly drift monitoring, experiment tracking, CI/CD, automated retraining and containerized deployment. This article is the end-to-end design for those steps. The training, promotion, serving and drift code below was run against the public dataset.

## What the exploratory analysis already decides

EDA is not a decorative step before the "serious part". Several engineering decisions come out of it:

- **Imbalance.** 20.37% of customers churned. Accuracy becomes misleading (a model that says "nobody leaves" is right almost 80% of the time). That is why the quality gate uses PR-AUC and recall on the churn class, and training compensates for imbalance with `scale_pos_weight`.
- **Identifiers out.** `RowNumber`, `CustomerId` and `Surname` carry no signal, and the surname is personal data. They are dropped before training, and the serving API does not even accept them.
- **Non-linear relationships.** The churn rate by number of products is 27.7% with one product, 7.6% with two, 82.7% with three and 100% with four. Tree models handle this without manual feature engineering.
- **Strong and weak signals.** The mean age of customers who left is 44.8, against 37.4 for those who stayed; inactive customers churn at 26.9%, against 14.3% for active ones. Credit card ownership, estimated salary and tenure barely separate the classes. That guides monitoring: drift in age and activity matters more than drift in salary.

## Data: reproducible and idempotent

A model is only as reliable as the pipeline that feeds it. Three properties I require:

**Layers.** Raw data stored exactly as it arrived and never modified (`data/raw`), cleaned and validated data (`data/processed`), and features ready for the model. If the source sends something wrong, you can reprocess from raw after the fix. It is the medallion idea (bronze, silver, gold) at project scale.

**Idempotency.** Running the same step twice for the same period produces the same result. In batch, that means overwriting the period's partition instead of appending; in Delta Lake or Iceberg that overwrite is atomic. The classic failure mode is a pipeline that appends: a run fails halfway, the rerun adds to whatever was left, and weeks later the training set has duplicate records nobody knows about.

**A contract at the entrance.** Before training or scoring, validate schema and ranges. Most of the time, a model degrading in production is not drift: it is a column that started arriving null, or a join that stopped matching.

```python
import pandas as pd

EXPECTED = {
    "CreditScore": (300, 900), "Age": (18, 100), "Tenure": (0, 10),
    "Balance": (0, None), "NumOfProducts": (1, 4), "EstimatedSalary": (0, None),
}
CATEGORIES = {"Geography": {"France", "Spain", "Germany"}, "Gender": {"Male", "Female"}}


def validate(df: pd.DataFrame) -> None:
    errors = []
    for column, (low, high) in EXPECTED.items():
        if df[column].isna().any():
            errors.append(f"{column}: null values")
        if low is not None and (df[column] < low).any():
            errors.append(f"{column}: below {low}")
        if high is not None and (df[column] > high).any():
            errors.append(f"{column}: above {high}")
    for column, allowed in CATEGORIES.items():
        unexpected = set(df[column].dropna().unique()) - allowed
        if unexpected:
            errors.append(f"{column}: unexpected categories {sorted(unexpected)}")
    if errors:
        raise ValueError("Data contract violated: " + "; ".join(errors))
```

Tools such as Great Expectations, Pandera or dbt tests do this more thoroughly. What matters is that a failure stops the pipeline instead of becoming a warning in a log.

One limitation of the public dataset worth stating: it is a snapshot, with no dates. With real data, every feature has to be computed *as it was at prediction time* (point-in-time correctness). Using today's balance to predict a churn from three months ago leaks the future into training, and it is one of the most expensive and silent bugs in ML.

## Training with preprocessing inside the model

The most common mistake on the way to production is packaging only the estimator and redoing preprocessing in the calling service. Over time, the notebook's encoding and the API's encoding drift apart (*training-serving skew*). The fix is to register the whole pipeline as a single artifact.

```python
import os

import kagglehub
import mlflow
import pandas as pd
from mlflow import MlflowClient
from sklearn.compose import ColumnTransformer
from sklearn.metrics import average_precision_score, recall_score, roc_auc_score
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder
from xgboost import XGBClassifier

MODEL_NAME = "churn-classifier"
TARGET = "Exited"
DROP = ["RowNumber", "CustomerId", "Surname"]
CATEGORICAL = ["Geography", "Gender"]
NUMERICAL = ["CreditScore", "Age", "Tenure", "Balance", "NumOfProducts",
             "HasCrCard", "IsActiveMember", "EstimatedSalary"]


def load_data() -> pd.DataFrame:
    path = kagglehub.dataset_download("anandshaw2001/customer-churn-dataset")
    return pd.read_csv(os.path.join(path, "Churn_Modelling.csv")).drop(columns=DROP)


def build_pipeline(scale_pos_weight: float) -> Pipeline:
    preprocess = ColumnTransformer([
        ("cat", OneHotEncoder(handle_unknown="ignore"), CATEGORICAL),
        ("num", "passthrough", NUMERICAL),
    ])
    model = XGBClassifier(n_estimators=300, max_depth=4, learning_rate=0.05,
                          scale_pos_weight=scale_pos_weight, eval_metric="aucpr")
    return Pipeline([("preprocess", preprocess), ("model", model)])


def main() -> None:
    df = load_data()
    X, y = df.drop(columns=[TARGET]), df[TARGET]
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, stratify=y, random_state=42)

    mlflow.set_experiment("churn-prediction")
    with mlflow.start_run():
        spw = float((y_train == 0).sum() / (y_train == 1).sum())
        pipeline = build_pipeline(spw)
        pipeline.fit(X_train, y_train)

        proba = pipeline.predict_proba(X_test)[:, 1]
        mlflow.log_params({"scale_pos_weight": round(spw, 3), "max_depth": 4, "n_estimators": 300})
        mlflow.log_metrics({
            "roc_auc": roc_auc_score(y_test, proba),
            "pr_auc": average_precision_score(y_test, proba),
            "recall_churn": recall_score(y_test, proba >= 0.5),
        })
        info = mlflow.sklearn.log_model(
            pipeline,
            name="model",
            registered_model_name=MODEL_NAME,
            input_example=X_test.head(5),
            skops_trusted_types=["xgboost.core.Booster", "xgboost.sklearn.XGBClassifier"],
        )

    MlflowClient().set_registered_model_alias(MODEL_NAME, "challenger", info.registered_model_version)


if __name__ == "__main__":
    main()
```

With these parameters, a run on the public dataset lands near 0.87 ROC-AUC and 0.71 PR-AUC. The number itself matters less than the fact that it is recorded together with the parameters and the artifact.

Two version details. The code uses MLflow 3, where `log_model` takes `name` instead of the old `artifact_path`; the project's `requirements.txt` still pins 2.15, so upgrading is part of the work. And in recent MLflow 3 releases, scikit-learn models are serialized with skops, which refuses types not declared as trusted; hence `skops_trusted_types`.

## Aliases, not stages

The MLflow model registry used to promote versions through *stages* (Staging, Production, Archived). That mechanism was deprecated in favor of **aliases**: movable names that point to a version. I use two: `challenger` for the freshly trained version and `champion` for the one serving. Promoting means moving the alias, and rolling back means moving it back.

Promotion goes through a gate: the challenger only becomes champion if it wins by a margin, so the model is not swapped over noise.

```python
from mlflow import MlflowClient
from mlflow.exceptions import MlflowException

MODEL_NAME = "churn-classifier"
MIN_GAIN = 0.005


def pr_auc_of(client: MlflowClient, alias: str) -> float | None:
    try:
        version = client.get_model_version_by_alias(MODEL_NAME, alias)
    except MlflowException:
        return None
    return client.get_run(version.run_id).data.metrics["pr_auc"]


def promote_if_better() -> bool:
    client = MlflowClient()
    challenger = pr_auc_of(client, "challenger")
    champion = pr_auc_of(client, "champion")
    if challenger is None:
        raise RuntimeError("No version has the 'challenger' alias.")
    if champion is not None and challenger < champion + MIN_GAIN:
        return False
    version = client.get_model_version_by_alias(MODEL_NAME, "challenger").version
    client.set_registered_model_alias(MODEL_NAME, "champion", version)
    return True
```

Comparing a single aggregate metric is the minimum. Before trusting the gate in production, I would add per-segment comparison (country, age band), because a model can improve on average and get worse precisely in the group that matters most.

## Serving: batch before online

For churn, the business question is almost always "who should we reach out to this week?". That is **batch scoring**: running the model over the customer base on a schedule and handing a ranked list to the retention team. It is cheaper, simpler to operate and easier to audit than an API. Online inference, with low latency and horizontal scaling, makes sense when the decision happens during an interaction, like making an offer while a customer is asking to close the account.

If you do go online, the API loads the champion by alias and validates input with the same contract as training:

```python
from typing import Literal

import mlflow
import pandas as pd
from fastapi import FastAPI
from pydantic import BaseModel, Field

MODEL_NAME = "churn-classifier"

app = FastAPI()
model = mlflow.sklearn.load_model(f"models:/{MODEL_NAME}@champion")
model_version = mlflow.MlflowClient().get_model_version_by_alias(MODEL_NAME, "champion").version


class Customer(BaseModel):
    CreditScore: int = Field(ge=300, le=900)
    Geography: Literal["France", "Spain", "Germany"]
    Gender: Literal["Male", "Female"]
    Age: int = Field(ge=18, le=100)
    Tenure: int = Field(ge=0, le=10)
    Balance: float = Field(ge=0)
    NumOfProducts: int = Field(ge=1, le=4)
    HasCrCard: Literal[0, 1]
    IsActiveMember: Literal[0, 1]
    EstimatedSalary: float = Field(ge=0)


@app.post("/predict")
def predict(customer: Customer) -> dict:
    features = pd.DataFrame([customer.model_dump()])
    probability = float(model.predict_proba(features)[0, 1])
    return {"churn_probability": round(probability, 4), "model_version": model_version}
```

Every response carries the model version; without it, investigating an odd prediction becomes guesswork. A country outside the list gets 422 before it reaches the model. For deployment there is a choice: load the model from the registry at startup (the container depends on MLflow being up) or download the artifact at image build time and tag the image with the model version. I prefer the second, because rollback becomes swapping an image, like any other service.

For risky new versions, *shadow mode* is the safest strategy: the challenger receives the same traffic, but its predictions are only logged, for comparison with the champion on real data.

## Monitoring in four layers

A model in production degrades without throwing exceptions. I monitor in layers, from cheapest to most expensive:

1. **Infrastructure**: latency, errors, prediction volume. A sudden drop in volume is usually a failure in the upstream pipeline.
2. **Data quality**: the same entrance contract, now measured continuously (null rates, out-of-range values).
3. **Feature drift**: the current distribution compared with a reference (the training set or a recent stable window).
4. **Model performance**: the real metrics, once labels arrive.

For drift I use Evidently. The current API works with `Dataset`, `DataDefinition` and presets:

```python
import pandas as pd
from evidently import DataDefinition, Dataset, Report
from evidently.presets import DataDriftPreset

SCHEMA = DataDefinition(
    numerical_columns=["CreditScore", "Age", "Tenure", "Balance", "NumOfProducts", "EstimatedSalary"],
    categorical_columns=["Geography", "Gender", "HasCrCard", "IsActiveMember"],
)


def drift_summary(reference: pd.DataFrame, current: pd.DataFrame) -> dict:
    report = Report([DataDriftPreset(drift_share=0.3)])
    result = report.run(
        current_data=Dataset.from_pandas(current, data_definition=SCHEMA),
        reference_data=Dataset.from_pandas(reference, data_definition=SCHEMA),
    )
    result.save_html("drift_report.html")

    summary = {"drifted_share": 0.0, "columns": {}}
    for metric in result.dict()["metrics"]:
        config = metric["config"]
        if config["type"].endswith("DriftedColumnsCount"):
            summary["drifted_share"] = float(metric["value"]["share"])
        elif config["type"].endswith("ValueDrift"):
            summary["columns"][config["column"]] = {
                "score": float(metric["value"]),
                "drifted": bool(metric["value"] >= config["threshold"]),
                "method": config["method"],
            }
    return summary
```

Evidently picks the statistical test based on column type and sample size; on large samples it uses normalized Wasserstein distance for numerical columns and Jensen-Shannon distance for categorical ones. It is also worth knowing PSI (*Population Stability Index*), common in credit, and the Kolmogorov-Smirnov test for smaller samples.

The most churn-specific issue is **label delay**. You only know whether a customer left weeks or months after the prediction. Meanwhile, the available signals are indirect: the distribution of predicted probabilities (a shift there often precedes a loss in performance), drift in the features the EDA showed to be strong (age, activity, number of products), and the business metrics of the retention campaign. When labels arrive, compare real performance with the training performance.

Tiered alerts prevent fatigue: a warning when drift appears, a critical alert when it persists across several runs or hits the strong features.

## Orchestration with Airflow 3

The weekly cycle (score, measure drift, retrain if needed, promote if better) becomes a DAG. In Airflow 3, the authoring API lives in `airflow.sdk`, `schedule` replaces `schedule_interval`, and `days_ago` is gone:

```python
from datetime import timedelta

import pendulum
from airflow.sdk import dag, task


@dag(
    schedule="@weekly",
    start_date=pendulum.datetime(2026, 1, 1, tz="UTC"),
    catchup=False,
    max_active_runs=1,
    default_args={"retries": 2, "retry_delay": timedelta(minutes=10)},
    tags=["churn"],
)
def churn_weekly():
    @task
    def score_customers(ds: str | None = None) -> str:
        from churn.batch import score_snapshot
        return score_snapshot(ds)  # overwrites data/scores/ds=<ds>/ and returns the path

    @task
    def measure_drift(scores_path: str) -> float:
        from churn.monitoring import drift_for
        return drift_for(scores_path)["drifted_share"]

    @task.short_circuit
    def drift_is_significant(share: float) -> bool:
        return share >= 0.3

    @task
    def retrain() -> None:
        from churn.train import main
        main()

    @task
    def promote() -> bool:
        from churn.promote import promote_if_better
        return promote_if_better()

    share = measure_drift(score_customers())
    drift_is_significant(share) >> retrain() >> promote()


churn_weekly()
```

Passing the logical date (`ds`) to each task makes every run a function of its inputs: you can reprocess an old week without side effects on the others. `short_circuit` skips retraining when drift is small, and `max_active_runs=1` prevents overlapping runs. Retraining on a fixed schedule is simple but wastes resources; retraining on persistent drift, with promotion behind the gate, is the balance I aim for.

## What remains

The technical side of MLOps is ordinary software engineering: versioning, tests, contracts, reproducible deployment, observability. What changes is that data is code too, and that the system can get worse without a single line changing. In `churn-prediction-mlops`, the order I follow is the order of this piece: data contract, tracked training with preprocessing inside the artifact, gated promotion with aliases, batch scoring, drift monitoring and, last, the orchestration that ties it all together.
