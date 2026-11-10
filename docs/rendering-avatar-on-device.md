# Lipsync su tre motori: MuseTalk (PC), Wav2Lip (Android), Visemi

## Perché

Oggi l'avatar lo renderizza il PC: MuseTalk genera un video H.264 e lo streama
via WebRTC. Fotorealistico e fedele alla foto della persona, ma **non scala**:
un flusso da generare per ogni sessione, sulla GPU del PC. Con più utenti la
GPU è il muro.

Spostare il rendering sul dispositivo toglie quel muro e fa sparire la banda
video. Se ne ricava anche fluidità: il collo su Android non è la potenza (un
S25 stravince) ma il percorso di rendering della WebView. Tre motori, uno
scelto da menu, per coprire il compromesso qualità/scalabilità:

| motore | dove | aspetto | scala | costo |
|---|---|---|---|---|
| **musetalk** | PC (GPU) | foto reale, animazione neurale | no (1 flusso/utente) | esistente |
| **wav2lip** | Android (NPU) | foto reale, animazione neurale | sì | inferenza ONNX on-device |
| **visemi** | Android (CPU) | foto animata a forme di bocca | sì, molto | renderer 2D leggero |

## Conversione avatar → modello: sul PC, una volta per persona

- **wav2lip**: nessuna conversione. Il modello ONNX è generico (foto + audio →
  frame). Al telefono servono solo il modello (scaricato una volta, uguale per
  tutti) e il `poster.jpg` (già servito). Zero lavoro per-persona.
- **visemi**: conversione sul PC. Dal `poster.jpg` si generano gli sprite delle
  forme di bocca (uno per viseme), serviti come asset della persona. Sul PC e
  non su Android perché è pesante, one-time, e con N telefoni sullo stesso
  avatar si fa una volta invece di N.

## Architettura

Il motore è una **capacità del client**, non una scelta del server: il telefono
sa se è capace di inferenza ONNX, il browser no. Il client lo dichiara al
gateway (`{type:"render_mode", mode:...}`, come già fa per `brain`), e il
gateway ricorda per decidere cosa mandare.

```
musetalk : app -> video_start(SDP) -> gateway apre WebRTC, streama il video (come oggi)
wav2lip  : app NON chiede il video. Riceve l'audio (già sul canale esistente) e
           genera il lipsync dalla foto in locale. Il gateway non renderizza.
visemi   : come wav2lip, ma il gateway manda ANCHE {type:"visemi", testo, durata,
           visemi:[{t,v,dur}...]} accanto a ogni segmento audio.
```

## Fasi

- **1. Generatore di visemi (PC)** — FATTO.
  `callbridge/viseme_gen.py`: testo italiano → timeline di visemi che copre la
  durata dell'audio. A regole (l'italiano è quasi fonetico), zero dipendenze.
  Verifica: `tools/prova-visemi.py`, 13/13.
- **2. Ossatura di selezione** — config `render_mode_default` FATTO; restano il
  messaggio di protocollo nel gateway e il selettore a 3 voci nell'app (accanto
  a BrainSwitch).
- **3. Il gateway rispetta il motore**: apre il WebRTC solo per `musetalk`; per
  `visemi` emette la timeline insieme all'audio (aggancio in `_stream_reply` /
  nel motore duplex, dove già si conosce testo e durata del segmento).
- **4. Renderer visemi sul client**: un componente che compone gli sprite di
  bocca sulla foto ai tempi ricevuti, sincronizzato con la riproduzione audio.
  Prima versione: mouth-swap 2D (sprite sovrapposti). Leggero, gira ovunque.
- **5. Conversione sprite di bocca (PC)**: dal poster, generare le forme di
  bocca per ogni viseme. Prima versione semi-procedurale (deformazione della
  regione bocca); poi, se serve qualità, un passaggio neurale offline.
- **6. Wav2Lip on-device (Android)**: modello ONNX + ONNX Runtime Mobile con
  delega NNAPI/GPU, in un plugin Capacitor nativo. La fase più pesante e
  rischiosa: prima una MISURA su S25 (regge i 25 fps a bassa risoluzione?),
  poi l'integrazione. Se non regge il realtime, resta come opzione "qualità"
  per frasi brevi, e `visemi` è il cavallo del multi-utente.
- **7. Degradazione**: se il client dichiara un motore che poi non regge
  (ONNX non carica, sprite mancanti), ripiega su `visemi`, e in ultimo su
  `musetalk`, avvisando — mai lo schermo fermo.

