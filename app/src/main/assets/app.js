// --- БЛОК СБОРКИ СТРАНИЦ ---
document.addEventListener("DOMContentLoaded", () => {
    try {
        let sbh = Android.getStatusBarHeightPx();
        if (sbh > 0) document.documentElement.style.setProperty("--sat", sbh + "px");
    } catch (e) {}
    document.body.style.paddingTop = "calc(68px + var(--sat))";
    initTheme(); 

    // === 1. ЗАГРУЖАЕМ НАВИГАЦИЮ ===
    let navHtml = Android.loadHtmlFile('nav.html');
    document.getElementById("nav-container").innerHTML = navHtml;

    // === 2. ЗАГРУЖАЕМ СТРАНИЦЫ ===
    const pagesToLoad = ['home.html', 'down.html', 'search.html', 'manager.html', 'author.html', 'detail.html', 'following.html', 'discovery.html', 'smartcache.html', 'anon_alert.html', 'browse.html', 'history.html', 'collections.html'];
    let allHtml = ""; 
    pagesToLoad.forEach((page) => {
        allHtml += Android.loadHtmlFile(page);
    }); 
    document.getElementById("pages-container").innerHTML = allHtml; // СОХРАНЯЕМ ЭТАЛОН ЧИСТОЙ СТРАНИЦЫ ДЛЯ СЛОЕВ

    let origDet = document.getElementById("page-detail");
    if (origDet) detailPageTemplate = origDet.outerHTML; // Инициализируем новые фичи поиска

    initSearchSuggestions();
    initSearchFilters(); 
// ... дальше идет твой оригинальный код (привязка кнопок, таймеры и т.д.) ...
    let confirmBtn = document.getElementById("modalConfirmBtn");
    if (confirmBtn) {
        confirmBtn.addEventListener("click", () => {
            if (modalConfirmAction) modalConfirmAction();
            closeModal();
        });
    }
    // Запускаем инициализацию интерфейса
    renderActiveDownloads();
    checkAnonAlert();
    loadVerifiedBadges();
    // Проверка обновлений — после скрытия загрузчика, чтобы окно не перекрывалось (z-index)
    setTimeout(() => { checkForAppUpdates(); }, 1300);
    // === ФИКС: ПРОВЕРЯЕМ АККАУНТ И СОХРАНЕННЫЕ СЕССИИ ПРИ СТАРТЕ ===
    setTimeout(() => {
        if (typeof Android !== "undefined") {
            if (typeof Android.checkAccount === "function") Android.checkAccount();
            if (typeof Android.requestSavedAccounts === "function") Android.requestSavedAccounts();
            // Зеркалим текущую веб-версию (хотфикс) для фоновой проверки обновлений
            if (typeof Android.setLocalWebVersion === "function") {
                let lwv = parseInt(localStorage.getItem("ota_web_version")) || CURRENT_WEB_VERSION;
                Android.setLocalWebVersion(lwv);
            }
            // Предзагрузка списка Telegram-чатов, чтобы окно выбора чата не было пустым.
            if (typeof Android.tgListChannels === "function") {
                try { Android.tgListChannels(); } catch (e) {}
            }
        }
    }, 100); // Небольшая задержка в 100мс, чтобы WebView гарантированно прогрузил DOM
    // ===============================================================

    setTimeout(() => {
        let changelog = localStorage.getItem("pending_changelog");
        // Окно "Что нового" показываем только при наличии сессии. Если её ещё
        // нет, оставляем pending_changelog нетронутым — окно появится при
        // следующем запуске, когда сессия будет.
        if (changelog && pixivHasSession()) {
            let ver = localStorage.getItem("ota_version") || "";
            let bannerFileName = localStorage.getItem("pending_banner");
            let soundFileName = localStorage.getItem("pending_sound");
            let videoFileName = localStorage.getItem("pending_video"); // <-- ДОСТАЕМ ВИДЕО // Передаем видео 5-м аргументом
            showChangelogModal(`Обновление установлено!`, changelog, bannerFileName, soundFileName, videoFileName);
            localStorage.removeItem("pending_changelog");
            localStorage.removeItem("pending_banner");
            localStorage.removeItem("pending_sound");
            localStorage.removeItem("pending_video"); // <-- ОЧИЩАЕМ ПАМЯТЬ
        }
    }, 3500); // Плавное затухание экрана загрузки
    setTimeout(() => {
        let loader = document.getElementById("loader-wrapper");
        if (loader) {
            loader.style.opacity = "0";
            setTimeout(() => (loader.style.display = "none"), 500);
        }
    }, 700);

    setTimeout(function() { updateTabSlider(); updateSearchModeSlider(); }, 150);
    window.addEventListener("resize", function() { updateTabSlider(); updateSearchModeSlider(); updateDetailTabSlider(); });
});

// --- ЛОГИКА КАСТОМНОЙ МОДАЛКИ (ВМЕСТО CONFIRM) ---
let modalConfirmAction = null;

function showConfirmModal(title, text, confirmAction) {
    document.getElementById("modalTitle").innerText = title;
    document.getElementById("modalText").innerText = text;
    modalConfirmAction = confirmAction;
    document.getElementById("customModalOverlay").classList.add("open");
    document.getElementById("customModal").classList.add("open");
}

function closeModal() {
    document.getElementById("customModalOverlay").classList.remove("open");
    document.getElementById("customModal").classList.remove("open");
    modalConfirmAction = null;
}

// --- ОСТАЛЬНАЯ ЛОГИКА ---
let activeDownloadsMap = {};
let savedDownloads = localStorage.getItem("activeDownloadsMap");
if (savedDownloads) {
    try {
        activeDownloadsMap = JSON.parse(savedDownloads);
        for (let id in activeDownloadsMap) {
            activeDownloadsMap[id].state = "paused";
            if (activeDownloadsMap[id].progress >= activeDownloadsMap[id].total && activeDownloadsMap[id].total > 0) {
                delete activeDownloadsMap[id];
            } else {
                activeDownloadsMap[id].text = "Приостановлено";
            }
        }
    } catch (e) {}
}

let currentNextUrl = "",
    currentAuthorNextUrl = "",
    currentRecomNextUrl = "",
    currentRelatedNextUrl = "";
let currentAuthorId = "",
    navHistory = ["home"],
    currentActionTarget = "",
    currentActionType = "";
let currentIllustId = "",
    currentIsBookmarked = false;
let currentDetailMeta = { id: "", title: "", thumb: "" };
// Кэш данных карточек из сеток (title/thumb/page_count/is_bookmarked и т.д.).
// Позволяет мгновенно отрисовать шапку и превью работы до ответа сети.
window.gridItemCache = window.gridItemCache || {};

// ==========================================
// ПРАВИЛЬНЫЕ ПЕРЕМЕННЫЕ ДЛЯ СЛОЕВ И КЭША
// ==========================================
let detailHistoryStack = [];
let detailScrollPositions = {};
let detailPageTemplate = ""; // Шаблон чистой страницы
let postCache = {}; // Морозилка постов
let authorCache = {};
let relatedCache = {};
let searchModeVal = "illust"; // 'illust' или 'user'
let searchAgeVal = "all",
    searchHideAiVal = false,
    recomHideAiVal = false;
let excludeTagsHistory = JSON.parse(localStorage.getItem("pixivExcludeTagsHistory")) || [];
let currentExcludeTags = excludeTagsHistory.join(", ");
let isDoubleLoading = false;
let detailImagesData = [];
let detailOriginalImages = []; // URL оригиналов текущей работы (для шеринга в Telegram)
let loadingMiniGrid = false;
let pendingRelatedRequest = null;
let relatedRetryCount = 0;
let tabScrollPositions = {};
let searchHistory = JSON.parse(localStorage.getItem("pixivSearchHistory")) || [];
function showToast(msg) {
    let t = document.createElement("div");
    t.innerText = msg;
    t.style.position = "fixed";
    t.style.bottom = "80px";
    t.style.left = "50%";
    t.style.transform = "translateX(-50%)";
    t.style.background = "rgba(0,0,0,0.9)";
    t.style.color = "#fff";
    t.style.padding = "10px 20px";
    t.style.borderRadius = "5px";
    t.style.zIndex = "9999";
    t.style.fontSize = "14px";
    t.style.fontWeight = "bold";
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2500);
}

function saveDownloadsMap() {
    localStorage.setItem("activeDownloadsMap", JSON.stringify(activeDownloadsMap));
}

// ==========================================
// ЛОГИКА ФИЛЬТРОВ (ВЫЕЗЖАЮЩАЯ ПАНЕЛЬ)
// ==========================================
function setSearchAge(val) {
    searchAgeVal = val;
    document.querySelectorAll('[id^="panelAge_"]').forEach((c) => c.classList.remove("active"));
    let el = document.getElementById("panelAge_" + val);
    if (el) el.classList.add("active");
    renderActiveFilters();
}

function toggleSearchAi() {
    searchHideAiVal = !searchHideAiVal;
    let el = document.getElementById("panelAiToggle");
    if (el) el.classList.toggle("active", searchHideAiVal);
    renderActiveFilters();
}

function toggleSearchFiltersPanel() {
    let panel = document.getElementById("expandableFiltersPanel");
    let btn = document.getElementById("openFilterBtn");
    if (panel) {
        panel.classList.toggle("open");
        if (panel.classList.contains("open")) {
            btn.style.borderColor = "var(--pixiv-blue)";
            btn.style.color = "var(--pixiv-blue)";
            btn.style.background = "rgba(0, 150, 250, 0.1)";
        } else {
            btn.style.borderColor = "var(--border)";
            btn.style.color = "var(--text)";
            btn.style.background = "var(--surface)";
        }
    }
}

function toggleRecomFiltersPanel() {
    let panel = document.getElementById("expandableRecomFiltersPanel");
    let btn = document.getElementById("openRecomFilterBtn");
    if (panel) {
        panel.classList.toggle("open");
        if (panel.classList.contains("open")) {
            if (btn) {
                btn.style.borderColor = "var(--pixiv-blue)";
                btn.style.color = "var(--pixiv-blue)";
                btn.style.background = "rgba(0, 150, 250, 0.1)";
            }
        } else {
            if (btn) {
                btn.style.borderColor = "var(--border)";
                btn.style.color = "var(--text)";
                btn.style.background = "var(--surface)";
            }
        }
    }
}

function renderActiveFilters() {
    // 1. Рисуем для Поиска
    let containerSearch = document.getElementById("activeSearchFilters");
    if (containerSearch) {
        let htmlSearch = "";
        if (searchAgeVal === "r18") {
            htmlSearch += `<div class="chip active" style="padding: 4px 10px; font-size: 12px; border-color: var(--red); color: var(--red); background: transparent;">R-18</div>`;
        } else if (searchAgeVal === "r18g") {
            htmlSearch += `<div class="chip active" style="padding: 4px 10px; font-size: 12px; border-color: var(--purple); color: var(--purple); background: transparent;">R-18G</div>`;
        } else if (searchAgeVal === "g") {
            htmlSearch += `<div class="chip active" style="padding: 4px 10px; font-size: 12px; border-color: var(--green); color: var(--green); background: transparent;">Safe</div>`;
        }
        if (searchHideAiVal) {
            htmlSearch += `<div class="chip active" style="padding: 4px 10px; font-size: 12px; background: transparent;">Без AI</div>`;
        }
        if (currentExcludeTags) {
            htmlSearch += `<div class="chip active" style="padding: 4px 10px; font-size: 12px; border-color: var(--red); color: var(--red); background: transparent;">Исключено: ${currentExcludeTags}</div>`;
        }
        containerSearch.innerHTML = htmlSearch;
    } // 2. Рисуем для Рекомендаций

    let containerRecom = document.getElementById("activeRecomFilters");
    if (containerRecom) {
        let htmlRecom = "";
        if (currentExcludeTags) {
            htmlRecom += `<div class="chip active" style="padding: 4px 10px; font-size: 12px; border-color: var(--red); color: var(--red); background: transparent;">Исключено: ${currentExcludeTags}</div>`;
        }
        containerRecom.innerHTML = htmlRecom;
    }
}

function toggleRecomAi() {
    recomHideAiVal = !recomHideAiVal;
    document.getElementById("recomAiChip").classList.toggle("active", recomHideAiVal);
    loadRecommendations(true);
}
function toggleSidebar() {
    document.getElementById("sidebar").classList.toggle("open");
    document.getElementById("sidebarOverlay").classList.toggle("open");
}

// Открыт ли левый выдвижной таб (при нём блокируем жесты/прокрутку фона)
function isSidebarOpen() {
    let sb = document.getElementById("sidebar");
    return !!(sb && sb.classList.contains("open"));
}

function handleBackPress() {
    // Редактор шаблона подписи — самое верхнее окно, закрываем первым.
    let tplModal = document.getElementById("tplModal");
    if (tplModal && tplModal.classList.contains("open")) {
        closeTemplateEditor();
        return true;
    }
    // Шторка "Поделиться" — закрываем (если не идёт отправка).
    let shareSheet = document.getElementById("shareSheet");
    if (shareSheet && shareSheet.classList.contains("open")) {
        closeShareSheet();
        return true;
    }
    // Сначала закрываем окно коллекций, если открыто
    let csSheet = document.getElementById("collectionPopover");
    if (csSheet && csSheet.classList.contains("open")) {
        closeCollectionSheet();
        return true;
    }
    if (document.getElementById("sidebar").classList.contains("open")) {
        toggleSidebar();
        return true;
    }
    // На странице коллекций: из открытой коллекции возвращаемся к списку
    // (только когда коллекции реально являются текущей вкладкой, а не лежат под работой)
    let colItems = document.getElementById("collectionItemsView");
    if (colItems && navHistory[navHistory.length - 1] === "collections" && colItems.style.display !== "none") {
        renderCollectionsPage();
        return true;
    }
    // Handle fullscreen player back
    let fsOverlay = document.getElementById("bdFullscreenOverlay");
    if (fsOverlay && fsOverlay.style.display === "block") {
        closeBdFullscreen();
        return true;
    }
    // Handle browse detail page back
    let bdPage = document.getElementById("page-browse-detail");
    if (bdPage && bdPage.style.display !== "none") {
        goBackFromBrowseDetail();
        return true;
    }
    let activeTab = navHistory[navHistory.length - 1];
    if ((activeTab === "detail" && detailHistoryStack.length > 0) || navHistory.length > 1) {
        goBack();
        return true;
    }
    return false;
}

function goBack() {
    let activeTab = navHistory[navHistory.length - 1];
    if (activeTab === "detail" && detailHistoryStack.length > 0) {
        let prevId = detailHistoryStack.pop();
        openDetails(prevId, true);
        return;
    }
    if (navHistory.length > 1) {
        navHistory.pop();
        internalSwitchTab(navHistory[navHistory.length - 1]);
    }
}

function switchTab(tabId) {
    if (navHistory[navHistory.length - 1] === tabId) {
        window.scrollTo({ top: 0, behavior: "smooth" });
        return;
    }
    navHistory.push(tabId);
    internalSwitchTab(tabId);
}

// Порядок главных вкладок (для вычисления направления свайпа)
const mainTabsOrder = ["home", "search", "browse", "down"];

function internalSwitchTab(tabId) {
    let activePage = document.querySelector(".page.active");
    let oldTabId = "";
    if (activePage) {
        oldTabId = activePage.id.replace("page-", "");
        tabScrollPositions[oldTabId] = window.scrollY;
    }

    // Раздел "Может понравиться" НЕ сбрасываем при выходе — подборка сохраняется
    // при навигации внутри сессии. Сброс происходит только при смене фильтра
    // (setDiscoveryFilter) и при полном перезаходе в приложение (грид пуст ->
    // первая загрузка ниже).

    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    
    // Снимаем классы анимаций с предыдущих переходов
    document.querySelectorAll(".page").forEach((p) => {
        p.classList.remove("slide-right-in", "slide-left-in", "pop-in", "fade-out");
    });

    // Hide browse detail overlay when switching tabs
    let bdPage = document.getElementById("page-browse-detail");
    if (bdPage) {
        bdPage.style.display = "none";
        let bdVid = document.getElementById("bdVideo");
        if (bdVid) { bdVid.pause(); bdVid.src = ""; }
    }

    if (tabId === "manager") Android.requestStorageInfo();

    if (mainTabsOrder.includes(tabId)) {
        if (document.getElementById("tab-" + tabId)) document.getElementById("tab-" + tabId).classList.add("active");
        document.getElementById("mainTabs").style.display = "flex";
        document.querySelector(".top-bar").style.display = "flex";
        updateTabSlider();
    } else {
        document.getElementById("mainTabs").style.display = "none";
        document.querySelector(".top-bar").style.display = "none";
    }

    let newPage = document.getElementById("page-" + tabId);
    newPage.classList.add("active");

    // Восстанавливаем скролл СИНХРОННО, до отрисовки нового кадра. Иначе страница
    // успевает один раз отрисоваться на старой позиции и потом «телепортируется».
    let targetScroll = tabScrollPositions[tabId] !== undefined ? tabScrollPositions[tabId] : 0;
    window.scrollTo(0, targetScroll);

    // Скользящий хайлайт переключателя Арты/Авторы (был width:0 пока страница скрыта)
    if (tabId === "search") { updateSearchModeSlider(); toggleSearchClear(); }

    // ==========================================
    // АНИМАЦИЯ ПЕРЕМЕЩЕНИЯ: новая страница заезжает сбоку, старая затухает
    // ==========================================
    if (oldTabId !== tabId) {
        if (mainTabsOrder.includes(oldTabId) && mainTabsOrder.includes(tabId)) {
            let oldIdx = mainTabsOrder.indexOf(oldTabId);
            let newIdx = mainTabsOrder.indexOf(tabId);
            if (newIdx > oldIdx) {
                newPage.classList.add("slide-right-in");
            } else {
                newPage.classList.add("slide-left-in");
            }
        } else {
            newPage.classList.add("pop-in");
        }
        if (activePage) {
            activePage.classList.add("fade-out");
            let old = activePage;
            setTimeout(function() { old.classList.remove("active", "fade-out"); }, 360);
        }
    }
    // ==========================================

    // Подстраховка: повторяем восстановление после старта анимации на случай,
    // если высота контента изменилась и позиция «уплыла».
    setTimeout(() => {
        window.scrollTo(0, targetScroll);
    }, 10);

    // Обновляем "скролл-филлеры" для кнопок загрузки
    document.querySelectorAll('.btn-secondary[id*="loadMore"]').forEach((btn) => {
        if (!btn.querySelector(".scroll-filler")) {
            let filler = document.createElement("div");
            filler.className = "scroll-filler";
            btn.appendChild(filler);
        }
    });

    if (tabId === "discovery" && document.getElementById("discoveryGrid").innerHTML === "") {
        loadMoreDiscovery(true);
    }
    if (tabId === "browse") {
        renderBrowseFavorites();
        renderWatchHistory();
        if (document.getElementById("browseGrid").innerHTML === "") {
            loadBrowse(true);
        }
    }
    if (tabId === "history") {
        renderHistory();
    }
    if (tabId === "down") {
        // Подтянуть текущее состояние привязки Telegram (если движок есть).
        try { if (typeof Android !== "undefined" && Android.tgQueryState) Android.tgQueryState(); } catch (e) {}
    }
    // ВНИМАНИЕ: collections НЕ перерисовываем здесь, иначе возврат из работы
    // сбросил бы открытую коллекцию на список. Список рисуется в openCollectionsTab().
}

// Перемещает скользящую линию под активную вкладку (с плавной анимацией через CSS-transition)
function updateTabSlider() {
    let tabs = document.getElementById("mainTabs");
    let slider = document.getElementById("tabSlider");
    if (!tabs || !slider) return;
    if (tabs.style.display === "none") return;
    let active = tabs.querySelector(".tab.active");
    if (!active) { slider.style.opacity = "0"; return; }
    slider.style.opacity = "1";
    slider.style.left = active.offsetLeft + "px";
    slider.style.width = active.offsetWidth + "px";
}

// Ведёт линию синхронно с вкладками при смене режима меню
var _tabSliderRaf = null;
function trackTabSlider(duration) {
    var slider = document.getElementById("tabSlider");
    if (!slider) return;
    if (_tabSliderRaf) cancelAnimationFrame(_tabSliderRaf);
    slider.style.transition = "opacity 0.2s ease";
    var start = performance.now();
    function step(now) {
        updateTabSlider();
        if (now - start < duration) {
            _tabSliderRaf = requestAnimationFrame(step);
        } else {
            _tabSliderRaf = null;
            slider.style.transition = "";
            updateTabSlider();
        }
    }
    _tabSliderRaf = requestAnimationFrame(step);
}

// Скользящий хайлайт переключателя Арты/Авторы
function updateSearchModeSlider() {
    var slider = document.getElementById("searchModeSlider");
    var active = document.querySelector("#searchMode_illust.active, #searchMode_user.active");
    if (!slider || !active) return;
    slider.style.left = active.offsetLeft + "px";
    slider.style.width = active.offsetWidth + "px";
}

function startDownload(link, target, type, title, thumb) {
    if (!link) return;
    if (/^\d+$/.test(link.trim())) {
        link = "https://www.pixiv.net/artworks/" + link.trim();
    }
    currentActionTarget = target;
    currentActionType = type;
    let illustId = null;
    let m = link.trim().match(/(?:artworks\/|illust_id=|PixivDL\/)(\d+)/);
    if (m) illustId = m[1];
    else if (/^\d+$/.test(link.trim())) illustId = link.trim();

    if (title && thumb && illustId) {
        addActiveDownload(illustId, title, thumb);
        Android.downloadWithMeta(link, title, thumb);
    } else {
        Android.download(link);
    }
    showToast("Добавлено в очередь!");
}

function onLinkChange() {
    clearTimeout(window.previewTimeout);
    let link = document.getElementById("linkInput").value;
    window.previewTimeout = setTimeout(() => {
        Android.preview(link);
        checkFilesExist(link, "btnMainCheck");
    }, 500);
}

function checkFilesExist(link, btnId) {
    if (!link) {
        document.getElementById(btnId).style.display = "none";
        return;
    }
    document.getElementById(btnId).style.display = Android.hasDownloadedFiles(link) ? "flex" : "none";
}

