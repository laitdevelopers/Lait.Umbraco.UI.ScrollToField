import { LitElement, html, css, nothing } from '@umbraco-cms/backoffice/external/lit';
import { UmbElementMixin } from '@umbraco-cms/backoffice/element-api';
import { UMB_DOCUMENT_WORKSPACE_CONTEXT } from '@umbraco-cms/backoffice/document';

/*
 * Lait Scroll To Field — a dynamic "table of contents" for the Umbraco document editor.
 *
 * Mounted as a `workspaceFooterApp`, which lives for the whole workspace lifetime and survives
 * tab switches. It renders nothing in the footer bar; the outline is a `position: fixed` drawer
 * docked to the right edge of the viewport (DatoCMS-style sidebar), open by default. An arrow
 * handle on its left edge slides it in/out; the choice is remembered per browser.
 *
 * The outline is built by deep-scanning the rendered editor DOM (descending through shadow roots)
 * for the document's tabs, property groups (uui-box / property-group containers) and Block List /
 * Block Grid entries. Blocks are nested under the group they belong to. Clicking an entry scrolls
 * the matching element into view and briefly highlights it; clicking a tab switches the active view
 * and the outline re-scans.
 *
 * This is deliberately DOM-driven rather than reliant on private backoffice observables: the
 * structural building blocks below are stable UI primitives, and the scanner degrades gracefully
 * (an empty/partial outline) if a future major renames an internal element. The few selectors that
 * could drift between versions are grouped in CONFIG so they are easy to adjust.
 */

const CONFIG = {
  // Where to root the scan. First match (searched deeply, through shadow roots) wins; we fall back
  // to document.body if none are present.
  editorRootSelectors: [
    'umb-content-workspace-view-edit',
    'umb-document-workspace-editor',
    'umb-workspace-editor',
  ],
  // Block List / Block Grid entries — the "modules" on a page.
  blockSelectors: ['umb-block-grid-entry', 'umb-block-list-entry'],
  // Property-group containers. Groups render as a uui-box wrapping a property-group element.
  groupTag: 'uui-box',
  // The element the content view tags with the group's name (most reliable source of a label).
  groupNameSelector: '[property-group]',
  groupNameAttr: 'property-group',
  // Candidate elements to read a human label from, in priority order, when naming a block.
  blockLabelSelectors: [
    '[id="name"]',
    'uui-ref-node',
    'umb-ref-grid-block',
    '[name="name"]',
    '.umb-block-grid__block--label',
    'h4',
    'h5',
    'strong',
  ],
  // Tabs inside the editor root (the document's own content-type tabs).
  tabSelector: 'uui-tab',
  // Tags we never need to descend into (perf + avoid noise).
  skipTags: new Set(['script', 'style', 'svg', 'uui-icon', 'uui-loader', 'iframe', 'canvas']),
  rescanDebounceMs: 350,
  highlightMs: 1600,
  maxLabelLen: 48,
};

const STORAGE_KEY = 'lait.scrollToField.open';

class LaitScrollToFieldOutline extends UmbElementMixin(LitElement) {
  static properties = {
    _open: { state: true },
    _items: { state: true },
    _rootFound: { state: true },
  };

  constructor() {
    super();
    this._open = readOpenState();
    this._items = [];
    this._rootFound = false;

    // Parallel array of the live DOM nodes each item points at (kept off the reactive state
    // so Lit doesn't try to diff DOM nodes).
    this._targets = [];
    this._editorRoot = null;
    this._observer = null;
    this._rescanTimer = null;
    this._warmupTimer = null;
    this._rootRetries = 0;
    this._lastSig = null;

    // Reset/re-scan when the edited document changes (optional context — guard if unavailable).
    this.consumeContext(UMB_DOCUMENT_WORKSPACE_CONTEXT, (workspace) => {
      if (!workspace?.unique) return;
      this.observe(
        workspace.unique,
        () => {
          this._editorRoot = null;
          this._rootRetries = 0;
          this._lastSig = null;
          this.#scheduleRescan(50);
          this.#startWarmup();
        },
        '_laitUniqueObserver',
      );
    });
  }

