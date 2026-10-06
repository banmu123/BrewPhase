import SwiftData
import SwiftUI

/// 风味窗口规则 (§18).
///
/// The windows the engine obeys, editable per roast level. Two things matter
/// here: the numbers are shown as a range that reads like the loose guidance it
/// is, and every change is previewed back as a phase track so the effect on a
/// bag is obvious before you leave the screen.
struct PhaseRulesView: View {

    @Environment(\.modelContext) private var context
    @Query private var rules: [PhaseRule]

    @State private var revision = 0
    @State private var isConfirmingReset = false
    @State private var actionError: String?
    /// 五个独立参数收进「高级阶段规则」。普通模式只看三段生命周期。
    @State private var showsAdvancedRules = false

    private var book: PhaseRuleBook { PhaseRuleBook.make(stored: rules) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Metric.sectionGap) {
                intro

                // 普通模式：用户在设置咖啡的生命周期，不是在调数学模型。
                // 三个阶段用一句话各占一行，能改的数字都在下面的高级区。
                ForEach(RoastLevel.pickerOrder) { level in
                    lifecycleCard(level)
                }

                advancedSection
                resetSection
            }
            .padding(.horizontal, Metric.gutter)
            .padding(.top, 8)
            .padding(.bottom, 40)
        }
        .background(Palette.paper)
        .navigationTitle("阶段规则")
        .navigationBarTitleDisplayMode(.inline)
        .id(revision)
        .onDisappear {
            // Reminders were planned from the old windows; re-plan them once,
            // when the user has finished fiddling, rather than on every tap.
            Task { await rescheduleAffectedBeans() }
        }
        .confirmationDialog("恢复默认窗口？", isPresented: $isConfirmingReset, titleVisibility: .visible) {
            Button("恢复默认", role: .destructive) {
                do {
                    try PhaseRuleBook.resetToDefaults(context: context)
                } catch {
                    actionError = L("没能保存下来，请再试一次")
                }
                revision += 1
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text("会把你改过的所有烘焙度都改回默认值。")
        }
        .alert(
            "没能保存",
            isPresented: Binding(
                get: { actionError != nil },
                set: { if !$0 { actionError = nil } }
            )
        ) {
            Button("好") { actionError = nil }
        } message: {
            Text(actionError ?? "")
        }
    }

    private var intro: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("这些数字只是估算")
                .font(TypeScale.title)
                .foregroundStyle(Palette.ink)
            Text(L("不同豆子、不同烘焙曲线都会不一样。下面是「%@」，改到符合你自己的经验就好。",
                   DefaultPhaseRules.disclaimer))
                .font(TypeScale.callout)
                .foregroundStyle(Palette.inkSoft)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.top, 4)
    }

    // MARK: - One level

    /// 普通模式的三行：养豆期、黄金风味期、风味衰减。数字是既有的
    /// `PhaseRuleData` 推出来的，这里只负责把它说得像人话。
    private func lifecycleCard(_ level: RoastLevel) -> some View {
        let data = book.rule(for: level)
        let isCustomized = !data.matchesDefaults()

        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Text(verbatim: level.label)
                    .font(TypeScale.title)
                    .foregroundStyle(Palette.ink)
                if isCustomized {
                    Chip(text: L("已自定义"), tint: Palette.roast, background: Palette.cream.opacity(0.6))
                }
                Spacer(minLength: 0)
            }

            Card(padding: 0) {
                VStack(spacing: 0) {
                    lifecycleRow("养豆期", L("%@–%@ 天", String(data.restMinDays), String(data.restMaxDays)))
                    CardDivider()
                    lifecycleRow("黄金风味期", L("%@–%@ 天", String(data.peakStartDay), String(data.peakEndDay)))
                    CardDivider()
                    lifecycleRow("风味衰减", L("%@ 天后", String(data.declineStartDay)), showsDivider: false)
                }
            }
        }
    }

    private func lifecycleRow(_ label: LocalizedStringKey, _ value: String, showsDivider: Bool = true) -> some View {
        VStack(spacing: 0) {
            HStack {
                Text(label)
                    .font(TypeScale.body)
                    .foregroundStyle(Palette.ink)
                Spacer(minLength: 8)
                Text(verbatim: value)
                    .font(TypeScale.numeral)
                    .foregroundStyle(Palette.roast)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 13)

            if showsDivider { CardDivider() }
        }
    }

    /// 五个独立参数收在这里。默认折着——它们是给「确实想校准」的人准备的。
    private var advancedSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button {
                withAnimation(Motion.settle) { showsAdvancedRules.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Text("高级阶段规则")
                        .font(TypeScale.callout)
                        .foregroundStyle(Palette.inkSoft)
                    Image(systemName: showsAdvancedRules ? "chevron.up" : "chevron.down")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Palette.inkFaint)
                    Spacer(minLength: 0)
                }
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 4)

            if showsAdvancedRules {
                Text("修改这些参数会影响 BrewPhase 对咖啡阶段的判断。")
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.inkSoft)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 4)

                ForEach(RoastLevel.pickerOrder) { level in
                    levelCard(level)
                }
            }
        }
    }

    private func levelCard(_ level: RoastLevel) -> some View {
        let data = book.rule(for: level)
        let isCustomized = !data.matchesDefaults()

        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Text(verbatim: level.label)
                    .font(TypeScale.title)
                    .foregroundStyle(Palette.ink)
                if isCustomized {
                    Chip(text: L("已自定义"), tint: Palette.roast, background: Palette.cream.opacity(0.6))
                }
                Spacer(minLength: 0)
            }

            Card(padding: 0) {
                VStack(spacing: 0) {
                    ruleStepper(level: level, data: data, label: "排气开始", keyPath: \.restMinDays, range: 0...60)
                    ruleStepper(level: level, data: data, label: "排气结束", keyPath: \.restMaxDays, range: 0...60)
                    ruleStepper(level: level, data: data, label: "窗口开始", keyPath: \.peakStartDay, range: 1...120)
                    ruleStepper(level: level, data: data, label: "窗口结束", keyPath: \.peakEndDay, range: 2...180)
                    ruleStepper(level: level, data: data, label: "衰退起点", keyPath: \.declineStartDay, range: 2...180,
                                showsDivider: false)
                }
            }

            preview(level: level, data: data)
        }
    }

    /// Live feedback: the same track the home screen draws, for a typical bag of
    /// this level sitting at the halfway point of its window.
    private func preview(level: RoastLevel, data: PhaseRuleData) -> some View {
        let normalized = data.normalized()
        let bounds = PhaseEngine.boundaries(for: normalized)
        let midpoint = (bounds.peakStart + bounds.peakEnd) / 2
        let snapshot = BeanSnapshot(
            name: level.label,
            roastLevel: level,
            roastDate: DateMath.add(days: -midpoint, to: Date()),
            weightG: 200,
            remainingG: 120
        )
        let reading = PhaseEngine.reading(for: snapshot, rule: normalized)

        return VStack(alignment: .leading, spacing: 7) {
            PhaseTrack(reading: reading, showsMarker: true, showsLegend: true)
            Text(L("排气 %@–%@ 天 · 窗口第 %@–%@ 天 · 第 %@ 天开始衰减",
                   String(normalized.restMinDays), String(normalized.restMaxDays),
                   String(bounds.peakStart), String(bounds.peakEnd), String(bounds.peakEnd)))
                .font(TypeScale.caption)
                .foregroundStyle(Palette.inkFaint)
        }
        .padding(.horizontal, 4)
    }

    // MARK: - Stepper

    private func ruleStepper(
        level: RoastLevel,
        data: PhaseRuleData,
        label: LocalizedStringKey,
        keyPath: WritableKeyPath<PhaseRuleData, Int>,
        range: ClosedRange<Int>,
        showsDivider: Bool = true
    ) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Text(label)
                    .font(TypeScale.body)
                    .foregroundStyle(Palette.inkSoft)
                Spacer(minLength: 8)

                Text(L("%@ 天", String(data[keyPath: keyPath])))
                    .font(TypeScale.numeral)
                    .foregroundStyle(Palette.ink)
                    .frame(minWidth: 56, alignment: .trailing)

                HStack(spacing: 6) {
                    stepButton(systemImage: "minus", isEnabled: data[keyPath: keyPath] > range.lowerBound) {
                        var updated = data
                        updated[keyPath: keyPath] = max(range.lowerBound, data[keyPath: keyPath] - 1)
                        apply(updated, to: level)
                    }
                    stepButton(systemImage: "plus", isEnabled: data[keyPath: keyPath] < range.upperBound) {
                        var updated = data
                        updated[keyPath: keyPath] = min(range.upperBound, data[keyPath: keyPath] + 1)
                        apply(updated, to: level)
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .frame(minHeight: 50)

            if showsDivider { CardDivider() }
        }
    }

    private func stepButton(systemImage: String, isEnabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(isEnabled ? Palette.roast : Palette.inkFaint.opacity(0.5))
                .frame(width: 32, height: 32)
                .background(Circle().fill(Palette.well))
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled)
    }

    // MARK: - Reset

    private var resetSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SecondaryButton(title: "全部恢复默认", systemImage: "arrow.counterclockwise") {
                isConfirmingReset = true
            }
            Text("默认值：浅烘 7–28 天 · 中烘 5–21 天 · 中深烘 / 深烘 3–14 天 · 意式拼配 7–21 天。")
                .font(TypeScale.caption)
                .foregroundStyle(Palette.inkFaint)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 4)
        }
    }

    // MARK: - Writing

    private func apply(_ data: PhaseRuleData, to level: RoastLevel) {
        let normalized = data.normalized()
        let row = rules.first(where: { $0.roastLevel == level })
        let previous = row?.data
        if let row {
            row.apply(normalized)
        } else {
            context.insert(PhaseRule(data: normalized))
        }
        do {
            try context.save()
        } catch {
            // 行内编辑的失败也要看得见：回滚插入/删除、把这一行的数字写回旧值
            // （rollback 撤不回属性改动，实测），`revision` 触发一次重建把写回
            // 的值画出来，再把失败说出来。
            AppLog.store.error("rule save failed: \(error.localizedDescription, privacy: .public)")
            context.rollback()
            if let row, let previous { row.apply(previous) }
            actionError = L("没能保存下来，请再试一次")
            revision += 1
            return
        }
        revision += 1
    }

    private func rescheduleAffectedBeans() async {
        let beans = (try? context.fetch(FetchDescriptor<Bean>())) ?? []
        let book = PhaseRuleBook.make(stored: rules)
        await NotificationManager.shared.refreshAll(beans: beans, book: book, context: context)
    }
}
