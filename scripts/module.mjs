/**
 * Effect Features — entry point.
 *
 * Grants features / spells to a D&D 5e actor's sheet while an Active Effect is active.
 * Compatible with Foundry V13 (dnd5e 5.3.x) and V14 (dnd5e 6.0.x).
 */

import { LOG_PREFIX, MODULE_ID } from "./config.mjs";
import * as grants from "./grants.mjs";
import {
  onCreateActiveEffect, onCreateItem, onDeleteActiveEffect, onDeleteItem, onPreDeleteItem,
  onUpdateActiveEffect, onUpdateItem, reconcileAllActors, syncActorGrants
} from "./sync.mjs";
import { openGrantSnapshot } from "./snapshot-editor.mjs";
import { onRenderActiveEffectConfig } from "./ui.mjs";

Hooks.once("init", () => {
  console.log(`${LOG_PREFIX} | Initialising`);

  // Public API for macros / other modules.
  game.modules.get(MODULE_ID).api = {
    getGrants: grants.getGrants,
    setGrants: grants.setGrants,
    grantFromItem: grants.grantFromItem,
    updateGrantSnapshot: grants.updateGrantSnapshot,
    patchGrantSnapshot: grants.patchGrantSnapshot,
    openGrantSnapshot,
    syncActorGrants
  };
});

Hooks.once("ready", () => {
  if ( game.system.id !== "dnd5e" ) {
    console.warn(`${LOG_PREFIX} | This module targets the dnd5e system; it is inactive under "${game.system.id}".`);
    return;
  }
  reconcileAllActors();
});

// UI: inject the Features tab into the effect config.
Hooks.on("renderActiveEffectConfig", onRenderActiveEffectConfig);

// Reconciliation triggers.
Hooks.on("createActiveEffect", onCreateActiveEffect);
Hooks.on("updateActiveEffect", onUpdateActiveEffect);
Hooks.on("deleteActiveEffect", onDeleteActiveEffect);
Hooks.on("createItem", onCreateItem);
Hooks.on("updateItem", onUpdateItem);
Hooks.on("deleteItem", onDeleteItem);

// Protect granted items from manual deletion.
Hooks.on("preDeleteItem", onPreDeleteItem);
