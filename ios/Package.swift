// swift-tools-version: 5.9
import PackageDescription

/*
 * The engine, as a package.
 *
 * The iOS app compiles every file under MediaWorkstation/ into one module (see
 * MediaWorkstation.xcodeproj). This package is a SECOND view of the same
 * source: it builds only the parts that have no UI in them, on macOS as well as
 * iOS, so the analysis and export engine can be compiled and unit-tested from a
 * Mac terminal with no Xcode project involved at all:
 *
 *     cd ios && swift test
 *
 * That is the fastest way to prove the Swift port still agrees with the
 * JavaScript engine the desktop uses — see Tests/MWEngineTests.
 *
 * The two views must never be linked together; the app target does not depend
 * on this package.
 */
let package = Package(
    name: "MWEngine",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "MWEngine", targets: ["MWEngine"]),
    ],
    targets: [
        .target(
            name: "MWEngine",
            path: "MediaWorkstation",
            exclude: ["App"],
            sources: ["Engine", "Models", "Remote"]
        ),
        .testTarget(
            name: "MWEngineTests",
            dependencies: ["MWEngine"],
            path: "Tests/MWEngineTests",
            resources: [.copy("Fixtures")]
        ),
    ]
)
