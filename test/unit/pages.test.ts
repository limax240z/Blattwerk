// Seitenoperationen ohne PDF: Seitenangaben lesen, Verschieben, Teilen, Bilder erkennen und Seitengröße.
import { deflateSync, crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { imagePageLayout, isPdf, readImageInfo } from '../../src/shared/image-info';
import { A4, chunkPages, formatPageRanges, marginsToUser, moveTarget, orderAfterMove, pageSelection, parsePageRanges, splitAtPages } from '../../src/shared/pages';

describe('Seitenangaben', () => {
  it('liest Einzelseiten, Bereiche und offene Bereiche (1-basiert → 0-basiert)', () => {
    expect(parsePageRanges('1-3, 5', 10)).toEqual([0, 1, 2, 4]);
    expect(parsePageRanges('8-', 10)).toEqual([7, 8, 9]);
    expect(parsePageRanges('-2', 10)).toEqual([0, 1]);
    expect(parsePageRanges(' 3 ; 1 ', 10)).toEqual([0, 2]);
    expect(parsePageRanges('2–4', 10)).toEqual([1, 2, 3]);
    expect(parsePageRanges('4,4,3-4', 10)).toEqual([2, 3]);
  });

  it('lehnt Ungültiges ab', () => {
    expect(parsePageRanges('', 10)).toBeNull();
    expect(parsePageRanges('0', 10)).toBeNull();
    expect(parsePageRanges('11', 10)).toBeNull();
    expect(parsePageRanges('5-3', 10)).toBeNull();
    expect(parsePageRanges('a', 10)).toBeNull();
    expect(parsePageRanges('1-2-3', 10)).toBeNull();
  });

  it('schreibt Seiten kompakt', () => {
    expect(formatPageRanges([0, 1, 2, 4, 6, 7])).toBe('1-3, 5, 7-8');
    expect(formatPageRanges([3, 1, 1])).toBe('2, 4');
    expect(formatPageRanges([])).toBe('');
  });
});

describe('Verschieben', () => {
  it('verschiebt mehrere Seiten geschlossen an eine Stelle', () => {
    // Seiten 2 und 4 (Index 1, 3) vor die erste Seite
    expect(orderAfterMove(5, [3, 1], 0)).toEqual([1, 3, 0, 2, 4]);
    // ans Ende
    expect(orderAfterMove(5, [0], 4)).toEqual([1, 2, 3, 4, 0]);
  });

  it('rechnet „vor Seite X“ in den Zielindex von FPDF_MovePages um', () => {
    // Seite 1 (Index 0) vor Seite 4 (Index 3) ziehen: ohne die bewegte Seite steht Seite 4 an Index 2
    expect(moveTarget([0], 3)).toBe(2);
    expect(orderAfterMove(5, [0], moveTarget([0], 3))).toEqual([1, 2, 0, 3, 4]);
    // ans Ende ziehen
    expect(orderAfterMove(5, [1, 2], moveTarget([1, 2], 5))).toEqual([0, 3, 4, 1, 2]);
  });
});

describe('Teilen', () => {
  it('in Stücke zu je N Seiten', () => {
    expect(chunkPages(5, 2)).toEqual([[0, 1], [2, 3], [4]]);
    expect(chunkPages(3, 1)).toEqual([[0], [1], [2]]);
  });

  it('an Startseiten, Seiten davor bilden ein eigenes Stück', () => {
    expect(splitAtPages(10, [2, 6])).toEqual([[0, 1], [2, 3, 4, 5], [6, 7, 8, 9]]);
    expect(splitAtPages(4, [0, 0, 10])).toEqual([[0, 1, 2, 3]]);
  });
});

function png(width: number, height: number): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

// Minimaler JPEG-Kopf: SOI, APP1 mit EXIF-Ausrichtung, SOF0 mit Maßen (genügt zum Lesen der Kopfdaten)
function jpegHeader(width: number, height: number, orientation: number | null, littleEndian = false): Uint8Array {
  const parts: number[] = [0xff, 0xd8];
  if (orientation !== null) {
    const u16 = (v: number) => (littleEndian ? [v & 0xff, v >> 8] : [v >> 8, v & 0xff]);
    const u32 = (v: number) =>
      littleEndian ? [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24] : [v >>> 24, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
    const tiff = [
      ...(littleEndian ? [0x49, 0x49] : [0x4d, 0x4d]),
      ...u16(42),
      ...u32(8),
      ...u16(1),
      ...u16(0x0112),
      ...u16(3),
      ...u32(1),
      ...u16(orientation),
      0,
      0,
      ...u32(0),
    ];
    const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
    const length = body.length + 2;
    parts.push(0xff, 0xe1, length >> 8, length & 0xff, ...body);
  }
  parts.push(0xff, 0xc0, 0, 17, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1);
  return new Uint8Array(parts);
}

describe('Bilder erkennen', () => {
  it('PNG: Maße aus dem IHDR', () => {
    expect(readImageInfo(png(40, 20))).toEqual({ kind: 'png', width: 40, height: 20, rotation: 0 });
  });

  it('JPEG: Maße und EXIF-Ausrichtung (beide Byte-Reihenfolgen)', () => {
    expect(readImageInfo(jpegHeader(4000, 3000, null))).toEqual({ kind: 'jpeg', width: 4000, height: 3000, rotation: 0 });
    expect(readImageInfo(jpegHeader(4000, 3000, 6))?.rotation).toBe(90);
    expect(readImageInfo(jpegHeader(4000, 3000, 8, true))?.rotation).toBe(270);
    expect(readImageInfo(jpegHeader(4000, 3000, 3, true))?.rotation).toBe(180);
  });

  it('erkennt weder Text noch abgeschnittene Dateien als Bild', () => {
    expect(readImageInfo(new TextEncoder().encode('kein Bild'))).toBeNull();
    expect(readImageInfo(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
    expect(readImageInfo(png(10, 10).subarray(0, 20))).toBeNull();
  });

  it('erkennt PDFs an der Signatur, auch nach einem kurzen Vorspann', () => {
    expect(isPdf(new TextEncoder().encode('%PDF-1.7\n'))).toBe(true);
    expect(isPdf(new TextEncoder().encode('Müll\n%PDF-1.4'))).toBe(true);
    expect(isPdf(png(2, 2))).toBe(false);
  });
});

describe('Seitengröße für Bilder', () => {
  // Wendet die Matrix auf einen Punkt des Bild-Einheitsquadrats an
  const apply = (m: number[], x: number, y: number) => [m[0]! * x + m[2]! * y + m[4]!, m[1]! * x + m[3]! * y + m[5]!];

  it('kleine Bilder in Originalgröße, große auf A4 verkleinert (Ausrichtung passend)', () => {
    expect(imagePageLayout({ width: 200, height: 100, rotation: 0 })).toMatchObject({ width: 200, height: 100 });
    const landscape = imagePageLayout({ width: 4000, height: 3000, rotation: 0 });
    // 4:3 im A4-Querformat (842 × 595): Die Höhe begrenzt
    expect(landscape.height).toBeCloseTo(A4.width, 0);
    expect(landscape.width).toBeCloseTo((A4.width * 4) / 3, 0);
    const portrait = imagePageLayout({ width: 3000, height: 4000, rotation: 0 });
    expect(portrait.height).toBeLessThanOrEqual(A4.height);
    expect(portrait.width).toBeLessThanOrEqual(A4.width);
  });

  it('EXIF 90°: Hochformat-Seite, obere Bildkante liegt rechts', () => {
    const layout = imagePageLayout({ width: 400, height: 300, rotation: 90 });
    expect([layout.width, layout.height]).toEqual([300, 400]);
    // Bildecke oben links (0,1) → oben rechts der Seite
    expect(apply(layout.matrix, 0, 1)).toEqual([300, 400]);
    // Bildecke unten links (0,0) → oben links der Seite
    expect(apply(layout.matrix, 0, 0)).toEqual([0, 400]);
  });

  it('EXIF 180° und 270°', () => {
    const turned = imagePageLayout({ width: 400, height: 300, rotation: 180 });
    expect(apply(turned.matrix, 0, 1)).toEqual([400, 0]);
    const left = imagePageLayout({ width: 400, height: 300, rotation: 270 });
    expect(apply(left.matrix, 0, 1)).toEqual([0, 0]);
    expect(apply(left.matrix, 1, 1)).toEqual([0, 400]);
  });
});

describe('Zuschneiden', () => {
  it('rechnet Ränder der angezeigten Seite in Kanten der ungedrehten Seite um', () => {
    const margins = { top: 1, right: 2, bottom: 3, left: 4 };
    expect(marginsToUser(margins, 0)).toEqual(margins);
    // 90° im Uhrzeigersinn: die linke Kante steht oben, die obere rechts
    expect(marginsToUser(margins, 90)).toEqual({ left: 1, top: 2, right: 3, bottom: 4 });
    expect(marginsToUser(margins, 180)).toEqual({ left: 2, top: 3, right: 4, bottom: 1 });
    expect(marginsToUser(margins, 270)).toEqual({ left: 3, top: 4, right: 1, bottom: 2 });
  });
});

describe('Seitenauswahl beim Zusammenführen', () => {
  it('leer heißt alle Seiten', () => {
    expect(pageSelection('', 10)).toBeNull();
    expect(pageSelection('   ', 10)).toBeNull();
  });
  it('liest Bereiche und meldet Ungültiges', () => {
    expect(pageSelection('1-3, 8', 10)).toEqual([0, 1, 2, 7]);
    expect(pageSelection('11', 10)).toBe(false);
    expect(pageSelection('abc', 10)).toBe(false);
  });
});
