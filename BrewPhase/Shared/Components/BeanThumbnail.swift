import SwiftUI

/// A bag's picture, or a quiet placeholder when there isn't one.
///
/// Reads from `ImageStore`'s cache synchronously: thumbnails are ~400px and are
/// decoded once, which is cheaper than the machinery an async loader would need
/// here (§38 — don't build infrastructure that isn't earning its keep).
struct BeanThumbnail: View {
    let imageName: String?
    var size: CGFloat = 58
    var cornerRadius: CGFloat = 14

    var body: some View {
        Group {
            if let image = ImageStore.shared.image(named: imageName, thumbnail: true) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                ZStack {
                    Palette.well
                    Image(systemName: "cup.and.saucer")
                        .font(.system(size: size * 0.32, weight: .light))
                        .foregroundStyle(Palette.latte.opacity(0.85))
                }
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .strokeBorder(Palette.hairline, lineWidth: 0.7)
        )
    }
}
