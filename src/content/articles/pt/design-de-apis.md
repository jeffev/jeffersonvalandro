---
title: "Design de APIs REST que aguentam produção"
description: "Recursos, métodos e idempotência, erros no formato RFC 9457, versionamento e depreciação (RFC 9745), paginação, chaves de idempotência e webhooks."
slug: "design-de-apis"
theme: "arquitetura"
order: 4
cover: ""
replaces: ["api-design-best-practices"]
---

Uma API é um contrato. Depois que clientes começam a consumir, cada mudança incompatível custa coordenação, correção às pressas do outro lado e confiança. As decisões de design de uma API são das mais caras de desfazer, e por isso vale acertá-las no começo.

O que segue são as decisões que eu aplico em APIs REST de produção, quase todas com Spring Boot: modelagem de recursos, semântica dos métodos, formato de erro, versionamento, paginação, segurança na borda e webhooks.

## Recursos e métodos

REST trata de recursos, não de ações. A URL identifica o recurso e o método diz o que fazer com ele.

```text
GET    /orders              lista pedidos
GET    /orders/{id}         um pedido
POST   /orders              cria pedido
PUT    /orders/{id}         substitui o pedido inteiro
PATCH  /orders/{id}         alteração parcial
DELETE /orders/{id}         remove (ou cancela)
GET    /orders/{id}/items   itens de um pedido

# evite: verbos na URL, estilo RPC
POST /getOrder
GET  /deleteOrder?id=123
```

As propriedades dos métodos, como a RFC 9110 define:

- **GET, HEAD**: seguros (não alteram estado) e idempotentes.
- **PUT, DELETE**: idempotentes. Repetir a mesma requisição deixa o servidor no mesmo estado.
- **POST**: nem seguro nem idempotente.
- **PATCH**: **não é idempotente em geral** (RFC 5789). Depende do formato do patch. Um JSON Merge Patch (`application/merge-patch+json`) que define `{"status": "CANCELLED"}` dá o mesmo resultado se repetido. Já um JSON Patch com `{"op": "add", "path": "/items/-", ...}` acrescenta um item a cada repetição.

Isso tem consequência prática: clientes, proxies e bibliotecas de retry podem repetir automaticamente métodos idempotentes depois de um timeout. Não trate PATCH como seguro para retry, a não ser que o seu formato garanta isso ou que você exija uma chave de idempotência (mais abaixo).

### Ações que não cabem no CRUD

Confirmar pedido, reenviar e-mail, arquivar documento. Duas saídas:

- **Transição de estado**: `PATCH /orders/{id}` com `{"status": "CONFIRMED"}`. Boa quando a ação é de fato só uma mudança de estado.
- **Sub-recurso de ação**: `POST /orders/{id}/confirmation`. Melhor quando a ação tem regras e efeitos colaterais (cobrar, notificar, reservar estoque). Aqui eu prefiro um substantivo, que modela a ação como um recurso criado.

## Status HTTP com significado

Cliente constrói lógica em cima do status. Devolver 200 para tudo, inclusive erro, obriga o cliente a parsear o corpo para saber se deu certo.

```text
200 OK                 leitura ou alteração com corpo
201 Created            criação; inclua o header Location
204 No Content         sucesso sem corpo
400 Bad Request        requisição malformada ou inválida
401 Unauthorized       sem autenticação ou credencial inválida
403 Forbidden          autenticado, mas sem permissão
404 Not Found          recurso não existe
409 Conflict           conflito de estado (duplicado, versão desatualizada)
422 Unprocessable      sintaxe ok, regra de negócio violada
429 Too Many Requests  limite excedido; inclua Retry-After
500 Internal Error     falha inesperada, sem stack trace
503 Unavailable        dependência fora; inclua Retry-After
```

## Erros no formato RFC 9457

Não invente envelope de erro. A RFC 9457 (*Problem Details for HTTP APIs*, que substituiu a RFC 7807) define um formato com media type `application/problem+json` e os campos `type`, `title`, `status`, `detail` e `instance`. Ela permite membros de extensão, que é onde entram a lista de erros de validação e o ID de rastreamento.

```json
{
  "type": "https://api.example.com/problems/validation-error",
  "title": "Dados inválidos",
  "status": 400,
  "detail": "Dois campos não passaram na validação.",
  "instance": "/v1/orders",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "errors": [
    { "field": "email", "code": "INVALID_FORMAT", "message": "E-mail inválido" },
    { "field": "amount", "code": "OUT_OF_RANGE", "message": "Deve estar entre 0,01 e 999999" }
  ]
}
```

