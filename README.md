# 🚫 知乎软广过滤器

<p>
  <img src="icons/icon128.png" width="96" alt="icon" />
</p>

基于智谱 GLM 大模型，自动识别并隐藏知乎 Feed 中的**软文广告**（种草、带货、品牌植入等伪装成正常帖子的内容）。

> 本插件**不**处理知乎自带「推广」标签的原生广告，那种请用 AdBlock 类插件。本插件只管那些看起来像正常分享、实则引导消费的软文。

---

## ✨ 功能

- 自动扫描知乎首页 / 推荐 / 回答列表里的每条帖子
- 交给大模型判断是否为软文广告，判定为软广的帖子折叠隐藏
- 原位置留一条提示条，支持**一键展开 / 重新折叠**
- 每条帖子右上角显示**实时状态徽标**：等待中 / 识别中 / 非软广 / 软广 / 已取消 / 失败
- 全局**串行队列**，一次只请求一条，不烧 API 额度
- 用户划过视窗、尚未处理的帖子自动**取消识别**
- 结果本地缓存（内存 + `chrome.storage.local`），同一条不重复请求
- 保存 API Key 时自动**测试可用性**
- 首次安装弹出**使用引导页**

## 🛠️ 实现原理

```
页面加载 / 滚动
   ↓
MutationObserver 捕获 Feed 节点
   ↓
抓取 标题 + 开头 200 字
   ↓
串行入队 → Service Worker 调用 GLM API
   ↓
返回 { is_ad, reason }
   ↓
折叠节点 / 放行
```

- **Content Script**：`MutationObserver` 监听 DOM；`IntersectionObserver` 检测视窗离开时取消排队任务；嵌套选择器去重（`.TopstoryItem` ⊃ `.Feed` ⊃ `.ContentItem` 只处理最外层）。
- **Service Worker**：统一调用智谱 [`glm-4-flash`](https://open.bigmodel.cn)（免费模型），双层缓存。
- **Prompt**：系统提示词描述软广特征（第一人称体验、品牌植入、引导购买等），要求严格返回 JSON。

## 📦 安装

### 方式 1：加载解压的扩展程序（推荐）

1. 克隆本仓库：
   ```bash
   git clone https://github.com/g03024735/zhihu-ad-filter.git
   ```
2. 打开 Chrome → `chrome://extensions/`
3. 右上角开启「开发者模式」
4. 点「加载已解压的扩展程序」→ 选中克隆下来的目录
5. 首次安装会自动弹出使用说明页

### 方式 2：Chrome 应用商店

（待上架）

## 🔑 申请智谱 API Key（免费）

1. 打开 [https://open.bigmodel.cn](https://open.bigmodel.cn)，注册登录
2. 控制台 → API Keys / 密钥管理 → 创建
3. 复制形如 `xxxxxxxx.yyyyyy` 的字符串
4. `glm-4-flash` 本身完全免费，新用户还有赠送 Token

## 🚀 使用

1. 点 Chrome 右上角插件图标 🚫
2. 粘贴 API Key，点「保存」（会自动测试有效性）
3. 打开 [知乎](https://www.zhihu.com)，开始刷

## 🏷️ 状态徽标

| 徽标 | 含义 |
|---|---|
| ⏳ 等待中 | 已入队，排队等待 |
| 🔄 识别中 | 正在请求 API |
| ✓ 非软广 | 正常帖子，已放行 |
| 🚫 软广 | 判定为软广，已折叠 |
| ⊘ 已取消 | 你滑过去了，跳过 |
| ○ 未识别 | 无可提取内容 |
| ⚠ 失败 | API 或网络错误 |

## 🔒 隐私

- API Key 只保存在你本地浏览器（`chrome.storage.sync`），不上传第三方
- 只把**标题** + **开头 200 字**发给智谱 API
- 不上传 cookie、账号、正文全文
- 除智谱 API 外不经过任何第三方服务器

## 📁 项目结构

```
.
├── manifest.json        # MV3 清单
├── background.js        # Service Worker：调 GLM API、缓存、Key 测试
├── content.js           # 内容脚本：抓取 Feed、串行队列、状态徽标、折叠
├── popup.html / .js     # 工具栏弹窗：开关、API Key 配置、统计
├── onboarding.html      # 首次安装引导页
├── icons/               # 扩展图标（16/32/48/128）
└── icon.svg             # 图标源文件
```

## 🤝 贡献

欢迎 PR 或 Issue。特别欢迎：

- 更精准的 Prompt 调优（降低误判）
- 适配更多知乎页面形态（专栏、搜索结果等）
- 性能优化

## 📄 License

[MIT](./LICENSE)