function updateAccount(name, id, status, isActive, avatar) {
    
    // === СЕТЕВОЙ ОТВЕТ ПОЛУЧЕН: Разблокируем интерфейс ===
    // Игнорируем предварительный статус, чтобы блокировка не слетала до ответа сервера/перезагрузки!
    let isPreliminary = status && status.includes("обновляем токен");
    
    if (typeof unlockAccountSwitch === 'function' && !isPreliminary) {
        unlockAccountSwitch();
    }
    // ======================================================

    document.getElementById("loggedOutView").style.display = isActive ? "none" : "block";
    document.getElementById("loggedInView").style.display = isActive ? "block" : "none";

    // Если есть активная сессия — окно входа точно прячем (без мигания до обновления списка аккаунтов)
    if (isActive) setAuthGate(false);
    
    ["downloaderCard", "searchCard", "recomCard", "sidebarMyIllusts", "sidebarMyBookmarks", "sidebarFollowing", "r18SettingsCard", "sidebarDiscovery"].forEach((cid) => {
        let el = document.getElementById(cid);
        if (el) el.classList.toggle("disabled-section", !isActive);
    });

    // ... остальной код функции остается без изменений ...

    // ... остальной код функции остается без изменений ...
    
    if (isActive) {
        let badge = getBadgeHtml(id);
        let safeName = (name || "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        document.getElementById("accName").innerHTML = safeName + badge;
        document.getElementById("accId").innerText = "ID: " + id;
        document.getElementById("sidebarName").innerHTML = safeName + badge;
        document.getElementById("sidebarId").innerText = "ID: " + id;
        
        if (avatar && avatar !== "null" && avatar !== "") {
            // Круглая аватарка в боковом меню
            document.getElementById("sidebarAvatarImg").src = avatar;
            document.getElementById("sidebarAvatarImg").style.display = "block";
            document.getElementById("sidebarAvatarPlaceholder").style.display = "none"; 
            
            // Задний фон (размытый) в боковом меню
            let bgImg = document.getElementById("sidebarHeaderBgImg");
            if (bgImg) {
                bgImg.src = avatar;
                bgImg.style.display = "block";
            }

            // Главная аватарка профиля
            document.getElementById("mainAvatarImg").src = avatar;
            document.getElementById("mainAvatarImg").style.display = "block";
            document.getElementById("mainAvatarPlaceholder").style.display = "none";
            
            // === ДОБАВЛЕНО: Баннер профиля ===
            let mainBanner = document.getElementById("mainBannerImg");
            if (mainBanner) {
                mainBanner.src = avatar;
                mainBanner.style.display = "block";
            }
        } else {
            // Если аватарки нет, прячем фоны
            let bgImg = document.getElementById("sidebarHeaderBgImg");
            if (bgImg) bgImg.style.display = "none";
            
            // === ДОБАВЛЕНО: Прячем баннер профиля ===
            let mainBanner = document.getElementById("mainBannerImg");
            if (mainBanner) mainBanner.style.display = "none";
        }
        
        if (document.getElementById("page-home").classList.contains("active") && document.getElementById("recomGrid").innerHTML === "") {
            loadRecommendations(true);
            loadHomeStrips();
        }
    } else {
        // Если вышли из аккаунта
        let bgImg = document.getElementById("sidebarHeaderBgImg");
        if (bgImg) bgImg.style.display = "none";
        
        // === ДОБАВЛЕНО: Прячем баннер при выходе ===
        let mainBanner = document.getElementById("mainBannerImg");
        if (mainBanner) mainBanner.style.display = "none";
    }

    // Загрузка сохраненных аккаунтов (работает отлично)
    if (typeof Android !== "undefined" && Android.requestSavedAccounts) Android.requestSavedAccounts();
}

function addActiveDownload(id, title, thumbUrl) {
    if (!activeDownloadsMap[id]) {
        activeDownloadsMap[id] = { state: "downloading", title: title || "Работа ID: " + id, text: "В очереди...", progress: 0, total: 0, thumb: thumbUrl || "" };
    } else {
        activeDownloadsMap[id].state = "downloading";
    }
    saveDownloadsMap();
    renderActiveDownloads();
}

function updateActiveDownloadInfo(id, title, thumbUrl) {
    if (activeDownloadsMap[id]) {
        if (title) activeDownloadsMap[id].title = title;
        if (thumbUrl) activeDownloadsMap[id].thumb = thumbUrl;
        saveDownloadsMap();
        renderActiveDownloads();
    }
}

function updateActiveDownload(id, text, current, total) {
    if (!activeDownloadsMap[id]) activeDownloadsMap[id] = { state: "downloading", title: "Работа ID: " + id, thumb: "" };
    activeDownloadsMap[id].text = text;
    activeDownloadsMap[id].progress = current;
    activeDownloadsMap[id].total = total;
    saveDownloadsMap();
    renderActiveDownloads();
}

function finishActiveDownload(id, success) {
    if (activeDownloadsMap[id]) {
        if (success) {
            delete activeDownloadsMap[id];
        } else {
            activeDownloadsMap[id].state = "error";
            activeDownloadsMap[id].text = "Ошибочка..";
        }
    }
    saveDownloadsMap();
    renderActiveDownloads();
    Android.requestStorageInfo();
}

function userPauseDownload(id) {
    if (activeDownloadsMap[id]) {
        activeDownloadsMap[id].state = "paused";
        activeDownloadsMap[id].text = "Приостановлено";
        saveDownloadsMap();
        renderActiveDownloads();
    }
    Android.pauseDownload(id);
}

function userResumeDownload(id) {
    if (activeDownloadsMap[id]) {
        activeDownloadsMap[id].state = "downloading";
        activeDownloadsMap[id].text = "Возобновление...";
        saveDownloadsMap();
        renderActiveDownloads();
    }
    Android.resumeDownload(id);
}

function userAbortDownload(id) {
    showConfirmModal("Отмена загрузки", "Удалить незавершенную загрузку и очистить память?", () => {
        delete activeDownloadsMap[id];
        saveDownloadsMap();
        renderActiveDownloads();
        Android.abortDownload(id);
    });
}

function renderActiveDownloads() {
    let container = document.getElementById('activeDownloadsList');
    if(!container) return;
    let keys = Object.keys(activeDownloadsMap);
    let countEl = document.getElementById('dlmActiveCount');
    if (countEl) {
        countEl.style.display = keys.length ? 'inline-block' : 'none';
        countEl.innerText = keys.length;
    }
    if (keys.length === 0) {
        container.innerHTML = '<div class="dlm-empty"><svg class="dlm-empty-icon"><use xlink:href="#icon-dl"></use></svg><span>Нет активных загрузок</span></div>';
        return;
    }
    let html = '';
    keys.forEach(k => {
        let d = activeDownloadsMap[k];
        let pct = d.total > 0 ? Math.floor((d.progress / d.total) * 100) : 0;
        let imgTag = d.thumb
            ? `<img src="${d.thumb}" class="dlm-active-thumb">`
            : `<div class="dlm-active-thumb"><svg class="icon-sm" style="color:var(--subtext)"><use href="#icon-image" xlink:href="#icon-image"></use></svg></div>`;

        let btnsHtml = '';
        if (d.state === 'downloading') {
            btnsHtml += `<div class="dlm-act-btn" onclick="event.stopPropagation(); userPauseDownload('${k}')"><svg class="icon-sm"><use href="#icon-pause" xlink:href="#icon-pause"></use></svg></div>`;
        } else {
            btnsHtml += `<div class="dlm-act-btn primary" onclick="event.stopPropagation(); userResumeDownload('${k}')"><svg class="icon-sm"><use href="#icon-play" xlink:href="#icon-play"></use></svg></div>`;
        }
        btnsHtml += `<div class="dlm-act-btn danger" onclick="event.stopPropagation(); userAbortDownload('${k}')"><svg class="icon-sm"><use href="#icon-close" xlink:href="#icon-close"></use></svg></div>`;

        let isErr = d.state === 'error';
        html += `
        <div class="dlm-active">
            ${imgTag}
            <div class="dlm-active-body">
                <div class="dlm-active-title">${d.title}</div>
                <div class="dlm-active-row">
                    <span class="dlm-active-text" style="${isErr ? 'color:var(--red);' : ''}">${d.text}</span>
                    <span class="dlm-active-pct">${pct}%</span>
                </div>
                <div class="dlm-active-track"><div class="dlm-active-fill" style="width:${pct}%;${isErr ? 'background:var(--red);' : ''}"></div></div>
            </div>
            <div class="dlm-act-btns">${btnsHtml}</div>
        </div>`;
    });
    container.innerHTML = html;
}

function deleteDownload(id) {
    showConfirmModal("Удаление пакета", "Точно удалить все скачанные файлы пакета " + id + "?", () => {
        Android.deleteDownloadedFolder(id);
    });
}

// Парсит строку размера ("12,3 МБ") в байты — для визуализации шкалы экономии.
function dlmParseBytes(s) {
    if (!s) return 0;
    let m = String(s).trim().match(/([\d.,]+)\s*(Б|КБ|МБ|ГБ|ТБ)/i);
    if (!m) return 0;
    let n = parseFloat(m[1].replace(',', '.')) || 0;
    let mult = { 'Б': 1, 'КБ': 1024, 'МБ': 1048576, 'ГБ': 1073741824, 'ТБ': 1099511627776 }[m[2].toUpperCase()] || 1;
    return n * mult;
}

function updateDownloadsUI(statsStr, listB64) {
    let stats = JSON.parse(decodeB64Utf8(statsStr));

    let curEl = document.getElementById('dlmCurrent');
    if (curEl) curEl.innerText = stats.current;
    let usedValEl = document.getElementById('dlmUsedVal');
    if (usedValEl) usedValEl.innerText = stats.current;
    let savedEl = document.getElementById('dlmSaved');
    if (savedEl) savedEl.innerText = stats.saved;
    let origEl = document.getElementById('dlmOriginal');
    if (origEl) origEl.innerText = 'Без сжатия весило бы ' + stats.original;

    // Шкала: синий сегмент — занятые файлы, зелёный — сэкономленное сжатием.
    let usedB = dlmParseBytes(stats.current);
    let savedB = dlmParseBytes(stats.saved);
    let totalB = usedB + savedB;
    let usedPct = totalB > 0 ? (usedB / totalB) * 100 : 100;
    let barUsed = document.getElementById('dlmBarUsed');
    let barSaved = document.getElementById('dlmBarSaved');
    if (barUsed) barUsed.style.width = usedPct + '%';
    if (barSaved) barSaved.style.width = (100 - usedPct) + '%';

    let container = document.getElementById('completedDownloadsList');
    if(!container) return;
    let fullList = [];
    try { fullList = JSON.parse(decodeB64Utf8(listB64)); } catch(e){}

    let list = fullList.filter(item => !activeDownloadsMap[item.id]);

    let savedCountEl = document.getElementById('dlmSavedCount');
    if (savedCountEl) {
        savedCountEl.style.display = list.length ? 'inline-block' : 'none';
        savedCountEl.innerText = list.length;
    }

    if (list.length === 0) {
        container.innerHTML = '<div class="dlm-empty"><svg class="dlm-empty-icon"><use xlink:href="#icon-folder"></use></svg><span>Папка загрузок пуста</span></div>';
        return;
    }
    let html = '';
    list.forEach(item => {
        // Оффлайн-пакет — особая плитка
        if (item.id === 'offline_cache') {
            html += `
            <div class="dlm-tile" onclick="openDetails('offline_cache')">
                <div class="dlm-tile-frame">
                    <div class="dlm-tile-offline">
                        <svg class="icon"><use href="#icon-sync" xlink:href="#icon-sync"></use></svg>
                    </div>
                    <div class="dlm-tile-pages"><svg class="dlm-pages-ico"><use href="#icon-pages" xlink:href="#icon-pages"></use></svg>${item.actual}</div>
                    <div class="dlm-tile-del" onclick="event.stopPropagation(); deleteDownload('offline_cache')"><svg class="icon-xs"><use href="#icon-trash" xlink:href="#icon-trash"></use></svg></div>
                </div>
                <div class="dlm-tile-cap">
                    <div class="dlm-tile-title">Оффлайн пакет</div>
                    <div class="dlm-tile-size">${item.size}</div>
                </div>
            </div>`;
            return;
        }

        let imgTag = item.thumb
            ? `<img src="data:image/jpeg;base64,${item.thumb}" class="dlm-tile-img">`
            : `<div class="dlm-tile-fallback"><svg class="icon"><use href="#icon-folder" xlink:href="#icon-folder"></use></svg></div>`;

        // Фирменный бейдж количества страниц (как в ленте Pixiv)
        let pagesBadge = (item.actual && item.actual > 1)
            ? `<div class="dlm-tile-pages"><svg class="dlm-pages-ico"><use href="#icon-pages" xlink:href="#icon-pages"></use></svg>${item.actual}</div>`
            : '';
        let badge = item.is_incomplete
            ? `<div class="dlm-tile-badge warn">${item.actual}/${item.expected}</div>`
            : '';
        let syncBtn = item.is_incomplete
            ? `<div class="dlm-tile-sync" onclick="event.stopPropagation(); addActiveDownload('${item.id}', 'Докачка...', 'data:image/jpeg;base64,${item.thumb}'); userResumeDownload('${item.id}')"><svg class="icon-xs"><use href="#icon-sync" xlink:href="#icon-sync"></use></svg></div>`
            : '';

        html += `
        <div class="dlm-tile" onclick="openDetails('${item.id}')">
            <div class="dlm-tile-frame${item.is_incomplete ? ' incomplete' : ''}">
                ${imgTag}
                ${badge || pagesBadge}
                <div class="dlm-tile-del" onclick="event.stopPropagation(); deleteDownload('${item.id}')"><svg class="icon-xs"><use href="#icon-trash" xlink:href="#icon-trash"></use></svg></div>
                ${syncBtn}
            </div>
            <div class="dlm-tile-cap">
                <div class="dlm-tile-title">ID: ${item.id}</div>
                <div class="dlm-tile-size">${item.size}</div>
            </div>
        </div>`;
    });
    container.innerHTML = html;
}

function updateProgress(id, current, total) {
    let pct = total > 0 ? (current / total) * 100 : 0;
    if (pct > 100) pct = 100;
    let gridBg = document.getElementById("gridBg_" + id);
    let gridFill = document.getElementById("fillGrid_" + id);
    if (gridBg && gridFill) {
        gridBg.style.display = "block";
        gridFill.style.width = pct + "%";
        if (current >= total && total > 0)
            setTimeout(() => {
                gridFill.style.width = "0%";
                gridBg.style.display = "none";
            }, 1500);
    }

    if (id === currentIllustId) {
        let inlineBg = document.getElementById("detProgressBg");
        let inlineEl = document.getElementById("fillDetInline");
        if (inlineBg && inlineEl) {
            inlineBg.style.display = "block";
            inlineEl.style.width = pct + "%";
            if (current >= total && total > 0)
                setTimeout(() => {
                    inlineEl.style.width = "0%";
                    inlineBg.style.display = "none";
                }, 1500);
        }
    }

    let linkInput = document.getElementById("linkInput");
    if (linkInput && linkInput.value.includes(id)) {
        let elBtn1 = document.getElementById("fillMain1");
        let elInline = document.getElementById("fillMainInline");
        if (elInline) document.getElementById("mainDlProgressContainer").style.display = "block";
        if (elBtn1) elBtn1.style.width = pct + "%";
        if (elInline) elInline.style.width = pct + "%";
        if (current >= total && total > 0)
            setTimeout(() => {
                if (elBtn1) elBtn1.style.width = "0%";
                if (elInline) elInline.style.width = "0%";
                if (document.getElementById("mainDlProgressContainer")) document.getElementById("mainDlProgressContainer").style.display = "none";
            }, 1500);
    }
}

function updatePreview(b64, meta) {
    let img = document.getElementById("previewImg");
    if (!img) return;
    if (b64 && b64 !== "null") {
        img.src = "data:image/jpeg;base64," + b64;
        img.style.display = "block";
        img.style.border = "1px solid var(--border)";
    } else {
        img.style.display = "none";
    }
    document.getElementById("previewMeta").innerText = meta;
}

function decodeB64Utf8(str) {
    return decodeURIComponent(escape(atob(str)));
}

function buildItemHtml(item) {
    // Запоминаем данные карточки, чтобы openDetails мог мгновенно показать
    // шапку и уже загруженное превью, не дожидаясь сети.
    if (item && item.id != null) {
        try {
            let keys = Object.keys(window.gridItemCache);
            if (keys.length > 800) { delete window.gridItemCache[keys[0]]; }
            window.gridItemCache[String(item.id)] = item;
        } catch (e) {}
    }

    let heartClass = item.is_bookmarked ? 'liked' : '';
    let heartIcon = item.is_bookmarked ? '#icon-heart' : '#icon-heart-outline';
    
    let r18badge = '';
    if (item.is_r18g) r18badge = '<div class="badge badge-r18g">R-18G</div>';
    else if (item.is_r18) r18badge = '<div class="badge badge-r18">R-18</div>';
    
    let safeTitle = item.title ? item.title.replace(/'/g, "\\'").replace(/"/g, '&quot;') : "Без названия";

    // Экранированное название для текстовой подписи на крупных карточках Главной.
    let escTitle = (item.title || "Без названия")
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    return `<img class="search-img" data-src="${item.thumb}">
        <div class="grid-caption"><span class="grid-caption-title">${escTitle}</span></div>
        <div class="grid-progress-bg" id="gridBg_${item.id}"><div class="grid-progress-fill" id="fillGrid_${item.id}"></div></div>
        <div class="badges-top">
            ${r18badge}
            ${item.page_count>1?'<div class="badge badge-pages"><svg class="icon-xs"><use href="#icon-pages" xlink:href="#icon-pages"></use></svg>'+item.page_count+'</div>':''}
        </div>
        <div class="like-btn-grid ${heartClass}" id="gridLike_${item.id}" onclick="event.stopPropagation(); toggleGridBookmark('${item.id}');">
            <svg class="icon-sm"><use href="${heartIcon}" xlink:href="${heartIcon}"></use></svg>
        </div>
        <div class="quick-dl-btn" onclick="event.stopPropagation(); startDownload('${item.id}', '', '', '${safeTitle}', '${item.thumb}');">
            <svg class="icon-sm"><use href="#icon-dl" xlink:href="#icon-dl"></use></svg>
        </div>`;
}

function toggleGridBookmark(id) {
    let btn = document.getElementById("gridLike_" + id);
    if (!btn) return;
    let isLiked = btn.classList.contains("liked");
    let willAdd = !isLiked;
    btn.classList.toggle("liked", willAdd);
    btn.querySelector("use").setAttribute("href", willAdd ? "#icon-heart" : "#icon-heart-outline");
    Android.toggleBookmark(id, willAdd);
}

function loadRecommendations(isNew) {
    if (isNew) {
        // Скелетон-карточки: .search-item уже умеет мерцать, поэтому пустые
        // карточки резервируют место и убирают «прыжки» сетки при загрузке.
        let g = document.getElementById("recomGrid");
        let h = "";
        for (let i = 0; i < 6; i++) h += '<div class="search-item skeleton-item"></div>';
        g.innerHTML = h;
        currentRecomNextUrl = "";
        document.getElementById("recomStatus").innerText = "Загрузка...";
    }
    Android.getRecommended(currentRecomNextUrl, "all", recomHideAiVal, currentExcludeTags);
}

function displayRecommendations(b64) {
    let grid = document.getElementById("recomGrid"),
        btn = document.getElementById("loadMoreRecomBtn"),
        st = document.getElementById("recomStatus");
    if (!grid) return;
    // Убираем скелетон-карточки перед добавлением реальных (и при ошибке тоже).
    grid.querySelectorAll(".skeleton-item").forEach((el) => el.remove());
    try {
        let data = JSON.parse(decodeB64Utf8(b64));
        currentRecomNextUrl = data.next_url;
        data.results.forEach((item) => {
            let div = document.createElement("div");
            div.className = "search-item";
            div.onclick = () => openDetails(item.id);
            div.innerHTML = buildItemHtml(item);
            grid.appendChild(div);
        });
        st.innerText = "Рекомендации:";
        btn.style.display = currentRecomNextUrl ? "block" : "none";
        let isHomeActive = document.getElementById("page-home").classList.contains("active");
        if (isHomeActive && recomHideAiVal && data.results.length < 15 && currentRecomNextUrl && !isDoubleLoading) {
            isDoubleLoading = true;
            loadRecommendations(false);
        } else {
            isDoubleLoading = false;
        }
    } catch (e) {
        st.innerText = "Ошибка сети.";
        btn.style.display = "none";
    }
}

// ===== ГЛАВНАЯ (вариант 6): hero + горизонтальные ленты разделов =====
window.homeHeroId = "";

function setHomeHero(item) {
    let hero = document.getElementById("homeHero");
    if (!hero || !item) return;
    hero.classList.remove("home-hero-skeleton");
    window.homeHeroId = item.id;
    let img = document.getElementById("homeHeroImg");
    let titleEl = document.getElementById("homeHeroTitle");
    if (titleEl) titleEl.textContent = item.title || "Без названия";
    if (img) {
        img.classList.remove("loaded");
        img.onload = () => img.classList.add("loaded");
        img.src = item.thumb || "";
    }
    hero.style.display = "block";
}

function renderHomeStrip(b64, sectionId, stripId, isHeroSource) {
    let strip = document.getElementById(stripId);
    let section = document.getElementById(sectionId);
    if (!strip) return;
    let items = [];
    try { let d = JSON.parse(decodeB64Utf8(b64)); items = d.results || []; } catch (e) { items = []; }
    if (isHeroSource && items.length) {
        setHomeHero(items[0]);
        items = items.slice(1);
    } else if (isHeroSource) {
        // Трендов нет — убираем скелетон hero, чтобы он не мерцал бесконечно.
        let hero = document.getElementById("homeHero");
        if (hero) { hero.classList.remove("home-hero-skeleton"); hero.style.display = "none"; }
    }
    strip.innerHTML = "";
    items.forEach((item) => {
        let div = document.createElement("div");
        div.className = "strip-item";
        div.onclick = () => openDetails(item.id);
        div.innerHTML = buildItemHtml(item);
        strip.appendChild(div);
    });
    if (section) section.style.display = items.length ? "block" : "none";
}

function displayHomeTrending(b64) { renderHomeStrip(b64, "secTrending", "homeTrendingStrip", true); }
function displayHomeSuggested(b64) { renderHomeStrip(b64, "secSuggested", "homeSuggestedStrip", false); }
function displayHomeBookmarks(b64) { renderHomeStrip(b64, "secBookmarks", "homeBookmarksStrip", false); }

function renderHomeCollections() {
    let strip = document.getElementById("homeCollectionsStrip");
    let section = document.getElementById("secCollections");
    if (!strip) return;
    let cols = (typeof getCollections === "function") ? getCollections() : [];
    if (!cols.length) { strip.innerHTML = ""; if (section) section.style.display = "none"; return; }
    strip.innerHTML = cols.map((c) => {
        let count = c.items ? c.items.length : 0;
        let cover = (c.items && c.items[0] && c.items[0].thumb) || "";
        let safeName = (c.name || "Без названия").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        let wf = (typeof collectionsWordForm === "function") ? collectionsWordForm(count) : "работ";
        let coverHtml = cover
            ? `<img class="search-img" data-src="${cover}">`
            : `<div class="col-cover-empty"><svg class="icon"><use href="#icon-collection" xlink:href="#icon-collection"></use></svg></div>`;
        return `<div class="strip-item col-item" onclick="openHomeCollection('${c.id}')">
            ${coverHtml}
            <div class="col-meta"><span class="col-name">${safeName}</span><span class="col-cnt">${count} ${wf}</span></div>
        </div>`;
    }).join("");
    if (section) section.style.display = "block";
}

function openHomeCollection(id) {
    try { openCollectionsTab(); } catch (e) {}
    setTimeout(() => { try { if (typeof openCollection === "function") openCollection(id); } catch (e) {} }, 80);
}

// Показывает скелетоны секций главной, пока грузятся данные, — чтобы блоки
// не «выпрыгивали» и интерфейс не прыгал. Реальные рендереры (renderHomeStrip,
// setHomeHero, displayRecommendations) затем заменяют скелетоны контентом.
function showHomeSkeletons() {
    let hero = document.getElementById("homeHero");
    if (hero && !window.homeHeroId) {
        hero.classList.add("home-hero-skeleton");
    }
    [
        ["secTrending", "homeTrendingStrip"],
        ["secSuggested", "homeSuggestedStrip"],
        ["secBookmarks", "homeBookmarksStrip"]
    ].forEach(([secId, stripId]) => {
        let sec = document.getElementById(secId);
        let strip = document.getElementById(stripId);
        if (sec && strip && strip.children.length === 0) {
            sec.style.display = "block";
            let h = "";
            for (let i = 0; i < 5; i++) h += '<div class="strip-item skel"></div>';
            strip.innerHTML = h;
        }
    });
}
window.showHomeSkeletons = showHomeSkeletons;

// Грузит все ленты "Главной" (сетевые через мост + локальные коллекции).
function loadHomeStrips() {
    try { showHomeSkeletons(); } catch (e) {}
    try {
        if (typeof Android !== "undefined" && Android.getHomeStrip) {
            Android.getHomeStrip("trending");
            Android.getHomeStrip("suggested");
            Android.getHomeStrip("bookmarks");
        }
    } catch (e) {}
    try { renderHomeCollections(); } catch (e) {}
}
window.openHomeCollection = openHomeCollection;
window.loadHomeStrips = loadHomeStrips;
window.renderHomeCollections = renderHomeCollections;

let currentDiscoveryNextUrl = "";

let discoveryAgeVal = "all"; // фильтр раздела "Может понравиться": all | safe | r18

function setDiscoveryFilter(val) {
    if (discoveryAgeVal === val) return;
    discoveryAgeVal = val;
    ["all", "safe", "r18"].forEach((v) => {
        let chip = document.getElementById("discChip" + v.charAt(0).toUpperCase() + v.slice(1));
        if (chip) chip.classList.toggle("active", v === val);
    });
    isDoubleLoading = false;
    loadMoreDiscovery(true); // смена фильтра -> сброс ленты
}

function loadMoreDiscovery(isNew = false) {
    if (isNew) {
        document.getElementById("discoveryGrid").innerHTML = "";
        currentDiscoveryNextUrl = "";
        // Свежая лента -> сбрасываем "список результатов" на стороне Android
        // (вход в раздел заново и смена фильтра должны начинать подборку с нуля).
        if (typeof Android !== "undefined" && Android.resetDiscovery) Android.resetDiscovery();
    }
    Android.getDiscovery(currentDiscoveryNextUrl, discoveryAgeVal);
}

function displayDiscovery(b64) {
    let grid = document.getElementById("discoveryGrid");
    let btn = document.getElementById("loadMoreDiscoveryBtn");
    if (!grid) return;
    try {
        let data = JSON.parse(decodeB64Utf8(b64));
        currentDiscoveryNextUrl = data.next_url;

        data.results.forEach((item) => {
            let div = document.createElement("div");
            div.className = "search-item";
            div.onclick = () => openDetails(item.id);
            div.innerHTML = buildItemHtml(item);
            grid.appendChild(div);
        });

        btn.style.display = currentDiscoveryNextUrl ? "block" : "none";

        let isActive = document.getElementById("page-discovery").classList.contains("active");
        if (isActive && data.results.length < 15 && currentDiscoveryNextUrl && !isDoubleLoading) {
            isDoubleLoading = true;
            loadMoreDiscovery(false);
        } else {
            isDoubleLoading = false;
        }
    } catch (e) {
        btn.style.display = "none";
        showToast("Ошибка загрузки радио");
    }
}

function startSearch(isNew) {
    let q = document.getElementById("searchInput").value.trim();
    if (!q) return;
    if (isNew) {
        saveSearchQuery(q);
        hideSearchSuggestions();
        document.getElementById("searchGrid").innerHTML = "";
        currentNextUrl = "";
        document.getElementById("searchStatus").innerText = "Поиск...";
        document.getElementById("searchGrid").style.display = searchModeVal === "user" ? "block" : "grid";
    }
    if (/^\d+$/.test(q)) {
        // В режиме "Авторы" числовой ввод — это ID профиля, а не иллюстрации.
        if (searchModeVal === "user") {
            openAuthor(q, "", "");
        } else {
            openDetails(q);
        }
        return;
    }
    if (searchModeVal === "user") {
        Android.searchUser(q, currentNextUrl);
    } else {
        Android.search(q, currentNextUrl, searchAgeVal, searchHideAiVal, currentExcludeTags);
    }
}

function loadMore() {
    let q = document.getElementById("searchInput").value.trim();
    if (searchModeVal === "user") {
        Android.searchUser(q, currentNextUrl);
    } else {
        Android.search(q, currentNextUrl, searchAgeVal, searchHideAiVal, currentExcludeTags);
    }
}

function initSearchFilters() {
    renderActiveFilters();
    renderExcludeTagsHistory();
}

function applyExcludeTags(inputId = "excludeTagInput") {
    let input = document.getElementById(inputId);
    if (!input) return;
    let val = input.value.trim();
    if (val) {
        let tags = val
            .split(",")
            .map((t) => t.trim())
            .filter((t) => t !== "");
        tags.forEach((t) => {
            excludeTagsHistory = excludeTagsHistory.filter((item) => item !== t);
            excludeTagsHistory.unshift(t);
        });
        if (excludeTagsHistory.length > 20) excludeTagsHistory.length = 20;
        localStorage.setItem("pixivExcludeTagsHistory", JSON.stringify(excludeTagsHistory));
    } // Очищаем оба поля, чтобы интерфейсы были синхронными
    let inpSearch = document.getElementById("excludeTagInput");
    if (inpSearch) inpSearch.value = "";
    let inpRecom = document.getElementById("excludeTagInputRecom");
    if (inpRecom) inpRecom.value = "";

    currentExcludeTags = excludeTagsHistory.join(", ");
    renderExcludeTagsHistory();
    renderActiveFilters();
}

function renderExcludeTagsHistory() {
    let html = "";
    excludeTagsHistory.forEach((t) => {
        let safeT = t.replace(/'/g, "\\'");
        let escT = String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
        html += `<div class="exclude-chip">
            <span class="exclude-chip-txt">${escT}</span>
            <span class="exclude-chip-x" onclick="event.stopPropagation(); removeExcludeHistoryItem('${safeT}')" aria-label="Удалить">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/></svg>
            </span>
        </div>`;
    });
    let listSearch = document.getElementById("excludeTagsHistoryList");
    if (listSearch) listSearch.innerHTML = html;
    let listRecom = document.getElementById("excludeTagsHistoryListRecom");
    if (listRecom) listRecom.innerHTML = html;
}

function removeExcludeHistoryItem(tag) {
    excludeTagsHistory = excludeTagsHistory.filter((item) => item !== tag);
    localStorage.setItem("pixivExcludeTagsHistory", JSON.stringify(excludeTagsHistory));
    currentExcludeTags = excludeTagsHistory.join(", ");
    renderExcludeTagsHistory();
    renderActiveFilters();
}

function setSearchMode(mode) {
    searchModeVal = mode;
    document.querySelectorAll("#searchMode_illust, #searchMode_user").forEach((c) => c.classList.remove("active"));
    let activeBtn = document.getElementById("searchMode_" + mode);
    if (activeBtn) activeBtn.classList.add("active");
    updateSearchModeSlider();
    let filterBtn = document.getElementById("openFilterBtn");
    let activeFiltersZone = document.getElementById("activeSearchFilters");
    let expandPanel = document.getElementById("expandableFiltersPanel");
    if (mode === "user") {
        if (filterBtn) filterBtn.style.display = "none";
        if (activeFiltersZone) activeFiltersZone.style.display = "none";
        if (expandPanel) expandPanel.classList.remove("open");
    } else {
        if (filterBtn) filterBtn.style.display = "flex";
        if (activeFiltersZone) activeFiltersZone.style.display = "flex";
    }
    startSearch(true);
}

function displayUserSearchResults(b64) {
    let grid = document.getElementById('searchGrid'), btn = document.getElementById('loadMoreBtn'), st = document.getElementById('searchStatus');
    if(!grid) return;
    
    try {
        let data = JSON.parse(decodeB64Utf8(b64)); 
        currentNextUrl = data.next_url;
        
        data.results.forEach(item => {
            let div = document.createElement('div');
            div.className = 'author-card'; 
            div.style.marginTop = '0';
            div.style.borderTop = 'none';
            div.style.cursor = 'pointer';
            div.onclick = () => openAuthor(item.id, item.name, avatar);
            
            let avatar = item.avatar || 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
            div.innerHTML = `
                <img src="${avatar}" class="author-card-avatar">
                <div class="author-card-info">
                    <div class="author-card-name" style="color: var(--text);">${item.name.replace(/'/g, "\\'").replace(/"/g, '&quot;')}${getBadgeHtml(item.id)}</div>
                    <div class="text-sub">ID: ${item.id}</div>
                </div>
                <div class="author-card-btn">Перейти</div>
            `;
            grid.appendChild(div);
        });
        
        st.innerText = "Найденные авторы";
        btn.style.display = currentNextUrl ? 'block' : 'none';
        
        let isSearchActive = document.getElementById('page-search').classList.contains('active');
        if (isSearchActive && data.results.length < 15 && currentNextUrl && !isDoubleLoading) {
            isDoubleLoading = true; 
            loadMore();
        } else { 
            isDoubleLoading = false; 
        }
    } catch (e) { 
        st.innerText = "Ошибка сети."; 
        btn.style.display = 'none'; 
    }
}

function displaySearchResults(b64) {
    let grid = document.getElementById('searchGrid'), btn = document.getElementById('loadMoreBtn'), st = document.getElementById('searchStatus');
    if(!grid) return;
    try {
        let data = JSON.parse(decodeB64Utf8(b64)); currentNextUrl = data.next_url;
        data.results.forEach(item => {
            let div = document.createElement('div'); div.className = 'search-item';
            div.onclick = () => openDetails(item.id); div.innerHTML = buildItemHtml(item); grid.appendChild(div);
        });
        st.innerText = "Результаты поиска";
        btn.style.display = currentNextUrl ? 'block' : 'none';
        
        let isSearchActive = document.getElementById('page-search').classList.contains('active');
        if (isSearchActive && (searchHideAiVal || searchAgeVal !== 'all') && data.results.length < 15 && currentNextUrl && !isDoubleLoading) {
            isDoubleLoading = true; loadMore();
        } else { isDoubleLoading = false; }
    } catch (e) { st.innerText = "Ошибка сети."; btn.style.display = 'none'; }
}

// --- НОВАЯ ЛОГИКА ПРОФИЛЯ ---

function openAuthor(id, name, avatarUrl = "") {
    tabScrollPositions["author"] = 0;
    switchTab("author");
    // Чужой профиль — показываем баннер-шапку (выходим из простого режима)
    document.getElementById("page-author").classList.remove("simple-mode");
    // Ник + бейдж верификации (если ID есть в списке)
    let titleEl = document.getElementById("authorTitle");
    let safeName = (name || "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    titleEl.innerHTML = safeName + getBadgeHtml(id);
    document.getElementById("authorIdDisplay").innerText = "ID: " + id; // Применяем аватарку и размытый фон
    let avatarEl = document.getElementById("authorProfileAvatar");
    let bannerEl = document.getElementById("authorBannerImg");
    if (avatarUrl && avatarUrl !== "null") {
        avatarEl.src = avatarUrl;
        bannerEl.src = avatarUrl;
        bannerEl.style.display = "block";
    } else {
        avatarEl.src = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs="; // Пусто
        bannerEl.style.display = "none";
    }
    document.getElementById("authorTabName").innerText = "Работы автора"; // Показываем кнопку подписки, если это чужой профиль
    let followBtn = document.getElementById("authorFollowBtn");
    if (id && id !== "self" && id !== "offline_cache") {
        followBtn.style.display = "block";
        
        // Присваиваем кнопке ID автора, чтобы скрипт мог её найти
        followBtn.setAttribute('data-author-id', id);
        
        // Восстанавливаем статус из кэша
        let isFollowed = window.followStateCache[id] === true;
        followBtn.classList.toggle('active', isFollowed);
        followBtn.innerText = isFollowed ? "Отписаться" : "Подписаться";

        // Вешаем клик
        followBtn.onclick = () => toggleFollowUser(id);
    } else {
        followBtn.style.display = "none";
    }

    document.getElementById("authorGrid").innerHTML = "";
    currentAuthorNextUrl = "";
    currentAuthorId = id;
    isViewingBookmarks = false;
    document.getElementById("loadMoreAuthorBtn").style.display = "none";
    Android.getAuthorIllusts(id, "");
}

function viewOwnIllusts() {
    tabScrollPositions["author"] = 0;
    toggleSidebar();
    switchTab("author");
    // Простой хедер вместо баннера-профиля
    document.getElementById("page-author").classList.add("simple-mode");
    document.getElementById("authorSimpleTitle").innerText = "Мои работы";
    document.getElementById("authorTabName").innerText = "Опубликованное";
    document.getElementById("authorFollowBtn").style.display = "none";

    document.getElementById("authorGrid").innerHTML = "";
    currentAuthorNextUrl = "";
    currentAuthorId = "self";
    isViewingBookmarks = false;
    document.getElementById("loadMoreAuthorBtn").style.display = "none";
    Android.getOwnIllusts("");
}

function viewBookmarks() {
    tabScrollPositions["author"] = 0;
    toggleSidebar();
    switchTab("author");
    // Простой хедер вместо баннера-профиля
    document.getElementById("page-author").classList.add("simple-mode");
    document.getElementById("authorSimpleTitle").innerText = "Нравится";
    document.getElementById("authorTabName").innerText = "Избранное";
    document.getElementById("authorFollowBtn").style.display = "none";

    document.getElementById("authorGrid").innerHTML = "";
    currentAuthorNextUrl = "";
    currentAuthorId = "self";
    isViewingBookmarks = true;
    document.getElementById("loadMoreAuthorBtn").style.display = "none";
    Android.getBookmarks("");
}

function copyAuthorId() {
    let idText = document.getElementById("authorIdDisplay").innerText;
    if (idText && idText.includes("ID: ")) {
        let rawId = idText.replace("ID: ", "").trim();
        if (rawId === "---" || rawId === "Ваш профиль" || rawId === "Сохраненное") return;
        let tempInput = document.createElement("input");
        tempInput.value = rawId;
        document.body.appendChild(tempInput);
        tempInput.select();
        document.execCommand("copy");
        document.body.removeChild(tempInput);
        showToast("ID автора скопирован: " + rawId);
        if (typeof Android !== "undefined" && typeof Android.hapticClick === "function") Android.hapticClick();
    }
}

function loadMoreAuthor() {
    if (isViewingBookmarks) Android.getBookmarks(currentAuthorNextUrl);
    else if (currentAuthorId === "self") Android.getOwnIllusts(currentAuthorNextUrl);
    else Android.getAuthorIllusts(currentAuthorId, currentAuthorNextUrl);
}

function displayAuthorIllusts(b64) {
    let data = JSON.parse(decodeB64Utf8(b64));
    if (loadingMiniGrid) {
        if (currentIllustId) authorCache[currentIllustId] = b64;
        let grid = document.getElementById("detMiniGrid");
        if (grid) {
            grid.innerHTML = "";
            let filtered = data.results.filter((item) => item.id !== currentIllustId).slice(0, 8);
            filtered.forEach((item) => {
                let div = document.createElement("div");
                div.className = "mini-item search-item";
                div.onclick = () => {
                    openDetails(item.id);
                };
                div.innerHTML = buildItemHtml(item);
                grid.appendChild(div);
            });
            if (filtered.length === 0) grid.innerHTML = '<div class="text-sub" style="padding:16px;">Больше нет работ</div>';
        }
        loadingMiniGrid = false;
        requestRelatedIllustsSafe();
        return;
    }

    let grid = document.getElementById("authorGrid");
    if (!grid) return;
    currentAuthorNextUrl = data.next_url;
    if (data.results_for_logged_in_user) currentAuthorId = "self";

    // Профиль открыт по ID (имя в шапке пустое) — берём имя автора из первой работы.
    let titleEl = document.getElementById("authorTitle");
    if (titleEl && titleEl.innerText.trim() === "" && data.results && data.results.length > 0 && data.results[0].author) {
        let safeName = String(data.results[0].author).replace(/</g, "&lt;").replace(/>/g, "&gt;");
        titleEl.innerHTML = safeName + getBadgeHtml(currentAuthorId);
    }

    data.results.forEach((item) => {
        let div = document.createElement("div");
        div.className = "search-item";
        div.onclick = () => openDetails(item.id);
        div.innerHTML = buildItemHtml(item);
        grid.appendChild(div);
    });
    document.getElementById("loadMoreAuthorBtn").style.display = currentAuthorNextUrl ? "block" : "none";
}

// ==========================================
// ОТКРЫТИЕ ПОСТА (СИСТЕМА СЛОЕВ + ИНСТАНТ ВОЗВРАТ)
// ==========================================
function openDetails(id, isBack = false) {
    let activeTab = navHistory[navHistory.length - 1]; // 1. ПЕРЕХОД ВГЛУБЬ (СОЗДАЕМ НОВЫЙ СЛОЙ)
    if (activeTab === "detail" && !isBack && currentIllustId && currentIllustId !== String(id)) {
        let currentPage = document.getElementById("page-detail");
        detailScrollPositions[currentIllustId] = window.scrollY || document.documentElement.scrollTop; // Прячем ID элементов старой страницы
        currentPage.querySelectorAll("[id]").forEach((el) => {
            el.dataset.oldId = el.id;
            el.removeAttribute("id");
        });
        currentPage.id = "page-detail-saved-" + currentIllustId;
        currentPage.style.display = "none";
        currentPage.classList.remove("active"); // Добавляем новый слой из шаблона
        document.getElementById("pages-container").insertAdjacentHTML("beforeend", detailPageTemplate); // Активируем новый слой (ТУТ АНИМАЦИЯ НУЖНА)
        document.getElementById("page-detail").classList.add("active");
        detailHistoryStack.push(currentIllustId);
    } else if (activeTab !== "detail" && !isBack) {
        // Зашли снаружи - очищаем все слои
        detailHistoryStack = [];
        detailScrollPositions = {};
        document.querySelectorAll('[id^="page-detail-saved-"]').forEach((el) => el.remove());
        if (!document.getElementById("page-detail")) {
            document.getElementById("pages-container").insertAdjacentHTML("beforeend", detailPageTemplate);
        }
        // Активную страницу переключит switchTab("detail") ниже — иначе остались бы
        // две активные страницы (исходная вкладка + деталь), что ломало навигацию и шапку.
    } // ========================================== // 2. ВОЗВРАТ НАЗАД (МГНОВЕННАЯ ТЕЛЕПОРТАЦИЯ) // ==========================================

    if (isBack) {
        let currentPage = document.getElementById("page-detail");
        if (currentPage) currentPage.remove();

        let prevPage = document.getElementById("page-detail-saved-" + id);
        if (prevPage) {
            prevPage.id = "page-detail";
            prevPage.querySelectorAll("[data-old-id]").forEach((el) => {
                el.id = el.dataset.oldId;
                el.removeAttribute("data-old-id");
            }); // ОТКЛЮЧАЕМ АНИМАЦИИ ПЕРЕД ПОКАЗОМ (чтобы не было скачков)
            prevPage.style.transition = "none";
            prevPage.style.animation = "none";
            prevPage.style.display = "";
            prevPage.classList.add("active"); // ХАК: Заставляем браузер применить стили мгновенно
            void prevPage.offsetWidth; // Возвращаем настройки анимации обратно
            prevPage.style.transition = "";
            prevPage.style.animation = "";

            currentIllustId = String(id); // Моментально восстанавливаем скролл
            setTimeout(() => {
                window.scrollTo(0, detailScrollPositions[id] || 0);
            }, 10);
            return; // ПРЕРЫВАЕМ! Сеть не нужна.
        }
    } // 3. НОВЫЙ ПОСТ (ГРУЗИМ ИЗ СЕТИ)

    currentIllustId = String(id);
    if (activeTab === "detail") {
        window.scrollTo(0, 0);
    } else {
        tabScrollPositions["detail"] = 0;
        switchTab("detail");
    }
    // Мгновенный предпросмотр из уже загруженной карточки сетки:
    // показываем название и кэшированное (уже скачанное) превью сразу,
    // а полные данные и HQ-картинку догрузит сеть.
    let cachedItem = window.gridItemCache[currentIllustId];
    document.getElementById("detImageContainer").className = "det-image-container";
    if (cachedItem && cachedItem.thumb) {
        document.getElementById("detTitle").innerText = cachedItem.title || "Загрузка...";
        let pBadge = (cachedItem.page_count > 1)
            ? `<div class="badge badge-pages" style="position:absolute; top:12px; left:12px;"><svg class="icon-xs"><use href="#icon-pages" xlink:href="#icon-pages"></use></svg>${cachedItem.page_count}</div>`
            : '';
        // src = превью (мгновенно из кэша браузера). При ответе сети контейнер
        // перерисуется с тем же превью + HQ через data-src, без вспышки пустоты.
        document.getElementById("detImageContainer").innerHTML = `
            <div class="det-first-img" style="position:relative; width:100%; min-height:400px; background:#050505; display:flex; align-items:center; justify-content:center;">
                <img class="search-img loaded" src="${cachedItem.thumb}"
                     style="max-width:100%; max-height:70vh; object-fit:contain;">
                ${pBadge}
            </div>`;
    } else {
        document.getElementById("detTitle").innerText = "Загрузка...";
        document.getElementById("detImageContainer").innerHTML = "";
    }
    document.getElementById("detMiniGrid").innerHTML = "";
    let relatedGrid = document.getElementById("detRelatedGrid");
    if (relatedGrid) relatedGrid.innerHTML = "";
    let relatedBtn = document.getElementById("loadMoreRelatedBtn");
    if (relatedBtn) relatedBtn.style.display = "none";
    currentRelatedNextUrl = "";
    relatedRetryCount = 0;
    document.getElementById("detAiTag").style.display = "none";
    document.getElementById("detViews").innerText = "0";
    document.getElementById("detBookmarks").innerText = "0";
    document.getElementById("detDate").innerText = "";
    // Сбрасываем автора, аватар и теги, иначе при переходе снаружи (с профиля,
    // поиска и т.п.) page-detail переиспользуется и они висят от прошлой работы,
    // пока не ответит сеть.
    let _authorName = document.getElementById("detAuthorName");
    if (_authorName) _authorName.innerText = "";
    let _authorAvatar = document.getElementById("detAuthorAvatar");
    if (_authorAvatar) _authorAvatar.src = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";
    let _detTags = document.getElementById("detTags");
    if (_detTags) _detTags.innerHTML = "";
    let _followBtn = document.getElementById("detFollowBtn");
    if (_followBtn) {
        _followBtn.innerText = "Подписаться";
        _followBtn.classList.remove("active");
        _followBtn.removeAttribute("data-author-id");
    }
    document.getElementById("fillDetInline").style.width = "0%";
    document.getElementById("detProgressBg").style.display = "none";
    // Состояние лайка берём из кэша карточки (если есть), иначе сбрасываем.
    currentIsBookmarked = (cachedItem && cachedItem.is_bookmarked) ? true : false;
    updateLikeUI();
    resetCommentsState();
    if (currentIllustId === "offline_cache") {
        document.getElementById("detLikeBtn").style.display = "none";
        Android.getOfflineDetails();
    } else {
        document.getElementById("detLikeBtn").style.display = "flex";
        Android.getIllustDetails(currentIllustId);
    }
}

// Заглушка
function requestRelatedIllustsSafe() {
    Android.getRelatedIllusts(currentIllustId, "");
}

function displayIllustDetails(b64) {
    let data = JSON.parse(decodeB64Utf8(b64));
    let t = document.getElementById('detTitle');

    if(!t) return;
    if(data.error) { t.innerText = data.error; return; }

    currentIsBookmarked = data.is_bookmarked; updateLikeUI();
    t.innerText = data.title;
    document.getElementById('detViews').innerText = data.view_count || 0;
    document.getElementById('detBookmarks').innerText = data.bookmark_count || 0;
    document.getElementById('detDate').innerText = (data.create_date || "").substring(0, 10);
    if(data.is_ai) document.getElementById('detAiTag').style.display = "inline-flex";

    document.getElementById('detAuthorName').innerText = data.author;
    document.getElementById('detAuthorAvatar').src = data.author_avatar || 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
    document.getElementById('detAuthorBtn').onclick = () => openAuthor(data.author_id, data.author, data.author_avatar);
    
    // Сервер прислал нам 100% точный статус — сохраняем его в кэш!
    window.followStateCache[data.author_id] = data.is_followed;

    let followBtn = document.getElementById('detFollowBtn');
    if (followBtn) {
        followBtn.setAttribute('data-author-id', data.author_id);
        followBtn.onclick = (e) => {
            e.stopPropagation(); 
            toggleFollowUser(data.author_id);
        };
    }
    
    // Синхронизируем интерфейс сразу после получения данных
    syncFollowButtons(data.author_id, data.is_followed);

    const localDict = {
        'オリジナル': 'Ориджинал', '女の子': 'Девушки', '風景': 'Пейзажи',
        '初音ミク': 'Miku', '創作': 'Творчество', '落書き': 'Скетч', '美少女': 'Красавица'
    };

    let tHtml = ""; 
    data.tags.forEach(tag => {
        let transText = tag.trans || localDict[tag.name] || "";
        let displayTrans = transText ? `<span style="opacity: 0.6; font-size: 0.9em; margin-left: 4px;">(${transText})</span>` : '';
        tHtml += `<div class="tag-chip" onclick="document.getElementById('searchInput').value='${tag.name}'; switchTab('search'); startSearch(true);">#${tag.name}${displayTrans}</div>`;
    });
    document.getElementById('detTags').innerHTML = tHtml;

    detailImagesData = data.images;
    let origImagesData = data.original_images || data.images;
    detailOriginalImages = origImagesData || [];

    // Данные для плейсхолдеров шаблона подписи при шеринге в Telegram.
    shareTemplateData = {
        id: String(currentIllustId),
        title: data.title || "",
        url: "https://www.pixiv.net/artworks/" + currentIllustId,
        author: data.author || "",
        author_url: "https://www.pixiv.net/users/" + (data.author_id || ""),
        tags: (data.tags || []).map((t) => t.name),
        pages: (data.images || []).length,
        date: (data.create_date || "").substring(0, 10),
        views: data.view_count || 0,
        bookmarks: data.bookmark_count || 0
    };

    recordIllustView({
        id: currentIllustId,
        title: data.title,
        thumb: (data.images && data.images[0]) || "",
        page_count: data.images ? data.images.length : 1
    });

    // Запоминаем текущую работу для коллекций и обновляем иконку
    currentDetailMeta = {
        id: String(currentIllustId),
        title: data.title || "Без названия",
        thumb: (data.images && data.images[0]) || ""
    };
    updateCollectionIcon();
    
    let safeTitle = data.title ? data.title.replace(/'/g, "\\'").replace(/"/g, '&quot;') : "Без названия";
    let isMultiPage = data.images.length > 1;

    // --- ПЕРВАЯ КАРТИНКА ---
    // Если есть уже загруженное превью карточки — ставим его в src, чтобы
    // картинка была видна мгновенно, а HQ-версия (data-src) догрузилась поверх
    // без вспышки пустоты (браузер держит старое изображение, пока грузит новое).
    let cachedThumb = (window.gridItemCache[currentIllustId] || {}).thumb || "";
    let firstSrcAttr = cachedThumb ? `src="${cachedThumb}" class="search-img loaded"` : `class="search-img"`;
    let imgH = `
        <div class="det-first-img" style="position:relative; width:100%; min-height:400px; background:#050505; display:flex; align-items:center; justify-content:center;">
             <img ${firstSrcAttr}
                 data-src="${data.images[0]}"
                 onclick="openImageViewer('${origImagesData[0] || data.images[0]}')"
                 style="max-width:100%; max-height:70vh; object-fit:contain; cursor: pointer;">
        </div>`;

    let listH = '';
    if (isMultiPage) {
        listH = `<div class="det-img-list">`;
        data.images.forEach((url, idx) => {
            // Берем оригинальный URL из массива оригиналов, если он там есть
            let originalUrl = (origImagesData && origImagesData[idx]) ? origImagesData[idx] : url;
        
            listH += `
            <div style="position:relative; width:100%; min-height:400px; background:#0A0A0A; margin-bottom: 2px;">
                <img class="search-img" 
                     data-src="${url}" 
                     onclick="openImageViewer('${originalUrl}')" 
                     style="width:100%; display:block; object-fit:contain; cursor: pointer;">
            
                <div class="quick-dl-btnPost" 
                     style="bottom:16px; right:16px; width:44px; height:44px; background:rgba(0,0,0,0.7); box-shadow: 0 4px 12px rgba(0,0,0,0.6);" 
                     onclick="event.stopPropagation(); Android.downloadPage(currentIllustId, ${idx}, '${safeTitle}', '${url}', '${originalUrl}'); showToast('Страница ${idx + 1} в очереди');">
                    <svg class="icon"><use href="#icon-dl" xlink:href="#icon-dl"></use></svg>
                </div>
            </div>`;
        });
        listH += `</div>`;
    }

    let overlayH = isMultiPage ? `<div class="show-all-overlay" onclick="showAllDetailImages()"><div class="show-all-btn">Показать всё (${data.images.length})</div></div>` : '';
    
    document.getElementById('detImageContainer').innerHTML = imgH + listH + overlayH;
    
    document.getElementById('detMiniGrid').innerHTML = '<div class="text-sub" style="padding:16px;">Загрузка...</div>';
    loadingMiniGrid = true;
    Android.getAuthorIllusts(data.author_id, "");
}

function toggleBookmark() {
    if (!currentIllustId) return;
    currentIsBookmarked = !currentIsBookmarked;
    updateLikeUI();
    let gridBtn = document.getElementById("gridLike_" + currentIllustId);
    if (gridBtn) {
        gridBtn.classList.toggle("liked", currentIsBookmarked);
        gridBtn.querySelector("use").setAttribute("href", currentIsBookmarked ? "#icon-heart" : "#icon-heart-outline");
    }
    Android.toggleBookmark(currentIllustId, currentIsBookmarked);
}

function updateLikeUI() {
    let btn = document.getElementById("detLikeBtn");
    if (!btn) return;
    btn.classList.toggle("liked", currentIsBookmarked);
    document.getElementById("detLikeIcon").innerHTML = currentIsBookmarked ? '<use href="#icon-heart" xlink:href="#icon-heart"></use>' : '<use href="#icon-heart-outline" xlink:href="#icon-heart-outline"></use>';
}

function revertBookmarkUI(id, wasAdded) {
    let willBe = !wasAdded;
    if (id === currentIllustId) {
        currentIsBookmarked = willBe;
        updateLikeUI();
    }
    let gridBtn = document.getElementById("gridLike_" + id);
    if (gridBtn) {
        gridBtn.classList.toggle("liked", willBe);
        gridBtn.querySelector("use").setAttribute("href", willBe ? "#icon-heart" : "#icon-heart-outline");
    }
}

// Глобальный кэш статусов подписки (ID автора -> true/false)
window.followStateCache = window.followStateCache || {};

// Универсальная функция синхронизации ВСЕХ кнопок на экране
function syncFollowButtons(userId, isFollowed) {
    // Находим все кнопки подписки, привязанные к этому автору
    let buttons = document.querySelectorAll(`[data-author-id="${userId}"]`);
    buttons.forEach(btn => {
        btn.classList.toggle('active', isFollowed);
        btn.innerText = isFollowed ? "Отписаться" : "Подписаться";
    });
}

// Обновленная функция клика (теперь без второго аргумента)
function toggleFollowUser(userId) {
    if (!userId || userId === "self" || userId === "offline_cache") return;

    // Берем статус из кэша и инвертируем его
    let isCurrentlyFollowing = window.followStateCache[userId] === true;
    let willFollow = !isCurrentlyFollowing;

    // Обновляем кэш
    window.followStateCache[userId] = willFollow;

    // Отправляем запрос на сервер
    if (typeof Android !== "undefined" && typeof Android.toggleUserFollow === "function") {
        Android.toggleUserFollow(userId, willFollow);
    }

    // Мгновенно синхронизируем все кнопки в интерфейсе
    syncFollowButtons(userId, willFollow);

    showToast(willFollow ? "Подписка оформлена" : "Вы отписались");
    
    if (typeof Android !== "undefined" && typeof Android.hapticClick === "function") {
        Android.hapticClick();
    }
}

function showAllDetailImages() {
    document.getElementById("detImageContainer").classList.add("expanded");
}

function loadMoreRelated() {
    if (currentIllustId) {
        Android.getRelatedIllusts(currentIllustId, currentRelatedNextUrl);
    }
}

function displayRelatedIllusts(b64) {
    let grid = document.getElementById("detRelatedGrid");
    let btn = document.getElementById("loadMoreRelatedBtn");
    if (!grid) return;
    try {
        let data = JSON.parse(decodeB64Utf8(b64));
        if (currentRelatedNextUrl === "") {
            grid.innerHTML = "";
        }

        currentRelatedNextUrl = data.next_url;

        let addedCount = 0;
        if (data.results) {
            data.results.forEach((item) => {
                if (String(item.id) !== String(currentIllustId) && !item.error) {
                    let div = document.createElement("div");
                    div.className = "search-item";
                    div.onclick = () => openDetails(item.id);
                    div.innerHTML = buildItemHtml(item);
                    grid.appendChild(div);
                    addedCount++;
                }
            });
        }
        if (addedCount === 0 && !currentRelatedNextUrl && relatedRetryCount < 3) {
            relatedRetryCount++;
            setTimeout(() => {
                if (currentIllustId) Android.getRelatedIllusts(currentIllustId, "");
            }, 1000);
            return;
        }
        if (btn) btn.style.display = currentRelatedNextUrl ? "block" : "none";
    } catch (e) {
        if (relatedRetryCount < 3) {
            relatedRetryCount++;
            setTimeout(() => {
                if (currentIllustId) Android.getRelatedIllusts(currentIllustId, "");
            }, 1000);
            return;
        }
        if (btn) btn.style.display = "none";
    }
}

// ==========================================
// КОММЕНТАРИИ И ПЕРЕКЛЮЧАТЕЛЬ ПОХОЖИЕ/КОММЕНТАРИИ
// ==========================================
let currentCommentsNextUrl = "";
let commentsLoaded = false;

// Переключение вкладок на детальной странице (Похожие / Комментарии)
function setDetailTab(tab) {
    let relatedSec = document.getElementById("detRelatedSection");
    let commentsSec = document.getElementById("detCommentsSection");
    document.querySelectorAll("#detTab_related, #detTab_comments").forEach((c) => c.classList.remove("active"));
    let activeBtn = document.getElementById("detTab_" + tab);
    if (activeBtn) activeBtn.classList.add("active");
    updateDetailTabSlider();

    if (tab === "comments") {
        if (relatedSec) relatedSec.style.display = "none";
        if (commentsSec) commentsSec.style.display = "block";
        // Грузим комментарии только при первом открытии вкладки
        if (!commentsLoaded) loadIllustComments();
    } else {
        if (relatedSec) relatedSec.style.display = "block";
        if (commentsSec) commentsSec.style.display = "none";
    }
}

// Скользящий хайлайт переключателя на детальной странице
function updateDetailTabSlider() {
    let slider = document.getElementById("detTabSlider");
    let active = document.querySelector("#detTab_related.active, #detTab_comments.active");
    if (!slider || !active) return;
    slider.style.left = active.offsetLeft + "px";
    slider.style.width = active.offsetWidth + "px";
}

// Сброс состояния комментариев при открытии новой иллюстрации
function resetCommentsState() {
    commentsLoaded = false;
    currentCommentsNextUrl = "";
    let cont = document.getElementById("detCommentsContainer");
    if (cont) cont.innerHTML = "";
    let inp = document.getElementById("detCommentInput");
    if (inp) inp.value = "";
    // Всегда возвращаемся на вкладку "Похожие" по умолчанию
    setDetailTab("related");
}

function loadIllustComments() {
    if (!currentIllustId || currentIllustId === "offline_cache") return;
    let cont = document.getElementById("detCommentsContainer");
    if (cont && !commentsLoaded) cont.innerHTML = '<div class="text-sub" style="padding: 12px 0;">Загрузка комментариев...</div>';
    currentCommentsNextUrl = "";
    Android.getIllustComments(currentIllustId, "");
}

function loadMoreComments() {
    if (!currentIllustId || !currentCommentsNextUrl) return;
    Android.getIllustComments(currentIllustId, currentCommentsNextUrl);
}

function displayIllustComments(b64) {
    let container = document.getElementById("detCommentsContainer");
    let btn = document.getElementById("loadMoreCommentsBtn");
    if (!container) return;
    try {
        let data = JSON.parse(decodeB64Utf8(b64));
        // Первая порция — очищаем "Загрузка..."
        if (!commentsLoaded || currentCommentsNextUrl === "") {
            container.innerHTML = "";
        }
        commentsLoaded = true;
        currentCommentsNextUrl = data.next_url || "";
        if (currentCommentsNextUrl === "null" || currentCommentsNextUrl === "undefined") currentCommentsNextUrl = "";

        // Диагностика: сервер вернул ошибку
        if (data.error) {
            container.innerHTML = '<div class="text-sub" style="padding: 12px 0; line-height: 1.5; word-break: break-all;">Ошибка загрузки: ' +
                (data.error || "") + '<br><span style="opacity:0.7; font-size:11px;">URL: ' +
                ((data.error_url || "").replace(/</g, "&lt;")) + '</span><br><span style="opacity:0.7; font-size:11px;">' +
                ((data.error_body || "").replace(/</g, "&lt;").slice(0, 200)) + '</span></div>';
            if (btn) btn.style.display = "none";
            return;
        }

        if ((!data.comments || data.comments.length === 0) && container.innerHTML === "") {
            container.innerHTML = '<div class="text-sub" style="padding: 12px 0;">Пока нет комментариев. Будьте первым!</div>';
            if (btn) btn.style.display = "none";
            return;
        }

        let html = "";
        (data.comments || []).forEach((c) => {
            let safeName = (c.user_name || "Аноним").replace(/</g, "&lt;").replace(/>/g, "&gt;");
            let safeText = (c.comment || "").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
            let badge = getBadgeHtml(c.user_id);
            // Стикеры Pixiv приходят как stamp вместо текста
            let stampHtml = c.stamp_url ? `<img class="det-comment-stamp" src="${c.stamp_url}">` : "";
            let repliesHtml = c.has_replies ? '<div class="det-comment-replies">Есть ответы</div>' : "";
            html += `<div class="det-comment-item">
                <div class="det-comment-head">
                    <span class="det-comment-name">${safeName}${badge}</span>
                    <span class="det-comment-date">${c.date || ""}</span>
                </div>
                <div class="det-comment-text">${safeText}${stampHtml}</div>
                ${repliesHtml}
            </div>`;
        });
        container.insertAdjacentHTML("beforeend", html);

        if (btn) btn.style.display = currentCommentsNextUrl ? "block" : "none";
    } catch (e) {
        if (container.innerHTML === "" || container.innerHTML.includes("Загрузка")) {
            container.innerHTML = '<div class="text-sub" style="padding: 12px 0;">Не удалось загрузить комментарии</div>';
        }
    }
}

function postComment() {
    let input = document.getElementById("detCommentInput");
    if (!input) return;
    let text = input.value.trim();
    if (!text) return;
    if (!currentIllustId || currentIllustId === "offline_cache") {
        showToast("Недоступно в офлайн-режиме");
        return;
    }
    let btn = document.getElementById("detCommentSendBtn");
    if (btn) btn.style.opacity = "0.5";
    Android.postIllustComment(currentIllustId, text);
}

// Автоувеличение высоты поля ввода комментария
function autoGrowComment(el) {
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
}

// Вызывается из native после успешной отправки
function onCommentPosted() {
    let input = document.getElementById("detCommentInput");
    if (input) { input.value = ""; input.style.height = "auto"; }
    let btn = document.getElementById("detCommentSendBtn");
    if (btn) btn.style.opacity = "1";
    showToast("Комментарий опубликован");
    // Перезагружаем список с начала
    commentsLoaded = false;
    loadIllustComments();
}

// Вызывается из native при ошибке отправки
function onCommentFailed() {
    let btn = document.getElementById("detCommentSendBtn");
    if (btn) btn.style.opacity = "1";
    showToast("Не удалось отправить комментарий");
}


// ЛОГИКА СЕНСОРНЫХ СВАЙПОВ И ЩИПКА
// ==========================================

let currentGridCols = parseInt(localStorage.getItem("pixivGridCols")) || 2;
let isPinching = false;
let initialPinchDist = 0;

const gridStyle = document.createElement('style');
// ВАЖНО: Внутри этого блока использованы только обычные пробелы
gridStyle.innerHTML = `
    #searchGrid, #recomGrid, #authorGrid, #detRelatedGrid, #discoveryGrid, #historyGrid, #collectionItemsGrid {
        display: grid !important;
        grid-template-columns: repeat(var(--grid-cols, 2), minmax(0, 1fr)) !important;
        gap: 4px !important;
        will-change: transform;
    }

    /* Список коллекций: меняем только число колонок, сохраняя крупный отступ карточек. */
    .col-grid {
        grid-template-columns: repeat(var(--grid-cols, 2), minmax(0, 1fr)) !important;
    }

    @keyframes gridZoomIn {
        0% { transform: scale(0.96); } 
        100% { transform: scale(1); }
    }
    @keyframes gridZoomOut {
        0% { transform: scale(1.04); } 
        100% { transform: scale(1); }
    }
    
    .grid-zoom-in { animation: gridZoomIn 0.25s cubic-bezier(0.2, 0.8, 0.2, 1.05) !important; }
    .grid-zoom-out { animation: gridZoomOut 0.25s cubic-bezier(0.2, 0.8, 0.2, 1.05) !important; }
`;
document.head.appendChild(gridStyle);
document.documentElement.style.setProperty('--grid-cols', currentGridCols);

// Страницы, где зум сетки (pinch) запрещён — у них своя фиксированная вёрстка.
const gridZoomBlockedPages = ["manager", "down", "browse", "smartcache"];

function changeGridCols(step) {
    let activePage = document.querySelector(".page.active");
    if (activePage && gridZoomBlockedPages.includes(activePage.id.replace("page-", ""))) {
        return;
    }

    let oldCols = currentGridCols;
    currentGridCols += step;
    
    if (currentGridCols < 1) currentGridCols = 1; 
    if (currentGridCols > 4) currentGridCols = 4; 
    
    if (oldCols !== currentGridCols) {
        localStorage.setItem('pixivGridCols', currentGridCols);
        document.documentElement.style.setProperty('--grid-cols', currentGridCols);
        
        let animClass = step < 0 ? 'grid-zoom-in' : 'grid-zoom-out';
        
        // Добавили discoveryGrid, historyGrid и коллекции, чтобы зум работал и там тоже!
        document.querySelectorAll('#searchGrid, #recomGrid, #authorGrid, #detRelatedGrid, #discoveryGrid, #historyGrid, #collectionItemsGrid, .col-grid').forEach(grid => {
            grid.classList.remove('grid-zoom-in', 'grid-zoom-out');
            void grid.offsetWidth; 
            grid.classList.add(animClass);
        });

        if (typeof Android !== 'undefined' && typeof Android.hapticClick === 'function') {
            Android.hapticClick();
        }
    }
}

// --- ПЕРЕМЕННЫЕ СВАЙПОВ ---
let ptrStartY = 0;
let ptrCurrentY = 0;
let ptrStartX = 0;
let ptrCurrentX = 0;

let isPulling = false;
let isSwiping = false;
let pullType = "";
let isBottomLoadingTriggered = false;
let swipeIgnored = false;

// Возвращает ВИДИМУЮ кнопку "Загрузить ещё" на активной странице.
// На детальной странице кнопок две (Похожие/Комментарии) — querySelector брал
// бы первую по DOM (всегда Похожие), из-за чего скролл в комментариях грузил не то.
function getActiveLoadMoreBtn() {
    let activePage = document.querySelector(".page.active");
    if (!activePage) return null;
    let buttons = activePage.querySelectorAll('.btn-secondary[id*="loadMore"]');
    for (let i = 0; i < buttons.length; i++) {
        let btn = buttons[i];
        if (btn.style.display !== "none" && btn.offsetParent !== null) return btn;
    }
    return null;
}

// Высота мёртвой зоны жеста обновления сверху (чёлка/статус-бар + небольшой запас).
function getRefreshDeadZone() {
    let sat = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--sat")) || 0;
    return sat + 16;
}

document.addEventListener("touchstart", (e) => {
    // ЕСЛИ ОТКРЫТ ПРОСМОТРЩИК - ИГНОРИРУЕМ ВСЁ ОСТАЛЬНОЕ
    if (document.getElementById('imageViewer').style.display === 'flex') return;
    // При открытом левом меню не реагируем на жесты фона
    if (isSidebarOpen()) return;

    if (e.touches.length === 2) {
            isPinching = true;
            isPulling = false;
            isSwiping = false;
            pullType = "";
            initialPinchDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
            return;
        }
        isPinching = false;

        ptrStartY = e.touches[0].clientY;
        ptrCurrentY = ptrStartY;
        ptrStartX = e.touches[0].clientX;
        ptrCurrentX = ptrStartX;
        isPulling = false;
        isSwiping = false;
        pullType = "";

        if (e.target.closest(".mini-grid-container, .filter-container, #activeSearchFilters, .theme-segmented, .det-img-list, .home-strip")) {
            swipeIgnored = true;
        } else {
            swipeIgnored = false;
        }
        if (window.scrollY === 0) {
            // Мёртвая зона в области чёлки/статус-бара: жест, начатый из самого верха,
            // не запускает обновление (часто пересекается с системными жестами).
            if (ptrStartY > getRefreshDeadZone()) {
                isPulling = true;
                pullType = "refresh";
            }
        } else if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 15) {
            let loadBtn = getActiveLoadMoreBtn();
            if (loadBtn && !isBottomLoadingTriggered) {
                isPulling = true;
                pullType = "loadmore";
                if (!loadBtn.querySelector(".scroll-filler")) {
                    let filler = document.createElement("div");
                    filler.className = "scroll-filler";
                    loadBtn.appendChild(filler);
                }
            }
        }
    },
    { passive: true }
);

document.addEventListener("touchmove", (e) => {
    if (document.getElementById('imageViewer').style.display === 'flex') return;
    if (isSidebarOpen()) return;
        if (isPinching && e.touches.length === 2) {
            let currentDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
            let diff = currentDist - initialPinchDist;

            if (diff > 50) {
                changeGridCols(-1);
                initialPinchDist = currentDist;
            } else if (diff < -50) {
                changeGridCols(1);
                initialPinchDist = currentDist;
            }
            return;
        }

        if (e.touches.length > 1) return;

        ptrCurrentX = e.touches[0].clientX;
        ptrCurrentY = e.touches[0].clientY;
        let dy = ptrCurrentY - ptrStartY;
        let dx = ptrCurrentX - ptrStartX;

        if (!isSwiping && Math.abs(dx) > 15 && Math.abs(dx) > Math.abs(dy)) {
            isSwiping = true;
            isPulling = false;
            pullType = "swipe";
        }

        if (isSwiping) return;
        if (!isPulling) return;
        if (pullType === "refresh") {
            let ptrEl = document.getElementById("pull-to-refresh");
            if (dy > 0 && window.scrollY === 0) {
                if (ptrEl) {
                    ptrEl.style.transition = "none";
                    let pullDistance = Math.min(dy * 0.4, 80);
                    ptrEl.style.transform = `translate(-50%, calc(-150% + ${pullDistance}px))`;
                    ptrEl.style.opacity = Math.min(dy / 100, 1);
                    let svg = ptrEl.querySelector("svg");
                    if (svg) svg.style.transform = `rotate(${dy * 2}deg)`;
                }
            } else if (ptrEl) {
                // Любое другое состояние (палец пошёл вверх ИЛИ страница начала
                // прокручиваться, scrollY>0) — прячем значок, иначе он застревает на экране.
                ptrEl.style.transform = "translate(-50%, -150%)";
                ptrEl.style.opacity = "0";
            }
        } else if (pullType === "loadmore") {
            let loadBtn = getActiveLoadMoreBtn();
            if (!loadBtn) return;
            let filler = loadBtn.querySelector(".scroll-filler");
            if (dy < 0 && !isBottomLoadingTriggered) {
                let pullDistance = Math.abs(dy);
                let progress = Math.min(100, (pullDistance / 120) * 100);
                if (filler) filler.style.width = progress + "%";
                loadBtn.style.transform = `translateY(-${Math.min(pullDistance * 0.15, 15)}px)`;

                if (progress >= 100) {
                    isBottomLoadingTriggered = true;
                    if (typeof Android !== "undefined" && typeof Android.hapticClick === "function") Android.hapticClick();
                    loadBtn.click();
                    thanosSnapElement(loadBtn, () => {
                        setTimeout(() => {
                            loadBtn.style.opacity = "1";
                            if (filler) filler.style.width = "0%";
                            loadBtn.style.transform = "translateY(0)";
                            isBottomLoadingTriggered = false;
                        }, 2000);
                    });
                }
            } else if (dy > 0 && !isBottomLoadingTriggered) {
                if (filler) filler.style.width = "0%";
                loadBtn.style.transform = "translateY(0)";
            }
        }
    },
    { passive: true }
);

document.addEventListener("touchend", (e) => {
    if (isSidebarOpen()) return;
    if (isPinching) {
        if (e.touches.length < 2) {
            isPinching = false;
            initialPinchDist = 0;
        }
        return;
    }

    let dy = ptrCurrentY - ptrStartY;
    let dx = ptrCurrentX - ptrStartX;
    if (isSwiping && !swipeIgnored && Math.abs(dx) > 70) {
        let currentTab = navHistory[navHistory.length - 1];
        let mainTabs = ["home", "search", "down"];
        if (mainTabs.includes(currentTab)) {
            let currentIndex = mainTabs.indexOf(currentTab);
            if (dx < 0 && currentIndex < mainTabs.length - 1) {
                switchTab(mainTabs[currentIndex + 1]);
            } else if (dx > 0 && currentIndex > 0) {
                switchTab(mainTabs[currentIndex - 1]);
            }
        } else {
            if (dx > 70 && ptrStartX < 60) {
                goBack();
            }
        }
    }

    if (!isPulling) {
        isSwiping = false;
        pullType = "";
        return;
    }
    isPulling = false;
    if (pullType === "refresh") {
        let ptrEl = document.getElementById("pull-to-refresh");
        if (ptrEl) {
            ptrEl.style.transition = "transform 0.3s, opacity 0.3s";
            ptrEl.style.transform = "translate(-50%, -150%)";
            ptrEl.style.opacity = "0";
        }
        if (dy > 120 && window.scrollY === 0) {
            refreshCurrentPage();
        }
    } else if (pullType === "loadmore") {
        let loadBtn = getActiveLoadMoreBtn();
        if (loadBtn && !isBottomLoadingTriggered) {
            let filler = loadBtn.querySelector(".scroll-filler");
            if (filler) filler.style.width = "0%";
            loadBtn.style.transform = "translateY(0)";
        }
    }
    pullType = "";
    isSwiping = false;
});

function refreshCurrentPage() {
    let currentTab = navHistory[navHistory.length - 1];
    showToast("Обновление...");
    if (currentTab === "home") {
        loadRecommendations(true);
        loadHomeStrips();
    } else if (currentTab === "search") {
        let q = document.getElementById("searchInput").value.trim();
        if (q) startSearch(true);
    } else if (currentTab === "manager") {
        Android.requestStorageInfo();
    } else if (currentTab === "author") {
        document.getElementById("authorGrid").innerHTML = "";
        if (typeof isViewingBookmarks !== "undefined" && isViewingBookmarks) {
            Android.getBookmarks("");
        } else if (currentAuthorId === "self") {
            Android.getOwnIllusts("");
        } else {
            Android.getAuthorIllusts(currentAuthorId, "");
        }
    } else if (currentTab === "detail") {
        if (currentIllustId) openDetails(currentIllustId);
    } else if (currentTab === "down") {
        Android.checkAccount();
    }
}

let cachedTrendingTags = null;

function initSearchSuggestions() {
    const container = document.querySelector("#page-search .search-bar-container");
    if (!container || document.getElementById("searchSuggestions")) return;

    const suggestionsDiv = document.createElement("div");
    suggestionsDiv.id = "searchSuggestions";
    suggestionsDiv.className = "search-suggestions";
    suggestionsDiv.style.display = "none";

    suggestionsDiv.innerHTML = `
        <div class="suggestions-section" id="historySection">
            <div class="suggestions-header">
                <span>История поиска</span>
                <span class="clear-history" onclick="clearSearchHistory()">Очистить</span>
            </div>
            <div id="searchHistoryList" class="compact-tags-container"></div>
        </div>
        <div class="suggestions-section" id="popularTagsSection">
            <div class="suggestions-header">В тренде на Pixiv</div>
            <div id="trendingTagsContainer" class="compact-tags-container">
                <div class="text-sub">Загрузка трендов...</div>
            </div>
        </div>
        <div class="suggestions-section" id="autocompleteSection" style="display: none;">
            <div class="suggestions-header">Подсказки</div>
            <div id="autocompleteList"></div>
        </div>
    `;

    const inputRow = container.querySelector(".search-input-row");
    inputRow ? inputRow.after(suggestionsDiv) : container.appendChild(suggestionsDiv);

    const input = document.getElementById("searchInput");
    input.addEventListener("focus", () => {
        showSearchSuggestions();
        triggerAutocomplete();
        cachedTrendingTags ? renderTrendingTags() : Android.getTrendingTags();
    });
    input.addEventListener("input", triggerAutocomplete);
    document.addEventListener("click", e => {
        if (!container.contains(e.target)) hideSearchSuggestions();
    });
}

function displayTrendingTags(b64) {
    try {
        let data = JSON.parse(decodeB64Utf8(b64));
        // У Pixiv API массив трендов обычно называется trend_tags
        if (data.trend_tags) {
            cachedTrendingTags = data.trend_tags;
            renderTrendingTags();
        }
    } catch (e) {
        console.error("Ошибка парсинга трендов:", e);
    }
}

// А вот здесь мы делаем ту самую компактную верстку!
function renderTrendingTags() {
    let container = document.getElementById("trendingTagsContainer");
    if (!container || !cachedTrendingTags) return;
    
    let html = "";
    
    // Используем .slice(0, 10), чтобы взять только первые 10 элементов
    cachedTrendingTags.slice(0, 10).forEach((item) => {
        let tName = item.tag;
        let tTrans = item.translated_name;
        let safeQ = tName.replace(/'/g, "\\'").replace(/"/g, "&quot;");
        let displayTrans = tTrans ? `<span style="opacity: 0.6; font-size: 0.9em; margin-left: 4px;">(${tTrans})</span>` : "";
        
        // Используем компактный стиль из CSS
        html += `<div class="compact-tag-chip trending" onclick="applySuggestion('${safeQ}')">#${tName}${displayTrans}</div>`;
    });
    
    container.innerHTML = html;
}

let autocompleteTimeout = null;
let activeAutocompleteTarget = "searchInput";

// Показ/скрытие крестика очистки в строке поиска иллюстраций
function toggleSearchClear() {
    let inp = document.getElementById("searchInput");
    let btn = document.getElementById("searchClearBtn");
    if (!inp || !btn) return;
    btn.classList.toggle("show", inp.value.length > 0);
}
function clearSearchInput() {
    let inp = document.getElementById("searchInput");
    if (!inp) return;
    inp.value = "";
    toggleSearchClear();
    inp.focus();
    triggerAutocomplete("searchInput");
}
window.toggleSearchClear = toggleSearchClear;
window.clearSearchInput = clearSearchInput;
function triggerAutocomplete(targetId) {
    if (typeof targetId !== "string") targetId = "searchInput";
    activeAutocompleteTarget = targetId;

    let input = document.getElementById(activeAutocompleteTarget);
    let val = input ? input.value.trim() : "";

    if (autocompleteTimeout) clearTimeout(autocompleteTimeout);

    // При вводе любого символа в поиск иллюстраций скрываем историю поиска,
    // а при очистке поля — показываем её обратно.
    if (activeAutocompleteTarget === "searchInput") {
        let historySection = document.getElementById("historySection");
        if (historySection) historySection.style.display = val ? "none" : "block";
    }

    if (!val) {
        if (activeAutocompleteTarget === "searchInput") {
            document.getElementById("autocompleteSection").style.display = "none";
            document.getElementById("popularTagsSection").style.display = "block";
        } else {
            let el = document.getElementById("excludeAutocompleteSection");
            if (el) el.style.display = "none";
        }
        return;
    }
    autocompleteTimeout = setTimeout(() => {
        Android.getAutocomplete(val);
    }, 400);
}

function displayAutocomplete(b64) {
    try {
        let data = JSON.parse(decodeURIComponent(escape(atob(b64))));
        let html = '';
        
        if (data.tags && data.tags.length > 0) {
            data.tags.forEach(tag => {
                let trans = tag.translated_name ? `<span style="color: var(--subtext); font-size: 12px;">(${tag.translated_name})</span>` : '';
                
                // Настраиваем логику клика в зависимости от того, куда мы вводим текст
                let onClickLogic = "";
                if (activeAutocompleteTarget === 'excludeTagInput' || activeAutocompleteTarget === 'excludeTagInputRecom') {
                     // Убираем старый applyExcludeTags(), просто применяем подсказку в поле (старая логика applySuggestion)
                     let safeQ = tag.name.replace(/'/g, "\\'").replace(/"/g, "&quot;");
                     onClickLogic = `applySuggestion('${safeQ}')`;
                } else {
                    // Для главного поиска
                    let safeQ = tag.name.replace(/'/g, "\\'").replace(/"/g, "&quot;");
                    onClickLogic = `applySuggestion('${safeQ}')`;
                }

                html += `<div class="autocomplete-compact-item" onclick="${onClickLogic}">
                            <svg class="icon-xs" style="color: var(--subtext); margin-right: 8px;"><use href="#icon-search"></use></svg>
                            ${tag.name} ${trans}
                         </div>`;
            });

            // Определяем, в какой именно контейнер положить HTML
            let sectionId = "autocompleteList";
            
            if (activeAutocompleteTarget === 'excludeTagInput') {
                 sectionId = 'excludeAutocompleteSection';
            } else if (activeAutocompleteTarget === 'excludeTagInputRecom') {
                 sectionId = 'excludeAutocompleteSectionRecom';
            }
            
            let sectionEl = document.getElementById(sectionId);
            
            if (sectionEl) {
                sectionEl.innerHTML = html;
                sectionEl.style.display = 'block'; // Показываем выпадающий список
                
                // Скрываем популярные теги, если это главный поиск
                if (activeAutocompleteTarget === 'searchInput') {
                     document.getElementById("popularTagsSection").style.display = "none";
                     document.getElementById("autocompleteSection").style.display = "block";
                }
            }
        } else {
            // Если подсказок нет - прячем контейнер
            let sectionId = "autocompleteList";
            if (activeAutocompleteTarget === 'excludeTagInput') {
                 sectionId = 'excludeAutocompleteSection';
            } else if (activeAutocompleteTarget === 'excludeTagInputRecom') {
                 sectionId = 'excludeAutocompleteSectionRecom';
            }

            let sectionEl = document.getElementById(sectionId);
            if (sectionEl) {
                 if(activeAutocompleteTarget === 'searchInput') {
                      sectionEl.innerHTML = '<div class="text-sub" style="padding: 8px;">Нет подсказок</div>';
                 } else {
                      sectionEl.style.display = 'none';
                 }
            }
        }
    } catch (e) {
        console.error("Ошибка автозаполнения:", e);
    }
}

function applySuggestion(q) {
    if (activeAutocompleteTarget === "excludeTagInput") {
        let input = document.getElementById("excludeTagInput");
        if (input) input.value = q;
        let el = document.getElementById("excludeAutocompleteSection");
        if (el) el.style.display = "none";
        applyExcludeTags("excludeTagInput");
    } else if (activeAutocompleteTarget === "excludeTagInputRecom") {
        let input = document.getElementById("excludeTagInputRecom");
        if (input) input.value = q;
        let el = document.getElementById("excludeAutocompleteSectionRecom");
        if (el) el.style.display = "none";
        applyExcludeTags("excludeTagInputRecom");
    } else {
        document.getElementById("searchInput").value = q;
        toggleSearchClear();
        hideSearchSuggestions();
        startSearch(true);
    }
}
function saveSearchQuery(q) {
    if (!q) return;
    searchHistory = searchHistory.filter((item) => item !== q);
    searchHistory.unshift(q);
    if (searchHistory.length > 5) searchHistory.pop();
    localStorage.setItem("pixivSearchHistory", JSON.stringify(searchHistory));
    renderSearchHistory();
}

function renderSearchHistory() {
    let list = document.getElementById("searchHistoryList");
    if (!list) return;
    if (searchHistory.length === 0) {
        list.innerHTML = '<div class="text-sub" style="padding: 8px;">История пуста</div>';
        return;
    }
    let html = "";
    searchHistory.forEach((q) => {
        let safeQ = q.replace(/'/g, "\\'").replace(/"/g, "&quot;");
        html += `<div class="suggestion-item" onclick="applySuggestion('${safeQ}')">
            <div class="suggestion-text"><svg class="icon-sm" style="color:var(--subtext)"><use href="#icon-search"></use></svg> <span>${safeQ}</span></div>
            <div class="suggestion-remove" onclick="event.stopPropagation(); removeSearchHistoryItem('${safeQ}')"><svg class="icon-sm"><use href="#icon-close"></use></svg></div>
        </div>`;
    });
    list.innerHTML = html;
}

function removeSearchHistoryItem(q) {
    searchHistory = searchHistory.filter((item) => item !== q);
    localStorage.setItem("pixivSearchHistory", JSON.stringify(searchHistory));
    renderSearchHistory();
}

function clearSearchHistory() {
    searchHistory = [];
    localStorage.setItem("pixivSearchHistory", JSON.stringify([]));
    renderSearchHistory();
}

// --- История просмотров иллюстраций (локально) ---
function getViewHistory() {
    try { return JSON.parse(localStorage.getItem("pixivViewHistory") || "[]"); } catch (e) { return []; }
}
function recordIllustView(item) {
    if (!item || !item.id) return;
    let id = String(item.id);
    let hist = getViewHistory().filter((e) => String(e.id) !== id);
    hist.unshift({
        id: id,
        title: item.title || "",
        thumb: item.thumb || "",
        page_count: item.page_count || 1,
        ts: new Date().getTime()
    });
    if (hist.length > 200) hist = hist.slice(0, 200);
    localStorage.setItem("pixivViewHistory", JSON.stringify(hist));
}

// ==========================================
// КОЛЛЕКЦИИ (локальное сохранение работ без лайка/скачивания)
// Хранятся в localStorage -> попадают в резервную копию автоматически.
// Формат: [ { id, name, items: [ {id, title, thumb} ] } ]
// ==========================================
function getCollections() {
    try { return JSON.parse(localStorage.getItem("pixivCollections") || "[]"); } catch (e) { return []; }
}
function saveCollections(arr) {
    localStorage.setItem("pixivCollections", JSON.stringify(arr));
}
function illustInCollection(col, illustId) {
    return col.items && col.items.some((it) => String(it.id) === String(illustId));
}
function isIllustInAnyCollection(illustId) {
    return getCollections().some((c) => illustInCollection(c, illustId));
}

// Обновляет подсветку иконки коллекции в детали
function updateCollectionIcon() {
    let btn = document.getElementById("detCollectionBtn");
    if (!btn) return;
    btn.classList.toggle("in-collection", isIllustInAnyCollection(currentDetailMeta.id));
}

function openCollectionSheet() {
    if (!currentIllustId || currentIllustId === "offline_cache") { showToast("Откройте работу"); return; }
    // Подстраховка для кэшированных страниц: синхронизируем мету с активной работой
    if (String(currentDetailMeta.id) !== String(currentIllustId)) {
        let titleEl = document.getElementById("detTitle");
        currentDetailMeta = {
            id: String(currentIllustId),
            title: titleEl ? titleEl.innerText : "Без названия",
            thumb: (typeof detailImagesData !== "undefined" && detailImagesData && detailImagesData[0]) || ""
        };
    }

    let btn = document.getElementById("detCollectionBtn");
    let pop = document.getElementById("collectionPopover");
    let ov = document.getElementById("collectionPopoverOverlay");
    if (!btn || !pop || !ov) return;

    // Сбрасываем строку создания
    let createRow = document.getElementById("cpopCreateRow");
    let createBtn = document.getElementById("cpopCreateBtn");
    if (createRow) createRow.style.display = "none";
    if (createBtn) createBtn.style.display = "flex";

    renderCollectionSheet();

    ov.classList.add("open");
    pop.classList.add("open");

    // Позиционируем поповер у кнопки коллекции
    let r = btn.getBoundingClientRect();
    let pw = pop.offsetWidth, ph = pop.offsetHeight;
    let margin = 8;
    let left = r.left;
    if (left + pw > window.innerWidth - margin) left = window.innerWidth - pw - margin;
    if (left < margin) left = margin;
    let top = r.bottom + 6; // под кнопкой
    if (top + ph > window.innerHeight - margin) top = r.top - ph - 6; // если не влезает — над кнопкой
    if (top < margin) top = margin;
    pop.style.left = left + "px";
    pop.style.top = top + "px";
}
function closeCollectionSheet() {
    let ov = document.getElementById("collectionPopoverOverlay");
    let pop = document.getElementById("collectionPopover");
    if (ov) ov.classList.remove("open");
    if (pop) pop.classList.remove("open");
    let inp = document.getElementById("newCollectionInput");
    if (inp) inp.value = "";
}

function showCollectionCreate() {
    let createRow = document.getElementById("cpopCreateRow");
    let createBtn = document.getElementById("cpopCreateBtn");
    if (createRow) createRow.style.display = "flex";
    if (createBtn) createBtn.style.display = "none";
    let inp = document.getElementById("newCollectionInput");
    if (inp) { inp.value = ""; setTimeout(() => inp.focus(), 50); }
}

function renderCollectionSheet() {
    let list = document.getElementById("collectionPopoverList");
    if (!list) return;
    let cols = getCollections();
    if (!cols.length) {
        list.innerHTML = '<div class="cpop-empty">Коллекций пока нет</div>';
        return;
    }
    let html = "";
    cols.forEach((c) => {
        let inIt = illustInCollection(c, currentDetailMeta.id);
        let safeName = (c.name || "Без названия").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        html += `<div class="cpop-item ${inIt ? "checked" : ""}" onclick="toggleCollectionMembership('${c.id}')">
            <span class="cpop-name">${safeName}</span>
        </div>`;
    });
    list.innerHTML = html;
}

function toggleCollectionMembership(collectionId) {
    let cols = getCollections();
    let col = cols.find((c) => c.id === collectionId);
    if (!col) return;
    if (!col.items) col.items = [];
    if (illustInCollection(col, currentDetailMeta.id)) {
        col.items = col.items.filter((it) => String(it.id) !== String(currentDetailMeta.id));
    } else {
        col.items.unshift({ id: currentDetailMeta.id, title: currentDetailMeta.title, thumb: currentDetailMeta.thumb });
    }
    saveCollections(cols);
    renderCollectionSheet();
    updateCollectionIcon();
}

function createCollectionAndAdd() {
    let inp = document.getElementById("newCollectionInput");
    if (!inp) return;
    let name = inp.value.trim();
    if (!name) { showToast("Введите название"); return; }
    let cols = getCollections();
    if (cols.some((c) => (c.name || "").toLowerCase() === name.toLowerCase())) {
        showToast("Такая коллекция уже есть");
        return;
    }
    let id = "col_" + new Date().getTime() + "_" + Math.floor(Math.random() * 1000);
    cols.unshift({ id: id, name: name, items: [{ id: currentDetailMeta.id, title: currentDetailMeta.title, thumb: currentDetailMeta.thumb }] });
    saveCollections(cols);
    inp.value = "";
    // Возвращаем кнопку "Создать" и прячем строку ввода
    let createRow = document.getElementById("cpopCreateRow");
    let createBtn = document.getElementById("cpopCreateBtn");
    if (createRow) createRow.style.display = "none";
    if (createBtn) createBtn.style.display = "flex";
    showToast("Коллекция «" + name + "» создана");
    renderCollectionSheet();
    updateCollectionIcon();
}

window.openCollectionSheet = openCollectionSheet;
window.closeCollectionSheet = closeCollectionSheet;
window.showCollectionCreate = showCollectionCreate;
window.toggleCollectionMembership = toggleCollectionMembership;
window.createCollectionAndAdd = createCollectionAndAdd;

// ===== Страница «Коллекции» (просмотр) =====
let currentOpenCollectionId = null;

function collectionsWordForm(n) {
    let mod10 = n % 10, mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return "работа";
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return "работы";
    return "работ";
}

function renderCollectionsPage() {
    // Всегда открываем со списка коллекций
    let listView = document.getElementById("collectionsListView");
    let itemsView = document.getElementById("collectionItemsView");
    let title = document.getElementById("collectionsTitle");
    if (listView) listView.style.display = "block";
    if (itemsView) itemsView.style.display = "none";
    if (title) title.innerText = "Коллекции";
    currentOpenCollectionId = null;

    let list = document.getElementById("collectionsList");
    let empty = document.getElementById("collectionsEmpty");
    if (!list) return;
    let cols = getCollections();
    if (!cols.length) {
        list.innerHTML = "";
        if (empty) empty.style.display = "flex";
        return;
    }
    if (empty) empty.style.display = "none";

    let cards = "";
    cols.forEach((c) => {
        let count = c.items ? c.items.length : 0;
        let cover = (c.items && c.items[0] && c.items[0].thumb) || "";
        let safeName = (c.name || "Без названия").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        let coverHtml = cover
            ? `<img class="search-img" data-src="${cover}">`
            : `<svg class="icon col-cover-ph"><use href="#icon-collection" xlink:href="#icon-collection"></use></svg>`;
        cards += `<div class="col-card2" onclick="openCollection('${c.id}')">
            <div class="col-card2-cover">${coverHtml}</div>
            <div class="col-card2-del" onclick="event.stopPropagation(); deleteCollection('${c.id}')"><svg class="icon-sm"><use href="#icon-trash" xlink:href="#icon-trash"></use></svg></div>
            <div class="col-card2-body">
                <div class="col-card2-name">${safeName}</div>
                <div class="col-card2-sub">${count} ${collectionsWordForm(count)}</div>
            </div>
        </div>`;
    });
    list.innerHTML = `<div class="col-grid">${cards}</div>`;
}

function openCollection(id) {
    let cols = getCollections();
    let col = cols.find((c) => c.id === id);
    if (!col) return;
    currentOpenCollectionId = id;

    let listView = document.getElementById("collectionsListView");
    let itemsView = document.getElementById("collectionItemsView");
    let title = document.getElementById("collectionsTitle");
    if (listView) listView.style.display = "none";
    if (itemsView) itemsView.style.display = "block";
    if (title) title.innerText = col.name || "Коллекция";

    let grid = document.getElementById("collectionItemsGrid");
    let empty = document.getElementById("collectionItemsEmpty");
    if (!grid) return;
    grid.innerHTML = "";
    let items = col.items || [];
    if (!items.length) {
        if (empty) empty.style.display = "flex";
        return;
    }
    if (empty) empty.style.display = "none";
    items.forEach((item) => {
        let div = document.createElement("div");
        div.className = "search-item";
        div.onclick = () => openDetails(item.id);
        div.innerHTML = buildItemHtml(item);
        grid.appendChild(div);
    });
    window.scrollTo(0, 0);
}

// Кнопка «назад» на странице коллекций: из работ — к списку, иначе — обычный goBack
function collectionsBack() {
    let itemsView = document.getElementById("collectionItemsView");
    if (itemsView && itemsView.style.display !== "none") {
        renderCollectionsPage();
        return;
    }
    goBack();
}

function deleteCollection(id) {
    let cols = getCollections();
    let col = cols.find((c) => c.id === id);
    if (!col) return;
    showConfirmModal("Удалить коллекцию?", "Коллекция «" + (col.name || "") + "» будет удалена. Работы не удаляются из Pixiv.", () => {
        let next = getCollections().filter((c) => c.id !== id);
        saveCollections(next);
        renderCollectionsPage();
        updateCollectionIcon();
        showToast("Коллекция удалена");
    });
}

window.renderCollectionsPage = renderCollectionsPage;
window.openCollection = openCollection;
window.collectionsBack = collectionsBack;
window.deleteCollection = deleteCollection;

// Заход в раздел «Коллекции» из меню — всегда открываем со списка
function openCollectionsTab() {
    switchTab("collections");
    renderCollectionsPage();
}
window.openCollectionsTab = openCollectionsTab;

function renderHistory() {
    let grid = document.getElementById("historyGrid");
    let empty = document.getElementById("historyEmpty");
    if (!grid) return;
    let hist = getViewHistory();
    grid.innerHTML = "";
    if (hist.length === 0) {
        if (empty) empty.style.display = "flex";
        return;
    }
    if (empty) empty.style.display = "none";
    hist.forEach((item) => {
        let div = document.createElement("div");
        div.className = "search-item";
        div.onclick = () => openDetails(item.id);
        div.innerHTML = buildItemHtml(item);
        grid.appendChild(div);
    });
}
function clearHistory() {
    if (getViewHistory().length === 0) return;
    showConfirmModal("Очистить историю", "Удалить всю историю просмотров? Это действие нельзя отменить.", () => {
        localStorage.setItem("pixivViewHistory", JSON.stringify([]));
        renderHistory();
    });
}

function showSearchSuggestions() {
    renderSearchHistory();
    document.getElementById("searchSuggestions").style.display = "block";
}

function hideSearchSuggestions() {
    setTimeout(() => {
        let el = document.getElementById("searchSuggestions");
        if (el) el.style.display = "none";
    }, 150);
}

function setTheme(themeName) {
    // Убираем старые классы и с html (document.documentElement), и с body
    document.documentElement.classList.remove("theme-light", "theme-oled");
    document.body.classList.remove("theme-light", "theme-oled");
    
    if (themeName !== "dark") {
        // Добавляем новые классы на оба фундаментальных слоя
        document.documentElement.classList.add("theme-" + themeName);
        document.body.classList.add("theme-" + themeName);
    }
    
    localStorage.setItem("pixivTheme", themeName);
    
    ["Dark", "Oled", "Light"].forEach((t) => {
        let btn = document.getElementById("btnTheme" + t);
        if (btn) btn.classList.remove("active");
    });
    
    let activeBtnName = "btnTheme" + themeName.charAt(0).toUpperCase() + themeName.slice(1);
    let activeBtn = document.getElementById(activeBtnName);
    if (activeBtn) activeBtn.classList.add("active");
}

function initTheme() {
    let savedTheme = localStorage.getItem("pixivTheme") || "dark";
    setTimeout(() => {
        setTheme(savedTheme);
    }, 100);
}

function openSearchFilterModal() {
    let overlay = document.getElementById("searchFilterOverlay");
    let modal = document.getElementById("searchFilterModal");
    if (overlay && modal) {
        overlay.classList.add("open");
        modal.classList.add("open");
    }
}

function closeSearchFilterModal() {
    let overlay = document.getElementById("searchFilterOverlay");
    let modal = document.getElementById("searchFilterModal");
    if (overlay && modal) {
        overlay.classList.remove("open");
        modal.classList.remove("open");
    }
}

function thanosSnapElement(element, onComplete) {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);

    const canvas = document.createElement("canvas");
    const padding = 1000;
    canvas.width = rect.width + padding * 2;
    canvas.height = rect.height + padding * 2;
    canvas.style.position = "fixed";
    canvas.style.left = rect.left - padding + "px";
    canvas.style.top = rect.top - padding + "px";
    canvas.style.zIndex = "9999";
    canvas.style.pointerEvents = "none";
    document.body.appendChild(canvas);

    const ctx = canvas.getContext("2d");
    const particles = [];
    const textColor = style.color !== "rgba(0, 0, 0, 0)" ? style.color : "#FFFFFF";
    const accentColor = "#0096FA";
    for (let i = 0; i < 600; i++) {
        particles.push({
            x: Math.random() * rect.width,
            y: Math.random() * rect.height,
            color: Math.random() > 0.2 ? textColor : accentColor,
            vx: (Math.random() - 0.5) * 3,
            vy: (Math.random() - 1) * 1,
            size: Math.random() * 0.9 + 0.5,
            life: Math.random() * 25 + 25,
            maxLife: 50,
        });
    }

    element.style.transition = "none";
    element.style.opacity = "0";

    function animate() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        let active = false;

        for (let i = 0; i < particles.length; i++) {
            let p = particles[i];
            if (p.life > 0) {
                active = true;
                p.x += p.vx;
                p.y += p.vy;
                p.vy -= 0.01;
                p.vx *= 0.96;
                p.life--;

                ctx.fillStyle = p.color;
                ctx.globalAlpha = p.life / p.maxLife;
                ctx.beginPath();
                ctx.arc(p.x + padding, p.y + padding, p.size, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        if (active) {
            requestAnimationFrame(animate);
        } else {
            canvas.remove();
            if (onComplete) onComplete();
        }
    }
    requestAnimationFrame(animate);
}

const lazyObserver = new IntersectionObserver(
    (entries, observer) => {
        entries.forEach((entry) => {
            if (entry.isIntersecting) {
                let img = entry.target;
                let src = img.getAttribute("data-src");
                if (src) {
                    img.onload = () => img.classList.add("loaded");
                    img.src = src;
                    img.removeAttribute("data-src");
                }
                observer.unobserve(img);
            }
        });
    },
    {
        rootMargin: "300px 0px",
    }
);

const domObserver = new MutationObserver(() => {
    document.querySelectorAll(".search-img[data-src]").forEach((img) => {
        lazyObserver.observe(img);
    });
});
domObserver.observe(document.body, { childList: true, subtree: true });

function spawnFlyingArt(imgSrc) {
    let container = document.getElementById("scFlyingContainer");
    if (!container) return;
    let img = document.createElement("img");
    img.src = imgSrc;
    img.className = "flying-art";
    let size = 120 + Math.random() * 150;
    let startX = -50 + Math.random() * 100;
    let endX = startX + (-30 + Math.random() * 60);
    let startRot = -20 + Math.random() * 40;
    let endRot = startRot + (-30 + Math.random() * 60);
    let duration = 6 + Math.random() * 6;
    let maxOp = 0.15 + Math.random() * 0.25;
    img.style.width = `${size}px`;
    img.style.height = `${size}px`;
    img.style.left = `${10 + Math.random() * 80}%`;
    img.style.setProperty("--start-x", `${startX}vw`);
    img.style.setProperty("--end-x", `${endX}vw`);
    img.style.setProperty("--start-rot", `${startRot}deg`);
    img.style.setProperty("--end-rot", `${endRot}deg`);
    img.style.setProperty("--scale", Math.random() > 0.5 ? "1" : "0.8");
    img.style.setProperty("--duration", `${duration}s`);
    img.style.setProperty("--max-opacity", maxOp);
    container.appendChild(img);
    setTimeout(() => {
        if (img.parentNode) img.parentNode.removeChild(img);
    }, duration * 1000);
}

const GITHUB_REPO_URL = "https://files.nothalk.fun/PixivDL/";
const CURRENT_WEB_VERSION = 1; // Стартовая версия HotFix-ов
let updateFilesQueue = [];
let updateFilesDownloaded = 0;
let isManualUpdateCheck = false;

// ===== БЕЙДЖИ ВЕРИФИЦИРОВАННЫХ ПОЛЬЗОВАТЕЛЕЙ =====
// На сервере лежит badges.json вида:
//   { "12345": "verified", "67890": "dev" }
// где ключ — ID пользователя Pixiv, значение — тип бейджа (см. BADGE_SVGS).
let verifiedBadges = {};
try {
    let cached = localStorage.getItem("pixivBadges");
    if (cached) verifiedBadges = JSON.parse(cached);
} catch (e) {}

// SVG-иконки бейджей по типам. Цвет берётся из --pixiv-blue / акцентов.
const BADGE_SVGS = {
    verified: '<svg viewBox="0 0 24 24" width="16" height="16" style="vertical-align: -3px; margin-left: 5px;"><path fill="#0096FA" d="M12 1l2.4 2.4 3.3-.6.6 3.3L21 9.6 19.2 12 21 14.4l-2.7 1.5-.6 3.3-3.3-.6L12 21l-2.4-2.4-3.3.6-.6-3.3L3 14.4 4.8 12 3 9.6l2.7-1.5.6-3.3 3.3.6z"/><path fill="#fff" d="M10.6 14.6l-2.2-2.2 1.1-1.1 1.1 1.1 3-3 1.1 1.1z"/></svg>',
    dev: '<svg viewBox="0 0 24 24" width="16" height="16" style="vertical-align: -3px; margin-left: 5px;"><circle cx="12" cy="12" r="11" fill="#0096FA"/><path fill="#fff" d="M9 6.2h4.1c2.4 0 4 1.5 4 3.9 0 2.4-1.6 3.9-4 3.9h-1.9v3.8H9V6.2zm3.9 5.7c1 0 1.6-.6 1.6-1.8 0-1.2-.6-1.8-1.6-1.8h-1.7v3.6h1.7z"/></svg>',
    premium: '<svg viewBox="0 0 24 24" width="16" height="16" style="vertical-align: -3px; margin-left: 5px;"><path fill="#FFB300" d="M12 1l2.4 2.4 3.3-.6.6 3.3L21 9.6 19.2 12 21 14.4l-2.7 1.5-.6 3.3-3.3-.6L12 21l-2.4-2.4-3.3.6-.6-3.3L3 14.4 4.8 12 3 9.6l2.7-1.5.6-3.3 3.3.6z"/><path fill="#fff" d="M10.6 14.6l-2.2-2.2 1.1-1.1 1.1 1.1 3-3 1.1 1.1z"/></svg>'
};

// Возвращает HTML-разметку бейджа для данного ID (или пустую строку)
function getBadgeHtml(userId) {
    if (!userId) return "";
    let type = verifiedBadges[String(userId)];
    if (!type) return "";
    return BADGE_SVGS[type] || BADGE_SVGS.verified;
}

// Загружает список бейджей с сервера и кэширует
function loadVerifiedBadges() {
    fetch(GITHUB_REPO_URL + "badges.json?t=" + Date.now())
        .then((r) => r.ok ? r.json() : null)
        .then((data) => {
            if (data && typeof data === "object") {
                verifiedBadges = data;
                localStorage.setItem("pixivBadges", JSON.stringify(data));
            }
        })
        .catch((e) => { /* офлайн — используем кэш */ });
}


function checkForAppUpdates() {
    isManualUpdateCheck = false;
    let updateUrl = GITHUB_REPO_URL + "update.json?t=" + Date.now();
    if (typeof Android !== "undefined" && typeof Android.checkUpdateJson === "function") {
        Android.checkUpdateJson(updateUrl);
    }
}

// Открывает системный экран «Открывать по умолчанию», где нужно один раз
// разрешить открытие ссылок pixiv.net в приложении (на Android 12+ для чужого
// домена это делается только вручную, а на HyperOS пункт спрятан).
function openLinkDefaultsSettings() {
    if (typeof Android !== "undefined" && typeof Android.openLinkDefaultsSettings === "function") {
        Android.openLinkDefaultsSettings();
        showToast("Включите «Открывать поддерживаемые ссылки» и отметьте pixiv.net");
    } else {
        showToast("Недоступно в этой версии");
    }
}
window.openLinkDefaultsSettings = openLinkDefaultsSettings;

function manualUpdateCheck() {
    isManualUpdateCheck = true;
    showToast("Поиск обновлений...");
    let updateUrl = GITHUB_REPO_URL + "update.json?t=" + Date.now();
    if (typeof Android !== "undefined" && typeof Android.checkUpdateJson === "function") {
        Android.checkUpdateJson(updateUrl);
    } else {
        showToast("Ошибка: Метод OTA недоступен");
    }
}

function processUpdateJson(b64Json) {
    try {
        let jsonStr = decodeURIComponent(escape(atob(b64Json)));
        let data = JSON.parse(jsonStr); // Читаем версии с сервера
        let serverNativeVersion = parseInt(data.native_version);
        let serverWebVersion = parseInt(data.web_version); // Читаем локальные версии
        let localNativeVersion = Android.getNativeVersion();
        let localWebVersion = parseInt(localStorage.getItem("ota_web_version")) || CURRENT_WEB_VERSION;
        if (serverNativeVersion > localNativeVersion) {
            let changelogText = Array.isArray(data.changelog) ? data.changelog.join("\n") : data.changelog || "Глобальное обновление системы.";
            // Ждём скрытия загрузчика, чтобы окно не оказалось под ним (z-index: 9999)
            setTimeout(() => {
                showApkUpdateModal("Требуется обновление приложения!", changelogText, data.apk_url);
            }, 900);
            return;
        }
        if (serverWebVersion > localWebVersion) {
            showToast(`Загрузка патча (v${serverWebVersion})...`);
            updateFilesQueue = data.files;
            updateFilesDownloaded = 0;
            localStorage.setItem("pending_ota_version", serverWebVersion);
            if (data.changelog) {
                let changelogText = Array.isArray(data.changelog) ? data.changelog.join("\n") : data.changelog;
                localStorage.setItem("pending_changelog", changelogText);
            }
            if (data.banner_image) {
                localStorage.setItem("pending_banner", data.banner_image);
            } else {
                localStorage.removeItem("pending_banner");
            } // === СОХРАНЯЕМ ИМЯ ЗВУКА ===

            if (data.sound_file) {
                localStorage.setItem("pending_sound", data.sound_file);
            } else {
                localStorage.removeItem("pending_sound");
            } // === НОВОЕ: СОХРАНЯЕМ ВИДЕО ===
            if (data.video_file) {
                localStorage.setItem("pending_video", data.video_file);
            } else {
                localStorage.removeItem("pending_video");
            }
            data.files.forEach((fileName) => {
                let fileUrl = GITHUB_REPO_URL + fileName + "?t=" + Date.now();
                Android.downloadAppUpdateFile(fileName, fileUrl);
            });
        } else {
            // Версии совпадают (ручная проверка)
            if (isManualUpdateCheck) {
                let changelogText = Array.isArray(data.changelog) ? data.changelog.join("\n") : data.changelog || "Изменений нет"; // Передаем звук при ручной проверке // ...
                showChangelogModal(`Актуальная версия`, changelogText, data.banner_image, data.sound_file, data.video_file);
            }
        }
    } catch (e) {
        if (isManualUpdateCheck) showToast("OTA: Ошибка чтения JSON");
        console.error("OTA Error:", e);
    } finally {
        isManualUpdateCheck = false;
    }
}

// Новое окно специально для обновления APK
// Окно обновления APK — в стиле хот-фикса
function showApkUpdateModal(title, text, apkUrl) {
    if (!document.getElementById("apkUpdateModal")) {
        let html = `
            <div class="modal-overlay open" id="apkUpdateOverlay"></div>
            <div class="custom-modal open" id="apkUpdateModal" style="width: 320px; max-width: 90vw; padding: 28px 24px 22px; border-radius: 18px; background: var(--surface); text-align: center;">
                <div style="width: 56px; height: 56px; border-radius: 50%; background: rgba(0,150,250,0.1); display: flex; align-items: center; justify-content: center; margin: 6px auto 16px;">
                    <svg viewBox="0 0 24 24" width="28" height="28" stroke="var(--pixiv-blue)" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
                    </svg>
                </div>
                <h3 id="apkUpdateTitle" style="margin: 0 0 5px; font-size: 20px; color: var(--text); font-weight: 800; letter-spacing: -0.3px;">Доступно обновление</h3>
                <div style="display: inline-block; background: rgba(0,150,250,0.12); color: var(--pixiv-blue); font-size: 11px; font-weight: bold; padding: 3px 10px; border-radius: 12px; margin-bottom: 16px; letter-spacing: 0.5px; text-transform: uppercase;">Update</div>

                <div id="apkUpdateToggleBtn" style="color: var(--pixiv-blue); font-size: 14px; font-weight: bold; margin-bottom: 16px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px; user-select: none;"
                     onclick="
                        let w = document.getElementById('apkUpdateTextWrapper');
                        let icon = document.getElementById('apkUpdateToggleIcon');
                        let textSpan = document.getElementById('apkUpdateToggleText');
                        if(w.style.maxHeight === '0px' || !w.style.maxHeight){
                            w.style.maxHeight = '250px';
                            textSpan.innerText = 'Скрыть список';
                            icon.style.transform = 'rotate(180deg)';
                        } else {
                            w.style.maxHeight = '0px';
                            textSpan.innerText = 'Что нового';
                            icon.style.transform = 'rotate(0deg)';
                        }
                     ">
                    <span id="apkUpdateToggleText">Что нового</span>
                    <svg id="apkUpdateToggleIcon" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round" style="transition: transform 0.3s ease;">
                        <polyline points="6 9 12 15 18 9"></polyline>
                    </svg>
                </div>

                <div id="apkUpdateTextWrapper" style="max-height: 0px; overflow-y: auto; transition: max-height 0.3s ease-in-out; scrollbar-width: none;">
                    <div id="apkUpdateText" style="font-size: 13px; color: var(--subtext); line-height: 1.5; margin-bottom: 16px; text-align: left; background: var(--bg); padding: 12px; border-radius: 8px; border: 1px solid var(--border);"></div>
                </div>

                <button id="apkDownloadBtn" class="btn-main" style="width: 100%; padding: 14px; font-size: 15px; border-radius: 12px; font-weight: bold; margin-top: 0;">Обновить сейчас</button>
                <div style="margin-top: 12px; font-size: 12px; color: var(--subtext); cursor: pointer;" onclick="document.getElementById('apkUpdateOverlay').classList.remove('open'); document.getElementById('apkUpdateModal').classList.remove('open');">Позже</div>
            </div>
        `;
        document.body.insertAdjacentHTML("beforeend", html);
    } else {
        document.getElementById("apkUpdateOverlay").classList.add("open");
        document.getElementById("apkUpdateModal").classList.add("open");
    }
    document.getElementById("apkUpdateTitle").innerText = title;
    document.getElementById("apkUpdateText").innerHTML = text.replace(/\n/g, "<br>");
    // Сбрасываем выдвижной блок в свёрнутое состояние при каждом открытии
    document.getElementById("apkUpdateTextWrapper").style.maxHeight = "0px";
    document.getElementById("apkUpdateToggleText").innerText = "Что нового";
    document.getElementById("apkUpdateToggleIcon").style.transform = "rotate(0deg)";
    document.getElementById("apkDownloadBtn").onclick = () => {
        Android.downloadAndInstallApk(apkUrl);
    };
}


function updateFileDownloaded(fileName) {
    updateFilesDownloaded++;
    if (updateFilesDownloaded >= updateFilesQueue.length) {
        localStorage.setItem("ota_web_version", localStorage.getItem("pending_ota_version"));
        // Обновляем зеркало веб-версии, чтобы фон не присылал повторное уведомление о хотфиксе
        if (typeof Android !== "undefined" && typeof Android.setLocalWebVersion === "function") {
            Android.setLocalWebVersion(parseInt(localStorage.getItem("ota_web_version")) || CURRENT_WEB_VERSION);
        }
        showToast("Обновление установлено! Перезапуск...");
        setTimeout(() => {
            let baseUrl = window.location.href.split("?")[0];
            window.location.replace(baseUrl + "?updated=" + Date.now());
        }, 1000);
    }
}

function updateFileFailed(fileName) {
    showToast("Ошибка загрузки: " + fileName);
}

function showChangelogModal(title, text, bannerFileName = null, soundFileName = null, videoFileName = null) {
    if (!document.getElementById('changelogModal')) {
        let html = `
            <div class="modal-overlay" id="changelogOverlay" onclick="closeChangelogModal()"></div>
            <div class="custom-modal" id="changelogModal" style="width: 320px; max-width: 90vw; padding: 0; border-radius: 8px; overflow: hidden; background: var(--surface);">

                <div id="changelogBannerWrapper" style="position: relative; width: 100%; height: 160px; display: none; background: #000;">
                    
                    <video id="changelogBannerVideo" playsinline loop poster="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" style="width: 100%; height: 100%; object-fit: cover; object-position: center; display: none;"></video>
                    <img id="changelogBannerImg" style="width: 100%; height: 100%; object-fit: cover; object-position: center; display: none;">
                    
                    <div style="position: absolute; left: 0; bottom: -2px; width: 100%; height: 52px; background: linear-gradient(0deg, var(--surface) 0%, var(--surface) 5%, rgba(0,0,0,0) 100%);"></div>
                </div>

                <div style="padding: 20px;">
                    <h3 id="changelogTitle" style="margin-top:0; margin-bottom: 12px; font-size: 18px; color: var(--text); font-weight: bold; text-align: center;"></h3>

                    <div id="changelogToggleBtn" style="color: var(--pixiv-blue); font-size: 14px; font-weight: bold; margin-bottom: 16px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px; user-select: none;" 
                         onclick="
                            let w = document.getElementById('changelogTextWrapper'); 
                            let icon = document.getElementById('changelogToggleIcon');
                            let textSpan = document.getElementById('changelogToggleText');
                            if(w.style.maxHeight === '0px' || !w.style.maxHeight){ 
                                w.style.maxHeight = '250px'; 
                                textSpan.innerText = 'Скрыть список'; 
                                icon.style.transform = 'rotate(180deg)'; 
                            } else { 
                                w.style.maxHeight = '0px'; 
                                textSpan.innerText = 'Что нового'; 
                                icon.style.transform = 'rotate(0deg)'; 
                            }
                         ">
                        <span id="changelogToggleText">Что нового</span>
                        <svg id="changelogToggleIcon" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round" style="transition: transform 0.3s ease;">
                            <polyline points="6 9 12 15 18 9"></polyline>
                        </svg>
                    </div>

                    <div id="changelogTextWrapper" style="max-height: 0px; overflow-y: auto; transition: max-height 0.3s ease-in-out; scrollbar-width: none;">
                        <div id="changelogText" style="font-size: 13px; color: var(--subtext); line-height: 1.5; margin-bottom: 16px; text-align: left; background: var(--bg); padding: 12px; border-radius: 5px; border: 1px solid var(--border);"></div>
                    </div>

                    <button class="btn-main" style="margin-top: 0; padding: 12px; font-size: 15px; width: 100%; border-radius: 4px; font-weight: bold;" onclick="closeChangelogModal()">Круто!</button>
                </div>
            </div>
        `;
        document.body.insertAdjacentHTML('beforeend', html);
    }
    
    document.getElementById('changelogTitle').innerText = title;
    document.getElementById('changelogText').innerHTML = text.replace(/\n/g, '<br>');
    
    document.getElementById('changelogTextWrapper').style.maxHeight = '0px';
    document.getElementById('changelogToggleText').innerText = 'Что нового';
    document.getElementById('changelogToggleIcon').style.transform = 'rotate(0deg)';

    const serverUrl = typeof GITHUB_REPO_URL !== 'undefined' ? GITHUB_REPO_URL : 'https://files.nothalk.fun/PixivDL/';

    let bannerWrapper = document.getElementById('changelogBannerWrapper');
    let bannerImg = document.getElementById('changelogBannerImg');
    let bannerVideo = document.getElementById('changelogBannerVideo');

    // Сбрасываем прошлые состояния
    bannerImg.style.display = 'none';
    bannerVideo.style.display = 'none';
    bannerVideo.pause();

    if (videoFileName) {
        // === ЕСЛИ ЕСТЬ ВИДЕО ===
        bannerVideo.src = serverUrl + videoFileName + "?t=" + Date.now();
        
        // Умный постер: если указана и картинка, ставим её как обложку до старта видео
        if (bannerFileName) {
            bannerVideo.poster = serverUrl + bannerFileName + "?t=" + Date.now();
        } else {
            bannerVideo.poster = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
        }

        bannerVideo.style.display = 'block';
        bannerWrapper.style.display = 'block';
        
        bannerVideo.volume = 0.3; 
        bannerVideo.play().catch(e => console.log("Видео заблокировано:", e));
        
    } else if (bannerFileName) {
        // === ЕСЛИ ЕСТЬ ТОЛЬКО КАРТИНКА ===
        bannerImg.src = serverUrl + bannerFileName + "?t=" + Date.now();
        bannerImg.style.display = 'block';
        bannerWrapper.style.display = 'block';
        
        bannerImg.onerror = function() {
            bannerWrapper.style.display = 'none';
        };
        
        if (soundFileName && soundFileName !== "null" && soundFileName !== "") {
            try {
                window.changelogAudio = new Audio(serverUrl + soundFileName); 
                window.changelogAudio.volume = 0.2; 
                window.changelogAudio.play().catch(e => console.log("Звук заблокирован:", e));
            } catch(e) {}
        }
    } else {
        bannerWrapper.style.display = 'none';
    }
    
    document.getElementById('changelogOverlay').classList.add('open');
    document.getElementById('changelogModal').classList.add('open');
}

function closeChangelogModal() {
    let overlay = document.getElementById("changelogOverlay");
    let modal = document.getElementById("changelogModal");
    if (overlay) overlay.classList.remove("open");
    if (modal) modal.classList.remove("open"); // Выключаем отдельный звук

    if (window.changelogAudio) {
        window.changelogAudio.pause();
        window.changelogAudio.currentTime = 0;
    } // Выключаем видео
    let video = document.getElementById("changelogBannerVideo");
    if (video) {
        video.pause();
        video.currentTime = 0;
    }
}

function copyUserId() {
    let idText = document.getElementById("sidebarId").innerText;
    if (idText && idText !== "ID: ---") {
        let rawId = idText.replace("ID: ", "").trim(); // Создаем временный элемент для копирования текста
        let tempInput = document.createElement("input");
        tempInput.value = rawId;
        document.body.appendChild(tempInput);
        tempInput.select();
        document.execCommand("copy");
        document.body.removeChild(tempInput);
        showToast("ID скопирован: " + rawId);
        if (typeof Android !== "undefined" && typeof Android.hapticClick === "function") {
            Android.hapticClick();
        }
    }
}

// ==========================================
// ЛОГИКА ОФФЛАЙН ПОДБОРКИ (SMART CACHE)
// ==========================================
let scCurrentCount = 50;
let scCurrentQuality = "medium";

function setScCount(val) {
    document.querySelectorAll('#scCount_50, #scCount_100, #scCount_300, #scCountBtn_custom').forEach((el) => el.classList.remove("active"));
    if (val === "custom") {
        let inp = document.getElementById("scCount_custom");
        scCurrentCount = parseInt(inp.value) || 50;
        document.getElementById("scCountBtn_custom").classList.add("active");
    } else {
        scCurrentCount = val;
        let btn = document.getElementById("scCount_" + val);
        if (btn) btn.classList.add("active");
        document.getElementById("scCount_custom").style.display = "none";
        document.getElementById("scCount_custom").value = "";
    }
}

function toggleCustomScCount() {
    let inp = document.getElementById("scCount_custom");
    inp.style.display = "inline-block";
    inp.focus();
    setScCount("custom");
}

function setScQuality(val) {
    scCurrentQuality = val;
    document.querySelectorAll('[id^="scQuality_"]').forEach((el) => el.classList.remove("active"));
    let btn = document.getElementById("scQuality_" + val);
    if (btn) btn.classList.add("active");
}

function startSmartCacheUI() {
    if (scCurrentCount <= 0) {
        showToast("Введите количество");
        return;
    }
    document.getElementById("scSetupScreen").style.display = "none";
    document.getElementById("scActiveScreen").style.display = "block";
    document.getElementById("scProgressText").innerText = `0 / ${scCurrentCount}`;
    document.getElementById("scProgressBar").style.width = "0%";
    Android.startSmartCache(scCurrentCount, scCurrentQuality);
}

function stopSmartCacheUI() {
    document.getElementById("scSetupScreen").style.display = "flex";
    document.getElementById("scActiveScreen").style.display = "none";
    document.getElementById("scFlyingContainer").innerHTML = "";
    Android.stopSmartCache();
    showToast("Сбор остановлен");
}

function updateSmartCacheProgress(current, total, localUrl) {
    let pct = total > 0 ? Math.floor((current / total) * 100) : 0;
    document.getElementById("scProgressText").innerText = `${current} / ${total}`;
    document.getElementById("scProgressBar").style.width = `${pct}%`;
    if (localUrl && localUrl !== "null") {
        spawnFlyingArt(localUrl);
    }
    if (current >= total) {
        setTimeout(() => {
            stopSmartCacheUI();
            showToast("Подборка завершена!");
        }, 1500);
    }
}

// Возвращает true, если есть активная авторизация или хотя бы одна сохранённая сессия.
function pixivHasSession() {
    try {
        let el = document.getElementById("accId");
        let activeId = el ? el.innerText.replace("ID: ", "").trim() : "";
        if (activeId && activeId !== "---") return true;
    } catch (e) {}
    return !!window.__pixivHasSavedAccounts;
}

function displaySavedAccounts(b64) {
    let jsonStr = decodeB64Utf8(b64);
    let accounts = [];
    try {
        accounts = JSON.parse(jsonStr);
    } catch (e) {}

    // Запоминаем, есть ли сохранённые сессии (используется для показа окна "Что нового").
    window.__pixivHasSavedAccounts = Array.isArray(accounts) && accounts.length > 0;

    let listContainer = document.getElementById("savedAccountsList");
    let card = document.getElementById("savedAccountsCard");
    let title = document.getElementById("savedAccountsTitle");

    if (!listContainer || !card || !title) return;

    

    let activeId = document.getElementById("accId").innerText.replace("ID: ", "").trim();
    let html = "";

    accounts.forEach((acc) => {
        if (acc.id === activeId) return; // Скрываем текущий аккаунт из списка
        let avatar = acc.avatar || "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";
        
        // ВАЖНО: Заменили Android.switchAccount на нашу безопасную switchAccountSafe
        let safeName = (acc.name || "").replace(/'/g, "\\'").replace(/"/g, "&quot;");
        html += `
            <div class="control-item account-switch-item" onclick="switchAccountSafe('${acc.id}')">
                <div class="control-item-left account-switch-info">
                    <img src="${avatar}" class="account-switch-avatar radius-5">
                    <div class="account-switch-text">
                        <div class="font-bold account-switch-name">${acc.name}${getBadgeHtml(acc.id)}</div>
                        <div class="text-sub account-switch-id">ID: ${acc.id}</div>
                    </div>
                </div>
                <div class="action-icon danger" onclick="event.stopPropagation(); removeSavedSession('${acc.id}', '${safeName}');"><svg class="icon-sm"><use href="#icon-logout"></use></svg></div>
            </div>`;
    });

    listContainer.innerHTML = html;

    // Показываем блок, если ты авторизован ИЛИ есть сохраненные аккаунты
    if (activeId !== "---" || accounts.length > 0) {
        card.style.display = "block";
        title.style.display = "block";
    } else {
        card.style.display = "none";
        title.style.display = "none";
    }

    // Полноэкранное окно входа показываем, когда сессий нет вообще:
    // не авторизованы И нет ни одной сохранённой сессии.
    let loggedIn = document.getElementById("loggedInView") &&
                   document.getElementById("loggedInView").style.display === "block";
    setAuthGate(!loggedIn && accounts.length === 0);
}

// Управление полноэкранным окном входа (#authGate)
function setAuthGate(show) {
    let gate = document.getElementById("authGate");
    if (gate) gate.classList.toggle("visible", !!show);
    if (show) populateAuthGateBackup();
}
window.setAuthGate = setAuthGate;

// Если найдена резервная копия — показываем сохранённые в ней сессии (выбором).
// Если копии нет — ничего не добавляем (никакой кнопки восстановления).
function populateAuthGateBackup() {
    let box = document.getElementById("authGateBackup");
    if (!box) return;

    let b64 = "";
    try {
        if (window.Android && typeof Android.getBackupAccounts === "function") {
            b64 = Android.getBackupAccounts() || "";
        }
    } catch (e) {}

    if (!b64) { box.innerHTML = ""; return; }

    let accounts = [];
    try { accounts = JSON.parse(decodeB64Utf8(b64)); } catch (e) {}
    if (!accounts.length) { box.innerHTML = ""; return; }

    let html = "";
    accounts.forEach((a) => {
        let avatar = a.avatar || "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";
        let safeName = (a.name || "Гость").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        let safeId = (a.id || "").replace(/'/g, "");
        html += `<div class="auth-gate-acc" onclick="restoreBackupAndActivate('${safeId}')">
            <img src="${avatar}">
            <div class="auth-gate-acc-text">
                <div class="auth-gate-acc-name">${safeName}</div>
                <div class="auth-gate-acc-id">ID: ${a.id}</div>
            </div>
        </div>`;
    });
    html += `<div class="auth-gate-sep">или войти заново</div>`;
    box.innerHTML = html;
}

function restoreBackupAndActivate(id) {
    try {
        if (window.Android && typeof Android.restoreBackupAndActivate === "function") {
            showToast("Восстановление сессии...");
            Android.restoreBackupAndActivate(id);
        }
    } catch (e) {
        showToast("Ошибка восстановления");
    }
}
window.populateAuthGateBackup = populateAuthGateBackup;
window.restoreBackupAndActivate = restoreBackupAndActivate;

// === ЛОГИКА АККОРДЕОНОВ НАСТРОЕК ===
function toggleAccSettings(contentId, headerId) {
    let content = document.getElementById(contentId);
    let header = document.getElementById(headerId);
    if (!content || !header) return;
    
    // Закрываем все открытые аккордеоны (теперь ищем по новому классу control-accordion)
    document.querySelectorAll('.control-accordion').forEach(el => {
        if (el.id !== contentId) {
            el.style.maxHeight = null;
            // Находим нужную шапку, чтобы перевернуть у нее стрелочку
            let hId = el.id.replace('accTheme', 'itemTheme').replace('accDownloader', 'downloaderCard').replace('accBackup', 'itemBackup').replace('accTelegram', 'itemTelegram');
            let h = document.getElementById(hId);
            if(h) h.classList.remove('open');
        }
    });

    // Открываем или закрываем текущий
    if (content.style.maxHeight && content.style.maxHeight !== '0px') {
        content.style.maxHeight = null;
        header.classList.remove('open');
    } else {
        // Динамически вычисляем высоту + запас для загрузки картинок
        content.style.maxHeight = (content.scrollHeight + 150) + "px"; 
        header.classList.add('open');
    }
}

// Дублируем глобально, чтобы HTML 100% видел функцию
window.toggleAccSettings = toggleAccSettings;

// ============================================================
// ЭКСПЕРИМЕНТАЛЬНЫЕ: Telegram (привязка + список каналов)
// ============================================================
// Привязка бота по токену от @BotFather через Bot API. Нативная сторона делает
// HTTP-запросы к api.telegram.org; JS показывает нужный шаг и рисует ответы.

const TG_STEPS = ["Status", "Token", "Loading"];

// Показать один из шагов аккордеона Telegram (Status|Token|Loading).
function tgShowStep(step) {
    TG_STEPS.forEach((s) => {
        let el = document.getElementById("tgStep" + s);
        if (el) el.classList.toggle("active", s === step);
    });
    tgRefreshAccordionHeight();
}

// Пересчитать высоту открытого аккордеона Telegram (контент меняется динамически).
function tgRefreshAccordionHeight() {
    let acc = document.getElementById("accTelegram");
    let header = document.getElementById("itemTelegram");
    if (!acc || !header) return;
    if (header.classList.contains("open")) {
        // Снимаем фиксацию и измеряем заново на следующем кадре.
        requestAnimationFrame(() => { acc.style.maxHeight = (acc.scrollHeight + 200) + "px"; });
    }
}

function tgSetErr(stepId, msg) {
    let el = document.getElementById(stepId);
    if (el) el.textContent = msg || "";
    tgRefreshAccordionHeight();
}

function tgClearInputs() {
    let el = document.getElementById("tgTokenInput"); if (el) el.value = "";
    tgSetErr("tgTokenErr", "");
}

// Начать привязку: открыть экран ввода токена бота.
function tgStart() {
    if (typeof Android === "undefined" || !Android.tgSetToken) { showToast("Недоступно в этой версии"); return; }
    tgSetErr("tgTokenErr", "");
    tgShowStep("Token");
}

function tgCancel() {
    tgClearInputs();
    tgShowStep("Status");
}

function tgSubmitToken() {
    let v = (document.getElementById("tgTokenInput").value || "").trim();
    if (!/^\d{6,}:[A-Za-z0-9_\-]{30,}$/.test(v)) { tgSetErr("tgTokenErr", "Похоже, это не токен бота"); return; }
    tgSetErr("tgTokenErr", "");
    tgShowStep("Loading");
    try { Android.tgSetToken(v); } catch (e) { tgSetErr("tgTokenErr", "Ошибка отправки"); tgShowStep("Token"); }
}

// Обновить список каналов вручную.
function tgRefresh() {
    tgShowStep("Loading");
    try { if (Android && Android.tgListChannels) Android.tgListChannels(); } catch (e) { tgShowStep("Status"); }
}

// Добавить канал/группу вручную по @username или ID (надёжный путь без getUpdates).
function tgAddChat() {
    let input = document.getElementById("tgAddInput");
    let v = (input && input.value || "").trim();
    if (!v) { showToast("Введите @username или ID канала"); return; }
    if (input) input.value = "";
    tgShowStep("Loading");
    try { Android.tgAddChat(v); } catch (e) { tgShowStep("Status"); showToast("Ошибка добавления"); }
}

function tgLogout() {
    try { if (Android && Android.tgLogout) Android.tgLogout(); } catch (e) {}
    tgClearInputs();
    tgRenderLinked(null);
    tgShowStep("Status");
    let block = document.getElementById("tgChannelsBlock");
    if (block) block.style.display = "none";
}

// Обновить статус-чип и кнопки в шаге Status. linked = {username, name} | null
function tgRenderLinked(linked) {
    let chip = document.getElementById("tgStatusChip");
    let linkBtn = document.getElementById("tgLinkBtn");
    let unlinkBtn = document.getElementById("tgUnlinkBtn");
    let refreshBtn = document.getElementById("tgRefreshBtn");
    if (!chip) return;
    if (linked && (linked.username || linked.name)) {
        chip.textContent = linked.username ? "@" + linked.username : linked.name;
        chip.classList.add("ok");
        if (unlinkBtn) unlinkBtn.style.display = "inline-block";
        if (linkBtn) linkBtn.style.display = "none";
        if (refreshBtn) refreshBtn.style.display = "block";
    } else {
        chip.textContent = "Не привязан";
        chip.classList.remove("ok");
        if (unlinkBtn) unlinkBtn.style.display = "none";
        if (linkBtn) linkBtn.style.display = "inline-flex";
        if (refreshBtn) refreshBtn.style.display = "none";
    }
    tgRefreshAccordionHeight();
}

// ====== Колбэки из нативной стороны ======

// Состояние привязки.
// json: { step: 'status'|'token'|'loading'|'ready'|'error', username, name, error, linked }
window.tgOnState = function (json) {
    let st;
    try { st = (typeof json === "string") ? JSON.parse(json) : json; } catch (e) { return; }
    if (!st) return;

    switch (st.step) {
        case "token":
            // Просим ввести (или перепривязать) токен.
            tgShowStep(st.linked ? "Status" : "Token");
            if (!st.linked) tgRenderLinked(null);
            tgSetErr("tgTokenErr", st.error || "");
            break;
        case "toast":
            // Короткое уведомление, шаг не меняем.
            showToast(st.error || "");
            break;
        case "loading":
            tgShowStep("Loading");
            break;
        case "ready":
            tgShowStep("Status");
            tgRenderLinked({ username: st.username, name: st.name });
            try { if (Android && Android.tgListChannels) Android.tgListChannels(); } catch (e) {}
            break;
        case "error":
            tgShowStep("Status");
            showToast(st.error || "Ошибка Telegram");
            break;
        default: // status
            tgShowStep("Status");
            tgRenderLinked((st.username || st.name) ? { username: st.username, name: st.name } : null);
    }
};

// Список каналов, где у бота есть право отправки.
// b64 -> { channels: [{id,title,username,members,isChannel,canPost}] }
window.tgOnChannels = function (b64) {
    let data;
    try { data = JSON.parse(decodeB64Utf8(b64)); } catch (e) { tgShowStep("Status"); return; }
    let chans = (data && data.channels) || [];

    // Кэшируем для шторки "Поделиться" и обновляем её, если открыта.
    tgKnownChannels = chans;
    if (shareSheetOpen) renderShareSheet();

    let block = document.getElementById("tgChannelsBlock");
    let list = document.getElementById("tgChannelsList");
    if (!list || !block) return;
    // Список пришёл -> уходим с экрана загрузки (актуально для "Обновить список").
    tgShowStep("Status");
    list.innerHTML = "";
    block.style.display = "block";

    if (chans.length === 0) {
        list.innerHTML = '<div class="tg-empty">Пока нет видимых каналов и групп</div>';
        tgRefreshAccordionHeight();
        return;
    }

    chans.forEach((c) => {
        let item = document.createElement("div");
        item.className = "tg-chan-item" + (c.canPost === false ? " tg-chan-noperm" : "");
        let parts = [];
        if (c.username) parts.push("@" + c.username);
        parts.push(c.isChannel ? "канал" : "группа");
        if (typeof c.members === "number" && c.members > 0) {
            parts.push(c.members.toLocaleString("ru-RU") + (c.isChannel ? " подписчиков" : " участников"));
        }
        if (c.canPost === false) parts.push("нет права отправки");
        item.innerHTML =
            '<div class="tg-chan-avatar"><svg><use href="#icon-telegram"></use></svg></div>' +
            '<div class="tg-chan-meta">' +
            '  <div class="tg-chan-title"></div>' +
            '  <div class="tg-chan-sub"></div>' +
            "</div>";
        item.querySelector(".tg-chan-title").textContent = c.title || "Без названия";
        item.querySelector(".tg-chan-sub").textContent = parts.join(" · ");
        list.appendChild(item);
    });
    tgRefreshAccordionHeight();
};

// ============================================================
// ПОДЕЛИТЬСЯ: отправка изображений работы в чат через бота
// ============================================================
let tgKnownChannels = [];   // кэш каналов/групп бота (из tgOnChannels)
let shareSheetOpen = false;
let shareInProgress = false;
let shareTemplateData = null; // данные текущей работы для плейсхолдеров (ставится в displayIllustDetails)
let shareSelected = [];       // какие страницы выбраны для отправки (по индексам)

// Полоса миниатюр для выбора конкретных изображений из пачки.
function renderShareImages() {
    let block = document.getElementById("shareImagesBlock");
    let strip = document.getElementById("shareImagesStrip");
    if (!block || !strip) return;

    let thumbs = detailImagesData || [];
    let origs = detailOriginalImages || [];
    let n = Math.max(thumbs.length, origs.length);

    shareSelected = [];
    for (let i = 0; i < n; i++) shareSelected.push(true); // по умолчанию выбраны все

    // Для одиночной работы выбор не нужен.
    if (n <= 1) { block.style.display = "none"; return; }

    block.style.display = "block";
    strip.innerHTML = "";
    for (let i = 0; i < n; i++) {
        let src = thumbs[i] || origs[i] || "";
        let t = document.createElement("div");
        t.className = "share-thumb sel";
        t.innerHTML =
            '<img src="' + src + '">' +
            '<div class="share-thumb-num">' + (i + 1) + '</div>' +
            '<div class="share-thumb-check"><svg><use href="#icon-check"></use></svg></div>';
        t.onclick = ((idx) => () => toggleShareImage(idx))(i);
        strip.appendChild(t);
    }
    updateShareImagesCount();
}

function toggleShareImage(idx) {
    shareSelected[idx] = !shareSelected[idx];
    let strip = document.getElementById("shareImagesStrip");
    if (strip && strip.children[idx]) strip.children[idx].classList.toggle("sel", shareSelected[idx]);
    updateShareImagesCount();
}

function shareToggleAllImages() {
    let sel = shareSelected.filter(Boolean).length;
    let target = !(sel === shareSelected.length); // все выбраны -> снять все; иначе выбрать все
    for (let i = 0; i < shareSelected.length; i++) shareSelected[i] = target;
    let strip = document.getElementById("shareImagesStrip");
    if (strip) for (let i = 0; i < strip.children.length; i++) strip.children[i].classList.toggle("sel", shareSelected[i]);
    updateShareImagesCount();
}

function updateShareImagesCount() {
    let cnt = document.getElementById("shareImagesCount");
    let all = document.getElementById("shareImagesToggleAll");
    let sel = shareSelected.filter(Boolean).length;
    let total = shareSelected.length;
    if (cnt) cnt.textContent = "Выбрано " + sel + " из " + total;
    if (all) all.textContent = (sel === total) ? "Снять все" : "Выбрать все";
}

// ---- Шаблоны подписи (Telegram HTML) ----
// Хранение: localStorage "tg_tpl_<chatId>" для чата, "tg_tpl_default" — общий.
// Плейсхолдеры: {title} {url} {id} {author} {author_url} {tags} {pages} {date} {views} {bookmarks}
const TG_TPL_BUILTIN = "<b>{title}</b>\n{author}\n\n{tags}\n\n{url}";
const TG_TPL_PLACEHOLDERS = [
    "{title}", "{author}", "{author_url}", "{url}", "{id}",
    "{tags}", "{pages}", "{date}", "{views}", "{bookmarks}"
];

function tgGetDefaultTemplate() {
    let v = null;
    try { v = localStorage.getItem("tg_tpl_default"); } catch (e) {}
    return (v != null) ? v : TG_TPL_BUILTIN;
}

// Шаблон для конкретного чата: свой -> общий -> встроенный.
function tgGetTemplateFor(chatId) {
    if (chatId === "__default__") return tgGetDefaultTemplate();
    let v = null;
    try { v = localStorage.getItem("tg_tpl_" + chatId); } catch (e) {}
    return (v != null) ? v : tgGetDefaultTemplate();
}

function tgHasOwnTemplate(chatId) {
    if (chatId === "__default__") { try { return localStorage.getItem("tg_tpl_default") != null; } catch (e) { return false; } }
    try { return localStorage.getItem("tg_tpl_" + chatId) != null; } catch (e) { return false; }
}

function tgEscHtml(s) {
    return String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Подставить значения работы в шаблон. Значения экранируются, разметка шаблона остаётся.
function tgRenderTemplate(tpl, data) {
    if (!data) data = {};
    let tagsStr = (data.tags || []).map((t) => "#" + String(t).replace(/\s+/g, "_")).join(" ");
    let map = {
        title: tgEscHtml(data.title),
        author: tgEscHtml(data.author),
        author_url: tgEscHtml(data.author_url),
        url: tgEscHtml(data.url),
        id: tgEscHtml(data.id),
        tags: tgEscHtml(tagsStr),
        pages: tgEscHtml(data.pages),
        date: tgEscHtml(data.date),
        views: tgEscHtml(data.views),
        bookmarks: tgEscHtml(data.bookmarks)
    };
    return String(tpl || "").replace(/\{(\w+)\}/g, (m, k) => (k in map ? map[k] : m));
}

// Открыть шторку выбора чата.
function openShareSheet() {
    if (!currentIllustId || currentIllustId === "offline_cache") { showToast("Откройте работу"); return; }
    if (!detailOriginalImages || detailOriginalImages.length === 0) { showToast("Нет изображений для отправки"); return; }

    let ov = document.getElementById("shareSheetOverlay");
    let sheet = document.getElementById("shareSheet");
    if (!ov || !sheet) return;

    shareSheetOpen = true;
    shareShowProgress(false); // сброс после прошлой отправки
    renderShareImages();      // выбор конкретных изображений из пачки
    renderShareSheet();

    // Копируемая ссылка на работу внизу.
    let linkEl = document.getElementById("shareWorkLink");
    if (linkEl) {
        let url = "https://www.pixiv.net/artworks/" + currentIllustId;
        linkEl.textContent = url;
        linkEl.style.display = "block";
    }

    ov.classList.add("open");
    sheet.classList.add("open");

    // Обновляем список чатов с нативной стороны (вдруг бот привязали/добавили чат).
    try { if (typeof Android !== "undefined" && Android.tgListChannels) Android.tgListChannels(); } catch (e) {}
}

// Скопировать ссылку на работу в буфер обмена.
function copyShareWorkLink() {
    let url = "https://www.pixiv.net/artworks/" + currentIllustId;
    let done = false;
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(url);
            done = true;
        }
    } catch (e) {}
    if (!done) {
        try {
            let ta = document.createElement("textarea");
            ta.value = url;
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.select();
            document.execCommand("copy");
            document.body.removeChild(ta);
            done = true;
        } catch (e) {}
    }
    showToast(done ? "Ссылка скопирована" : url);
}

function closeShareSheet() {
    if (shareInProgress) return; // не закрываем во время отправки
    shareSheetOpen = false;
    let ov = document.getElementById("shareSheetOverlay");
    let sheet = document.getElementById("shareSheet");
    if (ov) ov.classList.remove("open");
    if (sheet) sheet.classList.remove("open");
}

// Отрисовать список чатов в шторке.
function renderShareSheet() {
    let list = document.getElementById("shareSheetList");
    let hint = document.getElementById("shareSheetHint");
    if (!list || !hint) return;

    // Только чаты, куда бот реально может писать.
    let sendable = (tgKnownChannels || []).filter((c) => c.canPost !== false);

    if (sendable.length === 0) {
        list.innerHTML = "";
        let linked = document.getElementById("tgStatusChip");
        let isLinked = linked && linked.classList.contains("ok");
        hint.style.display = "block";
        hint.innerHTML = isLinked
            ? "Нет чатов с правом отправки.<br>Добавьте бота админом в канал/группу (Аккаунт → Экспериментальные)."
            : "Сначала привяжите Telegram-бота:<br>Аккаунт → Экспериментальные → Telegram.";
        return;
    }

    hint.style.display = "none";
    list.innerHTML = "";
    sendable.forEach((c) => {
        let item = document.createElement("div");
        item.className = "share-chat-item";
        let parts = [];
        if (c.username) parts.push("@" + c.username);
        parts.push(c.isChannel ? "канал" : "группа");
        let avaInner = c.photo
            ? '<img src="' + c.photo + '" alt="">'
            : '<svg><use href="#icon-telegram"></use></svg>';
        item.innerHTML =
            '<div class="share-chat-ava">' + avaInner + '</div>' +
            '<div class="share-chat-meta">' +
            '  <div class="share-chat-title"></div>' +
            '  <div class="share-chat-sub"></div>' +
            "</div>" +
            '<div class="share-chat-gear"><svg><use href="#icon-settings"></use></svg></div>';
        item.querySelector(".share-chat-title").textContent = c.title || "Без названия";
        item.querySelector(".share-chat-sub").textContent = parts.join(" · ");
        // Шестерёнка — настройки шаблона для этого чата (не запускает отправку).
        item.querySelector(".share-chat-gear").onclick = (e) => {
            e.stopPropagation();
            openTemplateEditor(String(c.id), c.title || "Чат");
        };
        item.onclick = () => pickShareTarget(String(c.id), c.title || "");
        list.appendChild(item);
    });
}

// Переключить шторку между списком чатов и прогресс-баром.
function shareShowProgress(show) {
    let body = document.getElementById("shareSheetBody");
    let prog = document.getElementById("shareProgress");
    if (body) body.style.display = show ? "none" : "block";
    if (prog) prog.style.display = show ? "block" : "none";
}

// Обновить прогресс-бар (pct 0..100) и подпись.
function shareSetBar(pct, label) {
    let fill = document.getElementById("shareProgressFill");
    let lbl = document.getElementById("shareProgressLabel");
    if (fill) fill.style.width = Math.max(0, Math.min(100, pct)) + "%";
    if (lbl && label != null) lbl.textContent = label;
}

// Выбрать чат и отправить все оригиналы работы.
function pickShareTarget(chatId, chatTitle) {
    if (shareInProgress) return;
    if (typeof Android === "undefined" || !Android.tgShareImages) { showToast("Недоступно в этой версии"); return; }
    // Отправляем только выбранные страницы (по умолчанию выбраны все).
    let origs = detailOriginalImages || [];
    let urls = [];
    for (let i = 0; i < origs.length; i++) {
        if (origs[i] && origs[i].length > 0 && shareSelected[i] !== false) urls.push(origs[i]);
    }
    if (urls.length === 0) { showToast("Выберите хотя бы одно изображение"); return; }

    // Подпись из шаблона чата (Telegram HTML). Обрезаем до лимита подписи (1024).
    let caption = tgRenderTemplate(tgGetTemplateFor(chatId), shareTemplateData);
    if (caption.length > 1024) caption = caption.substring(0, 1024);
    let parseMode = caption.length > 0 ? "HTML" : "";

    shareInProgress = true;
    shareShowProgress(true);
    shareSetBar(0, "Загрузка…");
    try {
        Android.tgShareImages(chatId, JSON.stringify(urls), caption, parseMode);
    } catch (e) {
        shareInProgress = false;
        shareShowProgress(false);
        showToast("Ошибка отправки");
    }
}

// Прогресс отправки. phase: "download" (0..50%) | "send" (50..100%).
window.tgShareProgress = function (done, total, phase) {
    if (!total) return;
    if (phase === "download") {
        shareSetBar((done / total) * 50, "Загрузка " + done + " / " + total);
    } else {
        shareSetBar(50 + (done / total) * 50, "Отправка " + done + " / " + total);
    }
};

// Итог отправки.
window.tgShareDone = function (sent, total, err) {
    shareInProgress = false;
    if (err && err.length > 0) {
        shareShowProgress(false);
        showToast(err);
        return;
    }
    if (sent === total && sent > 0) {
        shareSetBar(100, "Готово");
        showToast("Отправлено ✓");
        setTimeout(closeShareSheet, 400);
    } else {
        shareShowProgress(false);
        showToast(sent === 0 ? "Не удалось отправить, проверьте сеть" : ("Отправлено " + sent + " из " + total));
    }
};

window.openShareSheet = openShareSheet;
window.closeShareSheet = closeShareSheet;
window.pickShareTarget = pickShareTarget;
window.shareToggleAllImages = shareToggleAllImages;
window.copyShareWorkLink = copyShareWorkLink;

// ============================================================
// РЕДАКТОР ШАБЛОНА ПОДПИСИ
// ============================================================
let tplEditChatId = "__default__"; // какой шаблон редактируем
let tplCameFromShareSheet = false; // открыт ли редактор из шторки выбора чата

function openTemplateEditor(chatId, chatTitle) {
    tplEditChatId = chatId || "__default__";
    let modal = document.getElementById("tplModal");
    let overlay = document.getElementById("tplOverlay");
    let head = document.getElementById("tplHeadTitle");
    let ta = document.getElementById("tplTextarea");
    if (!modal || !ta) return;

    if (head) {
        head.textContent = (chatId === "__default__")
            ? "Шаблон по умолчанию"
            : "Шаблон: " + (chatTitle || "чат");
    }

    // Текущий текст: свой шаблон чата, иначе как стартовый — общий/встроенный.
    ta.value = tgGetTemplateFor(tplEditChatId);

    renderTplChips();
    tplUpdatePreview();

    // Прячем шторку выбора чата, пока открыт редактор, чтобы не взаимодействовать
    // с ней (скролл, тапы) и чтобы Android Back закрывал именно редактор.
    let sheet = document.getElementById("shareSheet");
    let sheetOv = document.getElementById("shareSheetOverlay");
    tplCameFromShareSheet = !!(sheet && sheet.classList.contains("open"));
    if (sheet) sheet.classList.remove("open");
    if (sheetOv) sheetOv.classList.remove("open");

    if (overlay) overlay.classList.add("open");
    modal.classList.add("open");
    document.body.style.overflow = "hidden"; // блокируем скролл фона
}

function closeTemplateEditor() {
    let modal = document.getElementById("tplModal");
    let overlay = document.getElementById("tplOverlay");
    if (modal) modal.classList.remove("open");
    if (overlay) overlay.classList.remove("open");
    document.body.style.overflow = "";

    // Возвращаем шторку выбора чата, если редактор был открыт из неё.
    if (tplCameFromShareSheet) {
        let sheet = document.getElementById("shareSheet");
        let sheetOv = document.getElementById("shareSheetOverlay");
        if (sheet) sheet.classList.add("open");
        if (sheetOv) sheetOv.classList.add("open");
        renderShareSheet(); // на случай, если шаблоны менялись
    }
    tplCameFromShareSheet = false;
}

function saveTemplateEditor() {
    let ta = document.getElementById("tplTextarea");
    if (!ta) return;
    let val = ta.value;
    try {
        if (tplEditChatId === "__default__") localStorage.setItem("tg_tpl_default", val);
        else localStorage.setItem("tg_tpl_" + tplEditChatId, val);
    } catch (e) {}
    showToast("Шаблон сохранён");
    closeTemplateEditor();
}

// Сбросить: для чата — удалить свой (вернётся общий); для общего — вернуть встроенный.
function tplResetToDefault() {
    let ta = document.getElementById("tplTextarea");
    if (!ta) return;
    if (tplEditChatId === "__default__") {
        ta.value = TG_TPL_BUILTIN;
    } else {
        try { localStorage.removeItem("tg_tpl_" + tplEditChatId); } catch (e) {}
        ta.value = tgGetDefaultTemplate();
        showToast("Сброшено на шаблон по умолчанию");
    }
    tplUpdatePreview();
}

function renderTplChips() {
    let box = document.getElementById("tplChips");
    if (!box) return;
    box.innerHTML = "";
    TG_TPL_PLACEHOLDERS.forEach((p) => {
        let chip = document.createElement("div");
        chip.className = "tpl-chip";
        chip.textContent = p;
        chip.onclick = () => tplInsert(p);
        box.appendChild(chip);
    });
}

// Вставить текст в позицию курсора textarea.
function tplInsert(text) {
    let ta = document.getElementById("tplTextarea");
    if (!ta) return;
    let s = ta.selectionStart || 0, e = ta.selectionEnd || 0;
    ta.value = ta.value.substring(0, s) + text + ta.value.substring(e);
    let pos = s + text.length;
    ta.selectionStart = ta.selectionEnd = pos;
    ta.focus();
    tplUpdatePreview();
}

// Обернуть выделение тегом Telegram HTML.
function tplWrap(tag) {
    let ta = document.getElementById("tplTextarea");
    if (!ta) return;
    let s = ta.selectionStart || 0, e = ta.selectionEnd || 0;
    let sel = ta.value.substring(s, e) || "текст";
    let open = "<" + tag + ">", close = "</" + tag + ">";
    ta.value = ta.value.substring(0, s) + open + sel + close + ta.value.substring(e);
    ta.selectionStart = s + open.length;
    ta.selectionEnd = s + open.length + sel.length;
    ta.focus();
    tplUpdatePreview();
}

function tplInsertLink() {
    let ta = document.getElementById("tplTextarea");
    if (!ta) return;
    let s = ta.selectionStart || 0, e = ta.selectionEnd || 0;
    let sel = ta.value.substring(s, e) || "{title}";
    let snippet = '<a href="{url}">' + sel + "</a>";
    ta.value = ta.value.substring(0, s) + snippet + ta.value.substring(e);
    ta.selectionStart = ta.selectionEnd = s + snippet.length;
    ta.focus();
    tplUpdatePreview();
}

// Раскрывающаяся цитата Telegram: <blockquote expandable>…</blockquote>.
function tplQuoteExpandable() {
    let ta = document.getElementById("tplTextarea");
    if (!ta) return;
    let s = ta.selectionStart || 0, e = ta.selectionEnd || 0;
    let sel = ta.value.substring(s, e) || "текст";
    let open = "<blockquote expandable>", close = "</blockquote>";
    ta.value = ta.value.substring(0, s) + open + sel + close + ta.value.substring(e);
    ta.selectionStart = s + open.length;
    ta.selectionEnd = s + open.length + sel.length;
    ta.focus();
    tplUpdatePreview();
}

// Живой предпросмотр: рендер шаблона на данных текущей работы (или демо).
function tplUpdatePreview() {
    let ta = document.getElementById("tplTextarea");
    let prev = document.getElementById("tplPreview");
    if (!ta || !prev) return;
    let demo = shareTemplateData || {
        title: "Название работы", author: "Автор",
        author_url: "https://www.pixiv.net/users/0",
        url: "https://www.pixiv.net/artworks/0", id: "0",
        tags: ["пример", "тег"], pages: 1, date: "2026-01-01", views: 1000, bookmarks: 100
    };
    // tgRenderTemplate уже экранирует значения и оставляет HTML-разметку шаблона.
    prev.innerHTML = tgRenderTemplate(ta.value, demo);
}

window.openTemplateEditor = openTemplateEditor;
window.closeTemplateEditor = closeTemplateEditor;
window.saveTemplateEditor = saveTemplateEditor;
window.tplResetToDefault = tplResetToDefault;
window.tplWrap = tplWrap;
window.tplInsertLink = tplInsertLink;
window.tplQuoteExpandable = tplQuoteExpandable;
window.tplUpdatePreview = tplUpdatePreview;

// Глобальная видимость для onclick в HTML.
window.tgStart = tgStart;
window.tgCancel = tgCancel;
window.tgSubmitToken = tgSubmitToken;
window.tgRefresh = tgRefresh;
window.tgAddChat = tgAddChat;
window.tgLogout = tgLogout;

// ============================================================
// РЕЗЕРВНОЕ КОПИРОВАНИЕ / ВОССТАНОВЛЕНИЕ ДАННЫХ
// Сохраняет сессии, куки, историю поиска/просмотра и настройки
// во внешнюю память (вне приложения, переживает переустановку).
// ============================================================
function collectLocalStorageJson() {
    let o = {};
    try {
        for (let i = 0; i < localStorage.length; i++) {
            let k = localStorage.key(i);
            o[k] = localStorage.getItem(k);
        }
    } catch (e) { console.error("collectLocalStorage", e); }
    return JSON.stringify(o);
}

function setBackupStatus(msg) {
    let el = document.getElementById("backupStatus");
    if (el) el.textContent = msg;
}

// Статус с сообщением об ошибке из Android (base64, чтобы не ломать экранирование)
function setBackupStatusB64(b64) {
    try { setBackupStatus(decodeB64Utf8(b64)); } catch (e) { setBackupStatus("Ошибка сохранения"); }
}

function doBackup() {
    try {
        if (!window.Android || typeof Android.backupData !== "function") {
            setBackupStatus("Нет нативного метода — пересоберите APK");
            showToast("Обновите APK (нативная часть)");
            return;
        }
        setBackupStatus("Сохранение...");
        Android.backupData(collectLocalStorageJson());
    } catch (e) {
        console.error("doBackup", e);
        setBackupStatus("Ошибка: " + (e && e.message ? e.message : e));
        showToast("Ошибка сохранения");
    }
}

function doRestore() {
    try {
        if (!window.Android || typeof Android.restoreData !== "function") {
            showToast("Обновите APK (нативная часть)");
            return;
        }
        showToast("Восстановление...");
        Android.restoreData();
    } catch (e) {
        console.error("doRestore", e);
        showToast("Ошибка восстановления");
    }
}

// Вызывается из Android после восстановления prefs/куки.
// b64 — base64 JSON-объекта localStorage.
function applyRestoredLocalStorage(b64) {
    try {
        let obj = JSON.parse(decodeB64Utf8(b64));
        for (let k in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, k)) {
                localStorage.setItem(k, obj[k]);
            }
        }
    } catch (e) { console.error("applyRestoredLocalStorage", e); }
    // Перезагружаем интерфейс, чтобы in-memory состояние, сессия и куки подхватились корректно
    setTimeout(function () { location.reload(); }, 600);
}

window.doBackup = doBackup;
window.doRestore = doRestore;
window.setBackupStatus = setBackupStatus;
window.setBackupStatusB64 = setBackupStatusB64;
window.applyRestoredLocalStorage = applyRestoredLocalStorage;




// JS-кallback, который вызывает Android после успешной смены аккаунта


// ==========================================
// ЛОГИКА АНОНИМНЫХ ОПОВЕЩЕНИЙ
// ==========================================
let anonAlertTimeout = null;

function checkAnonAlert() {
    // Получаем JSON. Добавляем Date.now() чтобы обмануть кэш
    fetch('https://files.nothalk.fun/PixivDL/anon.json?t=' + Date.now())
        .then(res => res.json())
        .then(data => {
            // Если show равно 1, показываем плашку
            if (data && data.show === 1) {
                // Если параметр timer есть - берем его, если нет - ставим 5 секунд по умолчанию
                let duration = data.timer ? parseInt(data.timer) : 5;
                showAnonSnackbar(data.title, data.message, duration);
            }
        })
        .catch(err => console.log('Anon alert error:', err));
}

function showAnonSnackbar(title, message, durationSeconds) {
    let snackbar = document.getElementById('anonSnackbar');
    let timerFill = document.getElementById('anonSnackTimer');
    
    if (!snackbar || !timerFill) return;

    // Заполняем тексты в плашке и модальном окне
    document.getElementById('anonSnackTitle').innerText = title || 'Уведомление';
    document.getElementById('anonSnackDesc').innerText = message || '';
    document.getElementById('anonModalTitle').innerText = title || 'Уведомление';
    document.getElementById('anonModalBody').innerText = message || '';

    // 1. Сбрасываем полоску таймера (мгновенно на 100%)
    timerFill.style.transition = 'none';
    timerFill.style.transform = 'scaleX(1)';
    
    // Форсируем перерисовку, чтобы браузер понял сброс анимации
    void snackbar.offsetWidth;

    // 2. Выдвигаем плашку на экран
    snackbar.classList.add('show');
    
    // 3. Запускаем анимацию убывания полоски динамически
    timerFill.style.transition = `transform ${durationSeconds}s linear`;
    timerFill.style.transform = 'scaleX(0)';

    // 4. Ставим динамический таймер на скрытие плашки
    anonAlertTimeout = setTimeout(() => {
        snackbar.classList.remove('show');
    }, durationSeconds * 1000); // Умножаем на 1000, так как JS считает в миллисекундах
}

function openAnonModal() {
    let snackbar = document.getElementById('anonSnackbar');
    
    // Прячем плашку и убиваем таймер исчезновения
    if (snackbar) snackbar.classList.remove('show');
    if (anonAlertTimeout) clearTimeout(anonAlertTimeout);

    // Открываем большое модальное окно по центру
    let overlay = document.getElementById('anonModalOverlay');
    let modal = document.getElementById('anonModal');
    if (overlay && modal) {
        overlay.classList.add('show');
        modal.classList.add('show');
    }
}

function closeAnonModal() {
    // Просто скрываем оверлей и модалку
    let overlay = document.getElementById('anonModalOverlay');
    let modal = document.getElementById('anonModal');
    if (overlay && modal) {
        overlay.classList.remove('show');
        modal.classList.remove('show');
    }
}

// ==========================================
// ЛОГИКА ПОДПИСОК (FOLLOWING)
// ==========================================
let currentFollowingNextUrl = "";

function openFollowing() {
    tabScrollPositions['following'] = 0;
    toggleSidebar();
    switchTab('following');
    
    let grid = document.getElementById('followingGrid');
    if (grid) grid.innerHTML = "";
    
    let btn = document.getElementById('loadMoreFollowingBtn');
    if (btn) btn.style.display = 'none';

    currentFollowingNextUrl = "";
    // Вызываем Java-метод (он у тебя уже отлично написан)
    Android.getFollowing("");
}

function loadMoreFollowing() {
    if (currentFollowingNextUrl) {
        Android.getFollowing(currentFollowingNextUrl);
    }
}

function displayFollowing(b64) {
    let grid = document.getElementById('followingGrid');
    let btn = document.getElementById('loadMoreFollowingBtn');
    if (!grid) return;

    try {
        let data = JSON.parse(decodeB64Utf8(b64));
        currentFollowingNextUrl = data.next_url;

        data.results.forEach(user => {
            let div = document.createElement('div');
            // Базовые стили карточки автора
            div.style.background = 'var(--surface)';
            div.style.border = '1px solid var(--border)';
            div.style.borderRadius = '5px';
            div.style.padding = '12px';
            div.style.marginBottom = '12px';
            div.style.cursor = 'pointer';
            div.style.width = '100%';
            div.style.boxSizing = 'border-box';
            div.style.overflow = 'hidden';
            
            // Клик по всей карточке открывает профиль автора
            div.onclick = () => openAuthor(user.id, user.name, user.avatar);

            let avatar = user.avatar || 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';

            // === УМНАЯ ЗАГРУЗКА ПРЕВЬЮШЕК С БЕЙДЖИКАМИ И КНОПКАМИ ===
            let illustsHtml = '';
            if (user.illusts && user.illusts.length > 0) {
                illustsHtml = '<div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; margin-top: 12px; width: 100%;">';
                user.illusts.slice(0, 3).forEach(ill => {
                    // Используем класс search-item и функцию buildItemHtml
                    // event.stopPropagation() не дает клику провалиться до профиля автора
                    illustsHtml += `
                        <div class="search-item" style="border-radius: 5px !important; margin: 0; width: 100%; height: auto;" 
                             onclick="event.stopPropagation(); openDetails('${ill.id}')">
                            ${buildItemHtml(ill)}
                        </div>
                    `;
                });
                illustsHtml += '</div>';
            }

            // === УМНАЯ ЗАГРУЗКА АВАТАРОК ===
            div.innerHTML = `
                <div style="display: flex; align-items: center; gap: 12px; width: 100%;">
                    <div style="width: 40px; height: 40px; border-radius: 5px; overflow: hidden; border: 1px solid var(--border); background: var(--bg); flex-shrink: 0;">
                        <img class="search-img" data-src="${avatar}" style="width: 100%; height: 100%; object-fit: cover; display: block;">
                    </div>
                    
                    <div style="flex: 1; min-width: 0;">
                        <div class="font-bold" style="color: var(--text); font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${user.name.replace(/'/g, "\\'").replace(/"/g, '&quot;')}</div>
                        <div class="text-sub" style="font-size: 12px; margin-top: 2px;">ID: ${user.id}</div>
                    </div>
                    
                    <div class="btn-outline" style="padding: 6px 12px; font-size: 12px; border-radius: 5px; flex-shrink: 0;">Профиль</div>
                </div>
                ${illustsHtml}
            `;
            grid.appendChild(div);
        });

        if (btn) btn.style.display = currentFollowingNextUrl ? 'block' : 'none';

    } catch (e) {
        showToast("Ошибка загрузки подписок");
        if (btn) btn.style.display = 'none';
    }
}

// ==========================================
// ЛОГИКА ПЕРЕКЛЮЧЕНИЯ НАВИГАЦИИ (ВЕРХ/НИЗ + V2)
// ==========================================
window.toggleBottomNavigation = function() {
    let isBottom = document.body.classList.toggle('nav-bottom');
    localStorage.setItem('pixivNavBottom', isBottom ? '1' : '0');
    
    window.updateNavToggleUI();
    trackTabSlider(360);
    if (typeof Android !== "undefined" && typeof Android.hapticClick === "function") Android.hapticClick();
};

window.toggleV2Navigation = function() {
    let isV2 = document.body.classList.toggle('nav-floating');
    localStorage.setItem('pixivNavV2', isV2 ? '1' : '0');

    window.updateNavToggleUI();
    trackTabSlider(360);
    if (typeof Android !== "undefined" && typeof Android.hapticClick === "function") Android.hapticClick();
};

window.updateNavToggleUI = function() {
    let toggleBtn = document.getElementById('navPosToggle');
    let v2Btn = document.getElementById('navV2Toggle');
    let v2Container = document.getElementById('navV2Setting');
    
    let isBottom = document.body.classList.contains('nav-bottom');
    let isV2 = document.body.classList.contains('nav-floating');
    
    if (toggleBtn) toggleBtn.classList.toggle('active', isBottom);
    
    // V2 настройка теперь всегда видна!
    if (v2Container) {
        v2Container.style.display = "flex";
        if (v2Btn) v2Btn.classList.toggle('active', isV2);
    }
};

// Применяем настройку при запуске приложения
setTimeout(() => {
    let isBottom = localStorage.getItem('pixivNavBottom') === '1';
    let isV2 = localStorage.getItem('pixivNavV2') === '1';
    
    if (isBottom) document.body.classList.add('nav-bottom');
    if (isV2) document.body.classList.add('nav-floating'); // Полностью независимо!

    window.updateNavToggleUI();
    trackTabSlider(360);
}, 500);

// ==========================================
// БЕЗОПАСНОЕ ПЕРЕКЛЮЧЕНИЕ АККАУНТОВ (ЧИСТЫЙ JS)
// ==========================================
let isSwitchingAccount = false;
let switchFailsafeTimer = null;

// Универсальная функция разблокировки
function unlockAccountSwitch() {
    if (!isSwitchingAccount) return;
    isSwitchingAccount = false;
    
    if (switchFailsafeTimer) clearTimeout(switchFailsafeTimer);
    
    let listContainer = document.getElementById("savedAccountsList");
    if (listContainer) {
        listContainer.classList.remove("disabled-section");
        // Принудительная перерисовка для мгновенного отклика
        listContainer.style.display = "none";
        void listContainer.offsetHeight;
        listContainer.style.display = "block";
    }
}

function switchAccountSafe(accId) {
    if (isSwitchingAccount) return;
    isSwitchingAccount = true;

    // 1. Делаем список прозрачным и некликабельным
    let listContainer = document.getElementById("savedAccountsList");
    if (listContainer) {
        listContainer.classList.add("disabled-section");
    }

    showToast("Подключение к серверам...");
    
    // 2. Микро-пауза для отрисовки, затем дергаем Java
    setTimeout(() => {
        if (typeof Android !== 'undefined') {
            Android.switchAccount(accId); 
        } else {
            showToast("Ошибка: Android API не найдено");
            unlockAccountSwitch();
        }
    }, 50);

    // 3. Фейлсейф: если Pixiv завис или отпал интернет, вернем UI через 15 секунд
    if (switchFailsafeTimer) clearTimeout(switchFailsafeTimer);
    switchFailsafeTimer = setTimeout(() => {
        unlockAccountSwitch();
        showToast("Превышено время ожидания ответа");
    }, 15000);
}

// Выход из сохранённой (неактивной) сессии — удаляет её из списка
function removeSavedSession(accId, accName) {
    showConfirmModal(
        "Выйти из аккаунта",
        "Удалить сохранённую сессию «" + (accName || accId) + "»? Для повторного входа потребуется авторизация.",
        function() {
            if (typeof Android !== "undefined" && typeof Android.removeSavedAccount === "function") {
                Android.removeSavedAccount(accId);
            } else {
                showToast("Ошибка: метод недоступен");
            }
        }
    );
}

// но ДО того, как придет ответ от сети. Поэтому мы ТУТ НЕ снимаем блокировку!
// JS-callback, который вызывает Android после успешной подмены куки

// Метод для полной и чистой перезагрузки интерфейса WebView
function reloadAppInterface() {
    let baseUrl = window.location.href.split("?")[0];
    window.location.replace(baseUrl + "?t=" + Date.now());
}

// JS-callback, который вызывает Android после успешной подмены куки
function finishAccountSwitch(newAccId) {
    // 1. Очищаем таймер-спасатель
    if (switchFailsafeTimer) clearTimeout(switchFailsafeTimer);

    // 2. Показываем статус юзеру (экран всё еще заблокирован серым фоном!)
    showToast("Аккаунт переключён • Перезапуск...");
    
    // 3. Ждем 800мс, чтобы юзер прочитал текст, и жестко перезагружаем страницу.
    // Никаких лишних Android.checkAccount() перед смертью страницы!
    setTimeout(() => {
        reloadAppInterface();
    }, 800);
}

let zoom = 1;
let lastZoom = 1;
let startX = 0, startY = 0; // Начальные координаты касания
let translateX = 0, translateY = 0; // Текущее смещение
let lastTranslateX = 0, lastTranslateY = 0; // Сохраненное смещение
let startDist = 0; // Расстояние между пальцами

function openImageViewer(url) {
    const viewer = document.getElementById('imageViewer');
    const img = document.getElementById('viewerImg');
    
    img.src = url;
    // Сброс всех параметров
    zoom = 1; lastZoom = 1;
    translateX = 0; translateY = 0;
    lastTranslateX = 0; lastTranslateY = 0;
    img.style.transform = `translate(0px, 0px) scale(1)`;
    
    viewer.style.display = 'flex';
    setTimeout(() => viewer.classList.add('open'), 10);
    navHistory.push("viewer");
}

function closeImageViewer() {
    const viewer = document.getElementById('imageViewer');
    viewer.classList.remove('open');
    setTimeout(() => {
        viewer.style.display = 'none';
        if (navHistory[navHistory.length-1] === "viewer") navHistory.pop();
    }, 200);
}


const setupZoom = () => {
    const vContent = document.querySelector('.viewer-content');
    const vImg = document.getElementById('viewerImg');

    vContent.addEventListener('touchstart', (e) => {
        if (e.touches.length === 1) {
            // Начало перетаскивания
            startX = e.touches[0].pageX - lastTranslateX;
            startY = e.touches[0].pageY - lastTranslateY;
        } else if (e.touches.length === 2) {
            // Начало зума
            startDist = Math.hypot(
                e.touches[0].pageX - e.touches[1].pageX,
                e.touches[0].pageY - e.touches[1].pageY
            );
        }
    }, {passive: false});

    vContent.addEventListener('touchmove', (e) => {
        e.preventDefault(); // Блокируем системный скролл

        if (e.touches.length === 1 && zoom > 1) {
            // Перемещение (работает только если картинка приближена)
            translateX = e.touches[0].pageX - startX;
            translateY = e.touches[0].pageY - startY;
            vImg.style.transform = `translate(${translateX}px, ${translateY}px) scale(${zoom})`;
        } else if (e.touches.length === 2) {
            // Масштабирование
            const dist = Math.hypot(
                e.touches[0].pageX - e.touches[1].pageX,
                e.touches[0].pageY - e.touches[1].pageY
            );
            zoom = Math.min(Math.max(1, lastZoom * (dist / startDist)), 5);
            
            // Если вернулись к масштабу 1, сбрасываем координаты
            if (zoom === 1) {
                translateX = 0; translateY = 0;
                lastTranslateX = 0; lastTranslateY = 0;
            }
            
            vImg.style.transform = `translate(${translateX}px, ${translateY}px) scale(${zoom})`;
        }
    }, {passive: false});

    vContent.addEventListener('touchend', (e) => {
        lastZoom = zoom;
        lastTranslateX = translateX;
        lastTranslateY = translateY;
    });
};

setTimeout(setupZoom, 1000);




// =========================================================
// BROWSE — Библиотека HentaiHeaven
// =========================================================

let browseCurrentPage = 1;
let browseLoading = false;
let browseHasMore = true;
let browseSearchQuery = "";

function stripHtml(html) {
    let tmp = document.createElement("div");
    tmp.innerHTML = html;
    return tmp.textContent || tmp.innerText || "";
}

function startBrowseSearch() {
    let input = document.getElementById("browseSearchInput");
    let query = input ? input.value.trim() : "";
    browseSearchQuery = query;
    document.getElementById("browseClearBtn").style.display = query ? "block" : "none";
    loadBrowse(true);
}

function clearBrowseSearch() {
    let input = document.getElementById("browseSearchInput");
    if (input) input.value = "";
    browseSearchQuery = "";
    document.getElementById("browseClearBtn").style.display = "none";
    loadBrowse(true);
}

function loadBrowse(reset) {
    if (browseLoading) return;
    if (reset) {
        browseCurrentPage = 1;
        browseHasMore = true;
        document.getElementById("browseGrid").innerHTML = "";
        document.getElementById("browseError").style.display = "none";
        document.getElementById("loadMoreBrowseBtn").style.display = "none";
    }
    if (!browseHasMore) return;

    browseLoading = true;
    document.getElementById("browseLoading").style.display = "block";
    document.getElementById("browseError").style.display = "none";

    Android.fetchBrowse(browseCurrentPage, browseSearchQuery);
}

function loadMoreBrowse() {
    loadBrowse(false);
}

// Called from Java after hidden WebView loads and parses the page
function onBrowseData(b64, totalPages) {
    browseLoading = false;
    document.getElementById("browseLoading").style.display = "none";
    try {
        let json = decodeURIComponent(escape(atob(b64)));
        let response = JSON.parse(json);
        let postsArray = response.posts ? response.posts : response;

        browseHasMore = postsArray.length >= 5;
        renderBrowsePosts(postsArray);
        browseCurrentPage++;
        document.getElementById("loadMoreBrowseBtn").style.display = browseHasMore ? "block" : "none";
    } catch(e) {
        onBrowseError("Parse error: " + e.message);
    }
}

function renderBrowsePosts(posts) {
    let grid = document.getElementById("browseGrid");

    if (!posts || !Array.isArray(posts) || posts.length === 0) {
        grid.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--subtext);">Ничего не найдено.</div>';
        return;
    }

    posts.forEach(function(post) {
        let title = post.title ? stripHtml(post.title) : "Без названия";
        let thumb = post.thumb || "";
        let postUrl = post.url || "";
        let rating = post.rating || 0;
        let episodes = post.totalEpisodes || 0;
        let year = post.released || 0;
        let genres = post.genres || [];

        let card = document.createElement("div");
        card.style.cssText = "display:flex; gap:0; background:var(--surface); border-radius:12px; margin-bottom:10px; overflow:hidden; cursor:pointer;";
        card.onclick = function() {
            openBrowseDetail(post.id);
        };

        let coverHtml = thumb
            ? '<img src="' + thumb + '" style="width:100px; min-width:100px; height:140px; object-fit:cover; background:var(--border);" loading="lazy" onerror="this.style.display=\'none\'; this.nextElementSibling.style.display=\'flex\';">' +
              '<div style="display:none; width:100px; min-width:100px; height:140px; background:var(--border); align-items:center; justify-content:center;"><svg style="width:24px;height:24px;color:var(--subtext);" viewBox="0 0 24 24"><path fill="currentColor" d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg></div>'
            : '<div style="width:100px; min-width:100px; height:140px; background:var(--border); display:flex; align-items:center; justify-content:center;"><svg style="width:24px;height:24px;color:var(--subtext);" viewBox="0 0 24 24"><path fill="currentColor" d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg></div>';

        // Meta line: rating + episodes + year
        let metaParts = [];
        if (rating > 0) metaParts.push('<span style="color:var(--pixiv-blue);">' + rating.toFixed(1) + '</span>');
        if (episodes > 0) metaParts.push(episodes + ' ep.');
        if (year > 0) metaParts.push(String(year));
        let metaHtml = metaParts.length > 0
            ? '<div style="font-size:12px; color:var(--subtext); margin-top:4px; display:flex; gap:8px; align-items:center;">' + metaParts.join('<span style="opacity:0.3;">|</span>') + '</div>'
            : '';

        // Genre chips
        let genreHtml = '';
        if (genres.length > 0) {
            let chips = genres.slice(0, 4).map(function(g) {
                return '<span style="font-size:10px; padding:2px 6px; background:var(--border); border-radius:4px; color:var(--subtext); white-space:nowrap;">' + stripHtml(String(g)) + '</span>';
            }).join('');
            genreHtml = '<div style="display:flex; gap:4px; flex-wrap:wrap; margin-top:6px;">' + chips + '</div>';
        }

        card.innerHTML = coverHtml +
            '<div style="padding:10px 12px; flex:1; min-width:0; display:flex; flex-direction:column; justify-content:center;">' +
                '<div style="font-size:14px; font-weight:bold; color:var(--text); line-height:1.35; overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical;">' + title + '</div>' +
                metaHtml +
                genreHtml +
            '</div>';

        grid.appendChild(card);
    });
}

