// --- БЛОК СБОРКИ СТРАНИЦ ---
document.addEventListener("DOMContentLoaded", () => {
    try { let sbh = Android.getStatusBarHeightPx(); if (sbh > 0) document.documentElement.style.setProperty('--sat', sbh + 'px'); } catch(e) {}
    
    // ВСТАВЛЯЕМ СЮДА:
    initTheme();

    const pagesToLoad = ['home.html', 'down.html', 'search.html', 'manager.html', 'author.html', 'detail.html', 'following.html'];
    
    let allHtml = "";
    
    // Мгновенно читаем файлы через Java
    pagesToLoad.forEach(page => {
        allHtml += Android.loadHtmlFile(page);
    });
    
    // Вставляем всё в DOM одним махом
    document.getElementById('pages-container').innerHTML = allHtml;

    // Инициализируем новые фичи поиска
    initSearchSuggestions();
    initSearchFilters(); // ДОБАВИТЬ ЭТУ СТРОКУ

    // Привязываем кнопку модального окна
    let confirmBtn = document.getElementById('modalConfirmBtn');
    if(confirmBtn) {
        confirmBtn.addEventListener('click', () => {
            if (modalConfirmAction) modalConfirmAction();
            closeModal();
        });
    }

    
    // Запускаем инициализацию интерфейса
    renderActiveDownloads();
    checkForAppUpdates(); 

    // ПРОВЕРЯЕМ, ЕСТЬ ЛИ НОВЫЙ ЧЕЙНДЖЛОГ ПОСЛЕ ПЕРЕЗАГРУЗКИ
    setTimeout(() => {
        let changelog = localStorage.getItem('pending_changelog');
        if (changelog) {
            let ver = localStorage.getItem('ota_version') || '';
            showChangelogModal(`Обновление v${ver} успешно установлено!`, changelog);
            // Удаляем, чтобы окно больше не вылезало при следующих запусках
            localStorage.removeItem('pending_changelog'); 
        }
    }, 1200); // Небольшая задержка 1.2 сек, чтобы сначала растворился загрузочный экран

    // Плавное затухание экрана загрузки
    setTimeout(() => {
        let loader = document.getElementById('loader-wrapper');
        if (loader) {
            loader.style.opacity = '0';
            setTimeout(() => loader.style.display = 'none', 500);
        }
    }, 700); 
});

// --- ЛОГИКА КАСТОМНОЙ МОДАЛКИ (ВМЕСТО CONFIRM) ---
let modalConfirmAction = null;

function showConfirmModal(title, text, confirmAction) {
    document.getElementById('modalTitle').innerText = title;
    document.getElementById('modalText').innerText = text;
    modalConfirmAction = confirmAction;
    
    document.getElementById('customModalOverlay').classList.add('open');
    document.getElementById('customModal').classList.add('open');
}

function closeModal() {
    document.getElementById('customModalOverlay').classList.remove('open');
    document.getElementById('customModal').classList.remove('open');
    modalConfirmAction = null;
}

// --- ОСТАЛЬНАЯ ЛОГИКА ---
let activeDownloadsMap = {};
let savedDownloads = localStorage.getItem('activeDownloadsMap');
if (savedDownloads) {
    try {
        activeDownloadsMap = JSON.parse(savedDownloads);
        for(let id in activeDownloadsMap) {
            activeDownloadsMap[id].state = 'paused';
            if (activeDownloadsMap[id].progress >= activeDownloadsMap[id].total && activeDownloadsMap[id].total > 0) {
                delete activeDownloadsMap[id];
            } else {
                activeDownloadsMap[id].text = 'Приостановлено';
            }
        }
    } catch(e) {}
}

let currentNextUrl = "", currentAuthorNextUrl = "", currentRecomNextUrl = "", currentRelatedNextUrl = "";
let currentAuthorId = "", navHistory = ['home'], currentActionTarget = '', currentActionType = '';
let currentIllustId = "", currentIsBookmarked = false;
let detailHistoryStack = []; // <-- НОВЫЙ МАССИВ ДЛЯ ИСТОРИИ РАБОТ
let searchModeVal = 'illust'; // 'illust' или 'user'
let searchAgeVal = 'all', searchHideAiVal = false, recomHideAiVal = false;
let excludeTagsHistory = JSON.parse(localStorage.getItem('pixivExcludeTagsHistory')) || [];
let currentExcludeTags = excludeTagsHistory.join(', '); // ТЕПЕРЬ ТЕГИ НЕ СБРАСЫВАЮТСЯ ПРИ ВЫХОДЕ ИЗ ПРИЛОЖЕНИЯ
let isDoubleLoading = false;
let detailImagesData = [];
let loadingMiniGrid = false;
let pendingRelatedRequest = null;
let relatedRetryCount = 0; 
let tabScrollPositions = {}; 
let searchHistory = JSON.parse(localStorage.getItem('pixivSearchHistory')) || []; // ИСТОРИЯ ПОИСКА

function showToast(msg) {
    let t = document.createElement('div');
    t.innerText = msg;
    t.style.position = 'fixed'; t.style.bottom = '80px'; t.style.left = '50%'; t.style.transform = 'translateX(-50%)';
    t.style.background = 'rgba(0,0,0,0.8)'; t.style.color = '#fff'; t.style.padding = '10px 20px';
    t.style.borderRadius = '20px'; t.style.zIndex = '9999'; t.style.fontSize = '14px'; t.style.fontWeight = 'bold';
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2500);
}

function saveDownloadsMap() { localStorage.setItem('activeDownloadsMap', JSON.stringify(activeDownloadsMap)); }


// ==========================================
// ЛОГИКА ФИЛЬТРОВ (ВЫЕЗЖАЮЩАЯ ПАНЕЛЬ)
// ==========================================
function setSearchAge(val) { 
    searchAgeVal = val; 
    // Переключаем активный чипс внутри панели
    document.querySelectorAll('[id^="panelAge_"]').forEach(c => c.classList.remove('active')); 
    let el = document.getElementById('panelAge_' + val);
    if(el) el.classList.add('active'); 
    
    renderActiveFilters(); 
}

function toggleSearchAi() { 
    searchHideAiVal = !searchHideAiVal; 
    let el = document.getElementById('panelAiToggle');
    if(el) el.classList.toggle('active', searchHideAiVal); 
    
    renderActiveFilters();
}

function toggleSearchFiltersPanel() {
    let panel = document.getElementById('expandableFiltersPanel');
    let btn = document.getElementById('openFilterBtn');
    
    if (panel) {
        panel.classList.toggle('open');
        
        // Подсвечиваем саму иконку фильтра синим цветом, когда панель открыта
        if (panel.classList.contains('open')) {
            btn.style.borderColor = 'var(--pixiv-blue)';
            btn.style.color = 'var(--pixiv-blue)';
            btn.style.background = 'rgba(0, 150, 250, 0.1)';
        } else {
            btn.style.borderColor = 'var(--border)';
            btn.style.color = 'var(--text)';
            btn.style.background = 'var(--surface)';
        }
    }
}

// Рисует маленькие "чипсы" активных фильтров рядом с переключателем
function renderActiveFilters() {
    let container = document.getElementById('activeSearchFilters');
    if (!container) return;
    
    let html = '';
    
    // Если выбран R-18, R-18G или Safe - показываем соответствующую метку
    if (searchAgeVal === 'r18') {
        html += `<div class="chip active" style="padding: 4px 10px; font-size: 12px; border-color: var(--red); color: var(--red); background: transparent;">R-18gay</div>`;
    } else if (searchAgeVal === 'r18g') {
        html += `<div class="chip active" style="padding: 4px 10px; font-size: 12px; border-color: var(--purple); color: var(--purple); background: transparent;">R-18G</div>`;
    } else if (searchAgeVal === 'g') {
        // Safe делаем зелененьким для наглядности
        html += `<div class="chip active" style="padding: 4px 10px; font-size: 12px; border-color: var(--green); color: var(--green); background: transparent;">Safe</div>`;
    }
    
    // Если скрываем AI - показываем метку
    if (searchHideAiVal) {
        html += `<div class="chip active" style="padding: 4px 10px; font-size: 12px; background: transparent;">Без AI</div>`;
    }
    
    // Если есть скрытые теги - показываем красную метку
    if (currentExcludeTags) {
        html += `<div class="chip active" style="padding: 4px 10px; font-size: 12px; border-color: var(--red); color: var(--red); background: transparent;">Исключено: ${currentExcludeTags}</div>`;
    }
    
    container.innerHTML = html;
}

function toggleRecomAi() { recomHideAiVal = !recomHideAiVal; document.getElementById('recomAiChip').classList.toggle('active', recomHideAiVal); loadRecommendations(true); }
function toggleSidebar() { document.getElementById('sidebar').classList.toggle('open'); document.getElementById('sidebarOverlay').classList.toggle('open'); }
// Перехватывает системную кнопку "Назад" на Android
function handleBackPress() { 
    if(document.getElementById('sidebar').classList.contains('open')){ 
        toggleSidebar(); 
        return true; 
    } 
    
    let activeTab = navHistory[navHistory.length - 1];
    // Если мы глубоко в работах ИЛИ есть куда возвращаться по вкладкам
    if ((activeTab === 'detail' && detailHistoryStack.length > 0) || navHistory.length > 1) { 
        goBack(); 
        return true; 
    } 
    return false; 
}

// Универсальная функция шага назад
function goBack() { 
    let activeTab = navHistory[navHistory.length - 1];
    
    // ПРОВЕРКА: Если мы в карточке работы и в стеке есть история
    if (activeTab === 'detail' && detailHistoryStack.length > 0) {
        // Достаем предыдущий ID работы из массива
        let prevId = detailHistoryStack.pop();
        // Открываем её, передав флаг isBack = true (чтобы не зациклить сохранение)
        openDetails(prevId, true);
        return; // Прерываем функцию, вкладку не меняем!
    }
    
    // Если история работ пуста, делаем обычный шаг назад по вкладкам приложения
    if (navHistory.length > 1) { 
        navHistory.pop(); 
        internalSwitchTab(navHistory[navHistory.length - 1]); 
    } 
}
function switchTab(tabId) { 
    if (navHistory[navHistory.length - 1] === tabId) {
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
    }
    navHistory.push(tabId); 
    internalSwitchTab(tabId); 
}

