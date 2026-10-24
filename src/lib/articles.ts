import { getCollection, type CollectionEntry } from 'astro:content';
import { articleUrl, type Lang } from '../i18n';

export type Article = CollectionEntry<'articles'>;
export const themes = ['arquitetura', 'qualidade', 'ia', 'mlops'] as const;

/** Entry id is "<lang>/<name>"; the name pairs the two translations. */
export const nameOf = (a: Article) => a.id.split('/')[1];
export const langOf = (a: Article) => a.id.split('/')[0] as Lang;

export async function articlesFor(lang: Lang) {
  const all = await getCollection('articles', (a) => langOf(a) === lang);
  return all.sort((a, b) => themes.indexOf(a.data.theme) - themes.indexOf(b.data.theme) || a.data.order - b.data.order);
}

/** Articles to list on a language's index: its own ones, plus PT-only articles on the EN side. */
export async function listingFor(lang: Lang) {
  const own = await articlesFor(lang);
  if (lang === 'pt') return own.map((a) => ({ article: a, foreign: false }));
  const names = new Set(own.map(nameOf));
  const ptOnly = (await articlesFor('pt')).filter((a) => !names.has(nameOf(a)));
  return [...own.map((a) => ({ article: a, foreign: false })), ...ptOnly.map((a) => ({ article: a, foreign: true }))].sort(
    (x, y) =>
      themes.indexOf(x.article.data.theme) - themes.indexOf(y.article.data.theme) || x.article.data.order - y.article.data.order,
  );
}

/** URL of the same article in the other language, or null when it has no translation. */
export async function counterpart(a: Article, to: Lang) {
  const other = (await getCollection('articles')).find((x) => langOf(x) === to && nameOf(x) === nameOf(a));
  return other ? articleUrl(to, other.data.slug) : null;
}

export const readingMinutes = (body = '') => Math.max(1, Math.round(body.split(/\s+/).filter(Boolean).length / 220));
