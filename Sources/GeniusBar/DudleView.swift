import GeniusBarLib
import SwiftUI

/// The Dudle: a round, spongy character with big solid-black eyes. All
/// traits come from the deterministic soul-ID derivation. The idle
/// animation is a periodic blink; with Reduce Motion on — or while the
/// menu is hidden (isPaused) — the timeline stops and the eyes stay open
/// and still.
struct DudleView: View {
    let spec: DudleSpec
    var diameter: CGFloat = 28
    /// Set while the menu is hidden so the blink timer stops.
    var isPaused: Bool = false
    /// VoiceOver label for the avatar; nil keeps it decorative (hidden)
    /// inside an already-labelled row.
    var label: String? = nil

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var animates: Bool { !reduceMotion && !isPaused }

    var body: some View {
        Group {
            if let label {
                avatar.accessibilityLabel(label).accessibilityAddTraits(.isImage)
            } else {
                avatar.accessibilityHidden(true)
            }
        }
        .frame(width: diameter, height: diameter)
    }

    private var avatar: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 20, paused: !animates)) { context in
            let scale = animates
                ? blinkEyeScale(at: context.date.timeIntervalSinceReferenceDate) : 1
            dudle(blinkScale: scale)
        }
    }

    private func dudle(blinkScale: Double) -> some View {
        let r = diameter / 2 * CGFloat(spec.sizeWobble)
        let eyeR = r * 0.38 * CGFloat(spec.eyeScale)
        let eyeY = -r * 0.12
        let eyeX = r * CGFloat(spec.eyeSpacing) / 2
        return ZStack {
            // Spongy body: squished circle with soft shading.
            Ellipse()
                .fill(
                    RadialGradient(
                        colors: [
                            Color(hue: spec.bodyHue, saturation: 0.55, brightness: 0.98),
                            Color(hue: spec.bodyHue, saturation: 0.65, brightness: 0.82),
                        ],
                        center: .center,
                        startRadius: r * 0.1,
                        endRadius: r
                    )
                )
                .frame(width: r * 2 * CGFloat(spec.squish), height: r * 2 / CGFloat(spec.squish))
            // Specular highlight.
            Ellipse()
                .fill(.white.opacity(0.55))
                .frame(width: r * 0.45, height: r * 0.28)
                .offset(
                    x: cos(CGFloat(spec.highlightAngle)) * r * 0.35,
                    y: sin(CGFloat(spec.highlightAngle)) * r * 0.35
                )
            // Blush cheeks.
            if spec.blush > 0.35 {
                HStack(spacing: eyeX) {
                    Ellipse().fill(.pink.opacity(0.5 * spec.blush))
                        .frame(width: eyeR * 0.9, height: eyeR * 0.6)
                    Ellipse().fill(.pink.opacity(0.5 * spec.blush))
                        .frame(width: eyeR * 0.9, height: eyeR * 0.6)
                }
                .offset(y: eyeY + eyeR * 1.1)
            }
            // Big solid-black eyes; the blink scales them shut briefly.
            HStack(spacing: eyeX * 0.6) {
                eye(radius: eyeR, blinkScale: blinkScale)
                eye(radius: eyeR, blinkScale: blinkScale)
            }
            .offset(y: eyeY)
        }
        .frame(width: diameter, height: diameter)
    }

    private func eye(radius: CGFloat, blinkScale: Double) -> some View {
        Circle()
            .fill(.black)
            .frame(width: radius * 2, height: radius * 2)
            .scaleEffect(x: 1, y: blinkScale, anchor: .center)
    }
}
