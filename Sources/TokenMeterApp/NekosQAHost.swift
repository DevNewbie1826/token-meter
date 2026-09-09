#if TOKEN_METER_QA
import Foundation
import SwiftUI
import TokenMeterCore

/// A QA-only host of the production management and quota views. No accounts,
/// credentials, reports, or rows are seeded. Registration uses BridgeClient,
/// auth.json, the real adapter/parser, and the real Swift decoder/projector.
struct NekosQAHost: View {
    @ObservedObject var model: TokenMeterViewModel
    @State private var refreshWasActive = false
    @State private var completedRefreshes = 0

    static func bridge(environment: [String: String]) -> BridgeClient? {
        guard environment["TOKEN_METER_QA_FIXTURE"] == "1" else { return nil }
        let executable: String
        if let override = environment["TOKEN_METER_QA_NEKOS_BRIDGE"] {
            executable = override
        } else if environment["TOKEN_METER_QA_SCENARIO"] != nil {
            executable = Bundle.main.bundleURL
                .appendingPathComponent("Contents/Resources/token-meter-qa-bridge").path
        } else { return nil }
        return BridgeClient(executableURL: URL(fileURLWithPath: executable))
    }

    static func announceReady(environment: [String: String]) {
        guard let session = environment["TOKEN_METER_QA_SESSION"] else { return }
        DistributedNotificationCenter.default().postNotificationName(
            Notification.Name("dev.herdr.token-meter.qa.ready.\(session)"), object: nil,
            userInfo: ["pid": ProcessInfo.processInfo.processIdentifier], deliverImmediately: true
        )
    }

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            ProviderManagementView(model: model)
            Divider()
            VStack {
                Text("Offline provider QA - not live upstream; management progress is simulated")
                MenuPanelView(model: model)
                Text(String(completedRefreshes))
                    .accessibilityIdentifier("nekos-qa-refresh-count")
            }
        }
        .onReceive(model.$refreshingProviderIDs) { providers in
            let active = !providers.isEmpty
            if refreshWasActive && !active { completedRefreshes += 1 }
            refreshWasActive = active
        }
    }
}
#endif