function internalSwitchTab(tabId) {
    let activePage = document.querySelector('.page.active');
    if (activePage) {
        let oldTabId = activePage.id.replace('page-', '');
        tabScrollPositions[oldTabId] = window.scrollY;
    }

    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    
    if(tabId === 'manager') Android.requestStorageInfo();

    if(['down', 'search', 'home'].includes(tabId)) {
        if (document.getElementById('tab-' + tabId)) document.getElementById('tab-' + tabId).classList.add('active');
        document.getElementById('mainTabs').style.display = 'flex';
        document.querySelector('.top-bar').style.display = 'flex';
        document.body.style.paddingTop = 'calc(104px + var(--sat))';
        if(tabId === 'home' && document.getElementById('recomGrid').innerHTML === "") loadRecommendations(true);
    } else {
        document.getElementById('mainTabs').style.display = 'none'; 
        document.querySelector('.top-bar').style.display = 'none';
        document.body.style.paddingTop = '0';
    }
    document.getElementById('page-' + tabId).classList.add('active');
    
    setTimeout(() => {
        if (tabScrollPositions[tabId] !== undefined) {
            window.scrollTo(0, tabScrollPositions[tabId]);
        } else {
            window.scrollTo(0, 0);
        }
    }, 0);
    // Добавляем слой заполнителя во все кнопки загрузки, если его там нет
    document.querySelectorAll('.btn-secondary[id*="loadMore"]').forEach(btn => {
        if (!btn.querySelector('.scroll-filler')) {
            let filler = document.createElement('div');
            filler.className = 'scroll-filler';
            btn.appendChild(filler);
        }
    });
}

function startDownload(link, target, type, title, thumb) {
    if(!link) return;
    if (/^\d+$/.test(link.trim())) { link = "https://www.pixiv.net/artworks/" + link.trim(); }
    currentActionTarget = target; currentActionType = type; 

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
    let link = document.getElementById('linkInput').value;
    window.previewTimeout = setTimeout(() => { Android.preview(link); checkFilesExist(link, 'btnMainCheck'); }, 500);
}

function checkFilesExist(link, btnId) {
    if (!link) { document.getElementById(btnId).style.display = 'none'; return; }
    document.getElementById(btnId).style.display = Android.hasDownloadedFiles(link) ? 'flex' : 'none';
}

function updateAccount(name, id, status, isActive, avatar) {
    document.getElementById('loggedOutView').style.display = isActive ? 'none' : 'block';
    document.getElementById('loggedInView').style.display = isActive ? 'block' : 'none';
    
    // Добавили 'sidebarFollowing' в этот список:
    ['downloaderCard', 'searchCard', 'recomCard', 'sidebarMyIllusts', 'sidebarMyBookmarks', 'sidebarFollowing', 'r18SettingsCard'].forEach(cid => {
        let el = document.getElementById(cid);
        if (el) el.classList.toggle('disabled-section', !isActive);
    });
    if (isActive) {
        document.getElementById('accName').innerText = name; document.getElementById('accId').innerText = "ID: " + id;
        document.getElementById('sidebarName').innerText = name; document.getElementById('sidebarId').innerText = "ID: " + id;
        if(avatar && avatar !== "null" && avatar !== "") {
            document.getElementById('sidebarAvatarImg').src = avatar; document.getElementById('sidebarAvatarImg').style.display = 'block'; document.getElementById('sidebarAvatarPlaceholder').style.display = 'none';
            document.getElementById('mainAvatarImg').src = avatar; document.getElementById('mainAvatarImg').style.display = 'block'; document.getElementById('mainAvatarPlaceholder').style.display = 'none';
        }
        if (document.getElementById('page-home').classList.contains('active') && document.getElementById('recomGrid').innerHTML === "") loadRecommendations(true);
    }
}

function addActiveDownload(id, title, thumbUrl) {
    if (!activeDownloadsMap[id]) {
        activeDownloadsMap[id] = { state: 'downloading', title: title || ('Работа ID: ' + id), text: 'В очереди...', progress: 0, total: 0, thumb: thumbUrl || '' };
    } else {
        activeDownloadsMap[id].state = 'downloading';
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
    if (!activeDownloadsMap[id]) activeDownloadsMap[id] = { state: 'downloading', title: 'Работа ID: ' + id, thumb: '' };
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
            activeDownloadsMap[id].state = 'error';
            activeDownloadsMap[id].text = 'Ошибочка..';
        }
    }
    saveDownloadsMap();
    renderActiveDownloads();
    Android.requestStorageInfo(); 
}

function userPauseDownload(id) {
    if(activeDownloadsMap[id]) {
        activeDownloadsMap[id].state = 'paused';
        activeDownloadsMap[id].text = 'Приостановлено';
        saveDownloadsMap();
        renderActiveDownloads();
    }
    Android.pauseDownload(id);
}

