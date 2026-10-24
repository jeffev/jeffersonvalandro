---
title: "CI/CD para backend Java: do commit ao cluster"
description: "Pipeline para Spring Boot com GitHub Actions ou Jenkins: testes separados, Testcontainers, imagem por digest, segredos, GitOps e estratégias de deploy."
slug: "ci-cd-backend-java"
theme: "qualidade"
order: 1
cover: ""
replaces: ["cicd-pipelines-backend"]
---

O pipeline é o sistema de entrega do software. A qualidade dele define quão rápido o time entrega, com quanta confiança faz deploy e quão rápido se recupera quando algo dá errado. Um pipeline lento, instável ou sem portões de qualidade atrapalha o time tanto quanto código ruim.

Vou usar GitHub Actions nos exemplos porque é o que a maioria dos projetos novos usa, mas as ideias valem igualmente para Jenkins, GitLab CI ou Azure DevOps; onde o Jenkins tem uma forma própria de fazer, eu mostro.

## O pipeline como funil

Cada etapa filtra defeitos, da mais barata para a mais cara. Um teste unitário quebrado custa minutos; o mesmo defeito em produção custa horas de incidente.

```text
commit → build + unitários → análise estática → integração → imagem → staging → produção
```

Falha numa etapa para tudo. Sem "aviso": se o portão não barra, não é portão.

## Etapa 1: build e testes unitários, rápido

É o ciclo que o desenvolvedor sente em todo push, então precisa ser curto. Feedback lento leva a commits acumulados e a troca de contexto. A técnica principal é separar teste unitário (sem I/O, sem contexto Spring) de teste de integração. No Maven isso já vem pronto: o Surefire roda `*Test` na fase `test`, o Failsafe roda `*IT` na fase `integration-test`.

```yaml
# .github/workflows/ci.yml
name: ci
on:
  pull_request:
  push:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '21'
          cache: maven
      - name: Unit tests
        run: ./mvnw -B --no-transfer-progress test
      - name: Integration tests
        run: ./mvnw -B --no-transfer-progress verify -DskipUnitTests
```

O `cache: maven` evita baixar o mundo a cada execução. O `-DskipUnitTests` é uma propriedade do próprio projeto, ligada ao `skipTests` do Surefire, para não rodar os unitários duas vezes.

## Etapa 2: análise estática e dependências

Análise estática pega code smell, vulnerabilidade e complexidade antes do revisor humano. O SonarQube (ou SonarQube Cloud) com quality gate faz o pipeline falhar quando o código novo piora. O gate padrão do Sonar, o *Sonar way*, olha justamente para o código novo: cobertura mínima de 80%, duplicação máxima de 3% e nenhum problema novo acima do limite de severidade. Medir só o código novo é o que torna o gate viável num legado.

```yaml
      - name: Sonar
        env:
          SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}
        run: >
          ./mvnw -B sonar:sonar
          -Dsonar.qualitygate.wait=true
```

Para dependências, o OWASP Dependency-Check (plugin Maven) ou o Dependabot e o scanning nativo do GitHub cuidam de CVEs conhecidas. Na imagem final, um scanner como Trivy pega o que vem do sistema operacional da imagem base.

No Jenkins, o equivalente é `withSonarQubeEnv('sonarqube') { sh 'mvn sonar:sonar' }` seguido de `waitForQualityGate abortPipeline: true`.

## Etapa 3: integração com Testcontainers

Teste de integração prova que a aplicação funciona com infraestrutura real: banco, broker, cache. O Testcontainers sobe contêineres durante o teste, sem banco de teste compartilhado e sem configuração por ambiente. Desde o Spring Boot 3.1, `@ServiceConnection` liga o contêiner à configuração automaticamente, sem `@DynamicPropertySource`:

```java
@SpringBootTest
@Testcontainers
class OrderFlowIT {

    @Container
    @ServiceConnection
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:16-alpine");

    @Container
    @ServiceConnection
    static KafkaContainer kafka = new KafkaContainer("apache/kafka:3.8.0");

    @Autowired OrderRepository orders;

    @Test
    void gravaERecuperaPedido() {
        // teste contra Postgres e Kafka de verdade
    }
}
```

O `KafkaContainer` do pacote `org.testcontainers.kafka`, que usa a imagem oficial `apache/kafka`, ganhou suporte a `@ServiceConnection` no Spring Boot 3.4. Para Oracle, o módulo `oracle-free` do Testcontainers com a imagem `gvenzl/oracle-free` funciona da mesma forma. É mais lento para subir, então vale reaproveitar o contêiner entre classes de teste.

## Etapa 4: imagem

A imagem só é construída depois que todos os portões passam. Um Dockerfile multi-stage separa o ambiente de build do de execução:

```dockerfile
FROM eclipse-temurin:21-jdk AS build
WORKDIR /src
COPY .mvn .mvn
COPY mvnw pom.xml ./
RUN ./mvnw -B dependency:go-offline
COPY src src
RUN ./mvnw -B package -DskipTests

FROM eclipse-temurin:21-jre
RUN useradd --system --uid 10001 app
USER app
WORKDIR /app
COPY --from=build /src/target/app.jar app.jar
ENTRYPOINT ["java", "-XX:MaxRAMPercentage=75", "-jar", "app.jar"]
```

Três detalhes. Copiar o `pom.xml` antes do código faz a camada de dependências ficar em cache entre builds. O `ENTRYPOINT` na forma de lista faz o Java ser o PID 1 e receber o `SIGTERM` do Kubernetes, permitindo o shutdown gracioso do Spring. E não é preciso `-XX:+UseContainerSupport`: a JVM detecta limites de contêiner por padrão desde o JDK 10. O que vale ajustar é quanto da memória do contêiner vai para o heap, com `MaxRAMPercentage`.

