window.__ModuleLoader__.load({
  id: 'dsh-link-menu',
  factory() {
    /** Locale namespace owned by this plugin. */
    const NS = 'link-menu';
    /** Host route that launches the OS default handler. */
    const OPEN_ROUTE = '/link-menu/open';
    /** Host route that resolves a file reference against every known workspace. */
    const RESOLVE_ROUTE = '/link-menu/resolve';
    /** Host route that reports where relative references resolve from. */
    const INFO_ROUTE = '/link-menu/info';
    /** Host route that returns a text file's content. */
    const READ_ROUTE = '/link-menu/read';
    /** Host route that copies a file through the system save dialog. */
    const SAVE_ROUTE = '/link-menu/save-as';

    /** Windows drive, UNC share, or POSIX absolute path. */
    const ABS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\[^\\]|\/(?:Users|home|root|mnt|opt|var|tmp|usr|etc|private|Volumes)\/)/;
    /** `file://` URL. */
    const FILE_URL = /^file:\/\//i;
    /** Web URL or mail address. */
    const WEB_URL = /^(?:https?:\/\/|mailto:)/i;
    /** `path/to/file.ext` or `path/to/file.ext:12` as plain text (any script). */
    const REL_PATH = /^(?:[^\s\\/:*?"<>|]+[\\/])+[^\s\\/:*?"<>|]+(?:\.[A-Za-z0-9]{1,10})?(?::\d+(?::\d+)?)?$/;
    /** A bare file name such as `manifest.json`, `设计稿.pdf`, or `background.js:12`. */
    const BARE_FILE = /^[^\s\\/:*?"<>|]+(?:\.[A-Za-z0-9]{1,10})(?::\d+(?::\d+)?)?$/;
    /** An absolute path embedded behind a label, e.g. `打开 C:\a\b.txt`. */
    const EMBEDDED_PATH = /[A-Za-z]:[\\/][^<>:"|?*\r\n]*$/;
    /** Trailing `:line` / `:line:col` in a reference. */
    const LINE_SUFFIX = /:\d+(?::\d+)?$/;

    const zh = {
      copyLink: '复制链接地址',
      openExternal: '在默认浏览器中打开',
      openDefault: '默认打开方式',
      openWith: '打开方式…',
      reveal: '在文件管理器中打开',
      copyPath: '复制文件地址',
      copyName: '复制文件名',
      copyContent: '复制文件内容',
      saveAs: '另存为…',
      openFailed: '无法打开',
      opened: '已用默认应用打开',
      openedCode: '已用 VS Code 打开',
      revealed: '已在资源管理器中打开',
      choosing: '已打开「选择打开方式」',
      copied: '已复制',
      savedTo: '已另存为',
      saveCancelled: '已取消另存',
      contentFailed: '无法读取文件内容',
    };
    const en = {
      copyLink: 'Copy link address',
      openExternal: 'Open in default browser',
      openDefault: 'Open with default app',
      openWith: 'Open with…',
      reveal: 'Show in file explorer',
      copyPath: 'Copy file path',
      copyName: 'Copy file name',
      copyContent: 'Copy file content',
      saveAs: 'Save a copy…',
      openFailed: 'Could not open',
      opened: 'Opened with the default app',
      openedCode: 'Opened with VS Code',
      revealed: 'Shown in File Explorer',
      choosing: 'Opened the “choose an app” dialog',
      copied: 'Copied',
      savedTo: 'Saved as',
      saveCancelled: 'Save cancelled',
      contentFailed: 'Could not read the file content',
    };

    /**
     * The menu is drawn with the shell's own tokens, so it follows the light
     * and dark theme and never looks like a foreign widget.
     */
    const CSS = [
      '.DLM_menu{position:fixed;z-index:2147483000;min-width:172px;max-width:min(320px,80vw);',
      'padding:4px;margin:0;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));',
      'background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-2,#fff));',
      'box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgba(0,0,0,.16));',
      'color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;',
      'font-family:inherit;outline:none;user-select:none}',
      '.DLM_item{display:flex;align-items:center;width:100%;box-sizing:border-box;',
      'padding:6px 10px;border:0;border-radius:7px;background:transparent;color:inherit;',
      'font:inherit;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
      'cursor:pointer;outline:none}',
      '.DLM_item:hover,.DLM_item:focus-visible{background:var(--dsw-alias-interactive-bg-hover);',
      'color:var(--dsw-alias-label-primary)}',
      '.DLM_item:active{opacity:.85}',
      '.DLM_toast{position:fixed;right:16px;bottom:16px;z-index:2147483001;',
      'max-width:min(360px,calc(100vw - 32px));box-sizing:border-box;padding:8px 12px;',
      'border-radius:10px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));',
      'background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-2,#fff));',
      'box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgba(0,0,0,.16));',
      'color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;',
      'font-family:inherit;pointer-events:none;opacity:0;transition:opacity .15s ease}',
      '.DLM_toast[data-visible="1"]{opacity:1}',
    ].join('');

    let toastElement = null;
    let toastTimer = 0;

    /** Brief bottom-right confirmation so the user can see the action fired. */
    function toast(text) {
      if (typeof text !== 'string' || text.length === 0) return;
      if (!toastElement || !toastElement.isConnected) {
        toastElement = document.createElement('div');
        toastElement.className = 'DLM_toast';
        toastElement.setAttribute('role', 'status');
        toastElement.setAttribute('aria-live', 'polite');
        document.body.appendChild(toastElement);
      }
      toastElement.textContent = text;
      toastElement.setAttribute('data-visible', '1');
      window.clearTimeout(toastTimer);
      toastTimer = window.setTimeout(() => {
        toastElement?.setAttribute('data-visible', '0');
      }, 2600);
    }

    /** Style element inserted once per page. */
    let styleElement = null;
    /** Root element of the open menu, or null. */
    let menuElement = null;
    /** Translate helper bound to the locale service, when available. */
    let translate = null;
    /** Locale service, used to read the shell's current language. */
    let localeService = null;
    /** Last language reported by the shell. */
    let language = '';

    /** Read the shell's current language, falling back to the browser's. */
    function readLanguage() {
      try {
        const snapshot = localeService?.getSnapshot?.();
        if (typeof snapshot === 'string') return snapshot;
        if (snapshot && typeof snapshot.locale === 'string') return snapshot.locale;
        if (snapshot && typeof snapshot.id === 'string') return snapshot.id;
        if (snapshot && typeof snapshot.language === 'string') return snapshot.language;
      } catch {
        // fall through to the browser language
      }
      return navigator.language || 'en';
    }

    /** Current dictionary, resolved from the shell language. */
    function dictionary() {
      return String(language || navigator.language || 'en').toLowerCase().startsWith('zh') ? zh : en;
    }

    /** Translate a menu label. */
    function t(key) {
      try {
        if (translate) {
          const value = translate(key);
          if (typeof value === 'string' && value !== key) return value;
        }
      } catch {
        // fall through to the local dictionary
      }
      return dictionary()[key] ?? key;
    }

    /** Strip a trailing line/column suffix. */
    function stripLineSuffix(value) {
      return value.replace(LINE_SUFFIX, '');
    }

    /** Read a candidate path from an arbitrary attribute or text value. */
    function pathFrom(value) {
      if (typeof value !== 'string') return null;
      const text = value.trim().replace(/^[`"']+|[`"']+$/g, '');
      if (text.length === 0 || text.length > 4096) return null;
      if (FILE_URL.test(text)) return { kind: 'file', target: text };
      if (ABS_PATH.test(text)) return { kind: 'file', target: stripLineSuffix(text) };
      return null;
    }

    /**
     * Read a path that sits behind a label, e.g. `打开 C:\a\b.txt`. Only used on
     * attributes of a shipped clickable chip, never on free prose.
     */
    function pathFromEmbedded(value) {
      if (typeof value !== 'string' || value.length === 0 || value.length > 4096) return null;
      const embedded = value.match(EMBEDDED_PATH);
      if (!embedded || embedded[0].length <= 3) return null;
      return { kind: 'file', target: stripLineSuffix(embedded[0].trim()) };
    }

    /** Read a candidate relative file reference from an attribute value. */
    function relativeFrom(value) {
      if (typeof value !== 'string') return null;
      const text = value.trim().replace(/^[`"']+|[`"']+$/g, '');
      if (text.length === 0 || text.length > 900) return null;
      if (/^[a-z]+:\/\//i.test(text)) return null;
      if (REL_PATH.test(text)) return { kind: 'relpath', target: stripLineSuffix(text) };
      if (BARE_FILE.test(text)) return { kind: 'relpath', target: stripLineSuffix(text) };
      // `在侧边栏打开 ocs-config.json`: the file name is the last token.
      const tail = text.split(/[\s"'`]+/).filter((part) => part.length > 0).pop();
      if (tail && tail !== text && BARE_FILE.test(tail)) {
        return { kind: 'relpath', target: stripLineSuffix(tail) };
      }
      return null;
    }

    /** Chips the chat renders as clickable file references. */
    const CHIP_SELECTOR = '[class*="fileLink"],[class*="fileMention"],[class*="fileCard"]';

    /**
     * Describe what was right-clicked, but only for elements the chat renders as
     * clickable references. Ordinary prose — error text that quotes a path, a
     * plain sentence ending in `.md` — must never be hijacked, so nothing here
     * scans arbitrary text nodes or attributes outside those containers.
     */
    function probeElement(element) {
      if (!(element instanceof Element)) return null;
      // A delivered file card only exposes its path in the title of the
      // full-card preview button: `<button class="...cardPreview" title="<abs path>">`.
      const presented = element.closest('[data-presented-file]');
      if (presented) {
        const titled = presented.querySelector('button[title]') ?? presented.querySelector('[title]');
        const values = [
          titled?.getAttribute('title'),
          titled?.getAttribute('aria-label'),
          presented.getAttribute('title'),
          presented.getAttribute('aria-label'),
        ];
        for (const value of values) {
          const found = pathFrom(value) ?? pathFromEmbedded(value) ?? relativeFrom(value);
          if (found) return found;
        }
        return null;
      }
      // The changed-files review rows carry the workspace-relative path inline.
      const review = element.closest('[data-review-file]');
      if (review) {
        const value = review.getAttribute('data-review-file');
        return pathFrom(value) ?? relativeFrom(value);
      }
      // Plain links.
      const anchor = element.closest('a[href]');
      if (anchor) {
        const href = anchor.getAttribute('href');
        if (href) {
          if (FILE_URL.test(href)) return { kind: 'file', target: href };
          try {
            const absolute = new URL(href, location.href).href;
            if (WEB_URL.test(absolute)) return { kind: 'url', target: absolute };
          } catch {
            // not a URL we can resolve
          }
          if (REL_PATH.test(href) && /\.[A-Za-z0-9]{1,10}$/.test(href)) {
            return { kind: 'relpath', target: stripLineSuffix(href) };
          }
        }
        const label = anchor.getAttribute('title') ?? anchor.getAttribute('aria-label');
        const fromLabel = pathFrom(label) ?? pathFromEmbedded(label) ?? relativeFrom(label);
        if (fromLabel) return fromLabel;
      }
      // A file chip keeps the authored path in an attribute; its visible text is
      // only the fallback (and often just the bare file name).
      const chip = element.closest(CHIP_SELECTOR);
      if (chip) {
        for (const name of ['title', 'data-path', 'data-file-path', 'aria-label']) {
          const value = chip.getAttribute(name);
          if (!value) continue;
          const found = pathFrom(value) ?? pathFromEmbedded(value) ?? relativeFrom(value);
          if (found) return found;
        }
        const text = (chip.textContent ?? '').trim();
        if (text.length > 0 && text.length < 4096 && !text.includes('\n')) {
          const found = pathFrom(text);
          if (found) return found;
          if (WEB_URL.test(text)) return { kind: 'url', target: text };
          const relative = relativeFrom(text);
          if (relative) return relative;
        }
        return null;
      }
      return null;
    }

    /** Walk up from the event target and describe what was right-clicked. */
    function resolveTarget(event) {
      let node = event.target;
      let depth = 0;
      while (node instanceof Element && depth < 10) {
        const found = probeElement(node);
        if (found) return found;
        node = node.parentElement;
        depth += 1;
      }
      return null;
    }

    /** Copy text, falling back to a hidden textarea when the clipboard API is unavailable. */
    async function copyText(text) {
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
          toast(t('copied'));
          return;
        }
      } catch {
        // fall through to the legacy path
      }
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      try {
        document.execCommand('copy');
      } catch {
        // nothing else to try
      }
      area.remove();
      toast(t('copied'));
    }

    /** Ask the Host to hand the target to the operating system. */
    async function openTarget(kind, target) {
      let status = 0;
      try {
        const response = await fetch(OPEN_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind, target }),
          cache: 'no-store',
        });
        status = response.status;
        const via = response.headers?.get?.('x-link-menu-via') || kind;
        if (!response.ok) throw new Error(`open failed: ${status}`);
        toast(
          via === 'reveal'
            ? t('revealed')
            : via === 'code'
              ? t('openedCode')
              : via === 'choose'
                ? t('choosing')
                : t('opened'),
        );
      } catch (error) {
        toast(status === 0 ? t('openFailed') : `${t('openFailed')} (${status})`);
        console.warn(`[link-menu] ${t('openFailed')}`, error);
      }
    }

    /** Copy a text file's content through the Host. */
    async function copyFileContent(target) {
      let status = 0;
      try {
        const response = await fetch(READ_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ target }),
          cache: 'no-store',
        });
        status = response.status;
        if (!response.ok) throw new Error(`read failed: ${status}`);
        const payload = await response.json();
        await copyText(typeof payload?.text === 'string' ? payload.text : '');
      } catch (error) {
        toast(t('contentFailed'));
        console.warn(`[link-menu] ${t('contentFailed')}`, status, error);
      }
    }

    /** Copy a file to a destination the user picks in the system save dialog. */
    async function saveFileAs(target) {
      try {
        const response = await fetch(SAVE_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ target }),
          cache: 'no-store',
        });
        if (!response.ok) throw new Error(`save failed: ${response.status}`);
        const payload = await response.json();
        if (payload?.saved) toast(`${t('savedTo')} ${baseName(payload.path ?? '')}`);
        else if (payload?.cancelled) toast(t('saveCancelled'));
        else toast(t('contentFailed'));
      } catch (error) {
        toast(t('contentFailed'));
        console.warn('[link-menu] save-as failed', error);
      }
    }

    /** Turn a `file://` target into a readable local path. */
    function displayPath(target) {
      if (!FILE_URL.test(target)) return target;
      try {
        const url = new URL(target);
        let path = decodeURIComponent(url.pathname);
        if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
        return path;
      } catch {
        return target;
      }
    }

    /** Last path segment, for "copy file name". */
    function baseName(target) {
      const path = displayPath(target);
      const parts = path.split(/[\\/]/);
      return parts[parts.length - 1] || path;
    }

    /** Cached answer from the Host: the base directory of relative references. */
    let workspaceInfo = null;

    /** Ask the Host which directory relative references should resolve against. */
    async function loadInfo() {
      try {
        const response = await fetch(INFO_ROUTE, { cache: 'no-store' });
        if (!response.ok) return null;
        const payload = await response.json();
        if (payload && typeof payload.cwd === 'string' && payload.cwd.length > 0) {
          workspaceInfo = payload;
          return payload;
        }
      } catch {
        // leave the cache empty and fall back to the raw reference
      }
      return null;
    }

    /** Base directory for relative references, loading it on first use. */
    async function baseDirectory() {
      if (workspaceInfo) return workspaceInfo.cwd;
      const info = await loadInfo();
      return info ? info.cwd : '';
    }

    /** Join a relative reference onto the base directory. */
    function joinPath(root, relative) {
      const separator = root.includes('\\') ? '\\' : '/';
      const cleaned = relative
        .replace(/^\.?[\\/]+/, '')
        .split(/[\\/]+/)
        .filter((part) => part.length > 0)
        .join(separator);
      return root.endsWith(separator) ? `${root}${cleaned}` : `${root}${separator}${cleaned}`;
    }

    /**
     * Absolute path for a relative reference. The Host resolves it against
     * every known workspace directory, so a reference from another workspace
     * still resolves; the old info + join fallback only runs when that route is
     * unavailable (older Host half).
     */
    async function resolveRelative(relative) {
      try {
        const response = await fetch(RESOLVE_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: relative }),
          cache: 'no-store',
        });
        if (response.ok) {
          const payload = await response.json();
          if (payload && typeof payload.path === 'string' && payload.path.length > 0) return payload.path;
        }
      } catch {
        // fall through to the local fallback
      }
      const root = await baseDirectory();
      return root ? joinPath(root, relative) : relative;
    }

    /** Close the open menu, if any. */
    function closeMenu() {
      if (menuElement?.parentNode) menuElement.parentNode.removeChild(menuElement);
      menuElement = null;
    }

    /** One menu row. */
    function menuItem(label, onSelect) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'DLM_item';
      item.setAttribute('role', 'menuitem');
      item.textContent = label;
      item.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeMenu();
        Promise.resolve()
          .then(onSelect)
          .catch(() => {});
      });
      return item;
    }

    /** The rows every file reference shares. */
    function fileRows(target, absoluteCopy, nameCopy) {
      return [
        menuItem(t('openDefault'), () => openTarget('file', target)),
        menuItem(t('openWith'), () => openTarget('choose', target)),
        menuItem(t('reveal'), () => openTarget('reveal', target)),
        menuItem(t('copyPath'), absoluteCopy),
        menuItem(t('copyName'), nameCopy),
        menuItem(t('copyContent'), () => copyFileContent(target)),
        menuItem(t('saveAs'), () => saveFileAs(target)),
      ];
    }

    /** Rows for the resolved target. */
    function rowsFor(target) {
      if (target.kind === 'url') {
        return [
          menuItem(t('copyLink'), () => copyText(target.target)),
          menuItem(t('openExternal'), () => openTarget('url', target.target)),
        ];
      }
      if (target.kind === 'file') {
        return fileRows(
          target.target,
          () => copyText(displayPath(target.target)),
          () => copyText(baseName(target.target)),
        );
      }
      if (target.kind === 'relpath') {
        const relative = target.target;
        return fileRows(
          relative,
          async () => copyText(await resolveRelative(relative)),
          () => copyText(baseName(relative)),
        );
      }
      return [menuItem(t('copyPath'), () => copyText(target.target))];
    }

    /** Show the menu at the pointer, clamped to the viewport. */
    function showMenu(x, y, target) {
      closeMenu();
      const root = document.createElement('div');
      root.className = 'DLM_menu';
      root.setAttribute('role', 'menu');
      root.tabIndex = -1;
      for (const row of rowsFor(target)) root.appendChild(row);
      document.body.appendChild(root);
      const rect = root.getBoundingClientRect();
      const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
      const top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
      root.style.left = `${left}px`;
      root.style.top = `${top}px`;
      menuElement = root;
      const first = root.querySelector('button');
      first?.focus({ preventScroll: true });
    }

    /** Right-click handler: intercept only when a link or file reference is under the pointer. */
    function onContextMenu(event) {
      const target = resolveTarget(event);
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      showMenu(event.clientX, event.clientY, target);
    }

    return {
      inject: ['locale'],
      apply(ctx) {
        try {
          localeService = ctx.locale;
        } catch {
          localeService = null;
        }
        language = readLanguage();
        ctx.effect(() => {
          try {
            const unsubscribe = localeService?.subscribe?.(() => {
              language = readLanguage();
            });
            return () => {
              if (typeof unsubscribe === 'function') unsubscribe();
            };
          } catch {
            return () => {};
          }
        }, 'link-menu: language');
        ctx.effect(() => {
          try {
            return ctx.locale.register(NS, { zh, en });
          } catch {
            return () => {};
          }
        }, 'link-menu: locale');
        try {
          translate = ctx.locale.bind(NS);
        } catch {
          translate = null;
        }
        void loadInfo();
        ctx.effect(() => {
          styleElement = document.createElement('style');
          styleElement.setAttribute('data-link-menu-css', '');
          styleElement.textContent = CSS;
          document.head.appendChild(styleElement);
          const disposers = [];
          document.addEventListener('contextmenu', onContextMenu, true);
          disposers.push(() => document.removeEventListener('contextmenu', onContextMenu, true));
          const onPointerDown = (event) => {
            if (menuElement && !menuElement.contains(event.target)) closeMenu();
          };
          const onKeyDown = (event) => {
            if (event.key !== 'Escape' || !menuElement) return;
            event.preventDefault();
            event.stopPropagation();
            closeMenu();
          };
          const onViewport = () => closeMenu();
          document.addEventListener('pointerdown', onPointerDown, true);
          disposers.push(() => document.removeEventListener('pointerdown', onPointerDown, true));
          document.addEventListener('keydown', onKeyDown, true);
          disposers.push(() => document.removeEventListener('keydown', onKeyDown, true));
          window.addEventListener('scroll', onViewport, true);
          disposers.push(() => window.removeEventListener('scroll', onViewport, true));
          window.addEventListener('resize', onViewport);
          disposers.push(() => window.removeEventListener('resize', onViewport));
          window.addEventListener('blur', onViewport);
          disposers.push(() => window.removeEventListener('blur', onViewport));
          return () => {
            for (const dispose of disposers) dispose();
            closeMenu();
            styleElement?.remove();
            styleElement = null;
          };
        }, 'link-menu: wiring');
      },
    };
  },
});
