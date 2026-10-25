// tq-traders 1.3 add-on: traders (green / blue / purple) and respec. Contains no game code.
const TRADER_C = `
/* Traders and respec add-on for the tq-android-perf overlay.
 *
 * Six merchants can be summoned next to the player; each sells items of one kind up to the player's level:
 *   kind 0: green (Rare) items, for gold (normal prices);
 *   kind 1: blue (Epic) items;  kind 2: purple (Legendary) items;
 *   kinds 3-5: lesser, greater and divine artifacts;  kind 6: complete relics and charms.
 * Kinds 1-6 are paid with items of the same kind sold to the trader (relics: complete ones): each one sold = 1 point
 * (and 1 gold), a shop item costs ts.t[T_COST] points, buying back costs 1; anything else is refused.
 * Magic find (bought with gold, 0.1x per step up to 2.5x, per character): every outermost loot roll (a monster's
 * weighted choice of tables, a master table or an item table; not in a market refresh) gets extra rolls (multiplier - 1 on average) and the best result is kept: the
 * item's color first (the highest classification of its base record and affixes, read from the game's own records),
 * then the number of affixes. Every trade window also gets a Restock button (ForceMarketRefresh); on a
 * summoned trader it rolls new stock. The panel also has Reset skills (all mastery and skill points back, masteries
 * can be chosen again) and Reset attributes (attribute points back), each confirmed by a second tap.
 *
 * The h_* functions replace MarketClient / Character functions (Interceptor.replace in trader-glue.js; o_* hold the
 * targets, which reach the originals when called from inside a replacement). Rare work (summon, filling the stock,
 * building the item list, saving points) runs in JS via trader_cb, called from tr_frame on the game thread.
 * All mutable state is in 'ts' (JS-allocated; CModule globals are read-only in this Frida build).
 */
#include <glib.h>

extern void (*ui_box) (float, float, float, float, guint32);
extern void (*ui_text) (float, float, const char *, float, guint32);
extern float (*ui_text_w) (const char *, float);
extern void (*ui_metrics) (float *);

extern guint32 (*o_sellcost) (void *, guint32);
extern guint8 (*o_afford) (void *, guint32);
extern guint32 (*o_buycost) (void *, guint32, guint8);
extern void * (*o_getsack) (void *, guint32, guint32);
extern void (*o_addmini) (void *, guint32, void *);
extern void (*o_addstatic) (void *, guint32, void *);
extern void (*o_refresh) (void *, void *);
extern void (*o_srvrefresh) (void *);
extern guint8 (*o_preq) (void *, guint32, gint32);
extern guint8 (*o_preqinv) (void *, guint32, void *, void *);
extern guint8 (*o_preqeq) (void *, guint32, guint32);
extern void (*o_submoney) (void *, guint32);
extern guint8 (*o_sale) (void *, guint32, guint8);
extern guint8 (*m_isused) (void *, guint32);
extern void * (*m_omget) (void);
extern void * (*m_getitem) (void *, guint32);
extern gint32 (*m_itemclass) (void *);
extern void * (*m_artifact) (void *);   /* DynamicCast<ItemArtifact, Item> */
extern void * (*m_relic) (void *);      /* DynamicCast<ItemRelic, Item> (charms too) */
extern guint8 (*m_relicdone) (void *);  /* ItemRelic::IsComplete */
extern void (*o_lootdyn) (void *, void *, void *, void *, void *, void *);
extern void (*o_lootfix) (void *, void *, void *, void *, void *, void *);
extern void (*o_lootmaster) (void *, void *, void *, void *, void *, void *);
extern void (*o_lootloader) (void *, void *, void *, void *, void *, void *);   /* 5 args; the 6th is ignored */
extern void * (*m_loadtable) (void *, void *);   /* ObjectManager::LoadTableFile(std::string const&) -> LoadTable* */
extern guint32 * mf_keys;               /* 16384-slot cache: record name hash -> mf_rank (color + 1; 0 = unknown) */
extern guint8 * mf_rank;
extern void (*trader_cb) (gint32);

/* t[] slots, mirrored in trader-glue.js */
#define NKIND 7
enum { T_ON, T_REQ, T_REQKIND, T_MKT, T_MKTF, T_FILL, T_FILLKIND, T_BUSY, T_MSGF, T_ADDING, T_BUYING, T_BUYKIND,
       T_SUMMON, T_SUMKIND, T_BASEID, T_FRAMES, T_COST, T_PCT, T_CONFIRM, T_CONFF, T_CLIENT /* 20-21: pointer */,
       T_ID0 = 22 /* 22..28 by kind */, T_PTS0 = 29 /* 29..35 by kind */, T_ARTOFF = 36 /* ItemArtifact tier field */,
       T_INMARKET = 37, T_MFSTEP = 38 /* 0..15: multiplier 1.0 + 0.1 * step */, T_MFBUSY = 39, T_RNG = 40,
       T_MFROLLS = 41, T_MFWINS = 42, T_MFDEPTH = 43, T_H0 = 44 /* 44..48: rank of the first roll */, T_H1 = 49 /* 49..53: kept roll */ };
enum { REQ_SUMMON = 1, REQ_RESTOCK = 2, REQ_TICK = 3, REQ_RESET_SKILLS = 4, REQ_RESET_STATS = 5, REQ_BUY_MF = 6 };
typedef struct {
  gint32 t[64];        /* 0 */
  char msg[64];        /* 256: status line written by JS */
  float ax, ay, aw;    /* 320: where the panel section was drawn last */
  gint32 pad;
  guint8 tmp[3][24];   /* 336: std::string name, prefix, suffix for magic-find extra rolls */
} TS;
extern TS ts;
gint32 ts_size (void) { return (gint32) sizeof (TS); }

/* ---------- market hooks ---------- */
static gint32 kind_of (void * c)   /* -1: not a summoned trader */
{
  guint32 id; gint32 k;
  if (!ts.t[T_ON]) return -1;
  id = *(guint32 *) ((guint8 *) c + 0x10);
  for (k = 0; k < NKIND; k++) if (ts.t[T_ID0 + k] != 0 && (guint32) ts.t[T_ID0 + k] == id) return k;
  return -1;
}
/* the kind an item counts for: 1 blue, 2 purple, 3-5 artifact tiers; -1 otherwise (green items are never paid with) */
static gint32 item_kind (guint32 id)
{
  void * it = m_getitem (m_omget (), id), * art;
  gint32 c;
  if (it == NULL) return -1;
  art = m_artifact (it);
  if (art != NULL) { gint32 tier = *(gint32 *) ((guint8 *) art + ts.t[T_ARTOFF]); return tier >= 0 && tier <= 2 ? 3 + tier : -1; }
  art = m_relic (it);
  if (art != NULL) return m_relicdone (art) ? 6 : -1;
  c = m_itemclass (it);
  return c == 3 ? 1 : c == 4 ? 2 : -1;
}
static gint32 need_for (void * c, guint32 id) { return m_isused (c, id) ? 1 : ts.t[T_COST]; }
static gint32 market_open (void) { return ts.t[T_ON] && ts.t[T_MKT] != 0 && ts.t[T_FRAMES] - ts.t[T_MKTF] <= 3; }
static gint32 open_kind (void) { gint32 k; for (k = 0; k < NKIND; k++) if (ts.t[T_ID0 + k] != 0 && ts.t[T_ID0 + k] == ts.t[T_MKT]) return k; return -1; }
static void msg (const char * s) { gint32 i; for (i = 0; i < 63 && s[i]; i++) ts.msg[i] = s[i]; ts.msg[i] = 0; ts.t[T_MSGF] = ts.t[T_FRAMES]; }

/* paid with points: items of the trader's kind and buy-backs (it only takes its own kind); anything else (potions
   the market adds) keeps its gold price */
static gint32 by_points (void * c, guint32 id, gint32 k) { return k >= 1 && (m_isused (c, id) || item_kind (id) == k); }
guint32 h_sellcost (void * c, guint32 id) { gint32 k = kind_of (c); return by_points (c, id, k) ? (guint32) need_for (c, id) : o_sellcost (c, id); }
guint8 h_afford (void * c, guint32 id) { gint32 k = kind_of (c); return by_points (c, id, k) ? ts.t[T_PTS0 + k] >= need_for (c, id) : o_afford (c, id); }
guint32 h_buycost (void * c, guint32 id, guint8 all)   /* 0 = the merchant refuses the item */
{
  gint32 k = kind_of (c);
  if (k >= 1) return item_kind (id) == k ? 1 : 0;
  return o_buycost (c, id, all);
}
void * h_getsack (void * e, guint32 id, guint32 type) { ts.t[T_MKT] = (gint32) id; ts.t[T_MKTF] = ts.t[T_FRAMES]; return o_getsack (e, id, type); }
void h_addmini (void * c, guint32 type, void * r) { if (kind_of (c) >= 0 && !ts.t[T_ADDING]) return; o_addmini (c, type, r); }
void h_addstatic (void * c, guint32 type, void * r) { if (kind_of (c) >= 0 && !ts.t[T_ADDING]) return; o_addstatic (c, type, r); }
void h_refresh (void * c, void * rng)
{
  gint32 k = kind_of (c);
  if (k >= 0) { *(void **) &ts.t[T_CLIENT] = c; ts.t[T_FILLKIND] = k; ts.t[T_FILL] = 1; }
  ts.t[T_INMARKET]++;   /* merchants' stock comes from the same loot tables: no magic find there */
  o_refresh (c, rng);
  ts.t[T_INMARKET]--;
}

/* ---------- magic find ---------- */
static const char * str_data (const guint8 * s, guint32 * len)   /* libc++ std::string */
{
  if (s[0] & 1) { *len = (guint32) *(const guint64 *) (s + 8); return *(const char * const *) (s + 16); }
  *len = s[0] >> 1; return (const char *) s + 1;
}
static void str_clear (guint8 * s) { if (s[0] & 1) { *(guint64 *) (s + 8) = 0; (*(char **) (s + 16))[0] = 0; } else { s[0] = 0; s[1] = 0; } }
/* color of a record: 0 common/broken, 1 magical (yellow), 2 rare (green), 3 epic (blue), 4 legendary (purple) */
static gint32 record_color (const guint8 * str)
{
  guint32 n, h = 2166136261u, i, slot, free_slot = 0xffffffffu; const char * d = str_data (str, &n); gint32 r = 0;
  void * tbl; const char * c;
  if (n == 0) return -1;
  for (i = 0; i < n; i++) { guint8 ch = (guint8) d[i]; if (ch >= 'A' && ch <= 'Z') ch += 32; if (ch == 92) ch = '/'; h = (h ^ ch) * 16777619u; }
  if (h == 0) h = 1;
  for (slot = h & 16383, i = 0; i < 64; i++, slot = (slot + 1) & 16383) {
    if (mf_keys[slot] == h) return mf_rank[slot] - 1;
    if (mf_keys[slot] == 0) { free_slot = slot; break; }
  }
  tbl = m_loadtable (m_omget (), (void *) str);   /* the game's record cache */
  if (tbl != NULL) {
    typedef const char * (*GetStr) (void *, const char *, const char *);
    c = ((GetStr) (*(void ***) tbl)[0x30 / 8]) (tbl, "itemClassification", "");
    if (c != NULL) r = c[0] == 'L' ? 4 : c[0] == 'E' ? 3 : c[0] == 'R' ? 2 : c[0] == 'M' ? 1 : 0;
  }
  if (free_slot != 0xffffffffu) { mf_rank[free_slot] = (guint8) (r + 1); mf_keys[free_slot] = h; }
  return r;
}
static gint32 loot_score (const guint8 * name, const guint8 * prefix, const guint8 * suffix)
{
  guint32 n; gint32 color = record_color (name), aff = 0, c;
  if (color < 0) return -1;
  str_data (prefix, &n); if (n) { aff++; c = record_color (prefix); if (c > color) color = c; }
  str_data (suffix, &n); if (n) { aff++; c = record_color (suffix); if (c > color) color = c; }
  return color * 10 + aff;
}
static guint32 mf_rand (void)
{
  guint32 x = (guint32) ts.t[T_RNG] + (guint32) ts.t[T_FRAMES] * 2654435761u + 1u;
  x ^= x << 13; x ^= x >> 17; x ^= x << 5; ts.t[T_RNG] = (gint32) x; return x;
}
typedef void (*LootFn) (void *, void *, void *, void *, void *, void *);
static void loot_mf (LootFn orig, void * self, guint8 * name, guint8 * pre, guint8 * suf, void * rng, void * n)
{
  gint32 steps = ts.t[T_MFSTEP], extra, best, k, i, j, r0;
  if (!ts.t[T_ON] || ts.t[T_INMARKET] || ts.t[T_MFDEPTH] || mf_keys == NULL) { orig (self, name, pre, suf, rng, n); return; }
  ts.t[T_MFDEPTH]++;   /* tables nested in this roll are part of it */
  orig (self, name, pre, suf, rng, n);
  best = loot_score (name, pre, suf);
  r0 = best < 0 ? 0 : best / 10; if (r0 > 4) r0 = 4;
  ts.t[T_H0 + r0]++;   /* what this roll would have been without magic find */
  extra = steps <= 0 ? 0 : steps / 10 + ((gint32) (mf_rand () % 10) < steps % 10 ? 1 : 0);   /* multiplier - 1 on average */
  for (k = 0; k < extra; k++) {
    gint32 sc;
    for (i = 0; i < 3; i++) str_clear (ts.tmp[i]);
    orig (self, ts.tmp[0], ts.tmp[1], ts.tmp[2], rng, n);
    ts.t[T_MFROLLS]++;
    sc = loot_score (ts.tmp[0], ts.tmp[1], ts.tmp[2]);
    if (sc > best) {   /* swap the std::string objects bitwise (libc++ strings can be moved that way) */
      guint8 * out[3]; out[0] = name; out[1] = pre; out[2] = suf;
      for (i = 0; i < 3; i++) for (j = 0; j < 24; j++) { guint8 t = out[i][j]; out[i][j] = ts.tmp[i][j]; ts.tmp[i][j] = t; }
      best = sc; ts.t[T_MFWINS]++;
    }
  }
  ts.t[T_MFDEPTH]--;
  r0 = best < 0 ? 0 : best / 10; if (r0 > 4) r0 = 4;
  ts.t[T_H1 + r0]++;
}
void h_lootdyn (void * self, guint8 * name, guint8 * pre, guint8 * suf, void * rng, void * n) { loot_mf (o_lootdyn, self, name, pre, suf, rng, n); }
void h_lootfix (void * self, guint8 * name, guint8 * pre, guint8 * suf, void * rng, void * n) { loot_mf (o_lootfix, self, name, pre, suf, rng, n); }
void h_lootmaster (void * self, guint8 * name, guint8 * pre, guint8 * suf, void * rng, void * n) { loot_mf (o_lootmaster, self, name, pre, suf, rng, n); }
/* monsters: picks one of the record's weighted tables (e.g. normal or unique items) and rolls it */
void h_lootloader (void * self, guint8 * name, guint8 * pre, guint8 * suf, void * rng) { loot_mf (o_lootloader, self, name, pre, suf, rng, NULL); }
/* A spawned merchant's market starts on a later frame. While a summon is armed, the first market whose merchant id is
   newer than the id taken just before the spawn is the trader's. */
void h_srvrefresh (void * s)
{
  gint32 id = *(gint32 *) ((guint8 *) s + 0x18);
  if (ts.t[T_SUMMON] && (guint32) id > (guint32) ts.t[T_BASEID]) {
    ts.t[T_ID0 + ts.t[T_SUMKIND]] = id; ts.t[T_SUMMON] = 0;
    msg ("The trader is standing next to you");
  }
  o_srvrefresh (s);
}
static gint32 buy_begin (void * c, guint32 id, gint32 k)
{
  gint32 need = need_for (c, id);
  if (ts.t[T_PTS0 + k] < need) {
    msg (need == 1 ? "Buying back costs 1 point" : "Sell more items of this kind to this trader first");
    return 0;
  }
  ts.t[T_BUYING] = need; ts.t[T_BUYKIND] = k;
  return 1;
}
guint8 h_preq (void * c, guint32 id, gint32 n)
{
  gint32 k = kind_of (c); guint8 r;
  if (!by_points (c, id, k)) return o_preq (c, id, n);
  if (!buy_begin (c, id, k)) return 0;
  r = o_preq (c, id, n); ts.t[T_BUYING] = 0; return r;
}
guint8 h_preqinv (void * c, guint32 id, void * a, void * b)
{
  gint32 k = kind_of (c); guint8 r;
  if (!by_points (c, id, k)) return o_preqinv (c, id, a, b);
  if (!buy_begin (c, id, k)) return 0;
  r = o_preqinv (c, id, a, b); ts.t[T_BUYING] = 0; return r;
}
guint8 h_preqeq (void * c, guint32 id, guint32 loc)
{
  gint32 k = kind_of (c); guint8 r;
  if (!by_points (c, id, k)) return o_preqeq (c, id, loc);
  if (!buy_begin (c, id, k)) return 0;
  r = o_preqeq (c, id, loc); ts.t[T_BUYING] = 0; return r;
}
/* the gold for a purchase is taken here (PurchaseConfirmation*): points instead */
void h_submoney (void * ch, guint32 amount)
{
  if (ts.t[T_BUYING]) { ts.t[T_PTS0 + ts.t[T_BUYKIND]] -= ts.t[T_BUYING]; ts.t[T_BUYING] = 0; return; }
  o_submoney (ch, amount);
}
guint8 h_sale (void * c, guint32 id, guint8 quiet)
{
  gint32 k = kind_of (c), counts = k >= 1 && item_kind (id) == k;
  guint8 r = o_sale (c, id, quiet);
  if (counts && (r & 1)) ts.t[T_PTS0 + k]++;
  return r;
}

/* ---------- overlay add-on ---------- */
static guint32 rgba (gint32 r, gint32 g, gint32 b, gint32 a) { return (guint32) r | ((guint32) g << 8) | ((guint32) b << 16) | ((guint32) a << 24); }
typedef struct { float x, y, w, h; } R;
static gint32 inside (R r, float x, float y) { return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h; }
static void fmt_int (char * buf, const char * prefix, gint32 v, const char * suffix)
{
  gint32 n = 0, d = 1000000, started = 0;
  while (*prefix) buf[n++] = *prefix++;
  if (v < 0) { buf[n++] = '-'; v = -v; }
  if (v > 9999999) v = 9999999;
  for (; d > 0; d /= 10) if (v >= d || d == 1 || started) { buf[n++] = (char) ('0' + (v / d) % 10); started = 1; }
  while (*suffix) buf[n++] = *suffix++;
  buf[n] = 0;
}
static const char * KIND_NAME[NKIND] = { "Green", "Blue", "Purple", "Lesser", "Greater", "Divine", "Relics" };
static const char * KIND_SOLD[NKIND] = { "", "Blue items sold: ", "Purple items sold: ", "Lesser artifacts sold: ", "Greater artifacts sold: ", "Divine artifacts sold: ", "Complete relics sold: " };
static const char * KIND_SELL[NKIND] = { "", "Sell blue items here", "Sell purple items here", "Sell lesser artifacts here", "Sell greater artifacts here", "Sell divine artifacts here", "Sell complete relics/charms" };
static guint32 kind_color (gint32 k, gint32 a)
{
  static const guint8 C[NKIND][3] = { { 52, 128, 60 }, { 46, 92, 168 }, { 118, 60, 150 }, { 150, 104, 52 }, { 168, 84, 40 }, { 176, 52, 52 }, { 90, 120, 130 } };
  return rgba (C[k][0], C[k][1], C[k][2], a);
}
static R restock_rect (float W, float H, float s) { R r; r.x = W * 0.012f; r.y = H * 0.30f; r.w = W * 0.15f; r.h = 70 * s; return r; }
static R summon_rect (gint32 k, float s)   /* row 1: colors, row 2: artifacts, row 3: relics, then magic find */
{
  R r; float gap = 14 * s; r.w = (ts.aw - 2 * gap) / 3; r.h = 54 * s; r.x = ts.ax + (k % 3) * (r.w + gap); r.y = ts.ay + 44 * s + (k / 3) * 64 * s; return r;
}
static R mf_rect (float s) { R a = summon_rect (7, s), b = summon_rect (8, s); a.w = b.x + b.w - a.x; return a; }
/* "1.3x" for step 3 */
static void fmt_mult (char * buf, const char * prefix, gint32 step, const char * suffix)
{
  gint32 n = 0, v = 10 + step;
  while (*prefix) buf[n++] = *prefix++;
  buf[n++] = (char) ('0' + v / 10); buf[n++] = '.'; buf[n++] = (char) ('0' + v % 10); buf[n++] = 'x';
  while (*suffix) buf[n++] = *suffix++;
  buf[n] = 0;
}
static R reset_rect (gint32 k, float s)   /* 0: skills, 1: attributes */
{
  R r; float gap = 14 * s; r.w = (ts.aw - gap) / 2; r.h = 54 * s; r.x = ts.ax + k * (r.w + gap); r.y = ts.ay + 340 * s; return r;
}
static const char * RESET_NAME[2] = { "Reset skills", "Reset attributes" };

gint32 tr_frame (void)
{
  ts.t[T_FRAMES]++;
  if (!ts.t[T_ON]) return 0;
  if (ts.t[T_SUMMON] && ts.t[T_FRAMES] - ts.t[T_SUMMON] > 300) { ts.t[T_SUMMON] = 0; msg ("The trader could not be summoned here"); }
  if (ts.t[T_REQ]) { gint32 r = ts.t[T_REQ]; trader_cb (r); ts.t[T_REQ] = 0; }
  if (ts.t[T_FILL] || ts.t[T_BUSY]) trader_cb (REQ_TICK);
  return market_open ();   /* the menu button would cover the merchant's name */
}
void tr_draw (gint32 panel, float x, float y, float w)
{
  float m[5], s, fs; char buf[64], buf2[64]; gint32 k, recent;
  guint32 white = rgba (240, 236, 226, 255), dim = rgba (170, 168, 160, 255), gold = rgba (214, 170, 92, 255);
  if (!ts.t[T_ON]) return;
  ui_metrics (m); s = m[2]; fs = s * 0.78f;
  recent = ts.t[T_FRAMES] - ts.t[T_MSGF] < 150 && ts.msg[0];
  if (panel) {
    R b;
    ts.ax = x; ts.ay = y; ts.aw = w;
    ui_text (x, y, "Summon a trader (row 2: artifacts)", fs, gold);
    for (k = 0; k < NKIND; k++) {
      b = summon_rect (k, s);
      ui_box (b.x, b.y, b.w, b.h, kind_color (k, 255));
      ui_text (b.x + (b.w - ui_text_w (KIND_NAME[k], fs * 0.9f)) / 2, b.y + 10 * s, KIND_NAME[k], fs * 0.9f, white);
    }
    {   /* magic find: buy the next step (second tap confirms) */
      R m2 = mf_rect (s); gint32 st = ts.t[T_MFSTEP];
      gint32 armed = ts.t[T_CONFIRM] == 3 && ts.t[T_FRAMES] - ts.t[T_CONFF] < 120;
      if (st >= 15) fmt_mult (buf, "Magic find ", st, " (max)");
      else if (armed) fmt_int (buf, "Tap again to pay ", (st + 1) * 100, "k gold");
      else { fmt_mult (buf2, "Magic find ", st, " -> "); fmt_mult (buf, buf2, st + 1, " for "); fmt_int (buf2, buf, (st + 1) * 100, "k"); for (k = 0; buf2[k]; k++) buf[k] = buf2[k]; buf[k] = 0; }
      ui_box (m2.x, m2.y, m2.w, m2.h, armed ? rgba (150, 60, 40, 255) : rgba (130, 108, 40, 255));
      ui_text (m2.x + (m2.w - ui_text_w (buf, fs * 0.82f)) / 2, m2.y + 12 * s, buf, fs * 0.82f, white);
    }
    fmt_int (buf, "Points: ", ts.t[T_PTS0 + 1], " blue, ");
    fmt_int (buf2, buf, ts.t[T_PTS0 + 2], " purple, ");
    fmt_int (buf, buf2, ts.t[T_PTS0 + 3], "/");
    fmt_int (buf2, buf, ts.t[T_PTS0 + 4], "/");
    fmt_int (buf, buf2, ts.t[T_PTS0 + 5], " artifacts, ");
    fmt_int (buf2, buf, ts.t[T_PTS0 + 6], " relics");
    ui_text (x, b.y + b.h + 14 * s, buf2, fs * 0.72f, dim);
    ui_text (x, y + 296 * s, "Character", fs, gold);
    for (k = 0; k < 2; k++) {
      R c = reset_rect (k, s);
      gint32 armed = ts.t[T_CONFIRM] == k + 1 && ts.t[T_FRAMES] - ts.t[T_CONFF] < 120;
      const char * label = armed ? "Tap again to confirm" : RESET_NAME[k];
      ui_box (c.x, c.y, c.w, c.h, armed ? rgba (150, 60, 40, 255) : rgba (60, 60, 56, 255));
      ui_text (c.x + (c.w - ui_text_w (label, fs * 0.85f)) / 2, c.y + 11 * s, label, fs * 0.85f, white);
    }
    if (ts.t[T_BUSY] == 2) { fmt_int (buf, "Preparing the item list: ", ts.t[T_PCT], "%"); ui_text (x, b.y + b.h + 44 * s, buf, fs * 0.75f, white); }
    else if (recent) ui_text (x, b.y + b.h + 44 * s, ts.msg, fs * 0.75f, white);
    return;
  }
  if (market_open ()) {
    R r = restock_rect (m[0], m[1], s);
    gint32 ok = open_kind ();
    const char * label = ok >= 0 ? "New stock" : "Restock";
    ui_box (r.x, r.y, r.w, r.h, rgba (16, 18, 18, 200));
    ui_text (r.x + (r.w - ui_text_w (label, fs)) / 2, r.y + (r.h - m[3] * fs) / 2 + 2 * s, label, fs, white);
    if (ok == 0) ui_text (r.x, r.y + r.h + 18 * s, "Green items for gold", fs * 0.8f, gold);
    if (ok >= 1) {
      fmt_int (buf, KIND_SOLD[ok], ts.t[T_PTS0 + ok], "");
      ui_text (r.x, r.y + r.h + 18 * s, buf, fs * 0.8f, gold);
      fmt_int (buf, "Shop item costs ", ts.t[T_COST], "");
      ui_text (r.x, r.y + r.h + 52 * s, buf, fs * 0.72f, dim);
      ui_text (r.x, r.y + r.h + 80 * s, "Buying back costs 1", fs * 0.72f, dim);
      ui_text (r.x, r.y + r.h + 108 * s, KIND_SELL[ok], fs * 0.72f, dim);
    }
    if (recent) ui_text (r.x, r.y + r.h + 150 * s, ts.msg, fs * 0.72f, white);
    return;
  }
  if (ts.t[T_BUSY] == 2) { fmt_int (buf, "Preparing the item list: ", ts.t[T_PCT], "%"); ui_text (m[0] * 0.245f, 84 * s, buf, fs * 0.8f, white); }
  else if (recent) ui_text (m[0] * 0.245f, 84 * s, ts.msg, fs * 0.8f, white);
}
gint32 tr_touch (float x, float y, gint32 panel, gint32 press)
{
  float m[5], s; gint32 k;
  if (!ts.t[T_ON]) return 0;
  ui_metrics (m); s = m[2];
  if (panel) {
    for (k = 0; k < NKIND; k++) if (inside (summon_rect (k, s), x, y)) {
      if (press && !ts.t[T_REQ]) { ts.t[T_REQKIND] = k; ts.t[T_REQ] = REQ_SUMMON; }
      return 2;   /* close the panel */
    }
    if (inside (mf_rect (s), x, y)) {
      if (!press || ts.t[T_MFSTEP] >= 15) return 1;
      if (ts.t[T_CONFIRM] == 3 && ts.t[T_FRAMES] - ts.t[T_CONFF] < 120) { ts.t[T_CONFIRM] = 0; if (!ts.t[T_REQ]) ts.t[T_REQ] = REQ_BUY_MF; return 1; }
      ts.t[T_CONFIRM] = 3; ts.t[T_CONFF] = ts.t[T_FRAMES];
      return 1;
    }
    for (k = 0; k < 2; k++) if (inside (reset_rect (k, s), x, y)) {
      if (!press) return 1;
      if (ts.t[T_CONFIRM] == k + 1 && ts.t[T_FRAMES] - ts.t[T_CONFF] < 120) {
        ts.t[T_CONFIRM] = 0;
        if (!ts.t[T_REQ]) ts.t[T_REQ] = k == 0 ? REQ_RESET_SKILLS : REQ_RESET_STATS;
        return 2;
      }
      ts.t[T_CONFIRM] = k + 1; ts.t[T_CONFF] = ts.t[T_FRAMES];
      return 1;
    }
    return 0;
  }
  if (!market_open () || !inside (restock_rect (m[0], m[1], s), x, y)) return 0;
  if (press && !ts.t[T_REQ]) ts.t[T_REQ] = REQ_RESTOCK;
  return 1;
}
`;
// ---- traders add-on (trader.c): green (gold), blue, purple, lesser/greater/divine artifact and relic traders (paid
// with items of the same kind sold to the trader) with items up to your level, a Restock button in every trade window,
// skill/attribute resets and magic find bought with gold. Appended after the overlay core (tq-android-perf's
// patch.js, or the standalone build); registers itself in OVERLAY_ADDONS.
// The item list is built on the device from the game's own database: every weapon/armor/jewelry record is created
// once as a throwaway item to read its classification and level requirement; the result is cached per game build.
const TS_MSG = 256;
const T_ON = 0, T_REQKIND = 2, T_MKT = 3, T_FILL = 5, T_FILLKIND = 6, T_BUSY = 7, T_MSGF = 8, T_ADDING = 9, T_SUMMON = 12,
  T_SUMKIND = 13, T_BASEID = 14, T_FRAMES = 15, T_COST = 16, T_PCT = 17, T_CLIENT = 20, T_ID0 = 22, T_PTS0 = 29, T_ARTOFF = 36,
  T_MFSTEP = 38, T_MFROLLS = 41, T_MFWINS = 42;
