import AppKit
import Foundation
import SwiftUI
import TokenMeterCore

@main
struct TokenMeterApp: App {
    @NSApplicationDelegateAdaptor(TokenMeterAppDelegate.self) private var appDelegate
    @StateObject private var model = TokenMeterViewModel(
        providerManagementStore: TokenMeterApp.providerManagementStoreForCurrentEnvironment()
    )

    var body: some Scene {
        MenuBarExtra("Token Meter", systemImage: "gauge.medium") {
            MenuPanelView(model: model)
                .onAppear { model.startAutomaticRefresh() }
        }
        .menuBarExtraStyle(.window)

        Settings {
            ProviderManagementView(model: model)
                .onAppear { model.startAutomaticRefresh() }
        }
    }
}

extension TokenMeterApp {
    static func providerManagementStoreForCurrentEnvironment() -> ProviderManagementStore? {
#if TOKEN_METER_QA
        if ProcessInfo.processInfo.environment["TOKEN_METER_QA_FIXTURE"] == "1" {
            return qaProviderManagementStore(scope: "menu")
        }
#endif
        return defaultProviderManagementStore()
    }

    static func defaultProviderManagementStore() -> ProviderManagementStore? {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        let directory = base
            .appendingPathComponent("TokenMeter", isDirectory: true)
            .appendingPathComponent("ProviderAccounts", isDirectory: true)
        return try? ProviderManagementStore(storageDirectory: directory)
    }

#if TOKEN_METER_QA
    static func qaProviderManagementStore(scope: String) -> ProviderManagementStore? {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(
                "TokenMeter-QA-\(ProcessInfo.processInfo.processIdentifier)-\(scope)",
                isDirectory: true
            )
        try? FileManager.default.removeItem(at: directory)
        return try? ProviderManagementStore(storageDirectory: directory)
    }
#endif

    static func credentialStoreForCurrentEnvironment() -> CredentialStoreProtocol? {
#if TOKEN_METER_QA
        if ProcessInfo.processInfo.environment["TOKEN_METER_QA_FIXTURE"] == "1" {
            return qaCredentialStore()
        }
#endif
        return defaultCredentialStore()
    }

    static func defaultCredentialStore() -> CredentialStoreProtocol? {
        AuthFileCredentialStore()
    }

#if TOKEN_METER_QA
    static func qaCredentialStore() -> CredentialStoreProtocol? {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(
                "TokenMeter-QA-\(ProcessInfo.processInfo.processIdentifier)-credentials",
                isDirectory: true
            )
        try? FileManager.default.removeItem(at: directory)
        return AuthFileCredentialStore(
            fileURL: directory.appendingPathComponent("auth.json", isDirectory: false)
        )
    }
#endif
}

#if TOKEN_METER_QA
private struct KimiLiveAcceptanceHostView: View {
    @ObservedObject var model: TokenMeterViewModel

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            ProviderManagementView(model: model)
            Divider()
            VStack(spacing: 0) {
                MenuPanelView(model: model)
                Text(status)
                    .font(.caption.monospaced())
                    .accessibilityIdentifier("kimi-live-status")
            }
        }
    }

    private var status: String {
        guard let card = model.card(for: "kimi-code") else {
            return "unregistered"
        }
        if let error = card.error {
            return "error:\(model.errorText(error))"
        }
        if card.rows.isEmpty {
            return "loading"
        }
        return "rows:\(card.rows.map(\.limitId).joined(separator: ","))"
    }
}
#endif

final class TokenMeterAppDelegate: NSObject, NSApplicationDelegate {
#if TOKEN_METER_QA
    private var qaProviderWindow: NSWindow?
    private var qaBringFrontObserver: NSObjectProtocol?
    private var qaCaptureObserver: NSObjectProtocol?

