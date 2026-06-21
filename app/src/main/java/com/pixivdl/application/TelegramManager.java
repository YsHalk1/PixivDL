package com.pixivdl.application;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.DataOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.util.LinkedHashSet;
import java.util.Set;

/**
 * Привязка Telegram-БОТА через Bot API (https://core.telegram.org/bots/api).
 *
 * Зачем так, а не аккаунт: для аккаунта нужен TDLib (нативные .so + api_id/hash + вход по телефону).
 * Бот проще — это обычные HTTPS-запросы к api.telegram.org по токену от @BotFather, без нативных
 * библиотек и без логина пользователя.
 *
 * ВАЖНОЕ ОГРАНИЧЕНИЕ Bot API: метода "дай все чаты бота" не существует. Бот узнаёт о чате только
 * через getUpdates (когда туда что-то приходит: сообщение, его добавили/сменили права и т.п.).
 * Поэтому канал появится в списке, только если:
 *   - бот добавлен в него администратором с правом отправки сообщений, И
 *   - по нему прилетело хоть одно обновление (или он уже был сохранён ранее), И
 *   - на бота НЕ установлен webhook (иначе getUpdates пуст).
 * Найденные чаты мы накапливаем в SharedPreferences, чтобы список не терялся со временем.
 */
public class TelegramManager {

    private static final String API = "https://api.telegram.org/bot";
    private static final String PREFS = "pixiv_auth";
    private static final String K_TOKEN = "tg_bot_token";
    private static final String K_BOT_ID = "tg_bot_id";
    private static final String K_BOT_USERNAME = "tg_bot_username";
    private static final String K_SEEN = "tg_seen_chats";
    private static final int HTTP_TIMEOUT = 20_000;

    /** Колбэки в UI (реализует MainActivity через runJs). */
    public interface TgEvents {
        void onState(String json);   // строка JSON состояния
        void onChannels(String b64); // base64(JSON) со списком каналов
    }

    private final Context appCtx;
    private final TgEvents events;

    public TelegramManager(Context ctx, TgEvents events) {
        this.appCtx = ctx.getApplicationContext();
        this.events = events;
    }

    // ============================================================
    //  Публичный API для моста
    // ============================================================

    /** Состояние при входе в раздел: привязан ли бот. */
    public void queryState() {
        runBg(new Runnable() { public void run() {
            String token = prefs().getString(K_TOKEN, "");
            if (token.length() == 0) { emitState("token", null, null, null, false); return; }
            // Проверяем, что токен ещё валиден.
            JSONObject me = api(token, "getMe", null);
            if (me == null || !me.optBoolean("ok", false)) {
                clearStored();
                emitState("token", null, null, "Токен недействителен, привяжите заново", false);
                return;
            }
            JSONObject res = me.optJSONObject("result");
            persistBot(token, res);
            emitReady(res);
            doListChannels(token);
        }});
    }

    /** Привязать бота по токену от @BotFather. */
    public void setToken(final String rawToken) {
        final String token = rawToken == null ? "" : rawToken.trim();
        emitState("loading", null, null, null, false);
        runBg(new Runnable() { public void run() {
            if (!looksLikeToken(token)) {
                emitState("token", null, null, "Похоже, это не токен бота", false);
                return;
            }
            JSONObject me = api(token, "getMe", null);
            if (me == null || !me.optBoolean("ok", false)) {
                emitState("token", null, null, "Неверный токен или нет сети", false);
                return;
            }
            JSONObject res = me.optJSONObject("result");
            persistBot(token, res);
            emitReady(res);
            doListChannels(token);
        }});
    }

    public void listChannels() {
        runBg(new Runnable() { public void run() {
            String token = prefs().getString(K_TOKEN, "");
            if (token.length() == 0) { emitState("token", null, null, null, false); return; }
            doListChannels(token);
        }});
    }

