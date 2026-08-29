# Spota iOS native overlay

This directory is the source of truth for the small native layer that cannot live in `public/`.
It contains the one-photo-per-day PhotoKit bridge, its Capacitor registration, the required
`AppDelegate`/`SceneDelegate`, and an idempotent installer for a generated Capacitor iOS project.

Apply it after creating or updating the native project:

```sh
cd /absolute/path/to/michikusa-app
npm uninstall @capacitor/push-notifications
npm install @capacitor-firebase/messaging@8.4.0 firebase

cd /absolute/path/to/michikusa
./native/ios/apply-to-capacitor.sh /absolute/path/to/michikusa-app/ios

cd /absolute/path/to/michikusa-app
npx cap sync ios
```

`apply-to-capacitor.sh` first mirrors this repository's current `public/` into the
Capacitor root `public/`, including removal of obsolete web files. This prevents Xcode
from silently packaging stale JavaScript when the GitHub source has changed.

Do not install `@capacitor/push-notifications` and `@capacitor-firebase/messaging` together.
The former returns an APNs token on iOS, while Spota's relay sends through FCM HTTP v1 and
therefore must register the FCM token returned by Firebase Messaging.

The installer performs only these scoped changes:

- checks that Firebase Messaging replaced the incompatible Push Notifications plugin;
- stops before changing files when `GoogleService-Info.plist` is missing;
- mirrors the reviewed repository `public/` into the Capacitor web directory;
- copies the four reviewed Swift sources into `App/App`;
- registers the two added Swift files in the `App` target without an extra Ruby gem;
- sets the photo-library explanation;
- configures Firebase Messaging presentation and SwiftPM symlink mode;
- disables Firebase Messaging auto-init until the user grants notification permission;
- configures the default Firebase app before Capacitor plugins start;
- keeps the native launch artwork above the WebView until `boot.js` reports that the
  first visual frame has been prepared, with a 12-second fail-safe so a broken page
  cannot trap the user on the cover;
- registers `spota.caf` as an app resource when that sound file is present;
- limits iPhone and iPad to portrait orientation.

After applying the overlay, run `npx cap sync ios` and build the `App` scheme. Re-run the
same two commands whenever web assets change. The daily candidate
preview never permits an iCloud download. Only the explicit “use” action can retrieve the
full asset, through a one-use opaque token enforced by native code.
