import SwiftUI

/// An assistant reply, rendered as the markdown it is.
///
/// ## Why this is a block renderer and not one `Text`
///
/// Two things had to be fixed, and only one of them is obvious.
///
/// The obvious one: `Text("**bold**")` parses markdown only for a *literal*. Handed a
/// `String` variable it renders the asterisks, which is what this app did until recently —
/// every reply arrived with its bold and backticks showing as punctuation.
///
/// The one that bites next: `AttributedString(markdown:)` fixes inline styling and nothing
/// else. Foundation's parser does no block layout at all — a heading keeps its `#`, a quote
/// keeps its `>`, a fenced block keeps its backticks, and a list collapses onto one line
/// unless you ask for `inlineOnlyPreservingWhitespace`. Stripping those markers, which is
/// what this file did first, buys legibility at the cost of structure: a reply whose
/// headings read as ordinary sentences is a wall of text with the signposts filed off.
///
/// So the text is split into blocks here and each is laid out as itself, with Foundation
/// doing only what it is good at — the inline run inside one block.
///
/// ## What is deliberately not supported
///
/// Tables, nested block quotes, reference links, and footnotes. An assistant reply on a
/// phone does not use them, and each would cost more than it returns. Anything unrecognised
/// falls through as a paragraph with its inline styling applied, so a construct this parser
/// has never heard of degrades to readable text rather than to nothing.
struct MarkdownText: View {
    private let blocks: [Block]
    private let compact: Bool

    /// `compact` is for the places a reply is quoted rather than read — a delegated unit's
    /// summary inside a collapsed card. Everything shrinks together, so a heading there is
    /// still visibly a heading without taking over the card it sits in.
    init(_ text: String, compact: Bool = false) {
        self.blocks = BlockCache.shared.blocks(for: text)
        self.compact = compact
    }

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 5 : 9) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                view(for: block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
    }

    // MARK: - Rendering

    @ViewBuilder private func view(for block: Block) -> some View {
        switch block {
        case .code(let source):
            // Horizontally scrollable rather than wrapped: a wrapped line of code is harder
            // to read than one you have to push sideways, and indentation is information.
            ScrollView(.horizontal, showsIndicators: false) {
                Text(source)
                    .font(.system(compact ? .caption2 : .caption, design: .monospaced))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(9)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(.tertiarySystemBackground), in: RoundedRectangle(cornerRadius: 8))

        case .heading(let level, let text):
            Text(Self.inline(text))
                .font(headingFont(level))
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                // Pulls the heading away from the block above without stranding it from the
                // block below, which is the one it belongs to.
                .padding(.top, compact ? 2 : 5)

        case .list(let items):
            VStack(alignment: .leading, spacing: compact ? 3 : 5) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .firstTextBaseline, spacing: 7) {
                        Text(item.marker)
                            .font(baseFont.monospacedDigit())
                            .foregroundStyle(.secondary)
                        Text(Self.inline(item.text))
                            .font(baseFont)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(.leading, CGFloat(item.depth) * 16)
                }
            }

        case .paragraph(let text):
            Text(Self.inline(text))
                .font(baseFont)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)

        case .quote(let text):
            HStack(alignment: .top, spacing: 9) {
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(Color.accentColor.opacity(0.45))
                    .frame(width: 3)
                Text(Self.inline(text))
                    .font(baseFont)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .fixedSize(horizontal: false, vertical: true)

        case .rule:
            Divider()
        }
    }

    private var baseFont: Font { compact ? .footnote : .body }

    /// Three sizes, not six. `####` and deeper are rare in a reply and a fourth step would
    /// be indistinguishable from the body text it sits above.
    private func headingFont(_ level: Int) -> Font {
        if compact { return .footnote.weight(.bold) }
        switch level {
        case 1: return .title3.weight(.semibold)
        case 2: return .headline
        default: return .subheadline.weight(.semibold)
        }
    }

    /// Inline styling for the text of one block — bold, italic, code spans, links.
    ///
    /// `inlineOnlyPreservingWhitespace` keeps the soft line breaks inside a paragraph, which
    /// matters because the blocks were split on blank lines, not on every newline. Parsing
    /// is best-effort: a malformed run comes back partially parsed, and a complete failure
    /// falls back to the raw text, because a reply you can read with stray asterisks beats
    /// an empty bubble.
    static func inline(_ raw: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            allowsExtendedAttributes: true,
            interpretedSyntax: .inlineOnlyPreservingWhitespace,
            failurePolicy: .returnPartiallyParsedIfPossible
        )
        return (try? AttributedString(markdown: raw, options: options)) ?? AttributedString(raw)
    }
}

// MARK: - Parsing

extension MarkdownText {
    struct ListItem: Equatable {
        let depth: Int
        let marker: String
        let text: String
    }

    enum Block: Equatable {
        case code(String)
        case heading(level: Int, text: String)
        case list(items: [ListItem])
        case paragraph(String)
        case quote(String)
        case rule

