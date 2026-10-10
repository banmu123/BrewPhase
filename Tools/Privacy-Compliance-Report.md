# BrewPhase 隐私政策与 App Store 合规报告

日期：2026-10-10 · 基线：`78dc31c` · 本批未提交未推送（按规格等开发者确认）

---

## 一、数据处理审计结论（全部基于代码证据）

| 数据类型 | 存储位置 | 传输方式 | 第三方接收方 | 证据 |
|---|---|---|---|---|
| 咖啡豆资料/冲煮记录/风味记录（用户输入的文字与数字） | App 沙盒（SwiftData） | 无网络传输 | 无 | `Models/Bean.swift`、`Models/Brew.swift`、`Models/Tasting.swift`；导出走系统分享面板（`Services/ExportManager.swift`） |
| 豆子图片（用户拍摄/选取） | App 沙盒（`ImageStore` 本地文件） | 无网络传输 | 无 | `Services/ImageStore.swift` |
| 偏好设置 | 设备 UserDefaults | 无 | 无 | `Core/FlavorLibrary.swift`（PrefKey） |
| 隐私分析（基线/推荐/相似检索） | 设备上计算 | **零网络** | 无 | `RAG/Embedding/AppleSentenceEmbedding.swift`（Apple `NLEmbedding` 端侧）；`RAG/Rules/*` 规则引擎 |
| 风味预测（实验功能） | 设备上 Core ML 推理 | 零网络 | 无 | `ML/FlavorWindowPredictor.swift`；模型随包（`BrewPhase/*.bin`） |
| 唯一可选网络：Ollama | 不落地 | **仅当用户在高级设置自行配置后**：问题文本 + 检索片段发送到用户填写的地址（默认本机回环 `127.0.0.1:11434`） | 用户自己配置的服务；开发者不运行、不经过 | `RAG/Providers/OllamaClient.swift`（URLSession 仅此一处；默认关闭） |

**明确不存在**：账号体系、遥测/分析/广告、崩溃上报、远程配置、第三方 SDK（pbxproj 中 `XCRemoteSwiftPackageReference` 计数 = 0）、WebView。

**权限现状**（本批清理后）：
- 保留：`NSCameraUsageDescription`（拍照入口真实在用：`PhotoFieldView` → `CameraPicker`）；通知权限（保存第一包豆时请求一次，`NotificationManager.requestAuthorizationIfNeeded`）。
- 删除（过期声明）：`NSLocationWhenInUseUsageDescription`（天气功能已整批移除，`CLLocationManager` 零引用）；`NSPhotoLibraryUsageDescription`（照片选取走系统 `PhotosPicker`，无需权限）。
- 已知标注：`ITSAppUsesNonExemptEncryption = NO`（App Store 出口合规，已配置）。
- **过程说明**：期间曾误删在用的 CameraPicker，被编译器立即拦截并已恢复（`grep` 工具层误报零引用；以编译器为准）。

**审计不确定项（无）**：网络栈唯一入口 OllamaClient 的行为已逐行核读；除其外无任何 `URLSession`/`dataTask`/WebView。

## 二、修改与新增文件

| 文件 | 变更 |
|---|---|
| `docs/privacy.html` | **新增**：双语隐私政策页（12.2KB，零外部依赖，响应式，咖啡暖色系） |
| `docs/screenshots/*.png` ×10 | **重命名** `Docs/ → docs/`（GitHub Pages 要求小写 `docs` 目录；`git mv` 保留历史） |
| `BrewPhase/Shared/Utilities/AppLinks.swift` | **新增**：公开 URL 集中定义（唯一一处） |
| `BrewPhase/Features/Settings/MoreView.swift` | 关于卡片内新增「隐私政策」入口（系统 `Link` 打开 Safari，沿用现有样式） |
| `README.md` | **新增**（此前不存在）：最小化公开说明 + 隐私政策链接 |
| `BrewPhase.xcodeproj/project.pbxproj` | 删除 2 个过期权限声明（定位/相册，各 ×2 配置） |
| `BrewPhase/Shared/Components/CameraPicker.swift` | 无净变更（曾误删已恢复） |
| `Tools/Localization/strings.py` + 两份 .strings | 新键「隐私政策 / Privacy Policy」，857 键通过 |

