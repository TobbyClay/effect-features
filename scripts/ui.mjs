/**
 * Effect Features — injects a "Features" tab into the Active Effect configuration sheet.
 *
 * Works against both the core `ActiveEffectConfig` (dnd5e 5.3.x / Foundry V13) and dnd5e's
 * `ActiveEffectSheet5e` (dnd5e 6.0.x / Foundry V14) because both are ApplicationV2 sheets that
 * fire the `renderActiveEffectConfig` hook and share the same tab DOM conventions.
 */

import { GRANT_TYPES, LOG_PREFIX, MODULE_ID, TAB_ID } from "./config.mjs";
import { getGrants, grantFromItem, patchGrantSnapshot, setGrants } from "./grants.mjs";
import { openGrantSnapshot } from "./snapshot-editor.mjs";

/* -------------------------------------------- */
/*  Cross-version helpers                        */
/* -------------------------------------------- */

/** Render a Handlebars template on this Foundry version. */
function renderTemplate(path, data) {
  const fn = foundry.applications?.handlebars?.renderTemplate ?? globalThis.renderTemplate;
  return fn(path, data);
}

/** Normalise the hook's html argument (HTMLElement in V13/V14, jQuery in legacy) to an element. */
function toElement(html) {
  if ( html instanceof HTMLElement ) return html;
  if ( html?.[0] instanceof HTMLElement ) return html[0];
  return null;
}

/** Extract drag/drop payload across versions. */
function getDragData(event) {
  const te = foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
  return te.getDragEventData(event);
}

/* -------------------------------------------- */
/*  Render hook                                  */
/* -------------------------------------------- */

/**
 * @param {ActiveEffectConfig} app
 * @param {HTMLElement|jQuery} html
 * @param {object} context
 */
export async function onRenderActiveEffectConfig(app, html, context) {
  const root = toElement(html);
  const effect = app.document;
  if ( !root || !effect ) return;

  // Locate the existing tab navigation and tab body so we can graft onto them.
  const anchorTab = root.querySelector(".tab[data-group][data-tab]");
  if ( !anchorTab ) return; // sheet layout we don't recognise — fail silent, never break it.
  const group = anchorTab.dataset.group;
  const tabBody = anchorTab.parentElement;
  const anchorNav = root.querySelector(`[data-group="${group}"][data-tab="${anchorTab.dataset.tab}"]`);
  const nav = anchorNav?.closest("nav") ?? root.querySelector("nav.tabs, nav.sheet-tabs");
  if ( !nav || !tabBody ) return;

  // Render the content BEFORE touching the DOM. If this hook is re-entered while awaiting (the
  // sheet submits on change, so back-to-back renders are normal), an await between the "remove
  // stale copies" step and the insert would let two passes both insert, duplicating the tab.
  const content = await renderTemplate(`modules/${MODULE_ID}/templates/features-tab.hbs`,
    prepareTabContext(effect, app));

  // The sheet may have re-rendered or closed while we awaited, orphaning these nodes.
  if ( !tabBody.isConnected ) return;

  // Everything below is synchronous, so it cannot interleave with another pass.
  root.querySelectorAll(`[data-tab="${TAB_ID}"]`).forEach(el => el.remove());

  // --- Nav item -------------------------------------------------------------
  const navItem = document.createElement("a");
  navItem.className = anchorNav?.className || "item";
  navItem.dataset.group = group;
  navItem.dataset.tab = TAB_ID;
  navItem.dataset.action = "tab"; // handled by ApplicationV2's built-in tab action…
  navItem.innerHTML = `<i class="fa-solid fa-hand-sparkles" inert></i> `
    + `<span>${game.i18n.localize("EFFECTFEATURES.TabLabel")}</span>`;
  nav.appendChild(navItem);

  // --- Tab section ----------------------------------------------------------
  const section = document.createElement("section");
  section.className = "tab effect-features-tab";
  section.dataset.group = group;
  section.dataset.tab = TAB_ID;
  section.innerHTML = content;
  tabBody.appendChild(section);

  // …but also drive it manually, so it works even if the core action name changes.
  navItem.addEventListener("click", ev => {
    ev.preventDefault();
    app.changeTab(TAB_ID, group);
  });

  // Restore active state if this tab was the one selected before the re-render.
  if ( app.tabGroups?.[group] === TAB_ID ) activateOwnTab(root, group);

  // View controls work even on locked sheets; add/delete controls are simply absent then.
  activateListeners(section, app, effect);
}