const NKIND = 7;
const MF_MAX = 15, MF_STEP_COST = 100000;                 // step n (1.0x + 0.1x * n) costs n * 100k gold
// pool class of each trader kind: Item::GetItemClassification 2 green, 3 blue, 4 purple; 10 + tier for artifacts
const KIND_CLASS = [2, 3, 4, 10, 11, 12, 20];             // 20: complete relics and charms
const KIND_KEYS = [null, 'blue', 'purple', 'lesser', 'greater', 'divine', 'relics'];   // points file
const RELIC_DONE_OFFSET = 0x678;                          // ItemRelic: level at which it is complete
const RELIC_BONUS_TABLE = 0xa10;                          // ItemRelic: std::string, completion bonus table
const ARTIFACT_TIER_OFFSET = 0xab0;                       // ItemArtifact: 0 lesser, 1 greater, 2 divine (set in Load)
// development and joke records that no player can find (sandbox, dev/test items, costume 'z_' items, cut content)
const TRADER_SKIP = /sandbox|soundtest|devcheat|devitem|\/dev\/|\/test|test_|\/out\/|\/old\/|\/z_|dummy|\/default\/|copy of|pieces_/;
const TRADER_CFG = V2_CACHE + 'tq-trader.json';
const TRADER_COST = 5;                                    // points (items of the trader's color sold) per shop item
const TRADER_TABS = { 1: 20, 2: 20, 3: 26, 4: 40, 5: 18, 6: 30 };   // per group: melee, ranged/staff, armor, jewelry, artifacts, relics
const TRADER_CLASSES = {
  WeaponMelee_Sword: 1, WeaponMelee_Axe: 1, WeaponMelee_Mace: 1,
  WeaponHunting_Bow: 2, WeaponHunting_Spear: 2, WeaponMagical_Staff: 2, WeaponHunting_RangedOneHand: 2,
  ArmorProtective_Head: 3, ArmorProtective_UpperBody: 3, ArmorProtective_Forearm: 3, ArmorProtective_LowerBody: 3, WeaponArmor_Shield: 3,
  ArmorJewelry_Ring: 4, ArmorJewelry_Amulet: 4, ItemArtifact: 5, ItemRelic: 6, ItemCharm: 6,
  ItemArtifactFormula: 7,                                 // not sold: maps each artifact to its formula (bonus table)
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
  'o_preq', 'o_preqinv', 'o_preqeq', 'o_submoney', 'o_sale', 'm_isused', 'm_omget', 'm_getitem', 'm_itemclass', 'm_artifact', 'm_relic', 'm_relicdone', 'o_lootdyn', 'o_lootfix', 'o_lootmaster', 'o_lootloader', 'm_loadtable', 'mf_keys', 'mf_rank', 'trader_cb'];
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
    artifact: fn('_ZN4GAME11DynamicCastINS_12ItemArtifactENS_4ItemEEEPT_PT0_', 'pointer', ['pointer']),
    relic: fn('_ZN4GAME11DynamicCastINS_9ItemRelicENS_4ItemEEEPT_PT0_', 'pointer', ['pointer']),
    artifactInfo: fn('_ZN4GAME19ItemArtifactFormula15GetArtifactInfoERNS_15ItemReplicaInfoE', 'void', ['pointer', 'pointer']),
    rtCtor: fn('_ZN4GAME19LootRandomizerTableC1Ev', 'void', ['pointer']),
    rtDtor: fn('_ZN4GAME19LootRandomizerTableD1Ev', 'void', ['pointer']),
    rtLoad: fn('_ZN4GAME19LootRandomizerTable10ManualLoadERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEE', 'void', ['pointer', 'pointer']),
    rtPick: fn('_ZNK4GAME19LootRandomizerTable17GetRandomizerNameERNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEERNS_13RandomUniformE', 'void', ['pointer', 'pointer', 'pointer']),
    randomGen: fn('_ZN4GAME10GameEngine12GetRandomGenEv', 'pointer', ['pointer']),
    money: fn('_ZNK4GAME9Character15GetCurrentMoneyEv', 'uint', ['pointer']),
    subMoney: fn('_ZN4GAME9Character13SubtractMoneyEj', 'void', ['pointer', 'uint']),
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
    ['_ZN4GAME23LootItemTable_DynWeight11GetLootNameERNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEES8_S8_RNS_13RandomUniformERi', 'h_lootdyn', 'o_lootdyn'],
    ['_ZN4GAME25LootItemTable_FixedWeight11GetLootNameERNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEES8_S8_RNS_13RandomUniformERi', 'h_lootfix', 'o_lootfix'],
    ['_ZNK4GAME10LootLoader11GetLootNameERNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEES8_S8_RNS_13RandomUniformE', 'h_lootloader', 'o_lootloader'],
    ['_ZN4GAME15LootMasterTable11GetLootNameERNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEES8_S8_RNS_13RandomUniformERi', 'h_lootmaster', 'o_lootmaster'],
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
  v.m_artifact.writePointer(E('_ZN4GAME11DynamicCastINS_12ItemArtifactENS_4ItemEEEPT_PT0_'));
  v.m_relic.writePointer(E('_ZN4GAME11DynamicCastINS_9ItemRelicENS_4ItemEEEPT_PT0_'));
  v.m_relicdone.writePointer(E('_ZNK4GAME9ItemRelic10IsCompleteEv'));
  v.m_loadtable.writePointer(E('_ZN4GAME13ObjectManager13LoadTableFileERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEE'));
  const cm = new CModule(TRADER_C, v); held.push(cm);
  if (new NativeFunction(cm.ts_size, 'int', [])() > 4096) throw Error('trader state too large');
  const ts = v.ts, t = i => ts.add(i * 4);
  V2.traderTs = ts;                                          // diagnostics
  const msg = s => { ts.add(TS_MSG).writeUtf8String(s.slice(0, 63)); t(T_MSGF).writeS32(t(T_FRAMES).readS32()); };

  // ---- item pool: [record, tab, level requirement] of every blue item, built on the device and cached per build
  const ri = Memory.alloc(0x100), tag = Memory.allocUtf8String('tq-trader'), strs = {};
  held.push(ri, tag);
  const cstr = s => strs[s] || (strs[s] = Memory.allocUtf8String(s));
  const replica = (rec, seed) => { f.riCtor(ri); f.assign(ri.add(8), cstr(rec)); ri.add(0x80).writeU32(seed); return ri; };
  const poolFile = V2_CACHE + 'tq-trader-items-' + ctx.buildId + '.json';
  let pool = null, queue = null, total = 0, found = [], wantSummon = null, formulaOf = {}, foundFormulas = {};
  const ri2 = Memory.alloc(0x100), rtab = Memory.alloc(0x200), tstr = Memory.alloc(24);
  held.push(ri2, rtab, tstr); f.riCtor(ri2); tstr.writeByteArray(new Uint8Array(24));
  const readStd = q => { const b0 = q.readU8(); return (b0 & 1) ? q.add(16).readPointer().readUtf8String(q.add(8).readU64().toNumber()) : q.add(1).readUtf8String(b0 >> 1); };
  // completion bonus of a relic/charm, picked from its bonus table the way the game does when a relic is completed
  function rollBonus(table, out) {
    f.assign(tstr, cstr(table));
    f.rtCtor(rtab);
    try { f.rtLoad(rtab, tstr); f.rtPick(rtab, out, f.randomGen(engine())); } finally { f.rtDtor(rtab); }
  }
  try { const c = JSON.parse(File.readAllText(poolFile)); if (c.v === 5 && c.items.length) { pool = c.items; formulaOf = c.formulas || {}; } } catch (e) {}
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
      let cls = f.itemClass(it);
      if (tab === 7) {                                         // formula: remember which artifact it makes
        f.artifactInfo(it, ri2);
        const art = readStd(ri2.add(8));
        if (art) foundFormulas[art.toLowerCase().split(String.fromCharCode(92)).join('/')] = rec;
        f.destroy(f.omGet(), it, tag, 1);
        continue;
      }
      let done = 0, bonus = '';
      if (tab === 5) { const a = f.artifact(it), tier = a.isNull() ? -1 : a.add(ARTIFACT_TIER_OFFSET).readS32(); cls = tier >= 0 && tier <= 2 ? 10 + tier : -1; }
      if (tab === 6) {
        const r = f.relic(it);
        done = r.isNull() ? 0 : r.add(RELIC_DONE_OFFSET).readU32(); cls = done > 0 && done < 100 ? 20 : -1;
        if (cls === 20) bonus = readStd(r.add(RELIC_BONUS_TABLE)) || '';
      }
      if ((cls >= 2 && cls <= 4) || cls >= 10) found.push([rec, tab, f.lvlReq(it), cls, done, bonus]);
      f.destroy(f.omGet(), it, tag, 1);
    }
    t(T_PCT).writeS32(Math.floor(100 * (total - queue.length) / total));
    if (queue.length) return;
    queue = null; pool = found; formulaOf = foundFormulas; t(T_BUSY).writeS32(0);
    try { const fl = new File(poolFile, 'w'); fl.write(JSON.stringify({ v: 5, items: pool, formulas: formulaOf })); fl.close(); } catch (e) {}
    V2.status.addons.trader.items = pool.length;
    if (wantSummon !== null) { const k = wantSummon; wantSummon = null; summon(k); }
  }

  function fill(client, kind) {
    const p = player(); if (p.isNull() || !pool) return;
    const lvl = f.charLevel(p), byTab = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] }, cls = KIND_CLASS[kind], extra = {};
    for (const [rec, tab, req, c, d, b] of pool) if (c === cls && req <= lvl) { byTab[tab].push(rec); extra[rec] = [d || 0, b || '']; }
    let n = 0;
    t(T_ADDING).writeS32(1);
    try {
      for (const tab in byTab) {
        const c = byTab[tab];
        for (let i = 0; i < TRADER_TABS[tab] && c.length; i++) {
          const rec = c.splice(Math.floor(Math.random() * c.length), 1)[0];
          const seed = Math.floor(Math.random() * 0x7fff);
          let r = replica(rec, seed);
          const [done, bonusTable] = extra[rec];
          if (done) {                                               // relics: complete, with a completion bonus
            r.add(0x84).writeU32(done);
            if (bonusTable) rollBonus(bonusTable, r.add(0x68));
          }
          const formula = tab === '5' && formulaOf[rec.toLowerCase().split(String.fromCharCode(92)).join('/')];
          if (formula) {                                            // artifacts: made by their formula, bonus included
            const it = f.createItem(replica(formula, seed));
            if (!it.isNull()) { f.artifactInfo(it, ri2); f.destroy(f.omGet(), it, tag, 1); r = ri2; }
          }
          f.addMini(client, 0, r);
          f.createMini(client);
          n++;
        }
      }
    } finally { t(T_ADDING).writeS32(0); }
    if (!n) msg('Nothing of this kind up to your level yet');
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

  // ---- magic find: trader.c caches the color of each record it sees (filled lazily from the game's records)
  const mfKeys = Memory.alloc(16384 * 4), mfRank = Memory.alloc(16384);
  held.push(mfKeys, mfRank);
  mfKeys.writeByteArray(new Uint8Array(16384 * 4)); mfRank.writeByteArray(new Uint8Array(16384));
  v.mf_keys.writePointer(mfKeys); v.mf_rank.writePointer(mfRank);
  function buyMf() {
    const p = player(), step = t(T_MFSTEP).readS32();
    if (p.isNull() || step >= MF_MAX) return;
    const cost = (step + 1) * MF_STEP_COST;
    if (f.money(p) < cost) { msg('Not enough gold: ' + cost / 1000 + 'k needed'); return; }
    f.subMoney(p, cost);
    t(T_MFSTEP).writeS32(step + 1);
    msg('Magic find is now ' + (1 + (step + 1) / 10).toFixed(1) + 'x');
  }

  const cb = new NativeCallback(code => {
    try {
      if (code === 1) {
        const kind = t(T_REQKIND).readS32();
        if (pool) summon(kind);
        else { wantSummon = kind; t(T_BUSY).writeS32(2); }            // finish the item list first, faster
      } else if (code === 2) {
        const id = t(T_MKT).readU32();
        let ours = false; for (let k = 0; k < NKIND; k++) if (t(T_ID0 + k).readU32() === id) ours = true;
        if (id) { f.forceRefresh(engine(), id); msg(ours ? 'New stock' : 'Restocked'); }
      } else if (code === 6) {
        buyMf();
      } else if (code === 7) {                               // diagnostics: run a function set by another script
        const dev = globalThis.DEV_FN; globalThis.DEV_FN = null; if (dev) V2.devResult = dev();
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

  // ---- points, per character (cache/tq-trader.json: { name: { blue, purple, lesser, greater, divine } })
  let cfg = {}; try { cfg = JSON.parse(File.readAllText(TRADER_CFG)); } catch (e) {}
  let who = null, saved = '';
  const pts = () => { const o = { mf: t(T_MFSTEP).readS32() }; for (let k = 1; k < NKIND; k++) o[KIND_KEYS[k]] = t(T_PTS0 + k).readS32(); return o; };
  const nameOf = p => { const w = f.playerName(p); let s = ''; for (let i = 0; i < 40; i++) { const c = w.add(i * 4).readU32(); if (!c) break; s += String.fromCharCode(c); } return s; };
  setInterval(() => {
    try {
      const p = player(); if (p.isNull()) return;
      const name = nameOf(p);
      if (name !== who) {
        who = name;
        let c = cfg[who] || {}; if (typeof c === 'number') c = { blue: c };      // 2.2 stored blue points only
        for (let k = 1; k < NKIND; k++) t(T_PTS0 + k).writeS32(c[KIND_KEYS[k]] || 0);
        t(T_MFSTEP).writeS32(Math.min(MF_MAX, c.mf || 0));
        for (let k = 0; k < NKIND; k++) t(T_ID0 + k).writeS32(0);
        saved = JSON.stringify(pts()); return;
      }
      const hist = b => [0, 1, 2, 3, 4].map(i => t(b + i).readS32());   // colors: white, yellow, green, blue, purple
      V2.status.addons.trader.magicFind = { step: t(T_MFSTEP).readS32(), extraRolls: t(T_MFROLLS).readS32(), better: t(T_MFWINS).readS32(),
        firstRoll: hist(44), kept: hist(49) };
      const now = JSON.stringify(pts());
      if (now !== saved) { saved = now; cfg[who] = pts(); const fl = new File(TRADER_CFG, 'w'); fl.write(JSON.stringify(cfg)); fl.close(); }
    } catch (e) {}
  }, 1000);

  t(T_COST).writeS32(TRADER_COST);
  t(T_ARTOFF).writeS32(ARTIFACT_TIER_OFFSET);
  if (!pool) {                                                 // build the list in the background, 2 ms per frame
    queue = candidates(); total = queue.length; found = [];
    t(T_BUSY).writeS32(1);
  }
  t(T_ON).writeS32(1);
  return { frame: cm.tr_frame, draw: cm.tr_draw, touch: cm.tr_touch, status: { items: pool ? pool.length : null, candidates: total } };
}
