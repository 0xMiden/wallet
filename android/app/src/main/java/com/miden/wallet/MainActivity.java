package com.miden.wallet;

import android.content.Intent;
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

        // An activity restored after its process died, or reopened from Recents, gets back the launch intent
        // whose link an earlier instance already received; dropped here, before the bridge reads the launch
        // URL, it cannot open its page again.
        Intent intent = getIntent();
        if (savedInstanceState != null || (intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) {
            intent.setData(null);
        }

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
