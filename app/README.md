# callAPIcall Voice — app Android

Client vocale che replica **Shift+F1** da remoto: registra l'audio, lo invia al
**voice gateway** del backend (il PC con Handy, raggiungibile via Tailscale),
e riceve indietro **testo** (la tua frase trascritta + la risposta) e **audio**
(riprodotto nell'app). La chat mostra entrambi.

Stack: Capacitor + React + Vite + TypeScript · React Query + Zustand ·
Tailwind + lucide + sonner · lightweight-charts · i18next · plugin Capacitor
(Preferences, Haptics, LocalNotifications).

## Modalità del pulsante "Talk"
- **Tieni premuto** → registra finché premi; al rilascio invia il turno (hold).
- **Trascina verso l'alto** → modalità **continua** (come Shift+F1): ascolto in
  streaming, il backend rileva da solo la pausa di fine turno. Un turno per volta.

## Backend richiesto
Sul PC con Handy avvia il voice gateway:
```
cd C:\Projects\callAPIcall\call-bridge
python main.py gateway        # WebSocket su 0.0.0.0:8771
```
Nelle impostazioni dell'app inserisci:
- **URL gateway**: `ws://<IP-Tailscale-del-PC>:8771`
- **Token**: uguale a `gateway_auth_token` in `call-bridge/config.json`.

## Sviluppo / build APK
```
cd C:\Projects\callAPIcall\app
npm install
npm run build                 # build web (Vite)
npx cap add android           # solo la prima volta
npm run cap:sync              # copia build + plugin in android/
npm run cap:open              # apre Android Studio -> Run/Build APK
```
Permessi Android necessari (aggiungere in `android/app/src/main/AndroidManifest.xml`
se non già richiesti dal WebView): `RECORD_AUDIO`, `INTERNET`.
La connessione è in chiaro (ws/http verso Tailscale): `capacitor.config.ts` ha
`cleartext: true` già impostato.

## Protocollo gateway (riferimento)
Vedi `call-bridge/callbridge/voice_gateway.py`. In sintesi (WebSocket):
`auth` → `auth_ok`/`ready` → per turno: `start` → frame audio PCM16 16k →
(`end` per hold | pausa VAD per continua) → `transcript` → `reply` (chunk) →
`audio_start`+PCM16+`audio_end` → `done`.
