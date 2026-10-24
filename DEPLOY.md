# Deploy do portfólio (Astro)

Hoje (branch `main`, site antigo) o deploy é "o repositório é o site":

- **VPS** (`jeffersonvalandro.com.br`, canônico): Caddy serve `/opt/demos/sites/portfolio`, um clone do repo, e o cron faz
  `*/10 * * * * cd /opt/demos/sites/portfolio && git pull -q --ff-only`.
- **GitHub Pages** (`jeffev.github.io/jeffersonvalandro/`): espelho, publicado da raiz do `main` pelo "Deploy from a branch".

Com o Astro, a raiz do repo deixa de ser o site: o HTML sai em `dist/` depois do `npm run build`. Nada abaixo foi
executado ainda. A ordem importa: primeiro o branch `site` precisa existir, depois o VPS passa a usá-lo, e só então o
`main` recebe o merge.

## 1. Build automático → branch `site`

O workflow `.github/workflows/deploy.yml` (já neste branch) roda a cada push no `main`:
`npm ci` → `npm run check` → `npm run build` → publica o conteúdo de `dist/` como único commit do branch `site`
(force push; o branch não tem histórico).

Para criar o branch `site` antes do merge, rode o workflow uma vez à mão a partir deste branch
(Actions → "Build and publish site" → Run workflow → branch `astro-revamp`), ou localmente:

```bash
npm ci && npm run build
cd dist && git init -b site && git add -A && git commit -m "Build" \
  && git push -f https://github.com/jeffev/jeffersonvalandro.git site
```

## 2. VPS passa a servir o branch `site`

Como o `site` é reescrito a cada build, `git pull --ff-only` falharia. Troque o clone e o cron:

```bash
ssh vps
cd /opt/demos/sites
git clone --branch site --single-branch https://github.com/jeffev/jeffersonvalandro.git portfolio-site
# Caddy: trocar o root de /opt/demos/sites/portfolio para /opt/demos/sites/portfolio-site e recarregar
crontab -e
# substituir a linha antiga por:
*/10 * * * * cd /opt/demos/sites/portfolio-site && git fetch -q origin site && git reset -q --hard origin/site
```

O Caddy precisa servir `404.html` para caminhos inexistentes e `index.html` dentro de pastas (o build usa
`/projetos/index.html` etc.). Exemplo de bloco:

```
jeffersonvalandro.com.br {
    root * /opt/demos/sites/portfolio-site
    encode zstd gzip
    file_server
    handle_errors {
        @404 expression {err.status_code} == 404
        rewrite @404 /404.html
        file_server
    }
    @assets path /_astro/*
    header @assets Cache-Control "public, max-age=31536000, immutable"
}
```

URLs antigas continuam funcionando: `/articles/<slug>.html` e `/news.html` viram páginas de redirecionamento geradas no
build (para o artigo que substituiu o antigo, ou para `/artigos/` quando ele saiu). O antigo `/#products` cai na home.

## 3. GitHub Pages

O site usa caminhos absolutos (`/_astro/...`, `/projetos/`), então ele **não funciona** dentro do subcaminho
`jeffev.github.io/jeffersonvalandro/`. Como o canônico é o domínio no VPS, a recomendação é **desligar o Pages**
(Settings → Pages → Source: None) no mesmo momento do merge. Se o espelho for importante, as alternativas são:

- Settings → Pages → Source: **GitHub Actions**, e acrescentar ao workflow os passos
  `actions/upload-pages-artifact@v3` (path: `dist`) e `actions/deploy-pages@v4` — mas só depois de tornar os links
  sensíveis a `base` (`import.meta.env.BASE_URL`) e buildar com `base: '/jeffersonvalandro'`; ou
- apontar o Pages para um domínio próprio (ex.: `www`), que roda na raiz e dispensa o `base`.

## 4. Merge

Depois dos passos 1 e 2 conferidos (`https://jeffersonvalandro.com.br/` servindo o build do branch `site`):
merge de `astro-revamp` no `main`. O workflow de notícias (`tech-news.yml`) foi removido neste branch, então o commit
diário de notícias para junto.

## Tarefas locais

| Comando | O que faz |
|---|---|
| `npm run dev` | servidor de desenvolvimento |
| `npm run build` / `npm run preview` | build em `dist/` e servidor do build em `http://127.0.0.1:4321` |
| `npm run check` | checagem de tipos do Astro |
| `npm run resume:pdf` | com o preview no ar, gera `public/downloads/jefferson-valandro-{curriculo,resume}.pdf` |
| `npm run og` | gera `public/og.png` a partir de `scripts/og.html` |

`resume:pdf` e `og` usam o Chrome instalado na máquina (playwright-core, sem baixar navegador). Os arquivos gerados
ficam versionados, então o CI não precisa de Chrome. Depois de mudar `src/data/experience.json` ou `profile.json`,
rode `npm run build && npm run preview` e então `npm run resume:pdf`.
