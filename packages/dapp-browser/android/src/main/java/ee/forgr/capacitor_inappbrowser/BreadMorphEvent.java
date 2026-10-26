package ee.forgr.capacitor_inappbrowser;

final class BreadMorphEvent {
    final String morphId;
    final String phase;
    final String target;
    final float progress;
    final float velocity;
    final boolean tracking;
    final long sequence;

    BreadMorphEvent(String morphId, String phase, String target, float progress, float velocity, boolean tracking, long sequence) {
        this.morphId = morphId;
        this.phase = phase;
        this.target = target;
        this.progress = progress;
        this.velocity = velocity;
        this.tracking = tracking;
        this.sequence = sequence;
    }
}
