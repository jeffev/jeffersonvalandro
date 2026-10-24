---
title: "Hexagonal architecture with Spring Boot, from domain to tests"
description: "Ports and adapters in Java 21 and Spring Boot: a framework-free domain, fakes instead of mocks, and dependency rules enforced with ArchUnit."
slug: "arquitetura-hexagonal-spring"
theme: "arquitetura"
order: 1
cover: ""
replaces: ["hexagonal-architecture", "clean-architecture"]
---

Hexagonal architecture, which Alistair Cockburn called *Ports and Adapters*, starts from a short idea: the core of the application knows nothing about the outside world. The database, HTTP, Kafka and third-party API clients are details plugged in from the outside, not code tangled with business rules.

Robert C. Martin's Clean Architecture says the same thing with different words. It has four circles (entities, use cases, interface adapters, frameworks) and a single rule: **source code dependencies only point inward**. Hexagonal has the core, the ports and the adapters. On Java projects I use both without ceremony: the split between entity and use case comes from Clean, and the names (input port, output port, adapter) come from hexagonal.

The payoff that justifies the cost is not aesthetics. It is being able to test business rules without starting a Spring context, a database or a broker, and to swap infrastructure without rewriting the domain.

## The three zones

- **Domain**: entities, value objects and domain services. Plain Java, no `@Entity`, no `@Component`, nothing from `org.springframework`.
- **Application**: use cases and **ports**. An input port is what the application offers (`PlaceOrderUseCase`). An output port is what it needs (`OrderRepository`, `PaymentGateway`). The interfaces belong to the core, not to the infrastructure.
- **Adapters**: concrete implementations. The REST controller calls an input port; the JPA adapter implements an output port. Adapters depend on the core, never the other way around.

Hexagonal makes one thing clearer than Clean does: there are *driving* adapters (whatever triggers the application: REST, a Kafka consumer, a scheduled job) and *driven* adapters (whatever the application triggers: the database, a payment gateway, a producer).

## Package layout

```text
src/main/java/com/example/order/
├── domain/
│   ├── model/        Order, OrderItem, OrderId, Money, OrderStatus
│   └── DomainException.java
├── application/
│   ├── port/in/      PlaceOrderUseCase, PlaceOrderCommand
│   ├── port/out/     OrderRepository, PaymentGateway
│   └── service/      PlaceOrderService
└── adapter/
    ├── in/web/       OrderController
    └── out/
        ├── persistence/  OrderJpaEntity, OrderPersistenceAdapter
        └── payment/      HttpPaymentGateway
```

## A domain without frameworks

The most important discipline is this one: a domain entity imports nothing from Spring or JPA. It holds invariants, rules that would be true even if there were no software.

```java
package com.example.order.domain.model;

public record Money(BigDecimal amount, String currency) {
    public static final Money ZERO_BRL = new Money(BigDecimal.ZERO, "BRL");

    public Money {
        Objects.requireNonNull(amount);
        if (amount.signum() < 0) throw new DomainException("Amount cannot be negative");
        if (!currency.matches("[A-Z]{3}")) throw new DomainException("Invalid currency: " + currency);
    }

    public Money add(Money other) {
        if (!currency.equals(other.currency)) throw new DomainException("Currency mismatch");
        return new Money(amount.add(other.amount), currency);
    }
}
```

```java
package com.example.order.domain.model;

public class Order {
    private final OrderId id;
    private final CustomerId customerId;
    private final List<OrderItem> items;
    private OrderStatus status;

    private Order(OrderId id, CustomerId customerId, List<OrderItem> items, OrderStatus status) {
        this.id = id;
        this.customerId = customerId;
        this.items = List.copyOf(items);
        this.status = status;
    }

    public static Order create(CustomerId customerId, List<OrderItem> items) {
        if (items.isEmpty()) throw new DomainException("An order needs at least one item");
        return new Order(OrderId.generate(), customerId, items, OrderStatus.PENDING);
    }

    // used by the persistence adapter to rebuild the aggregate
    public static Order restore(OrderId id, CustomerId customerId,
                                List<OrderItem> items, OrderStatus status) {
        return new Order(id, customerId, items, status);
    }

    public void confirm() {
        if (status != OrderStatus.PENDING)
            throw new DomainException("Only pending orders can be confirmed");
        status = OrderStatus.CONFIRMED;
    }

    public Money total() {
        return items.stream().map(OrderItem::subtotal).reduce(Money.ZERO_BRL, Money::add);
    }

    public OrderId id() { return id; }
    public CustomerId customerId() { return customerId; }
    public List<OrderItem> items() { return items; }
    public OrderStatus status() { return status; }
}
```

