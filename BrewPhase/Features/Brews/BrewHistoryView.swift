import SwiftData
import SwiftUI

/// 冲煮 — every brew ever recorded, newest first (§26).
///
/// Grouped by month because that is the unit a drinker actually thinks in
/// ("this month I've been drinking X"), and sorted by time rather than by bean,
/// which is the opposite of the cellar on purpose.
struct BrewHistoryView: View {

    @Environment(\.modelContext) private var context
    @Query(sort: \Brew.date, order: .reverse) private var brews: [Brew]

    @State private var editingBrew: Brew?
    /// 待删除的记录：删除一律先过确认框，长按菜单不再直接删。
    @State private var pendingDelete: Brew?
    @State private var actionError: String?

    private var months: [(key: String, brews: [Brew])] {
        var order: [String] = []
        var buckets: [String: [Brew]] = [:]
        for brew in brews {
            let key = monthKey(brew.date)
            if buckets[key] == nil {
                buckets[key] = []
                order.append(key)
            }
            buckets[key]?.append(brew)
        }
        return order.map { ($0, buckets[$0] ?? []) }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                if brews.isEmpty {
                    Card(lifted: true) {
                        EmptyStateView(
                            symbol: "cup.and.saucer",
                            title: "还没有冲煮记录",
                            message: "去豆仓挑一包，冲完记下参数和味道，这里就会长起来。"
                        )
                    }
                    .padding(.horizontal, Metric.gutter)
                    .padding(.top, 8)
                } else {
                    LazyVStack(alignment: .leading, spacing: Metric.sectionGap) {
                        summary

                        ForEach(months, id: \.key) { group in
                            VStack(alignment: .leading, spacing: 12) {
                                SectionHeader(
                                    title: .alreadyLocalized(group.key),
                                    detail: .alreadyLocalized(L("%@ 次", String(group.brews.count)))
                                )

                                ForEach(group.brews) { brew in
                                    Button {
                                        editingBrew = brew
                                    } label: {
                                        Card(padding: 14) {
                                            BrewRow(brew: brew, showsBeanName: true)
                                        }
                                    }
                                    .buttonStyle(CardButtonStyle())
                                    .contextMenu {
                                        Button(role: .destructive) {
                                            pendingDelete = brew
                                        } label: {
                                            Label("删除这条记录", systemImage: "trash")
                                        }
                                    }
                                }
                            }
                        }
                    }
                    .padding(.horizontal, Metric.gutter)
                    .padding(.top, 8)
                    .padding(.bottom, 32)
                }
            }
            .background(Palette.paper)
            .navigationTitle("冲煮")
            .navigationBarTitleDisplayMode(.large)
            .sheet(item: $editingBrew) { brew in
                if let bean = brew.bean {
                    BrewEditorView(bean: bean, existing: brew)
                }
            }
            // 删除失败时记录还在，必须说出来——默默失败会被当成「删掉了」。
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
            .confirmationDialog(
                "删除这条冲煮记录？",
                isPresented: Binding(
                    get: { pendingDelete != nil },
                    set: { if !$0 { pendingDelete = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button("删除", role: .destructive) {
                    if let brew = pendingDelete { delete(brew) }
                    pendingDelete = nil
                }
                Button("取消", role: .cancel) { pendingDelete = nil }
            } message: {
                Text("删除后不可恢复。这杯用掉的粉会回到原来那包豆的库存里。")
            }
        }
    }

    /// Three numbers that make the tab worth opening even when you are not
    /// looking for a specific brew.
    private var summary: some View {
        HStack(spacing: 0) {
            stat(String(brews.count), "总次数")
            divider
            stat(averageScore, "平均评分")
            divider
            stat(mostUsedMethod, "最常用")
        }
        .padding(.vertical, 14)
        .padding(.horizontal, 18)
        .frame(maxWidth: .infinity)
        .background(
            RoundedRectangle(cornerRadius: Metric.radius, style: .continuous)
                .fill(Palette.card)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Metric.radius, style: .continuous)
                .strokeBorder(Palette.hairline.opacity(0.9), lineWidth: 0.7)
        )
    }

    private func stat(_ value: String, _ label: LocalizedStringKey) -> some View {
        VStack(spacing: 4) {
            Text(verbatim: value)
                .font(TypeScale.numeral)
                .foregroundStyle(Palette.ink)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Text(label)
                .font(TypeScale.micro)
                .foregroundStyle(Palette.inkFaint)
        }
        .frame(maxWidth: .infinity)
    }

    private var divider: some View {
        Rectangle()
            .fill(Palette.hairline)
            .frame(width: 0.7, height: 26)
    }

    private var averageScore: String {
        let scored = brews.filter { $0.score > 0 }
        guard !scored.isEmpty else { return "—" }
        let total = scored.reduce(0) { $0 + $1.score }
        return String(format: "%.1f", Double(total) / Double(scored.count))
    }

    private var mostUsedMethod: String {
        let counts = brews.reduce(into: [String: Int]()) { result, brew in
            let key = brew.method.trimmed
            guard !key.isEmpty else { return }
            result[key, default: 0] += 1
        }
        return counts.max { $0.value < $1.value }?.key ?? "—"
    }

    /// The grouping key *is* the printed heading, which is safe here because a
    /// single render formats every date in the same language — the key never has
    /// to survive a language change.
    private func monthKey(_ date: Date) -> String {
        Fmt.monthHeading(date)
    }

    /// Deleting a brew undoes it: the coffee goes back into the bag and the
    /// timeline node it created goes with it. 唯一的写入路径是 `BrewRecorder`，
    /// 失败时它已经回滚过了，这里只负责把失败说出来。
    private func delete(_ brew: Brew) {
        do {
            try BrewRecorder.delete(brew, in: context)
        } catch let failure as BrewRecorder.Failure {
            actionError = failure.message
        } catch {
            actionError = L("没能删除，请再试一次")
        }
    }
}
