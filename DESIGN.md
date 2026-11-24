---
name: Stage Pipeline monitor
description: A flight-strip bay for parallel Claude Code tasks; priority is the order of strips, and the task that needs you sticks out of the line.
colors:
  plate: "#f5b700"
  plate-ink: "#1b1a16"
  plate-hover: "#3a372d"
  turns-paper: "#f6e7b4"
  turns-hover: "#ecd58f"
  strip: "#f4ecd8"
  sheet: "#ebe2c8"
  strip-ink: "#1b1a16"
  strip-muted: "#5a523c"
  strip-rule: "#ddd0ae"
  strip-control-rule: "#8a7d5c"
  strip-hover: "#ebe0c2"
  waits-ink: "#7a4b00"
  bad-ink: "#9c2a20"
  holder-running: "#2a7a3e"
  holder-queued: "#2f6a9e"
  holder-live: "#c5d3cb"
  holder-idle: "#6b747a"
  holder-paused: "#4f5a62"
  holder-problem: "#b83a30"
  holder-ink: "#ffffff"
  chip-running: "#dbecd9"
  chip-running-ink: "#1f5a2d"
  chip-waiting: "#f7e3b0"
  chip-waiting-ink: "#6b4300"
  chip-paused: "#dde1e4"
  chip-paused-ink: "#3a444b"
  bay: "#dfe3de"
  rail: "#eef1ed"
  rail-rule: "#c9d0ca"
  ink: "#1b2226"
  muted: "#4f5a54"
  bar: "#56665d"
  bar-other: "#aab4ae"
  warn: "#8a5a00"
  crit: "#b3261e"
  bay-dark: "#1a2024"
  rail-dark: "#232b30"
  rail-rule-dark: "#333e44"
  ink-dark: "#e4e8e3"
  muted-dark: "#9aa59f"
  strip-dark: "#f1e8d0"
  sheet-dark: "#e7dcc1"
  strip-rule-dark: "#cdbf9c"
  bar-other-dark: "#56636a"
  warn-dark: "#f5b700"
  crit-dark: "#ff8a7a"
typography:
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 700
    letterSpacing: "-0.01em"
  vital:
    fontFamily: "ui-monospace, SF Mono, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "22px"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "-0.02em"
  place:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 700
  ticket:
    fontFamily: "ui-monospace, SF Mono, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-0.01em"
  name:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.15
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.4
    fontFeature: "tnum"
  box-text:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.3
  heading:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 600
  figure:
    fontFamily: "ui-monospace, SF Mono, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "13px"
    fontWeight: 600
  meta:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
  meta-mono:
    fontFamily: "ui-monospace, SF Mono, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.15
  holder-label:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 700
    letterSpacing: "0.05em"
  legend:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 600
rounded:
  paper: "3px"
  panel: "4px"
spacing:
  hair: "2px"
  chip-gap: "4px"
  control-gap: "6px"
  box-y: "7px"
  strip-gap: "8px"
  box-x: "10px"
  rail-gap: "12px"
  panel-y: "14px"
  panel-x: "16px"
  side-gap: "18px"
  wrap-top: "20px"
  cock: "28px"
  gutter: "32px"
  vitals-gap: "32px"
  top-gap: "40px"
  wrap-bottom: "48px"
  strip-height: "64px"
  side-column: "360px"
