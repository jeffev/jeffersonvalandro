---
title: "O que a IA não faz por você: como revisei meus templates e e-books antes de vender"
description: "Bastidores de produtos feitos com IA: o que conferi antes de vender, os erros que a IA cometeu e como calibro a revisão pelo risco de cada mudança."
slug: "o-que-a-ia-nao-faz"
theme: "ia"
order: 4
cover: ""
replaces: ["o-que-a-ia-nao-faz", "ai-for-developers"]
---

Coloquei à venda templates de Next.js e e-books técnicos, e usei IA intensamente para construir tudo. Sei a pergunta que vem na cabeça de quem lê isso: "se a IA fez, vale alguma coisa?"

É uma pergunta justa. A IA gera código e texto em quantidade. O que ela não garante é que aquilo funcione, esteja certo e possa ser vendido para outra pessoa com a minha assinatura. Essa parte continua sendo trabalho de engenharia, e é sobre ela que eu quero falar.

## O que eu coloquei à venda

São nove templates, todos com Next.js 16, Tailwind CSS 4 e shadcn/ui, vendidos na minha loja no Payhip e cada um com uma demo no ar para testar antes de comprar:

- **Kairo Admin**: painel administrativo com 23 telas
- **Kairo AI Starter**: base de SaaS com login, chat de IA, créditos e Stripe
- **Kairo Blocks**: 61 blocos de landing page
- **Kairo Estate**: site de imobiliária com mapa e filtros na URL
- **Kairo Mail**: 32 templates de e-mail com React Email
- **Kairo Studio**: site de agência e portfólio
- **Kairo Invoice**: emissão de faturas com PDF, link de pagamento e Stripe
- **Kairo Booking**: agendamento com página pública de reservas e sinal pago pelo Stripe
- **Kairo Directory**: diretório de produtos com submissão e destaque pagos

E os e-books técnicos em português, cada um ensinando a construir um tipo de projeto. Eles começaram na Hotmart e hoje estão na Amazon, pelo KDP.

## A IA como equipe, eu como tech lead

Usei o Claude Code como uma equipe muito rápida: ele escreve o código, roda o build e os testes, tira as capturas de tela, monta os PDFs. O meu papel foi o mesmo que eu tenho como tech lead há anos: decidir o que construir, revisar tudo, dizer não e assumir a responsabilidade pelo que vai para as mãos de quem compra.

O gargalo mudou de lugar. Escrever código deixou de ser a parte demorada; revisar e decidir passou a ser. Quem já liderou time conhece essa sensação. A diferença é que a revisão precisa acompanhar um time que entrega muito, sem afrouxar.

O modelo mental que funciona para mim: a IA é um colega rápido, que sabe muito e às vezes tem confiança demais. Eu não faria merge do PR de um sênior sem ler, nem aplicaria em produção uma configuração que alguém mandou no chat sem conferir. O padrão para o que a IA produz é o mesmo.

## O que eu conferi antes de vender

### Os templates

- Build de produção sem erros, com a checagem de tipos do TypeScript rodando junto.
- Instalação do zero a partir do zip, numa pasta limpa, exatamente como o comprador vai receber. Template que só funciona na máquina de quem fez não é produto.
- Testes automáticos de interação nas demos: 16 no Kairo Estate e 23 no Kairo Studio, clicando em filtros, formulários e navegação como uma pessoa faria.
- No Kairo AI Starter, que mexe com dinheiro: cadastro, chat, consumo de créditos, bloqueio quando o saldo acaba, recuperação de senha, isolamento entre usuários (um não enxerga os dados do outro) e o webhook do Stripe assinado e idempotente (o mesmo pagamento avisado duas vezes não credita duas vezes).
- Revisão visual no tema claro, no escuro e no celular.
- As fotos das demos, uma a uma. No Kairo Studio, troquei três que mostravam marcas de terceiros. A IA não percebe esse tipo de problema; um cliente atento, sim.

### Os e-books

A regra mais importante: toda afirmação técnica é conferida no código antes de ir para o PDF. Cada trecho citado, cada número, cada "o template já faz isso". Se o livro diz que um formulário tem validação, eu abro o arquivo e confiro. Material técnico que erra fatos perde a confiança do leitor na primeira página.

## Onde a IA errou (e eu peguei)

### 1. Fatos errados, com toda a confiança

Um rascunho dizia que um template tinha seis formulários. Eram cinco: o sexto tipo existia no código, mas nenhuma tela usava. Parece detalhe, mas é exatamente o tipo de erro que faz o comprador desconfiar de todo o resto.

Isso tem nome: alucinação. O modelo produz algo fluente, confiante e errado, no mesmo tom de quando está certo. O sinal de "estou inventando" é idêntico ao de "tenho certeza", e por isso é o defeito mais perigoso para uso profissional.

### 2. Um bug que faria o SaaS dar crédito de graça

