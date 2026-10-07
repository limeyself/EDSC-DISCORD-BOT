/**
 * Discord role IDs for each Year 7 class section, as supplied by the server admins.
 * Role IDs are not secret (they appear in the Discord role settings URLs),
 * so they live in the repo rather than in environment variables.
 *
 * To change a role: update the ID here, then restart the bot.
 */
export const CLASS_ROLE_IDS: Record<string, string> = {
  "7A": "1446218606236012657",
  "7B": "1446218827707846757",
  "7C": "1446218846858903572",
  "7D": "1446218865804578986",
  "7E": "1446218887074025473",
  "7F": "1446218903905763369",
  "7G": "1446218926307545340",
  "7H": "1446218950559142045",
  "7I": "1446218970549063824",
  "7J": "1446218992439267348",
  "7K": "1556948707000320060",
  "7L": "1446219038945443890",
  "7M": "1446219041843843084",
  "7N": "1446219104292831382",
  "7O": "1446219126044491949",
  "7P": "1446236763474497749",
  "7Q": "1446236885205913723",
  "7R": "1446236915903758530",
};

/** Every class role ID the bot is allowed to add or remove. */
export const SECTION_ROLE_IDS: Set<string> = new Set(Object.values(CLASS_ROLE_IDS));

/** Every class name ("7A" … "7R"), for command choices and listings. */
export const CLASS_NAMES: string[] = Object.keys(CLASS_ROLE_IDS);

/**
 * Admin role: the only gate for admin commands (review approve/deny/release,
 * class-server setup, counting setup/reset). Replaces permission-bit checks —
 * anyone wearing this role can run them, anywhere the bot can see them.
 */
export const ADMIN_ROLE_ID = "1557298773951123476";
