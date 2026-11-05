import SwiftUI

/// The page is neutral; the coffee is in the details.
///
/// The ground is a plain light grey and the cards are white, so hierarchy comes
/// from type and spacing rather than from tinted paper and stacked shadows. The
/// coffee palette is still here — espresso for the one action that matters,
/// roast for links, latte for a small mark — but it is used in small doses on
/// top of a neutral page, never as a wash.
///
/// Colour is reserved for *state* — the phase of a bag — never for decoration.
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

    /// The page: a neutral light grey, not a warm white. Cards separate from it
    /// by value alone.
    static let paper = color(0xF7F7F7)
    /// Cards and sheets.
    static let card = color(0xFFFFFF)
    /// Recessed wells: chip backgrounds, sliders, the phase track's rail,
    /// secondary buttons.
    static let well = color(0xF0F0F0)
    static let wellDeep = color(0xE6E6E6)
    /// One hairline, everywhere.
    static let hairline = color(0xE3E3E3)

    // MARK: - Ink

    static let ink = color(0x2A211A)
    static let inkSoft = color(0x6F6A64)
    static let inkFaint = color(0x9E9A94)

    // MARK: - Coffee accents (extracted from the drink, kept quiet)
    //
    // espresso — the one primary action; roast — links and emphasis;
    // latte — small marks and the stock bar; cream — a light touch only;
    // moss — the peak state.

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
    // Almost none. Cards sit on the page with a hairline; only the focused bag
    // is allowed a soft, neutral shadow to lift it off the stack behind it.

    static let cardShadow = color(0x000000, 0.04)
    static let liftedShadow = color(0x000000, 0.08)
}

// MARK: - Type
//
// One family (the system face), a short ladder, and weight used to mark rank
// rather than to decorate. Nothing here is bold for emphasis alone.

enum TypeScale {
    /// The page's own name — the largest thing on any screen.
    static let display = Font.system(size: 30, weight: .semibold)
    /// The name of the bag the page is about.
    static let beanName = Font.system(size: 26, weight: .semibold)
    static let greeting = Font.system(size: 27, weight: .semibold)
    static let cardTitle = Font.system(size: 21, weight: .semibold)
    static let title = Font.system(size: 17, weight: .semibold)
    static let body = Font.system(size: 15)
    static let bodyMedium = Font.system(size: 15, weight: .medium)
    static let callout = Font.system(size: 13.5)
    static let caption = Font.system(size: 12)
    static let micro = Font.system(size: 11, weight: .medium)
    /// Section headers: small, quiet, generously tracked.
    static let section = Font.system(size: 11.5, weight: .semibold)
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
    static let radius: CGFloat = 16
    static let radiusSmall: CGFloat = 10
    static let cardPadding: CGFloat = 18
    static let gutter: CGFloat = 20
    static let sectionGap: CGFloat = 26
    static let tabBarInset: CGFloat = 12

    // MARK: - The bag stack

    /// How far the next card is pushed up behind the focused one.
    static let stackPeek: CGFloat = 13
    /// How much each card behind the focused one shrinks.
    static let stackDepthScale: CGFloat = 0.045
    /// Horizontal room the focused card keeps from the page gutter, so the deck
    /// reads as a deck rather than as a full-width page.
    static let stackInset: CGFloat = 6
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
    /// Flicking to the next bag in the stack.
    static let swipe = Animation.spring(response: 0.34, dampingFraction: 0.86)
    static let quick = Animation.easeOut(duration: 0.18)
}
