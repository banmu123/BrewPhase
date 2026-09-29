import SwiftUI

/// Picking flavour words (§15).
///
/// The shipped vocabulary is offered as one tap each; anything else can be typed
/// in and is kept alongside it. The distinction matters in the UI: built-in tags
/// are selectable chips, custom ones can be removed.
struct FlavorTagEditor: View {

    @Binding var tags: [String]

    @State private var draft = ""
    @FocusState private var isTyping: Bool

    private var customTags: [String] {
        tags.filter { !FlavorLibrary.isBuiltIn($0) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(FlavorLibrary.groups) { group in
                VStack(alignment: .leading, spacing: 7) {
                    Text(group.title)
                        .font(TypeScale.micro)
                        .foregroundStyle(Palette.inkFaint)
                    FlowLayout(spacing: 7, lineSpacing: 7) {
                        ForEach(group.tags, id: \.self) { tag in
                            SelectableTag(text: FlavorLibrary.displayName(for: tag),
                                          isOn: tags.contains(tag)) {
                                toggle(tag)
                            }
                        }
                    }
                }
            }

            if !customTags.isEmpty {
                VStack(alignment: .leading, spacing: 7) {
                    Text("自定义")
                        .font(TypeScale.micro)
                        .foregroundStyle(Palette.inkFaint)
                    FlowLayout(spacing: 7, lineSpacing: 7) {
                        ForEach(customTags, id: \.self) { tag in
                            CustomTag(text: FlavorLibrary.displayName(for: tag)) { remove(tag) }
                        }
                    }
                }
            }

            HStack(spacing: 8) {
                TextField("自己写一个", text: $draft)
                    .font(TypeScale.body)
                    .foregroundStyle(Palette.ink)
                    .focused($isTyping)
                    .submitLabel(.done)
                    .onSubmit(addDraft)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                    .background(
                        RoundedRectangle(cornerRadius: 11, style: .continuous)
                            .fill(Palette.well)
                    )

                Button(action: addDraft) {
                    Image(systemName: "plus")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(canAddDraft ? Palette.card : Palette.inkFaint)
                        .frame(width: 36, height: 36)
                        .background(
                            Circle().fill(canAddDraft ? Palette.roast : Palette.well)
                        )
                }
                .buttonStyle(.plain)
                .disabled(!canAddDraft)
            }
        }
    }

    private var canAddDraft: Bool {
        let text = draft.trimmed
        return !text.isEmpty && !tags.contains(text)
    }

    private func toggle(_ tag: String) {
        withAnimation(Motion.pop) {
            if let index = tags.firstIndex(of: tag) {
                tags.remove(at: index)
            } else {
                tags.append(tag)
            }
        }
    }

    private func remove(_ tag: String) {
        withAnimation(Motion.pop) {
            tags.removeAll { $0 == tag }
        }
    }

    private func addDraft() {
        let text = draft.trimmed
        guard !text.isEmpty, !tags.contains(text) else { return }
        withAnimation(Motion.pop) {
            tags.append(text)
            draft = ""
        }
    }
}

/// Read-only display of a set of tags, used on the detail page.
struct FlavorTagList: View {
    let tags: [String]
    var emptyText: LocalizedStringKey = "还没有标签"

    var body: some View {
        if tags.isEmpty {
            Text(emptyText)
                .font(TypeScale.callout)
                .foregroundStyle(Palette.inkFaint)
        } else {
            FlowLayout(spacing: 7, lineSpacing: 7) {
                ForEach(tags, id: \.self) { tag in
                    FlavorChip(text: FlavorLibrary.displayName(for: tag))
                }
            }
        }
    }
}