    func applicationWillFinishLaunching(_ notification: Notification) {
        if ProcessInfo.processInfo.environment["TOKEN_METER_QA_OPEN_SETTINGS"] == "1" {
            NSApp.setActivationPolicy(.regular)
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let environment = ProcessInfo.processInfo.environment
        // QA harness entry points stay machine-readable. The hosted window
        // renders the real app; there is no fixture data anymore.
        let qaHarnessRequested = environment["TOKEN_METER_QA_FIXTURE"] == "1"
            || environment["TOKEN_METER_QA_OPEN_SETTINGS"] == "1"
        if environment["TOKEN_METER_QA_OPEN_SETTINGS"] == "1" {
            let fixtureBridge = NekosQAHost.bridge(environment: environment)
            let model = TokenMeterViewModel(
                bridge: fixtureBridge,
                providerManagementStore: TokenMeterApp.qaProviderManagementStore(scope: "settings")
            )
            let showsLiveUsage = environment["TOKEN_METER_QA_LIVE_USAGE"] == "1"
            let hostedRoot: AnyView
            if fixtureBridge != nil {
                hostedRoot = AnyView(NekosQAHost(model: model))
            } else if showsLiveUsage {
                hostedRoot = AnyView(KimiLiveAcceptanceHostView(model: model))
            } else {
                hostedRoot = AnyView(ProviderManagementView(model: model))
            }
            let controller = NSHostingController(
                rootView: hostedRoot
            )
            let window = NSWindow(
                contentRect: NSRect(
                    x: 0,
                    y: 0,
                    width: showsLiveUsage || fixtureBridge != nil ? 1_080 : 640,
                    height: 760
                ),
                styleMask: [.titled, .closable, .resizable],
                backing: .buffered,
                defer: false
            )
            window.title = "Token Meter 설정"
            window.sharingType = .readOnly
            window.contentViewController = controller
            window.center()
            window.makeKeyAndOrderFront(nil)
            qaProviderWindow = window
            NSApp.activate(ignoringOtherApps: true)
            let distributed = DistributedNotificationCenter.default()
            qaBringFrontObserver = distributed.addObserver(
                forName: Notification.Name("dev.herdr.token-meter.qa.bring-front"),
                object: nil,
                queue: .main
            ) { [weak self] _ in
                guard let window = self?.qaProviderWindow else { return }
                window.makeKeyAndOrderFront(nil)
                NSApp.activate(ignoringOtherApps: true)
                distributed.postNotificationName(
                    Notification.Name("dev.herdr.token-meter.qa.front-ready"),
                    object: nil,
                    userInfo: ["pid": ProcessInfo.processInfo.processIdentifier],
                    deliverImmediately: true
                )
            }
            qaCaptureObserver = distributed.addObserver(
                forName: Notification.Name("dev.herdr.token-meter.qa.capture-window"),
                object: nil,
                queue: .main
            ) { [weak self] notification in
                if let target = notification.userInfo?["targetPID"] as? NSNumber,
                   target.int32Value != ProcessInfo.processInfo.processIdentifier { return }
                guard
                    let window = self?.qaProviderWindow,
                    let contentView = window.contentView,
                    let path = notification.userInfo?["path"] as? String,
                    let representation = contentView.bitmapImageRepForCachingDisplay(
                        in: contentView.bounds
                    )
                else {
                    return
                }
                contentView.cacheDisplay(
                    in: contentView.bounds,
                    to: representation
                )
                let data = representation.representation(
                    using: .png,
                    properties: [:]
                )
                try? data?.write(to: URL(fileURLWithPath: path), options: .atomic)
                distributed.postNotificationName(
                    Notification.Name("dev.herdr.token-meter.qa.capture-done"),
                    object: nil,
                    userInfo: ["pid": ProcessInfo.processInfo.processIdentifier],
                    deliverImmediately: true
                )
            }
        }
        if qaHarnessRequested {
            NekosQAHost.announceReady(environment: environment)
            FileHandle.standardOutput.write(Data("TOKEN_METER_QA_READY\n".utf8))
        }
    }
#endif
}

struct ProviderQuotaCard: Identifiable {
    let provider: ProviderCapability
    let accountRef: String
    let accountName: String
    let rows: [QuotaRow]
    let freshness: QuotaFreshness?
    let error: BridgeServiceError?
    /// Distinguishes an actual zero-window report from an account that has
    /// not been manually fetched yet.
    let hasUsageReport: Bool

