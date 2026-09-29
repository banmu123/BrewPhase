// Renders the BrewPhase app icon: warm paper ground, one restrained accent,
// a phase arc with "today" marked on it. Matches the in-app PhaseTrack motif.
//
//   swift Tools/make_icon.swift <out.png>
import AppKit
import CoreGraphics
import Foundation

let side = 1024.0
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon-1024.png"

func c(_ hex: UInt32, _ a: Double = 1) -> CGColor {
    CGColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: CGFloat(a))
}

let cs = CGColorSpace(name: CGColorSpace.sRGB)!
guard let ctx = CGContext(data: nil, width: Int(side), height: Int(side),
                          bitsPerComponent: 8, bytesPerRow: 0, space: cs,
                          bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else {
    fatalError("no context")
}

let paper = c(0xFAF7F2), cardTop = c(0xFFFDFA), roast = c(0x8A5A34)
let cream = c(0xEFE3D2), ink = c(0x2A211A), moss = c(0x6E8A5F)

// Ground: soft vertical warm-paper gradient (opaque, iOS requires no alpha).
let bg = CGGradient(colorsSpace: cs, colors: [cardTop, paper] as CFArray, locations: [0, 1])!
ctx.drawLinearGradient(bg, start: CGPoint(x: 0, y: side), end: CGPoint(x: 0, y: 0), options: [])

// The phase track: a full ring, with the "window" arc drawn on top of it.
let center = CGPoint(x: side / 2, y: side / 2)
let radius = side * 0.275
let lw = side * 0.075

ctx.setLineCap(.round)

// Track (resting + declining territory) — quiet, warm grey.
ctx.setStrokeColor(c(0xD9CFC1))
ctx.setLineWidth(lw)
ctx.addArc(center: center, radius: radius, startAngle: 0, endAngle: .pi * 2, clockwise: false)
ctx.strokePath()

// The good window — roast brown, a third of the ring on the left, so it reads as
// a distinct window rather than "half the circle is brown".
let start = Double.pi * 0.78
let end = Double.pi * 1.44
ctx.setStrokeColor(roast)
ctx.addArc(center: center, radius: radius, startAngle: start, endAngle: end, clockwise: false)
ctx.strokePath()

// "Today" — a filled dot sitting on the window, in the peak green.
let dotAngle = Double.pi * 1.11
let dotR = lw * 0.52
let dot = CGPoint(x: center.x + CGFloat(cos(dotAngle)) * radius,
                  y: center.y + CGFloat(sin(dotAngle)) * radius)
ctx.setFillColor(cardTop)
ctx.fillEllipse(in: CGRect(x: dot.x - dotR * 1.75, y: dot.y - dotR * 1.75,
                           width: dotR * 3.5, height: dotR * 3.5))
ctx.setFillColor(moss)
ctx.fillEllipse(in: CGRect(x: dot.x - dotR, y: dot.y - dotR, width: dotR * 2, height: dotR * 2))

// Inside: a coffee bean, split by its crease. Drawn as a filled ellipse with the
// crease carved out, so it reads at 40pt and stays quiet at 1024pt.
let beanW = side * 0.30, beanH = side * 0.215
ctx.saveGState()
let beanRect = CGRect(x: center.x - beanW / 2, y: center.y - beanH / 2, width: beanW, height: beanH)
ctx.addEllipse(in: beanRect)
ctx.clip()
ctx.setFillColor(ink)
ctx.fill(beanRect)
// crease: an S-curve cut, drawn in paper colour
ctx.setStrokeColor(paper)
ctx.setLineWidth(beanH * 0.14)
ctx.setLineCap(.round)
ctx.move(to: CGPoint(x: center.x - beanW * 0.02, y: beanRect.minY - 2))
ctx.addCurve(to: CGPoint(x: center.x + beanW * 0.02, y: beanRect.maxY + 2),
             control1: CGPoint(x: center.x + beanW * 0.30, y: center.y - beanH * 0.10),
             control2: CGPoint(x: center.x - beanW * 0.30, y: center.y + beanH * 0.10))
ctx.strokePath()
ctx.restoreGState()

// A hint of warm light top-left, like the sibling app's key light.
let gloss = CGGradient(colorsSpace: cs, colors: [c(0xFFFFFF, 0.55), c(0xFFFFFF, 0)] as CFArray,
                       locations: [0, 1])!
ctx.saveGState()
ctx.addEllipse(in: CGRect(x: side * 0.06, y: side * 0.62, width: side * 0.62, height: side * 0.42))
ctx.clip()
ctx.drawRadialGradient(gloss,
                       startCenter: CGPoint(x: side * 0.26, y: side * 0.86), startRadius: 0,
                       endCenter: CGPoint(x: side * 0.26, y: side * 0.86), endRadius: side * 0.45,
                       options: [])
ctx.restoreGState()

_ = cream

guard let image = ctx.makeImage() else { fatalError("no image") }
let rep = NSBitmapImageRep(cgImage: image)
guard let png = rep.representation(using: .png, properties: [:]) else { fatalError("no png") }
try png.write(to: URL(fileURLWithPath: out))
print("wrote \(out) (\(Int(side))x\(Int(side)))")
