import type { APIRoute } from 'astro';
import { redirectPage } from '../lib/redirect';

export const GET: APIRoute = ({ site }) => redirectPage('/', site!);
