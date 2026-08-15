#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: native/ios/apply-to-capacitor.sh /absolute/path/to/michikusa-app/ios" >&2
  exit 2
fi

IOS_ROOT=$1
SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP_DIR="$IOS_ROOT/App/App"
PROJECT="$IOS_ROOT/App/App.xcodeproj"
PLIST="$APP_DIR/Info.plist"

if [ ! -d "$PROJECT" ] || [ ! -f "$PLIST" ]; then
  echo "Capacitor iOS project was not found under: $IOS_ROOT" >&2
  exit 2
fi

cp "$SOURCE_DIR/DailyPhotoPlugin.swift" "$APP_DIR/DailyPhotoPlugin.swift"
cp "$SOURCE_DIR/SpotaBridgeViewController.swift" "$APP_DIR/SpotaBridgeViewController.swift"
cp "$SOURCE_DIR/SceneDelegate.swift" "$APP_DIR/SceneDelegate.swift"

PLIST_BUDDY=/usr/libexec/PlistBuddy
if ! "$PLIST_BUDDY" -c "Set :NSPhotoLibraryUsageDescription 選択した写真の追加と、許可した写真から1日1枚の思い出候補を端末内で選ぶために使います" "$PLIST" 2>/dev/null; then
  "$PLIST_BUDDY" -c "Add :NSPhotoLibraryUsageDescription string 選択した写真の追加と、許可した写真から1日1枚の思い出候補を端末内で選ぶために使います" "$PLIST"
fi
if ! "$PLIST_BUDDY" -c "Set :UIRequiresFullScreen true" "$PLIST" 2>/dev/null; then
  "$PLIST_BUDDY" -c "Add :UIRequiresFullScreen bool true" "$PLIST"
fi
"$PLIST_BUDDY" -c "Delete :UISupportedInterfaceOrientations" "$PLIST" 2>/dev/null || true
"$PLIST_BUDDY" -c "Add :UISupportedInterfaceOrientations array" "$PLIST"
"$PLIST_BUDDY" -c "Add :UISupportedInterfaceOrientations:0 string UIInterfaceOrientationPortrait" "$PLIST"
"$PLIST_BUDDY" -c "Delete :UISupportedInterfaceOrientations~ipad" "$PLIST" 2>/dev/null || true
"$PLIST_BUDDY" -c "Add :UISupportedInterfaceOrientations~ipad array" "$PLIST"
"$PLIST_BUDDY" -c "Add :UISupportedInterfaceOrientations~ipad:0 string UIInterfaceOrientationPortrait" "$PLIST"

ruby - "$PROJECT/project.pbxproj" <<'RUBY'
path = ARGV.fetch(0)
text = File.read(path)

unless text.include?("DailyPhotoPlugin.swift in Sources")
  build_files = <<~PBX.lines.map { |line| "\t\t#{line}" }.join
    A10D0001301F500000000001 /* DailyPhotoPlugin.swift in Sources */ = {isa = PBXBuildFile; fileRef = A10D0002301F500000000001 /* DailyPhotoPlugin.swift */; };
    A10D0003301F500000000001 /* SpotaBridgeViewController.swift in Sources */ = {isa = PBXBuildFile; fileRef = A10D0004301F500000000001 /* SpotaBridgeViewController.swift */; };
  PBX
  file_refs = <<~PBX.lines.map { |line| "\t\t#{line}" }.join
    A10D0002301F500000000001 /* DailyPhotoPlugin.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = DailyPhotoPlugin.swift; sourceTree = "<group>"; };
    A10D0004301F500000000001 /* SpotaBridgeViewController.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = SpotaBridgeViewController.swift; sourceTree = "<group>"; };
  PBX
  abort "PBXBuildFile section was not found" unless text.sub!("/* Begin PBXBuildFile section */\n", "/* Begin PBXBuildFile section */\n#{build_files}")
  abort "PBXFileReference section was not found" unless text.sub!("/* Begin PBXFileReference section */\n", "/* Begin PBXFileReference section */\n#{file_refs}")

  group_pattern = /(\t\t[0-9A-F]+ \/\* App \*\/ = \{\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = \(\n)/
  group_lines = "\t\t\t\tA10D0002301F500000000001 /* DailyPhotoPlugin.swift */,\n" \
                "\t\t\t\tA10D0004301F500000000001 /* SpotaBridgeViewController.swift */,\n"
  abort "App PBXGroup was not found" unless text.sub!(group_pattern) { Regexp.last_match(1) + group_lines }

  source_pattern = /(\t\t[0-9A-F]+ \/\* Sources \*\/ = \{\n\t\t\tisa = PBXSourcesBuildPhase;\n\t\t\tbuildActionMask = [0-9]+;\n\t\t\tfiles = \(\n)/
  source_lines = "\t\t\t\tA10D0001301F500000000001 /* DailyPhotoPlugin.swift in Sources */,\n" \
                 "\t\t\t\tA10D0003301F500000000001 /* SpotaBridgeViewController.swift in Sources */,\n"
  abort "App Sources phase was not found" unless text.sub!(source_pattern) { Regexp.last_match(1) + source_lines }
  File.write(path, text)
end
RUBY

echo "Applied Spota PhotoKit bridge and portrait-only configuration to $IOS_ROOT"
