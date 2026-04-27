import i18next from "./vendor/i18next.js";
import initWasm, {
    decode_qr_from_rgba,
    generate_qr_png_data_url,
    generate_qr_svg,
} from "./wasm/wasm_qr.js";

const STORAGE_KEY = "qrtool.browser.extension.state";
const HISTORY_LIMIT = 40;
const CAMERA_SCAN_INTERVAL_MS = 180;

const DEFAULT_STATE = {
    language: "vi",
    theme: "system",
    history: [],
    generate: {
        content: "",
        size: 512,
        dark: "#111111",
        light: "#ffffff",
    },
    camera: {
        autoStopOnFirst: true,
        preferredDeviceId: "",
    },
};

const ui = {};
let state = structuredClone(DEFAULT_STATE);
let wasmReady = false;
let latestSvgContent = "";
const cameraState = {
    stream: null,
    loopTimer: null,
    scanBusy: false,
    running: false,
    canvasContext: null,
    lastDecodedText: "",
};

const systemThemeMedia = window.matchMedia("(prefers-color-scheme: dark)");

document.addEventListener("DOMContentLoaded", () => {
    void bootstrap();
});

async function bootstrap() {
    cacheElements();
    bindEvents();

    setStatus(t("status.initial"));

    state = await loadState();
    await initializeI18n(state.language);
    applyTranslations();
    applyTheme(state.theme);
    hydrateControls();
    renderHistory();
    await handleRefreshCameraDevices(false);

    await initializeWasm();
}

function cacheElements() {
    ui.tabs = Array.from(document.querySelectorAll(".tab"));
    ui.panels = Array.from(document.querySelectorAll(".panel"));
    ui.status = document.getElementById("status");

    ui.generateInput = document.getElementById("generate-input");
    ui.generateSize = document.getElementById("generate-size");
    ui.generateSizeValue = document.getElementById("generate-size-value");
    ui.generateDark = document.getElementById("generate-dark");
    ui.generateLight = document.getElementById("generate-light");
    ui.generateButton = document.getElementById("generate-button");
    ui.generatedImage = document.getElementById("generated-image");
    ui.generateEmpty = document.getElementById("generate-empty");
    ui.downloadPng = document.getElementById("download-png");
    ui.downloadSvg = document.getElementById("download-svg");

    ui.decodeFile = document.getElementById("decode-file");
    ui.decodeButton = document.getElementById("decode-button");
    ui.decodeOutput = document.getElementById("decode-output");

    ui.cameraDevice = document.getElementById("camera-device");
    ui.cameraRefresh = document.getElementById("camera-refresh");
    ui.cameraStart = document.getElementById("camera-start");
    ui.cameraStop = document.getElementById("camera-stop");
    ui.cameraAutoStop = document.getElementById("camera-auto-stop");
    ui.cameraVideo = document.getElementById("camera-video");
    ui.cameraCanvas = document.getElementById("camera-canvas");
    ui.cameraHint = document.getElementById("camera-hint");
    ui.cameraOutput = document.getElementById("camera-output");

    ui.verifyUrl = document.getElementById("verify-url");
    ui.verifyButton = document.getElementById("verify-button");
    ui.verifyResult = document.getElementById("verify-result");

    ui.historyList = document.getElementById("history-list");
    ui.clearHistory = document.getElementById("clear-history");

    ui.languageSelect = document.getElementById("language-select");
    ui.themeSelect = document.getElementById("theme-select");
}