## Verifica per fase

Come per il full-duplex, ogni fase produce qualcosa di osservabile:
`tools/prova-visemi.py` (fatto), un dump della timeline emessa dal gateway, e
sul client il confronto a occhio fra bocca e parlato. La misura che conta per
il modo C è lo **scarto di sincrono** bocca/voce (obiettivo: sotto ~80 ms, la
soglia di percezione); per wav2lip, gli **fps sostenuti** sul telefono.

---

# Creazione dell'avatar: procedura guidata (da PC e da cellulare)

Decisa con l'utente: onboarding **completo**, **aperto a chiunque**, **wizard a
passi**, con GUI in **entrambi** gli ambienti (Control Center sul PC, app su
mobile). L'avvio e la raccolta materiali avvengono sul client; l'elaborazione
pesante sul server, che pubblica il risultato come asset della persona.

## I passi del wizard (uguali nei due ambienti)

1. **Nome** dell'avatar.
2. **Foto frontale** — scatta (fotocamera) o carica. È il minimo indispensabile:
   da qui si ricava il poster e la base per gli sprite di bocca.
3. **Pose / espressioni** — qualche scatto guidato (frontale, semi-profilo,
   bocca aperta e chiusa): rende gli sprite di bocca più fedeli.
4. **Breve video** — pochi secondi di volto che parla: si estraggono le forme
   di bocca reali della persona (fedeltà migliore del solo ritaglio dalla foto).
5. **Campione di voce** — una frase letta: clona la voce (XTTS). Riguarda la
   voce, non il lipsync, ma completa l'avatar.
6. **Elaborazione** (server) con barra di avanzamento — vedi sotto.
7. **Prova** — anteprima dell'avatar che pronuncia una frase, per accettare o
   rifare uno step.

Ogni passo è saltabile tranne nome e foto: con la sola foto l'avatar è già
usabile in modo `visemi`; gli altri materiali migliorano la resa.

## Cosa produce l'elaborazione (sul server, una volta per avatar)

- **poster.jpg** — il ritratto, già servito oggi. Serve a `wav2lip` e come posa
  a riposo di `visemi`.
- **visemi/<V>.png** — uno sprite per viseme, ritagliato/deformato dalla bocca
  (foto, o estratto dal video se c'è). È l'asset del modo `visemi`.
- **voce** — il campione registrato salvato come voce XTTS della persona
  (`manifest.voice`).

Tutto finisce sotto `avatar/persone/<nome>/`, accanto al manifest esistente, e
viene servito al client come già si serve il poster.

## Protocollo

- `POST /avatar/wizard/start` → apre una bozza, ritorna un `draft_id`.
- `POST /avatar/wizard/<draft_id>/<step>` → carica il materiale di un passo
  (multipart: foto / pose / video / voce).
- `POST /avatar/wizard/<draft_id>/elabora` → avvia l'elaborazione; il client
  segue l'avanzamento (polling o WS) e alla fine riceve il nome della persona.
- `DELETE /avatar/wizard/<draft_id>` → annulla la bozza.

## Aperto a chiunque — implicazioni note

L'onboarding aperto significa che chiunque apra l'app può creare un avatar sul
server di casa. Prima di esporlo pubblicamente restano da decidere: dove vivono
gli avatar di utenti diversi (uno spazio per-utente sotto `data/users/`, non la
cartella condivisa `avatar/persone/`), un tetto di spazio per utente, e la
moderazione dei contenuti caricati. Non è codice di questa fase, ma va deciso
prima della pubblicazione pubblica del wizard.

## Fasi (creazione avatar)

- **CA-1**: struttura persona estesa (visemi/, campo voce clonata) + endpoint
  `wizard/start` e upload dei materiali (nessuna elaborazione: solo raccolta).
- **CA-2**: elaborazione — generazione degli sprite di bocca dalla foto
  (mediapipe face mesh per trovare e ritagliare la bocca, deformazione per
  viseme); poster; se c'è il video, estrazione delle forme reali.
- **CA-3**: clonazione voce dal campione (riuso engine XTTS esistente).
- **CA-4**: il wizard UI, prima nell'app (mobile), poi nel Control Center (PC),
  condividendo lo stesso protocollo.
- **CA-5**: spazio per-utente e moderazione, prima della pubblicazione aperta.