O `type` é um URI que identifica o *tipo* do problema e deveria apontar para uma página que explica o erro. O cliente decide a lógica pelo `type` e pelo `code`, nunca pelo texto do `title`, que pode ser traduzido.

O Spring 6 e o Spring Boot 3 trazem a classe `ProblemDetail` pronta. Estender `ResponseEntityExceptionHandler` faz as exceções do próprio Spring MVC (validação, método não suportado, corpo ilegível) saírem nesse formato; sem um advice próprio, a propriedade `spring.mvc.problemdetails.enabled=true` faz o mesmo. As suas exceções entram no mesmo `@RestControllerAdvice`:

```java
@RestControllerAdvice
class ApiErrors extends ResponseEntityExceptionHandler {

    @ExceptionHandler(BusinessRuleViolation.class)
    ProblemDetail onBusinessRule(BusinessRuleViolation ex) {
        ProblemDetail problem = ProblemDetail.forStatusAndDetail(HttpStatus.UNPROCESSABLE_ENTITY, ex.getMessage());
        problem.setType(URI.create("https://api.example.com/problems/" + ex.code()));
        problem.setTitle("Regra de negócio violada");
        problem.setProperty("code", ex.code());
        problem.setProperty("traceId", currentTraceId());
        return problem;
    }
}
```

O `traceId` é inegociável em produção. Quando um cliente reporta um erro, você precisa achar aquela requisição no tracing em segundos.

## Versionamento e depreciação

Três abordagens comuns:

- **Na URL**: `/v1/orders`. Explícita, fácil de rotear, cachear e depreciar. É a que eu uso em APIs públicas e de parceiros.
- **Em header ou media type**: `Accept: application/vnd.example.v2+json`. URLs mais limpas, mas mais difícil de testar e compartilhar.
- **Em query string**: `?version=2`. Aceitável em API interna; mistura versão com filtro.

Mais importante que a forma é a política. Mudanças compatíveis (campo novo opcional, endpoint novo) não pedem versão nova. Mudanças incompatíveis pedem, e a versão antiga só sai depois de aviso formal. Para isso existem dois headers padronizados:

```http
Deprecation: @1782864000
Sunset: <data HTTP em que a versão deixa de responder>
Link: <https://developer.example.com/deprecations/orders-v1>; rel="deprecation"; type="text/html"
Link: <https://api.example.com/v2/orders>; rel="successor-version"
```

O `Deprecation` é da RFC 9745 e o valor é uma data no formato de *structured fields*: `@` seguido de segundos desde a época Unix. A data pode estar no passado (já depreciado) ou no futuro (depreciação anunciada). O `Sunset` é da RFC 8594, usa o formato de data HTTP comum e não pode ser anterior ao `Deprecation`. A RFC 9745 também define a relação de link `deprecation`, que aponta para a documentação da mudança. O prazo entre os dois é decisão de negócio; para API pública, meses, não semanas.

## Paginação

Nunca devolva coleção sem limite. Um `GET /orders` que devolve tudo funciona até o dia em que derruba o banco.

Paginação por offset (`?page=3&size=20`) é simples, mas instável com escrita concorrente (um insert na primeira página faz itens pularem ou repetirem) e fica lenta em offsets altos, porque o banco ainda percorre as linhas puladas. Para coleções que mudam, prefira **cursor** (ou *keyset*):

```http
GET /v1/orders?limit=20&cursor=eyJjcmVhdGVkQXQiOiIuLi4iLCJpZCI6MTQzfQ
```

```json
{
  "data": [ ... ],
  "page": { "limit": 20, "nextCursor": "eyJjcmVhdGVkQXQiOiIuLi4iLCJpZCI6MTYzfQ", "hasMore": true }
}
```

O cursor é opaco para o cliente, mas por dentro é só a chave de ordenação do último item. A consulta vira `WHERE (created_at, id) < (:createdAt, :id) ORDER BY created_at DESC, id DESC FETCH FIRST 20 ROWS ONLY`, que usa índice e não depende de quantas páginas já passaram.

## Segurança e robustez na borda

### Validação

Valide na fronteira, antes de chegar à regra de negócio:

```java
public record PlaceOrderRequest(
        @NotBlank @Size(max = 50) String customerId,
        @NotEmpty @Size(max = 100) List<@Valid OrderItemRequest> items,
        @NotNull @DecimalMin("0.01") @DecimalMax("999999") BigDecimal totalAmount) {}
```

Bean Validation cuida de formato. Regra que depende de estado (o cliente está ativo? tem limite?) fica no domínio e vira 422, não 400.

### Identificadores e vazamentos

