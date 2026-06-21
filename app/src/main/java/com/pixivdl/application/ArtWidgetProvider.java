package com.pixivdl.application;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
import android.view.View;
import android.widget.RemoteViews;
import java.io.File;

public class ArtWidgetProvider extends AppWidgetProvider {

    public static final String ACTION_AUTO_UPDATE_3X3 = "com.pixivdl.application.ACTION_AUTO_UPDATE_3X3";
    public static final String ACTION_RELOAD_WIDGET_3X3 = "com.pixivdl.application.ACTION_RELOAD_WIDGET_3X3";

    @Override
    public void onEnabled(Context context) {
        super.onEnabled(context);
        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        Intent intent = new Intent(context, ArtWidgetProvider.class);
        intent.setAction(ACTION_AUTO_UPDATE_3X3);
        int flags = Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE : PendingIntent.FLAG_UPDATE_CURRENT;
        PendingIntent pi = PendingIntent.getBroadcast(context, 0, intent, flags);
        am.setInexactRepeating(AlarmManager.ELAPSED_REALTIME_WAKEUP, SystemClock.elapsedRealtime() + 1000, 5 * 60 * 1000, pi);
    }

    @Override
    public void onDisabled(Context context) {
        super.onDisabled(context);
        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        Intent intent = new Intent(context, ArtWidgetProvider.class);
        intent.setAction(ACTION_AUTO_UPDATE_3X3);
        int flags = Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE : PendingIntent.FLAG_UPDATE_CURRENT;
        PendingIntent pi = PendingIntent.getBroadcast(context, 0, intent, flags);
        am.cancel(pi);
    }

    @Override
    public void onReceive(final Context context, Intent intent) {
        super.onReceive(context, intent);

        if (ACTION_RELOAD_WIDGET_3X3.equals(intent.getAction())) {
            // Кликнули "Обновить" на конкретном виджете
            final int widgetId = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID);
            if (widgetId != AppWidgetManager.INVALID_APPWIDGET_ID) {

                // 1. ВИЗУАЛЬНЫЙ ОТКЛИК: Меняем текст на виджете
                AppWidgetManager appWidgetManager = AppWidgetManager.getInstance(context);
                RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_art);
                views.setViewVisibility(R.id.widget_empty_text, View.VISIBLE);
                views.setTextViewText(R.id.widget_empty_text, "Обновляю...");
                appWidgetManager.partiallyUpdateAppWidget(widgetId, views);

                // 2. ЗАПУСКАЕМ ЗАГРУЗКУ (передаем false, так как это 3x3)
                new Thread(new Runnable() {
                        @Override
                        public void run() { 
                            WidgetUpdateLogic.fetchAndSetPopularArt(context, widgetId, false); 
                        }
                    }).start();
            }
        } else if (ACTION_AUTO_UPDATE_3X3.equals(intent.getAction())) {
            // Сработал таймер: обновляем ВСЕ виджеты 3x3
            AppWidgetManager am = AppWidgetManager.getInstance(context);
            int[] ids = am.getAppWidgetIds(new ComponentName(context, ArtWidgetProvider.class));
            for (final int id : ids) {
                new Thread(new Runnable() {
                        @Override
                        public void run() { WidgetUpdateLogic.fetchAndSetPopularArt(context, id, false); }
                    }).start();
            }
        }
    }

    @Override
    public void onUpdate(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
        for (int i : appWidgetIds) {
            updateAppWidget(context, appWidgetManager, i);
        }
    }

    static void updateAppWidget(final Context context, AppWidgetManager appWidgetManager, final int appWidgetId) {
        boolean imageLoaded = false;
        int flags = Build.VERSION.SDK_INT < 23 ? PendingIntent.FLAG_UPDATE_CURRENT : PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;

        RemoteViews remoteViews = new RemoteViews(context.getPackageName(), R.layout.widget_art);

        // ЧИТАЕМ УНИКАЛЬНЫЙ ФАЙЛ
        String imagePath = context.getSharedPreferences("PixivWidgetPrefs", Context.MODE_PRIVATE).getString("widget_image_path_" + appWidgetId, null);

        if (imagePath != null && new File(imagePath).exists()) {
            try {
                Bitmap bitmapDecodeFile = BitmapFactory.decodeFile(imagePath);
                if (bitmapDecodeFile != null) {
                    remoteViews.setImageViewBitmap(R.id.widget_image, bitmapDecodeFile);
                    remoteViews.setViewVisibility(R.id.widget_empty_text, View.GONE);
                    imageLoaded = true;
                }
            } catch (Exception e) { e.printStackTrace(); }
        }

        if (!imageLoaded) {
            remoteViews.setImageViewBitmap(R.id.widget_image, null);
            remoteViews.setViewVisibility(R.id.widget_empty_text, View.VISIBLE);

            // Загружаем арт при первом добавлении
            new Thread(new Runnable() {
                    @Override
                    public void run() { WidgetUpdateLogic.fetchAndSetPopularArt(context, appWidgetId, false); }
                }).start();
        }

        // ЧИТАЕМ УНИКАЛЬНЫЙ ID АРТА
        String illustId = context.getSharedPreferences("PixivWidgetPrefs", Context.MODE_PRIVATE).getString("widget_illust_id_" + appWidgetId, "");

        Intent appIntent = new Intent(context, MainActivity.class);

        // --- ФИКС: ДОБАВЛЯЕМ ФЛАГИ ОТ ПЕРЕЗАПУСКА ПРИЛОЖЕНИЯ ---
        appIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);

        if (illustId != null && !illustId.isEmpty()) {
            appIntent.putExtra("widget_target_illust_id", illustId);
            // Добавили widgetId в ссылку, чтобы Android не склеивал клики разных виджетов
            appIntent.setData(Uri.parse("pixivdl://widget/artworks/" + illustId + "?widgetId=" + appWidgetId));
        }

        // Уникальный requestCode = appWidgetId
        remoteViews.setOnClickPendingIntent(R.id.widget_image, PendingIntent.getActivity(context, appWidgetId, appIntent, flags));

        // НАСТРОЙКА КНОПКИ ОБНОВЛЕНИЯ
        Intent reloadIntent = new Intent(context, ArtWidgetProvider.class);
        reloadIntent.setAction(ACTION_RELOAD_WIDGET_3X3);
        reloadIntent.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId);

        // ФИКС: Оставили только requestCode (appWidgetId), этого достаточно для уникальности!
        remoteViews.setOnClickPendingIntent(R.id.widget_btn_reload, PendingIntent.getBroadcast(context, appWidgetId, reloadIntent, flags));

        appWidgetManager.updateAppWidget(appWidgetId, remoteViews);
    }
}
