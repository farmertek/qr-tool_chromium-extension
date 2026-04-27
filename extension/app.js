import i18next from "./vendor/i18next.js";
import initWasm, {
    compact_history_text,
    compute_overlay_layout,
    decode_qr_from_rgba,
    generate_symbolic_qr_mask,
    generate_qr_png_data_url,
    generate_qr_svg,
    pick_clipboard_image_type,
    verify_link_wasm,
} from "./wasm/wasm_qr.js";

const STORAGE_KEY = "qrtool.browser.extension.state";
const HISTORY_LIMIT = 80;
const CAMERA_SCAN_INTERVAL_DEFAULT_MS = 180;
const CAMERA_SCAN_INTERVAL_MIN_MS = 80;
const CAMERA_SCAN_INTERVAL_MAX_MS = 800;
const CAMERA_DEDUP_MS = 1500;
const CAMERA_OPTIMIZED_ROI_RATIO = 0.68;
const CAMERA_OPTIMIZED_DECODE_MAX_SIDE = 960;
const DEFAULT_OVERLAY_FONT_STYLE = "Regular";
const OVERLAY_FONT_FALLBACK_FAMILIES_WINDOWS = [
    "Segoe UI",
    "Bahnschrift Condensed",
    "Tahoma",
    "Trebuchet MS",
    "Verdana",
    "Arial",
    "Georgia",
    "Times New Roman",
    "Courier New",
];
const OVERLAY_FONT_FALLBACK_FAMILIES_LINUX = [
    "Noto Sans",
    "DejaVu Sans",
    "Liberation Sans",
    "Ubuntu",
    "Cantarell",
    "Droid Sans",
    "Arial",
    "Verdana",
];
const OVERLAY_FONT_PREFERRED_FAMILIES_WINDOWS = [
    "Segoe UI",
    "Bahnschrift Condensed",
    "Tahoma",
    "Arial",
];
const OVERLAY_FONT_PREFERRED_FAMILIES_LINUX = [
    "Noto Sans",
    "DejaVu Sans",
    "Liberation Sans",
    "Ubuntu",
];
const SYMBOLIC_PREVIEW_MIN_SIZE = 192;
const SYMBOLIC_PREVIEW_MAX_SIZE = 1024;
const SYMBOLIC_MODULE_COUNT = 33;
const SYMBOLIC_QUIET_MODULES = 2;
const OVERLAY_RATIO_MIN_PERCENT = 0;
const OVERLAY_RATIO_MAX_PERCENT = 30;
const OVERLAY_RATIO_DEFAULT_PERCENT = 20;
const OVERLAY_CORNER_RADIUS_MIN_PERCENT = 0;
const OVERLAY_CORNER_RADIUS_MAX_PERCENT = 50;
const OVERLAY_CORNER_RADIUS_DEFAULT_PERCENT = 0;

const runtimeEnv = detectRuntimeEnvironment();

const DEFAULT_STATE = {
    language: "vi",
    theme: "system",
    history: [],
    generate: {
        content: "",
        size: 640,
        dark: "#111111",
        light: "#ffffff",
        overlay: {
            text: "",
            textSizePx: 20,
            fontFamily: runtimeEnv.isLinux
                ? OVERLAY_FONT_PREFERRED_FAMILIES_LINUX[0]
                : OVERLAY_FONT_PREFERRED_FAMILIES_WINDOWS[0],
            fontStyle: DEFAULT_OVERLAY_FONT_STYLE,
            ratioPercent: OVERLAY_RATIO_DEFAULT_PERCENT,
            cornerRadiusPercent: OVERLAY_CORNER_RADIUS_DEFAULT_PERCENT,
            textColor: "#111111",
            boxColor: "#ffffff",
        },
    },
    camera: {
        autoStopOnFirst: true,
        preferredDeviceId: "",
        scanIntervalMs: CAMERA_SCAN_INTERVAL_DEFAULT_MS,
        copyOnDetect: false,
        optimizeDecode: true,
        torchEnabled: false,
        zoomLevel: 1,
    },
};

const ui = {};
let state = structuredClone(DEFAULT_STATE);
let wasmReady = false;
let latestGenerated = {
    pngDataUrl: "",
    svgContent: "",
    hasOverlay: false,
};
let overlayLogoDataUrl = "";
let decodeSourceBlob = null;
let decodeSourceName = "";
let decodePreviewObjectUrl = "";
let overlayFontChoices = buildFallbackOverlayFontChoices();
let overlayFontSystemLoadState = "idle";
let generatePreviewRenderToken = 0;

const cameraState = {
    stream: null,
    track: null,
    caps: null,
    loopTimer: null,
    scanBusy: false,
    running: false,
    canvasContext: null,
    decodeCanvas: null,
    decodeContext: null,
    lastDecodedText: "",
    lastDecodedAt: 0,
    torchSupported: false,
};

const systemThemeMedia = window.matchMedia("(prefers-color-scheme: dark)");

function detectRuntimeEnvironment() {
    const platform = String(navigator.userAgentData?.platform || navigator.platform || "")
        .toLowerCase();
    const userAgent = String(navigator.userAgent || "").toLowerCase();

    return {
        isLinux: platform.includes("linux") || userAgent.includes("linux"),
    };
}

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
    initializeOverlayFontChoices();
    hydrateControls();
    renderHistory();
    void renderGenerateSymbolicPreview();

    await handleRefreshCameraDevices(false);
    await initializeWasm();
}

function cacheElements() {
    ui.navTabs = Array.from(document.querySelectorAll(".nav-tab"));
    ui.panels = Array.from(document.querySelectorAll(".panel"));
    ui.status = document.getElementById("status");

    ui.generateInput = document.getElementById("generate-input");
    ui.generateSize = document.getElementById("generate-size");
    ui.generateSizeValue = document.getElementById("generate-size-value");
    ui.generateDark = document.getElementById("generate-dark");
    ui.generateLight = document.getElementById("generate-light");
    ui.generateButton = document.getElementById("generate-button");
    ui.generateClearAll = document.getElementById("generate-clear-all");
    ui.generatedImage = document.getElementById("generated-image");
    ui.generateEmpty = document.getElementById("generate-empty");
    ui.downloadPng = document.getElementById("download-png");
    ui.downloadSvg = document.getElementById("download-svg");

    ui.generateOverlayText = document.getElementById("generate-overlay-text");
    ui.generateOverlayTextSize = document.getElementById("generate-overlay-text-size");
    ui.generateOverlayTextSizeValue = document.getElementById("generate-overlay-text-size-value");
    ui.generateOverlayFont = document.getElementById("generate-overlay-font");
    ui.generateOverlayRatio = document.getElementById("generate-overlay-ratio");
    ui.generateOverlayRatioValue = document.getElementById("generate-overlay-ratio-value");
    ui.generateOverlayCornerRadius = document.getElementById("generate-overlay-corner-radius");
    ui.generateOverlayCornerRadiusValue = document.getElementById("generate-overlay-corner-radius-value");
    ui.generateOverlayTextColor = document.getElementById("generate-overlay-text-color");
    ui.generateOverlayBoxColor = document.getElementById("generate-overlay-box-color");
    ui.generateOverlayLogoFile = document.getElementById("generate-overlay-logo-file");
    ui.generateOverlayLogoName = document.getElementById("generate-overlay-logo-name");
    ui.generateOverlayClearLogo = document.getElementById("generate-overlay-clear-logo");

    ui.decodeDropzone = document.getElementById("decode-dropzone");
    ui.decodeFile = document.getElementById("decode-file");
    ui.decodeButton = document.getElementById("decode-button");
    ui.decodePasteButton = document.getElementById("decode-paste-button");
    ui.decodeClearSource = document.getElementById("decode-clear-source");
    ui.decodeSourceImage = document.getElementById("decode-source-image");
    ui.decodeOutput = document.getElementById("decode-output");
    ui.decodeCopyOutput = document.getElementById("decode-copy-output");
    ui.decodeVerifyOutput = document.getElementById("decode-verify-output");

    ui.cameraDevice = document.getElementById("camera-device");
    ui.cameraRefresh = document.getElementById("camera-refresh");
    ui.cameraStart = document.getElementById("camera-start");
    ui.cameraStop = document.getElementById("camera-stop");
    ui.cameraAutoStop = document.getElementById("camera-auto-stop");
    ui.cameraCopyOnDetect = document.getElementById("camera-copy-on-detect");
    ui.cameraOptimizeDecode = document.getElementById("camera-optimize-decode");
    ui.cameraInterval = document.getElementById("camera-interval");
    ui.cameraIntervalValue = document.getElementById("camera-interval-value");
    ui.cameraTorch = document.getElementById("camera-torch");
    ui.cameraZoomWrap = document.getElementById("camera-zoom-wrap");
    ui.cameraZoom = document.getElementById("camera-zoom");
    ui.cameraZoomValue = document.getElementById("camera-zoom-value");
    ui.cameraVideo = document.getElementById("camera-video");
    ui.cameraCanvas = document.getElementById("camera-canvas");
    ui.cameraHint = document.getElementById("camera-hint");
    ui.cameraOutput = document.getElementById("camera-output");
    ui.cameraCopyOutput = document.getElementById("camera-copy-output");
    ui.cameraVerifyOutput = document.getElementById("camera-verify-output");

    ui.verifyUrl = document.getElementById("verify-url");
    ui.verifyButton = document.getElementById("verify-button");
    ui.verifyResult = document.getElementById("verify-result");
    ui.verifyCopyOutput = document.getElementById("verify-copy-output");
    ui.verifyOpenVirusTotal = document.getElementById("verify-open-virustotal");

    ui.historyList = document.getElementById("history-list");
    ui.clearHistory = document.getElementById("clear-history");

    ui.languageSelect = document.getElementById("language-select");
    ui.themeSelect = document.getElementById("theme-select");
}