    var id: String { "\(provider.id):\(accountRef)" }

    var showsNoStandaloneUsageAPI: Bool {
        hasUsageReport && rows.isEmpty && provider.sourceKind == .noQuotaApi
    }

    init(
        provider: ProviderCapability,
        accountRef: String,
        accountName: String,
        rows: [QuotaRow],
        freshness: QuotaFreshness?,
        error: BridgeServiceError?,
        hasUsageReport: Bool = false
    ) {
        self.provider = provider
        self.accountRef = accountRef
        self.accountName = accountName
        self.rows = rows
        self.freshness = freshness
        self.error = error
        self.hasUsageReport = hasUsageReport
    }
}

protocol CredentialStoreProtocol: Sendable {
    func save(credential: BridgeCredential, for accountRef: String) throws -> Int
    func load(for accountRef: String) throws -> StoredCredential?
    func delete(for accountRef: String) throws
}

extension AuthFileCredentialStore: CredentialStoreProtocol {}

/// The live duplex login session the bridge client returns: advisory events,
/// the final result, correlated prompt responses and cancellation that
/// reaps the helper process.
protocol BridgeLoginSession: Sendable {
    var events: AsyncStream<AuthEvent> { get }
    var result: Task<LoginResult, Never> { get }
    func sendPromptResponse(id: String, value: String)
    func cancel()
}

extension LoginSession: BridgeLoginSession {}

protocol BridgeServing: Sendable {
    func fetchUsage(_ request: UsageRequest) async -> UsageResponse
    func login(request: LoginRequest) -> BridgeLoginSession
}

extension BridgeClient: BridgeServing {
    func login(request: LoginRequest) -> BridgeLoginSession {
        let session: LoginSession = login(request: request)
        return session
    }
}

/// One duplex prompt the helper is waiting on.
struct ProviderLoginPrompt: Equatable, Sendable, Identifiable {
    let id: String
    let prompt: String
    let inputKind: AuthInputKind
    let sensitive: Bool
}

struct ProviderAuthenticationProgress: Equatable, Sendable {
    let method: AuthMethod
    let statusText: String
    let code: String?
    let verificationURL: String?
    let isActive: Bool
    let prompt: ProviderLoginPrompt?
}

/// One registration button projected from the manifest.
struct RegistrationAction: Equatable, Identifiable, Sendable {
    let method: ProviderRegistrationMethod
    let title: String
    let accessibilityID: String

    var id: String { accessibilityID }
}

@MainActor
final class TokenMeterViewModel: ObservableObject {
    @Published private(set) var catalog = ProviderCatalog.locked
    @Published private(set) var registeredProviderIDs: Set<String> = []
    @Published private(set) var cards: [ProviderQuotaCard] = []
    @Published private(set) var authenticationProgress: [String: ProviderAuthenticationProgress] = [:]
    @Published private(set) var authenticationErrors: [String: BridgeServiceError] = [:]
    @Published private(set) var refreshingProviderIDs: Set<String> = []
    @Published var managementError: String?

    private struct RegisteredProviderAccount: Sendable {
        let accountRef: String
        let accountLabel: String
        let credentialRevision: Int
    }

    private struct ActiveLogin {
        let token: UUID
        let session: BridgeLoginSession
        var cancelled = false
    }

    private static let requestTimeoutMs: Int64 = 30_000
    private static let loginTimeoutMs: Int64 = 300_000

    private let credentialStore: CredentialStoreProtocol
    private let bridge: BridgeServing
    private let providerManagementStore: ProviderManagementStore?
    private let clock: WallClock
    private let openURL: (URL) -> Void
    private var accountsByProvider: [String: RegisteredProviderAccount] = [:]
    private var lastReportsByProvider: [String: UsageReport] = [:]
    private var activeLogins: [String: ActiveLogin] = [:]

