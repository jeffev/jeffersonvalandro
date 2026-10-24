---
title: "Qualidade de código na prática, e o que aprendi construindo o archlens-ai"
description: "Os anti-padrões que mais degradam um código, ciclos, complexidade, o quadrante de dívida técnica do Fowler e um estudo de caso com a minha ferramenta archlens-ai."
slug: "qualidade-de-codigo-archlens"
theme: "qualidade"
order: 2
cover: "images/archlens.png"
replaces: ["code-quality"]
---

Todo time diz que se importa com qualidade de código, e poucos conseguem medir. Pergunte a cinco pessoas o que é "código bom" e você ouve cinco respostas: formatação, cobertura, nomes, complexidade. Todas certas, todas incompletas.

O que me interessa é a degradação estrutural, porque ela é invisível até deixar de ser. Ninguém quebra um sistema num commit. Ele vai piorando por decisões que, uma a uma, pareciam razoáveis: mais um método na classe que já faz tudo, um import que fecha um ciclo, uma constante duplicada "só desta vez". Seis meses depois, uma mudança simples exige três pessoas para entender o impacto.

Code review sozinho não pega isso. Quem revisa vê um diff, não a tendência de que aquele diff faz parte. Foi essa percepção que me levou a construir o [archlens-ai](https://jeffev.github.io/archlens-ai), uma ferramenta de linha de comando que analisa a arquitetura de um projeto e gera um relatório. A segunda metade deste texto é um estudo de caso honesto dela, incluindo onde ela não é suficiente.

## Os seis anti-padrões que mais custam

Os nomes vêm, na maior parte, do catálogo de *code smells* do livro *Refactoring*, de Martin Fowler. Dar nome importa: no review, "isso aqui é feature envy" é mais rápido e menos pessoal que um parágrafo de explicação.

**God class.** A classe que sabe e faz demais. Ela cresce porque já existe, já tem o repositório injetado, já importa o que precisa. O sinal típico é um `OrderService` que cria pedido, manda e-mail, gera PDF de nota, atualiza estoque e calcula frete. A correção é decompor por motivo de mudança: e-mail, nota, estoque e frete mudam por razões diferentes e merecem casas diferentes.

**Feature envy.** Um método mais interessado nos dados de outra classe do que nos da sua.

```java
// em ReportService, mas o cálculo pertence a Order
BigDecimal total(Order order) {
    BigDecimal subtotal = order.getItems().stream()
            .map(i -> i.getPrice().multiply(BigDecimal.valueOf(i.getQuantity())))
            .reduce(BigDecimal.ZERO, BigDecimal::add);
    BigDecimal discount = order.getCoupon() == null ? BigDecimal.ZERO : order.getCoupon().getRate();
    return subtotal.multiply(BigDecimal.ONE.subtract(discount));
}
```

Uma cadeia de getters de outro objeto é o sinal. Costuma ser sintoma de modelo anêmico: dados em classes só com getters e setters, comportamento espalhado por services. Mover o método para `Order` reduz acoplamento e aumenta coesão de uma vez.

**Shotgun surgery.** O inverso da god class: uma mudança lógica exige mexer em muitos arquivos. Adicionar "telefone" ao cliente toca entidade, DTO, mapper, validador, contrato OpenAPI, formulário e template de e-mail. Nenhum arquivo é grande; o conceito é que está espalhado. A correção é eleger uma fonte da verdade e derivar o resto dela, por exemplo, gerar DTOs e validação a partir do contrato OpenAPI.

**Data clump.** Dados que sempre andam juntos e ainda não ganharam nome: `inicio, fim, fusoHorario`; `rua, cidade, cep`. Em Java 21, um record resolve em uma linha e ainda centraliza a validação:

```java
public record Periodo(LocalDate inicio, LocalDate fim, ZoneId fuso) {
    public Periodo {
        if (fim.isBefore(inicio)) throw new IllegalArgumentException("fim antes do início");
    }
}
```

**Código morto.** Branch inalcançável, método que ninguém chama, classe órfã. Além de ocupar espaço, ele confunde: quem chega não sabe se é intencional ou esquecido. A correção é apagar; o histórico do git existe para isso.

**Obsessão por primitivos.** IDs como `String`, dinheiro como `double`, e-mail como texto livre. Compila até alguém passar o ID do produto onde se esperava o do cliente. Value objects (`CustomerId`, `Money`, `Email`) transformam esse erro em erro de compilação e empurram a validação para a borda.

## Ciclos de dependência são outra categoria

Ciclo não piora legibilidade nem desempenho diretamente. Ele destrói a possibilidade de pensar nos módulos separadamente: se `pedido` depende de `cliente` e `cliente` depende de `pedido`, não dá para testar, entender ou extrair um sem o outro. Os dois viraram um módulo só, com dois nomes.

E ciclo é difícil de ver no review, porque um import parece inofensivo. Só aparece no grafo, que ninguém desenha à mão. Em Java, o ArchUnit verifica isso no build:

```java
@ArchTest
static final ArchRule semCiclosEntreModulos =
        slices().matching("com.example.(*)..").should().beFreeOfCycles();
```

A correção usual é extrair o que os dois precisam para um terceiro módulo, ou inverter uma das dependências com uma interface ou um evento.

## Complexidade ciclomática

É uma das poucas métricas com número de verdade. Thomas McCabe a definiu como a quantidade de caminhos linearmente independentes de uma função: cada `if`, `case`, laço, `&&` e `||` soma um. Ela indica quantos casos de teste você precisa para cobrir todos os ramos e, indiretamente, quão difícil é entender a função. O limite de 10 por método vem do artigo original de McCabe e é o padrão da regra `CyclomaticComplexity` do Checkstyle.

```xml
<module name="CyclomaticComplexity">
    <property name="max" value="10"/>
</module>
```

Num legado com muita função acima disso, comece mais frouxo (15 ou 20) e aperte aos poucos. Uma regra que falha em 400 lugares no primeiro dia é desligada no segundo.

## O quadrante da dívida técnica, lido direito

Martin Fowler propôs classificar dívida técnica em dois eixos: **deliberada ou inadvertida**, e **imprudente ou prudente**.

| | Imprudente | Prudente |
|---|---|---|
| **Deliberada** | "Não temos tempo para design." | "Precisamos entregar agora e vamos lidar com as consequências." |
| **Inadvertida** | "O que é separação em camadas?" | "Agora sabemos como deveríamos ter feito." |

Uma leitura errada comum é usar o quadrante para decidir *qual dívida pagar*. Não é para isso. O quadrante descreve **como a dívida nasceu**, e o que ele diagnostica é o time e o processo, não o código.

- Dívida **imprudente** (as duas células da esquerda) aponta problema de cultura ou de conhecimento. Pagar a dívida existente não resolve se o processo continua produzindo mais. A ação é treinar, revisar e criar portões automáticos.
- Dívida **prudente deliberada** é uma decisão de negócio legítima, desde que tenha registro e plano de pagamento.
- Dívida **prudente inadvertida** é inevitável, mesmo em times excelentes: você só descobre o desenho certo depois de construir. Fowler insiste nesse ponto.

A decisão de *pagar* é outra conversa, e o critério é o juro: quanto aquela dívida atrasa as mudanças que você precisa fazer. Uma gambiarra imprudente num módulo que ninguém toca há dois anos custa quase nada; uma dívida prudente no coração do domínio, que todo sprint esbarra, custa muito. Priorize pelo juro, não pelo quadrante.

## Estudo de caso: o archlens-ai

O [archlens-ai](https://github.com/jeffev/archlens-ai) é um projeto meu, open source sob licença MIT e publicado no npm. Você aponta para um diretório e ele gera um relatório HTML autocontido com grafo interativo da stack, mapa de módulos, nota de saúde de 0 a 100, nota por módulo (coesão, acoplamento, tamanho), anti-padrões, ciclos, cobertura de testes por módulo e sugestões de refatoração.

```bash
npx archlens-ai analyze ./meu-projeto
npx archlens-ai analyze ./meu-projeto --depth deep          # lê o conteúdo dos arquivos principais
npx archlens-ai analyze ./meu-projeto --profile security    # foco em OWASP Top 10
```

### Como funciona por dentro

Vale ser transparente, porque isso define o que dá para esperar dele. O fluxo tem quatro passos:

1. **Varredura**: percorre a árvore de arquivos, lê arquivos de configuração (`package.json`, `docker-compose`, configs da aplicação) e, em projetos Node.js, monta o grafo de imports com o madge.
2. **Prompt macro**: o Claude Code recebe esse material e descreve a stack: frameworks, bancos, filas e problemas de configuração de cada um.
3. **Prompt micro**: o Claude Code identifica módulos lógicos, dá as notas, aponta anti-padrões e propõe a arquitetura sugerida, em JSON validado por schema.
4. **Renderização**: o JSON vira um HTML com Cytoscape.js embutido. A detecção de ciclos é uma busca em profundidade sobre as dependências entre módulos.

Ou seja: **as notas e os anti-padrões são julgamento de um modelo de linguagem**, guiado por critérios explícitos no prompt (god class como "mais de 300 linhas com várias responsabilidades", menor acoplamento vale nota maior, e assim por diante). Não são métricas calculadas como a complexidade ciclomática.

### Rodando num projeto real

O relatório de demonstração publicado no site do projeto é de um sistema meu, o Tradelink: backend NestJS com TimescaleDB e Redis, um worker Python com FastAPI para backtests e um frontend React. O resultado: nota geral 44 de 100, 12 módulos identificados e 7 mudanças sugeridas.

Os achados que mais me interessaram:

- **God class** no módulo de portfólio: o service de portfólio era de longe o maior do backend e misturava posição, cálculo de lucro e prejuízo, agregação de operações e relatório. O relatório deu a esse módulo 20 de 100, com coesão 15.
- **Código morto**: um arquivo de teste de um módulo `trades` que não tinha implementação nenhuma na árvore. O relatório levantou as duas hipóteses: funcionalidade removida deixando o teste órfão, ou teste criado para algo que nunca foi implementado.
- **Shotgun surgery** no backtest: adicionar um parâmetro exigia mexer na entidade NestJS, no service, na rota FastAPI, no motor de backtest e no formulário do frontend, sem um contrato compartilhado que gerasse o resto.
- **Cobertura**: só 4 arquivos de teste, cobrindo 2 dos 12 módulos, com o portfólio, que é o de maior risco, sem teste algum.

Nada disso é impossível de achar sozinho. O valor foi achar tudo em um minuto, com nome e prioridade, num formato que dá para colocar na frente do time e discutir.

### Onde ele não basta

Construir a ferramenta me deixou com uma noção bem clara dos limites dela, e prefiro dizer isso aqui a deixar alguém descobrir em produção:

- **A nota varia entre execuções.** Como vem de um modelo, rodar duas vezes no mesmo código pode dar números diferentes. A tendência ao longo do tempo é informativa; a diferença de três pontos entre duas execuções, não.
- **O grafo de imports determinístico só existe para Node.js.** Em Java, Python, Go ou Rust, o modelo infere as dependências a partir da árvore de arquivos e, no modo `deep`, do conteúdo dos arquivos principais. Os ciclos que ele aponta são ciclos entre os módulos que o modelo identificou, não entre pacotes reais.
- **Projetos grandes são amostrados.** O prompt recebe uma lista limitada de arquivos e de dependências. Num monólito Java de milhares de classes, ele vê uma fração.

Por isso a ferramenta tem a opção `--min-score`, que encerra com código 1 abaixo do limite, mas eu não a usaria como portão rígido de merge. Se quiser no CI, use com margem folgada e publique o relatório como artefato para discussão:

```yaml
- name: Relatório de arquitetura
  run: npx archlens-ai analyze . --no-open --output archlens.html --min-score 50
  continue-on-error: true
- uses: actions/upload-artifact@v4
  with:
    name: archlens
    path: archlens.html
```

## Como eu combino as ferramentas

O que funciona para mim é separar **portões** de **diagnóstico**.

Portão precisa ser determinístico: a mesma entrada dá o mesmo resultado, sempre. Em Java, isso é Checkstyle e PMD para complexidade e estilo, SpotBugs para padrões de bug, SonarQube com quality gate sobre código novo, e ArchUnit para regras de dependência e ciclos entre pacotes. Esses quebram o build.

Diagnóstico pode ser julgamento: serve para enxergar o todo, priorizar e iniciar conversa. É onde o archlens-ai entra, junto com a revisão humana. Rodo quando começo num projeto, antes de planejar uma refatoração grande e de tempos em tempos para ver a tendência.

E vale a regra do escoteiro: todo PR deixa os arquivos que tocou um pouco melhores do que encontrou. Não é refatoração completa; é apagar o código morto que está ali, dar nome ao data clump, quebrar a função que passou do limite. Aplicado com consistência, cada PR vira uma pequena melhoria em vez de um evento neutro.

Qualidade é tendência, não fotografia. Um módulo com nota 60 que vem subindo está melhor que um com 75 que vem caindo, e a direção importa mais que o número do dia.
