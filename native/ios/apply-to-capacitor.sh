#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: native/ios/apply-to-capacitor.sh /absolute/path/to/michikusa-app/ios" >&2
  exit 2
fi

IOS_ROOT=$1
SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SOURCE_DIR/../.." && pwd)
CAP_ROOT=$(CDPATH= cd -- "$IOS_ROOT/.." && pwd)
APP_DIR="$IOS_ROOT/App/App"
PROJECT="$IOS_ROOT/App/App.xcodeproj"
PLIST="$APP_DIR/Info.plist"
FIREBASE_CONFIG="$APP_DIR/GoogleService-Info.plist"
PACKAGE_JSON="$CAP_ROOT/package.json"
CAP_CONFIG="$CAP_ROOT/capacitor.config.json"
WEB_SOURCE="$REPO_ROOT/public"

if [ ! -d "$PROJECT" ] || [ ! -f "$PLIST" ]; then
  echo "Capacitor iOS project was not found under: $IOS_ROOT" >&2
  exit 2
fi
if [ ! -f "$FIREBASE_CONFIG" ]; then
  echo "Firebase iOS configuration was not found: $FIREBASE_CONFIG" >&2
  exit 2
fi

ruby -rjson - "$PACKAGE_JSON" "$CAP_CONFIG" <<'RUBY'
package_path = ARGV.fetch(0)
config_path = ARGV.fetch(1)
abort "Capacitor package.json was not found: #{package_path}" unless File.file?(package_path)
abort "Capacitor config was not found: #{config_path}" unless File.file?(config_path)
package = JSON.parse(File.read(package_path))
config = JSON.parse(File.read(config_path))
deps = (package["dependencies"] || {}).merge(package["devDependencies"] || {})
unless deps.key?("@capacitor-firebase/messaging") && !deps.key?("@capacitor/push-notifications")
  abort <<~MESSAGE
    Replace the APNs-only iOS token plugin before applying the overlay:
      cd #{File.dirname(package_path)}
      npm uninstall @capacitor/push-notifications
      npm install @capacitor-firebase/messaging@8.4.0 firebase
  MESSAGE
end
unless config["appId"] == "com.damo.michikusa" && config["webDir"] == "public"
  abort "Refusing to replace web assets: expected appId=com.damo.michikusa and webDir=public"
end
RUBY

if [ ! -d "$WEB_SOURCE" ]; then
  echo "Repository web assets were not found under: $WEB_SOURCE" >&2
  exit 2
fi

# GitHub側のpublic/を唯一のWeb資産ソースとし、削除済みの古いJSも残さない。
# npx cap sync ios はCAP_ROOT/publicしか見ないため、その直前に必ず揃える。
mkdir -p "$CAP_ROOT/public"
rsync -a --delete "$WEB_SOURCE/" "$CAP_ROOT/public/"

cp "$SOURCE_DIR/DailyPhotoPlugin.swift" "$APP_DIR/DailyPhotoPlugin.swift"
cp "$SOURCE_DIR/SpotaHapticsPlugin.swift" "$APP_DIR/SpotaHapticsPlugin.swift"
cp "$SOURCE_DIR/SpotaBridgeViewController.swift" "$APP_DIR/SpotaBridgeViewController.swift"
cp "$SOURCE_DIR/SceneDelegate.swift" "$APP_DIR/SceneDelegate.swift"
cp "$SOURCE_DIR/AppDelegate.swift" "$APP_DIR/AppDelegate.swift"
cp "$SOURCE_DIR/App.entitlements" "$APP_DIR/App.entitlements"

ruby -rjson - "$IOS_ROOT/../capacitor.config.json" "$APP_DIR/capacitor.config.json" <<'RUBY'
ARGV.each do |path|
  next unless File.file?(path)
  config = JSON.parse(File.read(path))
  plugins = config["plugins"] ||= {}
  auth = plugins["FirebaseAuthentication"] ||= {}
  auth["providers"] = ["apple.com", "google.com"]
  # iOSのPushNotifications pluginはAPNs tokenを返すため、FCM HTTP v1の
  # 宛先登録にはFirebaseMessaging pluginを使用する。
  plugins.delete("PushNotifications")
  messaging = plugins["FirebaseMessaging"] ||= {}
  messaging["presentationOptions"] = ["badge", "sound", "alert"]
  experimental = config["experimental"] ||= {}
  ios = experimental["ios"] ||= {}
  spm = ios["spm"] ||= {}
  options = spm["packageOptions"] ||= {}
  options["@capacitor-firebase/messaging"] = {"symlink" => true}
  File.write(path, JSON.pretty_generate(config) + "\n")
