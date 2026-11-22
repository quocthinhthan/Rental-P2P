import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const ENV_PREFIXES = ['VITE_', 'REACT_APP_'];

export default defineConfig(({ mode }) => {
  // Load shared root .env* first, then dedicated frontend/.env* (including .env.local, .env.[mode])
  const rootEnv = loadEnv(mode, rootDir, ENV_PREFIXES);
  const frontendEnv = loadEnv(mode, __dirname, ENV_PREFIXES);

  // Merge: dedicated frontend values override root values only when non-empty
  const mergedClientEnv = {};
  for (const [key, value] of Object.entries(rootEnv)) {
    if (value !== '') {
      mergedClientEnv[key] = value;
    }
  }
  for (const [key, value] of Object.entries(frontendEnv)) {
    if (value !== '') {
      mergedClientEnv[key] = value;
    }
  }

  // Respect FRONTEND_PORT (shell > frontend/.env* > root .env* > 3000)
  const rootPortEnv = loadEnv(mode, rootDir, 'FRONTEND_PORT');
  const frontendPortEnv = loadEnv(mode, __dirname, 'FRONTEND_PORT');
  const rawPort =
    process.env.FRONTEND_PORT ||
    frontendPortEnv.FRONTEND_PORT ||
    rootPortEnv.FRONTEND_PORT ||
    '3000';
  const parsedPort = Number.parseInt(rawPort, 10);
  const port =
    Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535
      ? parsedPort
      : 3000;

  const define = Object.fromEntries(
    Object.entries(mergedClientEnv).map(([key, value]) => [
      `import.meta.env.${key}`,
      JSON.stringify(value),
    ])
  );

  return {
    plugins: [react()],
    envDir: __dirname,
    envPrefix: ENV_PREFIXES,
    define,
    server: {
      port,
      strictPort: true,
    },
    build: {
      outDir: 'build',
    },
  };
});
