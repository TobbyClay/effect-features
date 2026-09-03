/**
 * Effect Features — editing a stored item snapshot with the real dnd5e item sheet.
 *
 * A grant's `itemData` is a plain object that lives in an effect's flags, not a document in the
 * database. To let the user customise it with the familiar item sheet we build a detached Item
 * document and redirect every persistence call it makes back into the effect's flags:
 *
 *   - `update()`                  → merge into the snapshot
 *   - `*EmbeddedDocuments()`      → mutate the snapshot's embedded collections (effects, etc.)
 *
 * The detached document must carry an `_id`, otherwise `DocumentSheetV2` treats the sheet as a
 * creation form and throws "Document creation from ItemSheet5e is not supported."
 */

import { LOG_PREFIX } from "./config.mjs";
import { getGrants, updateGrantSnapshot } from "./grants.mjs";

/**
 * Open the item sheet for a grant's snapshot.
 * @param {ActiveEffect} effect    Effect owning the grant.
 * @param {string} grantId         Id of the grant to edit.
 * @param {object} [options]
 * @param {boolean} [options.editable]  Whether edits should be written back.
 * @returns {ItemSheet|void}
 */
export function openGrantSnapshot(effect, grantId, { editable = true } = {}) {
  const grant = getGrants(effect).find(g => g.id === grantId);
  if ( !grant?.itemData ) return;

  const data = foundry.utils.deepClone(grant.itemData);
  // A detached document still needs an id for the sheet to run in "edit" rather than "create" mode.
  if ( !data._id ) data._id = foundry.utils.randomID();
  // The snapshot carries no ownership of its own; grant it to the current user so the sheet is
  // editable for whoever is allowed to edit the effect. Ownership is stripped again on save.
  if ( editable ) data.ownership = { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER };

  let temp;
  try {
    temp = new CONFIG.Item.documentClass(data, { parent: null });
  } catch(err) {
    console.error(`${LOG_PREFIX} | Could not build a temporary item for editing`, err);
    ui.notifications?.error(game.i18n.localize("EFFECTFEATURES.Warning.EditFailed"));
    return;
  }

  if ( editable ) redirectPersistence(temp, effect, grantId);

  temp.sheet.render(true);
  return temp.sheet;
}

/* -------------------------------------------- */

/**
 * Replace a detached document's persistence methods so they write into the effect's stored
 * snapshot instead of the database.
 * @param {Item} temp        Detached item document.
 * @param {ActiveEffect} effect
 * @param {string} grantId
 */
function redirectPersistence(temp, effect, grantId) {
  // Item sheets submit on every change, so coalesce writes: without this a single editing
  // session would burn dozens of flag updates, each bumping the revision and re-syncing actors.
  const persist = foundry.utils.debounce(
    () => updateGrantSnapshot(effect, grantId, temp.toObject()), 250
  );

  /** Re-run data preparation so the sheet redraws with fresh derived data (labels, etc.). */
  const refresh = () => {
    try {
      temp.prepareData();
    } catch(err) {
      console.warn(`${LOG_PREFIX} | Could not re-prepare snapshot data`, err);
    }
  };

  /** Resolve the schema field name backing an embedded collection ("ActiveEffect" -> "effects"). */
  const collectionKey = embeddedName => {
    const embedded = temp.constructor.metadata?.embedded ?? {};
    return embedded[embeddedName] ?? embeddedName.toLowerCase() + "s";
  };

  // Sheet submissions arrive flattened ("system.description.value"). `updateSource` handles
  // dot-notation natively — do NOT pre-expand, as that would turn array-index paths such as
  // "system.damage.parts.0.number" into an object keyed "0" instead of an array entry.
  temp.update = async function(changes = {}, options = {}) {
    this.updateSource(changes, options);
    refresh();
    persist();
    return this;
  };

  temp.createEmbeddedDocuments = async function(embeddedName, dataArray = [], operation = {}) {
    const key = collectionKey(embeddedName);
    const current = this.toObject()[key] ?? [];
    const created = dataArray.map(d => {
      const entry = foundry.utils.deepClone(d);
      if ( !entry._id ) entry._id = foundry.utils.randomID();
      return entry;
    });
    this.updateSource({ [key]: [...current, ...created] });
    refresh();
    persist();
    const collection = this.getEmbeddedCollection(embeddedName);
    return created.map(c => collection.get(c._id)).filter(Boolean);
  };

  temp.updateEmbeddedDocuments = async function(embeddedName, updates = [], operation = {}) {
    const key = collectionKey(embeddedName);
    const collection = this.getEmbeddedCollection(embeddedName);
    const ids = [];
    // Apply each change through the embedded document's own `updateSource`, which resolves
    // dot-notation (including array indices) correctly, then rebuild the parent's source array.
    for ( const change of updates ) {
      const doc = collection.get(change._id);
      if ( !doc ) continue;
      const { _id, ...rest } = change;
      doc.updateSource(rest);
      ids.push(change._id);
    }
    this.updateSource({ [key]: collection.map(d => d.toObject()) });
    refresh();
    persist();
    const refreshed = this.getEmbeddedCollection(embeddedName);
    return ids.map(id => refreshed.get(id)).filter(Boolean);
  };

  temp.deleteEmbeddedDocuments = async function(embeddedName, ids = [], operation = {}) {
    const key = collectionKey(embeddedName);
    const collection = this.getEmbeddedCollection(embeddedName);
    const deleted = ids.map(id => collection.get(id)).filter(Boolean);
    const remaining = (this.toObject()[key] ?? []).filter(e => !ids.includes(e._id));
    this.updateSource({ [key]: remaining });
    refresh();
    persist();
    return deleted;
  };

  // Flag helpers on a detached document route through update(), which we've already redirected,
  // but `deleteFlag` builds a `-=` key that mergeObject must be told to honour.
  temp.setFlag = async function(scope, key, value) {
    return this.update({ [`flags.${scope}.${key}`]: value });
  };
  temp.unsetFlag = async function(scope, key) {
    return this.update({ [`flags.${scope}.-=${key}`]: null }, { performDeletions: true });
  };
}
