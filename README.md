<div align="center">

# PixivDL

**Android-приложение для просмотра и загрузки работ с Pixiv**

Нативная Java-оболочка вокруг WebView-интерфейса (HTML/CSS/JS) с виджетами,
уведомлениями, умным кэшем и интеграцией с Telegram.

![Platform](https://img.shields.io/badge/platform-Android-3DDC84?logo=android&logoColor=white)
![minSdk](https://img.shields.io/badge/minSdk-19-blue)
![targetSdk](https://img.shields.io/badge/targetSdk-34-blue)
![License](https://img.shields.io/badge/license-MIT-green)

</div>

---

## Возможности

- 🖼️ **Просмотр Pixiv** — лента, поиск, рекомендации, подписки, история, коллекции, страницы авторов.
- ⬇️ **Загрузка работ** — менеджер скачиваний с прогрессом и уведомлениями.
- 🧠 **Умный кэш** — предзагрузка и кэширование изображений для быстрого листания.
- 📲 **Виджеты рабочего стола** — `1×1` и `2×2` с автообновлением картинки.
- ✉️ **Отправка в Telegram** — привязка собственного бота (токен вводит пользователь) и отправка работ в чат/канал.
- 🔄 **Автообновление APK** — проверка и установка новых версий из приложения.

## Технологии

- **Язык:** Java (Android SDK)
- **UI:** WebView + HTML/CSS/JS (папка `app/src/main/assets`)
- **Сборка:** Gradle (Android Gradle Plugin 8.3.2)
- **minSdk 19**, **targetSdk 34**, `multiDex` включён

## Структура проекта

```
PixivDL/
├── app/
│   ├── src/main/
│   │   ├── java/com/pixivdl/application/   # Activity, виджеты, обновления, Telegram
│   │   ├── assets/                         # WebView-интерфейс (HTML/JS/CSS)
│   │   ├── res/                            # ресурсы Android (layout, drawable, values)
│   │   └── AndroidManifest.xml
│   └── build.gradle
├── gradle/wrapper/                         # Gradle Wrapper
├── build.gradle                            # корневой Gradle-скрипт
└── settings.gradle
```

## Сборка

Нужен установленный **Android SDK** и **JDK 8+**.

1. Склонируйте репозиторий:
   ```bash
   git clone https://github.com/YsHalk1/PixivDL.git
   cd PixivDL
   ```
2. Укажите путь к SDK в `local.properties` (файл создаётся локально, в репозиторий не входит):
   ```properties
   sdk.dir=/путь/к/Android/Sdk
   ```
3. Соберите APK:
   ```bash
   # Debug
   ./gradlew assembleDebug      # Windows: gradlew.bat assembleDebug

   # Release
   ./gradlew assembleRelease
   ```
   Готовый APK появится в `app/build/outputs/apk/`.

## Конфигурация Telegram

Токен бота **не зашит в код** — пользователь вводит его сам в приложении
(вкладка загрузок → раздел Telegram). Токен хранится локально в `SharedPreferences`
устройства и никуда, кроме API Telegram, не передаётся.

## Лицензия

Проект распространяется под лицензией [MIT](LICENSE) © 2026 NotHalk.

> Pixiv является торговой маркой соответствующих правообладателей.
> Этот проект не аффилирован с Pixiv Inc. Используйте на свой риск
> и в соответствии с условиями использования Pixiv.
