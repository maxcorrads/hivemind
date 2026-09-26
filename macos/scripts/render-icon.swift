// Renders web/public/icon.svg into a macOS .iconset folder (every size
// iconutil expects). The SVG is full-bleed, so it is drawn inside the
// 824/1024 content square of Apple's icon grid to sit with other Dock icons.
// Usage: swift render-icon.swift <icon.svg> <out.iconset>
import AppKit

let args = CommandLine.arguments
guard args.count == 3 else {
  FileHandle.standardError.write(Data("usage: render-icon.swift <icon.svg> <out.iconset>\n".utf8))
  exit(64)
}
guard let svg = NSImage(contentsOf: URL(fileURLWithPath: args[1])) else {
  FileHandle.standardError.write(Data("render-icon: cannot read \(args[1])\n".utf8))
  exit(1)
}
let out = URL(fileURLWithPath: args[2], isDirectory: true)
try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

for points in [16, 32, 128, 256, 512] {
  for scale in [1, 2] {
    let pixels = points * scale
    guard let bitmap = NSBitmapImageRep(
      bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4,
      hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)
    else { exit(1) }
    bitmap.size = NSSize(width: pixels, height: pixels)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    NSGraphicsContext.current?.imageInterpolation = .high
    let side = Double(pixels) * 824 / 1024
    let inset = (Double(pixels) - side) / 2
    svg.draw(in: NSRect(x: inset, y: inset, width: side, height: side))
    NSGraphicsContext.restoreGraphicsState()
    let name = scale == 1 ? "icon_\(points)x\(points).png" : "icon_\(points)x\(points)@2x.png"
    guard let png = bitmap.representation(using: .png, properties: [:]) else { exit(1) }
    try png.write(to: out.appendingPathComponent(name))
  }
}
