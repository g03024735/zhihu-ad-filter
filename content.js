// content.js — 监听知乎 Feed，提取内容，驱动隐藏

// 是否启用过滤（从 storage 读取）
let filterEnabled = true;
chrome.storage.sync.get("filterEnabled", (r) => {
  filterEnabled = r.filterEnabled !== false;
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.filterEnabled) {
    filterEnabled = changes.filterEnabled.newValue !== false;
  }
});

// 已处理过的节点，避免重复判断
const processedNodes = new WeakSet();

// 在 Feed 节点右上角展示状态徽标
const BADGE_STATES = {
  queued:     { text: "⏳ 等待中",   bg: "#f5f5f5", color: "#999" },
  processing: { text: "🔄 识别中",   bg: "#e3f2fd", color: "#1976d2" },
  clean:      { text: "✓ 非软广",   bg: "#e8f5e9", color: "#388e3c" },
  ad:         { text: "🚫 软广",    bg: "#fff3e0", color: "#e65100" },
  cancelled:  { text: "⊘ 已取消",   bg: "#fafafa", color: "#bbb" },
  skipped:    { text: "○ 未识别",   bg: "#f5f5f5", color: "#888" },
  error:      { text: "⚠ 失败",     bg: "#ffebee", color: "#c62828" },
};

function setBadge(node, state) {
  const conf = BADGE_STATES[state];
  if (!conf) return;

  let badge = node.querySelector(":scope > .__zhihu_ad_badge__");
  if (!badge) {
    if (getComputedStyle(node).position === "static") {
      node.style.position = "relative";
    }
    badge = document.createElement("div");
    badge.className = "__zhihu_ad_badge__";
    badge.style.cssText = `
      position: absolute; top: 8px; right: 8px; z-index: 10;
      padding: 2px 8px; border-radius: 10px;
      font-size: 11px; line-height: 16px;
      pointer-events: none;
      transition: opacity 0.4s;
    `;
    node.appendChild(badge);
  }
  badge.textContent = conf.text;
  badge.style.background = conf.bg;
  badge.style.color = conf.color;
  badge.style.opacity = "1";
}

// 几秒后淡出徽标，避免干扰
function fadeBadge(node, delay = 2500) {
  const badge = node.querySelector(":scope > .__zhihu_ad_badge__");
  if (!badge) return;
  setTimeout(() => {
    badge.style.opacity = "0";
    setTimeout(() => badge.remove(), 500);
  }, delay);
}

// 从一个 Feed 节点提取标题和摘要
function extractContent(node) {
  // 知乎 Feed 的常见 DOM 结构（适配问答、文章、想法）
  const titleEl =
    node.querySelector("h2") ||
    node.querySelector(".ContentItem-title") ||
    node.querySelector('[data-zop-question]');

  const snippetEl =
    node.querySelector(".ContentItem-summary") ||
    node.querySelector(".RichContent-inner") ||
    node.querySelector(".CopyrightRichContent") ||
    node.querySelector("[itemprop='text']");

  const title = titleEl?.innerText?.trim() || "";
  // 只取前 200 字，够判断了
  const snippet = snippetEl?.innerText?.trim().slice(0, 200) || "";

  return { title, snippet };
}

// 折叠节点（视觉隐藏）：连同 padding / border / margin 一起归零
function collapseNode(node) {
  node.style.transition =
    "opacity 0.3s, max-height 0.4s, padding 0.4s, margin 0.4s, border-width 0.4s";
  node.style.overflow = "hidden";
  node.style.opacity = "0.05";
  node.style.maxHeight = node.offsetHeight + "px";
  setTimeout(() => {
    if (node.dataset.adHidden === "1") {
      node.style.maxHeight = "0";
      node.style.paddingTop = "0";
      node.style.paddingBottom = "0";
      node.style.marginTop = "0";
      node.style.marginBottom = "0";
      node.style.borderTopWidth = "0";
      node.style.borderBottomWidth = "0";
    }
  }, 300);
}

// 展开节点
function expandNode(node) {
  node.style.opacity = "";
  node.style.maxHeight = "";
  node.style.overflow = "";
  node.style.paddingTop = "";
  node.style.paddingBottom = "";
  node.style.marginTop = "";
  node.style.marginBottom = "";
  node.style.borderTopWidth = "";
  node.style.borderBottomWidth = "";
}

