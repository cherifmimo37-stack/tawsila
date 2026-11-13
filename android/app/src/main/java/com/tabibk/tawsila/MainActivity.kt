
package com.tabibk.tawsila

import android.app.Activity
import android.os.Bundle
import android.graphics.Color
import android.content.Intent
import android.net.Uri
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.widget.Toast

class MainActivity : Activity() {

    private lateinit var webView: WebView

    private val appUrl = "https://tawsila-rdxk.onrender.com/"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        window.statusBarColor = Color.rgb(7, 17, 30)

        webView = WebView(this)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
        }

        webView.webViewClient = object : WebViewClient() {

            override fun shouldOverrideUrlLoading(
                view: WebView?,
                request: WebResourceRequest?
            ): Boolean {

                val uri = request?.url ?: return false
                val scheme = uri.scheme ?: return false
                val host = uri.host ?: ""

                if (scheme == "http" || scheme == "https") {
                    if (host == "tawsila-rdxk.onrender.com") {
                        return false
                    }
                }

                try {
                    startActivity(Intent(Intent.ACTION_VIEW, uri))
                } catch (e: Exception) {
                    Toast.makeText(
                        this@MainActivity,
                        "تعذر فتح الرابط",
                        Toast.LENGTH_SHORT
                    ).show()
                }

                return true
            }
        }

        
webView.settings.apply {
    setGeolocationEnabled(true)
}

webView.webChromeClient = object : WebChromeClient() {

    override fun onGeolocationPermissionsShowPrompt(
        origin: String?,
        callback: android.webkit.GeolocationPermissions.Callback?
    ) {

        if (origin == "https://tawsila-rdxk.onrender.com") {

            if (
                checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION) ==
                    android.content.pm.PackageManager.PERMISSION_GRANTED ||
                checkSelfPermission(android.Manifest.permission.ACCESS_COARSE_LOCATION) ==
                    android.content.pm.PackageManager.PERMISSION_GRANTED
            ) {
                callback?.invoke(origin, true, false)
            } else {
                callback?.invoke(origin, false, false)

                requestPermissions(
                    arrayOf(
                        android.Manifest.permission.ACCESS_FINE_LOCATION,
                        android.Manifest.permission.ACCESS_COARSE_LOCATION
                    ),
                    1001
                )
            }

        } else {
            callback?.invoke(origin, false, false)
        }
    }
}

        setContentView(webView)

        if (savedInstanceState == null) {
            webView.loadUrl(appUrl)
        } else {
            webView.restoreState(savedInstanceState)
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        webView.saveState(outState)
        super.onSaveInstanceState(outState)
    }

    @Deprecated("Deprecated in Android")
    override fun onBackPressed() {
        if (this::webView.isInitialized && webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }

    override fun onDestroy() {
        if (this::webView.isInitialized) {
            webView.destroy()
        }
        super.onDestroy()
    }
}
