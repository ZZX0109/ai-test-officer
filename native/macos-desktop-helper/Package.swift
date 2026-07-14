// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "AI-Test-Officer-Desktop-Helper",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "ai-test-officer-desktop-helper", targets: ["DesktopHelper"])],
    targets: [.executableTarget(name: "DesktopHelper")]
)
