// Stellt window.blattwerk bereit. Eigenes Modul, damit es vor allen Modulen der Oberfläche läuft (Importe werden in
// ihrer Reihenfolge ausgewertet; src/renderer/api.ts liest window.blattwerk beim Laden).
import { createIosApi } from './api';
import { installPinchZoom, installTouchDrawing } from './touch';

document.documentElement.dataset.platform = 'ipad';
window.blattwerk = createIosApi();
installPinchZoom();
installTouchDrawing();