  connectedCallback() {
    super.connectedCallback();
    this.#scheduleRescan(120);
    this.#startWarmup();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._observer?.disconnect();
    this._observer = null;
    clearTimeout(this._rescanTimer);
    clearInterval(this._warmupTimer);
  }

  /* The editor mounts its tabs, groups and blocks progressively, and not every late addition fires
     a mutation the observer is watching. So for the first minute after (re)opening a document we
     also rescan on a steady cadence; the signature check in #scan means this only re-renders when
     the outline actually changed. */
  #startWarmup() {
    clearInterval(this._warmupTimer);
    const stopAt = Date.now() + 60000;
    this._warmupTimer = setInterval(() => {
      if (Date.now() > stopAt) {
        clearInterval(this._warmupTimer);
        this._warmupTimer = null;
        return;
      }
      this.#scan();
    }, 1500);
  }

  // --- scanning -------------------------------------------------------------

  #scheduleRescan(delay = CONFIG.rescanDebounceMs) {
    clearTimeout(this._rescanTimer);
    this._rescanTimer = setTimeout(() => this.#scan(), delay);
  }

  #ensureRoot() {
    if (this._editorRoot && this._editorRoot.isConnected) return this._editorRoot;

    let root = null;
    for (const sel of CONFIG.editorRootSelectors) {
      root = deepQuery(document.body, (el) => el.localName === sel);
      if (root) break;
    }
    root = root ?? document.body;
    this._editorRoot = root;

    // (Re)attach a MutationObserver scoped to the root so we rescan as blocks are added/removed
    // or the user switches tabs. childList only — we don't care about attribute/text churn.
    this._observer?.disconnect();
    this._observer = new MutationObserver(() => this.#scheduleRescan());
    try {
      this._observer.observe(root, { childList: true, subtree: true });
    } catch {
      /* root may be detached mid-navigation; next scan re-resolves it */
    }
    return root;
  }

  #scan() {
    const root = this.#ensureRoot();
    const items = [];
    const targets = [];

    // Tabs first (the document's own content-type tabs), so switching views is one click away.
    const tabs = collectTabs(root);
    if (tabs.length > 1) {
      for (const t of tabs) {
        items.push({ kind: 'tab', label: t.label, depth: 0, active: t.active });
        targets.push(t.el);
      }
    }

    // Then groups + blocks in document order via a single deep DFS. Both groups and blocks add a
    // level of indentation to their contents, so block entries nest under their property group.
    walk(root, this, 0, (node, depth) => {
      const tag = node.localName;
      if (CONFIG.blockSelectors.includes(tag)) {
        items.push({ kind: 'block', label: labelForBlock(node), depth });
        targets.push(node);
        return depth + 1; // nested blocks / areas indent one level deeper
      }
      if (tag === CONFIG.groupTag) {
        const headline = groupHeadline(node);
        if (headline) {
          items.push({ kind: 'group', label: headline, depth });
          targets.push(node);
          return depth + 1; // properties & blocks inside this group indent under it
        }
      }
      return depth;
    });

    // Always keep target nodes fresh (they may be re-created on re-render), but only push new
    // reactive state — and trigger a re-render — when the outline's shape actually changed.
    this._targets = targets;
    const sig = items.map((i) => `${i.kind}:${i.label}:${i.depth}:${i.active ? 1 : 0}`).join('|');
    if (sig !== this._lastSig) {
      this._lastSig = sig;
      this._items = items;
    }
    this._rootFound = root !== document.body || items.length > 0;

    // The editor sometimes mounts a beat after the footer app; retry a few times if we found nothing.
    if (items.length === 0 && this._rootRetries < 8) {
      this._rootRetries += 1;
      this._editorRoot = null;
      this.#scheduleRescan(300);
    }
  }

  // --- navigation -----------------------------------------------------------

  #goTo(index) {
    const el = this._targets[index];
    const item = this._items[index];
    if (!el || !el.isConnected) {
      this.#scheduleRescan(0);
      return;
    }

    if (item?.kind === 'tab') {
      el.click(); // switch the active content-type tab, then re-scan its contents
      this.#scheduleRescan(250);
      return;
    }

    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    highlight(el);
  }

  // --- rendering ------------------------------------------------------------

  render() {
    const count = this._items.filter((i) => i.kind !== 'tab').length;
    return html`
      <div class="dock ${this._open ? '' : 'collapsed'}">
        <button
          class="handle"
          @click=${this.#toggle}
          aria-label=${this._open ? 'Hide outline' : 'Show outline'}
          title=${this._open ? 'Hide outline' : 'Show outline'}>
          <span class="chev">${this._open ? '❯' : '❮'}</span>
        </button>
        <div class="panel" role="navigation" aria-label="Document outline">
          <header>
            <span class="title">
              <uui-icon name="icon-bulleted-list"></uui-icon> Outline
              ${count ? html`<span class="count">${count}</span>` : nothing}
            </span>
            <uui-button compact look="default" label="Rescan" title="Rescan" @click=${() => this.#scan()}>
              <uui-icon name="icon-sync"></uui-icon>
            </uui-button>
          </header>
          <div class="list">${this.#renderList()}</div>
        </div>
      </div>
    `;
  }

  #renderList() {
    if (!this._items.length) {
      return html`<p class="empty">
        Nothing to outline yet. Open a document with tabs, property groups or Block&nbsp;List /
        Block&nbsp;Grid items.
      </p>`;
    }
    return this._items.map(
      (item, i) => html`
        <button
          class="row ${item.kind} ${item.active ? 'active' : ''}"
          style="padding-left: calc(var(--uui-size-space-3) + ${item.depth} * var(--uui-size-space-4))"
          @click=${() => this.#goTo(i)}
          title=${item.label}>
          <uui-icon name=${iconFor(item.kind)}></uui-icon>
          <span class="row-label">${item.label}</span>
        </button>
      `,
    );
  }

  #toggle = () => {
    this._open = !this._open;
    writeOpenState(this._open);
    if (this._open) this.#scheduleRescan(0);
  };

  static styles = css`
    :host {
      display: contents;
    }

    /* The drawer is docked flush to the right edge of the viewport and visible by default.
       Collapsing slides it fully off to the right (translateX 100%), leaving only the handle —
       which sticks out 26px to the left of the dock — visible at the screen edge. */
    .dock {
      position: fixed;
      top: 120px;
      right: 0;
      width: 300px;
      max-width: 86vw;
      z-index: 9000;
      transition: transform 0.25s ease;
    }
    .dock.collapsed {
      transform: translateX(100%);
    }

    .handle {
      position: absolute;
      left: -26px;
      top: 50%;
      transform: translateY(-50%);
      width: 26px;
      height: 72px;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      cursor: pointer;
      border: 1px solid var(--uui-color-border, #d8d7d9);
      border-right: none;
      border-radius: var(--uui-border-radius, 6px) 0 0 var(--uui-border-radius, 6px);
      background: var(--uui-color-surface, #fff);
      color: var(--uui-color-text-alt, #68676b);
      box-shadow: -4px 0 10px rgba(0, 0, 0, 0.08);
    }
    .handle:hover {
      color: var(--uui-color-interactive, #3544b1);
      background: var(--uui-color-surface-alt, #f7f7f7);
    }
    .handle .chev {
      font-size: 14px;
      line-height: 1;
      font-weight: 700;
    }

    .panel {
      display: flex;
      flex-direction: column;
      max-height: min(72vh, 660px);
      background: var(--uui-color-surface, #fff);
      color: var(--uui-color-text, #1b264f);
      border: 1px solid var(--uui-color-border, #d8d7d9);
      border-right: none;
      border-radius: var(--uui-border-radius, 6px) 0 0 var(--uui-border-radius, 6px);
      box-shadow: var(--uui-shadow-depth-3, 0 10px 30px rgba(0, 0, 0, 0.2));
      overflow: hidden;
    }
    .count {
      font-weight: 700;
      color: var(--uui-color-text-alt, #68676b);
      font-size: 0.85em;
      margin-left: var(--uui-size-space-1);
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--uui-size-space-2) var(--uui-size-space-3);
      border-bottom: 1px solid var(--uui-color-divider, #eee);
      background: var(--uui-color-surface-alt, #f7f7f7);
    }
    header .title {
      display: inline-flex;
      align-items: center;
      gap: var(--uui-size-space-2);
      font-weight: 700;
    }
    .list {
      overflow-y: auto;
      padding: var(--uui-size-space-2) 0;
    }
    .row {
      display: flex;
      align-items: center;
      gap: var(--uui-size-space-2);
      width: 100%;
      box-sizing: border-box;
      padding: var(--uui-size-space-2) var(--uui-size-space-3);
      border: none;
      background: none;
      color: inherit;
      font: inherit;
      text-align: left;
      cursor: pointer;
    }
    .row:hover {
      background: var(--uui-color-surface-emphasis, rgba(0, 0, 0, 0.05));
    }
    .row uui-icon {
      flex: 0 0 auto;
      color: var(--uui-color-text-alt, #68676b);
    }
    .row-label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .row.tab {
      font-weight: 700;
    }
    .row.tab.active {
      color: var(--uui-color-current-contrast, var(--uui-color-selected, #1b264f));
    }
    .row.group {
      font-weight: 700;
      color: var(--uui-color-text, #1b264f);
    }
    .row.block .row-label {
      color: var(--uui-color-text-alt, #44475b);
    }
    .empty {
      padding: var(--uui-size-space-3);
      margin: 0;
      color: var(--uui-color-text-alt, #68676b);
      font-size: 0.9rem;
    }
  `;
}

