package dev.hotarubi.clnk

import android.Manifest
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.util.Base64
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.content.IntentCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import java.io.InputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import org.json.JSONArray
import org.json.JSONObject

class MainActivity : TauriActivity() {
  private var webView: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Edge to edge, the WebView would draw under the system bars and the keyboard, and it can't tell
    // the page about the keyboard. Keeping it clear of them shrinks the page instead, like a browser.
    // The insets are consumed so the page doesn't add its own safe-area padding on top.
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or
          WindowInsetsCompat.Type.displayCutout() or
          WindowInsetsCompat.Type.ime(),
      )
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }
    // From Android 17 the WebView can't reach the local network, where the backend usually is, until
    // the user grants this. The page's client keeps retrying, so it connects once the permission is in.
    if (
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.CINNAMON_BUN &&
      checkSelfPermission(Manifest.permission.ACCESS_LOCAL_NETWORK) != PackageManager.PERMISSION_GRANTED
    ) {
      requestPermissions(arrayOf(Manifest.permission.ACCESS_LOCAL_NETWORK), 0)
    }
    // Not when the activity is recreated or reopened from the recent apps, which repeats the intent.
    if (savedInstanceState == null && (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) == 0) {
      receive(intent, launch = true)
    }
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    receive(intent, launch = false)
  }

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    webView.addJavascriptInterface(SystemBars(), "clnkSystemBars")
    webView.addJavascriptInterface(AppIcon(), "clnkAppIcon")
    webView.addJavascriptInterface(Share(), "clnkShare")
  }

  // The system bars are outside the page, and its theme needn't be the system's. The page calls this so
  // the window behind them shows its background, with icons readable on it. R8 keeps it by a rule in
  // proguard-rules.pro.
  inner class SystemBars {
    @JavascriptInterface
    fun update(background: String, dark: Boolean) {
      runOnUiThread {
        window.setBackgroundDrawable(ColorDrawable(Color.parseColor(background)))
        WindowCompat.getInsetsController(window, window.decorView).run {
          isAppearanceLightStatusBars = !dark
          isAppearanceLightNavigationBars = !dark
        }
      }
    }
  }

  // The launcher entries are the activity aliases in AndroidManifest.xml, one per icon, and the launcher
  // shows the enabled one. The page calls this with its icon setting on every start, so it also puts
  // things right if they ever differ. R8 keeps it by a rule in proguard-rules.pro.
  inner class AppIcon {
    @JavascriptInterface
    fun set(icon: String) {
      val chosen = ICON_ALIASES[icon] ?: return
      // The new one first, so there's never a moment without a launcher entry.
      setAliasEnabled(chosen, true)
      for (other in ICON_ALIASES.values) if (other != chosen) setAliasEnabled(other, false)
    }
  }

  private fun setAliasEnabled(alias: String, enabled: Boolean) {
    packageManager.setComponentEnabledSetting(
      ComponentName(this, "dev.hotarubi.clnk.$alias"),
      if (enabled) PackageManager.COMPONENT_ENABLED_STATE_ENABLED
      else PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
      PackageManager.DONT_KILL_APP,
    )
  }

  // Files other apps share to this one, from the share sheet. They come with the intent that starts the
  // activity, or with a new one while it runs, and wait here for the page to take them.
  private class Received(val launch: Boolean, val files: List<Uri>)

  private val received = mutableListOf<Received>()
  // The files the page took, by ID, and the ones it's reading.
  private val sharedFiles = ConcurrentHashMap<String, Uri>()
  private val openFiles = ConcurrentHashMap<String, InputStream>()
  private val nextFileId = AtomicInteger()

  private fun receive(intent: Intent, launch: Boolean) {
    val files = when (intent.action) {
      Intent.ACTION_SEND ->
        listOfNotNull(IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java))
      Intent.ACTION_SEND_MULTIPLE ->
        IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)
          ?.filterNotNull().orEmpty()
      else -> return
    }
    // Files only. Text that comes with them, often the other app's caption, is left out.
    if (files.isEmpty()) return
    synchronized(received) { received.add(Received(launch, files)) }
    // A page that's still loading takes it once it starts.
    webView?.evaluateJavascript("dispatchEvent(new Event('clnkshare'))", null)
  }

  // The page takes what was shared through this. It only gets strings from here, so it reads the files in
  // base64 parts. They're read from the other app, which allows that for as long as this app's task runs.
  // R8 keeps it by a rule in proguard-rules.pro.
  inner class Share {
    /** What was shared since the last call, as JSON: `[{launch, files: [{id, name, type, size}]}]`. */
    @JavascriptInterface
    fun take(): String {
      val taken = synchronized(received) { received.toList().also { received.clear() } }
      return JSONArray(
        taken.map { share ->
          JSONObject()
            .put("launch", share.launch)
            .put("files", JSONArray(share.files.map { describe(it) }))
        },
      ).toString()
    }

    /** The next part of a file in base64, an empty string at its end, or null if it can't be read. */
    @JavascriptInterface
    fun read(id: String): String? {
      val uri = sharedFiles[id] ?: return null
      return try {
        val stream = openFiles[id] ?: contentResolver.openInputStream(uri)?.also { openFiles[id] = it }
        if (stream == null) {
          close(id)
          return null
        }
        val part = ByteArray(SHARE_PART_BYTES)
        var length = 0
        while (length < part.size) {
          val read = stream.read(part, length, part.size - length)
          if (read < 0) break
          length += read
        }
        if (length == 0) close(id)
        Base64.encodeToString(part, 0, length, Base64.NO_WRAP)
      } catch (e: Exception) {
        close(id)
        null
      }
    }

    /** Done with a file, whether or not it was read to the end. */
    @JavascriptInterface
    fun close(id: String) {
      sharedFiles.remove(id)
      try {
        openFiles.remove(id)?.close()
      } catch (e: Exception) {}
    }
  }

  /** A shared file's ID for reading it, with its name, type and size (-1 if unknown). */
  private fun describe(uri: Uri): JSONObject {
    val id = nextFileId.getAndIncrement().toString()
    sharedFiles[id] = uri
    var name: String? = null
    var size = -1L
    var type: String? = null
    // Not every app's provider has these, and file URIs have none.
    try {
      val columns = arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
      contentResolver.query(uri, columns, null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) {
          val nameColumn = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
          val sizeColumn = cursor.getColumnIndex(OpenableColumns.SIZE)
          if (nameColumn >= 0) name = cursor.getString(nameColumn)
          if (sizeColumn >= 0 && !cursor.isNull(sizeColumn)) size = cursor.getLong(sizeColumn)
        }
      }
      type = contentResolver.getType(uri)
    } catch (e: Exception) {}
    return JSONObject()
      .put("id", id)
      .put("name", name?.takeIf { it.isNotBlank() } ?: uri.lastPathSegment ?: "file")
      .put("type", type.orEmpty())
      .put("size", size)
  }

  private companion object {
    // The values of the app icon setting, and their aliases in the manifest.
    val ICON_ALIASES = mapOf("default" to "DefaultIcon", "waifu" to "WaifuIcon")

    // Shared files go to the page in parts of this size, so a large one is never whole here, nor one
    // string there.
    const val SHARE_PART_BYTES = 1024 * 1024
  }
}
