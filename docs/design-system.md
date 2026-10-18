# Design system

The interface follows one visual language across the staff app, the sign-in
pages and the customer portal: a very light grey page, white pill clusters
and cards, near-black type, muted secondary text, and a single orange
accent. The dark theme is a deliberate second palette, not an inversion.

## Tokens

Everything is defined once in `src/app/globals.css` and consumed through the
ordinary Tailwind utilities, so `bg-slate-50`, `text-slate-500`,
`border-slate-200` and `bg-brand-500` are the only names most components use.

| Token | Light | Dark | Used for |
| --- | --- | --- | --- |
| `page` | `#F3F2F5` | `#141316` | application background |
| `surface` | `#FFFFFF` | `#1C1B20` | cards, pills, inputs on focus |
| `slate-50` | `#F7F6F8` | `#222126` | muted tiles, input backgrounds |
| `slate-200` | `#E7E5EA` | `#2F2E34` | hairline borders |
| `slate-500` | `#85838B` | `#918F98` | secondary text |
| `slate-900` / `fg` | `#242329` | `#F2F1F4` | primary text |
| `brand-500` | `#F4512C` | `#F4512C` | primary actions, highlights, feature cards |
| `selection` / `selection-fg` | `#211F24` / white | `#F2F1F4` / `#1A191D` | the active pill in any pill group |

Radii: `rounded-lg` 12px for inputs and tiles, `rounded-xl` 16px for cards,
`rounded-2xl` 20px for dialogs, `rounded-full` for every button and pill.
Shadows: `shadow-lift` (a 1px lift under a white segment) and `shadow-pop`
(menus and dialogs). Cards have a hairline border and no shadow.

Type: Inter (self-hosted through `@fontsource-variable/inter`), 14px base.
Page titles are 26px semibold with tight tracking; card titles 15px; body
and controls 13px; table headers 11px uppercase. Numbers use tabular
figures and tight tracking.

## Shell

* **Icon rail** (`AppShell`): a 68px column of white pill clusters. Theme
  (light / dark / system) at the top, one icon per module in the middle,
  notifications and sign-out at the bottom. The active module is the dark
  selection pill; labels appear as tooltips. On small screens the rail
  becomes a drawer with labels.
* **Top bar**: the brand pill, the current module's section pills in the
  centre, a utility cluster (search, notifications, security) and the
  account pill with a menu. Section pills come from
  `src/components/nav-config.ts`, filtered by role; sections that do not fit
  move into a "More" menu. Modules without sections show their own name.
* **Search** is a command dialog (Ctrl / ⌘ K) rather than a persistent field.
* **Page transitions**: routes cross-fade with a touch of blur
  (`PageTransition`); cards rise in with a short stagger (`card-rise`);
  tabs and pills slide their active background with Framer Motion. All
  motion respects `prefers-reduced-motion`.

## Components (`src/components/ui`)

* `Button` / `ButtonLink` / `buttonClass`: pill buttons. `primary` is orange
  and reserved for the main action on a view, `dark` is the selection colour,
  `secondary` the quiet white pill, `ghost` for toolbars.
* `PillNav`: a row of pill links with a sliding active pill and overflow
  handling. Used by the top bar, record-page sections and nested settings.
* `Tabs`: a segmented control on a muted track with a sliding white segment.
* `Card`: white surface with a compact title row. `Stat` is a stand-alone
  metric card; `MiniStat` a muted tile inside a card grid (`accent` renders
  the orange tile); `FeatureCard` is the orange gradient card with eyebrow,
  large number, hatched progress bar, supporting facts and a white action.
* `AnimatedNumber`: counts up to its value on mount (money, integer or
  decimal), rendered server-side with the final value.
* `Badge`: small tinted labels with no outline. `Alert`: tinted boxes
  without borders. `Dialog`, dropdowns (`.menu` / `.menu-item`) and toasts
  use `shadow-pop`.
* Inputs (`.input`): soft grey background, hairline border, white on focus
  with a faint orange ring; 36px tall. Filter bars use pill-shaped search
  fields and selects.
* `Skeleton` / `PageSkeleton`: soft placeholders used by the route-level
  `loading.tsx`.

## Rules of thumb

* Orange is for the main action, selected states, data highlights and
  feature cards. Links are dark and turn orange on hover (`.link`).
* The active item of any group is the dark selection pill; segmented tabs
  use the white segment on a muted track.
* No drop shadows on cards, no gradients outside feature surfaces, no
  uppercase labels except table headers and description lists.
* Leave space between sections (gap 16px) and keep it tight inside a card.
