// Kleinstes gültiges PDF mit einer leeren A4-Seite („Unbenannt“). Ohne Node-Abhängigkeiten, damit es Mac-App und
// iPad-App (ADR 0029) gleichermaßen nutzen.
import { PRODUCT_NAME } from './product';

// A4 hoch in Punkt
const A4 = [595.28, 841.89] as const;

// Zeichen bis U+00FF als je ein Byte (Latin-1)
const latin1 = (text: string): Uint8Array => Uint8Array.from(text, (char) => char.charCodeAt(0) & 0xff);

// Querverweistabelle mit genauen Positionen
export function blankPdf(now = new Date()): Uint8Array {
  const two = (n: number) => String(n).padStart(2, '0');
  const date = `D:${now.getUTCFullYear()}${two(now.getUTCMonth() + 1)}${two(now.getUTCDate())}${two(now.getUTCHours())}${two(now.getUTCMinutes())}${two(now.getUTCSeconds())}Z`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4[0]} ${A4[1]}] /Resources << >> /Contents 4 0 R >>`,
    '<< /Length 0 >>\nstream\n\nendstream',
    `<< /Producer (${PRODUCT_NAME}) /Creator (${PRODUCT_NAME}) /CreationDate (${date}) /ModDate (${date}) >>`,
  ];
  // Jedes Zeichen ist ein Byte, die Länge der Zeichenkette ist also die Position
  let body = '%PDF-1.7\n%âãÏÓ\n';
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return latin1(body);
}
