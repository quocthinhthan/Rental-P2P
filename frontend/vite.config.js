import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hasFrontendEnv =
  fs.existsSync(path.resolve(__dirname, '.env')) ||
  fs.existsSync(path.resolve(__dirname, '.env.local'));

export default defineConfig({
  plugins: [react()],
  envDir: hasFrontendEnv ? '.' : '..',
  envPrefix: ['VITE_', 'REACT_APP_'],
  server: {
    port: 3000,
  },
  build: {
    outDir: 'build',
  },
});
