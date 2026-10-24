---
title: "Arquitetura hexagonal com Spring Boot, do domínio ao teste"
description: "Portas e adaptadores em Java 21 e Spring Boot: domínio sem framework, fakes em vez de mocks e regras de dependência verificadas com ArchUnit."
slug: "arquitetura-hexagonal-spring"
theme: "arquitetura"
order: 1
cover: ""
replaces: ["hexagonal-architecture", "clean-architecture"]
---

A arquitetura hexagonal, que Alistair Cockburn chamou de *Ports and Adapters*, parte de uma ideia curta: o núcleo da aplicação não conhece o mundo de fora. Banco, HTTP, Kafka e cliente de API de terceiros são detalhes plugados por fora, e não código misturado com a regra de negócio.

A Clean Architecture do Robert C. Martin diz a mesma coisa com outro vocabulário. Lá são quatro círculos (entidades, casos de uso, adaptadores de interface, frameworks) e uma única regra: **dependências de código-fonte só apontam para dentro**. Na hexagonal são o núcleo, as portas e os adaptadores. Em projeto Java eu uso as duas juntas sem cerimônia: a separação entre entidade e caso de uso vem da Clean, e o nome das coisas (porta de entrada, porta de saída, adaptador) vem da hexagonal.

O ganho que justifica o custo não é estética. É poder testar a regra de negócio sem subir contexto do Spring, banco ou broker, e trocar infraestrutura sem reescrever o domínio.

## As três zonas

- **Domínio**: entidades, value objects e serviços de domínio. Java puro, sem `@Entity`, sem `@Component`, sem nada de `org.springframework`.
- **Aplicação**: os casos de uso e as **portas**. Porta de entrada é o que a aplicação oferece (`PlaceOrderUseCase`). Porta de saída é o que ela precisa (`OrderRepository`, `PaymentGateway`). As interfaces pertencem ao núcleo, não à infraestrutura.
- **Adaptadores**: implementações concretas. O controller REST chama uma porta de entrada; o adaptador JPA implementa uma porta de saída. Adaptador depende do núcleo, nunca o contrário.

Um detalhe que a hexagonal deixa mais claro que a Clean: existem adaptadores *de entrada* (quem dispara a aplicação: REST, consumidor Kafka, job agendado) e *de saída* (o que a aplicação aciona: banco, gateway de pagamento, producer).

## Estrutura de pacotes

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

## Domínio sem framework

A disciplina mais importante é esta: a entidade de domínio não importa nada de Spring ou JPA. Ela guarda invariantes, regras que valeriam mesmo sem software.

```java
package com.example.order.domain.model;

public record Money(BigDecimal amount, String currency) {
    public static final Money ZERO_BRL = new Money(BigDecimal.ZERO, "BRL");

    public Money {
        Objects.requireNonNull(amount);
        if (amount.signum() < 0) throw new DomainException("Valor não pode ser negativo");
        if (!currency.matches("[A-Z]{3}")) throw new DomainException("Moeda inválida: " + currency);
    }

    public Money add(Money other) {
        if (!currency.equals(other.currency)) throw new DomainException("Moedas diferentes");
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
        if (items.isEmpty()) throw new DomainException("Pedido precisa de ao menos um item");
        return new Order(OrderId.generate(), customerId, items, OrderStatus.PENDING);
    }

    // usado pelo adaptador de persistência para remontar o agregado
    public static Order restore(OrderId id, CustomerId customerId,
                                List<OrderItem> items, OrderStatus status) {
        return new Order(id, customerId, items, status);
    }

    public void confirm() {
        if (status != OrderStatus.PENDING)
            throw new DomainException("Só pedidos pendentes podem ser confirmados");
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

O método `restore` existe porque o banco precisa reconstruir um pedido já confirmado sem passar pela validação de criação. É um custo pequeno e explícito, melhor do que expor setters.

## Portas e caso de uso

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

Com `sealed` e records, o caso de uso trata os dois resultados com `switch` e o compilador avisa se aparecer um terceiro. O caso de uso em si é uma classe Java comum. Eu prefiro não colocar `@Service` nele: a montagem fica numa classe de configuração, e o pacote `application` continua sem depender do Spring.

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

E a transação? Ela é um detalhe de infraestrutura. Dá para colocar `@Transactional` num adaptador de entrada, ou envolver o caso de uso com `TransactionTemplate` na configuração. Se o time preferir anotar o serviço de aplicação, tudo bem, mas que seja uma decisão consciente e registrada na regra de arquitetura (mais abaixo).

## Adaptadores

O adaptador de persistência traduz entre o modelo de domínio e a entidade JPA. São duas classes diferentes de propósito: a JPA muda por motivos de banco (índice, coluna, lazy loading), a de domínio muda por motivos de negócio.

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

O controller só converte HTTP em comando e chama a porta de entrada. Se aparecer um `if` de regra de negócio aqui, ele está no lugar errado.

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

## Fakes em vez de mocks

Com o núcleo isolado, os testes do caso de uso rodam sem Spring. Dá para fazer isso com Mockito, e muita gente faz. Eu prefiro **fakes**: implementações reais e simples das portas, em memória.

A diferença aparece com o tempo. Um teste com mock verifica *chamadas* (`verify(repo).save(argThat(...))`); se você trocar `save` por `saveAll` numa refatoração, o teste quebra sem o comportamento ter mudado. Um teste com fake verifica *estado*: depois de fazer o pedido, ele está no repositório e confirmado? Esse teste sobrevive à refatoração.

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
    void confirmaPedidoQuandoPagamentoAprovado() {
        OrderId id = service.placeOrder(umPedidoValido());

        assertThat(orders.findById(id))
                .get()
                .extracting(Order::status)
                .isEqualTo(OrderStatus.CONFIRMED);
    }

    @Test
    void naoGravaPedidoQuandoPagamentoRecusado() {
        payments.declineNext("Saldo insuficiente");

        assertThatThrownBy(() -> service.placeOrder(umPedidoValido()))
                .isInstanceOf(PaymentDeclinedException.class);
        assertThat(orders.size()).isZero();
    }
}
```

