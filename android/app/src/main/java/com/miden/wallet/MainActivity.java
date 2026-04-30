package com.miden.wallet;

import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.Window;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Register custom plugins before super.onCreate
        registerPlugin(HardwareSecurityPlugin.class);
        registerPlugin(GoogleAuthPlugin.class);

        super.onCreate(savedInstanceState);
        setupStatusBar();

        // Also set after delay in case Capacitor overrides it
        new Handler(Looper.getMainLooper()).postDelayed(this::setupStatusBar, 500);
    }

    private void setupStatusBar() {
        Window window = getWindow();
        WindowCompat.setDecorFitsSystemWindows(window, true);
        window.setStatusBarColor(Color.WHITE);

        // Use modern API for light status bar
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
        if (controller != null) {
            controller.setAppearanceLightStatusBars(true);
        }
    }
}
