package com.zharph.wallpaper

import android.app.WallpaperManager
import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

class ZharphWallpaperModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ZharphWallpaper")

    // Old API, unchanged for callers: foreground = full-resolution cutout (path / file:// / content:// / base64) or null.
    AsyncFunction("applyWallpaper") { imageUri: String, foregroundCutout: String?, nx: Double, ny: Double, calendar: String? ->
      applyInternal(imageUri, foregroundCutout, null, nx, ny, calendar, DEFAULT_EDGE_SHARPNESS)
    }

    // New API: foreground = small alpha mask (path / file:// / content:// / base64 of a PNG). The service scales it to the
    // screen once at load time and applies it with DST_IN. edgeSharpness <= 1 means no sharpening.
    AsyncFunction("applyWallpaperMask") { imageUri: String, foregroundMask: String?, nx: Double, ny: Double, calendar: String?, edgeSharpness: Double? ->
      applyInternal(imageUri, null, foregroundMask, nx, ny, calendar, edgeSharpness ?: DEFAULT_EDGE_SHARPNESS)
    }
  }

  // Shared by both entry points. foregroundCutout and foregroundMask are mutually exclusive in practice (callers pass one);
  // whichever is not given is removed, so prefs never point at a stale file of the other kind.
  private fun applyInternal(
    imageUri: String,
    foregroundCutout: String?,
    foregroundMask: String?,
    nx: Double,
    ny: Double,
    calendar: String?,
    edgeSharpness: Double,
  ): Boolean {
    val context = requireNotNull(appContext.reactContext)
    val dir = context.filesDir
    val target = File(dir, "zharph-wallpaper.jpg")
    val foregroundFile = File(dir, "zharph-foreground.png")
    val maskFile = File(dir, "zharph-foreground-mask.png")
    val imageTmp = File(dir, target.name + ".tmp")
    val foregroundTmp = File(dir, foregroundFile.name + ".tmp")
    val maskTmp = File(dir, maskFile.name + ".tmp")
    val hasForeground = !foregroundCutout.isNullOrBlank()
    val hasMask = !foregroundMask.isNullOrBlank()
    if (hasForeground && hasMask) throw IllegalArgumentException("Pass either a cutout or a mask, not both")
    val sharpness = if (edgeSharpness.isFinite() && edgeSharpness > 1.0) edgeSharpness.toFloat().coerceAtMost(MAX_EDGE_SHARPNESS) else 1f

    // 1) Stage all files as .tmp. Nothing live is touched until all of them are fully written (and the mask validated).
    // 2) Swap them in together (previous files are kept as .bak so a failure can roll back).
    // 3) Update prefs last, so the service never sees a new version that points at a half-applied state.
    val backups = ArrayList<Pair<File, File>>() // (backup, original)
    try {
      stageImage(context, imageUri, imageTmp)
      // The cutout/mask may arrive as a file path / file:// / content:// uri (preferred: nothing big on the bridge)
      // or as base64 image data. Both are staged the same way.
      if (hasForeground) {
        if (isPathLike(foregroundCutout!!)) stageImage(context, foregroundCutout, foregroundTmp)
        else stageBase64Png(foregroundCutout, foregroundTmp)
      } else foregroundTmp.delete()
      if (hasMask) {
        if (isPathLike(foregroundMask!!)) stageImage(context, foregroundMask, maskTmp)
        else stageBase64Png(foregroundMask, maskTmp)
        validateMask(maskTmp) // a bad mask fails here (and rolls back) instead of silently showing no foreground later
      } else maskTmp.delete()

      moveAside(target, backups)
      moveAside(foregroundFile, backups)
      moveAside(maskFile, backups)
      if (!imageTmp.renameTo(target)) throw IOException("Could not install wallpaper image")
      if (hasForeground && !foregroundTmp.renameTo(foregroundFile)) throw IOException("Could not install foreground cutout")
      if (hasMask && !maskTmp.renameTo(maskFile)) throw IOException("Could not install foreground mask")

      val saved = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        .edit()
        .putString(KEY_IMAGE, target.absolutePath)
        .putString(KEY_FOREGROUND, if (hasForeground) foregroundFile.absolutePath else null)
        .putString(KEY_FOREGROUND_MASK, if (hasMask) maskFile.absolutePath else null)
        .putFloat(KEY_EDGE_SHARPNESS, sharpness)
        .putFloat(KEY_NX, nx.toFloat().coerceIn(0f, 1f))
        .putFloat(KEY_NY, ny.toFloat().coerceIn(0f, 1f))
        .putString(KEY_CALENDAR, if (calendar == CALENDAR_PERSIAN) CALENDAR_PERSIAN else CALENDAR_GREGORIAN)
        .putLong(KEY_VERSION, System.currentTimeMillis())
        .commit()
      if (!saved) throw IOException("Could not save wallpaper settings")
    } catch (error: Throwable) {
      // restore exactly the previous state (including "no files yet")
      target.delete()
      foregroundFile.delete()
      maskFile.delete()
      for ((backup, original) in backups) {
        original.delete()
        backup.renameTo(original)
      }
      throw error
    } finally {
      imageTmp.delete()
      foregroundTmp.delete()
      maskTmp.delete()
    }
    for ((backup, _) in backups) backup.delete()
    if (hasForeground) deleteTempCutout(context, foregroundCutout!!)
    if (hasMask) deleteTempCutout(context, foregroundMask!!)

    val intent = Intent("android.service.wallpaper.CHANGE_LIVE_WALLPAPER").apply {
      putExtra(
        "android.service.wallpaper.extra.LIVE_WALLPAPER_COMPONENT",
        ComponentName(context, ZharphWallpaperService::class.java)
      )
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }

    Handler(Looper.getMainLooper()).post { launchWallpaperScreen(context, intent) }
    return true
  }

  // Header-only decode: the staged mask must be a decodable image of a sane size (same limit the service applies).
  private fun validateMask(file: File) {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(file.absolutePath, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) throw IOException("Foreground mask is not a valid image")
    if (bounds.outWidth.toLong() * bounds.outHeight.toLong() > MAX_MASK_PIXELS) throw IOException("Foreground mask is too large")
  }

  // Some devices block or do not implement the direct "set live wallpaper" intent; never let that crash the app.
  private fun launchWallpaperScreen(context: Context, intent: Intent) {
    var useChooser = false
    try {
      context.startActivity(intent)
      return
    } catch (error: ActivityNotFoundException) {
      Log.w(TAG, "CHANGE_LIVE_WALLPAPER not available, falling back to the wallpaper chooser", error)
      useChooser = true
    } catch (error: SecurityException) {
      Log.w(TAG, "CHANGE_LIVE_WALLPAPER blocked, falling back to the wallpaper chooser", error)
      useChooser = true
    } catch (error: Throwable) {
      Log.w(TAG, "Could not open the live wallpaper screen", error)
    }
    if (!useChooser) return
    try {
      context.startActivity(
        Intent(WallpaperManager.ACTION_LIVE_WALLPAPER_CHOOSER).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      )
    } catch (error: Throwable) {
      Log.w(TAG, "Could not open the wallpaper chooser either", error)
    }
  }

  private fun moveAside(file: File, backups: MutableList<Pair<File, File>>) {
    if (!file.exists()) return
    val backup = File(file.parentFile, file.name + ".bak")
    if (backup.exists()) backup.delete()
    if (!file.renameTo(backup)) throw IOException("Could not back up " + file.name)
    backups.add(Pair(backup, file))
  }

  // base64 never starts with "file:" or "content:"; a leading "/" counts as a path only if that file really exists
  // (a base64 JPEG can start with "/9j/", but a cutout is PNG/WebP, which start with "iVBOR" / "UklGR").
  private fun isPathLike(value: String): Boolean =
    value.startsWith("file://", true) || value.startsWith("content://", true) ||
      (value.startsWith("/") && File(value).isFile)

  // The JS side writes the cutout / mask to <cache>/zharph-cutout-tmp.* / zharph-mask-tmp.*; it is a one-shot handoff, so remove it after use.
  private fun deleteTempCutout(context: Context, value: String) {
    try {
      if (!isPathLike(value) || value.startsWith("content://", true)) return
      val file = File(value.removePrefix("file://"))
      val cache = context.cacheDir.canonicalFile
      val canonical = file.canonicalFile
      if (canonical.parentFile == cache && (canonical.name.startsWith("zharph-cutout-") || canonical.name.startsWith("zharph-mask-"))) canonical.delete()
    } catch (error: Throwable) {
      Log.w(TAG, "Could not remove the temporary cutout file", error)
    }
  }

  private fun stageBase64Png(base64: String, temporary: File) {
    if (temporary.exists()) temporary.delete()
    val clean = base64.substringAfter(',', base64)
    val bytes = Base64.decode(clean, Base64.DEFAULT)
    FileOutputStream(temporary).use { it.write(bytes) }
    if (temporary.length() <= 0L) throw IOException("Foreground cutout is empty")
  }

  private fun stageImage(context: Context, source: String, temporary: File) {
    if (temporary.exists()) temporary.delete()

    when {
      source.startsWith("http://", true) || source.startsWith("https://", true) -> {
        val connection = URL(source).openConnection() as HttpURLConnection
        connection.connectTimeout = 15000
        connection.readTimeout = 30000
        connection.instanceFollowRedirects = true
        connection.connect()
        if (connection.responseCode !in 200..299) {
          connection.disconnect()
          throw IllegalStateException("Could not download wallpaper image (${connection.responseCode})")
        }
        connection.inputStream.use { input ->
          FileOutputStream(temporary).use { output -> input.copyTo(output) }
        }
        connection.disconnect()
      }
      source.startsWith("content://", true) -> {
        val input = context.contentResolver.openInputStream(Uri.parse(source))
          ?: throw IllegalStateException("Could not open selected image")
        input.use { stream ->
          FileOutputStream(temporary).use { output -> stream.copyTo(output) }
        }
      }
      else -> {
        val path = source.removePrefix("file://")
        File(path).inputStream().use { input ->
          FileOutputStream(temporary).use { output -> input.copyTo(output) }
        }
      }
    }
    if (temporary.length() <= 0L) throw IOException("Wallpaper image is empty")
  }

  companion object {
    const val PREFS = "zharph_wallpaper"
    const val KEY_IMAGE = "image_path"
    const val KEY_FOREGROUND = "foreground_path"
    const val KEY_FOREGROUND_MASK = "foreground_mask_path"
    const val KEY_EDGE_SHARPNESS = "foreground_edge_sharpness"
    const val DEFAULT_EDGE_SHARPNESS = 3.0
    const val MAX_EDGE_SHARPNESS = 32f
    // Masks come from the analysis image (<= 640 px long side = ~0.3 MP); anything above this is rejected.
    const val MAX_MASK_PIXELS = 2_500_000L
    const val KEY_NX = "clock_nx"
    const val KEY_NY = "clock_ny"
    const val KEY_VERSION = "version"
    const val KEY_CALENDAR = "clock_calendar"
    const val CALENDAR_GREGORIAN = "gregorian"
    const val CALENDAR_PERSIAN = "persian"
    private const val TAG = "ZharphWallpaper"
  }
}
