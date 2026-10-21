package com.zharph.wallpaper

import android.annotation.TargetApi
import android.app.WallpaperColors
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.res.Resources
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.Rect
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.service.wallpaper.WallpaperService
import android.util.Log
import android.text.format.DateFormat as AndroidDateFormat
import android.view.SurfaceHolder
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import kotlin.math.max
import kotlin.math.min

// Everything the background loader needs, read from prefs in one go so image, cutout and clock position stay consistent.
private class LoadRequest(
  val version: Long,
  val width: Int,
  val height: Int,
  val imagePath: String?,
  val foregroundPath: String?,
  val maskPath: String?,
  val edgeSharpness: Float,
  val nx: Float,
  val ny: Float,
  val calendar: String,
)

class ZharphWallpaperService : WallpaperService() {
  override fun onCreateEngine(): Engine = ZharphEngine()

  private companion object {
    const val MAX_LOAD_RETRIES = 5
    const val TAG = "ZharphWallpaper"
  }

  inner class ZharphEngine : Engine() {
    private val handler = Handler(Looper.getMainLooper())
    private var visible = false
    private var destroyed = false

    // Both bitmaps are pre-cropped/scaled to the screen once, so every redraw is a plain 1:1 blit.
    private var image: Bitmap? = null
    private var foreground: Bitmap? = null
    private var loadedVersion = -1L
    private var loadedW = 0
    private var loadedH = 0
    private var surfaceW = 0
    private var surfaceH = 0
    private var nx = 0.18f
    private var ny = 0.07f
    private var calendar = ZharphWallpaperModule.CALENDAR_GREGORIAN

    // Load failures: the failed request is remembered separately, loadedVersion is NOT touched, so a failed load is
    // retried (with backoff, bounded) instead of leaving a black screen forever.
    private var failedVersion = -2L
    private var failedW = 0
    private var failedH = 0
    private var failCount = 0
    private var nextRetryAt = 0L

    // Decoding runs on this single background thread. The old bitmaps stay on screen until the new pair is
    // ready and both are swapped in together on the main thread (no flicker, no half-updated state).
    private val loader: ExecutorService = Executors.newSingleThreadExecutor()
    private var loading = false
    private var pendingVersion = -1L
    private var pendingW = 0
    private var pendingH = 0
    @Volatile private var generation = 0

    private val now = Date()

    private val retryLoad = Runnable { if (!destroyed && visible) draw() }

    private val bitmapPaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
    private val timePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color = Color.WHITE
      typeface = android.graphics.Typeface.create("sans-serif-light", android.graphics.Typeface.NORMAL)
      textAlign = Paint.Align.CENTER
      setShadowLayer(8f, 0f, 2f, 0x59000000)
    }
    private val datePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color = 0xEBFFFFFF.toInt()
      typeface = android.graphics.Typeface.create("sans-serif-light", android.graphics.Typeface.NORMAL)
      textAlign = Paint.Align.CENTER
      setShadowLayer(5f, 0f, 1f, 0x59000000)
    }

    private val redraw = object : Runnable {
      override fun run() {
        if (!visible) return
        draw()
        scheduleNextMinute()
      }
    }

    // Timezone / manual clock changes: redraw right away instead of showing a stale time until the next tick.
    private val timeChangedReceiver = object : BroadcastReceiver() {
      override fun onReceive(context: Context?, intent: Intent?) {
        if (destroyed || !visible) return // when it becomes visible again, draw() builds fresh formats anyway
        draw()
        scheduleNextMinute()
      }
    }
    private var receiverRegistered = false

    override fun onCreate(surfaceHolder: SurfaceHolder) {
      super.onCreate(surfaceHolder)
      surfaceHolder.setFormat(android.graphics.PixelFormat.RGBA_8888)
      try {
        registerReceiver(
          timeChangedReceiver,
          IntentFilter().apply {
            addAction(Intent.ACTION_TIMEZONE_CHANGED)
            addAction(Intent.ACTION_TIME_CHANGED) // also sent when the 12/24h setting is toggled (untested)
            addAction(Intent.ACTION_LOCALE_CHANGED)
          }
        )
        receiverRegistered = true
      } catch (_: Throwable) {
        // formats are rebuilt on every draw, so the clock is still correct on the next minute tick
      }
    }

    override fun onSurfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
      super.onSurfaceChanged(holder, format, width, height)
      surfaceW = width
      surfaceH = height
      draw()
    }

    override fun onSurfaceCreated(holder: SurfaceHolder) {
      super.onSurfaceCreated(holder)
      draw()
    }

    override fun onVisibilityChanged(isVisible: Boolean) {
      visible = isVisible
      if (isVisible) {
        resetRetry() // screen on = a fresh attempt if the last load failed
        draw() // reloads only if the app applied a new wallpaper
        scheduleNextMinute()
      } else {
        handler.removeCallbacks(redraw)
      }
    }

    override fun onSurfaceDestroyed(holder: SurfaceHolder) {
      handler.removeCallbacks(redraw)
      super.onSurfaceDestroyed(holder)
    }

    override fun onDestroy() {
      destroyed = true
      generation++ // any decode still running is now stale
      handler.removeCallbacks(redraw)
      handler.removeCallbacks(retryLoad)
      if (receiverRegistered) {
        try { unregisterReceiver(timeChangedReceiver) } catch (_: IllegalArgumentException) {}
        receiverRegistered = false
      }
      loader.shutdownNow()
      image?.recycle()
      foreground?.recycle()
      image = null
      foreground = null
      super.onDestroy()
    }

    // WallpaperColors / onComputeColors need API 27; the framework never calls this below that, the check is a safety net.
    @TargetApi(Build.VERSION_CODES.O_MR1)
    override fun onComputeColors(): WallpaperColors? {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O_MR1) return null
      val bitmap = image ?: return null
      return WallpaperColors.fromBitmap(bitmap)
    }

    // Starts a background decode + crop only when the wallpaper (or screen size) actually changed. Never blocks.
    private fun ensureLoaded() {
      if (destroyed || surfaceW <= 0 || surfaceH <= 0) return
      val prefs = getSharedPreferences(ZharphWallpaperModule.PREFS, MODE_PRIVATE)
      val version = prefs.getLong(ZharphWallpaperModule.KEY_VERSION, 0L)
      if (version == loadedVersion && surfaceW == loadedW && surfaceH == loadedH) return
      if (loading && version == pendingVersion && surfaceW == pendingW && surfaceH == pendingH) return
      if (failCount > 0 && version == failedVersion && surfaceW == failedW && surfaceH == failedH) {
        // same request already failed: wait for the backoff, and stop after MAX_LOAD_RETRIES until screen-on / new wallpaper
        if (failCount >= MAX_LOAD_RETRIES || SystemClock.elapsedRealtime() < nextRetryAt) return
      }

      val request = LoadRequest(
        version = version,
        width = surfaceW,
        height = surfaceH,
        imagePath = prefs.getString(ZharphWallpaperModule.KEY_IMAGE, null),
        foregroundPath = prefs.getString(ZharphWallpaperModule.KEY_FOREGROUND, null),
        maskPath = prefs.getString(ZharphWallpaperModule.KEY_FOREGROUND_MASK, null),
        edgeSharpness = prefs.getFloat(ZharphWallpaperModule.KEY_EDGE_SHARPNESS, ZharphWallpaperModule.DEFAULT_EDGE_SHARPNESS.toFloat()),
        nx = prefs.getFloat(ZharphWallpaperModule.KEY_NX, 0.18f),
        ny = prefs.getFloat(ZharphWallpaperModule.KEY_NY, 0.07f),
        calendar = prefs.getString(ZharphWallpaperModule.KEY_CALENDAR, ZharphWallpaperModule.CALENDAR_GREGORIAN)
          ?: ZharphWallpaperModule.CALENDAR_GREGORIAN,
      )
      val token = ++generation
      loading = true
      pendingVersion = version
      pendingW = surfaceW
      pendingH = surfaceH
      try {
        loader.execute { runLoad(token, request) }
      } catch (_: RejectedExecutionException) {
        loading = false
      }
    }

    // Background thread: only touches its own bitmaps, then hands the result to the main thread.
    private fun runLoad(token: Int, request: LoadRequest) {
      var img: Bitmap? = null
      var fg: Bitmap? = null
      var ok = true
      try {
        val imagePath = request.imagePath
        img = imagePath?.let { decodeFitted(it, request.width, request.height) }
        if (token == generation) {
          val maskPath = request.maskPath
          val cutoutPath = request.foregroundPath
          fg = when {
            // New path: foreground = the wallpaper bitmap itself with the scaled mask applied (DST_IN), built once here.
            // A missing / undecodable mask is not a load failure (same as a missing cutout): no foreground is shown.
            maskPath != null -> if (img != null && imagePath != null) buildMaskedForeground(img, imagePath, maskPath, request.edgeSharpness) else null
            // Old path: a full-resolution cutout PNG/WebP, decoded and fitted like the image.
            cutoutPath != null -> decodeFitted(cutoutPath, request.width, request.height)
            else -> null
          }
        }
      } catch (_: Throwable) { // includes OutOfMemoryError: keep what is on screen instead of crashing
        ok = false
        img?.recycle()
        fg?.recycle()
        img = null
        fg = null
      }
      val resultImage = img
      val resultForeground = fg
      handler.post { onLoaded(token, request, resultImage, resultForeground, ok) }
    }

    // Main thread: swap both bitmaps (and the clock position) in one step, then redraw.
    private fun onLoaded(token: Int, request: LoadRequest, img: Bitmap?, fg: Bitmap?, ok: Boolean) {
      if (destroyed || token != generation) { // superseded by a newer request (or gone): drop this result
        img?.recycle()
        fg?.recycle()
        return
      }
      loading = false
      // A set image path that did not decode (missing / corrupt file) is a failure too, not just an exception.
      val failed = !ok || (request.imagePath != null && img == null)
      if (failed) {
        img?.recycle()
        fg?.recycle()
        failedVersion = request.version
        failedW = request.width
        failedH = request.height
        failCount++
        val delay = min(30_000L, 2_000L shl min(failCount - 1, 4))
        nextRetryAt = SystemClock.elapsedRealtime() + delay
        handler.removeCallbacks(retryLoad)
        if (failCount < MAX_LOAD_RETRIES) handler.postDelayed(retryLoad, delay)
        // loadedVersion stays as it was; whatever is on screen (old wallpaper, or black + clock) stays.
        draw()
        return
      }
      resetRetry()
      image?.recycle()
      foreground?.recycle()
      image = img
      foreground = fg
      nx = request.nx
      ny = request.ny
      calendar = request.calendar
      loadedVersion = request.version
      loadedW = request.width
      loadedH = request.height
      // WallpaperColors needs API 27
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
        try { notifyColorsChanged() } catch (_: Throwable) {}
      }
      draw()
    }

    private fun resetRetry() {
      failedVersion = -2L
      failCount = 0
      nextRetryAt = 0L
      handler.removeCallbacks(retryLoad)
    }

    private fun decodeFitted(path: String, targetW: Int, targetH: Int): Bitmap? {
      val file = File(path)
      if (!file.exists()) return null

      val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      BitmapFactory.decodeFile(path, bounds)
      if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null

      var sample = 1
      while (bounds.outWidth / (sample * 2) >= targetW && bounds.outHeight / (sample * 2) >= targetH) sample *= 2
      val source = BitmapFactory.decodeFile(path, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null

      val scale = max(targetW.toFloat() / source.width, targetH.toFloat() / source.height)
      val cropW = minOf(source.width.toFloat(), targetW / scale)
      val cropH = minOf(source.height.toFloat(), targetH / scale)
      val left = ((source.width - cropW) / 2f).toInt()
      val top = ((source.height - cropH) / 2f).toInt()

      val out = Bitmap.createBitmap(targetW, targetH, Bitmap.Config.ARGB_8888)
      Canvas(out).drawBitmap(
        source,
        Rect(left, top, (left + cropW).toInt(), (top + cropH).toInt()),
        Rect(0, 0, targetW, targetH),
        bitmapPaint
      )
      source.recycle()
      return out
    }

    // Where decodeFitted's centre crop lies, as fractions of the source: [left, top, width, height] in 0..1.
    // It depends only on the aspect ratios, so it is the same for the photo and for the (smaller, same-aspect) mask.
    private fun cropFraction(srcW: Int, srcH: Int, targetW: Int, targetH: Int): FloatArray {
      val scale = max(targetW.toFloat() / srcW, targetH.toFloat() / srcH)
      val w = min(1f, targetW / (scale * srcW))
      val h = min(1f, targetH / (scale * srcH))
      return floatArrayOf((1f - w) / 2f, (1f - h) / 2f, w, h)
    }

    // Reads the mask PNG (white RGB + alpha, from encodeForegroundMask) as a small ALPHA_8 bitmap. An opaque grey PNG is
    // accepted too (grey level = mask). Returns null if the file is missing, unreadable or larger than the module allows.
    private fun decodeMask(path: String): Bitmap? {
      val file = File(path)
      if (!file.exists()) return null
      val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      BitmapFactory.decodeFile(path, bounds)
      if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
      if (bounds.outWidth.toLong() * bounds.outHeight.toLong() > ZharphWallpaperModule.MAX_MASK_PIXELS) return null
      val decoded = BitmapFactory.decodeFile(path, BitmapFactory.Options().apply { inPreferredConfig = Bitmap.Config.ARGB_8888 })
        ?: return null
      try {
        if (decoded.hasAlpha()) return decoded.extractAlpha()
        // no alpha channel: move the grey level (green channel) into alpha, then extract it
        val w = decoded.width
        val h = decoded.height
        val pixels = IntArray(w * h)
        decoded.getPixels(pixels, 0, w, 0, 0, w, h)
        for (i in pixels.indices) pixels[i] = ((pixels[i] shr 8) and 0xFF) shl 24
        val asAlpha = Bitmap.createBitmap(pixels, w, h, Bitmap.Config.ARGB_8888)
        try { return asAlpha.extractAlpha() } finally { asAlpha.recycle() }
      } finally {
        decoded.recycle()
      }
    }

    // alpha' = clamp(s * (alpha - 0.5) + 0.5) on the 0..255 scale (Android ColorMatrix offsets are in 0..255); same ramp as
    // edgeMatrix() in tools.js. s <= 1: no filter. Applied to the already upscaled mask because it is part of the same draw.
    private fun sharpenFilter(s: Float): ColorMatrixColorFilter? {
      if (!(s > 1f)) return null
      return ColorMatrixColorFilter(
        ColorMatrix(
          floatArrayOf(
            1f, 0f, 0f, 0f, 0f,
            0f, 1f, 0f, 0f, 0f,
            0f, 0f, 1f, 0f, 0f,
            0f, 0f, 0f, s, 127.5f * (1f - s),
          )
        )
      )
    }

    // Runs once per load, on the loader thread. Returns a screen-sized bitmap that is `base` where the mask is 1 and
    // transparent where it is 0, so draw() only blits it. One draw does: bilinear scale of the small mask to the screen
    // (the same centre crop as decodeFitted) -> edge sharpening -> DST_IN. Memory: one copy of `base` + the small mask;
    // no full-resolution decode. null = no mask to apply; exceptions (incl. OOM) propagate to runLoad (= a failed load).
    private fun buildMaskedForeground(base: Bitmap, photoPath: String, maskPath: String, sharpness: Float): Bitmap? {
      val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      BitmapFactory.decodeFile(photoPath, bounds)
      if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
      val mask = decodeMask(maskPath)
      if (mask == null) {
        Log.w(TAG, "Foreground mask missing or unreadable; showing no foreground")
        return null
      }
      var out: Bitmap? = null
      try {
        val crop = cropFraction(bounds.outWidth, bounds.outHeight, base.width, base.height)
        val sx = base.width / (crop[2] * mask.width)
        val sy = base.height / (crop[3] * mask.height)
        val matrix = Matrix().apply {
          setScale(sx, sy)
          postTranslate(-crop[0] * mask.width * sx, -crop[1] * mask.height * sy)
        }
        val copy = base.copy(Bitmap.Config.ARGB_8888, true) ?: throw IllegalStateException("Could not copy the wallpaper bitmap")
        out = copy
        val paint = Paint(Paint.FILTER_BITMAP_FLAG).apply {
          xfermode = PorterDuffXfermode(PorterDuff.Mode.DST_IN)
          colorFilter = sharpenFilter(sharpness)
        }
        Canvas(copy).drawBitmap(mask, matrix, paint)
        return copy
      } catch (error: Throwable) {
        out?.recycle()
        throw error
      } finally {
        mask.recycle()
      }
    }

    private fun scheduleNextMinute() {
      handler.removeCallbacks(redraw)
      val delay = 60_000L - (System.currentTimeMillis() % 60_000L) + 250L
      handler.postDelayed(redraw, delay)
    }

    private fun draw() {
      ensureLoaded()
      // First load still running: keep the surface as it is instead of posting a black frame.
      if (loading && image == null) return
      val canvas = try { surfaceHolder.lockCanvas() } catch (_: Exception) { null } ?: return
      try {
        val width = canvas.width.toFloat()
        val height = canvas.height.toFloat()
        canvas.drawColor(Color.BLACK)

        image?.let { blit(canvas, it) }
        drawClock(canvas, width, height)
        foreground?.let { blit(canvas, it) }
      } finally {
        surfaceHolder.unlockCanvasAndPost(canvas)
      }
    }

    // 1:1 when the bitmap matches the surface; scaled only while a resize is waiting for its new bitmap.
    private fun blit(canvas: Canvas, bitmap: Bitmap) {
      if (bitmap.width == canvas.width && bitmap.height == canvas.height) {
        canvas.drawBitmap(bitmap, 0f, 0f, null)
      } else {
        canvas.drawBitmap(bitmap, null, Rect(0, 0, canvas.width, canvas.height), bitmapPaint)
      }
    }

    // The wallpaper is system-wide, so follow the system locale (not a per-app language override).
    private fun systemLocale(): Locale = try {
      val config = Resources.getSystem().configuration
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) config.locales.get(0) else @Suppress("DEPRECATION") config.locale
    } catch (_: Throwable) {
      Locale.getDefault()
    }

    // 24h: locale's own "Hm" pattern (en-US = HH:mm, the old output). 12h: "hm" without the am/pm marker (big lock-screen style clock).
    private fun formatTime(locale: Locale, is24: Boolean): String {
      val pattern = try {
        val best = AndroidDateFormat.getBestDateTimePattern(locale, if (is24) "Hm" else "hm")
        (if (is24) best else best.replace(Regex("[aB]+"), "").trim()).ifBlank { if (is24) "HH:mm" else "h:mm" }
      } catch (_: Throwable) {
        if (is24) "HH:mm" else "h:mm"
      }
      return try {
        SimpleDateFormat(pattern, locale).format(now)
      } catch (_: Throwable) {
        SimpleDateFormat("HH:mm", Locale.US).format(now)
      }
    }

    // Weekday + month + day in the user's locale (en-US gives the old "EEEE, MMMM d"). Persian calendar is opt-in.
    private fun formatDate(locale: Locale): String {
      if (calendar == ZharphWallpaperModule.CALENDAR_PERSIAN) persianDate(locale)?.let { return it }
      val pattern = try {
        AndroidDateFormat.getBestDateTimePattern(locale, "EEEEMMMMd")
      } catch (_: Throwable) {
        "EEEE, MMMM d"
      }
      return try {
        SimpleDateFormat(pattern, locale).format(now)
      } catch (_: Throwable) {
        SimpleDateFormat("EEEE, MMMM d", Locale.US).format(now)
      }
    }

    // android.icu needs API 24; below that (or on any error) null = fall back to the Gregorian date.
    private fun persianDate(locale: Locale): String? {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return null
      return try {
        val withCalendar = Locale.Builder().setLocale(locale).setUnicodeLocaleKeyword("ca", "persian").build()
        android.icu.text.DateFormat.getPatternInstance("EEEEMMMMd", withCalendar).format(now)
      } catch (_: Throwable) {
        null
      }
    }

    private fun drawClock(canvas: Canvas, width: Float, height: Float) {
      val centerX = nx * width + width * 0.64f / 2f
      val top = ny * height

      now.time = System.currentTimeMillis()
      timePaint.textSize = width * 0.22f
      datePaint.textSize = width * 0.05f

      // Built on every draw (once a minute) so a timezone / locale / 12-24h change or DST switch is always reflected.
      val locale = systemLocale()
      val timeText = formatTime(locale, AndroidDateFormat.is24HourFormat(this@ZharphWallpaperService))
      val dateText = formatDate(locale)

      val baseline = top + timePaint.textSize * 0.95f
      canvas.drawText(timeText, centerX, baseline, timePaint)
      canvas.drawText(dateText, centerX, baseline + datePaint.textSize * 1.5f, datePaint)
    }
  }
}