function onBrowseError(msg) {
    browseLoading = false;
    document.getElementById("browseLoading").style.display = "none";
    document.getElementById("browseError").style.display = "block";
    let safeMsg = (msg || "Не удалось подключиться").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    document.getElementById("browseErrorMsg").innerHTML = safeMsg.replace(/\\n/g, "<br>");
}

// =========================================================
// BROWSE DETAIL — in-app title page + video player
// =========================================================
let currentBrowseDetailId = "";
let currentBrowseDetailData = null;
let bdDescExpanded = false;
let _bdCurrentEpisodeId = "";
let _bdCurrentEpisodeTitle = "";
let _bdCurrentEpisodeNum = 0;
let _bdPendingResume = null;
let _bdSaveProgressTimer = null;

// --- Browse Favorites (localStorage) ---
function getBrowseFavorites() {
    try {
        return JSON.parse(localStorage.getItem("browse_favorites") || "[]");
    } catch(e) { return []; }
}

function saveBrowseFavorites(favs) {
    localStorage.setItem("browse_favorites", JSON.stringify(favs));
}

function isBrowseFavorite(id) {
    return getBrowseFavorites().some(function(f) { return f.id === id; });
}

function toggleBrowseFavorite() {
    if (!currentBrowseDetailId || !currentBrowseDetailData) return;
    let favs = getBrowseFavorites();
    let idx = -1;
    for (let i = 0; i < favs.length; i++) {
        if (favs[i].id === currentBrowseDetailId) { idx = i; break; }
    }
    if (idx >= 0) {
        favs.splice(idx, 1);
        showToast("Removed from favorites");
    } else {
        let d = currentBrowseDetailData;
        favs.unshift({
            id: currentBrowseDetailId,
            title: d.title || "",
            cover: d.cover || "",
            genres: (d.genres || []).slice(0, 4).map(function(g) { return g.name || g; }),
            totalEpisodes: d.totalEpisodes || 0
        });
        showToast("Added to favorites");
    }
    saveBrowseFavorites(favs);
    updateBdFavIcon();
    if (typeof Android !== "undefined" && typeof Android.hapticClick === "function") Android.hapticClick();
}

