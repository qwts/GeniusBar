import SwiftUI

/// Read-only detail panel for one soul. Display only: no actions, no chat
/// (chat comes in R3). Presence and last wake are always text; missing
/// name/harness use the same roster fallbacks as the list. Keyboard
/// reachable through the sheet's default focus, plus an explicit Done
/// button (Escape still works via .cancelAction).
public struct SoulDetailView: View {
    public let soul: Soul
    /// Set for static `--snapshot` renders so the blink timer stops and the
    /// eyes stay open. Interactive use keeps the default false.
    public var isPaused: Bool = false
    /// Full roster for resolving the parent soul's display name. Empty
    /// (the default) falls back to the raw parent agent ID.
    public var roster: [Soul] = []
    /// Static rendering for `--snapshot-detail`: the Done control shows as
    /// inert text, like Refresh in the menu content. Interactive use keeps
    /// the default false.
    public var isStatic: Bool = false

    @Environment(\.dismiss) private var dismiss

    public init(soul: Soul, isPaused: Bool = false, roster: [Soul] = [], isStatic: Bool = false) {
        self.soul = soul
        self.isPaused = isPaused
        self.roster = roster
        self.isStatic = isStatic
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                DudleView(
                    spec: deriveDudle(soulID: soul.agentId),
                    diameter: 56,
                    isPaused: isPaused,
                    label: "Avatar for \(soul.displayName)"
                )
                VStack(alignment: .leading) {
                    Text(soul.displayName).font(.headline)
                    Text(soul.agentId).font(.caption).foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(soul.displayName), \(soul.agentId)")
            if let note = soul.availabilityNote {
                Text(note)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 4) {
                GridRow { Text("Account").foregroundStyle(.secondary); Text(soul.account) }
                GridRow {
                    Text("Harness").foregroundStyle(.secondary)
                    Text(soul.displayHarness)
                }
                GridRow {
                    Text("Presence").foregroundStyle(.secondary)
                    Text(soul.presence.rawValue)
                }
                GridRow {
                    Text("Parent").foregroundStyle(.secondary)
                    parentCell
                }
                GridRow {
                    Text("Unacked").foregroundStyle(.secondary)
                    Text("\(soul.unacked)")
                }
                GridRow {
                    Text("Last wake").foregroundStyle(.secondary)
                    Text(soul.lastWake ?? "none")
                }
            }
            .font(.body)
            HStack {
                Spacer()
                if isStatic {
                    // Static snapshots cannot be clicked, and the button
                    // bezel draws a broken placeholder with no window, so
                    // show the same label as inert text (like Refresh).
                    Text("Done")
                        .foregroundStyle(.blue)
                } else {
                    Button("Done") { dismiss() }
                        .keyboardShortcut(.cancelAction)
                }
            }
        }
        .padding()
        .frame(minWidth: 300)
    }

    @ViewBuilder
    private var parentCell: some View {
        if let parentId = soul.parent {
            if let name = parentDisplayName(for: soul, in: roster) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(name)
                    Text(parentId)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
            } else {
                Text(parentId).textSelection(.enabled)
            }
        } else {
            Text("none")
        }
    }
}