function bindEvents() {
    ui.tabs.forEach((button) => {
        button.addEventListener("click", () => selectTab(button.dataset.tabTarget));
    });

    ui.generateSize.addEventListener("input", () => {
        ui.generateSizeValue.textContent = String(Number(ui.generateSize.value));
    });

    ui.generateButton.addEventListener("click", () => {
        void handleGenerate();
    });

    ui.downloadPng.addEventListener("click", () => {
        const dataUrl = ui.generatedImage.getAttribute("src");
        if (!dataUrl) {
            setStatus(t("status.downloadMissing"), true);
            return;
        }

        downloadFromDataUrl(dataUrl, `qr-${Date.now()}.png`);
    });

    ui.downloadSvg.addEventListener("click", () => {
        if (!latestSvgContent) {
            setStatus(t("status.downloadMissing"), true);
            return;
        }

        const blob = new Blob([latestSvgContent], { type: "image/svg+xml" });
        downloadFromBlob(blob, `qr-${Date.now()}.svg`);
    });

    ui.decodeButton.addEventListener("click", () => {
        void handleDecode();
    });

    ui.cameraRefresh.addEventListener("click", () => {
        void handleRefreshCameraDevices(true);
    });

    ui.cameraStart.addEventListener("click", () => {
        void handleStartCamera();
    });

    ui.cameraStop.addEventListener("click", () => {
        void handleStopCamera(true);
    });

    ui.cameraDevice.addEventListener("change", () => {
        state.camera.preferredDeviceId = ui.cameraDevice.value || "";
        void persistState();
    });

    ui.cameraAutoStop.addEventListener("change", () => {
        state.camera.autoStopOnFirst = Boolean(ui.cameraAutoStop.checked);
        void persistState();
    });

    ui.verifyButton.addEventListener("click", () => {
        void handleVerify();
    });

    ui.clearHistory.addEventListener("click", () => {
        state.history = [];
        renderHistory();
        void persistState();
        setStatus(t("status.historyCleared"), false, true);
    });

    ui.languageSelect.addEventListener("change", async () => {
        state.language = ui.languageSelect.value === "en" ? "en" : "vi";
        await i18next.changeLanguage(state.language);
        applyTranslations();
        await handleRefreshCameraDevices(false);
        renderHistory();
        await persistState();
        setStatus(t("status.settingsSaved"), false, true);
    });

    ui.themeSelect.addEventListener("change", () => {
        state.theme = normalizeTheme(ui.themeSelect.value);
        applyTheme(state.theme);
        void persistState();
        setStatus(t("status.settingsSaved"), false, true);
    });

    systemThemeMedia.addEventListener("change", () => {
        if (state.theme === "system") {
            applyTheme("system");
        }
    });

    document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
            void handleStopCamera(false);
        }
    });

    window.addEventListener("beforeunload", () => {
        void handleStopCamera(false);
    });
}

async function initializeI18n(language) {
    const resources = await loadLocaleResources();

    await i18next.init({
        lng: language === "en" ? "en" : "vi",
        fallbackLng: "vi",
        resources: {
            vi: { translation: resources.vi },
            en: { translation: resources.en },
        },
        interpolation: {
            escapeValue: false,
        },
    });
}

async function loadLocaleResources() {
    const [viResp, enResp] = await Promise.all([
        fetch("./locales/vi.json"),
        fetch("./locales/en.json"),
    ]);

    if (!viResp.ok || !enResp.ok) {
        throw new Error("Cannot load locale resources.");
    }

    return {
        vi: await viResp.json(),
        en: await enResp.json(),
    };
}

async function initializeWasm() {
    setStatus(t("status.loadingWasm"));

    try {
        const wasmModuleUrl = new URL("./wasm/wasm_qr_bg.wasm", import.meta.url);
        await initWasm({ module_or_path: wasmModuleUrl });
        wasmReady = true;
        setStatus(t("status.wasmReady"), false, true);
    } catch (error) {
        wasmReady = false;
        setStatus(t("status.wasmFailed", { error: formatError(error) }), true);
    }
}

function applyTranslations() {
    document.documentElement.lang = i18next.language;

    document.querySelectorAll("[data-i18n]").forEach((node) => {
        const key = node.dataset.i18n;
        if (key) {
            node.textContent = t(key);
        }
    });

    document.querySelectorAll("[data-i18n-placeholder]").forEach((node) => {
        const key = node.dataset.i18nPlaceholder;
        if (key && "placeholder" in node) {
            node.placeholder = t(key);
        }
    });

    if (!ui.decodeOutput.value.trim()) {
        ui.decodeOutput.value = "";
    }
}

function hydrateControls() {
    ui.generateInput.value = state.generate.content;
    ui.generateSize.value = String(state.generate.size);
    ui.generateSizeValue.textContent = String(state.generate.size);
    ui.generateDark.value = state.generate.dark;
    ui.generateLight.value = state.generate.light;
    ui.cameraAutoStop.checked = state.camera.autoStopOnFirst;

    ui.languageSelect.value = state.language;
    ui.themeSelect.value = state.theme;
}

function selectTab(tabName) {
    ui.tabs.forEach((button) => {
        button.classList.toggle("active", button.dataset.tabTarget === tabName);
    });

    ui.panels.forEach((panel) => {
        panel.classList.toggle("active", panel.dataset.tab === tabName);
    });

    if (tabName !== "camera" && cameraState.running) {
        void handleStopCamera(false);
    }
}

