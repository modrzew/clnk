package dev.hotarubi.clnk

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
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
  }
}
