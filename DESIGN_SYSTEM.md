# Design System

A neo-brutalist dark theme with high-contrast accents, designed for creative AI applications.

---

## Color Palette

### Backgrounds
| Token | Hex | Usage |
|-------|-----|-------|
| `--bg-dark` | `#0a0a0b` | Main background, darkest layer |
| `--bg-surface` | `#111113` | Cards, panels, content areas |
| `--bg-elevated` | `#1a1a1d` | Buttons, inputs, elevated elements |
| `--bg-hover` | `#222226` | Hover states |

### Borders
| Token | Hex | Usage |
|-------|-----|-------|
| `--border-subtle` | `#2a2a2f` | Default borders, dividers |
| `--border-strong` | `#3a3a42` | Hover borders, emphasis |

### Text
| Token | Hex | Usage |
|-------|-----|-------|
| `--text-primary` | `#fafaf9` | Headings, primary content |
| `--text-secondary` | `#a1a1a6` | Body text, descriptions |
| `--text-muted` | `#636366` | Labels, hints, disabled text |

### Accents
| Token | Hex | Usage |
|-------|-----|-------|
| `--accent-primary` | `#c8ff00` | Primary actions, active states, lime/electric green |
| `--accent-secondary` | `#00ffc8` | Secondary actions, highlights, cyan/mint |
| `--accent-warm` | `#ff6b35` | Errors, destructive actions, warnings, orange |

---

## Typography

### Font Families

```css
--font-display: 'Instrument Serif', Georgia, serif;
--font-mono: 'Space Mono', 'SF Mono', monospace;
--font-body: 'DM Sans', -apple-system, sans-serif;
```

#### Google Fonts Import
```css
@import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Instrument+Serif:ital@0;1&family=DM+Sans:wght@400;500;600&display=swap');
```

### Font Usage

| Font | Usage | Weights |
|------|-------|---------|
| **Instrument Serif** | Display headings, prompts, editorial feel | 400 regular, 400 italic |
| **Space Mono** | Labels, badges, technical info, timestamps | 400, 700 |
| **DM Sans** | Body text, UI elements, descriptions | 400, 500, 600 |

### Text Styles

```css
/* Display/Headline */
font-family: var(--font-display);
font-size: 24-32px;
font-style: italic; /* optional, for prompts */

/* Monospace Labels */
font-family: var(--font-mono);
font-size: 9-12px;
letter-spacing: 0.1-0.15em;
text-transform: uppercase;

/* Body Text */
font-family: var(--font-body);
font-size: 14-16px;
line-height: 1.5-1.8;
```

---

## Border Radius

| Token | Value | Usage |
|-------|-------|-------|
| `--radius-sm` | `4px` | Buttons, badges, small elements |
| `--radius-md` | `8px` | Cards, inputs, medium containers |
| `--radius-lg` | `12px` | Large panels, modals, images |

---

## Layout

| Token | Value | Usage |
|-------|-------|-------|
| `--sidebar-width` | `280px` | Fixed sidebar width on desktop |

---

## Component Patterns

### Buttons

```css
/* Primary Button */
background: var(--accent-primary);
color: var(--bg-dark);
border: none;
padding: 12px 24px;
font-family: var(--font-mono);
font-size: 12px;
font-weight: 700;
letter-spacing: 0.1em;
text-transform: uppercase;
border-radius: var(--radius-sm);

/* Secondary/Ghost Button */
background: var(--bg-elevated);
border: 1px solid var(--border-subtle);
color: var(--text-secondary);

/* Hover Effect */
transform: translateY(-2px);
box-shadow: 0 4px 12px rgba(200, 255, 0, 0.3);
```

### Input Fields

```css
background: var(--bg-surface);
border: 2px solid var(--border-subtle);
border-radius: var(--radius-md);
color: var(--text-primary);
font-family: var(--font-display);
font-style: italic;
padding: 20px 24px;

/* Focus State */
border-color: var(--accent-primary);
box-shadow: 0 0 0 4px rgba(200, 255, 0, 0.1);
```

### Cards

```css
background: var(--bg-surface);
border: 1px solid var(--border-subtle);
border-radius: var(--radius-lg);
overflow: hidden;

/* Hover */
transform: translateY(-4px);
```

### Badges

```css
padding: 4px 10px;
background: rgba(200, 255, 0, 0.15);
border-radius: 20px;
font-family: var(--font-mono);
font-size: 9px;
font-weight: 700;
letter-spacing: 0.1em;
color: var(--accent-primary);
```

---

## Animation

### Pulse Animation
```css
@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.5; transform: scale(0.8); }
}
```

### Spin Animation
```css
@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
```

### Blink Cursor
```css
@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}
```

### Transitions
```css
/* Standard */
transition: all 0.15s ease;

/* Smooth */
transition: all 0.2s ease;

/* Slower (for larger movements) */
transition: all 0.3s ease;
```

---

## Iconography

Uses Unicode symbols for a minimal, consistent look:

| Symbol | Usage |
|--------|-------|
| `◇` | Brand icon |
| `◈` | Empty state |
| `◐` | Loading/thinking |
| `◉` / `○` | Toggle on/off |
| `✎` | Edit |
| `✕` | Close/delete |
| `→` | Submit/next |
| `↗` | Open external |
| `↓` | Download |
| `↻` | Regenerate |
| `‹` / `›` | Navigation arrows |
| `⚠` | Warning |
| `☰` | Menu hamburger |

---

## Responsive Breakpoints

```css
/* Tablet */
@media (max-width: 900px) { }

/* Mobile */
@media (max-width: 768px) { }

/* Small phones */
@media (max-width: 380px) { }

/* Landscape phones */
@media (max-height: 500px) and (orientation: landscape) { }
```

---

## CSS Variables (Complete)

```css
:root {
  /* Backgrounds */
  --bg-dark: #0a0a0b;
  --bg-surface: #111113;
  --bg-elevated: #1a1a1d;
  --bg-hover: #222226;
  
  /* Borders */
  --border-subtle: #2a2a2f;
  --border-strong: #3a3a42;
  
  /* Text */
  --text-primary: #fafaf9;
  --text-secondary: #a1a1a6;
  --text-muted: #636366;
  
  /* Accents */
  --accent-primary: #c8ff00;
  --accent-secondary: #00ffc8;
  --accent-warm: #ff6b35;
  
  /* Typography */
  --font-display: 'Instrument Serif', Georgia, serif;
  --font-mono: 'Space Mono', 'SF Mono', monospace;
  --font-body: 'DM Sans', -apple-system, sans-serif;
  
  /* Spacing */
  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 12px;
  
  /* Layout */
  --sidebar-width: 280px;
}
```

---

## Design Philosophy

1. **Neo-brutalist aesthetic** — Bold, stark contrasts with minimal decoration
2. **Dark-first** — Designed for dark mode with careful luminance hierarchy
3. **High contrast accents** — Electric lime and cyan stand out against dark backgrounds
4. **Monospace for data** — Technical information uses monospace for clarity
5. **Serif for expression** — Display font adds editorial elegance to prompts
6. **Micro-interactions** — Subtle transforms and shadows on hover
7. **Functional minimalism** — Every element serves a purpose
