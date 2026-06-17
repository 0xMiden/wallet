#ifndef MIDEN_MOBILE_PROVER_H
#define MIDEN_MOBILE_PROVER_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Status codes returned by `miden_prove_transaction`. Mirror of the
// `Status` enum in miden-mobile-prover.
//
//   0  = Ok        — `*output_written` is the number of bytes written to
//                    `output_buf_ptr`.
//  -1  = BadInput  — input bytes did not decode as TransactionInputs.
//  -2  = ProveFailed — the prover rejected the input (malformed/invalid tx).
//  -3  = BufferTooSmall — `*output_written` is the required size; reallocate
//                         and retry.

int32_t miden_prove_transaction(
    const uint8_t* input_ptr,
    size_t input_len,
    uint8_t* output_buf_ptr,
    size_t output_buf_cap,
    size_t* output_written
);

#ifdef __cplusplus
}
#endif

#endif
