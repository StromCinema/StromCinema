package com.strom.cinema;

import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.BitmapRegionDecoder;
import android.graphics.Color;
import android.graphics.Rect;
import android.graphics.Typeface;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.SeekBar;
import android.widget.TextView;
import android.widget.Toast;
import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.ActionBar;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.TrackSelectionOverride;
import androidx.media3.common.TrackSelectionParameters;
import androidx.media3.common.Tracks;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.trackselection.DefaultTrackSelector;
import androidx.media3.ui.CaptionStyleCompat;
import androidx.media3.ui.PlayerView;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicReferenceArray;

@UnstableApi
public class PlayerActivity extends AppCompatActivity {

    // ── Extras ────────────────────────────────────────────────────────────────
    private static final String EXTRA_URL            = "url";
    private static final String EXTRA_TITLE          = "title";
    private static final String EXTRA_EPISODE_LABEL  = "episodeLabel";  // inbound: e.g. "S03E01", empty for movies
    private static final String EXTRA_MOVIE_ID       = "movieId";       // inbound: server id, used for progress reports
    private static final String EXTRA_PROGRESS_URL   = "progressUrl";   // inbound: where to POST the playback position
    private static final String EXTRA_AUDIO_TRACK    = "audioTrack";
    private static final String EXTRA_SUB_TRACK      = "subtitleTrack";
    private static final String EXTRA_START_TIME_MS  = "startTimeMs";   // inbound: where to seek on launch
    public  static final String EXTRA_POSITION_MS    = "positionMs";    // outbound: position when user exits

    // ── Colors (matches Strøm orange/dark theme) ───────────────────────────
    private static final int COLOR_ORANGE      = 0xFF9D8AFF; // (name kept) Strøm accent purple
    private static final int COLOR_BTN_NORMAL  = 0x12FFFFFF;
    private static final int COLOR_BTN_FOCUSED = 0xFFFFFFFF;
    private static final int COLOR_TEXT        = 0xFFFFFFFF;
    private static final int COLOR_DARK_TEXT   = 0xFF1A1033; // text on white focused items
    private static final int COLOR_PURPLE_DEEP = 0xFF6C48EC;
    private static final int COLOR_MUTED       = 0xFFB3A8D4;

    // ── Auto-hide delay ────────────────────────────────────────────────────
    private static final long OVERLAY_TIMEOUT_MS = 4000;

    // ── Subtitle/audio picker grid ────────────────────────────────────────
    private static final int PICKER_ROWS = 7;   // visible rows in the audio/subtitle list

    // ── Player ────────────────────────────────────────────────────────────
    private ExoPlayer             player;
    private DefaultTrackSelector  trackSelector;
    private PlayerView            playerView;

    // ── Progress reporting ───────────────────────────────────────────────
    // The server remembers where you stopped. The player posts the position
    // every few seconds while playing, on pause, and on exit, so a resume point
    // survives even if the TV kills the app mid-movie.
    private String movieId;
    private String progressUrl;
    private static final long PROGRESS_INTERVAL_MS = 10_000;
    private final ExecutorService progressExecutor = Executors.newSingleThreadExecutor();
    private final Handler progressHandler = new Handler(Looper.getMainLooper());
    private final Runnable progressRunnable = new Runnable() {
        @Override public void run() {
            reportProgress();
            progressHandler.postDelayed(this, PROGRESS_INTERVAL_MS);
        }
    };

    // ── Overlay ───────────────────────────────────────────────────────────
    private LinearLayout  controlBar;
    private LinearLayout  pickerPanel;
    private LinearLayout  pickerListBox;
    private TextView      pickerCounter;
    private int           pickerTop = 0;
    private View          topScrim;
    private android.graphics.drawable.GradientDrawable seekFill;
    private Typeface fMed = Typeface.SANS_SERIF, fBold = Typeface.DEFAULT_BOLD, fTitle = Typeface.DEFAULT_BOLD;
    private boolean       overlayVisible = false;

    // ── Control bar buttons: 0=rewind 1=playpause 2=forward 3=audio 4=subs
    private final List<View> ctrlButtons = new ArrayList<>();
    private int ctrlFocusIdx = 1;

    // ── Picker ────────────────────────────────────────────────────────────
    private enum PickerMode { NONE, AUDIO, SUBS, SUB_STYLE }
    private PickerMode       pickerMode    = PickerMode.NONE;
    private final List<View> pickerButtons = new ArrayList<>();
    private int              pickerFocusIdx = 0;

    // ── Track lists ───────────────────────────────────────────────────────
    private final List<Tracks.Group> audioGroups = new ArrayList<>();
    private final List<Tracks.Group> subGroups   = new ArrayList<>();
    private int activeAudioGroup = -1;
    private int activeSubGroup   = -1;

    // ── Auto-hide ─────────────────────────────────────────────────────────
    private final Handler  hideHandler  = new Handler(Looper.getMainLooper());
    private final Runnable hideRunnable = this::hideOverlay;

    // ── Title overlay (top-left, shown with controls) ─────────────────────
    private TextView titleView;

    // ── Clock (top-right, shown with controls) ─────────────────────────────
    private TextView clockView;
    private final Handler  clockHandler  = new Handler(Looper.getMainLooper());
    private final Runnable clockRunnable = this::updateClock;
    private static final SimpleDateFormat CLOCK_FORMAT =
        new SimpleDateFormat("HH:mm", Locale.getDefault());

    // ── Info panel ────────────────────────────────────────────────────────
    private LinearLayout infoPanelView;
    private boolean      infoPanelVisible = false;

    // ── Initial indices from JS ───────────────────────────────────────────
    private int initAudioIdx;
    private int initSubIdx;
    private boolean explicitSub;      // the viewer picked the subtitle (or Off) on the shelf before starting
    private boolean explicitSubOff;
    private String subtitleSelectionPrefKey;
    private String savedSubtitleSignature;

    // ── Guard: applyInitialTracks() fires exactly once ────────────────────
    private boolean tracksApplied = false;

    // ── Guard: resume-seek fires exactly once ──────────────────────────────
    // Previously this was inferred from `player.getCurrentPosition() < 2000`,
    // which assumes the first STATE_READY event always lands before 2 real
    // seconds of playback have elapsed. On a slower buffer/start (common on
    // TV hardware, large remuxed files, or a loaded network share) that's not
    // guaranteed — STATE_READY can fire after the position has already ticked
    // past 2000ms, so the resume-seek is silently skipped and playback starts
    // from 0 despite a valid startTimeMs. A dedicated flag makes "have we
    // already applied the resume seek" explicit instead of inferring it from
    // a timing-dependent proxy.
    private boolean resumeSeekApplied = false;

    // ── Subtitle style ────────────────────────────────────────────────────
    private int   subColorIdx  = 0;          // index into SUB_COLORS; 0 = White
    private float subSizeSp    = 20f;        // sp; shown as integer in picker
    private int   subFontStyle = 0;          // 0=Regular, 1=Medium, 2=Bold

    // ── Seekbar ───────────────────────────────────────────────────────────
    private android.widget.SeekBar seekBar;
    private LinearLayout           seekRow;
    private TextView               seekTimeCurrent;
    private TextView               seekTimeTotal;
    private boolean                seekBarTracking  = false;  // user dragging?
    private boolean                seekRowFocused   = false;  // D-pad row focus
    private static final long      SEEK_STEP_MS     = 30_000; // 30s per left/right
    private final Handler          seekPollHandler  = new Handler(Looper.getMainLooper());
    private final Runnable         seekPollRunnable = this::updateSeekBar;