function updateBdFavIcon() {
    let icon = document.getElementById("bdFavIcon");
    if (!icon) return;
    let isFav = isBrowseFavorite(currentBrowseDetailId);
    if (isFav) {
        icon.style.color = "#ff4060";
        icon.innerHTML = '<path fill="currentColor" d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>';
    } else {
        icon.style.color = "var(--subtext)";
        icon.innerHTML = '<path fill="currentColor" d="M16.5 3c-1.74 0-3.41.81-4.5 2.09C10.91 3.81 9.24 3 7.5 3 4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.32C18.6 15.36 22 12.28 22 8.5 22 5.42 19.58 3 16.5 3zm-4.4 15.55l-.1.1-.1-.1C7.14 14.24 4 11.39 4 8.5 4 6.5 5.5 5 7.5 5c1.54 0 3.04.99 3.57 2.36h1.87C13.46 5.99 14.96 5 16.5 5c2 0 3.5 1.5 3.5 3.5 0 2.89-3.14 5.74-7.9 10.05z"/>';
    }
}

function renderBrowseFavorites() {
    let favs = getBrowseFavorites();
    let section = document.getElementById("browseFavSection");
    let grid = document.getElementById("browseFavGrid");
    let count = document.getElementById("browseFavCount");
    if (!section || !grid) return;

    if (favs.length === 0) {
        section.style.display = "none";
        return;
    }

    section.style.display = "block";
    count.innerText = favs.length + " saved";

    let html = "";
    favs.forEach(function(f) {
        let coverHtml = f.cover
            ? '<img src="' + f.cover + '" style="width:100%; height:100%; object-fit:cover;" loading="lazy" onerror="this.style.display=\'none\'">'
            : '';
        html += '<div onclick="openBrowseDetail(\'' + f.id.replace(/'/g, "\\'") + '\')" ' +
            'style="min-width:110px; width:110px; cursor:pointer; flex-shrink:0;">' +
            '<div style="width:110px; height:150px; border-radius:10px; overflow:hidden; background:var(--surface); position:relative;">' +
                coverHtml +
            '</div>' +
            '<div style="font-size:12px; font-weight:600; color:var(--text); margin-top:6px; line-height:1.3; overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical;">' + stripHtml(f.title) + '</div>' +
            (f.totalEpisodes ? '<div style="font-size:11px; color:var(--subtext); margin-top:2px;">' + f.totalEpisodes + ' ep.</div>' : '') +
        '</div>';
    });
    grid.innerHTML = html;
}

// --- Watch History (localStorage) ---
function getWatchHistory() {
    try { return JSON.parse(localStorage.getItem("browse_watch_history") || "[]"); } catch(e) { return []; }
}
function _saveWatchHistoryData(hist) {
    localStorage.setItem("browse_watch_history", JSON.stringify(hist));
}
function saveWatchProgress() {
    if (!currentBrowseDetailId || !_bdCurrentEpisodeId || !currentBrowseDetailData) return;
    let vid = document.getElementById("bdVideo");
    if (!vid || !vid.duration || vid.duration <= 0) return;
    let t = vid.currentTime;
    let dur = vid.duration;
    if (t < 5) return;
    let hist = getWatchHistory().filter(function(e) {
        return !(e.id === currentBrowseDetailId && e.episodeId === _bdCurrentEpisodeId);
    });
    if (t / dur > 0.95) {
        _saveWatchHistoryData(hist);
        return;
    }
    hist.unshift({
        id: currentBrowseDetailId,
        title: currentBrowseDetailData.title || "",
        cover: currentBrowseDetailData.cover || "",
        episodeId: _bdCurrentEpisodeId,
        episodeTitle: _bdCurrentEpisodeTitle,
        episodeNum: _bdCurrentEpisodeNum,
        timecode: t,
        duration: dur
    });
    if (hist.length > 10) hist = hist.slice(0, 10);
    _saveWatchHistoryData(hist);
}
function renderWatchHistory() {
    let hist = getWatchHistory();
    let section = document.getElementById("browseWatchSection");
    let grid = document.getElementById("browseWatchGrid");
    if (!section || !grid) return;
    if (hist.length === 0) { section.style.display = "none"; return; }
    section.style.display = "block";
    let html = "";
    hist.forEach(function(e) {
        let pct = e.duration > 0 ? Math.min(100, Math.round((e.timecode / e.duration) * 100)) : 0;
        let coverHtml = e.cover
            ? '<img src="' + e.cover + '" style="width:100%; height:100%; object-fit:cover;" loading="lazy" onerror="this.style.display=\'none\'">'
            : '';
        let safeId = e.id.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
        let safeEpId = e.episodeId.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
        html += '<div onclick="openContinueWatching(\'' + safeId + '\', \'' + safeEpId + '\', ' + e.timecode + ')" style="min-width:110px; width:110px; cursor:pointer; flex-shrink:0;">'
            + '<div style="width:110px; height:150px; border-radius:10px; overflow:hidden; background:var(--surface); position:relative;">'
                + coverHtml
                + '<div style="position:absolute; bottom:0; left:0; right:0; height:3px; background:rgba(255,255,255,0.15);">'
                    + '<div style="height:100%; width:' + pct + '%; background:var(--pixiv-blue); border-radius:0 0 10px 0;"></div>'
                + '</div>'
            + '</div>'
            + '<div style="font-size:11px; color:var(--text); margin-top:4px; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; font-weight:600;">' + stripHtml(e.title) + '</div>'
            + '<div style="font-size:10px; color:var(--subtext); overflow:hidden; white-space:nowrap; text-overflow:ellipsis;">Эп. ' + (e.episodeNum || stripHtml(e.episodeTitle)) + '</div>'
            + '</div>';
    });
    grid.innerHTML = html;
}
function openContinueWatching(titleId, episodeId, timecode) {
    _bdPendingResume = { episodeId: episodeId, timecode: timecode };
    openBrowseDetail(titleId);
}

function openBrowseDetail(id) {
    currentBrowseDetailId = id;

    // Hide browse grid, show detail page as active overlay
    let detPage = document.getElementById("page-browse-detail");
    detPage.style.display = "block";
    detPage.classList.add("active");

    // Reset UI
    document.getElementById("bdTitle").innerText = "Loading...";
    document.getElementById("bdTitleFull").innerText = "";
    document.getElementById("bdCover").src = "";
    document.getElementById("bdCoverWrap").style.display = "block";
    document.getElementById("bdMeta").innerHTML = "";
    document.getElementById("bdGenres").innerHTML = "";
    document.getElementById("bdDescWrap").style.display = "none";
    document.getElementById("bdDesc").innerText = "";
    document.getElementById("bdEpisodesList").innerHTML = "";
    const _ph = document.getElementById("bdPlayerPlaceholder");
    if (_ph) _ph.style.display = "flex";
    const _bv = document.getElementById("bdVideo");
    if (_bv) _bv.style.display = "none";
    document.getElementById("bdLoading").style.display = "block";
    document.getElementById("bdError").style.display = "none";
    bdDescExpanded = false;

    let bdPage = document.getElementById("page-browse-detail");
    if (bdPage) bdPage.scrollTop = 0;

    Android.fetchBrowseDetail(id);
}

function displayBrowseDetail(b64) {
    document.getElementById("bdLoading").style.display = "none";
    try {
        let json = decodeURIComponent(escape(atob(b64)));
        let data = JSON.parse(json);

        if (data.error) {
            onBrowseDetailError(data.error);
            return;
        }

        // Store data for favorites
        currentBrowseDetailData = data;

        document.getElementById("bdTitle").innerText = data.title || "No title";
        document.getElementById("bdTitleFull").innerText = data.title || "No title";

        // Update favorite icon
        updateBdFavIcon();

        if (data.cover) {
            document.getElementById("bdCover").src = data.cover;
            document.getElementById("bdCoverWrap").style.display = "block";
        } else {
            document.getElementById("bdCoverWrap").style.display = "none";
        }

        // Meta: year, rating, views
        let metaParts = [];
        if (data.released) metaParts.push(String(data.released));
        if (data.ratingCount) metaParts.push(data.ratingCount + " ratings");
        if (data.views) metaParts.push(data.views + " views");
        if (data.totalEpisodes) metaParts.push(data.totalEpisodes + " ep.");
        document.getElementById("bdMeta").innerHTML = metaParts.join(' <span style="opacity:0.3;">|</span> ');

        // Genres
        let genreHtml = "";
        if (data.genres && data.genres.length > 0) {
            data.genres.forEach(function(g) {
                genreHtml += '<span style="font-size:11px; padding:3px 8px; background:var(--border); border-radius:6px; color:var(--subtext); white-space:nowrap;">' + stripHtml(String(g.name || g)) + '</span>';
            });
        }
        document.getElementById("bdGenres").innerHTML = genreHtml;

        // Description
        if (data.summary && data.summary.trim()) {
            document.getElementById("bdDesc").innerText = data.summary;
            document.getElementById("bdDescWrap").style.display = "block";
        }

        // Episodes
        let epHtml = "";
        if (data.episodes && data.episodes.length > 0) {
            data.episodes.forEach(function(ep, idx) {
                let epTitle = ep.title || ("Episode " + ep.number);
                let epDate = ep.releasedRelative || "";
                epHtml += '<div onclick="playBrowseEpisode(\'' + ep.id.replace(/'/g, "\\'") + '\')" ' +
                    'style="display:flex; align-items:center; gap:12px; padding:12px; background:var(--surface); border-radius:10px; margin-bottom:8px; cursor:pointer;">' +
                    '<div style="width:36px; height:36px; min-width:36px; border-radius:50%; background:var(--pixiv-blue); color:#fff; display:flex; align-items:center; justify-content:center; font-weight:bold; font-size:14px;">' + (ep.number || (idx + 1)) + '</div>' +
                    '<div style="flex:1; min-width:0;">' +
                        '<div style="font-size:14px; font-weight:600; color:var(--text); overflow:hidden; white-space:nowrap; text-overflow:ellipsis;">' + stripHtml(epTitle) + '</div>' +
                        (epDate ? '<div style="font-size:11px; color:var(--subtext); margin-top:2px;">' + stripHtml(epDate) + '</div>' : '') +
                    '</div>' +
                    '<svg style="width:20px; height:20px; color:var(--subtext); min-width:20px;" viewBox="0 0 24 24"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>' +
                '</div>';
            });
        } else {
            epHtml = '<div style="padding:16px; text-align:center; color:var(--subtext);">No episodes found</div>';
        }
        document.getElementById("bdEpisodesList").innerHTML = epHtml;

        if (_bdPendingResume) {
            playBrowseEpisode(_bdPendingResume.episodeId);
        }

    } catch(e) {
        onBrowseDetailError("Parse error: " + e.message);
    }
}

function onBrowseDetailError(msg) {
    document.getElementById("bdLoading").style.display = "none";
    document.getElementById("bdError").style.display = "block";
    document.getElementById("bdErrorMsg").innerText = msg || "Failed to load";
}

function retryBrowseDetail() {
    document.getElementById("bdError").style.display = "none";
    document.getElementById("bdLoading").style.display = "block";
    Android.fetchBrowseDetail(currentBrowseDetailId);
}

function goBackFromBrowseDetail() {
    saveWatchProgress();
    _bdPendingResume = null;
    let vid = document.getElementById("bdVideo");
    if (vid) { vid.pause(); vid.src = ""; vid.style.display = "none"; }
    const _ph3 = document.getElementById("bdPlayerPlaceholder");
    if (_ph3) _ph3.style.display = "flex";
    closeBdFullscreen();

    let detPage = document.getElementById("page-browse-detail");
    detPage.style.display = "none";
    detPage.classList.remove("active");
    renderBrowseFavorites();
    renderWatchHistory();
}

function toggleBdDesc() {
    let desc = document.getElementById("bdDesc");
    let toggle = document.getElementById("bdDescToggle");
    bdDescExpanded = !bdDescExpanded;
    desc.style.maxHeight = bdDescExpanded ? "none" : "60px";
    toggle.innerText = bdDescExpanded ? "Свернуть" : "Показать полностью";
}

// =========================================================
// CUSTOM VIDEO PLAYER
// =========================================================
let bdCurrentQualityIdx = -1;
let bdControlsVisible = false;
let bdControlsTimer = null;
let bdSeeking = false;

function bdFormatTime(sec) {
    if (!sec || isNaN(sec)) return "0:00";
    let m = Math.floor(sec / 60);
    let s = Math.floor(sec % 60);
    return m + ":" + (s < 10 ? "0" : "") + s;
}

// --- Inline player controls ---
let bdLastTapTime = 0;
let bdLastTapSide = null;

function bdToggleControls(e) {
    if (e) e.stopPropagation();
    let ov = document.getElementById("bdPlayerOverlay");
    if (!ov) return;
    bdControlsVisible = !bdControlsVisible;
    ov.style.opacity = bdControlsVisible ? "1" : "0";
    // НЕ меняем pointer-events - оверлей всегда должен ловить клики
    clearTimeout(bdControlsTimer);
    if (bdControlsVisible) {
        bdControlsTimer = setTimeout(function() {
            ov.style.opacity = "0";
            bdControlsVisible = false;
        }, 4000);
    }
}

function bdHandleClick(e) {
    e.stopPropagation();
    bdToggleControls(e);
}

function bdHandleDoubleTap(e, side) {
    e.stopPropagation();
    let now = Date.now();
    let timeDiff = now - bdLastTapTime;

    if (timeDiff < 300 && bdLastTapSide === side) {
        bdSeekVideo(side === 'left' ? -10 : 10);
        bdShowSeekIndicator(side);
        bdLastTapTime = 0;
        bdLastTapSide = null;
    } else {
        bdLastTapTime = now;
        bdLastTapSide = side;
    }
}

function bdSeekVideo(seconds) {
    let vid = document.getElementById("bdVideo");
    if (!vid || !vid.duration) return;
    vid.currentTime = Math.max(0, Math.min(vid.currentTime + seconds, vid.duration));
}

function bdShowSeekIndicator(side) {
    let indicator = document.getElementById(side === 'left' ? 'bdSeekLeft' : 'bdSeekRight');
    if (!indicator) return;

    indicator.style.transition = 'none';
    indicator.style.opacity = '1';
    indicator.style.transform = side === 'left' ? 'translate(-50%,-50%) scale(0.8)' : 'translate(50%,-50%) scale(0.8)';

    setTimeout(function() {
        indicator.style.transition = 'all 0.2s ease-out';
        indicator.style.transform = side === 'left' ? 'translate(-50%,-50%) scale(1)' : 'translate(50%,-50%) scale(1)';
    }, 10);

    setTimeout(function() {
        indicator.style.transition = 'opacity 0.3s ease-out';
        indicator.style.opacity = '0';
    }, 400);
}

function bdTogglePlay() {
    let vid = document.getElementById("bdVideo");
    if (vid.paused) { vid.play().catch(function(){}); } else { vid.pause(); }
}

function bdUpdatePlayIcon() {
    let vid = document.getElementById("bdVideo");
    let icon = document.getElementById("bdPlayIcon");
    icon.innerHTML = vid.paused
        ? '<path fill="currentColor" d="M8 5v14l11-7z"/>'
        : '<path fill="currentColor" d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>';
}

function bdUpdateProgress() {
    let vid = document.getElementById("bdVideo");
    if (!vid.duration || bdSeeking) return;
    let pct = (vid.currentTime / vid.duration) * 100;
    document.getElementById("bdProgress").style.width = pct + "%";
    document.getElementById("bdScrubber").style.left = pct + "%";
    document.getElementById("bdTimeText").innerText = bdFormatTime(vid.currentTime) + " / " + bdFormatTime(vid.duration);
    // Buffered
    if (vid.buffered.length > 0) {
        let bufPct = (vid.buffered.end(vid.buffered.length - 1) / vid.duration) * 100;
        document.getElementById("bdBuffered").style.width = bufPct + "%";
    }
}

function bdSeekStart(e) { e.stopPropagation(); bdSeeking = true; bdSeekMove(e); }
function bdSeekMove(e) {
    if (!bdSeeking) return;
    let wrap = document.getElementById("bdProgressWrap");
    let rect = wrap.getBoundingClientRect();
    let touch = e.touches ? e.touches[0] : e;
    let x = Math.max(0, Math.min(touch.clientX - rect.left, rect.width));
    let pct = (x / rect.width) * 100;
    document.getElementById("bdProgress").style.width = pct + "%";
    document.getElementById("bdScrubber").style.left = pct + "%";
}
function bdSeekEnd(e) {
    if (!bdSeeking) return;
    let wrap = document.getElementById("bdProgressWrap");
    let rect = wrap.getBoundingClientRect();
    let touch = e.changedTouches ? e.changedTouches[0] : e;
    let x = Math.max(0, Math.min(touch.clientX - rect.left, rect.width));
    let pct = x / rect.width;
    let vid = document.getElementById("bdVideo");
    if (vid.duration) vid.currentTime = pct * vid.duration;
    bdSeeking = false;
    bdUpdateProgress();
}

// --- Fullscreen controls ---
let bdFsControlsVisible = false;
let bdFsControlsTimer = null;
let bdFsSeeking = false;
let bdFsLastTapTime = 0;
let bdFsLastTapSide = null;

function bdFsToggleControls(e) {
    if (e) e.stopPropagation();
    let ov = document.getElementById("bdFsOverlay");
    if (!ov) return;
    bdFsControlsVisible = !bdFsControlsVisible;
    ov.style.opacity = bdFsControlsVisible ? "1" : "0";
    // НЕ меняем pointer-events - оверлей всегда должен ловить клики
    clearTimeout(bdFsControlsTimer);
    if (bdFsControlsVisible) {
        bdFsControlsTimer = setTimeout(function() {
            ov.style.opacity = "0";
            bdFsControlsVisible = false;
        }, 4000);
    }
}

function bdFsHandleClick(e) {
    e.stopPropagation();
    bdFsToggleControls(e);
}

function bdFsHandleDoubleTap(e, side) {
    e.stopPropagation();
    let now = Date.now();
    let timeDiff = now - bdFsLastTapTime;

    if (timeDiff < 300 && bdFsLastTapSide === side) {
        bdFsSeekVideo(side === 'left' ? -10 : 10);
        bdFsShowSeekIndicator(side);
        bdFsLastTapTime = 0;
        bdFsLastTapSide = null;
    } else {
        bdFsLastTapTime = now;
        bdFsLastTapSide = side;
    }
}

function bdFsSeekVideo(seconds) {
    let vid = document.getElementById("bdFullscreenVideo");
    if (!vid || !vid.duration) return;
    vid.currentTime = Math.max(0, Math.min(vid.currentTime + seconds, vid.duration));
}

function bdFsShowSeekIndicator(side) {
    let indicator = document.getElementById(side === 'left' ? 'bdFsSeekLeft' : 'bdFsSeekRight');
    if (!indicator) return;

    indicator.style.transition = 'none';
    indicator.style.opacity = '1';
    indicator.style.transform = side === 'left' ? 'translate(-50%,-50%) scale(0.8)' : 'translate(50%,-50%) scale(0.8)';

    setTimeout(function() {
        indicator.style.transition = 'all 0.2s ease-out';
        indicator.style.transform = side === 'left' ? 'translate(-50%,-50%) scale(1)' : 'translate(50%,-50%) scale(1)';
    }, 10);

    setTimeout(function() {
        indicator.style.transition = 'opacity 0.3s ease-out';
        indicator.style.opacity = '0';
    }, 400);
}

function bdFsTogglePlay() {
    let vid = document.getElementById("bdFullscreenVideo");
    if (vid.paused) { vid.play().catch(function(){}); } else { vid.pause(); }
}

function bdFsUpdatePlayIcon() {
    let vid = document.getElementById("bdFullscreenVideo");
    let icon = document.getElementById("bdFsPlayIcon");
    icon.innerHTML = vid.paused
        ? '<path fill="currentColor" d="M8 5v14l11-7z"/>'
        : '<path fill="currentColor" d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>';
}

function bdFsUpdateProgress() {
    let vid = document.getElementById("bdFullscreenVideo");
    if (!vid.duration || bdFsSeeking) return;
    let pct = (vid.currentTime / vid.duration) * 100;
    document.getElementById("bdFsProgress").style.width = pct + "%";
    document.getElementById("bdFsScrubber").style.left = pct + "%";
    document.getElementById("bdFsTimeText").innerText = bdFormatTime(vid.currentTime) + " / " + bdFormatTime(vid.duration);
    if (vid.buffered.length > 0) {
        let bufPct = (vid.buffered.end(vid.buffered.length - 1) / vid.duration) * 100;
        document.getElementById("bdFsBuffered").style.width = bufPct + "%";
    }
}

function bdFsSeekStart(e) { e.stopPropagation(); bdFsSeeking = true; bdFsSeekMove(e); }
function bdFsSeekMove(e) {
    if (!bdFsSeeking) return;
    let wrap = document.getElementById("bdFsProgressWrap");
    let rect = wrap.getBoundingClientRect();
    let touch = e.touches ? e.touches[0] : e;
    let x = Math.max(0, Math.min(touch.clientX - rect.left, rect.width));
    let pct = (x / rect.width) * 100;
    document.getElementById("bdFsProgress").style.width = pct + "%";
    document.getElementById("bdFsScrubber").style.left = pct + "%";
}
function bdFsSeekEnd(e) {
    if (!bdFsSeeking) return;
    let wrap = document.getElementById("bdFsProgressWrap");
    let rect = wrap.getBoundingClientRect();
    let touch = e.changedTouches ? e.changedTouches[0] : e;
    let x = Math.max(0, Math.min(touch.clientX - rect.left, rect.width));
    let pct = x / rect.width;
    let vid = document.getElementById("bdFullscreenVideo");
    if (vid.duration) vid.currentTime = pct * vid.duration;
    bdFsSeeking = false;
    bdFsUpdateProgress();
}

// --- Init video event listeners (called once after DOM ready) ---
function bdInitPlayerEvents() {
    let vid = document.getElementById("bdVideo");
    let fsVid = document.getElementById("bdFullscreenVideo");
    if (!vid || vid._bdInited) return;
    vid._bdInited = true;
    vid.addEventListener("timeupdate", bdUpdateProgress);
    vid.addEventListener("play", bdUpdatePlayIcon);
    vid.addEventListener("pause", bdUpdatePlayIcon);
    vid.addEventListener("progress", bdUpdateProgress);
    vid.addEventListener("loadedmetadata", bdUpdateProgress);
    vid.addEventListener("pause", saveWatchProgress);
    vid.addEventListener("timeupdate", function() {
        clearTimeout(_bdSaveProgressTimer);
        _bdSaveProgressTimer = setTimeout(saveWatchProgress, 5000);
    });

    if (fsVid) {
        fsVid.addEventListener("timeupdate", bdFsUpdateProgress);
        fsVid.addEventListener("play", bdFsUpdatePlayIcon);
        fsVid.addEventListener("pause", bdFsUpdatePlayIcon);
        fsVid.addEventListener("progress", bdFsUpdateProgress);
        fsVid.addEventListener("loadedmetadata", bdFsUpdateProgress);
    }
}

// --- Play episode ---
function playBrowseEpisode(episodeId) {
    _bdCurrentEpisodeId = episodeId;
    _bdCurrentEpisodeTitle = "";
    _bdCurrentEpisodeNum = 0;
    if (currentBrowseDetailData && currentBrowseDetailData.episodes) {
        for (let i = 0; i < currentBrowseDetailData.episodes.length; i++) {
            let ep = currentBrowseDetailData.episodes[i];
            if (ep.id === episodeId) {
                _bdCurrentEpisodeTitle = ep.title || ("Episode " + ep.number);
                _bdCurrentEpisodeNum = ep.number || (i + 1);
                break;
            }
        }
    }
    document.getElementById("bdPlayerWrap").style.display = "block";
    document.getElementById("bdPlayerLoading").style.display = "flex";
    const _ph2 = document.getElementById("bdPlayerPlaceholder");
    if (_ph2) _ph2.style.display = "none";

    _bdRevokeBlobUrls();
    let vid = document.getElementById("bdVideo");
    vid.style.display = "none";
    vid.pause();
    vid.src = "";
    bdCurrentQualityIdx = -1;
    document.getElementById("bdProgress").style.width = "0%";
    document.getElementById("bdScrubber").style.left = "0%";
    document.getElementById("bdTimeText").innerText = "0:00 / 0:00";
    document.getElementById("bdPlayerOverlay").style.opacity = "0";
    bdControlsVisible = false;

    bdInitPlayerEvents();

    let bdPage = document.getElementById("page-browse-detail");
    if (bdPage) bdPage.scrollTop = 0;

    Android.fetchBrowseEpisodeSources(episodeId);
}

let _bdBlobUrls = [];

function _bdRevokeBlobUrls() {
    _bdBlobUrls.forEach(function(u) { try { URL.revokeObjectURL(u); } catch(e) {} });
    _bdBlobUrls = [];
}

function _bdMakeMiniManifest(streamInfLine, streamUrl, audioLines) {
    let m = '#EXTM3U\n';
    audioLines.forEach(function(l) { m += l + '\n'; });
    m += streamInfLine + '\n' + streamUrl + '\n';
    let blob = new Blob([m], { type: 'application/vnd.apple.mpegurl' });
    let url = URL.createObjectURL(blob);
    _bdBlobUrls.push(url);
    return url;
}

async function parseHlsQualities(masterUrl) {
    try {
        let resp = await fetch(masterUrl);
        let text = await resp.text();
        if (!text.includes('#EXTM3U')) return null;
        let base = masterUrl.substring(0, masterUrl.lastIndexOf('/') + 1);
        let lines = text.split('\n');

        // Собрать аудио-рендиции (#EXT-X-MEDIA:TYPE=AUDIO) с абсолютными URI
        let audioLines = [];
        lines.forEach(function(line) {
            line = line.trim();
            if (!line.startsWith('#EXT-X-MEDIA:') || !line.includes('TYPE=AUDIO')) return;
            audioLines.push(line.replace(/URI="([^"]+)"/, function(_, uri) {
                return 'URI="' + (uri.startsWith('http') ? uri : base + uri) + '"';
            }));
        });

        let parsed = [];
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i].trim();
            if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
            let resMatch = line.match(/RESOLUTION=\d+x(\d+)/);
            let bwMatch = line.match(/BANDWIDTH=(\d+)/);
            let streamUrl = (lines[i + 1] || '').trim();
            if (!streamUrl || streamUrl.startsWith('#')) continue;
            if (!streamUrl.startsWith('http')) streamUrl = base + streamUrl;

            // Создать мини-манифест с видео + аудио
            let src = audioLines.length > 0
                ? _bdMakeMiniManifest(line, streamUrl, audioLines)
                : streamUrl;

            parsed.push({
                label: resMatch ? resMatch[1] + 'p' : (bwMatch ? Math.round(parseInt(bwMatch[1]) / 1000) + 'k' : 'Auto'),
                src: src,
                bandwidth: bwMatch ? parseInt(bwMatch[1]) : 0
            });
        }
        parsed.sort(function(a, b) { return b.bandwidth - a.bandwidth; });
        return parsed.length > 1 ? parsed : null;
    } catch(e) {
        return null;
    }
}

