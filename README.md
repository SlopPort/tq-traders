# TQ Traders & Respec for Titan Quest on Android

An unofficial, open-source Magisk module for Titan Quest on Android (single-player). It adds a small in-game menu where you can summon a trader next to your character, make any merchant restock, and reset your skills or attributes. It runs on its own or as an add-on of [tq-android-perf](https://github.com/SlopPort/tq-android-perf). No game files are modified or distributed.

![Menu](docs/menu.jpg)

![Blue trader](docs/blue-trader.jpg)

![Green trader](docs/green-trader.jpg)

![Masteries](docs/masteries.jpg)

**[Download v1.0 from GitHub Releases](https://github.com/SlopPort/tq-traders/releases/latest)**

## What it does

- **Summon a trader** next to your character, in three kinds:
  - **Green:** green (Rare) items for normal gold prices.
  - **Blue:** blue (Epic) items, paid with blue items you sell to it.
  - **Purple:** purple (Legendary) items, paid with purple items you sell to it.
- **Restock** any merchant's stock, including the game's normal merchants.
- **Reset skills:** all skill and mastery points come back, and you choose both masteries again.
- **Reset attributes:** all attribute points come back.

## Quick start

**Requirements:**

- A rooted **arm64** Android device with Magisk
- Your own installed copy of Titan Quest for Android (`com.hg.titanquestultimate`)
- A backup of your game saves

**Installation:**

1. Download `tq-traders-1.0.zip` from the Releases page.
2. In Magisk, open **Modules → Install from storage**.
3. Select the downloaded zip and reboot.
4. Start Titan Quest.
5. Wait until the main menu or the game world has loaded, then tap the **Mods** button at the top of the screen, next to the pause button. With tq-android-perf installed, the same options are in its **Perf** menu instead.

**Uninstall:** disable or remove the module in Magisk and reboot.

This is an experimental fan-made modification for single-player use. Use it at your own risk.

## Compatibility

| | |
|---|---|
| **Tested** | Titan Quest for Android **3.0.5339**, arm64, on a Redmi Note 8 (Snapdragon 665) with Magisk |
| **Expected to work, untested** | Other arm64 builds of the game. Functions are found by their exported names at runtime. A few object layouts are fixed and checked before use (see Limitations). |
| **Not supported** | The 32-bit (armeabi-v7a) build, the PC version, phones without root |

To see what loaded on your phone, run:

```bash
adb shell su -c cat /data/user/0/com.hg.titanquestultimate/cache/tq-v2-status.json
```

## How to use

### Summoning a trader

Open the menu and tap **Green**, **Blue** or **Purple** under "Summon a trader". The menu closes and the trader appears next to your character a moment later. Its look is picked at random from the game's own merchant models, and its name comes from the same record.

Talk to it like any other merchant. Its stock is a random selection of items of its color, up to your character level, sorted into the game's own trade window tabs: melee weapons, ranged weapons and staffs, armor, and jewelry.

While a trade window is open, a **New stock** button appears on the left. It rolls a new random selection. You can use it as often as you like.

### Paying the blue and purple traders

The blue and purple traders don't take gold. They take items of their own color:

| Action | Cost or gain |
|---|---|
| Sell a blue item to the blue trader | +1 point (it also pays 1 gold) |
| Buy an item from its stock | 5 points |
| Buy back an item you sold to it | 1 point |
| Sell an item of another color | Refused |

The purple trader works the same way with purple items and its own, separate point count. The trade window shows your current points. The menu shows both counts ("Sold to traders: ... blue, ... purple").

Points are saved per character, in a file in the game's cache folder, so they survive restarts.

The green trader uses gold at normal prices.

### Restocking any merchant

Every trade window, including the game's normal merchants, gets a **Restock** button. It makes the merchant generate new stock right away, using the game's own market refresh. Useful for vendor farming.

### Resetting skills and attributes

Under "Character" in the menu:

- **Reset skills** returns all skill and mastery points. Afterwards the game lets you choose both masteries again.
- **Reset attributes** returns all attribute points. Strength, dexterity, intelligence, health and energy go back to their starting values.

Both buttons need a second tap to confirm ("Tap again to confirm"). The game itself has potions that reset attributes in the Eternal Embers expansion, but there is normally no way to change a mastery once chosen.

### The first launch: building the item list

The module ships no game data. The first time it runs on a game build, it builds its list of items from the game's own database on the phone. Every weapon, armor and jewelry record is created once as a throwaway item to read its quality and its exact level requirement, then destroyed.

- This runs in the background and takes a few minutes, at a small FPS cost.
- If you summon a trader before it's finished, the list is built faster and the menu shows a progress bar ("Preparing the item list: ...%"). The trader appears when it's done.
- The result is cached per game build, so later launches are instant.
- Developer test items and joke costume items, which can't be found in normal play, are left out.

### Summoned traders are not saved

Summoned traders are not part of your save. After you load a game, summon one again.

## Using it with tq-android-perf

tq-traders works on its own, or as an add-on of tq-android-perf 2.3 or later:

- **Alone:** this module injects its own small copy of the menu (no engine patches) and shows a **Mods** button.
- **With tq-android-perf 2.3+:** the traders and resets appear inside the **Perf** menu, below the engine patches. This module's own service stays idle.

The reason is the game's anti-tamper protection: it kills the process after a second Frida injection, so only one injection per game process is possible. When both modules are installed, tq-android-perf injects this module's `tq-addon.js` together with its own patches, in its single injection.

Older versions of tq-android-perf (2.1.x) can't host add-ons. To avoid a second injection, tq-traders stays idle while any tq-android-perf is active and writes "update it to 2.3+" to its `status.log`. Update tq-android-perf, or disable it to use tq-traders alone.

## How it works

Everything is applied at runtime into the running game, with [Frida](https://frida.re/) (`frida-inject`, injected once by the Magisk service). The game's library exports its symbol names, so every game function is found by name. New logic is written in C (Frida's CModule, compiled on the phone).

- **Traders.** A summon spawns one of the game's own merchant creatures next to the player. The module notes which market belongs to it, and hooks the game's market functions for that market only: filling the stock, refreshing, prices, affordability, buying and selling. Normal merchants keep their normal behaviour.
- **Points instead of gold.** For the blue and purple traders, the hooked price functions return a point cost. When the game takes the gold for a purchase, the module takes points instead. A sale counts as a point only if the item has the trader's color; items of other colors are refused through the same price check the game uses for items a merchant won't buy.
- **Stock.** The stock is added with the game's own "add item to market" function, from the item list, filtered by color and your character level, with a random seed for each item.
- **Restock and New stock** call the game's own forced market refresh.
- **Item list.** The module walks the game's database archive for weapon, armor and jewelry records, creates each one once to read its quality and level requirement, and caches the result under the game library's build-id.
- **Respec** uses the game's own skill and attribute functions: skill levels are taken down one at a time (skills first, then the masteries), the points are given back with the game's "add skill points" function, and attributes are set back with the game's base attribute functions plus "add attribute points".
- **Menu.** The menu drawing and touch handling come from tq-android-perf's overlay core. This module registers itself there as an add-on (see that project's README).

## Limitations

- **arm64 only.**
- **Tested on one game build** (3.0.5339) and one phone. On other builds functions are found by name, but a few object layouts (the character's skill list and attributes, the database archive) are fixed. They are checked at runtime: if the layout is not recognized, the resets refuse to run and the item list reports an error in the status file, instead of guessing.
- **Summoned traders disappear** when you load a game. Summon again.
- **Appearance and name** of a trader come from the game's merchant records, so a trader may look and be named like a merchant from another act.
- **Buying back** an item from a blue or purple trader costs 1 point, not gold.
- **Single-player only.** The traders and resets are meant for your own single-player game. Don't use them to get an advantage over other players.

## Building from source

Repository layout:

- `module/`: `service.sh`, `module.prop`, the Magisk installer, and `build.py`, which downloads the official `frida-inject` and builds the zip.
- `module/tq-addon.js` and `module/standalone.js`: generated scripts. `tq-addon.js` is the add-on that tq-android-perf loads; `standalone.js` is the menu core plus the add-on, for use without tq-android-perf.
- `src/`: `trader.c` (market hooks and the add-on's drawing and touch, as a Frida CModule), `trader-glue.js` (setup, item list, summon and respec), `build_module.py` (generates the scripts).

To build:

```bash
python src/build_module.py
python module/build.py
```

The standalone script includes the menu core from tq-android-perf, so `build_module.py` needs a checkout of tq-android-perf next to this one.

## Development disclosure

Most of the work (reverse engineering, writing the code, running the phone over adb, testing) was done with Claude Code, Anthropic's AI coding assistant, under the direction of the project's contributors, who made the decisions and checked the game themselves. It was tested on one phone.

## License and disclaimer

MIT License, see `LICENSE`. Copyright tq-android-perf contributors.

The release zip bundles the unmodified `frida-inject` 17.22.1 (android-arm64) from the official Frida release, licensed under the wxWindows Library Licence 3.1. See `THIRD-PARTY.md`.

Titan Quest is a trademark of THQ Nordic. This is an unofficial, non-commercial fan project. It is not affiliated with or endorsed by THQ Nordic or HandyGames. It contains no game files, game code or assets: the module changes the user's own installed copy in memory while it runs. For single-player use.
