package consumer

import android.content.Context
import com.miden.breadconnect.BreadOpener
import com.miden.breadconnect.PackageOpener

fun existingPublicTypes(context: Context, opener: BreadOpener): Pair<BreadOpener, PackageOpener> =
    opener to PackageOpener(context)
