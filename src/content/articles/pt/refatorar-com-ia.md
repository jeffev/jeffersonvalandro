---
title: "Refatorar com IA sem quebrar o que funciona"
description: "Um fluxo seguro para refatorar com assistentes de IA: testes de caracterização, uma técnica por vez, checagem de comportamento e os vícios do código gerado."
slug: "refatorar-com-ia"
theme: "ia"
order: 1
cover: ""
replaces: ["refactoring-with-ai", "clean-code-with-ai", "solid-with-ai", "design-patterns-with-ai"]
---

Refatorar tem uma definição precisa: mudar a estrutura interna do código sem mudar o comportamento externo. Não é reescrever, não é adicionar funcionalidade, não é corrigir bug. É deixar a próxima mudança mais barata sem quebrar o que funciona hoje.

Assistentes de IA mudam essa disciplina de dois jeitos. Eles encontram code smells mais rápido e com mais constância do que uma leitura manual, e aplicam técnicas conhecidas (Extract Method, Introduce Parameter Object, Replace Conditional with Polymorphism) em segundos. O risco também é real: o modelo pode mudar o comportamento enquanto afirma que preservou. A disciplina está em saber usar com segurança.

## O contrato: só estrutura

A frase mais útil que eu coloco num pedido de refatoração é esta:

```text
Isto é uma refatoração estrutural. Não corrija bugs, não melhore algoritmos,
não adicione tratamento de erro e não mude comportamento, mesmo que veja
oportunidade. Se encontrar algo que pareça bug, liste separadamente no final.
```

Sem ela, o modelo tende a "aproveitar" a refatoração para consertar o que parece errado. Às vezes o "bug" é comportamento de que alguém depende, e a correção some no meio de um diff estrutural que ninguém consegue revisar direito. Bug encontrado vira outro ticket e outro commit.

## O fluxo seguro

Refatorar sem testes não é refatorar, é apostar. A sequência que eu sigo:

1. **Travar o comportamento com testes.** Se o código não tem testes, o primeiro passo é escrever testes de caracterização.
2. **Uma técnica por vez.** Nada de "melhore este código". Peça "aplique Extract Method nesta função". Misturar várias refatorações num passo impede saber qual delas causou o problema.
3. **Rodar os testes depois de cada passo.** Verde, commit. Vermelho, reverte e entende antes de seguir.
4. **Checar a afirmação de que nada mudou.** Antes de aceitar, peça ao modelo para comparar as duas versões (o prompt está mais abaixo).

### Testes de caracterização

Eles documentam o que o código *faz*, não o que deveria fazer. A ideia é do Michael Feathers, em *Working Effectively with Legacy Code*, e combina muito bem com IA, porque escrever esse tipo de teste é trabalho mecânico e extenso.

```text
Escreva testes de caracterização para esta função. O objetivo NÃO é provar que
o comportamento está correto, e sim travar o comportamento atual para que
qualquer refatoração que mude a saída seja detectada.
- Nome de cada teste: O QUE a função devolve para QUAL entrada.
- Cubra entradas típicas, limites, vazio/nulo e condições de erro.
- Não corrija nada: teste como está, mesmo que pareça errado.
No final, liste comportamentos que parecem suspeitos, para eu decidir
separadamente se são bugs.
```

A lista de comportamentos suspeitos no final costuma ser a parte mais valiosa da sessão.

### Inventário antes da mudança

Antes de aplicar qualquer técnica, peça um inventário priorizado:

```text
Audite este código em busca de oportunidades de refatoração. Para cada smell:
nome (Long Method, Feature Envy, Data Clump...), trechos afetados, técnica que
resolve e impacto em legibilidade e facilidade de mudança (baixo/médio/alto).
Ordene por impacto. Não gere o código refatorado ainda.
```

O "não gere ainda" é proposital. Se o modelo já entrega o código, você pula a etapa de decidir se cada mudança vale o custo. A priorização é sua.

## As técnicas que mais uso

### Extract Method

A técnica mais frequente. O gatilho é um bloco dentro de uma função que poderia ser descrito por um nome diferente do nome da função. Comentários do tipo `// busca o usuário` e `// calcula o resumo` são dicas diretas: cada um é uma extração esperando nome.

```typescript
// depois da extração: a função principal vira um índice do que acontece
function generateMonthlyReport(userId: string, month: number, year: number): MonthlyReport {
  const user = findUserOrThrow(userId);
  const period = monthRange(month, year);
  const transactions = findTransactions(userId, period);
  return toReport(user, { month, year }, summarize(transactions), transactions);
}

function summarize(transactions: Transaction[]): Summary {
  const sum = (type: TransactionType) =>
    transactions.filter(t => t.type === type).reduce((acc, t) => acc + t.amount, 0);
  const totalIn = sum('credit');
  const totalOut = sum('debit');
  return { totalIn, totalOut, balance: totalIn - totalOut };
}
```

