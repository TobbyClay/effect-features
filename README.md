# Effect Features

A Foundry VTT module for the **D&D 5e** system that lets an Active Effect grant **features and
spells** (or any owned item) to a character's sheet — but only while the effect is active.

Compatible with **Foundry V13** (dnd5e 5.3.x) and **Foundry V14** (dnd5e 6.0.x).

## What it does

When you open any Active Effect configuration, a new **Features** tab appears next to
*Details / Duration / Changes*. There you can:

- **Add a Feature** — browse the compendium for a feat and attach it.
- **Cast a Spell** — browse the compendium for a spell and attach it.
- **Add Item…** — attach any item type (weapon, equipment, consumable, tool, …).
- **Drag & drop** any item onto the tab to attach it.
- **Edit (pencil)** — open the real item sheet on the attached copy and customise it freely
  (name, description, activities, damage, its own effects…). You are editing *this effect's private
  copy*, never the original compendium item.
- **Spell quick options** — spell rows get inline **Method** (at-will / innate / ritual / pact /
  spell), **Preparation** (not prepared / prepared / always prepared) and **Level** selectors.

While the effect is **active** on an actor, the attached items are created on the actor's sheet.
When the effect is **disabled, expires, deleted, or its item is removed/unequipped**, the granted
items are automatically removed again.

## How it works

- Each attached item is stored as a **self-contained snapshot** in the effect's flags
  (`flags["effect-features"].grants`). Nothing depends on the source item continuing to exist.
- A single idempotent reconciliation pass (`syncActorGrants`) diffs the items an actor *should*
  have — based on its currently-active effects — against the items it *does* have, and creates or
  deletes only the difference. Every relevant hook (`create/update/deleteActiveEffect`,
  `create/update/deleteItem`, and a world-load sweep) simply calls it.
- Granted items are tagged with `flags["effect-features"].granted` so they can be recognised,
  reconciled, and protected from accidental manual deletion.
- Works for effects placed **directly on an actor** and for **transfer effects** on an owned item.

### Customising an attached item

Attached items are stored as a snapshot in the effect's flags, so the pencil button opens the item
sheet against a *detached* document whose saves are redirected back into those flags — updates,
and adding/editing/deleting the item's own embedded Active Effects, all persist to the snapshot.

Each edit bumps the grant's revision. Reconciliation notices the change and **updates any copies
already on actors in place**, so a live character picks up your customisation without the item
disappearing and reappearing.

Spell preparation uses the dnd5e 5.1+ model (`system.method` + `system.prepared`, where prepared is
`0` = not prepared, `1` = prepared, `2` = always prepared), which is identical in 5.3.x and 6.0.x.

## Notes & limitations

- Mutations are performed by the **primary active GM** (or, if no GM is connected, any GM). If no
  GM is online when a player toggles an effect, the grant syncs the next time a GM loads the world.
- Snapshots are point-in-time copies; editing the original compendium item later does not update
  existing grants (this is deliberate — it is what makes customised copies stable). Re-add the item
  to pull in a fresh version.
- Suppression edge cases (e.g. antimagic) are honoured via dnd5e's `effect.active`, re-evaluated on
  the hooks above.

## API

```js
const api = game.modules.get("effect-features").api;
api.getGrants(effect);                              // -> Grant[]
api.setGrants(effect, grants);                      // persist
api.grantFromItem(item);                            // -> Grant snapshot
api.updateGrantSnapshot(effect, grantId, itemData); // replace a snapshot (bumps rev)
api.patchGrantSnapshot(effect, grantId, patch);     // e.g. {"system.level": 3}
api.openGrantSnapshot(effect, grantId);             // open the editing sheet
api.syncActorGrants(actor);                         // force a reconciliation
```

Enable debug logging with `CONFIG.debug["effect-features"] = true`.
