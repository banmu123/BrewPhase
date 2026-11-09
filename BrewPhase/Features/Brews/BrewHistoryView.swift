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
        // 这一页现在是咖啡页里的一个推入目标，不再自己拥有导航栈：外面已经
        // 有一层，套第二层会长出第二条导航栏。
        ScrollView {
            if brews.isEmpty {
                EmptyStateView(
                    symbol: "cup.and.saucer",
                    title: "还没有冲煮记录",
                    message: "去豆仓挑一包，冲完记下参数和味道，这里就会长起来。"
                )
                .padding(.horizontal, Metric.gutter)
                .padding(.top, 60)
            } else {
                LazyVStack(alignment: .leading, spacing: 0) {
                    summary

                    ForEach(months, id: \.key) { group in
                        VStack(alignment: .leading, spacing: 0) {
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                SectionLabel(title: .alreadyLocalized(group.key))
                                Spacer(minLength: 0)
                                Text(L("%@ 次", String(group.brews.count)))
                                    .font(TypeScale.caption)
                                    .foregroundStyle(Palette.inkFaint)
                            }
                            .padding(.top, 28)

                            ForEach(Array(group.brews.enumerated()), id: \.element.id) { index, brew in
                                Button {
                                    editingBrew = brew
                                } label: {
                                    BrewRow(brew: brew, showsBeanName: true)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .padding(.vertical, 13)
                                }
                                .buttonStyle(.plain)
                                .contextMenu {
                                    Button(role: .destructive) {
                                        pendingDelete = brew
                                    } label: {
                                        Label("删除这条记录", systemImage: "trash")
                                    }
                                }

                                if index != group.brews.count - 1 {
                                    CardDivider()
                                }
                            }
                        }
                    }
                }
                .padding(.horizontal, Metric.gutter)
                .padding(.top, 4)
                .padding(.bottom, 40)
            }
        }
        .background(Palette.paper)
        .navigationTitle("冲煮")
        .navigationBarTitleDisplayMode(.inline)
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
            Text(deleteExplanation)
        }
    }

    /// Three numbers that make the tab worth opening even when you are not
    /// looking for a specific brew. No card: they sit on the page like a
    /// masthead, and one hairline below closes them.
    private var summary: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                stat(String(brews.count), "总次数")
                divider
                stat(averageScore, "平均评分")
                divider
                stat(mostUsedMethod, "最常用")
            }
            .padding(.top, 12)
            .padding(.bottom, 18)

            Hairline()
        }
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
        return Fmt.number(Double(total) / Double(scored.count))
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

    /// 删除前把后果说准：一般记录会退粉；已经被盘点结算的记录不会——
    /// 盘出来的数字是用户称的，删一条旧记录不能把它改掉。
    private var deleteExplanation: LocalizedStringKey {
        guard let brew = pendingDelete,
              let bean = brew.bean,
              brew.isSettledForStock(in: bean) else {
            return LocalizedStringKey("删除后不可恢复。这杯用掉的粉会回到原来那包豆的库存里。")
        }
        return LocalizedStringKey("删除后不可恢复。这次冲煮早于你最后一次盘点，库存不会再变动。")
    }

    /// Deleting a brew undoes it: the coffee it actually took goes back into the
    /// bag (unless a later stock count already settled it) and the timeline node
    /// it created goes with it. 唯一的写入路径是 `BrewRecorder`，失败时它已经
    /// 回滚过了，这里只负责把失败说出来。
    private func delete(_ brew: Brew) {
        do {
            // 库存变了，预计喝完日也跟着变——提醒要重排，否则那一杯的删除
            // 要等到下次启动才生效。
            if let bean = try BrewRecorder.delete(brew, in: context) {
                Task { await BrewRecorder.rescheduleReminders(for: bean, in: context) }
            }
        } catch let failure as BrewRecorder.Failure {
            actionError = failure.message
        } catch {
            actionError = L("没能删除，请再试一次")
        }
    }
}