    init(
        credentialStore: CredentialStoreProtocol? = nil,
        bridge: BridgeServing? = nil,
        providerManagementStore: ProviderManagementStore? = nil,
        clock: WallClock = SystemWallClock(),
        openURL: @escaping (URL) -> Void = { NSWorkspace.shared.open($0) }
    ) {
        self.credentialStore = credentialStore
            ?? TokenMeterApp.credentialStoreForCurrentEnvironment()
            ?? AuthFileCredentialStore()
        self.providerManagementStore = providerManagementStore
        self.clock = clock
        self.openURL = openURL
        if let bridge {
            self.bridge = bridge
        } else {
            // Every path — including a missing helper — goes through the
            // real bridge transport; a launch failure surfaces as the
            // helper's own typed dependency error.
            let executableURL = BridgeClient.bundledExecutableURL()
                ?? Bundle.main.bundleURL
                    .appendingPathComponent("Contents/Resources/token-meter-bridge")
            self.bridge = BridgeClient(executableURL: executableURL, clock: clock)
        }

        if let providerManagementStore {
            restoreRegisteredAccounts(from: providerManagementStore)
        }
    }

    func isRegistered(_ providerID: String) -> Bool {
        registeredProviderIDs.contains(providerID)
    }

    /// The registration buttons for one provider, projected from the
    /// manifest. Dual-method providers (Cursor, GitHub, Codex, Z.ai) get
    /// one button per declared method, so registry updates surface
    /// automatically.
    func registrationActions(for providerID: String) -> [RegistrationAction] {
        guard let provider = catalog.providers.first(where: { $0.id == providerID }) else {
            return []
        }
        return provider.registrationMethods.enumerated().map { index, method in
            RegistrationAction(
                method: method,
                title: Self.actionTitle(method),
                accessibilityID: index == 0
                    ? "provider-action-\(provider.id)"
                    : "provider-action-\(provider.id)-\(method.id)"
            )
        }
    }

    func card(for providerID: String) -> ProviderQuotaCard? {
        cards.first(where: { $0.provider.id == providerID })
    }

    func progress(for providerID: String) -> ProviderAuthenticationProgress? {
        authenticationProgress[providerID]
    }

    func accountRef(for providerID: String) -> String? {
        accountsByProvider[providerID]?.accountRef
    }

    func credentialRevision(for providerID: String) -> Int? {
        accountsByProvider[providerID]?.credentialRevision
    }

    /// Registers one provider through one declared auth method. Every
    /// method — API key included — starts a bridge LoginSession carrying the
    /// structured inputs; only the credential the helper returns is ever
    /// stored.
    func register(
        providerId: String,
        method: AuthMethod,
        inputs: LoginInputs = LoginInputs(),
        accountLabel: String? = nil
    ) async {
        guard let provider = catalog.providers.first(where: { $0.id == providerId }),
              provider.registrationMethod(for: method) != nil
        else {
            failAuthentication(providerId: providerId, error: .invalidProvider(providerId))
            return
        }

        managementError = nil
        authenticationErrors.removeValue(forKey: providerId)

        guard let success = await performBridgeLogin(
            provider: provider,
            method: method,
            inputs: inputs
        ) else {
            return
        }
        guard success.providerId == provider.id else {
            failAuthentication(
                providerId: provider.id,
                error: .invalidProtocol("login providerId mismatch")
            )
            return
        }
        guard provider.accepts(success.credential, for: method) else {
            failAuthentication(
                providerId: provider.id,
                error: .invalidProtocol("login returned an undeclared credential kind")
            )
            return
        }
        await completeRegistration(
            provider: provider,
            credential: success.credential,
            accountLabel: success.accountLabel ?? accountLabel
        )
    }

    /// Delivers one duplex prompt response to the live helper session. The
    /// value travels only through the session's stdin pipe.
    func respondToPrompt(providerId: String, value: String) {
        guard let active = activeLogins[providerId],
              let prompt = authenticationProgress[providerId]?.prompt
        else { return }
        active.session.sendPromptResponse(id: prompt.id, value: value)
        let previous = authenticationProgress[providerId]
        authenticationProgress[providerId] = ProviderAuthenticationProgress(
            method: previous?.method ?? .apiKey,
            statusText: "응답을 전송했습니다. 잠시만 기다려 주세요.",
            code: previous?.code,
            verificationURL: previous?.verificationURL,
            isActive: true,
            prompt: nil
        )
    }

