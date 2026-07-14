import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ScreenCaptureKit

struct Envelope: Decodable {
    let action: ActionValue
    let approvalEventId: String?
}

enum ActionValue: Decodable {
    case status
    case focus(bundleId: String, windowId: String)
    case click(bundleId: String, windowId: String, x: Double, y: Double)
    case keyboard(bundleId: String, windowId: String, text: String, sensitive: Bool)
    case capture(bundleId: String, windowId: String, outputPath: String)

    enum CodingKeys: String, CodingKey { case type, bundleId, windowId, x, y, text, sensitive, outputPath }

    init(from decoder: Decoder) throws {
        if let scalar = try? decoder.singleValueContainer().decode(String.self), scalar == "status" { self = .status; return }
        let value = try decoder.container(keyedBy: CodingKeys.self)
        let type = try value.decode(String.self, forKey: .type)
        let bundleId = try value.decode(String.self, forKey: .bundleId)
        let windowId = try value.decode(String.self, forKey: .windowId)
        switch type {
        case "focus-window": self = .focus(bundleId: bundleId, windowId: windowId)
        case "mouse-click": self = .click(bundleId: bundleId, windowId: windowId, x: try value.decode(Double.self, forKey: .x), y: try value.decode(Double.self, forKey: .y))
        case "keyboard-input": self = .keyboard(bundleId: bundleId, windowId: windowId, text: try value.decode(String.self, forKey: .text), sensitive: try value.decodeIfPresent(Bool.self, forKey: .sensitive) ?? false)
        case "capture-window": self = .capture(bundleId: bundleId, windowId: windowId, outputPath: try value.decode(String.self, forKey: .outputPath))
        default: throw DecodingError.dataCorruptedError(forKey: .type, in: value, debugDescription: "Unsupported desktop action")
        }
    }
}

func emit(_ value: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: value)
    FileHandle.standardOutput.write(data)
}

func requireApproval(_ envelope: Envelope) throws {
    guard let approval = envelope.approvalEventId, !approval.isEmpty else { throw NSError(domain: "AI-Test-Officer", code: 13, userInfo: [NSLocalizedDescriptionKey: "permission_event_required"]) }
}

func activate(bundleId: String) throws {
    guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first else { throw NSError(domain: "AI-Test-Officer", code: 4, userInfo: [NSLocalizedDescriptionKey: "allowlisted_application_not_running"]) }
    guard app.activate(options: [.activateAllWindows]) else { throw NSError(domain: "AI-Test-Officer", code: 5, userInfo: [NSLocalizedDescriptionKey: "window_focus_failed"]) }
}

func captureWindow(windowId: String, outputPath: String) async throws {
    guard CGPreflightScreenCaptureAccess() else { throw NSError(domain: "AI-Test-Officer", code: 6, userInfo: [NSLocalizedDescriptionKey: "screen_recording_permission_missing"]) }
    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
    guard let numericId = UInt32(windowId), let window = content.windows.first(where: { $0.windowID == numericId }) else { throw NSError(domain: "AI-Test-Officer", code: 7, userInfo: [NSLocalizedDescriptionKey: "approved_window_not_found"]) }
    let filter = SCContentFilter(desktopIndependentWindow: window)
    let configuration = SCStreamConfiguration()
    configuration.width = Int(window.frame.width * 2)
    configuration.height = Int(window.frame.height * 2)
    configuration.showsCursor = true
    let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
    let bitmap = NSBitmapImageRep(cgImage: image)
    guard let png = bitmap.representation(using: .png, properties: [:]) else { throw NSError(domain: "AI-Test-Officer", code: 8, userInfo: [NSLocalizedDescriptionKey: "window_capture_encoding_failed"]) }
    try png.write(to: URL(fileURLWithPath: outputPath), options: .atomic)
}

@main struct DesktopHelper {
    static func main() async {
        do {
            let envelope = try JSONDecoder().decode(Envelope.self, from: FileHandle.standardInput.readDataToEndOfFile())
            switch envelope.action {
            case .status:
                try emit(["accessibility": AXIsProcessTrusted(), "screenRecording": CGPreflightScreenCaptureAccess()])
            case .focus(let bundleId, _):
                try requireApproval(envelope); try activate(bundleId: bundleId); try emit(["focused": true])
            case .click(let bundleId, _, let x, let y):
                try requireApproval(envelope); try activate(bundleId: bundleId)
                let point = CGPoint(x: x, y: y)
                CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
                CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
                try emit(["clicked": true, "x": x, "y": y])
            case .keyboard(let bundleId, _, let text, let sensitive):
                try requireApproval(envelope)
                guard !sensitive else { throw NSError(domain: "AI-Test-Officer", code: 9, userInfo: [NSLocalizedDescriptionKey: "secure_input_capture_forbidden"]) }
                try activate(bundleId: bundleId)
                let source = CGEventSource(stateID: .hidSystemState)
                for scalar in text.unicodeScalars { var code = UniChar(scalar.value); let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true); event?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &code); event?.post(tap: .cghidEventTap) }
                try emit(["typedCharacterCount": text.count])
            case .capture(_, let windowId, let outputPath):
                try requireApproval(envelope); try await captureWindow(windowId: windowId, outputPath: outputPath); try emit(["captured": true, "outputPath": outputPath])
            }
        } catch {
            FileHandle.standardError.write(Data(String(describing: error).utf8))
            exit(1)
        }
    }
}
