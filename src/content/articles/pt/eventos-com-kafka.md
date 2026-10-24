---
title: "Comunicação entre serviços e eventos com Kafka"
description: "Quando usar chamada síncrona ou evento, partições e ordem por chave, outbox, consumidor idempotente, saga e event sourcing em Java com Spring Kafka."
slug: "eventos-com-kafka"
theme: "arquitetura"
order: 3
cover: ""
replaces: ["event-driven-architecture", "microservices-communication"]
---

Quando um monólito vira serviços, chamada de método vira chamada de rede. Isso muda tudo: agora existem latência, falha parcial, retry, descoberta de serviço e transação distribuída. Como os serviços conversam é uma das decisões mais caras de errar, e uma das menos discutidas.

Kafka entra muito nessa conversa, às vezes pelo motivo errado ("todo mundo usa"). Resultado comum: um sistema mais difícil de entender que o monólito, com toda a operação de um sistema distribuído e nenhum dos benefícios. Este texto organiza quando usar cada forma de comunicação e como acertar os detalhes que dão problema em produção.

## Síncrono ou assíncrono

A regra que eu uso: **se quem chama precisa do resultado para continuar, é síncrono. Se só precisa avisar que algo aconteceu, é assíncrono.**

Buscar o limite de crédito antes de aprovar um pedido é síncrono: sem a resposta, não há o que fazer. Avisar que o pedido foi aprovado para que faturamento, estoque e notificação façam sua parte é assíncrono: o serviço de pedidos não precisa saber o que cada um faz.

A chamada síncrona é simples de entender e dá consistência imediata, mas acopla no tempo (se B cai, A falha), no comportamento (A precisa saber o que B faz) e na escala (B precisa aguentar o pico de A). O evento desacopla os três, ao custo de consistência eventual, consumidores idempotentes e depuração mais difícil.

### REST, gRPC e o gateway

Para chamada síncrona, REST com JSON segue sendo a melhor escolha para APIs externas: qualquer cliente entende, e depurar com `curl` é trivial. Entre serviços internos, gRPC tem vantagens concretas: contrato em `.proto` com stubs gerados, Protobuf binário sobre HTTP/2, streaming de primeira classe e *deadlines* propagados em toda chamada.

```protobuf
syntax = "proto3";
package orders;

service OrderService {
  rpc PlaceOrder (PlaceOrderRequest) returns (PlaceOrderResponse);
  rpc StreamOrderUpdates (OrderId) returns (stream OrderEvent);
}
```

Um arranjo comum: REST na borda, através de um API gateway que concentra autenticação, rate limiting e roteamento, e gRPC por dentro. Service mesh (Istio, Linkerd) leva mTLS, retry e timeout para a infraestrutura, mas tem custo operacional alto; só compensa com muitos serviços e necessidades reais de gestão de tráfego.

Descoberta de serviço: no Kubernetes, o próprio `Service` resolve, com balanceamento no lado do servidor. Fora dele, Spring Cloud LoadBalancer com Consul ou Eureka faz o balanceamento no cliente.

## Kafka: o que precisa estar claro

### Tópicos, partições e chave

Um tópico é um log durável e particionado. A partição é a unidade de paralelismo e de ordem: **dentro de uma partição, a ordem é garantida; entre partições, não.**

Quem decide a partição é a chave da mensagem. O particionador padrão faz hash da chave e divide pelo número de partições, então mesma chave cai sempre na mesma partição. Para pedidos, a chave é o ID do pedido, e todos os eventos de um pedido são processados em sequência.

```java
@Component
class OrderEventPublisher {
    private final KafkaTemplate<String, OrderEvent> kafka;

    OrderEventPublisher(KafkaTemplate<String, OrderEvent> kafka) { this.kafka = kafka; }

    CompletableFuture<SendResult<String, OrderEvent>> publish(OrderEvent event) {
        // chave = orderId: todos os eventos do mesmo pedido na mesma partição
        return kafka.send("orders", event.orderId(), event);
    }
}
```

