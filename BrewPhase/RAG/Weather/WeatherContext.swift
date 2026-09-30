import CoreLocation
import Foundation
import WeatherKit

/// 天气场景。做推荐的粒度就到「场景」为止，不往「31.6°C」这种精度去——
/// 冲煮建议对 3 度以内的差别不敏感，场景足够了。
enum WeatherScene: String, Codable, CaseIterable, Sendable {
    case hot
    case warm
    case cool
    case cold
    case rainy
    case unknown

    var label: String {
        switch self {
        case .hot: return L("晴热")
        case .warm: return L("温和")
        case .cool: return L("转凉")
        case .cold: return L("冷")
        case .rainy: return L("下雨")
        case .unknown: return L("未设置")
        }
    }

    /// 手选 chips 的顺序。rainy 放最后：它和温度档位不是一个维度（下雨可以
    /// 又冷又下雨），放中间会打断「从热到冷」的自然顺序。
    static let manualChoices: [WeatherScene] = [.hot, .warm, .cool, .cold, .rainy]

    /// 语义符号。只用于界面装饰。
    var symbol: String {
        switch self {
        case .hot: return "sun.max.fill"
        case .warm: return "cloud.sun.fill"
        case .cool: return "cloud.fill"
        case .cold: return "wind.snow"
        case .rainy: return "cloud.rain.fill"
        case .unknown: return "circle.dashed"
        }
    }

    /// 从温度与天气条件推导场景。规则的边界在 `IntelligenceConfig`。
    ///
    /// 降水优先于温度：15°C 的雨天和 15°C 的阴天，想喝的东西不一样，
    /// 而「下雨」本身就是用户一听就懂的分类。
    static func derive(temperatureCelsius: Double?, condition: String?) -> WeatherScene {
        if let condition, Self.precipitating.contains(condition) { return .rainy }
        guard let temperatureCelsius else { return .unknown }
        let config = IntelligenceConfig.self
        if temperatureCelsius >= config.hotThresholdCelsius { return .hot }
        if temperatureCelsius >= config.coolThresholdCelsius { return .warm }
        if temperatureCelsius >= config.coldThresholdCelsius { return .cool }
        return .cold
    }

    /// WeatherKit 里表示降水的条件。写在这层而不是配置里：它是 WeatherKit
    /// 枚举值的对照表，不是可调参数。
    private static let precipitating: Set<String> = [
        "drizzle", "rain", "heavyRain", "sunShowers", "freezingRain", "sleet",
        "hail", "thunderstorms", "hurricane", "tropicalStorm",
    ]
}

/// 一次推荐可用的天气上下文。值类型，可以进任何线程、任何测试。
struct WeatherContext: Equatable, Sendable {
    let scene: WeatherScene
    /// 实测温度。仅自动模式有；展示用（「28°C」），推荐只看 scene。
    let temperatureCelsius: Double?
    /// true 表示来自位置 + 天气服务；false 表示用户手选或没设置。
    let isAutomatic: Bool
    /// 自动模式失败或受限时的说明，界面原样显示。
    let note: String?

    static let unset = WeatherContext(scene: .unknown, temperatureCelsius: nil,
                                      isAutomatic: false, note: nil)

    var isSet: Bool { scene != .unknown }
}

/// 天气从哪来。两个实现对应两种隐私姿态（协议 §38 的延续）：
/// 手动 = 零权限零网络；自动 = 一次位置权限 + 联网，拿不到就退回手动。
protocol WeatherServing: Sendable {
    func current() async -> WeatherContext
}

/// 自动模式：一次性的粗定位 + WeatherKit。
///
/// 隐私边界（要跟用户说清楚的三件事）：
/// * 位置权限是「使用期间」，取到坐标后立即停手，不做持续跟踪；
/// * 请求天气前把坐标粗化到约 5 km——天气不需要知道你在哪个门牌；
/// * 天气查询必须联网（设备上没有气象数据源），这是 WeatherKit 的前提。
///
/// 任何一步失败都返回带说明的 `.unknown`，由上层退回手动场景——天气是
/// 增益不是依赖，为它崩掉或卡住推荐页是最不该犯的错。
@MainActor
struct WeatherKitWeatherService: WeatherServing {

    /// 位置服务与缓存在 `current()` 里现用现建：类型本身是值语义的壳，没有
    /// 需要跨调用保住的状态（缓存落在 UserDefaults 里）。
    init() {}

