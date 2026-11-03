# dsh-link-menu

给 **DeepSeek Harness（DSH）桌面版** 聊天区里的链接与文件引用加一个类似 ChatGPT 的右键菜单：复制地址、用默认应用打开、在文件资源管理器中定位。

A ChatGPT-like right-click menu for links and file references inside DeepSeek Harness (DSH) desktop messages: copy the address, open with the default app, reveal in the file explorer.

---

## 功能 / Features

| 对象 / Target | 菜单项 / Menu items |
| --- | --- |
| 网页链接（`https://…`、`mailto:`） | 复制链接地址 · 在默认浏览器中打开 |
| 文件引用（`C:\…\file.txt`、`file:///…`） | 用默认应用打开 · 在文件资源管理器中显示 · 复制文件路径 · 复制文件名 |
| 相对文件引用（如 `src/main.ts`） | 同上，按配置的 `workspaceRoot` 解析为绝对路径 |

- 左键行为保持不变：链接照常在内置浏览器打开，文件引用照常定位。
- 只在真正命中链接/文件引用时接管右键；普通文本仍是系统默认菜单。
- 菜单跟随主题变量（`--dsw-*`），浅色/深色主题都能用。

## 安装 / Installation

要求：DSH **桌面版**（Electron）。菜单"用默认应用打开 / 在资源管理器中显示"由 Host 进程调用系统打开方式，浏览器版 DSH 无法提供。

1. 把这个仓库放到本机任意目录，例如：

   ```text
   D:\dsh-plugins\dsh-link-menu
   ```

2. 在 DSH 会话里让 agent 安装本地 bundle（或者自己在终端执行等价操作）：

   ```text
   plugin_manager install_bundle
   target: D:\dsh-plugins\dsh-link-menu
   ```

   `target` 必须是**绝对路径**。安装成功后 `application` 为 `applied`、`warnings` 为空数组。

3. 刷新 DSH 窗口（`Ctrl+R`）或重启应用，右键菜单即可使用。

## 配置 / Configuration

`workspaceRoot` 可选。设置后，消息里的**相对路径**会被解析到这个目录，并参与"打开/定位"：

```yaml
# cordis.patch.yml
- insert:
    - id: link-menu
      name: dsh-link-menu
      config:
        workspaceRoot: 'C:\Users\me\Documents\my-workspace'
```

不设置时依次回退到 DSH 工作目录（`workingDirectory.defaultDirectory`）和 Host 进程的当前目录。

卸载：用 `plugin_manager` 移除该 bundle，或在 profile 的 `cordis.patch.yml` 里删掉 `link-menu` 条目。

## 安全边界 / Safety

- 只处理 `http(s)`、`mailto:` 链接与**真实存在**的本地文件；其他目标不弹菜单，也不发给 Host。
- Host 端用参数数组启动系统打开方式（Windows：`rundll32 url.dll,FileProtocolHandler` / `explorer.exe /select,`），不经过 shell，不拼接命令字符串。
- 插件不读取文件内容，只把路径交给系统"打开/定位"。

## 兼容性 / Compatibility

插件依赖 DSH 客户端的两处实现细节：

1. 消息内链接/文件引用带 `fileLink` 类名（外链是 `<a>`，文件引用是 `<button>`）；
2. Host 侧可用 `webServer` 与 `workingDirectory` 服务。

测试于 2026-11 的 DSH 桌面版。DSH 大版本更新后若类名或槽位命名变化，可能需要在 `client.js` / `index.js` 中同步调整。

## 开发 / Development

包结构：

```text
index.js           Host 半边：/link-menu/open（打开/定位）、/link-menu/info（解析根目录）
client.js          浏览器半边：捕获右键、识别链接/文件、绘制菜单
locale/*.json      插件名称与描述
cordis.patch.yml   挂载配置
```

改动后用 `node --check index.js && node --check client.js` 做语法检查，刷新窗口查看效果。

## License

MIT