    /**
     * Добавить канал/группу вручную по @username или числовому ID — надёжный путь,
     * не зависящий от getUpdates. Проверяем чат через getChat и сохраняем в seen.
     */
    public void addChat(final String rawRef) {
        runBg(new Runnable() { public void run() {
            String token = prefs().getString(K_TOKEN, "");
            if (token.length() == 0) { emitState("token", null, null, null, false); return; }

            String ref = rawRef == null ? "" : rawRef.trim();
            if (ref.length() == 0) { emitToast("Введите @username или ID канала"); return; }
            // Нормализуем: ссылку t.me/xxx -> @xxx; голый username -> @username.
            int slash = ref.lastIndexOf('/');
            if (ref.startsWith("http") && slash >= 0) ref = ref.substring(slash + 1);
            boolean numeric = ref.matches("^-?\\d+$");
            if (!numeric && !ref.startsWith("@")) ref = "@" + ref;

            // Для числового ID пробуем разумные варианты: как введено, и с супергруппным
            // префиксом -100 (Bot API ждёт каналы/супергруппы в виде -100xxxxxxxxxx).
            java.util.List<String> candidates = new java.util.ArrayList<>();
            if (numeric) {
                String digits = ref.startsWith("-") ? ref.substring(1) : ref;
                candidates.add(ref);                                   // как ввёл пользователь
                if (!ref.startsWith("-100")) candidates.add("-100" + digits); // дописываем префикс
                if (!ref.startsWith("-")) candidates.add("-" + digits);       // на случай обычной группы
            } else {
                candidates.add(ref);
            }

            JSONObject chatResp = null;
            String lastDesc = "не найдено";
            for (String cand : candidates) {
                JSONObject r = api(token, "getChat", "chat_id=" + enc(cand));
                if (r != null && r.optBoolean("ok", false)) { chatResp = r; break; }
                if (r == null) lastDesc = "нет сети";
                else lastDesc = r.optString("description", "не найдено");
            }

            if (chatResp == null) {
                emitToast("Не удалось добавить: " + lastDesc + ". Бот должен быть участником/админом этого канала.");
                doListChannels(token);
                return;
            }
            JSONObject chat = chatResp.optJSONObject("result");
            long id = chat == null ? 0 : chat.optLong("id", 0);
            if (id == 0) { emitToast("Не удалось определить ID канала"); doListChannels(token); return; }

            Set<String> seen = loadSeen();
            seen.add(String.valueOf(id));
            saveSeen(seen);
            emitToast("Канал добавлен");
            doListChannels(token);
        }});
    }

    public void logout() {
        runBg(new Runnable() { public void run() {
            clearStored();
            emitState("token", null, null, null, false);
        }});
    }

    /** Текущий сохранённый токен бота (или пустая строка). Для оркестрации отправки из MainActivity. */
    public String getToken() {
        return prefs().getString(K_TOKEN, "");
    }

    /** Короткое уведомление пользователю (публичная обёртка над emitToast). */
    public void toast(String message) { emitToast(message); }

