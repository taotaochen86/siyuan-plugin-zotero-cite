# Zotero Cite (SiYuan plugin)

**English** | [简体中文](./README.md)

![icon](icon.svg)

## 1 In one sentence

Insert Zotero citations into SiYuan — both the in-text citation and the bibliography are rendered by the CSL style you already use in Zotero, so what you get is submission-ready text.

## 2 What it does

| Feature | Detail |
|---|---|
| 2.1 One-click insert | Select items in Zotero (multi-select allowed), click once in SiYuan, both the text and the bibliography update. No dialog |
| 2.2 Text follows CSL exactly | How the citation reads, how multiple items are joined, whether `[n]` appears — all decided by the active Zotero style (APA, Nature, IEEE, GB/T 7714, ACS, journal-specific styles) |
| 2.3 Two forms, mixable per citation | Default form (parent item / author-date / numeric) plus narrative `Chen et al. (2021)`; you can mix them in one document and even stack them as `Chen et al. (2021) [1]` |
| 2.4 Edit existing citations | Switch form, add or remove references of that citation, change the document-wide CSL style, jump to the matching bibliography entry |
| 2.5 Bibliography maintained automatically | Order follows the style (alphabetical for author-date, citation order for numeric); entries carry no numbering; re-rendered when the style changes |
| 2.6 Click to jump back to Zotero | Clicking a citation selects that item in Zotero; multi-item citations select all of them |
| 2.7 Parent items only | Selecting a PDF or an annotation in Zotero resolves to its parent item; standalone notes and attachments never appear |
| 2.8 Undo | 20 steps per document, style switches included |

## 3 Problems it solves in SiYuan

| Native SiYuan | With this plugin |
|---|---|
| 3.1 There is no citation concept at all — only block references and plain hyperlinks | A citation is a `zotero://` link whose visible text is rendered by CSL, effectively bringing Zotero's citation engine into SiYuan |
| 3.2 The bibliography has to be pasted in from Zotero by hand, and rebuilt whenever the style changes | The bibliography is generated automatically and re-rendered together with the body when the style changes |
| 3.3 In-text formatting (author-date vs. numeric) is typed manually; changing one citation means fixing every number | Numbers and author-date strings are assigned by CSL in citation order — re-render once after adding or removing citations |
| 3.4 In-text citations and bibliography entries have no link to each other, so removing a reference means fixing both ends | Both ends share the same itemKey; delete an in-text citation, re-render, and the bibliography entry disappears |
| 3.5 Finding which paper a sentence came from means digging through Zotero | Click the citation to jump to Zotero with the item selected — all items for a multi-item citation |
| 3.6 Journal and thesis templates differ wildly; hand-formatting is error-prone | Thousands of CSL styles are available instantly, and custom CSL files work too |

## 4 How it compares

Based only on each plugin's public documentation. **Not tested side by side** — check their docs for authoritative detail.

| | Zotero Cite (this plugin) | 文献引用 (WingDr/siyuan-plugin-citation) | 论文管理 (fu1fan/siyuan-paper-manager) |
|---|---|---|---|
| 4.1 Focus | In-text citations + bibliography, rendered by CSL | Literature-note library + citation links, Word/LaTeX export | Native-database paper library, citation export |
| 4.2 Literature notes required first | No | Yes — citations point at note documents in a library | No — metadata lives in a native database |
| 4.3 Rendering | Handed to Zotero's CSL engine; body and bibliography share one source | Anchor text generated from templates, several styles | Mostly "export a citation string"; you paste it into the body |
| 4.4 Bibliography | Generated and re-rendered with the style | Depends on the literature-note library structure | Export only; no bibliography maintenance |
| 4.5 Data source | Zotero 10 + Debug Bridge | BibTeX / CSL-JSON / Better BibTeX / Debug Bridge / Web API | Zotero Connector intake + local PDF metadata extraction |
| 4.6 Setup cost | Zotero + Debug Bridge required | Can work from local BibTeX alone | Zotero optional; PDF metadata resolved online |
| 4.7 Best for | Zotero users who need submission-grade formatting | People building a literature-note library inside SiYuan | People who want a paper library plus PDF translation |

Short version: **if your references already live in Zotero and you only need the text and bibliography to be right**, this plugin is the least work; **if you want literature cards inside SiYuan and Word/LaTeX export**, those two fit better.

## 5 Requirements and setup

### 5.1 Requirements

| Requirement | Version | Note |
|---|---|---|
| Zotero | **10** | The plugin runs code inside Zotero through the Debug Bridge; it never reads the database file |
| Zotero Debug Bridge | **1.2** | Zotero add-on exposing `127.0.0.1:23119/debug-bridge/execute` |
| SiYuan | 3.1.0+ | Desktop only (`frontends: desktop`) |

Without the Debug Bridge nothing listens on that endpoint and every request fails.

### 5.2 First-time setup

1. Download the Debug Bridge **1.2** xpi (not an older build)
2. Zotero → Tools → Plugins, then **drag the xpi into the window**
3. Restart Zotero
4. Zotero → Tools → Developer → Run JavaScript:

   ```js
   Zotero.Prefs.set("extensions.zotero.debug-bridge.token", "CTT", true);
   ```

   Replace `"CTT"` with your own token
5. SiYuan → Settings → Bazaar → Downloaded → Plugins → Zotero Cite → Settings, paste the same token into "Access token"
6. Click "Test connection"; `Connected: Zotero 10.x, library ID 1` means you are done

