import SwiftUI

/// BrewPhase lives on paper, not on a counter.
///
/// The sibling app (BrewStill) is a dark, lit room. BrewPhase is the notebook you
/// keep next to it: warm white ground, near-white cards, and one espresso-brown
/// accent used sparingly. Colour is reserved for *state* — the phase of a bag —
/// never for decoration.
enum Palette {

    // MARK: - Construction

    static func color(_ hex: UInt32, _ alpha: Double = 1) -> Color {
        Color(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: alpha
        )
    }

    // MARK: - Ground

    /// The page. Very light warm beige — deliberately not pure white, so cards
    /// can separate from it without a border.
    static let paper = color(0xFAF7F2)
    /// Cards and sheets.
    static let card = color(0xFFFFFF)
    /// Recessed wells: chip backgrounds, sliders, the phase track's rail.
    static let well = color(0xF3EDE4)
    static let wellDeep = color(0xEAE1D5)
    /// One hairline, everywhere.
    static let hairline = color(0xE8E0D4)

    // MARK: - Ink

    static let ink = color(0x2A211A)
    static let inkSoft = color(0x6E6257)
    static let inkFaint = color(0xA99C8D)

    // MARK: - Coffee accents (extracted from the drink, kept quiet)

    static let espresso = color(0x3B2A1E)
    static let roast = color(0x8A5A34)
    static let latte = color(0xC9A27A)
    static let cream = color(0xEFE3D2)
    static let moss = color(0x6E8A5F)

    // MARK: - Phase colours
    //
    // Small doses only: a dot, a 7pt bar segment, a chip's text. Never a filled
    // card background.

    static let resting = color(0x9A8E80)
    static let opening = color(0xC08A45)
    static let peak = color(0x6E8A5F)
    static let declining = color(0xB4705A)
    static let priority = color(0xA8503F)

    static func tint(_ phase: BeanPhase) -> Color {
        switch phase {
        case .resting: return resting
        case .opening: return opening
        case .peak: return peak
        case .declining: return declining
        }
    }

    static func tint(_ tier: PriorityTier) -> Color {
        switch tier {
        case .low: return inkFaint
        case .normal: return latte
        case .high: return roast
        case .urgent: return priority
        }
    }

    // MARK: - Elevation
    //
    // One soft shadow for cards, one deeper one for the Today card. Both are
    // warm-tinted rather than neutral black, which is what keeps the page from
    // looking grey.

    static let cardShadow = Color(red: 0.36, green: 0.26, blue: 0.16).opacity(0.07)
    static let liftedShadow = Color(red: 0.36, green: 0.26, blue: 0.16).opacity(0.11)
}

// MARK: - Type

enum TypeScale {
    static let greeting = Font.system(size: 27, weight: .semibold)
    static let cardTitle = Font.system(size: 21, weight: .semibold)
    static let title = Font.system(size: 17, weight: .semibold)
    static let body = Font.system(size: 15)
    static let bodyMedium = Font.system(size: 15, weight: .medium)
    static let callout = Font.system(size: 13.5)
    static let caption = Font.system(size: 12)
    static let micro = Font.system(size: 11, weight: .medium)
    /// Section headers: small, uppercase, generously tracked.
    static let section = Font.system(size: 12, weight: .semibold)
    /// The one line an action page leads with — the next-cup suggestion on the
    /// result screen.
    static let emphasis = Font.system(size: 23, weight: .semibold)
    /// Numbers that sit in columns should not jitter.
    static let numeral = Font.system(size: 15, weight: .medium).monospacedDigit()
    static let bigNumeral = Font.system(size: 24, weight: .semibold).monospacedDigit()
    /// The app's small piece of ceremony.
    static let signature = Font.system(size: 12.5, weight: .light, design: .serif)
}

enum Metric {
    static let radius: CGFloat = 20
    static let radiusSmall: CGFloat = 12
    static let cardPadding: CGFloat = 18
    static let gutter: CGFloat = 20
    static let sectionGap: CGFloat = 26
    static let tabBarInset: CGFloat = 12
}

// MARK: - Motion
//
// Native SwiftUI springs only (PRD §28). No Lottie, no third-party animation.

enum Motion {
    /// Opening a detail page, adding a bean.
    static let settle = Animation.spring(response: 0.42, dampingFraction: 0.86)
    /// A phase changing, a star filling, a chip appearing.
    static let pop = Animation.spring(response: 0.30, dampingFraction: 0.70)
    /// Anything that accompanies a list reorder.
    static let glide = Animation.spring(response: 0.5, dampingFraction: 0.9)
    static let quick = Animation.easeOut(duration: 0.18)
}
