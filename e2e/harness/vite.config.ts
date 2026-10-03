import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import autoprefixer from 'autoprefixer';
import tailwindcss from 'tailwindcss';
import { defineConfig } from 'vite';
import appTailwindConfig from '../../tailwind.config.ts';

// Visual test harness for Playwright WebKit. Separate Vite root so it never
// joins the app build or routing. Reuses the app's Tailwind config, PostCSS
// plugins, and src/index.css so tokens and fonts match the app.
const harnessRoot = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  root: harnessRoot,
  envDir: harnessRoot,
  envPrefix: 'HARNESS_',
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('../../src', import.meta.url)),
    },
  },
  css: {
    postcss: {
      plugins: [
        tailwindcss({
          ...appTailwindConfig,
          content: {
            relative: false,
            files: [
              `${repoRoot}/index.html`,
              `${repoRoot}/src/**/*.{ts,tsx}`,
              `${harnessRoot}/**/*.{html,ts,tsx}`,
            ],
          },
        }),
        autoprefixer(),
      ],
    },
  },
  server: {
    fs: { allow: [repoRoot] },
  },
});
