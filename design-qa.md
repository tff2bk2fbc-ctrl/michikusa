# Spota Design QA

## v129 / Liquid Glass production integration

- Result: passed
- Record: `docs/qa/v129/README.md`
- Scope: bottom navigation, search, notifications/messages, profile/settings materials, selection suppression, horizontal navigation gesture, and map drag/tap separation
- Automated regression: 144/144 passed
- Dedicated interaction/contrast checks: 9/9 passed

---

## v128 / Motion 50 B

- Source visual truth, KEEP state: `docs/qa/v128/motion50-b-reference.png`
- Source visual truth, NOT state: `docs/qa/v128/motion50-b-reference-not.png`
- Rendered production implementation: `docs/qa/v128/motion50-b-implementation.png`
- Focused production KEEP state: `docs/qa/v128/motion50-b-implementation-keep.png`
- Focused production NOT state: `docs/qa/v128/motion50-b-implementation-not.png`
- Combined comparison evidence: `docs/qa/v128/motion50-b-comparison.png`
- Browser render: Codex in-app browser, 838 × 720 screenshot surface
- Production frame under review: two 390 × 700 iPhone-width states
- State: light appearance; B / Corner Split; `KEEP THIS` and `NOT THIS`

## Findings

- No actionable P0, P1, or P2 mismatch remains.
- Typography: production keeps B's heavy system grotesk, two-line display text, `.82` line height, `-.075em` tracking, lowercase wording, and decisive corner placement. `KEEP THIS` enters from the upper-left; `NOT THIS` mirrors it from the upper-right.
- Spacing and layout rhythm: the production card deliberately fills more of the phone than the three-option gallery card. The corner offsets, card radius, action order, and two-column decision layout preserve B's hierarchy while adapting it to the full-screen daily-photo task. This is an intentional product-context adjustment, not design drift.
- Colors and tokens: the cool blue-gray surface, near-black type, white card, translucent controls, dark primary action, subtle rim, and shadow hierarchy remain consistent with the selected B preview and the app's existing light theme.
- Image quality and assets: the existing Spota image asset is rendered at native sharpness with `object-fit: cover`. No placeholder, emoji, CSS drawing, fabricated logo, or external image source was introduced.
- Copy and content: visible production labels are exactly `NOT THIS` and `KEEP THIS`; display verdicts are `not this.` and `keep this.`. The visual label is included in each accessible name before the Japanese explanation.
- Interaction: the B preview's `KEEP THIS` and `NOT THIS` controls were both exercised. The selected state remained in the correct corner, and automated flow tests verify right/right-up or ArrowRight accepts while left or ArrowLeft passes.
- Motion: visual movement retains the approved 260 ms decisive exit and one threshold haptic. Reduced-motion mode removes the large exit transform and immediately advances after the opacity response.
- Accessibility: production and comparison-preview cards retain `pan-y pinch-zoom`; production also has a visible focus indicator, forced-colors fallback, button alternatives, ArrowLeft/ArrowRight support, progress/instruction descriptions, a polite atomic status region, and pointer-cancel recovery. Both production and preview advance without a motion delay when Reduced Motion is enabled.
- Browser console: no warning or error entries were emitted by the source preview, production render, or combined comparison page.

## Open Questions

- The physical weight of the haptic cannot be judged in the browser or iOS Simulator. Only its call site, threshold, debounce, and non-duplication can be verified automatically.

## Implementation Checklist

- [x] Move the selection badge from A to B.
- [x] Connect B / Corner Split to the production daily-photo deck.
- [x] Keep `KEEP THIS` on the left display corner and right/accept action.
- [x] Keep `NOT THIS` on the right display corner and left/pass action.
- [x] Preserve the right/right-up accept and left pass gesture mapping.
- [x] Preserve one haptic at the decision threshold.
- [x] Prevent uploads before acceptance.
- [x] Cancel the accepted-photo handoff if the authenticated account changes during the native read.
- [x] Verify keyboard, touch, reduced-motion, status announcement, focus, and forced-colors states.
- [x] Compare source and implementation in the same combined visual input.

## Follow-up Polish

- P3: tune only the physical haptic intensity after an iPhone review if the current rigid pulse feels too sharp or too soft.

## Comparison History

- Pre-pass accessibility review found four P2 issues: the production card lacked a visible focus indicator; its English button labels were absent from their accessible names; the preview did not preserve pinch zoom; and its Reduced Motion path retained a 300 ms wait. All four were fixed before release approval.
- Visual pass 1: combined KEEP/NOT evidence showed no remaining P0/P1/P2 mismatch. Production's wider card is an intentional full-screen adaptation; B's typography, corners, decision ordering, materials, and interaction semantics remain faithful.
- Focused-region pass: both verdict corners, action labels, card crop, image sharpness, display weight, tracking, and line height were readable in the four-panel comparison, so no smaller crop was needed.

final result: passed
