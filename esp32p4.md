# Terminale hardware ESP32-P4 — stato dei lavori

**Data**: 16 settembre 2026 · **Ripresa prevista**: all'arrivo della board, fra circa due settimane
**Piano completo approvato**: `~/.claude/plans/swirling-finding-pinwheel.md`
**Commit del lavoro già fatto**: `5482b39`

---

## Cosa stiamo costruendo

Un terzo terminale per callAPIcall, accanto al PC e all'app Android: una development board
**ESP32-P4 + ESP32-C6** con display integrato, a cui verranno aggiunti microfono,
altoparlante, telecamera MIPI-CSI, lettore SD, GPS e batteria.

È un porting del **client**, non del sistema. STT, LLM, TTS e generazione del labiale
restano sul PC: il device fa quello che fa il telefono. Il protocollo esistente è già adatto
a un microcontrollore — JSON e PCM grezzo su un WebSocket — ed è il motivo per cui l'impresa
è ragionevole.

**Requisiti fissati:**
- il video viaggia **compresso in H.264**;
- il display mostra **posa fissa e video, commutabili**;
- si prende la parola in **tutti e tre i modi** dell'app (push-to-talk, parola di
  attivazione, sempre in ascolto) **più il vivavoce**;
- il device raggiunge internet via WiFi ma **non sarà mai sulla stessa rete del PC**: deve
  entrare nella **tailnet**.

---

## Dove siamo arrivati

### Fatto e verificato (commit `5482b39`)

**La fase 2 del piano è chiusa**: l'interoperabilità SDP con il gateway è dimostrata, senza
aver scritto una riga di firmware.

`tools/esp32-sdp-probe.py` si finge l'ESP32 con un'offerta SDP scritta a mano, minimale come
quella che un microcontrollore sa produrre. Contro il gateway in esecuzione, **dieci
controlli su dieci**, risposta in **0,58 s**:

```
OK  c'e' la traccia video
OK  NESSUNA traccia audio: la voce resta in PCM sul WebSocket
OK  il codec e' H.264
OK  packetization-mode=1: servono FU-A e STAP-A nel depacketizzatore
OK  rtcp-mux accettato: una sola porta UDP invece di due
OK  il gateway e' DTLS client -> l'ESP fa il SERVER (passivo)
OK  PLI disponibile: si puo' chiedere un keyframe dopo un errore
OK  REMB disponibile: si puo' abbassare il bitrate dal device
OK  la risposta porta gia' i candidati ICE (niente trickle da gestire)
OK  nessun riferimento a STUN esterni

profile-level-id concordato: 42e01f  (Baseline, cio' che tinyH264 decodifica)
```

Come rilanciarla:

```bash
python tools/esp32-sdp-probe.py
python tools/esp32-sdp-probe.py --persona la persona --salva riferimento.sdp
```

Il file salvato è l'**SDP di riferimento**: quando il firmware genererà la sua offerta, la si
confronta con questa, che è nota funzionante.

**Tre correzioni lato PC**, tutte utili anche all'app Android:

| | cosa | verifica |
|---|---|---|
| `call-bridge/requirements.txt` | `aiortc>=1.15` e `av>=17` erano installati a mano e **non dichiarati** | su una macchina ricostruita il video non sarebbe esistito, con un messaggio che sembrava configurazione |
| `avatar_webrtc.py` `_negozia` | via lo **STUN di Google**, `iceServers=[]` | `video_answer` in 0,58 s invece di potenzialmente 5 s |
| `media.py` `/poster/` | `?h=<px>` ridimensiona prima di mandare | senza query 418×556 e 34 KB **come prima**; `?h=480` → 361×480 e 22,8 KB; non ingrandisce mai |

Non-regressione verificata: un client che offre audio+video riceve ancora la traccia Opus col
livello giusto (rms 0,209 su 0,212 attesi).

### Non fatto — serve la board

