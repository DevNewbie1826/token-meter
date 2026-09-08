import SwiftUI
import TokenMeterCore

extension QuotaRow {
    /// A limit without a resolved fraction must not render a fabricated
    /// zero-width bar; it stays visibly unknown.
    var showsProgressBar: Bool { fraction != nil }
}

struct QuotaRowView: View {
    let row: QuotaRow

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack {
                Text(windowLabel)
                    .font(.subheadline.weight(.medium))
                Spacer()
                Text(amountLabel)
                    .font(.subheadline.monospacedDigit())
            }

            if row.showsProgressBar {
                GeometryReader { geometry in
                    ZStack(alignment: .leading) {
                        Capsule()
                            .fill(Color.primary.opacity(0.10))
                        Capsule()
                            .fill(severityColor)
                            .frame(width: geometry.size.width * clampedFraction)
                    }
                }
                .frame(height: 8)
            }

            HStack {
                Text(productLabel)
                Spacer()
                if let resetLabel {
                    Text(resetLabel)
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            "\(windowLabel), \(amountLabel), \(severityLabel), \(resetLabel ?? "리셋 정보 없음")"
        )
    }

    private var clampedFraction: Double {
        min(max(row.fraction ?? 0, 0), 1)
    }

    private var windowLabel: String {
        // A nonempty provider-provided label wins over the derived window
        // text; absent/empty keeps the existing windowSeconds/limitId
        // fallback untouched.
        if let label = row.label, !label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return label
        }
        return switch row.windowSeconds {
        case 18_000:
            "5시간"
        case 604_800:
            "7일"
        case 2_592_000:
            "월간"
        case let seconds?:
            "\(seconds / 3_600)시간"
        case nil:
            row.limitId
        }
    }

    private var amountLabel: String {
        if let fraction = row.fraction {
            return "\(String(format: "%.0f", (fraction * 100).rounded()))% 사용"
        }
        if let used = row.used, let limit = row.limit {
            return "\(formatted(used)) / \(formatted(limit)) \(unitLabel)"
        }
        if let used = row.used {
            return "\(formatted(used)) \(unitLabel) 사용"
        }
        return "사용량 알 수 없음"
    }

    private var resetLabel: String? {
        guard let milliseconds = row.resetsInMs, milliseconds > 0 else {
            return nil
        }
        let hours = milliseconds / 3_600_000
        if hours >= 48 {
            return "\(hours / 24)일 후 리셋"
        }
        if hours > 0 {
            return "\(hours)시간 후 리셋"
        }
        return "\(max(milliseconds / 60_000, 1))분 후 리셋"
    }

    private var severityColor: Color {
        switch row.severity {
        case .ok:
            .blue
        case .warning:
            .orange
        case .critical, .exhausted:
            .red
        case .unknown:
            .secondary
        }
    }

    private var severityLabel: String {
        switch row.severity {
        case .ok:
            "정상"
        case .warning:
            "주의"
        case .critical:
            "위험"
        case .exhausted:
            "소진"
        case .unknown:
            "알 수 없음"
        }
    }

    private var productLabel: String {
        switch row.productKind {
        case .quota:
            "쿼터"
        case .billingUsage:
            "결제 기간 사용량"
        case .organizationUsage:
            "조직 사용량"
        case .localActivity:
            "로컬 활동"
        }
    }

    private var unitLabel: String {
        switch row.unit {
        case .percent:
            "%"
        case .tokens:
            "tokens"
        case .credits:
            "credits"
        case .requests:
            "requests"
        case .usd:
            "USD"
        case .minutes:
            "minutes"
        case .bytes:
            "bytes"
        case .unknown:
            "units"
        }
    }

    private func formatted(_ value: Double) -> String {
        value.formatted(.number.precision(.fractionLength(0 ... 2)))
    }
}