Repeating steps 1–5 is required on a new machine (the token lives in Zotero's `prefs.js` and does not sync with SiYuan).

### 5.3 Settings

| Item | Default | Note |
|---|---|---|
| Bridge URL | `http://127.0.0.1:23119/debug-bridge/execute` | Rarely needs changing |
| Access token | empty | The token from step 4 in 5.2 |
| Default citation form | Default (CSL) | Affects new citations only; existing ones follow their own `?f=` |
| CSL style | current style | You can paste a style URL directly |
| Pick from installed styles… | — | Opens the style picker; search and switch, whole document re-renders |
| Bibliography heading | 参考文献 | Must match the heading used in the document |
| Citations carry links | on | Turn off for plain text; click-to-Zotero and the right-click menu stop working |

## 6 Slash command and shortcuts

| Entry / command | How to trigger | Shortcut |
|---|---|---|
| 6.1 Insert citation (main) | Type `/zotero` and press Enter in the editor | Unbound — set your own in Settings → Keymap → Plugins |
| 6.2 Insert citation | Red Z icon in the top bar | — |
| 6.3 Insert citation | Command palette: "插入 Zotero 文献引用" | Unbound |
| 6.4 Re-render all citations | Command palette: "重排全文 Zotero 引用" | Unbound |
| 6.5 Cycle form at cursor | Command palette: "切换光标处引用的形态" | Unbound |
| 6.6 Undo last citation action | Command palette: "撤销上一次 Zotero 引用操作" | `Ctrl+Alt+Z` (macOS: `⌥⌘Z`) |
| 6.7 Right-click · Default citation form | Right-click an in-text citation → item 1 | — |
| 6.8 Right-click · Narrative (`Chen et al. (2026)`) | Right-click an in-text citation → item 2 (greyed out for numeric styles) | — |
| 6.9 Right-click · Edit references… (add or remove) | Right-click an in-text citation → item 3, opens the editor | — |
| 6.10 Right-click · Change document CSL style… | Right-click an in-text citation → item 4, opens the style picker | — |
| 6.11 Right-click · Locate this entry in the bibliography | Right-click an in-text citation → item 5, scrolls to the entry and highlights it for 1.9 s | — |

The right-click menu only works on **in-text citations**, and only affects the citation you clicked. The `[↗]` link on a bibliography entry does not open the menu — it is the jump-back-to-Zotero link. None of the menu items has a default shortcut; bind the matching commands in Settings → Keymap → Plugins if you want one.

## 7 Usage

### 7.1 Insert a citation

1. Select items in Zotero (multi-select becomes one citation)
2. Back in SiYuan, put the cursor where the citation should go
3. Use any entry point (all three behave identically):
   - Type `/zotero` and press Enter
   - Click the red Z icon in the top bar
   - Command palette: "插入 Zotero 文献引用"
4. The citation appears and its bibliography entry is added at the end of the document

If nothing is selected in Zotero you get a one-line hint, never a dialog.

### 7.2 Edit an existing citation (right-click, 5 items)

| Menu item | Effect |
|---|---|
| Default citation form | Restores the style's own rendering; this citation only |
| `Chen et al. (2026)` narrative | Switches to narrative; this citation only; greyed out for numeric styles |
| Edit references… (add or remove) | Lists every item of this citation — untick to remove; append the current Zotero selection or add by keyword search |
| Change document CSL style… | Reads styles installed in Zotero, applies your pick, re-renders the whole document |
| Locate this entry in the bibliography | Scrolls to the entry and highlights it for 1.9 s; all items get highlighted |

- Single click = jump to Zotero (all items selected)
- To delete a citation, delete the text, or untick everything in "Edit references"

### 7.3 Undo

The plugin writes through the kernel API, which bypasses SiYuan's front-end undo stack, so plain `Ctrl+Z` cannot roll back re-rendering or style switches.

1. Command palette: "撤销上一次 Zotero 引用操作", or `Ctrl+Alt+Z`
2. 20 steps per document; one step = one complete operation
3. Undo also restores the previous CSL style and re-renders the bibliography
4. Inserting a citation goes through `protyle.insert` and stays in SiYuan's own undo stack — plain `Ctrl+Z` works there

### 7.4 What a citation really is

An in-text citation is just a markdown link:

```
[(Bordoloi et al., 2019)](zotero://select/library/items/UAPYI8NA?f=csl)
```

1. The link is the single source of truth; re-rendering collects order from the body
2. `?f=` is the form of that citation (`csl` / `narr`), stored per citation
3. Multi-item: `items/KEY1?zkeys=KEY1,KEY2&f=csl`
4. Bibliography entry links carry `?bib=1` and are skipped when re-rendering, so deleted references do not come back

## 8 Limitations

1. **Hard dependency on Zotero + Debug Bridge** — without it the plugin does nothing; it is not self-contained
2. **Zotero only** — EndNote, Mendeley, NoteExpress and direct PubMed lookup are not supported
3. **Desktop only** — it needs the local port 23119, so the web and mobile clients cannot use it
4. **Rebuilding the bibliography wipes everything after the heading** — never write body text below the "参考文献" heading; it will be deleted on every re-render
5. **Undo is a separate stack** — `Ctrl+Z` only covers inserting; re-rendering and style switches need the plugin's own undo command
6. **Numeric styles need a manual re-render** — numbers are reassigned by CSL after adding or removing citations
7. **Narrative form is author-date only** — IEEE and GB/T numeric styles have no such concept
8. **Bibliography entries show no numbering** — a deliberate choice to avoid duplicated list markers; stricter GB/T numeric formatting expects `[1]` on each entry, so check your journal's requirement before submission
9. **Reconfiguration on a new machine** — Debug Bridge and the token must be reinstalled and re-entered
10. **Performance degrades with document size** — a long document with many citations re-renders block by block and visibly pauses
