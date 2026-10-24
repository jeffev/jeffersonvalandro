---
title: "MCP para empresas de software: dando contexto da casa ao assistente de IA"
description: "Como montar um servidor MCP com arquitetura, padrões e regras de negócio da empresa, usando Streamable HTTP, registerTool e autorização OAuth."
slug: "mcp-para-empresas"
theme: "ia"
order: 3
cover: ""
replaces: ["mcp-for-software-companies"]
---

Os desenvolvedores usam assistentes de IA o dia inteiro, e o assistente responde como se o sistema fosse genérico. Ele não sabe que o time chama o fluxo de pagamento de "conciliação", que nenhum serviço chama o de usuários direto (tudo passa pelo gateway de identidade), nem que um ADR proibiu certo padrão de ORM depois de um incidente. Cada pessoa ou carrega esse contexto na cabeça, ou perde tempo explicando de novo em cada conversa.

O Model Context Protocol (MCP) é a peça que faltava para isso: um jeito padronizado de ligar assistentes de IA a fontes de dados e ferramentas. Para uma empresa de software, ele permite transformar arquitetura, padrões e conhecimento de negócio em contexto que o assistente consulta quando precisa.

## O que é o MCP, exatamente

MCP é um protocolo aberto, criado pela Anthropic e hoje mantido sob a Agentic AI Foundation, da Linux Foundation. Ele define como um cliente (Claude, Cursor, VS Code, entre outros) conversa com um servidor que oferece contexto. O servidor expõe três tipos de primitivas:

- **Tools**: funções que o modelo decide chamar ("buscar o ADR sobre cache", "quem é dono do serviço de faturamento").
- **Resources**: dados que o cliente pode ler, endereçados por URI: documentos, schemas, runbooks.
- **Prompts**: modelos de prompt prontos para fluxos comuns, que o cliente mostra ao usuário.

Há dois transportes padrão. O **stdio**, para servidores locais que o cliente inicia como processo filho. E o **Streamable HTTP**, para servidores remotos: um único endpoint HTTP que recebe mensagens JSON-RPC por POST e pode responder com JSON simples ou com um stream SSE quando precisa mandar várias mensagens. Ele substituiu o antigo transporte HTTP+SSE, que usava dois endpoints separados e hoje só existe por compatibilidade com clientes antigos. Se você encontrar um tutorial com `/sse` e `/messages`, ele é anterior a essa mudança.

## O problema que ele resolve

Um exemplo típico, sem MCP:

```text
Dev: Como chamo o serviço de notificação na minha feature nova?
IA:  Faça uma chamada HTTP ao endpoint do serviço. Exemplo com RestClient: ...
```

A resposta não está errada em abstrato. Ela só ignora que, na sua plataforma, comunicação entre serviços passa por eventos, que chamada HTTP direta fura os circuit breakers, que já existe um SDK interno exatamente para isso e que o serviço de notificação tem cota. O mesmo acontece em review de código que ignora os portões do time, em proposta de arquitetura que reabre decisão registrada em ADR, em dúvida de onboarding sobre termos que têm definição precisa no glossário interno.

## Os três pilares de um MCP corporativo

**Arquitetura.** Catálogo de serviços (dono, stack, repositório, quem está de plantão), grafo de dependências ("o que quebra se eu mudar o contrato da API de pagamentos?"), ADRs indexados e pesquisáveis, e topologia de infraestrutura.

**Padrões de desenvolvimento.** O "como fazemos aqui": exemplos canônicos de controller, teste de integração, tratamento de erro e métricas; catálogo de SDKs e bibliotecas internas, para ninguém construir duas vezes; o checklist real de review; e as armadilhas conhecidas do ambiente, como a configuração de banco que gera deadlock com certo padrão de acesso.

**Contexto de negócio.** O mais difícil de manter e o que mais rende em trabalho sênior: glossário do domínio, mapa de bounded contexts, catálogo de regras de negócio (conformidade, retenção de dados, limites com justificativa) e o estado das feature flags.

