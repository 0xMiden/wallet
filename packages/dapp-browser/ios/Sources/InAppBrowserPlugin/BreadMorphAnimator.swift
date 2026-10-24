import UIKit
import QuartzCore

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

final class BreadMorphAnimator {
    private weak var container: BreadMorphContainerViewController?
    let now: () -> CFTimeInterval
    private let reduceMotion: () -> Bool
    private(set) var target: Double?
    private(set) var spring: BreadMorphSpring?
    private(set) var card: BreadMorphCard?
    private(set) var link: CADisplayLink?
    var companions: [CALayer] = []
    var boosting: Bool { link != nil }

    init(container: BreadMorphContainerViewController, now: @escaping () -> CFTimeInterval = CACurrentMediaTime,
         reduceMotion: @escaping () -> Bool = { UIAccessibility.isReduceMotionEnabled }) {
        self.container = container
        self.now = now
        self.reduceMotion = reduceMotion
    }

    func boost() {}

    func releaseBoost() {}

    func progress() -> Double { 1 }

    func velocity() -> Double { 0 }

    func run(to target: Double, card: BreadMorphCard?, velocity: Double, physics: BreadMorphPhysics, onSettle: @escaping () -> Void) {}

    func hold(_ p: Double, card: BreadMorphCard?) {}

    func freeze() -> Double { progress() }

    func track(_ p: Double) {}

    func finish() -> Double { 1 }

    func reset() {}
}
