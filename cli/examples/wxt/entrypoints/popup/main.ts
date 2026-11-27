const count = 3;
document.getElementById("hello")!.textContent = browser.i18n.getMessage("savedTabs", [String(count)]);