function bindEvents() {
    ui.navTabs.forEach((button) => {
        button.addEventListener("click", () => {
            selectTab(button.dataset.tabTarget);
        });
    });

    ui.generateSize.addEventListener("input", () => {
        ui.generateSizeValue.textContent = String(Number(ui.generateSize.value));
        void renderGenerateSymbolicPreview();
    });

    ui.generateOverlayTextSize.addEventListener("input", () => {
        ui.generateOverlayTextSizeValue.textContent = String(Number(ui.generateOverlayTextSize.value));
        void renderGenerateSymbolicPreview();
    });

    ui.generateOverlayRatio.addEventListener("input", () => {
        ui.generateOverlayRatioValue.textContent = String(Number(ui.generateOverlayRatio.value));
        void renderGenerateSymbolicPreview();
    });

    ui.generateOverlayCornerRadius.addEventListener("input", () => {
        updateOverlayCornerRadiusDisplay(ui.generateOverlayCornerRadius.value);
        void renderGenerateSymbolicPreview();
    });

    ui.generateInput.addEventListener("input", () => {
        void renderGenerateSymbolicPreview();
    });

    ui.generateDark.addEventListener("input", () => {
        void renderGenerateSymbolicPreview();
    });

    ui.generateLight.addEventListener("input", () => {
        void renderGenerateSymbolicPreview();
    });

    ui.generateOverlayText.addEventListener("input", () => {
        void renderGenerateSymbolicPreview();
    });

    ui.generateOverlayFont.addEventListener("change", () => {
        void renderGenerateSymbolicPreview();
    });

    ui.generateOverlayFont.addEventListener("focus", () => {
        void refreshOverlayFontChoicesFromSystem();
    });

    ui.generateOverlayTextColor.addEventListener("input", () => {
        void renderGenerateSymbolicPreview();
    });

    ui.generateOverlayBoxColor.addEventListener("input", () => {
        void renderGenerateSymbolicPreview();
    });

    ui.generateButton.addEventListener("click", () => {
        void handleGenerate();
    });

    ui.generateClearAll.addEventListener("click", () => {
        void handleClearGenerateAll();
    });

    ui.downloadPng.addEventListener("click", () => {
        handleDownloadPng();
    });

    ui.downloadSvg.addEventListener("click", () => {
        handleDownloadSvg();
    });

    ui.generateOverlayLogoFile.addEventListener("change", () => {
        void handleOverlayLogoSelected();
    });

    ui.generateOverlayClearLogo.addEventListener("click", () => {
        handleOverlayLogoCleared();
    });

    ui.decodeFile.addEventListener("change", () => {
        void handleDecodeFileSelected();
    });

    ui.decodeButton.addEventListener("click", () => {
        void handleDecode();
    });

    ui.decodePasteButton.addEventListener("click", () => {
        void handleDecodeFromClipboard();
    });

    ui.decodeClearSource.addEventListener("click", () => {
        clearDecodeSource();
    });

    ui.decodeCopyOutput.addEventListener("click", () => {
        void handleCopyDecodeOutput();
    });

    ui.decodeVerifyOutput.addEventListener("click", () => {
        void handleVerifyFromDecodeOutput();
    });

    ui.decodeDropzone.addEventListener("dragenter", onDropzoneDragOver);
    ui.decodeDropzone.addEventListener("dragover", onDropzoneDragOver);
    ui.decodeDropzone.addEventListener("dragleave", onDropzoneDragLeave);
    ui.decodeDropzone.addEventListener("drop", (event) => {
        void onDropzoneDrop(event);
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

    ui.cameraCopyOutput.addEventListener("click", () => {
        void handleCopyCameraOutput();
    });

    ui.cameraVerifyOutput.addEventListener("click", () => {
        void handleVerifyFromCameraOutput();
    });

    ui.cameraDevice.addEventListener("change", () => {
        state.camera.preferredDeviceId = ui.cameraDevice.value || "";
        void persistState();
    });

    ui.cameraAutoStop.addEventListener("change", () => {
        state.camera.autoStopOnFirst = Boolean(ui.cameraAutoStop.checked);
        void persistState();
    });

    ui.cameraCopyOnDetect.addEventListener("change", () => {
        state.camera.copyOnDetect = Boolean(ui.cameraCopyOnDetect.checked);
        void persistState();
    });

    ui.cameraOptimizeDecode.addEventListener("change", () => {
        state.camera.optimizeDecode = Boolean(ui.cameraOptimizeDecode.checked);
        void persistState();
    });

    ui.cameraInterval.addEventListener("input", () => {
        handleCameraIntervalChanged();
    });

    ui.cameraTorch.addEventListener("click", () => {
        void handleCameraTorchToggle();
    });

    ui.cameraZoom.addEventListener("input", () => {
        void handleCameraZoomChanged();
    });

    ui.verifyButton.addEventListener("click", () => {
        void handleVerify();
    });

    ui.verifyCopyOutput.addEventListener("click", () => {
        void handleCopyVerifyOutput();
    });

    ui.verifyOpenVirusTotal.addEventListener("click", () => {
        handleOpenVerifyOutputInVirusTotal();
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
        revokeDecodePreviewObjectUrl();
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

    if (!overlayLogoDataUrl) {
        ui.generateOverlayLogoName.textContent = t("generate.overlayLogoNone");
    }

    fitSettingsSelectWidths();
    updateTorchButtonState();
}

function hydrateControls() {
    ui.generateInput.value = "";
    ui.generateSize.value = String(state.generate.size);
    ui.generateSizeValue.textContent = String(state.generate.size);
    ui.generateDark.value = state.generate.dark;
    ui.generateLight.value = state.generate.light;

    ui.generateOverlayText.value = state.generate.overlay.text;
    ui.generateOverlayTextSize.value = String(state.generate.overlay.textSizePx);
    ui.generateOverlayTextSizeValue.textContent = String(state.generate.overlay.textSizePx);
    const overlayFontChoice = resolveOverlayFontChoice(
        state.generate.overlay.fontFamily,
        state.generate.overlay.fontStyle,
    );
    state.generate.overlay.fontFamily = overlayFontChoice.family;
    state.generate.overlay.fontStyle = overlayFontChoice.style;
    setOverlayFontDropdownValue(overlayFontChoice);
    ui.generateOverlayRatio.value = String(state.generate.overlay.ratioPercent);
    ui.generateOverlayRatioValue.textContent = String(state.generate.overlay.ratioPercent);
    ui.generateOverlayCornerRadius.value = String(state.generate.overlay.cornerRadiusPercent);
    updateOverlayCornerRadiusDisplay(state.generate.overlay.cornerRadiusPercent);
    ui.generateOverlayTextColor.value = state.generate.overlay.textColor;
    ui.generateOverlayBoxColor.value = state.generate.overlay.boxColor;

    ui.cameraAutoStop.checked = state.camera.autoStopOnFirst;
    ui.cameraCopyOnDetect.checked = state.camera.copyOnDetect;
    ui.cameraOptimizeDecode.checked = state.camera.optimizeDecode !== false;
    ui.cameraInterval.value = String(state.camera.scanIntervalMs);
    ui.cameraIntervalValue.textContent = String(state.camera.scanIntervalMs);
    ui.cameraZoomValue.textContent = Number(state.camera.zoomLevel).toFixed(1);
    ui.verifyResult.value = "";

    ui.languageSelect.value = state.language;
    ui.themeSelect.value = state.theme;

    fitSettingsSelectWidths();
    updateTorchButtonState();
}

function selectTab(tabName) {
    ui.navTabs.forEach((button) => {
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

    const options = collectGenerateOptions();
    if (!options.content) {
        setStatus(t("status.needInput"), true);
        return;
    }

    setStatus(t("status.generating"));

    try {
        const basePng = generate_qr_png_data_url(
            options.content,
            options.size,
            options.dark,
            options.light,
        );

        const baseSvg = generate_qr_svg(options.content, options.dark, options.light);
        const hasOverlay = Boolean(options.overlayText || overlayLogoDataUrl);
        const finalPng = hasOverlay
            ? await composeGeneratedPngWithOverlay(basePng, options)
            : basePng;

        latestGenerated = {
            pngDataUrl: finalPng,
            svgContent: baseSvg,
            hasOverlay,
        };

        ui.generatedImage.src = finalPng;
        ui.generatedImage.hidden = false;
        ui.generateEmpty.hidden = true;

        state.generate = {
            content: "",
            size: options.size,
            dark: options.dark,
            light: options.light,
            overlay: {
                text: options.overlayText,
                textSizePx: options.overlayTextSizePx,
                fontFamily: options.overlayFontFamily,
                fontStyle: options.overlayFontStyle,
                ratioPercent: options.overlayRatioPercent,
                cornerRadiusPercent: options.overlayCornerRadiusPercent,
                textColor: options.overlayTextColor,
                boxColor: options.overlayBoxColor,
            },
        };

        pushHistory(
            "generate",
            options.content,
            hasOverlay ? `PNG ${options.size}px + overlay` : `PNG ${options.size}px`,
        );

        await persistState();
        setStatus(t("status.generateSuccess"), false, true);
    } catch (error) {
        setStatus(t("status.genericError", { error: formatError(error) }), true);
    }
}

async function handleClearGenerateAll() {
    state.generate = structuredClone(DEFAULT_STATE.generate);

    ui.generateInput.value = "";
    ui.generateSize.value = String(DEFAULT_STATE.generate.size);
    ui.generateSizeValue.textContent = String(DEFAULT_STATE.generate.size);
    ui.generateDark.value = DEFAULT_STATE.generate.dark;
    ui.generateLight.value = DEFAULT_STATE.generate.light;

    ui.generateOverlayText.value = DEFAULT_STATE.generate.overlay.text;
    ui.generateOverlayTextSize.value = String(DEFAULT_STATE.generate.overlay.textSizePx);
    ui.generateOverlayTextSizeValue.textContent = String(DEFAULT_STATE.generate.overlay.textSizePx);
    setOverlayFontDropdownValue(resolveOverlayFontChoice(
        DEFAULT_STATE.generate.overlay.fontFamily,
        DEFAULT_STATE.generate.overlay.fontStyle,
    ));
    ui.generateOverlayRatio.value = String(DEFAULT_STATE.generate.overlay.ratioPercent);
    ui.generateOverlayRatioValue.textContent = String(DEFAULT_STATE.generate.overlay.ratioPercent);
    ui.generateOverlayCornerRadius.value = String(DEFAULT_STATE.generate.overlay.cornerRadiusPercent);
    updateOverlayCornerRadiusDisplay(DEFAULT_STATE.generate.overlay.cornerRadiusPercent);
    ui.generateOverlayTextColor.value = DEFAULT_STATE.generate.overlay.textColor;
    ui.generateOverlayBoxColor.value = DEFAULT_STATE.generate.overlay.boxColor;

    overlayLogoDataUrl = "";
    ui.generateOverlayLogoFile.value = "";
    ui.generateOverlayLogoName.textContent = t("generate.overlayLogoNone");

    await renderGenerateSymbolicPreview();

    await persistState();
    setStatus(t("status.generateCleared"), false, true);
}

function collectGenerateOptions() {
    const overlayFontChoice = getSelectedOverlayFontChoice();

    return {
        content: ui.generateInput.value.trim(),
        size: clampNumber(Number(ui.generateSize.value), 192, 1536, 640),
        dark: isColorHex(ui.generateDark.value) ? ui.generateDark.value : "#111111",
        light: isColorHex(ui.generateLight.value) ? ui.generateLight.value : "#ffffff",
        overlayText: ui.generateOverlayText.value.trim(),
        overlayTextSizePx: clampNumber(Number(ui.generateOverlayTextSize.value), 10, 64, 20),
        overlayFontFamily: overlayFontChoice.family,
        overlayFontStyle: overlayFontChoice.style,
        overlayRatioPercent: clampNumber(
            Number(ui.generateOverlayRatio.value),
            OVERLAY_RATIO_MIN_PERCENT,
            OVERLAY_RATIO_MAX_PERCENT,
            OVERLAY_RATIO_DEFAULT_PERCENT,
        ),
        overlayCornerRadiusPercent: clampNumber(
            Number(ui.generateOverlayCornerRadius.value),
            OVERLAY_CORNER_RADIUS_MIN_PERCENT,
            OVERLAY_CORNER_RADIUS_MAX_PERCENT,
            OVERLAY_CORNER_RADIUS_DEFAULT_PERCENT,
        ),
        overlayTextColor: isColorHex(ui.generateOverlayTextColor.value)
            ? ui.generateOverlayTextColor.value
            : "#111111",
        overlayBoxColor: isColorHex(ui.generateOverlayBoxColor.value)
            ? ui.generateOverlayBoxColor.value
            : "#ffffff",
    };
}

async function composeGeneratedPngWithOverlay(basePngDataUrl, options) {
    const baseImage = await loadImageElement(basePngDataUrl);
    const canvas = document.createElement("canvas");
    canvas.width = baseImage.naturalWidth || baseImage.width;
    canvas.height = baseImage.naturalHeight || baseImage.height;

    const context = canvas.getContext("2d");
    if (!context) {
        throw new Error("Cannot acquire canvas context for overlay rendering.");
    }

    context.drawImage(baseImage, 0, 0, canvas.width, canvas.height);

    const overlayLayout = resolveOverlayLayout(
        canvas.width,
        canvas.height,
        options.overlayRatioPercent,
        options.overlayCornerRadiusPercent,
    );
    const side = overlayLayout.side;
    if (side < 8 || side >= Math.min(canvas.width, canvas.height)) {
        return canvas.toDataURL("image/png");
    }

    const x = overlayLayout.x;
    const y = overlayLayout.y;
    const radius = overlayLayout.radius;

    context.save();
    context.globalAlpha = 0.95;
    drawRoundedRectPath(context, x, y, side, side, radius);
    context.fillStyle = options.overlayBoxColor;
    context.fill();
    context.restore();

    if (overlayLogoDataUrl) {
        const logoImage = await loadImageElement(overlayLogoDataUrl);
        drawImageRoundedCover(context, logoImage, x, y, side, side, radius);
    }

    if (options.overlayText) {
        drawCenteredTextOverlay(
            context,
            options.overlayText,
            x,
            y,
            side,
            side,
            options.overlayTextSizePx,
            options.overlayFontFamily,
            options.overlayFontStyle,
            options.overlayTextColor,
        );
    }

    return canvas.toDataURL("image/png");
}

function drawRoundedRectPath(context, x, y, width, height, radius) {
    const r = Math.max(0, Math.min(radius, width / 2, height / 2));

    context.beginPath();
    context.moveTo(x + r, y);
    context.arcTo(x + width, y, x + width, y + height, r);
    context.arcTo(x + width, y + height, x, y + height, r);
    context.arcTo(x, y + height, x, y, r);
    context.arcTo(x, y, x + width, y, r);
    context.closePath();
}

function resolveOverlayLayout(canvasWidth, canvasHeight, ratioPercent, cornerRadiusPercent) {
    if (wasmReady && typeof compute_overlay_layout === "function") {
        try {
            const layout = compute_overlay_layout(
                Number(canvasWidth),
                Number(canvasHeight),
                Number(ratioPercent),
                Number(cornerRadiusPercent),
            );

            if (isValidOverlayLayout(layout, canvasWidth, canvasHeight)) {
                return {
                    x: Math.round(layout.x),
                    y: Math.round(layout.y),
                    side: Math.round(layout.side),
                    radius: Math.round(layout.radius),
                };
            }
        } catch (_error) {
            // Keep JS fallback when WASM helper is unavailable.
        }
    }

    const side = Math.max(
        0,
        Math.round(Math.min(canvasWidth, canvasHeight) * (Number(ratioPercent) / 100)),
    );
    return {
        x: Math.round((canvasWidth - side) / 2),
        y: Math.round((canvasHeight - side) / 2),
        side,
        radius: resolveOverlayCornerRadiusPx(side, cornerRadiusPercent),
    };
}

function isValidOverlayLayout(layout, canvasWidth, canvasHeight) {
    if (!layout || typeof layout !== "object") {
        return false;
    }

    const x = Number(layout.x);
    const y = Number(layout.y);
    const side = Number(layout.side);
    const radius = Number(layout.radius);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(side) || !Number.isFinite(radius)) {
        return false;
    }

    if (side < 0 || x < 0 || y < 0 || x + side > canvasWidth || y + side > canvasHeight) {
        return false;
    }

    return radius >= 0 && radius <= side / 2;
}

function resolveOverlayCornerRadiusPx(sidePx, cornerRadiusPercent) {
    const ratio = clampNumber(
        Number(cornerRadiusPercent),
        OVERLAY_CORNER_RADIUS_MIN_PERCENT,
        OVERLAY_CORNER_RADIUS_MAX_PERCENT,
        OVERLAY_CORNER_RADIUS_DEFAULT_PERCENT,
    ) / 100;
    return Math.round(sidePx * ratio);
}

function formatOverlayCornerRadiusRatioText(cornerRadiusPercent) {
    const ratio = clampNumber(
        Number(cornerRadiusPercent),
        OVERLAY_CORNER_RADIUS_MIN_PERCENT,
        OVERLAY_CORNER_RADIUS_MAX_PERCENT,
        OVERLAY_CORNER_RADIUS_DEFAULT_PERCENT,
    ) / 100;
    return ratio.toFixed(2);
}

function updateOverlayCornerRadiusDisplay(cornerRadiusPercent) {
    const ratioText = formatOverlayCornerRadiusRatioText(cornerRadiusPercent);
    ui.generateOverlayCornerRadiusValue.textContent = ratioText;
    ui.generateOverlayCornerRadius.title = ratioText;
    ui.generateOverlayCornerRadius.setAttribute("aria-valuetext", ratioText);
}

function drawImageRoundedCover(context, image, x, y, width, height, radius) {
    const sourceWidth = image.naturalWidth || image.width;
    const sourceHeight = image.naturalHeight || image.height;

    const scale = Math.max(width / sourceWidth, height / sourceHeight);
    const drawWidth = sourceWidth * scale;
    const drawHeight = sourceHeight * scale;
    const drawX = x + (width - drawWidth) / 2;
    const drawY = y + (height - drawHeight) / 2;

    context.save();
    drawRoundedRectPath(context, x, y, width, height, radius);
    context.clip();
    context.drawImage(image, drawX, drawY, drawWidth, drawHeight);
    context.restore();
}

function drawCenteredTextOverlay(
    context,
    text,
    x,
    y,
    width,
    height,
    fontSize,
    fontFamily,
    fontStyle,
    textColor,
) {
    let resolvedFontSize = clampNumber(Number(fontSize), 10, 64, 20);
    const resolvedFontChoice = resolveOverlayFontChoice(fontFamily, fontStyle);
    const maxWidth = Math.max(24, width - 20);
    const maxHeight = Math.max(24, height - 18);
    let lines = [];

    for (; resolvedFontSize >= 10; resolvedFontSize -= 1) {
        context.font = buildOverlayFontCss(
            resolvedFontSize,
            resolvedFontChoice.family,
            resolvedFontChoice.style,
        );
        lines = wrapTextToLines(context, text, maxWidth);
        const lineHeight = resolvedFontSize * 1.2;
        const totalHeight = lines.length * lineHeight;
        if (totalHeight <= maxHeight) {
            break;
        }
    }

    context.font = buildOverlayFontCss(
        resolvedFontSize,
        resolvedFontChoice.family,
        resolvedFontChoice.style,
    );
    context.fillStyle = textColor;
    context.textAlign = "center";
    context.textBaseline = "middle";

    const lineHeight = resolvedFontSize * 1.2;
    const totalHeight = lines.length * lineHeight;
    const startY = y + (height - totalHeight) / 2 + lineHeight / 2;

    lines.forEach((line, index) => {
        context.fillText(line, x + width / 2, startY + index * lineHeight);
    });
}

function wrapTextToLines(context, text, maxWidth) {
    const normalized = String(text || "").replace(/\s+/g, " ").trim();
    if (!normalized) {
        return [];
    }

    const words = normalized.split(" ");
    const lines = [];
    let currentLine = words[0];

    for (let index = 1; index < words.length; index += 1) {
        const candidate = `${currentLine} ${words[index]}`;
        if (context.measureText(candidate).width <= maxWidth) {
            currentLine = candidate;
            continue;
        }

        lines.push(currentLine);
        currentLine = words[index];
    }

    if (currentLine) {
        lines.push(currentLine);
    }

    return lines.slice(0, 5);
}

function buildFallbackOverlayFontChoices() {
    const families = runtimeEnv.isLinux
        ? OVERLAY_FONT_FALLBACK_FAMILIES_LINUX
        : OVERLAY_FONT_FALLBACK_FAMILIES_WINDOWS;

    return normalizeOverlayFontChoices(
        families.map((family) => ({
            family,
            style: DEFAULT_OVERLAY_FONT_STYLE,
        })),
    );
}

function getPreferredOverlayFontFamilies() {
    return runtimeEnv.isLinux
        ? OVERLAY_FONT_PREFERRED_FAMILIES_LINUX
        : OVERLAY_FONT_PREFERRED_FAMILIES_WINDOWS;
}

function overlayFontChoiceKey(choice) {
    return `${choice.family.toLowerCase()}||${choice.style.toLowerCase()}`;
}

function normalizeOverlayFontStyle(style) {
    const normalized = String(style || "").trim();
    return normalized || DEFAULT_OVERLAY_FONT_STYLE;
}

function normalizeOverlayFontChoices(choices) {
    const normalized = [];
    const seen = new Set();

    for (const rawChoice of choices) {
        const family = String(rawChoice?.family || "").trim();
        if (!family) {
            continue;
        }

        const style = normalizeOverlayFontStyle(rawChoice?.style);
        const choice = { family, style };
        const key = overlayFontChoiceKey(choice);
        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        normalized.push(choice);
    }

    normalized.sort((left, right) => {
        return left.family
            .toLowerCase()
            .localeCompare(right.family.toLowerCase()) ||
            left.style.toLowerCase().localeCompare(right.style.toLowerCase());
    });

    if (normalized.length) {
        return normalized;
    }

    return getPreferredOverlayFontFamilies().map((family) => ({
        family,
        style: DEFAULT_OVERLAY_FONT_STYLE,
    }));
}

function selectDefaultOverlayFontChoice(choices) {
    const normalizedChoices = normalizeOverlayFontChoices(choices);

    for (const preferredFamily of getPreferredOverlayFontFamilies()) {
        const regularChoice = normalizedChoices.find((choice) => {
            return (
                choice.family.toLowerCase() === preferredFamily.toLowerCase() &&
                choice.style.toLowerCase() === DEFAULT_OVERLAY_FONT_STYLE.toLowerCase()
            );
        });

        if (regularChoice) {
            return regularChoice;
        }

        const familyChoice = normalizedChoices.find(
            (choice) => choice.family.toLowerCase() === preferredFamily.toLowerCase(),
        );
        if (familyChoice) {
            return familyChoice;
        }
    }

    return normalizedChoices[0];
}

function resolveOverlayFontChoice(candidateFamily, candidateStyle) {
    const family = String(candidateFamily || "").trim();
    const style = normalizeOverlayFontStyle(candidateStyle);

    if (family) {
        const exactChoice = overlayFontChoices.find((choice) => {
            return (
                choice.family.toLowerCase() === family.toLowerCase() &&
                choice.style.toLowerCase() === style.toLowerCase()
            );
        });

        if (exactChoice) {
            return exactChoice;
        }

        const familyChoice = overlayFontChoices.find(
            (choice) => choice.family.toLowerCase() === family.toLowerCase(),
        );
        if (familyChoice) {
            return familyChoice;
        }
    }

    return selectDefaultOverlayFontChoice(overlayFontChoices);
}

function overlayFontChoiceValue(choice) {
    return `${choice.family}||${choice.style}`;
}

function parseOverlayFontChoiceValue(value) {
    const raw = String(value || "").trim();
    if (!raw) {
        return null;
    }

    const separatorIndex = raw.indexOf("||");
    if (separatorIndex < 0) {
        return {
            family: raw,
            style: DEFAULT_OVERLAY_FONT_STYLE,
        };
    }

    return {
        family: raw.slice(0, separatorIndex).trim(),
        style: normalizeOverlayFontStyle(raw.slice(separatorIndex + 2)),
    };
}

function setOverlayFontOptions(choices, preferredChoice) {
    overlayFontChoices = normalizeOverlayFontChoices(choices);
    const resolvedPreferred = preferredChoice
        ? resolveOverlayFontChoice(preferredChoice.family, preferredChoice.style)
        : selectDefaultOverlayFontChoice(overlayFontChoices);

    ui.generateOverlayFont.innerHTML = "";
    for (const choice of overlayFontChoices) {
        const option = document.createElement("option");
        option.value = overlayFontChoiceValue(choice);
        option.textContent = `${choice.family} / ${choice.style}`;
        ui.generateOverlayFont.append(option);
    }

    setOverlayFontDropdownValue(resolvedPreferred);
}

function setOverlayFontDropdownValue(choice) {
    const resolvedChoice = resolveOverlayFontChoice(choice?.family, choice?.style);
    const targetValue = overlayFontChoiceValue(resolvedChoice);

    if (Array.from(ui.generateOverlayFont.options).some((option) => option.value === targetValue)) {
        ui.generateOverlayFont.value = targetValue;
        return;
    }

    if (ui.generateOverlayFont.options.length) {
        ui.generateOverlayFont.value = ui.generateOverlayFont.options[0].value;
    }
}

function getSelectedOverlayFontChoice() {
    const parsed = parseOverlayFontChoiceValue(ui.generateOverlayFont.value);
    if (!parsed) {
        return selectDefaultOverlayFontChoice(overlayFontChoices);
    }

    return resolveOverlayFontChoice(parsed.family, parsed.style);
}

function initializeOverlayFontChoices() {
    const preferredChoice = resolveOverlayFontChoice(
        state.generate.overlay.fontFamily,
        state.generate.overlay.fontStyle,
    );

    setOverlayFontOptions(buildFallbackOverlayFontChoices(), preferredChoice);

    const selectedChoice = getSelectedOverlayFontChoice();
    state.generate.overlay.fontFamily = selectedChoice.family;
    state.generate.overlay.fontStyle = selectedChoice.style;

    void refreshOverlayFontChoicesFromSystem();
}

async function refreshOverlayFontChoicesFromSystem() {
    if (
        overlayFontSystemLoadState === "loading" ||
        overlayFontSystemLoadState === "loaded" ||
        overlayFontSystemLoadState === "unsupported"
    ) {
        return;
    }

    if (typeof window.queryLocalFonts !== "function") {
        overlayFontSystemLoadState = "unsupported";
        return;
    }

    overlayFontSystemLoadState = "loading";

    try {
        const systemChoices = await loadSystemTrueTypeOverlayFontChoices();
        if (systemChoices.length) {
            const currentChoice = getSelectedOverlayFontChoice();
            setOverlayFontOptions(systemChoices, currentChoice);

            const selectedChoice = getSelectedOverlayFontChoice();
            state.generate.overlay.fontFamily = selectedChoice.family;
            state.generate.overlay.fontStyle = selectedChoice.style;

            overlayFontSystemLoadState = "loaded";
            void persistState();
            void renderGenerateSymbolicPreview();
            return;
        }
    } catch (_error) {
        // Keep fallback choices when local font access is denied or unavailable.
    }

    overlayFontSystemLoadState = "idle";
}

async function loadSystemTrueTypeOverlayFontChoices() {
    const localFonts = await window.queryLocalFonts();
    const choices = [];

    for (const fontData of localFonts) {
        if (!(await isTrueTypeFontData(fontData))) {
            continue;
        }

        const family = String(fontData?.family || "").trim();
        if (!family) {
            continue;
        }

        choices.push({
            family,
            style: normalizeOverlayFontStyle(fontData?.style),
        });
    }

    const normalizedChoices = normalizeOverlayFontChoices(choices);
    if (!runtimeEnv.isLinux) {
        return normalizedChoices;
    }

    const allowedFamilies = new Set(
        OVERLAY_FONT_FALLBACK_FAMILIES_LINUX.map((family) => family.toLowerCase()),
    );
    return normalizedChoices.filter((choice) => {
        return allowedFamilies.has(choice.family.toLowerCase());
    });
}

async function isTrueTypeFontData(fontData) {
    if (!fontData || typeof fontData.blob !== "function") {
        return true;
    }

    try {
        const blob = await fontData.blob();
        const header = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
        return (
            header.length === 4 &&
            header[0] === 0x00 &&
            header[1] === 0x01 &&
            header[2] === 0x00 &&
            header[3] === 0x00
        );
    } catch (_error) {
        return false;
    }
}

function buildOverlayFontCss(fontSizePx, fontFamily, fontStyle) {
    const resolvedChoice = resolveOverlayFontChoice(fontFamily, fontStyle);
    const normalizedFamily = resolvedChoice.family.replaceAll("\"", "");
    const slant = resolveOverlayFontSlant(resolvedChoice.style);
    const weight = resolveOverlayFontWeight(resolvedChoice.style);
    return `${slant} ${weight} ${fontSizePx}px "${normalizedFamily}", "Segoe UI", "Trebuchet MS", sans-serif`;
}

function resolveOverlayFontWeight(style) {
    const normalized = String(style || "").toLowerCase();

    if (normalized.includes("thin")) {
        return 100;
    }

    if (normalized.includes("extra light") || normalized.includes("ultra light")) {
        return 200;
    }

    if (normalized.includes("light")) {
        return 300;
    }

    if (normalized.includes("medium")) {
        return 500;
    }

    if (normalized.includes("semibold") || normalized.includes("semi bold")) {
        return 600;
    }

    if (normalized.includes("extra bold") || normalized.includes("ultra bold")) {
        return 800;
    }

    if (normalized.includes("black") || normalized.includes("heavy")) {
        return 900;
    }

    if (normalized.includes("bold")) {
        return 700;
    }

    return 400;
}

function resolveOverlayFontSlant(style) {
    const normalized = String(style || "").toLowerCase();
    if (normalized.includes("oblique")) {
        return "oblique";
    }

    if (normalized.includes("italic")) {
        return "italic";
    }

    return "normal";
}

async function renderGenerateSymbolicPreview() {
    const currentToken = ++generatePreviewRenderToken;
    const options = collectGenerateOptions();
    const previewSize = clampNumber(
        Number(options.size),
        SYMBOLIC_PREVIEW_MIN_SIZE,
        SYMBOLIC_PREVIEW_MAX_SIZE,
        DEFAULT_STATE.generate.size,
    );

    const canvas = document.createElement("canvas");
    canvas.width = previewSize;
    canvas.height = previewSize;

    const context = canvas.getContext("2d");
    if (!context) {
        return;
    }

    context.fillStyle = options.light;
    context.fillRect(0, 0, previewSize, previewSize);

    paintSymbolicQrModules(context, previewSize, options.dark, options.light);
    await drawSymbolicOverlayPreview(context, previewSize, options);

    if (currentToken !== generatePreviewRenderToken) {
        return;
    }

    latestGenerated = {
        pngDataUrl: "",
        svgContent: "",
        hasOverlay: false,
    };

    ui.generatedImage.src = canvas.toDataURL("image/png");
    ui.generatedImage.hidden = false;
    ui.generateEmpty.hidden = true;
}

function paintSymbolicQrModules(context, previewSize, darkColor, lightColor) {
    const minSide = previewSize;
    if (minSide < 32) {
        return;
    }

    const totalModules = SYMBOLIC_MODULE_COUNT + SYMBOLIC_QUIET_MODULES * 2;
    const moduleSize = Math.max(
        1,
        Math.floor(minSide / totalModules),
    );
    const qrSidePx = SYMBOLIC_MODULE_COUNT * moduleSize;
    const originX = Math.floor((previewSize - qrSidePx) / 2);
    const originY = Math.floor((previewSize - qrSidePx) / 2);
    const symbolicMask = getSymbolicMaskFromWasm(SYMBOLIC_MODULE_COUNT);

    for (let row = 0; row < SYMBOLIC_MODULE_COUNT; row += 1) {
        for (let col = 0; col < SYMBOLIC_MODULE_COUNT; col += 1) {
            const maskIndex = row * SYMBOLIC_MODULE_COUNT + col;
            const isDark = symbolicMask
                ? symbolicMask[maskIndex] === 1
                : symbolicModuleIsDark(row, col, SYMBOLIC_MODULE_COUNT);
            context.fillStyle = isDark ? darkColor : lightColor;
            context.fillRect(
                originX + col * moduleSize,
                originY + row * moduleSize,
                moduleSize,
                moduleSize,
            );
        }
    }
}

function getSymbolicMaskFromWasm(moduleCount) {
    if (!wasmReady || typeof generate_symbolic_qr_mask !== "function") {
        return null;
    }

    try {
        const mask = generate_symbolic_qr_mask(moduleCount);
        const expectedLen = moduleCount * moduleCount;
        if (!mask || mask.length !== expectedLen) {
            return null;
        }

        return mask;
    } catch (_error) {
        return null;
    }
}

function symbolicModuleIsDark(row, col, moduleCount) {
    const finder = symbolicFinderModule(row, col, moduleCount);
    if (finder != null) {
        return finder;
    }

    const alignment = symbolicAlignmentModule(row, col, moduleCount);
    if (alignment != null) {
        return alignment;
    }

    if (symbolicTimingModule(row, col, moduleCount)) {
        return (row + col) % 2 === 0;
    }

    const pseudo =
        row * 73 +
        col * 151 +
        row * col * 17 +
        ((row ^ col) * 29);
    return pseudo % 11 < 5;
}

function symbolicFinderModule(row, col, moduleCount) {
    const starts = [
        [0, 0],
        [0, moduleCount - 7],
        [moduleCount - 7, 0],
    ];

    for (const [startRow, startCol] of starts) {
        if (
            row >= startRow && row < startRow + 7 &&
            col >= startCol && col < startCol + 7
        ) {
            const localRow = row - startRow;
            const localCol = col - startCol;
            const outerRing = localRow === 0 || localRow === 6 || localCol === 0 || localCol === 6;
            const innerWhiteRing =
                localRow === 1 || localRow === 5 || localCol === 1 || localCol === 5;
            if (outerRing) {
                return true;
            }

            if (innerWhiteRing) {
                return false;
            }

            return true;
        }
    }

    return null;
}

function symbolicAlignmentModule(row, col, moduleCount) {
    const start = moduleCount - 11;
    if (row < start || row >= start + 5 || col < start || col >= start + 5) {
        return null;
    }

    const localRow = row - start;
    const localCol = col - start;
    const border = localRow === 0 || localRow === 4 || localCol === 0 || localCol === 4;
    const center = localRow === 2 && localCol === 2;
    return border || center;
}

function symbolicTimingModule(row, col, moduleCount) {
    if (moduleCount <= 16) {
        return false;
    }

    const timingRangeStart = 8;
    const timingRangeEnd = moduleCount - 8;
    return (
        (row === 6 && col >= timingRangeStart && col < timingRangeEnd) ||
        (col === 6 && row >= timingRangeStart && row < timingRangeEnd)
    );
}

async function drawSymbolicOverlayPreview(context, previewSize, options) {
    const overlayLayout = resolveOverlayLayout(
        previewSize,
        previewSize,
        options.overlayRatioPercent,
        options.overlayCornerRadiusPercent,
    );
    const side = overlayLayout.side;
    if (side < 8 || side >= previewSize) {
        return;
    }

    const x = overlayLayout.x;
    const y = overlayLayout.y;
    const radius = overlayLayout.radius;

    context.save();
    context.globalAlpha = 0.95;
    drawRoundedRectPath(context, x, y, side, side, radius);
    context.fillStyle = options.overlayBoxColor;
    context.fill();
    context.restore();

    if (overlayLogoDataUrl) {
        try {
            const logoImage = await loadImageElement(overlayLogoDataUrl);
            drawImageRoundedCover(context, logoImage, x, y, side, side, radius);
        } catch (_error) {
            // Ignore logo decode errors in symbolic preview.
        }
    }

    if (options.overlayText) {
        drawCenteredTextOverlay(
            context,
            options.overlayText,
            x,
            y,
            side,
            side,
            options.overlayTextSizePx,
            options.overlayFontFamily,
            options.overlayFontStyle,
            options.overlayTextColor,
        );
    }
}

function handleDownloadPng() {
    if (!latestGenerated.pngDataUrl) {
        setStatus(t("status.downloadMissing"), true);
        return;
    }

    downloadFromDataUrl(latestGenerated.pngDataUrl, `qr-${Date.now()}.png`);
}

function handleDownloadSvg() {
    if (!latestGenerated.svgContent) {
        setStatus(t("status.downloadMissing"), true);
        return;
    }

    if (latestGenerated.hasOverlay) {
        setStatus(t("status.svgOverlayOnlyPng"), false, true);
    }

    downloadFromBlob(
        new Blob([latestGenerated.svgContent], { type: "image/svg+xml" }),
        `qr-${Date.now()}.svg`,
    );
}

async function handleOverlayLogoSelected() {
    const file = ui.generateOverlayLogoFile.files?.[0];
    if (!file) {
        return;
    }

    if (!file.type.startsWith("image/")) {
        setStatus(t("status.genericError", { error: "Invalid logo file type." }), true);
        return;
    }

    try {
        overlayLogoDataUrl = await blobToDataUrl(file);
        ui.generateOverlayLogoName.textContent = file.name;
        setStatus(t("status.overlayLogoLoaded"), false, true);
        void renderGenerateSymbolicPreview();
    } catch (error) {
        setStatus(t("status.genericError", { error: formatError(error) }), true);
    }
}

function handleOverlayLogoCleared() {
    overlayLogoDataUrl = "";
    ui.generateOverlayLogoFile.value = "";
    ui.generateOverlayLogoName.textContent = t("generate.overlayLogoNone");
    setStatus(t("status.overlayLogoCleared"), false, true);
    void renderGenerateSymbolicPreview();
}

async function handleDecodeFileSelected() {
    const file = ui.decodeFile.files?.[0];
    if (!file) {
        return;
    }

    setDecodeSource(file, file.name);
}

function onDropzoneDragOver(event) {
    event.preventDefault();
    ui.decodeDropzone.classList.add("dragover");
}

function onDropzoneDragLeave(event) {
    event.preventDefault();
    ui.decodeDropzone.classList.remove("dragover");
}

async function onDropzoneDrop(event) {
    event.preventDefault();
    ui.decodeDropzone.classList.remove("dragover");

    const files = Array.from(event.dataTransfer?.files || []);
    const imageFile = files.find((file) => file.type.startsWith("image/"));
    if (!imageFile) {
        setStatus(t("status.chooseFile"), true);
        return;
    }

    setDecodeSource(imageFile, imageFile.name);
    setStatus(t("status.dropImageReady"), false, true);
}

function setDecodeSource(blob, sourceName) {
    decodeSourceBlob = blob;
    decodeSourceName = sourceName;
    void setDecodePreviewFromBlob(blob);
}

async function setDecodePreviewFromBlob(blob) {
    revokeDecodePreviewObjectUrl();
    decodePreviewObjectUrl = URL.createObjectURL(blob);
    ui.decodeSourceImage.src = decodePreviewObjectUrl;
    ui.decodeSourceImage.hidden = false;
    ui.decodeDropzone.classList.add("has-preview");
}

function clearDecodeSource() {
    decodeSourceBlob = null;
    decodeSourceName = "";
    ui.decodeFile.value = "";
    ui.decodeOutput.value = "";
    revokeDecodePreviewObjectUrl();
    ui.decodeSourceImage.removeAttribute("src");
    ui.decodeSourceImage.hidden = true;
    ui.decodeDropzone.classList.remove("has-preview");
    setStatus(t("status.decodeSourceCleared"), false, true);
}

function revokeDecodePreviewObjectUrl() {
    if (decodePreviewObjectUrl) {
        URL.revokeObjectURL(decodePreviewObjectUrl);
        decodePreviewObjectUrl = "";
    }
}

async function handleDecode() {
    if (!wasmReady) {
        setStatus(t("status.wasmFailed", { error: "WASM not ready" }), true);
        return;
    }

    const sourceBlob = decodeSourceBlob || ui.decodeFile.files?.[0] || null;
    if (!sourceBlob) {
        setStatus(t("status.chooseFile"), true);
        return;
    }

    if (!decodeSourceBlob) {
        setDecodeSource(sourceBlob, sourceBlob.name || "image");
    }

    await decodeFromBlob(sourceBlob, decodeSourceName || sourceBlob.name || "image");
}

async function handleDecodeFromClipboard() {
    if (!wasmReady) {
        setStatus(t("status.wasmFailed", { error: "WASM not ready" }), true);
        return;
    }

    let imageBlob = null;
    let navigatorReadError = null;

    try {
        imageBlob = await tryReadClipboardImageWithNavigator();
    } catch (error) {
        navigatorReadError = error;
    }

    if (!imageBlob) {
        if (typeof navigator.clipboard?.read !== "function") {
            setStatus(t("status.clipboardUnsupported"), true);
            return;
        }

        if (navigatorReadError) {
            setStatus(t("status.clipboardReadFailed", { error: formatError(navigatorReadError) }), true);
            return;
        }

        setStatus(t("status.clipboardNoImage"), true);
        return;
    }

    const sourceName = t("read.clipboardImageName");
    setDecodeSource(imageBlob, sourceName);
    setStatus(t("status.clipboardImageReady"), false, true);
}

function pickClipboardImageType(types) {
    const normalized = Array.isArray(types)
        ? types
            .map((type) => String(type || "").trim().toLowerCase())
            .filter((type) => type)
        : [];

    if (!normalized.length) {
        return "";
    }

    if (typeof pick_clipboard_image_type === "function") {
        try {
            const selected = String(pick_clipboard_image_type(normalized.join("\n")) || "")
                .trim()
                .toLowerCase();
            if (selected) {
                return selected;
            }
        } catch (_error) {
            // Fall back to JS selection below when WASM helper is unavailable.
        }
    }

    return normalized.find((type) => type.startsWith("image/")) || "";
}

async function tryReadClipboardImageWithNavigator() {
    if (!navigator.clipboard || typeof navigator.clipboard.read !== "function") {
        return null;
    }

    const clipboardItems = await navigator.clipboard.read();
    for (const item of clipboardItems) {
        const imageType = pickClipboardImageType(item.types);
        if (!imageType) {
            continue;
        }

        const matchedType = item.types.find(
            (type) => String(type || "").trim().toLowerCase() === imageType,
        );
        if (!matchedType) {
            continue;
        }

        return await item.getType(matchedType);
    }

    return null;
}

async function decodeFromBlob(blob, sourceName) {
    try {
        const imageData = await blobToImageData(blob);
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

        pushHistory("decode", sourceName, decodedText);
        await persistState();

        setStatus(t("status.decodeSuccess"), false, true);
    } catch (error) {
        setStatus(t("status.genericError", { error: formatError(error) }), true);
    }
}

async function handleCopyDecodeOutput() {
    await copyTextToClipboard(ui.decodeOutput.value, "status.decodeOutputEmpty");
}

async function handleCopyCameraOutput() {
    await copyTextToClipboard(ui.cameraOutput.value, "status.cameraOutputEmpty");
}

async function handleVerifyFromDecodeOutput() {
    await verifyFromSourceOutput(ui.decodeOutput.value, "status.decodeOutputEmpty");
}

async function handleVerifyFromCameraOutput() {
    await verifyFromSourceOutput(ui.cameraOutput.value, "status.cameraOutputEmpty");
}

async function verifyFromSourceOutput(sourceOutput, emptyStatusKey) {
    const normalized = String(sourceOutput || "").trim();
    if (!normalized) {
        setStatus(t(emptyStatusKey), true);
        return;
    }

    ui.verifyUrl.value = normalized;
    selectTab("verify");
    await handleVerify();
}

async function handleCopyVerifyOutput() {
    await copyTextToClipboard(ui.verifyResult.value, "status.verifyOutputEmpty");
}

async function copyTextToClipboard(text, emptyStatusKey) {
    const normalized = String(text || "").trim();
    if (!normalized) {
        setStatus(t(emptyStatusKey), true);
        return false;
    }

    if (!navigator.clipboard?.writeText) {
        setStatus(t("status.clipboardWriteUnsupported"), true);
        return false;
    }

    try {
        await navigator.clipboard.writeText(normalized);
        setStatus(t("status.copySuccess"), false, true);
        return true;
    } catch (error) {
        setStatus(t("status.copyFailed", { error: formatError(error) }), true);
        return false;
    }
}

async function handleRefreshCameraDevices(showStatus = true) {
    if (!cameraSupported()) {
        ui.cameraDevice.innerHTML = "";
        const option = document.createElement("option");
        option.value = "";
        option.textContent = t("status.cameraUnsupported");
        ui.cameraDevice.append(option);
        ui.cameraDevice.disabled = true;
        cameraState.torchSupported = false;
        state.camera.torchEnabled = false;
        updateTorchButtonState();

        if (showStatus) {
            setStatus(t("status.cameraUnsupported"), true);
        }

        return [];
    }

    ui.cameraDevice.disabled = false;

    try {
        const devices = await refreshCameraDevices();
        if (!devices.length && showStatus) {
            setStatus(t("status.cameraNoDevice"), true);
            cameraState.torchSupported = false;
            state.camera.torchEnabled = false;
            updateTorchButtonState();
        } else if (showStatus) {
            setStatus(t("status.cameraRefreshDone"), false, true);
        }

        return devices;
    } catch (error) {
        cameraState.torchSupported = false;
        state.camera.torchEnabled = false;
        updateTorchButtonState();

        if (showStatus) {
            setStatus(t("status.cameraStartFailed", { error: formatCameraError(error) }), true);
        }

        return [];
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
        cameraState.track = stream.getVideoTracks()[0] || null;
        cameraState.running = true;
        cameraState.scanBusy = false;
        cameraState.lastDecodedText = "";
        cameraState.lastDecodedAt = 0;
        cameraState.canvasContext = null;
        cameraState.decodeCanvas = null;
        cameraState.decodeContext = null;

        ui.cameraVideo.srcObject = stream;
        ui.cameraHint.hidden = true;
        ui.cameraOutput.value = "";
        await ui.cameraVideo.play().catch(() => { });

        const activeDeviceId = cameraState.track?.getSettings?.().deviceId;
        if (activeDeviceId) {
            state.camera.preferredDeviceId = activeDeviceId;
            if (Array.from(ui.cameraDevice.options).some((option) => option.value === activeDeviceId)) {
                ui.cameraDevice.value = activeDeviceId;
            }
        }

        await configureCameraTrackControls();

        state.camera.autoStopOnFirst = Boolean(ui.cameraAutoStop.checked);
        state.camera.copyOnDetect = Boolean(ui.cameraCopyOnDetect.checked);
        state.camera.optimizeDecode = Boolean(ui.cameraOptimizeDecode.checked);
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

async function configureCameraTrackControls() {
    cameraState.caps = cameraState.track?.getCapabilities?.() || null;
    const zoomCap = cameraState.caps?.zoom;

    if (zoomCap) {
        ui.cameraZoomWrap.hidden = false;
        ui.cameraZoom.disabled = false;
        ui.cameraZoom.min = String(zoomCap.min ?? 1);
        ui.cameraZoom.max = String(zoomCap.max ?? 1);
        ui.cameraZoom.step = String(zoomCap.step || 0.1);

        const zoomValue = clampNumber(
            Number(state.camera.zoomLevel),
            Number(ui.cameraZoom.min),
            Number(ui.cameraZoom.max),
            Number(ui.cameraZoom.min),
        );

        ui.cameraZoom.value = String(zoomValue);
        ui.cameraZoomValue.textContent = zoomValue.toFixed(1);

        const applied = await tryApplyCameraZoomConstraint(zoomValue);
        if (applied) {
            state.camera.zoomLevel = zoomValue;
        }
    } else {
        ui.cameraZoomWrap.hidden = true;
        ui.cameraZoom.disabled = true;
    }

    state.camera.torchEnabled = false;
    cameraState.torchSupported = Boolean(cameraState.caps?.torch);
    updateTorchButtonState();
}

function handleCameraIntervalChanged() {
    const value = clampNumber(
        Number(ui.cameraInterval.value),
        CAMERA_SCAN_INTERVAL_MIN_MS,
        CAMERA_SCAN_INTERVAL_MAX_MS,
        CAMERA_SCAN_INTERVAL_DEFAULT_MS,
    );

    ui.cameraInterval.value = String(value);
    ui.cameraIntervalValue.textContent = String(value);
    state.camera.scanIntervalMs = value;
    void persistState();
}

async function handleCameraTorchToggle() {
    if (!cameraState.running || !cameraState.track) {
        setStatus(t("status.cameraTorchUnsupported"), true);
        return;
    }

    if (!cameraState.torchSupported) {
        setStatus(t("status.cameraTorchUnsupported"), true);
        return;
    }

    const nextTorch = !state.camera.torchEnabled;

    try {
        const applied = await tryApplyCameraTorchConstraint(nextTorch);
        if (!applied) {
            cameraState.torchSupported = false;
            updateTorchButtonState();
            setStatus(t("status.cameraTorchUnsupported"), true);
            return;
        }

        state.camera.torchEnabled = nextTorch;
        await persistState();
        updateTorchButtonState();
        setStatus(
            nextTorch ? t("status.cameraTorchEnabled") : t("status.cameraTorchDisabled"),
            false,
            true,
        );
    } catch (error) {
        setStatus(t("status.genericError", { error: formatError(error) }), true);
    }
}

function updateTorchButtonState() {
    if (!cameraState.running) {
        ui.cameraTorch.disabled = true;
        ui.cameraTorch.textContent = t("camera.torchButtonOff");
        return;
    }

    if (!cameraState.torchSupported) {
        ui.cameraTorch.disabled = true;
        ui.cameraTorch.textContent = t("camera.torchUnsupported");
        return;
    }

    ui.cameraTorch.disabled = false;
    ui.cameraTorch.textContent = state.camera.torchEnabled
        ? t("camera.torchButtonOn")
        : t("camera.torchButtonOff");
}

async function handleCameraZoomChanged() {
    const zoomValue = Number(ui.cameraZoom.value);
    ui.cameraZoomValue.textContent = zoomValue.toFixed(1);

    state.camera.zoomLevel = zoomValue;
    void persistState();

    if (!cameraState.running || !cameraState.track || !cameraState.caps?.zoom) {
        return;
    }

    const applied = await tryApplyCameraZoomConstraint(zoomValue);
    if (!applied) {
        setStatus(t("status.genericError", { error: "Cannot update camera zoom." }), true);
    }
}

async function tryApplyCameraZoomConstraint(zoomValue) {
    if (!cameraState.track) {
        return false;
    }

    const attempts = [
        { advanced: [{ zoom: zoomValue }] },
        { zoom: zoomValue },
    ];

    for (const constraints of attempts) {
        try {
            await cameraState.track.applyConstraints(constraints);
            return true;
        } catch (_error) {
            // Try next constraint shape.
        }
    }

    return false;
}

async function tryApplyCameraTorchConstraint(torchEnabled) {
    if (!cameraState.track) {
        return false;
    }

    const attempts = [
        { advanced: [{ torch: torchEnabled }] },
        { torch: torchEnabled },
    ];

    for (const constraints of attempts) {
        try {
            await cameraState.track.applyConstraints(constraints);
            return true;
        } catch (_error) {
            // Try next constraint shape.
        }
    }

    return false;
}

async function handleStopCamera(showStatus = true) {
    if (cameraState.loopTimer) {
        clearTimeout(cameraState.loopTimer);
        cameraState.loopTimer = null;
    }

    cameraState.running = false;
    cameraState.scanBusy = false;
    cameraState.lastDecodedText = "";
    cameraState.lastDecodedAt = 0;
    cameraState.canvasContext = null;
    cameraState.decodeCanvas = null;
    cameraState.decodeContext = null;

    if (cameraState.stream) {
        for (const track of cameraState.stream.getTracks()) {
            track.stop();
        }
    }

    cameraState.stream = null;
    cameraState.track = null;
    cameraState.caps = null;
    cameraState.torchSupported = false;
    state.camera.torchEnabled = false;

    ui.cameraVideo.srcObject = null;
    ui.cameraHint.hidden = false;
    ui.cameraZoomWrap.hidden = true;

    updateTorchButtonState();

    if (showStatus) {
        setStatus(t("status.cameraStopped"), false, true);
    }
}

async function requestCameraStream(preferredDeviceId) {
    const constraintsQueue = [];

    if (preferredDeviceId) {
        constraintsQueue.push({
            video: {
                deviceId: { exact: preferredDeviceId },
                width: { ideal: 1920 },
                height: { ideal: 1080 },
            },
            audio: false,
        });
    }

    constraintsQueue.push({
        video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
        },
        audio: false,
    });

    constraintsQueue.push({ video: true, audio: false });

    let lastError = null;
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
            }, clampNumber(
                Number(state.camera.scanIntervalMs),
                CAMERA_SCAN_INTERVAL_MIN_MS,
                CAMERA_SCAN_INTERVAL_MAX_MS,
                CAMERA_SCAN_INTERVAL_DEFAULT_MS,
            ));
        }
    };

    cameraState.loopTimer = window.setTimeout(() => {
        void tick();
    }, 50);
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

    const decodedText = state.camera.optimizeDecode !== false
        ? decodeCameraFrameOptimized(frameWidth, frameHeight)
        : decodeCameraFrameFull(frameWidth, frameHeight);
    if (!decodedText) {
        return;
    }

    const now = Date.now();
    if (
        decodedText === cameraState.lastDecodedText &&
        now - cameraState.lastDecodedAt < CAMERA_DEDUP_MS
    ) {
        return;
    }

    cameraState.lastDecodedText = decodedText;
    cameraState.lastDecodedAt = now;
    ui.cameraOutput.value = decodedText;

    let copiedToClipboard = false;
    if (state.camera.copyOnDetect && navigator.clipboard?.writeText) {
        try {
            await navigator.clipboard.writeText(decodedText);
            copiedToClipboard = true;
        } catch (_error) {
            copiedToClipboard = false;
        }
    }

    pushHistory("decode", t("camera.historySource"), decodedText);
    await persistState();

    if (ui.cameraAutoStop.checked) {
        await handleStopCamera(false);
        setStatus(
            copiedToClipboard
                ? t("status.cameraAutoStoppedCopied")
                : t("status.cameraAutoStopped"),
            false,
            true,
        );
        return;
    }

    setStatus(
        copiedToClipboard
            ? t("status.cameraDecodeCopied")
            : t("status.cameraDecodeSuccess"),
        false,
        true,
    );
}

function decodeCameraFrameOptimized(frameWidth, frameHeight) {
    const roiWidth = Math.max(120, Math.round(frameWidth * CAMERA_OPTIMIZED_ROI_RATIO));
    const roiHeight = Math.max(120, Math.round(frameHeight * CAMERA_OPTIMIZED_ROI_RATIO));
    const roiX = Math.max(0, Math.floor((frameWidth - roiWidth) / 2));
    const roiY = Math.max(0, Math.floor((frameHeight - roiHeight) / 2));

    const fromCenterRoi = decodeCameraFrameRegion(
        roiX,
        roiY,
        roiWidth,
        roiHeight,
        CAMERA_OPTIMIZED_DECODE_MAX_SIDE,
    );
    if (fromCenterRoi) {
        return fromCenterRoi;
    }

    const fromFullDownscaled = decodeCameraFrameRegion(
        0,
        0,
        frameWidth,
        frameHeight,
        CAMERA_OPTIMIZED_DECODE_MAX_SIDE,
    );
    if (fromFullDownscaled) {
        return fromFullDownscaled;
    }

    return decodeCameraFrameFull(frameWidth, frameHeight);
}

function decodeCameraFrameFull(frameWidth, frameHeight) {
    const imageData = cameraState.canvasContext.getImageData(0, 0, frameWidth, frameHeight);
    return decodeCameraImageData(imageData);
}

function decodeCameraFrameRegion(sourceX, sourceY, sourceWidth, sourceHeight, maxDecodeSide) {
    if (!cameraState.decodeCanvas) {
        cameraState.decodeCanvas = document.createElement("canvas");
    }

    if (!cameraState.decodeContext) {
        cameraState.decodeContext = cameraState.decodeCanvas.getContext("2d", {
            willReadFrequently: true,
        });
    }

    if (!cameraState.decodeContext) {
        return "";
    }

    const clampedWidth = Math.max(1, Math.floor(sourceWidth));
    const clampedHeight = Math.max(1, Math.floor(sourceHeight));
    const scale = Math.min(1, maxDecodeSide / Math.max(clampedWidth, clampedHeight));
    const targetWidth = Math.max(64, Math.round(clampedWidth * scale));
    const targetHeight = Math.max(64, Math.round(clampedHeight * scale));

    if (
        cameraState.decodeCanvas.width !== targetWidth ||
        cameraState.decodeCanvas.height !== targetHeight
    ) {
        cameraState.decodeCanvas.width = targetWidth;
        cameraState.decodeCanvas.height = targetHeight;
    }

    cameraState.decodeContext.drawImage(
        ui.cameraCanvas,
        sourceX,
        sourceY,
        clampedWidth,
        clampedHeight,
        0,
        0,
        targetWidth,
        targetHeight,
    );

    const imageData = cameraState.decodeContext.getImageData(0, 0, targetWidth, targetHeight);
    return decodeCameraImageData(imageData);
}

function decodeCameraImageData(imageData) {
    const decoded = decode_qr_from_rgba(
        imageData.width,
        imageData.height,
        new Uint8Array(imageData.data),
    );

    if (decoded == null) {
        return "";
    }

    return String(decoded).trim();
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
    setStatus(t("status.verifying"));

    try {
        const verified = await verifyLinkViaWasm(ui.verifyUrl.value);
        ui.verifyResult.value = verified.resolvedLink;
        pushHistory(
            "verify",
            verified.resolvedLink,
            verified.inputLink !== verified.resolvedLink
                ? verified.inputLink
                : t("verify.sameAsInput"),
        );
        await persistState();
        setStatus(t("status.verifySuccess"), false, true);
    } catch (error) {
        const reason = mapVerifyErrorToMessage(error);
        ui.verifyResult.value = reason;
        setStatus(`${t("status.verifyFailed")}: ${reason}`, true);
    }
}

async function verifyLinkViaWasm(rawInput) {
    if (typeof verify_link_wasm !== "function") {
        throw new Error("WASM verify export is unavailable.");
    }

    const result = await verify_link_wasm(String(rawInput ?? ""));
    const normalized = normalizeWasmVerifyResult(result);
    if (!normalized) {
        throw new Error("WASM verify result is invalid.");
    }

    return normalized;
}

function normalizeWasmVerifyResult(value) {
    if (!value || typeof value !== "object") {
        return null;
    }

    const inputLink = String(value.input_link ?? value.inputLink ?? "").trim();
    const resolvedLink = String(value.resolved_link ?? value.resolvedLink ?? "").trim();

    if (!inputLink || !resolvedLink) {
        return null;
    }

    return {
        inputLink,
        resolvedLink,
    };
}

function mapVerifyErrorToMessage(error) {
    const rawMessage = formatError(error);
    const parsed = /^(invalid-link|service-unavailable|cannot-resolve):\s*(.*)$/iu.exec(rawMessage);
    const kind = parsed?.[1]?.toLowerCase() || "cannot-resolve";
    const detail = String(parsed?.[2] || rawMessage || "").trim();

    let reason = t("verify.error_cannot_resolve");
    if (kind === "invalid-link") {
        reason = t("verify.error_invalid_link");
    } else if (kind === "service-unavailable") {
        reason = t("verify.error_service_unavailable");
    }

    if (!detail || detail === reason) {
        return reason;
    }

    return `${reason}: ${detail}`;
}

function normalizeUserInputLink(input) {
    const trimmed = String(input || "").trim();
    if (!trimmed) {
        throw new Error("Input link is empty");
    }

    const direct = tryNormalizeHttpUrl(trimmed);
    if (direct) {
        return direct;
    }

    const withHttps = tryNormalizeHttpUrl(`https://${trimmed}`);
    if (withHttps) {
        return withHttps;
    }

    throw new Error("Input link format is invalid");
}

function tryNormalizeHttpUrl(candidate) {
    try {
        const url = new URL(String(candidate || ""));
        if (url.protocol === "http:" || url.protocol === "https:") {
            return url.toString();
        }
    } catch (_error) {
        return null;
    }

    return null;
}

function getVerifyOutputLinkForChecker() {
    const output = String(ui.verifyResult.value || "").trim();
    if (!output) {
        setStatus(t("status.verifyOutputEmpty"), true);
        return null;
    }

    try {
        return normalizeUserInputLink(output);
    } catch (_error) {
        setStatus(t("verify.error_invalid_link"), true);
        return null;
    }
}

function openExternalCheckerPage(checkerUrl) {
    try {
        const opened = window.open(checkerUrl, "_blank", "noopener,noreferrer");
        if (opened) {
            setStatus(t("status.openedExternalChecker"), false, true);
            return;
        }
    } catch (_error) {
        // Continue with status fallback below.
    }

    setStatus(t("status.openExternalBlocked"), true);
}

function handleOpenVerifyOutputInVirusTotal() {
    const link = getVerifyOutputLinkForChecker();
    if (!link) {
        return;
    }

    const checkerUrl = `https://www.virustotal.com/gui/search?query=${encodeURIComponent(link)}`;
    openExternalCheckerPage(checkerUrl);
}

function fitSettingsSelectWidths() {
    const languageWidthCh = getSelectContentWidthCh(ui.languageSelect);
    const themeWidthCh = getSelectContentWidthCh(ui.themeSelect);
    const baseWidthCh = Math.max(languageWidthCh, themeWidthCh);
    const sharedWidthCh = Math.max(13, Math.min(26, Math.ceil(baseWidthCh * 1.2)));

    if (ui.languageSelect) {
        ui.languageSelect.style.width = `${sharedWidthCh}ch`;
    }

    if (ui.themeSelect) {
        ui.themeSelect.style.width = `${sharedWidthCh}ch`;
    }
}

function getSelectContentWidthCh(selectNode) {
    if (!selectNode) {
        return 11;
    }

    let maxChars = 0;
    for (const option of Array.from(selectNode.options || [])) {
        maxChars = Math.max(maxChars, String(option.textContent || "").trim().length);
    }

    return Math.max(11, Math.min(22, maxChars + 3));
}

function pushHistory(kind, input, output) {
    const entry = {
        id: crypto.randomUUID(),
        kind,
        input: compactHistoryText(input, 180),
        output: compactHistoryText(output, 420),
        at: new Date().toISOString(),
    };

    state.history.unshift(entry);
    state.history = state.history.slice(0, HISTORY_LIMIT);
    renderHistory();
}

function compactHistoryText(value, maxLength) {
    const normalized = String(value ?? "").replace(/\s+/g, " ").trim();

    if (wasmReady && typeof compact_history_text === "function") {
        try {
            return compact_history_text(normalized, Math.max(8, Math.floor(maxLength)));
        } catch (_error) {
            // Fall back to local compact logic.
        }
    }

    return compactText(normalized, maxLength);
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
        content.textContent = `${entry.input} | ${entry.output}`;

        item.append(head, content);
        ui.historyList.appendChild(item);
    }
}

async function blobToImageData(blob) {
    const objectUrl = URL.createObjectURL(blob);

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

function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("Cannot read file as data URL."));
        reader.readAsDataURL(blob);
    });
}