// --- helpers (module scope) -------------------------------------------------

function iconFor(kind) {
  switch (kind) {
    case 'tab':
      return 'icon-folder';
    case 'group':
      return 'icon-document';
    default:
      return 'icon-grid';
  }
}

/** Depth-first walk over light children AND shadow roots, in document order.
 *  `visit(node, depth)` returns the depth to use for that node's descendants. */
function walk(node, panelHost, depth, visit) {
  // Never descend into our own panel or into noise tags.
  if (node === panelHost) return;
  if (CONFIG.skipTags.has(node.localName)) return;

  let nextDepth = depth;
  if (node.nodeType === 1 && node.localName) {
    nextDepth = visit(node, depth) ?? depth;
  }

  // Shadow tree holds the rendered structure (e.g. uui-box groups); light children hold slotted
  // content (e.g. block entries). Visiting both, in this order, does not double-count: the shadow
  // tree contains <slot> placeholders, not the light nodes themselves.
  const sr = node.shadowRoot;
  if (sr) for (const child of sr.children) walk(child, panelHost, nextDepth, visit);
  for (const child of node.children) walk(child, panelHost, nextDepth, visit);
}

/** First element (deep, through shadow roots) matching predicate. */
function deepQuery(root, predicate) {
  if (root.nodeType === 1 && predicate(root)) return root;
  const sr = root.shadowRoot;
  if (sr) {
    for (const c of sr.children) {
      const found = deepQuery(c, predicate);
      if (found) return found;
    }
  }
  for (const c of root.children ?? []) {
    if (CONFIG.skipTags.has(c.localName)) continue;
    const found = deepQuery(c, predicate);
    if (found) return found;
  }
  return null;
}

