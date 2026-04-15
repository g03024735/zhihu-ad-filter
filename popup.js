// popup.js

const toggleSwitch = document.getElementById("toggleSwitch");
const apiKeyInput = document.getElementById("apiKeyInput");
const saveBtn = document.getElementById("saveBtn");
const savedTip = document.getElementById("savedTip");
const hiddenCountEl = document.getElementById("hiddenCount");

// 加载已保存的设置
chrome.storage.sync.get(["filterEnabled", "glmApiKey"], (r) => {
  toggleSwitch.checked = r.filterEnabled !== false;
  if (r.glmApiKey) {
    apiKeyInput.value = r.glmApiKey;
    apiKeyInput.type = "password";
  }
});

// 加载统计
chrome.runtime.sendMessage({ type: "GET_STATS" }, (res) => {
  hiddenCountEl.textContent = res?.hiddenCount || 0;
});

// 开关切换
toggleSwitch.addEventListener("change", () => {
  chrome.storage.sync.set({ filterEnabled: toggleSwitch.checked });
});

// 显示提示
function showTip(text, kind) {
  savedTip.textContent = text;
  savedTip.classList.remove("ok", "err", "pending");
  savedTip.classList.add("show", kind);
}
function hideTipLater(ms = 3000) {
  setTimeout(() => savedTip.classList.remove("show"), ms);
}

// 保存 API Key：先测试再保存
saveBtn.addEventListener("click", async () => {
  const key = apiKeyInput.value.trim();
  if (!key) return;

  saveBtn.disabled = true;
  showTip("测试中…", "pending");

  const res = await chrome.runtime.sendMessage({ type: "TEST_KEY", apiKey: key });

  if (res?.ok) {
    chrome.storage.sync.set({ glmApiKey: key }, () => {
      showTip("✓ 已保存", "ok");
      hideTipLater();
    });
  } else {
    showTip("✗ " + (res?.error || "无效"), "err");
    hideTipLater(4000);
  }

  saveBtn.disabled = false;
});

// 点击输入框时明文显示
apiKeyInput.addEventListener("focus", () => {
  apiKeyInput.type = "text";
});
apiKeyInput.addEventListener("blur", () => {
  if (apiKeyInput.value) apiKeyInput.type = "password";
});

// 打开使用说明
document.getElementById("openGuide").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });
});
