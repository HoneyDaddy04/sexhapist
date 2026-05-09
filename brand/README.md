# Sexhapist — Brand Kit

> be bold. be honest. be happy.

The full brand system: mark, color, type, voice, and the patterns that earn trust on first read. Open `guidelines.html` in a browser for the visual brand book.

## Quick start

**The mark** (duo, primary) — drop this anywhere you need the logo:

```html
<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-label="Sexhapist">
  <path d="M45.75 36.36 A24 24 0 1 0 45.75 63.64 A18 18 0 1 1 45.75 36.36 Z" fill="#0066cc"/>
  <path d="M54.25 36.36 A24 24 0 1 1 54.25 63.64 A18 18 0 1 0 54.25 36.36 Z" fill="#b85a6e"/>
</svg>
```

**The animated mark** — for splash screens, OG images, brand moments:

```html
<img src="brand/logo/sexhapist-mark-animated.svg" alt="Sexhapist" width="120" height="120">
```

**The favicon** — one line in `<head>`:

```html
<link rel="icon" href="brand/favicon/favicon.svg" type="image/svg+xml">
```

**The design tokens** — `tokens/colors.css` is the source of truth.

## File map

```
brand/
├── README.md                          ← you are here
├── guidelines.html                    ← the brand book (open in browser)
├── logo/
│   ├── sexhapist-mark-duo.svg         ← Blue + rose · PRIMARY
│   ├── sexhapist-mark-animated.svg    ← Animated duo (drift in, breathe forever)
│   ├── sexhapist-mark.svg             ← Charcoal monochrome · for one-color contexts
│   ├── sexhapist-mark-light.svg       ← White, for dark backgrounds
│   ├── sexhapist-wordmark.svg         ← Horizontal lockup
│   └── sexhapist-wordmark-stacked.svg ← Vertical lockup
├── favicon/
│   ├── favicon.svg                    ← Browser tab (auto dark-mode)
│   ├── apple-touch-icon.svg           ← iOS home screen
│   └── site.webmanifest               ← PWA manifest
├── tokens/
│   ├── colors.css                     ← CSS custom properties
│   ├── tokens.json                    ← Design tokens (Figma/RN/email sync)
│   └── typography.css                 ← Type scale + font stacks
├── mockups/
│   ├── og-image-1200x630.svg          ← Social share card
│   ├── social-avatar-1080.svg         ← Profile avatar (square)
│   └── email-signature.html           ← Inline-styled email sig
└── voice/
    └── voice-and-tone.md              ← Do/Don't language guide
```

## The system in 60 seconds

- **Mark:** two crescents nesting toward each other, not touching. The lens of negative space between them is the brand promise — held space for honest conversation.
- **Default color:** the duo — `#0066cc` (left, listening) and `#b85a6e` (right, speaking). Charcoal `#1d1d1f` is the monochrome alternative for one-color contexts (print, embossing, paid ads).
- **The mark is alive:** the animated version drifts in from far apart, settles into held space, then on a slow rhythm comes fully together — edges touching at the centerline — before releasing back. Held, joined, held, joined. Use it for splash screens, OG cards, brand moments. The static duo is the everyday default.
- **Type:** Fraunces (display, with italic active) + Inter (body). The italic `x` in the wordmark is the recognition anchor.
- **Voice:** lead with curiosity, lowercase the heavy words, italic carries the feeling, short sentences then one longer one that breathes.
- **Tagline:** *be bold. be honest. be happy.* — three imperatives, ordered intentionally. Don't reorder. Don't add a fourth.

## Generating raster exports

SVG is the source of truth for every mark in this kit. When you need PNG/JPG (paid ads, app stores, platforms that won't accept SVG):

```bash
# Using sharp-cli (recommended)
npx sharp-cli -i brand/logo/sexhapist-mark.svg -o mark-512.png resize 512 512

# Or rsvg-convert
rsvg-convert -w 1024 -h 1024 brand/favicon/apple-touch-icon.svg -o icon-1024.png

# Or any decent SVG-to-PNG tool — Inkscape, Figma, or an online converter
```

Don't commit the rasters. They go stale. Regenerate on demand.

## Wordmark fonts

The wordmark SVGs reference Fraunces via `font-family`. Both Fraunces and Inter are open-source (SIL OFL) and load from Google Fonts. If you need a fully self-contained portable wordmark with the text outlined to paths, open the SVG in Figma or Inkscape and run "Text → Outline" / "Object to Path" before exporting.

## Risk notes

- **Ad-platform policies** — Apple App Store, Meta Ads, Google Ads will flag the name regardless of the kit's elegance. For paid contexts, use the mark-only lockup (no wordmark).
- **Trademark** — two-crescent forms exist in wellness/yoga branding. Run a USPTO + Google Image search before public launch.
- **Duo color reproduction** — the duo (`#0066cc` + `#b85a6e`) is the primary. In contexts where color reproduction is constrained or unreliable (single-color print, embossing, fax-quality reproduction, hostile ad surfaces), fall back to the charcoal monochrome variant rather than letting the duo render poorly.

## Versioning

This is **v1.0** of the Sexhapist brand kit. When the mark changes, bump the major. When tokens change without breaking the mark, bump the minor.
