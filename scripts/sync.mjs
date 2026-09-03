/**
 * Effect Features — reconciliation engine.
 *
 * A single idempotent function, {@link syncActorGrants}, brings an actor's granted items in
 * line with the grants declared by whichever of its Active Effects are currently active.
 * Every relevant hook simply calls it; the diffing decides what to create or delete, so the
 * result is the same whether an effect was toggled, an item added/removed, or the world just
 * loaded.
 */

import { LOG_PREFIX, MODULE_ID } from "./config.mjs";
import { buildGrantedItemData, getGrants, getGrantMarker } from "./grants.mjs";

/** Per-actor re-entrancy guard so overlapping hooks don't double-create. */
const syncing = new Set();

/** Actors whose state changed while a sync was already running, and so need another pass. */
const dirty = new Set();

/**
 * Resolve the actor an effect applies to (directly owned, or via a transfer effect on an
 * owned item).
 * @param {ActiveEffect} effect
 * @returns {Actor|null}
 */
export function getTargetActor(effect) {
  const parent = effect?.parent;
  if ( parent instanceof Actor ) return parent;
  if ( parent?.parent instanceof Actor ) return parent.parent; // effect on an owned item
  return null;
}

/**
 * Only one client should mutate the world. Prefer the primary active GM; if no GM is
 * connected, fall back to any GM present so a solo-GM game still works.
 * @returns {boolean}
 */
export function isResponsibleExecutor() {
  const activeGM = game.users.activeGM;
  if ( activeGM ) return activeGM.isSelf;
  return game.user.isGM;
}

/**
 * Collect every active grant that should currently exist on an actor.
 * @param {Actor} actor
 * @returns {Map<string, {effect: ActiveEffect, grant: Grant}>}  Keyed by grantKey.
 */
function collectDesiredGrants(actor) {
  const desired = new Map();
  for ( const effect of actor.allApplicableEffects() ) {
    if ( !effect.active ) continue;
    // Guard against loops: ignore effects that live on items we ourselves granted.
    if ( getGrantMarker(effect.parent) ) continue;
    for ( const grant of getGrants(effect) ) {
      if ( !grant?.itemData ) continue;
      desired.set(`${effect.uuid}::${grant.id}`, { effect, grant });
    }
  }
  return desired;
}

/**
 * Reconcile an actor's granted items with the grants declared by its active effects.
 * Safe to call repeatedly; only creates/deletes the delta.
 * @param {Actor} actor
 * @param {object} [options]
 * @param {string} [options.reason]  Diagnostic label for logging.
 * @returns {Promise<void>}
 */
export async function syncActorGrants(actor, { reason } = {}) {
  if ( !actor?.isOwner || !isResponsibleExecutor() ) return;
  const lockKey = actor.uuid;
  // A sync is already running for this actor. Don't drop this request — the world may have
  // changed again mid-flight — just mark it so the running pass repeats when it finishes.
  if ( syncing.has(lockKey) ) {
    dirty.add(lockKey);
    return;
  }
  syncing.add(lockKey);
  try {
    // Bounded, so a pathological feedback loop degrades into a warning instead of a hang.
    let passes = 0;
    do {
      dirty.delete(lockKey);
      await performSync(actor, reason);
      if ( (++passes >= 10) && dirty.has(lockKey) ) {
        console.warn(`${LOG_PREFIX} | Grant sync for ${actor.name} did not settle after ${passes} passes.`);
        break;
      }
    } while ( dirty.has(lockKey) );
  } finally {
    syncing.delete(lockKey);
    dirty.delete(lockKey);
  }
}

/**
 * A single reconciliation pass. Always call via {@link syncActorGrants}, which serialises passes.
 * @param {Actor} actor
 * @param {string} [reason]
 * @returns {Promise<void>}
 */