    /// Cancels the live login; the helper process is reaped before the
    /// pending result completes.
    func cancelLogin(providerId: String) {
        guard var active = activeLogins[providerId] else { return }
        active.cancelled = true
        activeLogins[providerId] = active
        active.session.cancel()
        let previous = authenticationProgress[providerId]
        authenticationProgress[providerId] = ProviderAuthenticationProgress(
            method: previous?.method ?? .browser,
            statusText: "취소됨",
            code: previous?.code,
            verificationURL: previous?.verificationURL,
            isActive: false,
            prompt: nil
        )
    }

    func refresh(
        providerId: String,
        credentialOverride: BridgeCredential? = nil
    ) async {
        guard let provider = catalog.providers.first(where: { $0.id == providerId }),
              let account = accountsByProvider[providerId]
        else { return }

        refreshingProviderIDs.insert(providerId)
        defer { refreshingProviderIDs.remove(providerId) }

        let credential: BridgeCredential
        if let credentialOverride {
            credential = credentialOverride
        } else {
            do {
                if let loaded = try credentialStore.load(for: account.accountRef) {
                    credential = loaded.credential
                } else if provider.registrationCapability.allowsBlankAPIKey {
                    // Capability-derived local no-auth, mirroring the bridge's
                    // credential-free local rule: no stored secret is the
                    // honest `{none}` state for the local transports.
                    credential = .none
                } else {
                    publishFailure(.missingCredential, provider: provider, account: account)
                    return
                }
            } catch {
                publishFailure(
                    .dependency("Credential file load failed"),
                    provider: provider,
                    account: account
                )
                return
            }
        }

        let requestedAtMs = clock.nowMs()
        let request = UsageRequest(
            requestId: UUID().uuidString,
            operation: .fetchUsage,
            providerId: provider.id,
            connectorId: provider.id,
            accountRef: account.accountRef,
            requestedAtMs: requestedAtMs,
            deadlineAtMs: requestedAtMs + Self.requestTimeoutMs,
            credential: credential
        )

        switch await bridge.fetchUsage(request) {
        case .failure(let error):
            // A rotated credential is persisted before the error is shown,
            // exactly like the success path.
            let displayError = persistRefreshedCredential(
                error.refreshedCredential,
                provider: provider,
                account: account
            ) ?? error.underlyingError
            publishFailure(displayError, provider: provider, account: account)

        case .report(let report):
            guard report.providerId == provider.id,
                  report.connectorId == provider.id,
                  report.accountRef == account.accountRef
            else {
                publishFailure(
                    .invalidProtocol("usage response correlation mismatch"),
                    provider: provider,
                    account: account
                )
                return
            }

            let projectionError = persistRefreshedCredential(
                report.refreshedCredential,
                provider: provider,
                account: account
            )
            let currentAccount = accountsByProvider[provider.id] ?? account

            lastReportsByProvider[provider.id] = report
            let snapshot = QuotaProjector().project(
                AccountSnapshotInput(
                    providerId: provider.id,
                    accountRef: account.accountRef,
                    current: report,
                    currentFetchedAtMs: report.fetchedAtMs,
                    pendingError: projectionError
                ),
                nowMs: clock.nowMs()
            )
            publishCard(
                snapshot: snapshot,
                provider: provider,
                account: currentAccount,
                hasUsageReport: true
            )
        }
    }

