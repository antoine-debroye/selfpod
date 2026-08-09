# Font licenses

SelfPod is fully self-hosted and never references a CDN, so the web fonts it
uses are vendored into this directory and served from the app itself.

**All three font families here are licensed under the SIL Open Font License,
Version 1.1 (OFL-1.1).** The full license text accompanies them in
[`OFL-1.1.txt`](./OFL-1.1.txt).

The OFL requires that the license notice accompany the fonts wherever they are
redistributed — including inside a self-hosted application or a Docker image.
**Keep this file and `OFL-1.1.txt` next to the `.woff2` files.** Do not delete
them as part of a build or image-slimming step, and if the fonts are copied
elsewhere, copy these two files along with them. The OFL also reserves the font
names: a *modified* version of any of these fonts must not be distributed under
its original family name.

None of these licenses require attribution in the SelfPod user interface, and
none of them restrict commercial use.

## Vendored files

| File | Family | Axes | Style | Size |
|---|---|---|---|---|
| `fraunces-variable.woff2` | Fraunces | `opsz` 9–144, `wght` 100–900 | roman | 66 KB |
| `fraunces-italic-variable.woff2` | Fraunces | `opsz` 9–144, `wght` 100–900 | italic | 80 KB |
| `inter-variable.woff2` | Inter | `wght` 100–900 | roman | 47 KB |
| `jetbrains-mono-variable.woff2` | JetBrains Mono | `wght` 100–800 | roman | 39 KB |

All four are variable `woff2` files subset to **latin**, obtained from the
[Fontsource](https://fontsource.org) CDN on 2026-08-09:

```
https://cdn.jsdelivr.net/fontsource/fonts/fraunces:vf@latest/latin-standard-normal.woff2
https://cdn.jsdelivr.net/fontsource/fonts/fraunces:vf@latest/latin-standard-italic.woff2
https://cdn.jsdelivr.net/fontsource/fonts/inter:vf@latest/latin-wght-normal.woff2
https://cdn.jsdelivr.net/fontsource/fonts/jetbrains-mono:vf@latest/latin-wght-normal.woff2
```

Fontsource repackages the upstream fonts without changing their licensing; the
OFL terms below flow from each font's own project.

### Note for whoever writes the `@font-face` rules

Fraunces' variable build reports a **default `wght` of 900**, not 400. Declare
the full range and always set an explicit `font-weight`, or headings will render
at maximum weight:

```css
@font-face {
  font-family: 'Fraunces';
  src: url('/fonts/fraunces-variable.woff2') format('woff2-variations');
  font-weight: 100 900;   /* required — the file's own default is 900 */
  font-style: normal;
  font-display: swap;
}
```

Because Fraunces carries an `opsz` axis, browsers apply `font-optical-sizing:
auto` by default and will size it optically from `font-size` — which is the
reason the optical-size build was chosen over the smaller `wght`-only one. The
roman and italic files are separate faces; give them matching `font-family`
names and distinct `font-style` values so the browser picks between them.

## Families

### Fraunces

- Copyright 2020 The Fraunces Project Authors
- Repository: https://github.com/undercasetype/Fraunces
- Version in this directory: 1.000
- License: SIL Open Font License 1.1 — Reserved Font Name "Fraunces"

### Inter

- Copyright 2016 The Inter Project Authors
- Repository: https://github.com/rsms/inter
- Version in this directory: 4.001
- License: SIL Open Font License 1.1 — Reserved Font Name "Inter"

### JetBrains Mono

- Copyright 2020 The JetBrains Mono Project Authors
- Repository: https://github.com/JetBrains/JetBrainsMono
- Version in this directory: 2.211
- License: SIL Open Font License 1.1 — Reserved Font Name "JetBrains Mono"

Each copyright line above is transcribed from the `name` table embedded in the
corresponding vendored file, so it reflects exactly what is being shipped.

## Other vendored assets

The JavaScript in `../js/` is **not** covered by the OFL. htmx and its SSE
extension are both distributed under the BSD Zero Clause License (0BSD), which
grants use, copying, modification and distribution with no attribution or
notice-retention requirement:

- `../js/htmx.min.js` — htmx 2.0.10, 0BSD —
  https://github.com/bigskysoftware/htmx
- `../js/htmx-ext-sse.js` — htmx-ext-sse 2.2.4, 0BSD, Copyright (c) 2023
  Alexander Petros — https://github.com/bigskysoftware/htmx-extensions

The SSE extension is the separate `htmx-ext-sse` package, which is the
htmx-2.x-compatible one. The extension bundled in htmx 1.x under
`dist/ext/sse.js` targets the old internal API and will not work here.