Uma alternativa sem Dockerfile é `./mvnw spring-boot:build-image`, que usa Cloud Native Buildpacks e já gera imagem em camadas.

### Tag por commit, deploy por digest

```yaml
  image:
    needs: build
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    outputs:
      digest: ${{ steps.push.outputs.digest }}
    steps:
      - uses: actions/checkout@v4
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - id: push
        uses: docker/build-push-action@v6
        with:
          push: true
          tags: ghcr.io/${{ github.repository }}/order-service:${{ github.sha }}
```

A imagem é marcada com o SHA do commit, e o deploy referencia o **digest** (`@sha256:...`) que o push devolve. Tag é um ponteiro móvel; digest é imutável. Nunca use `latest` como alvo de deploy: ninguém sabe o que está rodando, dois nós podem puxar versões diferentes, e rollback vira adivinhação. Se quiser uma tag `latest` por conveniência para quem roda localmente, tudo bem, mas nenhum manifesto de ambiente deve apontar para ela.

## Segredos

Regra dura: segredo nunca aparece em código, Dockerfile, script de build ou histórico do git, nem em repositório privado. Um hook de pre-commit com gitleaks e o secret scanning com push protection do GitHub pegam a maioria dos acidentes antes de chegarem ao remoto.

**No pipeline**, o mínimo é o cofre de segredos da própria plataforma (secrets do GitHub Actions, credentials do Jenkins), que injeta valores em tempo de execução e mascara nos logs. Melhor ainda é não ter segredo de longa duração: com OIDC, o GitHub Actions troca um token assinado da execução por credenciais temporárias na AWS, no Azure, no GCP ou no Vault, sem chave guardada em lugar nenhum.

**Com HashiCorp Vault**, convém ser preciso sobre o que ele faz. Segredos estáticos do motor KV (uma senha guardada em `secret/ci/order-service`) são só lidos; nada é revogado quando a etapa termina. Quem tem *lease* e é revogado ou expira são os **segredos dinâmicos**: o motor de banco de dados cria um usuário com TTL curto para aquela execução e o remove quando o lease acaba. Se a preocupação é vazamento de credencial de banco, é para os dinâmicos que você deve ir.

O que o Vault dá sempre, para estáticos e dinâmicos, é auditoria: cada acesso fica registrado com identidade e caminho. Quando uma credencial vaza, você sabe quem a leu.

**Em execução**, os segredos que a aplicação usa ficam no Kubernetes, de preferência sincronizados de um cofre (External Secrets Operator, Vault Agent) ou cifrados no git (Sealed Secrets). Montar como arquivo em vez de variável de ambiente reduz o risco de aparecerem em dumps e em logs de diagnóstico.

## GitOps

No modelo GitOps, o estado desejado do cluster vive num repositório de configuração, separado do código. O pipeline não aplica manifesto no cluster: ele faz um commit trocando a imagem, e o Argo CD ou o Flux sincroniza.

```yaml
  promote-staging:
    needs: image
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          repository: org/k8s-config
          token: ${{ secrets.CONFIG_REPO_TOKEN }}
      - run: |
          cd overlays/staging
          kustomize edit set image order-service=ghcr.io/${{ github.repository }}/order-service@${{ needs.image.outputs.digest }}
          git config user.name ci-bot
          git config user.email ci-bot@users.noreply.github.com
          git commit -am "order-service ${{ github.sha }} em staging"
          git push
```

Cada deploy vira um commit com autor e diff. Rollback é `git revert`. A promoção para produção é um pull request no repositório de configuração, com aprovação, o que dá ao processo de mudança uma trilha de auditoria sem planilha.

## Estratégias de deploy

- **Rolling update**: o padrão do Kubernetes, troca pods aos poucos. Sem infraestrutura extra. Exige que versão nova e antiga convivam com o mesmo schema durante a transição, e readiness probe bem feita, senão o tráfego chega antes da aplicação estar pronta.
- **Blue/green**: dois ambientes idênticos, troca de tráfego de uma vez, rollback instantâneo. Custa o dobro de recurso durante a troca. Bom para mudanças de alto risco.
- **Canary**: uma fração pequena do tráfego vai para a versão nova enquanto erro, latência e métricas de negócio são observados; a fração cresce ou o deploy é abortado. Argo Rollouts e Flagger automatizam a análise. Vale em serviços críticos com tráfego suficiente para que a amostra signifique alguma coisa.

Seja qual for a estratégia, migração de banco precisa ser compatível com as duas versões ao mesmo tempo: o padrão *expand and contract*. Primeiro adiciona a coluna nova (Flyway ou Liquibase no deploy), depois o código passa a usá-la, e só num deploy posterior a coluna antiga sai.

## Medindo o próprio pipeline

Trate o pipeline como sistema de produção. As métricas do DORA (programa de pesquisa hoje no Google Cloud) são a referência: frequência de deploy, tempo entre commit e produção, taxa de mudanças que falham e tempo de recuperação de um deploy com falha. Mais útil que perseguir um número de outro time é olhar a própria tendência: se o lead time está subindo, alguma etapa ficou lenta ou instável.

O pior sinal é um pipeline em que ninguém confia. Quando alguém diz "vou fazer deploy manual só desta vez", o pipeline falhou: está lento, instável ou barrando mudança legítima com falso positivo. Conserte o pipeline, não o atalho.
