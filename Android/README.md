# BrewPhase Android

BrewPhase 的原生 Android 客户端。Kotlin + Jetpack Compose + Room，业务规则以仓库
`main` 分支的 iOS 源码为基准逐项移植——**不是**照着重画一遍界面。

> 当前状态：可构建、可安装、核心咖啡业务（阶段 / 库存 / 冲煮 / 记录 / 画布 / 设置 /
> 提醒）已经落地并有单元测试；同步、备份、RAG、风味模型尚未移植。
> 逐项状态见 [`docs/IOS_PARITY_MATRIX.md`](docs/IOS_PARITY_MATRIX.md)，不要把矩阵里的
> `IMPLEMENTED` 当成 `TESTED`。

## 技术栈与版本

| 项 | 值 |
|---|---|
| 语言 | Kotlin 2.0.21 |
| UI | Jetpack Compose（BOM 2024.10.01）+ Material 3 基础组件 + BrewPhase 自有主题 |
| 本地库 | Room 2.6.1（KSP 2.0.21-1.0.28） |
| 偏好 | DataStore Preferences 1.1.1 |
| 异步 | Coroutines / Flow / StateFlow |
| 后台 | WorkManager 2.9.1（已引入，同步任务尚未使用） |
| 网络 | OkHttp 4.12.0 |
| JSON | Kotlinx Serialization 1.7.3 |
| 图片 | Coil 2.7.0 |
| 扫码 | CameraX 1.4.0 + ML Kit Barcode 17.3.0（已引入，配对页未实现） |
| 数据库版本 | v1（首次发布，无历史迁移） |
| minSdk / targetSdk / compileSdk | 26 / 35 / 35 |
| AGP / Gradle / JDK | 8.7.3 / 8.14 / 17 |

`minSdk 26` 的理由：Room + Compose + Media3 在这个区间都受支持，且 Android 8.0 以下
的设备在目标用户里已可忽略；再往下要为零星设备维护大量兼容分支，不划算。

## 构建

```bash
# 需要：JDK 17、Android SDK（platform 35 + build-tools 35）
# 1) 指向本机 SDK
echo "sdk.dir=/path/to/Android/Sdk" > local.properties

# 2) Debug APK
./gradlew :app:assembleDebug
# 产物：app/build/outputs/apk/debug/app-debug.apk

# 3) 单元测试
./gradlew :app:testDebugUnitTest
```

本仓库当前没有提交 Gradle wrapper 的二进制（`gradle-wrapper.jar`），因为生成它的
环境不允许写入二进制到版本库；用本机 Gradle 8.14 或 `gradle wrapper` 生成一次即可：

```bash
gradle wrapper --gradle-version 8.14
```

依赖源用官方 `google()` / `mavenCentral()`。**不要**换回国内镜像后直接跑：
阿里云镜像对 HEAD 请求返回 502，而 Gradle 解析插件依赖时依赖 HEAD，会把
KSP / AGP 的解析直接打断（POM 的 GET 反而是 200，很容易误判成版本不存在）。

## 工程结构

```text
Android/
├── app/src/main/java/com/brewphase/android/
│   ├── app/            AppContainer（手写依赖容器）
│   ├── core/           DateMath、TagCodec（U+001F 编码）
│   ├── data/
│   │   ├── local/      Room 实体、DAO、数据库、映射
│   │   ├── repository/ 豆 / 冲煮 / 记录 / 画布 / 设置
│   │   └── media/      媒体导入、预览、孤儿清理
│   ├── domain/
│   │   ├── model/      BeanSnapshot、BrewRecord、枚举（与 iOS rawValue 对齐）
│   │   └── engine/     PhaseEngine、BrewMath、StockLedger、ConsumptionEstimator、
│   │                   NotificationPlanner、BrewPrefill、LinkResolver
│   ├── feature/        coffee / bean / brew / records / canvas / settings / insights / ask
│   ├── navigation/     三个一级 Tab + 二级页面
│   ├── notifications/  AlarmManager + 通知渠道
│   └── ui/             主题 token、通用组件
├── app/src/test/       领域层单测（51 个用例）
└── docs/               对齐矩阵、字段映射、架构、已知限制
```

分层约定：**Compose 只渲染，ViewModel 持有页面状态，Repository 只有一个写入路径，
业务规则全在 `domain/engine` 的纯函数里**。UI 不碰 DAO。

## 设计

视觉语言沿用 iOS 的 *Quiet Coffee Atelier*：Paper `#F7F7F7`、Card `#FFFFFF`、Ink `#1F1B18`、
Espresso `#3B2A20`、Latte `#A9744F`、Moss `#5E7155`。层次靠间距、字重与 1px 细线建立，
不用彩色卡片墙和胶囊徽章。所有数值集中在 `ui/theme/Color.kt` 的 `BpColors`。

## 已经做到的 / 还没做的

见 [`docs/IOS_PARITY_MATRIX.md`](docs/IOS_PARITY_MATRIX.md)。三句话版本：

1. 咖啡核心（阶段、库存、冲煮、镜像品鉴、记录、画布、设置、提醒）已经能用，且有单测；
2. 同步、备份、导出、RAG、风味模型**没有**完成，界面上也没有假装完成；
3. UI 截图验收没做——本机没有模拟器系统镜像，无法真实启动应用截图。
