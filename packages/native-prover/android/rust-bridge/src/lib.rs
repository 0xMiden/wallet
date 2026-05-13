//! Android JNI bridge for the native Miden transaction prover.
//!
//! Exports `Java_com_miden_nativeprover_MidenNativeProverPlugin_proveNative`
//! so the Kotlin Capacitor plugin can call into the rayon-backed
//! `LocalTransactionProver` from `miden-client`. The JNI symbol name is
//! fixed by JNI's mangling rules (Java_<package_with_underscores>_<class>_<method>)
//! and matches the Kotlin class at `com.miden.nativeprover.MidenNativeProverPlugin`.
//!
//! Wire format matches the iOS plugin's C ABI path:
//!   input  = serialized `TransactionInputs::to_bytes()`
//!   output = serialized `ProvenTransaction::to_bytes()`
//!
//! Same bytes consumed by `RemoteTransactionProver` and the web-sdk's
//! `JsCallbackTransactionProver` — interchangeable at the SDK boundary.

use jni::JNIEnv;
use jni::objects::{JByteArray, JClass};
use jni::sys::jbyteArray;
use miden_client::transaction::{
    LocalTransactionProver, ProvenTransaction, ProvingOptions, TransactionInputs,
};
use miden_client::utils::{Deserializable, Serializable};

/// JNI entry point. Caller passes input bytes as a Java `byte[]`; on
/// success returns proven-transaction bytes as a new `byte[]`. On any
/// failure throws a Java `RuntimeException` and returns null.
///
/// JNI symbol name `Java_com_miden_nativeprover_MidenNativeProverPlugin_proveNative`
/// is fixed by JNI's symbol-mangling rules — must match the Kotlin
/// declaration `external fun proveNative(input: ByteArray): ByteArray` on
/// the class at `com.miden.nativeprover.MidenNativeProverPlugin`.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_miden_nativeprover_MidenNativeProverPlugin_proveNative<'local>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    input: JByteArray<'local>,
) -> jbyteArray {
    // Copy the Java byte[] into a Rust Vec<u8>. `convert_byte_array`
    // does the JNI ↔ Rust copy in one shot; cheap relative to the
    // multi-second prove that follows.
    let input_bytes: Vec<u8> = match env.convert_byte_array(&input) {
        Ok(b) => b,
        Err(e) => {
            let _ = env.throw_new("java/lang/RuntimeException", format!("JNI input read: {e}"));
            return std::ptr::null_mut();
        }
    };

    let inputs = match TransactionInputs::read_from_bytes(&input_bytes) {
        Ok(i) => i,
        Err(e) => {
            let _ = env.throw_new(
                "java/lang/RuntimeException",
                format!("input bytes did not decode as TransactionInputs: {e}"),
            );
            return std::ptr::null_mut();
        }
    };

    // The rayon-backed prover spawns its own thread pool via the
    // `concurrent` feature. The prove future itself is CPU-bound (no
    // async I/O); `futures_executor::block_on` is a single-threaded
    // driver, all the real parallelism is in rayon under the hood.
    let prover = LocalTransactionProver::new(ProvingOptions::default());
    let proven: ProvenTransaction = match futures_executor::block_on(prover.prove(inputs)) {
        Ok(p) => p,
        Err(e) => {
            let _ = env.throw_new(
                "java/lang/RuntimeException",
                format!("prover rejected the transaction: {e}"),
            );
            return std::ptr::null_mut();
        }
    };

    let serialized = proven.to_bytes();
    match env.byte_array_from_slice(&serialized) {
        Ok(arr) => arr.into_raw(),
        Err(e) => {
            let _ = env.throw_new(
                "java/lang/RuntimeException",
                format!("JNI output write: {e}"),
            );
            std::ptr::null_mut()
        }
    }
}
