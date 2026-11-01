---
name: OTW Studio
description: A mission deck for media. Paste a link, launch it, follow its telemetry, take the file.
colors:
  signal: "#ec2c92"
  signal-fill: "#d41b7e"
  signal-fill-hover: "#db2084"
  signal-ink: "#f56aaf"
  signal-soft: "rgb(236 44 146 / 0.14)"
  signal-line: "rgb(236 44 146 / 0.5)"
  signal-glow: "#ff8cc6"
  field-hot: "#ff5fae"
  field-deep: "#b8106a"
  on-signal: "#ffffff"
  bg: "#0a0a0d"
  bg-2: "#121216"
  bg-3: "#1a1a20"
  bg-4: "#24242c"
  bar: "rgb(10 10 13 / 0.84)"
  line: "rgb(255 255 255 / 0.08)"
  line-2: "rgb(255 255 255 / 0.14)"
  track: "rgb(255 255 255 / 0.1)"
  scrim: "rgb(0 0 0 / 0.6)"
  text: "#f4f3f7"
  text-2: "#aba9b5"
  text-3: "#8b8995"
  ok: "#3ddc97"
  ok-soft: "rgb(61 220 151 / 0.12)"
  warn: "#f5b83d"
  warn-soft: "rgb(245 184 61 / 0.12)"
  err: "#ff6b57"
  err-soft: "rgb(255 107 87 / 0.12)"
  err-line: "rgb(255 107 87 / 0.32)"
  light-bg: "#f2f1f5"
  light-bg-2: "#ffffff"
  light-bg-3: "#ffffff"
  light-bg-4: "#eceaf0"
  light-bar: "rgb(242 241 245 / 0.86)"
  light-line: "rgb(16 14 24 / 0.09)"
  light-line-2: "rgb(16 14 24 / 0.16)"
  light-track: "rgb(16 14 24 / 0.1)"
  light-scrim: "rgb(16 14 24 / 0.4)"
  light-text: "#0f0e14"
  light-text-2: "#4a4855"
  light-text-3: "#64626e"
  light-signal-ink: "#c0166f"
  light-signal-soft: "rgb(236 44 146 / 0.1)"
  light-signal-line: "rgb(212 27 126 / 0.45)"
  light-ok: "#0c6b44"
  light-ok-soft: "rgb(19 138 89 / 0.1)"
  light-warn: "#875700"
  light-warn-soft: "rgb(214 140 0 / 0.12)"
  light-err: "#c7361f"
  light-err-soft: "rgb(199 54 31 / 0.08)"
  light-err-line: "rgb(199 54 31 / 0.3)"
typography:
  display:
    fontFamily: "Unbounded, Assistant, Raleway, sans-serif"
    fontSize: "26px"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-0.02em"
  readout:
    fontFamily: "Unbounded, Assistant, Raleway, sans-serif"
    fontSize: "46px"
    fontWeight: 600
    lineHeight: 0.95
    letterSpacing: "-0.035em"
    fontFeature: '"tnum", "lnum"'
  readout-sm:
    fontFamily: "Unbounded, Assistant, Raleway, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "-0.02em"
    fontFeature: '"tnum", "lnum"'
  headline:
    fontFamily: "Raleway, Assistant, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "-0.005em"
  title:
    fontFamily: "Raleway, Assistant, system-ui, sans-serif"
    fontSize: "14.5px"
    fontWeight: 700
    lineHeight: 1.35
  body:
    fontFamily: "Raleway, Assistant, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 500
    lineHeight: 1.5
    fontFeature: '"lnum"'
  meta:
    fontFamily: "Raleway, Assistant, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.5
  label:
    fontFamily: "Raleway, Assistant, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 650
    lineHeight: 1.3
  button:
    fontFamily: "Raleway, Assistant, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "0.01em"
  status:
    fontFamily: "Raleway, Assistant, system-ui, sans-serif"
    fontSize: "10.5px"
    fontWeight: 750
    lineHeight: 1
    letterSpacing: "0.06em"
  data:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "12.5px"
    fontWeight: 450
    lineHeight: 1.75
rounded:
  r-s: "8px"
  r: "12px"
  r-inset: "14px"
  r-msg: "16px"
  r-l: "20px"
  r-pill: "999px"
spacing:
  tight: "6px"
  cluster: "8px"
  stack: "12px"
  row-y: "14px"
  row-x: "16px"
  gutter: "16px"
  stack-lg: "20px"
  gutter-wide: "24px"
  section: "30px"
  topbar-h: "58px"
  tabbar-h: "66px"
  sidebar-w: "256px"
