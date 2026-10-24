---
title: "MLOps de ponta a ponta: do notebook ao modelo monitorado"
description: "Dados, treino com MLflow e aliases, promoção por portão, serving, drift com Evidently e orquestração com Airflow 3, ancorado num projeto real de churn."
slug: "mlops-de-ponta-a-ponta"
theme: "mlops"
order: 1
cover: ""
replaces: ["mlops-deployment", "model-monitoring", "data-pipelines-ml"]
---

Um modelo que funciona num notebook é a parte fácil. Colocá-lo em produção de um jeito reproduzível, monitorado e que outra pessoa consiga operar é o que se chama de MLOps, e é nesse intervalo que muito projeto de ML morre em silêncio.

Para não ficar no abstrato, vou ancorar o texto num projeto meu, o `churn-prediction-mlops`: previsão de cancelamento de clientes de banco sobre a base pública *Churn Modelling* (10.000 clientes, disponível no Kaggle). Sendo honesto sobre o estado dele: hoje o projeto tem a análise exploratória, a estrutura de pastas e a escolha da stack (XGBoost, SHAP, MLflow, Streamlit). Os próximos passos listados no README são justamente monitoramento de drift, registro de experimentos, CI/CD, retreino automático e deploy em contêiner. Este artigo é o desenho de ponta a ponta para esses passos. O código de treino, promoção, serving e drift abaixo foi executado contra a base pública.

## O que a análise exploratória já decide

A EDA não é uma etapa decorativa antes da "parte séria". Várias decisões de engenharia saem dela:

- **Desbalanceamento.** 20,37% dos clientes cancelaram. Acurácia vira métrica enganosa (um modelo que diz "ninguém sai" acerta quase 80%). Por isso o portão de qualidade usa PR-AUC e recall da classe de churn, e o treino compensa o desbalanceamento com `scale_pos_weight`.
- **Identificadores fora.** `RowNumber`, `CustomerId` e `Surname` não carregam sinal, e o sobrenome é dado pessoal. Saem antes do treino, e o serving nem os aceita.
- **Relações não lineares.** A taxa de churn por número de produtos é 27,7% com um produto, 7,6% com dois, 82,7% com três e 100% com quatro. Modelos de árvore lidam bem com isso sem engenharia manual.
- **Sinais fortes e fracos.** A idade média de quem saiu é 44,8 anos, contra 37,4 de quem ficou; clientes inativos cancelam 26,9%, contra 14,3% dos ativos. Já cartão de crédito, salário estimado e tempo de casa quase não separam as classes. Isso orienta o monitoramento: drift em idade e atividade importa mais do que drift em salário.

## Dados: reprodutíveis e idempotentes

O modelo é tão confiável quanto o pipeline que entrega os dados. Três propriedades que eu exijo:

**Camadas.** Dados brutos guardados exatamente como chegaram e nunca alterados (`data/raw`), dados limpos e validados (`data/processed`), e as features prontas para o modelo. Se a fonte mandar algo errado, dá para reprocessar a partir do bruto depois da correção. É a ideia da arquitetura medallion (bronze, prata, ouro) em escala de projeto.

**Idempotência.** Rodar o mesmo passo duas vezes para o mesmo período produz o mesmo resultado. Em lote, isso significa sobrescrever a partição do período em vez de acrescentar; no Delta Lake ou no Iceberg essa sobrescrita é atômica. O modo de falha clássico é um pipeline que acrescenta: uma execução falha no meio, a nova execução soma ao que sobrou, e semanas depois o dataset de treino tem registros duplicados sem ninguém saber.

**Contrato na entrada.** Antes de treinar ou pontuar, valide o schema e os intervalos. Na maior parte das vezes, modelo degradado em produção não é drift: é uma coluna que passou a chegar nula, ou um join que parou de casar.

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
            errors.append(f"{column}: valores nulos")
        if low is not None and (df[column] < low).any():
            errors.append(f"{column}: abaixo de {low}")
        if high is not None and (df[column] > high).any():
            errors.append(f"{column}: acima de {high}")
    for column, allowed in CATEGORIES.items():
        unexpected = set(df[column].dropna().unique()) - allowed
        if unexpected:
            errors.append(f"{column}: categorias inesperadas {sorted(unexpected)}")
    if errors:
        raise ValueError("Contrato de dados violado: " + "; ".join(errors))
```

Ferramentas como Great Expectations, Pandera ou testes do dbt fazem isso de forma mais completa. O importante é que a falha pare o pipeline, e não que vire um aviso num log.

Uma limitação da base pública que vale registrar: ela é uma fotografia, sem datas. Com dados reais, cada feature precisa ser calculada *como era no momento da previsão* (correção ponto no tempo). Usar o saldo de hoje para prever um cancelamento de três meses atrás vaza o futuro para o treino, e é um dos bugs mais caros e silenciosos em ML.

## Treino com o pré-processamento dentro do modelo

O erro mais comum na passagem para produção é empacotar só o estimador e refazer o pré-processamento no serviço que chama. Com o tempo, a codificação do notebook e a da API divergem (*training-serving skew*). A solução é registrar o pipeline inteiro como um artefato só.

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

Com esses parâmetros, a execução na base pública fica perto de 0,87 de ROC-AUC e 0,71 de PR-AUC. O número em si importa menos do que o fato de estar registrado junto com os parâmetros e o artefato.

Dois detalhes de versão. O código usa o MLflow 3, em que `log_model` recebe `name` no lugar do antigo `artifact_path`; o `requirements.txt` do projeto ainda fixa o 2.15, então essa atualização faz parte do trabalho. E, nas versões recentes do MLflow 3, modelos scikit-learn são serializados com skops, que recusa tipos não declarados como confiáveis; daí o `skops_trusted_types`.

## Aliases, não stages

O registro de modelos do MLflow costumava promover versões por *stages* (Staging, Production, Archived). Esse mecanismo foi depreciado em favor de **aliases**: nomes móveis que apontam para uma versão. Eu uso dois: `challenger` para a versão recém-treinada e `champion` para a que está servindo. Promover é mover o alias, e voltar atrás é movê-lo de volta.

A promoção passa por um portão: o desafiante só vira campeão se ganhar por uma margem, para não trocar de modelo por ruído.

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
        raise RuntimeError("Nenhuma versão com o alias 'challenger'.")
    if champion is not None and challenger < champion + MIN_GAIN:
        return False
    version = client.get_model_version_by_alias(MODEL_NAME, "challenger").version
    client.set_registered_model_alias(MODEL_NAME, "champion", version)
    return True
```

