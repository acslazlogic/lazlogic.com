// @ts-check
import { defineConfig } from 'astro/config';

// Served from the apex domain via GitHub Pages (see public/CNAME), so no `base` is needed.
export default defineConfig({
  site: 'https://lazlogic.com',
  trailingSlash: 'ignore',
});