function loadImageElement(src) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("Cannot open image."));
        image.src = src;
    });
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

function clampNumber(value, min, max, fallback) {
    if (!Number.isFinite(value)) {
        return fallback;
    }

    return Math.min(max, Math.max(min, value));
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
    const overlay = generate.overlay && typeof generate.overlay === "object" ? generate.overlay : {};
    const camera = safe.camera && typeof safe.camera === "object" ? safe.camera : {};
    const overlayChoice = resolveOverlayFontChoice(overlay.fontFamily, overlay.fontStyle);

    return {
        language: safe.language === "en" ? "en" : "vi",
        theme: normalizeTheme(safe.theme),
        history: Array.isArray(safe.history) ? safe.history.slice(0, HISTORY_LIMIT) : [],
        generate: {
            content: "",
            size: clampNumber(Number(generate.size), 192, 1536, 640),
            dark: isColorHex(generate.dark) ? generate.dark : "#111111",
            light: isColorHex(generate.light) ? generate.light : "#ffffff",
            overlay: {
                text: typeof overlay.text === "string" ? overlay.text : "",
                textSizePx: clampNumber(Number(overlay.textSizePx), 10, 64, 20),
                fontFamily: overlayChoice.family,
                fontStyle: overlayChoice.style,
                ratioPercent: clampNumber(
                    Number(overlay.ratioPercent),
                    OVERLAY_RATIO_MIN_PERCENT,
                    OVERLAY_RATIO_MAX_PERCENT,
                    OVERLAY_RATIO_DEFAULT_PERCENT,
                ),
                cornerRadiusPercent: clampNumber(
                    Number(overlay.cornerRadiusPercent),
                    OVERLAY_CORNER_RADIUS_MIN_PERCENT,
                    OVERLAY_CORNER_RADIUS_MAX_PERCENT,
                    OVERLAY_CORNER_RADIUS_DEFAULT_PERCENT,
                ),
                textColor: isColorHex(overlay.textColor) ? overlay.textColor : "#111111",
                boxColor: isColorHex(overlay.boxColor) ? overlay.boxColor : "#ffffff",
            },
        },
        camera: {
            autoStopOnFirst: camera.autoStopOnFirst !== false,
            preferredDeviceId: typeof camera.preferredDeviceId === "string"
                ? camera.preferredDeviceId
                : "",
            scanIntervalMs: clampNumber(
                Number(camera.scanIntervalMs),
                CAMERA_SCAN_INTERVAL_MIN_MS,
                CAMERA_SCAN_INTERVAL_MAX_MS,
                CAMERA_SCAN_INTERVAL_DEFAULT_MS,
            ),
            copyOnDetect: camera.copyOnDetect === true,
            optimizeDecode: camera.optimizeDecode !== false,
            torchEnabled: camera.torchEnabled === true,
            zoomLevel: Number.isFinite(Number(camera.zoomLevel))
                ? Number(camera.zoomLevel)
                : 1,
        },
    };
}

function isColorHex(value) {
    return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

async function storageGet(key) {
    if (typeof browser !== "undefined" && browser?.storage?.local?.get) {
        return await browser.storage.local.get(key);
    }

    if (typeof chrome === "undefined" || !chrome?.storage?.local?.get) {
        throw new Error("Extension storage API is unavailable.");
    }

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
    if (typeof browser !== "undefined" && browser?.storage?.local?.set) {
        await browser.storage.local.set(value);
        return;
    }

    if (typeof chrome === "undefined" || !chrome?.storage?.local?.set) {
        throw new Error("Extension storage API is unavailable.");
    }

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

