package ee.forgr.capacitor_inappbrowser;

import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import androidx.activity.result.ActivityResultCallback;
import androidx.activity.result.ActivityResultCaller;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.ActivityResultRegistry;
import androidx.activity.result.contract.ActivityResultContract;
import androidx.browser.auth.AuthTabIntent;
import java.util.UUID;

// If a closed launcher still awaits a result when its host is recreated, the restored key has no callback;
// that result stays parked until the host finishes.
final class BreadAuthTabLauncher implements ActivityResultCaller {
    private final String key = "bread_auth_" + UUID.randomUUID();
    private ActivityResultRegistry registry;
    private ActivityResultLauncher<Intent> launcher;
    private ActivityResultCallback<AuthTabIntent.AuthResult> callback;
    private boolean awaitingResult;

    BreadAuthTabLauncher(ActivityResultRegistry registry, ActivityResultCallback<AuthTabIntent.AuthResult> callback) {
        this.registry = registry;
        this.callback = callback;
        launcher = AuthTabIntent.registerActivityResultLauncher(this, this::onResult);
    }

    void launch(String browser, String url) {
        AuthTabIntent tab = new AuthTabIntent.Builder().build();
        tab.intent.setPackage(browser);
        awaitingResult = true;
        try { tab.launch(launcher, Uri.parse(url), BreadAuthState.CALLBACK_SCHEME); }
        catch (RuntimeException e) { awaitingResult = false; throw e; }
    }

    void close() {
        callback = null;
        if (awaitingResult) return;
        ActivityResultLauncher<Intent> owned = launcher;
        launcher = null; registry = null;
        if (owned != null) owned.unregister();
    }

    private void onResult(AuthTabIntent.AuthResult result) {
        ActivityResultCallback<AuthTabIntent.AuthResult> pending = callback;
        callback = null;
        try {
            if (pending != null) pending.onActivityResult(result);
        } finally {
            ActivityResultLauncher<Intent> owned = launcher;
            launcher = null; registry = null; awaitingResult = false;
            // Dispatch removes the launched key only after this callback returns.
            if (owned != null) new Handler(Looper.getMainLooper()).post(owned::unregister);
        }
    }

    @Override public <I, O> ActivityResultLauncher<I> registerForActivityResult(
            ActivityResultContract<I, O> contract, ActivityResultCallback<O> callback) {
        return registerForActivityResult(contract, registry, callback);
    }

    @Override public <I, O> ActivityResultLauncher<I> registerForActivityResult(
            ActivityResultContract<I, O> contract, ActivityResultRegistry registry, ActivityResultCallback<O> callback) {
        // A visible page can request sign-in after its activity has already started.
        return registry.register(key, contract, callback);
    }
}