end
RUBY

PLIST_BUDDY=/usr/libexec/PlistBuddy
if ! "$PLIST_BUDDY" -c "Set :NSPhotoLibraryUsageDescription 選択した写真の追加と、許可した写真から1日1枚の思い出候補を端末内で選ぶために使います" "$PLIST" 2>/dev/null; then
  "$PLIST_BUDDY" -c "Add :NSPhotoLibraryUsageDescription string 選択した写真の追加と、許可した写真から1日1枚の思い出候補を端末内で選ぶために使います" "$PLIST"
fi
if ! "$PLIST_BUDDY" -c "Set :UIRequiresFullScreen true" "$PLIST" 2>/dev/null; then
  "$PLIST_BUDDY" -c "Add :UIRequiresFullScreen bool true" "$PLIST"
fi
# 初回説明で利用者が通知を許可する前に、FCM identifierを自動発行・送信しない。
# FirebaseMessaging.getToken()は、許可後の明示操作でauto-initを再度有効にする。
if ! "$PLIST_BUDDY" -c "Set :FirebaseMessagingAutoInitEnabled false" "$PLIST" 2>/dev/null; then
  "$PLIST_BUDDY" -c "Add :FirebaseMessagingAutoInitEnabled bool false" "$PLIST"
fi
"$PLIST_BUDDY" -c "Delete :UISupportedInterfaceOrientations" "$PLIST" 2>/dev/null || true
"$PLIST_BUDDY" -c "Add :UISupportedInterfaceOrientations array" "$PLIST"
"$PLIST_BUDDY" -c "Add :UISupportedInterfaceOrientations:0 string UIInterfaceOrientationPortrait" "$PLIST"
"$PLIST_BUDDY" -c "Delete :UISupportedInterfaceOrientations~ipad" "$PLIST" 2>/dev/null || true
"$PLIST_BUDDY" -c "Add :UISupportedInterfaceOrientations~ipad array" "$PLIST"
"$PLIST_BUDDY" -c "Add :UISupportedInterfaceOrientations~ipad:0 string UIInterfaceOrientationPortrait" "$PLIST"

ruby - "$PROJECT/project.pbxproj" "$APP_DIR/spota.caf" <<'RUBY'
path = ARGV.fetch(0)
sound_path = ARGV.fetch(1)
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