async function handleGenerate() {
    if (!wasmReady) {
        setStatus(t("status.wasmFailed", { error: "WASM not ready" }), true);
        return;
    }

    const content = ui.generateInput.value.trim();
    if (!content) {
        setStatus(t("status.needInput"), true);
        return;
    }

    const size = Number(ui.generateSize.value);
    const dark = ui.generateDark.value;
    const light = ui.generateLight.value;

    setStatus(t("status.generating"));

    try {
        const pngDataUrl = generate_qr_png_data_url(content, size, dark, light);
        latestSvgContent = generate_qr_svg(content, dark, light);

        ui.generatedImage.src = pngDataUrl;
        ui.generatedImage.hidden = false;
        ui.generateEmpty.hidden = true;

        state.generate = { content, size, dark, light };
        pushHistory("generate", content, `PNG ${size}px`);
        await persistState();

        setStatus(t("status.generateSuccess"), false, true);
    } catch (error) {
        setStatus(t("status.genericError", { error: formatError(error) }), true);
    }
}

async function handleDecode() {
    if (!wasmReady) {
        setStatus(t("status.wasmFailed", { error: "WASM not ready" }), true);
        return;
    }

    const file = ui.decodeFile.files?.[0];
    if (!file) {
        setStatus(t("status.chooseFile"), true);
        return;
    }

    try {
        const imageData = await fileToImageData(file);
        const decoded = decode_qr_from_rgba(
            imageData.width,
            imageData.height,
            new Uint8Array(imageData.data),
        );

        if (decoded == null) {
            ui.decodeOutput.value = t("read.notFound");
            setStatus(t("status.decodeNotFound"), true);
            return;
        }

        const decodedText = String(decoded);
        ui.decodeOutput.value = decodedText;

        pushHistory("decode", file.name, decodedText);
        await persistState();

        setStatus(t("status.decodeSuccess"), false, true);
    } catch (error) {
        setStatus(t("status.genericError", { error: formatError(error) }), true);
    }
}

async function handleRefreshCameraDevices(showStatus = true) {
    if (!cameraSupported()) {
        if (showStatus) {
            setStatus(t("status.cameraUnsupported"), true);
        }

        return [];
    }

    try {
        const devices = await refreshCameraDevices();
        if (!devices.length && showStatus) {
            setStatus(t("status.cameraNoDevice"), true);
        } else if (showStatus) {
            setStatus(t("status.cameraRefreshDone"), false, true);
        }

        return devices;
    } catch (error) {
        if (showStatus) {
            setStatus(t("status.cameraStartFailed", { error: formatCameraError(error) }), true);
        }

        return [];
    }
}

async function handleStartCamera() {
    if (!wasmReady) {
        setStatus(t("status.wasmFailed", { error: "WASM not ready" }), true);
        return;
    }

    if (!cameraSupported()) {
        setStatus(t("status.cameraUnsupported"), true);
        return;
    }

    await handleStopCamera(false);
    const availableDevices = await handleRefreshCameraDevices(false);
    if (!availableDevices.length) {
        setStatus(t("status.cameraNoDevice"), true);
        return;
    }

    setStatus(t("status.cameraStarting"));

    try {
        const preferredDeviceId = ui.cameraDevice.value || state.camera.preferredDeviceId;
        const stream = await requestCameraStream(preferredDeviceId);

        cameraState.stream = stream;
        cameraState.running = true;
        cameraState.scanBusy = false;
        cameraState.lastDecodedText = "";
        cameraState.canvasContext = null;

        ui.cameraVideo.srcObject = stream;
        ui.cameraHint.hidden = true;
        ui.cameraOutput.value = "";
        await ui.cameraVideo.play().catch(() => { });

        const activeTrack = stream.getVideoTracks()[0];
        const activeDeviceId = activeTrack?.getSettings?.().deviceId;
        if (activeDeviceId) {
            state.camera.preferredDeviceId = activeDeviceId;
            if (Array.from(ui.cameraDevice.options).some((option) => option.value === activeDeviceId)) {
                ui.cameraDevice.value = activeDeviceId;
            }
        }

        state.camera.autoStopOnFirst = Boolean(ui.cameraAutoStop.checked);
        await persistState();

        startCameraLoop();
        setStatus(t("status.cameraStarted"), false, true);
    } catch (error) {
        await handleStopCamera(false);

        const cameraError = formatCameraError(error);
        const isPermissionError =
            error?.name === "NotAllowedError" || error?.name === "PermissionDeniedError";
        const isNoDeviceError =
            error?.name === "NotFoundError" || error?.name === "OverconstrainedError";

        if (isPermissionError) {
            setStatus(t("status.cameraPermissionDenied"), true);
        } else if (isNoDeviceError) {
            setStatus(t("status.cameraNoDevice"), true);
        } else {
            setStatus(t("status.cameraStartFailed", { error: cameraError }), true);
        }
    }
}

