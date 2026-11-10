/**
 * Le forme di bocca dei visemi, come geometria parametrica invece di 15 disegni
 * a mano.
 *
 * Ogni viseme è una bocca con tre parametri: quanto è APERTA (verticale),
 * quanto è LARGA (orizzontale), e quanto le labbra sono ARROTONDATE (una "o" è
 * tonda, una "i" è tesa). Da questi tre numeri si genera il path SVG. Il
 * vantaggio non è la pigrizia: parametri vicini danno forme vicine, quindi le
 * transizioni fra un viseme e l'altro si possono INTERPOLARE — la bocca scorre
 * da una forma all'altra invece di scattare, che è ciò che distingue un
 * lipsync credibile da uno a scatti.
 *
 * Questa è la prima versione: labbra stilizzate, non la bocca reale della
 * persona. Gli sprite fotorealistici ritagliati dal poster arrivano in una
 * fase successiva (CA-2) e sostituiranno il disegno senza toccare il timing.
 */

export type VisemeId =
  | "sil" | "PP" | "FF" | "TH" | "DD" | "kk" | "CH" | "SS"
  | "nn" | "RR" | "aa" | "E" | "I" | "O" | "U";

/** apertura (0-1), larghezza (0-1), arrotondamento (0-1). */
interface Forma {
  apertura: number;
  larghezza: number;
  tondo: number;
}

//: I tre numeri per ogni viseme. Tarati perché la forma si legga a colpo
//: d'occhio: "aa" spalancata, "O"/"U" tonde e strette, "I" larga e tesa, le
//: chiuse (sil/PP) davvero chiuse.
const FORME: Record<VisemeId, Forma> = {
  sil: { apertura: 0.06, larghezza: 0.55, tondo: 0.3 },
  PP:  { apertura: 0.0,  larghezza: 0.5,  tondo: 0.2 },
  FF:  { apertura: 0.12, larghezza: 0.55, tondo: 0.2 },
  TH:  { apertura: 0.22, larghezza: 0.55, tondo: 0.3 },
  DD:  { apertura: 0.3,  larghezza: 0.55, tondo: 0.3 },
  kk:  { apertura: 0.28, larghezza: 0.5,  tondo: 0.35 },
  CH:  { apertura: 0.26, larghezza: 0.42, tondo: 0.7 },
  SS:  { apertura: 0.16, larghezza: 0.6,  tondo: 0.2 },
  nn:  { apertura: 0.2,  larghezza: 0.55, tondo: 0.3 },
  RR:  { apertura: 0.3,  larghezza: 0.45, tondo: 0.5 },
  aa:  { apertura: 0.95, larghezza: 0.7,  tondo: 0.3 },
  E:   { apertura: 0.55, larghezza: 0.8,  tondo: 0.2 },
  I:   { apertura: 0.35, larghezza: 0.95, tondo: 0.1 },
  O:   { apertura: 0.7,  larghezza: 0.4,  tondo: 0.9 },
  U:   { apertura: 0.4,  larghezza: 0.28, tondo: 1.0 },
};

/** Interpola linearmente due forme (frazione 0 = a, 1 = b). */
function fondi(a: Forma, b: Forma, k: number): Forma {
  const m = (x: number, y: number) => x + (y - x) * k;
  return {
    apertura: m(a.apertura, b.apertura),
    larghezza: m(a.larghezza, b.larghezza),
    tondo: m(a.tondo, b.tondo),
  };
}

/**
 * Il path SVG della bocca per un viseme, in un viewBox 100×100.
 *
 * `verso`/`k`: se dati, la forma è interpolata da `id` verso `verso` alla
 * frazione `k` — è ciò che rende continua la transizione fra due visemi.
 */
export function pathBocca(id: VisemeId, verso?: VisemeId, k = 0): string {
  let f = FORME[id] ?? FORME.sil;
  if (verso && k > 0) f = fondi(f, FORME[verso] ?? f, Math.min(1, Math.max(0, k)));

  const cx = 50;
  const cy = 55;
  const rx = 12 + f.larghezza * 26; // semi-larghezza
  const ry = 2 + f.apertura * 26; // semi-altezza

  if (f.apertura < 0.04) {
    // Bocca chiusa: una linea leggermente incurvata, non un'ellisse degenere.
    return `M ${cx - rx} ${cy} Q ${cx} ${cy + 3} ${cx + rx} ${cy}`;
  }
  // Ellisse come due archi di Bézier. `tondo` sposta i punti di controllo:
  // vicino a 1 gli angoli si arrotondano (o/u), vicino a 0 restano tesi (i).
  const c = 0.55 + f.tondo * 0.35;
  const ox = rx * c;
  const oy = ry * c;
  return (
    `M ${cx - rx} ${cy} ` +
    `C ${cx - ox} ${cy - oy} ${cx + ox} ${cy - oy} ${cx + rx} ${cy} ` +
    `C ${cx + ox} ${cy + oy} ${cx - ox} ${cy + oy} ${cx - rx} ${cy} Z`
  );
}

export const VISEMI: VisemeId[] = [
  "sil", "PP", "FF", "TH", "DD", "kk", "CH", "SS",
  "nn", "RR", "aa", "E", "I", "O", "U",
];
