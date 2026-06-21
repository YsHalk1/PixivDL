package com.pixivdl.application;

import android.Manifest;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.os.Bundle;
import android.os.AsyncTask;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.MediaScannerConnection;
import android.os.Build;
import android.os.Environment;
import android.os.Vibrator;
import android.os.VibrationEffect;
import android.os.Build;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;
import android.net.Uri;
import android.provider.Settings;
import android.content.Intent;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONException;

import java.io.BufferedInputStream;
import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.URL;
import java.net.HttpURLConnection;
import java.net.URLEncoder;
import java.security.MessageDigest;
import java.security.SecureRandom;

import android.util.Base64;

public class MainActivity extends Activity {

        private WebView uiWebView;
        private WebView authWebView;
        private View authLoader;
        private View authLoaderLogo;
        private volatile boolean isSmartCacheRunning = false;

        private String codeVerifier;
        private boolean authCodeUsed = false;

        private String lastPreviewIllustId = "";

        private AutoPreviewTask currentPreviewTask;
        // Очередь загрузки превью: строго по 1 задаче за раз
        private final ExecutorService previewExecutor = Executors.newFixedThreadPool(1);

        private HashMap<String, IllustDownloadTask> activeDownloads = new HashMap<String, IllustDownloadTask>();

        private static final int REQUEST_WRITE_STORAGE = 1001;
        private static final int REQUEST_ALL_PERMS = 1002;
        private static final String PREFS_NAME = "pixiv_auth";
        private static final String KEY_ACCESS_TOKEN = "access_token";
        private static final String KEY_REFRESH_TOKEN = "refresh_token";
        private static final String KEY_USER_ID = "user_id";
        private static final String KEY_USER_NAME = "user_name";
        private static final String KEY_USER_AVATAR = "user_avatar"; 

        private static final String LOGIN_URL = "https://app-api.pixiv.net/web/v1/login";
        private static final String TOKEN_URL = "https://oauth.secure.pixiv.net/auth/token";
        private static final String REDIRECT_URI = "https://app-api.pixiv.net/web/v1/users/auth/pixiv/callback";

        private static final String CLIENT_ID = "MOBrBDS8blbauoSck0ZfDbtuzpyT";
        private static final String CLIENT_SECRET = "lsACyCD94FhDUtGTXi3QzcFE2uU1hqtDaKeqrdwj";
        private static final String USER_AGENT = "PixivAndroidApp/5.0.234 Android";
        // UA реального Chrome для WebView входа: Google блокирует OAuth в WebView,
        // если UA содержит маркер "; wv" (ошибка "disallowed_useragent" /
        // "небезопасный браузер"). Подменяем его на UA настоящего браузера.
        private static final String AUTH_USER_AGENT = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
        private static final String APP_OS = "android";
        private static final String APP_OS_VERSION = "16";
        private static final String APP_VERSION = "5.0.234";

        // Сразу под другими private static final...
        static final int NATIVE_APP_VERSION = 16;

        // ====== Состояние подборки "Может понравиться" (страница Discovery) ======
        // Список результатов: id всех уже показанных работ (для дедупликации между циклами).
        private final java.util.LinkedHashSet<String> discoveryShownIds = new java.util.LinkedHashSet<>();
        // Те же показанные работы как пул сидов для последующих циклов: {illustId, xRestrict}.
        private final java.util.ArrayList<long[]> discoverySeedPool = new java.util.ArrayList<>();
        private final Object discoveryLock = new Object();
        // Сколько работ отдаём за один цикл и сколько сидов берём.
        private static final int DISCOVERY_BATCH = 30;
        private static final int DISCOVERY_SEEDS = 5;
        private static final int DISCOVERY_SEEDS_R18 = 2;

        // Полный сброс списка результатов (смена фильтра либо выход из раздела).
        private void clearDiscoveryState() {
                synchronized (discoveryLock) {
                        discoveryShownIds.clear();
                        discoverySeedPool.clear();
                }
        }

        // ====== Экспериментальные: Telegram (TDLib через рефлексию) ======
        private TelegramManager tgManager;

        private synchronized TelegramManager getTgManager() {
                if (tgManager == null) {
                        tgManager = new TelegramManager(getApplicationContext(), new TelegramManager.TgEvents() {
                                @Override public void onState(String json) {
                                        runJs("if(window.tgOnState)window.tgOnState('" + jsQuote(json) + "');");
                                }
                                @Override public void onChannels(String b64) {
                                        runJs("if(window.tgOnChannels)window.tgOnChannels('" + b64 + "');");
                                }
                        });
                }
                return tgManager;
        }

        // Экранирование строки для безопасной вставки в одинарные кавычки JS.
        private static String jsQuote(String s) {
                if (s == null) return "";
                StringBuilder sb = new StringBuilder(s.length() + 16);
                for (int i = 0; i < s.length(); i++) {
                        char c = s.charAt(i);
                        switch (c) {
                                case '\\': sb.append("\\\\"); break;
                                case '\'': sb.append("\\'"); break;
                                case '\n': sb.append("\\n"); break;
                                case '\r': sb.append("\\r"); break;
                                case ' ': sb.append("\\u2028"); break;
                                case ' ': sb.append("\\u2029"); break;
                                default: sb.append(c);
                        }
                }
                return sb.toString();
        }

        // ====== Экспериментальные: отправка работы в Telegram через бота ======
        // Фаза 1 — параллельная загрузка оригиналов (пул потоков) + ужатие под лимиты Telegram.
        // Фаза 2 — последовательная отправка через sendPhoto (сохраняет порядок страниц).
        // Прогресс/итог сообщаем в JS через window.tgShareProgress(done,total,phase) / tgShareDone.
        private void shareIllustToTelegram(final String chatId, final String urlsJson, final String caption, final String parseMode) {
                new Thread(new Runnable() { public void run() {
                        TelegramManager tg = getTgManager();
                        String token = tg.getToken();
                        if (token == null || token.length() == 0) {
                                runJs("if(window.tgShareDone)window.tgShareDone(0,0,'Бот не привязан');");
                                return;
                        }

                        org.json.JSONArray urls;
                        try { urls = new org.json.JSONArray(urlsJson); }
                        catch (Exception e) { runJs("if(window.tgShareDone)window.tgShareDone(0,0,'Нет изображений');"); return; }

                        final int total = urls.length();
                        if (total == 0) { runJs("if(window.tgShareDone)window.tgShareDone(0,0,'Нет изображений');"); return; }

                        // --- Фаза 1: параллельная загрузка и подготовка изображений ---
                        final byte[][] buffers = new byte[total][];
                        final java.util.concurrent.atomic.AtomicInteger downloaded = new java.util.concurrent.atomic.AtomicInteger(0);
                        int poolSize = Math.min(4, total);
                        ExecutorService pool = Executors.newFixedThreadPool(poolSize);
                        for (int i = 0; i < total; i++) {
                                final int idx = i;
                                final String imageUrl = urls.optString(i, "");
                                pool.execute(new Runnable() { public void run() {
                                        byte[] raw = (imageUrl.length() == 0) ? null : readImageBytes(imageUrl);
                                        if (raw != null) buffers[idx] = prepareForTelegram(raw);
                                        int d = downloaded.incrementAndGet();
                                        runJs("if(window.tgShareProgress)window.tgShareProgress(" + d + "," + total + ",'download');");
                                }});
                        }
                        pool.shutdown();
                        try { pool.awaitTermination(5, java.util.concurrent.TimeUnit.MINUTES); }
                        catch (InterruptedException ignored) {}

                        // Уплотняем успешно загруженные изображения, сохраняя порядок страниц.
                        byte[][] ready = new byte[total][];
                        int got = 0;
                        for (int i = 0; i < total; i++) {
                                if (buffers[i] != null && buffers[i].length > 0) ready[got++] = buffers[i];
                        }

                        // --- Фаза 2: отправка альбомами по 10 (sendMediaGroup), порядок сохраняется ---
                        final int ALBUM = 10;
                        int sent = 0;
                        boolean firstChunk = true;
                        for (int start = 0; start < got; start += ALBUM) {
                                int count = Math.min(ALBUM, got - start);
                                String cap = firstChunk ? caption : null;
                                if (tg.sendMediaGroup(token, chatId, ready, start, count, cap, parseMode)) sent += count;
                                firstChunk = false;
                                int doneNow = Math.min(start + count, got);
                                runJs("if(window.tgShareProgress)window.tgShareProgress(" + doneNow + "," + (got > 0 ? got : total) + ",'send');");
                        }

                        runJs("if(window.tgShareDone)window.tgShareDone(" + sent + "," + total + ",'');");
                }}).start();
        }

        // Скачивание байтов изображения pixiv (с нужным Referer внутри openPixivImageStream).
        private byte[] readImageBytes(String imageUrl) {
                InputStream is = null;
                try {
                        is = openPixivImageStream(imageUrl);
                        if (is == null) return null;
                        ByteArrayOutputStream bos = new ByteArrayOutputStream();
                        byte[] buf = new byte[16384];
                        int n;
                        while ((n = is.read(buf)) != -1) bos.write(buf, 0, n);
                        return bos.toByteArray();
                } catch (Throwable t) {
                        return null;
                } finally {
                        if (is != null) { try { is.close(); } catch (Exception ignored) {} }
                }
        }

        // Ужимаем изображение под лимиты Telegram sendPhoto (<=10 МБ, длинная сторона <=2560),
        // чтобы устранить ошибку «фото слишком большое». Маленькие фото отправляем без перекодирования.
        private byte[] prepareForTelegram(byte[] raw) {
                if (raw == null) return null;
                try {
                        BitmapFactory.Options bounds = new BitmapFactory.Options();
                        bounds.inJustDecodeBounds = true;
                        BitmapFactory.decodeByteArray(raw, 0, raw.length, bounds);
                        int w = bounds.outWidth, h = bounds.outHeight;
                        if (w <= 0 || h <= 0) return raw; // не распознали как картинку — шлём как есть

                        final int MAX_DIM = 2560;          // длинная сторона при ужатии
                        final int MAX_BYTES = 9_500_000;   // запас под лимит 10 МБ
                        final int MAX_SUM = 10000;         // Telegram: ширина + высота <= 10000

                        // Фото уже в пределах лимитов Telegram — отправляем оригинал без перекодирования
                        // (перекодирование — самая дорогая операция, поэтому делаем его только при превышении).
                        if (raw.length < MAX_BYTES && (w + h) <= MAX_SUM) return raw;

                        // Грубое уменьшение при декодировании (экономит память на огромных PNG).
                        int sample = 1;
                        while ((Math.max(w, h) / (sample * 2)) >= MAX_DIM) sample *= 2;
                        BitmapFactory.Options opt = new BitmapFactory.Options();
                        opt.inSampleSize = sample;
                        Bitmap bmp = BitmapFactory.decodeByteArray(raw, 0, raw.length, opt);
                        if (bmp == null) return raw;

                        // Точное приведение длинной стороны к MAX_DIM.
                        int bw = bmp.getWidth(), bh = bmp.getHeight();
                        if (Math.max(bw, bh) > MAX_DIM) {
                                float scale = MAX_DIM / (float) Math.max(bw, bh);
                                Bitmap scaled = Bitmap.createScaledBitmap(bmp, Math.round(bw * scale), Math.round(bh * scale), true);
                                if (scaled != bmp) { bmp.recycle(); bmp = scaled; }
                        }

                        // JPEG с понижением качества, пока не уложимся в лимит по размеру.
                        int quality = 92;
                        byte[] out;
                        do {
                                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                                bmp.compress(Bitmap.CompressFormat.JPEG, quality, bos);
                                out = bos.toByteArray();
                                quality -= 12;
                        } while (out.length > MAX_BYTES && quality >= 50);
                        bmp.recycle();
                        return out;
                } catch (Throwable t) {
                        return raw;
                }
        }

        @Override
        public void onWindowFocusChanged(boolean hasFocus) {
                super.onWindowFocusChanged(hasFocus);
                if (hasFocus && Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
                        getWindow().getDecorView().setSystemUiVisibility(
                                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION // скрывает нижнюю панель
                                | View.SYSTEM_UI_FLAG_FULLSCREEN      // скрывает верхнюю строку (статус-бар)
                                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY // делает режим "липким" (панели сами прячутся)
                        );
                }
        }


        @Override
        protected void onCreate(Bundle savedInstanceState) {
                // Хак для обхода защиты Uri...
                if (android.os.Build.VERSION.SDK_INT >= 24) {
                        try {
                                java.lang.reflect.Method m = android.os.StrictMode.class.getMethod("disableDeathOnFileUriExposure");
                                m.invoke(null);
                        } catch (Exception e) {}
                }

                super.onCreate(savedInstanceState);

                // --- ДОБАВЬ ЭТОТ БЛОК ---
                // Разрешаем приложению залезать под вырез камеры (чёлку)
                if (Build.VERSION.SDK_INT >= 28) { // Build.VERSION_CODES.P
                        getWindow().getAttributes().layoutInDisplayCutoutMode = 
                                android.view.WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
                }
                // ------------------------

                requestWindowFeature(android.view.Window.FEATURE_NO_TITLE);

                // ... дальше идет остальной твой код ...

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
                        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE | 
                                                                                                                          View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
                }

                setContentView(R.layout.activity_main);

                if (Build.VERSION.SDK_INT >= 21) {
                        getWindow().setStatusBarColor(android.graphics.Color.parseColor("#00000000"));
                        getWindow().setNavigationBarColor(android.graphics.Color.parseColor("#00000000"));
                }


                uiWebView = findViewById(R.id.uiWebView);
                authWebView = findViewById(R.id.authWebView);

                WebSettings uiSettings = uiWebView.getSettings();
                uiSettings.setJavaScriptEnabled(true);
                uiSettings.setDomStorageEnabled(true);
                uiSettings.setMediaPlaybackRequiresUserGesture(false);

                uiWebView.setWebChromeClient(new WebChromeClient());

