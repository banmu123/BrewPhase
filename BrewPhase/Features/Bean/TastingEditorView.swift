import SwiftData
import SwiftUI

/// Adding a standalone flavour note.
///
/// Short on purpose: a day, a score, some words, some tags. This is the thing a
/// drinker does in ten seconds at the counter, and it is what fills the timeline
/// between brews.
struct TastingEditorView: View {

    let bean: Bean
    /// Pre-filled from the phase engine, so the user never has to count days.
    let today: Date

    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss

    @State private var date: Date
    @State private var score: Int = 0
    @State private var flavorTags: [String] = []
    @State private var notes: String = ""

    init(bean: Bean, today: Date = Date()) {
        self.bean = bean
        self.today = today
        _date = State(initialValue: today)
    }

    private var dayAfterRoast: Int {
        bean.dayAfterRoast(on: date) ?? 0
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    header

                    VStack(alignment: .leading, spacing: 10) {
                        SectionHeader(title: "这杯怎么样")
                        Card {
                            StarRatingInput(score: $score)
                        }
                    }

                    DateRowCard(title: "日期", date: $date, dayLabel: Fmt.day(dayAfterRoast))

                    VStack(alignment: .leading, spacing: 10) {
                        SectionHeader(title: "风味标签", detail: "可以以后再补")
                        Card {
                            FlavorTagEditor(tags: $flavorTags)
                        }
                    }

                    EditorSection(title: "一句话总结") {
                        EditorRow(showsDivider: false) {
                            EditorTextField(placeholder: "比如 甜感最明显，很干净", text: $notes)
                        }
                    }
                }
                .padding(.horizontal, Metric.gutter)
                .padding(.top, 8)
                .padding(.bottom, 40)
            }
            .background(Palette.paper)
            .navigationTitle("记一笔风味")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("取消") { dismiss() }
                        .foregroundStyle(Palette.inkSoft)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("保存") { save() }
                        .font(TypeScale.bodyMedium)
                        .foregroundStyle(Palette.roast)
                }
            }
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            BeanThumbnail(imageName: bean.imagePath, size: 40, cornerRadius: 10)
            VStack(alignment: .leading, spacing: 2) {
                Text(bean.name.isEmpty ? LocalizedStringKey("未命名") : .alreadyLocalized(bean.name))
                    .font(TypeScale.title)
                    .foregroundStyle(Palette.ink)
                Text(Fmt.day(dayAfterRoast))
                    .font(TypeScale.caption)
                    .foregroundStyle(Palette.inkFaint)
            }
            Spacer(minLength: 0)
        }
    }

    private func save() {
        let tasting = Tasting(
            date: date,
            dayAfterRoast: dayAfterRoast,
            flavorTags: flavorTags,
            score: BrewMath.clampScore(score),
            notes: notes.trimmed,
            source: .manual,
            bean: bean
        )
        context.insert(tasting)
        bean.touch()
        try? context.save()
        dismiss()
    }
}

/// A date row with an extra day label, for the tasting editor.
private struct DateRowCard: View {
    let title: LocalizedStringKey
    @Binding var date: Date
    let dayLabel: String

    var body: some View {
        EditorSection(title: title) {
            EditorRow(showsDivider: false) {
                Text(dayLabel)
                    .font(TypeScale.numeral)
                    .foregroundStyle(Palette.roast)
                Spacer(minLength: 8)
                // No locale of its own: the date picker follows the tree's
                // environment, which the app root sets to the chosen language.
                DatePicker("", selection: $date, displayedComponents: .date)
                    .labelsHidden()
                    .datePickerStyle(.compact)
            }
        }
    }
}
