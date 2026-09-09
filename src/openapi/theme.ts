/** Dark monochrome theme for the Scalar API reference. */
export const scalarThemeCss = `
:root {
  color-scheme: dark;
  --keyzori-docs-theme: monochrome;
}

html,
body {
  min-height: 100%;
  background:
    radial-gradient(circle at 82% -10%, rgba(255, 255, 255, 0.08), transparent 30rem),
    radial-gradient(circle at 12% 12%, rgba(255, 255, 255, 0.035), transparent 24rem),
    #08080a;
}

body {
  margin: 0;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif;
  font-feature-settings: liga 1, calt 1;
  text-rendering: optimizeLegibility;
}

.light-mode,
.dark-mode {
  --scalar-color-1: #fafafa;
  --scalar-color-2: #c7c7cc;
  --scalar-color-3: #8e8e96;
  --scalar-color-accent: #f4f4f5;

  --scalar-background-1: #0a0a0c;
  --scalar-background-2: #111113;
  --scalar-background-3: #19191c;
  --scalar-background-accent: #242428;
  --scalar-border-color: rgba(255, 255, 255, 0.1);

  --scalar-button-1: #f4f4f5;
  --scalar-button-1-color: #09090b;
  --scalar-button-1-hover: #ffffff;

  --scalar-color-green: #dedee2;
  --scalar-color-red: #fafafa;
  --scalar-color-yellow: #b8b8c0;
  --scalar-color-blue: #e8e8eb;
  --scalar-color-orange: #a8a8b0;
  --scalar-color-purple: #c9c9cf;

  --scalar-scrollbar-color: rgba(255, 255, 255, 0.14);
  --scalar-scrollbar-color-active: rgba(255, 255, 255, 0.3);

  --scalar-sidebar-background-1: rgba(10, 10, 12, 0.92);
  --scalar-sidebar-color-1: #f4f4f5;
  --scalar-sidebar-color-2: #9d9da5;
  --scalar-sidebar-color-active: #ffffff;
  --scalar-sidebar-border-color: rgba(255, 255, 255, 0.09);
  --scalar-sidebar-item-hover-background: rgba(255, 255, 255, 0.055);
  --scalar-sidebar-item-hover-color: #ffffff;
  --scalar-sidebar-item-active-background: rgba(255, 255, 255, 0.09);
  --scalar-sidebar-search-background: rgba(255, 255, 255, 0.035);
  --scalar-sidebar-search-color: #d4d4d8;
  --scalar-sidebar-search-border-color: rgba(255, 255, 255, 0.1);
}

::selection {
  color: #09090b;
  background: #e4e4e7;
}

* {
  scrollbar-width: thin;
  scrollbar-color: var(--scalar-scrollbar-color) transparent;
}

.t-doc__sidebar {
  border-right: 1px solid var(--scalar-sidebar-border-color);
  background: var(--scalar-sidebar-background-1);
  backdrop-filter: blur(20px) saturate(120%);
  box-shadow: 18px 0 60px rgba(0, 0, 0, 0.18);
}

.t-doc__sidebar a,
.t-doc__sidebar button {
  transition:
    color 140ms ease,
    background-color 140ms ease,
    border-color 140ms ease;
}

.sidebar-search,
.search-button,
input,
textarea,
select {
  border-color: rgba(255, 255, 255, 0.11) !important;
  background: rgba(255, 255, 255, 0.035) !important;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.025);
}

.scalar-card,
.request-card,
.response-card,
.code-snippet {
  border-color: rgba(255, 255, 255, 0.09) !important;
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.025),
    0 18px 48px rgba(0, 0, 0, 0.16);
}

pre,
code,
.scalar-code-block {
  font-family: JetBrains Mono, SFMono-Regular, Consolas, Liberation Mono, monospace;
  font-variant-ligatures: none;
}

a {
  text-underline-offset: 0.2em;
  text-decoration-color: rgba(255, 255, 255, 0.32);
}

button {
  letter-spacing: -0.01em;
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    scroll-behavior: auto !important;
    transition-duration: 0.01ms !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
  }
}
`;