async function handleStopCamera(showStatus = true) {
    if (cameraState.loopTimer) {
        clearTimeout(cameraState.loopTimer);
        cameraState.loopTimer = null;
    }

    cameraState.running = false;
    cameraState.scanBusy = false;
    cameraState.lastDecodedText = "";
    cameraState.canvasContext = null;

    if (cameraState.stream) {
        for (const track of cameraState.stream.getTracks()) {
            track.stop();
        }
    }

    cameraState.stream = null;
    ui.cameraVideo.srcObject = null;
    ui.cameraHint.hidden = false;

    if (showStatus) {
        setStatus(t("status.cameraStopped"), false, true);
    }
}

async function refreshCameraDevices() {
    const previousDeviceId = ui.cameraDevice.value || state.camera.preferredDeviceId || "";
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameraDevices = devices.filter((device) => device.kind === "videoinput");

    ui.cameraDevice.innerHTML = "";

    if (!cameraDevices.length) {
        const option = document.createElement("option");
        option.value = "";
        option.textContent = t("camera.noDeviceOption");
        ui.cameraDevice.append(option);
        state.camera.preferredDeviceId = "";
        return cameraDevices;
    }

    cameraDevices.forEach((device, index) => {
        const option = document.createElement("option");
        option.value = device.deviceId;
        option.textContent =
            device.label?.trim() ||
            (index === 0
                ? t("camera.defaultDevice")
                : t("camera.deviceItem", { index: index + 1 }));
        ui.cameraDevice.append(option);
    });

    const selectedDeviceId = cameraDevices.some((device) => device.deviceId === previousDeviceId)
        ? previousDeviceId
        : cameraDevices[0].deviceId;

    ui.cameraDevice.value = selectedDeviceId;
    state.camera.preferredDeviceId = selectedDeviceId;
    return cameraDevices;
}

async function requestCameraStream(preferredDeviceId) {
    const constraintsQueue = [];
    if (preferredDeviceId) {
        constraintsQueue.push({
            video: { deviceId: { exact: preferredDeviceId } },
            audio: false,
        });
    }

    constraintsQueue.push({
        video: { facingMode: "environment" },
        audio: false,
    });

    constraintsQueue.push({ video: true, audio: false });

    let lastError;
    for (const constraints of constraintsQueue) {
        try {
            return await navigator.mediaDevices.getUserMedia(constraints);
        } catch (error) {
            lastError = error;
        }
    }

    throw lastError ?? new Error("Unable to get camera stream.");
}

function startCameraLoop() {
    if (cameraState.loopTimer) {
        clearTimeout(cameraState.loopTimer);
        cameraState.loopTimer = null;
    }

    const tick = async () => {
        if (!cameraState.running) {
            return;
        }

        if (!cameraState.scanBusy) {
            cameraState.scanBusy = true;
            try {
                await scanCameraFrame();
            } catch (error) {
                setStatus(t("status.genericError", { error: formatError(error) }), true);
            } finally {
                cameraState.scanBusy = false;
            }
        }

        if (cameraState.running) {
            cameraState.loopTimer = window.setTimeout(() => {
                void tick();
            }, CAMERA_SCAN_INTERVAL_MS);
        }
    };

    cameraState.loopTimer = window.setTimeout(() => {
        void tick();
    }, CAMERA_SCAN_INTERVAL_MS);
}