    func remove(providerId: String) {
        cancelLogin(providerId: providerId)
        guard let account = accountsByProvider[providerId] else {
            registeredProviderIDs.remove(providerId)
            cards.removeAll { $0.provider.id == providerId }
            managementError = nil
            return
        }

        do {
            try credentialStore.delete(for: account.accountRef)
            try providerManagementStore?.removeAccount(
                providerId: providerId,
                accountRef: account.accountRef
            )
            accountsByProvider.removeValue(forKey: providerId)
            lastReportsByProvider.removeValue(forKey: providerId)
            registeredProviderIDs.remove(providerId)
            cards.removeAll { $0.provider.id == providerId }
            authenticationErrors.removeValue(forKey: providerId)
            authenticationProgress.removeValue(forKey: providerId)
            managementError = nil
        } catch {
            managementError = "등록 정보와 자격 증명을 삭제하지 못했습니다."
        }
    }

    // MARK: - Automatic refresh

    /// The installed timer-and-wake refresh driver, if any. Read-only
    /// outside the model so tests can drive `fire()` without a live timer.
    private(set) var refreshAutomation: RefreshAutomation?

    /// Installs the automatic refresh driver: a repeating timer at the
    /// coordinator's default interval plus one immediate tick on wake from
    /// sleep. Idempotent, so any lifecycle hook may call it. The driver is
    /// deliberately NOT created in `init` — unit tests instantiate the
    /// model and must not get live timers.
    func startAutomaticRefresh() {
        let automation = refreshAutomation ?? RefreshAutomation(
            intervalMs: Int(RefreshCoordinator.defaultRefreshIntervalMs)
        ) { [weak self] in
            self?.refreshDueProviders()
        }
        refreshAutomation = automation
        automation.start()
    }

    /// Stops the driver and removes its timer and wake observer. The
    /// automation object is kept so a later start reuses it.
    func stopAutomaticRefresh() {
        refreshAutomation?.stop()
    }

    /// One automation tick. Every registered provider whose catalog
    /// capability allows automatic refresh and that is not mid-refresh
    /// goes through the same `refresh(providerId:)` path as a manual
    /// refresh, so error surfaces, credential writeback and card
    /// projection stay identical. The model keeps no coordinator
    /// deadlines, so each tick refreshes every eligible provider rather
    /// than only due ones.
    private func refreshDueProviders() {
        for providerId in registeredProviderIDs {
            guard catalog.providers.contains(where: { $0.id == providerId }),
                  !refreshingProviderIDs.contains(providerId)
            else { continue }
            Task { [weak self] in
                await self?.refresh(providerId: providerId)
            }
        }
    }

    func errorText(_ error: BridgeServiceError) -> String {
        switch error {
        case .missingCredential, .authRequired:
            "인증이 필요합니다."
        case .permissionDenied:
            "사용량 조회 권한이 없습니다."
        case let .rateLimited(retryAfterMs):
            retryAfterMs == nil
                ? "요청 한도에 도달했습니다."
                : "요청 한도에 도달했습니다. 잠시 후 다시 시도합니다."
        case .noData:
            "표시할 사용량이 없습니다."
        case .timeout:
            "요청 시간이 초과되었습니다."
        default:
            error.wireMessage ?? "요청을 완료하지 못했습니다."
        }
    }

    // MARK: - Bridge login

