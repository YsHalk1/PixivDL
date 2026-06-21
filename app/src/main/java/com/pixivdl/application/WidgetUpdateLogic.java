package com.pixivdl.application;

import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.PorterDuff;
import android.graphics.PorterDuffXfermode;
import android.graphics.Rect;
import android.graphics.RectF;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Random;
import org.json.JSONArray;
import org.json.JSONObject;

public class WidgetUpdateLogic {

    // Добавили параметры appWidgetId и флаг is2x2
    public static void fetchAndSetPopularArt(Context context, int appWidgetId, boolean is2x2) {
        try {
            JSONObject jSONObject = null;
            String string = context.getSharedPreferences("pixiv_auth", Context.MODE_PRIVATE).getString("access_token", null);
            if (string == null) return;

            HttpURLConnection httpURLConnection = (HttpURLConnection) new URL("https://app-api.pixiv.net/v1/illust/recommended?include_ranking_illusts=true").openConnection();
            httpURLConnection.setRequestMethod("GET");
            httpURLConnection.setRequestProperty("Authorization", "Bearer " + string);
            httpURLConnection.setRequestProperty("User-Agent", "PixivAndroidApp/5.0.234 Android");

            // Таймауты, чтобы не висло по 3 минуты, если Pixiv тупит
            httpURLConnection.setConnectTimeout(10000);
            httpURLConnection.setReadTimeout(10000);

            if (httpURLConnection.getResponseCode() == 200) {
                BufferedReader bufferedReader = new BufferedReader(new InputStreamReader(httpURLConnection.getInputStream()));
                StringBuilder sb = new StringBuilder();
                while (true) {
                    String line = bufferedReader.readLine();
                    if (line == null) break;
                    sb.append(line);
                }

                JSONArray jSONArray = new JSONObject(sb.toString()).getJSONArray("illusts");
                if (jSONArray.length() > 0) {
                    int i = 0;
                    while (i < jSONArray.length()) {
                        JSONObject jSONObject2 = jSONArray.getJSONObject(new Random().nextInt(jSONArray.length()));
                        double dOptInt = ((double) jSONObject2.optInt("width", 1)) / ((double) jSONObject2.optInt("height", 1));
                        boolean z = jSONObject2.optInt("illust_ai_type") == 2;
                        int iOptInt = jSONObject2.optInt("x_restrict");

                        if (z || iOptInt != 0 || dOptInt <= 0.7d || dOptInt >= 1.4d) {
                            i++;
                        } else {
                            jSONObject = jSONObject2;
                            break;
                        }
                    }
                    if (jSONObject == null) jSONObject = jSONArray.getJSONObject(0);

                    // Берем medium для скорости, если нет - large
                    JSONObject imageUrls = jSONObject.getJSONObject("image_urls");
                    String imageUrl = imageUrls.optString("medium", imageUrls.optString("large"));
                    String illustId = jSONObject.optString("id");

                    // Передаем данные дальше
                    processAndSave(context, imageUrl, illustId, appWidgetId, is2x2);
                }
            }
        } catch (Exception e) { e.printStackTrace(); }
    }

    private static void processAndSave(Context context, String str, String str2, int appWidgetId, boolean is2x2) throws Exception {
        HttpURLConnection httpURLConnection = (HttpURLConnection) new URL(str).openConnection();
        httpURLConnection.setRequestProperty("Referer", "https://app-api.pixiv.net/");
        httpURLConnection.setConnectTimeout(15000);
        httpURLConnection.setReadTimeout(15000);

        InputStream inputStream = httpURLConnection.getInputStream();
        Bitmap bitmapDecodeStream = BitmapFactory.decodeStream(inputStream);
        inputStream.close();
        if (bitmapDecodeStream == null) return;

        int iMin = Math.min(bitmapDecodeStream.getWidth(), bitmapDecodeStream.getHeight());
        Bitmap bitmapCreateBitmap = Bitmap.createBitmap(bitmapDecodeStream, (bitmapDecodeStream.getWidth() - iMin) / 2, (bitmapDecodeStream.getHeight() - iMin) / 2, iMin, iMin);
        bitmapDecodeStream.recycle();

        Bitmap bitmapCreateScaledBitmap = Bitmap.createScaledBitmap(bitmapCreateBitmap, 400, 400, true);
        bitmapCreateBitmap.recycle();

        File file = new File(context.getFilesDir(), "Widget");
        if (!file.exists()) file.mkdirs();

        // Если это 2x2, радиус 45. Иначе 25.
        int radius = is2x2 ? 40 : 25;
        Bitmap roundedCornerBitmap = getRoundedCornerBitmap(bitmapCreateScaledBitmap, radius);
        bitmapCreateScaledBitmap.recycle();

        // УНИКАЛЬНОЕ ИМЯ ФАЙЛА ДЛЯ ЭТОГО ВИДЖЕТА
        File file2 = new File(file, "art_" + appWidgetId + ".png");
        FileOutputStream fileOutputStream = new FileOutputStream(file2);
        roundedCornerBitmap.compress(Bitmap.CompressFormat.PNG, 100, fileOutputStream);
        fileOutputStream.flush();
        fileOutputStream.close();
        roundedCornerBitmap.recycle();

        // УНИКАЛЬНЫЕ НАСТРОЙКИ
        context.getSharedPreferences("PixivWidgetPrefs", Context.MODE_PRIVATE).edit()
            .putString("widget_image_path_" + appWidgetId, file2.getAbsolutePath())
            .putString("widget_illust_id_" + appWidgetId, str2)
            .apply();

        // ОБНОВЛЯЕМ ТОЛЬКО ТОТ ВИДЖЕТ, КОТОРЫЙ ПРОСИЛ
        Intent intent;
        if (is2x2) {
            intent = new Intent(context, ArtWidgetProvider2x2.class);
        } else {
            intent = new Intent(context, ArtWidgetProvider.class); // Убедись, что класс 3x3 так называется
        }
        intent.setAction(AppWidgetManager.ACTION_APPWIDGET_UPDATE);
        intent.putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, new int[]{appWidgetId});
        context.sendBroadcast(intent);
    }

    private static Bitmap getRoundedCornerBitmap(Bitmap bitmap, int i) {
        Bitmap bitmapCreateBitmap = Bitmap.createBitmap(bitmap.getWidth(), bitmap.getHeight(), Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmapCreateBitmap);
        Paint paint = new Paint();
        Rect rect = new Rect(0, 0, bitmap.getWidth(), bitmap.getHeight());
        RectF rectF = new RectF(rect);
        paint.setAntiAlias(true);
        canvas.drawARGB(0, 0, 0, 0);
        float f = i;
        canvas.drawRoundRect(rectF, f, f, paint);
        paint.setXfermode(new PorterDuffXfermode(PorterDuff.Mode.SRC_IN));
        canvas.drawBitmap(bitmap, rect, rect, paint);
        return bitmapCreateBitmap;
    }
}
