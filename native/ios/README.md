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

Do not install `@capacitor/push-notifications` and `@capacitor-firebase/messaging` together.
The former returns an APNs token on iOS, while Spota's relay sends through FCM HTTP v1 and
therefore must register the FCM token returned by Firebase Messaging.

The installer performs only these scoped changes:

- checks that Firebase Messaging replaced the incompatible Push Notifications plugin;
- copies the four reviewed Swift sources into `App/App`;
- registers the two added Swift files in the `App` target without an extra Ruby gem;
- sets the photo-library explanation;
- configures Firebase Messaging presentation and SwiftPM symlink mode;
- disables Firebase Messaging auto-init until the user grants notification permission;
- limits iPhone and iPad to portrait orientation.

After `npx cap sync ios`, run `npx cap copy ios` whenever web assets change and build the
`App` scheme. The daily candidate
preview never permits an iCloud download. Only the explicit “use” action can retrieve the
full asset, through a one-use opaque token enforced by native code.