components:
  button-primary:
    backgroundColor: "{colors.signal-fill}"
    textColor: "{colors.on-signal}"
    typography: "{typography.button}"
    rounded: "{rounded.r-pill}"
    padding: "0 18px"
    height: "44px"
  button-primary-hover:
    backgroundColor: "{colors.signal-fill-hover}"
  button-secondary:
    backgroundColor: "{colors.bg-3}"
    textColor: "{colors.text}"
    typography: "{typography.button}"
    rounded: "{rounded.r-pill}"
    padding: "0 18px"
    height: "44px"
  button-secondary-hover:
    backgroundColor: "{colors.bg-4}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-2}"
    typography: "{typography.button}"
    rounded: "{rounded.r-pill}"
    padding: "0 18px"
    height: "44px"
  button-ghost-hover:
    backgroundColor: "{colors.bg-3}"
    textColor: "{colors.text}"
  button-danger:
    backgroundColor: "{colors.err-soft}"
    textColor: "{colors.err}"
    typography: "{typography.button}"
    rounded: "{rounded.r-pill}"
    padding: "0 18px"
    height: "44px"
  button-sm:
    padding: "0 14px"
    height: "36px"
  button-xs:
    padding: "0 11px"
    height: "30px"
  chip:
    backgroundColor: "transparent"
    textColor: "{colors.text-2}"
    typography: "{typography.label}"
    rounded: "{rounded.r-pill}"
    padding: "0 14px"
    height: "38px"
  chip-selected:
    backgroundColor: "{colors.signal-soft}"
    textColor: "{colors.text}"
  segmented:
    backgroundColor: "{colors.bg-2}"
    rounded: "{rounded.r-pill}"
    padding: "3px"
  segmented-option:
    backgroundColor: "transparent"
    textColor: "{colors.text-2}"
    typography: "{typography.label}"
    rounded: "{rounded.r-pill}"
    padding: "0 14px"
    height: "34px"
  segmented-option-selected:
    backgroundColor: "{colors.bg-4}"
    textColor: "{colors.text}"
  input:
    backgroundColor: "{colors.bg-2}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.r}"
    padding: "0 14px"
    height: "46px"
  composer:
    backgroundColor: "{colors.bg-3}"
    textColor: "{colors.text}"
    rounded: "{rounded.r-pill}"
    padding: "5px"
  panel:
    backgroundColor: "{colors.bg-2}"
    textColor: "{colors.text}"
    rounded: "{rounded.r-l}"
    padding: "16px"
  list-row:
    textColor: "{colors.text}"
    typography: "{typography.title}"
    padding: "14px 16px"
  thumb:
    backgroundColor: "{colors.bg-4}"
    rounded: "10px"
  pill-ok:
    backgroundColor: "{colors.ok-soft}"
    textColor: "{colors.ok}"
    typography: "{typography.status}"
    rounded: "{rounded.r-pill}"
    padding: "0 8px"
    height: "22px"
  pill-warn:
    backgroundColor: "{colors.warn-soft}"
    textColor: "{colors.warn}"
    typography: "{typography.status}"
    rounded: "{rounded.r-pill}"
    padding: "0 8px"
    height: "22px"
  pill-err:
    backgroundColor: "{colors.err-soft}"
    textColor: "{colors.err}"
    typography: "{typography.status}"
    rounded: "{rounded.r-pill}"
    padding: "0 8px"
    height: "22px"
  pill-run:
    backgroundColor: "{colors.signal-soft}"
    textColor: "{colors.signal-ink}"
    typography: "{typography.status}"
    rounded: "{rounded.r-pill}"
    padding: "0 8px"
    height: "22px"
  pill-muted:
    backgroundColor: "{colors.bg-4}"
    textColor: "{colors.text-2}"
    typography: "{typography.status}"
    rounded: "{rounded.r-pill}"
    padding: "0 8px"
    height: "22px"
  pill-live:
    backgroundColor: "{colors.signal-fill}"
    textColor: "{colors.on-signal}"
    typography: "{typography.status}"
    rounded: "{rounded.r-pill}"
    padding: "0 8px"
    height: "22px"
  track-segment:
    backgroundColor: "{colors.track}"
    rounded: "2px"
    height: "4px"
  track-segment-done:
    backgroundColor: "{colors.signal}"
  track-segment-failed:
    backgroundColor: "{colors.err}"
  track-segment-lg:
    rounded: "3px"
    height: "6px"
  alert-error:
    backgroundColor: "{colors.err-soft}"
    textColor: "{colors.text}"
    rounded: "{rounded.r-msg}"
    padding: "14px 16px"
  alert-warn:
    backgroundColor: "{colors.warn-soft}"
    textColor: "{colors.text}"
    rounded: "{rounded.r-msg}"
    padding: "14px 16px"
  alert-info:
    backgroundColor: "{colors.signal-soft}"
    textColor: "{colors.text}"
    rounded: "{rounded.r-msg}"
    padding: "14px 16px"
  nav-row:
    backgroundColor: "transparent"
    textColor: "{colors.text-2}"
    typography: "{typography.label}"
    rounded: "{rounded.r}"
    padding: "0 12px"
    height: "42px"
  nav-row-current:
    backgroundColor: "{colors.bg-3}"
    textColor: "{colors.text}"
  tabbar:
    backgroundColor: "{colors.bar}"
    textColor: "{colors.text-3}"
    height: "{spacing.tabbar-h}"
  toast:
    backgroundColor: "{colors.bg-4}"
    textColor: "{colors.text}"
    rounded: "{rounded.r-msg}"
    padding: "12px 14px"