components:
  strip:
    backgroundColor: "{colors.strip}"
    textColor: "{colors.strip-ink}"
    rounded: "{rounded.paper}"
    height: "64px"
  strip-box:
    typography: "{typography.box-text}"
    padding: "7px 10px"
  holder-needs-you:
    backgroundColor: "{colors.plate}"
    textColor: "{colors.plate-ink}"
    typography: "{typography.holder-label}"
  holder-your-turn:
    backgroundColor: "{colors.strip}"
    textColor: "{colors.strip-ink}"
    typography: "{typography.holder-label}"
  holder-running:
    backgroundColor: "{colors.holder-running}"
    textColor: "{colors.holder-ink}"
    typography: "{typography.holder-label}"
  holder-queued:
    backgroundColor: "{colors.holder-queued}"
    textColor: "{colors.holder-ink}"
    typography: "{typography.holder-label}"
  holder-live:
    backgroundColor: "{colors.holder-live}"
    textColor: "{colors.strip-ink}"
    typography: "{typography.holder-label}"
  holder-idle:
    backgroundColor: "{colors.holder-idle}"
    textColor: "{colors.holder-ink}"
    typography: "{typography.holder-label}"
  holder-paused:
    backgroundColor: "{colors.holder-paused}"
    textColor: "{colors.holder-ink}"
    typography: "{typography.holder-label}"
  holder-problem:
    backgroundColor: "{colors.holder-problem}"
    textColor: "{colors.holder-ink}"
    typography: "{typography.holder-label}"
  strip-sheet:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.strip-ink}"
    rounded: "{rounded.paper}"
    padding: "10px 14px 12px 132px"
  strip-button:
    backgroundColor: "transparent"
    textColor: "{colors.strip-ink}"
    rounded: "{rounded.paper}"
    padding: "4px 9px"
  strip-button-hover:
    backgroundColor: "{colors.strip-hover}"
  strip-button-pressed:
    backgroundColor: "{colors.holder-paused}"
    textColor: "{colors.holder-ink}"
  plate:
    backgroundColor: "{colors.plate}"
    textColor: "{colors.plate-ink}"
    rounded: "{rounded.panel}"
    padding: "12px 14px"
  plate-short:
    padding: "8px 14px"
  plate-open:
    backgroundColor: "{colors.plate-ink}"
    textColor: "{colors.plate}"
    rounded: "{rounded.paper}"
    padding: "5px 12px"
  plate-open-hover:
    backgroundColor: "{colors.plate-hover}"
  turns:
    backgroundColor: "{colors.turns-paper}"
    textColor: "{colors.plate-ink}"
    rounded: "{rounded.panel}"
    padding: "4px 14px"
  turn-open:
    backgroundColor: "transparent"
    textColor: "{colors.plate-ink}"
    rounded: "{rounded.paper}"
    padding: "2px 10px"
  turn-open-hover:
    backgroundColor: "{colors.turns-hover}"
  chip-running:
    backgroundColor: "{colors.chip-running}"
    textColor: "{colors.chip-running-ink}"
    typography: "{typography.meta-mono}"
    rounded: "{rounded.paper}"
    padding: "3px 6px"
  chip-waiting:
    backgroundColor: "{colors.chip-waiting}"
    textColor: "{colors.chip-waiting-ink}"
    typography: "{typography.meta-mono}"
    rounded: "{rounded.paper}"
    padding: "3px 6px"
  chip-paused:
    backgroundColor: "{colors.chip-paused}"
    textColor: "{colors.chip-paused-ink}"
    typography: "{typography.meta-mono}"
    rounded: "{rounded.paper}"
    padding: "3px 6px"
  panel:
    backgroundColor: "{colors.rail}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
    padding: "14px 16px"
  filter-button:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    padding: "5px 12px"
  filter-button-pressed:
    backgroundColor: "{colors.ink}"
    textColor: "#fbf6e8"
  owner-bar:
    backgroundColor: "{colors.bar}"
    rounded: "{rounded.paper}"
    height: "14px"
---

# Design System: Stage Pipeline monitor

## Overview

**Creative North Star: "The Strip Bay"**

The monitor is an air traffic control flight progress board. A bay of graphite (pale grey-green in light) holds buff paper strips printed in near-black, one strip per task, stacked in priority order: the top strip gets the machine first. Every strip opens with a coloured holder cell that names its one state, and its fields sit in fixed boxes ruled by hairlines, so a column reads straight down the whole bay. A strip whose chat asks something is pushed out of line toward the reader; the yellow plate in the right column carries the same chat with its Open.