## 三、隐私政策公开 URL 状态（如实）

| URL | 实测 | 说明 |
|---|---|---|
| `https://banmu123.github.io/BrewPhase/privacy.html` | **404（尚未发布）** | **需要开发者手动启用**：仓库 Settings → Pages → Source 选「Deploy from a branch」→ Branch 选 `main` + `/docs` → Save。启用后此链接即为本政策的正式入口，App 内与 README 指向的就是它 |
| 参考：`https://banmu123.github.io/BrewPing/privacy.html` | **200** | 证明该账号的 GitHub Pages 能力已可用、URL 模式一致；照做即可 |
| `https://github.com/banmu123/BrewPhase/blob/main/docs/privacy.html` | 内容可访问 | GitHub blob 页显示的是源码而非渲染网页，仅作临时核对，不作为正式入口 |

**App 内链接指向的是启用 Pages 后的正式 URL**——在启用之前它会 404。请务必在提交 App Store 前完成上面的启用步骤（一次性操作）。

## 四、App 内入口

- 位置：「更多 → 关于」卡片内，产品价值说明之下，一个「隐私政策 ↗」行（roast 色胶囊底，系统 `Link` 在 Safari 打开，带 VoiceOver 标签）。
- 实现：`AppLinks.privacyPolicy` 单点定义；中英文标题走既有本地化体系。

## 五、App Store Connect 手动核对清单（开发者填写）

1. **隐私政策 URL**：`https://banmu123.github.io/BrewPhase/privacy.html`（先完成第三节的手动启用，并浏览器实测 200）。
2. **App Privacy → 数据收集申报**：基于本报告审计，建议申报为「**未收集数据**（Data Not Collected）」。该结论依赖的事实：无任何分析/遥测/广告/崩溃上报 SDK（SPM 引用 0）；核心路径零网络请求；唯一的网络出口（Ollama）默认关闭、指向用户自配地址、且发送内容由用户触发——若你认为「用户主动配置的外部服务」仍需申报，则按「Data Not Linked to You」申报「其他数据类别」并在说明里注明 opt-in。
3. **第三方合作方**：无 SDK 级第三方处理者（无 SPM/CocoaPods 依赖）。系统框架（SwiftData/NaturalLanguage/Core ML/WeatherKit 已移除）不经开发者传输数据。
4. **出口合规**：`ITSAppUsesNonExemptEncryption = NO` 已配置， ASC 问题上按「仅使用豁免加密」作答即可。
5. **隐私政策入口**：已内置（更多 → 关于 → 隐私政策）；ASC 的 Privacy Policy URL 字段与 App 内指向同一地址。

## 六、仍需开发者补充/确认

1. **联系方式**：政策目前只提供 GitHub Issues 渠道（可核实）。如愿意公开邮箱，请把 `docs/privacy.html` 中「联系我们」一节补上一行（中英两处），并同步更新日期。
2. **GitHub Pages 启用**（第三节步骤）——只有你能操作。
3. 开发者身份表述：政策里写的是「BrewPhase 项目开发者」+ 仓库链接。若 ASC 卖家账户有正式主体名称（个人或公司），可自行替换页面里的对应表述。

## 七、验证结果

- 编译 + 全量测试：**341 项 0 失败**；警告仅 AppIntents 噪音 ×2。
- 本地化：857 键，generate/check 通过。
- HTML：UTF-8、无任何外部脚本/字体/CDN 引用（正则断言仅剩 GitHub 域链接）、11 个锚点与中英双版本全部就位、响应式（≤480px 适配）。
- `git diff` 审查：改动仅限上表文件；未触碰任何业务逻辑；`CameraPicker` 误删已被编译器拦截并恢复，最终无净变更。

## 八、边界说明

未提交、未推送（按规格等待确认）。未新增依赖/服务端/账号/遥测；未修改业务逻辑；`Docs → docs` 重命名通过 `git mv` 保留文件历史。
