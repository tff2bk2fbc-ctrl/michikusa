#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: native/ios/apply-to-capacitor.sh /absolute/path/to/michikusa-app/ios" >&2
  exit 2
fi

IOS_ROOT=$1
SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CAP_ROOT=$(CDPATH= cd -- "$IOS_ROOT/.." && pwd)
APP_DIR="$IOS_ROOT/App/App"
PROJECT="$IOS_ROOT/App/App.xcodeproj"
PLIST="$APP_DIR/Info.plist"
PACKAGE_JSON="$CAP_ROOT/package.json"

if [ ! -d "$PROJECT" ] || [ ! -f "$PLIST" ]; then
  echo "Capacitor iOS project was not found under: $IOS_ROOT" >&2
  exit 2
fi

ruby -rjson - "$PACKAGE_JSON" <<'RUBY'
path = ARGV.fetch(0)
abort "Capacitor package.json was not found: #{path}" unless File.file?(path)
package = JSON.parse(File.read(path))
deps = (package["dependencies"] || {}).merge(package["devDependencies"] || {})
unless deps.key?("@capacitor-firebase/messaging") && !deps.key?("@capacitor/push-notifications")
  abort <<~MESSAGE
    Replace the APNs-only iOS token plugin before applying the overlay:
      cd #{File.dirname(path)}
      npm uninstall @capacitor/push-notifications
      npm install @capacitor-firebase/messaging@8.4.0 firebase
  MESSAGE
end
RUBY

cp "$SOURCE_DIR/DailyPhotoPlugin.swift" "$APP_DIR/DailyPhotoPlugin.swift"
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
File.write(path, text)
RUBY

echo "Applied Spota PhotoKit bridge, Apple Sign In, Firebase Messaging, push presentation, and portrait-only configuration to $IOS_ROOT"