Não exponha ID sequencial como identificador público, que permite enumerar recursos, nem stack trace, nome de tabela ou versão de servidor. UUID (de preferência v7, ordenável no tempo e amigável a índice) ou um token opaco resolve o primeiro problema; um handler de erro central resolve o segundo.

### Rate limiting

Faça no gateway, devolva 429 com `Retry-After` e informe o limite para que o cliente possa desacelerar. Os headers `X-RateLimit-*` são convenção de mercado, não padrão; existe um rascunho na IETF para headers `RateLimit` padronizados, ainda não publicado como RFC.

### Chave de idempotência

POST não é idempotente. Se a rede cai entre cliente e servidor durante uma cobrança, o cliente fica sem saber se a cobrança aconteceu, e tentar de novo pode cobrar duas vezes. A solução é o cliente gerar uma chave por operação lógica e enviar num header:

```http
POST /v1/payments
Idempotency-Key: 8e03978e-40d5-43e8-bc93-6894a57f9324
Content-Type: application/json

{"customerId": "cust_123", "amountInCents": 5000, "currency": "BRL"}
```

O servidor guarda `(chave, hash do corpo, resposta)` por um período. Uma segunda requisição com a mesma chave e o mesmo corpo recebe a resposta guardada, sem executar de novo; mesma chave com corpo diferente é erro do cliente (422). Enquanto a primeira ainda está em processamento, a segunda recebe 409. O header `Idempotency-Key` está em rascunho na IETF e já é usado por APIs de pagamento como a da Stripe.

## Contrato primeiro com OpenAPI

Escreva o contrato em OpenAPI antes do código e gere as interfaces do servidor com o `openapi-generator` (gerador `spring`, com `interfaceOnly=true`). O controller implementa a interface gerada, e o build quebra se a implementação divergir do contrato. A documentação deixa de ser um artefato que envelhece em paralelo.

```yaml
openapi: 3.1.0
info: { title: Order API, version: 1.0.0 }
paths:
  /v1/orders:
    post:
      operationId: placeOrder
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/PlaceOrderRequest' }
      responses:
        '201': { description: Pedido criado }
        '400': { $ref: '#/components/responses/Problem' }
        '422': { $ref: '#/components/responses/Problem' }
```

## Webhooks

Webhook inverte a direção: o servidor avisa o cliente quando algo acontece. Três cuidados resolvem quase todos os problemas.

**Envelope com ID único.** Todo evento leva `id`, `type`, instante de criação e os dados. O `id` é a chave de idempotência do lado de quem recebe.

**Assinatura.** Para quem recebe, um webhook é uma requisição HTTP como outra qualquer; sem assinatura, qualquer um que descubra a URL envia eventos falsos. Assine o corpo bruto com HMAC-SHA256 e inclua um timestamp na mensagem assinada para barrar replay. A especificação aberta Standard Webhooks padroniza exatamente isso, com os headers `webhook-id`, `webhook-timestamp` e `webhook-signature`.

```java
static boolean isValid(String id, String timestamp, byte[] body, String receivedSignature, byte[] secret)
        throws GeneralSecurityException {
    long age = Math.abs(Instant.now().getEpochSecond() - Long.parseLong(timestamp));
    if (age > 300) return false; // fora da janela de 5 minutos: possível replay

    Mac mac = Mac.getInstance("HmacSHA256");
    mac.init(new SecretKeySpec(secret, "HmacSHA256"));
    mac.update((id + "." + timestamp + ".").getBytes(StandardCharsets.UTF_8));
    byte[] expected = mac.doFinal(body);

    byte[] received = Base64.getDecoder().decode(receivedSignature);
    return MessageDigest.isEqual(expected, received); // comparação em tempo constante
}
```

Nunca compare assinaturas com `equals`: a comparação comum para no primeiro byte diferente e vaza informação de tempo. `MessageDigest.isEqual` compara em tempo constante.

**Responder rápido, processar depois.** Quem envia vai tentar de novo em caso de timeout ou resposta diferente de 2xx, normalmente com backoff exponencial. Quem recebe valida a assinatura, registra o `id` e enfileira o trabalho, devolvendo 2xx em seguida. Se o `id` já foi visto, responde 2xx e descarta, para que as tentativas parem. Trabalho pesado dentro do handler leva a timeout, que leva a reenvio, que leva a processamento duplicado.

## Fechando

Quase tudo aqui se resume a duas ideias. A primeira é respeitar a semântica que o HTTP já define (métodos, status, headers padronizados) em vez de inventar uma própria, porque é dela que clientes, proxies e bibliotecas dependem. A segunda é tratar falha como caso normal: retry, duplicata, versão antiga e cliente mal-intencionado vão acontecer, e a API precisa ter uma resposta pronta para cada um.