    /**
     * Отправить одно фото в чат через sendPhoto (multipart/form-data).
     * photo — сырые байты изображения, fileName — имя для вложения.
     * Возвращает true при ok=true. Telegram пережимает фото (~1280px, JPEG) — это ожидаемо.
     */
    public boolean sendPhoto(String token, String chatId, byte[] photo, String fileName, String caption, String parseMode) {
        String boundary = "----PixivDL" + System.identityHashCode(photo) + "x" + photo.length;
        HttpURLConnection conn = null;
        try {
            URL url = new URL(API + token + "/sendPhoto");
            conn = (HttpURLConnection) url.openConnection();
            conn.setDoOutput(true);
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(HTTP_TIMEOUT);
            conn.setReadTimeout(60_000);
            conn.setRequestProperty("Connection", "Keep-Alive");
            conn.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);

            DataOutputStream out = new DataOutputStream(conn.getOutputStream());
            writeField(out, boundary, "chat_id", chatId);
            if (caption != null && caption.length() > 0) {
                writeField(out, boundary, "caption", caption);
                if (parseMode != null && parseMode.length() > 0) writeField(out, boundary, "parse_mode", parseMode);
            }
            // Файловое поле "photo".
            out.writeBytes("--" + boundary + "\r\n");
            out.writeBytes("Content-Disposition: form-data; name=\"photo\"; filename=\"" + fileName + "\"\r\n");
            out.writeBytes("Content-Type: application/octet-stream\r\n\r\n");
            out.write(photo);
            out.writeBytes("\r\n");
            out.writeBytes("--" + boundary + "--\r\n");
            out.flush();
            out.close();

            int code = conn.getResponseCode();
            InputStream is = (code >= 200 && code < 400) ? conn.getInputStream() : conn.getErrorStream();
            String body = readAll(is);
            JSONObject resp = (body == null) ? null : new JSONObject(body);
            return resp != null && resp.optBoolean("ok", false);
        } catch (Throwable t) {
            return false;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /**
     * Отправить альбом фото одним сообщением через sendMediaGroup (multipart/form-data).
     * photos[from .. from+count-1] — байты изображений (count: 2..10). caption — на первом фото.
     * Если count == 1 — fallback на sendPhoto (sendMediaGroup требует минимум 2 элемента).
     * Возвращает true при ok=true.
     */
    public boolean sendMediaGroup(String token, String chatId, byte[][] photos, int from, int count, String caption, String parseMode) {
        if (count <= 0) return false;
        if (count == 1) return sendPhoto(token, chatId, photos[from], "pixiv.jpg", caption, parseMode);

        String boundary = "----PixivDLgroup" + System.identityHashCode(photos) + "x" + from + "x" + count;
        HttpURLConnection conn = null;
        try {
            // Описание медиа: массив {type:photo, media:attach://photoN, caption?, parse_mode?}.
            JSONArray media = new JSONArray();
            for (int i = 0; i < count; i++) {
                JSONObject m = new JSONObject();
                m.put("type", "photo");
                m.put("media", "attach://photo" + i);
                if (i == 0 && caption != null && caption.length() > 0) {
                    m.put("caption", caption);
                    if (parseMode != null && parseMode.length() > 0) m.put("parse_mode", parseMode);
                }
                media.put(m);
            }

            URL url = new URL(API + token + "/sendMediaGroup");
            conn = (HttpURLConnection) url.openConnection();
            conn.setDoOutput(true);
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(HTTP_TIMEOUT);
            conn.setReadTimeout(120_000);
            conn.setRequestProperty("Connection", "Keep-Alive");
            conn.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);

            DataOutputStream out = new DataOutputStream(conn.getOutputStream());
            writeField(out, boundary, "chat_id", chatId);
            writeField(out, boundary, "media", media.toString());
            for (int i = 0; i < count; i++) {
                byte[] photo = photos[from + i];
                out.writeBytes("--" + boundary + "\r\n");
                out.writeBytes("Content-Disposition: form-data; name=\"photo" + i + "\"; filename=\"photo" + i + ".jpg\"\r\n");
                out.writeBytes("Content-Type: application/octet-stream\r\n\r\n");
                out.write(photo);
                out.writeBytes("\r\n");
            }
            out.writeBytes("--" + boundary + "--\r\n");
            out.flush();
            out.close();

            int code = conn.getResponseCode();
            InputStream is = (code >= 200 && code < 400) ? conn.getInputStream() : conn.getErrorStream();
            String body = readAll(is);
            JSONObject resp = (body == null) ? null : new JSONObject(body);
            return resp != null && resp.optBoolean("ok", false);
        } catch (Throwable t) {
            return false;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static void writeField(DataOutputStream out, String boundary, String name, String value) throws Exception {
        out.writeBytes("--" + boundary + "\r\n");
        out.writeBytes("Content-Disposition: form-data; name=\"" + name + "\"\r\n");
        out.writeBytes("Content-Type: text/plain; charset=UTF-8\r\n\r\n");
        out.write(value.getBytes("UTF-8"));
        out.writeBytes("\r\n");
    }

    private static String readAll(InputStream is) {
        if (is == null) return null;
        try {
            StringBuilder sb = new StringBuilder();
            BufferedReader br = new BufferedReader(new InputStreamReader(is, "UTF-8"));
            String line;
            while ((line = br.readLine()) != null) sb.append(line);
            br.close();
            return sb.toString();
        } catch (Throwable t) { return null; }
    }

    // ============================================================
    //  Сбор каналов с правом отправки
    // ============================================================

    private void doListChannels(String token) {
        try {
            long botId = prefs().getLong(K_BOT_ID, 0);
            Set<String> seen = loadSeen();

            // 1. Тянем свежие обновления и добавляем оттуда новые чаты.
            // ВАЖНО: без offset, чтобы не подтверждать (не "съедать") апдейты — иначе следующий
            // вызов их уже не увидит. Telegram всё равно вернёт всю неподтверждённую очередь (<24ч).
            String upArgs = "limit=100&timeout=0&allowed_updates="
                    + enc("[\"message\",\"channel_post\",\"edited_channel_post\",\"my_chat_member\",\"chat_member\"]");
            JSONObject updates = api(token, "getUpdates", upArgs);
            if (updates != null && updates.optBoolean("ok", false)) {
                JSONArray arr = updates.optJSONArray("result");
                if (arr != null) {
                    for (int i = 0; i < arr.length(); i++) {
                        collectChatIds(arr.optJSONObject(i), seen);
                    }
                }
            }
            saveSeen(seen);

            // 2. По каждому известному чату проверяем тип и право бота отправлять.
            JSONArray channels = new JSONArray();
            for (String idStr : seen) {
                try {
                    JSONObject ch = inspectChat(token, botId, idStr);
                    if (ch != null) channels.put(ch);
                } catch (Throwable ignored) {}
            }

            saveSeen(seen);

            JSONObject root = new JSONObject();
            root.put("channels", channels);
            events.onChannels(b64(root.toString()));
        } catch (Throwable t) {
            events.onChannels(b64("{\"channels\":[]}"));
        }
    }

    private void collectChatIds(JSONObject update, Set<String> seen) {
        if (update == null) return;
        String[] holders = {"message", "channel_post", "edited_channel_post",
                "edited_message", "my_chat_member", "chat_member"};
        for (String h : holders) {
            JSONObject obj = update.optJSONObject(h);
            if (obj == null) continue;
            JSONObject chat = obj.optJSONObject("chat");
            if (chat == null) continue;
            long id = chat.optLong("id", 0);
            String type = chat.optString("type", "");
            // Интересуют только группы/супергруппы/каналы, не личка.
            if (id != 0 && !"private".equals(type)) seen.add(String.valueOf(id));
        }
    }

    /** Возвращает JSON чата, если бот может туда писать; null если нет/ошибка (и убирает из seen). */
    private JSONObject inspectChat(String token, long botId, String chatIdStr) throws Exception {
        JSONObject chatResp = api(token, "getChat", "chat_id=" + enc(chatIdStr));
        if (chatResp == null || !chatResp.optBoolean("ok", false)) {
            return null; // оставляем в seen: возможно временная ошибка сети
        }
        JSONObject chat = chatResp.optJSONObject("result");
        if (chat == null) return null;

        String type = chat.optString("type", "");
        boolean isChannel = "channel".equals(type);
        boolean isGroup = "group".equals(type) || "supergroup".equals(type);
        if (!isChannel && !isGroup) return null;

        // 0 = бота нет (left/kicked) -> скрыть; 1 = есть, но без права постить; 2 = может постить.
        int access = botAccess(token, botId, chatIdStr, isChannel);
        if (access == 0) return null;

        String title = chat.optString("title", "");
        String username = chat.optString("username", "");
        long members = 0;
        JSONObject cnt = api(token, "getChatMemberCount", "chat_id=" + enc(chatIdStr));
        if (cnt != null && cnt.optBoolean("ok", false)) members = cnt.optLong("result", 0);

        JSONObject o = new JSONObject();
        o.put("id", chatIdStr);
        o.put("title", title);
        if (username.length() > 0) o.put("username", username);
        if (members > 0) o.put("members", members);
        o.put("isChannel", isChannel);
        o.put("canPost", access == 2);

        // Аватарка чата: chat.photo.small_file_id -> getFile -> скачиваем -> data URI.
        // URL файла содержит токен бота, поэтому в WebView отдаём только base64-картинку.
        try {
            JSONObject photo = chat.optJSONObject("photo");
            if (photo != null) {
                String fileId = photo.optString("small_file_id", "");
                if (fileId.length() > 0) {
                    String dataUri = fetchAvatarDataUri(token, fileId);
                    if (dataUri != null) o.put("photo", dataUri);
                }
            }
        } catch (Throwable ignored) {}

        return o;
    }

    /** Скачивает файл по file_id и возвращает data:image/jpeg;base64,... (или null). */
    private String fetchAvatarDataUri(String token, String fileId) {
        try {
            JSONObject fr = api(token, "getFile", "file_id=" + enc(fileId));
            if (fr == null || !fr.optBoolean("ok", false)) return null;
            JSONObject res = fr.optJSONObject("result");
            String path = res == null ? "" : res.optString("file_path", "");
            if (path.length() == 0) return null;

            byte[] bytes = downloadFileBytes(token, path);
            if (bytes == null || bytes.length == 0) return null;
            return "data:image/jpeg;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP);
        } catch (Throwable t) {
            return null;
        }
    }

    /** Скачивает байты файла из https://api.telegram.org/file/bot<token>/<path>. */
    private byte[] downloadFileBytes(String token, String filePath) {
        HttpURLConnection conn = null;
        InputStream is = null;
        try {
            URL url = new URL("https://api.telegram.org/file/bot" + token + "/" + filePath);
            conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(HTTP_TIMEOUT);
            conn.setReadTimeout(HTTP_TIMEOUT);
            conn.setRequestMethod("GET");
            int code = conn.getResponseCode();
            if (code < 200 || code >= 400) return null;
            is = conn.getInputStream();
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = is.read(buf)) != -1) bos.write(buf, 0, n);
            return bos.toByteArray();
        } catch (Throwable t) {
            return null;
        } finally {
            if (is != null) { try { is.close(); } catch (Exception ignored) {} }
            if (conn != null) conn.disconnect();
        }
    }

