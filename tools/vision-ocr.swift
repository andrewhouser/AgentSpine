// vision-ocr: read the text in an image or a scanned PDF with Apple's Vision framework, entirely on this
// Mac. Prints the recognised lines to stdout in reading order, one page after another. No network, no
// model download, no dependency; AgentSpine compiles this file on first use (src/inbox/ocr.ts).
//
//   vision-ocr <file>        image (png, jpg, heic, tiff, gif, bmp) or PDF
//   vision-ocr --selftest    draws a known phrase, reads it back, prints it
//   vision-ocr --render <out.png> <text>   writes an image of the text (used to build test fixtures)
//
// Exit status: 0 with text on stdout (possibly empty if the page holds none), 2 for a usage or read error.
import AppKit
import CoreGraphics
import Foundation
import PDFKit
import Vision

func recognise(_ image: CGImage) throws -> [String] {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.automaticallyDetectsLanguage = true
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
    let observations = (request.results ?? []).sorted {
        // Top to bottom, then left to right; Vision's origin is bottom-left.
        let dy = $0.boundingBox.midY - $1.boundingBox.midY
        return abs(dy) > 0.012 ? dy > 0 : $0.boundingBox.minX < $1.boundingBox.minX
    }
    return observations.compactMap { $0.topCandidates(1).first?.string }
}

func render(_ page: PDFPage) -> CGImage? {
    let box = page.bounds(for: .mediaBox)
    // 2x keeps small print legible without making a long document slow.
    let scale: CGFloat = 2
    let width = Int(box.width * scale), height = Int(box.height * scale)
    guard width > 0, height > 0,
          let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
    ctx.setFillColor(CGColor(gray: 1, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
    ctx.scaleBy(x: scale, y: scale)
    page.draw(with: .mediaBox, to: ctx)
    return ctx.makeImage()
}

func draw(_ phrase: String) -> NSImage {
    let size = NSSize(width: max(900, phrase.count * 44), height: 160)
    let image = NSImage(size: size)
    image.lockFocus()
    NSColor.white.setFill()
    NSRect(origin: .zero, size: size).fill()
    (phrase as NSString).draw(at: NSPoint(x: 30, y: 50), withAttributes: [
        .font: NSFont.systemFont(ofSize: 64), .foregroundColor: NSColor.black,
    ])
    image.unlockFocus()
    return image
}

func selftest() -> Int32 {
    guard let cg = draw("AgentSpine OCR 4471").cgImage(forProposedRect: nil, context: nil, hints: nil),
          let lines = try? recognise(cg) else { return 2 }
    print(lines.joined(separator: "\n"))
    return 0
}

func renderFixture(_ out: String, _ phrase: String) -> Int32 {
    guard let tiff = draw(phrase).tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
          let png = rep.representation(using: .png, properties: [:]) else { return 2 }
    do { try png.write(to: URL(fileURLWithPath: out)) } catch { return 2 }
    return 0
}

let args = CommandLine.arguments
if args.count == 2 && args[1] == "--selftest" { exit(selftest()) }
if args.count == 4 && args[1] == "--render" { exit(renderFixture(args[2], args[3])) }
guard args.count == 2 else {
    FileHandle.standardError.write(Data("usage: vision-ocr <file> | --selftest\n".utf8))
    exit(2)
}
let url = URL(fileURLWithPath: args[1])
do {
    if url.pathExtension.lowercased() == "pdf" {
        guard let doc = PDFDocument(url: url) else { exit(2) }
        for index in 0..<doc.pageCount {
            guard let page = doc.page(at: index), let cg = render(page) else { continue }
            let lines = try recognise(cg)
            if !lines.isEmpty { print(lines.joined(separator: "\n")); print("") }
        }
    } else {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let cg = CGImageSourceCreateImageAtIndex(source, 0, nil) else { exit(2) }
        print(try recognise(cg).joined(separator: "\n"))
    }
} catch {
    FileHandle.standardError.write(Data("vision-ocr: \(error.localizedDescription)\n".utf8))
    exit(2)
}
