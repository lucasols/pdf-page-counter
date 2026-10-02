import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/main.ts'],
  outDir: 'dist',
  clean: true,
  dts: true,
  tsconfig: './tsconfig.prod.json',
  format: ['esm'],
  fixedExtension: false,
});