    func current() async -> WeatherContext {
        let cache = WeatherCache()
        if let cached = cache.valid() {
            return cached
        }
        let locationManager = LocationOneShot()

        guard let location = await locationManager.oneShotLocation() else {
            return WeatherContext(
                scene: .unknown, temperatureCelsius: nil, isAutomatic: true,
                note: L("拿不到位置（未授权或暂时失败），先用手动选择的场景。")
            )
        }

        // 粗化到约 5 km 再出发。WeatherKit 要的是「附近的天气」，不是「你在哪」。
        let coarse = CLLocation(
            latitude: (location.coordinate.latitude * 20).rounded() / 20,
            longitude: (location.coordinate.longitude * 20).rounded() / 20
        )

        do {
            let weather = try await WeatherService.shared.weather(for: coarse)
            let current = weather.currentWeather
            let celsius = current.temperature.converted(to: .celsius).value
            let scene = WeatherScene.derive(
                temperatureCelsius: celsius,
                condition: current.condition.rawValue
            )
            let context = WeatherContext(scene: scene, temperatureCelsius: celsius,
                                         isAutomatic: true, note: nil)
            cache.store(context)
            return context
        } catch {
            AppLog.rag.error("weather failed: \(error.localizedDescription, privacy: .public)")
            return WeatherContext(
                scene: .unknown, temperatureCelsius: nil, isAutomatic: true,
                note: L("天气服务暂时不可用（需要在开发者后台为这个 App 开通 WeatherKit）。先用手动场景。")
            )
        }
    }
}

/// 场景缓存：一小时内不重复请求。天气一小时变不了几次，推荐页每次进都
/// 打一次服务才是浪费。
struct WeatherCache: Sendable {

    /// `UserDefaults` 本身线程安全（系统文档明确），这里只是持有一个引用。
    nonisolated(unsafe) private let defaults: UserDefaults
    private let maxAge: TimeInterval

    init(defaults: UserDefaults = .standard, maxAge: TimeInterval = 3600) {
        self.defaults = defaults
        self.maxAge = maxAge
    }

    private struct Payload: Codable {
        let scene: WeatherScene
        let temperatureCelsius: Double?
        let storedAt: Date
    }

    func valid() -> WeatherContext? {
        guard let data = defaults.data(forKey: PrefKey.weatherCache),
              let payload = try? JSONDecoder().decode(Payload.self, from: data),
              payload.storedAt.addingTimeInterval(maxAge) > Date()
        else { return nil }
        return WeatherContext(scene: payload.scene, temperatureCelsius: payload.temperatureCelsius,
                              isAutomatic: true, note: nil)
    }

    func store(_ context: WeatherContext) {
        guard let data = try? JSONEncoder().encode(
            Payload(scene: context.scene,
                    temperatureCelsius: context.temperatureCelsius,
                    storedAt: Date())
        ) else { return }
        defaults.set(data, forKey: PrefKey.weatherCache)
    }
}

/// 一次性定位。CLLocationManager 的 delegate 回调包成 async——整个 App
/// 只在「用户点了自动」这一刻用它，不常驻、不后台。
@MainActor
final class LocationOneShot: NSObject, CLLocationManagerDelegate {

    private var manager: CLLocationManager?
    private var continuation: CheckedContinuation<CLLocation?, Never>?

    /// 等一次定位。超时 8 秒：定位慢是很常见的事，推荐页不能陪它等。
    func oneShotLocation(timeout: TimeInterval = 8) async -> CLLocation? {
        let manager = CLLocationManager()
        manager.desiredAccuracy = kCLLocationAccuracyKilometer
        manager.delegate = self
        self.manager = manager

        return await withCheckedContinuation { continuation in
            self.continuation = continuation
            manager.requestWhenInUseAuthorization()
            manager.requestLocation()

            Task { [weak self] in
                try? await Task.sleep(for: .seconds(timeout))
                self?.finish(nil)
            }
        }
    }

    private func finish(_ location: CLLocation?) {
        continuation?.resume(returning: location)
        continuation = nil
    }

    nonisolated func locationManager(_ manager: CLLocationManager,
                                     didUpdateLocations locations: [CLLocation]) {
        Task { @MainActor in
            finish(locations.first)
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager,
                                     didFailWithError error: Error) {
        Task { @MainActor in
            finish(nil)
        }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        // 授权弹窗被拒时不会触发 didFailWithError，在这里收尾。
        guard manager.authorizationStatus == .denied || manager.authorizationStatus == .restricted else { return }
        Task { @MainActor in
            finish(nil)
        }
    }
}
