package com.callapicall.voice;

import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.FloatBuffer;
import java.util.Collections;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.Map;
import java.util.Random;

import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtSession;
import ai.onnxruntime.providers.NNAPIFlags;

/**
 * Misura Wav2Lip con ONNX Runtime NATIVO, così l'inferenza gira sull'acceleratore
 * del telefono (NNAPI/NPU) invece che sulla WebView in WASM — dove la misura in
 * JavaScript si era fermata a 3 fps perché la WebView non espone né WebGPU né
 * l'NPU.
 *
 * È solo un banco: scarica il modello dall'URL dato, crea una sessione con
 * NNAPI (ripiegando su CPU se non regge), esegue N inferenze con input di
 * rumore delle dimensioni giuste e riporta i millisecondi per fotogramma. Serve
 * a decidere se il modo A si può integrare davvero, prima di costruirlo.
 */
@CapacitorPlugin(name = "Wav2LipNative")
public class Wav2LipNativePlugin extends Plugin {

    private static final String TAG = "Wav2LipNative";

    // --- runtime: carica una volta, genera per turno ---------------------
    private OrtSession runtimeSess;
    private float[] maskedCHW; // [3,96,96] volto con metà inferiore azzerata
    private float[] refCHW;    // [3,96,96] volto di riferimento

    private void progress(String fase, int pct) {
        JSObject o = new JSObject();
        o.put("fase", fase);
        o.put("pct", pct);
        notifyListeners("w2lProgress", o);
    }

    private String modelPathPronto;

    /** Passo 1: scarica il modello. Ritorna dimensione e millisecondi, così il
     *  client sa se il download è il collo — senza dipendere dagli eventi. */
    @PluginMethod
    public void scaricaModello(PluginCall call) {
        final String modelUrl = call.getString("modelUrl", "");
        final String nomeFile = modelUrl.contains("int8") ? "wav2lip_int8.onnx" : "wav2lip.onnx";
        new Thread(() -> {
            try {
                long t = System.currentTimeMillis();
                modelPathPronto = scaricaConProgresso(modelUrl, nomeFile);
                long mb = new java.io.File(modelPathPronto).length() / (1024 * 1024);
                JSObject r = new JSObject();
                r.put("ok", true);
                r.put("mb", mb);
                r.put("ms", System.currentTimeMillis() - t);
                call.resolve(r);
            } catch (Throwable e) {
                Log.e(TAG, "scaricaModello fallita", e);
                call.reject(e.getClass().getSimpleName() + ": " + e.getMessage());
            }
        }).start();
    }

