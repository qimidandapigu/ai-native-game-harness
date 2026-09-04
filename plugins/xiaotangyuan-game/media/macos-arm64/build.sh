#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
module_cache=${TMPDIR:-/tmp}/xty-swift-module-cache
mkdir -p "$module_cache"
plutil -lint "$script_dir/Info.plist"
swiftc \
  -module-cache-path "$module_cache" \
  -target arm64-apple-macos14.0 \
  -swift-version 5 \
  -O \
  -framework AppKit \
  -framework ApplicationServices \
  -framework AVFoundation \
  -framework CoreGraphics \
  -framework ScreenCaptureKit \
  -Xlinker -sectcreate \
  -Xlinker __TEXT \
  -Xlinker __info_plist \
  -Xlinker "$script_dir/Info.plist" \
  "$script_dir/XtyMediaHost.swift" \
  -o "$script_dir/XtyMediaHost"
