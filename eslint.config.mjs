import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

// Only run the obsidianmd-specific rules (not @typescript-eslint type-check rules
// which have tsutils version conflicts)
export default defineConfig([
  {
    files: ["src/**/*.ts"],
    plugins: { obsidianmd },
    languageOptions: {
      parser: tsparser,
    },
    rules: {
      "obsidianmd/ui/sentence-case": "error",
      "obsidianmd/settings-tab/no-problematic-settings-headings": "error",
      "obsidianmd/settings-tab/no-manual-html-headings": "error",
      "obsidianmd/hardcoded-config-path": "error",
      "obsidianmd/no-static-styles-assignment": "error",
      "obsidianmd/commands/no-plugin-name-in-command-name": "error",
      "obsidianmd/regex-lookbehind": "error",
    },
  },
]);
