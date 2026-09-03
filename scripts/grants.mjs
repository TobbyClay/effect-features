/**
 * Effect Features — helpers for reading, writing and materialising grants stored on an
 * ActiveEffect as embedded item snapshots.
 */

import { GRANTS_FLAG, GRANTED_FLAG, MODULE_ID } from "./config.mjs";

/**
 * Read the grants stored on an effect.
 * @param {ActiveEffect} effect
 * @returns {Grant[]}  A defensive copy (safe to mutate).
 */
export function getGrants(effect) {
  const grants = effect?.getFlag(MODULE_ID, GRANTS_FLAG);
  return Array.isArray(grants) ? foundry.utils.deepClone(grants) : [];
}

/**
 * Persist a grants array back onto an effect.
 * @param {ActiveEffect} effect
 * @param {Grant[]} grants
 * @returns {Promise<ActiveEffect>}
 */
export function setGrants(effect, grants) {
  return effect.setFlag(MODULE_ID, GRANTS_FLAG, grants);
}

/**
 * Does this effect carry any grants?
 * @param {ActiveEffect} effect
 * @returns {boolean}
 */
export function hasGrants(effect) {
  return getGrants(effect).length > 0;
}

/**
 * Build a self-contained grant entry from a source item.
 * @param {Item} item  A world, compendium or owned item to snapshot.
 * @returns {Grant}
 */
export function grantFromItem(item) {
  const itemData = item.toObject();
  // The snapshot is created fresh on each actor, so drop identifiers & ownership.
  delete itemData._id;
  delete itemData.ownership;
  delete itemData.folder;
  delete itemData.sort;
  // If the source was itself a granted copy, drop our bookkeeping so the new grant doesn't
  // inherit a marker pointing at someone else's effect.
  if ( itemData.flags?.[MODULE_ID] ) delete itemData.flags[MODULE_ID];
  return {
    id: foundry.utils.randomID(),
    rev: 1,
    type: itemData.type,
    name: itemData.name,
    img: itemData.img,
    sourceUuid: item.uuid ?? null,
    itemData
  };
}

/* -------------------------------------------- */
/*  Snapshot mutation                            */
/* -------------------------------------------- */

/**
 * Replace a grant's stored item data wholesale, bumping its revision so already-granted copies
 * on actors get refreshed by the next reconciliation.
 * @param {ActiveEffect} effect
 * @param {string} grantId
 * @param {object} itemData  New full item data.
 * @returns {Promise<ActiveEffect|void>}
 */
export function updateGrantSnapshot(effect, grantId, itemData) {
  const grants = getGrants(effect);
  const grant = grants.find(g => g.id === grantId);
  if ( !grant ) return;
  const data = foundry.utils.deepClone(itemData);
  delete data.ownership;
  delete data.folder;
  if ( data.flags?.[MODULE_ID] ) delete data.flags[MODULE_ID];
  grant.itemData = data;
  grant.name = data.name ?? grant.name;
  grant.img = data.img ?? grant.img;
  grant.type = data.type ?? grant.type;
  grant.rev = (grant.rev ?? 1) + 1;
  return setGrants(effect, grants);
}

/**
 * Apply a partial update to a grant's stored item data, e.g. `{"system.level": 3}`.
 * @param {ActiveEffect} effect
 * @param {string} grantId
 * @param {object} patch  Expanded or dot-notation update object.
 * @returns {Promise<ActiveEffect|void>}
 */
export function patchGrantSnapshot(effect, grantId, patch) {
  const grants = getGrants(effect);
  const grant = grants.find(g => g.id === grantId);
  if ( !grant ) return;
  const data = foundry.utils.deepClone(grant.itemData);
  // mergeObject treats "system.level" as a literal key, so expand dot-notation paths first.
  foundry.utils.mergeObject(data, foundry.utils.expandObject(patch), { performDeletions: true });
  return updateGrantSnapshot(effect, grantId, data);
}

/**
 * Compute the unique reconciliation key for a grant belonging to an effect.
 * @param {ActiveEffect} effect
 * @param {Grant|string} grant  Grant entry or its id.
 * @returns {string}
 */
export function grantKey(effect, grant) {
  const grantId = typeof grant === "string" ? grant : grant.id;
  return `${effect.uuid}::${grantId}`;
}

/**
 * Produce the embedded item creation data for a grant, tagged so it can be reconciled.
 * @param {ActiveEffect} effect
 * @param {Grant} grant
 * @returns {object}  Item creation data.
 */
export function buildGrantedItemData(effect, grant) {
  const data = foundry.utils.deepClone(grant.itemData);
  delete data._id;
  foundry.utils.setProperty(data, `flags.${MODULE_ID}.${GRANTED_FLAG}`, {
    effectUuid: effect.uuid,
    grantKey: grantKey(effect, grant),
    grantId: grant.id,
    rev: grant.rev ?? 1
  });
  // dnd5e: prevent granted items from re-broadcasting their own transfer effects into a
  // grant loop is handled at sync time by ignoring flagged items.
  return data;
}

/**
 * Read the grant marker written on a granted item, if any.
 * @param {Item} item
 * @returns {GrantMarker|undefined}
 */
export function getGrantMarker(item) {
  return item?.getFlag?.(MODULE_ID, GRANTED_FLAG);
}
