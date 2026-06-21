package com.pixivdl.application;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.SystemClock;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Фоновая проверка обновлений приложения.
 *
 * Раз в несколько часов (через AlarmManager) скачивает update.json, сравнивает
 * native_version с установленной версией и, если на сервере новее — показывает
 * локальное уведомление. Работает при закрытом приложении; после перезагрузки
 * телефона расписание восстанавливается по BOOT_COMPLETED.
 *
 * Ограничение Android: при «принудительной остановке» приложения будильники не
 * срабатывают, пока пользователь снова не откроет приложение.
 */
public class UpdateCheckReceiver extends BroadcastReceiver {

    public static final String ACTION_CHECK_UPDATE = "com.pixivdl.application.ACTION_CHECK_UPDATE";

    private static final String UPDATE_URL = "https://files.nothalk.fun/PixivDL/update.json";
    private static final String CHANNEL_ID = "pixiv_dl_updates";
    private static final String PREFS_NAME = "pixiv_auth";
    private static final String KEY_LAST_NOTIFIED = "last_notified_update_version";
    private static final String KEY_LAST_NOTIFIED_WEB = "last_notified_hotfix_version";
    private static final String KEY_LOCAL_WEB_VERSION = "local_web_version";
    private static final int WEB_VERSION_BASE = 1; // соответствует CURRENT_WEB_VERSION в app.js
    private static final long INTERVAL = 60 * 1000L; // 1 минута
    private static final int REQUEST_CODE = 7001;
    private static final int NOTIFICATION_ID = 20250;

    // Планирует (или перепланирует) периодическую проверку обновлений.
    public static void schedule(Context context) {
        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;

        Intent intent = new Intent(context, UpdateCheckReceiver.class);
        intent.setAction(ACTION_CHECK_UPDATE);

        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pi = PendingIntent.getBroadcast(context, REQUEST_CODE, intent, flags);

        // Неточный повтор — щадит батарею; первая проверка примерно через минуту
        am.setInexactRepeating(
                AlarmManager.ELAPSED_REALTIME_WAKEUP,
                SystemClock.elapsedRealtime() + 60 * 1000L,
                INTERVAL,
                pi);
    }

    @Override
    public void onReceive(final Context context, Intent intent) {
        // После перезагрузки телефона восстанавливаем расписание
        if (intent != null && Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) {
            schedule(context);
        }

        final PendingResult result = goAsync(); // даём время на сетевой запрос вне основного потока
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    checkForUpdate(context.getApplicationContext());
                } catch (Exception e) {
                    e.printStackTrace();
                } finally {
                    result.finish();
                }
            }
        }).start();
    }

    private void checkForUpdate(Context context) {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(UPDATE_URL + "?t=" + SystemClock.elapsedRealtime());
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(5000);
            conn.setReadTimeout(5000);
            conn.setUseCaches(false);

            if (conn.getResponseCode() < 200 || conn.getResponseCode() >= 300) return;

            StringBuilder sb = new StringBuilder();
            BufferedReader br = new BufferedReader(new InputStreamReader(conn.getInputStream(), "UTF-8"));
            String line;
            while ((line = br.readLine()) != null) sb.append(line);
            br.close();

            JSONObject data = new JSONObject(sb.toString());
            int serverVersion = data.optInt("native_version", 0);
            int serverWebVersion = data.optInt("web_version", 0);

            SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            int localWebVersion = prefs.getInt(KEY_LOCAL_WEB_VERSION, WEB_VERSION_BASE);

            // Полноценное обновление приложения (APK)
            boolean nativeUpdate = serverVersion > MainActivity.NATIVE_APP_VERSION
                    && prefs.getInt(KEY_LAST_NOTIFIED, 0) < serverVersion;
            // Хотфикс (веб-патч OTA)
            boolean hotfixUpdate = serverWebVersion > localWebVersion
                    && prefs.getInt(KEY_LAST_NOTIFIED_WEB, 0) < serverWebVersion;

            if (!nativeUpdate && !hotfixUpdate) return; // ничего нового

            String changelog;
            Object cl = data.opt("changelog");
            if (cl instanceof org.json.JSONArray) {
                StringBuilder c = new StringBuilder();
                org.json.JSONArray arr = (org.json.JSONArray) cl;
                for (int i = 0; i < arr.length(); i++) {
                    if (c.length() > 0) c.append("\n");
                    c.append(arr.optString(i));
                }
                changelog = c.toString();
            } else {
                changelog = data.optString("changelog", "Откройте приложение, чтобы установить новую версию.");
            }

            showNotification(context, changelog);

            // Запоминаем, чтобы не дублировать одно и то же
            SharedPreferences.Editor ed = prefs.edit();
            if (nativeUpdate) ed.putInt(KEY_LAST_NOTIFIED, serverVersion);
            if (hotfixUpdate) ed.putInt(KEY_LAST_NOTIFIED_WEB, serverWebVersion);
            ed.apply();
        } catch (Exception e) {
            e.printStackTrace();
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private void showNotification(Context context, String body) {
        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID, "Обновления", NotificationManager.IMPORTANCE_HIGH);
            channel.setDescription("Уведомления о выходе новых версий PixivDL");
            nm.createNotificationChannel(channel);
        }

        Intent open = new Intent(context, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent contentIntent = PendingIntent.getActivity(context, 0, open, flags);

        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= 26) {
            builder = new Notification.Builder(context, CHANNEL_ID);
        } else {
            builder = new Notification.Builder(context);
        }

        builder.setContentTitle("Доступно обновление PixivDL")
               .setContentText(body)
               .setSmallIcon(R.drawable.ic_launcher)
               .setAutoCancel(true)
               .setContentIntent(contentIntent)
               .setStyle(new Notification.BigTextStyle().bigText(body));

        nm.notify(NOTIFICATION_ID, builder.build());
    }
}
