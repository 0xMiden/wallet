import UIKit

struct BreadMorphValue {
    let layer: CALayer
    let keyPath: String
    let value: Any
}

final class BreadMorphContainerView: UIView {
    weak var controller: BreadMorphContainerViewController?

    // The model spans the whole slot while the page flies, so touches route by hand against the presentation.
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard controller?.morphing == true else { return super.hitTest(point, with: event) }
        return isUserInteractionEnabled && !isHidden && self.point(inside: point, with: event) ? self : nil
    }
}

class BreadMorphContainerViewController: UIViewController, UIGestureRecognizerDelegate {
    static let keyPrefix = "bread.morph."
    let child: UIViewController
    let shadowView = UIView()
    let clipView = UIView()
    var morphing = false {
        didSet {
            tap.isEnabled = morphing
            pan.isEnabled = morphing
        }
    }
    let tap = UITapGestureRecognizer()
    let pan = UIPanGestureRecognizer()
    var onTap: (() -> Void)?
    var onPan: ((UIGestureRecognizer.State, CGPoint, CGPoint) -> Void)?

    init(child: UIViewController) {
        self.child = child
        super.init(nibName: nil, bundle: nil)
        tap.isEnabled = false
        pan.isEnabled = false
        tap.addTarget(self, action: #selector(tapped))
        pan.addTarget(self, action: #selector(panned(_:)))
        tap.delegate = self
        pan.delegate = self
    }

    required init?(coder: NSCoder) { return nil }

    override func loadView() {
        let view = BreadMorphContainerView()
        view.controller = self
        view.backgroundColor = .clear
        view.addGestureRecognizer(tap)
        view.addGestureRecognizer(pan)
        self.view = view
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        shadowView.isUserInteractionEnabled = false
        shadowView.layer.anchorPoint = .zero
        shadowView.layer.contentsGravity = .resize
        clipView.layer.anchorPoint = .zero
        clipView.clipsToBounds = true
        clipView.layer.cornerCurve = .circular
        view.addSubview(shadowView)
        view.addSubview(clipView)
        addChild(child)
        child.view.autoresizingMask = []
        clipView.addSubview(child.view)
        child.didMove(toParent: self)
        layoutAtRest()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        if !morphing { layoutAtRest() }
    }

    override var childForStatusBarHidden: UIViewController? { child }
    override var childForStatusBarStyle: UIViewController? { child }
    override var childForHomeIndicatorAutoHidden: UIViewController? { child }
    override var childForScreenEdgesDeferringSystemGestures: UIViewController? { child }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { child.supportedInterfaceOrientations }

    func layoutAtRest() {
        morphing = false
        let size = view.bounds.size
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for layer in [clipView.layer, shadowView.layer, view.layer] {
            for key in layer.animationKeys() ?? [] where key.hasPrefix(Self.keyPrefix) { layer.removeAnimation(forKey: key) }
        }
        // The only model write of geometry: it runs at rest, never while a pose is shown.
        let pad = BreadMorphShadow.pad(forWidth: size.width)
        for layer in [clipView.layer, shadowView.layer] {
            layer.transform = CATransform3DIdentity
            layer.position = .zero
        }
        clipView.layer.bounds = CGRect(origin: .zero, size: size)
        shadowView.layer.bounds = CGRect(x: 0, y: 0, width: size.width + 2 * pad, height: size.height + 2 * pad)
        clipView.layer.cornerRadius = 0
        clipView.layer.opacity = 1
        shadowView.layer.opacity = 0
        CATransaction.commit()
        let frame = CGRect(origin: .zero, size: size)
        if child.view.frame != frame { child.view.frame = frame }
    }

    func morphValues(_ pose: BreadMorphPose) -> [BreadMorphValue] {
        let clip = clipView.layer
        let shadow = shadowView.layer
        let scale = NSNumber(value: Double(pose.scale))
        let origin = NSValue(cgPoint: pose.origin)
        let height = NSNumber(value: Double(pose.cropHeight))
        let pad = BreadMorphShadow.pad(forWidth: view.bounds.width)
        let shadowOrigin = NSValue(cgPoint: CGPoint(x: pose.origin.x - pose.scale * pad, y: pose.origin.y - pose.scale * pad))
        return [
            BreadMorphValue(layer: clip, keyPath: "transform.scale", value: scale),
            BreadMorphValue(layer: clip, keyPath: "position", value: origin),
            BreadMorphValue(layer: clip, keyPath: "bounds.size.height", value: height),
            BreadMorphValue(layer: clip, keyPath: "cornerRadius", value: NSNumber(value: Double(pose.cornerRadius))),
            BreadMorphValue(layer: clip, keyPath: "opacity", value: NSNumber(value: Float(pose.alpha))),
            BreadMorphValue(layer: shadow, keyPath: "transform.scale", value: scale),
            BreadMorphValue(layer: shadow, keyPath: "position", value: shadowOrigin),
            BreadMorphValue(layer: shadow, keyPath: "bounds.size.height", value: NSNumber(value: Double(pose.cropHeight + 2 * pad))),
            BreadMorphValue(layer: shadow, keyPath: "opacity", value: NSNumber(value: pose.shadowOpacity))
        ]
    }

    func apply(_ pose: BreadMorphPose) {
        morphing = true
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for value in morphValues(pose) {
            let hold = CABasicAnimation(keyPath: value.keyPath)
            hold.fromValue = value.value
            hold.toValue = value.value
            hold.duration = 1
            hold.fillMode = .forwards
            hold.isRemovedOnCompletion = false
            value.layer.add(hold, forKey: Self.keyPrefix + value.keyPath)
        }
        CATransaction.commit()
    }

    // The shadow is the card's own look, so it follows the card end of the motion (pose at p = 0).
    func setShadow(for card: BreadMorphPose) {
        guard card.shadowOpacity > 0 else { return }
        let screenScale = max(view.window?.screen.scale ?? view.traitCollection.displayScale, 2)
        guard let made = BreadMorphShadow.render(start: card.scale, cornerRadius: card.cornerRadius, width: view.bounds.width, screenScale: screenScale) else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        shadowView.layer.contents = made.image
        shadowView.layer.contentsScale = made.contentsScale
        shadowView.layer.contentsCenter = made.contentsCenter
        CATransaction.commit()
    }

    func presentationFrame() -> CGRect {
        let layer = clipView.layer.presentation() ?? clipView.layer
        let scale = CGFloat((layer.value(forKeyPath: "transform.scale") as? NSNumber)?.doubleValue ?? 1)
        return CGRect(x: layer.position.x, y: layer.position.y, width: layer.bounds.width * scale, height: layer.bounds.height * scale)
    }

    func acceptsTouch(at point: CGPoint) -> Bool { morphing && presentationFrame().contains(point) }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        acceptsTouch(at: touch.location(in: view))
    }

    @objc private func tapped() { onTap?() }

    @objc private func panned(_ recognizer: UIPanGestureRecognizer) {
        onPan?(recognizer.state, recognizer.translation(in: view), recognizer.velocity(in: view))
    }
}
