import AppKit
import HivemindKit

/// The app icon's six hexagons (web/public/icon.svg: the Human over two
/// brains over three workers) as a menu-bar template image. Template images
/// are drawn by alpha only, so the state shows as fill vs outline.
enum MenuBarIcon {
  /// Centres of the hexagons in the SVG's 512 grid, with the alpha each has there.
  private static let hexagons: [(x: CGFloat, y: CGFloat, alpha: CGFloat)] = [
    (256.0, 172.0, 1), (205.0, 260.4, 1), (307.0, 260.4, 1),
    (153.9, 348.8, 0.5), (256.0, 348.8, 0.5), (358.1, 348.8, 0.5),
  ]
  /// Circumradius of each (pointy-top) hexagon.
  private static let radius: CGFloat = 52
  /// The drawing's bounds in the SVG grid.
  private static let bounds = CGRect(x: 108.9, y: 120, width: 294.2, height: 280.8)

  @MainActor private static var cache: [ServerAppStatus.Kind: NSImage] = [:]

  @MainActor static func image(for kind: ServerAppStatus.Kind) -> NSImage {
    if let cached = cache[kind] { return cached }
    let size = NSSize(width: 18, height: 18)
    let image = NSImage(size: size, flipped: true) { rect in
      draw(kind, in: rect)
      return true
    }
    image.isTemplate = true
    image.accessibilityDescription = accessibilityLabel(for: kind)
    cache[kind] = image
    return image
  }

  static func accessibilityLabel(for kind: ServerAppStatus.Kind) -> String {
    switch kind {
    case .running: "Hivemind Server: running"
    case .busy: "Hivemind Server: working"
    case .stopped: "Hivemind Server: stopped"
    case .failed: "Hivemind Server: error"
    }
  }

  private static func draw(_ kind: ServerAppStatus.Kind, in rect: NSRect) {
    let inset: CGFloat = 1
    let scale = min((rect.width - 2 * inset) / bounds.width, (rect.height - 2 * inset) / bounds.height)
    let offsetX = rect.midX - bounds.midX * scale
    let offsetY = rect.midY - bounds.midY * scale
    for hexagon in hexagons {
      let path = NSBezierPath()
      for corner in 0..<6 {
        // Pointy-top: the first corner is straight up.
        let angle = CGFloat.pi / 3 * CGFloat(corner) - CGFloat.pi / 2
        let point = NSPoint(x: offsetX + (hexagon.x + radius * cos(angle)) * scale,
                            y: offsetY + (hexagon.y + radius * sin(angle)) * scale)
        corner == 0 ? path.move(to: point) : path.line(to: point)
      }
      path.close()
      switch kind {
      case .running:
        NSColor.black.withAlphaComponent(hexagon.alpha).setFill()
        path.fill()
      case .busy:
        NSColor.black.withAlphaComponent(hexagon.alpha * 0.5).setFill()
        path.fill()
      case .stopped, .failed:
        path.lineWidth = 1
        NSColor.black.withAlphaComponent(max(hexagon.alpha, 0.7)).setStroke()
        path.stroke()
      }
    }
    if kind == .failed {
      // A badge dot in the top-right corner, cut out of the drawing so it
      // reads as a separate mark.
      let badge = NSRect(x: rect.maxX - 6, y: rect.minY, width: 6, height: 6)
      NSGraphicsContext.current?.compositingOperation = .clear
      NSBezierPath(ovalIn: badge.insetBy(dx: -1.5, dy: -1.5)).fill()
      NSGraphicsContext.current?.compositingOperation = .sourceOver
      NSColor.black.setFill()
      NSBezierPath(ovalIn: badge).fill()
    }
  }
}
