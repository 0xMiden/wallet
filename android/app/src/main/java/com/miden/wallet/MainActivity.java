package com.miden.wallet;

import android.content.Intent;
import android.os.Bundle;
import android.view.Window;

import androidx.core.view.WindowCompat;

import com.getcapacitor.BridgeActivity;

import ee.forgr.capacitor_inappbrowser.BreadAuthCallbacks;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // A dApp sign-in callback carries a login handle; Capacitor hands every intent to every plugin, and AppPlugin keeps VIEW URLs
        setIntent(BreadAuthCallbacks.consume(getIntent()));
        // Register custom plugins before super.onCreate
        registerPlugin(HardwareSecurityPlugin.class);
        registerPlugin(HotKeyPlugin.class);
        registerPlugin(ReownPlugin.class);
        registerPlugin(ScreenshotGuardPlugin.class);
        registerPlugin(SystemChromePlugin.class);
        registerPlugin(UpdateAvailabilityPlugin.class);
        registerPlugin(BreadConnectOpenerPlugin.class);

        // A launch intent whose link an earlier instance already received is dropped here, before the bridge
        // reads the launch URL, so it cannot open its page again.
        Intent intent = getIntent();
        if (LaunchIntentLogic.alreadyDelivered(savedInstanceState != null, intent.getFlags())) {
            intent.setData(null);
        }

        super.onCreate(savedInstanceState);
        setupStatusBar();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(BreadAuthCallbacks.consume(intent));
    }

    // The status bar's colour and icons follow the app theme from the web layer
    // (src/lib/mobile/status-bar.ts), so nothing here may force them.
    private void setupStatusBar() {
        Window window = getWindow();
        WindowCompat.setDecorFitsSystemWindows(window, true);
    }
}
