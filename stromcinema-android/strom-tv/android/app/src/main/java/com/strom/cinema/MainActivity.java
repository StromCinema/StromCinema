package com.strom.cinema;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(StromPlayerPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
