import type { APIRoute, GetStaticPaths } from 'astro';
import { getCollection } from 'astro:content';
import { articleUrl, routes } from '../../i18n';
import { langOf, nameOf } from '../../lib/articles';
import { redirectPage } from '../../lib/redirect';

// Old URLs were /articles/<slug>.html (English by default). Each one goes to the article that replaced it,
// preferring the English version; articles that were dropped go to the article index.
const legacy = [
  'ai-for-developers', 'angular-best-practices', 'api-design-best-practices', 'cicd-pipelines-backend', 'clean-architecture',
  'clean-code-with-ai', 'code-quality', 'data-pipelines-ml', 'design-patterns-with-ai', 'event-driven-architecture',
  'hexagonal-architecture', 'mcp-for-software-companies', 'microservices-communication', 'mlops-deployment', 'model-monitoring',
  'o-que-a-ia-nao-faz', 'react-best-practices', 'refactoring-with-ai', 'scalable-architectures', 'software-architectures',
  'solid-with-ai', 'spec-driven-development',
];

export const getStaticPaths: GetStaticPaths = async () => {
  const all = await getCollection('articles');
  return legacy.map((old) => {
    const hits = all.filter((a) => a.data.replaces.includes(old));
    const en = hits.find((a) => langOf(a) === 'en');
    const pt = hits.find((a) => langOf(a) === 'pt');
    // The PT-only article keeps its Portuguese audience.
    const target = old === 'o-que-a-ia-nao-faz' && pt ? pt : en ?? pt;
    const to = target ? articleUrl(langOf(target), target.data.slug) : routes.articles.en;
    return { params: { old }, props: { to, name: target ? nameOf(target) : null } };
  });
};

export const GET: APIRoute = ({ props, site }) => redirectPage(props.to as string, site!);