function userResumeDownload(id) {
    if(activeDownloadsMap[id]) {
        activeDownloadsMap[id].state = 'downloading';
        activeDownloadsMap[id].text = 'Возобновление...';
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
    if (keys.length === 0) {
        container.innerHTML = '<div class="text-sub">Нет активных загрузок</div>';
        return;
    }
    let html = '';
    keys.forEach(k => {
        let d = activeDownloadsMap[k];
        let pct = d.total > 0 ? Math.floor((d.progress / d.total) * 100) : 0;
        let imgTag = d.thumb ? `<img src="${d.thumb}" class="manager-thumb">` : `<div class="manager-thumb" style="display:flex;align-items:center;justify-content:center;"><svg class="icon-sm" style="color:var(--subtext)"><use href="#icon-search" xlink:href="#icon-search"></use></svg></div>`;
        
        let btnsHtml = '';
        if (d.state === 'downloading') {
            btnsHtml += `<div class="action-icon" style="color:var(--subtext);" onclick="event.stopPropagation(); userPauseDownload('${k}')"><svg class="icon-sm"><use href="#icon-pause" xlink:href="#icon-pause"></use></svg></div>`;
        } else {
            btnsHtml += `<div class="action-icon primary" onclick="event.stopPropagation(); userResumeDownload('${k}')"><svg class="icon-sm"><use href="#icon-play" xlink:href="#icon-play"></use></svg></div>`;
        }
        btnsHtml += `<div class="action-icon danger" onclick="event.stopPropagation(); userAbortDownload('${k}')"><svg class="icon-sm"><use href="#icon-close" xlink:href="#icon-close"></use></svg></div>`;

        html += `
        <div class="manager-item">
            ${imgTag}
            <div style="flex: 1; overflow: hidden;">
                <div class="font-bold" style="font-size: 14px; margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${d.title}</div>
                <div class="text-sub" style="font-size: 12px; color: ${d.state === 'error' ? 'var(--red)' : 'var(--subtext)'}">${d.text}</div>
                <div class="manager-progress-track"><div class="manager-progress-fill" style="width: ${pct}%;"></div></div>
            </div>
            <div style="display:flex; align-items:center;">${btnsHtml}</div>
        </div>`;
    });
    container.innerHTML = html;
}

function deleteDownload(id) {
    showConfirmModal("Удаление пакета", "Точно удалить все скачанные файлы пакета " + id + "?", () => {
        Android.deleteDownloadedFolder(id);
    });
}

function updateDownloadsUI(statsStr, listB64) {
    let stats = JSON.parse(decodeB64Utf8(statsStr));
    let t1 = document.getElementById('storageSpaceText');
    if(t1) {
        t1.innerHTML = `
            <div style="color: var(--pixiv-blue); font-size: 18px; font-weight: bold;">${stats.current}</div>
            <div style="color: var(--green); font-size: 12px; margin-top: 4px;">Сэкономлено сжатием: ${stats.saved}</div>
            <div style="color: var(--subtext); font-size: 11px;">(Оригиналы весили бы: ${stats.original})</div>
        `;
    }
    
    let container = document.getElementById('completedDownloadsList');
    if(!container) return;
    let fullList = [];
    try { fullList = JSON.parse(decodeB64Utf8(listB64)); } catch(e){}
    
    let list = fullList.filter(item => !activeDownloadsMap[item.id]);

    if (list.length === 0) {
        container.innerHTML = '<div class="text-sub">Папка загрузок пуста</div>';
        return;
    }
    let html = '';
    list.forEach(item => {
        let imgTag = '';
        let displayTitle = '';
        
        if (item.id === 'offline_cache') {
            displayTitle = 'Оффлайн пакет (' + item.actual + ' артов)';
            imgTag = `<div class="manager-thumb" style="display:flex;align-items:center;justify-content:center;background:var(--pixiv-blue);"><svg class="icon" style="color:#FFF;"><use href="#icon-sync"></use></svg></div>`;
        } else {
            displayTitle = 'ID: ' + item.id;
            imgTag = item.thumb ? `<img src="data:image/jpeg;base64,${item.thumb}" class="manager-thumb">` : `<div class="manager-thumb" style="display:flex;align-items:center;justify-content:center;"><svg class="icon-sm" style="color:var(--subtext)"><use href="#icon-folder"></use></svg></div>`;
        }
        
        let incompleteBadge = item.is_incomplete ? `<div class="text-red" style="font-size: 11px; margin-top:2px;">Не докачано (${item.actual}/${item.expected})</div>` : '';
        let syncBtn = item.is_incomplete ? `<div class="action-icon primary" onclick="event.stopPropagation(); addActiveDownload('${item.id}', 'Докачка...', 'data:image/jpeg;base64,${item.thumb}'); userResumeDownload('${item.id}')"><svg class="icon-sm"><use href="#icon-sync" xlink:href="#icon-sync"></use></svg></div>` : '';

        html += `
        <div class="manager-item" style="flex-direction: row; justify-content: space-between; align-items: center; cursor: pointer; padding: 12px 16px;" onclick="openDetails('${item.id}')">
            ${imgTag}
            <div style="flex: 1; margin-left: 12px;">
                <div class="font-bold" style="font-size: 14px;">${displayTitle}</div>
                <div class="text-sub" style="font-size: 12px;">${item.size}</div>
                ${incompleteBadge}
            </div>
            ${syncBtn}
            <div class="action-icon danger" onclick="event.stopPropagation(); deleteDownload('${item.id}')"><svg class="icon-sm"><use href="#icon-trash" xlink:href="#icon-trash"></use></svg></div>
        </div>`;
    });
    container.innerHTML = html;
}

function updateProgress(id, current, total) {
    let pct = total > 0 ? (current / total) * 100 : 0;
    if (pct > 100) pct = 100;
    
    let gridBg = document.getElementById('gridBg_' + id);
    let gridFill = document.getElementById('fillGrid_' + id);
    if (gridBg && gridFill) {
        gridBg.style.display = 'block';
        gridFill.style.width = pct + '%';
        if (current >= total && total > 0) setTimeout(() => { gridFill.style.width = '0%'; gridBg.style.display = 'none'; }, 1500);
    }

    if (id === currentIllustId) {
        let inlineBg = document.getElementById('detProgressBg');
        let inlineEl = document.getElementById('fillDetInline');
        if (inlineBg && inlineEl) {
            inlineBg.style.display = 'block';
            inlineEl.style.width = pct + '%';
            if (current >= total && total > 0) setTimeout(() => { inlineEl.style.width = '0%'; inlineBg.style.display = 'none'; }, 1500);
        }
    }

    let linkInput = document.getElementById('linkInput');
    if (linkInput && linkInput.value.includes(id)) {
        let elBtn1 = document.getElementById('fillMain1');
        let elInline = document.getElementById('fillMainInline');
        if (elInline) document.getElementById('mainDlProgressContainer').style.display = 'block';
        if (elBtn1) elBtn1.style.width = pct + '%';
        if (elInline) elInline.style.width = pct + '%';
        if (current >= total && total > 0) setTimeout(() => { 
            if(elBtn1) elBtn1.style.width = '0%'; 
            if(elInline) elInline.style.width = '0%'; 
            if(document.getElementById('mainDlProgressContainer')) document.getElementById('mainDlProgressContainer').style.display = 'none';
        }, 1500);
    }
}

function updatePreview(b64, meta) {
    let img = document.getElementById('previewImg');
    if(!img) return;
    if (b64 && b64 !== "null") { img.src = "data:image/jpeg;base64," + b64; img.style.display = "block"; img.style.border = "1px solid var(--border)"; } 
    else { img.style.display = "none"; }
    document.getElementById('previewMeta').innerText = meta;
}

function decodeB64Utf8(str) { return decodeURIComponent(escape(atob(str))); }

function buildItemHtml(item) {
    let heartClass = item.is_bookmarked ? 'liked' : '';
    let heartIcon = item.is_bookmarked ? '#icon-heart' : '#icon-heart-outline';
    
    let r18badge = '';
    if (item.is_r18g) r18badge = '<div class="badge badge-r18g">R-18G</div>';
    else if (item.is_r18) r18badge = '<div class="badge badge-r18">R-18</div>';
    
    let safeTitle = item.title ? item.title.replace(/'/g, "\\'").replace(/"/g, '&quot;') : "Без названия";

    // ВАЖНО: Используем data-src вместо src. Картинка не начнет грузиться сама по себе.
    return `<img class="search-img" data-src="${item.thumb}">
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
    let btn = document.getElementById('gridLike_' + id);
    if (!btn) return;
    let isLiked = btn.classList.contains('liked');
    let willAdd = !isLiked;
    
    btn.classList.toggle('liked', willAdd);
    btn.querySelector('use').setAttribute('href', willAdd ? '#icon-heart' : '#icon-heart-outline');
    
    Android.toggleBookmark(id, willAdd);
}

function loadRecommendations(isNew) {
    if(isNew) { document.getElementById('recomGrid').innerHTML = ""; currentRecomNextUrl = ""; document.getElementById('recomStatus').innerText = "Загрузка..."; }
    Android.getRecommended(currentRecomNextUrl, "all", recomHideAiVal, currentExcludeTags);
}

function displayRecommendations(b64) {
    let grid = document.getElementById('recomGrid'), btn = document.getElementById('loadMoreRecomBtn'), st = document.getElementById('recomStatus');
    if(!grid) return;
    try {
        let data = JSON.parse(decodeB64Utf8(b64)); currentRecomNextUrl = data.next_url;
        data.results.forEach(item => {
            let div = document.createElement('div'); div.className = 'search-item';
            div.onclick = () => openDetails(item.id); div.innerHTML = buildItemHtml(item); grid.appendChild(div);
        });
        st.innerText = "Рекомендации:";
        btn.style.display = currentRecomNextUrl ? 'block' : 'none';
        
        let isHomeActive = document.getElementById('page-home').classList.contains('active');
        if (isHomeActive && recomHideAiVal && data.results.length < 15 && currentRecomNextUrl && !isDoubleLoading) {
            isDoubleLoading = true; loadRecommendations(false);
        } else { isDoubleLoading = false; }
    } catch (e) { st.innerText = "Ошибка сети."; btn.style.display = 'none'; }
}

function startSearch(isNew) {
    let q = document.getElementById('searchInput').value.trim();
    if(!q) return;
    
    if (isNew) { 
        saveSearchQuery(q); // Сохраняем в историю
        hideSearchSuggestions(); // Прячем меню подсказок
        document.getElementById('searchGrid').innerHTML = ""; 
        currentNextUrl = ""; 
        document.getElementById('searchStatus').innerText = "Поиск..."; 
        
        // ВАЖНО: Если ищем авторов - выстраиваем их в колонку (блок), если арты - в плитку (грид)
        document.getElementById('searchGrid').style.display = searchModeVal === 'user' ? 'block' : 'grid';
    }
    
    if (/^\d+$/.test(q)) { openDetails(q); return; }
    
    // Ветвление: куда отправляем запрос
    if (searchModeVal === 'user') {
        Android.searchUser(q, currentNextUrl);
    } else {
        Android.search(q, currentNextUrl, searchAgeVal, searchHideAiVal, currentExcludeTags);
    }
}

function loadMore() { 
    let q = document.getElementById('searchInput').value.trim();
    if (searchModeVal === 'user') {
        Android.searchUser(q, currentNextUrl);
    } else {
        Android.search(q, currentNextUrl, searchAgeVal, searchHideAiVal, currentExcludeTags);
    }
}

// ==========================================
// ГЕНЕРАЦИЯ ИНТЕРФЕЙСА ФИЛЬТРОВ И ИСКЛЮЧЕНИЙ
// ==========================================
function initSearchFilters() {
    // HTML у нас уже прописан в search.html, так что просто рендерим состояния:
    renderActiveFilters(); 
    renderExcludeTagsHistory();
}

function applyExcludeTags() {
    let input = document.getElementById('excludeTagInput');
    if (!input) return;
    
    let val = input.value.trim();
    if (val) {
        // Можно ввести даже несколько через запятую — он поймет
        let tags = val.split(',').map(t => t.trim()).filter(t => t !== '');
        tags.forEach(t => {
            excludeTagsHistory = excludeTagsHistory.filter(item => item !== t);
            excludeTagsHistory.unshift(t); // Добавляем в начало
        });
        
        if (excludeTagsHistory.length > 20) excludeTagsHistory.length = 20; // Увеличили лимит до 20 штук
        localStorage.setItem('pixivExcludeTagsHistory', JSON.stringify(excludeTagsHistory));
    }
    
    // ОЧИЩАЕМ поле ввода
    input.value = '';
    
    // Обновляем строку для отправки в Java (склеиваем все активные чипсы через запятую)
    currentExcludeTags = excludeTagsHistory.join(', ');
    
    renderExcludeTagsHistory();
    renderActiveFilters();
}

function renderExcludeTagsHistory() {
    let container = document.getElementById('excludeTagsHistoryList');
    if(!container) return;
    
    let html = '';
    excludeTagsHistory.forEach(t => {
        let safeT = t.replace(/'/g, "\\'");
        // Чипс теперь только удаляется по клику, текст внутри инпута не мешается
        html += `<div class="chip" style="font-size: 11px; padding: 4px 8px; border-radius: 6px;">${t} <span style="margin-left:6px; color:var(--red); cursor:pointer;" onclick="event.stopPropagation(); removeExcludeHistoryItem('${safeT}')">✕</span></div>`;
    });
    container.innerHTML = html;
}

function removeExcludeHistoryItem(tag) {
    // Удаляем тег из активного массива
    excludeTagsHistory = excludeTagsHistory.filter(item => item !== tag);
    localStorage.setItem('pixivExcludeTagsHistory', JSON.stringify(excludeTagsHistory));
    
    // Обновляем строку для Java
    currentExcludeTags = excludeTagsHistory.join(', ');
    
    renderExcludeTagsHistory();
    renderActiveFilters();
}

// Функция addExcludeTagFromHistory больше не нужна, так как мы полностью перешли на чипсы! Можете её удалить.

function addExcludeTagFromHistory(tag) {
    let input = document.getElementById('excludeTagInput');
    if (!input) return;
    
    let current = input.value.split(',').map(t => t.trim()).filter(t => t !== '');
    if (!current.includes(tag)) {
        current.push(tag);
        input.value = current.join(', ');
    }
}


// За этой строчкой у вас должна идти функция setSearchMode(mode) { ... }
function setSearchMode(mode) {
    searchModeVal = mode;
    
    // Переключаем визуальное состояние таблетки
    document.querySelectorAll('#searchMode_illust, #searchMode_user').forEach(c => c.classList.remove('active'));
    let activeBtn = document.getElementById('searchMode_' + mode);
    if(activeBtn) activeBtn.classList.add('active');
    
    // Прячем фильтры (R-18, AI) и иконку воронки, если ищем авторов (к ним они не применяются)
    let filterBtn = document.getElementById('openFilterBtn');
    let activeFiltersZone = document.getElementById('activeSearchFilters');
    let expandPanel = document.getElementById('expandableFiltersPanel');
    
    if (mode === 'user') {
        if(filterBtn) filterBtn.style.display = 'none';
        if(activeFiltersZone) activeFiltersZone.style.display = 'none';
        // Если панель была открыта - закрываем её
        if(expandPanel) expandPanel.classList.remove('open');
    } else {
        if(filterBtn) filterBtn.style.display = 'flex';
        if(activeFiltersZone) activeFiltersZone.style.display = 'flex';
    }
    
    // Сразу запускаем поиск в новом режиме
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
            // Используем уже готовые стили карточки автора (из страницы деталей)
            div.className = 'author-card'; 
            div.style.marginTop = '0';
            div.style.borderTop = 'none';
            div.style.cursor = 'pointer';
            div.onclick = () => openAuthor(item.id, item.name);
            
            let avatar = item.avatar || 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
            div.innerHTML = `
                <img src="${avatar}" class="author-card-avatar">
                <div class="author-card-info">
                    <div class="author-card-name" style="color: var(--text);">${item.name.replace(/'/g, "\\'").replace(/"/g, '&quot;')}</div>
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

function viewOwnIllusts() { 
    tabScrollPositions['author'] = 0; 
    toggleSidebar(); 
    switchTab('author'); 
    document.getElementById('authorTitle').innerText = "Мои иллюстрации"; 
    document.getElementById('authorGrid').innerHTML = ""; // Очищаем старую сетку
    currentAuthorNextUrl = ""; 
    currentAuthorId = "self"; 
    isViewingBookmarks = false; 
    document.getElementById('loadMoreAuthorBtn').style.display = 'none'; // Прячем кнопку "Ещё"
    Android.getOwnIllusts(""); 
}

function viewBookmarks() { 
    tabScrollPositions['author'] = 0; 
    toggleSidebar(); 
    switchTab('author'); 
    document.getElementById('authorTitle').innerText = "Мои лайки"; 
    document.getElementById('authorGrid').innerHTML = ""; // Очищаем старую сетку
    currentAuthorNextUrl = ""; 
    currentAuthorId = "self"; 
    isViewingBookmarks = true; 
    document.getElementById('loadMoreAuthorBtn').style.display = 'none'; // Прячем кнопку "Ещё"
    Android.getBookmarks(""); 
}

function openAuthor(id, name) { 
    tabScrollPositions['author'] = 0; 
    switchTab('author'); 
    document.getElementById('authorTitle').innerText=name; 
    document.getElementById('authorGrid').innerHTML = ""; 
    currentAuthorNextUrl = ""; 
    currentAuthorId=id; 
    isViewingBookmarks=false; 
    document.getElementById('loadMoreAuthorBtn').style.display = 'none';
    Android.getAuthorIllusts(id, ""); 
}

function loadMoreAuthor() { 
    if(isViewingBookmarks) Android.getBookmarks(currentAuthorNextUrl); 
    else if (currentAuthorId === "self") Android.getOwnIllusts(currentAuthorNextUrl); 
    else Android.getAuthorIllusts(currentAuthorId, currentAuthorNextUrl); 
}

function displayAuthorIllusts(b64) {
    let data = JSON.parse(decodeB64Utf8(b64));
    
    if (loadingMiniGrid) {
        let grid = document.getElementById('detMiniGrid');
        if(grid) {
            grid.innerHTML = '';
            // Берем первые 8 работ автора, исключая текущую
            let filtered = data.results.filter(item => item.id !== currentIllustId).slice(0, 8);
            
            filtered.forEach(item => {
                let div = document.createElement('div');
                // Возвращаем класс search-item (для шиммера) и mini-item (для размеров в ленте)
                div.className = 'mini-item search-item'; 
                div.onclick = () => { openDetails(item.id); };
                
                // ВОЗВРАЩАЕМ ТВОЙ СТИЛЬ: используем buildItemHtml(item)
                // Эта функция сама создаст правильный HTML с лайками и кнопками
                div.innerHTML = buildItemHtml(item);
                
                grid.appendChild(div);
            });
            
            if (filtered.length === 0) grid.innerHTML = '<div class="text-sub" style="padding:16px;">Больше нет работ</div>';
        }
        loadingMiniGrid = false;
        requestRelatedIllustsSafe();
        return;
    }

    let grid = document.getElementById('authorGrid'); 
    if(!grid) return;
    currentAuthorNextUrl = data.next_url;
    if(data.results_for_logged_in_user) currentAuthorId = "self";
    data.results.forEach(item => {
        let div = document.createElement('div'); div.className = 'search-item';
        div.onclick = () => openDetails(item.id); div.innerHTML = buildItemHtml(item); grid.appendChild(div);
    });
    document.getElementById('loadMoreAuthorBtn').style.display = currentAuthorNextUrl ? 'block' : 'none';
}

// Добавлен скрытый параметр isBack (по умолчанию false)
function openDetails(id, isBack = false) {
    let activeTab = navHistory[navHistory.length - 1];
    
    // 1. УПРАВЛЕНИЕ ИСТОРИЕЙ
    if (activeTab === 'detail' && !isBack && currentIllustId && currentIllustId !== String(id)) {
        // Если мы уже в деталях и проваливаемся глубже — сохраняем текущий ID в стек
        detailHistoryStack.push(currentIllustId);
    } else if (activeTab !== 'detail' && !isBack) {
        // Если зашли снаружи (из поиска/главной) — сбрасываем глубокую историю
        detailHistoryStack = [];
    }

    tabScrollPositions['detail'] = 0;
    switchTab('detail'); 
    
    document.getElementById('detTitle').innerText="Загрузка..."; 
    document.getElementById('detImageContainer').innerHTML = "";
    document.getElementById('detImageContainer').className = "det-image-container"; 
    document.getElementById('detMiniGrid').innerHTML = "";
    
    let relatedGrid = document.getElementById('detRelatedGrid');
    if(relatedGrid) relatedGrid.innerHTML = "";
    let relatedBtn = document.getElementById('loadMoreRelatedBtn');
    if(relatedBtn) relatedBtn.style.display = "none";
    
    currentRelatedNextUrl = "";
    relatedRetryCount = 0; 

    document.getElementById('detAiTag').style.display = "none";
    document.getElementById('detViews').innerText = "0";
    document.getElementById('detBookmarks').innerText = "0";
    document.getElementById('detDate').innerText = "";
    
    document.getElementById('fillDetInline').style.width = '0%'; 
    document.getElementById('detProgressBg').style.display = 'none';
    
    currentIllustId = String(id); 
    currentIsBookmarked = false; 
    updateLikeUI(); 
    
    Android.getIllustDetails(currentIllustId);
}

function requestRelatedIllustsSafe() {
    if (pendingRelatedRequest) clearTimeout(pendingRelatedRequest);
    
    const checkDOM = () => {
        const container = document.getElementById('detImageContainer');
        const isDetailActive = document.getElementById('page-detail').classList.contains('active');
        if (container && container.children.length > 0 && currentIllustId && isDetailActive) {
            currentRelatedNextUrl = ""; 
            Android.getRelatedIllusts(currentIllustId, "");
            pendingRelatedRequest = null;
        } else {
            pendingRelatedRequest = setTimeout(checkDOM, 50);
        }
    };
    checkDOM();
}

function toggleBookmark() { 
    if(!currentIllustId) return; 
    currentIsBookmarked = !currentIsBookmarked; 
    updateLikeUI(); 
    
    let gridBtn = document.getElementById('gridLike_' + currentIllustId);
    if(gridBtn) {
        gridBtn.classList.toggle('liked', currentIsBookmarked);
        gridBtn.querySelector('use').setAttribute('href', currentIsBookmarked ? '#icon-heart' : '#icon-heart-outline');
    }
    Android.toggleBookmark(currentIllustId, currentIsBookmarked); 
}

function updateLikeUI() { 
    let btn = document.getElementById('detLikeBtn');
    if(!btn) return;
    btn.classList.toggle('liked', currentIsBookmarked); 
    document.getElementById('detLikeIcon').innerHTML = currentIsBookmarked ? '<use href="#icon-heart" xlink:href="#icon-heart"></use>' : '<use href="#icon-heart-outline" xlink:href="#icon-heart-outline"></use>'; 
}

function revertBookmarkUI(id, wasAdded) { 
    let willBe = !wasAdded;
    if (id === currentIllustId) {
        currentIsBookmarked = willBe; 
        updateLikeUI(); 
    }
    let gridBtn = document.getElementById('gridLike_' + id);
    if(gridBtn) {
        gridBtn.classList.toggle('liked', willBe);
        gridBtn.querySelector('use').setAttribute('href', willBe ? '#icon-heart' : '#icon-heart-outline');
    }
}

function showAllDetailImages() {
    document.getElementById('detImageContainer').classList.add('expanded');
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
    document.getElementById('detAuthorBtn').onclick = () => openAuthor(data.author_id, data.author);

    // ==========================================
    // НАСТРОЙКА КНОПКИ ПОДПИСКИ
    // ==========================================
    let followBtn = document.getElementById('detFollowBtn');
    if (followBtn) {
        // Красим кнопку в зависимости от того, подписаны мы уже или нет
        followBtn.classList.toggle('active', data.is_followed);
        followBtn.innerText = data.is_followed ? "Отписаться" : "Подписаться";
        
        // Вешаем вашу готовую функцию toggleFollowUser на клик
        followBtn.onclick = (e) => {
            e.stopPropagation(); // Чтобы случайно не открылся профиль
            toggleFollowUser(data.author_id, followBtn);
        };
    }
    // ==========================================
    // УМНЫЙ ПЕРЕВОД ТЕГОВ (С ПРИОРИТЕТОМ СЕРВЕРА PIXIV)
    // ==========================================
    const localDict = {
        'オリジナル': 'Ориджинал',
        '女の子': 'Девушки',
        '風景': 'Пейзажи',
        '初音ミク': 'Miku',
        '創作': 'Творчество',
        '落書き': 'Скетч',
        '美少女': 'Красавица'
    };

    let tHtml = ""; 
    data.tags.forEach(tag => {
        // ПРИОРИТЕТ: Сначала сервер (tag.trans), если пусто - локальный словарь, если и там пусто - ничего
        let transText = tag.trans || localDict[tag.name] || "";
        
        let displayTrans = transText ? `<span style="opacity: 0.6; font-size: 0.9em; margin-left: 4px;">(${transText})</span>` : '';
        
        tHtml += `<div class="tag-chip" onclick="document.getElementById('searchInput').value='${tag.name}'; switchTab('search'); startSearch(true);">#${tag.name}${displayTrans}</div>`;
    });
    document.getElementById('detTags').innerHTML = tHtml;
    // ==========================================
    // ГЕНЕРАЦИЯ КАРТИНОК (С УМНОЙ КНОПКОЙ ОБЛОЖКИ)
    // ==========================================
    // ==========================================
    // ГЕНЕРАЦИЯ КАРТИНОК (ОБЛОЖКА ВСЕГДА ЧИСТАЯ)
    // ==========================================
    detailImagesData = data.images;
    let origImagesData = data.original_images || data.images; // ДОСТАЕМ ОРИГИНАЛЫ
    
    let safeTitle = data.title ? data.title.replace(/'/g, "\\'").replace(/"/g, '&quot;') : "Без названия";
    let isMultiPage = data.images.length > 1;

    let imgH = `
    <div class="det-first-img" style="position:relative; width:100%; min-height:400px; background:#050505; display:flex; align-items:center; justify-content:center;">
        <img class="search-img" data-src="${data.images[0]}" style="max-width:100%; max-height:70vh; object-fit:contain;">
    </div>`;

    let listH = '';
    if (isMultiPage) {
        listH = `<div class="det-img-list">`;
        data.images.forEach((url, idx) => {
            // В onClick добавляем пятый параметр - '${origImagesData[idx]}'
            listH += `
            <div style="position:relative; width:100%; min-height:400px; background:#0A0A0A; margin-bottom: 2px;">
                <img class="search-img" data-src="${url}" style="width:100%; display:block; object-fit:contain;">
                <div class="quick-dl-btnPost" style="bottom:16px; right:16px; width:44px; height:44px; background:rgba(0,0,0,0.7); box-shadow: 0 4px 12px rgba(0,0,0,0.6);" onclick="event.stopPropagation(); Android.downloadPage(currentIllustId, ${idx}, '${safeTitle}', '${url}', '${origImagesData[idx]}'); showToast('Страница ${idx + 1} в очереди');">
                    <svg class="icon"><use href="#icon-dl" xlink:href="#icon-dl"></use></svg>
                </div>
            </div>`;
        });
        listH += `</div>`;
    }

    // 3. Кнопка "Показать всё"
    let overlayH = isMultiPage ? `<div class="show-all-overlay" onclick="showAllDetailImages()"><div class="show-all-btn">Показать всё (${data.images.length})</div></div>` : '';
    
    document.getElementById('detImageContainer').innerHTML = imgH + listH + overlayH;
    
    document.getElementById('detMiniGrid').innerHTML = '<div class="text-sub" style="padding:16px;">Загрузка...</div>';
    loadingMiniGrid = true;

    Android.getAuthorIllusts(data.author_id, "");
}

function loadMoreRelated() {
    if (currentIllustId) {
        Android.getRelatedIllusts(currentIllustId, currentRelatedNextUrl);
    }
}

function displayRelatedIllusts(b64) {
    let grid = document.getElementById('detRelatedGrid');
    let btn = document.getElementById('loadMoreRelatedBtn');
    if(!grid) return;
    
    try {
        let data = JSON.parse(decodeB64Utf8(b64)); 
        currentRelatedNextUrl = data.next_url;
        
        let addedCount = 0;
        if (data.results) {
            data.results.forEach(item => {
                if (String(item.id) !== String(currentIllustId) && !item.error) {
                    let div = document.createElement('div'); 
                    div.className = 'search-item';
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
        
        if (btn) btn.style.display = currentRelatedNextUrl ? 'block' : 'none';
    } catch (e) { 
        if (relatedRetryCount < 3) {
            relatedRetryCount++;
            setTimeout(() => {
                if (currentIllustId) Android.getRelatedIllusts(currentIllustId, "");
            }, 1000);
            return;
        }
        if (btn) btn.style.display = 'none'; 
    }
}

// ==========================================
// ЛОГИКА СЕНСОРНЫХ СВАЙПОВ (УМНАЯ МАРШРУТИЗАЦИЯ)
// ==========================================
let ptrStartY = 0;
let ptrCurrentY = 0;
let ptrStartX = 0;
let ptrCurrentX = 0;

let isPulling = false;
let isSwiping = false; // Для горизонтальных свайпов
let pullType = ''; // 'refresh', 'loadmore' или 'swipe'
let isBottomLoadingTriggered = false;
let swipeIgnored = false;

document.addEventListener('touchstart', (e) => {
    ptrStartY = e.touches[0].clientY;
    ptrCurrentY = ptrStartY;
    ptrStartX = e.touches[0].clientX;
    ptrCurrentX = ptrStartX;
    
    isPulling = false;
    isSwiping = false;
    pullType = '';

    // УМНАЯ БЛОКИРОВКА: Игнорируем переключение вкладок, если мы начали свайп внутри горизонтальной ленты или кнопок
    if (e.target.closest('.mini-grid-container, .filter-container, #activeSearchFilters, .theme-segmented, .det-img-list')) {
        swipeIgnored = true;
    } else {
        swipeIgnored = false;
    }
    
    // 1. Если мы в самом верху -> готовимся обновлять
    if (window.scrollY === 0) {
        isPulling = true;
        pullType = 'refresh';
    } 
    // 2. Если мы уперлись в самое дно страницы -> готовимся тянуть кнопку
    else if ((window.innerHeight + window.scrollY) >= document.body.offsetHeight - 15) {
        let activePage = document.querySelector('.page.active');
        let loadBtn = activePage ? activePage.querySelector('.btn-secondary[id*="loadMore"]') : null;
        
        if (loadBtn && loadBtn.style.display !== 'none' && !isBottomLoadingTriggered) {
            isPulling = true;
            pullType = 'loadmore';
            
            if (!loadBtn.querySelector('.scroll-filler')) {
                let filler = document.createElement('div');
                filler.className = 'scroll-filler';
                loadBtn.appendChild(filler);
            }
        }
    }
}, { passive: true });

document.addEventListener('touchmove', (e) => {
    ptrCurrentX = e.touches[0].clientX;
    ptrCurrentY = e.touches[0].clientY;
    
    let dy = ptrCurrentY - ptrStartY;
    let dx = ptrCurrentX - ptrStartX;

    // ЕСЛИ ПАЛЕЦ ПОШЕЛ ВБОК (Горизонтальный свайп имеет приоритет)
    if (!isSwiping && Math.abs(dx) > 15 && Math.abs(dx) > Math.abs(dy)) {
        isSwiping = true;
        isPulling = false; // Отменяем попытку pull-to-refresh
        pullType = 'swipe';
    }

    if (isSwiping) return; // Если свайпаем вбок, дальше код вертикальных пулов не выполняем

    // === ЕСЛИ ТЯНЕМ ВВЕРХ/ВНИЗ (ОРИГИНАЛЬНАЯ ЛОГИКА) ===
    if (!isPulling) return;
    
    if (pullType === 'refresh') {
        let ptrEl = document.getElementById('pull-to-refresh');
        if (dy > 0 && window.scrollY === 0) {
            if (ptrEl) {
                ptrEl.style.transition = 'none';
                let pullDistance = Math.min(dy * 0.4, 80); 
                ptrEl.style.transform = `translate(-50%, calc(-150% + ${pullDistance}px))`;
                ptrEl.style.opacity = Math.min(dy / 100, 1);
                let svg = ptrEl.querySelector('svg');
                if(svg) svg.style.transform = `rotate(${dy * 2}deg)`;
            }
        } else if (dy <= 0 && ptrEl) {
            ptrEl.style.transform = 'translate(-50%, -150%)';
            ptrEl.style.opacity = '0';
        }
    } 
    else if (pullType === 'loadmore') {
        let activePage = document.querySelector('.page.active');
        let loadBtn = activePage ? activePage.querySelector('.btn-secondary[id*="loadMore"]') : null;
        if (!loadBtn) return;
        
        let filler = loadBtn.querySelector('.scroll-filler');
        
        if (dy < 0 && !isBottomLoadingTriggered) {
            let pullDistance = Math.abs(dy);
            let progress = Math.min(100, (pullDistance / 120) * 100); 
            if (filler) filler.style.width = progress + '%';
            loadBtn.style.transform = `translateY(-${Math.min(pullDistance * 0.15, 15)}px)`;

            if (progress >= 100) {
                isBottomLoadingTriggered = true; 
                Android.hapticClick(); 
                loadBtn.click(); 
                
                thanosSnapElement(loadBtn, () => {
                    setTimeout(() => {
                        loadBtn.style.opacity = '1'; 
                        if (filler) filler.style.width = '0%';
                        loadBtn.style.transform = 'translateY(0)';
                        isBottomLoadingTriggered = false; 
                    }, 2000); 
                });
            }
        } else if (dy > 0 && !isBottomLoadingTriggered) {
            if (filler) filler.style.width = '0%';
            loadBtn.style.transform = 'translateY(0)';
        }
    }
}, { passive: true });

document.addEventListener('touchend', () => {
    let dy = ptrCurrentY - ptrStartY;
    let dx = ptrCurrentX - ptrStartX;
    
    // === ОБРАБОТКА ПЕРЕКЛЮЧЕНИЯ ВКЛАДОК СВАЙПАМИ ===
    if (isSwiping && !swipeIgnored && Math.abs(dx) > 70) {
        let currentTab = navHistory[navHistory.length - 1];
        let mainTabs = ['home', 'search', 'down']; // Порядок главных вкладок
        
        if (mainTabs.includes(currentTab)) {
            let currentIndex = mainTabs.indexOf(currentTab);
            
            if (dx < 0 && currentIndex < mainTabs.length - 1) {
                // Свайпнули влево (палец ушел влево) -> переключаем на вкладку правее
                switchTab(mainTabs[currentIndex + 1]);
            } else if (dx > 0 && currentIndex > 0) {
                // Свайпнули вправо (палец ушел вправо) -> переключаем на вкладку левее
                switchTab(mainTabs[currentIndex - 1]);
            }
        } else {
            // Если мы глубоко в приложении (в деталях или профиле), 
            // жест "Свайп от левого края" (до 60px от левой рамки) работает как кнопка "НАЗАД"
            if (dx > 70 && ptrStartX < 60) {
                goBack();
            }
        }
    }

    // === ЗАВЕРШЕНИЕ ВЕРТИКАЛЬНЫХ ПУЛЛОВ ===
    if (!isPulling) {
        isSwiping = false;
        pullType = '';
        return;
    }
    isPulling = false;
    
    if (pullType === 'refresh') {
        let ptrEl = document.getElementById('pull-to-refresh');
        if (ptrEl) {
            ptrEl.style.transition = 'transform 0.3s, opacity 0.3s';
            ptrEl.style.transform = 'translate(-50%, -150%)';
            ptrEl.style.opacity = '0';
        }
        if (dy > 120 && window.scrollY === 0) { 
            refreshCurrentPage();
        }
    } 
    else if (pullType === 'loadmore') {
        let activePage = document.querySelector('.page.active');
        let loadBtn = activePage ? activePage.querySelector('.btn-secondary[id*="loadMore"]') : null;
        if (loadBtn && !isBottomLoadingTriggered) {
            let filler = loadBtn.querySelector('.scroll-filler');
            if (filler) filler.style.width = '0%';
            loadBtn.style.transform = 'translateY(0)';
        }
    }
    pullType = '';
    isSwiping = false;
});

// ... Функция refreshCurrentPage() остаётся без изменений
// Умная функция, которая понимает, на какой мы вкладке, и обновляет только её
function refreshCurrentPage() {
    let currentTab = navHistory[navHistory.length - 1];
    showToast("Обновление...");
    
    if (currentTab === 'home') {
        loadRecommendations(true);
    } 
    else if (currentTab === 'search') {
        let q = document.getElementById('searchInput').value.trim();
        if(q) startSearch(true);
    } 
    else if (currentTab === 'manager') {
        Android.requestStorageInfo();
    } 
    else if (currentTab === 'author') {
        document.getElementById('authorGrid').innerHTML = ""; 
        if (typeof isViewingBookmarks !== 'undefined' && isViewingBookmarks) {
            Android.getBookmarks("");
        } else if (currentAuthorId === "self") {
            Android.getOwnIllusts("");
        } else {
            Android.getAuthorIllusts(currentAuthorId, "");
        }
    } 
    else if (currentTab === 'detail') {
        if (currentIllustId) openDetails(currentIllustId);
    } 
    else if (currentTab === 'down') {
        Android.checkAccount();
    }
}

// ==========================================
// ЛОГИКА ПЛАВАЮЩЕГО ОСТРОВКА ПОИСКА
// ==========================================
window.addEventListener('scroll', () => {
    let island = document.getElementById('floatingSearchIsland');
    if (!island) return;
    
    let isSearchActive = document.getElementById('page-search') && document.getElementById('page-search').classList.contains('active');
    
    if (isSearchActive && window.scrollY > 150) {
        let q = document.getElementById('searchInput').value.trim();
        document.getElementById('floatingSearchText').innerText = q ? q : 'Поиск...';
        island.classList.add('visible');
    } else {
        island.classList.remove('visible');
    }
}, { passive: true });

// ==========================================
// ЛОГИКА ИСТОРИИ, ТЕГОВ И ЖИВЫХ ПОДСКАЗОК PIXIV
// ==========================================
// ==========================================
// ЛОГИКА ИСТОРИИ, ТРЕНДОВ И ПОДСКАЗОК PIXIV
// ==========================================
let cachedTrendingTags = null; // Кешируем тренды, чтобы не грузить их при каждом тапе

function initSearchSuggestions() {
    let container = document.querySelector('#page-search .search-bar-container');
    if (!container || document.getElementById('searchSuggestions')) return;

    let suggestionsDiv = document.createElement('div');
    suggestionsDiv.id = 'searchSuggestions';
    suggestionsDiv.className = 'search-suggestions';
    suggestionsDiv.style.display = 'none';

    // Теперь блок частых тегов пустой, мы заполним его с сервера
    suggestionsDiv.innerHTML = `
        <div class="suggestions-section" id="historySection">
            <div class="suggestions-header"><span>История поиска</span> <span class="clear-history" onclick="clearSearchHistory()">Очистить</span></div>
            <div id="searchHistoryList"></div>
        </div>
        <div class="suggestions-section" id="popularTagsSection" style="margin-top: 20px;">
            <div class="suggestions-header"><span>В тренде на Pixiv</span></div>
            <div class="tags-container" id="trendingTagsContainer" style="padding: 4px 0; gap: 8px;">
                <div class="text-sub">Загрузка трендов...</div>
            </div>
        </div>
        <div class="suggestions-section" id="autocompleteSection" style="margin-top: 20px; display: none;">
            <div class="suggestions-header"><span>Подсказки</span></div>
            <div id="autocompleteList"></div>
        </div>
    `;
    
    let inputRow = container.querySelector('.search-input-row');
    if(inputRow) {
        inputRow.parentNode.insertBefore(suggestionsDiv, inputRow.nextSibling);
    } else {
        container.appendChild(suggestionsDiv);
    }

    let input = document.getElementById('searchInput');
    input.addEventListener('focus', () => {
        showSearchSuggestions();
        triggerAutocomplete(); 
        
        // Если тренды еще не скачаны - просим Java их загрузить
        if (!cachedTrendingTags) {
            Android.getTrendingTags();
        } else {
            renderTrendingTags();
        }
    });
    
    input.addEventListener('input', triggerAutocomplete);
    
    document.addEventListener('click', (e) => {
        if (!container.contains(e.target)) {
            hideSearchSuggestions();
        }
    });
}

// Получаем и рисуем ЖИВЫЕ ТРЕНДЫ
function displayTrendingTags(b64) {
    try {
        let data = JSON.parse(decodeB64Utf8(b64));
        if (data.trend_tags) {
            cachedTrendingTags = data.trend_tags;
            renderTrendingTags();
        }
    } catch(e) {}
}

function renderTrendingTags() {
    let container = document.getElementById('trendingTagsContainer');
    if (!container || !cachedTrendingTags) return;
    
    let html = '';
    cachedTrendingTags.forEach(item => {
        let tName = item.tag;
        let tTrans = item.translated_name; // Сервер сам дает перевод трендов!
        let safeQ = tName.replace(/'/g, "\\'").replace(/"/g, '&quot;');
        let displayTrans = tTrans ? `<span style="opacity: 0.6; font-size: 0.9em; margin-left: 4px;">(${tTrans})</span>` : '';
        
        html += `<div class="tag-chip" onclick="applySuggestion('${safeQ}')">#${tName}${displayTrans}</div>`;
    });
    container.innerHTML = html;
}

let autocompleteTimeout = null;
let activeAutocompleteTarget = 'searchInput'; // Какое поле ввода сейчас запрашивает подсказки

function triggerAutocomplete(targetId) {
    // Если функцию вызвал EventListener (например у главного поиска), задаем поиск по умолчанию
    if (typeof targetId !== 'string') targetId = 'searchInput';
    activeAutocompleteTarget = targetId;

    let input = document.getElementById(activeAutocompleteTarget);
    let val = input ? input.value.trim() : '';

    if (autocompleteTimeout) clearTimeout(autocompleteTimeout);
    
    if (!val) {
        if (activeAutocompleteTarget === 'searchInput') {
            document.getElementById('autocompleteSection').style.display = 'none';
            document.getElementById('popularTagsSection').style.display = 'block';
        } else {
            let el = document.getElementById('excludeAutocompleteSection');
            if(el) el.style.display = 'none';
        }
        return;
    }
    
    autocompleteTimeout = setTimeout(() => {
        Android.getAutocomplete(val);
    }, 400);
}

function displayAutocomplete(b64) {
    try {
        let data = JSON.parse(decodeB64Utf8(b64));
        let html = '';
        if (data.tags && data.tags.length > 0) {
            data.tags.forEach(tag => {
                let tName = tag.name;
                let tTrans = tag.translated_name; 
                let safeQ = tName.replace(/'/g, "\\'").replace(/"/g, '&quot;');
                let displayName = tTrans ? `${tName} <span style="opacity:0.6;font-size:0.9em;">(${tTrans})</span>` : tName;
                
                html += `<div class="suggestion-item" onclick="applySuggestion('${safeQ}')">
                    <div class="suggestion-text"><svg class="icon-sm" style="color:var(--subtext)"><use href="#icon-search"></use></svg> <span>${displayName}</span></div>
                </div>`;
            });
        } else {
            html = '<div class="text-sub" style="padding: 8px;">Нет подсказок</div>';
        }
        
        // Распределяем результаты в правильное меню
        if (activeAutocompleteTarget === 'excludeTagInput') {
            let container = document.getElementById('excludeAutocompleteSection');
            if (container) {
                container.innerHTML = html;
                container.style.display = 'block';
            }
        } else {
            let container = document.getElementById('autocompleteList');
            if (container) {
                container.innerHTML = html;
                document.getElementById('popularTagsSection').style.display = 'none';
                document.getElementById('autocompleteSection').style.display = 'block';
            }
        }
    } catch(e) {}
}

function applySuggestion(q) {
    if (activeAutocompleteTarget === 'excludeTagInput') {
        let input = document.getElementById('excludeTagInput');
        if (input) input.value = q;
        let el = document.getElementById('excludeAutocompleteSection');
        if (el) el.style.display = 'none';
        applyExcludeTags(); // Моментально добавляем тег в исключения
    } else {
        document.getElementById('searchInput').value = q;
        hideSearchSuggestions();
        startSearch(true);
    }
}
function saveSearchQuery(q) {
    if (!q) return;
    searchHistory = searchHistory.filter(item => item !== q);
    searchHistory.unshift(q);
    if (searchHistory.length > 5) searchHistory.pop();
    localStorage.setItem('pixivSearchHistory', JSON.stringify(searchHistory));
    renderSearchHistory();
}

function renderSearchHistory() {
    let list = document.getElementById('searchHistoryList');
    if(!list) return;
    
    if (searchHistory.length === 0) {
        list.innerHTML = '<div class="text-sub" style="padding: 8px;">История пуста</div>';
        return;
    }
    
    let html = '';
    searchHistory.forEach(q => {
        let safeQ = q.replace(/'/g, "\\'").replace(/"/g, '&quot;');
        // Заменили иконку истории на правильную (лупу или часы)
        html += `<div class="suggestion-item" onclick="applySuggestion('${safeQ}')">
            <div class="suggestion-text"><svg class="icon-sm" style="color:var(--subtext)"><use href="#icon-search"></use></svg> <span>${safeQ}</span></div>
            <div class="suggestion-remove" onclick="event.stopPropagation(); removeSearchHistoryItem('${safeQ}')"><svg class="icon-sm"><use href="#icon-close"></use></svg></div>
        </div>`;
    });
    list.innerHTML = html;
}

function removeSearchHistoryItem(q) {
    searchHistory = searchHistory.filter(item => item !== q);
    localStorage.setItem('pixivSearchHistory', JSON.stringify(searchHistory));
    renderSearchHistory();
}

function clearSearchHistory() {
    searchHistory = [];
    localStorage.setItem('pixivSearchHistory', JSON.stringify([]));
    renderSearchHistory();
}

function showSearchSuggestions() {
    renderSearchHistory();
    document.getElementById('searchSuggestions').style.display = 'block';
}

function hideSearchSuggestions() {
    setTimeout(() => {
        let el = document.getElementById('searchSuggestions');
        if(el) el.style.display = 'none';
    }, 150); 
}


// ==========================================
// ЛОГИКА ТЕМ ОФОРМЛЕНИЯ
// ==========================================
function setTheme(themeName) {
    document.body.classList.remove('theme-light', 'theme-oled');
    if (themeName !== 'dark') {
        document.body.classList.add('theme-' + themeName);
    }
    
    localStorage.setItem('pixivTheme', themeName);
    
    // Снимаем подсветку со всех кнопок
    ['Dark', 'Oled', 'Light'].forEach(t => {
        let btn = document.getElementById('btnTheme' + t);
        if (btn) btn.classList.remove('active');
    });
    
    // Добавляем красивую синюю подсветку активной кнопке
    let activeBtnName = 'btnTheme' + themeName.charAt(0).toUpperCase() + themeName.slice(1);
    let activeBtn = document.getElementById(activeBtnName);
    if (activeBtn) activeBtn.classList.add('active');
}

function initTheme() {
    let savedTheme = localStorage.getItem('pixivTheme') || 'dark';
    setTimeout(() => {
        setTheme(savedTheme);
    }, 100);
}


function openSearchFilterModal() {
    let overlay = document.getElementById('searchFilterOverlay');
    let modal = document.getElementById('searchFilterModal');
    if (overlay && modal) {
        overlay.classList.add('open');
        modal.classList.add('open');
    }
}

function closeSearchFilterModal() {
    let overlay = document.getElementById('searchFilterOverlay');
    let modal = document.getElementById('searchFilterModal');
    if (overlay && modal) {
        overlay.classList.remove('open');
        modal.classList.remove('open');
    }
}

// ==========================================
// ФИЗИЧЕСКИЙ ДВИЖОК РАСПАДА (Canvas 2D)
// ==========================================
// ==========================================
// ФИЗИЧЕСКИЙ ДВИЖОК РАСПАДА (Процедурный)
// ==========================================
function thanosSnapElement(element, onComplete) {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);

    // Создаем боевой холст поверх экрана
    const canvas = document.createElement('canvas');
    const padding = 1000; // Место для разлета частиц
    canvas.width = rect.width + padding * 2;
    canvas.height = rect.height + padding * 2;
    canvas.style.position = 'fixed';
    canvas.style.left = (rect.left - padding) + 'px';
    canvas.style.top = (rect.top - padding) + 'px';
    canvas.style.zIndex = '9999';
    canvas.style.pointerEvents = 'none';
    document.body.appendChild(canvas);

    const ctx = canvas.getContext('2d');
    const particles = [];
    
    // Берем цвет текста кнопки и фирменный синий Pixiv для акцентов
    const textColor = style.color !== 'rgba(0, 0, 0, 0)' ? style.color : '#FFFFFF';
    const accentColor = '#0096FA'; 

    // Генерируем 600 песчинок пепла случайным образом ВНУТРИ границ кнопки
    for (let i = 0; i < 600; i++) {
        particles.push({
            x: Math.random() * rect.width, // Случайная точка по ширине
            y: Math.random() * rect.height, // Случайная точка по высоте
            color: Math.random() > 0.2 ? textColor : accentColor, // 80% текста, 20% синих искр
            vx: (Math.random() - 0.5) * 3, // Разлет влево-вправо
            vy: (Math.random() - 1) * 1, // Резкий подскок вверх
            size: Math.random() * 0.9 + 0.5, // Разный размер песчинок (от 1 до 3.5 пикселей)
            life: Math.random() * 25 + 25, // Сколько кадров живет песчинка
            maxLife: 50
        });
    }

    // Прячем настоящую кнопку
    element.style.transition = 'none';
    element.style.opacity = '0';

    // Запускаем физику (60 кадров в секунду)
    function animate() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        let active = false;

        for(let i = 0; i < particles.length; i++) {
            let p = particles[i];
            if (p.life > 0) {
                active = true;
                
                // Двигаем частицу
                p.x += p.vx;
                p.y += p.vy;
                
                // Гравитация и ветер
                p.vy -= 0.01; // Антигравитация (пепел летит ВВЕРХ)
                p.vx *= 0.96; // Сопротивление воздуха (тормозит по горизонтали)
                
                p.life--;

                // Рисуем песчинку
                ctx.fillStyle = p.color;
                ctx.globalAlpha = p.life / p.maxLife; // Плавно растворяется
                
                ctx.beginPath();
                ctx.arc(p.x + padding, p.y + padding, p.size, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        if (active) {
            requestAnimationFrame(animate);
        } else {
            canvas.remove(); // Убираем холст, когда пыль осела
            if (onComplete) onComplete();
        }
    }
    requestAnimationFrame(animate);
}
// ==========================================
// ЛЕНИВАЯ ЗАГРУЗКА ИЗОБРАЖЕНИЙ (LAZY LOAD ENGINE)
// ==========================================
const lazyObserver = new IntersectionObserver((entries, observer) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            let img = entry.target;
            let src = img.getAttribute('data-src');
            
            if (src) {
                // Как только картинка скачалась - показываем её (плавный fade-in)
                img.onload = () => img.classList.add('loaded');
                // Даем команду на скачивание
                img.src = src;
                // Удаляем data-src, чтобы не грузить повторно
                img.removeAttribute('data-src');
            }
            // Перестаем следить за этой картинкой
            observer.unobserve(img);
        }
    });
}, { 
    // Начинаем загрузку за 300 пикселей до того, как картинка появится на экране
    rootMargin: '300px 0px' 
});

// Автоматически цепляем наблюдателя на все новые картинки, которые появляются на странице
const domObserver = new MutationObserver(() => {
    document.querySelectorAll('.search-img[data-src]').forEach(img => {
        lazyObserver.observe(img);
    });
});
domObserver.observe(document.body, { childList: true, subtree: true });

// ==========================================
// ЛОГИКА СТРАНИЦЫ ПОДПИСОК
// ==========================================
let currentFollowingNextUrl = "";

function openFollowing() {
    toggleSidebar(); // Закрываем левое выезжающее меню
    tabScrollPositions['following'] = 0; 
    switchTab('following'); // Переключаем вкладку
    
    document.getElementById('followingList').innerHTML = '<div class="text-sub" style="padding: 24px; text-align: center;">Загрузка авторов...</div>';
    document.getElementById('loadMoreFollowingBtn').style.display = 'none';
    currentFollowingNextUrl = "";
    
    // Отправляем запрос в Java на получение подписок
    Android.getFollowing(""); 
}

function loadMoreFollowing() {
    if (currentFollowingNextUrl) {
        Android.getFollowing(currentFollowingNextUrl);
    }
}

// Переключатель Подписаться / Отписаться
function toggleFollowUser(userId, btnElement) {
    let isFollowing = btnElement.classList.contains('active');
    let willFollow = !isFollowing;
    
    // Визуально меняем кнопку мгновенно
    btnElement.classList.toggle('active', willFollow);
    btnElement.innerText = willFollow ? "Отписаться" : "Подписаться";
    
    // Отправляем команду в Java (нужно добавить этот метод в Android)
    Android.toggleUserFollow(userId, willFollow);
}

// Отрисовка списка из Java
function displayFollowing(b64) {
    let container = document.getElementById('followingList');
    let btn = document.getElementById('loadMoreFollowingBtn');
    if(!container) return;
    
    try {
        let data = JSON.parse(decodeB64Utf8(b64)); 
        currentFollowingNextUrl = data.next_url;
        
        if (container.innerHTML.includes('Загрузка авторов...')) container.innerHTML = '';
        
        data.results.forEach(user => {
            let div = document.createElement('div');
            div.className = 'follow-block';
            
            let avatar = user.avatar || 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
            let safeName = user.name.replace(/'/g, "\\'").replace(/"/g, '&quot;');
            
            // 1. Генерируем ленту работ с использованием вашего универсального buildItemHtml
            let worksHtml = '';
            if (user.illusts && user.illusts.length > 0) {
                worksHtml += '<div class="mini-grid-container" style="padding-top: 0; margin-bottom: 12px;">';
                
                user.illusts.forEach(ill => {
                    // Используем классы 'mini-item' (для жесткого размера 140px) и 'search-item' (для шиммера).
                    // А внутрь просто вставляем всё то богатство, что генерирует buildItemHtml!
                    worksHtml += `
                        <div class="mini-item search-item" onclick="openDetails('${ill.id}')">
                            ${buildItemHtml(ill)}
                        </div>
                    `;
                });
                worksHtml += '</div>';
            } else {
                worksHtml = '<div class="text-sub" style="padding: 0 16px 16px 16px; font-size: 12px;">Нет публичных работ</div>';
            }

            // 2. Сборка всей карточки автора
            div.innerHTML = `
                <div class="follow-header">
                    <div class="follow-author" onclick="openAuthor('${user.id}', '${safeName}')">
                        <img src="${avatar}" class="follow-avatar">
                        <div class="follow-name">${user.name}</div>
                    </div>
                    <div class="follow-btn active" onclick="toggleFollowUser('${user.id}', this)">Отписаться</div>
                </div>
                ${worksHtml}
            `;
            container.appendChild(div);
        });
        
        if (data.results.length === 0 && !currentFollowingNextUrl) {
            container.innerHTML = '<div class="text-sub" style="padding: 24px; text-align: center;">У вас пока нет подписок</div>';
        }
        
        btn.style.display = currentFollowingNextUrl ? 'block' : 'none';
        
    } catch (e) {
        console.error(e);
        container.innerHTML = '<div class="text-sub" style="padding: 24px; text-align: center;">Ошибка разбора данных</div>';
    }
}

// ==========================================
// ЛОГИКА SMART CACHE (ОФФЛАЙН РАДИО)
// ==========================================
let scTargetCount = 50;
let scQuality = 'medium';
let scTestInterval = null; // Только для визуального теста

function setScCount(val) {
    document.querySelectorAll('[id^="scCount_"]').forEach(c => c.classList.remove('active'));
    document.getElementById('scCountBtn_custom').classList.remove('active');
    
    if (val === 'custom') {
        let input = document.getElementById('scCount_custom');
        scTargetCount = parseInt(input.value) || 50;
        document.getElementById('scCountBtn_custom').classList.add('active');
    } else {
        scTargetCount = val;
        document.getElementById('scCount_' + val).classList.add('active');
        document.getElementById('scCount_custom').style.display = 'none';
        document.getElementById('scCountBtn_custom').style.display = 'flex';
    }
}

function toggleCustomScCount() {
    document.getElementById('scCountBtn_custom').style.display = 'none';
    let input = document.getElementById('scCount_custom');
    input.style.display = 'block';
    input.focus();
}

function setScQuality(val) {
    scQuality = val;
    document.querySelectorAll('[id^="scQuality_"]').forEach(c => c.classList.remove('active'));
    document.getElementById('scQuality_' + val).classList.add('active');
}

function startSmartCacheUI() {
    document.getElementById('scSetupScreen').style.display = 'none';
    document.getElementById('scActiveScreen').style.display = 'block';
    document.getElementById('scProgressText').innerText = `0 / ${scTargetCount}`;
    document.getElementById('scProgressBar').style.width = '0%';
    
    // Запускаем реальный процесс в Java
    Android.startSmartCache(scTargetCount, scQuality);
}

function stopSmartCacheUI() {
    document.getElementById('scActiveScreen').style.display = 'none';
    document.getElementById('scSetupScreen').style.display = 'flex';
    document.getElementById('scFlyingContainer').innerHTML = ''; // Очищаем мусор
    
    // Останавливаем процесс в Java
    Android.stopSmartCache();
}

// Замените функцию updateSmartCacheProgress
function updateSmartCacheProgress(current, total, localUrl) {
    document.getElementById('scProgressText').innerText = `${current} / ${total}`;
    document.getElementById('scProgressBar').style.width = `${(current / total) * 100}%`;
    
    // Спавним картинку, используя прямой путь от нашего перехватчика
    if (localUrl && localUrl !== "") spawnFlyingArt(localUrl);
    
    if (current >= total) {
        setTimeout(() => {
            stopSmartCacheUI();
            showToast('Оффлайн пакет скачан!');
            Android.requestStorageInfo();
        }, 3000);
    }
}

// Замените начало функции openDetails:
function openDetails(id, isBack = false) {
    let activeTab = navHistory[navHistory.length - 1];
    
    // 1. УПРАВЛЕНИЕ ИСТОРИЕЙ
    if (activeTab === 'detail' && !isBack && currentIllustId && currentIllustId !== String(id)) {
        // Если мы уже в деталях и проваливаемся глубже — сохраняем текущий ID в стек
        detailHistoryStack.push(currentIllustId);
    } else if (activeTab !== 'detail' && !isBack) {
        // Если зашли снаружи (из поиска/главной) — сбрасываем глубокую историю
        detailHistoryStack = [];
    }

    tabScrollPositions['detail'] = 0;
    
    // ==========================================
    // ИСПРАВЛЕНИЕ: МОМЕНТАЛЬНЫЙ ПРЫЖОК
    // ==========================================
    if (activeTab === 'detail') {
        // Если мы уже в работе, просто моментально прыгаем в начало без анимации
        window.scrollTo(0, 0); 
    } else {
        // Если пришли из другой вкладки, переключаем как обычно
        switchTab('detail'); 
    }
    
    document.getElementById('detTitle').innerText="Загрузка..."; 
    document.getElementById('detImageContainer').innerHTML = "";
    document.getElementById('detImageContainer').className = "det-image-container"; 
    document.getElementById('detMiniGrid').innerHTML = "";
    
    let relatedGrid = document.getElementById('detRelatedGrid');
    if(relatedGrid) relatedGrid.innerHTML = "";
    let relatedBtn = document.getElementById('loadMoreRelatedBtn');
    if(relatedBtn) relatedBtn.style.display = "none";
    
    currentRelatedNextUrl = "";
    relatedRetryCount = 0; 

    document.getElementById('detAiTag').style.display = "none";
    document.getElementById('detViews').innerText = "0";
    document.getElementById('detBookmarks').innerText = "0";
    document.getElementById('detDate').innerText = "";
    
    document.getElementById('fillDetInline').style.width = '0%'; 
    document.getElementById('detProgressBg').style.display = 'none';
    
    currentIllustId = String(id); 
    currentIsBookmarked = false; 
    updateLikeUI(); 
    
    // ВОТ ТУТ РАЗВИЛКА ДЛЯ ОФФЛАЙНА
    if (currentIllustId === 'offline_cache') {
        document.getElementById('detLikeBtn').style.display = 'none'; // Убираем лайк
        Android.getOfflineDetails();
    } else {
        document.getElementById('detLikeBtn').style.display = 'flex';
        Android.getIllustDetails(currentIllustId);
    }
}

// Функция спавна (ее будет вызывать Java, передавая base64 скачанной картинки)
function spawnFlyingArt(imgSrc) {
    let container = document.getElementById('scFlyingContainer');
    if (!container) return;
    
    let img = document.createElement('img');
    img.src = imgSrc;
    img.className = 'flying-art';
    
    // Генерируем случайную физику (CSS переменные)
    let size = 120 + Math.random() * 150; // Размер от 120px до 270px
    let startX = -50 + Math.random() * 100; // Смещение по X (от -50vw до 50vw)
    let endX = startX + (-30 + Math.random() * 60); // Куда уплывет по X
    let startRot = -20 + Math.random() * 40; // Начальный поворот
    let endRot = startRot + (-30 + Math.random() * 60); // Конечный поворот
    let duration = 6 + Math.random() * 6; // Лететь будет от 6 до 12 секунд
    let maxOp = 0.15 + Math.random() * 0.25; // Полупрозрачность (15-40%)
    
    // Применяем переменные
    img.style.width = `${size}px`;
    img.style.height = `${size}px`; // Квадратные
    img.style.left = `${10 + Math.random() * 80}%`; // Случайная точка старта
    
    img.style.setProperty('--start-x', `${startX}vw`);
    img.style.setProperty('--end-x', `${endX}vw`);
    img.style.setProperty('--start-rot', `${startRot}deg`);
    img.style.setProperty('--end-rot', `${endRot}deg`);
    img.style.setProperty('--scale', Math.random() > 0.5 ? '1' : '0.8');
    img.style.setProperty('--duration', `${duration}s`);
    img.style.setProperty('--max-opacity', maxOp);
    
    container.appendChild(img);
    
    // Самоуничтожение тега после конца анимации (чтобы не забить оперативку)
    setTimeout(() => {
        if (img.parentNode) img.parentNode.removeChild(img);
    }, duration * 1000);
}

// ==========================================
// OTA ОБНОВЛЕНИЯ ЧЕРЕЗ GITHUB
// ==========================================
// Замените YOUR_USERNAME/YOUR_REPO на ваши данные GitHub!
const GITHUB_REPO_URL = 'https://raw.githubusercontent.com/YsHalk1/PixivDL/main/';
const CURRENT_BASE_VERSION = 1; 
let updateFilesQueue = [];
let updateFilesDownloaded = 0;

function checkForAppUpdates() {
    let updateUrl = GITHUB_REPO_URL + 'update.json?t=' + new Date().getTime();
    
    fetch(updateUrl)
        .then(response => {
            if (!response.ok) throw new Error('Файл update.json не найден');
            return response.json();
        })
        .then(data => {
            let localVersion = parseInt(localStorage.getItem('ota_version')) || CURRENT_BASE_VERSION;
            
            if (data.version > localVersion) {
                showToast(`Найдено обновление v${data.version}! Качаем...`);
                updateFilesQueue = data.files;
                updateFilesDownloaded = 0;
                
                // СОХРАНЯЕМ ВЕРСИЮ И ЧЕЙНДЖЛОГ ВО ВРЕМЕННУЮ ПАМЯТЬ
                localStorage.setItem('pending_ota_version', data.version);
                if (data.changelog) {
                    // Если это массив (как в новом красивом формате), склеиваем его через перенос строки
                    let changelogText = Array.isArray(data.changelog) ? data.changelog.join('\n') : data.changelog;
                    localStorage.setItem('pending_changelog', changelogText);
                }
                
                data.files.forEach(fileName => {
                    let fileUrl = GITHUB_REPO_URL + fileName + '?t=' + new Date().getTime();
                    Android.downloadAppUpdateFile(fileName, fileUrl);
                });
            }
        })
        .catch(e => {
            console.log('OTA Error: ', e);
        });
}

function updateFileDownloaded(fileName) {
    updateFilesDownloaded++;
    if (updateFilesDownloaded >= updateFilesQueue.length) {
        // КОГДА ВСЁ СКАЧАЛОСЬ - ПРИМЕНЯЕМ ВЕРСИЮ
        localStorage.setItem('ota_version', localStorage.getItem('pending_ota_version'));
        showToast('Обновление установлено! Перезапуск...');
        setTimeout(() => {
            location.reload(); 
        }, 1500);
    }
}

function updateFileFailed(fileName) {
    console.log('Не удалось скачать обновление для: ' + fileName);
}

// ==========================================
// ОКНО СПИСКА ИЗМЕНЕНИЙ (CHANGELOG)
// ==========================================
function showChangelogModal(title, text) {
    // Если окна еще нет в HTML, создаем его на лету
    if (!document.getElementById('changelogModal')) {
        let html = `
            <div class="modal-overlay" id="changelogOverlay" onclick="closeChangelogModal()"></div>
            <div class="custom-modal" id="changelogModal" style="max-height: 80vh; overflow-y: auto;">
                <h3 id="changelogTitle" style="margin-top:0; margin-bottom:16px; font-size: 18px; color: var(--pixiv-blue);"></h3>
                <div id="changelogText" style="font-size: 14px; color: var(--subtext); line-height: 1.5; margin-bottom: 24px;"></div>
                <button class="btn-main" style="margin-top: 0; padding: 12px; font-size: 16px;" onclick="closeChangelogModal()">Понятно, спасибо!</button>
            </div>
        `;
        document.body.insertAdjacentHTML('beforeend', html);
    }
    
    document.getElementById('changelogTitle').innerText = title;
    // Заменяем технические переносы строк \n на HTML-теги <br>, чтобы текст был с абзацами
    document.getElementById('changelogText').innerHTML = text.replace(/\n/g, '<br>');
    
    // Показываем с красивой анимацией
    document.getElementById('changelogOverlay').classList.add('open');
    document.getElementById('changelogModal').classList.add('open');
}

function closeChangelogModal() {
    let overlay = document.getElementById('changelogOverlay');
    let modal = document.getElementById('changelogModal');
    if(overlay) overlay.classList.remove('open');
    if(modal) modal.classList.remove('open');
}