The world is dense on purpose. One reader knows the vocabulary, so the page shows figures, tickets and states instead of explanations, and colour carries state before any word is read. Paper is the only warm material; everything else (bay, rail panels, top bar) is a cool, quiet ground that recedes behind the strips. The paper stays buff in both themes; only the bay and the rail change.

The system rejects the card-per-task admin dashboard: no KPI tiles, no task cards with headers and footers. Machine figures sit as bare numbers in the top bar; memory is one bar of the whole memory, not a donut or a gauge.

**Key Characteristics:**
- Buff paper strips on a cool bay; paper stays buff in dark.
- One coloured holder cell per strip names the state; the paper never changes colour by state.
- Fixed column grid shared by the legend rail and every strip.
- Yellow means "you": the chat that asks, your turn, the lit owner segment.
- Mono for tickets, figures and commands; system sans for names and prose.
- Out-of-line position (28 px) is the loudest signal and belongs only to a chat that asks.

## Colors

A cool grey-green ground, warm buff paper, one saturated yellow for the reader, and a fixed set of holder colours that read as a status ladder.

### Primary
- **Controller Yellow** (`plate`): the colour of "this waits for you". Fills the Needs you holder, the asking plates in the right column, the inset border of a Your turn holder, the owner-bar segment that is pointed at, and text selection. In dark it also serves as the focus ring and the warn tone of a machine figure.
- **Plate Black** (`plate-ink`): the ink on yellow, and the fill of the Open button on a plate (yellow text on black). Hover deepens to `plate-hover`.
- **Turn Paper** (`turns-paper`): the pale yellow of the one plate that lists chats whose turn ended; quieter than Controller Yellow because nothing there asks.

### Secondary
- **Buff Strip** (`strip`, `strip-dark`): the strip paper. Fields print in `strip-ink`, secondary lines in `strip-muted`, box rules in `strip-rule`.
- **Unfolded Sheet** (`sheet`, `sheet-dark`): the slightly darker buff of a strip unfolded to its chats, so the sheet reads as the strip's underside.
- **Strip control ink** (`strip-control-rule`, `strip-hover`): the hairline of Pause, chevron and Open buttons printed on paper, and their hover fill.
- **Waiting ink** (`waits-ink`): the brown of "question · 60 s" text on paper; `bad-ink` for a task problem line on the sheet.

### Tertiary
The holder ladder, one colour per state, in precedence order:
- **Problem Red** (`holder-problem`), white text.
- **Needs you**: Controller Yellow with Plate Black.
- **Paused Slate** (`holder-paused`), white text. The pressed Resume button on a strip uses the same slate.
- **Your turn**: buff paper with a 3 px Controller Yellow inset border.
- **Queued Blue** (`holder-queued`), white text.
- **Running Green** (`holder-running`), white text.
- **Live Sage** (`holder-live`), near-black text: a chat is open and nothing heavy runs.
- **Idle Grey** (`holder-idle`), white text.

Chips in the Now box take pale tints of the same ladder: `chip-running` / `chip-running-ink`, `chip-waiting` / `chip-waiting-ink` (also throttled), `chip-paused` / `chip-paused-ink`.

### Neutral
- **Bay** (`bay`, `bay-dark`): the page ground. Light is pale grey-green, dark is graphite.
- **Rail** (`rail`, `rail-dark`) and **Rail Rule** (`rail-rule`, `rail-rule-dark`): side panels, banner and empty-state fills, and the hairlines of the top bar and panel rows.
- **Ink** (`ink`, `ink-dark`) and **Muted** (`muted`, `muted-dark`): text on the bay and rail; muted is for section headings, legend, labels after figures and secondary rows.
- **Owner Bar** (`bar`, `bar-other`, `bar-other-dark`): segments of the memory bar. Task segments are `bar` (in dark they turn buff, matching the strips they belong to); other apps are `bar-other`; free memory is the empty track.
- **Pressure** (`warn`, `crit`, `warn-dark`, `crit-dark`): only the tone of a machine figure and a heavy-command state; `crit` also draws the problem banner.