No Kairo AI Starter, se o usuário apertasse "Parar" no meio de uma resposta do chat, a resposta não era cobrada. Quem montasse um SaaS em cima do template estaria pagando a IA do próprio bolso a cada clique. A correção: o servidor continua a geração mesmo depois que o navegador desconecta, salva a resposta e cobra os créditos. Lancei a versão 1.0.1 e troquei o arquivo na loja.

Esse bug não aparece em nenhum teste de caminho feliz. Ele só aparece para quem pergunta "e se o usuário fizer isso no meio?", que é a pergunta que um tech lead faz por hábito.

### 3. Texto de venda com promessa falsa

Na época em que os e-books estavam na Hotmart, usei a página de vendas gerada por IA que a plataforma oferece. A primeira versão dizia que o código era "testado em produção". Não era verdade: era um template novo. Corrigi antes de divulgar. Qualquer texto que fala em meu nome passa por mim, mesmo quando vem pronto da plataforma.

## Revisão proporcional ao risco

Revisar tudo com a mesma intensidade não escala. O que eu faço é calibrar o esforço pelo risco da mudança e pelo tipo de coisa que a IA costuma errar.

Os erros não se distribuem por igual. O risco é maior em APIs exatas de versões específicas de bibliotecas, em qualquer coisa posterior ao corte de treino do modelo, em frameworks pouco documentados, em configurações de segurança com muitas variações que parecem válidas, na interação entre duas bibliotecas e em contas feitas no meio de um texto. É menor em algoritmos conhecidos, na biblioteca padrão de linguagens populares, em transformação de código e na explicação de um código que você mesmo forneceu.

Na prática, divido assim:

- **Risco baixo, leitura rápida**: boilerplate, fixtures de teste, refatoração com intenção clara, conversão entre linguagens.
- **Risco médio, leitura cuidadosa e testes rodando**: regra de negócio, consultas ao banco, integração com API.
- **Risco alto, conferir na fonte primária**: autenticação, CORS, criptografia, versões de dependência e changelog, infraestrutura que toca produção, e qualquer código que lida com dinheiro, dados pessoais ou controle de acesso.

O Kairo AI Starter caiu inteiro na terceira faixa, e foi por isso que testei créditos, isolamento entre usuários e o webhook do Stripe com mais cuidado do que o resto.

## Agentes: o mínimo de permissão necessário

Um agente é um modelo que age: lê arquivos, roda comandos, chama APIs, observa o resultado e decide o próximo passo, em ciclo, até terminar. É diferente de um chat, e erra de um jeito diferente: se o raciocínio no passo 3 estiver errado, os passos 4 a 10 podem seguir com toda a confiança na direção errada.

Por isso trato agente como trato conta de serviço, com o princípio do menor privilégio. Para explorar e responder perguntas, só leitura. Para o ciclo de desenvolvimento, escrita no projeto e execução de testes, sem push e sem tocar em banco de verdade. Para qualquer ação com efeito fora da máquina (push, escrita em banco, chamada a API externa, publicação), aprovação humana a cada passo. A diferença entre um agente que só lê e um que escreve é enorme, e deve ser uma decisão consciente.

## O código precisa ser seu

Existe um jeito de usar IA que fecha tarefas rápido e acumula uma dívida invisível: aceitar o que ela produz sem entender, e iterar por prompt em vez de por compreensão. Três coisas se perdem:

- **A revisão.** Se você não entendeu o código bem o bastante para escrevê-lo, não entendeu bem o bastante para achar o bug que a IA colocou ali.
- **A posse.** Se ninguém no time consegue explicar por que um trecho funciona, mexer nele vira arqueologia.
- **A depuração.** Depurar exige um modelo mental do sistema. Na hora do incidente em produção, "perguntar para a IA" não é estratégia.

O teste que uso: se eu não consigo explicar em linguagem simples por que o código funciona (que invariante ele mantém, que caso de borda ele trata, o que quebra se eu mudar uma linha), eu não sou dono daquele código. Estou alugando do modelo.

E há um custo de longo prazo: habilidade que não se pratica enfraquece. Quem passa anos sem depurar, sem desenhar um sistema e sem ler documentação por conta própria fica frágil justamente nos momentos de maior pressão, como um incidente, uma auditoria de segurança ou uma revisão de arquitetura. Uso a IA para chegar mais rápido ao entendimento, não para pular essa etapa. "Me explique este código" e "o que pode dar errado nesta abordagem?" estão entre os pedidos que mais faço.

## O que eu aprendi

- A IA multiplica quem sabe revisar. Ela não substitui o critério de quem já viu código quebrar em produção.
- Teste como o cliente. Instalação limpa e testes de interação pegam o que passa batido no "funciona aqui".
- Desconfie do texto bem escrito. Erro com boa redação é o mais perigoso, porque convence.

Os templates estão na loja ValandroUI no Payhip, cada um com demo ao vivo, e os e-books estão na Amazon. Tudo passou pelo processo que descrevi aqui.
