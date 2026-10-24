---
title: "Spec-driven com IA: entregar funcionalidades sem perder o controle"
description: "Como escrever uma spec curta antes de pedir código à IA, com escopo, fora de escopo e arquivos esperados, usando o ai-kit, ferramenta que construí para isso."
slug: "spec-driven-com-ia"
theme: "ia"
order: 2
cover: ""
replaces: ["spec-driven-development"]
---

O jeito mais comum de usar um assistente de código é abrir o chat, descrever o que se quer, colar um pouco de contexto, iterar até funcionar e fazer merge. É rápido. Depois de algumas semanas, o código começa a mostrar os sintomas: implementações espalhadas, funcionalidades que quase batem com o que se pediu, mudanças que ninguém sabe explicar direito.

A causa é que, ao descrever uma funcionalidade numa mensagem, você deixa várias perguntas em aberto ao mesmo tempo: o que construir, o que não construir, quais arquivos mexer, como saber que terminou. O modelo responde todas sozinho, por inferência, sem avisar. Às vezes acerta. Quando erra, você descobre no review ou em produção.

Spec-driven é a disciplina de responder essas perguntas antes de pedir código. Não é ideia minha: o GitHub publicou o Spec Kit e a AWS construiu o editor Kiro em torno de specs, cada um com seu formato. Aqui eu descrevo o fluxo que uso no dia a dia e o [ai-kit](https://github.com/jeffev/ai-dev-kit), uma ferramenta open source que eu construí para automatizar esse fluxo em cima do Claude Code.

## O que é uma spec (e o que não é)

Não é documento de design, não é história de usuário, não é lista de requisitos. É um acordo curto, para uma única funcionalidade, que responde quatro perguntas: o que será construído, o que **não** será, quais tarefas compõem a implementação e quais arquivos devem mudar.

```markdown
# SPEC-007 — Busca de clientes por e-mail

## Status
draft

## What
Adicionar GET /api/customers/search?email= retornando uma página de CustomerSummaryDTO.

## Scope
- [ ] CustomerController: novo endpoint de busca com paginação
- [ ] CustomerRepository: consulta por e-mail com case-insensitive
- [ ] CustomerSummaryDTO (novo): id, nome, e-mail mascarado
- [ ] Teste de integração do endpoint

## Out of scope
- Busca por nome ou CPF
- Alterações no cadastro de clientes
- Cache dos resultados

## Contracts
### Request
GET /api/customers/search?email={texto}&page={n}&size={n}

### Response
Page<CustomerSummaryDTO>

## Stack context
- Controllers só chamam serviços de aplicação; nada de repositório direto
- DTOs são records

## Files expected to change
- src/main/java/com/example/customer/web/CustomerController.java
- src/main/java/com/example/customer/persistence/CustomerRepository.java
- src/main/java/com/example/customer/web/CustomerSummaryDTO.java (new)
- src/test/java/com/example/customer/web/CustomerSearchIT.java (new)
```

A seção mais subestimada é **Out of scope**. Todo pedido ambíguo tem um entorno de funcionalidades vizinhas que o modelo (e às vezes a gente) fica tentado a implementar: "já que estou aqui, coloco cache". Deixar a fronteira escrita impede isso antes de começar e dá ao modelo um sinal claro de onde parar.

A lista de arquivos esperados tem papel parecido. Ela limita o raio de impacto, e qualquer arquivo alterado fora dela vira um sinal que se pode verificar.

## O ciclo de vida

```text
rascunho → aprovação → início → implementação → revisão → fechamento
  (IA)      (humano)    (TASK.md)    (IA)          (IA)       (humano)
```

Uma spec, uma funcionalidade, uma sessão delimitada de trabalho com IA.

### 1. Rascunho: a IA escreve o acordo, não o código

Você descreve a funcionalidade em linguagem comum. A IA quebra em tarefas, propõe o fora de escopo, estima os arquivos e preenche as seções. Nenhuma linha de código de produção é escrita nesta etapa.

```bash
$ ai-kit spec new "busca de clientes por e-mail, paginada, devolvendo um resumo do cliente"
  ....  Calling claude -p to draft spec...
  OK  Spec created: .aikit-specs/draft/SPEC-007-busca-de-clientes-por-e-mail.md
  ....  Review and edit the spec, then run:

    ai-kit spec approve SPEC-007
```

No ai-kit, o rascunho é gerado com `claude -p` a partir da descrição e do `CLAUDE.md` do projeto, que traz as convenções da stack. É por isso que a seção *Stack context* costuma sair com regras do próprio projeto, e não genéricas.

### 2. Aprovação: o portão humano

Esta é a etapa de maior valor, e não é formalidade. Antes de qualquer código, alguém responde:

- O escopo está do tamanho certo?
- A lista de tarefas cobre a intenção, ou falta algo?
- O fora de escopo é explícito o bastante?
- Os arquivos esperados fazem sentido? Algum arquivo que deveria estar lá e não está?

Você edita o arquivo à vontade e depois aprova. O `approve` do ai-kit não aceita spec incompleta: ele verifica se *What* foi preenchido, se há pelo menos um item no checklist, se há arquivos listados e se a seção *Out of scope* existe.

```bash
$ ai-kit spec approve SPEC-007
  OK  SPEC-007 approved
  ....  Scope: 4 file(s) (2 new), 4 task(s)
  ....  Run:   ai-kit spec start SPEC-007
```

A spec aprovada continua em `draft/`, agora com status `approved`. Ela só muda de pasta no passo seguinte.

### 3. Início: TASK.md como contrato de implementação

```bash
$ ai-kit spec start SPEC-007
  OK  SPEC-007 is now active
  OK  TASK.md written at project root
  ....  Claude Code will read TASK.md automatically on session start
  ....  Auditor will log writes to files outside this spec's scope
```

O `start` move a spec para `active/`, registra o commit atual como ponto de partida e gera um `TASK.md` na raiz com objetivo, arquivos, checklist, regras da stack e o fora de escopo sob o título "não mexer". Ele também adiciona `@TASK.md` ao `CLAUDE.md`, que é o mecanismo de import do Claude Code; assim, toda sessão nova já começa com a tarefa carregada.

Esse arquivo resolve um problema real de sessões longas: o desvio de contexto. Depois de dezenas de chamadas de ferramenta, o agente vai se afastando da intenção original, acrescentando coisas e tocando arquivos que não devia. O `TASK.md` é a âncora que volta a cada sessão.

### 4. Implementação: IA com coleira

Agora sim o agente escreve código, dentro do contrato. O checklist funciona como fronteira natural de sessão: se o trabalho parar no meio, os itens desmarcados dizem à próxima sessão exatamente de onde continuar. Dá para marcar um item manualmente com `ai-kit spec update tick <N>`.

No ai-kit, os hooks do Claude Code continuam ativos durante a implementação: o auditor roda antes de cada escrita de arquivo e bloqueia problemas críticos (SQL concatenado, segredo no código, `@Transactional` em método privado, entre outros), e depois de cada `.java` escrito roda `mvnw compile`.

### 5. Revisão: aderência à spec, não "código bom"

Depois da implementação, a IA compara o que foi feito com o que foi combinado. É uma checagem de aderência, não um code review geral. O `review` envia ao modelo a spec e o `git diff` desde o commit de início e pede uma resposta num formato fixo:

```text
$ ai-kit spec review SPEC-007

### Coverage
- ✅ DONE — CustomerController: novo endpoint — GET /api/customers/search mapeado
- ✅ DONE — CustomerRepository: consulta por e-mail — findByEmailContainingIgnoreCase
- ✅ DONE — CustomerSummaryDTO — record criado
- ❌ MISSING — Teste de integração do endpoint — nenhum arquivo de teste no diff

### Out-of-scope changes
(none detected)

### Verdict
NEEDS WORK
```

Perguntar "isso corresponde ao que combinamos?" é muito mais rápido de responder do que "isso é bom?". O revisor humano continua necessário para a segunda pergunta, mas chega ao PR sabendo que a primeira já foi respondida. Os itens marcados como feitos são atualizados para `[x]` na própria spec.

### 6. Fechamento

```bash
$ ai-kit spec close SPEC-007
```

O `close` roda a revisão de novo. Se o veredito não for de pronto para fechar, ele pede confirmação (ou aceita `--force`). Ao fechar, marca a spec como `done`, anexa os commits feitos, move para `done/`, apaga o `TASK.md` e remove o import do `CLAUDE.md`.

## O histórico como efeito colateral

Depois de algumas semanas, a pasta `.aikit-specs/done/` vira um registro de cada funcionalidade: o que se pretendia, o que ficou de fora de propósito, o que foi implementado e com quais commits.

```text
.aikit-specs/
├── active/
│   └── SPEC-007-busca-de-clientes-por-e-mail.md
├── draft/
│   └── SPEC-008-notificacoes.md
└── done/
    ├── SPEC-001-refresh-token.md
    ├── SPEC-002-paginacao-produtos.md
    └── ...
```

Esse registro responde perguntas que normalmente exigem arqueologia: "por que esse campo é opcional?", "a falta de cache aqui foi intencional?". Diferente de uma mensagem de commit, a spec tem o contexto inteiro, inclusive o que foi deixado de fora de propósito.

## Por que specs melhoram o resultado da IA

Além do processo, a spec melhora o trabalho do modelo porque aumenta a relação entre sinal e ruído do contexto:

- **O fora de escopo evita geração a mais.** Menos arquivos tocados, menos para revisar, menos efeito colateral.
- **O checklist dá um critério de parada.** Sessões sem checklist tendem a se estender e divagar; com ele, o agente sabe quando terminou.
- **A lista de arquivos limita o raio.** Em bases grandes, onde o mesmo padrão aparece em vários lugares, isso reduz a chance de alterar o módulo errado.

## Uma spec, uma funcionalidade

É a regra mais difícil de manter sob prazo e a mais importante. Spec com várias funcionalidades gera implementação difícil de revisar, de reverter e de entender depois. A heurística que uso: se a spec passou de seis tarefas, ou se duas tarefas poderiam ser entregues separadamente e cada uma teria valor sozinha, divida. Uma spec a mais custa poucos minutos; desembaraçar uma implementação que mistura duas funcionalidades pode custar dias.

## Quando não usar

Spec-driven tem custo: uns dez a quinze minutos por funcionalidade, entre escrever, revisar e aprovar. Para corrigir um bug de duas linhas ou ajustar um estilo, é exagero. Vale quando:

- a mudança atravessa vários arquivos ou módulos e o risco de escopo crescer é real;
- o trabalho vai passar por várias sessões ou várias pessoas;
- vai haver code review formal;
- o domínio tem implicação de segurança, conformidade ou integridade de dados.

O ai-kit é uma das formas de aplicar a ideia, e dá para fazer tudo isso com um arquivo Markdown e disciplina. O que importa é a ordem: decidir o que construir, e o que não construir, antes de deixar a IA construir.
