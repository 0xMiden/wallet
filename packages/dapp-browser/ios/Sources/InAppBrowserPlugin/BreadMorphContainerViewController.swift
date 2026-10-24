import UIKit

class BreadMorphContainerViewController: UIViewController {
    let child: UIViewController
    let shadowView = UIView()
    let clipView = UIView()
    var morphing = false
    let tap = UITapGestureRecognizer()
    let pan = UIPanGestureRecognizer()
    var onTap: (() -> Void)?
    var onPan: ((UIGestureRecognizer.State, CGPoint, CGPoint) -> Void)?

    init(child: UIViewController) {
        self.child = child
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { return nil }

    func layoutAtRest() {}

    func apply(_ pose: BreadMorphPose) {}

    func presentationFrame() -> CGRect { .zero }

    func acceptsTouch(at point: CGPoint) -> Bool { false }
}