### Named Rules
**The Paper Stays Paper Rule.** Strip paper is buff in both themes. Dark mode changes the bay, rails and figures; it never inverts the strips.

**The Holder Carries State Rule.** A strip's state lives only in its holder cell. The paper, the boxes and the type never change colour by state; the one exception is the waiting text in the Chats box, which echoes the holder.

**The Yellow Means You Rule.** Controller Yellow marks only what wants the reader: a chat that asks, a turn that ended, the pointed-at owner segment, selection and (in dark) focus and warn. It is never decoration and never a sign that things are fine.

## Typography

**Body Font:** system sans (`-apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif`)
**Mono Font:** system mono (`ui-monospace, SF Mono, SFMono-Regular, Menlo, Consolas, monospace`)

**Character:** Printed-form type. The sans names things; the mono prints identifiers and quantities the way a strip printer would. The page works offline, so both stacks are the system's own; there is no display face.

### Hierarchy
- **Vital** (mono 600, 22px, line-height 1, -0.02em): the three machine figures in the top bar (free memory, swap, load), each followed by a 12px muted label.
- **Place** (sans 700, 20px): the strip's position number in the bay.
- **Title** (sans 700, 18px, -0.01em): the page name in the top bar; the largest sans on the page.
- **Ticket** (mono 600, 15px, 1.15, -0.01em): the task ticket on a strip. A strip with no task shows the repo folder in **Name** (sans 600, 15px) instead.
- **Body** (sans 400, 14px, 1.4, tabular figures): the page default.
- **Box text** (sans 400, 13px): the main line of a strip box; Stage and next clamps to two lines at 1.3.
- **Heading** (sans 600, 13px, muted): section headings ("Waiting for you", "Memory by owner"). Sentence case.
- **Figure** (mono 600, 13px): load figures on a strip, right-aligned.
- **Meta** (sans 12px) and **Meta mono** (mono 12px): secondary lines in boxes, chat meta, owner sizes and shares, chips, heavy-command kinds.
- **Holder label** (sans 700, 11px, 0.05em, uppercase): the state word in a holder cell only.
- **Legend** (sans 600, 11px, muted): the column names above the bay.

### Named Rules
**The Printer Rule.** Tickets, figures, sizes, percentages and command lines are mono; names, titles and prose are sans. A ticket is mono wherever it appears: strip, plate, turn row, owner row.

**The Holder Caps Rule.** Uppercase letter-spaced type belongs to the holder cell, where it is the printed state stamp. Headings, labels and buttons stay in sentence case.

## Layout

The page is a top bar over a two-column body. The top bar (min-height 64px, gutter 32px, hairline `rail-rule` below) is a three-track grid: title, the vitals, then the Active/All filter. The body is a grid of the bay (flexible) and the side column (360px) with a 28px gap, padded 20px / 32px / 48px and capped at 1720px.

**The strip grid.** The legend rail and every strip share one column template, `--cols`:

`84px 34px minmax(110px, 176px) minmax(0, 1.3fr) 112px minmax(0, 1.8fr) 76px 104px`

holder | place | ticket and repo | stage and next | now (chips) | chats | load (memory over CPU) | actions (Pause, chevron). Each box is padded 7px 10px and ruled on the left by a `strip-rule` hairline; the holder has no rule. Strips are at least 64px tall and stack with an 8px gap.

**The cock.** The bay carries 28px of left padding. A strip whose chat asks is shifted 28px left into that padding (and 28px in from the right), so it stands out of the line without breaking the grid.

**Side column.** Stacks with an 18px gap: the waiting plates (8px apart), then the Memory by owner panel, then the Heavy commands panel.