Com esse servidor conectado, a mesma pergunta sobre notificação vira algo assim: o assistente chama `get_service_info("notification")`, `get_pattern("async-messaging")` e `search_business_rules("order-confirmation")`, e responde que a comunicação é por evento, que o schema `OrderConfirmed` já existe no catálogo, que o SDK interno encapsula a conexão, e que uma regra de negócio exige a notificação em até 30 segundos, o que conflita com a política de retry padrão. Nada disso é mágica: é o modelo lendo as fontes que vocês já mantêm.

## Como desenhar as tools

A parte técnica é simples. O difícil é arquitetura de informação: o que expor e como estruturar para que o modelo pegue o contexto certo na hora certa.

- **Nome pela intenção, não pela implementação.** `get_service_owner(service)` em vez de `query_cmdb(table, filter)`. O modelo escolhe a tool pelo nome e pela descrição.
- **Tools estreitas.** Uma `get_everything(query)` é tentadora e gera comportamento inconsistente. `get_adr(id)`, `search_adrs(query)` e `list_adrs_for_service(service)` dão ao modelo alças confiáveis.
- **"Quando usar" na descrição.** A descrição é o que o modelo lê para decidir se chama a tool. Diga o gatilho, não só o que ela faz: "use antes de recomendar uma solução de arquitetura, para verificar se já existe decisão registrada".
- **Resposta com contexto, não JSON cru.** Devolva texto que inclua o dado e o que o modelo precisa para raciocinar sobre ele: "O serviço de pagamentos é do time Plataforma, roda Java 21 com Spring Boot. Ele está migrando a API interna da v2 para a v3; integrações novas devem usar a v3."
- **Marque o que é só leitura.** As anotações `readOnlyHint` e `openWorldHint` dizem ao cliente que a tool não altera nada, e ele pode tratar a chamada com menos atrito.

## Um servidor mínimo

O servidor raramente é a fonte da verdade. Ele é uma camada fina sobre o que já existe: Confluence ou Notion para ADRs e runbooks, Backstage ou CMDB para o catálogo, repositórios Git para README e CODEOWNERS, specs OpenAPI e AsyncAPI para contratos, o registry interno para os SDKs. Isso importa para a adoção: o servidor agrega valor sem criar mais um lugar para manter.

Para começar, três tools que resolvem dor de todo dia: informação de serviço, busca de ADR e padrão de código. Com a versão 2 do SDK oficial de TypeScript, uma tool fica assim:

```typescript
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { serviceCatalog, adrIndex, formatService, formatAdr } from "./sources.js";

export function buildServer(): McpServer {
  const server = new McpServer({ name: "company-context", version: "1.0.0" });

  server.registerTool(
    "get_service_info",
    {
      title: "Informações de um serviço interno",
      description:
        "Dono, stack, repositório, plantão e descrição de um serviço interno. " +
        "Use quando a conversa citar um serviço específico, seu dono ou suas dependências.",
      inputSchema: z.object({
        service: z.string().min(2).max(100).describe("Nome do serviço no catálogo"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ service }) => {
      const info = await serviceCatalog.lookup(service);
      const text = info ? formatService(info) : `Serviço "${service}" não encontrado no catálogo.`;
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "search_adrs",
    {
      title: "Buscar decisões de arquitetura",
      description:
        "Busca ADRs por palavra-chave. Use antes de recomendar uma solução de arquitetura " +
        "ou quando o usuário perguntar por que algo é feito de certo jeito.",
      inputSchema: z.object({ query: z.string().min(2).max(200) }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query }) => {
      const adrs = await adrIndex.search(query);
      const text = adrs.length === 0
        ? "Nenhum ADR encontrado para esse tema."
        : adrs.map(formatAdr).join("\n\n");
      return { content: [{ type: "text", text }] };
    },
  );

  return server;
}
```

No começo, rode localmente por stdio: cada desenvolvedor configura o servidor no cliente e já vê o resultado. Quando fizer sentido centralizar, sirva por Streamable HTTP. Com o adaptador de Express do SDK:

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

