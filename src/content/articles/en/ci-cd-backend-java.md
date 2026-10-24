---
title: "CI/CD for Java backends: from commit to cluster"
description: "A Spring Boot pipeline on GitHub Actions or Jenkins: split tests, Testcontainers, deploy by digest, secrets, GitOps and deployment strategies."
slug: "ci-cd-backend-java"
theme: "qualidade"
order: 1
cover: ""
replaces: ["cicd-pipelines-backend"]
---

The pipeline is your software's delivery system. Its quality decides how fast the team ships, how confidently it deploys, and how quickly it recovers when something goes wrong. A slow, flaky pipeline with no quality gates hurts a team as much as bad code does.

I use GitHub Actions in the examples because that is what most new projects use, but the ideas apply equally to Jenkins, GitLab CI or Azure DevOps; where Jenkins has its own way of doing something, I show it.

## The pipeline as a funnel

Each stage filters defects, from the cheapest to the most expensive. A broken unit test costs minutes; the same defect in production costs hours of incident response.

```text
commit → build + unit → static analysis → integration → image → staging → production
```

A failure at any stage stops everything. No "warnings": if the gate does not block, it is not a gate.

## Stage 1: build and unit tests, fast

This is the loop developers feel on every push, so it has to be short. Slow feedback leads to batched commits and context switching. The main technique is separating unit tests (no I/O, no Spring context) from integration tests. Maven already does this: Surefire runs `*Test` in the `test` phase, Failsafe runs `*IT` in the `integration-test` phase.

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

`cache: maven` avoids downloading the world on every run. `-DskipUnitTests` is a project property wired to Surefire's `skipTests`, so unit tests do not run twice.

## Stage 2: static analysis and dependencies

Static analysis catches code smells, vulnerabilities and complexity before a human reviewer does. SonarQube (or SonarQube Cloud) with a quality gate fails the pipeline when new code makes things worse. Sonar's default gate, *Sonar way*, looks precisely at new code: at least 80% coverage, at most 3% duplication, and no new issues above the severity threshold. Measuring only new code is what makes a gate workable on a legacy codebase.

```yaml
      - name: Sonar
        env:
          SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}
        run: >
          ./mvnw -B sonar:sonar
          -Dsonar.qualitygate.wait=true
```

For dependencies, OWASP Dependency-Check (Maven plugin) or Dependabot and GitHub's native scanning take care of known CVEs. On the final image, a scanner like Trivy catches what comes from the base image's operating system.

In Jenkins the equivalent is `withSonarQubeEnv('sonarqube') { sh 'mvn sonar:sonar' }` followed by `waitForQualityGate abortPipeline: true`.

## Stage 3: integration with Testcontainers

Integration tests prove the application works with real infrastructure: database, broker, cache. Testcontainers starts containers during the test, with no shared test database and no per-environment configuration. Since Spring Boot 3.1, `@ServiceConnection` wires the container into configuration automatically, no `@DynamicPropertySource` needed:

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
    void storesAndLoadsAnOrder() {
        // test against real Postgres and Kafka
    }
}
```

The `KafkaContainer` from the `org.testcontainers.kafka` package, which uses the official `apache/kafka` image, gained `@ServiceConnection` support in Spring Boot 3.4. For Oracle, Testcontainers' `oracle-free` module with the `gvenzl/oracle-free` image works the same way. It is slower to start, so reuse the container across test classes.

## Stage 4: the image

The image is only built after every gate passes. A multi-stage Dockerfile separates the build environment from the runtime:

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

Three details. Copying `pom.xml` before the source keeps the dependency layer cached between builds. The exec-form `ENTRYPOINT` makes Java PID 1 so it receives Kubernetes' `SIGTERM`, which allows Spring's graceful shutdown. And there is no need for `-XX:+UseContainerSupport`: the JVM has detected container limits by default since JDK 10. What is worth tuning is how much of the container's memory goes to the heap, with `MaxRAMPercentage`.

An alternative with no Dockerfile is `./mvnw spring-boot:build-image`, which uses Cloud Native Buildpacks and produces a layered image.

### Tag by commit, deploy by digest

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

The image is tagged with the commit SHA, and deployments reference the **digest** (`@sha256:...`) returned by the push. A tag is a movable pointer; a digest is immutable. Never use `latest` as a deployment target: nobody knows what is running, two nodes can pull different versions, and rollback becomes guesswork. If you want a `latest` tag as a convenience for people running locally, fine, but no environment manifest should point to it.

## Secrets

Hard rule: secrets never appear in code, Dockerfiles, build scripts or git history, not even in a private repository. A pre-commit hook with gitleaks plus GitHub's secret scanning with push protection catch most accidents before they reach the remote.

**In the pipeline**, the minimum is the platform's own secret store (GitHub Actions secrets, Jenkins credentials), which injects values at runtime and masks them in logs. Better still is having no long-lived secrets at all: with OIDC, GitHub Actions exchanges a signed token for the run for temporary credentials on AWS, Azure, GCP or Vault, with no key stored anywhere.

**With HashiCorp Vault**, it pays to be precise about what it does. Static secrets in the KV engine (a password stored at `secret/ci/order-service`) are just read; nothing is revoked when the stage ends. What has a *lease* and gets revoked or expires are **dynamic secrets**: the database engine creates a user with a short TTL for that run and removes it when the lease ends. If database credential leaks are the concern, dynamic secrets are what you want.

What Vault always gives you, for static and dynamic secrets alike, is auditing: every access is logged with identity and path. When a credential leaks, you know who read it.

**At runtime**, the secrets the application uses live in Kubernetes, ideally synced from a vault (External Secrets Operator, Vault Agent) or encrypted in git (Sealed Secrets). Mounting them as files rather than environment variables reduces the chance of them showing up in dumps and diagnostic logs.

## GitOps

In the GitOps model, the cluster's desired state lives in a configuration repository, separate from the code. The pipeline does not apply manifests to the cluster: it commits an image change, and Argo CD or Flux syncs it.

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
          git commit -am "order-service ${{ github.sha }} to staging"
          git push
```

Every deployment becomes a commit with an author and a diff. Rollback is `git revert`. Promotion to production is a pull request on the configuration repository, with an approval, which gives the change process an audit trail without spreadsheets.

## Deployment strategies

- **Rolling update**: Kubernetes' default, replacing pods gradually. No extra infrastructure. It requires the new and old versions to coexist on the same schema during the transition, and a well-built readiness probe, or traffic arrives before the application is ready.
- **Blue/green**: two identical environments, traffic switched at once, instant rollback. Costs double the resources during the switch. Good for high-risk changes.
- **Canary**: a small share of traffic goes to the new version while errors, latency and business metrics are watched; the share grows or the deployment is aborted. Argo Rollouts and Flagger automate the analysis. Worth it on critical services with enough traffic for the sample to mean something.

Whatever the strategy, database migrations must be compatible with both versions at the same time: the *expand and contract* pattern. First add the new column (Flyway or Liquibase at deploy time), then the code starts using it, and only in a later deployment does the old column go away.

## Measuring the pipeline itself

Treat the pipeline as a production system. The DORA metrics (a research program now at Google Cloud) are the reference: deployment frequency, lead time from commit to production, change failure rate, and recovery time after a failed deployment. More useful than chasing another team's number is watching your own trend: if lead time is rising, some stage got slow or flaky.

The worst sign is a pipeline nobody trusts. When someone says "I'll deploy manually just this once", the pipeline has failed: it is slow, flaky, or blocking legitimate changes with false positives. Fix the pipeline, not the shortcut.
