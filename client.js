window.__ModuleLoader__.load({
  id: 'dsh-link-menu',
  factory() {
    /** Locale namespace owned by this plugin. */
    const NS = 'link-menu';
    /** Host route that launches the OS default handler. */
    const OPEN_ROUTE = '/link-menu/open';
    /** Host route that reports where relative references resolve from. */
    const INFO_ROUTE = '/link-menu/info';
    /** Shipped chat reference chip: links and file references share one hashed class. */
    const FILE_LINK = /fileLink/;

    /** Windows drive, UNC share, or POSIX absolute path. */
    const ABS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\[^\\]|\/(?:Users|home|root|mnt|opt|var|tmp|usr|etc|private|Volumes)\/)/;
    /** `file://` URL. */
    const FILE_URL = /^file:\/\//i;
    /** Web URL or mail address. */
    const WEB_URL = /^(?:https?:\/\/|mailto:)/i;
    /** `path/to/file.ext` or `path/to/file.ext:12` as plain text. */
    const REL_PATH = /^(?:[\w.@+-]+[\\/])+[\w.@+ -]*[\w.@+-]+(?:\.[A-Za-z0-9]{1,10})?(?::\d+(?::\d+)?)?$/;
    /** Trailing `:line` / `:line:col` in a reference. */
    const LINE_SUFFIX = /:\d+(?::\d+)?$/;

    const zh = {
      copyLink: '复制链接地址',
      openExternal: '在默认浏览器中打开',
      openDefault: '用默认应用打开',
      reveal: '在文件资源管理器中显示',
      copyPath: '复制文件路径',
      copyName: '复制文件名',
      openFailed: '无法打开',
    };
    const en = {
      copyLink: 'Copy link address',
      openExternal: 'Open in default browser',
      openDefault: 'Open with default app',
      reveal: 'Show in file explorer',
      copyPath: 'Copy file path',
      copyName: 'Copy file name',
      openFailed: 'Could not open',
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
    ].join('');

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

    /** Look at one element for a link or a file reference. */
    function probeElement(element) {
      if (!(element instanceof Element)) return null;
      const className = typeof element.className === 'string' ? element.className : '';
      if (FILE_LINK.test(className)) {
        const text = (element.textContent ?? '').trim();
        if (text.length > 0 && text.length < 4096 && !text.includes('\n')) {
          const found = pathFrom(text);
          if (found) return found;
          if (WEB_URL.test(text)) return { kind: 'url', target: text };
          if (REL_PATH.test(text) && !/^[a-z]+:\/\//i.test(text)) {
            return { kind: 'relpath', target: stripLineSuffix(text) };
          }
        }
      }
      if (element.tagName === 'A') {
        const href = element.getAttribute('href');
        if (href) {
          if (FILE_URL.test(href)) return { kind: 'file', target: href };
          try {
            const absolute = new URL(href, location.href).href;
            if (WEB_URL.test(absolute)) return { kind: 'url', target: absolute };
          } catch {
            // not a URL we can resolve
          }
        }
      }
      for (const name of element.getAttributeNames()) {
        if (name === 'href') continue;
        if (!/path|file|href|title|aria-label|data-/i.test(name)) continue;
        const found = pathFrom(element.getAttribute(name));
        if (found) return found;
      }
      for (const key of Object.keys(element.dataset ?? {})) {
        if (!/path|file|href|target|location/i.test(key)) continue;
        const found = pathFrom(element.dataset[key]);
        if (found) return found;
      }
      const isLeaf = element.childElementCount === 0;
      if (isLeaf) {
        const text = (element.textContent ?? '').trim();
        if (text.length > 0 && text.length < 400 && !text.includes('\n')) {
          const found = pathFrom(text);
          if (found) return found;
          if (REL_PATH.test(text) && !/^[a-z]+:\/\//i.test(text)) {
            return { kind: 'relpath', target: stripLineSuffix(text) };
          }
        }
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
    }

    /** Ask the Host to hand the target to the operating system. */
    async function openTarget(kind, target) {
      try {
        const response = await fetch(OPEN_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind, target }),
          cache: 'no-store',
        });
        if (!response.ok) throw new Error(`open failed: ${response.status}`);
      } catch (error) {
        console.warn(`[link-menu] ${t('openFailed')}`, error);
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

    /** Absolute path for a relative reference, or the reference itself when unknown. */
    async function resolveRelative(relative) {
      const root = await baseDirectory();
      return root ? joinPath(root, relative) : relative;
    }

    /** Open a relative reference through its absolute location. */
    async function openRelative(kind, relative) {
      const absolute = await resolveRelative(relative);
      if (absolute === relative) throw new Error('workspace-root-unavailable');
      await openTarget(kind, absolute);
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

    /** Rows for the resolved target. */
    function rowsFor(target) {
      if (target.kind === 'url') {
        return [
          menuItem(t('copyLink'), () => copyText(target.target)),
          menuItem(t('openExternal'), () => openTarget('url', target.target)),
        ];
      }
      if (target.kind === 'file') {
        return [
          menuItem(t('openDefault'), () => openTarget('file', target.target)),
          menuItem(t('reveal'), () => openTarget('reveal', target.target)),
          menuItem(t('copyPath'), () => copyText(displayPath(target.target))),
          menuItem(t('copyName'), () => copyText(baseName(target.target))),
        ];
      }
      if (target.kind === 'relpath') {
        const relative = stripLineSuffix(target.target);
        return [
          menuItem(t('openDefault'), () => openRelative('file', relative)),
          menuItem(t('reveal'), () => openRelative('reveal', relative)),
          menuItem(t('copyPath'), async () => copyText(await resolveRelative(relative))),
        ];
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
