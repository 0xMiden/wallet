package com.miden.wallet;

import android.os.Bundle;
import android.view.Window;

import androidx.core.view.WindowCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Register custom plugins before super.onCreate
        registerPlugin(HardwareSecurityPlugin.class);
        registerPlugin(HotKeyPlugin.class);
        registerPlugin(ReownPlugin.class);
        registerPlugin(ScreenshotGuardPlugin.class);
        registerPlugin(SystemChromePlugin.class);
        registerPlugin(UpdateAvailabilityPlugin.class);

        super.onCreate(savedInstanceState);
        setupStatusBar();
    }

    // The status bar's colour and icons follow the app theme from the web layer
    // (src/lib/mobile/status-bar.ts), so nothing here may force them.
    private void setupStatusBar() {
        Window window = getWindow();
        WindowCompat.setDecorFitsSystemWindows(window, true);
    }
}
