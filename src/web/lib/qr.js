import QRCode from 'qrcode';

/**
 * Feed URL → inline SVG.
 *
 * Rendered inline rather than served from an endpoint: the QR encodes a token that
 * authorises feed access, so keeping it inside the already-authenticated page
 * avoids inventing a second, image-shaped way to reach that credential. It also
 * regenerates automatically when the token is rotated, since the whole fragment
 * re-renders.
 */
const cache = new Map();

export async function feedQrSvg(url, { size = 200 } = {}) {
  if (!url) return null;
  const key = `${url}|${size}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const svg = await QRCode.toString(url, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 1,
    width: size,
    color: { dark: '#16181D', light: '#FFFFFF' },
  });

  // Strip the fixed width/height so CSS controls the rendered size, and make the
  // graphic invisible to assistive tech (the URL itself is right beside it).
  const responsive = svg
    .replace(/<svg([^>]*)width="[^"]*"/, '<svg$1')
    .replace(/<svg([^>]*)height="[^"]*"/, '<svg$1')
    .replace('<svg', '<svg role="img" aria-hidden="true" focusable="false"');

  if (cache.size > 200) cache.clear();
  cache.set(key, responsive);
  return responsive;
}
