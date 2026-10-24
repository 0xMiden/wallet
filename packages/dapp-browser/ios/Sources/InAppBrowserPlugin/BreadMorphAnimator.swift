import UIKit
import QuartzCore
import os
import os.signpost

struct BreadMorphPhysics {
    let stiffness: Double
    let damping: Double
}

extension BreadMorphPhysics {
    init(response: Double, dampingRatio: Double) {
        stiffness = pow(2 * .pi / response, 2)
        damping = 4 * .pi * dampingRatio / response
    }

    static let expand = BreadMorphPhysics(response: 0.42, dampingRatio: 0.88)
    static let collapse = BreadMorphPhysics(response: 0.38, dampingRatio: 0.9)
    static let release = BreadMorphPhysics(response: 0.4, dampingRatio: 0.82)
}

struct BreadMorphCard {
    let rect: CGRect
    let cornerRadius: CGFloat
}

struct BreadMorphSpring {
    let from: Double
    let to: Double
    let velocity: Double
    let physics: BreadMorphPhysics
    let start: CFTimeInterval

    init(from: Double, to: Double, velocity: Double, physics: BreadMorphPhysics, start: CFTimeInterval) {
        self.from = from
        self.to = to
        self.velocity = velocity
        self.physics = physics
        self.start = start
    }

    func sample(at time: CFTimeInterval) -> (value: Double, velocity: Double) {
        let omega = physics.stiffness.squareRoot()
        guard omega > 0 else { return (to, 0) }
        let t = max(0, time - start)
        let zeta = physics.damping / (2 * omega)
        let displacement = from - to
        if zeta < 1 {
            let damped = omega * (1 - zeta * zeta).squareRoot()
            let c = (velocity + zeta * omega * displacement) / damped
            let decay = exp(-zeta * omega * t)
            let cosine = cos(damped * t)
            let sine = sin(damped * t)
            let position: Double = decay * (displacement * cosine + c * sine)
            let along: Double = (c * damped - zeta * omega * displacement) * cosine
            let across: Double = (displacement * damped + zeta * omega * c) * sine
            return (to + position, decay * (along - across))
        }
        if zeta == 1 {
            let decay = exp(-omega * t)
            let slope = velocity + omega * displacement
            return (to + decay * (displacement + slope * t), decay * (velocity - omega * slope * t))
        }
        let spread = omega * (zeta * zeta - 1).squareRoot()
        let fast = -zeta * omega + spread
        let slow = -zeta * omega - spread
        let fastPart = (velocity - slow * displacement) / (fast - slow)
        let slowPart = displacement - fastPart
        let fastDecay = exp(fast * t)
        let slowDecay = exp(slow * t)
        return (to + fastPart * fastDecay + slowPart * slowDecay, fastPart * fast * fastDecay + slowPart * slow * slowDecay)
    }

    var settleTime: CFTimeInterval {
        let tolerance = 0.001 * max(abs(to - from), 0.001)
        var last = 0.0
        for step in 0...3000 where abs(sample(at: start + Double(step) / 1000).value - to) > tolerance {
            last = Double(step) / 1000
        }
        return start + last
    }

    func time(reaching value: Double) -> CFTimeInterval? {
        var previous = from - value
        if previous == 0 { return start }
        for step in 1...2000 {
            let current = sample(at: start + Double(step) / 1000).value - value
            if current == 0 || (current < 0) != (previous < 0) {
                return start + (Double(step) - current / (current - previous)) / 1000
            }
            previous = current
        }
        return nil
    }
}

struct BreadMorphPose {
    let scale: CGFloat
    let origin: CGPoint
    let cropHeight: CGFloat
    let cornerRadius: CGFloat
    let shadowOpacity: Float
    let alpha: CGFloat

    static func at(_ p: Double, card: BreadMorphCard?, slot: CGSize) -> BreadMorphPose {
        let t = CGFloat(p)
        guard let card, card.rect.width > 0, slot.width > 0 else {
            let scale = 0.9 + 0.1 * t
            return BreadMorphPose(scale: scale, origin: CGPoint(x: slot.width * (1 - scale) / 2, y: slot.height * (1 - scale) / 2),
                                  cropHeight: slot.height, cornerRadius: 0, shadowOpacity: 0, alpha: min(1, max(0, t)))
        }
        let rect = card.rect
        let start = rect.width / slot.width
        return BreadMorphPose(scale: start + (1 - start) * t,
                              origin: CGPoint(x: rect.minX * (1 - t), y: rect.minY * (1 - t)),
                              cropHeight: rect.height / start * (1 - t) + slot.height * t,
                              cornerRadius: max(0, card.cornerRadius / start * (1 - t)),
                              shadowOpacity: Float(max(0, 0.2 * (1 - p))),
                              alpha: 1)
    }
}

