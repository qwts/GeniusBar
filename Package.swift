// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "GeniusBar",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "GeniusBarLib", targets: ["GeniusBarLib"]),
        .executable(name: "GeniusBar", targets: ["GeniusBar"]),
    ],
    targets: [
        .target(name: "GeniusBarLib"),
        .executableTarget(
            name: "GeniusBar",
            dependencies: ["GeniusBarLib"]
        ),
        .testTarget(
            name: "GeniusBarTests",
            dependencies: ["GeniusBarLib"]
        ),
    ]
)
