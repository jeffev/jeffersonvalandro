---
title: "Designing REST APIs that survive production"
description: "Resources, methods and idempotency, RFC 9457 errors, versioning and deprecation (RFC 9745), pagination, idempotency keys and webhooks."
slug: "design-de-apis"
theme: "arquitetura"
order: 4
cover: ""
replaces: ["api-design-best-practices"]
---

An API is a contract. Once clients start consuming it, every breaking change costs coordination, rushed fixes on the other side, and trust. API design decisions are among the most expensive to undo, which is why it pays to get them right early.

What follows are the decisions I apply to production REST APIs, almost all of them on Spring Boot: resource modeling, method semantics, error format, versioning, pagination, security at the edge, and webhooks.

## Resources and methods

REST is about resources, not actions. The URL identifies the resource and the method says what to do with it.

```text
GET    /orders              list orders
GET    /orders/{id}         one order
POST   /orders              create an order
PUT    /orders/{id}         replace the whole order
PATCH  /orders/{id}         partial change
DELETE /orders/{id}         remove (or cancel)
GET    /orders/{id}/items   items of an order

# avoid: verbs in the URL, RPC style
POST /getOrder
GET  /deleteOrder?id=123
```

Method properties, as RFC 9110 defines them:

- **GET, HEAD**: safe (no state change) and idempotent.
- **PUT, DELETE**: idempotent. Repeating the same request leaves the server in the same state.
- **POST**: neither safe nor idempotent.
- **PATCH**: **not idempotent in general** (RFC 5789). It depends on the patch format. A JSON Merge Patch (`application/merge-patch+json`) setting `{"status": "CANCELLED"}` gives the same result when repeated. A JSON Patch with `{"op": "add", "path": "/items/-", ...}` appends one more item on every repeat.

This has a practical consequence: clients, proxies and retry libraries may automatically repeat idempotent methods after a timeout. Do not treat PATCH as safe to retry unless your format guarantees it or you require an idempotency key (see below).

### Actions that do not fit CRUD

Confirming an order, resending an email, archiving a document. Two ways out:

- **State transition**: `PATCH /orders/{id}` with `{"status": "CONFIRMED"}`. Good when the action really is just a state change.
- **Action sub-resource**: `POST /orders/{id}/confirmation`. Better when the action carries rules and side effects (charging, notifying, reserving stock). I prefer a noun here, modeling the action as a resource being created.

## Meaningful status codes

Clients build logic on top of status codes. Returning 200 for everything, errors included, forces the client to parse the body to know whether it worked.

```text
200 OK                 read or change with a body
201 Created            creation; include a Location header
204 No Content         success with no body
400 Bad Request        malformed or invalid request
401 Unauthorized       not authenticated or bad credentials
403 Forbidden          authenticated but not allowed
404 Not Found          resource does not exist
409 Conflict           state conflict (duplicate, stale version)
422 Unprocessable      syntax fine, business rule violated
429 Too Many Requests  limit exceeded; include Retry-After
500 Internal Error     unexpected failure, no stack traces
503 Unavailable        a dependency is down; include Retry-After
```

## Errors in RFC 9457 format

Do not invent an error envelope. RFC 9457 (*Problem Details for HTTP APIs*, which replaced RFC 7807) defines a format with the `application/problem+json` media type and the members `type`, `title`, `status`, `detail` and `instance`. It allows extension members, which is where the list of validation errors and the trace ID go.

```json
{
  "type": "https://api.example.com/problems/validation-error",
  "title": "Invalid data",
  "status": 400,
  "detail": "Two fields failed validation.",
  "instance": "/v1/orders",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "errors": [
    { "field": "email", "code": "INVALID_FORMAT", "message": "Invalid email" },
    { "field": "amount", "code": "OUT_OF_RANGE", "message": "Must be between 0.01 and 999999" }
  ]
}
```

`type` is a URI identifying the *kind* of problem, and it should point to a page explaining the error. Clients branch on `type` and `code`, never on the `title` text, which may be translated.

