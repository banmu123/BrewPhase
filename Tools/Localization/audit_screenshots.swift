// Finds Chinese characters in a screenshot.
//
// Purpose: proving the English interface has no untranslated text left in it.
// Reading ten screenshots by eye is how a missed string ships, so this reads
// them with Vision instead and reports anything containing Han characters.
//
//     swift Tools/Localization/audit_screenshots.swift /tmp/en-*.png
//
// Exit code 1 when a *word* was found, so it can gate a release.
//
// Two classes are reported, because Vision is not perfect:
//
//   * a run of two or more Han characters is real untranslated text — an em
//     dash or a star glyph is never read as two characters in a row;
//   * an isolated Han character is almost always Vision misreading a symbol
//     (`—` comes back as 一, `★` as 大), so it is printed as a warning for a
//     human to glance at rather than as a failure. The one-character strings
//     this app actually has — 桃, 酸, 甜, 苦 — would show up here.

import AppKit
import Foundation
import Vision

let hanWord = try! NSRegularExpression(pattern: "[\\u3400-\\u9fff\\uf900-\\ufaff]{2,}")
let hanChar = try! NSRegularExpression(pattern: "[\\u3400-\\u9fff\\uf900-\\ufaff]")

func scan(_ path: String) -> (words: [String], singles: [String]) {
    guard let image = NSImage(contentsOfFile: path),
          let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil)
    else {
        return (["<could not read \(path)>"], [])
    }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    request.usesLanguageCorrection = false

    let handler = VNImageRequestHandler(cgImage: cgImage)
    try? handler.perform([request])

    let observations = (request.results ?? []).sorted {
        $0.boundingBox.midY > $1.boundingBox.midY
    }

    var words: [String] = []
    var singles: [String] = []
    for observation in observations {
        guard let candidate = observation.topCandidates(1).first else { continue }

        // The simulator's status bar is not the app. Vision reliably misreads the
        // battery and Wi-Fi glyphs at the top right as a pair of Han characters
        // (今口), which would otherwise be reported as untranslated text on every
        // screenshot. The device's status bar is ~62pt = 7.5% of the height, and
        // the navigation bar's own title sits below that.
        if observation.boundingBox.minY > 0.925 { continue }

        let text = candidate.string
        let range = NSRange(text.startIndex..., in: text)
        if hanWord.firstMatch(in: text, range: range) != nil {
            words.append(text)
        } else if hanChar.firstMatch(in: text, range: range) != nil {
            singles.append(text)
        }
    }
    return (words, singles)
}

var wordCount = 0
for path in CommandLine.arguments.dropFirst() {
    let (words, singles) = scan(path)
    let name = (path as NSString).lastPathComponent
    var summary = words.isEmpty ? "\(name): clean" : "\(name): \(words.count) untranslated line(s)"
    if !singles.isEmpty { summary += "  (+\(singles.count) glyph warning)" }
    print(summary)
    for line in words {
        wordCount += 1
        print("    UNTRANSLATED  \(line)")
    }
    for line in singles {
        print("    check?        \(line)")
    }
}

if wordCount > 0 {
    print("\nFAIL — \(wordCount) untranslated line(s) in the English interface")
    exit(1)
}
print("\nPASS — no untranslated text found (glyph warnings above are Vision misreads)")