async function performSync(actor, reason) {
  try {
    const desired = collectDesiredGrants(actor);

    // Currently granted items, keyed by their reconciliation key.
    const current = new Map();
    for ( const item of actor.items ) {
      const marker = getGrantMarker(item);
      if ( marker?.grantKey ) current.set(marker.grantKey, item);
    }

    const toCreate = [];
    const toUpdate = [];
    for ( const [key, { effect, grant }] of desired ) {
      const existing = current.get(key);
      if ( !existing ) {
        toCreate.push(buildGrantedItemData(effect, grant));
        continue;
      }
      // The snapshot was customised since this copy was made — refresh it in place so the
      // actor keeps the same item (and its id) rather than losing and regaining it.
      const currentRev = getGrantMarker(existing)?.rev ?? 1;
      if ( currentRev !== (grant.rev ?? 1) ) {
        toUpdate.push({ _id: existing.id, ...buildGrantedItemData(effect, grant) });
      }
    }

    const toDelete = [];
    for ( const [key, item] of current ) {
      if ( !desired.has(key) ) toDelete.push(item.id);
    }

    if ( toCreate.length ) {
      await actor.createEmbeddedDocuments("Item", toCreate, {
        keepId: false,
        [MODULE_ID]: { granting: true }
      });
    }
    if ( toUpdate.length ) {
      await actor.updateEmbeddedDocuments("Item", toUpdate, {
        diff: false,
        [MODULE_ID]: { granting: true }
      });
    }
    if ( toDelete.length ) {
      await actor.deleteEmbeddedDocuments("Item", toDelete, { [MODULE_ID]: { granting: true } });
    }

    if ( (toCreate.length || toUpdate.length || toDelete.length) && CONFIG.debug?.[MODULE_ID] ) {
      console.debug(`${LOG_PREFIX} | sync ${actor.name} (${reason ?? "?"}):`,
        `+${toCreate.length} / ~${toUpdate.length} / -${toDelete.length}`);
    }
  } catch(err) {
    console.error(`${LOG_PREFIX} | Failed to sync grants for ${actor?.name}`, err);
  }
}

/* -------------------------------------------- */
/*  Hook handlers                               */
/* -------------------------------------------- */

/** Should this operation be ignored because it originated from our own reconciliation? */
function isInternal(options) {
  return options?.[MODULE_ID]?.granting === true;
}

/** @param {ActiveEffect} effect */
export function onCreateActiveEffect(effect, options) {
  if ( isInternal(options) ) return;
  const actor = getTargetActor(effect);
  if ( actor ) syncActorGrants(actor, { reason: "createActiveEffect" });
}

/** @param {ActiveEffect} effect */
export function onUpdateActiveEffect(effect, changes, options) {
  if ( isInternal(options) ) return;
  // Only re-sync when something that can change active-state or the grant list moved.
  const relevant = ("disabled" in changes) || foundry.utils.hasProperty(changes, `flags.${MODULE_ID}`)
    || foundry.utils.hasProperty(changes, "flags.-=" + MODULE_ID) || ("duration" in changes);
  if ( !relevant ) return;
  const actor = getTargetActor(effect);
  if ( actor ) syncActorGrants(actor, { reason: "updateActiveEffect" });
}

/** @param {ActiveEffect} effect */
export function onDeleteActiveEffect(effect, options) {
  if ( isInternal(options) ) return;
  const actor = getTargetActor(effect);
  if ( actor ) syncActorGrants(actor, { reason: "deleteActiveEffect" });
}

/** @param {Item} item */
export function onCreateItem(item, options) {
  if ( isInternal(options) || getGrantMarker(item) ) return; // ignore items we granted
  if ( item.actor ) syncActorGrants(item.actor, { reason: "createItem" });
}

/** @param {Item} item */
export function onUpdateItem(item, changes, options) {
  if ( isInternal(options) || getGrantMarker(item) ) return;
  if ( item.actor ) syncActorGrants(item.actor, { reason: "updateItem" });
}

/** @param {Item} item */
export function onDeleteItem(item, options) {
  if ( isInternal(options) || getGrantMarker(item) ) return;
  if ( item.actor ) syncActorGrants(item.actor, { reason: "deleteItem" });
}

/**
 * Prevent players from manually deleting an item that an effect is actively granting.
 * Returning `false` cancels the deletion.
 * @param {Item} item
 * @param {object} options
 * @returns {boolean|void}
 */
export function onPreDeleteItem(item, options) {
  if ( isInternal(options) ) return; // our own reconciliation is allowed through
  const marker = getGrantMarker(item);
  if ( !marker?.effectUuid ) return;

  // Only defend items an effect is still actively granting. A leftover copy whose effect was
  // deleted, disabled, or lost must stay deletable, or it would be stuck on the sheet forever.
  let effect = null;
  try {
    effect = fromUuidSync(marker.effectUuid);
  } catch(err) {
    return; // unresolvable origin (e.g. a compendium that isn't loaded) — allow the deletion
  }
  if ( !effect?.active ) return;

  ui.notifications?.warn(game.i18n.localize("EFFECTFEATURES.Warning.CannotDeleteGranted"));
  return false;
}

/**
 * On world load, the responsible GM reconciles every actor once to recover from any events
 * that were missed while no responsible client was connected.
 * @returns {Promise<void>}
 */
export async function reconcileAllActors() {
  if ( !isResponsibleExecutor() ) return;
  for ( const actor of game.actors ) {
    if ( actor.isOwner ) await syncActorGrants(actor, { reason: "ready" });
  }
  // Unlinked (synthetic) token actors on the current scene, which are not in game.actors.
  for ( const token of canvas?.tokens?.placeables ?? [] ) {
    const actor = token.actor;
    if ( actor?.isToken && actor.isOwner ) await syncActorGrants(actor, { reason: "ready-token" });
  }
}
