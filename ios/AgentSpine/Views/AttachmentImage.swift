import SwiftUI
import UIKit

/// An image that was sent with a turn.
///
/// Not `AsyncImage`. The attachment route sits behind the dashboard token like every other
/// `/api` path, and `AsyncImage` takes a URL and can set no headers — which is exactly why
/// the web dashboard has to put `?token=` into every `<img src>` and then live with the
/// token sitting in the DOM. The app has no such constraint, so the bytes come through
/// `APIClient` with the header and the token never goes near a URL.
///
/// An id names one set of bytes forever, so the decoded image is cached in memory for the
/// life of the process. Scrolling back up a thread of photographs should not re-fetch them
/// over a tailnet.
struct AttachmentImage: View {
    let attachment: Attachment
    /// The side of the square. Set by the caller rather than fixed, because an outer
    /// `.frame` cannot shrink this one — it would centre an oversized view in a smaller
    /// slot and let it spill out of the row.
    var size: CGFloat = 150
    /// Whether tapping opens the full-screen viewer. Off for composer thumbnails, which are
    /// small, already carry a remove button, and show a picture you are still holding.
    var openable: Bool = true

    @State private var image: UIImage?
    @State private var failed = false
    @State private var viewing = false

    /// What VoiceOver reads. The filename when the server kept one, and the fact the vision
    /// pass skipped it when that is true, because "not read" is a visual badge otherwise.
    private var label: String {
        var parts = [attachment.name?.isEmpty == false ? attachment.name! : "Attached image"]
        if attachment.described == false { parts.append("not read by the assistant") }
        if failed { parts.append("could not be loaded") }
        return parts.joined(separator: ", ")
    }

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else if failed {
                // Named rather than blank: the bytes can genuinely be gone (a deleted
                // thread sweeps its files), and an empty grey box looks like a bug.
                VStack(spacing: 4) {
                    Image(systemName: "photo.badge.exclamationmark")
                    Text("not available").font(.caption2)
                }
                .foregroundStyle(.tertiary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ProgressView()
                    .controlSize(.small)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(width: size, height: size)
        .background(Color(.tertiarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: size > 100 ? 12 : 8))
        .overlay(alignment: .bottomTrailing) {
            // Whether the perception pass actually read this one. Worth showing: an image
            // the vision endpoint was down for was NOT looked at, and a thread that implied
            // otherwise would credit the assistant with having seen a photograph it did not.
            // Only at a size where it fits. On a composer thumbnail the badge would cover
            // the picture it is annotating, and a staged image has not been read yet
            // anyway — there is no run to have read it.
            if attachment.described == false, size > 100 {
                Label("not read", systemImage: "eye.slash")
                    .font(.caption2.weight(.semibold))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .background(.ultraThinMaterial, in: Capsule())
                    .foregroundStyle(.orange)
                    .padding(6)
            }
        }
        // A 150pt square of a photograph you took is a reminder that you sent it, not a
        // look at it. Tapping opens the real thing.
        .contentShape(Rectangle())
        .onTapGesture {
            guard openable, image != nil else { return }
            viewing = true
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityAddTraits(openable && image != nil ? .isButton : [])
        .accessibilityHint(openable && image != nil ? "Opens the full-size image" : "")
        .fullScreenCover(isPresented: $viewing) {
            if let image {
                AttachmentViewer(image: image, title: attachment.name)
            }
        }
        .task(id: attachment.id) { await load() }
    }

    private func load() async {
        if let cached = AttachmentCache.shared.image(for: attachment.id) {
            image = cached
            return
        }
        do {
            let data = try await APIClient.shared.attachmentData(attachment.id)
            guard let decoded = UIImage(data: data) else {
                failed = true
                return
            }
            AttachmentCache.shared.store(decoded, for: attachment.id)
            image = decoded
        } catch {
            failed = true
        }
    }
}

/// In-memory only, and deliberately so: these are photographs out of the user's own threads,
/// and `NSCache` drops them under pressure and keeps nothing on disk for a later process to
/// find. The server already treats an attachment as the most personal thing it stores.
@MainActor
final class AttachmentCache {
    static let shared = AttachmentCache()

    private let cache = NSCache<NSNumber, UIImage>()

    private init() {
        cache.countLimit = 60
    }

    func image(for id: Int) -> UIImage? { cache.object(forKey: NSNumber(value: id)) }

    func store(_ image: UIImage, for id: Int) {
        cache.setObject(image, forKey: NSNumber(value: id))
    }
}


/// A photograph, full screen, with pinch-to-zoom and pan.
///
/// Deliberately a `fullScreenCover` and not a sheet: a sheet keeps a strip of the thread
/// visible behind rounded corners, which is the wrong frame for looking at a picture. Black
/// background for the same reason — it is the only one that does not tint what you are
/// trying to see.
///
/// ## Why this is not a ScrollView
///
/// The obvious build — a `ScrollView` whose content frame grows with the zoom — does not
/// work for a fitted image, and fails in a way that looks like the picture vanishing. A
/// `scaledToFit` image inside a frame 2.5× the screen is still letterboxed inside *that*
/// frame, so the scroll view's origin lands in the black margin and the photograph is
/// somewhere off to the lower right. Zooming would appear to blank the screen.
///
/// So the image keeps its fitted size and is transformed instead: `scaleEffect` about the
/// centre, plus an offset the drag gesture moves. Both are clamped against the *fitted*
/// size — which has to be computed, since `scaledToFit` does not report it — so the picture
/// can never be flung somewhere you cannot get it back from.
struct AttachmentViewer: View {
    let image: UIImage
    let title: String?

    @Environment(\.dismiss) private var dismiss

    @State private var zoom: CGFloat = 1
    @State private var pan: CGSize = .zero
    /// Committed values, so a second gesture continues from where the first ended rather
    /// than snapping back and starting over.
    @State private var settledZoom: CGFloat = 1
    @State private var settledPan: CGSize = .zero

    private static let maxZoom: CGFloat = 6

    var body: some View {
        NavigationStack {
            GeometryReader { geometry in
                let fitted = fittedSize(in: geometry.size)

                Image(uiImage: image)
                    .resizable()
                    .frame(width: fitted.width, height: fitted.height)
                    .scaleEffect(zoom)
                    .offset(pan)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .contentShape(Rectangle())
                    .gesture(
                        MagnifyGesture()
                            .onChanged { value in
                                zoom = min(max(settledZoom * value.magnification, 1), Self.maxZoom)
                                pan = clamp(settledPan, zoom: zoom, fitted: fitted, container: geometry.size)
                            }
                            .onEnded { _ in
                                settledZoom = zoom
                                // Zooming back out can leave the image off-centre with
                                // margin on one side; re-clamping pulls it back.
                                pan = clamp(pan, zoom: zoom, fitted: fitted, container: geometry.size)
                                settledPan = pan
                            }
                    )
                    .simultaneousGesture(
                        DragGesture()
                            .onChanged { value in
                                guard zoom > 1 else { return }
                                let moved = CGSize(
                                    width: settledPan.width + value.translation.width,
                                    height: settledPan.height + value.translation.height
                                )
                                pan = clamp(moved, zoom: zoom, fitted: fitted, container: geometry.size)
                            }
                            .onEnded { _ in settledPan = pan }
                    )
                    .onTapGesture(count: 2) {
                        // Toggle, not step: one gesture, two states, no way to end up
                        // somewhere you cannot get back from.
                        withAnimation(.easeInOut(duration: 0.2)) {
                            if zoom > 1 {
                                zoom = 1
                                pan = .zero
                            } else {
                                zoom = 2.5
                            }
                            settledZoom = zoom
                            settledPan = pan
                        }
                    }
            }
            .background(.black)
            .navigationTitle(title ?? "")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    // Share, because the reason to open a photograph full screen is often
                    // to send it on. The system sheet decides where.
                    ShareLink(
                        item: Image(uiImage: image),
                        preview: SharePreview(title ?? "Image", image: Image(uiImage: image))
                    ) {
                        Image(systemName: "square.and.arrow.up")
                    }
                    .accessibilityLabel("Share this image")
                }
            }
            .toolbarBackground(.visible, for: .navigationBar)
        }
    }

    /// What `scaledToFit` would produce, computed because SwiftUI will not tell us and the
    /// pan limits are meaningless without it.
    private func fittedSize(in container: CGSize) -> CGSize {
        let size = image.size
        guard size.width > 0, size.height > 0, container.width > 0, container.height > 0 else {
            return container
        }
        let scale = min(container.width / size.width, container.height / size.height)
        return CGSize(width: size.width * scale, height: size.height * scale)
    }

    /// Keep the image overlapping the screen.
    ///
    /// The slack on each axis is however much the zoomed image overhangs the container,
    /// halved — beyond that you would be dragging the picture off the edge to look at black.
    /// An axis with no overhang is pinned to centre rather than left loose, which is what
    /// stops a portrait photograph sliding sideways in a landscape window.
    private func clamp(_ offset: CGSize, zoom: CGFloat, fitted: CGSize, container: CGSize) -> CGSize {
        let slackX = max(0, (fitted.width * zoom - container.width) / 2)
        let slackY = max(0, (fitted.height * zoom - container.height) / 2)
        return CGSize(
            width: min(max(offset.width, -slackX), slackX),
            height: min(max(offset.height, -slackY), slackY)
        )
    }
}
