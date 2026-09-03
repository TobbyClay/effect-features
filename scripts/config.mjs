/**
 * Effect Features — shared constants.
 */

/** The module id, matching module.json. */
export const MODULE_ID = "effect-features";

/**
 * Flag key (under `flags[MODULE_ID]`) on an ActiveEffect that stores the list of grants.
 * @type {string}
 */
export const GRANTS_FLAG = "grants";

/**
 * Flag key (under `flags[MODULE_ID]`) written on granted Items so we can recognise and
 * reconcile them later. Its value is a {@link GrantMarker}.
 * @type {string}
 */
export const GRANTED_FLAG = "granted";

/** DND5e item types that can be granted, mapped to the button that adds them. */
export const GRANT_TYPES = {
  feat: { icon: "fa-solid fa-star", labelKey: "EFFECTFEATURES.AddFeature" },
  spell: { icon: "fa-solid fa-wand-magic-sparkles", labelKey: "EFFECTFEATURES.CastSpell" },
  any: { icon: "fa-solid fa-suitcase", labelKey: "EFFECTFEATURES.AddItem" }
};

/** Data-tab / data-group identifier for the injected effect-config tab. */
export const TAB_ID = "effect-features";

/** Console + notification prefix. */
export const LOG_PREFIX = "Effect Features";

/**
 * @typedef {object} Grant
 * @property {string} id            Stable random id for this grant entry.
 * @property {string} type          The dnd5e item type ("feat", "spell", ...).
 * @property {string} name          Cached display name.
 * @property {string} img           Cached display image.
 * @property {string} [sourceUuid]  UUID the snapshot was taken from (informational only).
 * @property {object} itemData      Full embedded snapshot of the item to create.
 */

/**
 * @typedef {object} GrantMarker
 * @property {string} effectUuid  UUID of the effect that granted this item.
 * @property {string} grantKey    Unique `${effectUuid}::${grantId}` key.
 * @property {string} grantId     Id of the originating {@link Grant} entry.
 */
