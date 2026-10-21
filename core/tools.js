import { Image } from 'react-native';
import * as ImageManipulator from 'expo-image-manipulator';
import { BlendMode, FilterMode, ImageFormat, MipmapMode, Skia } from '@shopify/react-native-skia';

// Optional: only used to hand the cutout to native as a file. Without it (or with an old SDK) the cutout stays base64.
let fsModule = null;
try {
  // eslint-disable-next-line global-require
  fsModule = require('expo-file-system');
} catch (error) {
  fsModule = null;
}

// Long side of the wallpaper photo. 3072 so phones with 3000+ px tall screens are not upscaled ~2x by the native service (blur).
// Memory: a 3072x2304 decoded bitmap is ~28 MB in Skia (untested on low-RAM phones); lower it if you see OOM.
export const DISPLAY_LONG_SIDE = 3072;
export const ANALYSIS_LONG_SIDE = 640;

// ---------- 1. Prepare the photo ----------

function blobToDataUri(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read the image'));
    reader.readAsDataURL(blob);
  });
}

async function resolveSource(uri) {
  if (!/^https?:\/\//i.test(uri)) return uri;
  const response = await fetch(uri);
  if (!response.ok) throw new Error('Could not download the image');
  return blobToDataUri(await response.blob());
}

function render(source, actions = [], options = {}) {
  return ImageManipulator.manipulateAsync(source, actions, {
    format: ImageManipulator.SaveFormat.JPEG,
    compress: 0.92,
    ...options,
  });
}

function sizeOf(uri) {
  return new Promise((resolve) => Image.getSize(uri, (width, height) => resolve({ width, height }), () => resolve(null)));
}

// Returns { photo (Skia image), displayUri, job } where job feeds <DepthEngine job={...} />.
export async function prepareImage(uri) {
  const source = await resolveSource(uri);

  // Learn the size without a full-resolution re-encode; only encode once, already downscaled.
  const size = await sizeOf(source);
  let display;
  if (size && Math.max(size.width, size.height) > DISPLAY_LONG_SIDE) {
    const k = DISPLAY_LONG_SIDE / Math.max(size.width, size.height);
    display = await render(source, [{ resize: { width: Math.round(size.width * k) } }]);
    if (Math.abs(Math.max(display.width, display.height) - DISPLAY_LONG_SIDE) > 4) {
      // EXIF-rotated source reported swapped dimensions: redo with the correct axis
      display = await render(source, [{ resize: { height: Math.round(size.width * k) } }]);
    }
  } else {
    display = await render(source);
    if (Math.max(display.width, display.height) > DISPLAY_LONG_SIDE) {
      const k = DISPLAY_LONG_SIDE / Math.max(display.width, display.height);
      display = await render(display.uri, [{ resize: { width: Math.round(display.width * k) } }]);
    }
  }

  // The analysis copy is encoded once, straight to base64.
  const k2 = Math.min(1, ANALYSIS_LONG_SIDE / Math.max(display.width, display.height));
  const small = await render(
    display.uri,
    [{ resize: { width: Math.max(64, Math.round(display.width * k2)) } }],
    { compress: 0.9, base64: true },
  );

  const data = await Skia.Data.fromURI(display.uri);
  const photo = Skia.Image.MakeImageFromEncoded(data);
  if (!photo) throw new Error('Could not decode the image');

  return {
    photo,
    displayUri: display.uri,
    job: { base64: small.base64, width: small.width, height: small.height },
  };
}

// ---------- 2. Read the engine result ----------

const LAYER_COLORS = ['#FF5A5F', '#2DD4BF', '#FACC15', '#60A5FA'];

export function buildLayerList(result) {
  return (result.layers || [])
    .map((layer, index) => ({
      id: layer.id,
      label: layer.label,
      group: layer.group,
      area: layer.area,
      nearness: layer.nearness,
      color: LAYER_COLORS[index % LAYER_COLORS.length],
      above: false,
      mask: Skia.Image.MakeImageFromEncoded(Skia.Data.fromBase64(layer.mask)),
    }))
    .filter((layer) => layer.mask);
}

export function describeProgress(p) {
  switch (p && p.stage) {
    case 'prepare': return 'Preparing image...';
    case 'download': return 'Downloading AI models... ' + (p.pct || 0) + '%';
    case 'seg-download': return 'Downloading object model... ' + (p.pct || 0) + '%';
    case 'depth-download': return 'Downloading depth model... ' + (p.pct || 0) + '%';
    case 'cache': return 'Loading saved models...';
    case 'segment': return 'Detecting objects...';
    case 'depth': return 'Estimating depth...';
    case 'refine': return 'Cleaning layer edges...';
    default: return 'Analyzing...';
  }
}

// ---------- 3. Export for the wallpaper service ----------

// The engine returns soft (3x3 box-blurred) masks. After the bilinear upscale a linear alpha ramp (a ColorFilter matrix)
// narrows that soft edge to about 1-3 px at display size, so the cutout edge is sharp but not stair-stepped.
// alpha' = clamp(sharpness * (alpha - 0.5) + 0.5). sharpness <= 1 leaves the alpha untouched.
export function edgeMatrix(sharpness) {
  const s = Number(sharpness);
  if (!(s > 1)) return null;
  const b = 0.5 * (1 - s);
  return [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, s, b];
}

const CUTOUT_FILE = 'zharph-cutout-tmp';
const MASK_FILE = 'zharph-mask-tmp';

// Writes the bytes to a temporary file in the cache dir and returns its file:// uri, or null if that is not
// possible here (no expo-file-system with the File API). Native deletes the file after it has copied it.
function writeCutoutFile(bytes, ext, base = CUTOUT_FILE) {
  try {
    if (!fsModule || !fsModule.File || !fsModule.Paths || !bytes || !bytes.length) return null;
    const file = new fsModule.File(fsModule.Paths.cache, base + '.' + ext);
    if (file.exists) file.delete();
    file.create();
    file.write(bytes);
    return file.uri;
  } catch (error) {
    return null;
  }
}

// Returns a string for applyWallpaper(): by default a file:// path of the cutout (no big base64 string on the bridge),
// or the base64 PNG when files cannot be written. options (all optional):
//   output: 'file' (default) | 'base64'   format: 'png' (default) | 'webp' (lossless, with alpha)   edgeSharpness: 3
export function encodeForegroundCutout({ photo, layers }, options = {}) {
  const foreground = (layers || []).filter((layer) => layer.above && layer.mask);
  if (!foreground.length || !photo) return null;

  const { output = 'file', format = 'png', edgeSharpness = 3 } = options || {};
  const matrix = edgeMatrix(edgeSharpness);
  const edgeFilter = matrix ? Skia.ColorFilter.MakeMatrix(matrix) : null;

  const width = photo.width();
  const height = photo.height();
  const outputSurface = Skia.Surface.MakeOffscreen(width, height);
  if (!outputSurface) throw new Error('Could not create foreground render surface');

  const transparent = Skia.Color('transparent');
  const destination = Skia.XYWHRect(0, 0, width, height);
  const drawMask = (canvas, mask, paint) =>
    canvas.drawImageRectOptions(mask, Skia.XYWHRect(0, 0, mask.width(), mask.height()), destination, FilterMode.Linear, MipmapMode.None, paint);

  let maskSurface = null;
  let combinedMask;
  let cutFilter = edgeFilter; // single layer: the filter is applied while cutting
  if (foreground.length === 1) {
    combinedMask = foreground[0].mask; // single layer: no union pass needed
  } else {
    maskSurface = Skia.Surface.MakeOffscreen(width, height);
    if (!maskSurface) throw new Error('Could not create foreground render surface');
    const maskCanvas = maskSurface.getCanvas();
    maskCanvas.clear(transparent);
    const maskPaint = Skia.Paint();
    maskPaint.setAntiAlias(true);
    if (edgeFilter) maskPaint.setColorFilter(edgeFilter); // sharpen each upscaled layer, then union
    for (const layer of foreground) drawMask(maskCanvas, layer.mask, maskPaint);
    combinedMask = maskSurface.makeImageSnapshot();
    cutFilter = null; // already applied above
  }

  const outputCanvas = outputSurface.getCanvas();
  outputCanvas.clear(transparent);
  const sourcePaint = Skia.Paint();
  sourcePaint.setAntiAlias(true);
  outputCanvas.drawImage(photo, 0, 0, sourcePaint);

  const cutPaint = Skia.Paint();
  cutPaint.setAntiAlias(true);
  cutPaint.setBlendMode(BlendMode.DstIn);
  if (cutFilter) cutPaint.setColorFilter(cutFilter);
  drawMask(outputCanvas, combinedMask, cutPaint);

  const snapshot = outputSurface.makeImageSnapshot();
  const webp = format === 'webp';
  let result = null;
  if (output !== 'base64') {
    const bytes = snapshot.encodeToBytes(webp ? ImageFormat.WEBP : ImageFormat.PNG, 100);
    result = writeCutoutFile(bytes, webp ? 'webp' : 'png');
  }
  if (!result) {
    result = snapshot.encodeToBase64(webp ? ImageFormat.WEBP : ImageFormat.PNG, 100);
  }
  if (maskSurface) maskSurface.dispose();
  outputSurface.dispose();
  if (!result) throw new Error('Could not encode the foreground cutout');
  return result;
}

export function encodeForegroundMasks({ layers }) {
  return (layers || [])
    .filter((layer) => layer.above && layer.mask)
    .map((layer) => {
      const base64 = layer.mask.encodeToBase64(ImageFormat.PNG, 100);
      if (!base64) throw new Error('Could not encode a foreground layer');
      return base64;
    });
}

// ---------- 4. Mask-only export (new path; the cutout functions above are unchanged) ----------

// Unions the foreground layer masks into ONE small 8-bit-per-channel PNG (white RGB, alpha = mask) at the size of the
// engine masks (<= ANALYSIS_LONG_SIDE), NOT at photo size: no full-resolution surface, encode or file. The native
// service scales it to the screen, sharpens the edge and applies it to the wallpaper bitmap with DST_IN
// (see applyWallpaperWithMask). Needs no photo. Returns null when there is no foreground layer.
// Edge sharpening is NOT done here (it only makes sense after upscaling): pass edgeSharpness to applyWallpaperWithMask.
// options: output: 'file' (default, file:// uri in the cache dir) | 'base64'. Same fallback rules as encodeForegroundCutout.
export function encodeForegroundMask({ layers }, options = {}) {
  const foreground = (layers || []).filter((layer) => layer.above && layer.mask);
  if (!foreground.length) return null;

  const { output = 'file' } = options || {};
  const first = foreground[0].mask;
  let source = first; // single layer: the engine mask already is white RGB + alpha, so it is re-encoded as it is
  let surface = null;
  try {
    if (foreground.length > 1) {
      const width = first.width();
      const height = first.height();
      surface = Skia.Surface.MakeOffscreen(width, height);
      if (!surface) throw new Error('Could not create foreground mask surface');
      const canvas = surface.getCanvas();
      canvas.clear(Skia.Color('transparent'));
      const paint = Skia.Paint(); // default SrcOver on a transparent surface: alpha' = a + b - a*b (union), RGB stays white
      paint.setAntiAlias(true);
      const destination = Skia.XYWHRect(0, 0, width, height);
      for (const layer of foreground) {
        const mask = layer.mask;
        canvas.drawImageRectOptions(mask, Skia.XYWHRect(0, 0, mask.width(), mask.height()), destination, FilterMode.Linear, MipmapMode.None, paint);
      }
      source = surface.makeImageSnapshot();
    }

    let result = null;
    if (output !== 'base64') result = writeCutoutFile(source.encodeToBytes(ImageFormat.PNG, 100), 'png', MASK_FILE);
    if (!result) result = source.encodeToBase64(ImageFormat.PNG, 100);
    if (!result) throw new Error('Could not encode the foreground mask');
    return result;
  } finally {
    if (surface) surface.dispose();
  }
}
