import UIKit
import QuartzCore

struct BreadMorphPhysics {
    let stiffness: Double
    let damping: Double
}

extension BreadMorphPhysics {
    init(response: Double, dampingRatio: Double) {
        stiffness = 0
        damping = 0
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

    func sample(at time: CFTimeInterval) -> (value: Double, velocity: Double) { (0, 0) }

    var settleTime: CFTimeInterval { 0 }

    func time(reaching value: Double) -> CFTimeInterval? { nil }
}

struct BreadMorphPose {
    let scale: CGFloat
    let origin: CGPoint
    let cropHeight: CGFloat
    let cornerRadius: CGFloat
    let shadowOpacity: Float
    let alpha: CGFloat

    static func at(_ p: Double, card: BreadMorphCard?, slot: CGSize) -> BreadMorphPose {
        BreadMorphPose(scale: 0, origin: .zero, cropHeight: 0, cornerRadius: 0, shadowOpacity: 0, alpha: 0)
    }
}

enum BreadMorphGeometry {
    static func progressVelocity(_ v: CGPoint, card: CGRect, slot: CGRect) -> Double { 0 }

    static func initialVelocity(_ v: Double, from p: Double, to target: Double) -> Double { 0 }

    static func rubberBand(_ x: Double, length: Double) -> Double { 0 }
}
