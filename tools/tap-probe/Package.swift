// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "tap-probe",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "tap-probe", path: "Sources/tap-probe"),
    ]
)
