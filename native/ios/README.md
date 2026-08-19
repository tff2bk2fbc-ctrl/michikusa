# Spota iOS native overlay

This directory is the source of truth for the small native layer that cannot live in `public/`.
It contains the one-photo-per-day PhotoKit bridge, its Capacitor registration, the required
`AppDelegate`/`SceneDelegate`, and an idempotent installer for a generated Capacitor iOS project.

Apply it after creating or updating the native project:

```sh
./native/ios/apply-to-capacitor.sh /absolute/path/to/michikusa-app/ios
```

The installer performs only these scoped changes:

- copies the four reviewed Swift sources into `App/App`;
- registers the two added Swift files in the `App` target without an extra Ruby gem;
- sets the photo-library explanation;
- limits iPhone and iPad to portrait orientation.

Then run `npx cap copy ios` for web assets and build the `App` scheme. The daily candidate
preview never permits an iCloud download. Only the explicit “use” action can retrieve the
full asset, through a one-use opaque token enforced by native code.
