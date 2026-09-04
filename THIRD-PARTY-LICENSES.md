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

## whisper.cpp, ggml, and the Whisper model inside them

**What:** the image contains `whisper-cli` — built from
[whisper.cpp](https://github.com/ggml-org/whisper.cpp) at tag `b4938`, which includes
the ggml tensor library — and the file `ggml-base-q5_1.bin`, a quantised copy of
OpenAI's Whisper `base` model converted for whisper.cpp
(sha256 `422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898`). SelfPod
runs the binary as a child process to hear the words in an episode's opening and
closing minutes (spec §19.6). No audio or text leaves the machine.

**Licence:** whisper.cpp and ggml are MIT. The Whisper model weights are released by
OpenAI under MIT. Nothing here changes the image's licence line.

**Why a subprocess, when the MP3 decoder above is in-process:** a maths library fed a
sound file can hit an illegal instruction on an unexpected CPU or exhaust memory, and
in a child process that ends the child rather than the server that serves the feed;
the several hundred megabytes a model needs go back to the operating system when the
child exits, which they would not from inside a musl-linked Node process; and a run
that goes on too long is ended with one signal. The input is a WAV SelfPod's own
decoder wrote a moment earlier, never a file chosen by a stranger. There is no shell
in the path and no argument comes from outside the code.

**Building your own:** `Dockerfile` builds it from source at the pinned tag with
`GGML_NATIVE=OFF`, in two flavours on amd64 (AVX2 and SSE4.2, chosen at boot), and
fetches the model from Hugging Face checking the digest above. Point `WHISPER_CLI` and
`WHISPER_MODEL` at another build or a larger model to use those instead.

## Everything else

The remaining runtime dependencies are MIT, ISC, BSD or Apache-2.0. `npm ls --all` and
each package's own `LICENSE` file are the authority; this file records only the
dependency whose terms differ from SelfPod's own.
