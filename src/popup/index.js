/**
 * Popup 脚本：点击按钮打开 options 配置页。
 */
document.getElementById("open-options")?.addEventListener("click", () => {
  if (chrome.runtime?.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  } else {
    alert("无法打开配置页，请在扩展详情中选择“扩展程序选项”。");
  }
});