enum BreadMorphGeometry {
    static func progressVelocity(_ v: CGPoint, card: CGRect, slot: CGRect) -> Double {
        let dx = Double(slot.midX - card.midX)
        let dy = Double(slot.midY - card.midY)
        let lengthSquared = dx * dx + dy * dy
        guard lengthSquared > 1e-6 else { return 0 }
        return min(8, max(-8, (Double(v.x) * dx + Double(v.y) * dy) / lengthSquared))
    }

    static func initialVelocity(_ v: Double, from p: Double, to target: Double) -> Double {
        abs(target - p) < 0.01 ? 0 : v / (target - p)
    }

    static func rubberBand(_ x: Double, length: Double) -> Double {
        guard length > 0 else { return 0 }
        let stretched = (1 - 1 / (0.55 * abs(x) / length + 1)) * length
        return x < 0 ? -stretched : stretched
    }
}

final class BreadMorphFrameTarget: NSObject {
    weak var animator: BreadMorphAnimator?
    #if DEBUG
    private static let logger = Logger(subsystem: "com.miden.bread", category: "morph")
    private let trace = UserDefaults.standard.bool(forKey: "BreadMorphTrace")
    #endif

    init(animator: BreadMorphAnimator) {
        self.animator = animator
    }

    @objc func frame(_ link: CADisplayLink) {
        animator?.displayFrame(link.targetTimestamp)
        #if DEBUG
        guard trace, let animator else { return }
        let frame = NSCoder.string(for: animator.presentationFrame())
        Self.logger.debug("bread.morph p=\(animator.progress(), privacy: .public) frame=\(frame, privacy: .public)")
        #endif
    }
}

// Holds the display at full rate from a touch-down until a morph's own link takes over, or until it lapses.
final class BreadFrameRateBoost {
    static let shared = BreadFrameRateBoost(window: BreadFrameRateBoost.visibleWindow)
    static let duration: CFTimeInterval = 0.6
    private let now: () -> CFTimeInterval
    private let window: () -> UIWindow?
    private(set) var link: CADisplayLink?
    private(set) var pulse: CALayer?
    private var expiry: CFTimeInterval = 0
    var active: Bool { link != nil }

    init(now: @escaping () -> CFTimeInterval = CACurrentMediaTime, window: @escaping () -> UIWindow? = { nil }) {
        self.now = now
        self.window = window
    }

    deinit { link?.invalidate() }

    func hold(for duration: CFTimeInterval = BreadFrameRateBoost.duration) {
        expiry = max(expiry, now() + duration)
        guard link == nil else { return }
        let link = CADisplayLink(target: BreadFrameRateBoostTarget(boost: self), selector: #selector(BreadFrameRateBoostTarget.frame(_:)))
        link.preferredFrameRateRange = BreadMorphAnimator.frameRate
        link.add(to: .main, forMode: .common)
        self.link = link
        startPulse()
    }

    func release() {
        link?.invalidate()
        link = nil
        expiry = 0
        guard let pulse else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        pulse.removeFromSuperlayer()
        CATransaction.commit()
        self.pulse = nil
    }

    func tick() { if now() >= expiry { release() } }

    // A display link alone leaves an idle compositor idle; an animation the render server runs keeps it drawing at
    // the requested rate, so the morph's first frame lands on a 120 Hz panel. One point, below 1% opacity.
    private func startPulse() {
        guard let host = window()?.layer else { return }
        let layer = CALayer()
        layer.frame = CGRect(x: 0, y: 0, width: 1, height: 1)
        layer.backgroundColor = UIColor.black.cgColor
        layer.opacity = 0.004
        let animation = CABasicAnimation(keyPath: "opacity")
        animation.fromValue = NSNumber(value: Float(0.004))
        animation.toValue = NSNumber(value: Float(0.008))
        animation.duration = 0.25
        animation.autoreverses = true
        animation.repeatCount = .infinity
        animation.preferredFrameRateRange = BreadMorphAnimator.frameRate
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        layer.add(animation, forKey: "bread.boost")
        host.addSublayer(layer)
        CATransaction.commit()
        pulse = layer
    }

    static func visibleWindow() -> UIWindow? {
        let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .filter { $0.activationState == .foregroundActive }.flatMap(\.windows).filter { !$0.isHidden }
        return windows.first(where: \.isKeyWindow) ?? windows.first
    }
}

final class BreadFrameRateBoostTarget: NSObject {
    weak var boost: BreadFrameRateBoost?

