import PhotosUI
import SwiftUI

/// The bean's picture: take one, pick one, or remove it (§21).
///
/// The image is held in memory until the bean is saved, so cancelling an edit
/// leaves no file behind. 落盘与删旧的顺序由 `BeanEditorView.save()` 统一保证：
/// 先写新文件 → 落库成功 → 才删旧文件；任何一步失败，磁盘上的文件都还是
/// 库里指向的那一个。
struct PhotoFieldView: View {

    /// The file name already stored on the bean, if any.
    let storedName: String?
    /// An image picked during this editing session.
    @Binding var pickedImage: UIImage?
    /// Set when the user explicitly removes the picture.
    @Binding var isRemoved: Bool

    @State private var pickerItem: PhotosPickerItem?
    @State private var isShowingCamera = false

    private var previewImage: UIImage? {
        if let pickedImage { return pickedImage }
        guard !isRemoved else { return nil }
        return ImageStore.shared.image(named: storedName, thumbnail: true)
    }

    private var hasAnyImage: Bool { previewImage != nil }

    var body: some View {
        HStack(alignment: .center, spacing: 14) {
            preview

            VStack(alignment: .leading, spacing: 8) {
                Text(hasAnyImage ? "换一张" : "加一张包装照片")
                    .font(TypeScale.callout)
                    .foregroundStyle(Palette.inkSoft)

                HStack(spacing: 8) {
                    if CameraPicker.isAvailable {
                        actionButton("拍照", systemImage: "camera") { isShowingCamera = true }
                    }

                    PhotosPicker(selection: $pickerItem, matching: .images, photoLibrary: .shared()) {
                        Self.actionLabel("相册", systemImage: "photo")
                    }
                    .buttonStyle(.plain)
                }
            }

            Spacer(minLength: 0)
        }
        .onChange(of: pickerItem) { _, newValue in
            guard let newValue else { return }
            Task {
                if let data = try? await newValue.loadTransferable(type: Data.self),
                   let image = UIImage(data: data) {
                    await MainActor.run {
                        withAnimation(Motion.quick) {
                            pickedImage = image
                            isRemoved = false
                        }
                    }
                }
            }
        }
        .sheet(isPresented: $isShowingCamera) {
            CameraPicker { image in
                withAnimation(Motion.quick) {
                    pickedImage = image
                    isRemoved = false
                }
            }
            .ignoresSafeArea()
        }
    }

    private var preview: some View {
        ZStack {
            if let previewImage {
                Image(uiImage: previewImage)
                    .resizable()
                    .scaledToFill()
            } else {
                Palette.well
                Image(systemName: "camera")
                    .font(.system(size: 20, weight: .light))
                    .foregroundStyle(Palette.latte)
            }

            if hasAnyImage {
                VStack {
                    Spacer()
                    Button {
                        withAnimation(Motion.quick) {
                            pickedImage = nil
                            isRemoved = true
                        }
                    } label: {
                        Text("移除")
                            .font(TypeScale.micro)
                            .foregroundStyle(Palette.card)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 4)
                            .background(.black.opacity(0.42))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .frame(width: 74, height: 74)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(Palette.hairline, lineWidth: 0.7)
        )
    }

    private func actionButton(_ title: LocalizedStringKey, systemImage: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { Self.actionLabel(title, systemImage: systemImage) }
            .buttonStyle(.plain)
    }

    /// The capsule both buttons wear.
    ///
    /// `nonisolated static` rather than a method on the view, and the reason is not
    /// style. `View` is a `@MainActor` protocol, so **every** member of a type that
    /// conforms to it is inferred to be main-actor isolated — including this one.
    /// `PhotosPicker`'s `label:` parameter, on the other hand, is
    /// `@Sendable () -> Label`, which does not inherit the enclosing actor, so the
    /// closure is a nonisolated context and cannot call into this view at all.
    ///
    /// `nonisolated` opts the function back out, and `static` keeps it from
    /// capturing `self` — which a `@Sendable` closure could not have done anyway.
    /// Nothing here needs the actor: it only builds `Text`, `Image` and `Capsule`,
    /// whose own initialisers are not isolated.
    nonisolated static func actionLabel(_ title: LocalizedStringKey, systemImage: String) -> some View {
        HStack(spacing: 5) {
            Image(systemName: systemImage)
                .font(.system(size: 12, weight: .semibold))
            Text(title)
                .font(TypeScale.caption.weight(.medium))
                .lineLimit(1)
        }
        .foregroundStyle(Palette.roast)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Capsule(style: .continuous).fill(Palette.cream.opacity(0.6)))
        // Without this the buttons get squeezed and "Camera" wraps onto two lines.
        .fixedSize()
    }
}
