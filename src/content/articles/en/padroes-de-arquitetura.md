---
title: "Architecture patterns: how to choose and how to scale"
description: "Modular monolith, layers, microservices, events, hexagonal and serverless compared, plus the three scaling axes, caching and sharding."
slug: "padroes-de-arquitetura"
theme: "arquitetura"
order: 2
cover: ""
replaces: ["software-architectures", "scalable-architectures"]
---

Choosing an architecture is the decision with the longest tail in a project. A framework can be swapped over a weekend. The architecture shapes how the team organizes, how it deploys, how it debugs an incident at three in the morning and how the system grows, for years.

Even so, most teams choose by inertia: whatever they already know, whatever the framework suggests, or whatever a big company wrote about on its blog. This piece is a trade-off map for choosing on purpose, followed by the part that usually gets forgotten: how to scale what you chose.

## The patterns, one at a time

### Monolith (and modular monolith)

One deployable unit with everything inside. It is not a dirty word. Most successful products started this way, and many should stay this way. A call between components is a method call: no network, no serialization, no timeout.

It hurts when deployment becomes the bottleneck (touching one feature risks all of them) or when parts of the system have very different scaling needs.

The middle ground many people skip is the **modular monolith**: a single deployment, but with clearly bounded modules and dependency rules checked by the build. In Java you can do it with packages and ArchUnit, or with Spring Modulith, which verifies dependencies between modules and supports in-process events between them. When a module needs to become a service, the boundary already exists.

### Layered (N-tier)

Presentation, application, domain, infrastructure; each layer only depends on the one below. It is the structure everyone learns first and the one MVC suggests.

It works well for CRUD-heavy systems with few rules. The classic failure mode is the database leaking into the domain: JPA entities full of business logic, or a "domain" that just mirrors the tables. The separation only exists while someone defends it, ideally an automated test.

### Hexagonal (ports and adapters)

It flips the direction: the domain sits at the center and depends on nothing; the database, HTTP and queues plug in through ports (interfaces owned by the core) and adapters (implementations). It pays off in rich domains, because rules can be tested without infrastructure. It costs more files and more mapping, and it is overkill for CRUD. There is a whole article on it in this series, with Spring Boot and ArchUnit.

### Microservices

Small services deployed independently, each owning its domain context and its database. They talk over the network: REST, gRPC or messages.

They make sense when several teams need to ship without coordinating deployments, when parts of the system scale very differently, and when the domain is already well understood. Getting a boundary wrong costs far more in microservices than in a monolith, because moving a responsibility turns into migrating data between databases.

The cost is real: every synchronous call brings latency, timeouts and partial failure; consistency across services needs sagas and an outbox; debugging needs distributed tracing. Teams that migrate without that operational maturity often end up with a system that is harder to debug than the monolith they left.

And Amazon's two-pizza rule is about team autonomy, not service size. Nano-services, one endpoint per deployment, are a well-known failure mode.

### Event-driven

Producers publish facts, consumers react, and the broker (Kafka, RabbitMQ, SNS/SQS) is the only shared contract. Adding a new consumer does not require changing the producer.

It shines at fan-out (a confirmed payment triggers email, analytics and inventory, each at its own pace), at absorbing spikes and at auditing with replay. It charges you in debugging, in schema evolution and in eventual consistency, which is a product constraint and not just a technical property. The Kafka article in this series goes into the details.

### Serverless

Functions deployed to a provider that handles scaling, patching and availability. Scales to zero and bills per invocation.

Good for irregular load: webhooks, scheduled jobs, file processing, event consumers. Bad for latency-sensitive APIs because of cold starts (in Java, AWS SnapStart and GraalVM native images help a lot, but do not remove them), and coupling to the provider's event formats is real lock-in.

### CQRS

Not a whole architecture but a pattern used inside one. The write model, with validation and invariants, is separate from the read model, a denormalized projection shaped for the screen. Worth it when writes and reads look very different, like an order with a twenty-step flow and a dashboard full of aggregates. In plain CRUD it just doubles the work. Start with one model and add CQRS when you can say in one sentence which asymmetry it solves.

## How to choose

Three questions settle most cases.

**How big is the team and how is it organized?** A small team almost always does better with a monolith (modular, preferably). Several teams that need to ship independently is the strongest argument for microservices. Conway's Law applies either way: the architecture will mirror the organization.

**How complex is the domain?** Few rules, layers are enough. Rich rules with invariants, hexagonal pays for itself. If you still cannot describe the domain boundaries, it is not time for microservices.

**What is the load profile and operational maturity?** Steady, known load: scale the monolith first. Unpredictable spikes: events or serverless on the hot paths. Nobody looking after observability and platform: microservices will hurt.

Real systems mix. A combination that works well: a modular monolith with hexagonal inside for the core, Kafka to integrate with other systems, serverless functions for peripheral tasks.

