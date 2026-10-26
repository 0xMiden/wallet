package com.miden.wallet;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;

import ee.forgr.capacitor_inappbrowser.BreadAuthCallbacks;

public class AuthCallbackActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Intent forward = BreadAuthCallbacks.forwardIntent(this, getIntent(), MainActivity.class);
        if (forward != null) startActivity(forward);
        finish();
    }
}
