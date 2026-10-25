/* Traders and respec add-on for the tq-android-perf overlay.
 *
 * Three merchants can be summoned next to the player; each sells items of one quality up to the player's level:
 *   kind 0: green (Rare) items, for gold (normal prices);
 *   kind 1: blue (Epic) items, paid with blue items sold to it;
 *   kind 2: purple (Legendary) items, paid with purple items sold to it.
 * For kinds 1 and 2 each item of that quality sold = 1 point (and 1 gold); a shop item costs ts.t[T_COST] points, buying
 * back costs 1; anything else is refused. Every trade window also gets a Restock button (ForceMarketRefresh); on a
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
extern void (*trader_cb) (gint32);

/* t[] slots, mirrored in trader-glue.js */
enum { T_ON, T_REQ, T_REQKIND, T_MKT, T_MKTF, T_FILL, T_FILLKIND, T_BUSY, T_MSGF, T_ADDING, T_BUYING, T_BUYKIND,
       T_SUMMON, T_SUMKIND, T_BASEID, T_FRAMES, T_ID0 /* 16..18 */, T_PTS0 = 19 /* 19..21 by kind */, T_COST = 22, T_PCT = 23,
       T_CLIENT = 24 /* 24-25: pointer */, T_CONFIRM = 26, T_CONFF = 27 };
enum { REQ_SUMMON = 1, REQ_RESTOCK = 2, REQ_TICK = 3, REQ_RESET_SKILLS = 4, REQ_RESET_STATS = 5 };
typedef struct {
  gint32 t[32];        /* 0 */
  char msg[64];        /* 128: status line written by JS */
  float ax, ay, aw;    /* 192: where the panel section was drawn last */
} TS;
extern TS ts;
gint32 ts_size (void) { return (gint32) sizeof (TS); }

/* ---------- market hooks ---------- */
static gint32 kind_of (void * c)   /* -1: not a summoned trader */
{
  guint32 id; gint32 k;
  if (!ts.t[T_ON]) return -1;
  id = *(guint32 *) ((guint8 *) c + 0x10);
  for (k = 0; k < 3; k++) if (ts.t[T_ID0 + k] != 0 && (guint32) ts.t[T_ID0 + k] == id) return k;
  return -1;
}
static gint32 need_for (void * c, guint32 id) { return m_isused (c, id) ? 1 : ts.t[T_COST]; }
static gint32 item_class (guint32 id) { void * it = m_getitem (m_omget (), id); return it == NULL ? -1 : m_itemclass (it); }
static gint32 market_open (void) { return ts.t[T_ON] && ts.t[T_MKT] != 0 && ts.t[T_FRAMES] - ts.t[T_MKTF] <= 3; }
static gint32 open_kind (void) { gint32 k; for (k = 0; k < 3; k++) if (ts.t[T_ID0 + k] != 0 && ts.t[T_ID0 + k] == ts.t[T_MKT]) return k; return -1; }
static void msg (const char * s) { gint32 i; for (i = 0; i < 63 && s[i]; i++) ts.msg[i] = s[i]; ts.msg[i] = 0; ts.t[T_MSGF] = ts.t[T_FRAMES]; }