/**
 * Manually mark our tab active and everything else in the group inactive.
 * @param {HTMLElement} root
 * @param {string} group
 */
function activateOwnTab(root, group) {
  root.querySelectorAll(`[data-group="${group}"][data-tab]`).forEach(el => {
    el.classList.toggle("active", el.dataset.tab === TAB_ID);
  });
}

/* -------------------------------------------- */
/*  Context                                      */
/* -------------------------------------------- */

/**
 * Build the per-spell dropdown options straight from the snapshot's own data, so the snapshot
 * stays the single source of truth (no parallel "override" state to reconcile).
 *
 * dnd5e 5.1+ (both 5.3.x and 6.0.x) models this as `system.method` + `system.prepared`, where
 * prepared is 0 = not prepared, 1 = prepared, 2 = always prepared.
 * @param {object} itemData
 * @returns {object}
 */
function spellOptions(itemData) {
  const system = itemData?.system ?? {};
  const casting = CONFIG.DND5E?.spellcasting ?? {};

  const methods = Object.entries(casting)
    .sort(([, a], [, b]) => (a.order ?? 0) - (b.order ?? 0))
    .map(([value, cfg]) => ({
      value,
      label: game.i18n.localize(cfg.label ?? value),
      selected: system.method === value
    }));
  methods.unshift({
    value: "",
    label: game.i18n.localize("EFFECTFEATURES.Spell.MethodDefault"),
    selected: !system.method
  });

  const preparedValue = Number(system.prepared ?? 0);
  const prepared = [0, 1, 2].map(value => ({
    value,
    label: game.i18n.localize(`EFFECTFEATURES.Spell.Prepared.${value}`),
    selected: preparedValue === value
  }));

  const levelValue = Number(system.level ?? 0);
  const levels = Object.entries(CONFIG.DND5E?.spellLevels ?? {}).map(([value, label]) => ({
    value,
    label: game.i18n.localize(label),
    selected: levelValue === Number(value)
  }));

  return { methods, prepared, levels };
}

/**
 * @param {ActiveEffect} effect
 * @param {ActiveEffectConfig} app
 * @returns {object}
 */
function prepareTabContext(effect, app) {
  const grants = getGrants(effect).map(g => {
    const isSpell = g.type === "spell";
    return {
      id: g.id,
      name: g.name,
      img: g.img,
      type: g.type,
      // `localize` echoes the key back when it's missing, so check before using it.
      typeLabel: game.i18n.has(`TYPES.Item.${g.type}`)
        ? game.i18n.localize(`TYPES.Item.${g.type}`)
        : g.type,
      isSpell,
      spell: isSpell ? spellOptions(g.itemData) : null
    };
  });
  return {
    grants,
    hasGrants: grants.length > 0,
    editable: app.isEditable !== false,
    buttons: [
      { type: "feat", ...GRANT_TYPES.feat, label: game.i18n.localize(GRANT_TYPES.feat.labelKey) },
      { type: "spell", ...GRANT_TYPES.spell, label: game.i18n.localize(GRANT_TYPES.spell.labelKey) },
      { type: "any", ...GRANT_TYPES.any, label: game.i18n.localize(GRANT_TYPES.any.labelKey) }
    ]
  };
}

/* -------------------------------------------- */
/*  Listeners                                    */
/* -------------------------------------------- */

/**
 * @param {HTMLElement} section
 * @param {ActiveEffectConfig} app
 * @param {ActiveEffect} effect
 */