Tutto il resto. Il firmware non è iniziato, e non ha senso iniziarlo prima: le due incognite
che decidono l'architettura si misurano solo sull'hardware.

---

## Il primo giorno con la board: i due numeri che decidono tutto

Prima di scrivere firmware applicativo, servono due misure. Se una delle due va male, il
piano cambia — ed è molto meglio saperlo subito.

**1. Il ponte verso il C6.** Flashare lo slave ESP-Hosted sul C6 e far girare `iperf3` nei
due sensi. *Atteso*: ~36 Mbit/s (valore di laboratorio noto). **Se non dà almeno 20 Mbit/s
stabili, il video va ripensato prima di ogni altra cosa.**

**2. La tailnet.** MicroLink sul P4, auth key effimera dalla console Tailscale, e `ping` del
PC a `<indirizzo-tailscale-del-pc>`. Da annotare: percorso **diretto o via DERP**, RTT, throughput dentro il
tunnel, e **SRAM interna libera** con il tunnel attivo. È qui che si decide se si prosegue con
MicroLink o si passa al ripiego.

Un terzo controllo, rapido e utile: far girare il decoder `esp_h264` software su un file
362×480 **con il display acceso**, contando i fps. Conferma o smentisce il margine calcolato
(vedi sotto), e il display acceso conta perché il DPB sta in PSRAM e il DSI ne tira già
~73 MB/s.

---

## I fatti verificati, da non ri-scoprire

### Hardware (fonti ufficiali Espressif)

- **Niente decoder H.264 hardware sul P4**: solo l'encoder. Il decoder è **software**
  (`esp_h264`, basato su tinyH264): **640×480 → 25 fps mono-task, 31 dual-task**, 2,5 MB.
  A 1280×720 scende a 7/10 fps.
- JPEG invece è **hardware in encode e decode** (720p@88fps): utile per il poster e per le
  foto della camera, non per il video.
- Il nostro flusso è **362×480** = 174k pixel, il **56,6%** di 640×480 → **~44 fps di
  capacità**.
- **La traccia gira a 30 fps, non a 24**: è `VIDEO_PTIME = 1/30` di aiortc a scandirla
  (`mediastreams.py`), mentre la costante `FPS` in `avatar_webrtc.py:56` è dichiaratamente
  informativa e `avatar_fps` non la tocca. **Margine reale 1,47×.**
- ESP-SR (AFE con AEC, NS, VAD, WakeNet9/10) **supporta il P4**.
- Ponte P4↔C6 via ESP-Hosted su SDIO: **~36 Mbit/s** reali (40 MHz + HT20).

### Il gateway non va toccato

aiortc 1.15 (letto nel sorgente installato) fa già tutto il necessario:

- l'encoder usa `profile = "Baseline"` e `tune = zerolatency` (`codecs/h264.py`): CAVLC,
  niente CABAC, niente B-frame — **esattamente il sottoinsieme che tinyH264 decodifica**;
- `PLI → keyframe immediato` e `REMB → target_bitrate` sono implementati
  (`rtcrtpsender.py`): sono le due leve che su un decoder software valgono oro;
- l'offerta **deve** dichiarare `a=rtcp-mux`, altrimenti `rtcpeerconnection.py:1398` la
  rifiuta; servono anche `ice-ufrag`/`ice-pwd` e il gruppo BUNDLE;
- con `a=setup:actpass` aiortc risponde `active` → **l'ESP è il DTLS server**; il profilo
  SRTP `AES128_CM_SHA1_80` è offerto ed è quello universalmente implementato;
- niente trickle ICE da nessuna delle due parti: l'offerta va mandata completa, e **tutta la
  gestione dei candidati sciolti sparisce dal firmware**.

Banda video: **~1 Mbit/s di default**, riducibile a 600-700 kbit/s mandando REMB (limiti
aiortc: 500 kbit/s – 3 Mbit/s). Per confronto, MJPEG alla stessa risoluzione costava
20,4 KB/frame a qualità 75, cioè 4 Mbit/s a 24 fps: **H.264 costa tre-cinque volte meno
radio**, e su un link che passa per SDIO è un margine che si sente.

