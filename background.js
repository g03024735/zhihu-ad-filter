// background.js — 负责调用智谱 API，管理缓存

// 首次安装时打开引导页
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });
  }
});

const GLM_API = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const MODEL = "glm-4-flash-250414"; // 免费模型

const SYSTEM_PROMPT = `你是一个专门识别知乎软文广告的助手。
软文广告的典型特征：
- 以"亲测"、"种草"、"推荐"、"体验"等名义，实质是推销某个具体产品或品牌
- 标题常带品牌名/产品名/展会名，内容用第一人称讲使用体验
- 行文像分享，但核心是引导购买或关注某商品
- 常见于美妆、家电、数码、保健品、食品等消费品领域

请判断给定的知乎内容是否为软文广告。
只返回 JSON，格式为：{"is_ad": true 或 false, "reason": "一句话理由"}
不要输出任何其他内容。`;

// 内存缓存（Service Worker 重启后清空，持久化用 storage）
const memCache = new Map();

async function getApiKey() {
  const result = await chrome.storage.sync.get("glmApiKey");
  return result.glmApiKey || "";
}

async function classifyContent(title, snippet) {
  // 生成缓存 key（简单哈希）
  const cacheKey = `${title}|||${snippet}`.slice(0, 200);

  // 先查内存缓存
  if (memCache.has(cacheKey)) {
    return memCache.get(cacheKey);
  }

  // 再查持久缓存
  const stored = await chrome.storage.local.get(cacheKey);
  if (stored[cacheKey] !== undefined) {
    memCache.set(cacheKey, stored[cacheKey]);
    return stored[cacheKey];
  }

  const apiKey = await getApiKey();
  if (!apiKey) {
    return { is_ad: false, reason: "未配置 API Key" };
  }

  const userContent = `标题：${title}\n\n开头内容：${snippet}`;

  try {
    const resp = await fetch(GLM_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 100,
        temperature: 0.1,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
      }),
    });

    if (!resp.ok) {
      console.error("[软广过滤] API 错误:", resp.status);
      return { is_ad: false, reason: "API 请求失败" };
    }

    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content || "{}";

    let result;
    try {
      result = JSON.parse(text.replace(/```json|```/g, "").trim());
    } catch {
      result = { is_ad: false, reason: "解析失败" };
    }

    // 写入缓存
    memCache.set(cacheKey, result);
    await chrome.storage.local.set({ [cacheKey]: result });

    return result;
  } catch (err) {
    console.error("[软广过滤] 请求异常:", err);
    return { is_ad: false, reason: "网络异常" };
  }
}

// 测试 API Key 是否有效：发一个极简请求
async function testApiKey(apiKey) {
  if (!apiKey) return { ok: false, error: "Key 为空" };
  try {
    const resp = await fetch(GLM_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    if (resp.ok) return { ok: true };
    const data = await resp.json().catch(() => ({}));
    const msg = data?.error?.message || `HTTP ${resp.status}`;
    return { ok: false, error: msg };
  } catch (err) {
    return { ok: false, error: err.message || "网络异常" };
  }
}

// 监听来自 content script 的消息
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "CLASSIFY") {
    classifyContent(msg.title, msg.snippet).then(sendResponse);
    return true; // 保持异步通道
  }

  if (msg.type === "TEST_KEY") {
    testApiKey(msg.apiKey).then(sendResponse);
    return true;
  }

  if (msg.type === "GET_STATS") {
    chrome.storage.local.get("hiddenCount", (r) => {
      sendResponse({ hiddenCount: r.hiddenCount || 0 });
    });
    return true;
  }

  if (msg.type === "INC_HIDDEN") {
    chrome.storage.local.get("hiddenCount", (r) => {
      chrome.storage.local.set({ hiddenCount: (r.hiddenCount || 0) + 1 });
    });
  }
});
