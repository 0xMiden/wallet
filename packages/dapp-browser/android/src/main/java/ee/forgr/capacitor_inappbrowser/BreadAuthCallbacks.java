package ee.forgr.capacitor_inappbrowser;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;

public final class BreadAuthCallbacks {
    private BreadAuthCallbacks() {}

    public static Intent forwardIntent(Context context, Intent callback, Class<? extends Activity> host) {
        // Reaching the singleTask host would clear the Auth Tab above it before the URL could be ignored.
        if (BreadAuthController.authTabInFlight()) return null;
        return new Intent(callback).setClass(context, host)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    }

    // A VIEW intent whose data has the scheme com.miden.wallet.auth (ASCII case-insensitive): hands the data string to the
    // open sheet, if any, and returns a copy without data. Any other intent comes back unchanged, as the same object.
    public static Intent consume(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) return intent;
        String data = intent.getDataString();
        if (data == null || data.indexOf(':') != BreadAuthState.CALLBACK_SCHEME.length()
            || !BreadAuthState.startsWithIgnoringAsciiCase(data, BreadAuthState.CALLBACK_SCHEME)) return intent;
        BreadAuthController.hostCallback(data);
        return new Intent(intent).setData(null);
    }
}
