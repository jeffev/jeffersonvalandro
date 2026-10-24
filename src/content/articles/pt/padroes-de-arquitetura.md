---
title: "Padrões de arquitetura: como escolher e como escalar"
description: "Monólito modular, camadas, microsserviços, eventos, hexagonal e serverless comparados, mais os três eixos de escala, cache e sharding."
slug: "padroes-de-arquitetura"
theme: "arquitetura"
order: 2
cover: ""
replaces: ["software-architectures", "scalable-architectures"]
---

Escolha de arquitetura é a decisão com a cauda mais longa num projeto. Um framework dá para trocar num fim de semana. A arquitetura define como o time se organiza, como faz deploy, como depura um incidente às três da manhã e como o sistema cresce, por anos.

Mesmo assim, a maioria dos times escolhe por inércia: o que já conhece, o que o framework sugere ou o que uma empresa grande publicou num blog. Este texto é um mapa de trade-offs para escolher de propósito, seguido da parte que costuma ser esquecida: como escalar o que foi escolhido.

## Os padrões, um por um

### Monólito (e monólito modular)

Uma unidade de deploy com tudo dentro. Não é palavrão. A maioria dos produtos que deram certo começou assim, e muitos deveriam continuar assim. Chamada entre componentes é chamada de método: sem rede, sem serialização, sem timeout.

Ele sofre quando o deploy vira gargalo (mexer numa funcionalidade arrisca todas) ou quando partes do sistema têm necessidades de escala muito diferentes.

O meio-termo que muita gente pula é o **monólito modular**: um deploy só, mas com módulos de fronteira clara e regras de dependência verificadas no build. Em Java isso pode ser feito com pacotes e ArchUnit, ou com Spring Modulith, que verifica as dependências entre módulos e oferece eventos entre eles dentro do mesmo processo. Quando um módulo precisar virar serviço, a fronteira já existe.

### Camadas (N-tier)

Apresentação, aplicação, domínio, infraestrutura; cada camada só depende da de baixo. É a estrutura que todo mundo aprende primeiro e a que o MVC sugere.

Funciona bem para sistemas com muito CRUD e pouca regra. O modo de falha clássico é o banco vazar para o domínio: entidade JPA cheia de regra de negócio, ou "domínio" que é só um espelho das tabelas. A separação só existe enquanto alguém defende, de preferência um teste automatizado.

### Hexagonal (portas e adaptadores)

Inverte a direção: o domínio fica no centro e não depende de nada; banco, HTTP e fila se conectam por portas (interfaces do núcleo) e adaptadores (implementações). Rende muito em domínios ricos, porque a regra é testável sem infraestrutura. Custa mais arquivos e mais mapeamento, e fica desproporcional num CRUD. Tem um artigo inteiro sobre isso nesta série, com Spring Boot e ArchUnit.

### Microsserviços

Serviços pequenos com deploy independente, cada um dono do seu contexto de domínio e do seu banco. Conversam por rede: REST, gRPC ou mensagens.

Fazem sentido quando vários times precisam entregar sem coordenar deploy, quando partes do sistema escalam de forma muito diferente, e quando o domínio já é bem entendido. Errar fronteira em microsserviço custa muito mais caro do que errar num monólito, porque mover uma responsabilidade de lugar vira migração de dados entre bancos.

O custo é real: cada chamada síncrona traz latência, timeout e falha parcial; consistência entre serviços exige saga e outbox; depurar exige tracing distribuído. Time que migra sem essa maturidade operacional costuma terminar com um sistema mais difícil de depurar do que o monólito que deixou.

E a regra das duas pizzas da Amazon fala de autonomia de time, não de tamanho de serviço. Nano-serviço, um endpoint por deploy, é um modo de falha conhecido.

### Orientada a eventos

Produtores publicam fatos, consumidores reagem, e o broker (Kafka, RabbitMQ, SNS/SQS) é o único contrato compartilhado. Adicionar um consumidor novo não exige mudar o produtor.

