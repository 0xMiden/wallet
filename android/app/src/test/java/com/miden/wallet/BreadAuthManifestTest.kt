package com.miden.wallet

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Document
import org.w3c.dom.Element

/// Plain-JVM checks of the dApp sign-in callback's wiring. The app module has no Robolectric, so
/// MainActivity is checked by its source; Gradle runs these tests from the module directory.
class BreadAuthManifestTest {
    private val androidNamespace = "http://schemas.android.com/apk/res/android"

    private fun manifest(): Document =
        DocumentBuilderFactory.newInstance()
            .apply { isNamespaceAware = true }
            .newDocumentBuilder()
            .parse(File("src/main/AndroidManifest.xml"))

    private fun Element.attribute(name: String): String = getAttributeNS(androidNamespace, name)

    private fun Element.children(tag: String): List<Element> =
        (0 until childNodes.length).map { childNodes.item(it) }.filterIsInstance<Element>().filter { it.tagName == tag }

    private fun Document.elements(tag: String): List<Element> =
        getElementsByTagName(tag).let { nodes -> (0 until nodes.length).map { nodes.item(it) as Element } }

    private fun mainActivity(): Element = manifest().elements("activity").single { it.attribute("name") == ".MainActivity" }

    @Test
    fun mainActivityIsSingleTask() {
        assertEquals("singleTask", mainActivity().attribute("launchMode"))
    }

    @Test
    fun mainActivityReceivesTheCallbackAddress() {
        val filters = mainActivity().children("intent-filter").filter { filter ->
            filter.children("data").any { it.attribute("scheme") == "com.miden.wallet.auth" }
        }
        assertEquals(1, filters.size)
        val filter = filters.single()
        assertEquals(listOf("android.intent.action.VIEW"), filter.children("action").map { it.attribute("name") })
        assertEquals(
            listOf("android.intent.category.DEFAULT", "android.intent.category.BROWSABLE").sorted(),
            filter.children("category").map { it.attribute("name") }.sorted(),
        )
        assertEquals(
            listOf("com.miden.wallet.auth" to "callback"),
            filter.children("data").map { it.attribute("scheme") to it.attribute("host") },
        )
        val declared = manifest().elements("data").filter { it.attribute("scheme").equals("com.miden.wallet.auth", ignoreCase = true) }
        assertEquals(1, declared.size)
    }

    @Test
    fun mainActivityConsumesCallbacksBeforeTheBridge() {
        val source = File("src/main/java/com/miden/wallet/MainActivity.java").readText()
        val onCreate = source.substringAfter("void onCreate(", "").substringBefore("\n    }")
        val consume = onCreate.indexOf("setIntent(BreadAuthCallbacks.consume(getIntent()));")
        assertTrue("onCreate takes the callback out of the launch intent", consume >= 0)
        assertTrue("before super.onCreate builds the Bridge", onCreate.indexOf("super.onCreate(savedInstanceState);") > consume)
        val onNewIntent = source.substringAfter("void onNewIntent(", "").substringBefore("\n    }")
        assertTrue(onNewIntent.contains("super.onNewIntent(BreadAuthCallbacks.consume(intent));"))
        assertFalse(onNewIntent.contains("super.onNewIntent(intent)"))
    }
}
