# A2UI React Renderer - Styles Architecture

## Overview

The A2UI React renderer operates in the Light DOM (unlike the Lit renderer which uses Shadow DOM). This means all CSS must be carefully scoped and injected globally into the document. There are two distinct categories of CSS that the renderer needs:

1. **Structural styles** (utility class definitions)
2. **Color palette CSS variables** (theme-specific values)

These two categories have different scoping requirements and should be handled differently.

---

## Current State

Both structural styles and the default color palette are injected together via `injectStyles()` in `styles/index.ts` as a single `<style>` element in `<head>`. This works but conflates two separate concerns.

---

## The Two CSS Layers

### 1. Structural Styles (Framework-Level)

**What they are:** Utility class definitions that map class names to CSS properties. These come from `@a2ui/lit/0.8` via `Styles.structuralStyles` and are shared across all A2UI renderers.

**Examples:**
```css
.a2ui-surface .color-bgc-p30 {
  background-color: light-dark(var(--p-30), var(--p-70));
}
.a2ui-surface .layout-pt-2 {
  padding-top: var(--g-2);
}
```

**Key characteristic:** These classes reference CSS variables (`var(--p-30)`) but do not define them. They are the same regardless of theme.

**Correct approach:** Global CSS injection via `injectStyles()`. These are structural, never change per theme, and should be injected once at application startup. This is already handled correctly.

### 2. Color Palette CSS Variables (Theme-Level)

**What they are:** The actual color values that the structural utility classes reference. These define the visual identity of a surface.

**Examples:**
```css
--n-100: #ffffff;
--p-30: #383b99;
--primary: #137fec;
--bb-grid-size: 4px;
font-family: "Google Sans", "Helvetica Neue", Helvetica, Arial, sans-serif;
```

**Full set of palettes:**
- `--n-0` through `--n-100` (neutral colors, 18 shades)
- `--p-0` through `--p-100` (primary colors, 18 shades)
- `--s-0` through `--s-100` (secondary colors, 18 shades)
- `--t-0` through `--t-100` (tertiary colors, 18 shades)
- `--nv-0` through `--nv-100` (neutral-variant colors, 18 shades)
- `--e-0` through `--e-100` (error colors, 18 shades)
- Additional variables: `--primary`, `--text-color`, `--background-light`, `--background-dark`, `--border-color`, `--elevated-background-light`, `--bb-grid-size` (1-16), `font-family`

**Key characteristic:** These are theme-specific. Different themes should produce different palettes. Additionally, `surface.styles.primaryColor` can dynamically override the `--p-*` variables per surface.

**Current approach:** Injected globally alongside structural styles in `injectStyles()` as `defaultPaletteStyles`.

**Correct approach:** These should be part of the theme system (see below).

---

## How the Lit Renderer Handled This

In the Lit renderer, this was handled by the CopilotKit wrapper component `<themed-a2ui-surface>`:

```
ThemedA2UISurface (Lit custom element)
├── Shadow DOM <style> tag containing globalStyles (palette CSS variables)
└── <a2ui-surface> (A2UI Lit web component)
    └── Shadow DOM with structural styles + component styles
```

The palette lived in `@copilotkit/a2ui-renderer/dist/styles/global.js` and was injected into the shadow DOM's `:host` selector. This naturally scoped the palette to that specific surface instance.

The `<themed-a2ui-surface>` wrapper existed precisely because Lit components use Shadow DOM and needed the CSS variables to be available within the shadow boundary. It was an adapter between CopilotKit's React world and the A2UI Lit components.

---

## Why This Was Not Caught in Visual Parity Tests

The visual parity tests in the `add-react-renderer` project compare the React renderer directly against the Lit renderer (not against the CopilotKit wrapper). Neither test app uses `<themed-a2ui-surface>` — both use the raw A2UI components directly. This means both renderers were equally missing the palette variables in the test environment. Since the tests measure the difference between the two renderers, the diff was 0% even though both were missing colors.

---

## Recommended Architecture

### Theme Definition Should Include the Palette

Extend the theme type to include a `cssVariables` (or `palette`) property:

```typescript
interface Theme {
  // Existing: component class mappings
  components: {
    Button: string;
    Text: string;
    // ...
  };
  additionalStyles: Record<string, Record<string, string>>;

  // New: default CSS variable values for this theme
  cssVariables: Record<string, string>;
}
```

The `litTheme` (default theme) would include the full default palette:

```typescript
export const litTheme: Theme = {
  components: { /* ... */ },
  additionalStyles: { /* ... */ },
  cssVariables: {
    '--n-100': '#ffffff',
    '--n-99': '#fcfcfc',
    '--p-30': '#383b99',
    // ... all palette variables
  },
};
```

### Application of CSS Variables

The `A2UIRenderer` component should apply the theme's CSS variables as inline styles on the `.a2ui-surface` div. This is consistent with how `surface.styles.primaryColor` already generates inline `--p-*` overrides:

```tsx
// In A2UIRenderer
const theme = useTheme();

const surfaceStyles = useMemo(() => {
  const styles: Record<string, string> = {};

  // 1. Apply theme's default palette
  if (theme.cssVariables) {
    Object.assign(styles, theme.cssVariables);
  }

  // 2. Apply surface-level overrides (primaryColor generates --p-* values)
  if (surface?.styles?.primaryColor) {
    // ... existing primaryColor logic
  }

  return styles;
}, [theme, surface?.styles]);

return (
  <div className="a2ui-surface" style={surfaceStyles}>
    {/* ... */}
  </div>
);
```

### Cleanup

Once the palette is part of the theme system:
1. Remove `defaultPaletteStyles` from `styles/index.ts`
2. Remove it from `injectStyles()` — which returns to injecting only structural + component-specific styles
3. `injectStyles()` becomes purely framework-level with no theme-specific content

### Benefits

- **Multiple themes on one page:** Different `A2UIProvider` instances can use different themes with different palettes
- **React-idiomatic:** Theme flows through React context, not global CSS
- **Clean separation:** Global CSS = structural; inline styles = theme values
- **Override hierarchy is clear:** Theme defaults < surface.styles overrides < component-level overrides
- **Testable:** Visual parity tests can provide explicit palettes instead of relying on global injection

---

## Summary

| Layer | Content | Injection Method | Per-Theme? |
|-------|---------|-----------------|------------|
| Structural styles | Utility class definitions (`.color-bgc-p30`, `.layout-pt-2`) | Global `<style>` via `injectStyles()` | No |
| Component styles | Component-specific CSS (`.a2ui-surface .a2ui-button`) | Global `<style>` via `injectStyles()` | No |
| Default palette | CSS variable values (`--p-30: #383b99`) | **Should be** inline styles via theme system | Yes |
| Surface overrides | Dynamic `--p-*` from `primaryColor` | Inline styles on `.a2ui-surface` | Yes (per-surface) |
