// ---- traders add-on (trader.c): green (gold), blue and purple (paid with items of that color sold to the trader)
// merchants with items up to your level, and a Restock button in every trade window. Appended after the overlay core (tq-android-perf's
// patch.js, or the standalone build); registers itself in OVERLAY_ADDONS.
// The item list is built on the device from the game's own database: every weapon/armor/jewelry record is created
// once as a throwaway item to read its classification and level requirement; the result is cached per game build.
const TS_MSG = 128;
const T_ON = 0, T_REQKIND = 2, T_MKT = 3, T_FILLKIND = 6, T_BUSY = 7, T_MSGF = 8, T_ADDING = 9, T_SUMMON = 12, T_SUMKIND = 13,
  T_BASEID = 14, T_FRAMES = 15, T_ID0 = 16, T_PTS0 = 19, T_COST = 22, T_PCT = 23, T_CLIENT = 24, T_FILL = 5;
const KIND_CLASS = [2, 3, 4];                              // Item::GetItemClassification: 2 green, 3 blue, 4 purple
// development and joke records that no player can find (sandbox, dev/test items, costume 'z_' items, cut content)
const TRADER_SKIP = /sandbox|devcheat|devitem|\/dev\/|\/test|test_|\/out\/|\/old\/|\/z_|dummy|\/default\/|copy of|pieces_/;
const TRADER_CFG = V2_CACHE + 'tq-trader.json';
const TRADER_COST = 5;                                    // points (items of the trader's color sold) per shop item
const TRADER_TABS = { 1: 20, 2: 20, 3: 26, 4: 40 };       // items per market tab: melee, ranged/staff, armor, jewelry
const TRADER_CLASSES = {
  WeaponMelee_Sword: 1, WeaponMelee_Axe: 1, WeaponMelee_Mace: 1,
  WeaponHunting_Bow: 2, WeaponHunting_Spear: 2, WeaponMagical_Staff: 2, WeaponHunting_RangedOneHand: 2,
  ArmorProtective_Head: 3, ArmorProtective_UpperBody: 3, ArmorProtective_Forearm: 3, ArmorProtective_LowerBody: 3, WeaponArmor_Shield: 3,
  ArmorJewelry_Ring: 4, ArmorJewelry_Amulet: 4,
};
// Merchant records used for the trader's looks (one per model; the name and look come from the record).
const TRADER_LOOKS = [
  'records/creature/encounters/actors/act1trader_universal01.dbr', 'records/creature/encounters/actors/act2trader_universal01.dbr',
  'records/creature/encounters/actors/act4trader_universal01.dbr', 'records/creature/encounters/actors/act5trader_universal01.dbr',
  'records/creature/npc/merchants/greece/merchant_monstercamp_general.dbr', 'records/creature/npc/merchants/greece/merchant_tegea_general.dbr',
  'records/creature/npc/merchants/orient/merchant_greatwall_mage.dbr', 'records/xpack/creatures/npc/merchant/merchant_cityoflostsouls_mage.dbr',
  'records/xpack2/creatures/npc/merchant/merchant_glauberg_mage.dbr', 'records/xpack2/creatures/npc/merchant/merchant_hercynian_hunting.dbr',
  'records/xpack3/creatures/npc/merchant/merchant_atlantis_general.dbr', 'records/xpack3/creatures/npc/merchant/merchant_atlas_general.dbr',
  'records/xpack3/creatures/npc/merchant/merchant_tartarus.dbr',
];
const TRADER_EXTERNS = ['o_sellcost', 'o_afford', 'o_buycost', 'o_getsack', 'o_addmini', 'o_addstatic', 'o_refresh', 'o_srvrefresh',
  'o_preq', 'o_preqinv', 'o_preqeq', 'o_submoney', 'o_sale', 'm_isused', 'm_omget', 'm_getitem', 'm_itemclass', 'trader_cb'];
OVERLAY_ADDONS.push({ name: 'trader', install: traderInstall });