Comparar só uma métrica agregada é o mínimo. Antes de confiar no portão em produção, eu acrescentaria a comparação por segmento (país, faixa etária), porque um modelo pode melhorar na média e piorar justamente no grupo que mais importa.

## Servir: lote antes de online

Para churn, a pergunta de negócio quase sempre é "quem devo abordar nesta semana?". Isso é **pontuação em lote**: rodar o modelo sobre a base de clientes num horário fixo e entregar uma lista ordenada para a equipe de retenção. É mais barato, mais simples de operar e mais fácil de auditar do que uma API. Inferência online, com latência baixa e escala horizontal, faz sentido quando a decisão acontece durante uma interação, como oferecer algo enquanto o cliente pede o encerramento da conta.

Se for online, a API carrega o campeão pelo alias e valida a entrada com o mesmo contrato do treino:

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

Toda resposta carrega a versão do modelo; sem isso, investigar uma previsão estranha vira adivinhação. Um país fora da lista recebe 422 antes de chegar ao modelo. Para deploy, há uma escolha: carregar o modelo do registro na subida (o contêiner depende do MLflow estar no ar) ou baixar o artefato no build da imagem, marcando a imagem com a versão do modelo. Eu prefiro a segunda, porque o rollback vira trocar de imagem, como em qualquer serviço.

Para versões novas de alto risco, o *shadow mode* é a estratégia mais segura: o desafiante recebe o mesmo tráfego, mas suas previsões só são registradas, para comparação com o campeão em dados reais.

## Monitorar em quatro camadas

Modelo em produção degrada sem lançar exceção. Monitoro em camadas, da mais barata para a mais cara:

1. **Infraestrutura**: latência, erros, volume de previsões. Queda súbita de volume costuma ser falha no pipeline de cima.
2. **Qualidade dos dados**: o mesmo contrato de entrada, agora medido continuamente (taxa de nulos, valores fora do intervalo).
3. **Drift das features**: a distribuição atual comparada à de referência (a base de treino ou uma janela estável recente).
4. **Desempenho do modelo**: as métricas reais, quando o rótulo chega.

Para drift, uso o Evidently. A API atual trabalha com `Dataset`, `DataDefinition` e presets:

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

O Evidently escolhe o teste estatístico conforme o tipo e o tamanho da amostra; em amostras grandes, usa distância de Wasserstein normalizada para numéricas e distância de Jensen-Shannon para categóricas. Também vale conhecer o PSI (*Population Stability Index*), muito usado em crédito, e o teste de Kolmogorov-Smirnov para amostras menores.

O ponto mais específico de churn é o **atraso do rótulo**. Você só sabe se o cliente saiu semanas ou meses depois da previsão. Enquanto isso, os sinais disponíveis são indiretos: a distribuição das probabilidades previstas (uma mudança nela costuma anteceder a perda de desempenho), o drift nas features que a EDA mostrou serem fortes (idade, atividade, número de produtos) e as métricas de negócio da campanha de retenção. Quando o rótulo chega, compare o desempenho real com o do treino.

Alertas em níveis evitam fadiga: um aviso quando o drift aparece, um alerta crítico quando persiste por várias execuções ou quando atinge as features fortes.

## Orquestração com Airflow 3

O ciclo semanal (pontuar, medir drift, retreinar se necessário, promover se melhor) vira um DAG. No Airflow 3, a API de autoria fica em `airflow.sdk`, `schedule` substitui `schedule_interval` e `days_ago` não existe mais:

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
        return score_snapshot(ds)  # sobrescreve data/scores/ds=<ds>/ e devolve o caminho

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

Passar a data lógica (`ds`) a cada tarefa deixa cada execução função das suas entradas: dá para reprocessar uma semana antiga sem efeito colateral nas outras. O `short_circuit` pula o retreino quando o drift é pequeno, e o `max_active_runs=1` impede duas execuções sobrepostas. Retreinar por agenda fixa é simples, mas gasta recurso à toa; retreinar por drift persistente, com promoção condicionada ao portão, é o equilíbrio que eu procuro.

## O que fica

A parte técnica de MLOps é software comum: versionamento, testes, contratos, deploy reproduzível, observabilidade. O que muda é que os dados também são código, e que o sistema pode piorar sem que nenhuma linha mude. No `churn-prediction-mlops`, a ordem que sigo é a deste texto: contrato de dados, treino rastreado com o pré-processamento dentro do artefato, promoção por portão com aliases, pontuação em lote, monitoramento de drift e, por fim, a orquestração que amarra tudo.