Peça que os nomes descrevam a intenção, não repitam o comentário.

### Introduce Parameter Object

Quando os mesmos três ou quatro parâmetros aparecem juntos em várias assinaturas (`origem, destino, partida, retorno`), eles são um conceito sem nome. O objeto novo deve validar os próprios invariantes:

```typescript
class FlightRoute {
  constructor(
    readonly origin: string,
    readonly destination: string,
    readonly departure: Date,
    readonly returnDate?: Date,
  ) {
    if (!origin || !destination) throw new Error('Origin and destination are required');
    if (returnDate && returnDate < departure) throw new Error('Return must be after departure');
  }

  get isRoundTrip(): boolean {
    return this.returnDate !== undefined;
  }
}

// as assinaturas passam a receber o conceito, não os quatro valores soltos
declare function searchFlights(route: FlightRoute): Promise<Flight[]>;
declare function bookFlight(route: FlightRoute, passengerId: string): Promise<Booking>;
```

Repare que a validação no construtor é comportamento novo. Se as funções antigas não validavam, isso é uma mudança e merece commit próprio.

### Replace Conditional with Polymorphism, sem quebrar a API

Quando o mesmo `switch` por tipo aparece em vários métodos, o tipo deveria carregar o comportamento.

```typescript
type ShippingType = 'standard' | 'express' | 'overnight';
interface Order { shippingType: ShippingType; weight: number; }

// antes: o mesmo switch em três métodos
export class Shipping {
  calculateCost(order: Order): number {
    switch (order.shippingType) {
      case 'standard': return order.weight * 2.5;
      case 'express': return order.weight * 5.0 + 10;
      case 'overnight': return order.weight * 8.0 + 25;
    }
  }
  estimateDeliveryDays(order: Order): number {
    switch (order.shippingType) {
      case 'standard': return 7;
      case 'express': return 3;
      case 'overnight': return 1;
    }
  }
  getCarrierCode(order: Order): string {
    switch (order.shippingType) {
      case 'standard': return 'STD-01';
      case 'express': return 'EXP-02';
      case 'overnight': return 'OVN-03';
    }
  }
}
```

Um erro comum, inclusive em respostas de IA, é aproveitar para trocar a API: os chamadores passam a usar `Shipping.for(tipo).calculateCost(...)`. Isso deixou de ser refatoração; é uma mudança de interface que obriga a mexer em todos os chamadores. A versão que preserva o contrato mantém os três métodos públicos com as mesmas assinaturas e move só o conteúdo:

```typescript
interface ShippingRule {
  cost(order: Order): number;
  deliveryDays: number;
  carrierCode: string;
}

const RULES: Record<ShippingType, ShippingRule> = {
  standard: { cost: o => o.weight * 2.5, deliveryDays: 7, carrierCode: 'STD-01' },
  express: { cost: o => o.weight * 5.0 + 10, deliveryDays: 3, carrierCode: 'EXP-02' },
  overnight: { cost: o => o.weight * 8.0 + 25, deliveryDays: 1, carrierCode: 'OVN-03' },
};

// depois: mesma classe, mesmos métodos, mesmas assinaturas
export class Shipping {
  calculateCost(order: Order): number {
    return RULES[order.shippingType].cost(order);
  }
  estimateDeliveryDays(order: Order): number {
    return RULES[order.shippingType].deliveryDays;
  }
  getCarrierCode(order: Order): string {
    return RULES[order.shippingType].carrierCode;
  }
}
```

Os chamadores não mudam, os testes de caracterização continuam válidos, e um tipo novo de frete é uma entrada nova no mapa (o `Record` faz o compilador exigir a entrada quando o tipo for adicionado à união). Se depois fizer sentido expor `ShippingRule` diretamente, isso é um segundo passo, com a mudança de API explícita no commit.

Esse exemplo também mostra por que a checagem de comportamento importa. Se `shippingType` vier de um JSON externo com um valor inesperado, o `switch` original devolve `undefined` e a versão nova lança `TypeError` ao acessar `RULES[...]`. A diferença só aparece em tempo de execução, e só alguém procurando por ela vai encontrar.

### Move Method e Extract Class

Um método que só usa dados de outra classe (feature envy) vai para a classe dona dos dados. Uma classe cujos campos e métodos formam dois grupos que não se falam (identidade e endereço num `User`, por exemplo) vira duas, com composição. São refatorações em que a IA acerta muito, porque o critério é visível no próprio código.

## A checagem de comportamento

Depois de cada refatoração gerada, antes de aceitar:

