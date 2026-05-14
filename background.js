// background.js — 负责调用智谱 API，管理缓存

// 首次安装时打开引导页
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });
  }
});

const GLM_API = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const MODEL = "glm-4-flash-250414"; // 免费模型
const PROMPT_VERSION = "v2";

const SYSTEM_PROMPT = `你是一个专门识别知乎软文广告、种草文、带货文的助手。
你的目标是高召回：只要内容明显在影响消费决策、引导购买或包装成测评推荐，就应判为软文广告。

判为软文广告（is_ad=true）的典型特征：
- 标题或开头围绕消费品/服务的购买决策、选购建议、避坑、推荐清单、闭眼入、值不值、成本拆解、横评、实测、体验、用了多久来说实话
- 借知乎问答口吻讨论具体品类或品牌，例如空调、学习机、家电、数码、美妆、母婴、教育、保健品、食品、装修、汽车等
- 用第一人称生活故事、家庭场景、孩子/装修/睡眠/健康等痛点开场，随后引向某类商品或品牌的解决方案
- 出现电商促销或购买暗示，例如 618、双11、预算价位、10万以内、闭眼入、入手、下单、性价比、推荐哪台/哪款
- 标题带有品牌对比、国产/进口对比、日系/国产对比、某品牌贵不贵、差价值不值等消费导向
- 即使暂时没有看到购买链接或完整品牌型号，只要标题和开头已表现出商品推荐/种草/导购意图，也判为 true

判为非软广（is_ad=false）的情况：
- 主要是知识科普、社会讨论、新闻评论、真实求助或吐槽，且没有商品推荐、选购引导、品牌/品类导购倾向
- 只是偶然提到一个品牌或产品，但核心不是劝人购买、比较选购或推荐消费

请判断给定的知乎标题和开头内容是否为软文广告。
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
  const cacheKey = `${PROMPT_VERSION}|||${title}|||${snippet}`.slice(0, 240);

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
