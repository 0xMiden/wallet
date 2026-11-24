package ee.forgr.capacitor_inappbrowser;

import android.util.Log;

final class IabLog {
    private static volatile boolean debuggable;

    private IabLog() {}

    static void setDebuggable(boolean value) {
        debuggable = value;
    }

    static void d(String tag, String message) {
        if (debuggable) Log.d(tag, message);
    }

    static void i(String tag, String message) {
        if (debuggable) Log.i(tag, message);
    }
}
