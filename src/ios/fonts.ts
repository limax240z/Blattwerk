// Schriften für neuen Text auf dem iPad (ADR 0024, 0029): Familien von iPadOS mit den PostScript-Namen ihrer Schnitte.
// Die Hülle prüft, welche vorhanden sind, und liefert nur einzelne TrueType-/OpenType-Dateien (keine Sammlungen).
import type { SystemFontStyle } from '../shared/fonts';

export interface IpadFontFamily {
  id: string;
  name: string;
  styles: Partial<Record<SystemFontStyle, string>>;
}

// Kennungen wie auf dem Mac (src/main/files/system-fonts.ts), damit Texte auf beiden Geräten dieselbe Schrift finden
export const IPAD_FONTS: IpadFontFamily[] = [
  { id: 'arial', name: 'Arial', styles: { regular: 'ArialMT', bold: 'Arial-BoldMT', italic: 'Arial-ItalicMT', boldItalic: 'Arial-BoldItalicMT' } },
  {
    id: 'times-new-roman',
    name: 'Times New Roman',
    styles: { regular: 'TimesNewRomanPSMT', bold: 'TimesNewRomanPS-BoldMT', italic: 'TimesNewRomanPS-ItalicMT', boldItalic: 'TimesNewRomanPS-BoldItalicMT' },
  },
  { id: 'georgia', name: 'Georgia', styles: { regular: 'Georgia', bold: 'Georgia-Bold', italic: 'Georgia-Italic', boldItalic: 'Georgia-BoldItalic' } },
  { id: 'verdana', name: 'Verdana', styles: { regular: 'Verdana', bold: 'Verdana-Bold', italic: 'Verdana-Italic', boldItalic: 'Verdana-BoldItalic' } },
  { id: 'trebuchet', name: 'Trebuchet MS', styles: { regular: 'TrebuchetMS', bold: 'TrebuchetMS-Bold', italic: 'TrebuchetMS-Italic', boldItalic: 'Trebuchet-BoldItalic' } },
  {
    id: 'courier-new',
    name: 'Courier New',
    styles: { regular: 'CourierNewPSMT', bold: 'CourierNewPS-BoldMT', italic: 'CourierNewPS-ItalicMT', boldItalic: 'CourierNewPS-BoldItalicMT' },
  },
];
