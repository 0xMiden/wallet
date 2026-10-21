package consumer

import android.content.Context
import com.miden.breadconnect.BreadOpener
import com.miden.breadconnect.PackageOpener

class ExistingOpener : BreadOpener {
    override suspend fun open(link: String): Boolean = true
}

suspend fun existingDirectCalls(context: Context, opener: BreadOpener, builtIn: PackageOpener) {
    val link = "https://bread.miden.xyz/request#v=1&m=consumer-fixture"
    opener.open(link)
    builtIn.open(link)
    PackageOpener(context).open(link)
}