É ótima para fan-out (um pagamento confirmado dispara e-mail, analytics e estoque, cada um no seu ritmo), para absorver picos e para auditoria com replay. Cobra em depuração, em evolução de schema e em consistência eventual, que é uma restrição de produto e não só uma propriedade técnica. O artigo sobre eventos com Kafka desta série entra nos detalhes.

### Serverless

Funções implantadas num provedor que cuida de escala, patch e disponibilidade. Escala até zero e cobra por invocação.

Bom para carga irregular: webhooks, jobs agendados, processamento de arquivos, consumidores de evento. Ruim para API sensível a latência por causa do cold start (no Java, SnapStart na AWS e imagens nativas com GraalVM reduzem bastante, mas não eliminam), e o acoplamento aos eventos do provedor é lock-in de verdade.

### CQRS

Não é uma arquitetura inteira, é um padrão aplicado dentro de uma. O modelo de escrita, com validação e invariantes, é separado do modelo de leitura, uma projeção desnormalizada feita para a tela. Vale quando escrita e leitura têm formatos muito diferentes, como um pedido com fluxo de vinte passos e um painel com agregações. Num CRUD simples, só dobra o trabalho. Comece com um modelo e introduza CQRS quando conseguir descrever em uma frase a assimetria que ele resolve.

## Como escolher

Três perguntas resolvem a maior parte dos casos.

**Qual o tamanho do time e como ele se organiza?** Um time pequeno quase sempre vai melhor com um monólito (modular, de preferência). Vários times que precisam entregar de forma independente é o argumento mais forte para microsserviços. A Lei de Conway age de qualquer jeito: a arquitetura vai espelhar a organização.

**Quão complexo é o domínio?** Pouca regra, camadas bastam. Regra rica com invariantes, hexagonal se paga. Se você ainda não consegue descrever as fronteiras do domínio, não é hora de microsserviço.

**Qual a carga e a maturidade operacional?** Carga estável e conhecida: escale o monólito primeiro. Picos imprevisíveis: eventos ou serverless nos caminhos quentes. Sem gente cuidando de observabilidade e plataforma, microsserviços vão doer.

Sistemas reais misturam. Uma combinação que funciona bem: monólito modular com hexagonal por dentro para o núcleo, Kafka para integrar com outros sistemas, funções serverless para tarefas periféricas.

## Migrando: strangler fig

A pergunta mais comum não é "o que usar num projeto novo", é "como saio do que tenho". O padrão strangler fig, descrito por Martin Fowler, é a resposta padrão:

1. Coloque uma fachada (gateway ou proxy reverso) na frente do monólito.
2. Escolha um contexto para extrair, de preferência com fronteira de dados clara e muita mudança.
3. Construa o serviço novo respeitando o mesmo contrato.
4. Roteie o tráfego pela fachada, mantendo o código antigo até as métricas confirmarem.
5. Apague o código do monólito. Repita.

A lição que mais me custou: nunca extraia um serviço e mude o comportamento dele ao mesmo tempo. Extraia, valide paridade, depois evolua. Misturar os dois deixa qualquer incidente quase impossível de investigar.

## Os três eixos de escala

O *Scale Cube*, do livro *The Art of Scalability* (Abbott e Fisher), separa escala em três eixos:

- **Eixo X**: clonar. Várias instâncias idênticas atrás de um balanceador. Simples e eficaz para serviços sem estado.
- **Eixo Y**: decompor por função. É o eixo dos microsserviços: cada capacidade de negócio no seu serviço.
- **Eixo Z**: particionar por dado. Cada instância cuida de uma fatia (cliente, região, tenant). É o sharding.

Muitos times pulam direto para o Y. Normalmente o X resolve por muito tempo, desde que a aplicação não guarde estado em memória (sessão local, cache que precisa ser consistente entre instâncias).

## Cache: a primeira alavanca

