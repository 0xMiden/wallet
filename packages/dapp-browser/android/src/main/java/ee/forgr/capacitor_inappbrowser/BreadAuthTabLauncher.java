package ee.forgr.capacitor_inappbrowser;

import android.content.Intent;
import android.net.Uri;
import androidx.activity.result.ActivityResultCallback;
import androidx.activity.result.ActivityResultCaller;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.ActivityResultRegistry;
import androidx.activity.result.contract.ActivityResultContract;
import androidx.browser.auth.AuthTabIntent;
import java.util.UUID;

final class BreadAuthTabLauncher implements ActivityResultCaller {
    private final String key = "bread_auth_" + UUID.randomUUID();
    private ActivityResultRegistry registry;
    private ActivityResultLauncher<Intent> launcher;

    BreadAuthTabLauncher(ActivityResultRegistry registry, ActivityResultCallback<AuthTabIntent.AuthResult> callback) {
        this.registry = registry;
        launcher = AuthTabIntent.registerActivityResultLauncher(this, callback);
    }

    void launch(String browser, String url) {
        AuthTabIntent tab = new AuthTabIntent.Builder().build();
        tab.intent.setPackage(browser);
        tab.launch(launcher, Uri.parse(url), BreadAuthState.CALLBACK_SCHEME);
    }

    void close() {
        ActivityResultLauncher<Intent> owned = launcher;
        launcher = null; registry = null;
        if (owned != null) owned.unregister();
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
