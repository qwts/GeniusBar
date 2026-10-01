import SwiftUI

/// Menubar content: broker health header above the nested soul listing.
/// The roster is the whole census, keyed by account/agent ID. While the
/// broker is unreachable the last successful census stays on screen under
/// a "Last known" label. Dudle blink timers stop while the menu is hidden.
public struct ContentView: View {
    @ObservedObject var state: AppState
    @State private var selected: Soul?
    @State private var menuVisible = true
    /// Static rendering for `--snapshot` and `--window` probes: Dudle blink
    /// timers stay stopped (eyes open, stable frame) and appearing never
    /// starts the poll loop. Interactive use keeps the default false.
    public var isStatic: Bool = false

    public init(state: AppState, isStatic: Bool = false) {
        self.state = state
        self.isStatic = isStatic
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            healthHeader
            if state.isLoadingCredential {
                Text("Loading credential…")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            } else if state.isUnpaired {
                Text(unpairedMessage)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            Divider()
            if state.forest.isEmpty {
                Text(state.brokerUnreachable ? "No successful census yet." : "No souls on this machine.")
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 8)
            } else if isStatic {
                // A PNG cannot scroll, and a ScrollView measures empty
                // offscreen; list the same rows directly.
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(state.forest) { node in
                        SoulRowView(node: node, depth: 0, isPaused: true) { selected = $0 }
                    }
                }
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(state.forest) { node in
                            SoulRowView(node: node, depth: 0, isPaused: !menuVisible) { selected = $0 }
                        }
                    }
                }
            }
            Divider()
            HStack {
                if state.brokerUnreachable, let refresh = state.lastRefresh {
                    Text("Last known · \(refresh.formatted(date: .omitted, time: .standard))")
                        .font(.caption).foregroundStyle(.secondary)
                } else if let error = state.lastError {
                    Text(error).font(.caption).foregroundStyle(.red)
                        .lineLimit(2)
                } else if let refresh = state.lastRefresh {
                    Text("Updated \(refresh.formatted(date: .omitted, time: .standard))")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if isStatic {
                    // Static snapshots cannot be clicked, and the link
                    // bezel draws a broken placeholder with no window, so
                    // show the same label as inert text.
                    Text("Refresh")
                        .foregroundStyle(.blue)
                } else {
                    Button("Refresh") { state.refreshNow() }
                        .buttonStyle(.link)
                }
            }
        }
        .padding(12)
        .frame(width: 360)
        .sheet(item: $selected) { soul in
            SoulDetailView(soul: soul)
        }
        .onAppear {
            menuVisible = true
            if !isStatic { state.start() }
        }
        .onDisappear { menuVisible = false }
    }

    @ViewBuilder
    private var healthHeader: some View {
        if state.brokerUnreachable {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Circle().fill(.red).frame(width: 8, height: 8)
                    Text("Broker unreachable").font(.headline)
                }
                if let refresh = state.lastRefresh {
                    Text("Last known · \(refresh.formatted(date: .omitted, time: .standard))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    Text("No successful census yet.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel(brokerUnreachableLabel)
        } else if let health = state.health {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Circle().fill(.green).frame(width: 8, height: 8)
                    Text("Broker healthy").font(.headline)
                }
                Text(
                    "uptime \(formatUptime(health.uptimeMs)) · log \(health.eventLogBytes) B · "
                        + "accounts \(health.pairings.accounts) · principals \(health.pairings.principals) · "
                        + "watches \(health.watches)"
                )
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .combine)
        } else {
            HStack(spacing: 6) {
                Circle().fill(.gray).frame(width: 8, height: 8)
                Text("Broker status unknown").font(.headline)
            }
            .accessibilityElement(children: .combine)
        }
    }

    private var brokerUnreachableLabel: String {
        if let refresh = state.lastRefresh {
            "Broker unreachable. Last known census \(refresh.formatted(date: .omitted, time: .standard))."
        } else {
            "Broker unreachable. No successful census yet."
        }
    }

    private func formatUptime(_ ms: Int) -> String {
        let s = ms / 1000
        if s < 60 { return "\(s)s" }
        if s < 3600 { return "\(s / 60)m" }
        return "\(s / 3600)h \((s % 3600) / 60)m"
    }
}