        /// Line-at-a-time, because that is how markdown's block syntax is actually defined
        /// and because a reply is never long enough for anything cleverer to pay for itself.
        ///
        /// Consecutive lines of the same kind join into one block: three `- ` lines are one
        /// list, not three, and two prose lines are one paragraph with a soft break between
        /// them. A blank line ends whatever is open.
        static func parse(_ raw: String) -> [Block] {
            var blocks: [Block] = []
            var paragraph: [String] = []
            var items: [ListItem] = []
            var quote: [String] = []
            var code: [String] = []
            var inFence = false

            func flushParagraph() {
                if !paragraph.isEmpty {
                    blocks.append(.paragraph(paragraph.joined(separator: "\n")))
                    paragraph = []
                }
            }
            func flushList() {
                if !items.isEmpty {
                    blocks.append(.list(items: items))
                    items = []
                }
            }
            func flushQuote() {
                if !quote.isEmpty {
                    blocks.append(.quote(quote.joined(separator: "\n")))
                    quote = []
                }
            }
            /// Everything except the one kind about to be appended to.
            func flushAll(except keep: String = "") {
                if keep != "paragraph" { flushParagraph() }
                if keep != "list" { flushList() }
                if keep != "quote" { flushQuote() }
            }

            for line in raw.components(separatedBy: .newlines) {
                let trimmed = line.trimmingCharacters(in: .whitespaces)

                // A fence swallows everything until it closes, markers and all: a `#` inside
                // a code block is code, not a heading.
                if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                    if inFence {
                        blocks.append(.code(code.joined(separator: "\n")))
                        code = []
                        inFence = false
                    } else {
                        flushAll()
                        inFence = true
                    }
                    continue
                }
                if inFence {
                    code.append(line)
                    continue
                }

                if trimmed.isEmpty {
                    flushAll()
                    continue
                }

                // `---`, `***`, `___` — but only as a rule, never a `--- text` that happens
                // to start the same way.
                if trimmed.count >= 3, trimmed.allSatisfy({ $0 == "-" || $0 == "*" || $0 == "_" }) {
                    flushAll()
                    blocks.append(.rule)
                    continue
                }

                if trimmed.hasPrefix("#") {
                    let hashes = trimmed.prefix { $0 == "#" }
                    let rest = trimmed.dropFirst(hashes.count)
                    // ATX requires a space after the hashes. Without one it is not a
                    // heading — `#1 priority` is prose, and treating it as a heading is the
                    // sort of wrong that looks deliberate.
                    if rest.hasPrefix(" ") {
                        flushAll()
                        blocks.append(.heading(
                            level: min(hashes.count, 3),
                            text: rest.trimmingCharacters(in: .whitespaces)
                        ))
                        continue
                    }
                }

                if trimmed.hasPrefix(">") {
                    flushAll(except: "quote")
                    quote.append(trimmed.dropFirst().trimmingCharacters(in: .whitespaces))
                    continue
                }

                if let item = listItem(line) {
                    flushAll(except: "list")
                    items.append(item)
                    continue
                }

                flushAll(except: "paragraph")
                paragraph.append(trimmed)
            }

            if inFence, !code.isEmpty {
                // An unclosed fence is a truncated reply, not a reason to drop the code.
                blocks.append(.code(code.joined(separator: "\n")))
            }
            flushAll()
            return blocks
        }

        /// A bullet or a numbered item, with its nesting depth from the leading indent.
        private static func listItem(_ line: String) -> ListItem? {
            let indent = line.prefix { $0 == " " || $0 == "\t" }.count
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            let depth = min(indent / 2, 3)

            for bullet in ["- ", "* ", "+ "] where trimmed.hasPrefix(bullet) {
                return ListItem(
                    depth: depth,
                    marker: "•",
                    text: String(trimmed.dropFirst(bullet.count))
                )
            }

            // "1. ", "2) " — the number is kept as written rather than renumbered, because a
            // reply that starts a list at 3 usually means it.
            let digits = trimmed.prefix { $0.isNumber }
            if !digits.isEmpty, digits.count <= 3 {
                let rest = trimmed.dropFirst(digits.count)
                if rest.hasPrefix(". ") || rest.hasPrefix(") ") {
                    return ListItem(
                        depth: depth,
                        marker: "\(digits).",
                        text: String(rest.dropFirst(2))
                    )
                }
            }

            return nil
        }
    }
}

/// Parsed blocks, kept between renders.
///
/// A `View`'s `init` runs on every body evaluation, and during a live turn the thread
/// re-renders on every event off the stream — several times a second while tool calls land.
/// Without this, every finished turn's reply is re-parsed each time, so a long thread pays
/// for its whole history on every tick of the newest turn.
///
/// Keyed on the text itself, which is sound because the parse is a pure function of it: the
/// same reply always yields the same blocks. `NSCache` evicts under pressure, and a miss
/// costs exactly what the old behaviour cost every time.
@MainActor
final class BlockCache {
    static let shared = BlockCache()

    private final class Box {
        let blocks: [MarkdownText.Block]
        init(_ blocks: [MarkdownText.Block]) { self.blocks = blocks }
    }

    private let cache = NSCache<NSString, Box>()

    private init() {
        cache.countLimit = 300
    }

    func blocks(for text: String) -> [MarkdownText.Block] {
        let key = text as NSString
        if let hit = cache.object(forKey: key) { return hit.blocks }
        let parsed = MarkdownText.Block.parse(text)
        cache.setObject(Box(parsed), forKey: key)
        return parsed
    }
}
