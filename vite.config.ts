import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
const projectRoot = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({
  root: `${projectRoot}client`, publicDir: `${projectRoot}public`, plugins: [react()],
  build: { outDir: `${projectRoot}dist/client`, emptyOutDir: true },
});
