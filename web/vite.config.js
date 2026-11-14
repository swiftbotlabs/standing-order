import { defineConfig } from 'vite';
export default defineConfig({ build: { target: 'es2022', outDir: 'dist' }, optimizeDeps: { esbuildOptions: { target: 'es2022' } } });
