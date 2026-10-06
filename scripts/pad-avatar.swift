import Foundation
import CoreGraphics
import ImageIO

// Match the original border color and blend the outer 8%, preserving bright artwork.
let arguments = CommandLine.arguments
guard arguments.count == 3 else { fatalError("Usage: pad-avatar.swift input.png output.png") }
let inputURL = URL(fileURLWithPath: arguments[1])
let outputURL = URL(fileURLWithPath: arguments[2])
guard let source = CGImageSourceCreateWithURL(inputURL as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    fatalError("Unable to read avatar PNG")
}
let width = image.width
let height = image.height
let size = Int(ceil(Double(max(width, height)) / 0.6))
let offsetX = (size - width) / 2
let offsetY = (size - height) / 2
let feather = max(1.0, Double(min(width, height)) * 0.08)
let colorSpace = CGColorSpaceCreateDeviceRGB()
let bitmapInfo = CGImageAlphaInfo.premultipliedLast.rawValue
var original = [UInt8](repeating: 0, count: width * height * 4)
original.withUnsafeMutableBytes { bytes in
    guard let context = CGContext(data: bytes.baseAddress, width: width, height: height,
        bitsPerComponent: 8, bytesPerRow: width * 4, space: colorSpace, bitmapInfo: bitmapInfo) else {
        fatalError("Unable to decode avatar pixels")
    }
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
}
// Median edge colors exclude the blue glow and occasional bright pixels.
var edgeColors = [[UInt8](), [UInt8](), [UInt8]()]
for y in 0..<height {
    for x in 0..<width where min(x, width - 1 - x, y, height - 1 - y) < 4 {
        let pixel = (y * width + x) * 4
        for channel in 0..<3 { edgeColors[channel].append(original[pixel + channel]) }
    }
}
let background = edgeColors.map { values -> Double in
    let sorted = values.sorted()
    return Double(sorted[sorted.count / 2])
}
var padded = [UInt8](repeating: 255, count: size * size * 4)
for y in 0..<size {
    for x in 0..<size {
        let destination = (y * size + x) * 4
        let sx = x - offsetX
        let sy = y - offsetY
        if sx >= 0 && sx < width && sy >= 0 && sy < height {
            let pixel = (sy * width + sx) * 4
            let distance = Double(min(sx, width - 1 - sx, sy, height - 1 - sy))
            let t = min(1.0, distance / feather)
            let edgeBlend = t * t * (3.0 - 2.0 * t)
            let brightness = Double(max(original[pixel], original[pixel + 1], original[pixel + 2])) / 255.0
            let preserveArtwork = min(1.0, max(0.0, (brightness - 0.08) / 0.12))
            let blend = max(edgeBlend, preserveArtwork)
            let alpha = Double(original[pixel + 3]) / 255.0
            for channel in 0..<3 {
                let value = Double(original[pixel + channel]) * blend
                    + background[channel] * (1.0 - alpha * blend)
                padded[destination + channel] = UInt8(value.rounded())
            }
        } else {
            for channel in 0..<3 { padded[destination + channel] = UInt8(background[channel]) }
        }
    }
}
padded.withUnsafeMutableBytes { bytes in
    guard let context = CGContext(data: bytes.baseAddress, width: size, height: size,
        bitsPerComponent: 8, bytesPerRow: size * 4, space: colorSpace, bitmapInfo: bitmapInfo),
        let result = context.makeImage(),
        let destination = CGImageDestinationCreateWithURL(outputURL as CFURL, "public.png" as CFString, 1, nil) else {
        fatalError("Unable to create padded PNG")
    }
    CGImageDestinationAddImage(destination, result, nil)
    guard CGImageDestinationFinalize(destination) else { fatalError("Unable to save padded PNG") }
}
print("Saved \(size)x\(size) avatar with a \(Int(feather))-pixel feathered edge, matching background \(background)")