function bdRenderQualityChips(sources) {
    let qHtml = "";
    sources.forEach(function(s, idx) {
        let isActive = idx === bdCurrentQualityIdx;
        qHtml += '<div onclick="event.stopPropagation(); switchBdQuality(' + idx + ');" data-bd-q-idx="' + idx + '" ' +
            'style="padding:3px 8px; border-radius:6px; font-size:10px; font-weight:bold; cursor:pointer; white-space:nowrap; ' +
            (isActive ? 'background:var(--pixiv-blue); color:#fff;' : 'background:rgba(255,255,255,0.15); color:rgba(255,255,255,0.7);') +
            '">' + (s.label || 'Q' + idx) + '</div>';
    });
    document.getElementById("bdQualityChips").innerHTML = qHtml;
    document.getElementById("bdFsQualityChips").innerHTML = qHtml.replace(/var\(--pixiv-blue\)/g, '#0096FA');
}

async function displayBrowsePlayer(b64) {
    try {
        let json = decodeURIComponent(escape(atob(b64)));
        let data = JSON.parse(json);

        if (data.error) { document.getElementById("bdPlayerLoading").style.display = "none"; showToast(data.error); return; }

        let sources = data.sources || [];
        if (sources.length === 0) { document.getElementById("bdPlayerLoading").style.display = "none"; showToast("Видео не найдено"); return; }

        // Если один HLS-манифест — распарсить доступные качества для отображения
        if (sources.length === 1) {
            let url = sources[0].src || sources[0].file || '';
            if (url.includes('.m3u8') || url.includes('playlist') || url.includes('manifest')) {
                let hlsSources = await parseHlsQualities(url);
                if (hlsSources) {
                    sources = [{ label: 'Auto', src: url }].concat(hlsSources);
                }
            }
        }

        let vid = document.getElementById("bdVideo");
        if (data.thumbnail) vid.poster = data.thumbnail;

        bdCurrentQualityIdx = 0;
        vid.src = sources[0].src || sources[0].file || '';

        window._bdSources = sources;
        bdRenderQualityChips(sources);

        // Показываем видео и скрываем загрузчик только когда кадр готов
        vid.addEventListener("canplay", function onCanPlay() {
            vid.removeEventListener("canplay", onCanPlay);
            document.getElementById("bdPlayerLoading").style.display = "none";
            vid.style.display = "block";
        }, { once: true });
        vid.addEventListener("error", function onErr() {
            vid.removeEventListener("error", onErr);
            document.getElementById("bdPlayerLoading").style.display = "none";
            vid.style.display = "block";
        }, { once: true });

        if (_bdPendingResume && _bdPendingResume.episodeId === _bdCurrentEpisodeId) {
            let resumeTime = _bdPendingResume.timecode;
            _bdPendingResume = null;
            vid.addEventListener("loadedmetadata", function onResume() {
                vid.currentTime = resumeTime;
                vid.removeEventListener("loadedmetadata", onResume);
                bdUpdatePlayIcon();
                bdUpdateProgress();
            });
        } else {
            vid.play().catch(function() {});
        }

        let ov = document.getElementById("bdPlayerOverlay");
        ov.style.opacity = "1";
        bdControlsVisible = true;
        clearTimeout(bdControlsTimer);
        bdControlsTimer = setTimeout(function() {
            ov.style.opacity = "0";
            bdControlsVisible = false;
        }, 4000);

    } catch(e) {
        showToast("Ошибка плеера: " + e.message);
    }
}