`restore` exists because the database has to rebuild an already confirmed order without going through the creation checks. It is a small, explicit cost, and better than exposing setters.

## Ports and the use case

```java
package com.example.order.application.port.in;

public interface PlaceOrderUseCase {
    OrderId placeOrder(PlaceOrderCommand command);
}

public record PlaceOrderCommand(CustomerId customerId, List<OrderItem> items) {}
```

```java
package com.example.order.application.port.out;

public interface OrderRepository {
    void save(Order order);
    Optional<Order> findById(OrderId id);
}

public interface PaymentGateway {
    PaymentResult charge(CustomerId customerId, Money amount);
}

public sealed interface PaymentResult {
    record Approved(String transactionId) implements PaymentResult {}
    record Declined(String reason) implements PaymentResult {}
}
```

With `sealed` and records, the use case handles both outcomes with a `switch`, and the compiler complains if a third one shows up. The use case itself is an ordinary Java class. I prefer not to put `@Service` on it: wiring lives in a configuration class, and the `application` package stays free of Spring.

```java
package com.example.order.application.service;

public class PlaceOrderService implements PlaceOrderUseCase {
    private final OrderRepository orders;
    private final PaymentGateway payments;

    public PlaceOrderService(OrderRepository orders, PaymentGateway payments) {
        this.orders = orders;
        this.payments = payments;
    }

    @Override
    public OrderId placeOrder(PlaceOrderCommand command) {
        Order order = Order.create(command.customerId(), command.items());

        switch (payments.charge(order.customerId(), order.total())) {
            case PaymentResult.Approved approved -> order.confirm();
            case PaymentResult.Declined declined -> throw new PaymentDeclinedException(declined.reason());
        }

        orders.save(order);
        return order.id();
    }
}
```

```java
package com.example.order.config;

@Configuration
class OrderWiring {
    @Bean
    PlaceOrderUseCase placeOrderUseCase(OrderRepository orders, PaymentGateway payments) {
        return new PlaceOrderService(orders, payments);
    }
}
```

What about transactions? They are an infrastructure detail. You can put `@Transactional` on a driving adapter, or wrap the use case with a `TransactionTemplate` in the configuration. If the team would rather annotate the application service, fine, but make it a deliberate decision and encode it in the architecture rules (below).

## Adapters

The persistence adapter translates between the domain model and the JPA entity. They are two different classes on purpose: the JPA one changes for database reasons (indexes, columns, lazy loading), the domain one changes for business reasons.

```java
package com.example.order.adapter.out.persistence;

@Component
class OrderPersistenceAdapter implements OrderRepository {
    private final OrderJpaRepository jpa;

    OrderPersistenceAdapter(OrderJpaRepository jpa) { this.jpa = jpa; }

    @Override
    public void save(Order order) {
        jpa.save(OrderJpaEntity.fromDomain(order));
    }

    @Override
    public Optional<Order> findById(OrderId id) {
        return jpa.findById(id.value()).map(OrderJpaEntity::toDomain);
    }
}

interface OrderJpaRepository extends JpaRepository<OrderJpaEntity, String> {}
```

The controller only turns HTTP into a command and calls the input port. If a business `if` appears here, it is in the wrong place.

```java
package com.example.order.adapter.in.web;

@RestController
@RequestMapping("/api/orders")
class OrderController {
    private final PlaceOrderUseCase placeOrder;

    OrderController(PlaceOrderUseCase placeOrder) { this.placeOrder = placeOrder; }

    @PostMapping
    ResponseEntity<PlaceOrderResponse> create(@RequestBody @Valid PlaceOrderRequest request) {
        OrderId id = placeOrder.placeOrder(request.toCommand());
        return ResponseEntity.created(URI.create("/api/orders/" + id.value()))
                .body(new PlaceOrderResponse(id.value()));
    }
}
```

## Fakes instead of mocks

With the core isolated, use case tests run without Spring. You can do that with Mockito, and plenty of people do. I prefer **fakes**: real, simple, in-memory implementations of the ports.

The difference shows up over time. A mock-based test checks *calls* (`verify(repo).save(argThat(...))`); replace `save` with `saveAll` during a refactoring and the test breaks even though behavior did not change. A fake-based test checks *state*: after placing the order, is it in the repository and confirmed? That test survives the refactoring.