function collectTabs(root) {
  const out = [];
  walkTags(root, CONFIG.tabSelector, (el) => {
    const label = (el.getAttribute('label') || el.textContent || '').trim();
    if (!label) return;
    const active =
      el.hasAttribute('active') ||
      el.getAttribute('aria-selected') === 'true' ||
      el.classList.contains('active');
    out.push({ el, label: truncate(label), active });
  });
  return out;
}

/** Collect all elements of a given tag name, deep through shadow roots. */
function walkTags(node, tag, cb) {
  if (node.localName === tag) cb(node);
  const sr = node.shadowRoot;
  if (sr) for (const c of sr.children) walkTags(c, tag, cb);
  for (const c of node.children ?? []) {
    if (CONFIG.skipTags.has(c.localName)) continue;
    walkTags(c, tag, cb);
  }
}

/** Derive a property-group's display name. The headline is NOT reliably a `headline` attribute on
 *  uui-box (it's often set as a property), so we try several sources, most reliable first. */
function groupHeadline(box) {
  // 1) The content view tags the group container with its name — the most reliable source.
  const tagged = box.querySelector?.(CONFIG.groupNameSelector)?.getAttribute?.(CONFIG.groupNameAttr);
  if (tagged && tagged.trim()) return truncate(tagged);

  // 2) uui-box headline as a property (not reflected to an attribute).
  if (typeof box.headline === 'string' && box.headline.trim()) return truncate(box.headline);

  // 3) ...as an attribute.
  const attr = (box.getAttribute('headline') || '').trim();
  if (attr) return truncate(attr);

  // 4) ...rendered into the box's shadow header.
  const header = box.shadowRoot?.querySelector?.('#header');
  const ht = (header?.textContent || '').trim();
  if (ht) return truncate(ht);

  // 5) ...or supplied via a headline slot.
  const slotted = box.querySelector?.('[slot="headline"]');
  const st = (slotted?.textContent || '').trim();
  if (st) return truncate(st);

  return null;
}