O `createMcpHandler` recebe uma fábrica e cria um `McpServer` novo a cada requisição, o que deixa o servidor sem estado e fácil de escalar horizontalmente. O `allowedHosts` valida o header `Host` e protege contra DNS rebinding, um ataque real contra servidores HTTP que escutam em rede. Se o projeto ainda usa a versão 1 do SDK (`@modelcontextprotocol/sdk`), o equivalente é a classe `StreamableHTTPServerTransport`, e o `registerTool` existe lá também.

## Autorização

Um servidor remoto expõe conhecimento institucional por HTTP, então autenticação não é opcional. A especificação do MCP define a autorização sobre OAuth 2.1, com papéis claros:

- O **servidor MCP é um resource server**. Ele valida tokens de acesso; não os emite. Quem emite é o seu provedor de identidade (Keycloak, Entra ID, Okta, o que a empresa já usa para SSO).
- O servidor publica um documento de **Protected Resource Metadata** (RFC 9728) dizendo qual servidor de autorização usar. Uma requisição sem token recebe `401` com um header `WWW-Authenticate` apontando para esse documento, e é assim que o cliente descobre onde fazer login.
- O token precisa ter sido emitido **para este servidor**. O cliente pede o token indicando o recurso (RFC 8707), e o servidor rejeita tokens cuja audiência seja outra. Isso impede que um token obtido para um serviço seja reaproveitado contra outro.
- Escopo insuficiente recebe `403` com `insufficient_scope`.

O SDK traz essas peças prontas:

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

O `verifyAccessToken` é seu: valida o JWT contra as chaves do provedor e devolve cliente, escopos, expiração e audiência. Dentro das tools, a identidade de quem chamou fica disponível no contexto da requisição, e é com ela que você aplica as permissões que já existem: se a pessoa não pode ler o runbook de um serviço no Confluence, não pode lê-lo pelo MCP. O SDK também permite exigir escopos por tool, para separar leitura de operações sensíveis.

## Segurança além do login

- **Conteúdo é dado, não instrução.** Um ADR ou uma página de wiki pode conter texto que parece ordem ("ignore as instruções anteriores e..."). Isso é injeção de prompt indireta. Deixe claro nas respostas e nas instruções do servidor que o conteúdo retornado é material de consulta, e prefira tools só de leitura.
- **Audite as chamadas.** Registre qual tool foi chamada, por quem e com quais parâmetros.
- **Escolha o que expor.** Detalhes de arquitetura de segurança, postmortems sensíveis e dados de pessoas não pertencem a um MCP para desenvolvedores. O escopo é o que apoia o trabalho de desenvolvimento.

## Manutenção

A objeção mais comum a qualquer base de conhecimento é que ela envelhece e vira fonte de desinformação. Três práticas resolvem a maior parte:

- **Aponte para a fonte, não copie.** O servidor indexa a página do Confluence, o ADR no Git, a entrada do Backstage. Quando a fonte muda, o MCP já serve a versão nova.
- **Mostre a idade do dado.** Toda resposta inclui quando aquilo foi atualizado. "Padrão verificado pela última vez há dezoito meses" faz qualquer um conferir antes de confiar.
- **Quem é dono do conhecimento mantém o conhecimento.** ADRs com quem decide arquitetura, padrões com os times que os criaram. O servidor agrega; não é dono de nada.

## Onde rende mais

Onboarding é o caso de maior retorno. Quem chega pode perguntar "o que o serviço de faturamento faz e como ele se relaciona com o de assinaturas?" e receber uma resposta baseada no catálogo real, ou "por que usamos X e não Y aqui?" e chegar ao ADR com as alternativas descartadas. Isso não substitui mentoria; tira dela o trabalho de consulta mecânica, e sobra tempo para conversa de julgamento.

Há também um efeito colateral bom: construir o servidor obriga o time a escrever e organizar o que hoje só existe na cabeça das pessoas mais antigas. Definir as tools e escrever as descrições expõe buracos na documentação que já custavam tempo antes de qualquer IA.

Se você nunca escreveu um servidor MCP, eu tenho um livro gratuito que faz isso do zero, com um servidor pequeno e seguro em TypeScript, testes e o código completo: [Seu Primeiro Servidor MCP](/downloads/primeiro-servidor-mcp.pdf). É o melhor ponto de partida antes de levar a ideia para a empresa inteira.
