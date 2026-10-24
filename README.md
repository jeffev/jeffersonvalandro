# jeffersonvalandro.com.br

Portfólio de Jefferson Valandro, em [Astro](https://astro.build): estático, PT-BR em `/` e inglês em `/en/`.

## Onde fica cada coisa

| Conteúdo | Arquivo |
|---|---|
| Projetos | `src/data/projects.json` (`featured` = ordem na home; imagens em `src/assets/projects/`) |
| Experiência (currículo) | `src/data/experience.json` |
| Resumo, formação, habilidades, projetos próprios, links | `src/data/profile.json` |
| Templates e pacotes | `src/data/products.json`, `src/data/bundles.json` (os preços "em vez de" saem da soma dos produtos) |
| Livros | `src/data/books.json` (capas em `src/assets/products/`, PDFs em `public/downloads/`) |
| Artigos | `src/content/articles/{pt,en}/<nome>.md` — o mesmo nome de arquivo liga as duas línguas |
| Textos da interface | `src/i18n.ts` |
| Estilo base | `src/styles/global.css` |

Frontmatter dos artigos: `title`, `description`, `slug` (URL na língua do arquivo), `theme`
(`arquitetura` · `qualidade` · `ia` · `mlops`), `order`, `cover` (opcional) e `replaces` (slugs do site antigo que
devem redirecionar para este artigo). Artigos não mostram data.

Comandos e publicação: ver [DEPLOY.md](DEPLOY.md).
