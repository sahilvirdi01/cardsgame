#!/usr/bin/env bash
# Generates the animated GIF reaction library used by the Thulla animation.
# Requires ImageMagick (magick/convert). Re-run any time to regenerate.
set -euo pipefail

OUT="$(cd "$(dirname "$0")/.." && pwd)/public/gifs"
TMP="$(mktemp -d)"
mkdir -p "$OUT"
trap 'rm -rf "$TMP"' EXIT

FONT="DejaVu-Sans-Bold"
W=480
H=340
FRAMES=12

# make_gif <file> <text> <background> <color1> <color2> [output_dir]
make_gif() {
  local file="$1" text="$2" bg="$3" c1="$4" c2="$5"
  local dest="${6:-$OUT}"
  mkdir -p "$dest"
  local dir="$TMP/$file"
  mkdir -p "$dir"
  for ((i=0;i<FRAMES;i++)); do
    # pulse size + wobble angle
    local size=$(( 74 + (i % 6) * 5 ))
    local angle=$(( (i % 2 == 0) ? -3 : 3 ))
    local color="$c1"
    (( i % 4 < 2 )) && color="$c2"
    local dy=$(( (i % 3) * 4 - 4 ))
    magick -size ${W}x${H} "xc:${bg}" \
      -gravity center -font "$FONT" -pointsize "$size" -fill "$color" \
      -stroke "rgba(0,0,0,0.55)" -strokewidth 3 -annotate "${angle}x0+0+${dy}" "$text" \
      -stroke none \
      "png:$dir/f_$(printf '%03d' "$i").png"
  done
  magick -delay 7 -loop 0 "$dir"/f_*.png -layers Optimize "$dest/$file"
  echo "  created $file"
}

echo "Generating GIF library in $OUT"
make_gif "thulla.gif"    "THULLA!"  "#7a0b12" "#ffd23f" "#ffffff"
make_gif "thulla-2.gif"  "THULLA!"  "#140b2e" "#ff3b3b" "#ffd23f"
make_gif "bruh.gif"      "BRUH"     "#1b1b1b" "#f0f0f0" "#9aa0a6"
make_gif "lol.gif"       "LOL"      "#0b3d2e" "#ffe066" "#7ee2a8"
make_gif "oof.gif"       "OOF"      "#2b0b3a" "#ff8bd6" "#ffffff"
make_gif "gg.gif"        "GG WP"    "#0b2a5b" "#8fd0ff" "#ffffff"
make_gif "rip.gif"       "RIP"      "#101010" "#e0e0e0" "#ff5252"
make_gif "noob.gif"      "NOOB"     "#3a2200" "#ffb020" "#ffffff"
make_gif "whoa.gif"      "WHOA!"    "#0b6e6e" "#ffffff" "#b2fefa"
make_gif "ohno.gif"      "OH NO"    "#5b0b2a" "#ffd23f" "#ff8ba7"
make_gif "bonk.gif"      "BONK!"    "#3d0b0b" "#ffdd57" "#ff6b6b"
make_gif "ez.gif"        "EZ"       "#123b12" "#b6ff7a" "#ffffff"
make_gif "sad.gif"       "SAD"      "#101820" "#7fb2ff" "#ffffff"
make_gif "gigachad.gif"  "CHAD"     "#1a1a1a" "#d4af37" "#ffffff"

# Bhabhi/loser GIFs shown on the game-over screen.
make_gif "bhabhi.gif"        "BHABHI!"  "#4a0b12" "#ffd23f" "#ffffff" "$OUT/bhabhi"
make_gif "bhabhi-cry.gif"    "SO SAD"   "#101820" "#7fb2ff" "#ffffff" "$OUT/bhabhi"
make_gif "bhabhi-thulla.gif" "THULLA!"  "#140b2e" "#ff3b3b" "#ffd23f" "$OUT/bhabhi"

# NOTE: this only writes the placeholder GIF art above. It deliberately does
# NOT touch public/gifs/manifest.json, so your custom labels (and any GIFs you
# replaced) are never clobbered. The server auto-discovers every file in the
# folder, and manifest.json is used only to override labels/order.
echo "Done."
echo "Add or replace GIFs by dropping files into: $OUT"
