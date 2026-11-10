# Modifiche all'App Android per Streaming Audio

## Panoramica
L'app Android attualmente riceve l'audio TTS come file scaricato. Con questa modifica, riceverà l'audio in streaming WebSocket continuo.

---

## 1. Protocollo WebSocket Aggiornato

### Messaggi inviati dal Gateway (Windows) all'App:

```json
// INIZIO streaming audio (una volta)
{
  "type": "audio_start",
  "sample_rate": 24000
}
```

```text
// FRAME BINARIO CONTINUO (multipli, senza separazione JSON)
<PCM16_LE_mono_samples>
```

```json
// FINE streaming audio (una volta alla fine)
{
  "type": "audio_end"
}
```

---

## 2. Modifiche al Client WebSocket Android

### File: `app/src/main/java/com/yourpackage/GatewayWebSocket.kt` (o simile)

#### A. Gestore Messaggi JSON + Binarie

**PRIMA:**
```kotlin
ws.send(jsonMessage)  // Invia JSON
val audioBytes = receiveAudioFile()  // Aspetta file completo
```

**DOPO:**
```kotlin
// Ricevi messaggi misti (JSON + binari)
when (val messageType = incomingHeader[0]) {
    MESSAGE_JSON -> {
        val jsonMsg = String(incomingBuffer, Charsets.UTF_8)
        handleJsonMessage(jsonMsg)  // {"type": "audio_start", etc.}
    }
    MESSAGE_BINARY -> {
        val audioChunk = incomingBuffer.copyOf()  // PCM16 samples
        playAudioStream(audioChunk)  // Riproduci immediatamente
    }
}
```

#### B. Buffer di Ricezione WebSocket

Aggiungi supporto per frame misti:

```kotlin
class GatewayWebSocket(
    private val listener: GatewayListener
) {
    private lateinit var webSocket: WebSocket
    
    // Buffer per leggere header + payload
    private val incomingHeader = ByteArray(1)
    private val incomingBuffer = ByteArray(8192)  // Chunk di audio
    
    fun connect(url: String) {
        val request = Request.Builder()
            .url(url)
            .build()
        
        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onMessage(ws: WebSocket, bytes: Bytes) {
                // Legge 1 byte tipo messaggio + N byte payload
                val buffer = bytes.asByteArray()
                if (buffer.size < 2) return
                
                incomingHeader[0] = buffer[0]
                val payload = buffer.copyOfRange(1, buffer.size)
                
                when (incomingHeader[0]) {
                    MESSAGE_JSON -> {
                        val json = String(payload, Charsets.UTF_8)
                        handleJsonMessage(json)
                    }
                    MESSAGE_BINARY -> {
                        // Streaming audio: riproduci immediatamente
                        playAudioStream(payload)
                    }
                }
            }
        })
    }
}
```

#### C. Gestione Messaggi JSON

```kotlin
private fun handleJsonMessage(json: String) {
    val msg = Gson().fromJson(json, WebSocketMessage::class.java)
    
    when (msg.type) {
        "auth_ok" -> listener.onAuthenticated()
        "ready" -> listener.onReady()
        "transcript", "reply" -> listener.onText(msg.text ?: "")
        "audio_start" -> {
            // Inizia riproduzione streaming
            val sampleRate = msg.sampleRate ?: 24000
            audioPlayer.startStreaming(sampleRate)
        }
        "audio_end" -> {
            // Finisce riproduzione streaming
            audioPlayer.finishStreaming()
            listener.onTurnDone()
        }
        "done" -> listener.onSessionComplete()
        "error" -> listener.onError(msg.message ?: "Unknown error")
    }
}
```

---

## 3. Player Audio Streaming

### File: `app/src/main/java/com/yourpackage/AudioPlayer.kt`

**PRIMA:** Scarica file completo prima di riprodurre:
```kotlin
fun playAudioFile(filePath: String) {
    val audioFile = File(filePath)
    mediaPlayer.setDataSource(audioFile.path)
    mediaPlayer.prepare()
    mediaPlayer.start()
}
```