### Grupos de consumidores e o limite das partições

Num grupo de consumidores, cada partição é atribuída a exatamente um consumidor do grupo. Com 12 partições e 4 instâncias, cada uma lê 3. Uma décima terceira instância fica ociosa: **o número de partições é o teto de paralelismo do grupo.** Serviços diferentes usam grupos diferentes e cada grupo tem seu próprio offset; faturamento e notificação leem todos os eventos, independentemente.

Aqui está o detalhe que costuma ser explicado errado: **o número de partições de um tópico não pode ser reduzido, só aumentado. E aumentar quebra a ordem por chave.** Como a partição é `hash(chave) % número_de_partições`, ao passar de 12 para 16 boa parte das chaves muda de partição. Eventos novos de um pedido vão para a partição nova enquanto os antigos ainda podem estar esperando na partição velha, e o consumidor pode processar o evento 5 antes do 4.

Então dimensione com folga desde o início, pensando no paralelismo que você vai precisar, não no de hoje. Se precisar mudar de verdade, o caminho seguro é criar um tópico novo com o número certo de partições e migrar produtores e consumidores de forma controlada.

## Outbox: gravar e publicar sem perder evento

O bug mais comum e mais caro em sistemas orientados a eventos: a aplicação grava no banco, depois publica no Kafka, e cai entre as duas coisas. O banco tem o pedido, o evento nunca saiu, e ninguém fica sabendo. Inverter a ordem não resolve, só troca o problema: evento publicado de um pedido que não existe.

O padrão outbox resolve com a transação que você já tem. Na mesma transação que altera o estado, grava-se o evento numa tabela `outbox`. Um processo separado lê essa tabela e publica.

```java
@Service
class PlaceOrderHandler {
    private final OrderRepository orders;
    private final OutboxRepository outbox;
    private final ObjectMapper json;

    // construtor omitido

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

Para publicar, há duas opções. A simples é um job agendado que lê linhas não publicadas com `SELECT ... FOR UPDATE SKIP LOCKED` (Oracle e Postgres suportam), publica e marca. A mais robusta é CDC com Debezium, que lê o log de transações do banco (WAL no Postgres, redo log via LogMiner no Oracle) e publica sem polling; o Debezium tem até um roteador específico para tabelas outbox.

Nos dois casos a entrega é *pelo menos uma vez*: se o relay publicar e cair antes de marcar, o evento sai de novo. Por isso o outro lado precisa ser idempotente.

## Consumidor idempotente

Você vai receber o mesmo evento duas vezes. Não é hipótese: rebalanceamento, retry e o próprio outbox garantem isso. Processar duas vezes precisa ter o mesmo efeito que processar uma.

A forma mais simples é registrar o ID do evento numa tabela com chave única, na mesma transação do efeito:

```java
@Component
class BillingListener {
    private final ProcessedEventRepository processed;
    private final InvoiceService invoices;

    // construtor omitido

    @KafkaListener(topics = "orders", groupId = "billing")
    @Transactional
    void on(OrderPlaced event) {
        if (processed.existsById(event.eventId())) return;
        invoices.createFor(event);
        processed.save(new ProcessedEvent(event.eventId(), Instant.now()));
        // a chave primária em processed_event barra a corrida entre duas instâncias
    }
}
```

## Mensagem venenosa e dead letter topic

Se um evento não pode ser processado (payload inválido, bug), tentar para sempre trava a partição inteira. O Spring Kafka resolve isso com `@RetryableTopic`: tenta de novo em tópicos de retry com backoff, sem bloquear a partição principal, e depois manda para um dead letter topic.

```java
@RetryableTopic(attempts = "4", backoff = @Backoff(delay = 1000, multiplier = 2.0))
@KafkaListener(topics = "orders", groupId = "shipping")
void on(OrderPlaced event) {
    shipping.schedule(event);
}