function switchBdQuality(idx) {
    let sources = window._bdSources;
    if (!sources || !sources[idx]) return;

    let vid = document.getElementById("bdVideo");
    let fsVid = document.getElementById("bdFullscreenVideo");
    let currentTime = vid.currentTime;
    let wasPlaying = !vid.paused;
    let isFsOpen = document.getElementById("bdFullscreenOverlay").style.display === "block";

    if (isFsOpen) {
        currentTime = fsVid.currentTime;
        wasPlaying = !fsVid.paused;
    }

    bdCurrentQualityIdx = idx;

    let srcUrl = sources[idx].src || sources[idx].file || '';

    // Update inline video
    vid.src = srcUrl;
    vid.addEventListener("loadedmetadata", function onLoad() {
        vid.currentTime = currentTime;
        if (wasPlaying && !isFsOpen) vid.play().catch(function(){});
        vid.removeEventListener("loadedmetadata", onLoad);
    });

    // Update fullscreen video if open
    if (isFsOpen) {
        fsVid.src = srcUrl;
        fsVid.addEventListener("loadedmetadata", function onFsLoad() {
            fsVid.currentTime = currentTime;
            if (wasPlaying) fsVid.play().catch(function(){});
            fsVid.removeEventListener("loadedmetadata", onFsLoad);
        });
    }

    // Update all quality chips
    document.querySelectorAll("[data-bd-q-idx]").forEach(function(el) {
        let i = parseInt(el.getAttribute("data-bd-q-idx"));
        if (i === idx) {
            el.style.background = el.closest("#bdFsOverlay") ? "#0096FA" : "var(--pixiv-blue)";
            el.style.color = "#fff";
        } else {
            el.style.background = el.closest("#bdFsOverlay") ? "rgba(255,255,255,0.15)" : "rgba(255,255,255,0.15)";
            el.style.color = "rgba(255,255,255,0.7)";
        }
    });
}

