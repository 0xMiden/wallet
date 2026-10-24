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
    private static let lock = NSLock()
    private static var cache: [Key: BreadMorphShadowImage] = [:]

    private struct Key: Hashable {
        let start: Int
        let radius: Int
        let pad: Int
        let scale: Int
    }

    static func pad(forWidth width: CGFloat) -> CGFloat {
        ceil((3 * blur + offset) * width / minCardWidth)
    }

    // The card's shadow in the page's own (unscaled) space: blur and offset are on-screen values at the card end, so
    // they grow with 1 / start. Rendered once per size class and stretched by contentsCenter as the height animates.
    static func render(start: CGFloat, cornerRadius: CGFloat, width: CGFloat, screenScale: CGFloat) -> BreadMorphShadowImage? {
        guard width > 0, start > 0 else { return nil }
        let step = (max(start, minCardWidth / width) * 100).rounded() / 100
        let radius = max(0, cornerRadius.rounded())
        let margin = pad(forWidth: width)
        let pixelsPerPoint = max(0.5, step * screenScale)
        let key = Key(start: Int((step * 100).rounded()), radius: Int(radius), pad: Int(margin), scale: Int((pixelsPerPoint * 10).rounded()))
        lock.lock()
        defer { lock.unlock() }
        if let hit = cache[key] { return hit }
        guard let made = draw(sigma: blur / step, offset: offset / step, radius: radius, pad: margin, pixelsPerPoint: pixelsPerPoint) else { return nil }
        if cache.count >= 12 { cache.removeAll() }
        cache[key] = made
        return made
    }

    private static func draw(sigma: CGFloat, offset: CGFloat, radius: CGFloat, pad: CGFloat, pixelsPerPoint rs: CGFloat) -> BreadMorphShadowImage? {
        let padPx = Int((pad * rs).rounded())
        let offsetPx = Int((offset * rs).rounded())
        let radiusPx = Int((radius * rs).rounded())
        let halfPx = max(radiusPx + offsetPx, Int((3 * sigma * rs).rounded(.up)))
        let side = 2 * padPx + 2 * halfPx + 1
        var mask = [UInt8](repeating: 0, count: side * side)
        let drawn = mask.withUnsafeMutableBytes { raw -> Bool in
            guard let context = CGContext(data: raw.baseAddress, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side,
                                          space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return false }
            let shape = CGRect(x: padPx, y: side - (padPx + offsetPx + 2 * halfPx + 1), width: 2 * halfPx + 1, height: 2 * halfPx + 1)
            context.setFillColor(gray: 1, alpha: 1)
            context.addPath(CGPath(roundedRect: shape, cornerWidth: CGFloat(radiusPx), cornerHeight: CGFloat(radiusPx), transform: nil))
            context.fillPath()
            return true
        }
        guard drawn else { return nil }
        let sigmaPx = Double(sigma * rs)
        var scratch = [UInt8](repeating: 0, count: side * side)
        for size in boxSizes(sigma: sigmaPx) {
            guard box(&mask, &scratch, side: side, width: size, height: 1), box(&scratch, &mask, side: side, width: 1, height: size) else { return nil }
        }
        var pixels = [UInt8](repeating: 0, count: side * side * 4)
        for index in 0..<(side * side) {
            let alpha = Int(mask[index])
            pixels[index * 4] = UInt8((15 * alpha + 127) / 255)
            pixels[index * 4 + 1] = UInt8((23 * alpha + 127) / 255)
            pixels[index * 4 + 2] = UInt8((42 * alpha + 127) / 255)
            pixels[index * 4 + 3] = UInt8(alpha)
        }
        guard let provider = CGDataProvider(data: Data(pixels) as CFData),
              let image = CGImage(width: side, height: side, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: side * 4,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
                                  provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent) else { return nil }
        let center = CGFloat(padPx + halfPx) / CGFloat(side)
        return BreadMorphShadowImage(image: image, contentsCenter: CGRect(x: center, y: center, width: 1 / CGFloat(side), height: 1 / CGFloat(side)),
                                     contentsScale: rs)
    }

    // Three box passes approximate a Gaussian of the given sigma (widths per Kovesi, rounded to odd).
    private static func boxSizes(sigma: Double) -> [Int] {
        let ideal = (12 * sigma * sigma / 3 + 1).squareRoot()
        var lower = Int(ideal.rounded(.down))
        if lower % 2 == 0 { lower -= 1 }
        lower = max(1, lower)
        let upper = lower + 2
        let l = Double(lower)
        let count = ((12 * sigma * sigma - 3 * l * l - 12 * l - 9) / (-4 * l - 4)).rounded()
        return (0..<3).map { Double($0) < count ? lower : upper }
    }

    private static func box(_ source: inout [UInt8], _ target: inout [UInt8], side: Int, width: Int, height: Int) -> Bool {
        source.withUnsafeMutableBytes { src in
            target.withUnsafeMutableBytes { dst in
                var from = vImage_Buffer(data: src.baseAddress, height: vImagePixelCount(side), width: vImagePixelCount(side), rowBytes: side)
                var to = vImage_Buffer(data: dst.baseAddress, height: vImagePixelCount(side), width: vImagePixelCount(side), rowBytes: side)
                return vImageBoxConvolve_Planar8(&from, &to, nil, 0, 0, UInt32(height), UInt32(width), 0, vImage_Flags(kvImageBackgroundColorFill))
                    == vImage_Error(kvImageNoError)
            }
        }
    }
}
