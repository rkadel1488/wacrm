/**
 * Caps for interactive button/list prompts in the Flows engine.
 * Baileys has no native button/list message type — these prompts
 * render as numbered plain text (see lib/flows/meta-send.ts) — but
 * the caps still bound the menus to something a phone screen can
 * display sanely, so they're kept as validation limits.
 */
export const INTERACTIVE_LIMITS = {
  maxButtons: 3,
  buttonTitleMaxLength: 20,
  maxListSections: 10,
  maxListRowsTotal: 10,
  listRowTitleMaxLength: 24,
  listRowDescriptionMaxLength: 72,
  bodyMaxLength: 1024,
  footerMaxLength: 60,
  headerTextMaxLength: 60,
} as const
