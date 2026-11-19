import AppKit
import SwiftUI

/// An image sent with a turn, or staged in the composer — the Mac's counterpart of the phone's
/// AttachmentImage (which is UIKit). The bytes come through APIClient with the token in a
/// header, never in a URL, and are cached in memory only: these are the user's own photos.
struct MacAttachmentImage: View {
    let attachment: Attachment
    var size: CGFloat = 150

    @State private var image: NSImage?
    @State private var failed = false

    var body: some View {
        Group {
            if let image {
                Image(nsImage: image).resizable().scaledToFill()
            } else if failed {
                VStack(spacing: 4) {
                    Image(systemName: "photo.badge.exclamationmark")
                    Text("not available").font(SpineFont.sans(Spine.TypeSize.caption - 1, relativeTo: .caption2))
                }
                .foregroundStyle(Spine.Palette.textFaint)
            } else {
                ProgressView().controlSize(.small)
            }
        }
        .frame(width: size, height: size)
        .background(Spine.Palette.bgInset)
        .clipShape(RoundedRectangle(cornerRadius: size > 100 ? 12 : 8))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(attachment.name?.isEmpty == false ? attachment.name! : "Attached image")
        .task(id: attachment.id) { await load() }
    }

    private func load() async {
        if let cached = MacAttachmentCache.shared.image(for: attachment.id) {
            image = cached
            return
        }
        do {
            let data = try await APIClient.shared.attachmentData(attachment.id)
            guard let decoded = NSImage(data: data) else {
                failed = true
                return
            }
            MacAttachmentCache.shared.store(decoded, for: attachment.id)
            image = decoded
        } catch {
            failed = true
        }
    }
}

@MainActor
final class MacAttachmentCache {
    static let shared = MacAttachmentCache()
    private let cache = NSCache<NSNumber, NSImage>()
    private init() { cache.countLimit = 60 }
    func image(for id: Int) -> NSImage? { cache.object(forKey: NSNumber(value: id)) }
    func store(_ image: NSImage, for id: Int) { cache.setObject(image, forKey: NSNumber(value: id)) }
}

/// Reading a chosen or dropped file and uploading it, for both the thread composer and the
/// new-thread one. Throws a message that already names the file.
enum MacImageUpload {
    struct Failure: LocalizedError {
        let errorDescription: String?
    }

    static func upload(_ url: URL, conversationID: Int) async throws -> Attachment {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let name = url.lastPathComponent
        let data: Data
        do { data = try Data(contentsOf: url) } catch {
            throw Failure(errorDescription: "\(name) could not be read.")
        }
        guard let mime = MacImageFormat.mime(for: data) else {
            throw Failure(errorDescription: "\(name) is not a PNG, JPEG, HEIC or WebP image.")
        }
        do {
            return try await APIClient.shared.uploadAttachment(
                conversationID: conversationID, data: data, mime: mime, name: name
            )
        } catch {
            throw Failure(errorDescription: "\(name): \(error.localizedDescription)")
        }
    }
}

/// The image format, read from the bytes themselves. The server sniffs the content too and
/// refuses anything but these four, so this only has to be right enough to not be contradicted.
/// Nil means "not an image the server takes".
enum MacImageFormat {
    static func mime(for data: Data) -> String? {
        let bytes = [UInt8](data.prefix(12))
        if bytes.starts(with: [0x89, 0x50, 0x4E, 0x47]) { return "image/png" }
        if bytes.starts(with: [0xFF, 0xD8, 0xFF]) { return "image/jpeg" }
        if bytes.count >= 12, Array(bytes[4..<8]) == Array("ftyp".utf8) {
            let brand = String(decoding: bytes[8..<12], as: UTF8.self)
            if brand.hasPrefix("hei") || brand.hasPrefix("mif") { return "image/heic" }
        }
        if bytes.count >= 12, Array(bytes[0..<4]) == Array("RIFF".utf8), Array(bytes[8..<12]) == Array("WEBP".utf8) {
            return "image/webp"
        }
        return nil
    }
}
