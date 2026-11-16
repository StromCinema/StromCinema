package com.strom.cinema;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.SocketException;
import java.util.Enumeration;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * The only native bridge the TV front end needs:
 *   play()           opens the ExoPlayer screen (PlayerActivity) and resolves with where the viewer stopped
 *   discoverServer() finds the Strøm server on the LAN via mDNS (_strom._tcp)
 *   getLocalIp()     this TV's LAN address, so the web side can probe its own subnet if mDNS is blocked
 *   get/set/clearServer()  remembers the connected server in SharedPreferences
 */
@CapacitorPlugin(name = "StromPlayer")
public class StromPlayerPlugin extends Plugin {

    private static final String TAG = "StromPlayerPlugin";
    private static final String PREFS_NAME = "strom_prefs";
    private static final String KEY_SERVER = "server_host";

    // ─── PLAYBACK ───────────────────────────────────────────────────────────
    @PluginMethod
    public void play(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) { call.reject("url is required"); return; }

        // NOT call.getLong(): the bridge hands whole-number ms values over as Integer and
        // getLong() silently falls back to 0. optLong() on the raw JSON coerces correctly.
        long startTimeMs = call.getData().optLong("startTimeMs", 0L);
        Log.d(TAG, "play() title=" + call.getString("title", "") + " startTimeMs=" + startTimeMs);

        Intent intent = new Intent(getContext(), PlayerActivity.class);
        intent.putExtra("url",         url);
        intent.putExtra("title",       call.getString("title", ""));
        intent.putExtra("startTimeMs", startTimeMs);
        intent.putExtra("movieId",     call.getString("movieId", ""));
        intent.putExtra("progressUrl", call.getString("progressUrl", ""));

        // audio / subtitle choices from the shelf (all optional)
        if (call.hasOption("audioIndex"))    intent.putExtra("audioTrack",    call.getInt("audioIndex", -1));
        if (call.hasOption("subtitleIndex")) intent.putExtra("subtitleTrack", call.getInt("subtitleIndex", -1));
        intent.putExtra("subtitleOff",     call.getBoolean("subtitleOff", false));
        intent.putExtra("subUrl",          call.getString("subUrl", ""));
        intent.putExtra("subMime",         call.getString("subMime", ""));
        intent.putExtra("subLang",         call.getString("subLang", ""));
        intent.putExtra("subEmbCount",     call.getInt("subEmbCount", 0));
        intent.putExtra("preferredAudio",    call.getString("preferredAudio", ""));
        intent.putExtra("preferredSubtitle", call.getString("preferredSubtitle", ""));

