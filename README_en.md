# Zotero Cite (SiYuan plugin)

**English** | [简体中文](./README.md)

Insert Zotero citations into SiYuan through the **Zotero Debug Bridge**. Zero build step, one CommonJS file.

![icon](icon.svg)

## Read this first: the plugin has an external dependency

**Requires Zotero 10**, with **Debug Bridge 1.2**. The plugin does not read Zotero's database directly. It sends code to the **Zotero Debug Bridge** add-on running inside Zotero, which executes it in Zotero's own context and returns the result. **Without that add-on the plugin cannot work** — nothing is listening on `debug-bridge` at port 23119, so every request fails.

### Install Debug Bridge (1.2)

1. **Download the `Debug Bridge 1.2` xpi** — use 1.2, not an older build.
2. **Install**: Zotero → Tools → Plugins, then **drag the xpi into the window**.
3. **Restart Zotero**.
4. **Set a token**: Zotero → Tools → Developer → Run JavaScript, execute

   ```js
   Zotero.Prefs.set("extensions.zotero.debug-bridge.token", "CTT", true);
   ```

   (replace `"CTT"` with your own token — you will paste the same string into the plugin settings)

   While you are there, switching the Zotero UI to English makes keyboard work smoother:

   ```js
   Zotero.Prefs.set("intl.locale.requested", "en-US", true);
   Zotero.Prefs.set("intl.accept_languages", "en-US, en", true);
   ```

5. **Check from SiYuan**: plugin settings → "Test connection". `Connected: Zotero 10.0.1, library ID 1` means you are good.

> The same instructions are built into the top of the plugin settings panel, together with an "Open full setup guide" button. Connection errors also carry a link to that guide.

## Features

1. Insert the items currently selected in Zotero (multi-select supported, merged into a single citation)
2. **Text follows the CSL style exactly**: how the in-text citation looks, how multiple items are joined, whether `[n]` appears — all decided by the style (APA → `(Chen et al., 2021)`; IEEE → `[1]`; GB/T numeric → `[1]`). The plugin never assembles brackets or numbers on its own
3. The bibliography order also comes from the style (alphabetical for author-date, citation order for numeric); **entries carry no numbering** — the `[1]` prefix produced by numeric styles is stripped, and entries are laid out as plain paragraphs without bullet points
4. **Right-click any citation**: switch form / edit the references of this citation (add or remove) / change the document-wide CSL style / jump to the matching bibliography entry
5. Click a citation to jump to Zotero and select that item (multi-item citations select all of them)
6. Built-in undo stack, 20 steps per document

> The link itself never changes: it is always `zotero://select/library/items/KEY?zkeys=…&f=…`. Switching styles only rewrites the visible text — the link structure and SiYuan's link styling stay untouched.

## Icon

32-unit grid, red Z with a superscript block in the top-right corner:

- The red Z borrows Zotero's brand colour so it stands out in a row of grey icons
- The superscript block stands for "citation number" and degrades into a single bright pixel at 16px, still recognisable
- Colours are hard-coded (no `currentColor`), otherwise SiYuan themes would tint it grey and kill recognition
- A brighter `#F0604B` / `#FF8B74` pair is used in dark themes

Two icon files ship with the plugin; they serve different purposes:

| File | Purpose |
|---|---|
| `icon.svg` | Top-bar button (the same artwork is inlined by `addTopBar`) |
| `icon.png` | Bitmap for the **bazaar / plugin list card**, 256×256, rasterised from `icon.svg` |

Ship only the SVG and Settings → Bazaar → Downloaded → Plugins shows SiYuan's default placeholder (a blue house).

## Two citation forms

| Form | Description |
|---|---|
| Default | Straight CSL output; the plugin's default choice |
| `Chen et al. (2026)` narrative | author-only + suppress-author. **Author-date styles only**; the menu item is greyed out for numeric styles (existing narrative marks are reverted to default automatically) |

The form is stored per citation (the `?f=` query parameter), so you can mix forms in one document. The "default form" setting only affects newly inserted citations.

Multi-item narrative citations add a conjunction that follows the language: English `A (2014), B (2019) and C (2020)`; Chinese `甲（2014）、乙（2019）和丙（2020）`.

## Installation

Copy the whole directory into SiYuan's plugin folder:

```
Windows: C:\Users\<you>\SiYuan\data\plugins\siyuan-plugin-zotero-cite\
```

