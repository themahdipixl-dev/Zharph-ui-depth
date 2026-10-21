import { requireOptionalNativeModule } from 'expo';

const ZharphWallpaper = requireOptionalNativeModule('ZharphWallpaper');

// clock: { nx, ny, calendar? } — calendar: 'gregorian' (default) | 'persian' (optional, shows the Persian date; needs Android 7+, else Gregorian).
// foregroundCutout: null, a file path / file:// / content:// uri of a PNG or WebP with alpha, or a base64 string of one.
export async function applyWallpaper(imageUri, clock, foregroundCutout = null) {
  if (!ZharphWallpaper) {
    throw new Error('Zharph wallpaper native module is unavailable. Install a Zharph Android build first.');
  }

  return ZharphWallpaper.applyWallpaper(
    imageUri,
    typeof foregroundCutout === 'string' ? foregroundCutout : null,
    Number(clock?.nx ?? 0.18),
    Number(clock?.ny ?? 0.07),
    clock?.calendar === 'persian' ? 'persian' : 'gregorian',
  );
}

// New mask path (applyWallpaper above is unchanged). Same as applyWallpaper but the foreground is a small alpha MASK
// (from encodeForegroundMask in tools.js), not a full-resolution cutout: native scales it to the screen once, at load
// time, and applies it to the wallpaper bitmap with DST_IN. Requires a native build that has applyWallpaperMask.
// foregroundMask: null, or a file path / file:// / content:// uri of the mask PNG, or its base64.
// options.edgeSharpness: 3 (default; same meaning as in encodeForegroundCutout), 1 = no sharpening.
export async function applyWallpaperWithMask(imageUri, clock, foregroundMask = null, options = {}) {
  if (!ZharphWallpaper) {
    throw new Error('Zharph wallpaper native module is unavailable. Install a Zharph Android build first.');
  }
  if (typeof ZharphWallpaper.applyWallpaperMask !== 'function') {
    // JS updated (e.g. over the air) but the installed binary is older: say so instead of "undefined is not a function".
    throw new Error('This Zharph build has no mask support (applyWallpaperMask). Install a new native build, or use applyWallpaper with a cutout.');
  }

  const requested = Number(options?.edgeSharpness ?? 3);
  const edgeSharpness = requested > 1 ? Math.min(requested, 32) : 1; // NaN / <= 1 => 1 (no sharpening); never NaN on the bridge

  return ZharphWallpaper.applyWallpaperMask(
    imageUri,
    typeof foregroundMask === 'string' && foregroundMask ? foregroundMask : null,
    Number(clock?.nx ?? 0.18),
    Number(clock?.ny ?? 0.07),
    clock?.calendar === 'persian' ? 'persian' : 'gregorian',
    edgeSharpness,
  );
}

export default ZharphWallpaper;
