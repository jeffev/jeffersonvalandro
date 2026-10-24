import type { ImageMetadata } from 'astro';

const projects = import.meta.glob<{ default: ImageMetadata }>('../assets/projects/*.{png,jpg}', { eager: true });
const products = import.meta.glob<{ default: ImageMetadata }>('../assets/products/*.{png,jpg}', { eager: true });

const byName = (files: Record<string, { default: ImageMetadata }>) =>
  Object.fromEntries(Object.entries(files).map(([path, mod]) => [path.split('/').pop()!, mod.default]));

const projectImages = byName(projects);
const productImages = byName(products);

export function projectImage(name?: string): ImageMetadata | undefined {
  if (!name) return undefined;
  const img = projectImages[name];
  if (!img) throw new Error(`Project image not found: ${name}`);
  return img;
}

export function productImage(name: string): ImageMetadata {
  const img = productImages[name];
  if (!img) throw new Error(`Product image not found: ${name}`);
  return img;
}