function activateListeners(section, app, effect) {
  // Add buttons (browse compendium filtered by type).
  section.querySelectorAll("[data-ef-add]").forEach(btn => {
    btn.addEventListener("click", ev => {
      ev.preventDefault();
      addGrantViaBrowser(effect, btn.dataset.efAdd);
    });
  });

  // Row actions.
  section.querySelectorAll("[data-ef-action]").forEach(el => {
    el.addEventListener("click", ev => {
      ev.preventDefault();
      const grantId = el.closest("[data-grant-id]")?.dataset.grantId;
      if ( !grantId ) return;
      switch ( el.dataset.efAction ) {
        case "delete": return removeGrant(effect, grantId);
        case "edit": return openGrantSnapshot(effect, grantId, { editable: true });
        case "view": return openGrantSnapshot(effect, grantId, { editable: false });
      }
    });
  });

  // Inline snapshot fields (spell method / prepared state / level). These deliberately carry no
  // `name` attribute so the effect sheet's own form never tries to submit them, and we stop the
  // change event so its submit-on-change handler stays out of the way.
  section.querySelectorAll("[data-ef-field]").forEach(input => {
    input.addEventListener("change", ev => {
      ev.stopPropagation();
      const grantId = input.closest("[data-grant-id]")?.dataset.grantId;
      if ( !grantId ) return;
      const field = input.dataset.efField;
      const raw = input.value;
      const value = input.dataset.efType === "number" ? Number(raw) : raw;
      patchGrantSnapshot(effect, grantId, { [field]: value });
    });
  });

  // Drag & drop anywhere on the tab.
  const dropzone = section.querySelector(".ef-dropzone") ?? section;
  section.addEventListener("dragover", ev => {
    ev.preventDefault();
    dropzone.classList.add("dragover");
  });
  // `dragleave` also fires when crossing between child elements, so only clear the highlight
  // once the pointer has actually left the tab.
  section.addEventListener("dragleave", ev => {
    if ( !section.contains(ev.relatedTarget) ) dropzone.classList.remove("dragover");
  });
  section.addEventListener("drop", ev => {
    ev.preventDefault();
    dropzone.classList.remove("dragover");
    onDrop(effect, ev);
  });
}

/* -------------------------------------------- */
/*  Actions                                      */
/* -------------------------------------------- */

/**
 * Browse the compendium for an item of the given type and add it as a grant.
 * @param {ActiveEffect} effect
 * @param {"feat"|"spell"|"any"} type
 */
async function addGrantViaBrowser(effect, type) {
  const CompendiumBrowser = dnd5e?.applications?.CompendiumBrowser;
  if ( !CompendiumBrowser?.selectOne ) {
    ui.notifications?.warn(game.i18n.localize("EFFECTFEATURES.Warning.NoBrowser"));
    return;
  }
  const filters = {};
  if ( type !== "any" ) filters.locked = { types: new Set([type]) };
  let uuid;
  try {
    uuid = await CompendiumBrowser.selectOne({ filters });
  } catch(err) {
    console.error(`${LOG_PREFIX} | Compendium browser failed`, err);
    return;
  }
  if ( !uuid ) return;
  const item = await fromUuid(uuid);
  if ( item ) await addGrant(effect, item);
}

/**
 * Handle an item dropped onto the tab.
 * @param {ActiveEffect} effect
 * @param {DragEvent} event
 */
async function onDrop(effect, event) {
  let data;
  try {
    data = getDragData(event);
  } catch(err) {
    return;
  }
  if ( data?.type !== "Item" ) return;
  const item = await fromUuid(data.uuid);
  if ( item ) await addGrant(effect, item);
}

/**
 * Snapshot an item and append it to the effect's grants.
 * @param {ActiveEffect} effect
 * @param {Item} item
 */
async function addGrant(effect, item) {
  if ( item.documentName !== "Item" ) {
    ui.notifications?.warn(game.i18n.localize("EFFECTFEATURES.Warning.NotAnItem"));
    return;
  }
  const grants = getGrants(effect);
  grants.push(grantFromItem(item));
  await setGrants(effect, grants);
  ui.notifications?.info(game.i18n.format("EFFECTFEATURES.Notify.Added", { name: item.name }));
}

/**
 * Remove a grant entry.
 * @param {ActiveEffect} effect
 * @param {string} grantId
 */
async function removeGrant(effect, grantId) {
  await setGrants(effect, getGrants(effect).filter(g => g.id !== grantId));
}
