// background.js — 负责调用智谱 API，管理缓存

// 首次安装时打开引导页
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });
  }
});

const GLM_API = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const MODEL = "glm-4-flash-250414"; // 免费模型
const PROMPT_VERSION = "v7";

const SYSTEM_PROMPT = `你是一个专门识别知乎软文广告、种草文、带货文的助手。
目标：高召回。宁可多拦截疑似软广，也不要漏掉包装成经验、科普、干货、案例、测评、内幕、指南的商业推广。

判为 is_ad=true：标题或开头明显服务于商业转化，包括商品、品牌、软件/App、课程、咨询、私教、营销服务、SaaS、代运营、加盟等。
常见信号：
- 选购/推荐/避坑：是不是智商税、有必要买吗、怎么选、不踩坑、防坑指南、哪个系列最好、哪款好、推荐哪款/哪台/哪个、闭眼入、性价比、618/双11。
- 商品或品类导购：空调、电视、制氧机、学习机、中央空调、生日提醒软件、营养补充、小分子蛋白肽、益生菌、健身减脂增肌等。
- 服务或方案导流：SEO、网站建设、独立站、外链/反链、Google排名、长尾词、内容推广、私域、获客、转化率、营销自动化。
- 商业包装话术：行业内幕、乱象、误区、成本拆解、横评实测、用了多久说实话、市场潜力、赛道机会、客户/用户/项目案例。
- 身份背书：营养师、医生、老师、工程师、宝妈、装修/医疗器械/营销/SEO从业者等身份引出产品、服务、方法或方案。

不要因为开头没有链接、二维码、联系方式、完整型号就判 false。知乎软广经常先建立信任，转化信息可能在正文后半段或评论区。

判为 is_ad=false：主要是知识科普、社会讨论、新闻评论、真实求助或普通经验分享，且没有商品/服务/软件/课程/咨询/方案的推荐、选购、引流或商业转化倾向。

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
