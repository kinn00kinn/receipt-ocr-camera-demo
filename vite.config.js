import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs make the build work under https://<user>.github.io/<repo>/
  base: './',
  build: {
    target: 'es2022',
  },
});