    // ======================================================================
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        ActionBar ab = getSupportActionBar();
        if (ab != null) ab.hide();

        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);

        String url = getIntent().getStringExtra(EXTRA_URL);
        String title = getIntent().getStringExtra(EXTRA_TITLE);
        String episodeLabel = getIntent().getStringExtra(EXTRA_EPISODE_LABEL);
        movieId = getIntent().getStringExtra(EXTRA_MOVIE_ID);
        progressUrl = getIntent().getStringExtra(EXTRA_PROGRESS_URL);
        long startTimeMs = getIntent().getLongExtra(EXTRA_START_TIME_MS, 0L);
        initAudioIdx = getIntent().getIntExtra(EXTRA_AUDIO_TRACK, -1);
        initSubIdx   = getIntent().getIntExtra(EXTRA_SUB_TRACK,   -1);
        // ── Choices made on the shelf (audio / subtitle buttons) and the server's language defaults ──
        explicitSubOff = getIntent().getBooleanExtra("subtitleOff", false);
        String subUrl  = getIntent().getStringExtra("subUrl");
        String subMime = getIntent().getStringExtra("subMime");
        String subLang = getIntent().getStringExtra("subLang");
        boolean hasExtSub = subUrl != null && !subUrl.isEmpty();
        // a subtitle file loaded next to the film becomes the text group right after the film's own ones
        if (hasExtSub) initSubIdx = getIntent().getIntExtra("subEmbCount", 0);
        explicitSub = explicitSubOff || hasExtSub || initSubIdx >= 0;
        String prefAudio = getIntent().getStringExtra("preferredAudio");
        String prefSub   = getIntent().getStringExtra("preferredSubtitle");
        loadSavedSubtitleSelection(url, title, episodeLabel);
        if (explicitSub) savedSubtitleSignature = null;   // this start's choice wins over what was remembered
        android.util.Log.d("PlayerActivity", "onCreate — startTimeMs from intent=" + startTimeMs
            + " resumeSeekApplied(instance)=" + resumeSeekApplied + " this=" + this);

        if (url == null) { finish(); return; }

        // ── ExoPlayer ─────────────────────────────────────────────────────
        // Never disable the text renderer globally — locking it prevents
        // the user from switching subs on the fly in the overlay.
        // "Off" is handled by clearing the override in applyInitialTracks().
        trackSelector = new DefaultTrackSelector(this);
        {   // language defaults from the server. ExoPlayer still prefers tracks this device can actually play.
            TrackSelectionParameters.Builder lp = trackSelector.buildUponParameters();
            if (prefAudio != null && prefAudio.length() == 3 && !"any".equals(prefAudio)) lp.setPreferredAudioLanguage(prefAudio);
            if (!explicitSub && prefSub != null && prefSub.length() == 3 && !"off".equals(prefSub)) lp.setPreferredTextLanguage(prefSub);
            trackSelector.setParameters(lp.build());
        }
        player = new ExoPlayer.Builder(this).setTrackSelector(trackSelector).build();

        // ── Root: PlayerView + overlay ────────────────────────────────────
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        playerView = new PlayerView(this);
        playerView.setPlayer(player);
        playerView.setUseController(false);
        loadSubtitlePrefs();
        applySubtitleStyle();
        root.addView(playerView, matchParent());

        root.addView(buildOverlay(), matchParent());
        setContentView(root);

        // Populate title overlay (set after buildOverlay() creates titleView).
        // Second line shows the episode label (e.g. "S03E01") when present —
        // titleView already allows 2 lines for this purpose. Styled smaller/
        // dimmer than the title itself so it reads as a subtitle, not a second
        // title.
        if (title != null && !title.isEmpty() && titleView != null) {
            if (episodeLabel != null && !episodeLabel.isEmpty()) {
                String full = title + "\n" + episodeLabel;
                android.text.SpannableString spannable = new android.text.SpannableString(full);
                int epStart = title.length() + 1;
                int epEnd = full.length();
                spannable.setSpan(new android.text.style.RelativeSizeSpan(0.7f), epStart, epEnd, 0);
                spannable.setSpan(new android.text.style.ForegroundColorSpan(0xFFBBBBBB), epStart, epEnd, 0);
                titleView.setText(spannable);
            } else {
                titleView.setText(title);
            }
        }

        // ── Full screen ───────────────────────────────────────────────────
        WindowInsetsControllerCompat wic =
            WindowCompat.getInsetsController(getWindow(), playerView);
        wic.hide(WindowInsetsCompat.Type.systemBars());
        wic.setSystemBarsBehavior(
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);

        // ── Back ──────────────────────────────────────────────────────────
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() {
                if (overlayVisible && pickerMode != PickerMode.NONE) { closePicker(); }
                else if (overlayVisible) { hideOverlay(); }
                else { finishWithPosition(); }
            }
        });

        // ── Listeners ─────────────────────────────────────────────────────
        player.addListener(new androidx.media3.common.Player.Listener() {
            @Override public void onTracksChanged(Tracks tracks) {
                collectTracks(tracks);
                applyInitialTracks();
                updateTrackButtonLabels();
                applySubtitleStyle();
            }
            @Override public void onIsPlayingChanged(boolean isPlaying) {
                updatePlayPauseButton();
                if (!isPlaying) reportProgress(); // paused, buffering or ended: save where we are
            }
            @Override public void onPlaybackStateChanged(int state) {
                android.util.Log.d("PlayerActivity", "Playback state=" + state);
                if (state == androidx.media3.common.Player.STATE_READY) {
                    updateInfoPanel();
                    // Fallback only. The primary resume mechanism is the startPositionMs
                    // passed to setMediaItem() below, which ExoPlayer applies as part of
                    // period preparation. If the position is still near 0 here despite a
                    // requested startTimeMs, that primary path didn't take (progressive HTTP
                    // sources without a complete seek map), so apply it as a backstop.
                    android.util.Log.d("PlayerActivity", "STATE_READY — currentPosition=" + player.getCurrentPosition()
                        + " startTimeMs=" + startTimeMs + " resumeSeekApplied=" + resumeSeekApplied);
                    if (startTimeMs > 0 && !resumeSeekApplied && player.getCurrentPosition() < 1500) {
                        resumeSeekApplied = true;
                        android.util.Log.d("PlayerActivity", "STATE_READY fallback firing seekTo(" + startTimeMs + ")");
                        player.seekTo(startTimeMs);
                    }
                } else if (state == androidx.media3.common.Player.STATE_ENDED) {
                    // Movie finished: go back to the shelf (the server marks it as watched).
                    finishWithPosition();
                }
            }
            @Override public void onPlayerError(androidx.media3.common.PlaybackException error) {
                android.util.Log.e("PlayerActivity", "Playback error", error);
                Toast.makeText(PlayerActivity.this,
                    "Can't play this file: " + error.getErrorCodeName(), Toast.LENGTH_LONG).show();
                finishWithPosition();
            }
        });

        // Pass the resume position directly to setMediaItem rather than seeking
        // reactively once READY — see comment above for why the reactive-only
        // approach was unreliable on Android/ExoPlayer specifically.
        if (startTimeMs > 0) {
            android.util.Log.d("PlayerActivity", "setMediaItem with startPositionMs=" + startTimeMs);
            player.setMediaItem(buildMediaItem(url, subUrl, subMime, subLang), startTimeMs);
        } else {
            android.util.Log.d("PlayerActivity", "setMediaItem with NO start position (startTimeMs was 0)");
            player.setMediaItem(buildMediaItem(url, subUrl, subMime, subLang));
        }
        player.setPlayWhenReady(true);
        player.prepare();
        startTrickplay();
        if (progressUrl != null && !progressUrl.isEmpty() && movieId != null && !movieId.isEmpty()) {
            progressHandler.postDelayed(progressRunnable, PROGRESS_INTERVAL_MS);
        }
    }

    // ======================================================================
    //  Build overlay
    // ======================================================================
    private View buildOverlay() {
        FrameLayout container = new FrameLayout(this);
        container.setClickable(false);
        fMed   = loadFont(R.font.instrument_sans_medium, Typeface.SANS_SERIF);
        fBold  = loadFont(R.font.instrument_sans_bold, Typeface.DEFAULT_BOLD);
        fTitle = loadFont(R.font.big_shoulders_black, Typeface.DEFAULT_BOLD);

        // Soft scrim behind title/clock (top)
        topScrim = new View(this);
        topScrim.setBackground(new android.graphics.drawable.GradientDrawable(
            android.graphics.drawable.GradientDrawable.Orientation.TOP_BOTTOM,
            new int[]{ 0xCC0A0614, 0x00000000 }));
        topScrim.setVisibility(View.GONE);
        container.addView(topScrim, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, dp(150), Gravity.TOP));

        // Bottom gradient area
        LinearLayout bottomArea = new LinearLayout(this);
        bottomArea.setOrientation(LinearLayout.VERTICAL);
        bottomArea.setGravity(Gravity.BOTTOM);
        bottomArea.setPadding(dp(28), dp(32), dp(28), dp(36));
        bottomArea.setBackground(makeGradient());

        // Picker panel
        pickerPanel = new LinearLayout(this);
        pickerPanel.setOrientation(LinearLayout.VERTICAL);
        pickerPanel.setVisibility(View.GONE);
        pickerPanel.setPadding(dp(18), dp(16), dp(18), dp(14));
        pickerPanel.setBackground(makeCardBg());

        // ── Seek row: current | seekbar | total ───────────────────────────
        seekRow = new LinearLayout(this);
        seekRow.setOrientation(LinearLayout.HORIZONTAL);
        seekRow.setGravity(Gravity.CENTER_VERTICAL);
        seekRow.setPadding(0, 0, 0, dp(10));
        seekRow.setVisibility(View.GONE); // shown/hidden with controlBar

        seekTimeCurrent = new TextView(this);
        seekTimeCurrent.setTextColor(COLOR_TEXT);
        seekTimeCurrent.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        seekTimeCurrent.setTypeface(fBold);
        seekTimeCurrent.setText("0:00:00");
        seekTimeCurrent.setMinWidth(dp(58));
        seekTimeCurrent.setGravity(Gravity.END | Gravity.CENTER_VERTICAL);

        seekBar = new android.widget.SeekBar(this);
        LinearLayout.LayoutParams sbLp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        sbLp.leftMargin  = dp(12);
        sbLp.rightMargin = dp(12);
        seekBar.setLayoutParams(sbLp);
        seekBar.setMax(1000);
        seekBar.setProgress(0);
        seekBar.setPadding(dp(12), 0, dp(12), 0);
        seekBar.setSplitTrack(false);
        styleSeekBar(false);
        seekBar.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override public void onProgressChanged(SeekBar sb, int progress, boolean fromUser) {
                if (fromUser) {
                    long dur = player.getDuration();
                    if (dur > 0) {
                        long pos = (long)(progress / 1000f * dur);
                        seekTimeCurrent.setText(formatTime(pos));
                        showPreview(pos, progress / 1000f);
                    }
                }
            }
            @Override public void onStartTrackingTouch(SeekBar sb) {
                seekBarTracking = true;
                hideHandler.removeCallbacks(hideRunnable); // keep overlay alive while scrubbing
            }
            @Override public void onStopTrackingTouch(SeekBar sb) {
                long dur = player.getDuration();
                if (dur > 0) {
                    long pos = (long)(sb.getProgress() / 1000f * dur);
                    player.seekTo(pos);
                }
                hidePreview();
                seekBarTracking = false;
                resetHideTimer();
            }
        });

        seekTimeTotal = new TextView(this);
        seekTimeTotal.setTextColor(COLOR_MUTED);
        seekTimeTotal.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        seekTimeTotal.setTypeface(fMed);
        seekTimeTotal.setText("0:00:00");
        seekTimeTotal.setMinWidth(dp(58));
        seekTimeTotal.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);

        seekRow.addView(seekTimeCurrent);
        seekRow.addView(seekBar);
        seekRow.addView(seekTimeTotal);
        bottomArea.addView(seekRow);

        // Control bar
        controlBar = new LinearLayout(this);
        controlBar.setOrientation(LinearLayout.HORIZONTAL);
        controlBar.setGravity(Gravity.CENTER_VERTICAL);
        controlBar.setVisibility(View.GONE);

        // ◀◀ Rewind
        View rw = makeCtrlButton("⏪  10s", false);
        rw.setOnClickListener(v -> { player.seekBack(); resetHideTimer(); });
        ctrlButtons.add(rw);
        controlBar.addView(rw);
        controlBar.addView(hSpacer(dp(10)));

        // ▶ / ❚❚ Play-Pause
        View pp = makeCtrlButton("▶", true);
        pp.setOnClickListener(v -> { togglePlayPause(); resetHideTimer(); });
        ctrlButtons.add(pp);
        controlBar.addView(pp);
        controlBar.addView(hSpacer(dp(10)));

        // ▶▶ Forward
        View fw = makeCtrlButton("10s  ⏩", false);
        fw.setOnClickListener(v -> { player.seekForward(); resetHideTimer(); });
        ctrlButtons.add(fw);
        controlBar.addView(fw);

        // Flexible spacer
        View flex = new View(this);
        flex.setLayoutParams(new LinearLayout.LayoutParams(0, 1, 1f));
        controlBar.addView(flex);

        // 🔊 Audio
        View audioBtn = makeCtrlButton("Audio", false);
        audioBtn.setOnClickListener(v -> { togglePicker(PickerMode.AUDIO); resetHideTimer(); });
        ctrlButtons.add(audioBtn);
        controlBar.addView(audioBtn);
        controlBar.addView(hSpacer(dp(10)));

        // CC Subtitles
        View subBtn = makeCtrlButton("Subtitles  Off", false);
        subBtn.setOnClickListener(v -> { togglePicker(PickerMode.SUBS); resetHideTimer(); });
        ctrlButtons.add(subBtn);
        controlBar.addView(subBtn);
        controlBar.addView(hSpacer(dp(10)));

        // Aa — Subtitle style
        View aaBtn = makeCtrlButton("Aa", false);
        aaBtn.setOnClickListener(v -> { togglePicker(PickerMode.SUB_STYLE); resetHideTimer(); });
        ctrlButtons.add(aaBtn);
        controlBar.addView(aaBtn);
        controlBar.addView(hSpacer(dp(10)));

        // ⓘ Info
        View infoBtn = makeCtrlButton("ⓘ", false);
        infoBtn.setOnClickListener(v -> { toggleInfoPanel(); resetHideTimer(); });
        ctrlButtons.add(infoBtn);
        controlBar.addView(infoBtn);

        bottomArea.addView(controlBar);

        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.gravity = Gravity.BOTTOM;
        container.addView(bottomArea, lp);

        // Audio / subtitle / style card — centred over the picture
        FrameLayout.LayoutParams pickLp = new FrameLayout.LayoutParams(
            dp(520), ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER);
        pickLp.bottomMargin = dp(90);
        container.addView(pickerPanel, pickLp);

        // ── Info panel — top-right corner ─────────────────────────────────
        infoPanelView = buildInfoPanel();
        FrameLayout.LayoutParams infoLp = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT);
        infoLp.gravity = Gravity.TOP | Gravity.END;
        infoLp.topMargin  = dp(64); // sits below the clock, which shares this corner
        infoLp.rightMargin = dp(28);
        infoPanelView.setVisibility(View.GONE);
        container.addView(infoPanelView, infoLp);

        // ── Title — top-left corner, shown with controls ───────────────────
        titleView = new TextView(this);
        titleView.setTextColor(COLOR_TEXT);
        titleView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 28);
        titleView.setTypeface(fTitle);
        titleView.setLetterSpacing(0.02f);
        titleView.setShadowLayer(dp(3), 0, dp(1), 0xFF000000);
        titleView.setMaxLines(2);
        titleView.setMaxWidth(dp(900));
        titleView.setEllipsize(android.text.TextUtils.TruncateAt.END);
        titleView.setVisibility(View.GONE);
        FrameLayout.LayoutParams titleLp = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT);
        titleLp.gravity   = Gravity.TOP | Gravity.START;
        titleLp.topMargin  = dp(28);
        titleLp.leftMargin = dp(28);
        container.addView(titleView, titleLp);

        // ── Clock — top-right corner, shown with controls ──────────────────
        clockView = new TextView(this);
        clockView.setTextColor(COLOR_TEXT);
        clockView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        clockView.setTypeface(fBold);
        clockView.setShadowLayer(dp(3), 0, dp(1), 0xFF000000);
        clockView.setVisibility(View.GONE);
        FrameLayout.LayoutParams clockLp = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT);
        clockLp.gravity    = Gravity.TOP | Gravity.END;
        clockLp.topMargin  = dp(28);
        clockLp.rightMargin = dp(28);
        container.addView(clockView, clockLp);

        // ── Seek preview (trick play): small frame + time above the seek bar ──
        overlayContainer = container;
        previewBox = new LinearLayout(this);
        previewBox.setOrientation(LinearLayout.VERTICAL);
        previewBox.setGravity(Gravity.CENTER_HORIZONTAL);
        previewBox.setVisibility(View.GONE);
        previewImage = new ImageView(this);
        previewImage.setScaleType(ImageView.ScaleType.FIT_CENTER);
        previewImage.setBackgroundColor(0xFF000000);
        previewBox.addView(previewImage, new LinearLayout.LayoutParams(dp(PREVIEW_W_DP), dp(PREVIEW_H_DP)));
        previewTime = new TextView(this);
        previewTime.setTextColor(COLOR_TEXT);
        previewTime.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        previewTime.setTypeface(fBold);
        previewTime.setShadowLayer(dp(3), 0, dp(1), 0xFF000000);
        previewTime.setPadding(0, dp(4), 0, 0);
        previewBox.addView(previewTime, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        container.addView(previewBox, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP | Gravity.START));

        return container;
    }

    // ======================================================================
    //  Progress reporting
    // ======================================================================
    private void reportProgress() {
        if (player == null || progressUrl == null || progressUrl.isEmpty()
                || movieId == null || movieId.isEmpty() || progressExecutor.isShutdown()) return;
        final long pos = player.getCurrentPosition();
        final long dur = player.getDuration();
        if (pos <= 0) return;
        final String url = progressUrl;
        final String id = movieId;
        try {
            progressExecutor.execute(() -> postProgress(url, id, pos, dur));
        } catch (RuntimeException ignored) { /* executor shut down while exiting */ }
    }

    private void postProgress(String url, String id, long positionMs, long durationMs) {
        HttpURLConnection connection = null;
        try {
            JSONObject body = new JSONObject();
            body.put("id", id);
            body.put("positionMs", positionMs);
            if (durationMs > 0 && durationMs != C.TIME_UNSET) body.put("durationMs", durationMs);
            byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
            connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(3000);
            connection.setReadTimeout(3000);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream out = connection.getOutputStream()) { out.write(bytes); }
            connection.getResponseCode();
        } catch (Exception error) {
            android.util.Log.d("PlayerActivity", "Progress report failed: " + error.getMessage());
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    // ======================================================================
    //  Clock
    // ======================================================================
    private void updateClock() {
        if (clockView != null) clockView.setText(CLOCK_FORMAT.format(new Date()));
        // Re-align to the next minute boundary rather than a flat 60s tick,
        // so the displayed minute doesn't visibly lag behind the real one.
        long delayToNextMinute = 60_000L - (System.currentTimeMillis() % 60_000L);
        clockHandler.postDelayed(clockRunnable, delayToNextMinute);
    }

    private void startClock() {
        clockHandler.removeCallbacks(clockRunnable);
        updateClock();
    }

    private void stopClock() {
        clockHandler.removeCallbacks(clockRunnable);
    }

    // ======================================================================
    //  Show / hide overlay
    // ======================================================================
    private void showOverlay() {
        overlayVisible = true;
        ctrlFocusIdx = 1; // always land on play/pause when controls appear
        seekRow.setVisibility(View.VISIBLE);
        controlBar.setVisibility(View.VISIBLE);
        if (titleView != null) titleView.setVisibility(View.VISIBLE);
        if (topScrim != null) topScrim.setVisibility(View.VISIBLE);
        if (clockView != null) { clockView.setVisibility(View.VISIBLE); startClock(); }
        updatePlayPauseButton();
        setCtrlFocus(ctrlFocusIdx);
        applySeekRowFocusStyle();
        startSeekPoll();
        resetHideTimer();
    }

    private void hideOverlay() {
        commitScrub();   // a pending D-pad scrub is applied, not lost
        overlayVisible = false;
        seekRowFocused = false;
        closePicker();
        infoPanelVisible = false;
        infoPanelView.setVisibility(View.GONE);
        if (titleView != null) titleView.setVisibility(View.GONE);
        if (topScrim != null) topScrim.setVisibility(View.GONE);
        if (clockView != null) { clockView.setVisibility(View.GONE); stopClock(); }
        seekRow.setVisibility(View.GONE);
        controlBar.setVisibility(View.GONE);
        stopSeekPoll();
        hideHandler.removeCallbacks(hideRunnable);
    }

    private void resetHideTimer() {
        hideHandler.removeCallbacks(hideRunnable);
        hideHandler.postDelayed(hideRunnable, OVERLAY_TIMEOUT_MS);
    }

    // ======================================================================
    //  Info panel
    // ======================================================================
    private LinearLayout buildInfoPanel() {
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setPadding(dp(16), dp(14), dp(16), dp(14));
        panel.setBackground(makeCardBg());
        // rows added dynamically in updateInfoPanel()
        return panel;
    }

    // MKV often has no frame rate in its header, so ExoPlayer reports none. In that case we measure it:
    // frames actually rendered by the decoder divided by the wall-clock time, sampled once a second
    // while the info panel is open and the video is playing.
    private float measuredFps = 0f;
    private long fpsBaseFrames = -1, fpsBaseTime = 0;
    private final Runnable fpsTick = new Runnable() {
        @Override public void run() {
            if (!infoPanelVisible) return;
            try {
                androidx.media3.exoplayer.DecoderCounters dc = player.getVideoDecoderCounters();
                if (dc != null && player.isPlaying()) {
                    dc.ensureUpdated();
                    long now = android.os.SystemClock.elapsedRealtime();
                    long frames = dc.renderedOutputBufferCount;
                    if (fpsBaseFrames >= 0 && now - fpsBaseTime >= 2000 && frames > fpsBaseFrames) {
                        measuredFps = (frames - fpsBaseFrames) * 1000f / (now - fpsBaseTime);
                        fpsBaseFrames = frames; fpsBaseTime = now;
                        updateInfoPanel();
                    } else if (fpsBaseFrames < 0 || frames < fpsBaseFrames) {
                        fpsBaseFrames = frames; fpsBaseTime = now;
                    }
                }
            } catch (Throwable ignored) { /* counters not available on this device */ }
            hideHandler.postDelayed(this, 1000);
        }
    };

    private String snapFps(float f) {
        float[] common = {23.976f, 24f, 25f, 29.97f, 30f, 48f, 50f, 59.94f, 60f};
        for (float c : common) if (Math.abs(f - c) < c * 0.025f) return c == (int) c ? String.valueOf((int) c) : String.format("%.3f", c).replaceAll("0+$", "");
        return String.format("%.1f", f);
    }

    private void toggleInfoPanel() {
        infoPanelVisible = !infoPanelVisible;
        if (infoPanelVisible) {
            fpsBaseFrames = -1;
            hideHandler.removeCallbacks(fpsTick);
            hideHandler.postDelayed(fpsTick, 1000);
            updateInfoPanel();
            infoPanelView.setVisibility(View.VISIBLE);
            // highlight the info button
            if (ctrlButtons.size() > 6) applyCtrlFocusStyle(ctrlButtons.get(6), true);
            hideHandler.removeCallbacks(hideRunnable); // keep overlay alive while reading
        } else {
            infoPanelView.setVisibility(View.GONE);
            if (ctrlButtons.size() > 6) applyCtrlFocusStyle(ctrlButtons.get(6), ctrlFocusIdx == 6);
            resetHideTimer();
        }
    }

    private void updateInfoPanel() {
        runOnUiThread(() -> {
            infoPanelView.removeAllViews();

            // Prefer track selector mapped format — has bitrate/fps populated
            // even when getVideoFormat() returns -1 for those fields (common with MKV).
            androidx.media3.common.Format vf = null;
            androidx.media3.common.Format af = null;
            androidx.media3.exoplayer.trackselection.MappingTrackSelector.MappedTrackInfo mti =
                trackSelector.getCurrentMappedTrackInfo();
            if (mti != null) {
                for (int ri = 0; ri < mti.getRendererCount(); ri++) {
                    androidx.media3.common.TrackGroup sel = null;
                    androidx.media3.exoplayer.trackselection.TrackSelectionArray tsa =
                        player.getCurrentTrackSelections();
                    if (ri < tsa.length && tsa.get(ri) != null)
                        sel = tsa.get(ri).getTrackGroup();
                    if (sel == null) continue;
                    int type = mti.getRendererType(ri);
                    if (type == C.TRACK_TYPE_VIDEO  && vf == null) vf = sel.getFormat(0);
                    if (type == C.TRACK_TYPE_AUDIO  && af == null) af = sel.getFormat(0);
                }
            }
            // Fallback to live format if track selector gave nothing
            if (vf == null) vf = player.getVideoFormat();
            if (af == null) af = player.getAudioFormat();

            // ── Video ──────────────────────────────────────────────────────
            addInfoHeader("VIDEO");
            if (vf != null) {
                addInfoRow("Codec",   friendlyCodec(vf.sampleMimeType));
                if (vf.width > 0 && vf.height > 0)
                    addInfoRow("Resolution", vf.width + " × " + vf.height + "  " + resolutionBadge(vf.width, vf.height));
                if (vf.frameRate > 0)
                    addInfoRow("Frame rate", String.format("%.2f fps", vf.frameRate));
                else if (measuredFps > 0)
                    addInfoRow("Frame rate", String.format("%s fps", snapFps(measuredFps)));
                else
                    addInfoRow("Frame rate", "measuring...");
                if (vf.bitrate > 0)
                    addInfoRow("Bitrate", formatBitrate(vf.bitrate));
                if (vf.colorInfo != null)
                    addInfoRow("HDR", hdrLabel(vf.colorInfo));
            } else {
                addInfoRow("", "Loading...");
            }

            // ── Audio ──────────────────────────────────────────────────────
            addInfoSpacer();
            addInfoHeader("AUDIO");
            if (af != null) {
                addInfoRow("Codec",    friendlyCodec(af.sampleMimeType));
                if (af.channelCount > 0)
                    addInfoRow("Channels", channelLabel(af.channelCount));
                if (af.sampleRate > 0)
                    addInfoRow("Sample rate", af.sampleRate / 1000 + " kHz");
                if (af.bitrate > 0)
                    addInfoRow("Bitrate", formatBitrate(af.bitrate));
                if (af.language != null && !af.language.isEmpty())
                    addInfoRow("Language", af.language.toUpperCase());
            } else {
                addInfoRow("", "Loading...");
            }

            // ── Subtitles ──────────────────────────────────────────────────
            addInfoSpacer();
            addInfoHeader("SUBTITLES");
            if (activeSubGroup >= 0 && activeSubGroup < subGroups.size()) {
                androidx.media3.common.Format sf =
                    subGroups.get(activeSubGroup).getMediaTrackGroup().getFormat(0);
                addInfoRow("Language", sf.language != null ? sf.language.toUpperCase() : "Unknown");
                if (sf.label != null && !sf.label.isEmpty())
                    addInfoRow("Label", sf.label);
                addInfoRow("Format", friendlyCodec(sf.sampleMimeType));
            } else {
                addInfoRow("", "Off");
            }
        });
    }

    private void addInfoHeader(String title) {
        TextView tv = new TextView(this);
        tv.setText(title);
        tv.setTextColor(COLOR_ORANGE);
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
        tv.setTypeface(fBold);
        tv.setLetterSpacing(0.2f);
        tv.setPadding(0, 0, 0, dp(4));
        infoPanelView.addView(tv);
    }

    private void addInfoRow(String label, String value) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setPadding(0, dp(2), 0, dp(2));

        TextView lv = new TextView(this);
        lv.setText(label.isEmpty() ? "" : label + "  ");
        lv.setTextColor(COLOR_MUTED);
        lv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        lv.setTypeface(fMed);
        lv.setMinWidth(dp(90));

        TextView vv = new TextView(this);
        vv.setText(value);
        vv.setTextColor(COLOR_TEXT);
        vv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        vv.setTypeface(fBold);

        row.addView(lv);
        row.addView(vv);
        infoPanelView.addView(row);
    }

    private void addInfoSpacer() {
        View v = new View(this);
        v.setLayoutParams(new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, dp(8)));
        infoPanelView.addView(v);
    }

    // ── Codec / format helpers ─────────────────────────────────────────────
    private String friendlyCodec(String mime) {
        if (mime == null) return "Unknown";
        switch (mime) {
            case "video/hevc":        return "H.265 / HEVC";
            case "video/avc":         return "H.264 / AVC";
            case "video/av01":        return "AV1";
            case "video/vp9":         return "VP9";
            case "video/vp8":         return "VP8";
            case "video/dolby-vision":return "Dolby Vision";
            case "audio/ac3":         return "Dolby AC-3";
            case "audio/eac3":        return "Dolby E-AC-3 (Atmos)";
            case "audio/truehd":      return "Dolby TrueHD";
            case "audio/dts":         return "DTS";
            case "audio/dts-hd":      return "DTS-HD";
            case "audio/mpeg":        return "MP3";
            case "audio/mp4a-latm":   return "AAC";
            case "audio/flac":        return "FLAC";
            case "audio/vorbis":      return "Vorbis";
            case "audio/opus":        return "Opus";
            case "text/vtt":          return "WebVTT";
            case "application/x-subrip": return "SRT";
            case "text/x-ssa":        return "ASS/SSA";
            case "application/pgs":   return "PGS";
            default:
                // Strip mime prefix for anything else
                return mime.contains("/") ? mime.substring(mime.lastIndexOf('/') + 1).toUpperCase() : mime;
        }
    }

    private String resolutionBadge(int w, int h) {
        int major = Math.max(w, h); // use larger dimension — handles non-standard heights like 3840x1604
        if (major >= 3840) return "4K UHD";
        if (major >= 1920) return "1080p";
        if (major >= 1280) return "720p";
        if (major >= 854)  return "480p";
        return "";
    }

    private String channelLabel(int ch) {
        switch (ch) {
            case 1: return "1.0 Mono";
            case 2: return "2.0 Stereo";
            case 6: return "5.1 Surround";
            case 8: return "7.1 Surround";
            default: return ch + " ch";
        }
    }

    private String formatBitrate(int bps) {
        if (bps >= 1_000_000) return String.format("%.1f Mbps", bps / 1_000_000f);
        if (bps >= 1_000)     return String.format("%.0f Kbps", bps / 1_000f);
        return bps + " bps";
    }

    private String hdrLabel(androidx.media3.common.ColorInfo ci) {
        if (ci.colorTransfer == androidx.media3.common.C.COLOR_TRANSFER_ST2084) return "HDR10";
        if (ci.colorTransfer == androidx.media3.common.C.COLOR_TRANSFER_HLG)    return "HLG";
        return "SDR";
    }

    // ======================================================================
    //  Picker
    // ======================================================================
    private void togglePicker(PickerMode mode) {
        if (pickerMode == mode) { closePicker(); return; }
        pickerMode = mode;
        buildPickerPanel(mode);
        pickerPanel.setVisibility(View.VISIBLE);
        int start = 0;
        if (mode == PickerMode.AUDIO) start = Math.max(0, activeAudioGroup);
        else if (mode == PickerMode.SUBS) start = Math.max(0, activeSubGroup + 1);
        pickerFocusIdx = start;
        setPickerFocus(start);
        hideHandler.removeCallbacks(hideRunnable); // don't hide while picker is open
    }

    private void closePicker() {
        pickerMode = PickerMode.NONE;
        subStyleRow = 0;
        pickerPanel.setVisibility(View.GONE);
        pickerPanel.removeAllViews();
        pickerButtons.clear();
        setCtrlFocus(ctrlFocusIdx);
    }

    private void buildPickerPanel(PickerMode mode) {
        pickerPanel.removeAllViews();
        pickerButtons.clear();
        pickerListBox = null;
        pickerCounter = null;

        if (mode == PickerMode.SUB_STYLE) {
            buildSubStylePanel();
            return;
        }

        pickerPanel.addView(makeCardTitle(mode == PickerMode.AUDIO ? "AUDIO" : "SUBTITLES"));

        if (mode == PickerMode.SUBS) {
            addListRow("Off", activeSubGroup == -1, v -> { selectSubTrack(-1); closePicker(); });
        }
        List<Tracks.Group> groups = (mode == PickerMode.AUDIO) ? audioGroups : subGroups;
        int activeIdx = (mode == PickerMode.AUDIO) ? activeAudioGroup : activeSubGroup;
        for (int i = 0; i < groups.size(); i++) {
            final int idx = i;
            String lbl = buildTrackLabel(groups.get(i), i + 1, mode);
            if (mode == PickerMode.AUDIO)
                addListRow(lbl, activeIdx == i, v -> { selectAudioTrack(idx); closePicker(); });
            else
                addListRow(lbl, activeIdx == i, v -> { selectSubTrack(idx); closePicker(); });
        }
        if (pickerButtons.isEmpty()) addListRow("No tracks", false, v -> closePicker());

        pickerListBox = new LinearLayout(this);
        pickerListBox.setOrientation(LinearLayout.VERTICAL);
        pickerPanel.addView(pickerListBox);

        pickerCounter = new TextView(this);
        pickerCounter.setTextColor(COLOR_MUTED);
        pickerCounter.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
        pickerCounter.setTypeface(fMed);
        pickerCounter.setGravity(Gravity.END);
        pickerCounter.setPadding(0, dp(8), dp(4), 0);
        pickerPanel.addView(pickerCounter);
        pickerTop = 0;
        layoutPickerWindow();
    }

    /** One list row: [tick] [label]. Focus/active look is applied in applyPickerFocusStyle. */
    private void addListRow(String label, boolean active, View.OnClickListener l) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(14), 0, dp(14), 0);
        row.setTag(Boolean.valueOf(active));
        TextView tick = new TextView(this);
        tick.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        tick.setTypeface(fBold);
        tick.setText(active ? "✓" : "");
        tick.setMinWidth(dp(26));
        TextView lab = new TextView(this);
        lab.setText(label);
        lab.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        lab.setTypeface(active ? fBold : fMed);
        lab.setSingleLine(true);
        lab.setEllipsize(android.text.TextUtils.TruncateAt.END);
        row.addView(tick);
        row.addView(lab, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        row.setOnClickListener(l);
        pickerButtons.add(row);
        styleListRow(row, false);
    }

    /** Shows at most PICKER_ROWS rows, scrolled so the focused row is visible. */
    private void layoutPickerWindow() {
        if (pickerListBox == null) return;
        int n = pickerButtons.size();
        if (pickerFocusIdx < pickerTop) pickerTop = pickerFocusIdx;
        if (pickerFocusIdx >= pickerTop + PICKER_ROWS) pickerTop = pickerFocusIdx - PICKER_ROWS + 1;
        pickerTop = Math.max(0, Math.min(pickerTop, Math.max(0, n - PICKER_ROWS)));
        pickerListBox.removeAllViews();
        for (int i = pickerTop; i < Math.min(n, pickerTop + PICKER_ROWS); i++) {
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(42));
            if (i > pickerTop) lp.topMargin = dp(4);
            pickerListBox.addView(pickerButtons.get(i), lp);
        }
        if (pickerCounter != null) {
            pickerCounter.setVisibility(n > PICKER_ROWS ? View.VISIBLE : View.GONE);
            pickerCounter.setText((pickerFocusIdx + 1) + " / " + n);
        }
    }

    private void styleListRow(LinearLayout row, boolean focused) {
        TextView tick = (TextView) row.getChildAt(0);
        TextView lab  = (TextView) row.getChildAt(1);
        android.graphics.drawable.GradientDrawable gd = new android.graphics.drawable.GradientDrawable();
        gd.setCornerRadius(dp(12));
        if (focused) {
            gd.setColor(0xFFFFFFFF);
            gd.setStroke(dp(2), 0x999D8AFF);
        } else {
            gd.setColor(0x0DFFFFFF);
        }
        row.setBackground(gd);
        lab.setTextColor(focused ? COLOR_DARK_TEXT : COLOR_TEXT);
        tick.setTextColor(focused ? COLOR_PURPLE_DEEP : COLOR_ORANGE);
    }

    private TextView makeCardTitle(String text) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setTextColor(COLOR_MUTED);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        t.setTypeface(fBold);
        t.setLetterSpacing(0.2f);
        t.setPadding(dp(4), 0, 0, dp(10));
        return t;
    }

    // ── Sub style picker: Row1=Color, Row2=Size ────────────────────────────
    // pickerButtons layout:
    //   0=White 1=Yellow 2=Green 3=Cyan 4=LightGray  (color row)
    //   5=− 6=value 7=+                                  (size row)
    private static final int[] SUB_COLORS = {
        Color.WHITE,
        Color.YELLOW,
        0xFF00E676,   // Green
        0xFF00E5FF,   // Cyan
        0xFFBDBDBD,   // Light Gray
    };
    private static final String[] SUB_COLOR_LABELS = { "White", "Yellow", "Green", "Cyan", "Lt. Gray" };
    private static final int SUB_SIZE_MIN = 10;
    private static final int SUB_SIZE_MAX = 60;

    // Which row the d-pad is currently on inside SUB_STYLE picker (0=color, 1=size, 2=font)
    private int subStyleRow = 0;

    private void buildSubStylePanel() {
        pickerPanel.removeAllViews();
        pickerButtons.clear();
        subStyleRow = 0;

        pickerPanel.addView(makeCardTitle("SUBTITLE STYLE"));

        // Color row
        HorizontalScrollView colorScroll = new HorizontalScrollView(this);
        colorScroll.setHorizontalScrollBarEnabled(false);
        LinearLayout colorRow = new LinearLayout(this);
        colorRow.setOrientation(LinearLayout.HORIZONTAL);
        colorRow.setGravity(Gravity.CENTER_VERTICAL);
        for (int i = 0; i < SUB_COLOR_LABELS.length; i++) {
            final int ci = i;
            View btn = makePickerButton(SUB_COLOR_LABELS[i], i == subColorIdx);
            btn.setOnClickListener(v -> {
                subColorIdx = ci;
                applySubtitleStyle();
                saveSubtitlePrefs();
                buildSubStylePanel();
                pickerFocusIdx = ci;
                setPickerFocus(pickerFocusIdx);
            });
            pickerButtons.add(btn);
            colorRow.addView(btn);
            if (i < SUB_COLOR_LABELS.length - 1) colorRow.addView(hSpacer(dp(8)));
        }
        colorScroll.addView(colorRow);
        pickerPanel.addView(colorScroll);
        pickerPanel.addView(hSpacer(dp(8)));

        // Size row: − | value | +
        LinearLayout sizeRow = new LinearLayout(this);
        sizeRow.setOrientation(LinearLayout.HORIZONTAL);
        sizeRow.setGravity(Gravity.CENTER_VERTICAL);
        View minusBtn = makePickerButton("−", false);
        View valueBtn = makePickerButton(String.valueOf((int) subSizeSp), true);
        View plusBtn  = makePickerButton("+", false);
        minusBtn.setOnClickListener(v -> {
            subSizeSp = Math.max(SUB_SIZE_MIN, (int) subSizeSp - 1);
            applySubtitleStyle(); saveSubtitlePrefs(); buildSubStylePanel();
            subStyleRow = 1; pickerFocusIdx = SUB_COLOR_LABELS.length;
            setPickerFocus(pickerFocusIdx);
        });
        plusBtn.setOnClickListener(v -> {
            subSizeSp = Math.min(SUB_SIZE_MAX, (int) subSizeSp + 1);
            applySubtitleStyle(); saveSubtitlePrefs(); buildSubStylePanel();
            subStyleRow = 1; pickerFocusIdx = SUB_COLOR_LABELS.length + 2;
            setPickerFocus(pickerFocusIdx);
        });
        pickerButtons.add(minusBtn); pickerButtons.add(valueBtn); pickerButtons.add(plusBtn);
        sizeRow.addView(minusBtn); sizeRow.addView(hSpacer(dp(8)));
        sizeRow.addView(valueBtn); sizeRow.addView(hSpacer(dp(8))); sizeRow.addView(plusBtn);
        pickerPanel.addView(sizeRow);
        pickerPanel.addView(hSpacer(dp(8)));

        // Roboto weight row
        String[] fontLabels = { "Regular", "Medium", "Bold" };
        LinearLayout fontRow = new LinearLayout(this);
        fontRow.setOrientation(LinearLayout.HORIZONTAL);
        fontRow.setGravity(Gravity.CENTER_VERTICAL);
        for (int i = 0; i < fontLabels.length; i++) {
            final int fi = i;
            View btn = makePickerButton(fontLabels[i], i == subFontStyle);
            btn.setOnClickListener(v -> {
                subFontStyle = fi;
                applySubtitleStyle();
                saveSubtitlePrefs();
                buildSubStylePanel();
                subStyleRow = 2;
                pickerFocusIdx = SUB_COLOR_LABELS.length + 3 + fi;
                setPickerFocus(pickerFocusIdx);
            });
            pickerButtons.add(btn);
            fontRow.addView(btn);
            if (i < fontLabels.length - 1) fontRow.addView(hSpacer(dp(8)));
        }
        pickerPanel.addView(fontRow);
    }

    private String buildTrackLabel(Tracks.Group g, int fallbackNum, PickerMode mode) {
        if (g.getMediaTrackGroup().length == 0) return "Track " + fallbackNum;
        androidx.media3.common.Format fmt = g.getMediaTrackGroup().getFormat(0);
        String langName = null;
        if (fmt.language != null && !fmt.language.isEmpty() && !"und".equals(fmt.language)) {
            try {
                langName = new Locale(fmt.language).getDisplayLanguage(Locale.ENGLISH);
            } catch (Exception ignored) { }
            if (langName == null || langName.isEmpty()) langName = fmt.language.toUpperCase();
            else langName = langName.substring(0, 1).toUpperCase() + langName.substring(1);
        }
        List<String> parts = new ArrayList<>();
        parts.add(langName != null ? langName : "Track " + fallbackNum);
        if (mode == PickerMode.AUDIO) {
            String codec = shortAudioCodec(fmt.sampleMimeType);
            String ch = shortChannels(fmt.channelCount);
            if (codec != null && ch != null) parts.add(codec + " " + ch);
            else if (codec != null) parts.add(codec);
            else if (ch != null) parts.add(ch);
        } else {
            String c = shortSubCodec(fmt.sampleMimeType);
            if (c != null) parts.add(c);
            if ((fmt.roleFlags & C.ROLE_FLAG_CAPTION) != 0) parts.add("SDH");
            if ((fmt.selectionFlags & C.SELECTION_FLAG_FORCED) != 0) parts.add("Forced");
        }
        if (fmt.label != null && !fmt.label.isEmpty()
                && (langName == null || !fmt.label.equalsIgnoreCase(langName))
                && !fmt.label.equalsIgnoreCase(fmt.language)) parts.add(fmt.label);
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < parts.size(); i++) { if (i > 0) sb.append("  ·  "); sb.append(parts.get(i)); }
        return sb.toString();
    }

    private String shortAudioCodec(String mime) {
        if (mime == null) return null;
        switch (mime) {
            case "audio/ac3":       return "Dolby Digital";
            case "audio/eac3":      return "Dolby Digital Plus";
            case "audio/eac3-joc":  return "Dolby Atmos";
            case "audio/true-hd":
            case "audio/truehd":    return "Dolby TrueHD";
            case "audio/vnd.dts":
            case "audio/dts":       return "DTS";
            case "audio/vnd.dts.hd":
            case "audio/dts-hd":    return "DTS-HD";
            case "audio/vnd.dts.hd;profile=lbr": return "DTS Express";
            case "audio/mp4a-latm": return "AAC";
            case "audio/mpeg":      return "MP3";
            case "audio/flac":      return "FLAC";
            case "audio/opus":      return "Opus";
            case "audio/vorbis":    return "Vorbis";
            case "audio/raw":       return "PCM";
            default:                return null;
        }
    }

    private String shortChannels(int ch) {
        switch (ch) {
            case 1: return "1.0";
            case 2: return "2.0";
            case 6: return "5.1";
            case 8: return "7.1";
            default: return ch > 0 ? ch + "ch" : null;
        }
    }

    private String shortSubCodec(String mime) {
        if (mime == null) return null;
        switch (mime) {
            case "application/x-subrip": return "SRT";
            case "text/x-ssa":           return "ASS";
            case "text/vtt":             return "VTT";
            case "application/pgs":      return "PGS";
            case "application/dvbsubs":  return "DVB";
            case "application/vobsub":   return "VobSub";
            case "application/ttml+xml": return "TTML";
            default:                     return null;
        }
    }

    // ======================================================================
    //  Track selection
    // ======================================================================
    private void collectTracks(Tracks tracks) {
        audioGroups.clear();
        subGroups.clear();
        for (Tracks.Group g : tracks.getGroups()) {
            if      (g.getType() == C.TRACK_TYPE_AUDIO) audioGroups.add(g);
            else if (g.getType() == C.TRACK_TYPE_TEXT)  subGroups.add(g);
        }
    }

    private MediaItem buildMediaItem(String url, String subUrl, String subMime, String subLang) {
        if (subUrl == null || subUrl.isEmpty()) return MediaItem.fromUri(url);
        String mime = subMime == null || subMime.isEmpty() ? androidx.media3.common.MimeTypes.APPLICATION_SUBRIP : subMime;
        MediaItem.SubtitleConfiguration.Builder sc = new MediaItem.SubtitleConfiguration.Builder(android.net.Uri.parse(subUrl))
            .setMimeType(mime).setSelectionFlags(C.SELECTION_FLAG_DEFAULT);
        if (subLang != null && subLang.length() == 3) sc.setLanguage(subLang);
        return new MediaItem.Builder().setUri(url).setSubtitleConfigurations(java.util.Collections.singletonList(sc.build())).build();
    }

    private void applyInitialTracks() {
        if (tracksApplied) return;
        if (audioGroups.isEmpty() && subGroups.isEmpty()) return;
        if (subGroups.isEmpty()
                && ((savedSubtitleSignature != null && !SUBTITLE_OFF.equals(savedSubtitleSignature))
                    || initSubIdx >= 0)) return;
        tracksApplied = true;
        TrackSelectionParameters.Builder p = trackSelector.buildUponParameters();
        if (initAudioIdx >= 0 && initAudioIdx < audioGroups.size()) {
            activeAudioGroup = initAudioIdx;
            p.setOverrideForType(new TrackSelectionOverride(
                audioGroups.get(initAudioIdx).getMediaTrackGroup(), 0));
        }
        int subtitleIndex = findSavedSubtitleIndex();
        if (subtitleIndex == Integer.MIN_VALUE) subtitleIndex = initSubIdx;
        if (subtitleIndex < 0) {
            // "Off" — clear any text override, renderer stays enabled for on-the-fly switching.
            activeSubGroup = -1;
            p.clearOverridesOfType(C.TRACK_TYPE_TEXT);
            if (explicitSubOff) p.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true);   // picking a track later re-enables it
        } else if (subtitleIndex < subGroups.size()) {
            activeSubGroup = subtitleIndex;
            p.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false);
            p.setOverrideForType(new TrackSelectionOverride(
                subGroups.get(subtitleIndex).getMediaTrackGroup(), 0));
        }
        trackSelector.setParameters(p.build());
    }

    private void selectAudioTrack(int idx) {
        activeAudioGroup = idx;
        TrackSelectionParameters.Builder p = trackSelector.buildUponParameters();
        p.setOverrideForType(new TrackSelectionOverride(
            audioGroups.get(idx).getMediaTrackGroup(), 0));
        trackSelector.setParameters(p.build());
        updateTrackButtonLabels();
    }

    private void selectSubTrack(int idx) {
        activeSubGroup = idx;
        TrackSelectionParameters.Builder p = trackSelector.buildUponParameters();
        if (idx < 0) {
            // "Off" — clear override only, keep renderer enabled
            p.clearOverridesOfType(C.TRACK_TYPE_TEXT);
        } else {
            p.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false);
            p.setOverrideForType(new TrackSelectionOverride(
                subGroups.get(idx).getMediaTrackGroup(), 0));
        }
        trackSelector.setParameters(p.build());
        saveSubtitleSelection(idx);
        updateTrackButtonLabels();
    }

    private static final String PREFS_NAME     = "strom_prefs";
    private static final String PREF_SUB_COLOR = "sub_color_idx";
    private static final String PREF_SUB_SIZE  = "sub_size_sp";
    private static final String PREF_SUB_FONT  = "sub_font_style";
    private static final String PREF_SUB_TRACK_PREFIX = "sub_track_v1_";
    private static final String SUBTITLE_OFF = "__off__";

    private void loadSavedSubtitleSelection(String url, String title, String episodeLabel) {
        String identity = subtitleContentIdentity(url, title, episodeLabel);
        subtitleSelectionPrefKey = PREF_SUB_TRACK_PREFIX + sha256(identity);
        savedSubtitleSignature = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
            .getString(subtitleSelectionPrefKey, null);
    }

    private String subtitleContentIdentity(String url, String title, String episodeLabel) {
        String stableUrl = url == null ? "" : url;
        try {
            URL parsed = new URL(stableUrl);
            // Exclude the server host so a DHCP/IP change does not lose the
            // selection. The API path and encoded file path/info-hash remain stable.
            stableUrl = parsed.getPath() + (parsed.getQuery() == null ? "" : "?" + parsed.getQuery());
        } catch (Exception ignored) {}
        return (title == null ? "" : title) + "\n"
            + (episodeLabel == null ? "" : episodeLabel) + "\n" + stableUrl;
    }

    private String sha256(String value) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                .digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder out = new StringBuilder(digest.length * 2);
            for (byte b : digest) out.append(String.format(Locale.US, "%02x", b & 0xff));
            return out.toString();
        } catch (Exception ignored) {
            return Integer.toHexString(value.hashCode());
        }
    }

    private String subtitleSignature(Tracks.Group group) {
        if (group == null || group.getMediaTrackGroup().length == 0) return "";
        androidx.media3.common.Format f = group.getMediaTrackGroup().getFormat(0);
        return safeTrackValue(f.id) + "|" + safeTrackValue(f.language) + "|"
            + safeTrackValue(f.label) + "|" + safeTrackValue(f.sampleMimeType) + "|"
            + safeTrackValue(f.codecs) + "|" + f.roleFlags + "|" + f.selectionFlags;
    }

    private String safeTrackValue(String value) {
        return value == null ? "" : value.trim().toLowerCase(Locale.ROOT);
    }

    private int findSavedSubtitleIndex() {
        if (savedSubtitleSignature == null) return Integer.MIN_VALUE;
        if (SUBTITLE_OFF.equals(savedSubtitleSignature)) return -1;
        for (int i = 0; i < subGroups.size(); i++) {
            if (savedSubtitleSignature.equals(subtitleSignature(subGroups.get(i)))) return i;
        }
        // Track metadata changed since last playback. Fall back to the inbound
        // selection rather than selecting a different language by position.
        return Integer.MIN_VALUE;
    }

    private void saveSubtitleSelection(int index) {
        if (subtitleSelectionPrefKey == null) return;
        String value = index < 0 || index >= subGroups.size()
            ? SUBTITLE_OFF : subtitleSignature(subGroups.get(index));
        savedSubtitleSignature = value;
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit()
            .putString(subtitleSelectionPrefKey, value)
            .apply();
    }

    private void loadSubtitlePrefs() {
        android.content.SharedPreferences p = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        subColorIdx = p.getInt(PREF_SUB_COLOR, 0);
        subSizeSp   = p.getFloat(PREF_SUB_SIZE, 20f);
        subFontStyle = Math.max(0, Math.min(2, p.getInt(PREF_SUB_FONT, 0)));
    }

    private void saveSubtitlePrefs() {
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit()
            .putInt(PREF_SUB_COLOR, subColorIdx)
            .putFloat(PREF_SUB_SIZE, subSizeSp)
            .putInt(PREF_SUB_FONT, subFontStyle)
            .apply();
    }

    private android.graphics.Typeface getSubtitleTypeface() {
        switch (subFontStyle) {
            case 1:
                return android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL);
            case 2:
                return android.graphics.Typeface.create("sans-serif", android.graphics.Typeface.BOLD);
            default:
                return android.graphics.Typeface.create("sans-serif", android.graphics.Typeface.NORMAL);
        }
    }

    private void applySubtitleStyle() {
        androidx.media3.ui.SubtitleView sv = playerView.getSubtitleView();
        if (sv == null) return;
        sv.setStyle(new CaptionStyleCompat(
            SUB_COLORS[subColorIdx],
            Color.TRANSPARENT,
            Color.TRANSPARENT,
            CaptionStyleCompat.EDGE_TYPE_OUTLINE,
            0xFF000000,
            getSubtitleTypeface()
        ));
        sv.setApplyEmbeddedStyles(false);
        sv.setApplyEmbeddedFontSizes(false);
        sv.setBottomPaddingFraction(0.10f);
        sv.setFixedTextSize(TypedValue.COMPLEX_UNIT_SP, subSizeSp);
    }

    private void updateTrackButtonLabels() {
        if (ctrlButtons.size() < 5) return;
        runOnUiThread(() -> {
            // Audio (index 3)
            View av = ctrlButtons.get(3);
            if (av instanceof TextView) {
                String lbl = "Audio";
                if (activeAudioGroup >= 0 && activeAudioGroup < audioGroups.size()) {
                    androidx.media3.common.Format fmt =
                        audioGroups.get(activeAudioGroup).getMediaTrackGroup().getFormat(0);
                    if (fmt.language != null && !fmt.language.isEmpty())
                        lbl = "Audio  " + fmt.language.toUpperCase();
                }
                ((TextView) av).setText(lbl);
            }
            // Subs (index 4)
            View sv = ctrlButtons.get(4);
            if (sv instanceof TextView) {
                String lbl = "Subtitles  Off";
                if (activeSubGroup >= 0 && activeSubGroup < subGroups.size()) {
                    androidx.media3.common.Format fmt =
                        subGroups.get(activeSubGroup).getMediaTrackGroup().getFormat(0);
                    String lang = fmt.language;
                    lbl = "Subtitles  " + (lang != null && !lang.isEmpty() ? lang.toUpperCase() : "On");
                }
                ((TextView) sv).setText(lbl);
            }
        });
    }

    // ======================================================================
    //  Play / Pause
    // ======================================================================
    private void togglePlayPause() {
        if (player.isPlaying()) player.pause(); else player.play();
    }

    private void updatePlayPauseButton() {
        if (ctrlButtons.size() < 2) return;
        View v = ctrlButtons.get(1);
        if (v instanceof TextView)
            ((TextView) v).setText(player.isPlaying() ? "⏸" : "▶");
    }

    // ======================================================================
    //  D-pad key handling
    //
    //  Rule: MOVEMENT keys handled in onKeyDown (feels responsive).
    //        CONFIRM (Enter/OK) handled in onKeyUp only — prevents key-repeat
    //        from double-firing after a picker selection closes the panel and
    //        the next repeat lands on play/pause instead.
    // ======================================================================

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        int kc = event.getKeyCode();
        // Fully intercept all keys we handle so they never reach PlayerView or child views
        if (kc == KeyEvent.KEYCODE_DPAD_CENTER      ||
            kc == KeyEvent.KEYCODE_ENTER             ||
            kc == KeyEvent.KEYCODE_BUTTON_A          ||
            kc == KeyEvent.KEYCODE_DPAD_LEFT         ||
            kc == KeyEvent.KEYCODE_DPAD_RIGHT        ||
            kc == KeyEvent.KEYCODE_DPAD_UP           ||
            kc == KeyEvent.KEYCODE_DPAD_DOWN         ||
            kc == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE  ||
            kc == KeyEvent.KEYCODE_MEDIA_PLAY        ||
            kc == KeyEvent.KEYCODE_MEDIA_PAUSE       ||
            kc == KeyEvent.KEYCODE_MEDIA_FAST_FORWARD||
            kc == KeyEvent.KEYCODE_MEDIA_REWIND      ||
            kc == KeyEvent.KEYCODE_BUTTON_R1         ||
            kc == KeyEvent.KEYCODE_BUTTON_L1) {
            if (event.getAction() == KeyEvent.ACTION_DOWN) return onKeyDown(kc, event);
            if (event.getAction() == KeyEvent.ACTION_UP)   return onKeyUp(kc, event);
            return true;
        }
        return super.dispatchKeyEvent(event);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        switch (keyCode) {
            // Confirm handled in onKeyUp — just consume the down event here
            case KeyEvent.KEYCODE_DPAD_CENTER:
            case KeyEvent.KEYCODE_ENTER:
            case KeyEvent.KEYCODE_BUTTON_A:
                return true;

            case KeyEvent.KEYCODE_DPAD_LEFT:
                if (!overlayVisible) { showOverlay(); return true; }
                if (seekRowFocused) {
                    if (!scrubStep(-1)) {
                        long pos = Math.max(0, player.getCurrentPosition() - SEEK_STEP_MS);
                        player.seekTo(pos);
                    }
                } else if (pickerMode != PickerMode.NONE) {
                    movePicker(-1);
                } else {
                    moveCtrl(-1);
                }
                resetHideTimer();
                return true;

            case KeyEvent.KEYCODE_DPAD_RIGHT:
                if (!overlayVisible) { showOverlay(); return true; }
                if (seekRowFocused) {
                    if (!scrubStep(1)) {
                        long dur = player.getDuration();
                        long pos = dur > 0 ? Math.min(dur, player.getCurrentPosition() + SEEK_STEP_MS) : player.getCurrentPosition();
                        player.seekTo(pos);
                    }
                } else if (pickerMode != PickerMode.NONE) {
                    movePicker(1);
                } else {
                    moveCtrl(1);
                }
                resetHideTimer();
                return true;

            case KeyEvent.KEYCODE_DPAD_UP:
                if (!overlayVisible) { showOverlay(); return true; }
                if (seekRowFocused) {
                    // already at top row — do nothing (or could hideOverlay)
                } else if (pickerMode == PickerMode.SUB_STYLE) {
                    if (subStyleRow == 2) {
                        subStyleRow = 1;
                        pickerFocusIdx = SUB_COLOR_LABELS.length + Math.min(2, pickerFocusIdx - (SUB_COLOR_LABELS.length + 3));
                        setPickerFocus(pickerFocusIdx);
                    } else if (subStyleRow == 1) {
                        subStyleRow = 0;
                        pickerFocusIdx = Math.min(pickerFocusIdx - SUB_COLOR_LABELS.length, SUB_COLOR_LABELS.length - 1);
                        if (pickerFocusIdx < 0) pickerFocusIdx = 0;
                        setPickerFocus(pickerFocusIdx);
                    } else {
                        closePicker();
                        seekRowFocused = true;
                        applySeekRowFocusStyle();
                    }
                } else if (pickerMode == PickerMode.AUDIO || pickerMode == PickerMode.SUBS) {
                    if (pickerFocusIdx > 0) setPickerFocus(pickerFocusIdx - 1);
                } else {
                    // control bar → seek row
                    seekRowFocused = true;
                    applySeekRowFocusStyle();
                    setCtrlFocus(ctrlFocusIdx); // un-highlight ctrl buttons
                }
                resetHideTimer();
                return true;

            case KeyEvent.KEYCODE_DPAD_DOWN:
                if (!overlayVisible) { showOverlay(); return true; }
                if (seekRowFocused) {
                    // seek row → control bar
                    seekRowFocused = false;
                    applySeekRowFocusStyle();
                    setCtrlFocus(ctrlFocusIdx);
                } else if (pickerMode == PickerMode.SUB_STYLE) {
                    if (subStyleRow == 0) {
                        subStyleRow = 1;
                        int col = Math.min(pickerFocusIdx, 2);
                        pickerFocusIdx = SUB_COLOR_LABELS.length + col;
                        setPickerFocus(pickerFocusIdx);
                    } else if (subStyleRow == 1) {
                        subStyleRow = 2;
                        int col = Math.max(0, Math.min(2, pickerFocusIdx - SUB_COLOR_LABELS.length));
                        pickerFocusIdx = SUB_COLOR_LABELS.length + 3 + col;
                        setPickerFocus(pickerFocusIdx);
                    }
                } else if (pickerMode == PickerMode.AUDIO || pickerMode == PickerMode.SUBS) {
                    if (pickerFocusIdx + 1 < pickerButtons.size()) setPickerFocus(pickerFocusIdx + 1);
                } else if (pickerMode == PickerMode.NONE) {
                    if (ctrlFocusIdx == 3) togglePicker(PickerMode.AUDIO);
                    else if (ctrlFocusIdx == 4) togglePicker(PickerMode.SUBS);
                    else if (ctrlFocusIdx == 5) togglePicker(PickerMode.SUB_STYLE);
                }
                resetHideTimer();
                return true;

            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
            case KeyEvent.KEYCODE_MEDIA_PLAY:
            case KeyEvent.KEYCODE_MEDIA_PAUSE:
                togglePlayPause();
                if (!overlayVisible) showOverlay(); else resetHideTimer();
                return true;

            case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD:
            case KeyEvent.KEYCODE_BUTTON_R1:
                player.seekForward();
                if (!overlayVisible) showOverlay(); else resetHideTimer();
                return true;

            case KeyEvent.KEYCODE_MEDIA_REWIND:
            case KeyEvent.KEYCODE_BUTTON_L1:
                player.seekBack();
                if (!overlayVisible) showOverlay(); else resetHideTimer();
                return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    // Confirm fires on KEY_UP — single shot, no repeat issues
    @Override
    public boolean onKeyUp(int keyCode, KeyEvent event) {
        switch (keyCode) {
            case KeyEvent.KEYCODE_DPAD_CENTER:
            case KeyEvent.KEYCODE_ENTER:
            case KeyEvent.KEYCODE_BUTTON_A:
                if (!overlayVisible) { showOverlay(); return true; }
                if (pickerMode != PickerMode.NONE) {
                    if (pickerFocusIdx < pickerButtons.size())
                        pickerButtons.get(pickerFocusIdx).performClick();
                } else {
                    if (ctrlFocusIdx < ctrlButtons.size())
                        ctrlButtons.get(ctrlFocusIdx).performClick();
                }
                return true;
        }
        return super.onKeyUp(keyCode, event);
    }

    private void moveCtrl(int dir) {
        int next = Math.max(0, Math.min(ctrlButtons.size() - 1, ctrlFocusIdx + dir));
        setCtrlFocus(next);
    }

    private void movePicker(int dir) {
        int next;
        if (pickerMode == PickerMode.SUB_STYLE) {
            // Clamp within current row
            if (subStyleRow == 0) {
                next = Math.max(0, Math.min(SUB_COLOR_LABELS.length - 1, pickerFocusIdx + dir));
            } else if (subStyleRow == 1) {
                int rowStart = SUB_COLOR_LABELS.length;
                int rowEnd = rowStart + 2; // −, value, +
                next = Math.max(rowStart, Math.min(rowEnd, pickerFocusIdx + dir));
            } else {
                int rowStart = SUB_COLOR_LABELS.length + 3;
                int rowEnd = rowStart + 2;
                next = Math.max(rowStart, Math.min(rowEnd, pickerFocusIdx + dir));
            }
        } else {
            return; // audio/subtitle list is vertical: left/right do nothing
        }
        setPickerFocus(next);
    }

    private void setCtrlFocus(int idx) {
        ctrlFocusIdx = idx;
        for (int i = 0; i < ctrlButtons.size(); i++)
            applyCtrlFocusStyle(ctrlButtons.get(i), i == idx);
    }

    private void setPickerFocus(int idx) {
        pickerFocusIdx = idx;
        for (int i = 0; i < pickerButtons.size(); i++)
            applyPickerFocusStyle(i, i == idx);
        if (pickerMode == PickerMode.AUDIO || pickerMode == PickerMode.SUBS) layoutPickerWindow();
    }

    // ======================================================================
    //  Focus styling
    // ======================================================================
    private void applySeekRowFocusStyle() {
        if (seekRow == null || seekBar == null) return;
        styleSeekBar(seekRowFocused);
        seekTimeCurrent.setTextColor(seekRowFocused ? COLOR_ORANGE : COLOR_TEXT);
        seekTimeTotal.setTextColor(seekRowFocused ? COLOR_TEXT : COLOR_MUTED);
        seekRow.setBackground(null);
    }

    /** Thin rounded track, purple fill, round thumb that grows + glows when focused. */
    private void styleSeekBar(boolean focused) {
        if (seekFill == null) {
            android.graphics.drawable.GradientDrawable bg = new android.graphics.drawable.GradientDrawable();
            bg.setColor(0x40FFFFFF);
            bg.setCornerRadius(dp(4));
            seekFill = new android.graphics.drawable.GradientDrawable();
            seekFill.setCornerRadius(dp(4));
            android.graphics.drawable.ClipDrawable clip = new android.graphics.drawable.ClipDrawable(
                seekFill, Gravity.START, android.graphics.drawable.ClipDrawable.HORIZONTAL);
            android.graphics.drawable.LayerDrawable ld =
                new android.graphics.drawable.LayerDrawable(new android.graphics.drawable.Drawable[]{ bg, clip });
            ld.setId(0, android.R.id.background);
            ld.setId(1, android.R.id.progress);
            ld.setLayerGravity(0, Gravity.CENTER_VERTICAL);
            ld.setLayerGravity(1, Gravity.CENTER_VERTICAL);
            seekBar.setProgressDrawable(ld);
        }
        // track gets a little thicker when focused
        android.graphics.drawable.LayerDrawable ld =
            (android.graphics.drawable.LayerDrawable) seekBar.getProgressDrawable();
        int h = dp(focused ? 7 : 4);
        ld.setLayerHeight(0, h);
        ld.setLayerHeight(1, h);
        seekFill.setColor(focused ? 0xFFB9A8FF : COLOR_ORANGE);

        android.graphics.drawable.GradientDrawable thumb = new android.graphics.drawable.GradientDrawable();
        thumb.setShape(android.graphics.drawable.GradientDrawable.OVAL);
        if (focused) {
            thumb.setColor(0xFFFFFFFF);
            thumb.setStroke(dp(6), 0x669D8AFF);   // soft purple glow ring
            thumb.setSize(dp(26), dp(26));
        } else {
            thumb.setColor(0xFFE9E4FF);
            thumb.setSize(dp(12), dp(12));
        }
        seekBar.setThumb(thumb);
        seekBar.setThumbOffset(0);
        seekBar.invalidate();
    }

    private void applyCtrlFocusStyle(View v, boolean focused) {
        if (!(v instanceof TextView)) return;
        TextView tv = (TextView) v;
        boolean isPrimary = (ctrlButtons.indexOf(v) == 1); // index 1 = play/pause
        if (focused) {
            android.graphics.drawable.GradientDrawable gd = new android.graphics.drawable.GradientDrawable();
            gd.setColor(0xFFFFFFFF);
            gd.setCornerRadius(dp(30));
            gd.setStroke(dp(3), 0x999D8AFF);
            tv.setBackground(gd);
            tv.setTextColor(COLOR_DARK_TEXT);
        } else {
            tv.setBackground(makeCtrlBg(isPrimary));
            tv.setTextColor(COLOR_TEXT);
        }
    }

    private void applyPickerFocusStyle(int idx, boolean focused) {
        if (idx >= pickerButtons.size()) return;
        View v = pickerButtons.get(idx);
        if (v instanceof LinearLayout) { styleListRow((LinearLayout) v, focused); return; }
        if (!(v instanceof TextView)) return;
        TextView tv = (TextView) v;

        boolean active;
        if (pickerMode == PickerMode.SUB_STYLE) {
            if (idx < SUB_COLOR_LABELS.length)
                active = (idx == subColorIdx);
            else
                active = (idx - SUB_COLOR_LABELS.length == 1); // size value chip
        } else active = false;

        tv.setBackground(chipBg(focused, active));
        tv.setTextColor(focused ? COLOR_DARK_TEXT : COLOR_TEXT);
    }

    private android.graphics.drawable.GradientDrawable chipBg(boolean focused, boolean active) {
        android.graphics.drawable.GradientDrawable gd = new android.graphics.drawable.GradientDrawable();
        gd.setCornerRadius(dp(12));
        if (focused) { gd.setColor(0xFFFFFFFF); gd.setStroke(dp(2), 0x999D8AFF); }
        else if (active) { gd.setColor(COLOR_PURPLE_DEEP); }
        else gd.setColor(0x14FFFFFF);
        return gd;
    }

    // ======================================================================
    //  View helpers
    // ======================================================================
    private View makeCtrlButton(String text, boolean large) {
        TextView tv = new TextView(this);
        tv.setText(text);
        tv.setTextColor(COLOR_TEXT);
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, large ? 22 : 14);
        tv.setTypeface(fBold);
        tv.setGravity(Gravity.CENTER);
        // Play/pause gets a taller hit area; other buttons are more compact
        tv.setPadding(dp(large ? 22 : 20), dp(large ? 14 : 11), dp(large ? 22 : 20), dp(large ? 14 : 11));
        tv.setBackground(makeCtrlBg(large));
        tv.setLetterSpacing(0.02f);
        tv.setLayoutParams(new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT));
        return tv;
    }

    /** Dark translucent pill; purple gradient pill for play/pause. */
    private android.graphics.drawable.Drawable makeCtrlBg(boolean isPrimary) {
        android.graphics.drawable.GradientDrawable gd;
        if (isPrimary) {
            gd = new android.graphics.drawable.GradientDrawable(
                android.graphics.drawable.GradientDrawable.Orientation.TL_BR,
                new int[]{ 0xFF6C48EC, 0xFF4A29B8 });
        } else {
            gd = new android.graphics.drawable.GradientDrawable();
            gd.setColor(0x990E0820);
            gd.setStroke(dp(1), 0x33FFFFFF);
        }
        gd.setCornerRadius(dp(30));
        return gd;
    }

    private android.graphics.drawable.GradientDrawable makeCardBg() {
        android.graphics.drawable.GradientDrawable gd = new android.graphics.drawable.GradientDrawable(
            android.graphics.drawable.GradientDrawable.Orientation.TOP_BOTTOM,
            new int[]{ 0xF51B1336, 0xF5120C26 });
        gd.setCornerRadius(dp(16));
        gd.setStroke(dp(1), 0x40A08CFF);
        return gd;
    }

    private Typeface loadFont(int res, Typeface fallback) {
        try {
            Typeface t = androidx.core.content.res.ResourcesCompat.getFont(this, res);
            return t != null ? t : fallback;
        } catch (Exception e) {
            return fallback;
        }
    }

    private View makePickerButton(String text, boolean active) {
        TextView tv = new TextView(this);
        tv.setText(text);
        tv.setTextColor(COLOR_TEXT);
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        tv.setTypeface(fBold);
        tv.setGravity(Gravity.CENTER);
        tv.setPadding(dp(16), dp(9), dp(16), dp(9));
        tv.setBackground(chipBg(false, active));
        return tv;
    }

    private android.graphics.drawable.GradientDrawable makeGradient() {
        return new android.graphics.drawable.GradientDrawable(
            android.graphics.drawable.GradientDrawable.Orientation.BOTTOM_TOP,
            new int[]{ 0xEE0A0614, 0x00000000 });
    }

    private android.graphics.drawable.GradientDrawable makeRoundedBg(int color, int radius) {
        android.graphics.drawable.GradientDrawable gd = new android.graphics.drawable.GradientDrawable();
        gd.setColor(color);
        gd.setCornerRadius(radius);
        return gd;
    }

    private View hSpacer(int width) {
        View v = new View(this);
        v.setLayoutParams(new LinearLayout.LayoutParams(width, 1));
        return v;
    }

    private FrameLayout.LayoutParams matchParent() {
        return new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT);
    }

    private int dp(int val) {
        return Math.round(TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP, val, getResources().getDisplayMetrics()));
    }

    // ======================================================================
    //  Seekbar polling
    // ======================================================================
    private void startSeekPoll() {
        seekPollHandler.removeCallbacks(seekPollRunnable);
        seekPollHandler.post(seekPollRunnable);
    }

    private void stopSeekPoll() {
        seekPollHandler.removeCallbacks(seekPollRunnable);
    }

    private void updateSeekBar() {
        if (seekBar == null) return;
        if (!seekBarTracking && scrubPos < 0) {
            long dur = player.getDuration();
            long pos = player.getCurrentPosition();
            if (dur > 0) {
                seekBar.setProgress((int)(pos * 1000L / dur));
                seekTimeCurrent.setText(formatTime(pos));
                seekTimeTotal.setText(formatTime(dur));
            }
        }
        if (overlayVisible) seekPollHandler.postDelayed(seekPollRunnable, 500);
    }

    // ======================================================================
    //  Seek preview thumbnails (trick play)
    // ======================================================================
    // The server (/api/tv/trickplay/:id) makes sprite sheets: one small frame every few seconds, tiled into JPEGs.
    // They are downloaded in the background when playback starts and kept as compressed JPEG data; only the one
    // tile that is shown gets decoded (BitmapRegionDecoder), so scrubbing needs no network and stays light on TV boxes.
    // No sheets (server without ffmpeg, preview switched off, film not processed yet) = no preview, and seeking
    // works exactly as before. Sheets that are already finished are used while the rest is still being made.
    private static final int PREVIEW_W_DP = 200, PREVIEW_H_DP = 112;
    private static final long SCRUB_COMMIT_MS = 700;   // D-pad: wait this long after the last press, then seek
    private FrameLayout overlayContainer;
    private LinearLayout previewBox;
    private ImageView previewImage;
    private TextView previewTime;
    private final ExecutorService trickExecutor = Executors.newSingleThreadExecutor();
    private volatile boolean trickStop = false;
    private volatile boolean trickMetaReady = false;   // set last, after the grid fields below are filled in
    private volatile int trickLoaded = 0;              // number of sheets downloaded so far
    private int trickIntervalS, trickTileW, trickTileH, trickCols, trickRows, trickCount;
    private AtomicReferenceArray<BitmapRegionDecoder> trickSheets;
    private int previewLastTile = -1;
    private long scrubPos = -1;                        // D-pad: position being scrubbed to (-1 = none yet)
    private final Runnable scrubCommitRunnable = this::commitScrub;

    private void startTrickplay() {
        if (progressUrl == null || !progressUrl.endsWith("/progress") || movieId == null || movieId.isEmpty()) return;
        final String base = progressUrl.substring(0, progressUrl.length() - "/progress".length()) + "/trickplay/" + movieId;
        try { trickExecutor.execute(() -> trickplayLoop(base)); } catch (RuntimeException ignored) { /* shutting down */ }
    }

    /** Background thread: fetch the grid description and every finished sheet; keep checking until all are in. */
    private void trickplayLoop(String base) {
        int[] code = new int[1];
        for (int attempt = 0; attempt < 720 && !trickStop; attempt++) {
            long waitMs = 15_000;
            try {
                code[0] = 0;
                byte[] body = httpGet(base, code);
                if (code[0] == 404) return;                      // preview off, no ffmpeg on the server, or unknown film
                if (body != null && code[0] == 200) {
                    JSONObject j = new JSONObject(new String(body, StandardCharsets.UTF_8));
                    int sheets = j.optInt("sheets"), ready = j.optInt("ready");
                    if (!trickMetaReady && sheets > 0) {
                        trickIntervalS = j.getInt("interval");
                        trickTileW = j.getInt("tileW");  trickTileH = j.getInt("tileH");
                        trickCols  = j.getInt("cols");   trickRows  = j.getInt("rows");
                        trickCount = j.getInt("count");
                        trickSheets = new AtomicReferenceArray<>(sheets);
                        trickMetaReady = true;
                    }
                    if (trickMetaReady) {
                        while (trickLoaded < ready && trickLoaded < trickSheets.length() && !trickStop) {
                            byte[] jpg = httpGet(base + "/" + trickLoaded + ".jpg", null);
                            if (jpg == null) break;
                            trickSheets.set(trickLoaded, BitmapRegionDecoder.newInstance(jpg, 0, jpg.length, false));
                            trickLoaded++;
                        }
                        if (j.optBoolean("done") && trickLoaded >= Math.min(sheets, trickSheets.length())) return;
                    }
                    waitMs = trickLoaded < ready ? 2_000 : 10_000;
                } else {
                    waitMs = 4_000;                              // 202: the server is still making the first sheet
                }
            } catch (Exception e) {
                android.util.Log.d("PlayerActivity", "Trickplay fetch failed: " + e.getMessage());
            }
            try { Thread.sleep(waitMs); } catch (InterruptedException e) { return; }
        }
    }

    private byte[] httpGet(String url, int[] codeOut) throws Exception {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(4000);
            c.setReadTimeout(20000);
            int status = c.getResponseCode();
            if (codeOut != null) codeOut[0] = status;
            if (status < 200 || status >= 300) return null;
            try (InputStream in = c.getInputStream()) {
                ByteArrayOutputStream out = new ByteArrayOutputStream(64 * 1024);
                byte[] buf = new byte[16 * 1024];
                int n;
                while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
                return out.toByteArray();
            }
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /** Show the frame for posMs above the seek bar. frac = position along the bar (0..1). Hides itself if that part has no sheet yet. */
    private void showPreview(long posMs, float frac) {
        if (previewBox == null || !trickMetaReady || trickCount <= 0) return;
        int tile = (int) Math.max(0, Math.min(trickCount - 1, posMs / 1000L / trickIntervalS));
        int per = trickCols * trickRows;
        int sheet = tile / per;
        BitmapRegionDecoder dec = sheet < trickSheets.length() ? trickSheets.get(sheet) : null;
        if (dec == null) { previewBox.setVisibility(View.GONE); return; }
        if (tile != previewLastTile) {
            int idx = tile % per, x = (idx % trickCols) * trickTileW, y = (idx / trickCols) * trickTileH;
            Bitmap bmp = null;
            try {
                if (x + trickTileW <= dec.getWidth() && y + trickTileH <= dec.getHeight()) {
                    BitmapFactory.Options o = new BitmapFactory.Options();
                    o.inPreferredConfig = Bitmap.Config.RGB_565;
                    bmp = dec.decodeRegion(new Rect(x, y, x + trickTileW, y + trickTileH), o);
                }
            } catch (Exception ignored) { /* leave bmp null */ }
            if (bmp == null) { previewBox.setVisibility(View.GONE); return; }
            previewImage.setImageBitmap(bmp);
            previewLastTile = tile;
        }
        previewTime.setText(formatTime(posMs));
        previewBox.setVisibility(View.VISIBLE);
        int[] sb = new int[2], oc = new int[2];
        seekBar.getLocationOnScreen(sb);
        overlayContainer.getLocationOnScreen(oc);
        int pad = seekBar.getPaddingLeft();
        float trackW = Math.max(1, seekBar.getWidth() - pad - seekBar.getPaddingRight());
        int boxW = dp(PREVIEW_W_DP), boxH = dp(PREVIEW_H_DP) + dp(26);
        int left = (int) (sb[0] - oc[0] + pad + frac * trackW - boxW / 2f);
        left = Math.max(dp(12), Math.min(overlayContainer.getWidth() - boxW - dp(12), left));
        previewBox.setTranslationX(left);
        previewBox.setTranslationY(sb[1] - oc[1] - boxH - dp(10));
    }

    private void hidePreview() {
        if (previewBox != null) previewBox.setVisibility(View.GONE);
    }

    /**
     * D-pad left/right on the seek row while previews exist: move a pending position, show its frame, and seek once
     * the viewer pauses (so holding the key does not fire a seek per press). Returns false when there are no
     * previews - the caller then seeks right away as before.
     */
    private boolean scrubStep(int direction) {
        if (!trickMetaReady || trickLoaded == 0 || player == null) return false;
        long dur = player.getDuration();
        if (dur <= 0) return false;
        long base = scrubPos >= 0 ? scrubPos : player.getCurrentPosition();
        scrubPos = Math.max(0, Math.min(dur, base + direction * SEEK_STEP_MS));
        float frac = scrubPos / (float) dur;
        seekBar.setProgress((int) (frac * 1000));
        seekTimeCurrent.setText(formatTime(scrubPos));
        showPreview(scrubPos, frac);
        seekPollHandler.removeCallbacks(scrubCommitRunnable);
        seekPollHandler.postDelayed(scrubCommitRunnable, SCRUB_COMMIT_MS);
        return true;
    }

    /** Seek to the scrubbed position (if any) and hide the preview. */
    private void commitScrub() {
        seekPollHandler.removeCallbacks(scrubCommitRunnable);
        if (scrubPos >= 0 && player != null) player.seekTo(scrubPos);
        scrubPos = -1;
        hidePreview();
    }

    private String formatTime(long ms) {
        long s   = ms / 1000;
        long h   = s / 3600;
        long m   = (s % 3600) / 60;
        long sec = s % 60;
        return String.format("%d:%02d:%02d", h, m, sec);
    }

    // ======================================================================
    //  Lifecycle
    // ======================================================================
    /** Exit the player and report current playback position back to the plugin. */
    private void finishWithPosition() {
        commitScrub();
        long pos = (player != null) ? player.getCurrentPosition() : 0L;
        long dur = (player != null) ? player.getDuration()        : 0L;
        reportProgress();
        Intent result = new Intent();
        result.putExtra(EXTRA_POSITION_MS, pos);
        result.putExtra("durationMs", dur);
        setResult(RESULT_OK, result);
        finish();
    }

    @Override
    protected void onStop() {
        super.onStop();
        reportProgress(); // Home pressed or screen off: keep the resume point current
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        hideHandler.removeCallbacks(hideRunnable);
        progressHandler.removeCallbacks(progressRunnable);
        progressExecutor.shutdown(); // lets the final position report finish
        trickStop = true;
        trickExecutor.shutdownNow();
        seekPollHandler.removeCallbacks(scrubCommitRunnable);
        if (trickSheets != null) {
            for (int i = 0; i < trickSheets.length(); i++) {
                BitmapRegionDecoder d = trickSheets.get(i);
                if (d != null) d.recycle();
            }
        }
        stopSeekPoll();
        stopClock();
        if (player != null) { player.release(); player = null; }
        trackSelector = null;
    }
}