unless text.include?("SpotaHapticsPlugin.swift in Sources")
  build_file = "\t\tA10D0008301F500000000001 /* SpotaHapticsPlugin.swift in Sources */ = {isa = PBXBuildFile; fileRef = A10D0009301F500000000001 /* SpotaHapticsPlugin.swift */; };\n"
  file_ref = "\t\tA10D0009301F500000000001 /* SpotaHapticsPlugin.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = SpotaHapticsPlugin.swift; sourceTree = \"<group>\"; };\n"
  abort "PBXBuildFile section was not found" unless text.sub!("/* Begin PBXBuildFile section */\n", "/* Begin PBXBuildFile section */\n#{build_file}")
  abort "PBXFileReference section was not found" unless text.sub!("/* Begin PBXFileReference section */\n", "/* Begin PBXFileReference section */\n#{file_ref}")

  group_pattern = /(\t\t[0-9A-F]+ \/\* App \*\/ = \{\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = \(\n)/
  abort "App PBXGroup was not found" unless text.sub!(group_pattern) { Regexp.last_match(1) + "\t\t\t\tA10D0009301F500000000001 /* SpotaHapticsPlugin.swift */,\n" }

  source_pattern = /(\t\t[0-9A-F]+ \/\* Sources \*\/ = \{\n\t\t\tisa = PBXSourcesBuildPhase;\n\t\t\tbuildActionMask = [0-9]+;\n\t\t\tfiles = \(\n)/
  abort "App Sources phase was not found" unless text.sub!(source_pattern) { Regexp.last_match(1) + "\t\t\t\tA10D0008301F500000000001 /* SpotaHapticsPlugin.swift in Sources */,\n" }
  File.write(path, text)
end

unless text.include?("App.entitlements")
  file_ref = "\t\tA10D0005301F500000000001 /* App.entitlements */ = {isa = PBXFileReference; lastKnownFileType = text.plist.entitlements; path = App.entitlements; sourceTree = \"<group>\"; };\n"
  abort "PBXFileReference section was not found" unless text.sub!("/* Begin PBXFileReference section */\n", "/* Begin PBXFileReference section */\n#{file_ref}")
  group_pattern = /(\t\t[0-9A-F]+ \/\* App \*\/ = \{\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = \(\n)/
  abort "App PBXGroup was not found" unless text.sub!(group_pattern) { Regexp.last_match(1) + "\t\t\t\tA10D0005301F500000000001 /* App.entitlements */,\n" }
end

unless text.include?("CODE_SIGN_ENTITLEMENTS = App/App.entitlements;")
  text.gsub!("CODE_SIGN_STYLE = Automatic;", "CODE_SIGN_ENTITLEMENTS = App/App.entitlements;\n\t\t\t\tCODE_SIGN_STYLE = Automatic;")
end

unless text.include?("com.apple.SignInWithApple")
  marker = "\t\t\t\t\t\tProvisioningStyle = Automatic;"
  capability = "\t\t\t\t\t\tSystemCapabilities = {\n" \
               "\t\t\t\t\t\t\tcom.apple.SignInWithApple = { enabled = 1; };\n" \
               "\t\t\t\t\t\t};\n" \
               "#{marker}"
  abort "App target attributes were not found" unless text.sub!(marker, capability)
end

unless text.include?("com.apple.Push")
  marker = "\t\t\t\t\t\t\tcom.apple.SignInWithApple = { enabled = 1; };"
  replacement = marker + "\n\t\t\t\t\t\t\tcom.apple.Push = { enabled = 1; };"
  abort "Apple Sign In capability marker was not found" unless text.sub!(marker, replacement)
end

if File.file?(sound_path) && !text.include?("spota.caf in Resources")
  build_file = "\t\tA10D0006301F500000000001 /* spota.caf in Resources */ = {isa = PBXBuildFile; fileRef = A10D0007301F500000000001 /* spota.caf */; };\n"
  file_ref = "\t\tA10D0007301F500000000001 /* spota.caf */ = {isa = PBXFileReference; lastKnownFileType = file; path = spota.caf; sourceTree = \"<group>\"; };\n"
  abort "PBXBuildFile section was not found" unless text.sub!("/* Begin PBXBuildFile section */\n", "/* Begin PBXBuildFile section */\n#{build_file}")
  abort "PBXFileReference section was not found" unless text.sub!("/* Begin PBXFileReference section */\n", "/* Begin PBXFileReference section */\n#{file_ref}")

  group_pattern = /(\t\t[0-9A-F]+ \/\* App \*\/ = \{\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = \(\n)/
  abort "App PBXGroup was not found" unless text.sub!(group_pattern) { Regexp.last_match(1) + "\t\t\t\tA10D0007301F500000000001 /* spota.caf */,\n" }

  resources_pattern = /(\t\t[0-9A-F]+ \/\* Resources \*\/ = \{\n\t\t\tisa = PBXResourcesBuildPhase;\n\t\t\tbuildActionMask = [0-9]+;\n\t\t\tfiles = \(\n)/
  abort "App Resources phase was not found" unless text.sub!(resources_pattern) { Regexp.last_match(1) + "\t\t\t\tA10D0006301F500000000001 /* spota.caf in Resources */,\n" }
end

# Xcodeの画面名欄へ誤って貼り付けられた改行付きコマンドを除去する。
text.gsub!(/^(\s*)INFOPLIST_KEY_CFBundleDisplayName = .*;$/, '\\1INFOPLIST_KEY_CFBundleDisplayName = spota;')
File.write(path, text)
RUBY

echo "Synchronized current web assets and applied Spota native configuration to $IOS_ROOT"
