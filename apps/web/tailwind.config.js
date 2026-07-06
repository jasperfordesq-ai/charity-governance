/**
 * Tailwind config - required so HeroUI v2's theme plugin is registered and so the
 * `.dark` CLASS (toggled by the ThemeToggle + the FOUC script in app/layout.tsx)
 * drives dark mode. Loaded from globals.css via `@config "../../tailwind.config.js"`.
 *
 * Note: with an explicit config present, content scanning is no longer fully automatic,
 * so the app source globs below are required for our own utilities to be generated.
 */
const { heroui } = require('@heroui/theme');

/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    './src/**/*.{ts,tsx,mdx}',
    // Scan HeroUI's compiled components so their utility classes are generated.
    '../../node_modules/@heroui/theme/dist/**/*.{js,mjs}',
  ],
  theme: {
    extend: {},
  },
  plugins: [heroui()],
};
