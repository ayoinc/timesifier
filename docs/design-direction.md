# Design direction: the departure sheet

Written for TS-030, before the landing page was built. `docs/design-system.md` says how tokens and components work; this page says what they should look like and why. Where the two disagree about a value, this page wins and the tokens change through `scripts/tokens.ts`.

## Who it is for

People and small teams who bill or account for their time: a freelancer with several clients, a studio of five, someone who hands in a timesheet on Friday. They open Timesifier many times a day for a few seconds. They do not want to be motivated. They want the number to be right and easy to show to someone else.

## The feeling

A printed departure sheet in a railway station: the yellow page behind glass that says what leaves when. It is public, exact, read at a glance and trusted without thinking. Timesifier should feel like that: plain statements, columns of times that line up, and one loud colour. By day the product is the yellow sheet. By night it is the lit departure board: the same information, yellow on near-black.

## Type

One family in two widths, as a timetable is set.

- **Sofia Sans Condensed**, weights 700 and 800, for display, headlines and anything that is a time or a total. A condensed face is what makes a column of times fit on a sheet; set large and heavy it is also the voice of the page.
- **Sofia Sans**, weights 400 and 600, for everything that is read: body, labels, controls.

Both are by Lettersoup, under the SIL Open Font License 1.1, and are self-hosted from `app/fonts/` (`app/fonts/OFL.txt`). Numbers are always tabular. Display text is set tight, with a line height close to its size; body text keeps Material's 16/24. No italics, no second family, no monospace.

## Colour

One seed, `#FFD400`, through Material's fidelity scheme, which keeps the seed itself as a colour in both schemes.

| Role                          | Light                             | Dark                                |
| ----------------------------- | --------------------------------- | ----------------------------------- |
| `sheet` / `on-sheet`          | the yellow page, near-black type  | near-black board, yellow type       |
| `surface` / `on-surface`      | warm paper, brown-black ink       | warm black, pale paper-coloured ink |
| `primary` / `on-primary`      | ink, with yellow on it: an action | yellow, with ink on it              |
| `primary-container`           | yellow, for the one thing running | the same yellow                     |
| `outline`, `on-surface` rules | ink lines                         | pale lines                          |

Yellow marks two things only: the sheet (the hero and the closing band) and whatever is live (the running timer, the current day). Everything else is ink on paper, and an action is the reverse of the page it stands on: an ink button on paper and on the sheet, a yellow one on the board. There is no second accent colour; projects are told apart by name and position, not by a rainbow.

## Shape and space

Corners are small: 2 to 12px. A sheet of paper and an enamel sign do not have 28px corners. Structure comes from ruled lines, 1px between rows and 2px under a heading or above a total, not from cards and shadows. The 4px grid stays. Sections are separated by generous vertical space (24 units on a wide window) and each is laid out differently from the one before it.

## Imagery

- The product is shown as itself: real markup of a day's entries and a week's report, with example data whose totals are computed from the entries, never typed in. Nothing is shown that the product will not do: a timer, entries, projects and a weekly report.
- Photographs are of two subjects only: people's hands at the work that is being timed, and European railway platforms and their clocks. No faces to camera, no laptops with glowing dashboards, no staged meetings. They are unfiltered, cropped square-cornered, and captioned with where they are and who took them.
- Every image is a file in `public/images/`, in AVIF with a WebP fallback, with its width and height set. `public/images/CREDITS.md` records the source, author and licence of each.

## Three things this design refuses to do

1. **Invent proof.** No customer logos, testimonials, ratings, user counts or "trusted by" lines until they are real. The page argues from what the product does.
2. **Decorate.** No gradients, glows, glass, drop shadows on cards, floating badges, emoji, or icons standing in for an argument. If a section needs a visual, it is the product or a photograph.
3. **Round the number.** A duration is shown to the minute, in tabular figures, and a total on the page is always the sum of what is shown above it.

## References

Looked up on Mobbin on 11 November 2026, for structure, hierarchy, density and tone.

| Reference                                                                                                   | Taken                                                                                                     | Refused                                                                        |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [Harvest, home hero](https://mobbin.com/sites/sections/640cffbf-6670-4115-b398-dfd3dd40a816)                | The product's own day view directly under the headline: rows of project, note and duration, with a total. | The star rating and the email field in the hero.                               |
| [Harvest, "Time tracking software"](https://mobbin.com/sites/sections/661d5576-507a-4678-b016-03056d573685) | One point per section, with the visual beside the words.                                                  | Three icon-and-paragraph columns.                                              |
| [Toggl Track, home hero](https://mobbin.com/sites/sections/2d586b63-3145-4b6e-8546-6afab037aff5)            | Headline and action on the left, product on the right; a saturated ground that is the brand.              | The logo wall and "trusted by 5 million"; floating avatar chips.               |
| [Toggl Track, sign-up hero](https://mobbin.com/sites/sections/418fb790-1626-4350-b829-eaa50206e9ce)         | The timer bar as the single object that explains the product.                                             | A sign-up form with three providers in the hero.                               |
| [Toggl Track, timer](https://mobbin.com/screens/0377b3b9-d025-4acc-a063-dec579f16cc4)                       | "What are you working on?", project and elapsed time on one line; days of the week with their totals.     | The calendar grid as the default view, and a sidebar of fourteen destinations. |
| [Harvest, detailed time report](https://mobbin.com/screens/f1c84f2b-a306-4a83-800b-b7dfa3ad73b9)            | The report as a ledger: one large total, ruled rows, hours right-aligned.                                 | Checkbox and bulk-action chrome.                                               |
| [Bonsai, starting time tracking](https://mobbin.com/flows/d421b6de-84fd-4668-8279-10eb9613a5cf)             | The three states of a timer in order: ready, running, logged.                                             | A timer hidden in a popover.                                                   |
| [Toggl Track, accepting an invitation](https://mobbin.com/flows/b2df1053-3a88-44cb-b77f-851292c77db6)       | Arriving straight in the tool, on an empty week, after one screen.                                        | Confetti and a checklist for joining.                                          |
| [Linear, home hero](https://mobbin.com/sites/sections/40a46191-a57a-4bab-9a92-94fc14cad817)                 | One sentence, one button, the real product cut off by the fold.                                           | The dark gradient glow.                                                        |

## What follows from this in the product

The shell, the sign-in pages and every component take the same tokens, so they already have the type, the colours and the corners: a filled button in the application is the same ink-and-yellow button as the one on the home page. Still to do, on later cards: the Today page drawn as the day sheet shown on the home page; the week report as the ruled table; and a pass over the shell's surfaces, which are still laid out as a default Material application.