**DOPO:** Riproduce streaming continuo:
```kotlin
class AudioPlayer {
    private var sampleRate: Int = 24000
    private var isStreaming = false
    
    fun startStreaming(sampleRate: Int) {
        this.sampleRate = sampleRate
        isStreaming = true
        // Inizializza OutputStream per ricevere PCM16
        audioOutputStream.open()
    }
    
    fun playAudioStream(chunk: ByteArray) {
        if (!isStreaming) return
        // Scrivi chunk direttamente nell'output audio (no buffering file)
        audioOutputStream.write(chunk)
    }
    
    fun finishStreaming() {
        isStreaming = false
        audioOutputStream.close()
        audioPlayer.flush()
    }
}
```

---

## 4. Costanti WebSocket

Aggiungi all'app:
```kotlin
object WebSocketConstants {
    const val MESSAGE_JSON = 0x01
    const val MESSAGE_BINARY = 0x02
    
    // Messaggi JSON
    const val TYPE_AUTH = "auth"
    const val TYPE_START = "start"
    const val TYPE_END = "end"
    const val TYPE_TRANSCRIPT = "transcript"
    const val TYPE_REPLY = "reply"
    const val TYPE_AUDIO_START = "audio_start"
    const val TYPE_AUDIO_END = "audio_end"
    const val TYPE_DONE = "done"
    const val TYPE_ERROR = "error"
}
```

---

## 5. Struttura Messaggi JSON

```kotlin
data class WebSocketMessage(
    val type: String?,
    val text: String? = null,
    val sampleRate: Int? = null,
    val message: String? = null,
    val token: String? = null,
    val port: Int? = null,
    val url: String? = null
)
```

---

## 6. Test delle Modifiche

### Passo 1: Avvia il gateway Windows
```bash
cd /mnt/c/Projects/callAPIcall
call-bridge/main.py ptt
```

### Passo 2: Connetti l'app Android
- Apri l'app Android
- Inserisci token: `change-me-shared-token`
- Premi "Start"

### Passo 3: Verifica lo streaming
1. Lancia un enunciato (es. "Ciao")
2. Controlla che l'audio parta IMMEDIATAMENTE dopo la sintesi TTS
3. Non ci deve essere attesa di download file
4. La riproduzione deve fluire in tempo reale

---

## 7. Vantaggi dello Streaming

✅ **Nessun ritardo** - L'audio parte non appena Handy inizia a sintetizzare
✅ **Meno memoria** - Nessun salvataggio file temporaneo
✅ **Più fluido** - Riproduzione continua senza interruzioni
✅ **Barge-in reattivo** - Interruzione immediata se l'utente riparla

---

## 8. Note Tecniche

### Formato Audio
- **Formato**: PCM16 (int16 LE) mono
- **Sample rate**: 24000 Hz (standard Handy TTS)
- **Chunk size**: ~8KB per frame WebSocket (16ms audio)

### Timing
- Hermes genera testo → Handy TTS sintetizza → Streaming invia
- Tempo totale: ~50-200ms da fine generazione a inizio riproduzione
- Con file download: +2-5s di attesa download

---

## 9. Debug

Se l'app non riceve audio:
1. Controlla i log WebSocket Android (`adb logcat | grep Gateway`)
2. Verifica che il server invii frame binari dopo `audio_start`
3. Assicurati che l'audio player supporti streaming PCM16
4. Prova con `adb shell dumpsys window windows | grep mCurrentFocus` per vedere se l'app è attiva

---

## 10. Prossimi Passi

1. Modifica il client WebSocket Android per supportare frame misti
2. Implementa player audio streaming (no file)
3. Testa con enunciati brevi e lunghi
4. Verifica barge-in funziona correttamente
5. Ottimizza buffer audio per evitare glitch