async function scanCameraFrame() {
    if (!cameraState.running || !cameraState.stream) {
        return;
    }

    const video = ui.cameraVideo;
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        return;
    }

    const frameWidth = video.videoWidth;
    const frameHeight = video.videoHeight;
    if (!frameWidth || !frameHeight) {
        return;
    }

    if (ui.cameraCanvas.width !== frameWidth || ui.cameraCanvas.height !== frameHeight) {
        ui.cameraCanvas.width = frameWidth;
        ui.cameraCanvas.height = frameHeight;
    }

    if (!cameraState.canvasContext) {
        cameraState.canvasContext = ui.cameraCanvas.getContext("2d", { willReadFrequently: true });
        if (!cameraState.canvasContext) {
            throw new Error("Cannot acquire camera canvas context.");
        }
    }

    cameraState.canvasContext.drawImage(video, 0, 0, frameWidth, frameHeight);
    const imageData = cameraState.canvasContext.getImageData(0, 0, frameWidth, frameHeight);
    const decoded = decode_qr_from_rgba(frameWidth, frameHeight, new Uint8Array(imageData.data));

    if (decoded == null) {
        return;
    }

    const decodedText = String(decoded).trim();
    if (!decodedText || decodedText === cameraState.lastDecodedText) {
        return;
    }

    cameraState.lastDecodedText = decodedText;
    ui.cameraOutput.value = decodedText;

    pushHistory("decode", t("camera.historySource"), decodedText);
    await persistState();
    setStatus(t("status.cameraDecodeSuccess"), false, true);

    if (ui.cameraAutoStop.checked) {
        await handleStopCamera(false);
        setStatus(t("status.cameraAutoStopped"), false, true);
    }
}

function cameraSupported() {
    return Boolean(
        navigator.mediaDevices &&
        typeof navigator.mediaDevices.getUserMedia === "function" &&
        typeof navigator.mediaDevices.enumerateDevices === "function",
    );
}

function formatCameraError(error) {
    if (!error) {
        return "unknown camera error";
    }

    if (typeof error === "string") {
        return error;
    }

    if (error?.name && error?.message) {
        return `${error.name}: ${error.message}`;
    }

    return formatError(error);
}

async function handleVerify() {
    let rawUrl = ui.verifyUrl.value.trim();

    if (!rawUrl) {
        setStatus(t("status.invalidUrl"), true);
        return;
    }

    if (!/^https?:\/\//i.test(rawUrl)) {
        rawUrl = `https://${rawUrl}`;
    }

    let url;
    try {
        url = new URL(rawUrl);
    } catch (_error) {
        setStatus(t("status.invalidUrl"), true);
        return;
    }

    setStatus(t("status.verifying"));

    try {
        const probe = await probeLink(url.toString());
        if (probe.ok) {
            const message = t("verify.ok", { status: probe.status });
            ui.verifyResult.textContent = message;
            pushHistory("verify", url.toString(), message);
            setStatus(t("status.verifySuccess"), false, true);
        } else {
            const message = t("verify.fail", { reason: probe.reason });
            ui.verifyResult.textContent = message;
            pushHistory("verify", url.toString(), message);
            setStatus(message, true);
        }

        await persistState();
    } catch (error) {
        const message = t("verify.fail", { reason: formatError(error) });
        ui.verifyResult.textContent = message;
        setStatus(message, true);
    }
}

function pushHistory(kind, input, output) {
    const entry = {
        id: crypto.randomUUID(),
        kind,
        input: compactText(input, 140),
        output: compactText(output, 220),
        at: new Date().toISOString(),
    };

    state.history.unshift(entry);
    state.history = state.history.slice(0, HISTORY_LIMIT);
    renderHistory();
}

function renderHistory() {
    ui.historyList.innerHTML = "";

    if (!state.history.length) {
        const item = document.createElement("li");
        item.className = "history-item";
        item.textContent = t("history.empty");
        ui.historyList.appendChild(item);
        return;
    }

    const formatter = new Intl.DateTimeFormat(i18next.language === "vi" ? "vi-VN" : "en-US", {
        dateStyle: "short",
        timeStyle: "short",
    });

    for (const entry of state.history) {
        const item = document.createElement("li");
        item.className = "history-item";

        const head = document.createElement("div");
        head.className = "history-head";

        const kind = document.createElement("span");
        kind.textContent = t(`history.kind.${entry.kind}`);

        const at = document.createElement("span");
        at.textContent = formatter.format(new Date(entry.at));

        head.append(kind, at);

        const content = document.createElement("div");
        content.className = "history-content";
        content.textContent = `${entry.input}\n${entry.output}`;

        item.append(head, content);
        ui.historyList.appendChild(item);
    }
}

