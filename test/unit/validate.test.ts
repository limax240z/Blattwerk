import { describe, expect, it } from 'vitest';
import { MAX_READ_CHUNK } from '../../src/shared/ipc';
import {
  renameTarget,
  isAllowedExternalUrl,
  isFileId,
  isSafeLocalPath,
  looksLikePdf,
  validateMenuState,
  validateReadRange,
  sanitizeFileName,
  validateTabDestination,
  validateTabDragHoverState,
  validateTabDragMessage,
  validateTabTransfer,
} from '../../src/shared/validate';

const bytes = (text: string) => new TextEncoder().encode(text);

describe('looksLikePdf', () => {
  it('erkennt den PDF-Kopf am Anfang', () => {
    expect(looksLikePdf(bytes('%PDF-1.7\n...'))).toBe(true);
  });
  it('erkennt den PDF-Kopf nach Müll in den ersten 1024 Bytes', () => {
    expect(looksLikePdf(bytes(`${'x'.repeat(500)}%PDF-1.4`))).toBe(true);
  });
  it('lehnt Text ohne Kopf ab', () => {
    expect(looksLikePdf(bytes('Das ist kein PDF'))).toBe(false);
    expect(looksLikePdf(new Uint8Array())).toBe(false);
  });
  it('sucht nicht weiter als 1024 Bytes', () => {
    expect(looksLikePdf(bytes(`${'x'.repeat(1100)}%PDF-1.4`))).toBe(false);
  });
});

describe('validateReadRange', () => {
  it('akzeptiert gültige Bereiche und kürzt auf die Dateigröße', () => {
    expect(validateReadRange(0, 100, 50)).toEqual({ begin: 0, end: 50 });
    expect(validateReadRange(10, 20, 100)).toEqual({ begin: 10, end: 20 });
  });
  it('lehnt negative, ungeordnete und nicht ganzzahlige Werte ab', () => {
    expect(validateReadRange(-1, 10, 100)).toBeNull();
    expect(validateReadRange(20, 10, 100)).toBeNull();
    expect(validateReadRange(1.5, 10, 100)).toBeNull();
    expect(validateReadRange('0', 10, 100)).toBeNull();
    expect(validateReadRange(200, 300, 100)).toBeNull();
  });
  it('lehnt zu große Einzelzugriffe ab', () => {
    expect(validateReadRange(0, MAX_READ_CHUNK + 1, MAX_READ_CHUNK * 2)).toBeNull();
    expect(validateReadRange(0, MAX_READ_CHUNK, MAX_READ_CHUNK * 2)).not.toBeNull();
  });
});

describe('isAllowedExternalUrl', () => {
  it('erlaubt nur http, https und mailto', () => {
    expect(isAllowedExternalUrl('https://example.com')).toBe(true);
    expect(isAllowedExternalUrl('http://example.com/a?b=c')).toBe(true);
    expect(isAllowedExternalUrl('mailto:info@example.com')).toBe(true);
    expect(isAllowedExternalUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedExternalUrl('smb://server/share')).toBe(false);
    expect(isAllowedExternalUrl('kein link')).toBe(false);
    expect(isAllowedExternalUrl(42)).toBe(false);
  });
  it('lehnt Links mit Zugangsdaten im Host-Teil ab (Täuschung über das Ziel)', () => {
    expect(isAllowedExternalUrl('https://www.bank.de@boese.example/login')).toBe(false);
    expect(isAllowedExternalUrl('https://nutzer:pw@example.com')).toBe(false);
  });
});

describe('isSafeLocalPath', () => {
  it('erlaubt nur absolute lokale Pfade', () => {
    expect(isSafeLocalPath('/Users/a/datei.pdf', 'darwin')).toBe(true);
    expect(isSafeLocalPath('relativ/datei.pdf', 'darwin')).toBe(false);
    expect(isSafeLocalPath('C:\\Daten\\datei.pdf', 'win32')).toBe(true);
    expect(isSafeLocalPath('D:/Daten/datei.pdf', 'win32')).toBe(true);
  });
  it('lehnt Netzwerk- und Gerätepfade unter Windows ab', () => {
    expect(isSafeLocalPath('\\\\server\\freigabe\\datei.pdf', 'win32')).toBe(false);
    expect(isSafeLocalPath('\\\\?\\C:\\datei.pdf', 'win32')).toBe(false);
    expect(isSafeLocalPath('//server/freigabe/datei.pdf', 'win32')).toBe(false);
  });
  it('lehnt leere, zu lange und Nullbyte-Pfade ab', () => {
    expect(isSafeLocalPath('', 'darwin')).toBe(false);
    expect(isSafeLocalPath(`/${'a'.repeat(5000)}`, 'darwin')).toBe(false);
    expect(isSafeLocalPath('/a\0b', 'darwin')).toBe(false);
    expect(isSafeLocalPath(42, 'darwin')).toBe(false);
  });
});

describe('isFileId', () => {
  it('erkennt UUIDs', () => {
    expect(isFileId('3f2b8c1e-1234-4abc-9def-0123456789ab')).toBe(true);
    expect(isFileId('../../etc/passwd')).toBe(false);
  });
});