                uiWebView.setWebViewClient(new WebViewClient() {
                                @Override
                                public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                                        if (Build.VERSION.SDK_INT >= 21) {
                                                String url = request.getUrl().toString();
                                                if (url.startsWith("https://offline-cache/")) return fetchOfflineImage(url);
                                                if (url.startsWith("https://app.local/")) return fetchLocalAppAsset(url); // <-- НОВОЕ
                                                if (url.contains("pximg.net")) return fetchPixivImageForWebView(url);
                                        }
                                        return super.shouldInterceptRequest(view, request);
                                }

                                @Override
                                public WebResourceResponse shouldInterceptRequest(WebView view, String url) {
                                        if (url.startsWith("https://offline-cache/")) return fetchOfflineImage(url);
                                        if (url.startsWith("https://app.local/")) return fetchLocalAppAsset(url); // <-- НОВОЕ
                                        if (url.contains("pximg.net")) return fetchPixivImageForWebView(url);
                                        return super.shouldInterceptRequest(view, url);
                                }

                                // ==========================================
                                // ВОЛШЕБНЫЙ МАРШРУТИЗАТОР OTA-ОБНОВЛЕНИЙ
                                // ==========================================
                                private WebResourceResponse fetchLocalAppAsset(String urlString) {
                                        try {
                                                String fileName = urlString.replace("https://app.local/", "");
                                                if (fileName.isEmpty() || fileName.equals("/")) fileName = "index.html";
                                                if (fileName.contains("?")) fileName = fileName.substring(0, fileName.indexOf("?"));

                                                // 1. Сначала ищем свежий скачанный файл в обновлениях
                                                File updateFile = new File(getExternalFilesDir(null), "AppUpdates/" + fileName);
                                                if (updateFile.exists()) {
                                                        return new WebResourceResponse(getMimeTypeFromFileName(fileName), "UTF-8", new java.io.FileInputStream(updateFile));
                                                }

                                                // 2. Если обновления нет - берем старый добрый файл из APK
                                                return new WebResourceResponse(getMimeTypeFromFileName(fileName), "UTF-8", getAssets().open(fileName));
                                        } catch (Exception e) {
                                                return null;
                                        }
                                }
                                // ... (тут остаются ваши старые fetchOfflineImage и fetchPixivImageForWebView)

                                // --- НОВЫЙ МЕТОД ДЛЯ ОФФЛАЙН КАРТИНОК ---
                                private WebResourceResponse fetchOfflineImage(String urlString) {
                                        try {
                                                String fileName = urlString.substring("https://offline-cache/".length());
                                                fileName = java.net.URLDecoder.decode(fileName, "UTF-8");
                                                File file = new File(getExternalFilesDir(null), "OfflineCache/" + fileName);
                                                if (file.exists()) {
                                                        return new WebResourceResponse(getMimeTypeFromFileName(fileName), "UTF-8", new java.io.FileInputStream(file));
                                                }
                                        } catch (Exception e) {}
                                        return null;
                                }


                                private WebResourceResponse fetchPixivImageForWebView(String urlString) {
                                        try {
                                                URL url = new URL(urlString);
                                                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                                                conn.setRequestProperty("Referer", "https://app-api.pixiv.net/");
                                                conn.setRequestProperty("User-Agent", USER_AGENT);
                                                conn.setConnectTimeout(10000);
                                                conn.setReadTimeout(10000);
                                                return new WebResourceResponse("image/jpeg", "UTF-8", conn.getInputStream());
                                        } catch (Exception e) {
                                                return null;
                                        }
                                }
                        });

                uiWebView.addJavascriptInterface(new WebAppInterface(), "Android");
                uiWebView.loadUrl("https://app.local/index.html");

                authLoader = findViewById(R.id.authLoader);
                authLoaderLogo = findViewById(R.id.authLoaderLogo);

                WebSettings authSettings = authWebView.getSettings();
                authSettings.setJavaScriptEnabled(true);
                authSettings.setDomStorageEnabled(true);
                // Притворяемся настоящим Chrome, иначе вход через Google падает с
                // "запрос не соответствует правилам Google о безопасных браузерах".
                authSettings.setUserAgentString(AUTH_USER_AGENT);
                authSettings.setSupportMultipleWindows(false);
                // OAuth Google использует сторонние куки между accounts.google.com и pixiv.
                android.webkit.CookieManager.getInstance().setAcceptCookie(true);
                if (Build.VERSION.SDK_INT >= 21) {
                        android.webkit.CookieManager.getInstance().setAcceptThirdPartyCookies(authWebView, true);
                }

                authWebView.setWebChromeClient(new android.webkit.WebChromeClient() {
                        @Override
                        public void onProgressChanged(WebView view, int newProgress) {
                                // Прячем лоадер, как только страница входа полностью отрисована
                                if (newProgress >= 100) hideAuthLoader();
                        }
                });

                new Handler(Looper.getMainLooper()).postDelayed(new Runnable() {
                                @Override
                                public void run() {
                                        // Запрашиваем все нужные приложению разрешения одним окном
                                        requestAllPermissions();
                                        loadSavedUserAndRefreshTokenIfPossible();
                                        handleIntent(getIntent());
                                }
                        }, 1000);
                        
            android.webkit.CookieManager.getInstance().setAcceptCookie(true);

            // Планируем фоновую проверку обновлений (работает и при закрытом приложении)
            try {
                UpdateCheckReceiver.schedule(getApplicationContext());
            } catch (Exception e) {
                e.printStackTrace();
            }
        }

        // ==========================================
        // МЕТОДЫ ПОДНЯТЫ НАВЕРХ ДЛЯ ИСПРАВЛЕНИЯ БАГА AIDE
        // ==========================================
        private void performLogout() {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        String currentId = prefs.getString(KEY_USER_ID, "");

        // Удаляем текущий аккаунт из "Сейфа"
        String json = prefs.getString("saved_accounts_list", "[]");
        try {
            JSONArray arr = new JSONArray(json);
            JSONArray newArr = new JSONArray();
            for (int i=0; i<arr.length(); i++) {
                JSONObject obj = arr.getJSONObject(i);
                if (!obj.optString("id").equals(currentId)) {
                    newArr.put(obj);
                }
            }
            prefs.edit().putString("saved_accounts_list", newArr.toString()).apply();
        } catch (Exception e) {}

        // Стираем активную сессию токенов
        prefs.edit().remove(KEY_ACCESS_TOKEN).remove(KEY_REFRESH_TOKEN)
            .remove(KEY_USER_ID).remove(KEY_USER_NAME).remove(KEY_USER_AVATAR).apply();

        // ==== СТИРАЕМ КУКИ ИЗ БРАУЗЕРА ====
        android.webkit.CookieManager cookieManager = android.webkit.CookieManager.getInstance();
        if (Build.VERSION.SDK_INT >= 21) {
            cookieManager.removeAllCookies(null);
            cookieManager.flush();
        } else {
            cookieManager.removeAllCookie();
        }
        // ==================================

        authCodeUsed = false;
        codeVerifier = null;
        lastPreviewIllustId = "";

        updateUIAccount("", "", "✗ Вход не выполнен", false, ""); 
        if (currentPreviewTask != null) {
            currentPreviewTask.cancel(true);
        }
        updateUIPreview(null, "Изображение не загружено");
        authWebView.stopLoading();
        authWebView.loadUrl("about:blank");
        authWebView.setVisibility(View.GONE);
        hideAuthLoader();
        updateUIStatus("Аккаунт удален.");
        Toast.makeText(this, "Выход выполнен", Toast.LENGTH_SHORT).show();
    }

        private String extractIllustId(String input) {
                try {
                        if (input == null) return null;
                        String text = input.trim();
                        if (text.matches("\\d+")) return text;
                        java.util.regex.Matcher m = java.util.regex.Pattern.compile("(?:artworks/|illust_id=|PixivDL/|/i/)(\\d+)").matcher(text);
                        if (m.find()) return m.group(1);
                } catch (Exception ignored) {}
                return null;
        }
        // ==========================================

        private boolean hasStoragePermission() {
                // Android 11+ (R): полноценный доступ к файлам даёт только «Доступ ко всем файлам»
                if (Build.VERSION.SDK_INT >= 30) {
                        try { return Environment.isExternalStorageManager(); } catch (Exception e) { return false; }
                }
                if (Build.VERSION.SDK_INT >= 23) {
                        boolean read = checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED;
                        if (Build.VERSION.SDK_INT >= 29) {
                                return read;
                        } else {
                                boolean write = checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED;
                                return read && write;
                        }
                }
                return true;
        }

        private void requestStoragePermission() {
                // Android 11+: уводим пользователя на системный экран «Доступ ко всем файлам»
                if (Build.VERSION.SDK_INT >= 30) {
                        requestAllFilesAccess();
                        return;
                }
                if (Build.VERSION.SDK_INT >= 23) {
                        requestPermissions(new String[]{
                                                                      Manifest.permission.READ_EXTERNAL_STORAGE,
                                                                      Manifest.permission.WRITE_EXTERNAL_STORAGE
                                                              }, REQUEST_WRITE_STORAGE);
                }
        }

        // Открывает системный экран выдачи «Доступ ко всем файлам» (Android 11+),
        // если он ещё не выдан. Нужен для записи бэкапа в публичную папку «Загрузки».
        private void requestAllFilesAccess() {
                if (Build.VERSION.SDK_INT < 30) return;
                try {
                        if (Environment.isExternalStorageManager()) return; // уже выдан
                        Intent intent = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION);
                        intent.setData(Uri.parse("package:" + getPackageName()));
                        startActivity(intent);
                } catch (Exception e) {
                        // На части прошивок прямого экрана для пакета нет — открываем общий список
                        try {
                                Intent intent = new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION);
                                startActivity(intent);
                        } catch (Exception ignored) {}
                }
        }

        // Запрашивает за один раз все разрешения, которые реально нужны приложению
        // на текущей версии Android: уведомления (13+), доступ к памяти (на старых версиях)
        // и «Доступ ко всем файлам» (11+) для резервных копий.
        private void requestAllPermissions() {
                if (Build.VERSION.SDK_INT < 23) return; // до Android 6 разрешения выдаются при установке

                java.util.ArrayList<String> need = new java.util.ArrayList<String>();

                // Уведомления о загрузках/обновлениях (Android 13+)
                if (Build.VERSION.SDK_INT >= 33) {
                        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                                need.add(Manifest.permission.POST_NOTIFICATIONS);
                        }
                }

                // Чтение общей памяти (до Android 12 включительно)
                if (Build.VERSION.SDK_INT <= 32) {
                        if (checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                                need.add(Manifest.permission.READ_EXTERNAL_STORAGE);
                        }
                }

                // Запись в общую память (до Android 9 включительно; на 10+ не действует)
                if (Build.VERSION.SDK_INT <= 28) {
                        if (checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                                need.add(Manifest.permission.WRITE_EXTERNAL_STORAGE);
                        }
                }

                if (!need.isEmpty()) {
                        // Сначала обычные runtime-разрешения; «Доступ ко всем файлам»
                        // запросим в onRequestPermissionsResult, чтобы окна не перекрывались.
                        requestPermissions(need.toArray(new String[need.size()]), REQUEST_ALL_PERMS);
                } else {
                        // Нечего запрашивать через диалог — сразу к доступу к файлам (Android 11+)
                        requestAllFilesAccess();
                }
        }

        public void runJs(final String js) {
                runOnUiThread(new Runnable() {
                                @Override
                                public void run() {
                                        if (Build.VERSION.SDK_INT >= 19) {
                                                uiWebView.evaluateJavascript(js, null);
                                        } else {
                                                uiWebView.loadUrl("javascript:" + js);
                                        }
                                }
                        });
        }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent); // ВАЖНО: сохраняем новый интент, иначе Android будет подсовывать старый!
    handleIntent(intent);
    }

        private void handleIntent(Intent intent) {
        if (intent == null) return;

        // ==========================================
        // 1. ЛОГИКА ПЕРЕХВАТА КЛИКА ИЗ ВИДЖЕТА
            // ==========================================
            String illustIdFromWidget = intent.getStringExtra("widget_target_illust_id");
        if (illustIdFromWidget != null && !illustIdFromWidget.isEmpty()) {
            openIllustWhenReady(illustIdFromWidget);
            return; // Завершаем выполнение, чтобы не сработала логика браузера
        }

            // ==========================================
            // 2. СТАРАЯ ЛОГИКА (ССЫЛКИ ИЗ БРАУЗЕРА И "ПОДЕЛИТЬСЯ")
                // ==========================================
            String action = intent.getAction();
        String type = intent.getType();
    String urlToProcess = null;

    if (Intent.ACTION_VIEW.equals(action)) {
    Uri data = intent.getData();
        if (data != null) { urlToProcess = data.toString(); }
            } else if (Intent.ACTION_SEND.equals(action) && "text/plain".equals(type)) {
            String sharedText = intent.getStringExtra(Intent.EXTRA_TEXT);
            if (sharedText != null) { urlToProcess = sharedText; }
            }

        if (urlToProcess != null) {
        final String id = extractIllustId(urlToProcess);
            if (id != null && !id.isEmpty()) {
                    openIllustWhenReady(id);
                    }
                        }
                    }

        // Открывает работу по ID, дожидаясь готовности веб-интерфейса.
        // При холодном старте по ссылке app.js может ещё догружаться к моменту
        // вызова — поэтому внутри WebView крутим короткий цикл ожидания openDetails
        // (до ~12 c), иначе переход бы потерялся.
        private void openIllustWhenReady(final String id) {
                if (id == null || id.isEmpty()) return;
                final String safe = id.replace("\\", "").replace("'", "");
                String js = "(function(){var n=60;function go(){"
                        + "if(typeof openDetails==='function'){openDetails('" + safe + "');}"
                        + "else if(n-->0){setTimeout(go,200);}}go();})();";
                runJs(js);
        }

        @Override
        protected void onPause() {
                super.onPause();
                // Страховка: гарантируем запись куки (в т.ч. настроек R-18) на диск при сворачивании,
                // чтобы система не потеряла их при выгрузке процесса из памяти
                if (Build.VERSION.SDK_INT >= 21) {
                        try { android.webkit.CookieManager.getInstance().flush(); } catch (Exception e) {}
                }
        }

        @Override
        public void onBackPressed() {
                if (authWebView != null && authWebView.getVisibility() == View.VISIBLE) {
                        authWebView.stopLoading();
                        authWebView.setVisibility(View.GONE);
                        authWebView.loadUrl("about:blank");
                        hideAuthLoader();
                        // Вход отменён — возвращаем куки текущего аккаунта, стёртые в startPixivLogin
                        restoreActiveAccountCookies();
                        updateUIStatus("Вход отменен");
                        return;
                }

                if (Build.VERSION.SDK_INT >= 19) {
                        uiWebView.evaluateJavascript("handleBackPress()", new ValueCallback<String>() {
                                        @Override
                                        public void onReceiveValue(String value) {
                                                if ("false".equals(value)) { finish(); }
                                        }
                                });
                } else {
                        finish(); 
                }
        }

        @Override
        public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
                if (requestCode == REQUEST_WRITE_STORAGE) {
                        if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                                updateUIStatus("Разрешения получены!");
                                runJs("if (document.getElementById('page-manager').classList.contains('active')) { Android.requestStorageInfo(); }");
                        } else {
                                updateUIStatus("Отказано в доступе к памяти.");
                        }
                } else if (requestCode == REQUEST_ALL_PERMS) {
                        // Стартовый запрос всех разрешений: считаем, сколько выдано
                        int granted = 0;
                        for (int r : grantResults) {
                                if (r == PackageManager.PERMISSION_GRANTED) granted++;
                        }
                        if (grantResults.length == 0 || granted == grantResults.length) {
                                updateUIStatus("Разрешения получены!");
                        } else {
                                updateUIStatus("Часть разрешений не выдана.");
                        }
                        // Теперь, когда диалог runtime-разрешений закрыт, просим «Доступ ко всем файлам» (Android 11+)
                        requestAllFilesAccess();
                }
        }

        public class WebAppInterface {
                // Открывает системный экран «Открывать по умолчанию / Open by default»
                // для нашего приложения. На Android 12+ ссылки на чужой домен (pixiv.net)
                // нельзя верифицировать, поэтому пользователь должен один раз вручную
                // разрешить «Открывать поддерживаемые ссылки». На HyperOS этот пункт
                // спрятан — поэтому уводим туда напрямую из приложения.
                // Возвращает состояние перехвата ссылок:
                //   "ok"       — Android < 12 (там диалог выбора работает сам);
                //   "enabled"  — пользователь уже разрешил открывать pixiv.net в приложении;
                //   "disabled" — фильтры есть, но разрешение не выдано (ссылки идут в браузер);
                //   "unknown"  — определить не удалось.
                // Используем рефлексию над DomainVerificationManager (API 31+), чтобы код
                // компилировался независимо от выставленного compileSdk.
                @JavascriptInterface
                public String getLinkHandlingState() {
                        if (Build.VERSION.SDK_INT < 31) return "ok";
                        try {
                                Class<?> dvmCls = Class.forName("android.content.pm.verify.domain.DomainVerificationManager");
                                Object dvm = getSystemService(dvmCls);
                                if (dvm == null) return "unknown";
                                Object userState = dvmCls.getMethod("getDomainVerificationUserState", String.class)
                                        .invoke(dvm, getPackageName());
                                if (userState == null) return "unknown";
                                Object mapObj = userState.getClass().getMethod("getHostToStateMap").invoke(userState);
                                if (!(mapObj instanceof java.util.Map)) return "unknown";
                                java.util.Map<?, ?> map = (java.util.Map<?, ?>) mapObj;
                                // DOMAIN_STATE_NONE=0, DOMAIN_STATE_SELECTED=1, DOMAIN_STATE_VERIFIED=2
                                for (Object v : map.values()) {
                                        if (v instanceof Integer && ((Integer) v) >= 1) return "enabled";
                                }
                                return "disabled";
                        } catch (Throwable t) {
                                return "unknown";
                        }
                }

                @JavascriptInterface
                public void openLinkDefaultsSettings() {
                        runOnUiThread(new Runnable() {
                                @Override
                                public void run() {
                                        Uri pkg = Uri.parse("package:" + getPackageName());
                                        // 1. Прямой экран «Open by default» (Android 12+, API 31)
                                        if (Build.VERSION.SDK_INT >= 31) {
                                                try {
                                                        Intent i = new Intent(Settings.ACTION_APP_OPEN_BY_DEFAULT_SETTINGS, pkg);
                                                        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                                                        startActivity(i);
                                                        return;
                                                } catch (Exception ignored) {}
                                        }
                                        // 2. Фолбэк — обычная страница «О приложении», оттуда есть «Открывать по умолчанию»
                                        try {
                                                Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg);
                                                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                                                startActivity(i);
                                        } catch (Exception e) {
                                                Toast.makeText(MainActivity.this,
                                                        "Не удалось открыть настройки. Откройте их вручную: О приложении → Открывать по умолчанию.",
                                                        Toast.LENGTH_LONG).show();
                                        }
                                }
                        });
                }

                @JavascriptInterface
                public float getStatusBarHeightPx() {
                        int result = 0;
                        int resourceId = getResources().getIdentifier("status_bar_height", "dimen", "android");
                        if (resourceId > 0) result = getResources().getDimensionPixelSize(resourceId);
                        return result / getResources().getDisplayMetrics().density;
                }

                @JavascriptInterface
                public int getNativeVersion() {
                        return NATIVE_APP_VERSION;
                }

                // Зеркалит текущую веб-версию (хотфикс) в SharedPreferences,
                // чтобы фоновый UpdateCheckReceiver мог сравнивать её с сервером.
                @JavascriptInterface
                public void setLocalWebVersion(final int version) {
                        try {
                                getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                                        .edit().putInt("local_web_version", version).apply();
                        } catch (Exception ignored) {}
                }

                @JavascriptInterface
                public void downloadAndInstallApk(final String urlStr) {
                        // Вызываем наш отдельный скрипт!
                        new ApkUpdater(MainActivity.this).downloadAndInstall(urlStr);
                }
                
                @JavascriptInterface
                public void getDiscovery(final String nextUrl, final String ageFilter) {
                        runOnUiThread(new Runnable() {
                                        @Override public void run() { startDiscovery(nextUrl, ageFilter); }
                                });
                }

                @JavascriptInterface
                public void getHomeStrip(final String kind) {
                        runOnUiThread(new Runnable() {
                                        @Override public void run() { startHomeStrip(kind); }
                                });
                }

                @JavascriptInterface
                public void resetDiscovery() {
                        clearDiscoveryState();
                }

                // ====== Экспериментальные: Telegram (Bot API) ======
                @JavascriptInterface
                public void tgQueryState() { getTgManager().queryState(); }

                @JavascriptInterface
                public void tgSetToken(final String token) { getTgManager().setToken(token); }

                @JavascriptInterface
                public void tgListChannels() { getTgManager().listChannels(); }

                @JavascriptInterface
                public void tgAddChat(final String ref) { getTgManager().addChat(ref); }

                @JavascriptInterface
                public void tgLogout() { getTgManager().logout(); }

                // Отправить все изображения работы в выбранный чат через бота.
                // urlsJson — JSON-массив URL оригиналов; caption уйдёт только на первое фото.
                @JavascriptInterface
                public void tgShareImages(final String chatId, final String urlsJson, final String caption, final String parseMode) {
                        shareIllustToTelegram(chatId, urlsJson, caption, parseMode);
                }

                @JavascriptInterface
                public void fetchBrowse(final int page, final String query) {
                        runOnUiThread(new Runnable() {
                                @Override public void run() { startBrowseFetch(page, query); }
                        });
                }

                @JavascriptInterface
                public void fetchBrowseDetail(final String id) {
                        runOnUiThread(new Runnable() {
                                @Override public void run() { startBrowseDetailFetch(id); }
                        });
                }

                @JavascriptInterface
                public void fetchBrowseEpisodeSources(final String episodeId) {
                        runOnUiThread(new Runnable() {
                                @Override public void run() { startBrowseEpisodeFetch(episodeId); }
                        });
                }
        
        @JavascriptInterface
        public void requestSavedAccounts() {
            runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
                        String json = prefs.getString("saved_accounts_list", "[]");
                        runJs("displaySavedAccounts('" + Base64.encodeToString(json.getBytes(), Base64.NO_WRAP) + "');");
                    }
                });
        }
        
        @JavascriptInterface
        public void onAccountSwitched(final String newAccId) {
            runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        uiWebView.evaluateJavascript("finishAccountSwitch('" + newAccId + "')", null);
                    }
                });
        }

        @JavascriptInterface
        public void switchAccount(final String targetId) {
            runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);

                        String currentId = prefs.getString(KEY_USER_ID, "");
                        String currentName = prefs.getString(KEY_USER_NAME, "");
                        String currentAvatar = prefs.getString(KEY_USER_AVATAR, "");
                        saveAccountToCache(currentId, currentName, currentAvatar);

                        String json = prefs.getString("saved_accounts_list", "[]");
                        try {
                            JSONArray arr = new JSONArray(json);
                            for (int i = 0; i < arr.length(); i++) {
                                JSONObject obj = arr.getJSONObject(i);
                                if (obj.optString("id").equals(targetId)) {
                                    String tAccess = obj.optString("access_token", "");
                                    String tRefresh = obj.optString("refresh_token", "");
                                    // Если сессия повреждена (нет токенов) — переключение бессмысленно,
                                    // сообщаем пользователю вместо молчаливого зависания
                                    if (tRefresh.isEmpty() && tAccess.isEmpty()) {
                                        updateUIStatus("Сессия повреждена. Войдите в этот аккаунт заново.");
                                        runJs("showToast('Сессия устарела — войдите заново');");
                                        runJs("unlockAccountSwitch();");
                                        break;
                                    }
                                    prefs.edit()
                                        .putString(KEY_USER_ID, targetId)
                                        .putString(KEY_USER_NAME, obj.optString("name"))
                                        .putString(KEY_USER_AVATAR, obj.optString("avatar"))
                                        .putString(KEY_ACCESS_TOKEN, obj.optString("access_token"))
                                        .putString(KEY_REFRESH_TOKEN, obj.optString("refresh_token"))
                                        .apply();

                                    // 2. Работа с куки
                                    String savedCookie = obj.optString("cookie", "");
                                    android.webkit.CookieManager cookieManager = android.webkit.CookieManager.getInstance();

                                    // Жесткая очистка старых куки перед инъекцией новых
                                    if (Build.VERSION.SDK_INT >= 21) {
                                        cookieManager.removeAllCookies(null);
                                        } else {
                                            cookieManager.removeAllCookie();
                                            }

                                                if (!savedCookie.isEmpty()) {
                                                String[] cookies = savedCookie.split(";");
                                            for (String c : cookies) {
                                        String clean = c.trim();
                                        if (!clean.isEmpty()) {
                                    // Вкалываем куки во все зеркала, чтобы WebView нигде не попросил логин
                                    cookieManager.setCookie("https://pixiv.net", clean);
                                    cookieManager.setCookie("https://www.pixiv.net", clean);
                                    cookieManager.setCookie("https://secure.pixiv.net", clean);
                                    cookieManager.setCookie("https://accounts.pixiv.net", clean);
                                    cookieManager.setCookie("https://app-api.pixiv.net", clean);
                                }
                            }
                        // Снова заставляем WebView "проглотить" изменения немедленно
                            if (Build.VERSION.SDK_INT >= 21) {
                        cookieManager.flush();
                    }
                }

                                    updateUIStatus("Аккаунт изменён...");
                                    loadSavedUserAndRefreshTokenIfPossible();
                                    onAccountSwitched(targetId);
                                    break;
                                }
                            }
                        } catch (Exception e) {
                            e.printStackTrace();
                        }
                    }   // ← закрываем run()
                });     // ← закрываем Runnable и runOnUiThread
        }           // ← закрываем метод switchAccount

        // Удаляет конкретную сохранённую сессию из "сейфа" (не активную). Активный аккаунт
        // удаляется через performLogout(); здесь — выход из дополнительной сохранённой сессии.
        @JavascriptInterface
        public void removeSavedAccount(final String targetId) {
            runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if (targetId == null || targetId.isEmpty()) return;
                        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
                        String json = prefs.getString("saved_accounts_list", "[]");
                        try {
                            JSONArray arr = new JSONArray(json);
                            JSONArray newArr = new JSONArray();
                            for (int i = 0; i < arr.length(); i++) {
                                JSONObject obj = arr.optJSONObject(i);
                                if (obj != null && !obj.optString("id").equals(targetId)) {
                                    newArr.put(obj);
                                }
                            }
                            prefs.edit().putString("saved_accounts_list", newArr.toString()).apply();
                            updateUIStatus("Сессия удалена.");
                            runJs("showToast('Аккаунт удалён из списка');");
                            // Обновляем список сохранённых сессий в UI
                            requestSavedAccounts();
                        } catch (Exception e) {
                            e.printStackTrace();
                        }
                    }
                });
        }


                @JavascriptInterface
                public void checkUpdateJson(final String urlStr) {
                        new Thread(new Runnable() {
                                        public void run() {
                                                HttpURLConnection conn = null;
                                                try {
                                                        URL url = new URL(urlStr);
                                                        conn = (HttpURLConnection) url.openConnection();
                                                        conn.setRequestMethod("GET");
                                                        conn.setUseCaches(false);
                                                        conn.setConnectTimeout(10000);
                                                        conn.setReadTimeout(10000);

                                                        if (conn.getResponseCode() >= 200 && conn.getResponseCode() < 300) {
                                                                BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream()));
                                                                StringBuilder res = new StringBuilder();
                                                                String line;
                                                                while ((line = reader.readLine()) != null) res.append(line);
                                                                reader.close();

                                                                // Кодируем в Base64, чтобы JS не подавился спецсимволами
                                                                final String b64 = Base64.encodeToString(res.toString().getBytes("UTF-8"), Base64.NO_WRAP);
                                                                runOnUiThread(new Runnable() {
                                                                                @Override
                                                                                public void run() {
                                                                                        uiWebView.evaluateJavascript("processUpdateJson('" + b64 + "')", null);
                                                                                }
                                                                        });
                                                        }
                                                } catch (Exception e) {
                                                        e.printStackTrace();
                                                } finally {
                                                        if (conn != null) conn.disconnect();
                                                }
                                        }
                                }).start();
                }

                @JavascriptInterface public void login() { runOnUiThread(new Runnable() { @Override public void run() { startPixivLogin(); }}); }
                @JavascriptInterface public void checkAccount() { runOnUiThread(new Runnable() { @Override public void run() { checkPixivAccount(); }}); }
                @JavascriptInterface public void updateToken() { runOnUiThread(new Runnable() { @Override public void run() { refreshAccessTokenManually(); }}); }
                @JavascriptInterface public void preview(final String link) { runOnUiThread(new Runnable() { @Override public void run() { startAutoPreviewFromInput(link); }}); }
                @JavascriptInterface public void logout() { runOnUiThread(new Runnable() { @Override public void run() { performLogout(); }}); }


                @JavascriptInterface public void getIllustDetails(final String id) { 
                        runOnUiThread(new Runnable() { @Override public void run() { startGetDetails(id); }}); 
                }
                @JavascriptInterface 
                public void getRelatedIllusts(final String illustId, final String nextUrl) {
                        runOnUiThread(new Runnable() {
                                        @Override
                                        public void run() {
                                                SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
                                                String accessToken = prefs.getString(KEY_ACCESS_TOKEN, null);
                                                if (accessToken == null || accessToken.length() == 0) return;
                                                String baseUrl = "https://app-api.pixiv.net/v2/illust/related?illust_id=" + illustId;
                                                new ListTask("displayRelatedIllusts", "all", false, "")
                                                        .executeOnExecutor(AsyncTask.THREAD_POOL_EXECUTOR, accessToken, baseUrl, nextUrl);
                                        }
                                });
                }

                // === КОММЕНТАРИИ: получение списка (GET) ===
                @JavascriptInterface
                public void getIllustComments(final String illustId, final String nextUrl) {
                        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
                        final String accessToken = prefs.getString(KEY_ACCESS_TOKEN, null);
                        if (accessToken == null || accessToken.length() == 0) return;
                        new Thread(new Runnable() {
                                        @Override
                                        public void run() {
                                                HttpURLConnection conn = null;
                                                try {
                                                        String urlStr = (nextUrl != null && nextUrl.startsWith("http"))
                                                                ? nextUrl
                                                                : "https://app-api.pixiv.net/v3/illust/comments?illust_id=" + illustId;
                                                        URL url = new URL(urlStr);
                                                        conn = (HttpURLConnection) url.openConnection();
                                                        conn.setRequestMethod("GET");
                                                        conn.setRequestProperty("Authorization", "Bearer " + accessToken);
                                                        addPixivApiHeaders(conn);
                                                        conn.setConnectTimeout(10000);
                                                        conn.setReadTimeout(10000);
                                                        conn.setUseCaches(false);

                                                        int code = conn.getResponseCode();
                                                        if (code >= 200 && code < 300) {
                                                                BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream(), "UTF-8"));
                                                                StringBuilder res = new StringBuilder();
                                                                String line;
                                                                while ((line = reader.readLine()) != null) res.append(line);
                                                                reader.close();

                                                                JSONObject root = new JSONObject(res.toString());
                                                                JSONArray rawComments = root.optJSONArray("comments");
                                                                JSONArray out = new JSONArray();
                                                                if (rawComments != null) {
                                                                        for (int i = 0; i < rawComments.length(); i++) {
                                                                                JSONObject c = rawComments.getJSONObject(i);
                                                                                JSONObject user = c.optJSONObject("user");
                                                                                JSONObject item = new JSONObject();
                                                                                item.put("comment", c.optString("comment", ""));
                                                                                item.put("date", c.optString("date", ""));
                                                                                if (user != null) {
                                                                                        item.put("user_name", user.optString("name", ""));
                                                                                        item.put("user_id", user.optString("id", ""));
                                                                                }
                                                                                JSONObject stamp = c.optJSONObject("stamp");
                                                                                if (stamp != null) {
                                                                                        item.put("stamp_url", stamp.optString("stamp_url", ""));
                                                                                }
                                                                                item.put("has_replies", c.optBoolean("has_replies", false));
                                                                                out.put(item);
                                                                        }
                                                                }
                                                                // next_url может прийти как JSON null — optString тогда вернёт строку "null",
                                                                // из-за чего следующий запрос падает с "no protocol: null". Нормализуем в "".
                                                                String commentsNextUrl = root.isNull("next_url") ? "" : root.optString("next_url", "");
                                                                if (commentsNextUrl.equals("null")) commentsNextUrl = "";
                                                                JSONObject result = new JSONObject();
                                                                result.put("comments", out);
                                                                result.put("next_url", commentsNextUrl);
                                                                final String b64 = Base64.encodeToString(result.toString().getBytes("UTF-8"), Base64.NO_WRAP);
                                                                runJs("displayIllustComments('" + b64 + "');");
                                                        } else {
                                                                // Не-2xx — читаем тело ошибки и передаём в UI для диагностики
                                                                StringBuilder errBody = new StringBuilder();
                                                                try {
                                                                        java.io.InputStream es = conn.getErrorStream();
                                                                        if (es != null) {
                                                                                BufferedReader er = new BufferedReader(new InputStreamReader(es, "UTF-8"));
                                                                                String l;
                                                                                while ((l = er.readLine()) != null) errBody.append(l);
                                                                                er.close();
                                                                        }
                                                                } catch (Exception ignored) {}
                                                                JSONObject result = new JSONObject();
                                                                result.put("comments", new JSONArray());
                                                                result.put("next_url", "");
                                                                result.put("error", "HTTP " + code);
                                                                result.put("error_body", errBody.toString());
                                                                result.put("error_url", urlStr);
                                                                final String b64 = Base64.encodeToString(result.toString().getBytes("UTF-8"), Base64.NO_WRAP);
                                                                runJs("displayIllustComments('" + b64 + "');");
                                                        }
                                                } catch (Exception e) {
                                                        try {
                                                                JSONObject result = new JSONObject();
                                                                result.put("comments", new JSONArray());
                                                                result.put("next_url", "");
                                                                result.put("error", "EXCEPTION");
                                                                result.put("error_body", String.valueOf(e.getMessage()));
                                                                String s = Base64.encodeToString(result.toString().getBytes("UTF-8"), Base64.NO_WRAP);
                                                                runJs("displayIllustComments('" + s + "');");
                                                        } catch (Exception ignored) {}
                                                } finally {
                                                        if (conn != null) try { conn.disconnect(); } catch (Exception ignored) {}
                                                }
                                        }
                                }).start();
                }

                // === КОММЕНТАРИИ: отправка (POST) ===
                @JavascriptInterface
                public void postIllustComment(final String illustId, final String comment) {
                        new Thread(new Runnable() {
                                        @Override
                                        public void run() {
                                                HttpURLConnection conn = null;
                                                try {
                                                        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
                                                        String token = prefs.getString(KEY_ACCESS_TOKEN, null);
                                                        if (token == null) { runJs("onCommentFailed();"); return; }

                                                        URL url = new URL("https://app-api.pixiv.net/v1/illust/comment/add");
                                                        conn = (HttpURLConnection) url.openConnection();
                                                        conn.setRequestMethod("POST");
                                                        conn.setRequestProperty("Authorization", "Bearer " + token);
                                                        conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
                                                        addPixivApiHeaders(conn);
                                                        conn.setDoOutput(true);

                                                        String body = "illust_id=" + illustId + "&comment=" + URLEncoder.encode(comment, "UTF-8");
                                                        OutputStream os = conn.getOutputStream();
                                                        os.write(body.getBytes("UTF-8"));
                                                        os.flush();
                                                        os.close();

                                                        int code = conn.getResponseCode();
                                                        if (code >= 200 && code < 300) {
                                                                runJs("onCommentPosted();");
                                                        } else {
                                                                runJs("onCommentFailed();");
                                                        }
                                                } catch (Exception e) {
                                                        runJs("onCommentFailed();");
                                                } finally {
                                                        if (conn != null) try { conn.disconnect(); } catch (Exception ignored) {}
                                                }
                                        }
                                }).start();
                }

                @JavascriptInterface public void getAuthorIllusts(final String userId, final String nextUrl) {
                        runOnUiThread(new Runnable() { @Override public void run() { startAuthorIllusts(userId, nextUrl); }}); 
                }
                @JavascriptInterface public void getOwnIllusts(final String nextUrl) {
                        runOnUiThread(new Runnable() {
                                        @Override
                                        public void run() {
                                                SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
                                                String accessToken = prefs.getString(KEY_ACCESS_TOKEN, null);
                                                String userId = prefs.getString(KEY_USER_ID, null);
                                                if (accessToken != null && userId != null) {
                                                        new AuthorTask(true).executeOnExecutor(AsyncTask.THREAD_POOL_EXECUTOR, accessToken, userId, nextUrl); 
                                                }
                                        }
                                });
                }
                @JavascriptInterface public void search(final String query, final String nextUrl, final String ageFilter, final boolean hideAi, final String excludeTag) { 
                        runOnUiThread(new Runnable() { @Override public void run() { startSearch(query, nextUrl, ageFilter, hideAi, excludeTag); }}); 
                }

                @JavascriptInterface public void getRecommended(final String nextUrl, final String ageFilter, final boolean hideAi, final String excludeTag) {
                        runOnUiThread(new Runnable() { @Override public void run() { startRecommended(nextUrl, ageFilter, hideAi, excludeTag); }});
                }
                @JavascriptInterface public void getBookmarks(final String nextUrl) {
                        runOnUiThread(new Runnable() { @Override public void run() { startBookmarks(nextUrl); }});
                }
                @JavascriptInterface public void toggleBookmark(final String illustId, final boolean isAdd) {
                        runOnUiThread(new Runnable() { @Override public void run() { startToggleBookmark(illustId, isAdd); }});
                }
                @JavascriptInterface public boolean hasDownloadedFiles(final String input) {
                        if (!hasStoragePermission()) return false;
                        String illustId = extractIllustId(input);
                        if (illustId == null || illustId.length() == 0) return false;
                        File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "PixivDL/" + illustId);
                        return dir.exists() && dir.isDirectory() && dir.list() != null && dir.list().length > 0;
                }

                @JavascriptInterface public void download(final String link) { runOnUiThread(new Runnable() { @Override public void run() { startDownloadFromInput(link, "", "", -1); }}); }

                @JavascriptInterface public void downloadWithMeta(final String link, final String title, final String thumb) { 
                        runOnUiThread(new Runnable() { @Override public void run() { startDownloadFromInput(link, title, thumb, -1); }}); 
                }

                @JavascriptInterface
                public void getFollowing(final String nextUrl) {
                        runOnUiThread(new Runnable() {
                                        @Override
                                        public void run() {
                                                SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
                                                String accessToken = prefs.getString(KEY_ACCESS_TOKEN, null);
                                                String userId = prefs.getString(KEY_USER_ID, null);
                                                if (accessToken != null && userId != null) {
                                                        new FollowingTask().executeOnExecutor(AsyncTask.THREAD_POOL_EXECUTOR, accessToken, userId, nextUrl);
                                                }
                                        }
                                });
                }

                @JavascriptInterface
                public void toggleUserFollow(final String userId, final boolean follow) {
                        new Thread(new Runnable() {
                                        @Override
                                        public void run() {
                                                try {
                                                        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
                                                        String token = prefs.getString(KEY_ACCESS_TOKEN, null);
                                                        if (token == null) return;

                                                        String urlStr = follow ? "https://app-api.pixiv.net/v1/user/follow/add" : "https://app-api.pixiv.net/v1/user/follow/delete";
                                                        URL url = new URL(urlStr);
                                                        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                                                        conn.setRequestMethod("POST");
                                                        conn.setRequestProperty("Authorization", "Bearer " + token);
                                                        conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
                                                        addPixivApiHeaders(conn);
                                                        conn.setDoOutput(true);

                                                        String body = "user_id=" + userId + "&restrict=public";
                                                        OutputStream os = conn.getOutputStream();
                                                        os.write(body.getBytes("UTF-8"));
                                                        os.flush(); os.close();

                                                        conn.getResponseCode(); 
                                                } catch (Exception ignored) {}
                                        }
                                }).start();
                }

                @JavascriptInterface public void downloadPage(final String link, final int pageIndex, final String title, final String thumb, final String originalUrl) { 
                        runOnUiThread(new Runnable() { @Override public void run() { startDownloadFromInput(link, title, thumb, pageIndex, originalUrl); }}); 
                }

                @JavascriptInterface
                public void pauseDownload(final String id) {
                        IllustDownloadTask task = activeDownloads.get(id);
                        if (task != null) { task.cancel(true); activeDownloads.remove(id); }
                }

                @JavascriptInterface
                public void abortDownload(final String id) {
                        IllustDownloadTask task = activeDownloads.get(id);
                        if (task != null) { task.cancel(true); activeDownloads.remove(id); }
                        new Thread(new Runnable() {
                                        @Override
                                        public void run() {
                                                try { Thread.sleep(500); } catch (Exception e) {} 
                                                if (!id.contains("_p")) { deleteIllustFolder(id); }
                                                requestStorageInfo();
                                        }
                                }).start();
                }

                @JavascriptInterface
                public void getOfflineDetails() {
                        new Thread(new Runnable() {
                                        public void run() {
                                                try {
                                                        File dir = new File(getExternalFilesDir(null), "OfflineCache");
                                                        File[] files = dir.exists() ? dir.listFiles() : new File[0];
                                                        int count = 0;
                                                        JSONArray imagesArray = new JSONArray();

                                                        for (File f : files) {
                                                                if (!f.getName().equals(".nomedia")) {
                                                                        count++;
                                                                        imagesArray.put("https://offline-cache/" + f.getName());
                                                                }
                                                        }

                                                        JSONObject result = new JSONObject();
                                                        result.put("id", "offline_cache");
                                                        result.put("title", "Оффлайн Радио (" + count + " артов)");
                                                        result.put("author", "Локальная папка");
                                                        result.put("author_id", "");
                                                        result.put("is_bookmarked", false);
                                                        result.put("is_ai", false);
                                                        result.put("view_count", 0);
                                                        result.put("bookmark_count", 0);
                                                        result.put("create_date", "Доступно без сети");
                                                        result.put("author_avatar", "");
                                                        result.put("tags", new JSONArray());
                                                        result.put("images", imagesArray);
                                                        result.put("original_images", imagesArray);

                                                        String b64 = Base64.encodeToString(result.toString().getBytes("UTF-8"), Base64.NO_WRAP);
                                                        runJs("displayIllustDetails('" + b64 + "');");
                                                } catch (Exception e) {}
                                        }
                                }).start();
                }

                @JavascriptInterface
                public void deleteDownloadedFolder(final String id) {
                        new Thread(new Runnable() {
                                        public void run() { 
                                                if (id.equals("offline_cache")) {
                                                        File dir = new File(getExternalFilesDir(null), "OfflineCache");
                                                        if (dir.exists()) deleteRecursive(dir);
                                                } else {
                                                        deleteIllustFolder(id); 
                                                }
                                                requestStorageInfo(); 
                                        }
                                }).start();
                }

                @JavascriptInterface
                public void resumeDownload(final String id) {
                        new Thread(new Runnable() {
                                        @Override
                                        public void run() {
                                                String realId = id;
                                                int page = -1;
                                                if (id.contains("_p")) {
                                                        String[] p = id.split("_p");
                                                        realId = p[0];
                                                        try { page = Integer.parseInt(p[1]); } catch(Exception e){}
                                                }
                                                File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "PixivDL/" + realId);
                                                if (dir.exists() && dir.isDirectory()) {
                                                        File[] files = dir.listFiles();
                                                        if (files != null && files.length > 0) {
                                                                File lastModified = files[0];
                                                                for (File f : files) { if (f.lastModified() > lastModified.lastModified()) lastModified = f; }
                                                                if (lastModified.exists()) lastModified.delete();
                                                        }
                                                }
                                                final String fId = realId;
                                                final int fPage = page;
                                                runOnUiThread(new Runnable() {
                                                                @Override
                                                                public void run() { startDownloadFromInput(fId, "", "", fPage); }
                                                        });
                                        }
                                }).start();
                }

                // ==========================================
                // РЕЗЕРВНОЕ КОПИРОВАНИЕ / ВОССТАНОВЛЕНИЕ ДАННЫХ
                // Файл лежит в публичной папке Downloads/PixivDL_Backup (вне каталога
                // приложения), поэтому переживает полную переустановку. Оффлайн-подборка
                // (OfflineCache) сюда намеренно НЕ входит.
                // ==========================================

                @JavascriptInterface
                public void backupData(final String localStorageJson) {
                        runOnUiThread(new Runnable() {
                                @Override
                                public void run() {
                                        if (!hasStoragePermission()) {
                                                requestStoragePermission();
                                                runJs("setBackupStatus('Нужен доступ к памяти — повторите');");
                                                runJs("showToast('Дайте доступ к памяти и повторите');");
                                                return;
                                        }

                                        // Сбрасываем свежие куки активного аккаунта в saved_accounts_list,
                                        // чтобы текущая сессия точно попала в бэкап.
                                        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
                                        String currentId = prefs.getString(KEY_USER_ID, "");
                                        if (currentId != null && !currentId.isEmpty()) {
                                                try {
                                                        saveAccountToCache(currentId,
                                                                prefs.getString(KEY_USER_NAME, ""),
                                                                prefs.getString(KEY_USER_AVATAR, ""));
                                                } catch (Exception ignored) {}
                                        }

                                        new Thread(new Runnable() {
                                                @Override
                                                public void run() {
                                                        FileOutputStream fos = null;
                                                        try {
                                                                SharedPreferences p = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
                                                                JSONObject root = new JSONObject();
                                                                root.put("schema", 1);

                                                                // 1. SharedPreferences (токены, список аккаунтов, настройки)
                                                                JSONObject prefsObj = new JSONObject();
                                                                Map<String, ?> all = p.getAll();
                                                                for (Map.Entry<String, ?> e : all.entrySet()) {
                                                                        Object v = e.getValue();
                                                                        JSONObject cell = new JSONObject();
                                                                        if (v instanceof Boolean) { cell.put("t", "b"); cell.put("v", (Boolean) v); }
                                                                        else if (v instanceof Integer) { cell.put("t", "i"); cell.put("v", (Integer) v); }
                                                                        else if (v instanceof Long) { cell.put("t", "l"); cell.put("v", (Long) v); }
                                                                        else if (v instanceof Float) { cell.put("t", "f"); cell.put("v", (double) (Float) v); }
                                                                        else { cell.put("t", "s"); cell.put("v", String.valueOf(v)); }
                                                                        prefsObj.put(e.getKey(), cell);
                                                                }
                                                                root.put("prefs", prefsObj);

                                                                // 2. Живые куки активного аккаунта (доп. подстраховка)
                                                                android.webkit.CookieManager cm = android.webkit.CookieManager.getInstance();
                                                                JSONObject cookies = new JSONObject();
                                                                cookies.put("www", safeStr(cm.getCookie("https://www.pixiv.net")));
                                                                cookies.put("net", safeStr(cm.getCookie("https://pixiv.net")));
                                                                cookies.put("secure", safeStr(cm.getCookie("https://secure.pixiv.net")));
                                                                cookies.put("accounts", safeStr(cm.getCookie("https://accounts.pixiv.net")));
                                                                cookies.put("appapi", safeStr(cm.getCookie("https://app-api.pixiv.net")));
                                                                root.put("cookies", cookies);

                                                                // 3. localStorage (история поиска/просмотра, избранное, тема, меню)
                                                                String lsJson = (localStorageJson == null || localStorageJson.isEmpty()) ? "{}" : localStorageJson;
                                                                root.put("localStorage", new JSONObject(lsJson));

                                                                File f = getBackupFile();
                                                                File parent = f.getParentFile();
                                                                if (parent != null) parent.mkdirs();
                                                                fos = new FileOutputStream(f);
                                                                fos.write(root.toString().getBytes("UTF-8"));
                                                                fos.flush();

                                                                runJs("setBackupStatus('Сохранено во внешнюю память');");
                                                                runJs("showToast('Данные сохранены');");
                                                        } catch (Exception ex) {
                                                                ex.printStackTrace();
                                                                String msg = "Ошибка: " + ex.getClass().getSimpleName() + ": " + safeStr(ex.getMessage());
                                                                try {
                                                                        runJs("setBackupStatusB64('" + Base64.encodeToString(msg.getBytes("UTF-8"), Base64.NO_WRAP) + "');");
                                                                } catch (Exception ignored) {
                                                                        runJs("setBackupStatus('Ошибка сохранения');");
                                                                }
                                                                runJs("showToast('Ошибка сохранения');");
                                                        } finally {
                                                                if (fos != null) { try { fos.close(); } catch (Exception ignored) {} }
                                                        }
                                                }
                                        }).start();
                                }
                        });
                }

                @JavascriptInterface
                public void restoreData() {
                        runOnUiThread(new Runnable() {
                                @Override
                                public void run() {
                                        if (!hasStoragePermission()) {
                                                requestStoragePermission();
                                                runJs("showToast('Дайте доступ к памяти и повторите');");
                                                return;
                                        }

                                        new Thread(new Runnable() {
                                                @Override
                                                public void run() {
                                                        try {
                                                                File f = getBackupFile();
                                                                if (!f.exists()) {
                                                                        runJs("showToast('Резервная копия не найдена');");
                                                                        return;
                                                                }

                                                                StringBuilder sb = new StringBuilder();
                                                                BufferedReader br = new BufferedReader(new InputStreamReader(new java.io.FileInputStream(f), "UTF-8"));
                                                                String line;
                                                                while ((line = br.readLine()) != null) sb.append(line);
                                                                br.close();

                                                                JSONObject root = new JSONObject(sb.toString());

                                                                // 1. Восстанавливаем SharedPreferences с сохранением типов
                                                                SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
                                                                SharedPreferences.Editor ed = prefs.edit();
                                                                JSONObject prefsObj = root.optJSONObject("prefs");
                                                                if (prefsObj != null) {
                                                                        java.util.Iterator<String> keys = prefsObj.keys();
                                                                        while (keys.hasNext()) {
                                                                                String k = keys.next();
                                                                                JSONObject cell = prefsObj.optJSONObject(k);
                                                                                if (cell == null) continue;
                                                                                String t = cell.optString("t", "s");
                                                                                if ("b".equals(t)) ed.putBoolean(k, cell.optBoolean("v"));
                                                                                else if ("i".equals(t)) ed.putInt(k, cell.optInt("v"));
                                                                                else if ("l".equals(t)) ed.putLong(k, cell.optLong("v"));
                                                                                else if ("f".equals(t)) ed.putFloat(k, (float) cell.optDouble("v"));
                                                                                else ed.putString(k, cell.optString("v"));
                                                                        }
                                                                }
                                                                ed.apply();

                                                                // 2. Восстанавливаем сессию + куки активного аккаунта и обновляем UI
                                                                runOnUiThread(new Runnable() {
                                                                        @Override
                                                                        public void run() { loadSavedUserAndRefreshTokenIfPossible(); }
                                                                });

                                                                // 3. localStorage отдаём в JS через base64 (без проблем с экранированием)
                                                                JSONObject ls = root.optJSONObject("localStorage");
                                                                String lsStr = (ls != null) ? ls.toString() : "{}";
                                                                String lsB64 = Base64.encodeToString(lsStr.getBytes("UTF-8"), Base64.NO_WRAP);

                                                                runJs("showToast('Данные восстановлены');");
                                                                runJs("applyRestoredLocalStorage('" + lsB64 + "');");
                                                        } catch (Exception ex) {
                                                                ex.printStackTrace();
                                                                runJs("showToast('Ошибка восстановления');");
                                                        }
                                                }
                                        }).start();
                                }
                        });
                }

                @JavascriptInterface
                public boolean hasBackup() {
                        try { return getBackupFile().exists(); } catch (Exception e) { return false; }
                }

                // Возвращает base64 JSON-массив аккаунтов из резервной копии [{id,name,avatar}],
                // либо "" если копии нет/нет доступа. Нужно, чтобы экран входа показал сессии.
                @JavascriptInterface
                public String getBackupAccounts() {
                        try {
                                if (!hasStoragePermission()) return "";
                                JSONObject root = readBackupRoot();
                                if (root == null) return "";
                                JSONObject prefsObj = root.optJSONObject("prefs");
                                if (prefsObj == null) return "";
                                JSONObject cell = prefsObj.optJSONObject("saved_accounts_list");
                                String listJson = (cell != null) ? cell.optString("v", "[]") : "[]";
                                JSONArray arr = new JSONArray(listJson);
                                JSONArray out = new JSONArray();
                                for (int i = 0; i < arr.length(); i++) {
                                        JSONObject a = arr.optJSONObject(i);
                                        if (a == null) continue;
                                        String id = a.optString("id", "");
                                        if (id.isEmpty()) continue;
                                        JSONObject o = new JSONObject();
                                        o.put("id", id);
                                        o.put("name", a.optString("name", "Гость"));
                                        o.put("avatar", a.optString("avatar", ""));
                                        out.put(o);
                                }
                                return Base64.encodeToString(out.toString().getBytes("UTF-8"), Base64.NO_WRAP);
                        } catch (Exception e) {
                                return "";
                        }
                }

                // Восстанавливает данные из копии и делает активным выбранный аккаунт.
                @JavascriptInterface
                public void restoreBackupAndActivate(final String targetId) {
                        runOnUiThread(new Runnable() {
                                @Override
                                public void run() {
                                        if (!hasStoragePermission()) {
                                                requestStoragePermission();
                                                runJs("showToast('Дайте доступ к памяти и повторите');");
                                                return;
                                        }
                                        new Thread(new Runnable() {
                                                @Override
                                                public void run() {
                                                        try {
                                                                JSONObject root = readBackupRoot();
                                                                if (root == null) {
                                                                        runJs("showToast('Резервная копия не найдена');");
                                                                        return;
                                                                }
                                                                restorePrefsFromBackup(root);
                                                                activateSavedAccount(targetId);

                                                                runOnUiThread(new Runnable() {
                                                                        @Override
                                                                        public void run() { loadSavedUserAndRefreshTokenIfPossible(); }
                                                                });

                                                                JSONObject ls = root.optJSONObject("localStorage");
                                                                String lsStr = (ls != null) ? ls.toString() : "{}";
                                                                String lsB64 = Base64.encodeToString(lsStr.getBytes("UTF-8"), Base64.NO_WRAP);

                                                                runJs("showToast('Сессия восстановлена');");
                                                                runJs("applyRestoredLocalStorage('" + lsB64 + "');");
                                                        } catch (Exception ex) {
                                                                ex.printStackTrace();
                                                                runJs("showToast('Ошибка восстановления');");
                                                        }
                                                }
                                        }).start();
                                }
                        });
                }

                @JavascriptInterface
                public void requestStorageInfo() {
                        if (!hasStoragePermission()) {
                                runOnUiThread(new Runnable() {
                                                @Override
                                                public void run() { requestStoragePermission(); }
                                        });
                                try {
                                        JSONObject statsObj = new JSONObject();
                                        statsObj.put("current", "0 Б");
                                        statsObj.put("saved", "0 Б");
                                        statsObj.put("original", "0 Б");
                                        runJs("updateDownloadsUI('" + Base64.encodeToString(statsObj.toString().getBytes("UTF-8"), Base64.NO_WRAP) + "', '" + Base64.encodeToString("[]".getBytes("UTF-8"), Base64.NO_WRAP) + "');");
                                } catch (Exception e) {}
                                return;
                        }

                        new Thread(new Runnable() {
                                        @Override
                                        public void run() {
                                                try {
                                                        File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "PixivDL");
                                                        long totalCurrentSize = 0;
                                                        long totalOriginalSize = 0;

                                                        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
                                                        SharedPreferences.Editor editor = prefs.edit();

                                                        HashSet<String> existingFiles = new HashSet<String>();
                                                        HashSet<String> existingFolders = new HashSet<String>();

                                                        JSONArray list = new JSONArray();
                                                        if (dir.exists() && dir.isDirectory()) {
                                                                File[] folders = dir.listFiles();
                                                                if (folders != null) {
                                                                        for (File f : folders) {
                                                                                if (f.isDirectory() && f.getName().matches("\\d+")) {
                                                                                        File[] files = f.listFiles();
                                                                                        existingFolders.add("expected_" + f.getName());

                                                                                        if (files == null || files.length == 0) {
                                                                                                deleteIllustFolder(f.getName());
                                                                                                continue;
                                                                                        }

                                                                                        long folderCurrentSize = 0;
                                                                                        int actualImgs = 0;

                                                                                        for (File img : files) {
                                                                                                String name = img.getName().toLowerCase();
                                                                                                if (name.endsWith(".jpg") || name.endsWith(".png") || name.endsWith(".gif") || name.endsWith(".webp")) {
                                                                                                        if(img.length() > 0) actualImgs++;
                                                                                                        long actualSize = img.length();
                                                                                                        folderCurrentSize += actualSize;
                                                                                                        totalCurrentSize += actualSize;

                                                                                                        String key = "orig_" + f.getName() + "_" + img.getName();
                                                                                                        existingFiles.add(key);

                                                                                                        long origSize = prefs.getLong(key, actualSize);
                                                                                                        if (origSize < actualSize) origSize = actualSize; 
                                                                                                        totalOriginalSize += origSize;
                                                                                                }
                                                                                        }

                                                                                        int expected = prefs.getInt("expected_" + f.getName(), -1);

                                                                                        JSONObject obj = new JSONObject();
                                                                                        obj.put("id", f.getName());
                                                                                        obj.put("size", formatSize(folderCurrentSize));
                                                                                        obj.put("thumb", getThumbnailBase64(f));
                                                                                        obj.put("actual", actualImgs);
                                                                                        obj.put("expected", expected);
                                                                                        obj.put("is_incomplete", (expected != -1 && actualImgs < expected));

                                                                                        list.put(obj);
                                                                                }
                                                                        }
                                                                }
                                                        }

                                                        Map<String, ?> allEntries = prefs.getAll();
                                                        for (Map.Entry<String, ?> entry : allEntries.entrySet()) {
                                                                if (entry.getKey().startsWith("orig_") && !existingFiles.contains(entry.getKey())) {
                                                                        editor.remove(entry.getKey());
                                                                }
                                                                if (entry.getKey().startsWith("expected_") && !existingFolders.contains(entry.getKey())) {
                                                                        editor.remove(entry.getKey());
                                                                }
                                                        }
                                                        // --- ИЩЕМ ОФФЛАЙН КЭШ ---
                                                        File offlineDir = new File(getExternalFilesDir(null), "OfflineCache");
                                                        if (offlineDir.exists() && offlineDir.isDirectory()) {
                                                                File[] offFiles = offlineDir.listFiles();
                                                                if (offFiles != null && offFiles.length > 1) { // 1 это .nomedia
                                                                        long offSize = 0;
                                                                        int offCount = 0;
                                                                        String offThumb = "";
                                                                        for (File f : offFiles) {
                                                                                if (f.getName().equals(".nomedia")) continue;
                                                                                offSize += f.length();
                                                                                offCount++;
                                                                        }
                                                                        JSONObject obj = new JSONObject();
                                                                        obj.put("id", "offline_cache");
                                                                        obj.put("size", formatSize(offSize));
                                                                        // Ставим специальную иконку для кэша
                                                                        obj.put("thumb", "cache_icon"); 
                                                                        obj.put("actual", offCount);
                                                                        obj.put("expected", offCount);
                                                                        obj.put("is_incomplete", false);
                                                                        list.put(obj);
                                                                        totalCurrentSize += offSize;
                                                                }
                                                        }
                                                        editor.apply();

                                                        long savedBytes = totalOriginalSize - totalCurrentSize;
                                                        if (savedBytes < 0) savedBytes = 0; 

                                                        JSONObject statsObj = new JSONObject();
                                                        statsObj.put("current", formatSize(totalCurrentSize));
                                                        statsObj.put("saved", formatSize(savedBytes));
                                                        statsObj.put("original", formatSize(totalOriginalSize));

                                                        final String statsStr = statsObj.toString();
                                                        final String jsonStr = list.toString();
                                                        runJs("updateDownloadsUI('" + Base64.encodeToString(statsStr.getBytes("UTF-8"), Base64.NO_WRAP) + "', '" + Base64.encodeToString(jsonStr.getBytes("UTF-8"), Base64.NO_WRAP) + "');");
                                                } catch(Exception e) {}
                                        }
                                }).start();
                }

                // Умная загрузка HTML страниц
                @JavascriptInterface
                public String loadHtmlFile(String fileName) {
                        try {
                                File updateFile = new File(getExternalFilesDir(null), "AppUpdates/" + fileName);
                                InputStream is;
                                if (updateFile.exists()) {
                                        is = new java.io.FileInputStream(updateFile); // Берем обновление
                                } else {
                                        is = getAssets().open(fileName); // Или берем из базы
                                }
                                byte[] buffer = new byte[is.available()];
                                is.read(buffer);
                                is.close();
                                return new String(buffer, "UTF-8");
                        } catch (Exception e) {
                                return "<div style='color:red; padding:16px;'>Ошибка загрузки " + fileName + "</div>";
                        }
                }

                // Загрузчик файлов с GitHub
                @JavascriptInterface
                public void downloadAppUpdateFile(final String fileName, final String urlStr) {
                        new Thread(new Runnable() {
                                        public void run() {
                                                try {
                                                        File dir = new File(getExternalFilesDir(null), "AppUpdates");
                                                        File file = new File(dir, fileName);
                                                        if (!file.getParentFile().exists()) file.getParentFile().mkdirs();

                                                        URL url = new URL(urlStr);
                                                        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                                                        conn.setRequestMethod("GET");
                                                        conn.setUseCaches(false);

                                                        InputStream is = conn.getInputStream();
                                                        FileOutputStream os = new FileOutputStream(file);
                                                        byte[] buffer = new byte[8192];
                                                        int count;
                                                        while ((count = is.read(buffer)) != -1) os.write(buffer, 0, count);
                                                        os.flush(); os.close(); is.close();

                                                        runJs("updateFileDownloaded('" + fileName + "');");
                                                } catch (Exception e) {
                                                        runJs("updateFileFailed('" + fileName + "');");
                                                }
                                        }
                                }).start();
                }
                
        @JavascriptInterface
        public void openExternalLink(String url) {
            try {
                Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                startActivity(intent);
            } catch (Exception e) {
                e.printStackTrace();
            }
        }

                @JavascriptInterface
                public void openPixivSettings() {
                        runOnUiThread(new Runnable() {
                                        @Override
                                        public void run() {
                                                // Создаем аккуратное всплывающее окно вместо полноэкранного браузера
                                                final android.app.Dialog dialog = new android.app.Dialog(MainActivity.this);
                                                dialog.requestWindowFeature(android.view.Window.FEATURE_NO_TITLE);

                                                // Делаем фон окна прозрачным, чтобы были видны закругленные края нашей карточки
                                                if (dialog.getWindow() != null) {
                                                        dialog.getWindow().setBackgroundDrawable(new android.graphics.drawable.ColorDrawable(android.graphics.Color.TRANSPARENT));
                                                }

                                                // Контейнер карточки
                                                android.widget.LinearLayout layout = new android.widget.LinearLayout(MainActivity.this);
                                                layout.setOrientation(android.widget.LinearLayout.VERTICAL);

                                                // Закругляем углы и делаем фирменный темный фон
                                                android.graphics.drawable.GradientDrawable gd = new android.graphics.drawable.GradientDrawable();
                                                gd.setColor(android.graphics.Color.parseColor("#1C1C1E")); // Темный цвет под ваш UI
                                                gd.setCornerRadius(50f); // Сильное красивое закругление (как в iOS)
                                                layout.setBackground(gd);
                                                if (Build.VERSION.SDK_INT >= 21) {
                                                        layout.setClipToOutline(true);
                                                }

                                                // Шапка карточки
                                                android.widget.RelativeLayout header = new android.widget.RelativeLayout(MainActivity.this);
                                                header.setPadding(50, 40, 50, 20);

                                                android.widget.TextView title = new android.widget.TextView(MainActivity.this);
                                                title.setText("Контент R-18");
                                                title.setTextColor(android.graphics.Color.WHITE);
                                                title.setTextSize(18);
                                                title.setTypeface(null, android.graphics.Typeface.BOLD);

                                                android.widget.RelativeLayout.LayoutParams titleParams = new android.widget.RelativeLayout.LayoutParams(
                                                        android.widget.RelativeLayout.LayoutParams.WRAP_CONTENT,
                                                        android.widget.RelativeLayout.LayoutParams.WRAP_CONTENT
                                                );
                                                titleParams.addRule(android.widget.RelativeLayout.CENTER_VERTICAL);
                                                header.addView(title, titleParams);

                                                // Кнопка закрытия
                                                android.widget.Button closeBtn = new android.widget.Button(MainActivity.this);
                                                closeBtn.setText("Готово");
                                                closeBtn.setTextColor(android.graphics.Color.parseColor("#0096FA")); // Pixiv Blue
                                                closeBtn.setBackgroundColor(android.graphics.Color.TRANSPARENT);
                                                closeBtn.setPadding(0, 0, 0, 0);

                                                android.widget.RelativeLayout.LayoutParams btnParams = new android.widget.RelativeLayout.LayoutParams(
                                                        android.widget.RelativeLayout.LayoutParams.WRAP_CONTENT,
                                                        android.widget.RelativeLayout.LayoutParams.WRAP_CONTENT
                                                );
                                                btnParams.addRule(android.widget.RelativeLayout.ALIGN_PARENT_RIGHT);
                                                btnParams.addRule(android.widget.RelativeLayout.CENTER_VERTICAL);
                                                header.addView(closeBtn, btnParams);

                                                layout.addView(header);

                                                // Круговой спиннер по центру в стиле приложения
                                                final android.widget.ProgressBar r18Spinner = new android.widget.ProgressBar(
                                                        MainActivity.this, null, android.R.attr.progressBarStyleLarge);
                                                if (Build.VERSION.SDK_INT >= 21) {
                                                        r18Spinner.setIndeterminateTintList(android.content.res.ColorStateList.valueOf(
                                                                android.graphics.Color.parseColor("#0096FA")));
                                                }

                                                // Сам "невидимый" браузер
                                                final WebView browserWebView = new WebView(MainActivity.this);
                                                WebSettings settings = browserWebView.getSettings();
                                                settings.setJavaScriptEnabled(true);
                                                settings.setDomStorageEnabled(true);
                                                browserWebView.setBackgroundColor(android.graphics.Color.TRANSPARENT); // Убираем белый фон у WebView

                                                // Передаем куки пользователя
                                                android.webkit.CookieManager cookieManager = android.webkit.CookieManager.getInstance();
                                                cookieManager.setAcceptCookie(true);
                                                if (Build.VERSION.SDK_INT >= 21) {
                                                        cookieManager.setAcceptThirdPartyCookies(browserWebView, true);
                                                }

                                                browserWebView.setWebChromeClient(new android.webkit.WebChromeClient() {
                                                                @Override
                                                                public void onProgressChanged(WebView view, int newProgress) {
                                                                        if (newProgress >= 100) {
                                                                                r18Spinner.animate().alpha(0f).setDuration(300).withEndAction(new Runnable() {
                                                                                                @Override
                                                                                                public void run() { r18Spinner.setVisibility(View.GONE); }
                                                                                        }).start();
                                                                        }
                                                                }
                                                        });

                                                browserWebView.setWebViewClient(new WebViewClient() {
                                                                @Override
                                                                public boolean shouldOverrideUrlLoading(WebView view, String url) {
                                                                        view.loadUrl(url);
                                                                        return true;
                                                                }

                                                                @Override
                                                                public void onPageFinished(WebView view, String url) {
                                                                        // CSS-Магия: стираем всё, кроме самих переключателей
                                                                        String cssInject = "javascript:(function() { " +
                                                                                "var style = document.createElement('style');" +
                                                                                "style.innerHTML = '" +
                                                                                "   header, nav, footer, aside, .premium-banner, [class*=\"Header\"], [class*=\"Footer\"] { display: none !important; }" +
                                                                                "   #wrapper, #root, body { background: transparent !important; margin: 0 !important; padding: 0 !important; min-width: auto !important; }" +
                                                                                "   /* Инвертируем цвета текста Pixiv под темную тему */" +
                                                                                "   body * { color: #000000 !important; }" +
                                                                                "'; " +
                                                                                "document.head.appendChild(style);" +
                                                                                "})()";

                                                                        if (Build.VERSION.SDK_INT >= 19) {
                                                                                view.evaluateJavascript(cssInject, null);
                                                                        } else {
                                                                                view.loadUrl(cssInject);
                                                                        }
                                                                }
                                                        });

                                                // Оборачиваем браузер и спиннер в контейнер, чтобы спиннер был строго по центру области
                                                android.widget.FrameLayout webContainer = new android.widget.FrameLayout(MainActivity.this);
                                                android.widget.FrameLayout.LayoutParams wvParams = new android.widget.FrameLayout.LayoutParams(
                                                        android.widget.FrameLayout.LayoutParams.MATCH_PARENT,
                                                        android.widget.FrameLayout.LayoutParams.MATCH_PARENT
                                                );
                                                webContainer.addView(browserWebView, wvParams);

                                                android.widget.FrameLayout.LayoutParams spinnerParams = new android.widget.FrameLayout.LayoutParams(
                                                        (int)(getResources().getDisplayMetrics().density * 40),
                                                        (int)(getResources().getDisplayMetrics().density * 40)
                                                );
                                                spinnerParams.gravity = android.view.Gravity.CENTER;
                                                webContainer.addView(r18Spinner, spinnerParams);

                                                // Задаем высоту контейнеру так, чтобы влезли только настройки
                                                android.widget.LinearLayout.LayoutParams containerParams = new android.widget.LinearLayout.LayoutParams(
                                                        android.widget.LinearLayout.LayoutParams.MATCH_PARENT,
                                                        (int)(getResources().getDisplayMetrics().density * 250) // Высота 250dp
                                                );
                                                layout.addView(webContainer, containerParams);

                                                // Ширина карточки - 90% от ширины экрана
                                                int width = (int)(getResources().getDisplayMetrics().widthPixels * 0.9);
                                                dialog.setContentView(layout, new android.view.ViewGroup.LayoutParams(width, android.view.ViewGroup.LayoutParams.WRAP_CONTENT));

                                                // При ЛЮБОМ закрытии (кнопка, "Назад", тап вне окна) надёжно сохраняем куки настроек R-18
                                                dialog.setOnDismissListener(new android.content.DialogInterface.OnDismissListener() {
                                                                @Override
                                                                public void onDismiss(android.content.DialogInterface d) {
                                                                        // 1. Принудительно пишем куки WebView на диск
                                                                        if (Build.VERSION.SDK_INT >= 21) {
                                                                                android.webkit.CookieManager.getInstance().flush();
                                                                        }
                                                                        // 2. Снимаем свежие куки в "сейф" активного аккаунта, чтобы они пережили перезапуск и смену аккаунта
                                                                        SharedPreferences p = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
                                                                        saveAccountToCache(p.getString(KEY_USER_ID, ""), p.getString(KEY_USER_NAME, ""), p.getString(KEY_USER_AVATAR, ""));
                                                                        // 3. Освобождаем WebView (куки уже в общем хранилище, destroy их не трогает)
                                                                        try { browserWebView.destroy(); } catch (Exception e) {}
                                                                }
                                                        });

                                                closeBtn.setOnClickListener(new View.OnClickListener() {
                                                                @Override
                                                                public void onClick(View v) {
                                                                        dialog.dismiss();
                                                                }
                                                        });

                                                dialog.show();
                                                browserWebView.loadUrl("https://www.pixiv.net/settings/viewing");
                                        }
                                });
                }

                @JavascriptInterface
                public void getAutocomplete(final String word) {
                        MainActivity.this.runOnUiThread(new Runnable() {
                                        @Override
                                        public void run() {
                                                SharedPreferences prefs = MainActivity.this.getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
                                                String accessToken = prefs.getString(KEY_ACCESS_TOKEN, null);
                                                if (accessToken != null && accessToken.length() > 0) {
                                                        new AutocompleteTask().executeOnExecutor(AsyncTask.THREAD_POOL_EXECUTOR, accessToken, word);
                                                }
                                        }
                                });
                }

                @JavascriptInterface
                public void getTrendingTags() {
                        MainActivity.this.runOnUiThread(new Runnable() {
                                        @Override
                                        public void run() {
                                                SharedPreferences prefs = MainActivity.this.getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
                                                String accessToken = prefs.getString(KEY_ACCESS_TOKEN, null);
                                                if (accessToken != null && accessToken.length() > 0) {
                                                        new TrendingTagsTask().executeOnExecutor(AsyncTask.THREAD_POOL_EXECUTOR, accessToken);
                                                }
                                        }
                                });
                }
                
        // --- Внутри класса WebAppInterface в MainActivity.java ---

        @JavascriptInterface
        public void setWidgetArt(final String sourceImagePath) {
            new Thread(new Runnable() {
                    @Override
                    public void run() {
                        try {
                            java.io.File src = new java.io.File(sourceImagePath);
                            if (!src.exists()) return;

                            // 1. Подготавливаем приватную папку data/Widget
                            java.io.File internalDir = new java.io.File(MainActivity.this.getFilesDir(), "Widget");
                            if (!internalDir.exists()) internalDir.mkdirs();
                            java.io.File widgetFile = new java.io.File(internalDir, "current_art.png"); // PNG для прозрачности углов

                            // 2. Сжимаем исходник до разумного размера (400px)
                            android.graphics.BitmapFactory.Options opts = new android.graphics.BitmapFactory.Options();
                            opts.inJustDecodeBounds = true;
                            android.graphics.BitmapFactory.decodeFile(src.getAbsolutePath(), opts);

                            opts.inSampleSize = 1;
                            while ((opts.outWidth / opts.inSampleSize) > 400 || (opts.outHeight / opts.inSampleSize) > 400) {
                                opts.inSampleSize *= 2;
                            }
                            opts.inJustDecodeBounds = false;

                            android.graphics.Bitmap scaledBmp = android.graphics.BitmapFactory.decodeFile(src.getAbsolutePath(), opts);

                            if (scaledBmp != null) {
                                // 3. МАГИЯ: Скругляем углы самого Bitmap'а
                                // 20dp в пиксели
                                float density = MainActivity.this.getResources().getDisplayMetrics().density;
                                int pxRadius = Math.round(20 * density); 

                                android.graphics.Bitmap roundedBmp = getRoundedCornerBitmap(scaledBmp, pxRadius);
                                scaledBmp.recycle(); // Удаляем промежуточный bitmap

                                // 4. Сохраняем скругленный PNG в приватную папку
                                java.io.FileOutputStream fos = new java.io.FileOutputStream(widgetFile);
                                roundedBmp.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, fos); // PNG сохраняет прозрачность
                                fos.flush(); fos.close();
                                roundedBmp.recycle();
                            }

                            // 5. Сохраняем путь в настройки
                            SharedPreferences prefs = MainActivity.this.getSharedPreferences("PixivWidgetPrefs", Context.MODE_PRIVATE);
                            prefs.edit().putString("widget_image_path", widgetFile.getAbsolutePath()).apply();

                            // 6. Посылаем сигнал обновить виджет
                            updateAllWidgets();

                        } catch (Exception e) { e.printStackTrace(); }
                    }
                }).start();
        }

        // Вспомогательная функция для скругления углов Bitmap
        private android.graphics.Bitmap getRoundedCornerBitmap(android.graphics.Bitmap bitmap, int pixels) {
            android.graphics.Bitmap output = android.graphics.Bitmap.createBitmap(bitmap.getWidth(), bitmap.getHeight(), android.graphics.Bitmap.Config.ARGB_8888);
            android.graphics.Canvas canvas = new android.graphics.Canvas(output);

            final int color = 0xff424242;
            final android.graphics.Paint paint = new android.graphics.Paint();
            final android.graphics.Rect rect = new android.graphics.Rect(0, 0, bitmap.getWidth(), bitmap.getHeight());
            final android.graphics.RectF rectF = new android.graphics.RectF(rect);
            final float roundPx = pixels;

            paint.setAntiAlias(true);
            canvas.drawARGB(0, 0, 0, 0);
            paint.setColor(color);
            canvas.drawRoundRect(rectF, roundPx, roundPx, paint);

            paint.setXfermode(new android.graphics.PorterDuffXfermode(android.graphics.PorterDuff.Mode.SRC_IN));
            canvas.drawBitmap(bitmap, rect, rect, paint);

            return output;
        }

        // Вынесем обновление виджетов в удобный метод
        private void updateAllWidgets() {
            Intent intent = new Intent(MainActivity.this, ArtWidgetProvider.class);
            intent.setAction(android.appwidget.AppWidgetManager.ACTION_APPWIDGET_UPDATE);
            int[] ids = android.appwidget.AppWidgetManager.getInstance(MainActivity.this)
                .getAppWidgetIds(new android.content.ComponentName(MainActivity.this, ArtWidgetProvider.class));
            intent.putExtra(android.appwidget.AppWidgetManager.EXTRA_APPWIDGET_IDS, ids);
            MainActivity.this.sendBroadcast(intent);
        }

                @JavascriptInterface
                public void hapticClick() {
                        MainActivity.this.runOnUiThread(new Runnable() {
                                        @Override
                                        public void run() {
                                                Vibrator v = (Vibrator) MainActivity.this.getSystemService(Context.VIBRATOR_SERVICE);
                                                if (v != null && v.hasVibrator()) {
                                                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                                                                v.vibrate(VibrationEffect.createOneShot(40, VibrationEffect.DEFAULT_AMPLITUDE));
                                                        } else {
                                                                v.vibrate(40);
                                                        }
                                                }
                                        }
                                });
                }

                @JavascriptInterface
                public void setLandscape(final boolean landscape) {
                        MainActivity.this.runOnUiThread(new Runnable() {
                                @Override
                                public void run() {
                                        if (landscape) {
                                                setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
                                        } else {
                                                setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
                                        }
                                }
                        });
                }

                @JavascriptInterface 
                public void searchUser(final String query, final String nextUrl) { 
                        runOnUiThread(new Runnable() { 
                                        @Override public void run() { startSearchUser(query, nextUrl); }
                                }); 
                }

                // === МЕТОДЫ SMART CACHE ТЕПЕРЬ ТУТ ===
                @JavascriptInterface
                public void startSmartCache(final int count, final String quality) {
                        if (isSmartCacheRunning) return;
                        isSmartCacheRunning = true;
                        new Thread(new Runnable() {
                                        @Override
                                        public void run() {
                                                runSmartCacheEngine(count, quality);
                                        }
                                }).start();
                }

                @JavascriptInterface
                public void stopSmartCache() {
                        isSmartCacheRunning = false;
                }

        } // <==== ВОТ ТУТ МЫ ПРАВИЛЬНО ЗАКРЫВАЕМ WebAppInterface

        // ========================================================
        // МЕТОДЫ MAIN ACTIVITY
        // ========================================================

        private void deleteIllustFolder(String illustId) {
                File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "PixivDL/" + illustId);
                if (dir.exists()) {
                        deleteRecursive(dir);
                }

                SharedPreferences.Editor editor = getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit();
                editor.remove("expected_" + illustId);
                Map<String, ?> allEntries = getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getAll();
                for (String key : allEntries.keySet()) {
                        if (key.startsWith("orig_" + illustId + "_")) {
                                editor.remove(key);
                        }
                }
                editor.apply();
        }

        private void deleteRecursive(File fileOrDirectory) {
                if (fileOrDirectory.isDirectory()) {
                        File[] children = fileOrDirectory.listFiles();
                        if (children != null) {
                                for (File child : children) {
                                        deleteRecursive(child);
                                }
                        }
                }
                fileOrDirectory.delete();
        }

        private String getThumbnailBase64(File dir) {
                try {
                        File[] files = dir.listFiles();
                        if (files != null) {
                                for (File f : files) {
                                        if (f.getName().toLowerCase().endsWith(".jpg") || f.getName().toLowerCase().endsWith(".png")) {
                                                BitmapFactory.Options options = new BitmapFactory.Options();
                                                options.inSampleSize = 8; 
                                                Bitmap bmp = BitmapFactory.decodeFile(f.getAbsolutePath(), options);
                                                if (bmp != null) {
                                                        ByteArrayOutputStream baos = new ByteArrayOutputStream();
                                                        bmp.compress(Bitmap.CompressFormat.JPEG, 40, baos);
                                                        String b64 = Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP);
                                                        bmp.recycle();
                                                        return b64;
                                                }
                                        }
                                }
                        }
                } catch (Exception e) {}
                return "";
        }

        private String formatSize(long size) {
                if (size <= 0) return "0 Б";
                final String[] units = new String[] { "Б", "КБ", "МБ", "ГБ", "ТБ" };
                int digitGroups = (int) (Math.log10(size) / Math.log10(1024));
                return new java.text.DecimalFormat("#,##0.#").format(size / Math.pow(1024, digitGroups)) + " " + units[digitGroups];
        }

        private void updateUIStatus(final String text) {
                runJs("updateStatus('" + text.replace("'", "\\'").replace("\n", " ") + "');");
        }

        private void updateUIProgress(final String id, final int current, final int total) {
                runJs("updateProgress('" + id + "', " + current + ", " + total + ");");
        }

        private void updateUIAccount(final String name, final String id, final String statusMsg, final boolean isActive, final String avatarUrl) {
                String n = (name == null || name.length() == 0) ? "Гость" : name;
                String i = (id == null || id.length() == 0) ? "---" : id;
                String a = (avatarUrl == null) ? "" : avatarUrl;
                runJs("updateAccount('" + n + "', '" + i + "', '" + statusMsg + "', " + isActive + ", '" + a + "');");
        }

        private void updateUIPreview(final Bitmap bitmap, final String metaText) {
                new Thread(new Runnable() {
                                @Override
                                public void run() {
                                        String base64 = "null";
                                        if (bitmap != null) {
                                                ByteArrayOutputStream baos = new ByteArrayOutputStream();
                                                bitmap.compress(Bitmap.CompressFormat.JPEG, 70, baos);
                                                base64 = Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP);
                                        }
                                        final String finalBase64 = base64;
                                        final String safeMeta = metaText.replace("'", "\\'").replace("\n", " | ");
                                        runJs("updatePreview('" + finalBase64 + "', '" + safeMeta + "');");
                                }
                        }).start();
        }

        private void sendSearchResultsToUI(final String b64JsonStr, final String jsFunction) {
                runJs(jsFunction + "('" + b64JsonStr + "');");
        }

        private void sendDetailsToUI(final String b64JsonStr) {
                runJs("displayIllustDetails('" + b64JsonStr + "');");
        }

        private void startDownloadFromInput(String input, String title, String thumb, int targetPage) {
                startDownloadFromInput(input, title, thumb, targetPage, null);
        }

        private void startDownloadFromInput(String input, String title, String thumb, int targetPage, String originalUrl) {
                if (!hasStoragePermission()) { requestStoragePermission(); updateUIStatus("Требуются права на память."); return; }
                if (input == null || input.trim().length() == 0) { updateUIStatus("Вставьте ссылку для скачивания."); return; }

                String illustId = extractIllustId(input);
                if (illustId == null) { updateUIStatus("Не удалось найти ID работы в ссылке."); return; }

                String accessToken = getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getString(KEY_ACCESS_TOKEN, null);
                if (accessToken == null) return;

                String taskKey = targetPage == -1 ? illustId : illustId + "_p" + targetPage;
                if (activeDownloads.containsKey(taskKey)) { updateUIStatus("Уже загружается!"); return; }

                String dlTitle = title;
                if (targetPage != -1 && title != null && !title.isEmpty()) { dlTitle = title + " (Стр. " + (targetPage + 1) + ")"; }
                updateUIStatus("Скачиваем: " + (targetPage == -1 ? illustId : illustId + " стр." + (targetPage+1)));

                IllustDownloadTask task = new IllustDownloadTask(illustId, dlTitle, thumb, targetPage, taskKey, originalUrl);
                activeDownloads.put(taskKey, task);
                task.executeOnExecutor(AsyncTask.THREAD_POOL_EXECUTOR, accessToken, illustId);
        }

        private void startSearch(String query, String nextUrl, String ageFilter, boolean hideAi, String excludeTag) {
                SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
                String accessToken = prefs.getString(KEY_ACCESS_TOKEN, null);
                if (accessToken == null || accessToken.length() == 0) return;
                try {
                        String finalQuery = query;
                        if ("r18".equals(ageFilter)) finalQuery += " R-18";
                        else if ("r18g".equals(ageFilter)) finalQuery += " R-18G";

                        String baseUrl = "https://app-api.pixiv.net/v1/search/illust?word=" + URLEncoder.encode(finalQuery, "UTF-8") + "&search_target=partial_match_for_tags&sort=date_desc";
                        new ListTask("displaySearchResults", ageFilter, hideAi, excludeTag).executeOnExecutor(AsyncTask.THREAD_POOL_EXECUTOR, accessToken, baseUrl, nextUrl);
                } catch (Exception ignored) {}
        }

        private void startRecommended(String nextUrl, String ageFilter, boolean hideAi, String excludeTag) {
                SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
                String accessToken = prefs.getString(KEY_ACCESS_TOKEN, null);
                if (accessToken == null || accessToken.length() == 0) return;

                String baseUrl = "https://app-api.pixiv.net/v1/illust/recommended?include_ranking_illusts=true";
                new ListTask("displayRecommendations", ageFilter, hideAi, excludeTag).executeOnExecutor(AsyncTask.THREAD_POOL_EXECUTOR, accessToken, baseUrl, nextUrl);
        }

        private void startBookmarks(String nextUrl) {
                SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
                String accessToken = prefs.getString(KEY_ACCESS_TOKEN, null);
                String userId = prefs.getString(KEY_USER_ID, null);
                if (accessToken == null || userId == null || accessToken.length() == 0) return;

                String baseUrl = "https://app-api.pixiv.net/v1/user/bookmarks/illust?user_id=" + userId + "&restrict=public";
                new ListTask("displayAuthorIllusts", "all", false, "").executeOnExecutor(AsyncTask.THREAD_POOL_EXECUTOR, accessToken, baseUrl, nextUrl);
        }

        // Загружает одну из лент "Главной": "trending" | "suggested" | "bookmarks".
        // Переиспользует ListTask и отдаёт результат в соответствующий JS-колбэк.
        private void startHomeStrip(String kind) {
                SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
                String accessToken = prefs.getString(KEY_ACCESS_TOKEN, null);
                String userId = prefs.getString(KEY_USER_ID, null);
                if (accessToken == null || accessToken.length() == 0) return;

                if ("trending".equals(kind)) {
                        String baseUrl = "https://app-api.pixiv.net/v1/illust/ranking?mode=day";
                        new ListTask("displayHomeTrending", "all", false, "").executeOnExecutor(AsyncTask.THREAD_POOL_EXECUTOR, accessToken, baseUrl, "");
                } else if ("bookmarks".equals(kind)) {
                        if (userId == null || userId.length() == 0) return;
                        String baseUrl = "https://app-api.pixiv.net/v1/user/bookmarks/illust?user_id=" + userId + "&restrict=public";
                        new ListTask("displayHomeBookmarks", "all", false, "").executeOnExecutor(AsyncTask.THREAD_POOL_EXECUTOR, accessToken, baseUrl, "");
                } else if ("suggested".equals(kind)) {
                        if (userId == null || userId.length() == 0) return;
                        // Та же логика, что на странице "Может понравиться": случайная закладка -> похожие на неё
                        new DiscoveryTask("all", "displayHomeSuggested").executeOnExecutor(AsyncTask.THREAD_POOL_EXECUTOR, accessToken, userId, "");
                }
        }

        private class ListTask extends AsyncTask<String, Void, String> {
                private String jsCallback;
                private String ageFilter;
                private boolean hideAi;
                private String excludeTag; // НОВОЕ ПОЛЕ

                public ListTask(String jsCallback, String ageFilter, boolean hideAi, String excludeTag) {
                        this.jsCallback = jsCallback;
                        this.ageFilter = ageFilter;
                        this.hideAi = hideAi;
                        this.excludeTag = excludeTag; // ИНИЦИАЛИЗАЦИЯ
                }

                @Override
                protected String doInBackground(String... params) {
                        String token = params[0];
                        String baseUrl = params[1];
                        String nextUrlStr = params[2];

                        for (int retry = 0; retry < 3; retry++) {
                                HttpURLConnection conn = null;
                                try {
                                        String urlStr = (nextUrlStr != null && nextUrlStr.startsWith("http")) ? nextUrlStr : baseUrl;

                                        URL url = new URL(urlStr);
                                        conn = (HttpURLConnection) url.openConnection();
                                        conn.setRequestMethod("GET");
                                        conn.setRequestProperty("Authorization", "Bearer " + token);
                                        addPixivApiHeaders(conn);
                                        conn.setConnectTimeout(10000);
                                        conn.setReadTimeout(10000);
                                        conn.setUseCaches(false);

                                        int responseCode = conn.getResponseCode();

                                        if (responseCode >= 200 && responseCode < 300) {
                                                BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream()));
                                                StringBuilder res = new StringBuilder();
                                                String line;
                                                while ((line = reader.readLine()) != null) res.append(line);
                                                reader.close();

                                                JSONObject root = new JSONObject(res.toString());
                                                String nextUrlReturned = root.isNull("next_url") ? "" : root.optString("next_url", "");
                                                if (nextUrlReturned.equals("null")) nextUrlReturned = "";

                                                JSONArray illusts = root.optJSONArray("illusts");

                                                JSONArray resultsArray = new JSONArray();
                                                if (illusts != null) {
                                                        for (int i = 0; i < illusts.length(); i++) {
                                                                JSONObject ill = illusts.getJSONObject(i);

                                                                // ==========================================
                                                                // НОВЫЙ БЛОК: ИСКЛЮЧЕНИЕ ПО ТЕГАМ
                                                                // ==========================================
                                                                boolean hasExcludedTag = false;
                                                                if (excludeTag != null && !excludeTag.trim().isEmpty()) {
                                                                        String[] excludedTagsArray = excludeTag.toLowerCase().split(",");
                                                                        JSONArray illTags = ill.optJSONArray("tags");

                                                                        if (illTags != null) {
                                                                                for (int t = 0; t < illTags.length(); t++) {
                                                                                        JSONObject tagObj = illTags.getJSONObject(t);
                                                                                        String tName = tagObj.optString("name", "").toLowerCase();
                                                                                        String tTrans = tagObj.optString("translated_name", "").toLowerCase();

                                                                                        for (String ex : excludedTagsArray) {
                                                                                                String exTrim = ex.trim();
                                                                                                // Проверяем частичное совпадение на японском и русском
                                                                                                if (!exTrim.isEmpty() && (tName.contains(exTrim) || tTrans.contains(exTrim))) {
                                                                                                        hasExcludedTag = true;
                                                                                                        break;
                                                                                                }
                                                                                        }
                                                                                        if (hasExcludedTag) break;
                                                                                }
                                                                        }
                                                                }
                                                                if (hasExcludedTag) continue; // ВЫБРАСЫВАЕМ АРТ, ИДЕМ К СЛЕДУЮЩЕМУ
                                                                // ==========================================

                                                                int xRestrict = ill.optInt("x_restrict", 0);
                                                                int aiType = ill.optInt("illust_ai_type", 0);
                                                                boolean isR18 = xRestrict == 1;
                                                                boolean isR18G = xRestrict == 2;
                                                                boolean isAi = aiType == 2;

                                                                if (hideAi && isAi) continue;
                                                                if ("g".equals(ageFilter) && xRestrict != 0) continue;
                                                                if ("r18".equals(ageFilter) && !isR18) continue;
                                                                if ("r18g".equals(ageFilter) && !isR18G) continue;

                                                                JSONObject item = new JSONObject();
                                                                item.put("id", String.valueOf(ill.optInt("id")));
                                                                item.put("title", ill.optString("title", "Без названия"));

                                                                JSONObject user = ill.optJSONObject("user");
                                                                item.put("author", user != null ? user.optString("name", "Неизвестен") : "Неизвестен");
                                                                item.put("author_id", user != null ? String.valueOf(user.optInt("id", 0)) : "");

                                                                item.put("is_r18", isR18);
                                                                item.put("is_r18g", isR18G);
                                                                item.put("page_count", ill.optInt("page_count", 1));

                                                                item.put("is_bookmarked", ill.optBoolean("is_bookmarked", false));

                                                                JSONObject imgs = ill.optJSONObject("image_urls");
                                                                item.put("thumb", imgs != null ? imgs.optString("medium", "") : "");

                                                                resultsArray.put(item);
                                                        }
                                                }

                                                JSONObject finalResult = new JSONObject();
                                                finalResult.put("results", resultsArray);
                                                finalResult.put("next_url", nextUrlReturned);

                                                return Base64.encodeToString(finalResult.toString().getBytes("UTF-8"), Base64.NO_WRAP);

                                        } else if (responseCode == 429) { 
                                                Thread.sleep(1500); 
                                        } else if (responseCode >= 500) {
                                                Thread.sleep(1000);
                                        } else {
                                                break; 
                                        }
                                } catch (Exception e) {
                                        try { Thread.sleep(1000); } catch (Exception ignored) {}
                                } finally {
                                        if (conn != null) {
                                                try { conn.disconnect(); } catch (Exception ignored) {}
                                        }
                                }
                        }
                        try {
                                return Base64.encodeToString("{\"results\":[],\"next_url\":\"\"}".getBytes("UTF-8"), Base64.NO_WRAP);
                        } catch (Exception ignored) { return ""; }
                }
                @Override
                protected void onPostExecute(String encodedJson) {
                        sendSearchResultsToUI(encodedJson, jsCallback);
                }
        }

        private void startAuthorIllusts(String userId, String nextUrl) {
                SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
                String accessToken = prefs.getString(KEY_ACCESS_TOKEN, null);
                if (accessToken == null || accessToken.length() == 0) return;
                new AuthorTask(false).executeOnExecutor(AsyncTask.THREAD_POOL_EXECUTOR, accessToken, userId, nextUrl);
        }

        private class AuthorTask extends AsyncTask<String, Void, String> {
                private boolean resultsForLoggedInUser;
                public AuthorTask(boolean forLoggedInUser) {
                        this.resultsForLoggedInUser = forLoggedInUser;
                }

                @Override
                protected String doInBackground(String... params) {
                        String token = params[0];
                        String userId = params[1];
                        String nextUrlStr = params[2];

                        for (int retry = 0; retry < 3; retry++) {
                                HttpURLConnection conn = null;
                                try {
                                        String urlStr = (nextUrlStr != null && nextUrlStr.startsWith("http")) ? nextUrlStr : "https://app-api.pixiv.net/v1/user/illusts?user_id=" + userId + "&type=illust";

                                        URL url = new URL(urlStr);
                                        conn = (HttpURLConnection) url.openConnection();
                                        conn.setRequestMethod("GET");
                                        conn.setRequestProperty("Authorization", "Bearer " + token);
                                        addPixivApiHeaders(conn);
                                        conn.setConnectTimeout(10000);
                                        conn.setReadTimeout(10000);
                                        conn.setUseCaches(false);

                                        int responseCode = conn.getResponseCode();

                                        if (responseCode >= 200 && responseCode < 300) {
                                                BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream()));
                                                StringBuilder res = new StringBuilder();
                                                String line;
                                                while ((line = reader.readLine()) != null) res.append(line);
                                                reader.close();

                                                JSONObject root = new JSONObject(res.toString());
                                                String nextUrlReturned = root.isNull("next_url") ? "" : root.optString("next_url", "");
                                                if (nextUrlReturned.equals("null")) nextUrlReturned = "";

                                                JSONArray illusts = root.optJSONArray("illusts");

                                                JSONArray resultsArray = new JSONArray();
                                                if (illusts != null) {
                                                        for (int i = 0; i < illusts.length(); i++) {
                                                                JSONObject ill = illusts.getJSONObject(i);
                                                                JSONObject item = new JSONObject();
                                                                item.put("id", String.valueOf(ill.optInt("id")));
                                                                item.put("title", ill.optString("title", "Без названия"));

                                                                JSONObject user = ill.optJSONObject("user");
                                                                item.put("author", user != null ? user.optString("name", "Неизвестен") : "Неизвестен");
                                                                item.put("author_id", user != null ? String.valueOf(user.optInt("id", 0)) : "");

                                                                int xRestrict = ill.optInt("x_restrict", 0);
                                                                item.put("is_r18", xRestrict == 1);
                                                                item.put("is_r18g", xRestrict == 2);
                                                                item.put("page_count", ill.optInt("page_count", 1));

                                                                item.put("is_bookmarked", ill.optBoolean("is_bookmarked", false));

                                                                JSONObject imgs = ill.optJSONObject("image_urls");
                                                                item.put("thumb", imgs != null ? imgs.optString("medium", "") : "");

                                                                resultsArray.put(item);
                                                        }
                                                }

                                                JSONObject finalResult = new JSONObject();
                                                finalResult.put("results", resultsArray);
                                                finalResult.put("next_url", nextUrlReturned);
                                                finalResult.put("results_for_logged_in_user", resultsForLoggedInUser); 

                                                return Base64.encodeToString(finalResult.toString().getBytes("UTF-8"), Base64.NO_WRAP);
                                        } else if (responseCode == 429) { 
                                                Thread.sleep(1500); 
                                        } else if (responseCode >= 500) {
                                                Thread.sleep(1000);
                                        } else {
                                                break; 
                                        }
                                } catch (Exception e) {
                                        try { Thread.sleep(1000); } catch (Exception ignored) {}
                                } finally {
                                        if (conn != null) {
                                                try { conn.disconnect(); } catch (Exception ignored) {}
                                        }
                                }
                        }
                        try {
                                return Base64.encodeToString("{\"results\":[],\"next_url\":\"\"}".getBytes("UTF-8"), Base64.NO_WRAP);
                        } catch (Exception ignored) { return ""; }
                }
                @Override
                protected void onPostExecute(String encodedJson) {
                        sendSearchResultsToUI(encodedJson, "displayAuthorIllusts");
                }
        }

        private void startGetDetails(String id) {
                SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
                String accessToken = prefs.getString(KEY_ACCESS_TOKEN, null);
                if (accessToken != null) {
                        new DetailTask().executeOnExecutor(AsyncTask.THREAD_POOL_EXECUTOR, accessToken, id);
                }
        }

        private class DetailTask extends AsyncTask<String, Void, String> {
                @Override
                protected String doInBackground(String... params) {
                        try {
                                JSONObject detail = getIllustDetailJson(params[0], params[1]);
                                if (detail == null) throw new Exception("Сетевая ошибка");

                                if (!detail.has("illust")) {
                                        JSONObject errObj = detail.optJSONObject("error");
                                        String errMsg = errObj != null ? errObj.optString("user_message", "Работа ограничена или удалена") : "Нет доступа к работе";
                                        throw new Exception(errMsg);
                                }

                                JSONObject ill = detail.getJSONObject("illust");
                                JSONObject result = new JSONObject();

                                result.put("id", params[1]);
                                result.put("title", ill.optString("title", "Без названия"));

                                result.put("is_bookmarked", ill.optBoolean("is_bookmarked", false));
                                result.put("is_ai", ill.optInt("illust_ai_type", 0) == 2);
                                result.put("view_count", ill.optInt("total_view", 0));
                                result.put("bookmark_count", ill.optInt("total_bookmarks", 0));
                                result.put("create_date", ill.optString("create_date", ""));

                                JSONObject user = ill.optJSONObject("user");
                                result.put("author", user != null ? user.optString("name", "Неизвестен") : "Неизвестен");
                                result.put("author_id", user != null ? String.valueOf(user.optInt("id", 0)) : "");
                                result.put("is_followed", user != null && user.optBoolean("is_followed", false));

                                JSONObject profileImg = user != null ? user.optJSONObject("profile_image_urls") : null;
                                result.put("author_avatar", profileImg != null ? profileImg.optString("medium", "") : "");

                                JSONArray tagsJson = ill.optJSONArray("tags");
                                JSONArray tagsArray = new JSONArray();
                                if (tagsJson != null) {
                                        for (int i=0; i<tagsJson.length(); i++) {
                                                JSONObject tagObj = tagsJson.getJSONObject(i);
                                                JSONObject t = new JSONObject();
                                                t.put("name", tagObj.optString("name", ""));
                                                String trans = tagObj.optString("translated_name", "");
                                                if (trans.equals("null")) trans = ""; 
                                                t.put("trans", trans);
                                                tagsArray.put(t);
                                        }
                                }
                                result.put("tags", tagsArray);

                                JSONArray imagesArray = new JSONArray();
                                JSONArray originalArray = new JSONArray(); // НОВЫЙ МАССИВ ДЛЯ ОРИГИНАЛОВ

                                JSONArray metaPages = ill.optJSONArray("meta_pages");
                                if (metaPages != null && metaPages.length() > 0) {
                                        for (int i = 0; i < metaPages.length(); i++) {
                                                JSONObject urls = metaPages.getJSONObject(i).optJSONObject("image_urls");
                                                if (urls != null) {
                                                        imagesArray.put(urls.optString("large", urls.optString("medium", "")));
                                                        originalArray.put(urls.optString("original", "")); // ДОБАВЛЯЕМ ОРИГИНАЛ
                                                }
                                        }
                                } else {
                                        JSONObject urls = ill.optJSONObject("image_urls");
                                        if (urls != null) imagesArray.put(urls.optString("large", urls.optString("medium", "")));

                                        JSONObject metaSingle = ill.optJSONObject("meta_single_page");
                                        if (metaSingle != null && metaSingle.has("original_image_url")) {
                                                originalArray.put(metaSingle.optString("original_image_url", ""));
                                        } else if (urls != null) {
                                                originalArray.put(urls.optString("original", urls.optString("large", "")));
                                        }
                                }
                                result.put("images", imagesArray);
                                result.put("original_images", originalArray); // ПЕРЕДАЕМ В JS

                                return Base64.encodeToString(result.toString().getBytes("UTF-8"), Base64.NO_WRAP);
                        } catch (Exception e) {
                                try {
                                        JSONObject err = new JSONObject();
                                        err.put("error", e.getMessage() != null ? e.getMessage() : "Ошибка загрузки");
                                        return Base64.encodeToString(err.toString().getBytes("UTF-8"), Base64.NO_WRAP);
                                } catch (Exception ignored) {
                                        return "";
                                }
                        }
                }
                @Override
                protected void onPostExecute(String encodedJson) {
                        sendDetailsToUI(encodedJson);
                }
        }

        private class AutocompleteTask extends AsyncTask<String, Void, String> {
                @Override
                protected String doInBackground(String... params) {
                        try {
                                String urlStr = "https://app-api.pixiv.net/v2/search/autocomplete?merge_plain_keyword_results=true&word=" + URLEncoder.encode(params[1], "UTF-8");
                                URL url = new URL(urlStr);
                                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                                conn.setRequestMethod("GET");
                                conn.setRequestProperty("Authorization", "Bearer " + params[0]);
                                addPixivApiHeaders(conn); 
                                conn.setConnectTimeout(5000);
                                conn.setReadTimeout(5000);
                                conn.setUseCaches(false);

                                if (conn.getResponseCode() >= 200 && conn.getResponseCode() < 300) {
                                        BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream()));
                                        StringBuilder res = new StringBuilder();
                                        String line;
                                        while ((line = reader.readLine()) != null) res.append(line);
                                        reader.close();
                                        return Base64.encodeToString(res.toString().getBytes("UTF-8"), Base64.NO_WRAP);
                                }
                        } catch (Exception ignored) {}
                        return "";
                }
                @Override
                protected void onPostExecute(String b64) {
                        if (b64 != null && b64.length() > 0) {
                                sendSearchResultsToUI(b64, "displayAutocomplete");
                        }
                }
        }

        private class TrendingTagsTask extends AsyncTask<String, Void, String> {
                @Override
                protected String doInBackground(String... params) {
                        try {
                                String urlStr = "https://app-api.pixiv.net/v1/trending-tags/illust";
                                URL url = new URL(urlStr);
                                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                                conn.setRequestMethod("GET");
                                conn.setRequestProperty("Authorization", "Bearer " + params[0]);
                                addPixivApiHeaders(conn); 
                                conn.setConnectTimeout(5000);
                                conn.setReadTimeout(5000);
                                conn.setUseCaches(false);

                                if (conn.getResponseCode() >= 200 && conn.getResponseCode() < 300) {
                                        BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream()));
                                        StringBuilder res = new StringBuilder();
                                        String line;
                                        while ((line = reader.readLine()) != null) res.append(line);
                                        reader.close();
                                        return Base64.encodeToString(res.toString().getBytes("UTF-8"), Base64.NO_WRAP);
                                }
                        } catch (Exception ignored) {}
                        return "";
                }
                @Override
                protected void onPostExecute(String b64) {
                        if (b64 != null && b64.length() > 0) {
                                sendSearchResultsToUI(b64, "displayTrendingTags");
                        }
                }
        }

        private void startSearchUser(String query, String nextUrl) {
                SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
                String accessToken = prefs.getString(KEY_ACCESS_TOKEN, null);
                if (accessToken == null || accessToken.length() == 0) return;
                try {
                        String baseUrl = "https://app-api.pixiv.net/v1/search/user?word=" + URLEncoder.encode(query, "UTF-8");
                        new UserSearchTask().executeOnExecutor(AsyncTask.THREAD_POOL_EXECUTOR, accessToken, baseUrl, nextUrl);
                } catch (Exception ignored) {}
        }

        private class UserSearchTask extends AsyncTask<String, Void, String> {
                @Override
                protected String doInBackground(String... params) {
                        String token = params[0];
                        String baseUrl = params[1];
                        String nextUrlStr = params[2];

                        for (int retry = 0; retry < 3; retry++) {
                                HttpURLConnection conn = null;
                                try {
                                        String urlStr = (nextUrlStr != null && nextUrlStr.startsWith("http")) ? nextUrlStr : baseUrl;
                                        URL url = new URL(urlStr);
                                        conn = (HttpURLConnection) url.openConnection();
                                        conn.setRequestMethod("GET");
                                        conn.setRequestProperty("Authorization", "Bearer " + token);
                                        addPixivApiHeaders(conn);
                                        conn.setConnectTimeout(10000);
                                        conn.setReadTimeout(10000);

                                        int responseCode = conn.getResponseCode();
                                        if (responseCode >= 200 && responseCode < 300) {
                                                BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream()));
                                                StringBuilder res = new StringBuilder();
                                                String line;
                                                while ((line = reader.readLine()) != null) res.append(line);
                                                reader.close();

                                                JSONObject root = new JSONObject(res.toString());
                                                String nextUrlReturned = root.isNull("next_url") ? "" : root.optString("next_url", "");

                                                JSONArray userPreviews = root.optJSONArray("user_previews");
                                                JSONArray resultsArray = new JSONArray();
                                                if (userPreviews != null) {
                                                        for (int i = 0; i < userPreviews.length(); i++) {
                                                                JSONObject preview = userPreviews.getJSONObject(i);
                                                                JSONObject user = preview.optJSONObject("user");
                                                                if (user == null) continue;

                                                                JSONObject item = new JSONObject();
                                                                item.put("id", String.valueOf(user.optInt("id")));
                                                                item.put("name", user.optString("name", "Без имени"));

                                                                JSONObject profileImg = user.optJSONObject("profile_image_urls");
                                                                item.put("avatar", profileImg != null ? profileImg.optString("medium", "") : "");

                                                                resultsArray.put(item);
                                                        }
                                                }

                                                JSONObject finalResult = new JSONObject();
                                                finalResult.put("results", resultsArray);
                                                finalResult.put("next_url", nextUrlReturned);

                                                return Base64.encodeToString(finalResult.toString().getBytes("UTF-8"), Base64.NO_WRAP);
                                        } else if (responseCode == 429) { 
                                                Thread.sleep(1500); 
                                        } else if (responseCode >= 500) {
                                                Thread.sleep(1000);
                                        } else {
                                                break; 
                                        }
                                } catch (Exception e) {
                                        try { Thread.sleep(1000); } catch (Exception ignored) {}
                                } finally {
                                        if (conn != null) { try { conn.disconnect(); } catch (Exception ignored) {} }
                                }
                        }
                        try { return Base64.encodeToString("{\"results\":[],\"next_url\":\"\"}".getBytes("UTF-8"), Base64.NO_WRAP); } catch(Exception e) { return ""; }
                }
                @Override
                protected void onPostExecute(String b64) {
                        sendSearchResultsToUI(b64, "displayUserSearchResults");
                }
        }

        private void startToggleBookmark(final String illustId, final boolean isAdd) {
                new Thread(new Runnable() {
                                @Override
                                public void run() {
                                        try {
                                                SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
                                                String token = prefs.getString(KEY_ACCESS_TOKEN, null);
                                                if (token == null) return;

                                                String urlStr = isAdd ? "https://app-api.pixiv.net/v2/illust/bookmark/add" : "https://app-api.pixiv.net/v1/illust/bookmark/delete";
                                                URL url = new URL(urlStr);
                                                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                                                conn.setRequestMethod("POST");
                                                conn.setRequestProperty("Authorization", "Bearer " + token);
                                                conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
                                                addPixivApiHeaders(conn);
                                                conn.setDoOutput(true);

                                                String body = "illust_id=" + illustId + (isAdd ? "&restrict=public" : "");
                                                OutputStream os = conn.getOutputStream();
                                                os.write(body.getBytes("UTF-8"));
                                                os.flush(); os.close();

                                                int code = conn.getResponseCode();
                                                if(code < 200 || code >= 300) {
                                                        runJs("revertBookmarkUI('" + illustId + "', " + isAdd + ");");
                                                }
                                        } catch(Exception e) {
                                                runJs("revertBookmarkUI('" + illustId + "', " + isAdd + ");");
                                        }
                                }
                        }).start();
        }

        // ==========================================
        // ЛОГИКА ЗАГРУЗКИ ПРЕВЬЮ (С ОЧЕРЕДЬЮ)
        // ==========================================
        private void startAutoPreviewFromInput(String input) {
                String illustId = extractIllustId(input);

                if (illustId == null || illustId.isEmpty()) {
                        updateUIPreview(null, "Вставьте ссылку на работу");
                        lastPreviewIllustId = "";
                        return;
                }

                SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
                String accessToken = prefs.getString(KEY_ACCESS_TOKEN, null);
                if (accessToken == null) return;

                // Если это превью уже загружено или грузится прямо сейчас - игнорируем
                if (illustId.equals(lastPreviewIllustId)) return; 

                // Если есть старая задача (мы быстро стираем и пишем новую ссылку) - отменяем её
                if (currentPreviewTask != null) {
                        currentPreviewTask.cancel(true);
                }

                lastPreviewIllustId = illustId;
                updateUIPreview(null, "Загрузка превью...");

                currentPreviewTask = new AutoPreviewTask();
                // Запускаем через нашу очередь (по 1 за раз), а не через общий пул!
                currentPreviewTask.executeOnExecutor(previewExecutor, accessToken, illustId);
        }

        private class AutoPreviewTask extends AsyncTask<String, Void, Object[]> {
                @Override
                protected Object[] doInBackground(String... params) {
                        // Постоянно проверяем isCancelled(), чтобы быстро убить задачу, если пользователь ввел другую ссылку
                        if (isCancelled()) return null; 

                        try {
                                String token = params[0];
                                String illustId = params[1];

                                JSONObject detail = getIllustDetailJson(token, illustId);
                                if (detail == null || isCancelled()) return null;

                                if (!detail.has("illust")) {
                                        return new Object[]{null, "Работа скрыта или удалена"};
                                }

                                JSONObject ill = detail.getJSONObject("illust");
                                String title = ill.optString("title", "Без названия");
                                JSONObject user = ill.optJSONObject("user");
                                String author = user != null ? user.optString("name", "Неизвестен") : "Неизвестен";
                                String meta = title + "\nАвтор: " + author;

                                String thumbUrl = getPreviewImageUrl(ill);
                                if (thumbUrl == null || isCancelled()) return new Object[]{null, meta};

                                Bitmap bmp = downloadBitmap(thumbUrl);
                                if (isCancelled()) return null;

                                return new Object[]{bmp, meta};
                        } catch (Exception e) {
                                return new Object[]{null, "Ошибка сети"};
                        }
                }

                @Override
                protected void onPostExecute(Object[] result) {
                        if (isCancelled() || result == null) return;
                        Bitmap bmp = (Bitmap) result[0];
                        String meta = (String) result[1];
                        updateUIPreview(bmp, meta);
                }
        }

        private void loadSavedUserAndRefreshTokenIfPossible() {
                SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
                String refreshToken = prefs.getString(KEY_REFRESH_TOKEN, null);
                String userId = prefs.getString(KEY_USER_ID, "");
                String userName = prefs.getString(KEY_USER_NAME, "");
                String userAvatar = prefs.getString(KEY_USER_AVATAR, "");

                // Возвращаем сохранённые куки активного аккаунта в живой jar ДО любых срезов
                // (refresh/profile вызовут saveAccountToCache; без этого срез был бы неполным
                // и затирал бы хорошую куку, напр. настройку R-18).
                restoreActiveAccountCookies();

                if (refreshToken != null && refreshToken.length() > 0) {
                        updateUIAccount(userName, userId, "Авторизовано (обновляем токен)", true, userAvatar); 
                        new RefreshTokenTask(false).executeOnExecutor(AsyncTask.THREAD_POOL_EXECUTOR, refreshToken);
                } else {
                        updateUIAccount("", "", "Вход не выполнен, проверьте подключение к интернету", false, "");
                }
        }

        private void showAuthLoader() {
                if (authLoader == null) return;
                authLoader.animate().cancel();
                authLoader.setAlpha(1f);
                authLoader.setVisibility(View.VISIBLE);
                if (authLoaderLogo != null) {
                        // Плавная пульсация логотипа, как на стартовом экране приложения
                        android.view.animation.AlphaAnimation pulse = new android.view.animation.AlphaAnimation(1f, 0.4f);
                        pulse.setDuration(750);
                        pulse.setRepeatMode(android.view.animation.Animation.REVERSE);
                        pulse.setRepeatCount(android.view.animation.Animation.INFINITE);
                        authLoaderLogo.startAnimation(pulse);
                }
        }

        private void hideAuthLoader() {
                if (authLoader == null || authLoader.getVisibility() != View.VISIBLE) return;
                authLoader.animate().alpha(0f).setDuration(350).withEndAction(new Runnable() {
                                @Override
                                public void run() {
                                        authLoader.setVisibility(View.GONE);
                                        if (authLoaderLogo != null) authLoaderLogo.clearAnimation();
                                }
                        }).start();
        }

        // Достаёт сохранённую строку куки конкретного аккаунта из "сейфа".
        private String getSavedCookieForId(String id) {
                if (id == null || id.isEmpty()) return "";
                SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
                String json = prefs.getString("saved_accounts_list", "[]");
                try {
                        JSONArray arr = new JSONArray(json);
                        for (int i = 0; i < arr.length(); i++) {
                                JSONObject obj = arr.optJSONObject(i);
                                if (obj != null && obj.optString("id").equals(id)) {
                                        return obj.optString("cookie", "");
                                }
                        }
                } catch (Exception e) {}
                return "";
        }

        // Инъекция строки "имя=значение; ..." во все зеркала Pixiv.
        private void injectCookieString(android.webkit.CookieManager cm, String savedCookie) {
                if (savedCookie == null || savedCookie.isEmpty()) return;
                cm.setAcceptCookie(true);
                String[] cookies = savedCookie.split(";");
                for (String c : cookies) {
                        String clean = c.trim();
                        if (!clean.isEmpty()) {
                                cm.setCookie("https://pixiv.net", clean);
                                cm.setCookie("https://www.pixiv.net", clean);
                                cm.setCookie("https://secure.pixiv.net", clean);
                                cm.setCookie("https://accounts.pixiv.net", clean);
                                cm.setCookie("https://app-api.pixiv.net", clean);
                        }
                }
        }

        // Возвращает в живой CookieManager куки активного аккаунта из "сейфа".
        // Нужно при отмене добавления аккаунта: startPixivLogin стирает все куки,
        // и без восстановления веб-сессия (в т.ч. настройки R-18) текущего аккаунта теряется.
        // ВАЖНО: removeAllCookies на API 21+ асинхронный — инжектим строго в его колбэке,
        // иначе незавершённое удаление затрёт только что восстановленные куки (это и был баг
        // при "Добавить аккаунт" -> "Назад": очистка из startPixivLogin догоняла восстановление).
        private void restoreActiveAccountCookies() {
                SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
                String currentId = prefs.getString(KEY_USER_ID, "");
                final String savedCookie = getSavedCookieForId(currentId);
                if (savedCookie == null || savedCookie.isEmpty()) return;

                final android.webkit.CookieManager cm = android.webkit.CookieManager.getInstance();
                cm.setAcceptCookie(true);
                if (Build.VERSION.SDK_INT >= 21) {
                        // Сначала дочищаем любые "анонимные" куки страницы логина, ПОТОМ инжектим — в колбэке
                        cm.removeAllCookies(new ValueCallback<Boolean>() {
                                @Override
                                public void onReceiveValue(Boolean value) {
                                        injectCookieString(cm, savedCookie);
                                        cm.flush();
                                }
                        });
                } else {
                        cm.removeAllCookie();
                        injectCookieString(cm, savedCookie);
                }
        }

        private void startPixivLogin() {
        try {
            // СОХРАНЯЕМ ТЕКУЩИЙ АККАУНТ В СЕЙФ
            SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
            String currentId = prefs.getString(KEY_USER_ID, "");
            saveAccountToCache(currentId, prefs.getString(KEY_USER_NAME, ""), prefs.getString(KEY_USER_AVATAR, ""));

            // ОЧИЩАЕМ КУКИ, ЧТОБЫ ВОЙТИ В НОВЫЙ АККАУНТ
            android.webkit.CookieManager cookieManager = android.webkit.CookieManager.getInstance();
            if (Build.VERSION.SDK_INT >= 21) {
                cookieManager.removeAllCookies(null);
                cookieManager.flush();
            } else {
                cookieManager.removeAllCookie();
            }

            authCodeUsed = false;
            codeVerifier = generateCodeVerifier();
            String codeChallenge = generateCodeChallenge(codeVerifier);

            String url = LOGIN_URL + "?code_challenge=" + urlEncode(codeChallenge)
                + "&code_challenge_method=S256&client=pixiv-android";

            updateUIStatus("Открыт вход Pixiv...");
            authWebView.setVisibility(View.VISIBLE);
            showAuthLoader();

            authWebView.setWebViewClient(new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView view, String url) {
                        return handleCallbackUrl(url);
                    }
                    @Override
                    public void onPageFinished(WebView view, String url) {
                        handleCallbackUrl(url);
                    }
                });
            authWebView.loadUrl(url);
        } catch (Exception e) {
            updateUIStatus("Ошибка запуска входа: " + e.toString());
            }
        }

        private boolean handleCallbackUrl(String url) {
                if (url == null) return false;
                if (url.startsWith(REDIRECT_URI)) {
                        if (authCodeUsed) return true;
                        Uri uri = Uri.parse(url);
                        String code = uri.getQueryParameter("code");
                        if (code != null && code.length() > 0) {
                                authCodeUsed = true;
                                updateUIStatus("Код получен. Получаем токен...");
                                authWebView.stopLoading();
                                authWebView.setVisibility(View.GONE);
                                hideAuthLoader();
                                new AuthorizationCodeTokenTask().executeOnExecutor(AsyncTask.THREAD_POOL_EXECUTOR, code);
                                return true;
                        }
                }
                return false;
        }

        private class AuthorizationCodeTokenTask extends AsyncTask<String, Void, String> {
                private String error;
                @Override
                protected String doInBackground(String... params) {
                        try {
                                String body = "client_id=" + urlEncode(CLIENT_ID) + "&client_secret=" + urlEncode(CLIENT_SECRET)
                                        + "&grant_type=authorization_code&code=" + urlEncode(params[0])
                                        + "&code_verifier=" + urlEncode(codeVerifier) + "&redirect_uri=" + urlEncode(REDIRECT_URI) + "&include_policy=true";
                                return postPixivTokenRequest(body);
                        } catch (Exception e) {
                                error = e.toString();
                                return null;
                        }
                }

                @Override
                protected void onPostExecute(String result) {
                        if (result == null) {
                                updateUIStatus("Ошибка входа: " + error);
                                authCodeUsed = false;
                                return;
                        }
                        if (saveTokenResponse(result)) {
                                authWebView.loadUrl("about:blank");
                                authWebView.setVisibility(View.GONE);
                                hideAuthLoader();
                                SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
                                updateUIAccount(prefs.getString(KEY_USER_NAME, ""), prefs.getString(KEY_USER_ID, ""), "✓ Аккаунт активен", true, "");
                                updateUIStatus("Успешный вход! Получаем данные профиля...");
                                new AccountTask().executeOnExecutor(AsyncTask.THREAD_POOL_EXECUTOR, prefs.getString(KEY_ACCESS_TOKEN, ""), prefs.getString(KEY_USER_ID, "")); 
                                Toast.makeText(MainActivity.this, "Успешный вход", Toast.LENGTH_SHORT).show();
                        }
                }

                private String postPixivTokenRequest(String body) {
                        try {
                                URL url = new URL(TOKEN_URL);
                                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                                conn.setRequestMethod("POST");
                                conn.setDoOutput(true);
                                conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
                                conn.setRequestProperty("User-Agent", USER_AGENT);
                                conn.setRequestProperty("App-OS", APP_OS);
                                conn.setRequestProperty("App-OS-Version", APP_OS_VERSION);
                                conn.setRequestProperty("App-Version", APP_VERSION);
                                conn.setUseCaches(false);

                                OutputStream os = conn.getOutputStream();
                                os.write(body.getBytes("UTF-8"));
                                os.flush();
                                os.close();

                                int responseCode = conn.getResponseCode();
                                BufferedReader reader;
                                if (responseCode >= 200 && responseCode < 300) {
                                        reader = new BufferedReader(new InputStreamReader(conn.getInputStream()));
                                } else {
                                        reader = new BufferedReader(new InputStreamReader(conn.getErrorStream()));
                                }

                                StringBuilder res = new StringBuilder();
                                String line;
                                while ((line = reader.readLine()) != null) {
                                        res.append(line);
                                }
                                reader.close();

                                if (responseCode >= 200 && responseCode < 300) {
                                        return res.toString();
                                } else {
                                        error = "HTTP " + responseCode;
                                        return null;
                                }
                        } catch (Exception e) {
                                error = e.toString();
                                return null;
                        }
                }
        }

        private void refreshAccessTokenManually() {
                SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
                String refreshToken = prefs.getString(KEY_REFRESH_TOKEN, null);
                if (refreshToken == null || refreshToken.length() == 0) {
                        updateUIStatus("Refresh token отсутствует. Нужно войти заново.");
                        return;
                }
                updateUIStatus("Обновляем access token...");
                new RefreshTokenTask(true).executeOnExecutor(AsyncTask.THREAD_POOL_EXECUTOR, refreshToken);
        }

        private class RefreshTokenTask extends AsyncTask<String, Void, String> {
        private String error;
        private boolean showToast;
        private int httpCode = -1; // Сохраняем HTTP код ответа
        private String usedToken;  // Сохраняем токен для ретрая

        public RefreshTokenTask(boolean showToast) { this.showToast = showToast; }

        @Override
        protected String doInBackground(String... params) {
            usedToken = params[0];
            try {
                String body = "client_id=" + urlEncode(CLIENT_ID) + "&client_secret=" + urlEncode(CLIENT_SECRET)
                    + "&grant_type=refresh_token&refresh_token=" + urlEncode(usedToken) + "&include_policy=true";

                URL url = new URL(TOKEN_URL);
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("POST");
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
                conn.setRequestProperty("User-Agent", USER_AGENT);
                conn.setRequestProperty("App-OS", APP_OS);
                conn.setRequestProperty("App-OS-Version", APP_OS_VERSION);
                conn.setRequestProperty("App-Version", APP_VERSION);
                conn.setConnectTimeout(8000); // Таймаут 8 сек
                conn.setReadTimeout(8000);
                conn.setUseCaches(false);

                OutputStream os = conn.getOutputStream();
                os.write(body.getBytes("UTF-8"));
                os.flush();
                os.close();

                httpCode = conn.getResponseCode();
                BufferedReader reader;
                if (httpCode >= 200 && httpCode < 300) {
                    reader = new BufferedReader(new InputStreamReader(conn.getInputStream()));
                } else {
                    reader = new BufferedReader(new InputStreamReader(conn.getErrorStream()));
                }

                StringBuilder res = new StringBuilder();
                String line;
                while ((line = reader.readLine()) != null) {
                    res.append(line);
                }
                reader.close();

                if (httpCode >= 200 && httpCode < 300) {
                    return res.toString();
                } else {
                    error = "HTTP " + httpCode;
                    return null;
                }
            } catch (Exception e) {
                error = e.toString();
                return null;
            }
        }

        @Override
        protected void onPostExecute(String result) {
            SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
            String uName = prefs.getString(KEY_USER_NAME, "");
            String uId = prefs.getString(KEY_USER_ID, "");
            String uAv = prefs.getString(KEY_USER_AVATAR, "");

            if (result == null) {
                // ЕслиPixiv прямо сказал, что токен недействителен (400 Bad Request)
                if (httpCode == 400 || httpCode == 401) {
                    updateUIStatus("Токен сброшен. Войдите заново.");
                    updateUIAccount(uName, uId, "✗ Требуется авторизация", false, uAv);
                } else {
                    // Любая другая проблема (нет интернета, таймаут, сервер упал)
                    updateUIStatus("Нет сети. Ожидание подключения...");
                    // КРИТИЧЕСКИ ВАЖНО: передаем true, чтобы UI не ломался и ждал
                    updateUIAccount(uName, uId, "⚠ Ожидание сети...", true, uAv);

                    // Умный ретрай: повторяем попытку через 5 секунд в фоне
                    new Handler(Looper.getMainLooper()).postDelayed(new Runnable() {
                            @Override
                            public void run() {
                                new RefreshTokenTask(false).executeOnExecutor(AsyncTask.THREAD_POOL_EXECUTOR, usedToken);
                            }
                        }, 5000);
                }
                return;
            }

            if (saveTokenResponse(result)) {
                updateUIAccount(prefs.getString(KEY_USER_NAME, ""), prefs.getString(KEY_USER_ID, ""), "✓ Аккаунт активен", true, prefs.getString(KEY_USER_AVATAR, ""));
                updateUIStatus("Access token успешно обновлён.");
                new AccountTask().executeOnExecutor(AsyncTask.THREAD_POOL_EXECUTOR, prefs.getString(KEY_ACCESS_TOKEN, ""), prefs.getString(KEY_USER_ID, ""));
                if (showToast) Toast.makeText(MainActivity.this, "Токен обновлён", Toast.LENGTH_SHORT).show();
            }
        }
    }

    private class AccountTask extends AsyncTask<String, Void, String> {
        private String error;
        private int httpCode = -1;
        private String usedAccessToken;
        private String usedUserId;

        @Override
        protected String doInBackground(String... params) {
            usedAccessToken = params[0];
            usedUserId = params[1];
            try {
                URL url = new URL("https://app-api.pixiv.net/v1/user/detail?user_id=" + usedUserId);
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("GET");
                conn.setRequestProperty("Authorization", "Bearer " + usedAccessToken);
                addPixivApiHeaders(conn);
                conn.setConnectTimeout(8000);
                conn.setReadTimeout(8000);
                conn.setUseCaches(false);

                httpCode = conn.getResponseCode();
                BufferedReader reader;
                if (httpCode >= 200 && httpCode < 300) {
                    reader = new BufferedReader(new InputStreamReader(conn.getInputStream()));
                } else {
                    reader = new BufferedReader(new InputStreamReader(conn.getErrorStream()));
                }

                StringBuilder res = new StringBuilder();
                String line;
                while ((line = reader.readLine()) != null) {
                    res.append(line);
                }
                reader.close();

                if (httpCode >= 200 && httpCode < 300) {
                    return res.toString();
                } else {
                    error = "HTTP " + httpCode;
                    return null;
                }
            } catch (Exception e) {
                error = e.toString();
                return null;
            }
        }

        @Override
        protected void onPostExecute(String result) {
            SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);

            if (result == null) {
                if (httpCode == 400 || httpCode == 401) {
                    updateUIStatus("Ошибка проверки. Токен недействителен.");
                    updateUIAccount(prefs.getString(KEY_USER_NAME, ""), prefs.getString(KEY_USER_ID, ""), "✗ Ошибка профиля", false, prefs.getString(KEY_USER_AVATAR, ""));
                } else {
                    updateUIStatus("Проверка профиля отложена (нет сети).");
                    // Оставляем аккаунт рабочим, просто профиль не обновился прямо сейчас
                }
                return;
            }
            try {
                JSONObject user = new JSONObject(result).getJSONObject("user");
                String id = user.optString("id", "");
                String name = user.optString("name", "");

                String avatarUrl = "";
                if(user.has("profile_image_urls")){
                    avatarUrl = user.getJSONObject("profile_image_urls").optString("medium", "");
                }

                prefs.edit()
                    .putString(KEY_USER_ID, id)
                    .putString(KEY_USER_NAME, name)
                    .putString(KEY_USER_AVATAR, avatarUrl) 
                    .apply();

                saveAccountToCache(id, name, avatarUrl);

                updateUIAccount(name, id, "Аккаунт работает", true, avatarUrl); 
                updateUIStatus("Аккаунт проверен успешно.");
            } catch (Exception e) {
                updateUIStatus("Ошибка разбора ответа профиля.");
            }
        }
    }

        private boolean saveTokenResponse(String result) {
                try {
                        JSONObject json = new JSONObject(result);
                        JSONObject response = json.getJSONObject("response");
                        String accessToken = response.getString("access_token");
                        String refreshToken = response.getString("refresh_token");
                        String userId = "";
                        String userName = "";
                        if (response.has("user")) {
                                JSONObject user = response.getJSONObject("user");
                                userId = user.optString("id", "");
                                userName = user.optString("name", "");
                        }
                        SharedPreferences.Editor editor = getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit();
                        editor.putString(KEY_ACCESS_TOKEN, accessToken);
                        editor.putString(KEY_REFRESH_TOKEN, refreshToken);
                        if (userId.length() > 0) {
                                editor.putString(KEY_USER_ID, userId);
                        }
                        if (userName.length() > 0) {
                                editor.putString(KEY_USER_NAME, userName);
                        }
                        editor.apply();
            // ДОБАВИТЬ ЭТУ СТРОКУ:
            saveAccountToCache(userId, userName, ""); 
            return true;
                } catch (Exception e) {
                        updateUIStatus("Ошибка разбора токена");
                        return false;
                }
        }

        private void checkPixivAccount() {
                SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
                String accessToken = prefs.getString(KEY_ACCESS_TOKEN, null);
                String userId = prefs.getString(KEY_USER_ID, null);

                if (accessToken == null || userId == null) {
                        updateUIStatus("Access token или ID отсутствует. Войдите заново, либо проверьте подключение к интернету.");
                        return;
                }
                updateUIStatus("Проверяем аккаунт...");
                new AccountTask().executeOnExecutor(AsyncTask.THREAD_POOL_EXECUTOR, accessToken, userId);
        }

        
        
        
    // Разбирает строку "a=b; c=d" и кладёт пары в карту (имя -> значение).
    // Более поздние вызовы перетирают значение того же имени — это используется
    // для слияния: сначала старые сохранённые куки, потом свежие из живого jar.
    private void mergeCookieString(java.util.Map<String, String> map, String cookieStr) {
        if (cookieStr == null) return;
        String[] parts = cookieStr.split(";");
        for (String p : parts) {
            String t = p.trim();
            if (t.isEmpty()) continue;
            int eq = t.indexOf('=');
            if (eq <= 0) continue;
            String k = t.substring(0, eq).trim();
            String v = t.substring(eq + 1).trim();
            if (!k.isEmpty()) map.put(k, v);
        }
    }

    // Файл резервной копии лежит в публичной папке Downloads/PixivDL_Backup
    // (вне приватного каталога приложения), поэтому не удаляется при переустановке.
    // Downloads уже используется приложением для загрузок и гарантированно доступен на запись.
    private File getBackupFile() {
        File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "PixivDL_Backup");
        return new File(dir, "pixivdl_backup.json");
    }

    private String safeStr(String s) {
        return s == null ? "" : s;
    }

    // Читает и парсит файл резервной копии. Возвращает null, если файла нет.
    private JSONObject readBackupRoot() throws Exception {
        File f = getBackupFile();
        if (!f.exists()) return null;
        StringBuilder sb = new StringBuilder();
        BufferedReader br = new BufferedReader(new InputStreamReader(new java.io.FileInputStream(f), "UTF-8"));
        String line;
        while ((line = br.readLine()) != null) sb.append(line);
        br.close();
        return new JSONObject(sb.toString());
    }

    // Восстанавливает SharedPreferences из распарсенного бэкапа (с сохранением типов).
    private void restorePrefsFromBackup(JSONObject root) {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        SharedPreferences.Editor ed = prefs.edit();
        JSONObject prefsObj = root.optJSONObject("prefs");
        if (prefsObj != null) {
            java.util.Iterator<String> keys = prefsObj.keys();
            while (keys.hasNext()) {
                String k = keys.next();
                JSONObject cell = prefsObj.optJSONObject(k);
                if (cell == null) continue;
                String t = cell.optString("t", "s");
                if ("b".equals(t)) ed.putBoolean(k, cell.optBoolean("v"));
                else if ("i".equals(t)) ed.putInt(k, cell.optInt("v"));
                else if ("l".equals(t)) ed.putLong(k, cell.optLong("v"));
                else if ("f".equals(t)) ed.putFloat(k, (float) cell.optDouble("v"));
                else ed.putString(k, cell.optString("v"));
            }
        }
        ed.apply();
    }

    // Делает указанный аккаунт активным: переносит токены в активные ключи и
    // инжектит его куки. Аккаунт берётся из saved_accounts_list (уже в prefs).
    private void activateSavedAccount(String targetId) {
        if (targetId == null || targetId.isEmpty()) return;
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        try {
            JSONArray arr = new JSONArray(prefs.getString("saved_accounts_list", "[]"));
            for (int i = 0; i < arr.length(); i++) {
                JSONObject obj = arr.optJSONObject(i);
                if (obj == null || !obj.optString("id").equals(targetId)) continue;
                prefs.edit()
                        .putString(KEY_USER_ID, targetId)
                        .putString(KEY_USER_NAME, obj.optString("name"))
                        .putString(KEY_USER_AVATAR, obj.optString("avatar"))
                        .putString(KEY_ACCESS_TOKEN, obj.optString("access_token"))
                        .putString(KEY_REFRESH_TOKEN, obj.optString("refresh_token"))
                        .apply();

                final String savedCookie = obj.optString("cookie", "");
                final android.webkit.CookieManager cm = android.webkit.CookieManager.getInstance();
                cm.setAcceptCookie(true);
                if (Build.VERSION.SDK_INT >= 21) {
                    cm.removeAllCookies(new ValueCallback<Boolean>() {
                        @Override public void onReceiveValue(Boolean value) {
                            injectCookieString(cm, savedCookie);
                            cm.flush();
                        }
                    });
                } else {
                    cm.removeAllCookie();
                    injectCookieString(cm, savedCookie);
                }
                break;
            }
        } catch (Exception e) { e.printStackTrace(); }
    }

    private void saveAccountToCache(String id, String name, String avatarUrl) {
        if (id == null || id.isEmpty()) return;
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        String access = prefs.getString(KEY_ACCESS_TOKEN, "");
        String refresh = prefs.getString(KEY_REFRESH_TOKEN, "");

        // 1. Принудительно сбрасываем кэш WebView, чтобы куки точно записались
        android.webkit.CookieManager cookieManager = android.webkit.CookieManager.getInstance();
        if (Build.VERSION.SDK_INT >= 21) {
            cookieManager.flush();
        }

        // 2. Собираем куки со всех поддоменов авторизации Pixiv
        String c1 = cookieManager.getCookie("https://pixiv.net");
        String c2 = cookieManager.getCookie("https://www.pixiv.net");
        String c3 = cookieManager.getCookie("https://secure.pixiv.net");
        String c4 = cookieManager.getCookie("https://accounts.pixiv.net");

        String json = prefs.getString("saved_accounts_list", "[]");
        try {
            JSONArray arr = new JSONArray(json);

            // Находим существующую запись аккаунта (ссылка внутри массива — правки видны в arr)
            JSONObject target = null;
            for (int i = 0; i < arr.length(); i++) {
                JSONObject obj = arr.optJSONObject(i);
                if (obj != null && obj.optString("id").equals(id)) { target = obj; break; }
            }

            // 3. СЛИЯНИЕ, а не перезапись: сначала ранее сохранённые куки (чтобы ничего не потерять,
            // напр. настройку R-18), затем накладываем свежие из живого jar (свежие побеждают).
            java.util.LinkedHashMap<String, String> map = new java.util.LinkedHashMap<String, String>();
            if (target != null) mergeCookieString(map, target.optString("cookie", ""));
            mergeCookieString(map, c1);
            mergeCookieString(map, c2);
            mergeCookieString(map, c3);
            mergeCookieString(map, c4);

            StringBuilder sb = new StringBuilder();
            for (java.util.Map.Entry<String, String> e : map.entrySet()) {
                if (sb.length() > 0) sb.append("; ");
                sb.append(e.getKey()).append("=").append(e.getValue());
            }
            String finalCookie = sb.toString();

            if (target != null) {
                if (name != null && !name.isEmpty()) target.put("name", name);
                if (avatarUrl != null && !avatarUrl.isEmpty()) target.put("avatar", avatarUrl);
                // Токены обновляем ТОЛЬКО если они непустые — иначе затрём валидную сохранённую
                // сессию пустыми значениями (баг: аккаунт, который "выпал", становился незаходимым)
                if (access != null && !access.isEmpty()) target.put("access_token", access);
                if (refresh != null && !refresh.isEmpty()) target.put("refresh_token", refresh);
                // Сохраняем только если в итоге есть что сохранять (слияние гарантирует, что
                // мы не затрём хорошую куку пустой/частичной)
                if (finalCookie.length() > 5) target.put("cookie", finalCookie);
            } else {
                JSONObject obj = new JSONObject();
                obj.put("id", id);
                obj.put("name", name != null && !name.isEmpty() ? name : "Гость");
                obj.put("avatar", avatarUrl != null ? avatarUrl : "");
                obj.put("access_token", access);
                obj.put("refresh_token", refresh);
                obj.put("cookie", finalCookie);
                arr.put(obj);
            }
            prefs.edit().putString("saved_accounts_list", arr.toString()).apply();
        } catch (Exception e) {}
    }
       
    

        private JSONObject getIllustDetailJson(String accessToken, String illustId) {
                for (int retry = 0; retry < 3; retry++) {
                        HttpURLConnection conn = null;
                        try {
                                URL url = new URL("https://app-api.pixiv.net/v1/illust/detail?illust_id=" + illustId);
                                conn = (HttpURLConnection) url.openConnection();
                                conn.setRequestMethod("GET");
                                conn.setRequestProperty("Authorization", "Bearer " + accessToken);
                                addPixivApiHeaders(conn);
                                conn.setConnectTimeout(10000);
                                conn.setReadTimeout(10000);
                                conn.setUseCaches(false);

                                if (conn.getResponseCode() >= 200 && conn.getResponseCode() < 300) {
                                        BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream()));
                                        StringBuilder res = new StringBuilder();
                                        String line;
                                        while ((line = reader.readLine()) != null) res.append(line);
                                        reader.close();
                                        return new JSONObject(res.toString());
                                } else if (conn.getResponseCode() == 429) { 
                                        Thread.sleep(2000);
                                } else if (conn.getResponseCode() >= 500) { 
                                        Thread.sleep(1000);
                                } else {
                                        return null;
                                }
                        } catch (Exception e) {
                                try { Thread.sleep(1000); } catch (Exception ignored) {}
                        } finally {
                                if (conn != null) {
                                        try { conn.disconnect(); } catch (Exception ignored) {}
                                }
                        }
                }
                return null;
        }

        private String getPreviewImageUrl(JSONObject illust) {
                try {
                        JSONObject imageUrls = illust.optJSONObject("image_urls");
                        if (imageUrls != null) {
                                if (imageUrls.optString("medium", "").length() > 0) return imageUrls.optString("medium");
                                if (imageUrls.optString("large", "").length() > 0) return imageUrls.optString("large");
                        }
                        JSONArray metaPages = illust.optJSONArray("meta_pages");
                        if (metaPages != null && metaPages.length() > 0) {
                                JSONObject pageImageUrls = metaPages.getJSONObject(0).optJSONObject("image_urls");
                                if (pageImageUrls != null) {
                                        if (pageImageUrls.optString("medium", "").length() > 0) return pageImageUrls.optString("medium");
                                }
                        }
                } catch (Exception ignored) {}
                return null;
        }

        private Bitmap downloadBitmap(String imageUrl) {
                try {
                        InputStream is = openPixivImageStream(imageUrl);
                        if (is != null) {
                                Bitmap bmp = BitmapFactory.decodeStream(is);
                                is.close();
                                return bmp;
                        }
                } catch (Exception ignored) {}
                return null;
        }

        private void copyStream(InputStream is, OutputStream os) throws Exception {
                byte[] buffer = new byte[8192];
                int count;
                while ((count = is.read(buffer)) != -1) {
                        os.write(buffer, 0, count);
                }
                os.flush();
        }

        private void addPixivApiHeaders(HttpURLConnection conn) {
                conn.setRequestProperty("User-Agent", USER_AGENT);
                conn.setRequestProperty("App-OS", APP_OS);
                conn.setRequestProperty("App-OS-Version", APP_OS_VERSION);
                conn.setRequestProperty("App-Version", APP_VERSION);
                // ВОТ ЭТА СТРОЧКА ЗАСТАВИТ PIXIV ПРИСЫЛАТЬ ПЕРЕВОДЫ ТЕГОВ И ОПИСАНИЙ:
                conn.setRequestProperty("Accept-Language", "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7");
        }
        
        private void startDiscovery(String nextUrl, String ageFilter) {
                SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
                String accessToken = prefs.getString(KEY_ACCESS_TOKEN, null);
                String userId = prefs.getString(KEY_USER_ID, null);
                if (accessToken == null || userId == null || accessToken.length() == 0) return;

                new DiscoveryTask(ageFilter).executeOnExecutor(AsyncTask.THREAD_POOL_EXECUTOR, accessToken, userId, nextUrl);
        }

        private class DiscoveryTask extends AsyncTask<String, Void, String> {
                private String ageFilter; // фильтр раздела "Может понравиться": all | safe | r18
                private String callbackName = "displayDiscovery"; // куда отдать результат (страница Discovery или лента главной)

                public DiscoveryTask(String ageFilter) {
                        this.ageFilter = (ageFilter == null) ? "all" : ageFilter;
                }

                public DiscoveryTask(String ageFilter, String cb) {
                        this.ageFilter = (ageFilter == null) ? "all" : ageFilter;
                        if (cb != null && cb.length() > 0) this.callbackName = cb;
                }

                @Override
                protected String doInBackground(String... params) {
                        String token = params[0];
                        String userId = params[1];

                        // Страница "Может понравиться" — алгоритм с состоянием (мультисид -> похожие ->
                        // дедуп по списку результатов -> перемешать -> 30). Лента на главной ("suggested")
                        // остаётся простой: один случайный сид -> похожие, без состояния и фильтра.
                        if ("displayDiscovery".equals(callbackName)) {
                                return buildDiscoveryFeed(token, userId);
                        }
                        return buildSimpleSuggested(token, userId);
                }

                // --- Простая лента для главной: 1 случайная закладка -> похожие на неё ---
                private String buildSimpleSuggested(String token, String userId) {
                        try {
                                String seedUrl = "https://app-api.pixiv.net/v1/user/bookmarks/illust?user_id=" + userId + "&restrict=public";
                                String seedRes = callPixivApiSync(seedUrl, token);
                                if (seedRes == null) throw new Exception();

                                JSONArray seedIllusts = new JSONObject(seedRes).optJSONArray("illusts");
                                if (seedIllusts == null || seedIllusts.length() == 0) throw new Exception();

                                int rSeed = new SecureRandom().nextInt(seedIllusts.length());
                                String seedId = seedIllusts.getJSONObject(rSeed).optString("id");

                                String relatedUrl = "https://app-api.pixiv.net/v2/illust/related?illust_id=" + seedId;
                                String relRes = callPixivApiSync(relatedUrl, token);
                                if (relRes == null) throw new Exception();

                                JSONArray relIllusts = new JSONObject(relRes).optJSONArray("illusts");
                                JSONArray resultsArray = new JSONArray();
                                if (relIllusts != null) {
                                        for (int i = 0; i < relIllusts.length(); i++) {
                                                JSONObject ill = relIllusts.getJSONObject(i);
                                                int xRestrict = ill.optInt("x_restrict", 0);
                                                if ("safe".equals(ageFilter) && xRestrict != 0) continue;
                                                if ("r18".equals(ageFilter) && xRestrict == 0) continue;
                                                resultsArray.put(buildDiscoveryItem(ill, xRestrict));
                                        }
                                }

                                JSONObject finalResult = new JSONObject();
                                finalResult.put("results", resultsArray);
                                finalResult.put("next_url", "fake_url_to_trigger_next_random_seed");
                                return Base64.encodeToString(finalResult.toString().getBytes("UTF-8"), Base64.NO_WRAP);
                        } catch (Exception e) {
                                try { return Base64.encodeToString("{\"results\":[],\"next_url\":\"\"}".getBytes("UTF-8"), Base64.NO_WRAP); } catch (Exception ignored) { return ""; }
                        }
                }

                // --- Основной алгоритм страницы "Может понравиться" (см. ТЗ) ---
                // Цикл 1: сиды берём из закладок; цикл 2+: сиды берём из уже показанных работ
                // (списка результатов). В обоих случаях — 5 сидов, из них 2 R-18 (при фильтре safe —
                // все обычные, при r18 — все R-18). По сидам собираем похожие, выкидываем повторки и
                // всё, что уже в списке результатов, перемешиваем и отдаём случайные 30.
                private String buildDiscoveryFeed(String token, String userId) {
                        try {
                                SecureRandom rnd = new SecureRandom();

                                boolean firstCycle;
                                java.util.List<long[]> seedSource = new java.util.ArrayList<>();
                                synchronized (discoveryLock) {
                                        firstCycle = discoverySeedPool.isEmpty();
                                        if (!firstCycle) seedSource.addAll(discoverySeedPool);
                                }

                                // Источник сидов для первого цикла — закладки пользователя.
                                if (firstCycle) {
                                        String seedUrl = "https://app-api.pixiv.net/v1/user/bookmarks/illust?user_id=" + userId + "&restrict=public";
                                        String seedRes = callPixivApiSync(seedUrl, token);
                                        if (seedRes == null) throw new Exception();
                                        JSONArray seedIllusts = new JSONObject(seedRes).optJSONArray("illusts");
                                        if (seedIllusts == null || seedIllusts.length() == 0) throw new Exception();
                                        for (int i = 0; i < seedIllusts.length(); i++) {
                                                JSONObject ill = seedIllusts.getJSONObject(i);
                                                seedSource.add(new long[]{ ill.optLong("id", 0), ill.optInt("x_restrict", 0) });
                                        }
                                }

                                // Разбиваем источник на R-18 и обычные, выбираем сиды по фильтру.
                                java.util.List<long[]> r18Pool = new java.util.ArrayList<>();
                                java.util.List<long[]> safePool = new java.util.ArrayList<>();
                                for (long[] s : seedSource) {
                                        if (s[0] <= 0) continue;
                                        if (s[1] != 0) r18Pool.add(s); else safePool.add(s);
                                }
                                java.util.Collections.shuffle(r18Pool, rnd);
                                java.util.Collections.shuffle(safePool, rnd);

                                java.util.List<long[]> chosen = pickSeeds(r18Pool, safePool, rnd);
                                if (chosen.isEmpty()) throw new Exception();

                                // Текущий список результатов (для дедупа).
                                java.util.HashSet<String> alreadyShown;
                                synchronized (discoveryLock) { alreadyShown = new java.util.HashSet<>(discoveryShownIds); }

                                // Собираем похожие по всем сидам, дедуп внутри пачки и против списка результатов.
                                java.util.LinkedHashMap<String, JSONObject> candidates = new java.util.LinkedHashMap<>();
                                java.util.HashMap<String, Integer> candXR = new java.util.HashMap<>();
                                for (long[] seed : chosen) {
                                        String relatedUrl = "https://app-api.pixiv.net/v2/illust/related?illust_id=" + seed[0];
                                        String relRes = callPixivApiSync(relatedUrl, token);
                                        if (relRes == null) continue;
                                        JSONArray relIllusts = new JSONObject(relRes).optJSONArray("illusts");
                                        if (relIllusts == null) continue;
                                        for (int i = 0; i < relIllusts.length(); i++) {
                                                JSONObject ill = relIllusts.getJSONObject(i);
                                                String id = String.valueOf(ill.optInt("id"));
                                                int xRestrict = ill.optInt("x_restrict", 0);
                                                if ("safe".equals(ageFilter) && xRestrict != 0) continue;
                                                if ("r18".equals(ageFilter) && xRestrict == 0) continue;
                                                if (alreadyShown.contains(id)) continue;   // уже показывали
                                                if (candidates.containsKey(id)) continue;   // дубль в этой пачке
                                                candidates.put(id, buildDiscoveryItem(ill, xRestrict));
                                                candXR.put(id, xRestrict);
                                        }
                                }

                                // Перемешиваем и берём случайные 30.
                                java.util.List<String> ids = new java.util.ArrayList<>(candidates.keySet());
                                java.util.Collections.shuffle(ids, rnd);
                                int take = Math.min(DISCOVERY_BATCH, ids.size());

                                JSONArray resultsArray = new JSONArray();
                                java.util.List<String> newIds = new java.util.ArrayList<>();
                                java.util.List<long[]> newSeeds = new java.util.ArrayList<>();
                                for (int i = 0; i < take; i++) {
                                        String id = ids.get(i);
                                        resultsArray.put(candidates.get(id));
                                        newIds.add(id);
                                        long idNum = 0;
                                        try { idNum = Long.parseLong(id); } catch (Exception ignored) {}
                                        newSeeds.add(new long[]{ idNum, candXR.get(id) == null ? 0 : candXR.get(id) });
                                }

                                // Пополняем список результатов и пул сидов для следующих циклов.
                                synchronized (discoveryLock) {
                                        discoveryShownIds.addAll(newIds);
                                        discoverySeedPool.addAll(newSeeds);
                                }

                                JSONObject finalResult = new JSONObject();
                                finalResult.put("results", resultsArray);
                                // Бесконечная подгрузка возможна, пока есть что показывать.
                                finalResult.put("next_url", take > 0 ? "fake_url_to_trigger_next_random_seed" : "");
                                return Base64.encodeToString(finalResult.toString().getBytes("UTF-8"), Base64.NO_WRAP);
                        } catch (Exception e) {
                                try { return Base64.encodeToString("{\"results\":[],\"next_url\":\"\"}".getBytes("UTF-8"), Base64.NO_WRAP); } catch (Exception ignored) { return ""; }
                        }
                }

                // Выбор DISCOVERY_SEEDS сидов с учётом фильтра и нехватки в пулах.
                // safe -> только обычные; r18 -> только R-18 (добиваем обычными, если R-18 мало);
                // all -> DISCOVERY_SEEDS_R18 штук R-18 + остальное обычные, с взаимной добивкой.
                private java.util.List<long[]> pickSeeds(java.util.List<long[]> r18Pool, java.util.List<long[]> safePool, SecureRandom rnd) {
                        java.util.List<long[]> chosen = new java.util.ArrayList<>();
                        int needR18, needSafe;
                        if ("safe".equals(ageFilter)) { needR18 = 0; needSafe = DISCOVERY_SEEDS; }
                        else if ("r18".equals(ageFilter)) { needR18 = DISCOVERY_SEEDS; needSafe = 0; }
                        else { needR18 = DISCOVERY_SEEDS_R18; needSafe = DISCOVERY_SEEDS - DISCOVERY_SEEDS_R18; }

                        int ri = 0, si = 0;
                        for (int i = 0; i < needR18 && ri < r18Pool.size(); i++) chosen.add(r18Pool.get(ri++));
                        for (int i = 0; i < needSafe && si < safePool.size(); i++) chosen.add(safePool.get(si++));

                        // Добивка до DISCOVERY_SEEDS из остатков (но при safe — не подмешиваем R-18).
                        boolean allowR18Fill = !"safe".equals(ageFilter);
                        boolean allowSafeFill = !"r18".equals(ageFilter) || (safePool.size() > 0 && r18Pool.size() < DISCOVERY_SEEDS);
                        while (chosen.size() < DISCOVERY_SEEDS && (ri < r18Pool.size() || si < safePool.size())) {
                                boolean tookOne = false;
                                if (allowSafeFill && si < safePool.size()) { chosen.add(safePool.get(si++)); tookOne = true; }
                                else if (allowR18Fill && ri < r18Pool.size()) { chosen.add(r18Pool.get(ri++)); tookOne = true; }
                                if (!tookOne) break;
                        }
                        return chosen;
                }

                // Форматирование работы Pixiv в элемент ленты для UI.
                private JSONObject buildDiscoveryItem(JSONObject ill, int xRestrict) throws JSONException {
                        JSONObject item = new JSONObject();
                        item.put("id", String.valueOf(ill.optInt("id")));
                        item.put("title", ill.optString("title", "Без названия"));
                        JSONObject user = ill.optJSONObject("user");
                        item.put("author", user != null ? user.optString("name", "Неизвестен") : "Неизвестен");
                        item.put("author_id", user != null ? String.valueOf(user.optInt("id", 0)) : "");
                        item.put("is_r18", xRestrict == 1);
                        item.put("is_r18g", xRestrict == 2);
                        item.put("page_count", ill.optInt("page_count", 1));
                        item.put("is_bookmarked", ill.optBoolean("is_bookmarked", false));
                        JSONObject imgs = ill.optJSONObject("image_urls");
                        item.put("thumb", imgs != null ? imgs.optString("medium", "") : "");
                        return item;
                }

                @Override
                protected void onPostExecute(String b64) {
                        if (b64 != null && b64.length() > 0) {
                                runJs(callbackName + "('" + b64 + "');");
                        }
                }
        }


    // -----------------------------------------------------------------------
