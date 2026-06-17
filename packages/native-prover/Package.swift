// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "MidenNativeProver",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "MidenNativeProver",
            targets: ["NativeProverPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        // Pre-built static library wrapping the Miden Rust prover. Built
        // from web-sdk/crates/mobile-prover via cargo for the
        // aarch64-apple-ios and aarch64-apple-ios-sim triples, then
        // bundled into an xcframework by `xcodebuild -create-xcframework`.
        .binaryTarget(
            name: "MidenMobileProver",
            path: "ios/MidenMobileProver.xcframework"
        ),
        .target(
            name: "NativeProverPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                "MidenMobileProver"
            ],
            path: "ios/Sources/NativeProverPlugin")
    ]
)