describe('validateMenuState', () => {
  const valid = {
    hasDocument: true,
    canPrint: false,
    viewMode: 'two-page',
    sidebarVisible: true,
    readMode: false,
    rightPanelVisible: false,
    tabCount: 2,
    dirtyCount: 1,
    canUndo: true,
    canRedo: false,
    activeDirty: true,
    commentToolsVisible: false,
    organizeMode: true,
    canAssemble: true,
    canExtract: false,
    formEditing: false,
    canEditForms: true,
    redactToolsVisible: false,
    markToolsVisible: false,
    hasRedactionMarks: true,
    contentEditing: false,
  };
  it('übernimmt einen gültigen Zustand', () => {
    expect(validateMenuState(valid)).toEqual(valid);
    expect(validateMenuState({ ...valid, viewMode: null })).not.toBeNull();
  });
  it('lehnt ungültige Werte ab', () => {
    expect(validateMenuState({ ...valid, viewMode: 'quer' })).toBeNull();
    expect(validateMenuState({ ...valid, tabCount: -1 })).toBeNull();
    expect(validateMenuState({ ...valid, hasDocument: 'ja' })).toBeNull();
    expect(validateMenuState({ ...valid, dirtyCount: 1.5 })).toBeNull();
    expect(validateMenuState({ ...valid, canUndo: 'ja' })).toBeNull();
    expect(validateMenuState(null)).toBeNull();
  });
});

describe('sanitizeFileName', () => {
  it('entfernt Pfadanteile und verbotene Zeichen', () => {
    expect(sanitizeFileName('Bericht')).toBe('Bericht.pdf');
    expect(sanitizeFileName('a/b\\c')).toBe('a-b-c.pdf');
    expect(sanitizeFileName('../../etc/passwd')).toBe('-..-etc-passwd.pdf');
    expect(sanitizeFileName('Teil:1?*')).toBe('Teil-1--.pdf');
    expect(sanitizeFileName('Zeile\nUmbruch')).toBe('Zeile-Umbruch.pdf');
  });
  it('vermeidet leere, versteckte und reservierte Namen', () => {
    expect(sanitizeFileName('')).toBe('Dokument.pdf');
    expect(sanitizeFileName('  ..Name..  ')).toBe('Name.pdf');
    expect(sanitizeFileName('CON')).toBe('_CON.pdf');
    expect(sanitizeFileName('com1.txt')).toBe('_com1.txt.pdf');
    expect(sanitizeFileName(42)).toBe('Dokument.pdf');
  });
  it('behält Umlaute und eine vorhandene Endung, begrenzt die Länge', () => {
    expect(sanitizeFileName('Ünïcödé Name.PDF')).toBe('Ünïcödé Name.pdf');
    expect(sanitizeFileName('x'.repeat(300))).toHaveLength(150);
  });
});

describe('Tab-Übergabe zwischen Fenstern', () => {
  const pdf = new TextEncoder().encode('%PDF-1.7\n%%EOF');

  it('nimmt gültige Übergaben an', () => {
    expect(
      validateTabTransfer({ bytes: null, password: null, filePassword: null, page: 1 }),
    ).toEqual({ bytes: null, password: null, filePassword: null, page: 1 });
    expect(
      validateTabTransfer({ bytes: pdf, password: 'geheim', filePassword: null, page: 3 })?.bytes,
    ).toBe(pdf);
  });

  it('lehnt Nicht-PDFs, ungültige Seiten und lange Kennwörter ab', () => {
    expect(
      validateTabTransfer({
        bytes: new Uint8Array([1, 2, 3]),
        password: null,
        filePassword: null,
        page: 1,
      }),
    ).toBeNull();
    expect(
      validateTabTransfer({ bytes: null, password: null, filePassword: null, page: 0 }),
    ).toBeNull();
    expect(
      validateTabTransfer({ bytes: null, password: 'x'.repeat(2000), filePassword: null, page: 1 }),
    ).toBeNull();
    expect(validateTabTransfer(null)).toBeNull();
  });

  it('prüft das Ziel', () => {
    expect(validateTabDestination({ kind: 'point', x: 10, y: -20 })).toEqual({
      kind: 'point',
      x: 10,
      y: -20,
    });
    expect(validateTabDestination({ kind: 'merge' })).toEqual({ kind: 'merge' });
    expect(validateTabDestination({ kind: 'new', extra: 1 })).toEqual({ kind: 'new' });
    expect(validateTabDestination({ kind: 'point', x: Number.NaN, y: 0 })).toBeNull();
    expect(validateTabDestination({ kind: 'anywhere' })).toBeNull();
  });

  it('prüft Meldungen beim Ziehen über die Fenstergrenze', () => {
    const start = {
      kind: 'start',
      title: 'a.pdf',
      tabOffset: { x: 4, y: 5 },
      grip: { x: 30, y: 60 },
    };
    expect(validateTabDragMessage(start)).toEqual(start);
    expect(validateTabDragMessage({ kind: 'move', x: 1, y: 2, detached: true })).toEqual({
      kind: 'move',
      x: 1,
      y: 2,
      detached: true,
    });
    expect(validateTabDragMessage({ kind: 'end', more: 1 })).toEqual({ kind: 'end' });
    expect(validateTabDragMessage({ ...start, title: 'x'.repeat(2000) })).toBeNull();
    expect(validateTabDragMessage({ kind: 'move', x: 1, y: 2 })).toBeNull();
    expect(validateTabDragHoverState({ overBar: true, index: 2 })).toEqual({
      overBar: true,
      index: 2,
    });
    expect(validateTabDragHoverState({ overBar: true, index: -1 })).toBeNull();
  });
});

describe('renameTarget', () => {
  it('ergänzt .pdf, ersetzt unzulässige Zeichen, lehnt Leeres ab', () => {
    expect(renameTarget('Bewerbung')).toBe('Bewerbung.pdf');
    expect(renameTarget('Bewerbung.PDF')).toBe('Bewerbung.pdf');
    expect(renameTarget('a/b:c')).toBe('a-b-c.pdf');
    expect(renameTarget('   ')).toBeNull();
    expect(renameTarget('.pdf')).toBeNull();
    expect(renameTarget(5)).toBeNull();
  });
});
