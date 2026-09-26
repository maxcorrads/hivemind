// Renders web/public/icon.svg into the iOS app icon set: one 1024x1024 PNG per
// appearance, full-bleed and square (iOS applies its own mask).
//   AppIcon.png         light (any): the artwork on its #16171b background, opaque
//                       (no alpha channel, as the App Store requires)
//   AppIcon-Dark.png    dark: the same artwork on a transparent background, so
//                       the system puts it on its dark backdrop
//   AppIcon-Tinted.png  tinted: the artwork's luminance in grayscale on black,
//                       which the system tints
// The SVG's rounded background rect is left out of the artwork; the light and
// tinted icons fill the whole square instead, so no corners or seams show.
// ios/build.sh runs this when icon.svg or this script changed since the icon
// set was last rendered (ios/scripts/render-icon.sha256); commit the result.
// Usage: swift render-icon.swift <icon.svg> <out.appiconset>
import AppKit

let args = CommandLine.arguments
guard args.count == 3 else {
  FileHandle.standardError.write(Data("usage: render-icon.swift <icon.svg> <out.appiconset>\n".utf8))
  exit(64)
}
func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data("render-icon: \(message)\n".utf8))
  exit(1)
}
guard let source = try? String(contentsOfFile: args[1], encoding: .utf8) else { fail("cannot read \(args[1])") }
let out = URL(fileURLWithPath: args[2], isDirectory: true)
try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

// The background: the SVG's first <rect>, whose fill is the icon's color.
guard let rect = source.range(of: "<rect[^>]*/>", options: .regularExpression) else { fail("no background <rect> in the SVG") }
let rectTag = String(source[rect])
guard let fillRange = rectTag.range(of: "fill=\"#[0-9a-fA-F]{6}\"", options: .regularExpression) else {
  fail("the background <rect> has no #rrggbb fill")
}
let hex = rectTag[fillRange].dropFirst(7).prefix(6)
guard let rgb = UInt32(hex, radix: 16) else { fail("bad fill \(hex)") }
let background = CGColor(
  srgbRed: CGFloat((rgb >> 16) & 0xff) / 255, green: CGFloat((rgb >> 8) & 0xff) / 255, blue: CGFloat(rgb & 0xff) / 255, alpha: 1)

var glyphsSource = source
glyphsSource.removeSubrange(rect)
guard let glyphs = NSImage(data: Data(glyphsSource.utf8)) else { fail("cannot draw the SVG without its background") }

let pixels = 1024
let bounds = CGRect(x: 0, y: 0, width: pixels, height: pixels)
let srgb = CGColorSpace(name: CGColorSpace.sRGB)!

func bitmap(_ space: CGColorSpace, _ alpha: CGImageAlphaInfo) -> CGContext {
  guard let context = CGContext(
    data: nil, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: alpha.rawValue)
  else { fail("cannot make a \(pixels)x\(pixels) bitmap") }
  return context
}

func write(_ context: CGContext, to name: String) {
  let url = out.appendingPathComponent(name)
  guard let image = context.makeImage(),
    let destination = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil)
  else { fail("cannot write \(url.path)") }
  CGImageDestinationAddImage(destination, image, nil)
  guard CGImageDestinationFinalize(destination) else { fail("cannot write \(url.path)") }
}

// The artwork alone, on transparent: the dark icon as it is, and the layer the others are made of.
let art = bitmap(srgb, .premultipliedLast)
art.clear(bounds)
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(cgContext: art, flipped: false)
NSGraphicsContext.current?.imageInterpolation = .high
glyphs.draw(in: bounds)
NSGraphicsContext.restoreGraphicsState()
guard let artwork = art.makeImage() else { fail("cannot draw the artwork") }

let light = bitmap(srgb, .noneSkipLast)
light.setFillColor(background)
light.fill(bounds)
light.draw(artwork, in: bounds)
write(light, to: "AppIcon.png")

write(art, to: "AppIcon-Dark.png")

// Color matched from sRGB into gray, the artwork becomes its luminance.
let tinted = bitmap(CGColorSpace(name: CGColorSpace.genericGrayGamma2_2)!, .none)
tinted.setFillColor(gray: 0, alpha: 1)
tinted.fill(bounds)
tinted.draw(artwork, in: bounds)
write(tinted, to: "AppIcon-Tinted.png")
