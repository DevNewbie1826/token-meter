import SwiftUI
import TokenMeterCore

/// One duplex or upfront login field, rendered from the typed policy.
/// Follows the app's existing input vocabulary: rounded-border fields,
/// monospaced for pasted header/URL text, secure for secrets, and a
/// masked fields for every secret, including cookie headers.
struct ProviderLoginFieldView: View {
    let providerID: String
    let field: ProviderLoginField
    @Binding var value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
            editor
                .accessibilityIdentifier("provider-field-\(providerID)-\(field.kind.rawValue)")
            if field.kind == .cookieHeader {
                Text("DevTools → Network에서 api.json 요청의 Cookie 헤더 전체를 붙여넣으세요. 비워 두면 건너뜁니다.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if field.kind == .apiKey && field.isOptional {
                Text("키는 선택 사항입니다. 비워 두면 로컬 무인증 연결을 사용합니다.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private var editor: some View {
        switch (field.isSecure, field.isMultiline) {
        case (true, true):
            SecureField(placeholder, text: $value)
                .textFieldStyle(.roundedBorder)
                .privacySensitive()
        case (true, false):
            SecureField(placeholder, text: $value)
                .textFieldStyle(.roundedBorder)
        case (false, true):
            TextEditor(text: $value)
                .font(.body.monospaced())
                .scrollContentBackground(.hidden)
                .background(Color.primary.opacity(0.06))
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                .frame(minHeight: 68)
        case (false, false):
            TextField(placeholder, text: $value)
                .textFieldStyle(.roundedBorder)
        }
    }

    private var label: String {
        switch field.kind {
        case .apiKey: "API 키"
        case .cookieHeader: "Cookie 헤더"
        case .apiBaseUrl: "기준 URL / 리전 (선택 사항)"
        case .enterpriseHost: "엔터프라이즈 호스트 (선택 사항)"
        }
    }

    private var placeholder: String {
        switch field.kind {
        case .apiKey: field.isOptional ? "비워 둘 수 있음" : "API 키 입력"
        case .cookieHeader: "login_aliyunid_csrf=…; login_aliyunid_tt=…"
        case .apiBaseUrl: "API 기준 URL 입력 (선택 사항)"
        case .enterpriseHost: "ghe.example.com"
        }
    }
}

/// The single interactive login sheet. It renders policy fields, starts the
/// bridge LoginSession, streams its events (URLs, device codes, waiting and
/// paste hints), answers duplex prompts of every input kind, and cancels by
/// reaping the helper.
struct ProviderLoginSheet: View {
    let provider: ProviderCapability
    let method: AuthMethod
    @ObservedObject var model: TokenMeterViewModel
    @Environment(\.dismiss) private var dismiss

    @State private var fieldValues: [ProviderLoginFieldKind: String] = [:]
    @State private var accountLabel = ""
    @State private var isRunning = false
    @State private var promptValue = ""

    private var fields: [ProviderLoginField] {
        ProviderLoginFieldPolicy.fields(for: provider, method: method)
    }

    private var progress: ProviderAuthenticationProgress? {
        model.progress(for: provider.id)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(title)
                .font(.title3.bold())
            Text(subtitle)
                .font(.callout)
                .foregroundStyle(.secondary)

            if isRunning {
                progressSection
            } else {
                inputSection
            }

            if let error = model.authenticationErrors[provider.id] {
                Label(model.errorText(error), systemImage: "exclamationmark.triangle.fill")
                    .font(.callout)
                    .foregroundStyle(.orange)
            }

            HStack {
                Spacer()
                if isRunning {
                    Button("취소") {
                        model.cancelLogin(providerId: provider.id)
                    }
                    .accessibilityIdentifier("provider-login-cancel-\(provider.id)")
                } else {
                    Button("닫기") {
                        model.cancelLogin(providerId: provider.id)
                        dismiss()
                    }
                    Button(actionTitle) { Task { await run() } }
                        .keyboardShortcut(.defaultAction)
                        .accessibilityIdentifier("provider-save-\(provider.id)")
                }
            }
        }
        .padding(20)
        .frame(width: 480)
        .task {
            // Providers with no upfront fields (OAuth browser/device)
            // begin their bridge session as soon as the sheet appears.
            if fields.isEmpty && !isRunning && !model.isRegistered(provider.id) {
                await run()
            }
        }
        .onChange(of: model.isRegistered(provider.id)) { _, registered in
            if registered {
                dismiss()
            }
        }
    }

    // MARK: - Input phase

    private var inputSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(fields) { field in
                ProviderLoginFieldView(
                    providerID: provider.id,
                    field: field,
                    value: binding(for: field.kind)
                )
            }
            if method == .apiKey {
                TextField("계정 레이블 (선택 사항)", text: $accountLabel)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("provider-account-label-\(provider.id)")
            }
        }
    }

    // MARK: - Progress phase

    private var progressSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                if progress?.isActive != false {
                    ProgressView()
                        .controlSize(.small)
                }
                Text(progress?.statusText ?? "인증을 준비하는 중…")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }

            if let code = progress?.code {
                VStack(alignment: .leading, spacing: 5) {
                    Text("인증 코드")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(code)
                        .font(.title2.monospaced().bold())
                        .textSelection(.enabled)
                }
            }

            if let rawURL = progress?.verificationURL,
               let url = URL(string: rawURL) {
                Link(rawURL, destination: url)
                    .font(.callout.monospaced())
                    .lineLimit(2)
            }

            if let prompt = progress?.prompt {
                promptSection(prompt)
            }
        }
    }

    private func promptSection(_ prompt: ProviderLoginPrompt) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Divider()
            Text(prompt.prompt)
                .font(.callout.weight(.medium))
            promptEditor(prompt)
                .accessibilityIdentifier("provider-prompt-\(provider.id)")
            HStack {
                Spacer()
                Button("전송") {
                    model.respondToPrompt(providerId: provider.id, value: promptValue)
                    promptValue = ""
                }
                .keyboardShortcut(.defaultAction)
                .accessibilityIdentifier("provider-prompt-send-\(provider.id)")
            }
        }
    }

    @ViewBuilder
    private func promptEditor(_ prompt: ProviderLoginPrompt) -> some View {
        if prompt.sensitive {
            SecureField(promptPlaceholder(prompt.inputKind), text: $promptValue)
                .textFieldStyle(.roundedBorder)
                .privacySensitive()
        } else {
            switch prompt.inputKind {
            case .cookieHeader:
                TextEditor(text: $promptValue)
                    .font(.body.monospaced())
                    .scrollContentBackground(.hidden)
                    .background(Color.primary.opacity(0.06))
                    .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                    .frame(minHeight: 68)
            case .text, .code, .redirectUrl, .apiBaseUrl:
                TextField(promptPlaceholder(prompt.inputKind), text: $promptValue)
                    .textFieldStyle(.roundedBorder)
                    .font(.body.monospaced())
            }
        }
    }

    private func promptPlaceholder(_ kind: AuthInputKind) -> String {
        switch kind {
        case .text: "입력"
        case .code: "인증 코드 입력"
        case .redirectUrl: "https://…"
        case .cookieHeader: "Cookie 헤더"
        case .apiBaseUrl: "https://…"
        }
    }

    // MARK: - Flow

    private func run() async {
        guard !isRunning else { return }
        isRunning = true
        await model.register(
            providerId: provider.id,
            method: method,
            inputs: ProviderLoginFieldPolicy.loginInputs(from: fieldValues),
            accountLabel: accountLabel
        )
        isRunning = false
        if model.isRegistered(provider.id) {
            dismiss()
        }
    }

    private func binding(for kind: ProviderLoginFieldKind) -> Binding<String> {
        Binding(
            get: { fieldValues[kind] ?? "" },
            set: { fieldValues[kind] = $0 }
        )
    }

    private var title: String {
        "\(provider.displayName) \(actionTitle)"
    }

    private var actionTitle: String {
        switch method {
        case .apiKey: "API 키 등록"
        case .browser: "브라우저 로그인"
        case .device: "기기 인증"
        }
    }

    private var subtitle: String {
        switch method {
        case .apiKey:
            "입력한 키는 브리지 인증 모듈로 전송되어 검증되며, 반환된 자격 증명만 auth.json 파일에 저장됩니다."
        case .browser:
            "브라우저에서 OAuth 로그인을 완료하면 반환된 자격 증명만 auth.json 파일에 저장됩니다."
        case .device:
            "화면에 표시된 코드를 다른 기기에서 입력하면 자격 증명이 반환됩니다."
        }
    }
}
