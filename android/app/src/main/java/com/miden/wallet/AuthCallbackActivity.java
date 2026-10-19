package com.miden.wallet;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;

import ee.forgr.capacitor_inappbrowser.BreadAuthCallbacks;

public class AuthCallbackActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Reaching the singleTask host would clear the Auth Tab above it before the URL could be ignored.
        if (BreadAuthCallbacks.forwardsToHost()) {
            startActivity(new Intent(getIntent()).setClass(this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP));
        }
        finish();
    }
}
