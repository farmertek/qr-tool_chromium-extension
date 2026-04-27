const APP_PAGE = "app.html";
const extensionApi = typeof browser !== "undefined" ? browser : chrome;

extensionApi.action.onClicked.addListener(() => {
    extensionApi.tabs.create({ url: extensionApi.runtime.getURL(APP_PAGE) });
});