Antes de réplica ou shard, cache. O padrão mais comum é o **cache-aside**: a aplicação consulta o cache, e num miss lê do banco e popula. Só o que é de fato pedido ocupa memória. No Spring isso é uma anotação:

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

O `sync = true` faz com que, numa mesma instância, só uma thread recalcule a chave em falta enquanto as outras esperam. Isso ataca o **cache stampede**: quando uma entrada popular expira e milhares de requisições vão juntas ao banco. Entre instâncias, as defesas são jitter no TTL (para as chaves não expirarem em sincronia) e renovação antecipada, recalculando um pouco antes de expirar enquanto ainda serve o valor antigo. O Caffeine tem isso pronto com `refreshAfterWrite`, para cache local.

Invalidação é a parte difícil. As três estratégias práticas:

- **TTL**: expira depois de N segundos. Simples; o TTL é a quantidade de dado velho que o negócio aceita ver.
- **Invalidar na escrita**: ao gravar, apague a entrada em vez de atualizá-la. A próxima leitura repopula. Evita a corrida em que duas escritas atualizam o cache fora de ordem.
- **Invalidação por evento**: a mudança publica um evento e os consumidores apagam suas entradas. Mais consistente, exige infraestrutura de eventos.

O *write-through*, que grava em cache e banco na mesma operação, funciona para dados muito lidos e pouco escritos, como catálogo ou configuração. Cada escrita paga duas latências.

## Banco: a escala progressiva

Servidor de aplicação sem estado escala trivialmente no eixo X. O banco é quase sempre o primeiro gargalo. Uma ordem razoável:

1. **Otimizar consulta e índice.** Parece óbvio, mas um plano de execução ruim vence qualquer arquitetura.
2. **Réplicas de leitura.** Escrita no primário, leitura nas réplicas. Funciona quando a carga é dominada por leitura e a aplicação tolera atraso de replicação. Cuidado com o fluxo "gravei e já li": quem acabou de salvar precisa ler do primário, ou vai achar que a gravação sumiu.
3. **Decomposição vertical.** Cada serviço com seu schema. É o eixo Y aplicado aos dados, e o preço é trocar JOIN por chamada de API ou por projeção alimentada por evento.
4. **Sharding horizontal.** Dados distribuídos por uma chave de shard; todas as linhas de um cliente no mesmo nó. Dá escala linear de escrita, mas consulta entre shards é cara, migração é dolorosa, e chave mal escolhida cria hotspot (um tenant gigante num shard só, ou uma chave baseada em data em que todo insert cai no último nó).

Sharding resolve um problema de vazão de escrita que a maioria dos sistemas nunca chega a ter. Times que fazem isso cedo passam mais tempo brigando com a complexidade do que entregando.

## Resiliência e observabilidade

Escala sem resiliência é frágil. Três padrões básicos, todos disponíveis no Resilience4j com integração ao Spring Boot:

- **Circuit breaker**: quando a taxa de falha de uma dependência passa do limite, as próximas chamadas falham na hora em vez de esperar timeout, evitando cascata.
- **Bulkhead**: pools separados por dependência, para que um banco lento não consuma as threads que atendem o usuário.
- **Retry com backoff exponencial e jitter**: falhas transitórias são normais, mas retry imediato piora um serviço já sobrecarregado.

E nada disso se opera sem observabilidade: métricas por serviço (taxa, erros, duração), logs estruturados com ID de correlação e tracing distribuído com OpenTelemetry. Log sozinho não diz qual das quinze chamadas causou o p99 de ontem.

## Fechando

A melhor arquitetura para hoje é aquela da qual você consegue sair quando o contexto mudar. Um monólito bem modularizado vira microsserviços aos poucos; um monólito sem fronteiras vira um sistema distribuído problemático. Comece pelo mais simples que atende, com fronteiras que permitam extrair depois, e escale na ordem: clonar, cachear, replicar, decompor, e só no fim particionar.