```java
class InMemoryOrderRepository implements OrderRepository {
    private final Map<OrderId, Order> store = new HashMap<>();

    @Override public void save(Order order) { store.put(order.id(), order); }
    @Override public Optional<Order> findById(OrderId id) { return Optional.ofNullable(store.get(id)); }
    int size() { return store.size(); }
}

class FakePaymentGateway implements PaymentGateway {
    private PaymentResult next = new PaymentResult.Approved("txn-test");

    void declineNext(String reason) { next = new PaymentResult.Declined(reason); }

    @Override
    public PaymentResult charge(CustomerId customerId, Money amount) { return next; }
}
```

```java
class PlaceOrderServiceTest {
    private final InMemoryOrderRepository orders = new InMemoryOrderRepository();
    private final FakePaymentGateway payments = new FakePaymentGateway();
    private final PlaceOrderService service = new PlaceOrderService(orders, payments);

    @Test
    void confirmsOrderWhenPaymentIsApproved() {
        OrderId id = service.placeOrder(aValidOrder());

        assertThat(orders.findById(id))
                .get()
                .extracting(Order::status)
                .isEqualTo(OrderStatus.CONFIRMED);
    }

    @Test
    void doesNotStoreOrderWhenPaymentIsDeclined() {
        payments.declineNext("Insufficient funds");

        assertThatThrownBy(() -> service.placeOrder(aValidOrder()))
                .isInstanceOf(PaymentDeclinedException.class);
        assertThat(orders.size()).isZero();
    }
}
```

The same `InMemoryOrderRepository` serves dozens of tests and, as a bonus, documents the port's contract. The real adapters get their own integration tests, with Testcontainers running Oracle or Postgres. Business rules are covered by the fast tests, JPA mapping by the slow ones. Each kind of test checks one thing.

Mocks still have a place: when the interaction is exactly what matters (making sure an email was *not* sent twice, say) or when the port is too large to be worth a fake.

## Dependency rules checked by the build

Architecture that relies only on human discipline falls apart within months. Someone in a hurry imports `jakarta.persistence.Column` into the domain, code review misses it, and that is that. In Java the tool for this is **ArchUnit**: rules become JUnit tests and break the build.

```java
@AnalyzeClasses(packages = "com.example.order", importOptions = ImportOption.DoNotIncludeTests.class)
class ArchitectureTest {

    @ArchTest
    static final ArchRule domainKnowsNoFrameworks =
            noClasses().that().resideInAPackage("..domain..")
                    .should().dependOnClassesThat()
                    .resideInAnyPackage("org.springframework..", "jakarta.persistence..", "com.fasterxml.jackson..");

    @ArchTest
    static final ArchRule applicationKnowsNoAdapters =
            noClasses().that().resideInAPackage("..application..")
                    .should().dependOnClassesThat().resideInAPackage("..adapter..");

    @ArchTest
    static final ArchRule layers = layeredArchitecture()
            .consideringOnlyDependenciesInLayers()
            .layer("Domain").definedBy("..domain..")
            .layer("Application").definedBy("..application..")
            .layer("Adapters").definedBy("..adapter..")
            .layer("Config").definedBy("..config..")
            .whereLayer("Adapters").mayOnlyBeAccessedByLayers("Config")
            .whereLayer("Application").mayOnlyBeAccessedByLayers("Adapters", "Config")
            .whereLayer("Domain").mayOnlyBeAccessedByLayers("Application", "Adapters", "Config");
}
```

ArchUnit also ships `Architectures.onionArchitecture()`, which already knows about domain, application services and adapters. I start with the explicit rules above because the failure messages are easier to read for people who have never seen the tool.

Two rules I usually add next: JPA entities may only live in `..adapter.out.persistence..`, and classes annotated with `@RestController` only in `..adapter.in.web..`.

## When not to use it

Hexagonal is expensive: more files, more interfaces, mapping between JPA entities and the domain. It pays off when:

- the business rules are rich enough that isolating them reduces cognitive load;
- the system will live for years and pass through several teams;
- there are, or will be, several ways in (REST and Kafka triggering the same use case) or out (two payment gateways).

For a microservice that is basically CRUD over one table, controller → service → repository does the job and is more honest. Nor do you need to apply the pattern uniformly across a monorepo: use it where the domain calls for it. The cost of the architecture should be proportional to the size of the domain it protects.
