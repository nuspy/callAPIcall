/**
 * La logica di timing del lipsync a visemi: dato un istante, quale forma di
 * bocca mostrare — e quanto è già transitata verso la successiva.
 *
 * È deliberatamente PURA (nessun DOM, nessun timer): così si verifica in
 * isolamento, senza browser né audio, e il componente React che la usa resta
 * un guscio sottile. Il timer vero e l'aggancio all'orologio dell'audio
 * stanno fuori di qui.
 *
 * Il sincronismo con la voce è il punto delicato. I visemi hanno tempi
 * relativi all'inizio del loro segmento audio; il segmento comincia a suonare
 * a un certo istante dell'orologio condiviso (`AudioContext.currentTime`).
 * Chi guida il player gli passa quell'istante come `t0`: da lì in poi
 * `visemeAt(clock)` risponde con la bocca giusta. Un pacchetto arriva PRIMA
 * del suo audio, quindi si accoda e si àncora quando l'audio parte davvero
 * (`accoda` + `ancora`).
 */
import type { VisemeId } from "./visemeShapes";

export interface Viseme {
  t: number; // secondi dall'inizio del segmento
  v: VisemeId;
  dur: number;
}

export interface TimelineVisemi {
  testo: string;
  lang: string;
  durata: number;
  visemi: Viseme[];
}

/** Cosa mostrare a un dato istante: il viseme corrente, verso quale sta
 *  andando, e a che frazione (0-1) della transizione siamo. */
export interface StatoBocca {
  v: VisemeId;
  verso: VisemeId;
  k: number;
}

//: Quanto dura la fusione fra un viseme e il successivo. Corta: la bocca deve
//: seguire il parlato, non strisciare. ~50 ms è sotto la soglia in cui si
//: nota il ritardo ma sopra quella in cui gli scatti danno fastidio.
const FUSIONE_S = 0.05;

const RIPOSO: StatoBocca = { v: "sil", verso: "sil", k: 0 };

export class VisemePlayer {
  //: Segmenti in attesa del loro audio: (t0 dell'audio o null se non ancora
  //: partito, timeline). Si scoda man mano che l'audio dei segmenti finisce.
  private coda: { t0: number | null; tl: TimelineVisemi }[] = [];

  /** Accoda la timeline di un segmento non ancora partito (arriva prima del PCM). */
  accoda(tl: TimelineVisemi): void {
    this.coda.push({ t0: null, tl });
  }

  /** L'audio del prossimo segmento senza àncora comincia a `t0` (clock audio). */
  ancora(t0: number): void {
    const primo = this.coda.find((c) => c.t0 === null);
    if (primo) primo.t0 = t0;
  }

  /** Niente più da mostrare: coda vuota e nessun segmento in corso a `clock`. */
  finito(clock: number): boolean {
    return !this.coda.some(
      (c) => c.t0 === null || clock < c.t0 + c.tl.durata + FUSIONE_S,
    );
  }

  /** Scarta i segmenti già conclusi, per non far crescere la coda. */
  pota(clock: number): void {
    this.coda = this.coda.filter(
      (c) => c.t0 === null || clock < c.t0 + c.tl.durata + FUSIONE_S,
    );
  }

  reset(): void {
    this.coda = [];
  }

  /** La bocca da mostrare all'istante `clock` (stesso orologio dell'audio). */
  visemeAt(clock: number): StatoBocca {
    // Il segmento in corso: t0 impostato e clock dentro la sua durata.
    const seg = this.coda.find(
      (c) => c.t0 !== null && clock >= c.t0 && clock < c.t0 + c.tl.durata + FUSIONE_S,
    );
    if (!seg || seg.t0 === null) return RIPOSO;
    const locale = clock - seg.t0; // secondi dall'inizio del segmento
    const vs = seg.tl.visemi;
    if (!vs.length) return RIPOSO;

    // Il viseme il cui intervallo [t, t+dur) contiene `locale`.
    let i = 0;
    while (i < vs.length - 1 && locale >= vs[i].t + vs[i].dur) i++;
    const cur = vs[i];
    const next = vs[i + 1];

    // Fusione verso il successivo solo nell'ultimo tratto del viseme corrente.
    if (next) {
      const inizioFusione = cur.t + cur.dur - FUSIONE_S;
      if (locale >= inizioFusione) {
        const k = (locale - inizioFusione) / FUSIONE_S;
        return { v: cur.v, verso: next.v, k: Math.min(1, Math.max(0, k)) };
      }
    }
    return { v: cur.v, verso: cur.v, k: 0 };
  }
}
