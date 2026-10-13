package ee.forgr.capacitor_inappbrowser;

import android.view.Window;
import android.view.WindowManager;
import java.lang.ref.WeakReference;
import java.util.WeakHashMap;

@androidx.annotation.MainThread
final class FullscreenRotation {
    private static final int JUMPCUT = WindowManager.LayoutParams.ROTATION_ANIMATION_JUMPCUT;
    private static final WeakHashMap<Window, Policy> policies = new WeakHashMap<>();
    private WeakReference<Window> window = new WeakReference<>(null);

    private static final class Policy {
        final int original;
        final WeakHashMap<FullscreenRotation, Boolean> owners = new WeakHashMap<>();
        Policy(int original) { this.original = original; }
    }

    void acquire(Window target) {
        if (target != null && window.get() == target) return;
        release();
        if (target == null) return;
        Policy policy = policies.get(target);
        // Iterators skip cleared weak keys before the reference queue receives them.
        if (policy == null || !policy.owners.keySet().iterator().hasNext()) {
            int original = target.getAttributes().rotationAnimation;
            if (policy != null && original == JUMPCUT) original = policy.original;
            policy = new Policy(original);
            policies.put(target, policy);
            hint(target, JUMPCUT);
        }
        policy.owners.put(this, true);
        window = new WeakReference<>(target);
    }

    void release() {
        Window target = window.get();
        window.clear();
        if (target == null) return;
        Policy policy = policies.get(target);
        if (policy == null) return;
        policy.owners.remove(this);
        if (policy.owners.keySet().iterator().hasNext()) return;
        policies.remove(target);
        // A newer external rotation policy must survive our final release.
        if (target.getAttributes().rotationAnimation == JUMPCUT) hint(target, policy.original);
    }

    private static void hint(Window target, int hint) {
        WindowManager.LayoutParams params = target.getAttributes();
        if (params.rotationAnimation == hint) return;
        params.rotationAnimation = hint;
        target.setAttributes(params);
    }
}
