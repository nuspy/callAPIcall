/**
 * Anello di stato che scorre attorno al pulsante di conversazione.
 *
 * Arancione mentre l'avatar RAGIONA, viola mentre PARLA: due stati che
 * l'utente deve distinguere con la coda dell'occhio, senza leggere.
 * Fermo (invisibile) negli altri casi, cosi' il movimento significa sempre
 * "sta lavorando".
 *
 * E' un SVG e non un bordo CSS perche' il pulsante e' una pillola (bordi molto
 * arrotondati, non un cerchio): un `border` animato non sa disegnare un
 * segmento che corre lungo quel profilo, un `rect` con `pathLength` si'.
 */
export function TalkRing({ phase }: { phase: string }) {
  const attivo = phase === "reasoning" || phase === "speaking";
  if (!attivo) return null;
  const colore = phase === "speaking" ? "#a855f7" : "#f97316"; // viola / arancio

  return (
    <svg
      className="absolute inset-0 w-full h-full pointer-events-none"
      // Il viewBox segue le proporzioni della pillola; `preserveAspectRatio
      // none` lo fa aderire a qualunque larghezza senza deformare lo spessore
      // percepito del tratto (vector-effect lo tiene costante).
      viewBox="0 0 100 34"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <rect
        x="1.5" y="1.5" width="97" height="31" rx="15.5" ry="15.5"
        fill="none"
        stroke={colore}
        strokeWidth="3"
        vectorEffect="non-scaling-stroke"
        strokeLinecap="round"
        // pathLength=100 rende il tratteggio indipendente dalle dimensioni
        // reali: 18 di segmento e 82 di vuoto, qualunque sia il pulsante.
        pathLength={100}
        strokeDasharray="18 82"
        className="talk-ring-run"
      />
    </svg>
  );
}
