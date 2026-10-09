/**
 * sharp, loaded the first time an image is actually handled rather than at boot.
 *
 * Importing it means loading libvips, which is tens of milliseconds on a laptop and
 * whole seconds on the Celeron in a small NAS — paid before the first page could be
 * served, for a library that is only needed when a cover is inspected or saved or an
 * episode's artwork is extracted. Both services share this one loader, so the module
 * is loaded once however many of them ask, and a boot with no images never loads it.
 *
 * The image itself proves at build time that sharp loads (the native-module check in
 * the Dockerfile), so in the container this cannot fail. On a development machine
 * where it does, the error keeps sharp's own explanation and names the module, so it
 * reads as "the image library is broken" rather than "this image is invalid".
 */
let loading = null;

export function loadSharp() {
  loading ??= import('sharp')
    .then((module) => module.default)
    .catch((err) => {
      loading = null;
      throw new Error(`The image library (sharp) could not be loaded: ${err?.message ?? err}`, { cause: err });
    });
  return loading;
}