    init(boost: BreadFrameRateBoost) {
        self.boost = boost
    }

    @objc func frame(_ link: CADisplayLink) { boost?.tick() }
}

final class BreadMorphAnimator {
    static let frameRate = CAFrameRateRange(minimum: 80, maximum: 120, preferred: 120)
    static let fadeDuration: CFTimeInterval = 0.2
    private static let log = OSLog(subsystem: "com.miden.bread", category: .pointsOfInterest)
    private weak var container: BreadMorphContainerViewController?
    let now: () -> CFTimeInterval
    var reduceMotion: () -> Bool
    private(set) var target: Double?
    private(set) var spring: BreadMorphSpring?
    private(set) var card: BreadMorphCard?
    private(set) var link: CADisplayLink?
    var companions: [CALayer] = []
    var boosting: Bool { link != nil }
    private var held: Double = 1
    private var fade: (from: Double, start: CFTimeInterval)?
    private var settleWork: DispatchWorkItem?
    private var settleDeadline: CFTimeInterval?
    private var runToken = 0
    private var signpost: OSSignpostID?

    init(container: BreadMorphContainerViewController, now: @escaping () -> CFTimeInterval = CACurrentMediaTime,
         reduceMotion: @escaping () -> Bool = { UIAccessibility.isReduceMotionEnabled }) {
        self.container = container
        self.now = now
        self.reduceMotion = reduceMotion
    }

    deinit { link?.invalidate() }

    func boost() {
        guard link == nil else { return }
        let link = CADisplayLink(target: BreadMorphFrameTarget(animator: self), selector: #selector(BreadMorphFrameTarget.frame(_:)))
        link.preferredFrameRateRange = Self.frameRate
        link.add(to: .main, forMode: .common)
        self.link = link
        BreadFrameRateBoost.shared.release()
    }

    func releaseBoost() {
        guard spring == nil, fade == nil else { return }
        stopLink()
    }

    func progress() -> Double {
        if let spring { return spring.sample(at: now()).value }
        if let fade, let target {
            let elapsed = min(1, max(0, (now() - fade.start) / Self.fadeDuration))
            return fade.from + (target - fade.from) * elapsed
        }
        return held
    }

    func velocity() -> Double { spring?.sample(at: now()).velocity ?? 0 }

    func displayFrame(_ targetTimestamp: CFTimeInterval) {
        guard let deadline = settleDeadline, targetTimestamp >= deadline else { return }
        settleWork?.perform()
    }

    func presentationFrame() -> CGRect { container?.presentationFrame() ?? .zero }

    func run(to target: Double, card: BreadMorphCard?, velocity: Double, physics: BreadMorphPhysics, onSettle: @escaping () -> Void) {
        boost()
        guard let container else { return }
        let start = now()
        let from = progress()
        let fromPose = pose(from)
        if let card { self.card = card } else if target < 0.5 { self.card = nil }
        let toPose = pose(target)
        cancelSettle()
        beginSignpost()
        self.target = target
        container.setShadow(for: pose(0))
        container.morphing = true
        var settling = Self.fadeDuration
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        if reduceMotion() {
            spring = nil
            fade = (from, start)
            let animation = CABasicAnimation(keyPath: "opacity")
            animation.fromValue = NSNumber(value: Float(min(1, max(0, from))))
            animation.toValue = NSNumber(value: Float(min(1, max(0, target))))
            animation.duration = Self.fadeDuration
            animation.timingFunction = CAMediaTimingFunction(name: .easeOut)
            animation.fillMode = .forwards
            animation.isRemovedOnCompletion = false
            animation.preferredFrameRateRange = Self.frameRate
            container.view.layer.add(animation, forKey: BreadMorphContainerViewController.keyPrefix + "opacity")
        } else {
            fade = nil
            spring = BreadMorphSpring(from: from, to: target, velocity: velocity, physics: physics, start: start)
            let relative = CGFloat(BreadMorphGeometry.initialVelocity(velocity, from: from, to: target))
            settling = 0
            let starts = container.morphValues(fromPose) + companionValues(from)
            let ends = container.morphValues(toPose) + companionValues(target)
            for (begin, end) in zip(starts, ends) {
                let animation = CASpringAnimation(keyPath: begin.keyPath)
                animation.mass = 1
                animation.stiffness = CGFloat(physics.stiffness)
                animation.damping = CGFloat(physics.damping)
                animation.initialVelocity = relative
                animation.fromValue = begin.value
                animation.toValue = end.value
                animation.duration = animation.settlingDuration
                animation.fillMode = .forwards
                animation.isRemovedOnCompletion = false
                animation.preferredFrameRateRange = Self.frameRate
                begin.layer.add(animation, forKey: BreadMorphContainerViewController.keyPrefix + begin.keyPath)
                settling = max(settling, animation.duration)
            }
        }
        CATransaction.commit()
        runToken += 1
        let token = runToken
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.runToken == token else { return }
            self.land(at: target)
            onSettle()
        }
        settleWork = work
        settleDeadline = CACurrentMediaTime() + settling
        DispatchQueue.main.asyncAfter(deadline: .now() + settling, execute: work)
    }

