import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'pdfjs-dist/web/pdf_viewer.css';
import './styles/tokens.css';
import './styles/global.css';
import './i18n';
import { App } from './app/App';

// macOS: Fenstertitel und Werkzeugleiste sind eins (Ampelknöpfe in der Leiste, siehe window.ts). Die iPad-App setzt
// „ipad“ vorher selbst (src/ios/entry.ts; Safari auf dem iPad meldet sich ebenfalls als „Macintosh“).
document.documentElement.dataset.platform ??= navigator.userAgent.includes('Macintosh') ? 'mac' : 'other';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
