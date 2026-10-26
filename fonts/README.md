# Fonts

Webfonts shipped inside the wallet bundle. Nothing here is fetched at runtime
from a third party — that is the point of the directory.

## Inter, Nunito

Declared in `src/main.css`, which is where the `@font-face` rules and the
reasoning behind the clamped axes live. Vite fingerprints these files and emits
them next to the compiled stylesheet, so the same sources serve the extension,
the mobile WebView and the desktop shell.

Both families are variable fonts with a `wght` axis clamped to `400..800`,
upright only, split into the same `unicode-range` subsets Google Fonts uses.
`Inter` additionally carries the `opsz` axis over `14..32`.

### Regenerating

The files came from the Google Fonts CDN, which does axis and codepoint
subsetting server-side. To refresh them (or to widen an axis — editing the
`font-weight` range in `src/main.css` alone will not add weights the files do
not contain), fetch the stylesheet for the range you want and download every
`woff2` it names, keeping the `<Family>-<subset>.woff2` naming:

```sh
# The User-Agent decides the format the CDN serves; an unrecognised one gets ttf.
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
curl -A "$UA" 'https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400..800&display=swap'
curl -A "$UA" 'https://fonts.googleapis.com/css2?family=Nunito:wght@400..800&display=swap'
```

Each `/* subset */` comment in the response names the file below it, and each
rule's `unicode-range` must be copied into `src/main.css` alongside it.

### Licensing

Inter and Nunito are both under the SIL Open Font License 1.1, reproduced in
`Inter/OFL.txt` and `Nunito/OFL.txt` as the license requires.

## Geist, GeistMono

Present but unreferenced: no `@font-face` rule, no build step, and no CSS names
them. `tailwind.config.ts` still carries a "Custom font families with Geist"
comment above a block that resolves entirely to Inter. Either wire them up or
delete them — and if they are wired up, they need an `OFL.txt` of their own,
since Geist is OFL-1.1 too.