@DltHandler
void onDeadLetter(OrderPlaced event, @Header(KafkaHeaders.RECEIVED_TOPIC) String topic) {
    log.error("Evento {} foi para {} após esgotar as tentativas", event.eventId(), topic);
}
```

Um cuidado: retry em tópico separado sacrifica a ordem por chave para aquele evento. Se ordem estrita importa, prefira `DefaultErrorHandler` com `DeadLetterPublishingRecoverer`, que tenta na própria partição (bloqueando-a durante as tentativas) e só depois publica no DLT.

## Contratos de evento

Evento é contrato. Mudar o formato sem coordenação quebra consumidores em silêncio. Com Schema Registry (Avro ou Protobuf), a compatibilidade é verificada na publicação. Em compatibilidade `BACKWARD`, o modo padrão, consumidores com o schema novo leem eventos antigos; adicionar campo opcional com default é seguro, renomear não é.

```json
{"name": "currency", "type": ["null", "string"], "default": null}
```

## Saga: transação que atravessa serviços

Num monólito, uma transação de banco cobre "criar pedido, reservar estoque, cobrar". Com cada serviço dono do seu banco, não existe transação global. A saga troca a transação distribuída por uma sequência de transações locais, cada uma com uma **compensação** que desfaz o efeito se um passo posterior falhar.

Na **coreografia**, cada serviço reage a eventos dos outros. Estoque ouve `OrderPlaced` e publica `InventoryReserved` ou `InventoryRejected`; pagamento ouve `InventoryReserved`; pedido ouve `PaymentFailed`, cancela e publica `OrderCancelled`; estoque ouve isso e libera a reserva. Não há ponto central, mas o fluxo só existe espalhado em cinco listeners. Funciona bem para sagas curtas.

Na **orquestração**, um componente conduz o fluxo, manda comandos e guarda o estado da saga. A regra fica num lugar só, mais fácil de testar e de depurar. Não precisa de framework:

```java
@Component
class PlaceOrderSaga {
    private final SagaStateRepository states;
    private final KafkaTemplate<String, Object> commands;

    // construtor omitido

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
                send(new CancelOrder(e.orderId(), "sem estoque"));
            }
        }
        states.save(saga);
    }

    private void send(OrderCommand command) {
        commands.send("order-commands", command.orderId(), command);
    }
}
```

`OrderSagaEvent` aqui é uma `sealed interface` com os cinco records, e o `switch` exaustivo garante que um evento novo não passe despercebido. Em produção, os comandos também saem por outbox, pelo mesmo motivo de antes.

Se preferir um framework, as opções reais são o Axon Framework (na linha 4.x, com `@Saga`, `@StartSaga`, `@SagaEventHandler` e `@EndSaga`), motores de workflow como Temporal ou Camunda, ou Eventuate Tram Sagas. Spring State Machine é outra coisa: modela máquinas de estado, não é um framework de saga.

## Event sourcing

Event sourcing vai além: em vez de guardar o estado atual, guarda a sequência de eventos, e o estado é derivado reaplicando-os.

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

Vale quando histórico é requisito de verdade: auditoria completa, consultas temporais ("qual era o status ontem às 14h?"), ou a necessidade de construir projeções novas a partir do passado. Não vale para "preciso de comunicação assíncrona entre serviços": para isso, outbox basta. Aplicar event sourcing em todas as entidades traz snapshots, versionamento de eventos e projeções para gerenciar, e o custo só se justifica nos agregados em que a história importa.

## Resumo prático

Comece pela pergunta "quem chama precisa da resposta?". Escolha a chave de partição pensando em qual ordem o negócio exige, e dimensione as partições com folga porque não dá para voltar atrás. Publique por outbox, consuma de forma idempotente, mande mensagem venenosa para DLT, versione os eventos com schema registry, e escolha entre coreografia e orquestração pelo tamanho do fluxo. Event sourcing fica para onde a história é o produto.