```text
Compare a versão original e a refatorada e liste cada caso em que podem se
comportar diferente:
1. Retornos: todos os caminhos são equivalentes?
2. Exceções: a nova lança onde a original não lançava, ou engole o que a
   original propagava?
3. Efeitos colaterais: algo escrito, logado ou emitido de forma diferente?
4. Nulo e ausente: alguma trata valor ausente de outro jeito?
5. Curto-circuito: alguma extração muda quando a avaliação para?
6. Mutação: algum objeto passa a ser (ou deixa de ser) alterado no lugar?
Para cada diferença, diga se é intencional ou não.
```

Ela pega a maioria das mudanças silenciosas, mas não substitui os testes. É uma segunda leitura, não uma prova.

## Os vícios do código que a IA escreve

Refatorar com IA também significa refatorar *o que a IA gerou*. Alguns padrões aparecem com tanta frequência que vale procurar ativamente:

- **Função que faz tudo.** Se o pedido descreve cinco responsabilidades, o modelo entrega uma função com cinco responsabilidades. Ele cumpriu o que foi pedido. Divida o pedido antes de enviar.
- **Defesa em excesso.** Checagens de nulo e de tipo em parâmetros internos que já chegaram validados, e `try/catch` que troca uma exceção específica por uma genérica. Valide na fronteira do sistema e confie no contrato por dentro.
- **Números mágicos.** `>= 3` e `* 0.95` espalhados pelo código. Peça para extrair limites e taxas como constantes nomeadas.
- **Estilo destoante.** O modelo não conhece as convenções do time. Cole um trecho existente no pedido ("siga este padrão") e a saída melhora muito.
- **Extração demais.** Um bloco de três linhas vira função, dois passos viram duas funções, e entender o fluxo exige pular entre dez arquivos. Extraia quando o nome novo acrescenta informação, não só porque o bloco é separável.
- **Abstração prematura.** Strategy, factory e registry para um caso que tem duas variantes e não vai ter terceira. Esse merece uma seção própria.

## Inversão de dependência sem exagero

O DIP diz que módulos de alto nível não devem depender de módulos de baixo nível; os dois dependem de abstrações. Na prática, um `OrderService` que faz `new PostgresOrderRepository()` no construtor amarra regra de negócio a banco: trocar o banco exige mexer na regra, e testar a regra exige banco. Injetar a dependência pelo construtor, tipada por uma interface que o próprio serviço define, resolve as duas coisas.

O exagero oposto é criar interface para tudo, e a IA faz muito isso quando você pede "siga SOLID". Interface tem custo: mais um arquivo, mais uma indireção. Ela se paga quando existem duas implementações (a de produção e um fake de teste já contam) ou quando você quer proteger um módulo estável de um detalhe volátil, como um gateway de pagamento de terceiros. Uma interface com uma única implementação e nenhum teste usando outra é cerimônia.

## O teste do padrão

Antes de aceitar um padrão de projeto sugerido pela IA, faça uma pergunta: **que mudança concreta e provável este padrão torna mais fácil?**

Se a resposta for "nenhuma que eu consiga imaginar hoje", o padrão está adicionando indireção sem flexibilidade. Um Strategy com uma estratégia, um Observer entre dois métodos da mesma classe, uma Facade sobre duas chamadas internas: tudo isso deixa o código atual mais difícil de ler em troca de uma flexibilidade que talvez nunca seja usada. Se a mudança for provável (um terceiro meio de pagamento já está no roadmap), o padrão se paga. Três linhas parecidas são melhores do que a abstração errada.

## Uma sequência para código legado

Para a classe de 500 linhas, sem teste e sem dono claro:

1. **Entender antes de mexer.** Peça uma explicação seção por seção, com entradas, saídas, efeitos colaterais e dependências externas, sem sugestões.
2. **Testes de caracterização** para o que você entendeu.
3. **Renomear primeiro.** Nome bom não custa nada e clareia todo o resto.
4. **Extract Method** nos blocos marcados por comentário.
5. **Extract Class** quando os agrupamentos ficarem visíveis.
6. **Polimorfismo por último.** É a mudança estrutural mais profunda e só fica clara quando o resto já está bem nomeado e extraído.

Há um efeito que se acumula a favor: código bem estruturado gera sugestões melhores. O modelo raciocina muito melhor sobre uma função curta e bem nomeada do que sobre um bloco de duzentas linhas emaranhado. Cada sessão de refatoração deixa o código mais fácil para a próxima, com ou sem IA.

O que a ferramenta não substitui é o julgamento sobre quando abstrair e quando deixar inline, quando a terceira repetição justifica uma função compartilhada e quando é coincidência, quando um nome está errado porque o conceito de negócio mudou. Use a IA para tirar o atrito mecânico (nomes, extrações, testes, consistência) e gaste o tempo economizado nessas decisões.
