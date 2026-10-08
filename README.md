# lazlogic.com

Marketing site for **LazLogic**, the spatial intelligence platform for point clouds and geospatial data.

Built with [Astro](https://astro.build) as a fully static site and deployed to GitHub Pages at
[lazlogic.com](https://lazlogic.com).

## Development

```bash
npm install
npm run dev       # http://localhost:4321
npm run check     # type-check .astro and .ts files
npm run build     # static output in dist/
npm run preview   # serve dist/ locally
```

Node 22+ is recommended (CI uses 22).

## Structure

```
src/
  config.ts              site name, contact email, optional form endpoint
  layouts/Base.astro     <head>, meta/OG tags, scroll-reveal observer
  pages/index.astro      homepage, assembled from section components
  pages/404.astro
  components/            one component per homepage section
  scripts/scenes.ts      procedural point-cloud scenes (city, corridor, powerline, mine, site)
  scripts/pointcloud.ts  small WebGL1 renderer: splats, classification sweep, before/after split
  styles/global.css      design tokens and shared primitives
public/
  CNAME                  custom domain for GitHub Pages
  og.png                 social preview image (1200×630)
```

The 3D visuals contain no point data: each scene is generated from a fixed seed in the browser, so
the page stays small and renders the same scene on every visit.

## Before launch

- **Stats** in `src/components/Stats.astro` are placeholders. Replace them with real figures.
- **Demo form**: set `formEndpoint` in `src/config.ts` to a form backend (Formspree, Basin, a Lambda
  URL, …) that accepts a JSON POST. While it is empty, the form opens a pre-filled email to
  `hello@lazlogic.com`. Make sure that mailbox exists.
- Review product claims in the copy (formats, SDKs, integrations) against what ships.

## Deploying to GitHub Pages

1. Push this repo to GitHub, then go to **Settings → Pages → Build and deployment** and set
   **Source** to **GitHub Actions**. `.github/workflows/deploy.yml` builds and deploys every push to `main`.
2. In **Settings → Pages → Custom domain**, enter `lazlogic.com` (also stored in `public/CNAME`).
3. At your DNS provider, add:

   | Type  | Host  | Value                   |
   | ----- | ----- | ----------------------- |
   | A     | `@`   | `185.199.108.153`       |
   | A     | `@`   | `185.199.109.153`       |
   | A     | `@`   | `185.199.110.153`       |
   | A     | `@`   | `185.199.111.153`       |
   | AAAA  | `@`   | `2606:50c0:8000::153`   |
   | AAAA  | `@`   | `2606:50c0:8001::153`   |
   | AAAA  | `@`   | `2606:50c0:8002::153`   |
   | AAAA  | `@`   | `2606:50c0:8003::153`   |
   | CNAME | `www` | `<github-user-or-org>.github.io` |

4. Once DNS resolves, tick **Enforce HTTPS**. To guard against domain takeover, also
   [verify the domain](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/verifying-your-custom-domain-for-github-pages)
   for your account or organisation.
