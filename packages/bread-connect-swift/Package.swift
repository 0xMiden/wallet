// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "BreadConnect",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [
        .library(name: "BreadConnect", targets: ["BreadConnect"])
    ],
    targets: [
        .target(name: "BreadConnect"),
        .testTarget(name: "BreadConnectTests", dependencies: ["BreadConnect"])
    ]
)