Spring 6 and Spring Boot 3 ship a `ProblemDetail` class. Extending `ResponseEntityExceptionHandler` makes Spring MVC's own exceptions (validation, unsupported method, unreadable body) come out in this format; without your own advice, the `spring.mvc.problemdetails.enabled=true` property does the same. Your exceptions go into the same `@RestControllerAdvice`:

```java
@RestControllerAdvice
class ApiErrors extends ResponseEntityExceptionHandler {

    @ExceptionHandler(BusinessRuleViolation.class)
    ProblemDetail onBusinessRule(BusinessRuleViolation ex) {
        ProblemDetail problem = ProblemDetail.forStatusAndDetail(HttpStatus.UNPROCESSABLE_ENTITY, ex.getMessage());
        problem.setType(URI.create("https://api.example.com/problems/" + ex.code()));
        problem.setTitle("Business rule violated");
        problem.setProperty("code", ex.code());
        problem.setProperty("traceId", currentTraceId());
        return problem;
    }
}
```

The `traceId` is non-negotiable in production. When a client reports an error, you need to find that request in your tracing system within seconds.

## Versioning and deprecation

Three common approaches:

- **In the URL**: `/v1/orders`. Explicit, easy to route, cache and deprecate. It is what I use for public and partner APIs.
- **In a header or media type**: `Accept: application/vnd.example.v2+json`. Cleaner URLs, harder to test and share.
- **In the query string**: `?version=2`. Acceptable for internal APIs; it mixes versioning with filtering.

The policy matters more than the mechanism. Compatible changes (a new optional field, a new endpoint) do not need a new version. Breaking changes do, and the old version only goes away after formal notice. Two standardized headers exist for that:

```http
Deprecation: @1782864000
Sunset: <HTTP-date when the version stops responding>
Link: <https://developer.example.com/deprecations/orders-v1>; rel="deprecation"; type="text/html"
Link: <https://api.example.com/v2/orders>; rel="successor-version"
```

`Deprecation` comes from RFC 9745, and its value is a structured-field date: `@` followed by seconds since the Unix epoch. It can be in the past (already deprecated) or in the future (deprecation announced). `Sunset` comes from RFC 8594, uses the usual HTTP-date format, and must not be earlier than `Deprecation`. RFC 9745 also defines the `deprecation` link relation, pointing to documentation about the change. The gap between the two is a business decision; for a public API, months rather than weeks.

## Pagination

Never return an unbounded collection. A `GET /orders` that returns everything works until the day it takes down the database.

Offset pagination (`?page=3&size=20`) is simple, but unstable under concurrent writes (an insert on the first page makes items skip or repeat) and slow at high offsets, because the database still walks the skipped rows. For collections that change, prefer **cursor** (or *keyset*) pagination:

```http
GET /v1/orders?limit=20&cursor=eyJjcmVhdGVkQXQiOiIuLi4iLCJpZCI6MTQzfQ
```

```json
{
  "data": [ ... ],
  "page": { "limit": 20, "nextCursor": "eyJjcmVhdGVkQXQiOiIuLi4iLCJpZCI6MTYzfQ", "hasMore": true }
}
```

The cursor is opaque to the client, but inside it is just the sort key of the last item. The query becomes `WHERE (created_at, id) < (:createdAt, :id) ORDER BY created_at DESC, id DESC FETCH FIRST 20 ROWS ONLY`, which uses an index and does not depend on how many pages came before.

## Security and robustness at the edge

### Validation

Validate at the boundary, before anything reaches business logic:

```java
public record PlaceOrderRequest(
        @NotBlank @Size(max = 50) String customerId,
        @NotEmpty @Size(max = 100) List<@Valid OrderItemRequest> items,
        @NotNull @DecimalMin("0.01") @DecimalMax("999999") BigDecimal totalAmount) {}
```