    func hold(_ p: Double, card: BreadMorphCard?) {
        self.card = card
        container?.setShadow(for: pose(0))
        track(p)
    }

    func freeze() -> Double {
        let p = progress()
        track(p)
        return p
    }

    func track(_ p: Double) {
        cancelSettle()
        spring = nil
        fade = nil
        target = nil
        held = p
        holdPose(p)
    }

    func finish() -> Double {
        let end: Double = progress() >= 0.5 ? 1 : 0
        land(at: end)
        return end
    }

    func reset() {
        cancelSettle()
        spring = nil
        fade = nil
        target = nil
        held = 1
        container?.layoutAtRest()
        removeCompanionAnimations()
        stopLink()
        endSignpost()
    }

    private func pose(_ p: Double) -> BreadMorphPose {
        BreadMorphPose.at(p, card: card, slot: container?.view.bounds.size ?? .zero)
    }

    private func companionValues(_ p: Double) -> [BreadMorphValue] {
        let opacity = NSNumber(value: Float(min(1, max(0, p))))
        return companions.map { BreadMorphValue(layer: $0, keyPath: "opacity", value: opacity) }
    }

    private func holdPose(_ p: Double) {
        guard let container else { return }
        if reduceMotion() {
            container.morphing = true
            hold([BreadMorphValue(layer: container.view.layer, keyPath: "opacity", value: NSNumber(value: Float(min(1, max(0, p)))))])
        } else {
            container.apply(pose(p))
            hold(companionValues(p))
        }
    }

    private func hold(_ values: [BreadMorphValue]) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for value in values {
            let animation = CABasicAnimation(keyPath: value.keyPath)
            animation.fromValue = value.value
            animation.toValue = value.value
            animation.duration = 1
            animation.fillMode = .forwards
            animation.isRemovedOnCompletion = false
            value.layer.add(animation, forKey: BreadMorphContainerViewController.keyPrefix + value.keyPath)
        }
        CATransaction.commit()
    }

    private func land(at end: Double) {
        cancelSettle()
        spring = nil
        fade = nil
        target = nil
        held = end
        if end >= 1 {
            container?.layoutAtRest()
            removeCompanionAnimations()
        } else {
            holdPose(end)
        }
        stopLink()
        endSignpost()
    }

    private func cancelSettle() {
        runToken += 1
        settleWork?.cancel()
        settleWork = nil
        settleDeadline = nil
    }

    private func removeCompanionAnimations() {
        for layer in companions { layer.removeAnimation(forKey: BreadMorphContainerViewController.keyPrefix + "opacity") }
    }

    private func stopLink() {
        link?.invalidate()
        link = nil
    }

    private func beginSignpost() {
        guard signpost == nil else { return }
        let id = OSSignpostID(log: Self.log)
        signpost = id
        os_signpost(.animationBegin, log: Self.log, name: "bread.morph", signpostID: id)
    }

    private func endSignpost() {
        guard let id = signpost else { return }
        signpost = nil
        os_signpost(.end, log: Self.log, name: "bread.morph", signpostID: id)
    }
}
