import { Styles } from '@a2ui/lit/0.8';

/**
 * Structural CSS styles from the Lit renderer, converted for global DOM use.
 * These styles define all the utility classes (layout-*, typography-*, color-*, etc.)
 * Converts :host selectors to .a2ui-surface for scoped use outside Shadow DOM.
 */
export const structuralStyles: string = Styles.structuralStyles.replace(
  /:host\s*\{/g,
  '.a2ui-surface {'
);

/**
 * Component-specific styles that replicate Lit's Shadow DOM scoped CSS.
 *
 * Each Lit component has `static styles` with :host, element selectors, and ::slotted().
 * Since React uses Light DOM, we transform these to global CSS scoped under .a2ui-surface.
 *
 * Transformation rules:
 *   :host          → .a2ui-surface .a2ui-{component}
 *   section        → .a2ui-surface .a2ui-{component} section
 *   ::slotted(*)   → .a2ui-surface .a2ui-{component} section > *
 */
export const componentSpecificStyles: string = `
/* =========================================================================
 * Card (from Lit card.ts static styles)
 * ========================================================================= */

/* :host { display: block; flex: var(--weight); min-height: 0; overflow: auto; } */
.a2ui-surface .a2ui-card {
  display: block;
  flex: var(--weight);
  min-height: 0;
  overflow: auto;
}

/* section { height: 100%; width: 100%; min-height: 0; overflow: auto; } */
/* Use > to target only Card's direct section, not nested sections (e.g., TextField's section) */
.a2ui-surface .a2ui-card > section {
  height: 100%;
  width: 100%;
  min-height: 0;
  overflow: auto;
}

/* section ::slotted(*) { height: 100%; width: 100%; } */
/* Use > section > to only target Card's slotted children, not deeply nested elements */
.a2ui-surface .a2ui-card > section > * {
  height: 100%;
  width: 100%;
}

/* =========================================================================
 * Divider (from Lit divider.ts static styles)
 * ========================================================================= */

/* :host { display: block; min-height: 0; overflow: auto; } */
.a2ui-surface .a2ui-divider {
  display: block;
  min-height: 0;
  overflow: auto;
}

/* hr { height: 1px; background: #ccc; border: none; } */
/* Use :where() for low specificity (0,0,1) so theme utility classes can override */
/* Browser default margins apply (margin-block: 0.5em, margin-inline: auto) */
:where(.a2ui-surface .a2ui-divider) hr {
  height: 1px;
  background: #ccc;
  border: none;
}

/* =========================================================================
 * Text (from Lit text.ts static styles)
 * ========================================================================= */

/* :host { display: block; flex: var(--weight); } */
.a2ui-surface .a2ui-text {
  display: block;
  flex: var(--weight);
}

/* h1, h2, h3, h4, h5 { line-height: inherit; font: inherit; } */
/* Use :where() to match Lit's low specificity (0,0,0,1 - just element) */
:where(.a2ui-surface .a2ui-text) h1,
:where(.a2ui-surface .a2ui-text) h2,
:where(.a2ui-surface .a2ui-text) h3,
:where(.a2ui-surface .a2ui-text) h4,
:where(.a2ui-surface .a2ui-text) h5 {
  line-height: inherit;
  font: inherit;
}

/* Ensure markdown paragraph margins are reset */
.a2ui-surface .a2ui-text p {
  margin: 0;
}

/* =========================================================================
 * TextField (from Lit text-field.ts static styles)
 * ========================================================================= */

/* :host { display: flex; flex: var(--weight); } */
.a2ui-surface .a2ui-textfield {
  display: flex;
  flex: var(--weight);
}

/* input { display: block; width: 100%; } */
:where(.a2ui-surface .a2ui-textfield) input {
  display: block;
  width: 100%;
}

/* label { display: block; margin-bottom: 4px; } */
:where(.a2ui-surface .a2ui-textfield) label {
  display: block;
  margin-bottom: 4px;
}

/* textarea - same styling as input for multiline text fields */
:where(.a2ui-surface .a2ui-textfield) textarea {
  display: block;
  width: 100%;
}

/* =========================================================================
 * CheckBox (from Lit checkbox.ts static styles)
 * ========================================================================= */

/* :host { display: block; flex: var(--weight); min-height: 0; overflow: auto; } */
.a2ui-surface .a2ui-checkbox {
  display: block;
  flex: var(--weight);
  min-height: 0;
  overflow: auto;
}

/* input { display: block; width: 100%; } */
:where(.a2ui-surface .a2ui-checkbox) input {
  display: block;
  width: 100%;
}

/* =========================================================================
 * Slider (from Lit slider.ts static styles)
 * ========================================================================= */

/* :host { display: block; flex: var(--weight); } */
.a2ui-surface .a2ui-slider {
  display: block;
  flex: var(--weight);
}

/* input { display: block; width: 100%; } */
:where(.a2ui-surface .a2ui-slider) input {
  display: block;
  width: 100%;
}

/* =========================================================================
 * Button (from Lit button.ts static styles)
 * ========================================================================= */

/* :host { display: block; flex: var(--weight); min-height: 0; } */
.a2ui-surface .a2ui-button {
  display: block;
  flex: var(--weight);
  min-height: 0;
}

/* =========================================================================
 * Icon (from Lit icon.ts static styles)
 * ========================================================================= */

/* :host { display: block; flex: var(--weight); min-height: 0; overflow: auto; } */
.a2ui-surface .a2ui-icon {
  display: block;
  flex: var(--weight);
  min-height: 0;
  overflow: auto;
}

/* =========================================================================
 * Tabs (from Lit tabs.ts static styles)
 * ========================================================================= */

/* :host { display: block; flex: var(--weight); } */
.a2ui-surface .a2ui-tabs {
  display: block;
  flex: var(--weight);
}

/* =========================================================================
 * Modal (from Lit modal.ts static styles)
 * ========================================================================= */

/* :host { display: block; flex: var(--weight); } */
.a2ui-surface .a2ui-modal {
  display: block;
  flex: var(--weight);
}

/* dialog { padding: 0; border: none; background: none; } */
:where(.a2ui-surface .a2ui-modal) dialog {
  padding: 0;
  border: none;
  background: none;
}

/* dialog section #controls { display: flex; justify-content: end; margin-bottom: 4px; } */
.a2ui-surface .a2ui-modal dialog section #controls {
  display: flex;
  justify-content: end;
  margin-bottom: 4px;
}

/* dialog section #controls button { padding: 0; background: none; ... } */
.a2ui-surface .a2ui-modal dialog section #controls button {
  padding: 0;
  background: none;
  width: 20px;
  height: 20px;
  cursor: pointer;
  border: none;
}

/* =========================================================================
 * Image (from Lit image.ts static styles)
 * ========================================================================= */

/* :host { display: block; flex: var(--weight); min-height: 0; overflow: auto; } */
.a2ui-surface .a2ui-image {
  display: block;
  flex: var(--weight);
  min-height: 0;
  overflow: auto;
}

/* img { display: block; width: 100%; height: 100%; object-fit: var(--object-fit, fill); } */
:where(.a2ui-surface .a2ui-image) img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: var(--object-fit, fill);
}

/* =========================================================================
 * Video (from Lit video.ts static styles)
 * ========================================================================= */

/* :host { display: block; flex: var(--weight); min-height: 0; overflow: auto; } */
.a2ui-surface .a2ui-video {
  display: block;
  flex: var(--weight);
  min-height: 0;
  overflow: auto;
}

/* video { display: block; width: 100%; } */
:where(.a2ui-surface .a2ui-video) video {
  display: block;
  width: 100%;
}

/* =========================================================================
 * AudioPlayer (from Lit audio.ts static styles)
 * ========================================================================= */

/* :host { display: block; flex: var(--weight); min-height: 0; overflow: auto; } */
.a2ui-surface .a2ui-audio {
  display: block;
  flex: var(--weight);
  min-height: 0;
  overflow: auto;
}

/* audio { display: block; width: 100%; } */
:where(.a2ui-surface .a2ui-audio) audio {
  display: block;
  width: 100%;
}

/* =========================================================================
 * Column (from Lit column.ts static styles)
 * ========================================================================= */

/* :host { display: flex; flex: var(--weight); } */
.a2ui-surface .a2ui-column {
  display: flex;
  flex: var(--weight);
}

/* section { display: flex; flex-direction: column; min-width: 100%; height: 100%; } */
.a2ui-surface .a2ui-column > section {
  display: flex;
  flex-direction: column;
  min-width: 100%;
  height: 100%;
}

/* :host([alignment="..."]) section { align-items: ...; } */
/* Use > section to only target Column's direct section, not nested sections (e.g., CheckBox's section) */
.a2ui-surface .a2ui-column[data-alignment="start"] > section { align-items: start; }
.a2ui-surface .a2ui-column[data-alignment="center"] > section { align-items: center; }
.a2ui-surface .a2ui-column[data-alignment="end"] > section { align-items: end; }
.a2ui-surface .a2ui-column[data-alignment="stretch"] > section { align-items: stretch; }

/* :host([distribution="..."]) section { justify-content: ...; } */
.a2ui-surface .a2ui-column[data-distribution="start"] > section { justify-content: start; }
.a2ui-surface .a2ui-column[data-distribution="center"] > section { justify-content: center; }
.a2ui-surface .a2ui-column[data-distribution="end"] > section { justify-content: end; }
.a2ui-surface .a2ui-column[data-distribution="spaceBetween"] > section { justify-content: space-between; }
.a2ui-surface .a2ui-column[data-distribution="spaceAround"] > section { justify-content: space-around; }
.a2ui-surface .a2ui-column[data-distribution="spaceEvenly"] > section { justify-content: space-evenly; }

/* =========================================================================
 * Row (from Lit row.ts static styles)
 * ========================================================================= */

/* :host { display: flex; flex: var(--weight); } */
.a2ui-surface .a2ui-row {
  display: flex;
  flex: var(--weight);
}

/* section { display: flex; flex-direction: row; width: 100%; min-height: 100%; } */
.a2ui-surface .a2ui-row > section {
  display: flex;
  flex-direction: row;
  width: 100%;
  min-height: 100%;
}

/* :host([alignment="..."]) section { align-items: ...; } */
/* Use > section to only target Row's direct section, not nested sections */
.a2ui-surface .a2ui-row[data-alignment="start"] > section { align-items: start; }
.a2ui-surface .a2ui-row[data-alignment="center"] > section { align-items: center; }
.a2ui-surface .a2ui-row[data-alignment="end"] > section { align-items: end; }
.a2ui-surface .a2ui-row[data-alignment="stretch"] > section { align-items: stretch; }

/* :host([distribution="..."]) section { justify-content: ...; } */
.a2ui-surface .a2ui-row[data-distribution="start"] > section { justify-content: start; }
.a2ui-surface .a2ui-row[data-distribution="center"] > section { justify-content: center; }
.a2ui-surface .a2ui-row[data-distribution="end"] > section { justify-content: end; }
.a2ui-surface .a2ui-row[data-distribution="spaceBetween"] > section { justify-content: space-between; }
.a2ui-surface .a2ui-row[data-distribution="spaceAround"] > section { justify-content: space-around; }
.a2ui-surface .a2ui-row[data-distribution="spaceEvenly"] > section { justify-content: space-evenly; }

/* =========================================================================
 * List (from Lit list.ts static styles)
 * ========================================================================= */

/* :host { display: block; flex: var(--weight); min-height: 0; overflow: auto; } */
.a2ui-surface .a2ui-list {
  display: block;
  flex: var(--weight);
  min-height: 0;
  overflow: auto;
}

/* :host([direction="vertical"]) section { display: grid; } */
.a2ui-surface .a2ui-list[data-direction="vertical"] > section {
  display: grid;
}

/* :host([direction="horizontal"]) section { display: flex; max-width: 100%; overflow-x: scroll; ... } */
.a2ui-surface .a2ui-list[data-direction="horizontal"] > section {
  display: flex;
  max-width: 100%;
  overflow-x: scroll;
  overflow-y: hidden;
  scrollbar-width: none;
}

/* :host([direction="horizontal"]) section > ::slotted(*) { flex: 1 0 fit-content; ... } */
.a2ui-surface .a2ui-list[data-direction="horizontal"] > section > * {
  flex: 1 0 fit-content;
  max-width: min(80%, 400px);
}

/* =========================================================================
 * DateTimeInput (from Lit datetime-input.ts static styles)
 * ========================================================================= */

/* :host { display: block; flex: var(--weight); min-height: 0; overflow: auto; } */
.a2ui-surface .a2ui-datetime-input {
  display: block;
  flex: var(--weight);
  min-height: 0;
  overflow: auto;
}

/* input { display: block; border-radius: 8px; padding: 8px; border: 1px solid #ccc; width: 100%; } */
/* Use :where() to match Lit's low specificity (0,0,0,1) so theme utility classes can override */
:where(.a2ui-surface .a2ui-datetime-input) input {
  display: block;
  border-radius: 8px;
  padding: 8px;
  border: 1px solid #ccc;
  width: 100%;
}

/* =========================================================================
 * Global box-sizing (matches Lit's * { box-sizing: border-box; } in components)
 * ========================================================================= */

.a2ui-surface *,
.a2ui-surface *::before,
.a2ui-surface *::after {
  box-sizing: border-box;
}
`;

/**
 * Default color palette CSS variables.
 * In the Lit renderer, these are defined on :host of the themed-a2ui-surface custom element.
 * For React (Light DOM), we scope them to .a2ui-surface so they cascade to all child components.
 * These provide the default values; surface.styles.primaryColor overrides --p-* via inline styles.
 */
export const defaultPaletteStyles: string = `
.a2ui-surface {
  --n-100: #ffffff;
  --n-99: #fcfcfc;
  --n-98: #f9f9f9;
  --n-95: #f1f1f1;
  --n-90: #e2e2e2;
  --n-80: #c6c6c6;
  --n-70: #ababab;
  --n-60: #919191;
  --n-50: #777777;
  --n-40: #5e5e5e;
  --n-35: #525252;
  --n-30: #474747;
  --n-25: #3b3b3b;
  --n-20: #303030;
  --n-15: #262626;
  --n-10: #1b1b1b;
  --n-5: #111111;
  --n-0: #000000;

  --p-100: var(--a2ui-card-bg, #ffffff);
  --p-99: #fffbff;
  --p-98: #fcf8ff;
  --p-95: #f2efff;
  --p-90: #e1e0ff;
  --p-80: #c0c1ff;
  --p-70: #a0a3ff;
  --p-60: #8487ea;
  --p-50: #6a6dcd;
  --p-40: #5154b3;
  --p-35: #4447a6;
  --p-30: #383b99;
  --p-25: #2c2e8d;
  --p-20: #202182;
  --p-15: #131178;
  --p-10: #06006c;
  --p-5: #03004d;
  --p-0: #000000;

  --s-100: #ffffff;
  --s-99: #fffbff;
  --s-98: #fcf8ff;
  --s-95: #f2efff;
  --s-90: #e2e0f9;
  --s-80: #c6c4dd;
  --s-70: #aaa9c1;
  --s-60: #8f8fa5;
  --s-50: #75758b;
  --s-40: #5d5c72;
  --s-35: #515165;
  --s-30: #454559;
  --s-25: #393a4d;
  --s-20: #2e2f42;
  --s-15: #242437;
  --s-10: #191a2c;
  --s-5: #0f0f21;
  --s-0: #000000;

  --t-100: #ffffff;
  --t-99: #fffbff;
  --t-98: #fff8f9;
  --t-95: #ffecf4;
  --t-90: #ffd8ec;
  --t-80: #e9b9d3;
  --t-70: #cc9eb8;
  --t-60: #af849d;
  --t-50: #946b83;
  --t-40: #79536a;
  --t-35: #6c475d;
  --t-30: #5f3c51;
  --t-25: #523146;
  --t-20: #46263a;
  --t-15: #3a1b2f;
  --t-10: #2e1125;
  --t-5: #22071a;
  --t-0: #000000;

  --nv-100: #ffffff;
  --nv-99: #fffbff;
  --nv-98: #fcf8ff;
  --nv-95: #f2effa;
  --nv-90: #e4e1ec;
  --nv-80: #c8c5d0;
  --nv-70: #acaab4;
  --nv-60: #918f9a;
  --nv-50: #777680;
  --nv-40: #5e5d67;
  --nv-35: #52515b;
  --nv-30: #46464f;
  --nv-25: #3b3b43;
  --nv-20: #303038;
  --nv-15: #25252d;
  --nv-10: #1b1b23;
  --nv-5: #101018;
  --nv-0: #000000;

  --e-100: #ffffff;
  --e-99: #fffbff;
  --e-98: #fff8f7;
  --e-95: #ffedea;
  --e-90: #ffdad6;
  --e-80: #ffb4ab;
  --e-70: #ff897d;
  --e-60: #ff5449;
  --e-50: #de3730;
  --e-40: #ba1a1a;
  --e-35: #a80710;
  --e-30: #93000a;
  --e-25: #7e0007;
  --e-20: #690005;
  --e-15: #540003;
  --e-10: #410002;
  --e-5: #2d0001;
  --e-0: #000000;

  --primary: #137fec;
  --text-color: #fff;
  --background-light: #f6f7f8;
  --background-dark: #101922;
  --border-color: oklch(from var(--background-light) l c h / calc(alpha * 0.15));
  --elevated-background-light: oklch(from var(--background-light) l c h / calc(alpha * 0.05));
  --bb-grid-size: 4px;
  --bb-grid-size-2: calc(var(--bb-grid-size) * 2);
  --bb-grid-size-3: calc(var(--bb-grid-size) * 3);
  --bb-grid-size-4: calc(var(--bb-grid-size) * 4);
  --bb-grid-size-5: calc(var(--bb-grid-size) * 5);
  --bb-grid-size-6: calc(var(--bb-grid-size) * 6);
  --bb-grid-size-7: calc(var(--bb-grid-size) * 7);
  --bb-grid-size-8: calc(var(--bb-grid-size) * 8);
  --bb-grid-size-9: calc(var(--bb-grid-size) * 9);
  --bb-grid-size-10: calc(var(--bb-grid-size) * 10);
  --bb-grid-size-11: calc(var(--bb-grid-size) * 11);
  --bb-grid-size-12: calc(var(--bb-grid-size) * 12);
  --bb-grid-size-13: calc(var(--bb-grid-size) * 13);
  --bb-grid-size-14: calc(var(--bb-grid-size) * 14);
  --bb-grid-size-15: calc(var(--bb-grid-size) * 15);
  --bb-grid-size-16: calc(var(--bb-grid-size) * 16);

  font-family: "Google Sans", "Helvetica Neue", Helvetica, Arial, sans-serif;
}
`;

/**
 * Injects A2UI styles into the document head.
 * Includes the default color palette, utility classes (layout-*, typography-*, color-*, etc.),
 * and component-specific overrides. Call this once at application startup.
 *
 * @example
 * ```tsx
 * import { injectStyles } from '@a2ui/react/styles';
 *
 * // In your app entry point:
 * injectStyles();
 * ```
 */
export function injectStyles(): void {
  if (typeof document === 'undefined') {
    return; // SSR safety
  }

  const styleId = 'a2ui-structural-styles';

  // Avoid duplicate injection
  if (document.getElementById(styleId)) {
    return;
  }

  const styleElement = document.createElement('style');
  styleElement.id = styleId;
  // Include default palette, structural (utility classes), and component-specific styles.
  // The default palette provides CSS variables (--p-*, --n-*, etc.) that the utility classes reference.
  // These can be overridden by surface.styles.primaryColor via inline styles on .a2ui-surface.
  styleElement.textContent = defaultPaletteStyles + '\n' + structuralStyles + '\n' + componentSpecificStyles;
  document.head.appendChild(styleElement);
}

/**
 * Removes injected A2UI styles from the document.
 * Useful for cleanup in tests or when unmounting.
 */
export function removeStyles(): void {
  if (typeof document === 'undefined') {
    return;
  }

  const styleElement = document.getElementById('a2ui-structural-styles');
  if (styleElement) {
    styleElement.remove();
  }
}
