# dsh-link-menu

给 **DeepSeek Harness（DSH）桌面版** 聊天区里的链接与文件引用加一个类似 ChatGPT 的右键菜单。

A ChatGPT-like right-click menu for links and file references inside DeepSeek Harness (DSH) desktop messages.

---

## 功能 / Features

| 对象 / Target | 菜单项 / Menu items |
| --- | --- |
| 网页链接（`https://…`、`mailto:`） | 复制链接地址 · 在默认浏览器中打开 |
| 文件引用（`C:\…\file.txt`、`file:///…`） | 默认打开方式 · 在文件管理器中打开 · 复制文件地址 · 复制文件名 |
| 相对文件引用（如 `src/main.ts`） | 同上，按 DSH 工作区解析成绝对路径 |

- 左键行为保持不变：链接照常在内置浏览器打开，文件引用照常定位。
- 只在真正命中链接/文件引用时接管右键；普通文本仍是系统默认菜单。
- 菜单跟随主题变量（`--dsw-*`），浅色/深色主题都能用。

## 0.2.1 的改动 / What's new in 0.2.1

- 清理：`focusWindowByTitle` 两处无效的第二个参数（该函数只接收标题提示），行为不变。
- 清理：`fileRows` 的注释改成实际的三行；第四行「复制文件名」由调用处追加。
- 打包可复现：新增 `build.mjs`，按固定清单、固定时间戳生成 `dist/dsh-link-menu-<version>.zip`，同样的源码两次打包结果一致。

## 0.2.0 的改动 / What's new in 0.2.0

- 文件菜单固定为 4 行：**默认打开方式 / 在文件管理器中打开 / 复制文件地址 / 复制文件名**。
- 「默认打开方式」直接打开：系统有关联应用时用关联应用；`.json` 等没有真实关联、但装了 VS Code 时直接进 VS Code，不再弹「选择打开方式」。
- 「在文件管理器中打开」提速：Host 侧常驻一个预热好的 PowerShell 辅助进程，文件夹窗口已打开时直接激活（实测约 60–80ms），未打开时用 `Shell.Application.Explore` 新开窗口（约 1 秒，接近资源管理器本身的开窗耗时）。
- 打开/定位后会把目标窗口提到前台（Windows 前台锁用 ALT 轻敲绕过）。
- 所有平台行为：Windows 用 `rundll32` / `explorer` / `Shell.Application`；macOS 用 `open`；Linux 用 `xdg-open`。

## 安装 / Installation

要求：DSH **桌面版**（Electron）。「默认打开方式 / 在文件管理器中打开」由 Host 进程调用系统能力，浏览器版 DSH 无法提供。

1. 解压或克隆到本机任意目录，例如：

   ```text
   D:\dsh-plugins\dsh-link-menu
   ```

2. 在 DSH 会话里安装本地 bundle：

   ```text
   plugin_manager install_bundle
   target: D:\dsh-plugins\dsh-link-menu
   ```

   `target` 必须是**绝对路径**。安装成功后 `application` 为 `applied`、`warnings` 为空数组。

3. 重启 DSH 应用（客户端半边需要重新加载），右键菜单即可使用。

## 配置 / Configuration

消息里的**相对路径**（`src/theme.json`、`manifest.json`、`background.js:12`）会按 DSH 的**所有工作区目录**依次尝试解析，所以从其他工作区的对话里右键文件也能正常打开；`workspaceRoot` 只是额外优先尝试的目录，可留空：

```yaml
# cordis.patch.yml
- insert:
    - id: link-menu
      name: dsh-link-menu
      config:
        workspaceRoot: 'C:\Users\me\Documents\my-workspace'   # 可选
```

解析顺序：DSH 工作区列表（新工作区在前）→ `workspaceRoot` → `workingDirectory.defaultDirectory` → Host 进程当前目录。

卸载：用 `plugin_manager` 移除该 bundle，或在 profile 的 `cordis.patch.yml` 里删掉 `link-menu` 条目。

## 安全边界 / Safety

- 只处理 `http(s)`、`mailto:` 链接与**真实存在**的本地文件；其他目标不弹菜单，也不发给 Host。
- Host 端用参数数组启动系统打开方式，不经过 shell，不拼接命令字符串。
- 插件不读取文件内容，只把路径交给系统「打开 / 定位」。

## 兼容性 / Compatibility

插件依赖 DSH 客户端的两处实现细节：

1. 消息内链接/文件引用带 `fileLink` 类名（外链是 `<a>`，文件引用是 `<button>`，文件引用的 `title` 是绝对路径）；
2. Host 侧可用 `webServer`、`workingDirectory` 与 `workspaceRegistry` 服务。

测试于 2026-11 的 DSH 桌面版。DSH 大版本更新后若类名或槽位命名变化，可能需要在 `client.js` / `index.js` 中同步调整。

## 开发 / Development

包结构：

```text
index.js           Host 半边：/link-menu/open（打开/定位）、/link-menu/resolve（跨工作区解析路径）、/link-menu/info（解析根目录与 VS Code 探测）
client.js          浏览器半边：捕获右键、识别链接/文件、绘制菜单
locale/*.json      插件名称与描述（plugin_manager 展示用）
cordis.patch.yml   挂载配置
build.mjs          打包脚本，生成 dist/dsh-link-menu-<version>.zip
test/host-routes.mjs  Host 路由冒烟测试（只测拒绝路径，不启动任何应用）
```

改动后先查语法：

```powershell
node --check index.js
node --check client.js
node test/host-routes.mjs
```

Host 半边改动可在 DSH 里 `plugin_manager set_plugin`（`include:link-menu` 关→开）热重载；client 半边改动需要重启应用。

发版：改 `package.json` 的 `version`，再打包，`dist/` 已被 `.gitignore` 忽略：

```powershell
node build.mjs
```

## License

MIT