        // Resolves the original JS promise from handlePlayerResult() when PlayerActivity finishes.
        startActivityForResult(call, intent, "handlePlayerResult");
    }

    @ActivityCallback
    private void handlePlayerResult(PluginCall call, ActivityResult result) {
        if (call == null) return; // process was killed while playing — nothing to resolve

        JSObject payload = new JSObject();
        Intent data = result.getData();
        if (data != null) {
            payload.put("positionMs", data.getLongExtra(PlayerActivity.EXTRA_POSITION_MS, 0L));
            payload.put("durationMs", data.getLongExtra("durationMs", 0L));
        } else {
            payload.put("positionMs", 0L);
            payload.put("durationMs", 0L);
        }
        call.resolve(payload);
    }

    // ─── SAVED SERVER ───────────────────────────────────────────────────────
    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    @PluginMethod
    public void getServer(PluginCall call) {
        JSObject result = new JSObject();
        result.put("host", prefs().getString(KEY_SERVER, ""));
        call.resolve(result);
    }

    @PluginMethod
    public void setServer(PluginCall call) {
        prefs().edit().putString(KEY_SERVER, call.getString("host", "")).apply();
        call.resolve();
    }

    @PluginMethod
    public void clearServer(PluginCall call) {
        prefs().edit().remove(KEY_SERVER).apply();
        call.resolve();
    }

    // ─── TRAILER FALLBACK ───────────────────────────────────────────────────
    /** Opens a YouTube trailer in the YouTube app, or the browser if the app is missing. */
    @PluginMethod
    public void openYouTube(PluginCall call) {
        String key = call.getString("key", "");
        if (!key.matches("[\\w-]{6,20}")) { call.reject("bad id"); return; }
        try {
            Intent app = new Intent(Intent.ACTION_VIEW, android.net.Uri.parse("vnd.youtube:" + key));
            app.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(app);
        } catch (Exception e) {
            try {
                Intent web = new Intent(Intent.ACTION_VIEW, android.net.Uri.parse("https://www.youtube.com/watch?v=" + key));
                web.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(web);
            } catch (Exception e2) { call.reject("no app can open the trailer"); return; }
        }
        call.resolve();
    }

    // ─── AUDIO FORMATS THE TV CAN PLAY ──────────────────────────────────────
    /** Which surround formats this device + TV/receiver accept as direct (passthrough) playback. */
    @PluginMethod
    public void getAudioSupport(PluginCall call) {
        JSObject r = new JSObject();
        r.put("truehd", direct(android.media.AudioFormat.ENCODING_DOLBY_TRUEHD, android.media.AudioFormat.CHANNEL_OUT_7POINT1_SURROUND, 48000));
        r.put("dtshd",  direct(android.media.AudioFormat.ENCODING_DTS_HD, android.media.AudioFormat.CHANNEL_OUT_7POINT1_SURROUND, 48000));
        r.put("dts",    direct(android.media.AudioFormat.ENCODING_DTS, android.media.AudioFormat.CHANNEL_OUT_5POINT1, 48000));
        r.put("eac3",   direct(android.media.AudioFormat.ENCODING_E_AC3, android.media.AudioFormat.CHANNEL_OUT_5POINT1, 48000));
        call.resolve(r);
    }

    private boolean direct(int encoding, int channelMask, int rate) {
        // AudioTrack.isDirectPlaybackSupported needs Android 10 (API 29); older -> unknown, treated as "not supported"
        if (android.os.Build.VERSION.SDK_INT < 29) return false;
        try {
            android.media.AudioFormat fmt = new android.media.AudioFormat.Builder()
                .setEncoding(encoding).setSampleRate(rate).setChannelMask(channelMask).build();
            android.media.AudioAttributes attrs = new android.media.AudioAttributes.Builder()
                .setUsage(android.media.AudioAttributes.USAGE_MEDIA)
                .setContentType(android.media.AudioAttributes.CONTENT_TYPE_MOVIE).build();
            return android.media.AudioTrack.isDirectPlaybackSupported(fmt, attrs);
        } catch (Throwable t) {
            return false;
        }
    }

    // ─── LOCAL ADDRESS ──────────────────────────────────────────────────────
    @PluginMethod
    public void getLocalIp(PluginCall call) {
        JSObject result = new JSObject();
        result.put("ip", "");
        try {
            Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
            while (interfaces != null && interfaces.hasMoreElements()) {
                NetworkInterface ni = interfaces.nextElement();
                if (!ni.isUp() || ni.isLoopback()) continue;
                Enumeration<InetAddress> addresses = ni.getInetAddresses();
                while (addresses.hasMoreElements()) {
                    InetAddress address = addresses.nextElement();
                    if (address instanceof Inet4Address && address.isSiteLocalAddress()) {
                        result.put("ip", address.getHostAddress());
                        call.resolve(result);
                        return;
                    }
                }
            }
        } catch (SocketException ignored) {
            // fall through: empty ip
        }
        call.resolve(result);
    }

    // ─── mDNS DISCOVERY ─────────────────────────────────────────────────────
    // Finds the Strøm server on the LAN via NsdManager (_strom._tcp), which the server
    // advertises via bonjour-service. Subnet-agnostic — works on any home network without
    // knowing its IP range ahead of time. The web side falls back to probing its own
    // subnet if this comes back empty (e.g. router has multicast disabled).
    private static final String STROM_SERVICE_TYPE = "_strom._tcp.";
    private static final long DISCOVERY_TIMEOUT_MS = 4000L;

    @PluginMethod
    public void discoverServer(PluginCall call) {
        NsdManager nsdManager = (NsdManager) getContext().getSystemService(Context.NSD_SERVICE);
        if (nsdManager == null) { call.reject("NsdManager unavailable on this device"); return; }

        // Guards against resolving/rejecting the call twice — the timeout
        // and a genuine resolveService() success can otherwise race.
        AtomicBoolean settled = new AtomicBoolean(false);
        Handler mainHandler = new Handler(Looper.getMainLooper());

        NsdManager.DiscoveryListener[] listenerHolder = new NsdManager.DiscoveryListener[1];

        Runnable stopDiscoverySafely = () -> {
            if (listenerHolder[0] != null) {
                try { nsdManager.stopServiceDiscovery(listenerHolder[0]); } catch (Exception ignored) {}
            }
        };

        Runnable timeoutRunnable = () -> {
            if (settled.compareAndSet(false, true)) {
                stopDiscoverySafely.run();
                call.reject("No Strøm server found via mDNS");
            }
        };
        mainHandler.postDelayed(timeoutRunnable, DISCOVERY_TIMEOUT_MS);

        NsdManager.ResolveListener resolveListener = new NsdManager.ResolveListener() {
            @Override
            public void onResolveFailed(NsdServiceInfo serviceInfo, int errorCode) {
                // Resolution failed for this instance — keep discovering,
                // the timeout above will fire if nothing else resolves.
            }

            @Override
            public void onServiceResolved(NsdServiceInfo serviceInfo) {
                InetAddress host = serviceInfo.getHost();
                // The web side builds "host:port" URLs, so only an IPv4 address is usable here.
                if (!(host instanceof Inet4Address)) return;
                if (settled.compareAndSet(false, true)) {
                    mainHandler.removeCallbacks(timeoutRunnable);
                    stopDiscoverySafely.run();

                    JSObject result = new JSObject();
                    result.put("host", host.getHostAddress());
                    result.put("port", serviceInfo.getPort());
                    call.resolve(result);
                }
            }
        };

        NsdManager.DiscoveryListener discoveryListener = new NsdManager.DiscoveryListener() {
            @Override public void onDiscoveryStarted(String serviceType) {}

            @Override
            public void onServiceFound(NsdServiceInfo serviceInfo) {
                if (serviceInfo.getServiceType().contains("strom")) {
                    try { nsdManager.resolveService(serviceInfo, resolveListener); } catch (Exception ignored) {}
                }
            }

            @Override public void onServiceLost(NsdServiceInfo serviceInfo) {}
            @Override public void onDiscoveryStopped(String serviceType) {}

            @Override
            public void onStartDiscoveryFailed(String serviceType, int errorCode) {
                if (settled.compareAndSet(false, true)) {
                    mainHandler.removeCallbacks(timeoutRunnable);
                    call.reject("Failed to start mDNS discovery, error code " + errorCode);
                }
            }

            @Override public void onStopDiscoveryFailed(String serviceType, int errorCode) {}
        };

        listenerHolder[0] = discoveryListener;
        nsdManager.discoverServices(STROM_SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discoveryListener);
    }
}
