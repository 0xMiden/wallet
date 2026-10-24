package ee.forgr.capacitor_inappbrowser;

final class BreadMorphPhysics {
    static final BreadMorphPhysics EXPAND = new BreadMorphPhysics(0.42f, 0.88f);
    static final BreadMorphPhysics COLLAPSE = new BreadMorphPhysics(0.38f, 0.90f);
    static final BreadMorphPhysics RELEASE = new BreadMorphPhysics(0.40f, 0.82f);

    final float stiffness;
    final float dampingRatio;

    // The wallet's springs (src/lib/animation/springs.ts) take the same response and damping ratio, mass 1.
    private BreadMorphPhysics(float response, float dampingRatio) {
        double frequency = 2 * Math.PI / response;
        this.stiffness = (float) (frequency * frequency);
        this.dampingRatio = dampingRatio;
    }
}
