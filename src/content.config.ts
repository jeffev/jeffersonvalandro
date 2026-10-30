import { defineCollection, z } from 'astro:content';
import { file, glob } from 'astro/loaders';

const i18n = z.object({ pt: z.string(), en: z.string() });
const i18nList = z.object({ pt: z.array(z.string()), en: z.array(z.string()) });
const price = z.object({ personal: z.number(), commercial: z.number() });

const projects = defineCollection({
  loader: file('src/data/projects.json'),
  schema: z.object({
    title: i18n,
    year: z.string(),
    featured: z.number().optional(),
    image: z.string().optional(),
    stack: z.array(z.string()),
    summary: i18n.optional(),
    description: i18n,
    // url por idioma quando o destino tem versão em inglês (a demo do MCP tem /mcp-demo e /mcp-demo/en).
    links: z.array(z.object({
      kind: z.enum(['demo', 'github', 'site', 'study', 'kaggle', 'about']),
      url: z.union([z.string().url(), z.object({ pt: z.string().url(), en: z.string().url() })]),
    })),
  }),
});

const experience = defineCollection({
  loader: file('src/data/experience.json'),
  schema: z.object({
    order: z.number(),
    company: z.union([z.string(), i18n]),
    period: i18n,
    role: i18n,
    summary: i18n,
    bullets: i18nList,
    stack: z.array(z.string()),
  }),
});

const products = defineCollection({
  loader: file('src/data/products.json'),
  schema: z.object({
    order: z.number(),
    name: z.string(),
    kind: z.enum(['app', 'starter', 'site']),
    image: z.string(),
    price,
    buy: z.string().url(),
    demo: z.string().url(),
    description: i18n,
  }),
});

const bundles = defineCollection({
  loader: file('src/data/bundles.json'),
  schema: z.object({
    order: z.number(),
    name: z.string(),
    image: z.string(),
    price,
    buy: z.string().url(),
    includes: z.array(z.string()),
    description: i18n,
  }),
});

const books = defineCollection({
  loader: file('src/data/books.json'),
  schema: z.object({
    group: z.enum(['ai', 'code', 'free', 'finance']),
    order: z.number(),
    title: z.string(),
    image: z.string(),
    pages: z.number().optional(),
    soon: z.boolean().optional(),
    description: i18n,
    links: z
      .array(z.object({ kind: z.enum(['amazon', 'pdf', 'zip']), url: z.string(), price: z.string().optional(), label: i18n.optional() }))
      .optional(),
  }),
});

// Articles: src/content/articles/{pt,en}/<id>.md — the same file name pairs the two languages.
const articles = defineCollection({
  loader: glob({ pattern: '{pt,en}/*.md', base: 'src/content/articles', generateId: ({ entry }) => entry.replace(/\.md$/, '') }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    slug: z.string(),
    theme: z.enum(['arquitetura', 'qualidade', 'ia', 'mlops']),
    order: z.number(),
    cover: z.string().optional(),
    replaces: z.array(z.string()).default([]),
  }),
});

export const collections = { projects, experience, products, bundles, books, articles };