async function fileToImageData(file) {
    const objectUrl = URL.createObjectURL(file);

    try {
        const image = await loadImageElement(objectUrl);
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth || image.width;
        canvas.height = image.naturalHeight || image.height;

        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) {
            throw new Error("Cannot acquire 2D drawing context.");
        }

        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, canvas.width, canvas.height);
    } finally {
        URL.revokeObjectURL(objectUrl);
    }
}

function loadImageElement(src) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("Cannot open image file."));
        image.src = src;
    });
}

async function probeLink(url) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 7000);

    try {
        let response;

        try {
            response = await fetch(url, {
                method: "HEAD",
                cache: "no-store",
                redirect: "follow",
                signal: controller.signal,
            });
        } catch (_headError) {
            response = await fetch(url, {
                method: "GET",
                cache: "no-store",
                redirect: "follow",
                signal: controller.signal,
            });
        }

        return {
            ok: response.ok,
            status: response.status,
            reason: `HTTP ${response.status}`,
        };
    } catch (error) {
        return {
            ok: false,
            status: 0,
            reason: formatError(error),
        };
    } finally {
        clearTimeout(timeoutId);
    }
}

function applyTheme(theme) {
    const normalized = normalizeTheme(theme);
    const applied = normalized === "system" ? (systemThemeMedia.matches ? "dark" : "light") : normalized;
    document.documentElement.dataset.theme = applied;
}

function normalizeTheme(theme) {
    if (theme === "light" || theme === "dark") {
        return theme;
    }

    return "system";
}

function setStatus(message, isError = false, isSuccess = false) {
    ui.status.textContent = message;
    ui.status.classList.toggle("error", isError);
    ui.status.classList.toggle("ok", isSuccess && !isError);
}

function t(key, options) {
    if (!i18next.isInitialized) {
        return key;
    }

    return i18next.t(key, options);
}

function formatError(error) {
    if (!error) {
        return "unknown error";
    }

    if (typeof error === "string") {
        return error;
    }

    if (error instanceof Error) {
        return error.message;
    }

    if (typeof error.message === "string") {
        return error.message;
    }

    return String(error);
}

function compactText(value, maxLength) {
    const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
    if (normalized.length <= maxLength) {
        return normalized;
    }

    return `${normalized.slice(0, maxLength - 3)}...`;
}

async function loadState() {
    try {
        const result = await storageGet(STORAGE_KEY);
        return normalizeState(result?.[STORAGE_KEY]);
    } catch (_error) {
        return structuredClone(DEFAULT_STATE);
    }
}

async function persistState() {
    await storageSet({ [STORAGE_KEY]: state });
}

function normalizeState(candidate) {
    const safe = candidate && typeof candidate === "object" ? candidate : {};
    const generate = safe.generate && typeof safe.generate === "object" ? safe.generate : {};
    const camera = safe.camera && typeof safe.camera === "object" ? safe.camera : {};

    return {
        language: safe.language === "en" ? "en" : "vi",
        theme: normalizeTheme(safe.theme),
        history: Array.isArray(safe.history) ? safe.history.slice(0, HISTORY_LIMIT) : [],
        generate: {
            content: typeof generate.content === "string" ? generate.content : "",
            size: Number.isFinite(Number(generate.size))
                ? Math.min(1024, Math.max(192, Number(generate.size)))
                : 512,
            dark: isColorHex(generate.dark) ? generate.dark : "#111111",
            light: isColorHex(generate.light) ? generate.light : "#ffffff",
        },
        camera: {
            autoStopOnFirst: camera.autoStopOnFirst !== false,
            preferredDeviceId: typeof camera.preferredDeviceId === "string"
                ? camera.preferredDeviceId
                : "",
        },
    };
}

function isColorHex(value) {
    return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

async function storageGet(key) {
    return new Promise((resolve, reject) => {
        chrome.storage.local.get(key, (value) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }

            resolve(value);
        });
    });
}

async function storageSet(value) {
    return new Promise((resolve, reject) => {
        chrome.storage.local.set(value, () => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }

            resolve();
        });
    });
}

function downloadFromDataUrl(dataUrl, fileName) {
    const anchor = document.createElement("a");
    anchor.href = dataUrl;
    anchor.download = fileName;
    anchor.click();
}

function downloadFromBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);

    try {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = fileName;
        anchor.click();
    } finally {
        URL.revokeObjectURL(url);
    }
}
