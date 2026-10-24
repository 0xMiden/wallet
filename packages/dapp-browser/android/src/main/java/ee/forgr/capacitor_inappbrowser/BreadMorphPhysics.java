package ee.forgr.capacitor_inappbrowser;

final class BreadMorphPhysics {
    static final BreadMorphPhysics EXPAND = new BreadMorphPhysics(0.42f, 0.88f);
    static final BreadMorphPhysics COLLAPSE = new BreadMorphPhysics(0.38f, 0.90f);
    static final BreadMorphPhysics RELEASE = new BreadMorphPhysics(0.40f, 0.82f);

    final float stiffness;
    final float dampingRatio;

    private BreadMorphPhysics(float response, float dampingRatio) {
        this.stiffness = 0;
        this.dampingRatio = 0;
    }
}
