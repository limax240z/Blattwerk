import type { Annotation, Point, Rgb } from '../../../shared/annotations';
import { dashPattern, stampColor as colorOfStamp, stampLines } from '../../../shared/annotations';
import type { PageGeometry } from '../../engine/coords';

export const css = ({ r, g, b }: Rgb) => `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;

function points(geometry: PageGeometry, list: Point[]): string {
  return list.map((p) => geometry.toView(p).join(',')).join(' ');
}

function arrowHead(geometry: PageGeometry, start: Point, end: Point, width: number): string {
  const [sx, sy] = geometry.toView(start);
  const [ex, ey] = geometry.toView(end);
  const angle = Math.atan2(ey - sy, ex - sx);
  const length = Math.max(8, width * 4);
  const spread = Math.PI / 7;
  const p1 = [ex - length * Math.cos(angle - spread), ey - length * Math.sin(angle - spread)];
  const p2 = [ex - length * Math.cos(angle + spread), ey - length * Math.sin(angle + spread)];
  return `${p1.join(',')} ${ex},${ey} ${p2.join(',')}`;
}

// Zeichnet einen Kommentar so, wie er nach dem Speichern aussieht (Annäherung an die PDFium-Darstellung).
export function AnnotationShape({ annotation: a, geometry }: { annotation: Annotation; geometry: PageGeometry }) {
  const color = css(a.color);
  switch (a.kind) {
    case 'highlight':
      return (
        <g opacity={a.opacity} style={{ mixBlendMode: 'multiply' }}>
          {a.quads.map((q, i) => (
            <polygon key={i} points={points(geometry, [q[0], q[1], q[3], q[2]])} fill={color} />
          ))}
        </g>
      );
    case 'underline':
    case 'strikeout':
    case 'squiggly':
      return (
        <g opacity={a.opacity}>
          {a.quads.map((q, i) => {
            const [tl, tr, bl, br] = q;
            const height = Math.hypot(tl.x - bl.x, tl.y - bl.y);
            const width = Math.max(1, height * 0.07);
            if (a.kind === 'strikeout') {
              const mid = (p: Point, r: Point): Point => ({ x: (p.x + r.x) / 2, y: (p.y + r.y) / 2 });
              return <polyline key={i} points={points(geometry, [mid(tl, bl), mid(tr, br)])} stroke={color} strokeWidth={width} />;
            }
            if (a.kind === 'underline') {
              return <polyline key={i} points={points(geometry, [bl, br])} stroke={color} strokeWidth={width} />;
            }
            const steps = Math.max(2, Math.round(Math.hypot(br.x - bl.x, br.y - bl.y) / 3));
            const wave = Array.from({ length: steps + 1 }, (_, s) => {
              const f = s / steps;
              const offset = s % 2 === 0 ? 0 : height * 0.12;
              return { x: bl.x + (br.x - bl.x) * f, y: bl.y + (br.y - bl.y) * f + offset };
            });
            return <polyline key={i} points={points(geometry, wave)} stroke={color} strokeWidth={width} fill="none" />;
          })}
        </g>
      );
    case 'note': {
      const r = geometry.rectToView(a.rect);
      return (
        <g opacity={a.opacity}>
          <rect x={r.x} y={r.y} width={r.w} height={r.h * 0.82} rx={2} fill={color} stroke="rgba(0,0,0,0.55)" strokeWidth={0.8} />
          <polygon
            points={`${r.x + r.w * 0.3},${r.y + r.h * 0.82} ${r.x + r.w * 0.5},${r.y + r.h} ${r.x + r.w * 0.55},${r.y + r.h * 0.82}`}
            fill={color}
            stroke="rgba(0,0,0,0.55)"
            strokeWidth={0.8}
          />
          {[0.25, 0.45, 0.65].map((f) => (
            <line key={f} x1={r.x + r.w * 0.2} x2={r.x + r.w * 0.8} y1={r.y + r.h * f} y2={r.y + r.h * f} stroke="rgba(0,0,0,0.6)" strokeWidth={0.8} />
          ))}
        </g>
      );
    }
    case 'freetext': {
      const r = geometry.rectToView(a.rect);
      return (
        <foreignObject x={r.x} y={r.y} width={r.w} height={r.h} opacity={a.opacity}>
          <div
            style={{
              width: '100%',
              height: '100%',
              color,
              fontFamily: 'Helvetica, Arial, sans-serif',
              fontSize: a.fontSize,
              lineHeight: 1.15,
              padding: 2,
              overflow: 'hidden',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
            }}
          >
            {a.contents}
          </div>
        </foreignObject>
      );
    }
    case 'ink':
      return (
        <g
          opacity={a.opacity}
          fill="none"
          stroke={color}
          strokeWidth={a.width}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray={dashPattern(a.dash ?? 'solid', a.width).join(' ') || undefined}
        >
          {a.paths.map((path, i) => (
            <polyline key={i} points={points(geometry, path)} />
          ))}
        </g>
      );
    case 'square':
    case 'circle': {
      const r = geometry.rectToView(a.rect);
      const inset = a.width / 2;
      const fill = a.fill ? css(a.fill) : 'none';
      return (
        <g opacity={a.opacity} stroke={color} strokeWidth={a.width} fill={fill}>
          {a.kind === 'square' ? (
            <rect x={r.x + inset} y={r.y + inset} width={Math.max(0, r.w - a.width)} height={Math.max(0, r.h - a.width)} />
          ) : (
            <ellipse cx={r.x + r.w / 2} cy={r.y + r.h / 2} rx={Math.max(0, r.w / 2 - inset)} ry={Math.max(0, r.h / 2 - inset)} />
          )}
        </g>
      );
    }
    case 'line':
    case 'arrow':
      return (
        <g opacity={a.opacity} stroke={color} strokeWidth={a.width} fill="none" strokeLinecap="round">
          <polyline points={points(geometry, [a.start, a.end])} />
          {a.kind === 'arrow' && <polyline points={arrowHead(geometry, a.start, a.end, a.width)} strokeLinejoin="round" />}
        </g>
      );
    case 'redact': {
      // Roter Umriss mit halbdurchsichtiger Füllung: Hier wird beim Anwenden geschwärzt.
      const style = { fill: 'rgba(0, 0, 0, 0.28)', stroke: color, strokeWidth: 1.5, vectorEffect: 'non-scaling-stroke' as const };
      if (a.quads.length > 0) {
        return (
          <g data-testid="redaction-mark">
            {a.quads.map((q, i) => (
              <polygon key={i} points={points(geometry, [q[0], q[1], q[3], q[2]])} style={style} />
            ))}
          </g>
        );
      }
      const r = geometry.rectToView(a.rect);
      return <rect x={r.x} y={r.y} width={r.w} height={r.h} style={style} data-testid="redaction-mark" />;
    }
    case 'signature': {
      const r = geometry.rectToView(a.rect);
      return (
        <image
          href={`data:image/png;base64,${a.image}`}
          x={r.x}
          y={r.y}
          width={r.w}
          height={r.h}
          preserveAspectRatio="none"
          opacity={a.opacity}
        />
      );
    }
    case 'stamp': {
      const r = geometry.rectToView(a.rect);
      // Stempel aus anderen Programmen: Aussehen unbekannt, bis zum Speichern nur der Umriss an der neuen Stelle
      if (!a.label) {
        return (
          <rect
            x={r.x}
            y={r.y}
            width={r.w}
            height={r.h}
            fill="none"
            stroke="rgb(120, 120, 120)"
            strokeWidth={1}
            strokeDasharray="6 4"
            vectorEffect="non-scaling-stroke"
          />
        );
      }
      const stampColor = css(colorOfStamp(a));
      const border = Math.max(1.5, r.h * 0.06);
      // Eine oder zwei Zeilen (eigene Stempel: Text, darunter Datum/Name); wie beim Speichern (#buildStampAppearance)
      const [first = '', second] = stampLines(a.label);
      const fit = (text: string, share: number, weight: number) => Math.min(r.h * share, (r.w - border * 4) / Math.max(1, text.length * weight));
      const fontSize = fit(first, second ? 0.36 : 0.5, 0.68);
      const smallSize = second ? fit(second, 0.22, 0.56) : 0;
      return (
        <g opacity={a.opacity}>
          <rect
            x={r.x + border / 2}
            y={r.y + border / 2}
            width={Math.max(0, r.w - border)}
            height={Math.max(0, r.h - border)}
            fill="none"
            stroke={stampColor}
            strokeWidth={border}
          />
          <text
            x={r.x + r.w / 2}
            y={second ? r.y + r.h * 0.4 : r.y + r.h / 2}
            fill={stampColor}
            fontFamily="Helvetica, Arial, sans-serif"
            fontWeight="bold"
            fontSize={fontSize}
            textAnchor="middle"
            dominantBaseline="central"
          >
            {first}
          </text>
          {second && (
            <text x={r.x + r.w / 2} y={r.y + r.h * 0.74} fill={stampColor} fontFamily="Helvetica, Arial, sans-serif" fontSize={smallSize} textAnchor="middle" dominantBaseline="central">
              {second}
            </text>
          )}
        </g>
      );
    }
  }
}