O mesmo `InMemoryOrderRepository` serve para dezenas de testes e, de quebra, documenta o contrato da porta. Os adaptadores de verdade ganham testes de integração próprios, com Testcontainers subindo Oracle ou Postgres. A regra de negócio fica coberta pelos testes rápidos; o mapeamento JPA, pelos lentos. Cada um testa uma coisa.

Mock ainda tem lugar: quando o que importa é justamente a interação (garantir que um e-mail *não* foi enviado duas vezes, por exemplo) ou quando a porta é grande demais para valer um fake.

## Regra de dependência verificada pelo build

Arquitetura que depende só de disciplina humana se desfaz em seis meses. Alguém com pressa importa `jakarta.persistence.Column` dentro do domínio, o code review não pega, e pronto. Em Java a ferramenta para isso é o **ArchUnit**: as regras viram testes JUnit e quebram o build.

```java
@AnalyzeClasses(packages = "com.example.order", importOptions = ImportOption.DoNotIncludeTests.class)
class ArchitectureTest {

    @ArchTest
    static final ArchRule dominioNaoConheceFrameworks =
            noClasses().that().resideInAPackage("..domain..")
                    .should().dependOnClassesThat()
                    .resideInAnyPackage("org.springframework..", "jakarta.persistence..", "com.fasterxml.jackson..");

    @ArchTest
    static final ArchRule aplicacaoNaoConheceAdaptadores =
            noClasses().that().resideInAPackage("..application..")
                    .should().dependOnClassesThat().resideInAPackage("..adapter..");

    @ArchTest
    static final ArchRule camadas = layeredArchitecture()
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

O ArchUnit também tem `Architectures.onionArchitecture()`, que já conhece a ideia de domínio, serviços de aplicação e adaptadores. Eu começo com as regras explícitas acima porque a mensagem de erro fica mais fácil de entender para quem nunca viu a ferramenta.

Duas regras que costumo adicionar em seguida: entidades JPA só podem existir em `..adapter.out.persistence..`, e classes anotadas com `@RestController` só em `..adapter.in.web..`.

## Quando não usar

Hexagonal custa caro: mais arquivos, mais interfaces, mapeamento entre entidade JPA e domínio. Vale quando:

- a regra de negócio é rica o bastante para que isolá-la reduza a carga mental;
- o sistema vai viver anos e passar por vários times;
- existem, ou vão existir, várias formas de entrada (REST e Kafka disparando o mesmo caso de uso) ou de saída (dois gateways de pagamento).

Para um microsserviço que é basicamente CRUD sobre uma tabela, controller → service → repository resolve e é mais honesto. Também não precisa aplicar o padrão de forma uniforme num monorepo: use onde o domínio pede. O custo da arquitetura deveria ser proporcional ao tamanho do domínio que ela protege.
