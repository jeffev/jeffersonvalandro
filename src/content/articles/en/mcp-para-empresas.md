---
title: "MCP for software companies: giving your AI assistant the company's context"
description: "How to build an MCP server with your company's architecture, patterns and business rules, using Streamable HTTP, registerTool and OAuth authorization."
slug: "mcp-para-empresas"
theme: "ia"
order: 3
cover: ""
replaces: ["mcp-for-software-companies"]
---

Developers use AI assistants all day, and the assistant answers as if the system were generic. It does not know the team calls the payment flow "reconciliation", that no service calls the user service directly (everything goes through the identity gateway), or that an ADR banned a certain ORM pattern after an incident. Everyone either carries that context in their head or wastes time explaining it again in every conversation.

The Model Context Protocol (MCP) is the missing piece: a standard way to connect AI assistants to data sources and tools. For a software company, it turns architecture, patterns and business knowledge into context the assistant can look up when it needs to.

## What MCP is, precisely

MCP is an open protocol, created by Anthropic and now maintained under the Linux Foundation's Agentic AI Foundation. It defines how a client (Claude, Cursor, VS Code and others) talks to a server that provides context. The server exposes three kinds of primitives:

- **Tools**: functions the model decides to call ("find the ADR about caching", "who owns the billing service").
- **Resources**: data the client can read, addressed by URI: documents, schemas, runbooks.
- **Prompts**: ready-made prompt templates for common workflows, which the client surfaces to the user.

There are two standard transports. **stdio**, for local servers the client launches as a child process. And **Streamable HTTP**, for remote servers: a single HTTP endpoint that receives JSON-RPC messages via POST and can answer with plain JSON or with an SSE stream when it needs to send several messages. It replaced the old HTTP+SSE transport, which used two separate endpoints and now only exists for compatibility with older clients. If you find a tutorial with `/sse` and `/messages`, it predates that change.

## The problem it solves

A typical exchange without MCP:

```text
Dev: How do I call the notification service from my new feature?
AI:  Make an HTTP call to the service endpoint. Example with RestClient: ...
```

The answer is not wrong in the abstract. It just ignores that, on your platform, services talk through events, that a direct HTTP call bypasses the circuit breakers, that there is already an internal SDK for exactly this, and that the notification service has a quota. The same happens in code reviews that ignore the team's gates, in architecture proposals that reopen decisions recorded in ADRs, and in onboarding questions about terms that have a precise meaning in the internal glossary.

## The three pillars of a company MCP

**Architecture.** The service catalog (owner, stack, repository, who is on call), the dependency graph ("what breaks if I change the payments API contract?"), indexed and searchable ADRs, and infrastructure topology.

**Development patterns.** The "how we do things here": canonical examples of controllers, integration tests, error handling and metrics; the catalog of internal SDKs and libraries, so nobody builds the same thing twice; the actual review checklist; and the known traps of your environment, like the database configuration that deadlocks with a certain access pattern.

**Business context.** The hardest to maintain and the most valuable for senior work: the domain glossary, the bounded context map, the catalog of business rules (compliance, data retention, limits and why they exist) and the state of feature flags.

With that server connected, the same notification question becomes something like this: the assistant calls `get_service_info("notification")`, `get_pattern("async-messaging")` and `search_business_rules("order-confirmation")`, then answers that communication is event-based, that the `OrderConfirmed` schema already exists in the catalog, that the internal SDK wraps the connection, and that a business rule requires the notification within 30 seconds, which conflicts with the default retry policy. None of this is magic: it is the model reading sources you already maintain.

## Designing the tools

The technical part is simple. The hard part is information architecture: what to expose and how to structure it so the model grabs the right context at the right moment.

- **Name by intent, not implementation.** `get_service_owner(service)` instead of `query_cmdb(table, filter)`. The model picks a tool by its name and description.
- **Narrow tools.** A `get_everything(query)` is tempting and produces inconsistent behavior. `get_adr(id)`, `search_adrs(query)` and `list_adrs_for_service(service)` give the model reliable handles.
- **Put "when to use" in the description.** The description is what the model reads to decide whether to call the tool. State the trigger, not just what it does: "use before recommending an architectural solution, to check whether a decision is already recorded".
- **Return context, not raw JSON.** Return text that includes the data and what the model needs to reason about it: "The payments service belongs to the Platform team and runs Java 21 with Spring Boot. It is migrating its internal API from v2 to v3; new integrations should use v3."
- **Mark what is read-only.** The `readOnlyHint` and `openWorldHint` annotations tell the client the tool changes nothing, so it can handle the call with less friction.

## A minimal server

The server is rarely the source of truth. It is a thin layer over what already exists: Confluence or Notion for ADRs and runbooks, Backstage or a CMDB for the catalog, Git repositories for READMEs and CODEOWNERS, OpenAPI and AsyncAPI specs for contracts, the internal registry for SDKs. That matters for adoption: the server adds value without creating one more place to maintain.

To start, three tools that address everyday pain: service information, ADR search and code patterns. With version 2 of the official TypeScript SDK, a tool looks like this:

