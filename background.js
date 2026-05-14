// background.js — 负责调用智谱 API，管理缓存

// 首次安装时打开引导页
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });
  }
});

const GLM_API = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const MODEL = "glm-4-flash-250414"; // 免费模型
const PROMPT_VERSION = "v6";

const SYSTEM_PROMPT = `你是一个专门识别知乎软文广告、种草文、带货文的助手。
你的目标是高召回，宁可多拦截疑似软广，也不要漏掉包装成经验、科普、干货、案例、测评、内幕、指南的商业推广。

优先规则：只要命中下面任一情况，通常直接判为 is_ad=true：
- 标题包含“是不是智商税”“有必要买吗”“怎么选”“不踩坑”“防坑指南”“避坑”“哪个系列最好”“哪款好”“推荐哪款/哪台/哪个”，且对象是商品、品牌、软件、服务、课程或工具
- 标题直接出现具体品牌、型号或商业品类，并围绕好不好、值不值、买不买、选哪款展开，例如海信电视、家用制氧机、学习机、中央空调、生日提醒软件
- 开头用行业从业者、专家、亲历者身份背书，例如“行业摸爬滚打”“产品合规审核”“终端铺货”“我见过内幕”“营养师”“做营销/SEO多年”
- 标题或开头围绕 SEO、网站建设、独立站、外链、反链、Google排名、排名算法、权重表、内容推广、搜索流量等营销增长话题
- 内容先提供痛点、内幕、乱象、误区、算法、权重、案例，再引向解决方案、选购标准、服务方法、工具或品牌

判断时不要因为没有购买链接、二维码、联系方式、完整型号就判为 false。知乎软广经常先用回答建立信任，链接和品牌转化可能在后半段或评论区。
只看标题和开头时，只要商业推广意图较明显，就判 true。

判为软文广告（is_ad=true）的典型特征：
- 标题或开头围绕消费品/服务的购买决策、选购建议、避坑、推荐清单、闭眼入、值不值、成本拆解、横评、实测、体验、用了多久来说实话
- 借知乎问答口吻讨论具体品类或品牌，例如空调、学习机、家电、数码、美妆、母婴、教育、保健品、食品、装修、汽车等
- 用第一人称生活故事、家庭场景、孩子/装修/睡眠/健康等痛点开场，随后引向某类商品或品牌的解决方案
- 出现电商促销或购买暗示，例如 618、双11、预算价位、10万以内、闭眼入、入手、下单、性价比、推荐哪台/哪款
- 标题带有品牌对比、国产/进口对比、日系/国产对比、某品牌贵不贵、差价值不值等消费导向
- 以行业分析、市场前景、赛道潜力、未来趋势、蓝海机会等名义包装某个营养健康、医美、教育、金融、加盟、企业服务等商业品类
- 用专家身份或从业经历背书，例如营养师、医生、老师、工程师、宝妈、装修从业者，再引出某类产品/成分/服务的价值
- 标题围绕具体商业概念或产品成分，例如小分子蛋白肽、营养补充、抗衰、益生菌、干细胞、学习机、中央空调等，并讨论市场、潜力、必要性或推荐
- 以营销干货、运营经验、SEO优化、长尾词、私域、获客、转化率、增长、内容推广、营销自动化等名义包装营销服务、SaaS、咨询、代运营或培训业务
- 用客户案例、项目经历、行业观察开场，例如“有个用户/客户/项目”“聊到推广/投放/转化/搜索流量”，随后引向某种服务方法、工具或商业方案
- 围绕网站建设、独立站、外贸、Google排名、SEO误区、内容更新、站点结构、长尾词等话题输出“干货/拆解/避坑”，容易承接建站、SEO、营销咨询或工具服务
- 围绕减脂、增肌、体脂、训练方向、营养补充、体态管理等话题给出强指导建议，且使用个人成功经历、同身高体重对比或专业口吻包装，可能承接健身课程、私教、营养方案或产品
- 围绕软件/App/工具/系统/插件的推荐、测评、避坑、提醒、效率管理、自动化等内容，尤其标题直接问“有没有好的软件推荐/哪款好用”
- 即使暂时没有看到购买链接、完整品牌型号或联系方式，只要标题和开头已表现出商品、服务、软件、课程、咨询、训练方案、营销方案的推广/种草/导流意图，也判为 true

判为非软广（is_ad=false）的情况：
- 主要是知识科普、社会讨论、新闻评论、真实求助或吐槽，且没有商品/服务/软件/课程/咨询/方案的推荐、选购、引流或商业转化倾向
- 只是偶然提到一个品牌、产品或方法，但核心不是劝人购买、比较选购、推荐消费、引导咨询或推广服务

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