// BROWSE — ПРЯМОЕ ПОДКЛЮЧЕНИЕ К HENTAIHAVEN (обновлённый парсер 2026)
// -----------------------------------------------------------------------
    // -----------------------------------------------------------------------
// BROWSE — ПРЯМОЕ ПОДКЛЮЧЕНИЕ К HENTAIHAVEN (исправленная версия)
// -----------------------------------------------------------------------
// BROWSE — HENTAIHAVEN via hidden WebView (bypasses Cloudflare + CORS)
// -----------------------------------------------------------------------
    private static final String HENTAIHAVEN_BASE = "https://hentaihaven.xxx";
    private WebView browseWebView;

    private void startBrowseFetch(final int page, final String query) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                ensureBrowseWebView();

                browseWebView.setWebViewClient(new WebViewClient() {
                    @Override
                    public void onPageFinished(WebView view, String url) {
                        // Inject JS to extract HTML and parse with hentai-api selectors
                        String extractJs =
                            "(function() {" +
                            "  try {" +
                            "    var posts = [];" +
                            "    var cards = document.querySelectorAll('.c-tabs-item__content');" +
                            "    var added = {};" +
                            "    for (var i = 0; i < cards.length; i++) {" +
                            "      var el = cards[i];" +
                            "      var imgEl = el.querySelector('.c-image-hover img');" +
                            "      var cover = imgEl ? (imgEl.getAttribute('data-src') || imgEl.getAttribute('src') || '') : '';" +
                            "      cover = cover.replace(/ /g, '%20');" +
                            "      var linkEl = el.querySelector('.c-image-hover a');" +
                            "      var href = linkEl ? (linkEl.getAttribute('href') || '') : '';" +
                            "      if (!href) continue;" +
                            "      var parts = href.split('/').filter(function(s){return s.length>0;});" +
                            "      var id = '';" +
                            "      for (var p = 0; p < parts.length; p++) {" +
                            "        if ((parts[p]==='manga'||parts[p]==='series') && p+1<parts.length) { id=parts[p+1]; break; }" +
                            "      }" +
                            "      if (!id && parts.length>0) id = parts[parts.length-1];" +
                            "      if (!id || added[id]) continue;" +
                            "      added[id] = true;" +
                            "      var titleEl = el.querySelector('.post-title h3');" +
                            "      var title = titleEl ? titleEl.textContent.trim() : '';" +
                            "      if (!title) continue;" +
                            "      var ratingEl = el.querySelector('.total_votes');" +
                            "      var rating = ratingEl ? parseFloat(ratingEl.textContent.trim()) || 0 : 0;" +
                            "      var chapEl = el.querySelector('.chapter');" +
                            "      var totalEpisodes = 0;" +
                            "      if (chapEl) { var nums = chapEl.textContent.match(/\\d+/); if (nums) totalEpisodes = parseInt(nums[0]); }" +
                            "      var yearEl = el.querySelector('.mg_release .summary-content');" +
                            "      var released = 0;" +
                            "      if (yearEl) { var ym = yearEl.textContent.match(/\\d{4}/); if (ym) released = parseInt(ym[0]); }" +
                            "      var genres = [];" +
                            "      var genreEls = el.querySelectorAll('.mg_genres .summary-content a');" +
                            "      for (var g = 0; g < genreEls.length; g++) {" +
                            "        var gn = genreEls[g].textContent.replace(/,/g,'').trim();" +
                            "        if (gn) genres.push(gn);" +
                            "      }" +
                            "      posts.push({id:id,title:title,url:href,thumb:cover,rating:rating,released:released,totalEpisodes:totalEpisodes,genres:genres});" +
                            "    }" +
                            "    return JSON.stringify({posts:posts});" +
                            "  } catch(e) { return JSON.stringify({posts:[],error:e.message}); }" +
                            "})();";

                        if (Build.VERSION.SDK_INT >= 19) {
                            view.evaluateJavascript(extractJs, new ValueCallback<String>() {
                                @Override
                                public void onReceiveValue(String value) {
                                    try {
                                        // value is a JSON-encoded string wrapped in quotes
                                        String jsonStr = value;
                                        if (jsonStr.startsWith("\"") && jsonStr.endsWith("\"")) {
                                            jsonStr = jsonStr.substring(1, jsonStr.length() - 1);
                                        }
                                        jsonStr = jsonStr.replace("\\\"", "\"")
                                                         .replace("\\\\", "\\")
                                                         .replace("\\/", "/");
                                        String b64 = Base64.encodeToString(jsonStr.getBytes("UTF-8"), Base64.NO_WRAP);
                                        runJs("onBrowseData('" + b64 + "', 999);");
                                    } catch (Exception e) {
                                        runJs("onBrowseError('Parse error: " + e.getMessage().replace("'", "\\'") + "');");
                                    }
                                }
                            });
                        }
                    }

                    @Override
                    public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                        runJs("onBrowseError('WebView error: " + description.replace("'", "\\'") + "');");
                    }
                });

                String searchTerm = (query != null && !query.trim().isEmpty()) ? query.trim() : "";
                String encodedQuery;
                try { encodedQuery = URLEncoder.encode(searchTerm, "UTF-8"); } catch (Exception e) { encodedQuery = searchTerm; }
                String urlStr = HENTAIHAVEN_BASE + (page <= 1
                    ? "/?s=" + encodedQuery + "&post_type=wp-manga" + (searchTerm.isEmpty() ? "&m_orderby=latest" : "")
                    : "/page/" + page + "/?s=" + encodedQuery + "&post_type=wp-manga" + (searchTerm.isEmpty() ? "&m_orderby=latest" : ""));
                browseWebView.loadUrl(urlStr);
            }
        });
    }

    // -----------------------------------------------------------------------
    // BROWSE DETAIL — fetch title info via hidden WebView
    // -----------------------------------------------------------------------
    private void startBrowseDetailFetch(final String id) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                ensureBrowseWebView();

                browseWebView.setWebViewClient(new WebViewClient() {
                    @Override
                    public void onPageFinished(WebView view, String url) {
                        String extractJs =
                            "(function() {" +
                            "  try {" +
                            "    var title = ''; var te = document.querySelector('.post-title h1');" +
                            "    if (te) title = te.textContent.trim().replace(/[\\r\\n\\t]+/g, ' ');" +
                            "    var cover = ''; var ce = document.querySelector('.summary_image img');" +
                            "    if (ce) cover = (ce.getAttribute('data-src') || ce.getAttribute('src') || '').replace(/ /g,'%20');" +
                            "    var summary = ''; var se = document.querySelector('.description-summary p');" +
                            "    if (se) summary = se.textContent.trim().replace(/[\\r\\n\\t]+/g, ' ');" +
                            "    var rc = 0; var re = document.querySelector('span[property=\"ratingCount\"]');" +
                            "    if (re) rc = parseInt(re.textContent.trim()) || 0;" +
                            "    var views = 0; var ve = document.querySelector('.post-content_item:nth-child(4) .summary-content');" +
                            "    if (ve) { var vm = ve.textContent.match(/[\\d,]+/); if (vm) views = parseInt(vm[0].replace(/,/g,'')); }" +
                            "    var released = 0; var ye = document.querySelector('.post-status .summary-content a');" +
                            "    if (ye) { var ym = ye.textContent.match(/\\d{4}/); if (ym) released = parseInt(ym[0]); }" +
                            "    var genres = []; document.querySelectorAll('.genres-content a').forEach(function(g) {" +
                            "      var n = g.textContent.trim(); if (n) genres.push({name:n});" +
                            "    });" +
                            "    var episodes = []; var epEls = document.querySelectorAll('li.wp-manga-chapter');" +
                            "    var epLen = epEls.length;" +
                            "    for (var i = 0; i < epLen; i++) {" +
                            "      var epEl = epEls[i];" +
                            "      var aEl = epEl.querySelector('a');" +
                            "      if (!aEl) continue;" +
                            "      var epHref = aEl.getAttribute('href') || '';" +
                            "      var epParts = epHref.split('/').filter(function(s){return s.length>0;});" +
                            "      var epId = '';" +
                            "      if (epParts.length >= 2) epId = epParts[epParts.length-2] + '/' + epParts[epParts.length-1];" +
                            "      var epTitle = aEl.textContent.trim().replace(/[\\r\\n\\t]+/g, ' ');" +
                            "      var dateEl = epEl.querySelector('.chapter-release-date');" +
                            "      var epDate = dateEl ? dateEl.textContent.trim() : '';" +
                            "      episodes.push({id:btoa(epId),title:epTitle,number:epLen-i,releasedRelative:epDate});" +
                            "    }" +
                            "    episodes.sort(function(a,b){return a.number-b.number;});" +
                            "    return JSON.stringify({title:title,cover:cover,summary:summary,ratingCount:rc,views:views,released:released,genres:genres,episodes:episodes,totalEpisodes:epLen});" +
                            "  } catch(e) { return JSON.stringify({error:e.message}); }" +
                            "})();";

                        if (Build.VERSION.SDK_INT >= 19) {
                            view.evaluateJavascript(extractJs, new ValueCallback<String>() {
                                @Override
                                public void onReceiveValue(String value) {
                                    try {
                                        String jsonStr = unescapeJsString(value);
                                        String b64 = Base64.encodeToString(jsonStr.getBytes("UTF-8"), Base64.NO_WRAP);
                                        runJs("displayBrowseDetail('" + b64 + "');");
                                    } catch (Exception e) {
                                        runJs("onBrowseDetailError('" + e.getMessage().replace("'", "\\'") + "');");
                                    }
                                }
                            });
                        }
                    }

                    @Override
                    public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                        runJs("onBrowseDetailError('" + description.replace("'", "\\'") + "');");
                    }
                });

                browseWebView.loadUrl(HENTAIHAVEN_BASE + "/watch/" + id);
            }
        });
    }

    // -----------------------------------------------------------------------
    // BROWSE EPISODE SOURCES — fetch video URLs via hidden WebView
    // -----------------------------------------------------------------------
    private void startBrowseEpisodeFetch(final String episodeIdB64) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                ensureBrowseWebView();

                String episodePath;
                try {
                    episodePath = new String(Base64.decode(episodeIdB64, Base64.DEFAULT), "UTF-8");
                } catch (Exception e) {
                    runJs("displayBrowsePlayer('" + Base64.encodeToString("{\"error\":\"Invalid episode ID\"}".getBytes(), Base64.NO_WRAP) + "');");
                    return;
                }

                final String epUrl = HENTAIHAVEN_BASE + "/watch/" + episodePath;

                browseWebView.setWebViewClient(new WebViewClient() {
                    private boolean iframeLoaded = false;

                    @Override
                    public void onPageFinished(WebView view, String url) {
                        if (!iframeLoaded) {
                            // Step 1: Find the iframe src on the episode page
                            iframeLoaded = true;
                            String findIframeJs =
                                "(function() {" +
                                "  var iframe = document.querySelector('.player_logic_item > iframe, .player_logic_item iframe, iframe[src*=\"player\"]');" +
                                "  if (iframe && iframe.src) return iframe.src;" +
                                "  var scripts = document.querySelectorAll('script');" +
                                "  for (var i = 0; i < scripts.length; i++) {" +
                                "    var m = scripts[i].textContent.match(/iframe[^>]*src=[\"']([^\"']+)[\"']/);" +
                                "    if (m) return m[1];" +
                                "  }" +
                                "  return '';" +
                                "})();";

                            if (Build.VERSION.SDK_INT >= 19) {
                                view.evaluateJavascript(findIframeJs, new ValueCallback<String>() {
                                    @Override
                                    public void onReceiveValue(String value) {
                                        String iframeSrc = unescapeJsString(value);
                                        if (iframeSrc.isEmpty()) {
                                            // Fallback: try to find video directly on the page
                                            tryDirectVideoExtract(view);
                                            return;
                                        }
                                        // Step 2: Load the iframe URL to extract the token
                                        browseWebView.loadUrl(iframeSrc);
                                    }
                                });
                            }
                        } else {
                            // Step 2: We're on the iframe page — extract token, decrypt, fetch sources
                            // Uses BrowseBridge.onSourcesReady() because fetch() returns a Promise
                            // and evaluateJavascript cannot handle Promises
                            String extractSourcesJs =
                                "(function() {" +
                                "  try {" +
                                "    function rot13(s) {" +
                                "      return s.replace(/[a-zA-Z]/g, function(c) {" +
                                "        return String.fromCharCode((c<='Z'?90:122)>=(c=c.charCodeAt(0)+13)?c:c-26);" +
                                "      });" +
                                "    }" +
                                "    var meta = document.querySelector('meta[name=\"x-secure-token\"]');" +
                                "    if (!meta) {" +
                                "      var vid = document.querySelector('video source, video[src]');" +
                                "      if (vid) {" +
                                "        var src = vid.getAttribute('src') || (vid.querySelector('source') ? vid.querySelector('source').getAttribute('src') : '');" +
                                "        if (src) { BrowseBridge.onSourcesReady(JSON.stringify({sources:[{label:'Default',src:src,type:'video/mp4'}]})); return; }" +
                                "      }" +
                                "      BrowseBridge.onSourcesReady(JSON.stringify({error:'No token or video found'}));" +
                                "      return;" +
                                "    }" +
                                "    var token = meta.getAttribute('content').replace('sha512-','');" +
                                "    var step1 = rot13(token);" +
                                "    var step2 = atob(step1);" +
                                "    var step3 = rot13(step2);" +
                                "    var step4 = atob(step3);" +
                                "    var step5 = rot13(step4);" +
                                "    var step6 = atob(step5);" +
                                "    var decrypted = JSON.parse(step6);" +
                                "    var apiUrl = (decrypted.uri || 'https://hentaihaven.xxx/wp-content/plugins/player-logic/') + 'api.php';" +
                                "    var fd = new FormData();" +
                                "    fd.append('action','zarat_get_data_player_ajax');" +
                                "    fd.append('a', decrypted.en);" +
                                "    fd.append('b', decrypted.iv);" +
                                "    fetch(apiUrl, {method:'POST',body:fd})" +
                                "      .then(function(r){return r.json();})" +
                                "      .then(function(j){" +
                                "        var result = {sources:j.data.sources||[],thumbnail:j.data.image||''};" +
                                "        BrowseBridge.onSourcesReady(JSON.stringify(result));" +
                                "      })" +
                                "      .catch(function(e){" +
                                "        BrowseBridge.onSourcesReady(JSON.stringify({error:'Fetch failed: '+e.message}));" +
                                "      });" +
                                "  } catch(e) { BrowseBridge.onSourcesReady(JSON.stringify({error:e.message})); }" +
                                "})();";

                            if (Build.VERSION.SDK_INT >= 19) {
                                view.evaluateJavascript(extractSourcesJs, null);
                            }
                        }
                    }

                    @Override
                    public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                        runJs("displayBrowsePlayer('" + Base64.encodeToString(("{\"error\":\"" + description + "\"}").getBytes(), Base64.NO_WRAP) + "');");
                    }
                });

                browseWebView.loadUrl(epUrl);
            }
        });
    }

    private void tryDirectVideoExtract(WebView view) {
        String js = "(function(){" +
            "var v=document.querySelector('video source,video[src]');" +
            "if(v){var s=v.getAttribute('src')||(v.querySelector('source')?v.querySelector('source').getAttribute('src'):'');" +
            "if(s){BrowseBridge.onSourcesReady(JSON.stringify({sources:[{label:'Default',src:s,type:'video/mp4'}]}));return;}}" +
            "BrowseBridge.onSourcesReady(JSON.stringify({error:'No video found on page'}));" +
            "})();";
        if (Build.VERSION.SDK_INT >= 19) {
            view.evaluateJavascript(js, null);
        }
    }

    private void ensureBrowseWebView() {
        if (browseWebView == null) {
            browseWebView = new WebView(MainActivity.this);
            browseWebView.getSettings().setJavaScriptEnabled(true);
            browseWebView.getSettings().setDomStorageEnabled(true);
            browseWebView.getSettings().setUserAgentString(
                "Mozilla/5.0 (Linux; Android 13; Pixel 7 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"
            );
            browseWebView.getSettings().setAllowUniversalAccessFromFileURLs(true);
            if (Build.VERSION.SDK_INT >= 16) {
                browseWebView.getSettings().setAllowFileAccessFromFileURLs(true);
            }
            android.webkit.CookieManager.getInstance().setAcceptCookie(true);
            if (Build.VERSION.SDK_INT >= 21) {
                android.webkit.CookieManager.getInstance().setAcceptThirdPartyCookies(browseWebView, true);
            }
            // Add JS interface so browseWebView can send results back
            browseWebView.addJavascriptInterface(new BrowseWebViewInterface(), "BrowseBridge");
        }
    }

    /** JS interface for the hidden browseWebView to send async results back */
    public class BrowseWebViewInterface {
        @JavascriptInterface
        public void onSourcesReady(String json) {
            try {
                final String b64 = Base64.encodeToString(json.getBytes("UTF-8"), Base64.NO_WRAP);
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        runJs("displayBrowsePlayer('" + b64 + "');");
                    }
                });
            } catch (Exception e) {
                e.printStackTrace();
            }
        }
    }

    private String unescapeJsString(String value) {
        if (value == null) return "";
        String s = value.trim();
        if (s.equals("null") || s.equals("undefined")) return "";
        // Remove wrapping quotes from evaluateJavascript result
        if (s.startsWith("\"") && s.endsWith("\"")) {
            s = s.substring(1, s.length() - 1);
        }
        // Unescape JS string escapes back to raw characters
        // Order matters: \\\\ first, then the rest
        s = s.replace("\\\\/", "/");
        s = s.replace("\\\\\"", "\"");
        s = s.replace("\\\\\\\\", "\\\\");
        // Handle \\n \\t \\r that are literal escape sequences from JS
        s = s.replace("\\\\n", "\\n");
        s = s.replace("\\\\t", "\\t");
        s = s.replace("\\\\r", "\\r");
        // Now handle the simple escapes from the JSON wrapping
        s = s.replace("\\\"", "\"");
        s = s.replace("\\/", "/");
        // Remove actual control characters that break JSON parsing
        s = s.replace("\n", " ").replace("\r", " ").replace("\t", " ");
        return s;
    }


        private String safeFileName(String name) {
                if (name == null || name.length() == 0) return "untitled";
                String r = name.replaceAll("[\\\\/:*?\"<>|\r\n]", "_").trim();
                return (r.length() > 60) ? r.substring(0, 60) : (r.isEmpty() ? "untitled" : r);
        }

        private String getExtensionFromUrl(String url) {
                try {
                        String clean = url.contains("?") ? url.substring(0, url.indexOf("?")) : url;
                        int dot = clean.lastIndexOf(".");
                        if (dot >= 0) {
                                String ext = clean.substring(dot);
                                if (ext.length() <= 6) return ext;
                        }
                } catch (Exception ignored) {}
                return ".jpg";
        }

        private String getMimeTypeFromFileName(String fileName) {
                String l = fileName.toLowerCase();
                if (l.endsWith(".png")) return "image/png";
                if (l.endsWith(".gif")) return "image/gif";
                if (l.endsWith(".webp")) return "image/webp";
                if (l.endsWith(".jpg") || l.endsWith(".jpeg")) return "image/jpeg";
                // --- ДОБАВЛЯЕМ ПОДДЕРЖКУ ВЕБ-ФАЙЛОВ ---
                if (l.endsWith(".html")) return "text/html";
                if (l.endsWith(".css")) return "text/css";
                if (l.endsWith(".js")) return "application/javascript";
                return "text/plain";
        }

        private static String generateCodeVerifier() {
                byte[] bytes = new byte[32];
                new SecureRandom().nextBytes(bytes);
                return Base64.encodeToString(bytes, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
        }

        private static String generateCodeChallenge(String verifier) throws Exception {
                return Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.getBytes("UTF-8")), Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
        }

        private static String urlEncode(String value) throws Exception {
                return URLEncoder.encode(value, "UTF-8");
        }

        private InputStream openPixivImageStream(String imageUrl, long[] outSize) {
                try {
                        URL url = new URL(imageUrl);
                        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                        conn.setRequestMethod("GET");
                        conn.setRequestProperty("User-Agent", USER_AGENT);
                        conn.setRequestProperty("Referer", "https://app-api.pixiv.net/");
                        conn.setConnectTimeout(15000);
                        conn.setReadTimeout(15000);
                        conn.setUseCaches(false);

                        if (conn.getResponseCode() >= 200 && conn.getResponseCode() < 300) {
                                if (outSize != null && outSize.length > 0) {
                                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                                                outSize[0] = conn.getContentLengthLong();
                                        } else {
                                                outSize[0] = conn.getContentLength();
                                        }
                                }
                                return new BufferedInputStream(conn.getInputStream());
                        }
                } catch (Exception ignored) {}
                return null;
        }

        private InputStream openPixivImageStream(String imageUrl) {
                return openPixivImageStream(imageUrl, null);
        }

        private class IllustDownloadTask extends AsyncTask<String, Object, String> {
                private String error;
                private PowerManager.WakeLock wakeLock;
                private NotificationManager notificationManager;
                private Notification.Builder notificationBuilder;
                private int notificationId;
                private String mIllustId;
                private String mTitle;
                private String mThumb;
                private int mTargetPage;
                private String mTaskKey;
                private String mOriginalUrl;

                public IllustDownloadTask(String illustId, String title, String thumb, int targetPage, String taskKey, String originalUrl) {
                        this.mIllustId = illustId;
                        this.mTitle = title;
                        this.mThumb = thumb;
                        this.mTargetPage = targetPage;
                        this.mTaskKey = taskKey;
                        this.mOriginalUrl = originalUrl;
                }

                @Override
                protected void onPreExecute() {
                        super.onPreExecute();
                        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "PixivDL::DownloadLock");
                        wakeLock.acquire(15 * 60 * 1000L);

                        notificationId = mTaskKey.hashCode();
                        notificationManager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);

                        if (Build.VERSION.SDK_INT >= 26) {
                                NotificationChannel channel = new NotificationChannel("pixiv_dl", "Загрузки", NotificationManager.IMPORTANCE_LOW);
                                notificationManager.createNotificationChannel(channel);
                                notificationBuilder = new Notification.Builder(MainActivity.this, "pixiv_dl");
                        } else { notificationBuilder = new Notification.Builder(MainActivity.this); }

                        notificationBuilder.setContentTitle("Скачивание Pixiv").setContentText("Подключение...").setSmallIcon(android.R.drawable.stat_sys_download).setOngoing(true);
                        notificationManager.notify(notificationId, notificationBuilder.build());

                        if (mTitle != null && !mTitle.isEmpty()) {
                                runJs("addActiveDownload('" + mTaskKey + "', '" + mTitle.replace("'", "\\'") + "', '" + mThumb + "');");
                        } else {
                                runJs("addActiveDownload('" + mTaskKey + "', 'Работа " + mTaskKey + "', '');");
                        }
                        updateUIProgress(mTaskKey, 0, 1);
                }

                @Override
                protected String doInBackground(String... params) {
                        try {
                                if (isCancelled()) return "Приостановлено";

                                String cleanTitle = mTitle != null ? mTitle : "untitled";
                                // Убираем приписку (Стр. X) из имени файла, если она там есть от UI
                                if (cleanTitle.contains(" (Стр.")) {
                                        cleanTitle = cleanTitle.substring(0, cleanTitle.lastIndexOf(" (Стр."));
                                }
                                cleanTitle = safeFileName(cleanTitle);

                                JSONArray imageUrls = new JSONArray();
                                int dlTotal = 1;
                                int filenameIndexOffset = 0; // Для правильного индекса _pX при поштучном скачивании

                                // ==========================================
                                // БЫСТРЫЙ ПУТЬ: Поштучное скачивание (ОРИГИНАЛЬНАЯ ССЫЛКА)
                                // ==========================================
                                if (mTargetPage != -1 && mOriginalUrl != null && mOriginalUrl.startsWith("http")) {
                                        imageUrls.put(mOriginalUrl); // БЕРЕМ ИСТИННЫЙ ОРИГИНАЛ!
                                        filenameIndexOffset = mTargetPage; 

                                        runJs("updateActiveDownloadInfo('" + mTaskKey + "', '" + cleanTitle.replace("'", "\\'") + " (Стр."+(mTargetPage+1)+")', '" + mThumb + "');");
                                }
                                // ==========================================
                                // МЕДЛЕННЫЙ ПУТЬ: Скачивание всей пачки (Запрос к API)
                                // ==========================================
                                else {
                                        JSONObject detail = getIllustDetailJson(params[0], mIllustId);
                                        if (detail == null) { error = "Не удалось получить данные."; return null; }
                                        if (!detail.has("illust")) { error = "Работа ограничена или удалена"; return null; }

                                        JSONObject illust = detail.getJSONObject("illust");
                                        cleanTitle = safeFileName(illust.optString("title", cleanTitle));
                                        String thumbUrl = getPreviewImageUrl(illust);
                                        final String fThumb = thumbUrl != null ? thumbUrl : (mThumb != null ? mThumb : "");

                                        runJs("updateActiveDownloadInfo('" + mTaskKey + "', '" + cleanTitle.replace("'", "\\'") + "', '" + fThumb + "');");

                                        imageUrls = collectOriginalImageUrls(illust);
                                        if (imageUrls.length() == 0) { error = "Не найдены original URLs."; return null; }
                                        dlTotal = imageUrls.length();

                                        // Запоминаем, сколько файлов в папке должно быть в итоге
                                        getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit().putInt("expected_" + mIllustId, dlTotal).apply();
                                }

                                File baseDir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "PixivDL");
                                if (!baseDir.exists()) baseDir.mkdirs();
                                File targetDir = new File(baseDir, mIllustId);
                                if (!targetDir.exists()) targetDir.mkdirs();

                                int successCount = 0;
                                int skipCount = 0;
                                int completed = 0; 

                                // Цикл скачивания
                                for (int i = 0; i < imageUrls.length(); i++) {
                                        if (isCancelled()) return "Приостановлено";

                                        String imageUrl = imageUrls.getString(i);
                                        int fileIdx = mTargetPage != -1 ? filenameIndexOffset : i;

                                        // Формируем имя: Если это единственный файл всей работы - без индекса. Иначе пишем _pX.
                                        String fileName;
                                        if (dlTotal == 1 && mTargetPage == -1) {
                                                fileName = mIllustId + "_" + cleanTitle + getExtensionFromUrl(imageUrl);
                                        } else {
                                                fileName = mIllustId + "_p" + fileIdx + "_" + cleanTitle + getExtensionFromUrl(imageUrl);
                                        }

                                        publishProgress("Скачано " + completed + " из " + dlTotal, completed, dlTotal, mTaskKey);

                                        if (isFileAlreadyDownloaded(fileName, mIllustId)) { skipCount++; successCount++; completed++; continue; }

                                        boolean success = false;
                                        for (int retry = 0; retry < 3; retry++) {
                                                if (isCancelled()) return "Приостановлено";
                                                if (downloadImageToGallery(imageUrl, fileName, targetDir)) { success = true; break; } 
                                                else {
                                                        publishProgress("Восстановление связи...", completed, dlTotal, mTaskKey);
                                                        try { Thread.sleep(2000); } catch(Exception e){} 
                                                }
                                        }

                                        if (success) { successCount++; completed++; } 
                                        else { error = "Прервано из-за плохой сети"; return null; }
                                }

                                if (isCancelled()) return "Приостановлено";
                                publishProgress("Скачано " + completed + " из " + dlTotal, completed, dlTotal, mTaskKey);

                                if (successCount < dlTotal) { error = "Сбой: сохранено " + successCount + " из " + dlTotal; return null; }
                                if (skipCount == dlTotal) return "Файл(ы) уже скачаны.";
                                return "Успешно: " + successCount + " из " + dlTotal;

                        } catch (Exception e) {
                                error = e.getMessage() != null ? e.getMessage() : e.toString();
                                return null;
                        }
                }

                // Остальные вспомогательные методы (onProgressUpdate, onCancelled, onPostExecute и т.д.)
                @Override
                protected void onProgressUpdate(Object... values) {
                        if (isCancelled()) return;
                        String text = (String) values[0]; int current = (int) values[1]; int total = (int) values[2]; String id = (String) values[3];
                        updateUIStatus(text); updateUIProgress(id, current, total); 
                        notificationBuilder.setContentText(text).setProgress(total, current, false);
                        notificationManager.notify(notificationId, notificationBuilder.build());
                        runJs("updateActiveDownload('" + id + "', '" + text.replace("'", "\\'") + "', " + current + ", " + total + ");");
                }

                @Override
                protected void onCancelled() {
                        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
                        notificationManager.cancel(notificationId);
                        activeDownloads.remove(mTaskKey);
                }

                @Override
                protected void onPostExecute(String result) {
                        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
                        notificationBuilder.setContentText(result == null ? "Ошибка" : "Завершено").setProgress(0, 0, false).setOngoing(false).setSmallIcon(android.R.drawable.stat_sys_download_done);
                        notificationManager.notify(notificationId, notificationBuilder.build());
                        activeDownloads.remove(mTaskKey);

                        if (result == null) {
                                updateUIProgress(mTaskKey, 0, 1); updateUIStatus("Ошибка: " + error);
                                runJs("finishActiveDownload('" + mTaskKey + "', false);");
                                return;
                        }
                        updateUIProgress(mTaskKey, 1, 1); updateUIStatus(result);
                        Toast.makeText(MainActivity.this, "Завершено", Toast.LENGTH_SHORT).show();
                        runJs("if(typeof currentActionTarget !== 'undefined' && currentActionTarget !== '') { checkFilesExist(document.getElementById('linkInput').value, currentActionTarget === 'det' ? 'detCheckBtn' : 'btnMainCheck'); }");
                        runJs("finishActiveDownload('" + mTaskKey + "', true);");
                }

                // isFileAlreadyDownloaded, downloadImageToGallery и collectOriginalImageUrls остаются прежними!
                // ... (Не забудьте оставить их внутри класса IllustDownloadTask)

                private boolean isFileAlreadyDownloaded(String fileName, String illustId) {
                        File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "PixivDL/" + illustId);
                        String nameNoExt = fileName;
                        int dot = fileName.lastIndexOf(".");
                        if(dot > 0) nameNoExt = fileName.substring(0, dot);

                        File fileJpg = new File(dir, nameNoExt + ".jpg");
                        File filePng = new File(dir, nameNoExt + ".png");
                        File fileGif = new File(dir, nameNoExt + ".gif");
                        File fileWebp = new File(dir, nameNoExt + ".webp");

                        return (fileJpg.exists() && fileJpg.length() > 0) || (filePng.exists() && filePng.length() > 0) || (fileGif.exists() && fileGif.length() > 0) || (fileWebp.exists() && fileWebp.length() > 0);
                }

                private boolean downloadImageToGallery(String imageUrl, String fileName, File dir) {
                        for (int retry = 0; retry < 3; retry++) {
                                if (isCancelled()) return false;
                                InputStream is = null;
                                FileOutputStream os = null;
                                try {
                                        boolean shouldCompress = true;
                                        if (fileName.toLowerCase().endsWith(".gif")) shouldCompress = false; 

                                        if (shouldCompress) {
                                                if (fileName.toLowerCase().endsWith(".png") || fileName.toLowerCase().endsWith(".webp")) {
                                                        fileName = fileName.substring(0, fileName.lastIndexOf('.')) + ".jpg";
                                                }
                                        }

                                        File file = new File(dir, fileName);

                                        long[] origSizeArr = new long[1];
                                        is = openPixivImageStream(imageUrl, origSizeArr);
                                        if (is == null) throw new Exception("Stream is null");

                                        if (shouldCompress) {
                                                try {
                                                        Bitmap bmp = BitmapFactory.decodeStream(is);
                                                        if (bmp != null) {
                                                                os = new FileOutputStream(file);
                                                                bmp.compress(Bitmap.CompressFormat.JPEG, 95, os);
                                                                bmp.recycle();

                                                                long origSize = origSizeArr[0];
                                                                long finalSize = file.length();
                                                                if (origSize < finalSize) origSize = finalSize; 

                                                                SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
                                                                prefs.edit().putLong("orig_" + dir.getName() + "_" + fileName, origSize).apply();
                                                        } else {
                                                                throw new Exception("Decode failed");
                                                        }
                                                } catch (OutOfMemoryError | Exception e) {
                                                        System.gc(); 
                                                        if (is != null) is.close();
                                                        if (os != null) os.close();
                                                        is = openPixivImageStream(imageUrl);
                                                        if (is == null) throw new Exception("Stream is null on retry");
                                                        os = new FileOutputStream(file);
                                                        copyStream(is, os);
                                                }
                                        } else {
                                                os = new FileOutputStream(file);
                                                copyStream(is, os);
                                        }

                                        MediaScannerConnection.scanFile(MainActivity.this, new String[]{file.getAbsolutePath()}, new String[]{getMimeTypeFromFileName(fileName)}, null);
                                        return true;
                                } catch (Exception e) {
                                        try { Thread.sleep(2000); } catch (Exception ignored) {}
                                } finally {
                                        if (os != null) { try { os.close(); } catch (Exception ignored) {} }
                                        if (is != null) { try { is.close(); } catch (Exception ignored) {} }
                                }
                        }
                        return false;
                }

                private JSONArray collectOriginalImageUrls(JSONObject illust) {
                        JSONArray result = new JSONArray();
                        try {
                                JSONArray metaPages = illust.optJSONArray("meta_pages");
                                if (metaPages != null && metaPages.length() > 0) {
                                        for (int i = 0; i < metaPages.length(); i++) {
                                                String original = metaPages.getJSONObject(i).getJSONObject("image_urls").optString("original", "");
                                                if (original.length() > 0) {
                                                        result.put(original);
                                                }
                                        }
                                } else {
                                        JSONObject metaSingle = illust.optJSONObject("meta_single_page");
                                        if (metaSingle != null) {
                                                String original = metaSingle.optString("original_image_url", "");
                                                if (original.length() > 0) {
                                                        result.put(original);
                                                }
                                        }
                                        if (result.length() == 0) {
                                                JSONObject urls = illust.optJSONObject("image_urls");
                                                if (urls != null) {
                                                        String large = urls.optString("large", "");
                                                        if (large.length() > 0) {
                                                                result.put(large);
                                                        }
                                                }
                                        }
                                }
                        } catch (Exception ignored) {}
                        return result;
                }

        }

        private class FollowingTask extends AsyncTask<String, Void, String> {
                @Override
                protected String doInBackground(String... params) {
                        String token = params[0];
                        String myId = params[1];
                        String nextUrlStr = params[2];

                        try {
                                String urlStr = (nextUrlStr != null && nextUrlStr.startsWith("http")) ? nextUrlStr : "https://app-api.pixiv.net/v1/user/following?user_id=" + myId + "&restrict=public";
                                URL url = new URL(urlStr);
                                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                                conn.setRequestMethod("GET");
                                conn.setRequestProperty("Authorization", "Bearer " + token);
                                addPixivApiHeaders(conn);

                                if (conn.getResponseCode() >= 200 && conn.getResponseCode() < 300) {
                                        BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream()));
                                        StringBuilder res = new StringBuilder();
                                        String line;
                                        while ((line = reader.readLine()) != null) res.append(line);
                                        reader.close();

                                        JSONObject root = new JSONObject(res.toString());
                                        JSONArray userPreviews = root.optJSONArray("user_previews");

                                        JSONObject result = new JSONObject();
                                        result.put("next_url", root.optString("next_url", ""));

                                        JSONArray resultsArray = new JSONArray();
                                        if (userPreviews != null) {
                                                for (int i = 0; i < userPreviews.length(); i++) {
                                                        JSONObject item = userPreviews.getJSONObject(i);
                                                        JSONObject userObj = item.getJSONObject("user");
                                                        JSONArray illusts = item.optJSONArray("illusts");

                                                        JSONObject userEntry = new JSONObject();
                                                        userEntry.put("id", String.valueOf(userObj.optInt("id")));
                                                        userEntry.put("name", userObj.optString("name"));
                                                        userEntry.put("avatar", userObj.optJSONObject("profile_image_urls").optString("medium"));

                                                        JSONArray illustsArray = new JSONArray();
                                                        if (illusts != null) {
                                                                for (int j = 0; j < illusts.length(); j++) {
                                                                        JSONObject ill = illusts.getJSONObject(j);
                                                                        JSONObject illEntry = new JSONObject();
                                                                        illEntry.put("id", String.valueOf(ill.optInt("id")));
                                                                        // Используем medium (как в поиске), чтобы сработала ленивая загрузка
                                                                        illEntry.put("thumb", ill.optJSONObject("image_urls").optString("medium"));
                                                                        illEntry.put("page_count", ill.optInt("page_count"));
                                                                        illEntry.put("is_r18", ill.optInt("x_restrict") == 1);
                                                                        illEntry.put("is_r18g", ill.optInt("x_restrict") == 2);
                                                                        illustsArray.put(illEntry);
                                                                }
                                                        }
                                                        userEntry.put("illusts", illustsArray);
                                                        resultsArray.put(userEntry);
                                                }
                                        }
                                        result.put("results", resultsArray);
                                        return Base64.encodeToString(result.toString().getBytes("UTF-8"), Base64.NO_WRAP);
                                }
                        } catch (Exception e) { e.printStackTrace(); }
                        return null;
                }


                @Override
                protected void onPostExecute(String b64) {
                        if (b64 != null) {
                                runJs("displayFollowing('" + b64 + "')");
                        } else {
                                runJs("showToast('Не удалось загрузить подписки')");
                        }
                }

        }

        // ========================================================
        // ОФФЛАЙН РАДИО И МЕНЕДЖЕР (БЕЗ УТЕЧЕК ПАМЯТИ)
        // ========================================================
        private void runSmartCacheEngine(int targetCount, String quality) {
                SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
                String token = prefs.getString(KEY_ACCESS_TOKEN, null);
                String userId = prefs.getString(KEY_USER_ID, null);

                if (token == null || userId == null) {
                        isSmartCacheRunning = false;
                        runJs("stopSmartCacheUI(); showToast('Необходима авторизация');");
                        return;
                }

                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                PowerManager.WakeLock wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "PixivDL::SmartCache");
                wakeLock.acquire(30 * 60 * 1000L);

                // Инициализация уведомления
                int scNotificationId = 99999;
                NotificationManager notifManager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
                Notification.Builder notifBuilder;
                if (Build.VERSION.SDK_INT >= 26) {
                        NotificationChannel channel = new NotificationChannel("pixiv_dl_cache", "Smart Cache", NotificationManager.IMPORTANCE_LOW);
                        notifManager.createNotificationChannel(channel);
                        notifBuilder = new Notification.Builder(this, "pixiv_dl_cache");
                } else {
                        notifBuilder = new Notification.Builder(this);
                }
                notifBuilder.setContentTitle("Пу-пу-пу...").setSmallIcon(android.R.drawable.stat_sys_download).setOngoing(true);

                int downloadedImages = 0;
                long lastNotifyTime = 0;
                String seedUrl = "https://app-api.pixiv.net/v1/user/bookmarks/illust?user_id=" + userId + "&restrict=public";

                // === ПРЯЧЕМ ОТ ГАЛЕРЕИ ===
                File offlineDir = new File(getExternalFilesDir(null), "OfflineCache");
                if (!offlineDir.exists()) offlineDir.mkdirs();
                try { new File(offlineDir, ".nomedia").createNewFile(); } catch (Exception e) {}

                try {
                        while (isSmartCacheRunning && downloadedImages < targetCount) {
                                String seedRes = callPixivApiSync(seedUrl, token);
                                if (seedRes == null) { Thread.sleep(2000); continue; }

                                JSONArray seedIllusts = new JSONObject(seedRes).optJSONArray("illusts");
                                if (seedIllusts == null || seedIllusts.length() == 0) {
                                        seedUrl = "https://app-api.pixiv.net/v1/illust/recommended?include_ranking_illusts=true";
                                        continue;
                                }

                                int rSeed = new SecureRandom().nextInt(seedIllusts.length());
                                String seedId = seedIllusts.getJSONObject(rSeed).optString("id");

                                String relatedUrl = "https://app-api.pixiv.net/v2/illust/related?illust_id=" + seedId;
                                String relRes = callPixivApiSync(relatedUrl, token);
                                if (relRes == null) continue;

                                JSONArray relIllusts = new JSONObject(relRes).optJSONArray("illusts");
                                if (relIllusts == null || relIllusts.length() == 0) continue;

                                // 4. Берем 2-3 случайных работы из похожих
                                int artsToPick = 2 + new SecureRandom().nextInt(2); // 2 или 3 арта
                                for (int i = 0; i < artsToPick && isSmartCacheRunning && downloadedImages < targetCount; i++) {
                                        int rIdx = new SecureRandom().nextInt(relIllusts.length());
                                        JSONObject ill = relIllusts.getJSONObject(rIdx);

                                        String illId = ill.optString("id");
                                        String title = safeFileName(ill.optString("title", "untitled"));

                                        int pageCount = ill.optInt("page_count", 1);

                                        // ==========================================
                                        // НОВОЕ: ОГРАНИЧЕНИЕ НА КОЛИЧЕСТВО СТРАНИЦ
                                        // ==========================================
                                        if (pageCount > 5) continue; // Пропускаем работу и идем к следующей!
                                        // ==========================================

                                        // Проверяем, не скачана ли уже эта работа
                                        File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "PixivDL/" + illId);
                                        if (dir.exists() && dir.isDirectory() && dir.list() != null && dir.list().length > 0) continue;

                                        // ... дальше идет старый код скачивания ...


                                        JSONArray metaPages = ill.optJSONArray("meta_pages");

                                        for (int p = 0; p < pageCount && isSmartCacheRunning && downloadedImages < targetCount; p++) {
                                                String urlToDownload = "";
                                                if (pageCount > 1 && metaPages != null && p < metaPages.length()) {
                                                        JSONObject pUrls = metaPages.getJSONObject(p).optJSONObject("image_urls");
                                                        if (pUrls != null) urlToDownload = pUrls.optString(quality.equals("original") ? "original" : (quality.equals("large") ? "large" : "medium"), "");
                                                } else {
                                                        if (quality.equals("original")) {
                                                                JSONObject single = ill.optJSONObject("meta_single_page");
                                                                if (single != null) urlToDownload = single.optString("original_image_url", "");
                                                        } else {
                                                                JSONObject urls = ill.optJSONObject("image_urls");
                                                                if (urls != null) urlToDownload = urls.optString(quality.equals("large") ? "large" : "medium", "");
                                                        }
                                                }

                                                if (urlToDownload.isEmpty()) continue;

                                                String fileName = illId + "_p" + p + "_" + title + getExtensionFromUrl(urlToDownload);
                                                File file = new File(offlineDir, fileName);

                                                // Скачиваем БЕЗ сканера галереи
                                                if (file.exists() || downloadOfflineImageSync(urlToDownload, file)) {
                                                        downloadedImages++;

                                                        // Передаем в JS быструю виртуальную ссылку, никакого Base64!
                                                        String localUrl = "https://offline-cache/" + Uri.encode(fileName);
                                                        runJs("updateSmartCacheProgress(" + downloadedImages + ", " + targetCount + ", '" + localUrl + "');");

                                                        // Ограничитель уведомлений (не чаще раза в секунду)
                                                        long now = System.currentTimeMillis();
                                                        if (now - lastNotifyTime > 1000 || downloadedImages == targetCount) {
                                                                notifBuilder.setContentText("Собрано " + downloadedImages + " из " + targetCount).setProgress(targetCount, downloadedImages, false);
                                                                notifManager.notify(scNotificationId, notifBuilder.build());
                                                                lastNotifyTime = now;
                                                        }
                                                }
                                        }
                                }
                        }
                } catch (Exception e) {} finally {
                        isSmartCacheRunning = false;
                        notifManager.cancel(scNotificationId);
                        if (wakeLock.isHeld()) wakeLock.release();
                }
        }

        // Специальный загрузчик без MediaScanner (не показывает в галерее)
        private boolean downloadOfflineImageSync(String imageUrl, File file) {
                try {
                        InputStream is = openPixivImageStream(imageUrl, null);
                        if (is == null) return false;
                        FileOutputStream os = new FileOutputStream(file);
                        copyStream(is, os);
                        os.close(); is.close();
                        return true;
                } catch (Exception e) { return false; }
        }

        private String callPixivApiSync(String urlStr, String token) {
                try {
                        URL url = new URL(urlStr);
                        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                        conn.setRequestMethod("GET");
                        conn.setRequestProperty("Authorization", "Bearer " + token);
                        addPixivApiHeaders(conn);
                        conn.setConnectTimeout(8000);
                        conn.setReadTimeout(8000);
                        if (conn.getResponseCode() >= 200 && conn.getResponseCode() < 300) {
                                BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream()));
                                StringBuilder res = new StringBuilder();
                                String line;
                                while ((line = reader.readLine()) != null) res.append(line);
                                reader.close();
                                return res.toString();
                        }
                } catch (Exception ignored) {}
                return null;
        }

        private boolean downloadImageSyncHelper(String imageUrl, File file) {
                try {
                        long[] outSize = new long[1];
                        InputStream is = openPixivImageStream(imageUrl, outSize);
                        if (is == null) return false;
                        FileOutputStream os = new FileOutputStream(file);
                        copyStream(is, os);
                        os.close();
                        is.close();
                        // Добавляем в галерею
                        MediaScannerConnection.scanFile(this, new String[]{file.getAbsolutePath()}, null, null);
                        return true;
                } catch (Exception e) {
                        return false;
                }
        }
}

    


