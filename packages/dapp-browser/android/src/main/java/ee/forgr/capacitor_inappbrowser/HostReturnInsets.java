package ee.forgr.capacitor_inappbrowser;

import android.graphics.Insets;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.WebView;
import java.lang.ref.WeakReference;
import java.util.WeakHashMap;
import java.util.function.BooleanSupplier;

@androidx.annotation.RequiresApi(30)
final class HostReturnInsets implements View.OnApplyWindowInsetsListener, View.OnAttachStateChangeListener {
    private static final WeakHashMap<WebView, WeakReference<HostReturnInsets>> owners = new WeakHashMap<>();
    private final WeakReference<WebView> host;
    private Runnable changed;
    private BooleanSupplier current;
    private WindowInsets delivered;
    private long revision;
    private boolean finished, released;

    static HostReturnInsets acquire(WebView host, BooleanSupplier current, Runnable changed) {
        WeakReference<HostReturnInsets> existing = owners.get(host);
        if (existing != null && existing.get() != null) return null;
        HostReturnInsets policy = new HostReturnInsets(host, current, changed);
        owners.put(host, new WeakReference<>(policy));
        host.setOnApplyWindowInsetsListener(policy);
        host.addOnAttachStateChangeListener(policy);
        host.requestApplyInsets();
        return policy;
    }

    private HostReturnInsets(WebView host, BooleanSupplier current, Runnable changed) {
        this.host = new WeakReference<>(host);
        this.current = current;
        this.changed = changed;
    }

    boolean owned() {
        WebView view = host.get();
        WeakReference<HostReturnInsets> owner = owners.get(view);
        return !released && owner != null && owner.get() == this;
    }

    boolean ready() { return owned() && delivered != null; }
    long revision() { return revision; }

    @Override public WindowInsets onApplyWindowInsets(View view, WindowInsets incoming) {
        if (!owned()) return view.onApplyWindowInsets(incoming);
        if (!finished && !current.getAsBoolean()) {
            release();
            return view.onApplyWindowInsets(incoming);
        }
        Insets ordinary = incoming.getInsetsIgnoringVisibility(WindowInsets.Type.systemBars());
        WindowInsets effective = new WindowInsets.Builder(incoming)
            .setInsets(WindowInsets.Type.systemBars(), ordinary).build();
        WindowInsets previous = delivered;
        delivered = null;
        // Normal WebView delivery must reach native env() before a paint fence can be requested.
        WindowInsets result = view.onApplyWindowInsets(effective);
        delivered = effective;
        if (!effective.equals(previous)) {
            revision++;
            if (changed != null) changed.run();
        }
        if (finished && incoming.getInsets(WindowInsets.Type.systemBars()).equals(ordinary)) release();
        return result;
    }

    void finish() {
        finished = true;
        // The host listener may outlive the game until ordinary insets arrive; sever game references.
        current = null;
        changed = null;
    }

    void requestInsets() {
        WebView view = host.get();
        if (owned() && view != null) view.requestApplyInsets();
    }

    private void release() {
        if (owned()) {
            WebView view = host.get();
            owners.remove(view);
            view.setOnApplyWindowInsetsListener(null);
            view.removeOnAttachStateChangeListener(this);
        }
        released = true;
        delivered = null;
        current = null;
        changed = null;
    }

    @Override public void onViewAttachedToWindow(View view) {}
    @Override public void onViewDetachedFromWindow(View view) { release(); }
}
