import Capacitor
import Foundation
import MidenMobileProver

// Capacitor plugin that proves a Miden transaction natively. Bridges JS
// calls (Uint8Array → base64 → bytes → C ABI → bytes → base64 → Uint8Array)
// onto a background queue so the WKWebView main thread stays responsive
// during the multi-second prove.
//
// Wire format matches `RemoteTransactionProver` / the web-sdk's
// `JsCallbackTransactionProver`: caller passes serialized `TransactionInputs`,
// receives serialized `ProvenTransaction`. Encoding is base64 because
// Capacitor's plugin bridge round-trips through JSON.
@objc(MidenNativeProverPlugin)
public class MidenNativeProverPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MidenNativeProverPlugin"
    public let jsName = "MidenNativeProver"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "prove", returnType: CAPPluginReturnPromise)
    ]

    /// Single-flight prove queue. Concurrent calls would compete for the
    /// global rayon pool inside libmiden_mobile_prover.a, hurting per-prove
    /// latency for both. A serial queue gives predictable timings.
    private let proveQueue = DispatchQueue(label: "com.miden.native-prover.prove", qos: .userInitiated)

    public override func load() {
        super.load()
        NSLog("[MidenNativeProver] plugin loaded")
    }

    @objc func prove(_ call: CAPPluginCall) {
        NSLog("[MidenNativeProver] prove() called, callbackId=\(call.callbackId)")
        // Quick synchronous probe path so we can confirm the bridge returns
        // at all. Pass `probe: "echo"` to get an immediate resolve.
        if let probe = call.getString("probe") {
            NSLog("[MidenNativeProver] prove() probe='\(probe)', resolving synchronously")
            call.resolve(["probe": probe, "echo": "ok"])
            return
        }
        guard let inputBase64 = call.getString("input"),
              let inputData = Data(base64Encoded: inputBase64) else {
            NSLog("[MidenNativeProver] prove() rejected: bad input shape")
            call.reject("MidenNativeProver.prove requires `input` as a base64-encoded Uint8Array")
            return
        }
        NSLog("[MidenNativeProver] prove() dispatching native prove for \(inputData.count) input bytes")

        proveQueue.async { [weak self] in
            guard self != nil else { return }
            let t0 = Date()
            let result = Self.runProve(input: inputData)
            let elapsedMs = Date().timeIntervalSince(t0) * 1000.0
            NSLog("[MidenNativeProver] prove() native call returned in \(elapsedMs)ms")
            DispatchQueue.main.async {
                switch result {
                case .success(let output):
                    NSLog("[MidenNativeProver] prove() success, output=\(output.count) bytes")
                    call.resolve([
                        "output": output.base64EncodedString(),
                        "durationMs": elapsedMs
                    ])
                case .failure(let err):
                    NSLog("[MidenNativeProver] prove() failure: \(err)")
                    call.reject("MidenNativeProver: \(err)")
                }
            }
        }
    }

    private enum ProveError: Error, CustomStringConvertible {
        case badInput
        case proveFailed
        case unknownStatus(Int32)

        var description: String {
            switch self {
            case .badInput: return "input bytes did not decode as TransactionInputs"
            case .proveFailed: return "prover rejected the transaction"
            case .unknownStatus(let s): return "native prover returned unknown status \(s)"
            }
        }
    }

    private static func runProve(input: Data) -> Result<Data, ProveError> {
        // First attempt: pre-size the output buffer to 4 MB. Real proven
        // transactions on the devnet typical-claim path are well under
        // 1 MB; 4 MB gives plenty of headroom without forcing a retry.
        var cap = 4 * 1024 * 1024
        for _ in 0..<2 {
            var output = [UInt8](repeating: 0, count: cap)
            var written: Int = 0
            let status: Int32 = input.withUnsafeBytes { inputBytes -> Int32 in
                guard let inputBase = inputBytes.baseAddress?.assumingMemoryBound(to: UInt8.self) else {
                    return -1
                }
                return output.withUnsafeMutableBufferPointer { outBuf -> Int32 in
                    miden_prove_transaction(
                        inputBase,
                        input.count,
                        outBuf.baseAddress,
                        outBuf.count,
                        &written
                    )
                }
            }

            switch status {
            case 0:
                return .success(Data(output.prefix(written)))
            case -1:
                return .failure(.badInput)
            case -2:
                return .failure(.proveFailed)
            case -3:
                // BufferTooSmall — `written` is the required size. Grow
                // with slack and retry once. Two iterations is enough:
                // the FFI's `written` is exact.
                cap = written + 4096
                continue
            default:
                return .failure(.unknownStatus(status))
            }
        }
        return .failure(.unknownStatus(-99))
    }
}
