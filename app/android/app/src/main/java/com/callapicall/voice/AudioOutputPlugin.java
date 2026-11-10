package com.callapicall.voice;

import android.content.Context;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.util.Log;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Routing dell'uscita audio: auricolare (earpiece), altoparlante (viva voce),
 * o Bluetooth. Su Android 12+ usa setCommunicationDevice; sotto, le API legacy.
 *
 * - speaker   -> MODE_NORMAL, altoparlante (riproduzione media)
 * - earpiece  -> MODE_IN_COMMUNICATION, capsula auricolare (full-duplex + AEC)
 * - bluetooth -> MODE_IN_COMMUNICATION, cuffia/auto Bluetooth (SCO)
 */
@CapacitorPlugin(name = "AudioOutput")
public class AudioOutputPlugin extends Plugin {

    @PluginMethod
    public void setOutput(PluginCall call) {
        String mode = call.getString("mode", "speaker");
        AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        if (am == null) { call.reject("AudioManager non disponibile"); return; }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                setOutputModern(am, mode);
            } else {
                setOutputLegacy(am, mode);
            }
            JSObject ret = new JSObject();
            ret.put("ok", true);
            ret.put("mode", mode);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("setOutput fallito: " + e.getMessage());
        }
    }

    /** Ripristina la modalita' audio normale (a fine sessione). */
    @PluginMethod
    public void clear(PluginCall call) {
        AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        if (am != null) {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    am.clearCommunicationDevice();
                } else {
                    am.stopBluetoothSco();
                    am.setBluetoothScoOn(false);
                    am.setSpeakerphoneOn(false);
                }
                am.setMode(AudioManager.MODE_NORMAL);
            } catch (Exception ignored) {}
        }
        call.resolve();
    }

    private void setOutputModern(AudioManager am, String mode) {
        int type;
        switch (mode) {
            case "earpiece":  type = AudioDeviceInfo.TYPE_BUILTIN_EARPIECE; break;
            case "bluetooth": type = AudioDeviceInfo.TYPE_BLUETOOTH_SCO;    break;
            default:          type = AudioDeviceInfo.TYPE_BUILTIN_SPEAKER;  break;
        }
        // MODE_IN_COMMUNICATION anche per il vivavoce. In MODE_NORMAL la
        // piattaforma non ingaggia la cancellazione d'eco hardware: il
        // microfono risente l'altoparlante, lo STT trascrive la voce
        // dell'avatar e l'avatar si interrompe da solo. E' la ragione per cui
        // la conversazione continua era concessa solo in cuffia.
        am.setMode(AudioManager.MODE_IN_COMMUNICATION);
        AudioDeviceInfo target = null;
        StringBuilder visti = new StringBuilder();
        for (AudioDeviceInfo d : am.getAvailableCommunicationDevices()) {
            visti.append(d.getType()).append(' ');
            if (d.getType() == type) { target = d; break; }
        }
        // In MODE_IN_COMMUNICATION il device predefinito e' l'AURICOLARE, non
        // l'altoparlante: e' la modalita' "telefonata". Quindi qui non basta
        // chiedere la modalita' giusta — se il device non viene applicato, la
        // voce esce dall'auricolare e il vivavoce non c'e'. Succedeva
        // esattamente questo: selezionando Vivavoce si sentiva dall'auricolare.
        //
        // `setCommunicationDevice` ritorna false quando il device non e'
        // accettato, e il valore va guardato: senza, il fallimento e'
        // invisibile. Il ripiego e' l'API vecchia (`setSpeakerphoneOn`), che e'
        // deprecata ma funziona ancora ed e' l'unica che resta.
        boolean applicato = false;
        if (target != null) {
            applicato = am.setCommunicationDevice(target);
        }
        if (!applicato) {
            Log.w("AudioOutput", "device " + type + " non applicato (disponibili: "
                    + visti + "): ripiego sull'API vecchia");
            am.clearCommunicationDevice();
            if (type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) {
                am.setSpeakerphoneOn(true);
            } else if (type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE) {
                am.setSpeakerphoneOn(false);
            }
        } else if (type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) {
            // Applicato: si spegne comunque il flag vecchio, perche' i due
            // meccanismi convivono e su alcuni telefoni l'ultimo vince.
            am.setSpeakerphoneOn(true);
        }
        Log.i("AudioOutput", "uscita " + mode + " -> device " + type
                + (applicato ? " applicato" : " via API vecchia")
                + ", modo " + am.getMode());
    }

    @SuppressWarnings("deprecation")
    private void setOutputLegacy(AudioManager am, String mode) {
        if ("speaker".equals(mode)) {
            // Come sopra: la modalita' comunicazione e' cio' che accende
            // l'AEC di piattaforma, e senza il vivavoce non e' sostenibile.
            am.setMode(AudioManager.MODE_IN_COMMUNICATION);
            am.stopBluetoothSco();
            am.setBluetoothScoOn(false);
            am.setSpeakerphoneOn(true);
        } else if ("bluetooth".equals(mode)) {
            am.setMode(AudioManager.MODE_IN_COMMUNICATION);
            am.setSpeakerphoneOn(false);
            am.startBluetoothSco();
            am.setBluetoothScoOn(true);
        } else { // earpiece
            am.setMode(AudioManager.MODE_IN_COMMUNICATION);
            am.stopBluetoothSco();
            am.setBluetoothScoOn(false);
            am.setSpeakerphoneOn(false);
        }
    }
}