function labelForBlock(entry) {
  // Search the block's own subtree (shadow + light) for a label element, but DO NOT cross into a
  // nested block entry — that label belongs to the child, not this block.
  const found = findLabelElement(entry, entry, 0);
  if (found) return truncate(found);

  const alias = entry.getAttribute('data-content-element-type-alias');
  if (alias) return truncate(prettify(alias));
  return 'Block';
}

function findLabelElement(node, owner, depth) {
  if (depth > 10) return null;
  for (const sel of CONFIG.blockLabelSelectors) {
    const hit = node.matches?.(sel) ? node : null;
    if (hit) {
      const t = (hit.textContent || '').trim();
      if (t) return t;
    }
  }
  const descend = (children) => {
    for (const c of children ?? []) {
      if (CONFIG.blockSelectors.includes(c.localName)) continue; // a nested block owns its own label
      if (CONFIG.skipTags.has(c.localName)) continue;
      const r = findLabelElement(c, owner, depth + 1);
      if (r) return r;
    }
    return null;
  };
  return descend(node.shadowRoot?.children) ?? descend(node.children);
}

function highlight(el) {
  const prev = {
    outline: el.style.outline,
    offset: el.style.outlineOffset,
    radius: el.style.borderRadius,
    transition: el.style.transition,
  };
  el.style.transition = 'outline-color 0.2s ease';
  el.style.outline = '2px solid var(--uui-color-focus, #2152a3)';
  el.style.outlineOffset = '2px';
  el.style.borderRadius = el.style.borderRadius || '4px';
  setTimeout(() => {
    el.style.outline = prev.outline;
    el.style.outlineOffset = prev.offset;
    el.style.borderRadius = prev.radius;
    el.style.transition = prev.transition;
  }, CONFIG.highlightMs);
}

function truncate(s) {
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > CONFIG.maxLabelLen ? s.slice(0, CONFIG.maxLabelLen - 1) + '…' : s;
}

function prettify(alias) {
  return alias
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^\w/, (c) => c.toUpperCase());
}

function readOpenState() {
  // Open by default — only stay collapsed if the user explicitly collapsed it before.
  try {
    return localStorage.getItem(STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}
function writeOpenState(open) {
  try {
    localStorage.setItem(STORAGE_KEY, open ? '1' : '0');
  } catch {
    /* storage unavailable — non-fatal */
  }
}

customElements.define('lait-scroll-to-field-outline', LaitScrollToFieldOutline);
export default LaitScrollToFieldOutline;
