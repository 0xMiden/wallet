package ee.forgr.capacitor_inappbrowser;

final class BreadPresentationState {
    enum Phase { PREPARING, VISIBLE, TEMPORARILY_HIDDEN, ERROR, CLOSED }

    private final long timeout;
    private long generation;
    private long navigationGeneration;
    private long remaining;
    private long lastTick;
    private boolean visible = true;
    private boolean foreground = true;
    private boolean configured;
    private boolean ready;
    private boolean painted;
    private boolean revealed;
    private boolean failed;
    private boolean closed;
    private boolean fullscreen;
    private String token;

    BreadPresentationState(long timeout) { this(timeout, true); }
    BreadPresentationState(long timeout, boolean initiallyVisible) {
        this.timeout = timeout; remaining = timeout; visible = initiallyVisible;
    }
    long navigationGeneration() { return navigationGeneration; }
    long generation() { return generation; }
    boolean fullscreen() { return fullscreen; }
    boolean isReady() { return ready; }
    String token() { return token; }
    boolean active() { return visible && foreground && !closed; }

    Phase phase() {
        if (closed) return Phase.CLOSED;
        if (!active()) return Phase.TEMPORARILY_HIDDEN;
        if (failed) return Phase.ERROR;
        return configured && ready && painted ? Phase.VISIBLE : Phase.PREPARING;
    }

    void navigate(long now) {
        if (closed) return;
        generation++;
        navigationGeneration++;
        configured = ready = painted = revealed = failed = false;
        token = null;
        remaining = timeout;
        lastTick = now;
    }

    void configure(String token, boolean fullscreen, boolean manualReady) {
        if (closed || failed) return;
        this.token = token;
        if (this.fullscreen != fullscreen) layoutChanged();
        this.fullscreen = fullscreen;
        configured = true;
        // Automatic readiness is still a document-ready message from the bootstrap.
        // Metadata can arrive while the parser is still loading the head.
    }

    void ready() { if (configured && !closed && !failed) ready = true; }

    // Paint callbacks are also invalidated by geometry and visibility changes.
    void layoutChanged() { if (!closed) { generation++; painted = false; } }
    boolean canReveal(long request) {
        return request == generation && active() && configured && ready && !failed;
    }
    void painted(long request) {
        if (canReveal(request)) { painted = true; revealed = true; }
    }

    void visibility(boolean value, long now) {
        if (closed || visible == value) return;
        tick(now);
        visible = value;
        layoutChanged();
    }
    void foreground(boolean value, long now) {
        if (closed || foreground == value) return;
        tick(now);
        foreground = value;
        layoutChanged();
    }
    boolean tick(long now) {
        if (active() && !revealed && !failed) {
            remaining = Math.max(0, remaining - Math.max(0, now - lastTick));
            if (remaining == 0) fail();
        }
        lastTick = now;
        return failed;
    }
    void fail() { if (!closed) { failed = true; layoutChanged(); } }
    boolean close() {
        if (closed) return false;
        closed = true;
        generation++;
        navigationGeneration++;
        return true;
    }

    // Hidden requests retain authority over their own instance, never another session.
    boolean authorizes(boolean mainFrame, String messageToken, String documentToken, long started) {
        return !closed && mainFrame && started == navigationGeneration && messageToken != null
            && !messageToken.isEmpty() && messageToken.equals(documentToken);
    }
}
