import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { CONTENT_SECURITY_POLICY } from './src/main/protocol-paths';

// Oberfläche für die iPad-App (ADR 0029): dieselbe Seite wie auf dem Mac, aber mit src/ios/entry.ts als Einstieg
// (stellt window.blattwerk bereit). Ziel ist WebKit auf iPadOS 18, Ausgabe in den Ordner, den Xcode einbindet.
const iosEntry = (): Plugin => ({
  name: 'blattwerk-ios-entry',
  // vor der Verarbeitung durch Vite, sonst ist main.tsx schon als Einstieg eingetragen
  transformIndexHtml: { order: 'pre', handler: (html) => html.replace('src="./main.tsx"', 'src="../ios/entry.ts"') },
  // Dieselbe CSP wie auf dem Mac; die Hülle setzt sie in jede Antwort (ios/Blattwerk/SchemeHandler.swift)
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'csp.txt', source: CONTENT_SECURITY_POLICY });
  },
});

export default defineConfig({
  root: path.resolve(import.meta.dirname, 'src/renderer'),
  base: './',
  publicDir: path.resolve(import.meta.dirname, 'src/renderer/public'),
  plugins: [react(), iosEntry()],
  build: {
    outDir: path.resolve(import.meta.dirname, 'out/ios/web'),
    emptyOutDir: true,
    target: 'safari18',
    sourcemap: false,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      input: { main: path.resolve(import.meta.dirname, 'src/renderer/index.html') },
    },
  },
  worker: {
    format: 'es',
  },
});
