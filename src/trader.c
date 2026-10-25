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