// 隐藏节点，带可切换的提示条
function hideNode(node, reason) {
  if (node.dataset.adHidden) return;
  node.dataset.adHidden = "1";

  setBadge(node, "ad");
  collapseNode(node);

  const bar = document.createElement("div");
  bar.className = "__zhihu_ad_bar__";
  bar.style.cssText = `
    display: flex; align-items: center; justify-content: space-between;
    padding: 6px 16px; margin: 4px 0;
    background: #fff8e1; border-left: 3px solid #ffc107;
    font-size: 12px; color: #888; border-radius: 2px;
  `;
  const btnStyle = "border:none;background:transparent;color:#1772f6;cursor:pointer;font-size:12px;padding:0";
  bar.innerHTML = `
    <span class="__zhihu_ad_label__">🚫 疑似软广已隐藏 · <span style="color:#bbb;font-size:11px">${reason}</span></span>
    <button class="__zhihu_ad_toggle__" style="${btnStyle}">显示</button>
  `;

  const label = bar.querySelector(".__zhihu_ad_label__");
  const btn = bar.querySelector(".__zhihu_ad_toggle__");
  btn.addEventListener("click", () => {
    if (node.dataset.adHidden === "1") {
      node.dataset.adHidden = "0";
      expandNode(node);
      btn.textContent = "隐藏";
      label.innerHTML = `👀 已显示 · <span style="color:#bbb;font-size:11px">${reason}</span>`;
    } else {
      node.dataset.adHidden = "1";
      collapseNode(node);
      btn.textContent = "显示";
      label.innerHTML = `🚫 疑似软广已隐藏 · <span style="color:#bbb;font-size:11px">${reason}</span>`;
    }
  });

  node.parentNode?.insertBefore(bar, node);

  chrome.runtime.sendMessage({ type: "INC_HIDDEN" });
}

// 全局串行队列：一次只处理一条，避免并发请求 API
const taskQueue = [];
let queueRunning = false;

async function runQueue() {
  if (queueRunning) return;
  queueRunning = true;
  while (taskQueue.length) {
    const node = taskQueue.shift();
    visibilityObserver.unobserve(node); // 已开始处理，不再取消
    try {
      await classifyAndHide(node);
    } catch (err) {
      console.error("[软广过滤] 处理异常:", err);
    }
  }
  queueRunning = false;
}

// 视窗可见性：曾出现又滑出的节点，若还在队列里，直接取消
const visibilityObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      const node = entry.target;
      if (entry.isIntersecting) {
        node.dataset.adSeen = "1";
      } else if (node.dataset.adSeen === "1") {
        const idx = taskQueue.indexOf(node);
        if (idx !== -1) {
          taskQueue.splice(idx, 1);
          setBadge(node, "cancelled");
          visibilityObserver.unobserve(node);
        }
      }
    }
  },
  { threshold: 0 }
);

async function classifyAndHide(node) {
  if (!filterEnabled) return;
  if (!node.isConnected) return; // 已被移除的节点跳过

  const { title, snippet } = extractContent(node);
  if (!title && !snippet) {
    setBadge(node, "skipped");
    return;
  }

  setBadge(node, "processing");

  const result = await chrome.runtime.sendMessage({
    type: "CLASSIFY",
    title,
    snippet,
  });

  if (result?.is_ad) {
    hideNode(node, result.reason || "");
    // 节点被折叠，徽标随之消失，不需要再处理
  } else if (result?.reason && /失败|异常|未配置/.test(result.reason)) {
    setBadge(node, "error");
  } else {
    setBadge(node, "clean");
  }
}

// 入队：去重 + 启动队列
function processFeedItem(node) {
  if (processedNodes.has(node)) return;
  // 嵌套去重：如果祖先已被处理，跳过当前节点
  for (let p = node.parentElement; p; p = p.parentElement) {
    if (processedNodes.has(p)) return;
  }
  processedNodes.add(node);
  if (filterEnabled) setBadge(node, "queued");
  taskQueue.push(node);
  visibilityObserver.observe(node);
  runQueue();
}

// 找出页面中所有 Feed 条目
function findFeedItems(root = document) {
  // 知乎 Feed 条目的常见容器选择器
  return root.querySelectorAll(
    ".Feed, .ContentItem, .TopstoryItem, .PinItem"
  );
}

// 批量处理当前可见的 Feed 条目
function processVisible() {
  findFeedItems().forEach((node) => processFeedItem(node));
}

// MutationObserver 监听动态加载
const observer = new MutationObserver((mutations) => {
  if (!filterEnabled) return;
  for (const mutation of mutations) {
    for (const added of mutation.addedNodes) {
      if (added.nodeType !== 1) continue;
      // 如果本身是 Feed 节点
      if (
        added.classList?.contains("Feed") ||
        added.classList?.contains("ContentItem") ||
        added.classList?.contains("TopstoryItem") ||
        added.classList?.contains("PinItem")
      ) {
        processFeedItem(added);
      }
      // 或者子树中包含 Feed 节点
      findFeedItems(added).forEach((node) => processFeedItem(node));
    }
  }
});

// 启动
observer.observe(document.body, { childList: true, subtree: true });
processVisible();
