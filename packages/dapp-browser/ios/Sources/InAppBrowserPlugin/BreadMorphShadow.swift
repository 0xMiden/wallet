import UIKit
import Accelerate

struct BreadMorphShadowImage {
    let image: CGImage
    let contentsCenter: CGRect
    let contentsScale: CGFloat
}

enum BreadMorphShadow {
    static let blur: CGFloat = 14
    static let offset: CGFloat = 10
    static let minCardWidth: CGFloat = 80

    static func pad(forWidth width: CGFloat) -> CGFloat {
        ceil((3 * blur + offset) * width / minCardWidth)
    }

    static func render(start: CGFloat, cornerRadius: CGFloat, width: CGFloat, screenScale: CGFloat) -> BreadMorphShadowImage? {
        nil
    }
}