    /**
     * Уровень доступа бота к чату:
     *   0 — бота нет (left/kicked) либо запрос не удался;
     *   1 — бот присутствует, но НЕ может отправлять сообщения;
     *   2 — бот может отправлять сообщения.
     */
    private int botAccess(String token, long botId, String chatIdStr, boolean isChannel) {
        try {
            JSONObject mResp = api(token, "getChatMember",
                    "chat_id=" + enc(chatIdStr) + "&user_id=" + botId);
            if (mResp == null || !mResp.optBoolean("ok", false)) return 0;
            JSONObject m = mResp.optJSONObject("result");
            if (m == null) return 0;
            String status = m.optString("status", "");

            if ("creator".equals(status)) return 2; // боту недоступно, но на всякий
            if ("administrator".equals(status)) {
                if (isChannel) return m.optBoolean("can_post_messages", false) ? 2 : 1;
                // В группе админ может писать (если не урезали явно).
                return m.optBoolean("can_post_messages", true) ? 2 : 1;
            }
            if ("member".equals(status)) {
                // В канале обычный бот-участник постить не может; в группе — может.
                return isChannel ? 1 : 2;
            }
            if ("restricted".equals(status)) {
                return m.optBoolean("can_send_messages", false) ? 2 : 1;
            }
            return 0; // left / kicked
        } catch (Throwable t) {
            return 0;
        }
    }

