# Third-party licences

SelfPod itself is MIT. It ships other people's code, and one piece of it is not MIT —
which is the reason this file exists rather than a line in the README.

## mpg123-decoder (and the mpg123 library inside it)

- **Package:** `mpg123-decoder`, MIT
- **Bundled library:** [mpg123](https://www.mpg123.de/), **LGPL-2.1-or-later**
- **What it is for:** decoding MP3 audio so SelfPod can compare what two episodes
  *sound* like. Finding a theme tune that was re-encoded rather than copied cannot be
  done by comparing bytes, and comparing sound means decoding it. See `doc/selfpod-spec.md`
  §19.3.

The npm package is MIT, but it compiles mpg123 into its distributed files and its
upstream README says plainly that "any external source code included by repository …
may have different licensing terms". mpg123 is LGPL-2.1-or-later, so that is the
licence that governs that part.

**What the LGPL asks for here, and how it is met.** SelfPod uses mpg123 through its
published interface and does not modify it. It is not statically linked into a
proprietary binary: it arrives as a separate package under `node_modules`, and anyone
who wants a different build of it can replace that package and re-run the image. The
library's own source is at <https://www.mpg123.de/> and the WebAssembly build's at
<https://github.com/eshaz/wasm-audio-decoders>.

**Why not ffmpeg.** The same job could be done by bundling ffmpeg, and it was
considered and rejected. ffmpeg's usual builds are GPL, which propagates to whatever is
distributed with them; it brings a complete H.264/H.265/AV1/VP9 decoder stack into an
image that is fed files chosen by strangers; it is about eighty megabytes; and it runs
as a child process. mpg123-decoder is an MP3 decoder and nothing else, about eighty
kilobytes of WebAssembly, sandboxed and in-process, and LGPL rather than GPL. The
obligation above is real and small. That one would have been real and large.

## Everything else

The remaining runtime dependencies are MIT, ISC, BSD or Apache-2.0. `npm ls --all` and
each package's own `LICENSE` file are the authority; this file records only the
dependency whose terms differ from SelfPod's own.