    private func performBridgeLogin(
        provider: ProviderCapability,
        method: AuthMethod,
        inputs: LoginInputs
    ) async -> LoginSuccess? {
        let requestedAtMs = clock.nowMs()
        let session = bridge.login(request: LoginRequest(
            providerId: provider.id,
            method: method,
            requestedAtMs: requestedAtMs,
            deadlineAtMs: requestedAtMs + Self.loginTimeoutMs,
            inputs: inputs
        ))
        let token = UUID()
        activeLogins[provider.id] = ActiveLogin(token: token, session: session)
        authenticationProgress[provider.id] = ProviderAuthenticationProgress(
            method: method,
            statusText: method == .device
                ? "기기 인증을 시작하는 중…"
                : method == .browser
                    ? "브라우저 로그인을 시작하는 중…"
                    : "브리지에서 자격 증명을 확인하는 중…",
            code: nil,
            verificationURL: nil,
            isActive: true,
            prompt: nil
        )

        let eventTask = Task { [weak self] in
            for await event in session.events {
                guard let self,
                      self.activeLogins[provider.id]?.token == token else { return }
                self.handle(event: event, providerId: provider.id, method: method)
            }
        }
        let result = await session.result.value
        await eventTask.value

        guard let active = activeLogins[provider.id], active.token == token else { return nil }
        activeLogins.removeValue(forKey: provider.id)

        let previous = authenticationProgress[provider.id]
        switch result {
        case .failure(let error):
            authenticationProgress[provider.id] = ProviderAuthenticationProgress(
                method: method,
                statusText: active.cancelled ? "취소됨" : errorText(error),
                code: previous?.code,
                verificationURL: previous?.verificationURL,
                isActive: false,
                prompt: nil
            )
            if active.cancelled {
                // The user asked to stop; a reaped helper's timeout is not
                // an authentication failure.
                return nil
            }
            failAuthentication(providerId: provider.id, error: error)
            return nil
        case .success(let success):
            authenticationProgress[provider.id] = ProviderAuthenticationProgress(
                method: method,
                statusText: "로그인 완료",
                code: previous?.code,
                verificationURL: previous?.verificationURL,
                isActive: false,
                prompt: nil
            )
            return success
        }
    }

    private func handle(event: AuthEvent, providerId: String, method: AuthMethod) {
        let previous = authenticationProgress[providerId]
        var status = previous?.statusText ?? "인증 중…"
        var code = previous?.code
        var verificationURL = previous?.verificationURL
        var prompt = previous?.prompt

        switch event {
        case .openUrl(let rawURL):
            verificationURL = rawURL
            status = "브라우저에서 로그인을 완료해 주세요."
            if let url = URL(string: rawURL) { openURL(url) }
        case .code(let value, let rawURL):
            code = value
            verificationURL = rawURL
            status = "아래 코드를 입력해 주세요."
        case .waiting(let detail):
            status = detail
        case .pasteHint(let detail):
            status = detail
        case .prompt(let requestId, let promptText, let inputKind, let sensitive):
            status = promptText
            prompt = ProviderLoginPrompt(
                id: requestId,
                prompt: promptText,
                inputKind: inputKind,
                sensitive: sensitive
            )
        }

        authenticationProgress[providerId] = ProviderAuthenticationProgress(
            method: method,
            statusText: status,
            code: code,
            verificationURL: verificationURL,
            isActive: true,
            prompt: prompt
        )
    }

    // MARK: - Registration completion

    private func completeRegistration(
        provider: ProviderCapability,
        credential: BridgeCredential,
        accountLabel: String?
    ) async {
        let existing = accountsByProvider[provider.id]
        let accountRef = existing?.accountRef ?? UUID().uuidString
        let label = normalizedAccountLabel(accountLabel, provider: provider)

        do {
            let revision = try credentialStore.save(credential: credential, for: accountRef)
            let account = RegisteredProviderAccount(
                accountRef: accountRef,
                accountLabel: label,
                credentialRevision: revision
            )
            do {
                try persistAccount(providerID: provider.id, account: account)
            } catch {
                if existing == nil {
                    try? credentialStore.delete(for: accountRef)
                }
                managementError = "계정 정보를 저장하지 못했습니다."
                return
            }

            accountsByProvider[provider.id] = account
            registeredProviderIDs.insert(provider.id)
            managementError = nil
            authenticationErrors.removeValue(forKey: provider.id)
            await refresh(
                providerId: provider.id,
                credentialOverride: credential
            )
        } catch {
            managementError = "auth.json에 자격 증명을 저장하지 못했습니다."
        }
    }

    private func failAuthentication(providerId: String, error: BridgeServiceError) {
        authenticationErrors[providerId] = error
        managementError = errorText(error)
    }