### Vincoli del protocollo che un client C sbaglierebbe al primo tentativo

Tutti verificati in `call-bridge/callbridge/voice_gateway.py`:

- **`auth` entro 10 s** dall'apertura (riga 346), poi si attende `ready`. Con
  `gateway_auth_token` vuoto il confronto è saltato ma **il messaggio resta obbligatorio**.
- **I frame binari fuori turno sono scartati in silenzio** (riga 367): niente PCM prima di
  `start`.
- **Lunghezza dei frame audio sempre pari**: `np.frombuffer(dtype="<i2")` (riga 61) solleva
  su un frame dispari, e la connessione cade.
- **`audio_start.sample_rate` non è costante** (24000 tipico, XTTS può dare 22050) — e la persona
  usa XTTS, quindi è il caso normale, non l'eccezione.
- **Fra `transcript` e `audio_start` possono passare fino a 20 s**: niente timeout aggressivi.
- **`audio_start` arriva sempre**, anche quando la voce viaggia su WebRTC.
- Il campo `voice` di `start` **viene ignorato** quando c'è una persona attiva (riga 555).
- **Bug latente**: in `_do_duplex_session._receiver` (righe 810-835) il parsing JSON sta nel
  ramo `else` del log periodico → un messaggio che cade sul tick dei 5 s **si perde**.
  `video_start` va trattato come ritrasmettibile (timeout 10 s, un retry).
- `/upload` legge `Content-Length` e poi `rfile.read(n)`: **niente chunked**, e il file
  finisce tutto in RAM sul PC (limite pratico lato device: 32 MB).

Porte: **8771** WebSocket e **8772** HTTP, entrambe su `0.0.0.0`. Le 8770 (control server) e
8720 (motori STT/TTS) sono legate a `127.0.0.1` e il client remoto **non le vede**.

---

## Le decisioni prese, e perché

**Entrare nella tailnet con MicroLink** (`github.com/goodshuma/microlink`, MIT). Implementa
il protocollo ts2021 completo: Noise, WireGuard, DISCO, STUN, DERP. Il device diventa un nodo
con un suo `100.x`. Offre **UDP bidirezionale e P2P diretto**, che è il requisito che WebRTC
impone e che le alternative non soddisfano. Latenza 5-50 ms in diretta, 30-150 ms via DERP;
~116 KB di SRAM statica; buffer H2/JSON da 512 KB in PSRAM, **configurabili al ribasso**.
*Rischio*: il P4 è dichiarato "dovrebbe funzionare" ma **non è fra le board testate**, il
progetto ha 9 commit e non pubblica numeri di throughput.
*Ripiego*: WireGuard puro (`esp_wireguard`, maturo) verso il **NAS** (`100.84.254.116`) o
**tadamoo** (`100.84.121.75`), già in tailnet e già accesi, che fa da subnet router. Più
semplice ma con un salto in più e il device che appare come subnet, non come nodo.
*Scartato*: il **Funnel**, perché trasporta solo HTTP — il video non passerebbe.

**WebRTC con la sola traccia video, voce in PCM sul WebSocket.** Non offrire `m=audio`
nell'offerta SDP. Il motivo non è il codec ma il **numero di percorsi audio nel firmware**:
a video spento la voce arriva comunque in PCM, e quello è lo stato normale in push-to-talk e
con la parola di attivazione — quindi il percorso PCM va scritto in ogni caso. Offrire
`m=audio` non lo sostituisce, gliene affianca un secondo con un commutatore a caldo in mezzo
ai turni. In più Opus costerebbe il 10-20% di un core (aiortc manda stereo a 48 kHz) nello
stesso budget del decoder video. **Decisione reversibile a costo zero**: basta aggiungere la
m-line e la traccia Opus compare da sola, sempre senza toccare il PC.

