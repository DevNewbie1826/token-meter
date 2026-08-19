import SwiftUI
import TokenMeterCore

struct ProviderManagementView: View {
    @ObservedObject var model: TokenMeterViewModel
    @State private var sheet: ProviderSheet?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text("프로바이더 관리")
                    .font(.title2.bold())
                Text("OMP usage registry에서 동기화한 16개 프로바이더입니다. 모델 목록은 가져오지 않습니다.")
                    .foregroundStyle(.secondary)
            }

            List(model.catalog.providers, id: \.id) { provider in
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(provider.displayName)
                            .font(.body.weight(.medium))
                        Text(provider.id)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                    }

                    Spacer()
                    registrationActions(for: provider)
                }
                .padding(.vertical, 4)
                .accessibilityElement(children: .contain)
                .accessibilityLabel(
                    "\(provider.displayName), 모델 목록 없음"
                )
            }

            if let managementError = model.managementError {
                Label(managementError, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.red)
            }
        }
        .padding(20)
        .frame(width: 640, height: 600)
        .sheet(item: $sheet) { target in
            switch target {
            case .register(let provider, let method):
                ProviderLoginSheet(
                    provider: provider,
                    method: method.authMethod,
                    model: model
                )
            case .manage(let provider):
                ProviderManageSheet(provider: provider, model: model)
            }
        }
        .accessibilityIdentifier("provider-management-window")
    }

    @ViewBuilder
    private func registrationActions(for provider: ProviderCapability) -> some View {
        if model.isRegistered(provider.id) {
            Button("관리") { sheet = .manage(provider) }
                .accessibilityIdentifier("provider-action-\(provider.id)")
        } else {
            HStack(spacing: 6) {
                ForEach(model.registrationActions(for: provider.id)) { action in
                    Button(action.title) {
                        sheet = .register(provider, action.method)
                    }
                    .accessibilityIdentifier(action.accessibilityID)
                }
            }
        }
    }

}

private enum ProviderSheet: Identifiable {
    case register(ProviderCapability, ProviderRegistrationMethod)
    case manage(ProviderCapability)

    var id: String {
        switch self {
        case .register(let provider, let method):
            "register-\(provider.id)-\(method.id)"
        case .manage(let provider):
            "manage-\(provider.id)"
        }
    }
}

private struct ProviderManageSheet: View {
    let provider: ProviderCapability
    @ObservedObject var model: TokenMeterViewModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("\(provider.displayName) 관리")
                .font(.title3.bold())
            if let card = model.card(for: provider.id) {
                Text(card.accountName)
                    .foregroundStyle(.secondary)
                if card.showsNoStandaloneUsageAPI {
                    Text("독립 사용량 API가 없습니다.")
                        .foregroundStyle(.secondary)
                } else {
                    Text("등록된 자격 증명으로 사용량을 조회합니다.")
                        .foregroundStyle(.secondary)
                }
            }

            HStack {
                Spacer()
                Button("취소") { dismiss() }
                Button("제거", role: .destructive) {
                    model.remove(providerId: provider.id)
                    if model.managementError == nil { dismiss() }
                }
                .accessibilityIdentifier("provider-remove-\(provider.id)")
            }
        }
        .padding(20)
        .frame(width: 420)
    }
}