## Migrating: strangler fig

The most common question is not "what should I use on a new project" but "how do I get out of what I have". The strangler fig pattern, described by Martin Fowler, is the standard answer:

1. Put a facade (gateway or reverse proxy) in front of the monolith.
2. Pick a context to extract, ideally one with clear data ownership and frequent change.
3. Build the new service honoring the same contract.
4. Route traffic through the facade, keeping the old code until metrics confirm.
5. Delete the monolith code. Repeat.

The lesson that cost me the most: never extract a service and change its behavior at the same time. Extract, validate parity, then evolve. Mixing the two makes any incident nearly impossible to investigate.

## The three scaling axes

The *Scale Cube*, from *The Art of Scalability* (Abbott and Fisher), splits scaling into three axes:

- **X axis**: clone. Several identical instances behind a load balancer. Simple and effective for stateless services.
- **Y axis**: split by function. This is the microservices axis: each business capability in its own service.
- **Z axis**: partition by data. Each instance handles a slice (customer, region, tenant). This is sharding.

Many teams jump straight to Y. The X axis usually takes you a long way, as long as the application keeps no state in memory (local sessions, a cache that must be consistent across instances).

## Caching: the first lever

Before replicas or shards, cache. The most common pattern is **cache-aside**: the application checks the cache, and on a miss reads from the database and populates it. Only what is actually requested takes up memory. In Spring it is an annotation:

```java
@Service
class ProductQueries {
    private final ProductRepository products;

    ProductQueries(ProductRepository products) { this.products = products; }

    @Cacheable(cacheNames = "products", key = "#id", sync = true)
    public ProductView findById(long id) {
        return products.findViewById(id).orElseThrow(() -> new ProductNotFound(id));
    }

    @CacheEvict(cacheNames = "products", key = "#id")
    public void evict(long id) {}
}
```

```yaml
spring:
  cache:
    type: redis
    redis:
      time-to-live: 5m
```

`sync = true` makes sure that, within one instance, only one thread recomputes a missing key while the others wait. That addresses the **cache stampede**: a popular entry expires and thousands of requests hit the database together. Across instances, the defenses are TTL jitter (so keys do not expire in lockstep) and early refresh, recomputing slightly before expiry while still serving the old value. Caffeine has this built in with `refreshAfterWrite` for local caches.

Invalidation is the hard part. The three practical strategies:

- **TTL**: expire after N seconds. Simple; the TTL is how much stale data the business is willing to see.
- **Invalidate on write**: on save, delete the entry instead of updating it. The next read repopulates it. This avoids the race where two writes update the cache out of order.
- **Event-driven invalidation**: the change publishes an event and consumers delete their entries. More consistent, needs event infrastructure.

*Write-through*, which writes cache and database in the same operation, suits data that is read a lot and written rarely, like catalogs or configuration. Every write pays two latencies.

## Databases: scaling step by step

A stateless application server scales trivially on the X axis. The database is almost always the first bottleneck. A sensible order:

1. **Fix queries and indexes.** It sounds obvious, but a bad execution plan beats any architecture.
2. **Read replicas.** Writes go to the primary, reads to replicas. Works when the load is read-dominated and the application tolerates replication lag. Watch the "save then read" flow: whoever just saved needs to read from the primary, or they will think the write vanished.
3. **Vertical decomposition.** Each service owns its schema. It is the Y axis applied to data, and the price is replacing JOINs with API calls or event-fed projections.
4. **Horizontal sharding.** Data spread by a shard key; all rows for a customer on the same node. It gives linear write scaling, but cross-shard queries are expensive, migrations are painful, and a bad key creates hotspots (one huge tenant on a single shard, or a date-based key where every insert lands on the last node).

Sharding solves a write-throughput problem most systems never reach. Teams that do it early spend more time fighting the complexity than shipping.

## Resilience and observability

Scale without resilience is fragile. Three basic patterns, all available in Resilience4j with Spring Boot integration:

- **Circuit breaker**: when a dependency's failure rate crosses a threshold, subsequent calls fail immediately instead of waiting for a timeout, which prevents cascades.
- **Bulkhead**: separate pools per dependency, so a slow database does not eat the threads serving users.
- **Retry with exponential backoff and jitter**: transient failures are normal, but immediate retries make an overloaded service worse.

None of this can be operated without observability: per-service metrics (rate, errors, duration), structured logs with a correlation ID, and distributed tracing with OpenTelemetry. Logs alone will not tell you which of fifteen calls caused yesterday's p99.

## Wrapping up

The best architecture for today is the one you can move away from when the context changes. A well-modularized monolith turns into microservices gradually; a monolith with no boundaries turns into a troubled distributed system. Start with the simplest thing that works, with boundaries that allow extraction later, and scale in order: clone, cache, replicate, decompose, and only at the end, partition.
