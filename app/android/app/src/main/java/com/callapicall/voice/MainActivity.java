package com.callapicall.voice;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AudioOutputPlugin.class);
        registerPlugin(Wav2LipNativePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