**Decoder mono-task, non dual-task.** Il dual darebbe ~55 fps ma occupando **entrambi i
core**, e l'altro core ospita l'unico carico con scadenza dura del sistema: se
`i2s_channel_read()` non viene servito in tempo i campioni si perdono e l'utente sente la
propria frase troncata. Il decoder invece è elastico — un fotogramma in ritardo è un
fotogramma, e il recupero via PLI è già previsto. **Il secondo core serve a garantire che il
microfono non perda un blocco, non a decodificare più in fretta del necessario.**

**ES7210 con riferimento hardware per l'AEC.** Il full-duplex a vivavoce vive o muore
sull'AEC, e l'AEC ha bisogno del segnale di riferimento: con un ES7210 che campiona l'uscita
dell'amplificatore su un proprio canale, arriva all'AFE **già allineato nello stesso stream
I2S**, invece di essere stimato dal software. Attenzione al clock: con un solo codec in
full-duplex, RX e TX condividono LRCLK e quindi il rate.

---

## Cosa resta da fare

Le fasi, nell'ordine del piano (le prime due sono chiuse):

| | fase | stato |
|---|---|---|
| 0 | **Banco**: hello_world, slave sul C6, iperf3, pannello DSI, SD, modi colore del PPA, decoder su file di prova | **serve la board** |
| 1 | **Tailnet**: MicroLink, auth key, ping del PC, throughput nel tunnel, SRAM libera | **serve la board** |
| 2 | **Interoperabilità SDP** | ✅ **fatta** (`5482b39`) |
| 3 | **Rete e controllo**: WebSocket, `auth`→`ready`, turni da testo, riconnessione, **diagnostica** | da fare |
| 4 | **Riproduzione audio**: ring, ricampionatore stateful, I2S TX, `interrupt` | da fare |
| 5 | **Cattura e push-to-talk**: I2S RX, AFE, PCM sul WS, pulsante fisico | da fare |
| 6 | **Vivavoce, AEC, parola di attivazione, duplex** | da fare |
| 7 | **Video H.264**, in tre passi: 7a trasporto · 7b decodifica · 7c visualizzazione | da fare |
| 8 | **Camera, SD, GPS, batteria** | da fare |
| 9 | **Robustezza**: riconnessione, OTA, provisioning, prova di 8-24 ore | da fare |

**Le fasi 3-6 possono girare sulla LAN del PC** (hotspot o stessa WiFi), senza VPN, se la
fase 1 mostrasse problemi. Solo il video (fase 7) ha bisogno che la questione tailnet sia
chiusa, perché ICE deve trovare una coppia di indirizzi funzionante.

**La fase 7 va spezzata in tre** perché un riquadro nero non deve avere tre spiegazioni
possibili: prima si conta che i pacchetti SRTP arrivino (senza decodificare), poi si
decodifica scrivendo frame I420 su SD da guardare dal PC (senza display), e solo alla fine si
mette a schermo.

Due note che valgono per tutte le fasi:

- **La schermata di diagnostica va costruita in fase 3, non alla fine.** È lo strumento con
  cui si misurano tutti i rischi: stato tailnet (diretto o DERP) e RTT, RSSI, heap interno ed
  esterno, fps e ms di decodifica, PLI mandati, bitrate REMB, stato ICE/DTLS, picco e rms del
  microfono, ERLE dell'AEC, batteria, temperatura.
- **La prova che conta di più**, in fase 7, non è "il video si vede": è **cosa succede
  all'audio quando il video è acceso** — istogramma degli intervalli fra frame PCM e underrun
  del ring, con video acceso e spento.

---

## Rischi aperti, in ordine di quanto costa scoprirli tardi

1. **MicroLink sul P4**: non testato su questa board. *Chiuso in fase 1*, deliberatamente
   presto. Ripiego già individuato.
2. **AEC insufficiente** → il full-duplex a vivavoce non si può consegnare, e la risposta
   potrebbe essere *meccanica* (distanza e disaccoppiamento fra altoparlante e microfono):
   va scoperto **prima che la scocca sia definita**. Da non mascherare con `_e_eco` lato
   server, che è una toppa.