Bean Validation handles shape. Rules that depend on state (is the customer active? is there credit?) belong in the domain and become 422, not 400.

### Identifiers and leaks

Do not expose sequential IDs as public identifiers, which lets anyone enumerate resources, nor stack traces, table names or server versions. A UUID (preferably v7, time-ordered and index-friendly) or an opaque token solves the first problem; a central error handler solves the second.

### Rate limiting

Do it at the gateway, return 429 with `Retry-After`, and expose the limit so clients can slow down. The `X-RateLimit-*` headers are an industry convention, not a standard; there is an IETF draft for standardized `RateLimit` headers that has not been published as an RFC yet.

### Idempotency keys

POST is not idempotent. If the network drops between client and server during a charge, the client cannot tell whether the charge happened, and retrying may charge twice. The fix is for the client to generate one key per logical operation and send it in a header:

```http
POST /v1/payments
Idempotency-Key: 8e03978e-40d5-43e8-bc93-6894a57f9324
Content-Type: application/json

{"customerId": "cust_123", "amountInCents": 5000, "currency": "BRL"}
```

The server stores `(key, body hash, response)` for a while. A second request with the same key and body gets the stored response without running again; the same key with a different body is a client error (422). While the first one is still in progress, the second gets 409. The `Idempotency-Key` header is an IETF draft and is already used by payment APIs such as Stripe's.

## Contract first with OpenAPI

Write the contract in OpenAPI before the code and generate server interfaces with `openapi-generator` (the `spring` generator with `interfaceOnly=true`). The controller implements the generated interface, and the build breaks if the implementation drifts from the contract. Documentation stops being an artifact that ages on the side.

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
        '201': { description: Order created }
        '400': { $ref: '#/components/responses/Problem' }
        '422': { $ref: '#/components/responses/Problem' }
```

## Webhooks

A webhook flips the direction: the server tells the client when something happens. Three precautions solve almost every problem.

**An envelope with a unique ID.** Every event carries an `id`, a `type`, a creation instant and the data. The `id` is the idempotency key on the receiving side.

**Signatures.** To the receiver, a webhook is just another HTTP request; without a signature, anyone who finds the URL can send fake events. Sign the raw body with HMAC-SHA256 and include a timestamp in the signed message to block replays. The open Standard Webhooks specification standardizes exactly this, with the `webhook-id`, `webhook-timestamp` and `webhook-signature` headers.

```java
static boolean isValid(String id, String timestamp, byte[] body, String receivedSignature, byte[] secret)
        throws GeneralSecurityException {
    long age = Math.abs(Instant.now().getEpochSecond() - Long.parseLong(timestamp));
    if (age > 300) return false; // outside the 5-minute window: possible replay

    Mac mac = Mac.getInstance("HmacSHA256");
    mac.init(new SecretKeySpec(secret, "HmacSHA256"));
    mac.update((id + "." + timestamp + ".").getBytes(StandardCharsets.UTF_8));
    byte[] expected = mac.doFinal(body);

    byte[] received = Base64.getDecoder().decode(receivedSignature);
    return MessageDigest.isEqual(expected, received); // constant-time comparison
}
```

Never compare signatures with `equals`: ordinary comparison stops at the first differing byte and leaks timing information. `MessageDigest.isEqual` compares in constant time.

**Respond fast, process later.** The sender will retry on a timeout or any non-2xx response, usually with exponential backoff. The receiver verifies the signature, records the `id` and enqueues the work, then returns 2xx. If the `id` was already seen, it returns 2xx and drops the event so the retries stop. Heavy work inside the handler leads to timeouts, which lead to redelivery, which leads to duplicate processing.

## Wrapping up

Almost everything here comes down to two ideas. First, respect the semantics HTTP already defines (methods, status codes, standardized headers) instead of inventing your own, because that is what clients, proxies and libraries rely on. Second, treat failure as the normal case: retries, duplicates, old versions and malicious clients will all happen, and the API needs a ready answer for each one.
