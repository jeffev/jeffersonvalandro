---
title: "Service communication and events with Kafka"
description: "When to call and when to publish, partitions and per-key ordering, outbox, idempotent consumers, sagas and event sourcing in Java with Spring Kafka."
slug: "eventos-com-kafka"
theme: "arquitetura"
order: 3
cover: ""
replaces: ["event-driven-architecture", "microservices-communication"]
---

When a monolith becomes services, method calls become network calls. That changes everything: now there is latency, partial failure, retries, service discovery and distributed transactions. How services talk to each other is one of the most expensive decisions to get wrong, and one of the least discussed.

Kafka comes up a lot in that conversation, sometimes for the wrong reason ("everyone uses it"). A common result: a system that is harder to understand than the monolith, with all the operational weight of a distributed system and none of the benefits. This piece lays out when to use each style of communication and how to get right the details that cause trouble in production.

## Synchronous or asynchronous

The rule I use: **if the caller needs the result to keep going, it is synchronous. If it only needs to announce that something happened, it is asynchronous.**

Checking a credit limit before approving an order is synchronous: without the answer there is nothing to do. Announcing that the order was approved so billing, inventory and notifications can do their part is asynchronous: the order service does not need to know what each of them does.

A synchronous call is easy to reason about and gives immediate consistency, but it couples in time (if B is down, A fails), in behavior (A has to know what B does) and in scale (B has to handle A's peak). An event decouples all three, at the cost of eventual consistency, idempotent consumers and harder debugging.

### REST, gRPC and the gateway

For synchronous calls, REST with JSON is still the best choice for external APIs: every client understands it, and debugging with `curl` is trivial. Between internal services, gRPC has concrete advantages: a `.proto` contract with generated stubs, binary Protobuf over HTTP/2, first-class streaming, and deadlines propagated on every call.

```protobuf
syntax = "proto3";
package orders;

service OrderService {
  rpc PlaceOrder (PlaceOrderRequest) returns (PlaceOrderResponse);
  rpc StreamOrderUpdates (OrderId) returns (stream OrderEvent);
}
```

A common setup: REST at the edge, through an API gateway that handles authentication, rate limiting and routing, and gRPC inside. A service mesh (Istio, Linkerd) moves mTLS, retries and timeouts into the infrastructure, but it has a high operational cost; it only pays off with many services and real traffic-management needs.

Service discovery: on Kubernetes, the `Service` object handles it, with server-side load balancing. Outside it, Spring Cloud LoadBalancer with Consul or Eureka does client-side balancing.

## Kafka: what needs to be clear

### Topics, partitions and keys

A topic is a durable, partitioned log. The partition is the unit of parallelism and of ordering: **within a partition, order is guaranteed; across partitions, it is not.**

The message key decides the partition. The default partitioner hashes the key modulo the number of partitions, so the same key always lands on the same partition. For orders, the key is the order ID, and every event of an order is processed in sequence.

```java
@Component
class OrderEventPublisher {
    private final KafkaTemplate<String, OrderEvent> kafka;

    OrderEventPublisher(KafkaTemplate<String, OrderEvent> kafka) { this.kafka = kafka; }

    CompletableFuture<SendResult<String, OrderEvent>> publish(OrderEvent event) {
        // key = orderId: every event of the same order goes to the same partition
        return kafka.send("orders", event.orderId(), event);
    }
}
```

### Consumer groups and the partition ceiling

In a consumer group, each partition is assigned to exactly one consumer in the group. With 12 partitions and 4 instances, each reads 3. A thirteenth instance sits idle: **the partition count is the group's parallelism ceiling.** Different services use different groups, and each group keeps its own offsets; billing and notifications both read every event, independently.

Here is the detail that is often explained wrong: **a topic's partition count cannot be reduced, only increased. And increasing it breaks per-key ordering.** Since the partition is `hash(key) % partition_count`, going from 12 to 16 moves a good share of keys to a different partition. New events for an order go to the new partition while older ones may still be waiting in the old one, and the consumer can process event 5 before event 4.

So size with headroom from the start, for the parallelism you will need, not the one you have today. If you really must change it, the safe path is a new topic with the right partition count and a controlled migration of producers and consumers.

## Outbox: write and publish without losing events

The most common and most expensive bug in event-driven systems: the application writes to the database, then publishes to Kafka, and crashes in between. The database has the order, the event never went out, and nobody finds out. Swapping the order does not help, it just swaps the problem: an event published for an order that does not exist.

The outbox pattern solves it with the transaction you already have. In the same transaction that changes state, the event is written to an `outbox` table. A separate process reads that table and publishes.

```java
@Service
class PlaceOrderHandler {
    private final OrderRepository orders;
    private final OutboxRepository outbox;
    private final ObjectMapper json;

    // constructor omitted

    @Transactional
    public OrderId handle(PlaceOrderCommand cmd) throws JsonProcessingException {
        Order order = Order.create(cmd.customerId(), cmd.items());
        orders.save(order);
        outbox.save(new OutboxEvent(
                UUID.randomUUID(), "Order", order.id().value(), "order.placed",
                json.writeValueAsString(OrderPlaced.from(order)), Instant.now()));
        return order.id();
    }
}
```

There are two ways to publish. The simple one is a scheduled job that reads unpublished rows with `SELECT ... FOR UPDATE SKIP LOCKED` (both Oracle and Postgres support it), publishes and marks them. The sturdier one is CDC with Debezium, which reads the database's transaction log (WAL on Postgres, redo log through LogMiner on Oracle) and publishes without polling; Debezium even has a router built for outbox tables.

Either way, delivery is *at least once*: if the relay publishes and dies before marking the row, the event goes out again. That is why the other side must be idempotent.

## Idempotent consumers

You will receive the same event twice. It is not a hypothesis: rebalances, retries and the outbox itself guarantee it. Processing twice must have the same effect as processing once.

The simplest way is to record the event ID in a table with a unique key, in the same transaction as the effect:

```java
@Component
class BillingListener {
    private final ProcessedEventRepository processed;
    private final InvoiceService invoices;

    // constructor omitted

    @KafkaListener(topics = "orders", groupId = "billing")
    @Transactional
    void on(OrderPlaced event) {
        if (processed.existsById(event.eventId())) return;
        invoices.createFor(event);
        processed.save(new ProcessedEvent(event.eventId(), Instant.now()));
        // the primary key on processed_event stops the race between two instances
    }
}
```

## Poison messages and dead letter topics

If an event cannot be processed (invalid payload, a bug), retrying forever blocks the whole partition. Spring Kafka handles this with `@RetryableTopic`: it retries through retry topics with backoff, without blocking the main partition, and then sends the record to a dead letter topic.

```java
@RetryableTopic(attempts = "4", backoff = @Backoff(delay = 1000, multiplier = 2.0))
@KafkaListener(topics = "orders", groupId = "shipping")
void on(OrderPlaced event) {
    shipping.schedule(event);
}

@DltHandler
void onDeadLetter(OrderPlaced event, @Header(KafkaHeaders.RECEIVED_TOPIC) String topic) {
    log.error("Event {} went to {} after exhausting retries", event.eventId(), topic);
}
```

One caveat: retrying on a separate topic gives up per-key ordering for that event. If strict ordering matters, use `DefaultErrorHandler` with `DeadLetterPublishingRecoverer`, which retries on the same partition (blocking it during the attempts) and only then publishes to the DLT.

## Event contracts

An event is a contract. Changing its shape without coordination breaks consumers silently. With a Schema Registry (Avro or Protobuf), compatibility is checked at publish time. Under `BACKWARD` compatibility, the default mode, consumers on the new schema can read old events; adding an optional field with a default is safe, renaming one is not.

```json
{"name": "currency", "type": ["null", "string"], "default": null}
```

## Sagas: transactions that span services

In a monolith, one database transaction covers "create order, reserve stock, charge". With each service owning its database, there is no global transaction. A saga replaces the distributed transaction with a sequence of local transactions, each with a **compensation** that undoes its effect if a later step fails.

In **choreography**, each service reacts to the others' events. Inventory listens to `OrderPlaced` and publishes `InventoryReserved` or `InventoryRejected`; payment listens to `InventoryReserved`; orders listens to `PaymentFailed`, cancels and publishes `OrderCancelled`; inventory listens to that and releases the reservation. There is no central point, but the flow only exists scattered across five listeners. It works well for short sagas.

In **orchestration**, one component drives the flow, sends commands and keeps the saga state. The logic lives in one place, easier to test and debug. No framework required:

```java
@Component
class PlaceOrderSaga {
    private final SagaStateRepository states;
    private final KafkaTemplate<String, Object> commands;

    // constructor omitted

    @KafkaListener(topics = "order-events", groupId = "place-order-saga")
    @Transactional
    void on(OrderSagaEvent event) {
        SagaState saga = states.findOrStart(event.orderId());
        switch (event) {
            case OrderPlaced e -> {
                saga.moveTo(Step.RESERVING_INVENTORY);
                send(new ReserveInventory(e.orderId(), e.items()));
            }
            case InventoryReserved e -> {
                saga.moveTo(Step.CHARGING);
                send(new ChargePayment(e.orderId(), e.amount()));
            }
            case PaymentCharged e -> {
                saga.moveTo(Step.DONE);
                send(new ConfirmOrder(e.orderId()));
            }
            case PaymentFailed e -> {
                saga.moveTo(Step.COMPENSATING);
                send(new ReleaseInventory(e.orderId()));
                send(new CancelOrder(e.orderId(), e.reason()));
            }
            case InventoryRejected e -> {
                saga.moveTo(Step.FAILED);
                send(new CancelOrder(e.orderId(), "out of stock"));
            }
        }
        states.save(saga);
    }

    private void send(OrderCommand command) {
        commands.send("order-commands", command.orderId(), command);
    }
}
```

`OrderSagaEvent` is a `sealed interface` over the five records, and the exhaustive `switch` makes sure a new event cannot slip by unnoticed. In production, commands also go out through the outbox, for the same reason as before.

If you would rather use a framework, the real options are Axon Framework (in the 4.x line, with `@Saga`, `@StartSaga`, `@SagaEventHandler` and `@EndSaga`), workflow engines such as Temporal or Camunda, or Eventuate Tram Sagas. Spring State Machine is something else: it models state machines and is not a saga framework.

## Event sourcing

Event sourcing goes further: instead of storing the current state, you store the sequence of events, and state is derived by replaying them.

```java
public sealed interface OrderEvent permits OrderCreated, ItemAdded, PaymentApplied, OrderShipped {}

public record OrderState(String id, Status status, List<Item> items, String trackingId) {

    static OrderState replay(List<OrderEvent> history) {
        OrderState state = null;
        for (OrderEvent event : history) {
            state = apply(state, event);
        }
        return state;
    }

    private static OrderState apply(OrderState s, OrderEvent event) {
        return switch (event) {
            case OrderCreated e -> new OrderState(e.orderId(), Status.CREATED, e.items(), null);
            case ItemAdded e -> new OrderState(s.id(), s.status(), append(s.items(), e.item()), null);
            case PaymentApplied e -> new OrderState(s.id(), Status.PAID, s.items(), null);
            case OrderShipped e -> new OrderState(s.id(), Status.SHIPPED, s.items(), e.trackingId());
        };
    }

    private static List<Item> append(List<Item> items, Item item) {
        var copy = new ArrayList<>(items);
        copy.add(item);
        return List.copyOf(copy);
    }
}
```

It is worth it when history is a real requirement: full auditing, temporal queries ("what was the status yesterday at 2 p.m.?"), or the need to build new projections from the past. It is not worth it for "I need asynchronous communication between services": the outbox is enough for that. Applying event sourcing to every entity brings snapshots, event versioning and projections to manage, and the cost is only justified for aggregates where history matters.

## In practice

Start with "does the caller need the answer?". Pick the partition key based on the ordering the business requires, and size partitions with headroom because there is no going back. Publish through an outbox, consume idempotently, send poison messages to a DLT, version events with a schema registry, and choose between choreography and orchestration by the size of the flow. Leave event sourcing for places where history is the product.
