# Spota v127 Design QA

- Source visual truth: `docs/qa/v127/motion50-reference.png`
- Rendered implementation crop: `docs/qa/v127/motion50-implementation.png`
- Combined comparison evidence: `docs/qa/v127/motion50-comparison.png`
- Native simulator evidence: `docs/qa/v127/simulator-launch.png`
- Browser viewport: 838 × 720 rendered pixels
- Source / normalized target region: 788 × 338 pixels
- State: Motion 50 typography and A option preview; light appearance

## Findings

- No actionable P0, P1, or P2 mismatch remains.
- Typography: the implementation preserves the reference's heavy grotesk character, two-line composition, tight negative tracking, compact line height, and near-edge scale. The system font stack gives the iOS build a native optical result without a new font download.
- Spacing and layout rhythm: both lines occupy the same visual block and retain the deliberately tight inter-line relationship. The right edge is intentionally close to the crop, matching the dynamic reference treatment.
- Colors and tokens: the implementation retains the cool, nearly white blue-gray surface and near-black type. The implementation surface is marginally lighter than the reference; this is a P3 polish difference and does not change hierarchy or readability.
- Image quality and assets: the supplied Spota image asset is reused in the option cards; no placeholder, emoji, CSS drawing, or newly fabricated logo replaces it.
- Copy and content: the preview keeps the reference headline and the production decision UI uses concise English `USE` and `PASS` semantics. Japanese explanatory copy stays outside the decision headline.
- Interaction: the A-option `USE` control was activated in the browser and the DOM announced `USEを選択しました`. The page emitted no warning or error console entries during the inspected state.
- Accessibility: visible action targets remain native buttons, the decision card retains keyboard support, and reduced-motion alternatives are present in production CSS and automated tests.

## Open Questions

- Real haptic weight cannot be judged in the simulator. The physical iPhone pass should tune only haptic intensity if needed; it should not change the approved timing or visual composition.

## Implementation Checklist

- [x] Match heavy display typography and tight line height.
- [x] Keep the bottom navigation structure unchanged while retaining the new material treatment.
- [x] Restrict production motion to the approved catalog range.
- [x] Keep #41 unchanged.
- [x] Provide Motion 50 as a separate three-option HTML preview and connect A to the daily-photo decision flow.
- [x] Confirm browser rendering, interaction state, console, automated tests, native sync, and simulator build.

## Follow-up Polish

- P3: after a physical-device review, the Motion 50 background tint may be moved slightly closer to the reference blue-gray if the warmer app surface feels too neutral on an OLED display.

## Comparison History

- Pass 1: the combined evidence shows no P0/P1/P2 differences. No visual fix was required after this comparison.
- Focused region comparison: the source target is already a focused typography crop, so the normalized 788 × 338 hero crop serves as both full-view and focused evidence. No smaller crop was necessary to judge letter weight, tracking, line height, or edge spacing.

final result: passed