3. **SRAM interna** (non la PSRAM, che avanza): AFE 150-250 KB, lwIP + SDIO 100-150 KB,
   MicroLink ~116 KB, DTLS/SRTP 50-80 KB col picco *durante la negoziazione*, DMA I2S ~64 KB,
   stack 60-80 KB, su ~700 KB totali. Da misurare **nello stato composito peggiore**, non a
   riposo.
4. **Decoder a 30 fps**: margine 1,47×, da confermare con il display acceso. Leve in ordine:
   REMB più basso, fotogrammi ripetuti, e in ultima istanza sei righe su `next_timestamp` per
   scandire la traccia a 20 fps (tocca solo `AvatarTrack`).
5. **Interoperabilità DTLS/SRTP fra `esp_peer` e aiortc**: i fatti favorevoli sono
   verificati, ma il fallimento tipico è muto — niente errore, solo un riquadro nero.
6. **Latenza audio**, da scomporre: cattura → invio → `transcript` → `audio_start` → primo
   campione. Gli estremi sono nostri: sotto 80 ms in cattura, 150 ms in riproduzione. Se la
   tailnet cade su DERP si aggiungono 30-150 ms **a ogni verso**, e il barge-in ne risente.
7. **Riservatezza**: `ws://` in chiaro e media server senza autenticazione. Il video invece
   sarà cifrato da SRTP — la parte meno sensibile è l'unica protetta. Da decidere presto
   (tailnet fidata, o `wss://` con certificato: il server accetta un `ssl_context`), perché
   cambia impostazioni e provisioning.

---

## Riferimenti rapidi

**File da leggere per primi, alla ripresa:**
- `~/.claude/plans/swirling-finding-pinwheel.md` — il piano completo e approvato
- `tools/esp32-sdp-probe.py` — la sonda, con l'offerta SDP commentata riga per riga: è la
  specifica di cosa deve produrre il firmware
- `call-bridge/callbridge/voice_gateway.py` — il protocollo: docstring iniziale per l'elenco
  dei messaggi, `_video_start` (512), `_send_pcm` (1158), `_messaggio_collaterale` (463)
- `call-bridge/callbridge/avatar_webrtc.py` — `_negozia` (427) e il controllo
  `"m=audio" in offerta_sdp` che decide Opus contro PCM
- `app/src/lib/gateway.ts` e `app/src/lib/controller.ts` — l'elenco completo dei messaggi e
  la macchina a stati del turno, da replicare in C

**Componenti ESP-IDF previsti** (IDF v5.4+): `microlink`, `esp_hosted` + `esp_wifi_remote`,
`esp_websocket_client`, `cJSON`, `esp_http_client`, `esp_lcd_mipi_dsi` + `esp_lvgl_port` v2
con LVGL 9, `esp_codec_dev` (ES8311/ES7210), `esp-sr`, `esp_h264`,
`esp-webrtc-solution`/`esp_peer`, `esp_driver_ppa` (**obbligatorio**: tinyH264 restituisce
I420 e convertirlo in software costerebbe il 15-25% di un core), `esp_driver_jpeg`,
`esp_video` + `esp_cam_sensor`, `esp_driver_sdmmc`.

**Indirizzi**: PC in tailnet `<indirizzo-tailscale-del-pc>` · gateway `ws://…:8771` · media `http://…:8772`
· NAS `100.84.254.116` · tadamoo `100.84.121.75`.

**Strumenti già pronti lato PC**: `call-bridge/dump-turni.on` fa salvare in
`call-bridge/turni/` il WAV di ogni turno ricevuto (serve a tarare il guadagno del microfono
e a giudicare se la soppressione del rumore aiuta o danneggia Whisper); il log del gateway è
`call-bridge/serve.log`, quello del bridge `call-bridge/ptt.log`.
