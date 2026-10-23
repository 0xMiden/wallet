package ee.forgr.capacitor_inappbrowser;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import androidx.activity.ComponentActivity;
import androidx.activity.result.ActivityResultCallback;
import androidx.activity.result.ActivityResultCaller;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.ActivityResultRegistry;
import androidx.activity.result.contract.ActivityResultContract;
import androidx.browser.auth.AuthTabIntent;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import java.util.WeakHashMap;

final class BreadAuthTabLauncher implements ActivityResultCaller {
    private static final String SAVED_STATE_KEY = "bread_auth_launch_keys";
    private static final WeakHashMap<ActivityResultRegistry, Ledger> ledgers = new WeakHashMap<>();
    private static final class Ledger {
        final Set<String> keys = new HashSet<>();
        boolean registered;
    }

    private final String key;
    private final Ledger ledger;
    private ActivityResultRegistry registry;
    private ActivityResultLauncher<Intent> launcher;
    private ActivityResultCallback<AuthTabIntent.AuthResult> callback;
    private boolean awaitingResult;

    BreadAuthTabLauncher(ActivityResultRegistry registry, ActivityResultCallback<AuthTabIntent.AuthResult> callback) {
        this(registry, callback, "bread_auth_" + UUID.randomUUID(), false);
    }

    private BreadAuthTabLauncher(ActivityResultRegistry registry, ActivityResultCallback<AuthTabIntent.AuthResult> callback,
            String key, boolean awaitingResult) {
        this.key = key;
        this.ledger = ledgers.computeIfAbsent(registry, ignored -> new Ledger());
        this.registry = registry;
        this.callback = callback;
        this.awaitingResult = awaitingResult;
        ledger.keys.add(key);
        launcher = AuthTabIntent.registerActivityResultLauncher(this, this::onResult);
    }

    static void hostLoaded(ComponentActivity host) {
        ActivityResultRegistry registry = host.getActivityResultRegistry();
        Ledger ledger = ledgers.computeIfAbsent(registry, ignored -> new Ledger());
        if (ledger.registered) return;
        ledger.registered = true;
        host.getSavedStateRegistry().registerSavedStateProvider(SAVED_STATE_KEY, () -> {
            Bundle saved = new Bundle();
            saved.putStringArrayList("keys", new ArrayList<>(ledger.keys));
            return saved;
        });
        Bundle restored = host.getSavedStateRegistry().consumeRestoredStateForKey(SAVED_STATE_KEY);
        ArrayList<String> keys = restored == null ? null : restored.getStringArrayList("keys");
        if (keys == null) return;
        // Only launch identities survive recreation. No old page or auth data is reattached.
        for (String key : keys) new BreadAuthTabLauncher(registry, null, key, true);
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
        unregister();
    }

    private void unregister() {
        ledger.keys.remove(key);
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
            awaitingResult = false;
            ledger.keys.remove(key);
            // Dispatch removes its launched key after returning. Registration can deliver synchronously,
            // before the constructor assigns launcher, so defer reading it as well as unregistering it.
            new Handler(Looper.getMainLooper()).post(this::unregister);
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