guint32 h_sellcost (void * c, guint32 id) { gint32 k = kind_of (c); return k >= 1 ? (guint32) need_for (c, id) : o_sellcost (c, id); }
guint8 h_afford (void * c, guint32 id) { gint32 k = kind_of (c); return k >= 1 ? ts.t[T_PTS0 + k] >= need_for (c, id) : o_afford (c, id); }
guint32 h_buycost (void * c, guint32 id, guint8 all)   /* 0 = the merchant refuses the item */
{
  gint32 k = kind_of (c);
  if (k >= 1) return item_class (id) == k + 2 ? 1 : 0;
  return o_buycost (c, id, all);
}
void * h_getsack (void * e, guint32 id, guint32 type) { ts.t[T_MKT] = (gint32) id; ts.t[T_MKTF] = ts.t[T_FRAMES]; return o_getsack (e, id, type); }
void h_addmini (void * c, guint32 type, void * r) { if (kind_of (c) >= 0 && !ts.t[T_ADDING]) return; o_addmini (c, type, r); }
void h_addstatic (void * c, guint32 type, void * r) { if (kind_of (c) >= 0 && !ts.t[T_ADDING]) return; o_addstatic (c, type, r); }
void h_refresh (void * c, void * rng)
{
  gint32 k = kind_of (c);
  if (k >= 0) { *(void **) &ts.t[T_CLIENT] = c; ts.t[T_FILLKIND] = k; ts.t[T_FILL] = 1; }
  o_refresh (c, rng);
}
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
    msg (need == 1 ? "Buying back costs 1 item of this color" : k == 1 ? "Sell more blue items first" : "Sell more purple items first");
    return 0;
  }
  ts.t[T_BUYING] = need; ts.t[T_BUYKIND] = k;
  return 1;
}
guint8 h_preq (void * c, guint32 id, gint32 n)
{
  gint32 k = kind_of (c); guint8 r;
  if (k < 1) return o_preq (c, id, n);
  if (!buy_begin (c, id, k)) return 0;
  r = o_preq (c, id, n); ts.t[T_BUYING] = 0; return r;
}
guint8 h_preqinv (void * c, guint32 id, void * a, void * b)
{
  gint32 k = kind_of (c); guint8 r;
  if (k < 1) return o_preqinv (c, id, a, b);
  if (!buy_begin (c, id, k)) return 0;
  r = o_preqinv (c, id, a, b); ts.t[T_BUYING] = 0; return r;
}
guint8 h_preqeq (void * c, guint32 id, guint32 loc)
{
  gint32 k = kind_of (c); guint8 r;
  if (k < 1) return o_preqeq (c, id, loc);
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
  gint32 k = kind_of (c), counts = k >= 1 && item_class (id) == k + 2;
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
static const char * KIND_NAME[3] = { "Green", "Blue", "Purple" };
static guint32 kind_color (gint32 k, gint32 a)
{
  if (k == 0) return rgba (52, 128, 60, a);
  if (k == 1) return rgba (46, 92, 168, a);
  return rgba (118, 60, 150, a);
}
static R restock_rect (float W, float H, float s) { R r; r.x = W * 0.012f; r.y = H * 0.30f; r.w = W * 0.15f; r.h = 70 * s; return r; }
static R summon_rect (gint32 k, float s)
{
  R r; float gap = 14 * s; r.w = (ts.aw - 2 * gap) / 3; r.h = 54 * s; r.x = ts.ax + k * (r.w + gap); r.y = ts.ay + 52 * s; return r;
}
static R reset_rect (gint32 k, float s)   /* 0: skills, 1: attributes */
{
  R r; float gap = 14 * s; r.w = (ts.aw - gap) / 2; r.h = 54 * s; r.x = ts.ax + k * (r.w + gap); r.y = ts.ay + 250 * s; return r;
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
    ui_text (x, y, "Summon a trader", fs, gold);
    for (k = 0; k < 3; k++) {
      b = summon_rect (k, s);
      ui_box (b.x, b.y, b.w, b.h, kind_color (k, 255));
      ui_text (b.x + (b.w - ui_text_w (KIND_NAME[k], fs * 0.9f)) / 2, b.y + 10 * s, KIND_NAME[k], fs * 0.9f, white);
    }
    fmt_int (buf, "Sold to traders: ", ts.t[T_PTS0 + 1], " blue, ");
    fmt_int (buf2, buf, ts.t[T_PTS0 + 2], " purple");
    ui_text (x, b.y + b.h + 16 * s, buf2, fs * 0.75f, dim);
    ui_text (x, y + 198 * s, "Character", fs, gold);
    for (k = 0; k < 2; k++) {
      R c = reset_rect (k, s);
      gint32 armed = ts.t[T_CONFIRM] == k + 1 && ts.t[T_FRAMES] - ts.t[T_CONFF] < 120;
      const char * label = armed ? "Tap again to confirm" : RESET_NAME[k];
      ui_box (c.x, c.y, c.w, c.h, armed ? rgba (150, 60, 40, 255) : rgba (60, 60, 56, 255));
      ui_text (c.x + (c.w - ui_text_w (label, fs * 0.85f)) / 2, c.y + 11 * s, label, fs * 0.85f, white);
    }
    if (ts.t[T_BUSY] == 2) { fmt_int (buf, "Preparing the item list: ", ts.t[T_PCT], "%"); ui_text (x, b.y + b.h + 48 * s, buf, fs * 0.75f, white); }
    else if (recent) ui_text (x, b.y + b.h + 48 * s, ts.msg, fs * 0.75f, white);
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
      fmt_int (buf, ok == 1 ? "Blue items sold: " : "Purple items sold: ", ts.t[T_PTS0 + ok], "");
      ui_text (r.x, r.y + r.h + 18 * s, buf, fs * 0.8f, gold);
      fmt_int (buf, "Shop item costs ", ts.t[T_COST], "");
      ui_text (r.x, r.y + r.h + 52 * s, buf, fs * 0.72f, dim);
      ui_text (r.x, r.y + r.h + 80 * s, "Buying back costs 1", fs * 0.72f, dim);
      ui_text (r.x, r.y + r.h + 108 * s, ok == 1 ? "Sell blue items here" : "Sell purple items here", fs * 0.72f, dim);
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
    for (k = 0; k < 3; k++) if (inside (summon_rect (k, s), x, y)) {
      if (press && !ts.t[T_REQ]) { ts.t[T_REQKIND] = k; ts.t[T_REQ] = REQ_SUMMON; }
      return 2;   /* close the panel */
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