    // ============================================================
    //  HTTP к Bot API
    // ============================================================

    /** GET-запрос к методу Bot API. args — уже сформированная query-строка (без ведущего '?') или null. */
    private JSONObject api(String token, String method, String args) {
        HttpURLConnection conn = null;
        try {
            String urlStr = API + token + "/" + method + (args != null && args.length() > 0 ? "?" + args : "");
            URL url = new URL(urlStr);
            conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(HTTP_TIMEOUT);
            conn.setReadTimeout(HTTP_TIMEOUT);
            conn.setRequestMethod("GET");

            int code = conn.getResponseCode();
            InputStream is = (code >= 200 && code < 400) ? conn.getInputStream() : conn.getErrorStream();
            if (is == null) return null;
            StringBuilder sb = new StringBuilder();
            BufferedReader br = new BufferedReader(new InputStreamReader(is, "UTF-8"));
            String line;
            while ((line = br.readLine()) != null) sb.append(line);
            br.close();
            return new JSONObject(sb.toString());
        } catch (Throwable t) {
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    // ============================================================
    //  Хранение токена и списка известных чатов
    // ============================================================

    private SharedPreferences prefs() {
        return appCtx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private void persistBot(String token, JSONObject me) {
        SharedPreferences.Editor e = prefs().edit();
        e.putString(K_TOKEN, token);
        if (me != null) {
            e.putLong(K_BOT_ID, me.optLong("id", 0));
            e.putString(K_BOT_USERNAME, me.optString("username", ""));
        }
        e.apply();
    }

    private void clearStored() {
        prefs().edit()
                .remove(K_TOKEN).remove(K_BOT_ID).remove(K_BOT_USERNAME).remove(K_SEEN)
                .apply();
    }

    private Set<String> loadSeen() {
        Set<String> out = new LinkedHashSet<>();
        String raw = prefs().getString(K_SEEN, "");
        if (raw.length() > 0) {
            for (String s : raw.split(",")) {
                String t = s.trim();
                if (t.length() > 0) out.add(t);
            }
        }
        return out;
    }

    private void saveSeen(Set<String> seen) {
        StringBuilder sb = new StringBuilder();
        for (String s : seen) { if (sb.length() > 0) sb.append(','); sb.append(s); }
        prefs().edit().putString(K_SEEN, sb.toString()).apply();
    }

    // ============================================================
    //  События в UI
    // ============================================================

    private void emitReady(JSONObject me) {
        String username = me == null ? null : me.optString("username", "");
        String name = me == null ? null : me.optString("first_name", "");
        emitState("ready", (username != null && username.length() > 0) ? username : null,
                (name != null && name.length() > 0) ? name : null, null, true);
    }

    private void emitState(String step, String username, String name, String error, boolean linked) {
        JSONObject o = new JSONObject();
        try {
            o.put("step", step);
            if (username != null) o.put("username", username);
            if (name != null) o.put("name", name);
            if (error != null) o.put("error", error);
            o.put("linked", linked);
        } catch (Throwable ignored) {}
        events.onState(o.toString());
    }

    /** Короткое уведомление пользователю (через тот же канал состояния, step="toast"). */
    private void emitToast(String message) {
        JSONObject o = new JSONObject();
        try { o.put("step", "toast"); o.put("error", message); } catch (Throwable ignored) {}
        events.onState(o.toString());
    }

    // ============================================================
    //  Утилиты
    // ============================================================

    private static boolean looksLikeToken(String t) {
        // Формат токена: <digits>:<35+ символов>
        return t != null && t.matches("^\\d{6,}:[A-Za-z0-9_\\-]{30,}$");
    }

    private static String enc(String s) {
        try { return URLEncoder.encode(s, "UTF-8"); } catch (Throwable t) { return s; }
    }

    private static void runBg(Runnable r) { new Thread(r).start(); }

    private static String b64(String s) {
        try { return Base64.encodeToString(s.getBytes("UTF-8"), Base64.NO_WRAP); }
        catch (Throwable t) { return ""; }
    }
}