function traderInstall(ctx) {
  const E = V2.exp;
  const fn = (n, r, a) => new NativeFunction(E(n), r, a);
  const f = {
    riCtor: fn('_ZN4GAME15ItemReplicaInfoC2Ev', 'void', ['pointer']),
    assign: fn('_ZNSt6__ndk112basic_stringIcNS_11char_traitsIcEENS_9allocatorIcEEE6assignEPKc', 'pointer', ['pointer', 'pointer']),
    addMini: fn('_ZN4GAME12MarketClient15AddMiniMartItemENS_15Market_TypeEnumERNS_15ItemReplicaInfoE', 'void', ['pointer', 'uint', 'pointer']),
    createMini: fn('_ZN4GAME12MarketClient18CreateMiniMartItemEv', 'void', ['pointer']),
    createItem: fn('_ZN4GAME4Item10CreateItemERKNS_15ItemReplicaInfoE', 'pointer', ['pointer']),
    destroy: fn('_ZN4GAME13ObjectManager15DestroyObjectExEPNS_6ObjectEPKci', 'void', ['pointer', 'pointer', 'pointer', 'int']),
    omGet: fn('_ZN4GAME9SingletonINS_13ObjectManagerEE3GetEv', 'pointer', []),
    newId: fn('_ZN4GAME13ObjectManager14CreateObjectIDEv', 'uint', ['pointer']),
    lvlReq: fn('_ZNK4GAME4Item19GetLevelRequirementEv', 'int', ['pointer']),
    itemClass: fn('_ZNK4GAME4Item21GetItemClassificationEv', 'int', ['pointer']),
    charLevel: fn('_ZNK4GAME9Character12GetCharLevelEv', 'int', ['pointer']),
    mainPlayer: fn('_ZNK4GAME10GameEngine13GetMainPlayerEv', 'pointer', ['pointer']),
    playerName: fn('_ZNK4GAME6Player13GetPlayerNameEv', 'pointer', ['pointer']),
    spawn: fn('_ZN4GAME4Game5SpawnEPKc', 'void', ['pointer', 'pointer']),
    forceRefresh: fn('_ZN4GAME10GameEngine18ForceMarketRefreshEj', 'void', ['pointer', 'uint']),
    dbArchive: fn('_ZN4GAME6Engine18GetDatabaseArchiveEv', 'pointer', ['pointer']),
    fileName: fn('_ZNK4GAME9StringMap11GetFileNameEi', 'pointer', ['pointer', 'int']),
    // respec
    isMastery: fn('_ZNK4GAME5Skill22IsSkillTheMasterySkillEv', 'bool', ['pointer']),
    skillLevel: fn('_ZNK4GAME5Skill13GetSkillLevelEv', 'uint', ['pointer']),
    masteryId: fn('_ZNK4GAME5Skill12GetMasteryIdEv', 'uint', ['pointer']),
    objectId: fn('_ZNK4GAME6Object11GetObjectIdEv', 'uint', ['pointer']),
    skillDec: fn('_ZN4GAME5Skill19DecrementSkillLevelEv', 'bool', ['pointer']),   // base version: also takes masteries down
    addSkillPoints: fn('_ZN4GAME9Character14AddSkillPointsEj', 'void', ['pointer', 'uint']),
    baseAttr: fn('_ZNK4GAME12CharacterBio20GetBaseCharAttributeENS_17CharAttributeTypeE', 'float', ['pointer', 'int']),
    setBaseAttr: fn('_ZN4GAME9Character16SetBaseAttributeENS_17CharAttributeTypeEf', 'void', ['pointer', 'int', 'float']),
    addModPoints: fn('_ZN4GAME9Character17AddModifierPointsEj', 'void', ['pointer', 'uint']),
  };
  const skillMgrVt = E('_ZTVN4GAME12SkillManagerE').add(16);
  const gGame = E('_ZN4GAME5gGameE'), gGameEngine = E('_ZN4GAME11gGameEngineE'), gEngine = E('_ZN4GAME7gEngineE');
  const engine = () => gGameEngine.readPointer();
  const player = () => { const e = engine(); return e.isNull() ? ptr(0) : f.mainPlayer(e); };
  const hooks = [
    ['_ZNK4GAME12MarketClient19GetSellToPlayerCostEj', 'h_sellcost', 'o_sellcost'],
    ['_ZNK4GAME12MarketClient16IsItemAffordableEj', 'h_afford', 'o_afford'],
    ['_ZNK4GAME12MarketClient20GetBuyFromPlayerCostEjb', 'h_buycost', 'o_buycost'],
    ['_ZN4GAME10GameEngine22GetMarketInventorySackEjNS_15Market_TypeEnumE', 'h_getsack', 'o_getsack'],
    ['_ZN4GAME12MarketClient15AddMiniMartItemENS_15Market_TypeEnumERNS_15ItemReplicaInfoE', 'h_addmini', 'o_addmini'],
    ['_ZN4GAME12MarketClient13AddStaticItemENS_15Market_TypeEnumERNS_15ItemReplicaInfoE', 'h_addstatic', 'o_addstatic'],
    ['_ZN4GAME12MarketClient13RefreshMarketERNS_13RandomUniformE', 'h_refresh', 'o_refresh'],
    ['_ZN4GAME12MarketServer14RefreshMarketsEv', 'h_srvrefresh', 'o_srvrefresh'],
    ['_ZN4GAME12MarketClient21PlayerPurchaseRequestEji', 'h_preq', 'o_preq'],
    ['_ZN4GAME12MarketClient30PlayerPurchaseRequestInventoryEjRKNS_4Vec2ES3_', 'h_preqinv', 'o_preqinv'],
    ['_ZN4GAME12MarketClient26PlayerPurchaseRequestEquipEj21EquipmentCtrlLocation', 'h_preqeq', 'o_preqeq'],
    ['_ZN4GAME9Character13SubtractMoneyEj', 'h_submoney', 'o_submoney'],
    ['_ZN4GAME12MarketClient17PlayerSaleRequestEjb', 'h_sale', 'o_sale'],
  ];
  const targets = hooks.map(h => E(h[0]));                   // resolve everything before touching code

  // ---- CModule
  const cell = () => { const m = Memory.alloc(8); held.push(m); return m; };
  const v = { ts: Memory.alloc(4096), ui_box: cell(), ui_text: cell(), ui_text_w: cell(), ui_metrics: cell() };
  held.push(v.ts); v.ts.writeByteArray(new Uint8Array(4096));
  for (const k of ['box', 'text', 'text_w', 'metrics']) v['ui_' + k].writePointer(ctx.ui[k]);
  TRADER_EXTERNS.forEach(n => { v[n] = cell(); });
  // Interceptor.replace: a call to the target from inside its replacement reaches the original, so each 'o_' cell is
  // simply the target address.
  hooks.forEach((h, i) => v[h[2]].writePointer(targets[i]));
  v.m_isused.writePointer(E('_ZNK4GAME12MarketClient10IsUsedItemEj'));
  v.m_omget.writePointer(E('_ZN4GAME9SingletonINS_13ObjectManagerEE3GetEv'));
  v.m_getitem.writePointer(E('_ZN4GAME13ObjectManager9GetObjectINS_4ItemEEEPT_j'));
  v.m_itemclass.writePointer(E('_ZNK4GAME4Item21GetItemClassificationEv'));
  const cm = new CModule(TRADER_C, v); held.push(cm);
  if (new NativeFunction(cm.ts_size, 'int', [])() > 4096) throw Error('trader state too large');
  const ts = v.ts, t = i => ts.add(i * 4);
  const msg = s => { ts.add(TS_MSG).writeUtf8String(s.slice(0, 63)); t(T_MSGF).writeS32(t(T_FRAMES).readS32()); };

  // ---- item pool: [record, tab, level requirement] of every blue item, built on the device and cached per build
  const ri = Memory.alloc(0x100), tag = Memory.allocUtf8String('tq-trader'), strs = {};
  held.push(ri, tag);
  const cstr = s => strs[s] || (strs[s] = Memory.allocUtf8String(s));
  const replica = (rec, seed) => { f.riCtor(ri); f.assign(ri.add(8), cstr(rec)); ri.add(0x80).writeU32(seed); return ri; };
  const poolFile = V2_CACHE + 'tq-trader-items-' + ctx.buildId + '.json';
  let pool = null, queue = null, total = 0, found = [], wantSummon = null;
  try { const c = JSON.parse(File.readAllText(poolFile)); if (c.v === 2 && c.items.length) pool = c.items; } catch (e) {}
  // weapon/armor/jewelry records from the database archive (DatabaseArchive: header-entry list at +0x58, names in
  // the StringMap at +0x70; entry: name index at +0, class std::string at +8)
  function candidates() {
    const arch = f.dbArchive(gEngine.readPointer()), out = [];
    const str = p => { const b = p.readU8(); return (b & 1) ? p.add(16).readPointer().readUtf8String(p.add(8).readU64()) : p.add(1).readUtf8String(b >> 1); };
    let n = 0;
    for (let node = arch.add(0x58).readPointer(); !node.isNull() && n < 1000000; node = node.readPointer(), n++) {
      const e = node.add(0x18).readPointer(), tab = TRADER_CLASSES[str(e.add(8))];
      if (!tab) continue;
      const rec = f.fileName(arch.add(0x70), e.readS32()).readUtf8String();
      if (!TRADER_SKIP.test(rec.toLowerCase().split(String.fromCharCode(92)).join('/'))) out.push([rec, tab]);
    }
    if (n < 1000 || out.length < 100) throw Error('database archive layout not recognized (' + n + ' records, ' + out.length + ' items)');
    return out;
  }
  function measureStep(budgetMs) {
    const t0 = Date.now();
    while (queue.length && Date.now() - t0 < budgetMs) {
      const [rec, tab] = queue.pop();
      const it = f.createItem(replica(rec, 1));
      if (it.isNull()) continue;
      const cls = f.itemClass(it);
      if (cls >= 2 && cls <= 4) found.push([rec, tab, f.lvlReq(it), cls]);
      f.destroy(f.omGet(), it, tag, 1);
    }
    t(T_PCT).writeS32(Math.floor(100 * (total - queue.length) / total));
    if (queue.length) return;
    queue = null; pool = found; t(T_BUSY).writeS32(0);
    try { const fl = new File(poolFile, 'w'); fl.write(JSON.stringify({ v: 2, items: pool })); fl.close(); } catch (e) {}
    V2.status.addons.trader.items = pool.length;
    if (wantSummon !== null) { const k = wantSummon; wantSummon = null; summon(k); }
  }

  function fill(client, kind) {
    const p = player(); if (p.isNull() || !pool) return;
    const lvl = f.charLevel(p), byTab = { 1: [], 2: [], 3: [], 4: [] }, cls = KIND_CLASS[kind];
    for (const [rec, tab, req, c] of pool) if (c === cls && req <= lvl) byTab[tab].push(rec);
    t(T_ADDING).writeS32(1);
    try {
      for (const tab in byTab) {
        const c = byTab[tab];
        for (let i = 0; i < TRADER_TABS[tab] && c.length; i++) {
          const rec = c.splice(Math.floor(Math.random() * c.length), 1)[0];
          f.addMini(client, 0, replica(rec, Math.floor(Math.random() * 0x7fff)));
          f.createMini(client);
        }
      }
    } finally { t(T_ADDING).writeS32(0); }
  }
  function summon(kind) {
    const g = gGame.readPointer();
    if (g.isNull() || player().isNull()) return;
    const look = TRADER_LOOKS[Math.floor(Math.random() * TRADER_LOOKS.length)];
    // h_srvrefresh takes the first market newer than this id (the spawned merchant's starts a few frames later)
    t(T_BASEID).writeU32(f.newId(f.omGet()));
    t(T_SUMKIND).writeS32(kind);
    t(T_SUMMON).writeS32(Math.max(1, t(T_FRAMES).readS32()));
    msg('Summoning...');
    f.spawn(g, cstr(look));
  }
  // ---- respec. Character layout (checked): SkillManager embedded at +0x750 (skill list: vector at +0x1a0),
  // CharacterBio at +0xb88. Every mastery is in the skill list; a chosen one has level > 0.
  function resetSkills() {
    const p = player(), sm = p.add(0x750);
    if (!sm.readPointer().equals(skillMgrVt)) throw Error('skill manager not found');
    const skills = [];
    for (let q = sm.add(0x1a0).readPointer(), e = sm.add(0x1a8).readPointer(); q.compare(e) < 0 && skills.length < 4000; q = q.add(8)) skills.push(q.readPointer());
    const chosen = new Set(skills.filter(x => f.isMastery(x) && f.skillLevel(x) > 0).map(x => f.objectId(x)));
    let n = 0;
    for (const x of skills) if (!f.isMastery(x) && chosen.has(f.masteryId(x))) for (let k = f.skillLevel(x); k > 0 && f.skillDec(x); k--) n++;
    for (const x of skills) if (f.isMastery(x) && chosen.has(f.objectId(x))) for (let k = f.skillLevel(x); k > 0 && f.skillDec(x); k--) n++;
    if (n) f.addSkillPoints(p, n);
    msg(n ? n + ' skill points returned; choose your masteries again' : 'No skill points to return');
  }
  const ATTRS = [[1, 50, 4], [2, 50, 4], [3, 50, 4], [4, 300, 40], [5, 300, 40]];   // strength, dexterity, intelligence, health, energy: start, per point
  function resetStats() {
    const p = player(), bio = p.add(0xb88);
    if (f.baseAttr(bio, 1) < 50 || f.baseAttr(bio, 4) < 300) throw Error('attributes not found');
    let n = 0;
    for (const [type, start, per] of ATTRS) {
      const cur = f.baseAttr(bio, type), k = Math.floor((cur - start) / per + 1e-3);
      if (k > 0) { f.setBaseAttr(p, type, cur - k * per); n += k; }
    }
    if (n) f.addModPoints(p, n);
    msg(n ? n + ' attribute points returned' : 'No attribute points to return');
  }

  const cb = new NativeCallback(code => {
    try {
      if (code === 1) {
        const kind = t(T_REQKIND).readS32();
        if (pool) summon(kind);
        else { wantSummon = kind; t(T_BUSY).writeS32(2); }            // finish the item list first, faster
      } else if (code === 2) {
        const id = t(T_MKT).readU32();
        const ours = [0, 1, 2].some(k => t(T_ID0 + k).readU32() === id);
        if (id) { f.forceRefresh(engine(), id); msg(ours ? 'New stock' : 'Restocked'); }
      } else if (code === 4 || code === 5) {
        if (!player().isNull()) (code === 4 ? resetSkills : resetStats)();
      } else if (code === 3) {
        if (queue) measureStep(t(T_BUSY).readS32() === 2 ? 12 : 2);
        else if (t(T_FILL).readS32()) { t(T_FILL).writeS32(0); fill(t(T_CLIENT).readPointer(), t(T_FILLKIND).readS32()); }   // set by h_refresh
        else t(T_BUSY).writeS32(0);
      }
    } catch (e) { V2.status.addons.trader.error = String(e); msg("Error: " + String(e).slice(0, 50)); t(T_FILL).writeS32(0); t(T_BUSY).writeS32(0); queue = null; }
  }, 'void', ['int']);
  held.push(cb);
  v.trader_cb.writePointer(cb);

  hooks.forEach((h, i) => Interceptor.replace(targets[i], cm[h[1]]));

  // ---- points, per character (cache/tq-trader.json: { name: { blue, purple } })
  let cfg = {}; try { cfg = JSON.parse(File.readAllText(TRADER_CFG)); } catch (e) {}
  let who = null, saved = '';
  const pts = () => ({ blue: t(T_PTS0 + 1).readS32(), purple: t(T_PTS0 + 2).readS32() });
  const nameOf = p => { const w = f.playerName(p); let s = ''; for (let i = 0; i < 40; i++) { const c = w.add(i * 4).readU32(); if (!c) break; s += String.fromCharCode(c); } return s; };
  setInterval(() => {
    try {
      const p = player(); if (p.isNull()) return;
      const name = nameOf(p);
      if (name !== who) {
        who = name;
        let c = cfg[who] || {}; if (typeof c === 'number') c = { blue: c };      // 2.2 stored blue points only
        t(T_PTS0 + 1).writeS32(c.blue || 0); t(T_PTS0 + 2).writeS32(c.purple || 0);
        for (let k = 0; k < 3; k++) t(T_ID0 + k).writeS32(0);
        saved = JSON.stringify(pts()); return;
      }
      const now = JSON.stringify(pts());
      if (now !== saved) { saved = now; cfg[who] = pts(); const fl = new File(TRADER_CFG, 'w'); fl.write(JSON.stringify(cfg)); fl.close(); }
    } catch (e) {}
  }, 1000);

  t(T_COST).writeS32(TRADER_COST);
  if (!pool) {                                                 // build the list in the background, 2 ms per frame
    queue = candidates(); total = queue.length; found = [];
    t(T_BUSY).writeS32(1);
  }
  t(T_ON).writeS32(1);
  return { frame: cm.tr_frame, draw: cm.tr_draw, touch: cm.tr_touch, status: { items: pool ? pool.length : null, candidates: total } };
}
