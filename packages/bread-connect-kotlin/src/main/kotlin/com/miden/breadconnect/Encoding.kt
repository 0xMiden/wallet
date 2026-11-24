package com.miden.breadconnect

import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

internal object Base64Url {
    private const val ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    private val VALUES = IntArray(128) { -1 }.also { values -> ALPHABET.forEachIndexed { i, c -> values[c.code] = i } }

    fun encode(bytes: ByteArray): String {
        val text = StringBuilder((bytes.size * 4 + 2) / 3)
        var i = 0
        while (i < bytes.size) {
            val chunk = (bytes[i].toInt() and 255 shl 16) or
                ((if (i + 1 < bytes.size) bytes[i + 1].toInt() and 255 else 0) shl 8) or
                (if (i + 2 < bytes.size) bytes[i + 2].toInt() and 255 else 0)
            val chars = minOf(4, ((bytes.size - i) * 8 + 5) / 6)
            for (j in 0 until chars) text.append(ALPHABET[(chunk shr (18 - 6 * j)) and 63])
            i += 3
        }
        return text.toString()
    }

    /** Unpadded base64url only: a padded, non-canonical or foreign-alphabet string is null. */
    fun decode(text: String): ByteArray? {
        if (text.length % 4 == 1) return null
        val bytes = ByteArray(text.length * 6 / 8)
        var bits = 0
        var buffer = 0
        var index = 0
        for (char in text) {
            val value = if (char.code < 128) VALUES[char.code] else -1
            if (value < 0) return null
            buffer = (buffer shl 6 or value) and 0xFFFF
            bits += 6
            if (bits >= 8) {
                bits -= 8
                bytes[index++] = (buffer shr bits and 255).toByte()
            }
        }
        if (buffer and ((1 shl bits) - 1) != 0) return null
        return bytes
    }

    /** The bytes of a base64url field, or null when it is malformed or not [size] bytes long. */
    fun decode(text: String, size: Int): ByteArray? = decode(text)?.takeIf { it.size == size }
}

/** The bytes as a string when they are well-formed UTF-8, else null. */
internal fun ByteArray.strictUtf8(): String? = try {
    Charsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(ByteBuffer.wrap(this))
        .toString()
} catch (e: CharacterCodingException) {
    null
}

/**
 * The element's own text keeps object key order and each number as written, and escapes strings as JavaScript's
 * `JSON.stringify` does. Encoding through `JsonElement.serializer()` would rewrite a number that does not fit a Long
 * as a Double, so `-0.5e10` would come back as `-5.0E9` and a larger integer would lose digits.
 */
internal fun JsonElement.serialized(): String = toString()

internal fun parseJson(text: String): JsonElement? = try {
    Json.parseToJsonElement(text)
} catch (e: SerializationException) {
    null
} catch (e: IllegalArgumentException) {
    null
}

/** A JSON string's text; null for anything else, including the bare literals kotlinx's tree parser lets through. */
internal val JsonElement?.string: String?
    get() = (this as? JsonPrimitive)?.takeIf { it.isString }?.content

internal val JsonElement?.obj: JsonObject?
    get() = this as? JsonObject

/** A Miden dApp message: a JSON object with a string `type`. */
internal fun JsonElement?.dAppMessage(): JsonObject? = obj?.takeIf { it["type"].string != null }
