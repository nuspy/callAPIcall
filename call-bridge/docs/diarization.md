# Diarizzazione — chi parla quando

Nella sezione **Analisi** il transcript esce diviso per voce (`Speaker 1`,
`Speaker 2`, …), e le voci si possono rinominare. Riassunto, punti salienti e
attività ereditano le etichette: i task escono intestati alla persona invece che
a "non specificato".

## Perché trascrivi-poi-diarizza (e non il contrario)

L'idea intuitiva — un analizzatore di timbri che taglia l'audio e manda allo STT
gli spezzoni di ciascuna voce — rende **peggio**:

- whisper ragiona su una finestra da 30 s: su spezzoni da 1-2 s allucina, ripete
  e sbaglia lingua sui back-channel ("sì", "ok", "mhm");
- l'encoder costa comunque i 30 s pieni a ogni chiamata: 400 turni = 400
  inferenze invece di 12;
- i confini di turno cadono in mezzo alle parole, e le sovrapposizioni (due che
  parlano insieme) vengono distrutte proprio dove servirebbero.

Quello che si fa qui — ed è ciò che fa WhisperX — è tenere le due cose separate:

```
whisper (audio intero)  ->  segmenti + parole con i tempi
diarizzazione (audio intero) -> fasce [start, end, speaker]
                       assign_speakers() -> incrocio per sovrapposizione
```

`engines/diarize.py` fa la seconda e la terza parte.

## Come è fatta

| pezzo | modello | ruolo |
|---|---|---|
| segmentazione | `sherpa-onnx-pyannote-segmentation-3-0` (6 MB) | quante voci sono attive, finestra per finestra |
| impronta vocale | `3dspeaker CAM++ zh_en` (28 MB) | embedding di ogni turno |
| clustering | `FastClustering` di sherpa-onnx | raggruppa le impronte in speaker |

Tutto ONNX, offline, su CPU: nessun token HuggingFace, nessuna licenza da
accettare, nessun torch in più. `sherpa-onnx` si porta il proprio onnxruntime e
convive con `onnxruntime-gpu` (verificato: sessione CUDA creata dopo l'import).

I modelli non stanno in git:

```
cd call-bridge
python fetch_models.py --only diarization            # ~35 MB
python fetch_models.py --only diarization --titanet  # + NeMo TitaNet large (101 MB)
```

Se mancano — o se manca il pacchetto — l'analisi prosegue **senza** etichette:
la diarizzazione è un di più, non un prerequisito.

## Misure reali (intervista Snapsoft, CPU, 4 thread)

| | CAM++ | TitaNet large |
|---|---|---|
| 5 min di audio | 16 s (19x realtime) | 32 s (9x realtime) |
| voci trovate (soglia 1.0 / 1.2) | 2 (giuste) | 5 / 2 |
| peso | 28 MB | 101 MB |

CAM++ è il predefinito: stesso risultato, metà tempo, un quarto del peso.

## Taratura

`diarization_threshold` è **legata al modello di embedding**. Con CAM++, sullo
stesso file: `0.8` → 7 voci, `1.0` → le 2 giuste, `1.2` → una sola. Il default è
`1.0`; cambiando modello va ritarata.

Molto più affidabile che indovinare: **dire quante voci ci sono**. Il campo
"Voci" nel form dell'analisi (o `speakers` in `POST /analysis/start`) lo fissa
per quel file; `diarization_num_speakers` fa lo stesso per tutte le analisi.

Due correzioni automatiche coprono i difetti tipici del clustering:

- i cluster sotto 5 s **e** sotto l'1% del parlato vengono riassorbiti (sono
  "mhm" isolati che il clustering non sa dove mettere);
- un cambio di voce che dura meno di 0,8 s incastrato tra due battute dello
  stesso interlocutore viene annullato (sul test reale una singola parola
  finiva all'altro speaker in mezzo a una frase).

## Configurazione

| chiave | default | nota |
|---|---|---|
| `diarization_enabled` | `true` | spegne tutto |
| `diarization_model_dir` | `""` | "" = `call-bridge/models/diarization` |
| `diarization_device` | `"cpu"` | `"cuda"` richiede un wheel sherpa-onnx build CUDA |
| `diarization_num_threads` | `4` | |
| `diarization_num_speakers` | `0` | 0 = automatico |
| `diarization_threshold` | `1.0` | vedi taratura |
| `diarization_max_minutes` | `240` | oltre si salta: l'audio sta tutto in RAM (~230 MB/ora) |

## Il timeout dell'analisi non è quello della voce

`analysis_response_timeout_s` (default 1800 s) è l'attesa della risposta del
cervello per ogni chunk. **Non** usare `acp_response_timeout_s` (300 s): quello è
tarato sulla conversazione, dove cinque minuti di silenzio sono un guasto.

Costato caro una volta: con un modello "thinking" i due tentativi di analisi
venivano tagliati a 300 s esatti e uscivano VUOTI, e l'errore che arrivava alla
GUI era `il cervello non ha prodotto JSON sul chunk 1` — che indicava il posto
sbagliato. Nel log la firma era inequivocabile:

```
18:40:39  ACP: sessione agente pronta
18:45:39  analisi: risposta non-JSON (tentativo 1):     <- 300 s esatti
18:45:39  ACP: timeout risposta dopo 300s
```

Ora l'errore cita sempre la risposta vera del cervello (`ha risposto: …`), così
la prossima diagnosi parte dal punto giusto.

## API

- `POST /analysis/start` — campo `speakers` (0 = automatico) per quel file.
- `GET /analysis/<id>/transcript` — i segmenti hanno `speaker` (nome mostrato) e
  `speaker_label` (etichetta originale, la chiave per rinominare).
- `POST /analysis/<id>/speakers` — `{"names": {"Speaker 1": "Andrea"}}`. Nome
  vuoto = torna all'etichetta. Gli artifact conservano sempre `Speaker N`: la
  rinomina si applica in lettura, quindi è reversibile e ripetibile.
- `GET /transcribe?segments=1&words=1` (motore STT nativo) — trascrizione con i
  tempi. Senza i parametri la risposta resta `{"text": ...}`.