    /// Persists a credential the bridge rotated during this fetch. Returns
    /// the error to surface when the writeback itself fails, nil otherwise.
    @discardableResult
    private func persistRefreshedCredential(
        _ refreshedCredential: BridgeCredential?,
        provider: ProviderCapability,
        account: RegisteredProviderAccount
    ) -> BridgeServiceError? {
        guard let refreshedCredential else { return nil }
        do {
            let revision = try credentialStore.save(
                credential: refreshedCredential,
                for: account.accountRef
            )
            let updated = RegisteredProviderAccount(
                accountRef: account.accountRef,
                accountLabel: account.accountLabel,
                credentialRevision: revision
            )
            accountsByProvider[provider.id] = updated
            do {
                try persistAccount(providerID: provider.id, account: updated)
            } catch {
                managementError = "갱신된 자격 증명 메타데이터를 저장하지 못했습니다."
            }
            return nil
        } catch {
            return .dependency("Credential file refresh writeback failed")
        }
    }

    private func normalizedAccountLabel(
        _ accountLabel: String?,
        provider: ProviderCapability
    ) -> String {
        let trimmed = accountLabel?.trimmingCharacters(in: .whitespacesAndNewlines)
        return (trimmed?.isEmpty == false ? trimmed : nil) ?? provider.displayName
    }

    private func restoreRegisteredAccounts(from store: ProviderManagementStore) {
        var automaticProviders: [String] = []
        for provider in catalog.providers {
            guard let record = (try? store.accounts(forProvider: provider.id))?.first else {
                continue
            }
            let storedCredential = try? credentialStore.load(for: record.accountRef)
            let canRestoreWithoutCredentialFile =
                record.credentialRevision == 0
                && provider.credentialKinds.contains(.none)
            guard storedCredential != nil || canRestoreWithoutCredentialFile else {
                try? store.removeAccount(
                    providerId: provider.id,
                    accountRef: record.accountRef
                )
                continue
            }
            let account = RegisteredProviderAccount(
                accountRef: record.accountRef,
                accountLabel: record.displayName,
                credentialRevision: record.credentialRevision
            )
            accountsByProvider[provider.id] = account
            registeredProviderIDs.insert(provider.id)
            cards.append(ProviderQuotaCard(
                provider: provider,
                accountRef: account.accountRef,
                accountName: account.accountLabel,
                rows: [],
                freshness: nil,
                error: nil
            ))
            automaticProviders.append(provider.id)
        }
        for providerId in automaticProviders {
            Task { [weak self] in await self?.refresh(providerId: providerId) }
        }
    }

    private func persistAccount(
        providerID: String,
        account: RegisteredProviderAccount
    ) throws {
        guard let providerManagementStore else { return }
        try providerManagementStore.upsert(account: AccountRecord(
            providerId: providerID,
            accountRef: account.accountRef,
            displayName: account.accountLabel,
            credentialRevision: account.credentialRevision
        ))
    }

    private func publishFailure(
        _ error: BridgeServiceError,
        provider: ProviderCapability,
        account: RegisteredProviderAccount
    ) {
        let report = lastReportsByProvider[provider.id]
        let snapshot = QuotaProjector().project(
            AccountSnapshotInput(
                providerId: provider.id,
                accountRef: account.accountRef,
                current: report,
                currentFetchedAtMs: report?.fetchedAtMs,
                pendingError: error
            ),
            nowMs: clock.nowMs()
        )
        publishCard(
            snapshot: snapshot,
            provider: provider,
            account: account,
            hasUsageReport: report != nil
        )
    }

    private func publishCard(
        snapshot: AccountSnapshot,
        provider: ProviderCapability,
        account: RegisteredProviderAccount,
        hasUsageReport: Bool
    ) {
        let card = ProviderQuotaCard(
            provider: provider,
            accountRef: account.accountRef,
            accountName: account.accountLabel,
            rows: snapshot.rows,
            freshness: snapshot.freshness,
            error: snapshot.error,
            hasUsageReport: hasUsageReport
        )
        cards.removeAll { $0.provider.id == provider.id }
        cards.append(card)
        cards.sort { $0.provider.displayName < $1.provider.displayName }
    }

    private static func actionTitle(_ method: ProviderRegistrationMethod) -> String {
        switch method {
        case .apiKey: "API 키로 등록"
        case .browser: "브라우저로 로그인"
        case .device: "기기 인증"
        }
    }
}