**Responsive.**
- **At 1180px and below:** the body becomes one column and the side column moves above the bay, laid out as an auto-fit grid of 300px-minimum tracks.
- **At 860px and below:** the top bar padding drops to 10px / 16px and the vitals wrap onto a second row; the body gutter drops to 16px; the side column moves below the bay (the bay comes first); the legend is hidden and the cock is removed (the holder colour alone carries it). Each strip re-flows into named areas: row 1 holder (76px), place (30px), task, actions; row 2 stage and now; row 3 chats. The load box is hidden, and a strip with no stage, next step or heavy work hides its empty row. The unfolded sheet loses its left indent.

## Elevation & Depth

Depth is physical and small: strips are paper lying on the bay, so they cast a short soft shadow; panels are flat. Lift is a state, never decoration.

### Shadow Vocabulary
- **Paper rest** (`--strip-shadow`; light `0 1px 2px rgba(27,34,38,.14), 0 3px 8px rgba(27,34,38,.08)`, dark `0 2px 6px rgba(0,0,0,.38)`): every strip, its unfolded sheet and every yellow plate.
- **Paper lifted** (`--lift-shadow`; light `0 4px 14px rgba(27,34,38,.22)`, dark `0 6px 18px rgba(0,0,0,.55)`): a cocked strip (its chat asks) and a strip lifted by pointing at its owner in Memory by owner.

### Named Rules
**The Paper Lies Flat Rule.** Only paper (strips, sheets, plates) casts a shadow. Rails, panels, the filter and the top bar are flat and separated by hairlines.

**The Lift Dims the Rest Rule.** When an owner is pointed at, its strip takes the lifted shadow and every other strip drops to 50% opacity; the matching bar segment turns yellow.

## Shapes

Square-cut paper. Strips, sheets, chips and buttons printed on paper use a barely softened corner (3px); rail panels, plates, the filter and the banner use 4px. Nothing is pill-shaped or fully round. Structure inside a strip comes from 1px hairline rules, not from gaps or fills. Empty states use a dashed `rail-rule` border; a drag target strip shows a 2px dashed focus outline.

## Components

### Strip (signature)
Buff paper on the bay, one row of ruled boxes on the shared grid.
- **Shape:** 3px corners, min-height 64px, paper-rest shadow, grab cursor.
- **Boxes:** 7px 10px padding, `strip-rule` hairline left; a muted 12px line over a 13px main line, both ellipsised.
- **Holder:** first box, filled by the state colour, uppercase 11px label (see Colors, Tertiary).
- **Load box:** right-aligned mono figure (memory) over a 12px mono CPU line.
- **States:** cocked (asks) shifts 28px left with the lifted shadow; dragging drops to 45% opacity; drop target gets a 2px dashed outline; keyboard focus draws a 2px solid outline 2px outside the paper.
- **Unfold:** clicking the strip, Enter, or the chevron opens the sheet below it: `sheet` paper, joined to the strip (top corners square, 2px overlap), indented 132px so its text starts under the task column. The sheet lists stage, next, heavy lines (mono 12px) and a ruled list of chats (title, meta, last prompt, Open). The chevron rotates 180°.
- **Reorder:** drag a strip, or Alt+Up / Alt+Down on a focused strip.

### Legend rail
The column names above the bay, on the same `--cols` grid, 11px 600 muted, with 6px below. The load column name is right-aligned to sit over its figures.

### Buttons
- **Plate Open (primary):** Plate Black fill, yellow text, 13px 700, 5px 12px, 3px corners; hover `plate-hover`. The only filled button on the page.
- **Strip button (Pause, chevron, Open on the sheet):** transparent with a 1px `strip-control-rule` hairline, 12px, 4px 9px, 3px corners; hover `strip-hover`. Pressed Pause (Resume) fills with Paused Slate and white text.
- **Turn Open:** transparent with a 1px Plate Black hairline on Turn Paper, 12px 600, 2px 10px; hover `turns-hover`.
- **Link button:** muted underlined 13px text (offset 3px), ink on hover; for "show all".
- **Focus:** every control uses a 2px solid outline offset 2px in `--focus` (ink in light, yellow in dark).