---

# Design System: OTW Studio

## Overview

**Creative North Star: "The Mission Deck"**

OTW Studio is a mission deck for media. A pasted link becomes a payload the member inspects, launches from a thumb-reach composer and follows by its telemetry until it lands as a file. The world is graphite space: four near-black steps from Graphite Void (#0a0a0d) upward, lit by a single signal colour, OTW Design's hot magenta (#ec2c92), which marks only what is live, chosen or about to happen. Raised surfaces catch light along their top edge like brushed metal, and the two places where media enters (the composer and the upload dropzone) wear a chrome rim. OTW Design's own chrome astronaut helmet, keyed from their 512px logo, is the only illustration: it rides the magenta field and floats inside a drawn orbit on empty states.

Density is an instrument panel, not a dashboard. Lists run 14.5px titles over 12.5–13px meta. Numerals are tabular everywhere and set in the display face wherever they are readouts. Every job shows its state on a four-segment track (queued, fetch, process, ready) with percent, stage, speed and time left. Every error names what happened and sits beside the button that fixes it. The phone is the primary cockpit, with a glass top bar, a five-tab bar and the docked composer. From 1024px a sidebar takes over, and from 1280px the in-flight column stands beside the deck.

The confirmed anti-reference is the category default: a centred paste box on a white page with a giant download button. Dark is the default theme. The light theme swaps tokens and keeps the component grammar unchanged. English and Hebrew share one layout written in logical properties, so right-to-left is a mirror, not a variant.

**Key Characteristics:**
- Graphite tonal stack with light-catch gradient edges on raised surfaces; no flat grey card borders.
- One signal colour, OTW magenta, for action, live work, selection and focus; one magenta field per screen.
- Unbounded for titles and readouts, Raleway for the interface, Assistant leading in Hebrew, JetBrains Mono for logs and IDs.
- Pills for everything pressed, 20px rounded panels, 16:9 media stills with 10px corners.
- A four-segment telemetry track whose sheen moves only while work is happening.
- Mobile first with a thumb-zone composer; logical properties throughout for RTL.

## Colors

A graphite-and-magenta palette: four near-black neutrals carry the structure, OTW's hot magenta is the only chromatic voice, and three status hues appear only on status.

### Primary
- **OTW Magenta** (#ec2c92, `signal`): the brand signal. It is used for the 2px focus ring, the current tab and nav icon, the tab underline and tab-bar cap, completed telemetry segments and the active fill, the orbit dot, and the composer and dropzone rims when active. It is never used as a text colour on dark and never as a fill under white text (3.93:1).
- **Pressed Magenta** (#d41b7e, `signal-fill`; hover #db2084): the fill for every magenta surface that carries white text, including primary buttons, the switch's on state and the live pill. White on it measures 4.93:1 (4.61:1 on hover).
- **Pink Readout** (#f56aaf, `signal-ink`; light theme #c0166f): magenta as text. It is used for links, running-pill text, transcript timestamps, sidebar counts, the selected chip's size and the info-alert icon (6.7:1 on panels).
- **Selection Tint** (`signal-soft`, magenta at 14%) and **Selection Line** (`signal-line`, magenta at 50%): the fill and outline of whatever is chosen, such as a selected chip, a selected recipe row, the running pill, the info alert and the 3px focus halo around inputs.
- **Glow Pink** (#ff8cc6, `signal-glow`): the bright midpoint of the magenta rim when the composer has focus or a file is dragged over the dropzone, and the top stop of the audio waveform gradient.
- **The Magenta Field** (`field-hot` #ff5fae → `signal` #ec2c92 → `field-deep` #b8106a): a radial gradient used behind the Launch greeting band, `radial-gradient(130% 150% at 90% 0%, #ff5fae 0%, #ec2c92 32%, #b8106a 72%, #8a0a4f 100%)`, and behind the sign-in brand panel, `radial-gradient(120% 90% at 80% 0%, #ff5fae 0%, #ec2c92 38%, #b8106a 100%)`. Text on it is white (`on-signal`). The bright end follows the helmet, so in Hebrew both gradients mirror (`at 10% 0%` and `at 20% 0%`) and text stays on the deep end.

### Status
- **Signal Green** (#3ddc97, `ok`; light #0c6b44): marks ready and uploaded states, a met password rule, the toast check and success lines in the log.
- **Amber** (#f5b83d, `warn`; light #875700): marks the storage-full alert and "deleted soon" file meta.
- **Ember** (#ff6b57, `err`; light #c7361f): marks failed pills, error alerts, a failed track segment, a field's error border, the danger button and error lines in the log.

Each status hue has a 12% tint (`*-soft`) for its pill or alert ground. Ember also has a 32% outline (`err-line`).

### Neutral
- **Graphite Void** (#0a0a0d, `bg`): the page, the sidebar, the log well and the fade behind the docked composer.
- **Graphite** (#121216, `bg-2`): panels, inputs, the segmented track, the bottom sheet and the auth notes.
- **Raised Graphite** (#1a1a20, `bg-3`): secondary buttons, the composer interior, the current nav row, ghost hover and probe tags.
- **Lifted Graphite** (#24242c, `bg-4`): thumbnail placeholders, the selected segment, the toast, avatars, the muted pill and recipe chain steps.
- **Bar Glass** (`bar`, Graphite Void at 84%): the top bar and tab bar, under `blur(16px) saturate(150%)`.
- **Hairline** (`line`, white at 8%) and **Control Line** (`line-2`, white at 14%): `line` divides rows and sections, and `line-2` outlines chips, inputs, secondary buttons, the switch and avatars.
- **Moon White** (#f4f3f7, `text`), **Dust** (#aba9b5, `text-2`), **Ash** (#8b8995, `text-3`): text for titles and values, body and secondary text, and meta, placeholders and inactive labels respectively. Ash holds 5.4:1 on panels.
- **Track** (`track`, white at 10%) is the empty telemetry segment. **Scrim** (`scrim`, black at 60%) sits behind the sheet with a 3px blur.

### Light theme
The `light-*` keys hold the light theme's value for each role. Pale Lilac Paper (#f2f1f5) is the page, white is panels and raised surfaces, and #eceaf0 is lifted. Ink runs #0f0e14 / #4a4855 / #64626e. Pink Readout deepens to #c0166f, and the status hues deepen to the values above. The light-catch edge becomes a dark hairline gradient, and both shadows lighten to ink at 6–40%. The magenta field and white-on-fill rules do not change between themes. Status text is deepened for small sizes on its own tint: green #0c6b44 measures 5.8:1 over a white panel and 5.2:1 over the page; amber #875700 measures 5.5:1 and 4.9:1.

### Named Rules
**The One Signal Rule.** Magenta means "act, live, or chosen". It marks the primary action, running and live work, the selected option and keyboard focus, and nothing decorative. Green, amber and ember appear only on status.

**The White-on-Fill Rule.** White text sits only on Pressed Magenta (#d41b7e, 4.93:1) or on the deep end of the magenta field. It never sits on the brand #ec2c92 (3.93:1) or the hot end #ff5fae (2.8:1).

**The One Field Rule.** The magenta gradient field appears once per screen: the greeting band on Launch, or the brand panel on sign-in. The helmet sits at its hot end and the text on its deep end. The hot spot follows the helmet to the inline end, so in Hebrew the gradient mirrors as well.

## Typography

**Display Font:** Unbounded (with Assistant, Raleway, sans-serif)
**Body Font:** Raleway (with Assistant, system-ui, sans-serif); in Hebrew, Assistant leads both roles
**Label/Mono Font:** JetBrains Mono (with ui-monospace, SFMono-Regular, Menlo) for logs, job IDs and textarea input

**Character:** Unbounded's wide, rounded geometry gives titles and readouts the look of instrument numerals. Raleway, OTW Design's own text face, keeps dense lists calm at 13–15px. Assistant, OTW's Hebrew face, carries Hebrew at heavier weights so it holds its own beside Unbounded.

### Hierarchy
- **Display** (600, 26px → 30px from 720px → 32px from 1024px, 1.15, -0.02em): page titles and the Launch greeting. The sign-in tagline is the one larger setting (34px, 60px from 960px, line height 1.05, -0.03em, at most 11ch), and sign-in card titles use the display face at 22px.
- **Readout** (600, 46px, 0.95, -0.035em, tabular): the mission percent on job detail, with its unit in 16px Ash.
- **Readout small** (600, 15px, 1, -0.02em, tabular): the percent in in-flight cards. The wordmark "OTW Studio" uses the same face at 15px and -0.01em, with "Studio" in Ash.
- **Headline** (700, 18px, 1.3, -0.005em): section heads and empty-state titles.
- **Title** (700, 14.5px, 1.35): job, row and file titles. Job titles clamp to two lines and file names truncate to one. Panel titles use 15.5px. The payload title is 19px, or 22px from 1024px.
- **Body** (500, 15px, 1.5, lining numerals; Hebrew 16px): running text in Dust. Page intros run to at most 60ch and empty-state copy to 38ch.
- **Meta** (500, 12.5–13px, Ash): job meta with dot separators, hints, row subtitles and timestamps.
- **Label** (650, 13px, 1.3, Dust): field labels, chips and segmented options. Tab-bar labels use 11.5px.
- **Button** (700, 14px, 1, +0.01em): 13px on small buttons, 12.5px on extra-small.
- **Status** (750, 10.5px, 1, +0.06em, uppercase; Hebrew 12px with no tracking): status pills and file-kind tags on thumbnails only.
- **Data** (JetBrains Mono 450, 12.5px, 1.75): job logs. Inline IDs use 0.86em of the surrounding size.

The build specifies weights 450, 650 and 750. Load Raleway, Assistant and JetBrains Mono as variable weight ranges (400–800) so these weights render. The prototype requests `wght@400..800` (Unbounded `500..700`); a discrete list such as `400;500;600;700;800` would snap 650 to 700 and 750 to 800.

### Named Rules
**The Instrument Numerals Rule.** Every measure (percent, speed, size, duration, clock) uses tabular lining numerals. Inside Hebrew it is isolated left to right, so "6.1 MB/s" and "9:56" never reorder. Titles from other sites are wrapped in `<bdi>`.

**The Display-Is-for-Readouts Rule.** Unbounded sets page titles, the wordmark and telemetry numbers only. Body, labels, buttons and list titles stay in Raleway.

**The Hebrew Weight Rule.** In Hebrew, Assistant leads. Display steps up to 800 with zero tracking, body grows to 16px, and status pills drop their uppercase tracking and grow to 12px.

## Layout

Mobile first, one column. Below 1024px the main column caps at 760px with a 16px gutter (24px from 720px). A sticky glass top bar (58px) holds the mark, the wordmark and the language and theme tools. A fixed glass tab bar (66px plus the safe-area inset) holds five equal tabs: Launch, Jobs, Tools, Library, More. More opens a bottom sheet with the remaining sections. The main column's bottom padding clears the tab bar.

On a phone, Launch stacks in this order: the magenta band (full bleed, with 28px bottom corners), the in-flight strip (cards 82% wide with a 272px minimum, horizontal scroll with snap), the looked-up payload, Recent, and finally the composer. The composer is docked sticky above the tab bar over a fade to the page colour.

- **720px:** the gutter grows to 24px, in-flight cards to 46%, the library to 3 columns and the stats grid to 4 columns; panel padding becomes 20px.
- **960px:** sign-in splits into a full-height brand panel (1.05fr) and the form (1fr).
- **1024px:** a fixed 256px sidebar at the inline start replaces the top bar and tab bar. Main widens to 1180px with 34px / 40px / 56px padding. The composer moves under the band as a static field with a hint line. The payload becomes a 300px still beside its title, with the options and Launch at full width beneath, above the fold. Job detail gains a 360px sticky aside. Tools splits into two columns, Settings gets a 220px vertical tab rail, and the library shows 4 columns. In-flight cards form a 2-column grid up to 1279px.
- **1280px:** Launch splits into the deck and a 340px sticky in-flight column, which adds the Ready panel.
- **1440px:** the library shows 5 columns.
- **Below 480px:** the Paste button in the composer collapses to its icon.

Rhythm is 2px-granular, and 4, 6, 8, 10, 12 and 16px gaps do most of the work. List rows pad 14px × 16px. Stacks use 12px (20px for large stacks). Section heads sit 30px below the content above them and 12px above their own content. Page heads take 6px above and 18px below.

### Named Rules
**The Thumb Zone Rule.** On phones the link field and Launch live in the docked composer just above the tab bar. After a lookup the bar turns into New link · summary · Launch, and the payload card's own Launch button hides. Nothing the member needs to finish a job sits only at the top of a long screen.

**The Mirror-for-Free Rule.** Every inset, margin, padding, border side and corner uses inline and block logical properties. Physical left and right appear only on content that stays LTR (logs, URL and email fields), and on backgrounds positioned explicitly that carry an `[dir="rtl"]` override. Directional icons (back, arrow, sign out) flip in RTL.

## Elevation & Depth

The system is a hybrid. Tonal layering (Graphite Void → Graphite → Raised → Lifted) carries most of the hierarchy. Raised surfaces add a 1px light-catch gradient edge, painted as a border-box gradient behind a padding-box fill, plus a soft ambient shadow. Glass is reserved for the bars and the media source tag. Magenta glow appears only under primary buttons and the brand mark.

### Shadow Vocabulary
- **Ambient low** (`box-shadow: 0 1px 2px rgb(0 0 0 / 0.4), 0 10px 24px -16px rgb(0 0 0 / 0.75)`): panels, the selected segment, the current sidebar row and the selected settings tab.
- **Ambient high** (`box-shadow: 0 2px 8px rgb(0 0 0 / 0.35), 0 26px 56px -24px rgb(0 0 0 / 0.85)`): the composer, the bottom sheet and the toast.
- **Signal glow** (`box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.22), 0 10px 22px -12px rgb(236 44 146 / 0.75)`): primary buttons only.
- **Mark glow** (`box-shadow: 0 6px 16px -8px rgb(236 44 146 / 0.8)`): the 32px brand mark.
- **Helmet drop** (`filter: drop-shadow(0 18px 24px rgb(60 0 30 / 0.5))`): the helmet over the magenta field, with a neutral black drop shadow on empty states.
- **Light-catch edge** (`linear-gradient(180deg, rgb(255 255 255 / 0.17), rgb(255 255 255 / 0.05) 42%, rgb(255 255 255 / 0.03))`): the 1px border of panels and the sheet.
- **Chrome rim** (`linear-gradient(120deg, rgb(255 255 255 / 0.6), rgb(255 255 255 / 0.1) 28%, rgb(255 255 255 / 0.42) 52%, rgb(255 255 255 / 0.07) 74%, rgb(255 255 255 / 0.32))`): the 1.5px border of the composer and dropzone.

### Named Rules
**The Light-Catch Rule.** Raised panels get a gradient edge that is brighter at the top, plus ambient low. They never get a flat grey border or a hard offset shadow.

**The Chrome Rim Rule.** Only the places where media enters, the composer and the dropzone, wear the chrome rim. When they have focus or are receiving a drop, the rim turns magenta (signal → Glow Pink → signal).

## Shapes

Controls are pills and containers are rounded rectangles. Buttons, chips, segmented controls and their options, the composer, status pills, the switch and the media source tag are full pills (999px). Panels and the dropzone have 20px corners. Inputs, sidebar rows, settings tabs, library thumbnails and the desktop payload still use 12px. Blocks inset within panels (the stats grid, the log well, sheet rows, the user card, auth notes) use 14px. Alerts and the toast use 16px. Skeletons and probe tags use 8px. Media thumbnails are 16:9 with 10px corners (7px at 56–64px wide), and the duration and kind tags on them use 6px. The Launch band takes 28px bottom corners on phones and 24px all round on desktop. The bottom sheet takes 26px top corners. Avatars, the switch knob and the live dot are circles.

Telemetry segments are 4px bars with 2px corners and 3px gaps. On job detail they grow to 6px with 3px corners and 4px gaps.

Icons sit on a 24-unit grid and are drawn in 1.75px strokes with round caps and joins, in `currentColor`. The default size is 20px. Variants are 16px small, 24px large, 22px in the tab bar and 18px inside buttons. The recurring empty-state motif is two tilted ellipses at 20% and 12% opacity, with a magenta dot orbiting the helmet.

### Named Rules
**The Press-Is-a-Pill Rule.** Buttons, chips, segments, the composer and status pills are pills. Containers and navigation rows are rounded rectangles, so a current nav row reads as a place, not a button.

## Components

### Buttons
Confident and tactile: pills that sink a pixel when pressed.
- **Shape:** full pill (999px). Minimum height is 44px with 18px inline padding. Small buttons are 36px with 14px padding, extra-small are 30px with 11px, and icon-only buttons are square at their height.
- **Primary:** Pressed Magenta with a white 700 14px label, an inset top highlight and the signal glow. Hover moves to #db2084. Each region has one primary: Launch, Sign in, or Download all.
- **Secondary:** Raised Graphite with a Control Line border, and Lifted Graphite on hover. It carries supporting actions and every error-fixing action ("Add cookies", "Add Vimeo login").
- **Ghost:** transparent with Dust text. On hover it fills Raised Graphite and switches to Moon White. It is used for icon tools (language, theme, sign out) and for Retry beside a fix.
- **Danger:** an ember tint with ember text and the ember line, used for Cancel on a job.
- **States:** pressing translates the button 1px down over 120ms. Colour transitions take 180ms on `cubic-bezier(0.16, 1, 0.3, 1)`. Disabled buttons drop to 45% opacity. While loading, the label is hidden behind an 18px spinner ring that turns every 0.7s.

### Chips and Segmented Controls
- **Chip:** a 38px pill with a Control Line outline and a Dust 650 13px label. An optional trailing size or count sits in Ash at 12px (for example "720p **312 MB**"). The selected chip takes the Selection Tint, the Selection Line border and Moon White text, and its trailing meta turns Pink Readout. Chip rows scroll edge to edge on phones and wrap on desktop.
- **Segmented:** a Graphite track with a hairline border and 3px padding, holding 34px pill options. The selected option is Lifted Graphite with ambient low. The block variant stretches its options evenly ("Deliver to").
- **Tabs:** 14px 700 Dust labels with an optional 16px icon and a count in a Raised Graphite pill. The selected tab gets Moon White and a 2px magenta underline. Arrow keys move between tabs and mirror in RTL. From 1024px, Settings tabs become a vertical rail of 12px rows, with Raised Graphite and ambient low marking the selection.

### Cards / Containers
- **Corner Style:** 20px.
- **Background:** Graphite (`bg-2`) on the page's Graphite Void.
- **Shadow Strategy:** the light-catch edge plus ambient low (see Elevation & Depth).
- **Border:** the gradient edge only. Rows inside a panel are divided by hairlines.
- **Internal Padding:** 16px (20px from 720px). Panel heads are 14px × 16px with a hairline below.
- **Payload card:** a 16:9 still with a glass source tag (black at 66% with an 8px blur, white 12px 700 label, LTR URL), then the title, facts with dot separators, quality chips, a "More options" disclosure whose chevron turns 180° in 200ms, and Launch. From 1024px the still takes 300px beside the title.
- **Alerts:** 16px corners with the status tint, a 1px line in the hue, a 20px icon in the hue, a 750 14.5px title, a 13.5px Dust body and an action cluster under the text. Error alerts use ember, warning alerts amber, and info alerts magenta.
- **Empty state:** centred, with the orbit motif around the 62px helmet, an 18px headline, body copy of at most 38ch and one secondary action.

### Inputs / Fields
- **Style:** a 650 13px label sits 7px above a 46px input. The input has a Graphite fill, a 1px Control Line border, 12px corners and 15px 500 text, with Ash placeholders. A leading 16px icon sits 14px from the start. Email and URL fields stay `dir="ltr"` in Hebrew and keep their icon side clear. The select uses a custom chevron at the inline end. The textarea is mono at 13px with 1.6 line height and a 128px minimum.
- **Hover:** the border moves to Ash.
- **Focus:** the border moves to the Selection Line, with a 3px Selection Tint halo and no outline. Every other focusable element gets a 2px OTW Magenta outline at a 2px offset.
- **Error:** the border turns ember, and a 600 13px ember line with an icon appears beneath.
- **Switch:** a 46 × 28px pill in Lifted Graphite with a Control Line. When on, it fills Pressed Magenta. The white 20px knob slides along the inline axis in 220ms.

### Navigation
- **Top bar (phone):** a 58px sticky glass bar with a hairline below. It holds the brand (the 32px mark with 9px corners and the Unbounded wordmark), the server chip and the language tool at the inline end. The theme toggle lives in the More sheet, because three tools beside the chip don't fit 390px.
- **Tab bar (phone):** a fixed glass bar of five equal columns, each a 22px icon over an 11.5px 650 label in Ash. The current tab switches to Moon White with a magenta icon and a 2px magenta cap on its top edge, inset 30% from each side.
- **Sidebar (from 1024px):** 256px wide on Graphite Void with a hairline at the inline end. Rows are 42px tall with 12px corners and 14px 650 Dust text. Hover fills Graphite. The current row takes Raised Graphite, ambient low and a magenta icon. Under the brand sits the server switch (see Server Switcher). Counts appear in Pink Readout, and separators group the sections. The footer holds the tools and a user card with 14px corners and a hairline border.
- **More sheet (phone):** a bottom dialog up to 560px wide with 26px top corners, the light-catch edge and ambient high. It has a 40 × 4px grip and 52px rows with 14px corners. It sits over the Scrim with a 3px blur, rises 40px in 340ms, and closes when the backdrop is tapped. Below the links: a light/dark row and the Sample data flag.

### Status Pills
- **Style:** a 22px pill with 8px inline padding in the Status type. Ready uses green on its tint, Failed uses ember on its tint, and Running or a count uses Pink Readout on the Selection Tint. Queued and Expired use Dust on Lifted Graphite. Live "Rec" uses white on Pressed Magenta with a 7px dot that pulses every 1.6s.

### Telemetry Track (signature)
The track is the world's progress instrument, and every job, item and upload uses it.
- **Segments:** four equal segments for queued, fetch, process and ready. Done segments fill OTW Magenta. The active segment fills to its percentage through a clip-path transition (600ms) and carries a white 55% sheen that sweeps every 1.8s while work runs. A failed segment turns ember, and pending segments show the Track colour. In RTL both the fill and the sheen run right to left.
- **Telemetry line:** below the track, the percent in bold, then the stage name, speed and time left, all in tabular numerals. In in-flight cards the percent is set in Unbounded at 15px.
- **Job detail:** a 46px readout with a stage pill above the 6px track, with a label under each segment (the current one in Moon White). Below sits a stats grid divided by 1px hairline gaps: two columns, four from 720px, and two again from 1024px, where the detail column narrows beside its aside.
- **Single-stage transfers:** an upload uses the same track with one segment.

### Composer (signature)
- **Style:** a pill bar with the chrome rim, a Raised Graphite interior and ambient high. In order it holds a link icon, the LTR URL field, Clear (shown only when the field has text), a ghost Paste button and a 44px round primary Look up button with an up arrow. On focus the rim turns magenta.
- **Phone:** docked, sticky above the tab bar over a fade. After a lookup it becomes three parts: a secondary New link (+) button, a summary (the title in 750 14.5px, then the choice, size and server in tabular numerals) and a primary Launch.
- **Desktop:** the first element under the band. It is static and adds a 12.5px Ash hint line under the bar naming what a link can be.

### Job Row (signature)
- **Grid:** a 96px 16:9 thumbnail spanning two rows; the title (clamped to two lines) with dot-separated meta; and at the inline end a pill or a download button. Progress or an error spans the row beneath. Linked rows hover with a 2.5% wash.
- **Thumbnail kinds:** video shows its still with a duration tag (black at 74%, white 11px). Audio shows a magenta bar waveform (Glow Pink → Pressed Magenta) on a deep radial (#2a1020 → #121216). Items with no still show a drawn icon on Raised Graphite. Text outputs show their first lines fading out. A live recording gets a 2px magenta inset ring and a running clock.
- **Error inside a row:** a bold ember sentence naming what happened, a plain sentence naming the fix, then an extra-small secondary fix action and a ghost Retry.

### Launch Band (signature)
- **Style:** the Magenta Field holds the greeting (Display, white) and a summary line (600, white at 90%). The helmet sits at the inline end, partly off the bottom edge, and the text keeps clear of it.
- **Phone:** full bleed under the top bar, with 28px bottom corners, a minimum height of 152px and a 152px helmet.
- **Desktop:** an inset panel with 24px corners and a 190px helmet. From 960px the sign-in brand panel uses the same field at full height, with the tagline "Links in. Files out."

### Launch Moment (motion)
When Launch is pressed, the button holds a loading state for about 450ms. A new in-flight card then docks at the head of the strip over 700ms, arriving from 14px below at 97% scale with a 6px blur and zero opacity. The count updates everywhere at once (band summary, In flight pill, sidebar badge) and a toast confirms the launch. The card then walks its track: queued, then fetch with live speed and time left, then process, then ready, when a Ready pill appears and a second toast fires. Screens enter with a 6px rise in 280ms. All motion uses `cubic-bezier(0.16, 1, 0.3, 1)`. Under `prefers-reduced-motion`, every animation and transition collapses to 0.01ms, the sheen is removed and scrolling jumps instead of gliding.

### Server Switcher and Picker
Each media server has its own database, so the member's current server is always visible and new work always names where it runs.
- **Switch:** on phones a 34px pill chip in the top bar (status dot, server name ellipsised at 150px, chevron); from 1024px a full-width row under the logo with the name in 750 13.5px and the host in 12px Ash, on Graphite with 14px corners.
- **Status dots:** 8px circles, green online, amber degraded, ember for a rejected key or an unreachable server.
- **Picker:** a radio list in the More-sheet dialog on phones; from 1024px the same dialog drops from the sidebar switch as a 340px panel with 18px corners. Rows are 58px with 14px corners: dot, name, LTR host, an optional Default pill, and a magenta check on the chosen row (which also takes the Selection Tint). A server whose key was rejected stays listed but disabled, with the reason in ember. The panel ends with "Manage servers" for admins.
- **Where it shows up:** "Runs on <server>" (a link-styled button that opens the picker) under the Launch decision; the server in the phone launch bar's summary; a 12px server icon and name as the last meta item on job rows and in-flight cards; a black-70% badge at the top inline end of Library tiles; "All servers" chip filters above Jobs and Library.

### Servers (admin settings)
- **Rows:** dot, name, LTR host, key prefix in mono (`mk_9fQ2_…`), status; a second line for the admin's note (e.g. the database). Actions sit at the inline end from 720px and under the text on phones: Make default (ghost), Replace key (secondary), Remove (ghost). A server declared in Studio's config shows locked pills (Default, Server config) and a one-line explanation instead of actions.
- **Inline, never modal:** Replace key and Remove open under their row. Remove is an amber alert stating what happens to that server's files.
- **Add a server:** Name and Address (HTTPS origin, LTR) side by side from 560px, the API key in a password field, an optional admin-only note. Test connection shows a result box (testing with a spinning icon, online on the green tint, failures on the ember tint: key rejected, can't reach, not HTTPS, private address), and Save stays disabled until a test passes and again after any edit.
- **Help:** a collapsible "How to add a server" with the `keys:create otw-studio` command in a log block.

### Toast
- **Style:** Lifted Graphite with 16px corners and ambient high, 650 14px text and a green check. It rises 10px in 250ms and stays 2.6s. On phones it sits above the composer; on desktop it sits 28px from the bottom.

## Do's and Don'ts

### Do:
- **Do** reserve OTW Magenta (#ec2c92) for the primary action, running and live work, selection and focus, and let graphite carry everything else.
- **Do** put white text only on Pressed Magenta (#d41b7e) or on the deep end of the magenta field (#b8106a and darker).
- **Do** show every job's state on the four-segment telemetry track, with percent, stage, speed and time left in tabular numerals.
- **Do** pair every error with the action that fixes it: an ember sentence that names what happened, then a secondary fix button ("Add cookies", "Add Vimeo login") and a ghost Retry.
- **Do** write layout in logical properties, flip directional icons in RTL, wrap titles from other sites in `<bdi>` and isolate measures left to right.
- **Do** keep primary touch targets at least 44px tall (inputs 46px). Dense secondary controls may drop to 36px or 30px.
- **Do** give raised panels the light-catch edge and ambient low, and give the composer and dropzone the chrome rim.
- **Do** load the type families as variable weight ranges so the 450, 650 and 750 weights render as specified.
- **Do** collapse all animation under reduced motion and remove the track sheen.

- **Do** name the server wherever work starts or is listed, and keep a rejected server visible but unusable rather than hiding it.

### Don't:
- **Don't** send an API key to the page, echo it back after saving, or offer a way to reveal it; show the prefix only.
- **Don't** use magenta as decoration, as a second large fill or as a card background; the field appears once per screen.
- **Don't** put text on the hot end of the field (#ff5fae to #ec2c92), where white drops to 2.8–3.9:1, and don't leave the field's gradient position physical so that Hebrew text lands there.
- **Don't** set body copy, labels, buttons or list titles in Unbounded.
- **Don't** introduce a second progress style (bare bars, circular rings, spinners for running jobs); single-stage transfers use a one-segment track.
- **Don't** give raised panels a flat grey border or a hard offset shadow.
- **Don't** use uppercase tracked text anywhere except status pills and file-kind tags.
- **Don't** use glyph or emoji icons; icons are drawn 1.75px line SVGs in `currentColor`.
- **Don't** hard-code a white-alpha hover or tint without a light-theme counterpart; the theme swaps tokens, not components.
