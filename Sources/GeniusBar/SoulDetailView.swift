import GeniusBarLib
import SwiftUI

/// Read-only detail panel for one soul. Display only: no actions, no chat
/// (chat comes in R3). Presence and last wake are always text; missing
/// name/harness use the same roster fallbacks as the list. Keyboard
/// reachable through the sheet's default focus.
struct SoulDetailView: View {
    let soul: Soul

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                DudleView(
                    spec: deriveDudle(soulID: soul.agentId),
                    diameter: 56,
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
                    Text(soul.parent ?? "none").textSelection(.enabled)
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
        }
        .padding()
        .frame(minWidth: 300)
    }
}