Then enable "Zotero 文献引用" in SiYuan → Settings → Bazaar → Downloaded → Plugins.

## Configuration

SiYuan → Settings → Bazaar → Downloaded → Plugins → Zotero Cite → Settings:

| Item | Description |
|---|---|
| Bridge URL | Default `http://127.0.0.1:23119/debug-bridge/execute` |
| Access token | The token you set in step 4 above |
| Default citation form | Default / narrative. Only affects new citations |
| CSL style | For example `http://www.zotero.org/styles/apa`, `.../ieee`, `.../gb-t-7714-2015-author-date-bilingual` |
| Pick from installed styles… | Opens the style picker; search and switch in one click (same as the right-click "change document style") |
| Bibliography heading | Defaults to `参考文献` |
| Citations carry links | Turn off to leave plain text only (click-to-Zotero and the right-click menu stop working) |

## Usage

### Insert a citation

1. Select items in Zotero (multi-select works; you can also search and tick items inside the dialog)
2. Back in SiYuan, put the cursor where the citation should go
3. Any of three entry points:
   - Click the red Z icon in the top bar
   - Type `/zotero` in the editor and press Enter (slash menu)
   - Search "插入 Zotero 文献引用" in the command palette
4. Tick the items → insert

**Parent items only**: notes and PDF attachments — whether found by search or selected in Zotero — are resolved to their parent item. Standalone notes and standalone attachments (no parent) never appear, because they carry no bibliographic data. So selecting a PDF in Zotero still inserts the paper it belongs to.

### Right-click menu (5 items — this is where existing citations are edited)

| Item | Effect |
|---|---|
| Default citation form | Restores the style's own rendering; affects this citation only |
| `Chen et al. (2026)` narrative | Switches to narrative; affects this citation only; greyed out for numeric styles |
| Edit references… (add or remove) | Lists every item in this citation — untick to remove; also appends the current Zotero selection or adds items found by keyword search |
| Change document CSL style… | Reads the styles installed in Zotero, applies the one you pick, re-renders the whole document |
| Locate this entry in the bibliography | Scrolls to the matching entry and highlights it for 1.9 s; multi-item citations highlight all of them |

- Single click = jump to Zotero (all items of a multi-item citation are selected)
- To delete a citation, just delete the text in the editor, or untick everything in "Edit references"

### Undo

The plugin writes through the kernel API, which **bypasses SiYuan's front-end undo stack**, so plain `Ctrl+Z` cannot roll back re-rendering or style switches.

- Command palette: "撤销上一次 Zotero 引用操作" (shortcut `Ctrl+Alt+Z`), 20 steps per document
- One step = one complete operation; undo also restores the previous CSL style and re-renders the bibliography
- **Inserting** a citation goes through `protyle.insert` and stays in SiYuan's own undo stack, so plain `Ctrl+Z` works there

## Data model

A citation in the body is just a markdown link:

```
[(Bordoloi et al., 2019)](zotero://select/library/items/UAPYI8NA?f=csl)
```

- The links are the single source of truth; re-rendering collects key order from the body
- `?f=` is the form of this citation: `csl` / `narr` (older `paren`/`num`/`paren+num`/`narr+num` values are migrated automatically)
- Multi-item: `...items/KEY1?zkeys=KEY1,KEY2&f=csl`
- Bibliography entry links carry `?bib=1` so they can be told apart from in-text citations — re-rendering skips them, otherwise deleted references would keep coming back because their bibliography entry still exists
- The document attributes `custom-zotero-cites` / `custom-zotero-style` / `custom-zotero-formats` are redundant backups only

> Why multi-item citations are not written as `items/KEY1,KEY2`: Zotero 10 only splits commas in the `itemKey` query parameter. A comma-separated path is treated as one nonexistent key and, once handed to Windows protocol dispatch, hangs Zotero. On click the plugin calls `selectItems()` inside Zotero through the debug bridge instead.

## Known limitations

- In-text `[n]` (numeric styles) is assigned by CSL in citation order; re-render once after adding or removing citations. Bibliography entries show no numbering, but their order still matches the in-text numbers
- Rebuilding the bibliography deletes every block after the heading — do not write body text below that heading
- Narrative form exists only for author-date styles; numeric styles (IEEE, GB/T numeric) have no such concept
- Moving to another machine means reinstalling Debug Bridge and re-entering the token (it lives in Zotero's `prefs.js` and does not sync with SiYuan)