// --- Fullscreen with landscape ---
function openBdFullscreen() {
    let vid = document.getElementById("bdVideo");
    let fsVid = document.getElementById("bdFullscreenVideo");
    let overlay = document.getElementById("bdFullscreenOverlay");
    if (!vid.src) return;

    let wasPlaying = !vid.paused;
    let time = vid.currentTime;
    vid.pause();

    fsVid.style.display = "none";
    fsVid.src = vid.src;
    overlay.style.display = "block";

    fsVid.addEventListener("canplay", function onFsCanPlay() {
        fsVid.removeEventListener("canplay", onFsCanPlay);
        fsVid.style.display = "block";
    }, { once: true });
    fsVid.addEventListener("error", function onFsErr() {
        fsVid.removeEventListener("error", onFsErr);
        fsVid.style.display = "block";
    }, { once: true });

    fsVid.addEventListener("loadedmetadata", function onLoad() {
        fsVid.currentTime = time;
        if (wasPlaying) fsVid.play().catch(function(){});
        fsVid.removeEventListener("loadedmetadata", onLoad);
    });

    // Rotate to landscape
    if (typeof Android !== "undefined" && typeof Android.setLandscape === "function") {
        Android.setLandscape(true);
    }

    // Show controls initially
    let fsOv = document.getElementById("bdFsOverlay");
    fsOv.style.opacity = "1";
    bdFsControlsVisible = true;
    clearTimeout(bdFsControlsTimer);
    bdFsControlsTimer = setTimeout(function() {
        fsOv.style.opacity = "0";
        bdFsControlsVisible = false;
    }, 4000);
}

function closeBdFullscreen() {
    let overlay = document.getElementById("bdFullscreenOverlay");
    if (overlay.style.display !== "block") return;

    let fsVid = document.getElementById("bdFullscreenVideo");
    let vid = document.getElementById("bdVideo");

    let time = fsVid.currentTime;
    let wasPlaying = !fsVid.paused;
    fsVid.pause();
    fsVid.src = "";
    overlay.style.display = "none";

    if (vid.src) {
        vid.currentTime = time;
        if (wasPlaying) vid.play().catch(function(){});
    }

    // Rotate back to portrait
    if (typeof Android !== "undefined" && typeof Android.setLandscape === "function") {
        Android.setLandscape(false);
    }
}

