#!/bin/sh
# STAC Browser (radiantearth/stac-browser) を、うちのカタログを見る設定でビルドする。
#
#   stac-browser/build.sh <STAC Browser のソース> <出力先>
#
# 環境変数:
#   SB_catalogUrl  カタログの URL (例: https://…/catalog.json)
#   SB_pathPrefix  配信するパス (例: /duck-geocoder/catalog/)
#
# ソースは CI が版を固定して取ってくる (deploy.yml)。ここでは取りに行かない。
#
# **パッチを1つ当てる** (items-base.patch)。うちの Collection は項目一覧を
# `rel: items` の相対パス (plateau-buildings-items.json) で指している。
# STAC Browser 5.1.0 は、カタログから辿って開いた Collection (先に読んで控えてあるもの) で、
# この相対パスを Collection ではなくページの URL を基準に解決し、404 になる
# (URL を直接開いたときは起きない)。上流で直ったらパッチを外す。
set -eu

src=$(cd "$1" && pwd)
out=$2
here=$(cd "$(dirname "$0")" && pwd)

: "${SB_catalogUrl:?カタログの URL (SB_catalogUrl) を指定してください}"
: "${SB_pathPrefix:?配信するパス (SB_pathPrefix) を指定してください}"

cd "$src"
git apply "$here/items-base.patch"
npm ci --no-audit --no-fund
SB_CONFIG="$here/config.mjs" npm run build

mkdir -p "$out"
cp -R dist/. "$out/"
# ソースマップは配信しない (51MB のうち 34MB を占める。直すのは上流なので、ここで読む人はいない)。
find "$out" -name '*.map' -delete
