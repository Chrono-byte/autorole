# IU digital color research

Research checked 2026-11-01. Scope: Indiana University brand colors in digital interfaces, accessible combinations, and methods for measuring color differences.

## Brand values and tolerances

- IU directs designers to use its hex values for digital RGB work, retain primary cream and crimson in palettes, keep primary colors dominant, and check contrast. IU describes its primary cream as effectively white in most design executions. [IU brand color guidance](https://brand.iu.edu/iu-brand/visual-identity/color.html)
- An IU Indianapolis promotional toolkit specifies crimson `#990000`, dark crimson `#4C1213`, and light crimson `#DD0031`; these are distinct named palette colors, not documented tolerance bounds or automatically accessible substitutes. [IU Indianapolis promotional toolkit](https://profiles.indianapolis.iu.edu/faculty-staff-resources/promotional-toolkit/index.html)
- No numerical digital color tolerance, permitted hex deviation, or ΔE acceptance threshold was found in the reviewed IU brand guidance. Use published values as targets; obtain an explicit tolerance from IU brand owners before treating a deviation as approved.

## Accessibility variants

- Choose foreground and background together, and test the actual pairing. WCAG 2.2 AA generally requires at least 4.5:1 for text and 3:1 for large text; exceptions include inactive or decorative content and logotypes. Required visual information for user interface components and graphical objects generally needs 3:1 against adjacent colors, subject to the criterion's exceptions. [WCAG 2.2, 1.4.3 and 1.4.11](https://www.w3.org/TR/WCAG22/#contrast-minimum)
- IU's [Rivet color utilities](https://rivet.iu.edu/utilities/color/) provide named digital shades and a contrast checker; they are design-system choices, not evidence that arbitrary shades are approved brand replacements. IU also says not to convey information using color alone. [IU accessibility guidance](https://accessibility.iu.edu/creating-content/web-content/styling.html)
- WCAG contrast uses relative luminance, `(Lighter + 0.05) / (Darker + 0.05)`, with linearized sRGB channels. It assesses a color pair, not brand fidelity or perceptual color difference. [W3C contrast explanation](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum)

## Color measurement

- [ISO/CIE 11664-6:2022](https://cie.co.at/publications/colorimetry-part-6-ciede2000-colour-difference-formula-1) defines CIEDE2000, a color-difference formula based on CIELAB; it does not establish an IU-specific pass threshold. Specify the color-space conversion, white reference, viewing conditions, and acceptance threshold when reporting ΔE. CIE distinguishes object-color difference from light-source chromaticity difference. [CIE technical note](https://cie.co.at/files/CIE_TN_001-2014.pdf)
- CIE recommends CIELAB or CIEDE2000 for comparing pairs of images displayed side by side in the same medium under the same illumination conditions. This is a measurement method, not an authorization to alter an IU color. [CIE image-difference report](https://www.cie.co.at/publications/methods-evaluating-colour-differences-images)

## Limitations

IU's central brand page embeds palette swatches in its HTML: primary Crimson `#990000` and secondary Light Crimson `#F41C40`, Dark Crimson `#6D0808`, Light Cream `#F8EFE2`, Dark Cream `#F5E3CC`, Light Gray `#EEEEF0`, Dark Gray `#B9C1C6`, and IU Black `#072332`. The promotional toolkit lists additional values in its specific context. An IU training page gives a conflicting crimson value (`#7D110C`), so confirm current canonical values and any exception policy with IU brand owners before implementation. [IU training page](https://ittrainingcontent.iu.edu/training/htmba/files/pc/introducing-css.html) The full ISO/CIE standard is sold by CIE; its public summary, not the complete normative text, was reviewed. Actual display appearance varies with device and color management, and passing contrast does not establish brand approval.
