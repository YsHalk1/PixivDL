package com.pixivdl.application;

import android.content.Intent;
import android.net.Uri;
import android.os.Environment;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

import androidx.core.content.FileProvider;


public class ApkUpdater {

    private final MainActivity activity;

    public ApkUpdater(MainActivity activity) {
        this.activity = activity;
    }

    public void downloadAndInstall(final String urlStr) {
        activity.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        activity.runJs("document.getElementById('apkDownloadBtn').innerText = 'Загрузка... Пожалуйста, подождите';");
                        activity.runJs("document.getElementById('apkDownloadBtn').disabled = true;");
                    } catch (Exception ignored) {}
                }
            });

        new Thread(new Runnable() {
                @Override
                public void run() {
                    HttpURLConnection conn = null;
                    InputStream is = null;
                    FileOutputStream os = null;

                    try {
                        URL url = new URL(urlStr);
                        conn = (HttpURLConnection) url.openConnection();
                        conn.connect();

                        if (conn.getResponseCode() != HttpURLConnection.HTTP_OK) {
                            showToast("Ошибка скачивания APK: " + conn.getResponseCode());
                            return;
                        }

                        is = conn.getInputStream();
                        File apkFile = new File(activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "update.apk");
                        os = new FileOutputStream(apkFile);

                        byte[] buffer = new byte[4096];
                        int bytesRead;
                        while ((bytesRead = is.read(buffer)) != -1) {
                            os.write(buffer, 0, bytesRead);
                        }

                        os.flush();
                        os.close();      // закрываем поток
                        os = null;       // убираем ссылку для GC
                        showToast("Скачивание завершено, установка...");

                        if (!apkFile.exists()) {
                            showToast("APK файл не найден!");
                            return;
                        }

                        installApk(apkFile);

                    } catch (Exception e) {
                        e.printStackTrace();
                        showToast("Ошибка обновления: " + e.getMessage());
                    } finally {
                        try { if (os != null) os.close(); } catch (Exception ignored) {}
                        try { if (is != null) is.close(); } catch (Exception ignored) {}
                        if (conn != null) conn.disconnect();

                        activity.runOnUiThread(new Runnable() {
                                @Override
                                public void run() {
                                    try {
                                        activity.runJs("document.getElementById('apkDownloadBtn').innerText = 'Обновить APK';");
                                        activity.runJs("document.getElementById('apkDownloadBtn').disabled = false;");
                                    } catch (Exception ignored) {}
                                }
                            });
                    }
                }
            }).start();
    }

    

    private void installApk(File apkFile) {
        if (!apkFile.exists()) {
            showToast("APK файл не найден!");
            return;
        }
        try {
            Uri apkUri = FileProvider.getUriForFile(
                activity,
                activity.getPackageName() + ".fileprovider",
                apkFile
            );
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(apkUri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(intent);
        } catch (Exception e) {
            e.printStackTrace();
            showToast("Не удалось запустить установку: " + e.getMessage());
        }
    }

    private void showToast(final String msg) {
        activity.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    Toast.makeText(activity, msg, Toast.LENGTH_LONG).show();
                }
            });
    }
}

