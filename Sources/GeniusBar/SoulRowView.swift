import GeniusBarLib
import SwiftUI

/// One soul row: a select button (Dudle, display name, harness, presence,
/// unacked count, last wake) opening the read-only detail. Every soul is
/// selectable, including 'left' ones, which stay listed with a text state
/// and explanation. Presence and last wake are always text, never color
/// or motion alone; the button is keyboard-focusable with a VoiceOver
/// label.
struct SoulRowView: View {
    let node: SoulNode
    let depth: Int
    /// Set while the menu is hidden so Dudle blink timers stop.
    var isPaused: Bool = false
    var onSelect: (Soul) -> Void

    var body: some View {
        let soul = node.soul
        VStack(alignment: .leading, spacing: 2) {
            Button { onSelect(soul) } label: {
                HStack(spacing: 8) {
                    DudleView(
                        spec: deriveDudle(soulID: soul.agentId),
                        isPaused: isPaused,
                        label: "Avatar for \(soul.displayName)"
                    )
                    VStack(alignment: .leading, spacing: 1) {
                        HStack(spacing: 6) {
                            Text(soul.displayName).font(.body)
                            Text(soul.displayHarness)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        HStack(spacing: 6) {
                            presenceBadge(soul.presence)
                            Text("unacked \(soul.unacked)")
                                .font(.caption)
                                .foregroundStyle(soul.unacked > 0 ? .orange : .secondary)
                            Text("last wake \(soul.lastWake ?? "none")")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        if let note = soul.availabilityNote {
                            Text(note)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Show details for \(soul.displayName)")
            .accessibilityLabel(rowLabel(soul))
            .accessibilityHint("Shows details.")
            .padding(.leading, CGFloat(depth) * 16)
            ForEach(node.children) { child in
                SoulRowView(node: child, depth: depth + 1, isPaused: isPaused, onSelect: onSelect)
            }
        }
    }

    private func rowLabel(_ soul: Soul) -> String {
        var parts = [
            soul.displayName,
            soul.displayHarness,
            "presence \(soul.presence.rawValue)",
            "unacked \(soul.unacked)",
            "last wake \(soul.lastWake ?? "none")",
        ]
        if let note = soul.availabilityNote { parts.append(note) }
        return parts.joined(separator: ", ")
    }

    private func presenceBadge(_ presence: Presence) -> some View {
        Text(presence.rawValue)
            .font(.caption)
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .background(
                Capsule().fill(
                    presence == .joined ? Color.green.opacity(0.2)
                        : presence == .watching ? Color.blue.opacity(0.2)
                        : Color.gray.opacity(0.2)
                )
            )
    }
}
