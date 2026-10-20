package com.miden.breadconnect;

import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

final class NativeOpenAttempt {

    static final String REQUEST_PREFIX = "https://bread.miden.xyz/request#";
    static final String BREAD_PACKAGE = "com.miden.wallet";
    static final String MARKET_URL = "market://details?id=com.miden.wallet";
    static final String PLAY_URL = "https://play.google.com/store/apps/details?id=com.miden.wallet";
    static final long EXPIRY_MS = 30 * 60 * 1000L;

    interface IO {
        boolean isBread();
        boolean start(String link, String targetPackage);
    }

    interface Scheduler {
        Runnable after(long delay, Runnable action);
    }

    static final class Result {
        final boolean opened;
        final String next;
        final boolean cancelled;

        Result(boolean opened, String next, boolean cancelled) {
            this.opened = opened;
            this.next = next;
            this.cancelled = cancelled;
        }
    }

    private static final class Attempt {
        final String link;
        String expected = "wallet";
        boolean inFlight;
        boolean closeRequested;
        Runnable cancelExpiry;

        Attempt(String link) {
            this.link = link;
        }
    }

    private final Map<String, Attempt> attempts = new HashMap<>();
    private final IO io;
    private final Scheduler scheduler;
    private boolean closed;

    NativeOpenAttempt(IO io, Scheduler scheduler) {
        this.io = io;
        this.scheduler = scheduler;
    }

    String prepare(String link) {
        if (link == null || !link.startsWith(REQUEST_PREFIX)) {
            return null;
        }
        String id = UUID.randomUUID().toString();
        Attempt attempt = new Attempt(link);
        synchronized (this) {
            if (closed) {
                return null;
            }
            attempts.put(id, attempt);
        }
        Runnable cancel = scheduler.after(EXPIRY_MS, () -> close(id));
        boolean retained;
        synchronized (this) {
            retained = attempts.get(id) == attempt;
            if (retained) {
                attempt.cancelExpiry = cancel;
            }
        }
        if (!retained) {
            cancel.run();
        }
        return id;
    }

    Result openStep(String id, String step) {
        Attempt attempt;
        synchronized (this) {
            attempt = attempts.get(id);
            if (attempt == null || !step.equals(attempt.expected) || attempt.inFlight) {
                return new Result(false, null, true);
            }
            attempt.inFlight = true;
        }
        boolean opened = false;
        String next = null;
        try {
            if ("wallet".equals(step)) {
                opened = io.isBread() && io.start(attempt.link, BREAD_PACKAGE);
                if (!opened) {
                    next = "primaryStore";
                }
            } else if ("primaryStore".equals(step)) {
                if (!io.start(MARKET_URL, null)) {
                    next = "secondaryStore";
                }
            } else {
                io.start(PLAY_URL, null);
            }
        } catch (RuntimeException error) {
            close(id);
            throw error;
        }
        Runnable cancel = null;
        synchronized (this) {
            if (attempts.get(id) != attempt) {
                return new Result(false, null, true);
            }
            attempt.inFlight = false;
            attempt.expected = next;
            if (next == null) {
                attempts.remove(id);
                cancel = attempt.cancelExpiry;
            }
        }
        if (cancel != null) {
            cancel.run();
        }
        return new Result(opened, next, false);
    }

    synchronized void revoke(String id) {
        // The extraction checkpoint carries ownership; admission enforcement follows its regression gate.
        Attempt attempt = attempts.get(id);
        if (attempt != null) {
            attempt.closeRequested = true;
        }
    }

    void closeAll() {
        String[] ids;
        synchronized (this) {
            closed = true;
            ids = attempts.keySet().toArray(new String[0]);
        }
        for (String id : ids) {
            close(id);
        }
    }

    boolean openWallet(String link) {
        boolean opened = io.isBread() && io.start(link, BREAD_PACKAGE);
        if (!opened && !io.start(MARKET_URL, null)) {
            io.start(PLAY_URL, null);
        }
        return opened;
    }

    private void close(String id) {
        Attempt attempt;
        synchronized (this) {
            attempt = attempts.remove(id);
        }
        if (attempt != null && attempt.cancelExpiry != null) {
            attempt.cancelExpiry.run();
        }
    }
}