    /** Passo 2: crea la sessione (dal modello già scaricato) e carica il volto.
     *  Ritorna i millisecondi di ciascuna, per vedere quale è il collo. */
    @PluginMethod
    public void prepara(PluginCall call) {
        final String faceUrl = call.getString("faceUrl", "");
        new Thread(() -> {
            try {
                if (modelPathPronto == null) throw new Exception("chiama prima scaricaModello()");
                OrtEnvironment env = OrtEnvironment.getEnvironment();
                OrtSession.SessionOptions opts = new OrtSession.SessionOptions();
                opts.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT);
                Map<String, String> o = new HashMap<>();
                o.put("intra_op_num_threads", "4");
                opts.addXnnpack(o);
                if (runtimeSess != null) runtimeSess.close();
                long t = System.currentTimeMillis();
                runtimeSess = env.createSession(modelPathPronto, opts);
                long msSess = System.currentTimeMillis() - t;
                t = System.currentTimeMillis();
                caricaVolto(faceUrl);
                JSObject r = new JSObject();
                r.put("ok", true);
                r.put("msSessione", msSess);
                r.put("msVolto", System.currentTimeMillis() - t);
                call.resolve(r);
            } catch (Throwable e) {
                Log.e(TAG, "prepara fallita", e);
                call.reject(e.getClass().getSimpleName() + ": " + e.getMessage());
            }
        }).start();
    }

    /** Cartella di cache PERSISTENTE (getFilesDir, non getCacheDir che Android
     *  svuota quando serve spazio): quel che si scarica resta sul dispositivo. */
    private java.io.File cacheDir() {
        java.io.File d = new java.io.File(getContext().getFilesDir(), "avatar-cache");
        if (!d.exists()) d.mkdirs();
        return d;
    }

    /**
     * Scarica {@code url} in un file persistente e lo RIUSA se non è cambiato.
     *
     * Validazione: {@code If-Modified-Since} sul lastModified del file locale —
     * se il server risponde 304 il file va bene com'è, niente download. Per i
     * server che non fanno conditional, il ripiego confronta la dimensione
     * (Content-Length): stessa dimensione = stesso file. Così un avatar (o il
     * modello) scaricato una volta resta sul telefono e si riscarica solo se ne
     * esce una versione più recente (mtime o dimensione diversi).
     */
    private String scaricaConCache(String url, String nome, boolean conProgresso) throws Exception {
        java.io.File f = new java.io.File(cacheDir(), nome);
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(20000);
        c.setReadTimeout(120000);
        if (f.exists() && f.length() > 1000) c.setIfModifiedSince(f.lastModified());
        c.connect();
        int code = c.getResponseCode();
        if (code == HttpURLConnection.HTTP_NOT_MODIFIED) {   // 304: invariato
            c.disconnect();
            return f.getAbsolutePath();
        }
        int totale = c.getContentLength();
        if (f.exists() && totale > 0 && f.length() == totale) {  // ripiego per dimensione
            c.disconnect();
            return f.getAbsolutePath();
        }
        long lastMod = c.getLastModified();
        java.io.File tmp = new java.io.File(f.getAbsolutePath() + ".part");
        long letti = 0;
        int ultimoPct = -1;
        try (InputStream in = c.getInputStream();
             java.io.FileOutputStream out = new java.io.FileOutputStream(tmp)) {
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                letti += n;
                if (conProgresso && totale > 0) {
                    int pct = (int) (letti * 100 / totale);
                    if (pct != ultimoPct && pct % 5 == 0) { progress("scarico il modello", pct); ultimoPct = pct; }
                }
            }
        } finally {
            c.disconnect();
        }
        if (f.exists()) f.delete();
        if (!tmp.renameTo(f)) throw new Exception("rinomina fallita: " + nome);
        if (lastMod > 0) f.setLastModified(lastMod);   // per la validazione successiva
        return f.getAbsolutePath();
    }

    /** Come scaricaConCache, col progresso in percentuale (per file grossi). */
    private String scaricaConProgresso(String url, String nome) throws Exception {
        return scaricaConCache(url, nome, true);
    }

    private void caricaVolto(String faceUrl) throws Exception {
        // Nome per-persona (dall'URL): due avatar diversi NON si sovrascrivono
        // in cache, e ognuno resta sul dispositivo per conto suo.
        String nome = "face_" + Integer.toHexString(faceUrl.hashCode()) + ".png";
        String fp = scaricaConCache(faceUrl, nome, false);
        android.graphics.Bitmap bmp = android.graphics.BitmapFactory.decodeFile(fp);
        android.graphics.Bitmap face = android.graphics.Bitmap.createScaledBitmap(bmp, 96, 96, true);
        int[] px = new int[96 * 96];
        face.getPixels(px, 0, 96, 0, 0, 96, 96);
        refCHW = new float[3 * 96 * 96];
        maskedCHW = new float[3 * 96 * 96];
        for (int y = 0; y < 96; y++) {
            for (int x = 0; x < 96; x++) {
                int p = px[y * 96 + x];
                float b = (p & 0xff) / 255f;
                float g = ((p >> 8) & 0xff) / 255f;
                float r = ((p >> 16) & 0xff) / 255f;
                int idx = y * 96 + x;
                // ordine BGR come nella validazione Python (cv2)
                refCHW[idx] = b; refCHW[96 * 96 + idx] = g; refCHW[2 * 96 * 96 + idx] = r;
                boolean bassa = y >= 48;               // metà inferiore mascherata
                maskedCHW[idx] = bassa ? 0 : b;
                maskedCHW[96 * 96 + idx] = bassa ? 0 : g;
                maskedCHW[2 * 96 * 96 + idx] = bassa ? 0 : r;
            }
        }
    }

    /**
     * Dato il mel (float32, [80×T] riga-per-mel, in base64) genera i
     * fotogrammi-bocca del turno e li ritorna come JPEG in base64.
     * Il mel lo calcola il JS (verificato contro Python); qui c'è solo
     * l'inferenza, la parte pesante, sull'acceleratore.
     */
    @PluginMethod
    public void genera(PluginCall call) {
        final String melB64 = call.getString("mel", "");
        final int melT = call.getInt("melT", 0);
        new Thread(() -> {
            try {
                if (runtimeSess == null) throw new Exception("chiama prima prepara()");
                byte[] raw = android.util.Base64.decode(melB64, android.util.Base64.DEFAULT);
                java.nio.FloatBuffer melFb = java.nio.ByteBuffer.wrap(raw)
                        .order(java.nio.ByteOrder.LITTLE_ENDIAN).asFloatBuffer();
                float[] mel = new float[melFb.remaining()];
                melFb.get(mel);

                OrtEnvironment env = OrtEnvironment.getEnvironment();
                int nFrames = (int) Math.floor(melT / (80.0 / 25.0));   // 25 fps
                // vid è costante nel turno (foto statica): si costruisce una volta
                float[] vid = new float[6 * 96 * 96];
                System.arraycopy(maskedCHW, 0, vid, 0, 3 * 96 * 96);
                System.arraycopy(refCHW, 0, vid, 3 * 96 * 96, 3 * 96 * 96);
                OnnxTensor vidT = OnnxTensor.createTensor(env,
                        java.nio.FloatBuffer.wrap(vid), new long[]{1, 6, 96, 96});

                com.getcapacitor.JSArray bocche = new com.getcapacitor.JSArray();
                float[] melChunk = new float[1 * 1 * 80 * 16];
                double mult = 80.0 / 25.0;
                for (int i = 0; i < nFrames; i++) {
                    int sCol = (int) (i * mult);
                    if (sCol + 16 > melT) sCol = Math.max(0, melT - 16);
                    for (int m = 0; m < 80; m++)
                        for (int j = 0; j < 16; j++)
                            melChunk[m * 16 + j] = mel[m * melT + sCol + j];
                    OnnxTensor melTns = OnnxTensor.createTensor(env,
                            java.nio.FloatBuffer.wrap(melChunk), new long[]{1, 1, 80, 16});
                    Map<String, OnnxTensor> feeds = new HashMap<>();
                    feeds.put("mel", melTns);
                    feeds.put("vid", vidT);
                    float[][][][] out = (float[][][][]) runtimeSess.run(feeds).get(0).getValue();
                    melTns.close();
                    bocche.put(boccaJpeg(out[0]));      // [3,96,96] -> jpeg base64
                }
                vidT.close();
                JSObject r = new JSObject();
                r.put("frames", nFrames);
                r.put("bocche", bocche);
                call.resolve(r);
            } catch (Throwable e) {
                Log.e(TAG, "genera fallita", e);
                call.reject(e.getClass().getSimpleName() + ": " + e.getMessage());
            }
        }).start();
    }

    private String boccaJpeg(float[][][] chw) {
        android.graphics.Bitmap bmp = android.graphics.Bitmap.createBitmap(96, 96,
                android.graphics.Bitmap.Config.ARGB_8888);
        int[] px = new int[96 * 96];
        for (int y = 0; y < 96; y++) {
            for (int x = 0; x < 96; x++) {
                int b = clamp(chw[0][y][x]);
                int g = clamp(chw[1][y][x]);
                int r = clamp(chw[2][y][x]);
                px[y * 96 + x] = 0xff000000 | (r << 16) | (g << 8) | b;
            }
        }
        bmp.setPixels(px, 0, 96, 0, 0, 96, 96);
        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
        bmp.compress(android.graphics.Bitmap.CompressFormat.JPEG, 85, bos);
        return android.util.Base64.encodeToString(bos.toByteArray(), android.util.Base64.NO_WRAP);
    }

    private int clamp(float v) {
        int i = Math.round(v * 255f);
        return i < 0 ? 0 : (i > 255 ? 255 : i);
    }

    @PluginMethod
    public void benchmark(PluginCall call) {
        final String url = call.getString("modelUrl", "");
        final int frames = call.getInt("frames", 20);
        // Fuori dal thread della UI: il download e l'inferenza bloccano.
        new Thread(() -> {
            try {
                JSObject res = eseguiBenchmark(url, frames);
                call.resolve(res);
            } catch (Throwable e) {
                Log.e(TAG, "benchmark fallito", e);
                call.reject(e.getClass().getSimpleName() + ": " + e.getMessage());
            }
        }).start();
    }

    /** Scarica il modello su FILE (cache) e ne ritorna il percorso.
     *
     * Non in memoria: 145 MB in un {@code byte[]} sforavano il heap Java
     * dell'app (limite ~256 MB) con un OutOfMemoryError. Su file, ONNX Runtime
     * lo mappa in memoria (mmap) e non lo tiene nel heap. Il file resta in
     * cache: la seconda misura non riscarica. */
    private String scaricaSuFile(String url, String nome) throws Exception {
        return scaricaConCache(url, nome, false);
    }

    private OnnxTensor rand(OrtEnvironment env, long[] shape) throws Exception {
        long n = 1;
        for (long d : shape) n *= d;
        float[] a = new float[(int) n];
        Random r = new Random(1);
        for (int i = 0; i < a.length; i++) a[i] = r.nextFloat();
        return OnnxTensor.createTensor(env, FloatBuffer.wrap(a), shape);
    }

    /** ms per FOTOGRAMMA di una configurazione (execution provider + batch).
     *
     * Il batch conta: NNAPI paga un overhead fisso per chiamata (setup, e i
     * trasferimenti verso l'acceleratore per gli operatori che partiziona), e
     * un batch lo ammortizza su più frame. Per un avatar conversazionale un
     * piccolo buffer di latenza è accettabile, quindi il per-frame nel batch è
     * il numero che dice se il modo A è fattibile con una pipeline a gruppi. */
    private double misura(OrtEnvironment env, String modelPath, String ep,
                          int batch, int giri) throws Exception {
        OrtSession.SessionOptions opts = new OrtSession.SessionOptions();
        opts.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT);
        if ("nnapi".equals(ep)) {
            opts.addNnapi(EnumSet.of(NNAPIFlags.USE_FP16));
        } else if ("xnnpack".equals(ep)) {
            Map<String, String> o = new HashMap<>();
            o.put("intra_op_num_threads", "4");
            opts.addXnnpack(o);
        } // "cpu" = default, nessun EP

        OrtSession sess = env.createSession(modelPath, opts);
        OnnxTensor mel = rand(env, new long[]{batch, 1, 80, 16});
        OnnxTensor vid = rand(env, new long[]{batch, 6, 96, 96});
        Map<String, OnnxTensor> feeds = new HashMap<>();
        feeds.put("mel", mel);
        feeds.put("vid", vid);

        for (int i = 0; i < 2; i++) sess.run(feeds).close(); // warm-up

        long t0 = System.nanoTime();
        for (int i = 0; i < giri; i++) sess.run(feeds).close();
        double ms = (System.nanoTime() - t0) / 1e6 / giri / batch;

        mel.close();
        vid.close();
        sess.close();
        Log.i(TAG, ep + " b" + batch + ": " + ms + " ms/frame");
        return ms;
    }

    private JSObject eseguiBenchmark(String url, int frames) throws Exception {
        long tScar = System.nanoTime();
        String modelPath = scaricaSuFile(url, "wav2lip.onnx");
        long modelBytes = new java.io.File(modelPath).length();
        double caricamentoS = (System.nanoTime() - tScar) / 1e9;

        OrtEnvironment env = OrtEnvironment.getEnvironment();
        // Più configurazioni, per trovare il collo di bottiglia: NNAPI a batch
        // crescente (ammortizza l'overhead), e XNNPACK (CPU ottimizzata) come
        // pietra di paragone. Si tiene la migliore.
        String[][] prove = {
            {"nnapi", "1", "20"},
            {"nnapi", "4", "10"},
            {"nnapi", "8", "6"},
            {"xnnpack", "1", "15"},
        };
        JSObject r = new JSObject();
        com.getcapacitor.JSArray dettagli = new com.getcapacitor.JSArray();
        String bestEp = "-";
        int bestBatch = 0;
        double bestMs = Double.MAX_VALUE;
        for (String[] p : prove) {
            String ep = p[0];
            int batch = Integer.parseInt(p[1]);
            int giri = Integer.parseInt(p[2]);
            try {
                double ms = misura(env, modelPath, ep, batch, giri);
                dettagli.put(ep + " ×" + batch + ": " + Math.round(ms * 10) / 10.0
                        + " ms/frame (" + Math.round(1000.0 / ms) + " fps)");
                if (ms < bestMs) { bestMs = ms; bestEp = ep; bestBatch = batch; }
            } catch (Throwable e) {
                dettagli.put(ep + " ×" + batch + ": non disponibile ("
                        + e.getClass().getSimpleName() + ")");
                Log.w(TAG, ep + " b" + batch + " fallito: " + e.getMessage());
            }
        }
        if (bestMs == Double.MAX_VALUE) throw new Exception("nessuna configurazione ha funzionato");

        r.put("provider", bestEp + " ×" + bestBatch);
        r.put("msPerFrame", bestMs);
        r.put("fps", 1000.0 / bestMs);
        r.put("caricamentoS", caricamentoS);
        r.put("modelBytes", modelBytes);
        r.put("dettagli", dettagli);
        return r;
    }
}
