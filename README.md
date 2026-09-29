# 考研每日一句

一个轻量的静态页面，按当天日期从 Base64 数据文件中取出对应的考研鼓励句，**即用即解**，避免提前看到内容。

## 功能

- 自动获取当天日期，匹配数据文件中对应的句子。
- 句子以 Base64 编码存储，页面加载时才解码显示，防止人类提前阅读。
- 日期显示规则：
  - 2026 年：显示 `mm-dd`
  - 其他年份：显示 `yyyy-mm-dd`
- 若当天日期未在数据文件中匹配到内容，显示：`不在2027考研初试备考时间`
- 使用霞鹜文楷中文字体，阅读体验舒适。
- 底部显示“每日一句”。

## 文件结构

```
.
├── index.html
├── 考研每日一句_83天_Base64.txt
└── fonts/
    └── LXGWWenKai-Regular.woff2
```

## 使用方法

1. 下载或克隆本仓库。
2. 确保 `考研每日一句_83天_Base64.txt` 与 `index.html` 位于同一目录。
3. 在 `fonts/` 目录中放入霞鹜文楷字体文件（见下方说明）。
4. 部署到 GitHub Pages 或任意静态服务器即可。

## 字体

页面默认使用 **霞鹜文楷（LXGW WenKai）**。你可以从以下地址下载：

- GitHub Releases：<https://github.com/lxgw/LxgwWenKai/releases>
- 项目主页：<https://github.com/lxgw/LxgwWenKai>

下载后，将字体文件放到 `./fonts/` 目录下，并保持文件名与 HTML 中 `@font-face` 的路径一致：

```
./fonts/LXGWWenKai-Regular.woff2
./fonts/LXGWWenKai-Regular.ttf
```

推荐使用 `.woff2` 格式，体积更小、加载更快。如果只提供 `.ttf`，删除或注释掉 `@font-face` 中对应的 `woff2` 行即可。

## 数据文件格式

每行一条记录，字段之间用制表符或空格分隔：

```
日期  序号  Base64编码的句子
```

示例：

```
2026-09-29	001	6ICD56CU6Lev5LiK77yM...
```

- 日期格式：`yyyy-mm-dd`
- 序号：三位数字，如 `001`
- 句子：UTF-8 文本的 Base64 编码

页面只会读取当天日期对应的行，并即时解码显示。

## 自定义

- 修改 `DATA_URL` 常量可更换数据文件路径。
- 修改年份判断逻辑可适配其他年份。
- 若需调整字体，修改 `@font-face` 中的 `src` 路径即可。

## 许可

仅用于个人学习与鼓励。