```typescript
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { serviceCatalog, adrIndex, formatService, formatAdr } from "./sources.js";

export function buildServer(): McpServer {
  const server = new McpServer({ name: "company-context", version: "1.0.0" });

  server.registerTool(
    "get_service_info",
    {
      title: "Internal service information",
      description:
        "Owner, stack, repository, on-call and description of an internal service. " +
        "Use when the conversation mentions a specific service, its owner or its dependencies.",
      inputSchema: z.object({
        service: z.string().min(2).max(100).describe("Service name in the catalog"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ service }) => {
      const info = await serviceCatalog.lookup(service);
      const text = info ? formatService(info) : `Service "${service}" not found in the catalog.`;
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "search_adrs",
    {
      title: "Search architecture decisions",
      description:
        "Searches ADRs by keyword. Use before recommending an architectural solution " +
        "or when the user asks why something is done a certain way.",
      inputSchema: z.object({ query: z.string().min(2).max(200) }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query }) => {
      const adrs = await adrIndex.search(query);
      const text = adrs.length === 0
        ? "No ADRs found for this topic."
        : adrs.map(formatAdr).join("\n\n");
      return { content: [{ type: "text", text }] };
    },
  );

  return server;
}
```

At first, run it locally over stdio: each developer configures the server in their client and sees the result right away. When it makes sense to centralize, serve it over Streamable HTTP. With the SDK's Express adapter:

```typescript
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { buildServer } from "./server.js";

const app = createMcpExpressApp({ host: "0.0.0.0", allowedHosts: ["mcp.example.internal"] });
const node = toNodeHandler(createMcpHandler(buildServer));

app.all("/mcp", (req, res) => void node(req, res, req.body));
app.listen(3000);
```

`createMcpHandler` takes a factory and builds a fresh `McpServer` for every request, which keeps the server stateless and easy to scale horizontally. `allowedHosts` validates the `Host` header and protects against DNS rebinding, a real attack on HTTP servers listening on a network. If your project still uses version 1 of the SDK (`@modelcontextprotocol/sdk`), the equivalent is the `StreamableHTTPServerTransport` class, and `registerTool` exists there too.

## Authorization

A remote server exposes institutional knowledge over HTTP, so authentication is not optional. The MCP specification defines authorization on top of OAuth 2.1, with clear roles:

- The **MCP server is a resource server**. It validates access tokens; it does not issue them. Your identity provider issues them (Keycloak, Entra ID, Okta, whatever the company already uses for SSO).
- The server publishes a **Protected Resource Metadata** document (RFC 9728) saying which authorization server to use. A request without a token gets `401` with a `WWW-Authenticate` header pointing to that document, which is how the client discovers where to log in.
- The token must have been issued **for this server**. The client requests the token naming the resource (RFC 8707), and the server rejects tokens whose audience is something else. This stops a token obtained for one service from being replayed against another.
- Insufficient scope gets `403` with `insufficient_scope`.

The SDK ships these pieces:

```typescript
import {
  createMcpExpressApp,
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthMetadataRouter,
  requireBearerAuth,
} from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { buildServer } from "./server.js";
import { oauthMetadata, verifyAccessToken } from "./auth.js";

const mcpUrl = new URL("https://mcp.example.internal/mcp");

const auth = requireBearerAuth({
  verifier: { verifyAccessToken },
  requiredScopes: ["mcp"],
  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
  expectedResource: mcpUrl,
});

const app = createMcpExpressApp({ host: "0.0.0.0", allowedHosts: [mcpUrl.hostname] });
app.use(mcpAuthMetadataRouter({ oauthMetadata, resourceServerUrl: mcpUrl }));

const node = toNodeHandler(createMcpHandler(buildServer));
app.all("/mcp", auth, (req, res) => void node(req, res, req.body));
app.listen(3000);
```

`verifyAccessToken` is yours: it validates the JWT against the provider's keys and returns the client, scopes, expiry and audience. Inside the tools, the caller's identity is available in the request context, and that is what you use to apply the permissions that already exist: if someone cannot read a service's runbook in Confluence, they cannot read it through MCP either. The SDK also lets you require scopes per tool, to separate reads from sensitive operations.

## Security beyond login

- **Content is data, not instructions.** An ADR or wiki page can contain text that looks like a command ("ignore previous instructions and..."). That is indirect prompt injection. Make it clear in responses and in the server instructions that returned content is reference material, and prefer read-only tools.
- **Audit calls.** Log which tool was called, by whom and with which parameters.
- **Choose what to expose.** Security architecture details, sensitive postmortems and people data do not belong in a developer MCP. The scope is what supports development work.

## Maintenance

The most common objection to any knowledge base is that it goes stale and becomes a source of misinformation. Three practices solve most of it:

- **Point to the source, do not copy it.** The server indexes the Confluence page, the ADR in Git, the Backstage entry. When the source changes, MCP already serves the new version.
- **Show how old the data is.** Every response includes when it was last updated. "Pattern last verified eighteen months ago" makes anyone double-check before relying on it.
- **Whoever owns the knowledge maintains it.** ADRs stay with whoever decides architecture, patterns with the teams that created them. The server aggregates; it owns nothing.

## Where it pays off most

Onboarding is the highest-return case. A newcomer can ask "what does the billing service do and how does it relate to subscriptions?" and get an answer grounded in the real catalog, or "why do we use X instead of Y here?" and land on the ADR with the alternatives that were rejected. It does not replace mentoring; it takes the mechanical lookup work out of it, leaving time for conversations that need judgment.

There is a good side effect too: building the server forces the team to write down and organize what today only exists in senior people's heads. Defining tools and writing descriptions exposes gaps in documentation that were already costing time before any AI.

If you have never written an MCP server, I have a free book (in Portuguese) that builds one from scratch: a small, secure TypeScript server, with tests and the full source code. It is called [Seu Primeiro Servidor MCP](/downloads/primeiro-servidor-mcp.pdf), and it is the best starting point before taking the idea to the whole company.