### Plates (Waiting for you)
- **Asking plate:** Controller Yellow, 4px corners, 12px 14px, paper-rest shadow; a two-column grid of who (ticket mono 14px + repo 12px, or the folder name, 700 15px) and kind with age, then Open at the top right, then the question clamped to two lines (13px) and the options on one line (12px). The two oldest are full; the rest are short plates (8px 14px, who and kind only, text in the tooltip).
- **Turn list:** one Turn Paper plate (4px 14px) after the asking plates, a row per chat whose turn ended (who, "your turn · age", Open), rows divided by a 15%-ink hairline.
- **Empty:** a dashed muted "Nobody waits for you." line.

### Owner bar (Memory by owner)
One 14px bar of the whole memory, 3px corners, `rail-rule` inset hairline, 2px gaps between segments: a segment per task (`bar`), other apps (`bar-other`), the rest empty for free memory. Below it, a row per owner (largest first, at most seven, then other apps): name (ticket in mono 12px), size and share in muted mono 12px. Pointing at a segment or row tints the row with `bay`, lights the segment yellow and lifts that task's strip.

### Chips
Mono 12px, 3px 6px, 3px corners, wrapping with 3px / 4px gaps in the Now box. Running shows the kind only; waiting, throttled and paused show "kind · state".

### Filter (Active / All)
A segmented pair in the top bar: 1px muted border, 4px corners, 13px, 5px 12px, an inner muted divider. The pressed side fills with ink and paper text (in dark, buff fill with near-black text) and turns 600; hover is the rail tint. Each side carries its count.

### Panels and vitals
- **Panel:** rail fill, 1px `rail-rule` border, 4px corners, 14px 16px, 13px 600 muted heading with 12px below. Heavy-command rows sit on a three-track grid (86px mono kind, state text, mono usage) with hairlines between.
- **Vitals:** three figure-and-label pairs on one baseline, 32px apart, figure tinted `warn` or `crit` by pressure.
- **Banner:** a `crit` hairline box on rail with `crit` text, under the top bar, for a server or save failure.

### Motion
- Cock in and out: margin over 0.2s on `cubic-bezier(.2, .8, .2, 1)`; opacity changes (drag, lift) over 0.15s ease-out.
- Chevron rotation: 0.18s on the same curve.
- With reduced motion, strips and chevron do not transition.

## Do's and Don'ts

### Do:
- **Do** put every new per-task field into a ruled box on the shared `--cols` grid, and add its name to the legend rail.
- **Do** name a strip's state only through its holder cell, using the holder ladder in precedence order (problem, needs you, paused, your turn, queued, running, live, idle).
- **Do** reserve the 28px cock and the lifted shadow for a strip whose chat asks something (and for the pointed-at owner's lift).
- **Do** print tickets, sizes, percentages and command lines in mono, and names in sans.
- **Do** keep strip paper buff and strip ink near-black in both themes; theme only the bay, rails, ink and figures.
- **Do** tint machine figures `warn` or `crit` by pressure rather than adding icons or badges.
- **Do** keep the page offline: system font stacks only, inline SVG for the chevron.

### Don't:
- **Don't** turn a task into a card with a header, body and footer, or put machine figures in KPI tiles.
- **Don't** colour strip paper, boxes or rows by state; the holder carries it.
- **Don't** use Controller Yellow as decoration or as a "fine" signal; it means the reader is wanted.
- **Don't** use uppercase letter-spaced labels outside the holder cell.
- **Don't** give rails, panels or the top bar a shadow; only paper casts one.
- **Don't** round anything past 4px.
- **Don't** load web fonts or a CDN.
