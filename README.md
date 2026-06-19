# Lait Scroll To Field — table of contents for the Umbraco editor

A **table of contents navigation helper** for the Umbraco **17** (Bellissima) backoffice. When a content
page grows long — especially with many Block List / Block Grid modules — editors lose the overview.
This package adds a dockable **outline panel** to the document editor (inspired by the popular DatoCMS
sidebar plugin):

- Lists the document's **tabs**, **property groups** and individual **Block List / Block Grid items**.
- Click any entry to **scroll it into view and briefly highlight it**.
- Click a **tab** entry to switch the active view, then the outline re-scans automatically.
- The panel is **docked on the right and open by default**. An arrow handle on its left edge slides
  it out of the way (and back); the open/collapsed choice is remembered per browser/user.

It is **client-only** — there is no server code, no configuration and no external service.

## Preview

The outline panel docked beside the Umbraco document editor — the page's tabs, property groups and
Block List / Block Grid items, with blocks nested under their group:

![The Lait Scroll To Field outline panel docked beside the Umbraco document editor](https://raw.githubusercontent.com/bootsmann1995/Lait.Umbraco.UI.ScrollToField/main/src/Lait.Umbraco.UI.ScrollToField/preview_1.png)

## How it works

The extension is registered as a **`workspaceFooterApp`**, which lives for the whole workspace
lifetime and survives tab switches. It renders nothing in the footer bar itself; the outline is a
`position: fixed` drawer docked to the right edge of the viewport, with an arrow handle that slides
it in and out.

The outline is built by **scanning the rendered editor DOM** (descending through shadow roots) for
the document's tabs, property-group boxes and block entries — then `scrollIntoView()` +
a temporary highlight on click. This DOM-driven approach is deliberately resilient: it doesn't depend
on private backoffice observables, and it degrades gracefully (an empty or partial outline) rather
than erroring if a future major renames an internal element. A `MutationObserver` re-scans as blocks
are added/removed or the active tab changes.

## Project layout

```
Lait.Umbraco.UI.ScrollToField/
├─ Lait.Umbraco.UI.ScrollToField.sln
├─ umbraco-marketplace.json
└─ src/Lait.Umbraco.UI.ScrollToField/
   ├─ Lait.Umbraco.UI.ScrollToField.csproj   # RCL; StaticWebAssetBasePath = App_Plugins/LaitScrollToField
   ├─ icon.png
   └─ wwwroot/                               # backoffice client (plain JS + Lit, no build step)
      ├─ umbraco-package.json                 # served at /App_Plugins/LaitScrollToField/...
      └─ outline-panel.js                     # the floating outline element
```

The client is intentionally **plain JavaScript** importing Lit from the backoffice's own import map,
so there is **no npm/Vite build** — it runs as-is. The client lives in `wwwroot` and the project sets
`StaticWebAssetBasePath = App_Plugins/LaitScrollToField`, which is how Umbraco 17 discovers the
`umbraco-package.json` from a referenced Razor Class Library — loading over **both a project reference
and a NuGet install, with no manual file copy**.

## Install

From NuGet, into any Umbraco 17 site:

```bash
dotnet add package Lait.Umbraco.UI.ScrollToField
```

Run the site and open any document — the outline drawer is on the right, open by default. There is
nothing to configure.

## Test in a local Umbraco 17 site

**Easiest: run the helper script** (from the repo root, PowerShell): `.\test\setup-local-test.ps1`.
It installs the U17 template, creates a SQLite-backed site under `test/TestSite`, references this
project, and runs it. Login: `admin@example.com` / `P@ssw0rd1234`.

To see the outline at its best, create a document type with **a few tabs and a Block List / Block
Grid** property, add some blocks, then open the document and toggle the panel.

**Project reference (while developing):**

```bash
dotnet add <YourSite>/<YourSite>.csproj reference src/Lait.Umbraco.UI.ScrollToField/Lait.Umbraco.UI.ScrollToField.csproj
```

`dotnet run` the site — no file copying, the client ships as static web assets.

**Local NuGet feed:** run `.\test\pack-local.ps1` (packs to `%USERPROFILE%\LocalNuget` and registers
it as a source), then `dotnet add package Lait.Umbraco.UI.ScrollToField` in any site.

> Tip: run Umbraco in development mode so the `umbraco-package.json` cache is short-lived (~10s) while
> you iterate on `outline-panel.js`.

## Tuning / things to verify against your install

The outline reads the editor's rendered structure. The handful of selectors that could drift between
Umbraco majors are all grouped in the `CONFIG` object at the top of `wwwroot/outline-panel.js`:

- **`editorRootSelectors`** — where the scan is rooted (`umb-content-workspace-view-edit` etc.).
- **`blockSelectors`** — Block List / Block Grid entry elements (`umb-block-grid-entry`,
  `umb-block-list-entry`).
- **`groupTag`** / **`groupNameSelector`** / **`groupNameAttr`** — the property-group container
  (`uui-box`) and where its name comes from (`umb-content-workspace-view-edit-properties[property-group]`).
- **`blockLabelSelectors`** — where a block's display name is read from.
- **`tabSelector`** — the document's content-type tabs.

If a future version renames one of these, adjust `CONFIG` — no other code changes are needed. Blocks
on a **non-active tab** aren't in the DOM until you switch to that tab; that's why tab entries are
listed first, and the outline re-scans after a tab switch.

## Author

Built by **Anders Bootsmann** — [github.com/bootsmann1995](https://github.com/bootsmann1995).

## License

MIT — see [LICENSE](LICENSE).
