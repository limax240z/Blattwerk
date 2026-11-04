// Viele PDFs speichern Fuß- und Kopfzeilen nicht an ihrem sichtbaren Platz, sondern ganz am Anfang oder Ende des Inhalts.
// Der Browser wählt in der Reihenfolge des Dokuments aus: Eine Fußzeile, die „zuerst“ kommt, klappt die Auswahl beim
// Ziehen nach unten plötzlich nach oben um. Solche Stücke kommen deshalb an ihren sichtbaren Platz. Mehrspaltiger Text
// bleibt, wie er ist: Dort geht der Sprung nach oben zugleich nach rechts.

export interface TextBox {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

// Ein Sprung zählt ab so viel der Seitenhöhe
const JUMP = 0.25;
// Kopf- und Fußzeilen sind kurz: Nur so viele Stücke am Anfang und Ende kommen in Frage
const MAX_RUN = 8;

const jumpsUp = (from: TextBox, to: TextBox, height: number) => from.top - to.bottom > height * JUMP && to.left <= from.right;

/**
 * Wie viele Stücke vom Anfang ans Ende gehören (head) und wie viele vom Ende an den Anfang (tail).
 * boxes in Dokumentreihenfolge, height = Seitenhöhe.
 */
export function misplacedRuns(boxes: TextBox[], height: number): { head: number; tail: number } {
  let head = 0;
  for (let i = 0; i < Math.min(MAX_RUN, boxes.length - 1); i++) {
    if (jumpsUp(boxes[i] as TextBox, boxes[i + 1] as TextBox, height)) {
      head = i + 1;
      break;
    }
  }
  let tail = 0;
  for (let i = boxes.length - 1; i > Math.max(head, boxes.length - 1 - MAX_RUN); i--) {
    if (jumpsUp(boxes[i - 1] as TextBox, boxes[i] as TextBox, height)) {
      tail = boxes.length - i;
      break;
    }
  }
  return { head, tail };
}
