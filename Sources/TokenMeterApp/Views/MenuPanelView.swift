import SwiftUI
import TokenMeterCore

struct MenuPanelView: View {
    @ObservedObject var model: TokenMeterViewModel
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        VStack(spacing: 0) {
            Button {
                openSettings()
            } label: {
                Label("프로바이더 등록/관리", systemImage: "plus.circle.fill")
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .font(.headline)
                    .padding(.vertical, 4)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("provider-management-button")
            .padding(16)

            Divider()

            if model.cards.isEmpty {
                ContentUnavailableView(
                    "등록된 프로바이더가 없습니다",
                    systemImage: "gauge.open.with.lines.needle.33percent",
                    description: Text("프로바이더를 등록하면 쿼터가 여기에 표시됩니다.")
                )
                .frame(minHeight: 260)
                .padding()
            } else {
                ScrollView {
                    LazyVStack(spacing: 12) {
                        ForEach(model.cards) { card in
                            providerCard(card)
                        }
                    }
                    .padding(16)
                }
            }
        }
        .frame(width: 420, height: 520, alignment: .top)
        .background(Color(nsColor: .windowBackgroundColor))
        .accessibilityIdentifier("token-meter-menu-panel")
    }

    private func providerCard(_ card: ProviderQuotaCard) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(card.provider.displayName)
                        .font(.headline)
                    Text(card.accountName)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if card.provider.pollingPolicy == .notPolled {
                    Button {
                        Task { await model.refresh(providerId: card.provider.id) }
                    } label: {
                        if model.refreshingProviderIDs.contains(card.provider.id) {
                            ProgressView()
                                .controlSize(.small)
                        } else {
                            Label("수동 새로고침", systemImage: "arrow.clockwise")
                        }
                    }
                    .buttonStyle(.borderless)
                    .disabled(model.refreshingProviderIDs.contains(card.provider.id))
                    .accessibilityIdentifier("provider-refresh-\(card.provider.id)")
                }
                freshnessLabel(card.freshness)
            }

            ForEach(card.rows, id: \.limitId) { row in
                QuotaRowView(row: row)
            }

            if card.showsNoStandaloneUsageAPI {
                Text("독립 사용량 API가 없습니다.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if let error = card.error {
                let errorMessage = model.errorText(error)
                Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .accessibilityLabel("오류. \(errorMessage)")
            }
        }
        .padding(14)
        .background(.background.secondary)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(Color.primary.opacity(0.08))
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(card.provider.displayName), \(card.accountName)")
    }

    @ViewBuilder
    private func freshnessLabel(_ freshness: QuotaFreshness?) -> some View {
        switch freshness {
        case .fresh:
            Label("최신", systemImage: "checkmark.circle.fill")
                .foregroundStyle(.green)
                .font(.caption.weight(.semibold))
        case .stale:
            Label("오래됨", systemImage: "arrow.clockwise.circle.fill")
                .foregroundStyle(.orange)
                .font(.caption.weight(.semibold))
        case .expired:
            Label("만료됨", systemImage: "xmark.circle.fill")
                .foregroundStyle(.red)
                .font(.caption.weight(.semibold))
        case nil:
            Label("알 수 없음", systemImage: "questionmark.circle")
                .foregroundStyle(.secondary)
                .font(.caption.weight(.semibold))
        }
    }
}
