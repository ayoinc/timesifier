# Design direction: the departure sheet

Written for TS-030: first before the landing page was built, then extended as the owner saw the page and asked for more (the mark, the mindset, anatomy figures, the convention for the product screens, and the audit of the page's claims). `docs/design-system.md` says how tokens and components work; this page says what they should look like and why. Where the two disagree about a value, this page wins and the tokens change through `scripts/tokens.ts`.

## Who it is for

People and small teams who bill or account for their time: a freelancer with several clients, a studio of five, someone who hands in a timesheet on Friday. They open Timesifier many times a day for a few seconds. They do not want to be motivated. They want the number to be right and easy to show to someone else.

## The feeling

A printed departure sheet in a railway station: the yellow page behind glass that says what leaves when. It is public, exact, read at a glance and trusted without thinking. Timesifier should feel like that: plain statements, columns of times that line up, and one loud colour. By day the product is the amber sheet. By night it is the lit departure board: the same information, amber on near-black.

## Type

One family in two widths, as a timetable is set.

- **Sofia Sans Condensed**, weights 700 and 800, for display, headlines and anything that is a time or a total. A condensed face is what makes a column of times fit on a sheet; set large and heavy it is also the voice of the page.
- **Sofia Sans**, weights 400 and 600, for everything that is read: body, labels, controls.

Both are by Lettersoup, under the SIL Open Font License 1.1, and are self-hosted from `app/fonts/` (`app/fonts/OFL.txt`). Numbers are always tabular. Display text is set tight, with a line height close to its size; body text keeps Material's 16/24. No italics, no second family, no monospace.

## Colour

Two colours are given, and both come from the product's mark ("The mark", below): the amber of its arrowhead, `#FEAD05`, and the charcoal of its T, `#252A2F`. The owner chose the mark after seeing the first version of this page, which was built on a lemon yellow (`#FFD400`) and a brown-black ink. One product has one yellow, so the tokens moved to the mark and not the other way round:

- **The seed is the amber.** Every colour role in both schemes is derived from it through Material's fidelity scheme, which keeps the seed itself as `primary-container` in both. The paper, the outlines and the dark scheme's surfaces are all tints of it.
- **The ink is the charcoal.** It is the one colour not derived from the seed: `INK_COLOUR` in `scripts/tokens.ts`. It is the text on paper in the light scheme, and the text on amber in both. Charcoal on the amber measures 7.7:1 and on the paper 13.6:1; `scripts/tokens.test.ts` holds every pair above 4.5:1.
- **The dark scheme's ground stays derived**, a warm near-black, and is not the charcoal. The charcoal on a tile is the icon ("The mark"); as a whole page it is colder than the paper it would be the night of.

| Role                          | Light                            | Dark                                |
| ----------------------------- | -------------------------------- | ----------------------------------- |
| `sheet` / `on-sheet`          | the amber page, charcoal type    | near-black board, amber type        |
| `surface` / `on-surface`      | warm paper, charcoal ink         | warm black, pale paper-coloured ink |
| `primary` / `on-primary`      | ink, with amber on it: an action | amber, with ink on it               |
| `primary-container`           | amber, for the one thing running | the same amber                      |
| `outline`, `on-surface` rules | ink lines                        | pale lines                          |

Amber marks two things only: the sheet (the band at the top, the hero and the closing band of a public page) and whatever is live (the running timer, the current day). Everything else is ink on paper, and an action is the reverse of the page it stands on: an ink button on paper and on the sheet, an amber one on the board. There is no second accent colour: Material's tertiary roles take the values of the secondary ones, and projects are told apart by name and position, not by a rainbow.

The browser's own frame takes the sheet's colour: `pnpm tokens` writes it to `app/styles/theme-colour.ts` for the page's `theme-color`, so it cannot drift from the tokens.

## Shape and space

Corners are small: 2 to 24px on Material's step names, and 8px or less on anything that holds rows or type. A sheet of paper and an enamel sign do not have 28px corners. Structure comes from ruled lines, 1px between rows and 2px under a heading or above a total, not from cards and shadows. The 4px grid stays. Sections are separated by generous vertical space (24 units on a wide window) and each is laid out differently from the one before it.

## Imagery

- The product is shown as itself: real markup of a day's entries and a week's report, with example data whose totals are computed from the entries, never typed in. Nothing is shown that the product will not do: a timer, entries, projects and a weekly report. Every such drawing carries the word "Example".
- How something works is drawn as an anatomy figure ("Anatomy figures", below), not described in a paragraph and not illustrated by a stock picture.
- Photographs are of two subjects only: people's hands at the work that is being timed, and European railway platforms and their clocks. No faces to camera, no laptops with glowing dashboards, no staged meetings. They are unfiltered, cropped square-cornered, and captioned with where they are and who took them.
- Every image is a file in `public/images/`, in AVIF with a WebP fallback, with its width and height set. `public/images/CREDITS.md` records the source, author and licence of each.

## Three things this design refuses to do

1. **Invent proof.** No customer logos, testimonials, ratings, user counts or "trusted by" lines until they are real. The page argues from what the product does.
2. **Decorate.** No gradients, glows, glass, drop shadows on cards, floating badges, emoji, or icons standing in for an argument. If a section needs a visual, it is the product or a photograph.
3. **Round the number.** A duration is shown to the minute, in tabular figures, and a total on the page is always the sum of what is shown above it.

## The mark

The owner's mark: a charcoal letter T cut on a slant into two rounded bars, with an amber arrowhead at its upper right pointing forward. It was supplied as a drawing on white and traced, not redrawn: the outline in `app/components/mark-paths.ts` differs from the owner's file on 0.056% of the pixels inside the mark.

**Construction.** Three shapes, each of straight edges joined by circular corners, on a box 855.2 wide and 631.1 high (one unit is one pixel of the owner's drawing). The bar and the stem lean the same way; each has two large corners (radius about 60 and, on the stem, 66 and 46) and two small ones (about 20). The arrowhead's tip has a radius of 50 and its two other corners about 21 and 23. The gap between bar and stem is 5% of the mark's height, and between the T and the arrowhead 5.6%. None of these is to be adjusted: the source is not geometrically regular (the bar's two slanted ends are 4° apart) and the trace keeps it as drawn.

**The two colours.** Sampled from the owner's file: charcoal `#252A2F` and amber `#FEAD05`. They are the ink and the seed of the whole product ("Colour").

- On paper, in either scheme: the T in the text colour, the arrowhead in `primary-container` (the amber). In the dark scheme the T is therefore the pale ink, which is the scheme's own recolouring and the only one allowed.
- On the amber band, where an amber arrowhead would not show: the whole mark in the band's ink, one colour (`tone="one"`).
- As an icon: the mark in white and amber on a charcoal tile, which reads on a light tab strip and a dark one.

**Clear space.** Nothing comes nearer the mark than the height of its bar, which is 30% of the mark's height, on any side. In the lockup with the name the gap is a third of the mark's height (8px beside a 24px mark), and the name is the only thing allowed inside the clear space.

**Size.** In the lockup the mark is as tall as the name's type size: 24px beside the 24px name. Alone it is never under 16px tall: below that the cut between bar and stem closes. The 16px favicon is the one exception, because a browser asks for it.

**What not to do.** Do not stretch it or change its proportions. Do not recolour it outside the cases above. No outline, shadow, glow, gradient or rotation. Do not redraw it "cleaner": the trace is the mark. Do not set the name in another typeface beside it.

**The arrowhead is a motif, used sparingly.** It means forward and start. It stands on exactly one kind of control, the one that starts a timer (`TimerMark`, and the button on the timer in the anatomy figure), in place of a generic play triangle. It is never decoration: not a bullet, not a divider, not a background pattern, not a pointer on a link, not an arrow on the primary action.

**Where the files live.**

| File                                                                                                            | What it is                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `app/components/mark-paths.ts`                                                                                  | The three outlines. The one source of the mark's shape.                                                                                                            |
| `app/components/Mark.tsx`                                                                                       | The mark drawn in the page, following the scheme. With a `title` it is a named image; without one it is decoration beside a name.                                  |
| `app/components/Wordmark.tsx`                                                                                   | The lockup: mark and name. What the header and the footer of every page use, so the name is read once and the mark is not announced.                               |
| `public/mark.svg`                                                                                               | The mark alone, as a file.                                                                                                                                         |
| `public/favicon.svg`, `favicon.ico`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, `site.webmanifest` | The icons, drawn by `scripts/icons.ts`.                                                                                                                            |
| `public/social.png`                                                                                             | The picture a shared link is shown with: the mark, the name and the headline on the sheet, 1200 by 630, drawn by `scripts/social-image.ts` in the site's own type. |

Run `pnpm icons` after any change to the outlines, the seed or the typefaces, and commit what it writes.

**In what Timesifier sends** (TS-100). A message and a PDF cannot draw the outlines, so `pnpm icons` also writes the platform brand's built-in images, as PNGs at twice the size they are shown, into `app/brand/built-in-images.ts`: the logo (the mark in white and amber on the charcoal tile, 56 by 56, shown at 28) and the mark for a light ground and for a dark one (48 tall, shown 14px tall in a message and 9pt on a PDF). The platform console may replace each with a PNG of its own (`platform_brand`); until it does, these are what every message carries.

**Organisation first.** What an organisation sends its clients is its own: an invoice, an estimate, their PDFs, the estimate's page and the messages that carry them lead with the organisation's logo and name, on a band of its colour where it has one, and the product steps back to one line at the foot, the mark beside "Made with Timesifier", small. The organisation's colour is accepted only where white words read on it at 4.5 to 1 or more, since its action carries white words. Its logo stands in the band of every page of the product too, on a tile of paper beside the organisation's name, so any logo reads on the amber; the product's own lockup stays where it was.

## The mindset, on every screen

The owner's instruction: the mindset of Benji Taylor's essay ["Family Values"](https://benji.org/family-values) on every screen. Its three principles are simplicity, fluidity and delight: "Simplicity ensures accessibility, fluidity maintains continuity of experience, and delight fosters meaningful connections." Below is what each demands of this product, as rules a reviewer or a test can check. A rule with no screen yet is for the card that builds the screen.

### Simplicity

"The fundamentals would be at your fingertips, but everything else would appear as it became most relevant to you."

1. **One primary action in a view.** Exactly one filled button, or none. Everything else is outlined, text, or a link.
2. **What is not needed yet is not shown.** A control appears where and when it applies: editing in the row or in a sheet over the page ("trays overlay content directly onto the current interface"), never on a page of its own; no per-row menu until there are three things to put in it.
3. **A transient step keeps its context.** Confirming, warning and short forms open over the page they belong to and close back to it, with the focus returned to what opened them.
4. **No dead or needless link.** Every link leads to a page or a place that exists and says something, and no two navigations on a page repeat each other. `e2e/public-links.spec.ts` follows every link on the public pages.
5. **Plain words, true today.** A sentence says what the product does now, or says "will". "Nothing on the page is untrue", below.

| Screen              | The one primary action                                           | What stays out until it is needed                                     |
| ------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| Public pages        | "Start tracking", at the top and at the end, to the sign-in page | A second call to action, a pricing table, a newsletter field          |
| Sign in             | Continue: the address, then the code sent to it                  | A name on the way in; any other way to sign in; a page for new people |
| Today and the timer | Start, which becomes Stop: one control                           | Manual entry and editing, until asked for                             |
| Projects            | New project                                                      | Archiving, budgets and filters, until a project has them              |
| The week            | None: it is a reading page                                       | The entries behind a cell, until the cell is chosen                   |
| Reports             | Export what is on the page                                       | Any chart that is not the figures themselves                          |
| Settings            | The form being edited saves; deleting is never the filled button | Danger, until the person scrolls to it                                |

### Fluidity

"If a component occupies a space and will persist in the next phase of the user's journey, it should remain consistent." And: "We fly instead of teleport."

1. **The same thing is the same element.** What persists across a change of view is not removed and drawn again. Checked for: the band at the top (identical markup on every public page, so the browser paints it in the same place); a digit of a running time that has not changed (`Digits`: only a changed digit is replaced, and `e2e/components.spec.ts` proves it); the timer's control as it turns from stop to start (one button, which keeps the focus).
2. **Motion follows the person.** On the public pages what moves is tied to the scrolling by the browser (`animation-timeline`), so it runs forward and back with the hand and never plays on its own behind the reader's back. Two things run on time instead, because a number must never rest short of the truth: a digit's change, and the week's totals, which count up once to the sum and stop there.
3. **Only `transform` and `opacity` animate.** Nothing animates a size or a position in the layout, so nothing beside a moving thing moves. `e2e/landing.spec.ts` proves the page's layout is the same with and without script, and before and after its images arrive.
4. **Durations and easings are the motion tokens.** No number of milliseconds is written in a component.
5. **Reduced motion is honoured everywhere.** With it, the clock still tells the time and nothing slides, grows, counts or drifts: every element stands where it ends up. One test for the public pages and one for the shell.
6. **A time that changes is never read out as it changes.** A running time has the role `timer` and a label; nothing on a page is a live region that announces seconds.

In the signed-in product: moving between destinations is a view transition in which the navigation holds still (the shell does this today); starting the timer turns the ready bar into the running bar in place; stopping it turns the running bar into the newest row of the day, which is the same element moving, not a row appearing.

Between public pages there is no cross-document view transition. It was built and removed: in the browser's own test build the transition was refused on arrival and reported as an error on every navigation, and a page that logs an error for a flourish is worse than one that changes plainly.

### Delight

"Mastering delight is mastering selective emphasis." And: "Delight tends to increase as the frequency of feature usage decreases."

1. **What is done a hundred times a day stays quiet.** Starting, stopping and editing an entry get a state layer and the change of state, nothing more.
2. **What is rare may be marked.** The candidates in this product, each for its own card: the first entry a person ever records; a week closed with every day accounted for; an organisation created; an invitation accepted. One moment each, once, never a repeat.
3. **Delight is never the price of the task.** It does not delay the result, cover the control, need dismissing, or play sound. With reduced motion it is the plain state.
4. **On the public pages the delight is that the page works.** The example runs on the visitor's own clock: the timer counts their seconds from a believable start, the date is their today, the stop control stops it, and every total stays the sum of what is shown. A page about time that keeps time. Nothing else on the page performs.

| Screen              | Quiet                              | May be marked                                                              |
| ------------------- | ---------------------------------- | -------------------------------------------------------------------------- |
| Public pages        | Everything but the running example | The example itself, and the anatomy figure assembling as it is scrolled to |
| Sign in             | All of it                          | Nothing: a person signing in is on their way somewhere                     |
| Today and the timer | Start, stop, edit                  | The first entry ever                                                       |
| Projects            | All of it                          | Nothing                                                                    |
| The week            | Moving between weeks               | A week with every working day accounted for                                |
| Reports             | All of it                          | Nothing: a report is evidence                                              |
| Settings            | All of it                          | Nothing, and deleting least of all                                         |

## One way in

The public pages have one primary action and it opens `/sign-in`, which serves a person who is new and a person coming back alike. There is no "create an account", on any page or in any email, and no address that makes one: `/sign-up` is answered with the way to `/sign-in`. The band at the top carries one quiet "Sign in" to the same address.

The action reads **"Start tracking"** (`PRIMARY_ACTION` in `app/landing/Site.tsx`). It read "Get started" until the timer was built, because until then it promised more than the next page could do; it became "Start tracking" with TS-101, the timer having shipped with TS-012. Under each action one line says what opening it leads to.

**The sign-in page** (card TS-036) is the next page of the same product: the public pages' band, with nothing at its right because this page is the way in, their column and their foot. It has two views and each has one filled action.

| Where                                     | Words                                                                                                                      |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Title                                     | Sign in · Timesifier                                                                                                       |
| First view, heading                       | Enter your email                                                                                                           |
| First view, lead                          | We will email you a code. If you are new here, the same code sets you up.                                                  |
| Second view, heading                      | Check your email                                                                                                           |
| Second view, lead                         | Where to look, where the code works and for how long, and: "From this browser you can be sent at most five codes an hour." |
| The action, on both views                 | Continue                                                                                                                   |
| Under the second view's action, ruled off | Send a new code; Use a different email                                                                                     |
| The check failed                          | We could not confirm this browser. Wait a moment and press Continue again.                                                 |

The page asks an address and a code and nothing else: no name, which a person gives in Settings. It never says whether an address has an account, because the server does not. A code that was asked for is still there after a reload or a trip to the mailbox. One page for everybody means that signing in with the wrong one of two addresses makes a second, empty account, so the two pages such an account lands on (creating an organisation, and an invitation that is not this account's) say "Signed in as" with the address and offer "Use a different email".

From 840px a photograph stands in the columns beside the form: the station clock, which the home page uses too. Under 840px the page is the form alone. That choice is the builder's, not the owner's, and is the first thing to take out if the page should be quieter.

## Light is the product's face

The owner, on seeing both schemes on 2026-11-11: "the light mode is way better, it looks more beautiful." So a person who has chosen nothing gets the light scheme on every page, public and signed in, whatever their device prefers: the amber sheet on paper is what the product looks like, and a visitor's first sight of it is not left to a setting they made for other software. Dark stays, as a choice in Settings beside Light and "Match my device", and is held to the same contrast. How it is rendered is in `docs/design-system.md`, "Colour schemes".

## Nothing on the page is untrue

The owner: "we need to validate all what we are writing so it's not slop". On 11 November 2026 an independent reviewer checked all 93 claims on the three public pages against the code, the configuration, production and Cloudflare's documentation. 39 were not plainly true. What became of each is in the pull request of TS-030; the rules that came out of it are these.

1. **Tense.** What is built is said in the present tense, and only what is not built takes "will". Each sentence is held to the code that does it: the timer, timesheets and approvals, leave, expenses and invoices are built, so the home page, the terms and the notice say what they do now. A sentence about a feature that is not built names it as not built yet, or is left out. An audit of every sentence on the public pages, the sign-in page and the emails' footers, made on 12 November 2026 for TS-101, is in its pull request.
2. **Every drawing of example data says "Example"** (`EXAMPLE_NOTE`), and a test finds any time on the page that stands in a drawing without it.
3. **Where data lives is said exactly.** The database "runs and stores its data only inside the EU": a D1 jurisdiction, fixed when a database is created (the commands in `README.md`; [Cloudflare, D1 data location](https://developers.cloudflare.com/d1/configuration/data-location/): "Jurisdictions are used to create D1 databases that only run and store data within a region"). The same sentence is never left alone: a request reaches the data centre nearest the visitor, which may be outside the EU, and is passed to Frankfurt, where the Worker runs near the database ([Workers placement](https://developers.cloudflare.com/workers/configuration/placement/): "Placement Hints run your Worker in the data center with the lowest latency to your specified cloud region"; `placement` in `wrangler.jsonc`, `docs/decisions.md` 34); the files a page loads come from the nearest data centre (the same page: "Static assets are always served from the location nearest to the incoming request"); and Cloudflare's request logs, its record of each email, Turnstile and Web Analytics carry no EU restriction ([data localisation compatibility](https://developers.cloudflare.com/data-localization/compatibility/)). `test/claims.test.ts` fails if a page says the first without the second, if a database is ever created without the jurisdiction, or if a page says requests are handled in Frankfurt while `wrangler.jsonc` places the Worker elsewhere.
4. **Who can see what is said exactly.** "Closed to everyone outside your organisation", which `test/organisations/membership.test.ts` proves, and never "private". Inside an organisation the roles see what `app/organisations/access.ts` lets them: owners, admins and Finance everyone's time; a manager their own and their teams'; everyone else their own. The privacy notice's "Who sees what" names each role, and `test/claims.test.ts` holds those sentences to the functions they describe.
5. **The cookies in the notice are the cookies in the code.** `test/claims.test.ts` takes their names from the application and fails on a cookie the notice omits or invents, and on a wrong count.
6. **No new factual claim goes on a public page without its evidence** in the same pull request: a test, or a quoted source here or in `docs/security.md`.
7. **What is stored is the schema.** The privacy notice's "What is stored" is drawn from `app/db/personal-data.ts`, which puts every table of `app/db/schema.ts` under one of its rows; how long each is kept is what the code does (the foreign keys, and the daily job in `workers/scheduled.ts` that deletes activity records after `ACTIVITY_RETENTION_DAYS`), and where nothing deletes a thing the notice says it is kept until it is deleted. Receipts are in R2 with the `eu` jurisdiction ([Cloudflare, R2 data location](https://developers.cloudflare.com/r2/reference/data-location/): "Jurisdictional Restrictions guarantee objects in a bucket are stored within a specific jurisdiction"). Every email the product sends is named with whom it goes to. `test/claims.test.ts` fails on a table in no row, a retention or a number the page states that the code does not, an email sender the notice does not name, and a role it misstates.

Still open, and the owner's to close, because the repository cannot supply them: the legal name and address of whoever runs Timesifier (the notice says in so many words that it is incomplete without them, and `CONTROLLER` in `app/routes/privacy.tsx` is where they go); the legal basis for each use of data and the basis on which data reaches a United States company; and proof that `privacy@timesifier.com` is read.

## Anatomy figures

An anatomy figure explains how something in the product works by drawing it as a real object with labelled parts, in the manner of a technical drawing in a manual. The idea is taken from Anthropic's anatomy diagrams and redrawn in this product's own lines, type and three tones, so that it reads as part of the departure sheet.

**When to use one.** To explain a mechanism that a paragraph would have to ask the reader to imagine: what an entry is, how a week is added up, what a role may do, what deleting an organisation removes. Not to decorate a section, not for a list of features, and never more than one on a screen.

**What it must be.** A measuring instrument, not an illustration: every length, count and position in it is computed from data, and a test holds it to that data. In "The anatomy of a working day" a strip's length is its minutes, and the rider stands at the sum (`test/day-anatomy.test.ts`).

**How it is drawn.**

- **Grid and angles.** One shared view: the floor's two axes run down the page to the right and to the left at 2 across to 1 down (26.57°), uprights stay upright, and nothing is in perspective, so equal lengths stay equal wherever they are and the figure can be measured by eye. `app/anatomy/iso.ts` is the drawing board; it turns boxes and posts in a small world into path data.
- **Three tones, each a token.** `paper` for the bench and the machine, what holds the subject (`surface-bright` top, `surface-container-high` and `surface-dim` sides, `on-surface` lines). `ink` for the subject, what the figure is about (`on-surface` faces, `surface` lines). `lit` for the one thing that is live, wherever it appears (`primary-container`, `on-primary-fixed` lines). The arrowhead on a start control is the only other amber.
- **Stroke.** 1px for a line on a face and for a leader, 1.5px round a part, round joins, and the weight does not scale with the figure: a line is a ruled line at any size.
- **Labels.** A dot on the part, an upright leader, a number on an ink disc, and the part's name beside it in `title-medium`; a figure the label quotes is in `title-large`, tabular. Leaders from the back row rise and those from the front row drop, so the words stand in the empty corners and never on the drawing. **At most seven labels.** Under 840px the drawing carries numbers only.
- **Density.** Parts that belong to the mechanism, each standing on another part: a scale with its marks, a stop at the end of a rail, the posts of a cutter. No texture, no shading, no part that does nothing.

**How it is built.**

- An inline SVG component under `app/`, drawn with `Solid` and `Leader` from `app/anatomy/Figure.tsx`. Classes and tokens only: no `style` attribute, no `<style>`, no raster, nothing from another origin.
- It has an accessible name (`role="img"` and a label) and a text equivalent: a numbered list beside or under it with one sentence for each label, which is what the drawing is described by. The list is what a screen reader reads; the drawing's own text is measured for contrast by a test, because a scanner cannot.
- Whole and still without script and with reduced motion. Where it assembles, it does so in the order of its numbers, tied to the scrolling, by opacity only.
- If it shows example data it says "Example".

A drawing that must live outside the application, in a document, is generated by a script from the same drawing board with the token values written into the file: `scripts/architecture-figure.ts` draws `docs/architecture.svg`.

**Where the product could use one**, for the owner's own cards:

1. **Today, when it is empty.** The anatomy of an entry: a start, an end, a project, and the length between them, in place of an empty-state illustration.
2. **Members, beside the roles.** What an owner, an admin, Finance, a manager and a member can each see and change, drawn as who holds which key.
3. **Deleting an organisation.** What goes with it (everything in it: memberships, invitations, time, expenses and their receipts, invoices, the activity log) and what does not (each person's account), drawn before the person types the name.

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

## For the product screens

The owner wants everything after sign-in to follow the same convention as the home page. This section is that convention, written so that another engineer can restyle the signed-in shell and the pages that exist (the organisation chooser, creating an organisation, settings, members, the invitation page, the sign-in page) without asking. After it come references for the three screens that are not built yet (today, projects, the weekly report), which are the owner's to design; those are guidance, not designs.

### The convention

**The page frame.** One column, centred, at most 1200px wide, with 20px at the sides and 32px from 600px (`PAGE` in `app/landing/Site.tsx`: `mx-auto w-full max-w-300 px-5 medium:px-8`). From 840px the column is a grid of 12 with 32px gutters. Text that is read runs no wider than 640px (`max-w-160`); a form no wider than 480px (`max-w-120`). A page that is a list (members, projects) uses 8 of the 12 columns; a page that is a form uses 5; nothing is centred in the window but the frame itself.

**The band at the top.**

- _Public pages and the sign-in page:_ `SiteHeader` from `app/landing/Site.tsx`. The amber band, the lockup at the left in one colour (`<Wordmark tone="one" />`), one quiet outlined "Sign in" at the right; on the sign-in page itself, nothing at the right. It stays at the top of the window and gains a 2px ink rule once the page has moved 96px.
- _Signed in:_ the same amber band, `SiteHeader` itself: the owner chose it on 2026-11-11 ("copy that and replicate that theme and style everywhere"), over the paper band these notes first proposed. The lockup at the left in one colour, the organisation's name at the right in `title-medium`, and the same 2px ink rule once the page has moved 96px. Navigation is a column of text links beside the page from 600px and a bar of them along the bottom under it; the current destination is marked by a 2px ink rule beside or under its label and `aria-current`, not by a filled pill.

**Headings.** A page has one `h1`: `headline-large`, and `display-small` from 600px, in the condensed width, set tight. It says what the page is ("Members", "Wednesday 11 November"), never a greeting. A section's heading is `headline-medium` with a 2px ink rule above it and 40px of space above the rule. A heading inside a sheet is `label-large`. Nothing is in capitals, and no heading has an icon.

**A sheet of rows** is how any list with a figure at the end of each line is drawn: `Ledger` in `app/components/Ledger.tsx`, of which the day on the home page is the model.

- One 2px ink frame, 8px corners (`rounded-large`), paper inside. No shadow and no card inside a card.
- A heading line in `label-large`: what the sheet is at the left, one word at the right (a count, a state).
- Rows separated by a 1px rule in `outline-variant`, 12px above and below the text. A row is a title in `body-large`, at most one quieter line under it in `body-medium`, and one figure at the end in `title-large`, condensed and tabular. A short column before the title (an entry's times) is allowed where the sheet is at least 384px wide; under that it becomes a line of the row.
- At most one total, under the sheet's one 2px rule: its label in `label-large`, its figure in `title-large`. A total is always the sum of the rows above it, and a test holds it.
- A row's actions are at its end: one text button, or a menu once there are three. Never a row of icons.
- Members, pending invitations, the organisations to choose from, a day's entries and the projects are all this component.

**Totals and figures.** Any time or count a person might compare is tabular and condensed. A running time is `Digits` inside an element with the role `timer`; it is the largest thing on its page. A duration is hours and minutes (`1:05`), a running time adds seconds (`1:05:32`), a time of day is on the 24-hour clock (`09:15`), and a stretch of time is two of them joined by an en dash (`21:33–02:33`). A day is "Wednesday 11 November" and a period "9–15 November 2026", the same on every page and in every browser; each kind has one form, written by `app/time/format.ts` (`docs/design-system.md`, "Dates and times").

**Buttons.** One filled button in a view (`Button`, `variant="filled"`): ink on paper, amber on the dark board. It is 48px tall on a public page with 4px corners (`size="large"`, which the sign-in page uses; the home page's action is a link drawn the same), and the component's own 40px and 10px in the product; never a pill. The second action is `outlined`; the third is `text`. A destructive action is a `text` button in the error colour until the confirming step, where it is the filled one. A button's words say what it does ("Send the code", "Create the organisation"), not "Submit" or "Continue". The sign-in page is the one exception, by the owner's card (TS-036): both its views say "Continue", because a label that said what the code does ("Sign in", "Create account") would have to say which of the two a person is.

**Fields.** `TextField`, one to a line, the label above and always visible, the help under it, the error under that in the error colour and tied to the field. A form has one column, its fields no wider than 480px, 24px between fields, and its one filled button at the start of the line under the last field, not across the width. No placeholder stands in for a label.

**Empty states.** Inside the sheet where the rows will be: one sentence in `body-large` saying what will be here and what makes the first one, and the one action that makes it. No illustration, no icon in a circle, no "Nothing here yet!". Where how the thing works needs explaining, an anatomy figure may stand there instead ("Anatomy figures").

**The amber band, and where it is allowed.**

1. The top band, the hero and the closing band of a public page, and the top band of the sign-in page and of every signed-in page.
2. The one thing that is running: the running timer's row or bar, in `primary-container`, with its text in `on-primary-fixed`.
3. Today's column in the current week.
4. The arrowhead on a start control.

Nowhere else: not a selected navigation item, not a badge, not a highlight on a figure, not a hover. A screen with nothing running and no today on it has no amber on it at all, and that is correct.

**Spacing rhythm.** The 4px grid. Inside a sheet: 12px between a row's lines and its rules, 16px at its sides, 20px from 384px. Between a heading and what it heads: 16px. Between blocks in a section: 40px. Between sections: 64px, and 96px from 840px. A page ends with 96px of paper.

**Motion.** As in "The mindset, on every screen": the navigation holds still while the page changes; a row that is added arrives in its place and nothing else moves; only `transform` and `opacity`; the motion tokens; nothing with reduced motion.

**What is shared, and where it is.**

| Component                                 | For                                                                                                                                     |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `app/components/Wordmark.tsx`, `Mark.tsx` | The lockup and the mark, in every header and footer.                                                                                    |
| `app/components/Ledger.tsx`               | Every sheet of rows.                                                                                                                    |
| `app/components/Digits.tsx`               | Every time that changes while it is looked at.                                                                                          |
| `app/components/TimerMark.tsx`            | The start and stop mark of a timer, in a row or inside a button.                                                                        |
| `app/anatomy/`                            | The drawing board and the parts of an anatomy figure.                                                                                   |
| `app/landing/Site.tsx`                    | `SiteHeader`, `SiteFooter`, `PAGE` and `LINK`: the frame of a page nobody is signed in on. The sign-in page takes its header from here. |

All but the last are in the component gallery (`/design`) with their tests. What stays in `app/landing/` and is the home page's own: the example week, the running day, the photographs and the sections.

**The pages that exist, one line each.**

- _Sign in:_ the public band, then one column of 5: the `h1`, one field, one filled button, and under it one line of what happens next. The code step replaces the field in place; the heading stays the same element.
- _Choosing an organisation:_ an `h1` and one `Ledger` of organisations, the role as each row's figure, the row itself the link. "New organisation" is the outlined button above it.
- _Creating an organisation:_ a form of one field and one filled button.
- _Members:_ a `Ledger` of members (name, address, role) and a second of pending invitations (address, role, when it expires); "Invite" is the one filled button, above the first.
- _Settings:_ sections ruled off as on the privacy notice, the heading at the left from 840px and the form at the right; deletion last, under its own rule, with a `text` button in the error colour.
- _An invitation:_ one column of 5: who invites the person to what, as an `h1` and one sentence, then Join filled and Decline as text.

### Today and the timer

- [Toggl Track, timer running](https://mobbin.com/screens/f3f12f0a-4fed-4d07-aec9-bbc35a8f4c7f): the description, the project, the elapsed time and the stop control are one bar across the top of the page, and the strip of days under it gives each day its total.
- [Harvest, day view of the timesheet](https://mobbin.com/screens/faa70ee1-66ce-4ca0-a18e-972a631e4942): the heading is the day ("Today: Thursday 18 May"), one large control starts tracking, the week's seven days sit above the entries with their totals and the week's total, and a new entry chooses its project from a list grouped by client.
- [Harvest, timer settings](https://mobbin.com/screens/f3e9cb9d-1800-498a-b5cc-61515c8c9997): an entry is either a duration or a start and an end, time is shown as hours and minutes, and detailed views are never rounded.
- [Bonsai, starting time tracking](https://mobbin.com/flows/d421b6de-84fd-4668-8279-10eb9613a5cf): the three states in order, ready, running, logged.

**Structure.** One column. The timer is the first thing on the page and the only filled control; under it, the day's entries, newest first; under them, the day's total. The week strip is how a person moves between days. A list, not a calendar grid: the grid is Toggl's default and it hides the totals.

**Hierarchy.** The elapsed time is the largest thing on the page, in the condensed width. Then each entry's duration, right-aligned in one column. The note is body text; the project and the times are secondary. Only the running row is yellow.

**Density.** An entry is one row of two lines, 56 to 64px tall, ruled off from the next. Ten entries fit a laptop screen without scrolling. Editing happens in the row or in a sheet, never on another page.

### Projects

- [Toggl Track, projects](https://mobbin.com/screens/fb6b254e-8a0a-4ecf-9aba-e2c21e9d6400): a table of project, client, timeframe and time spent against the estimate as a thin bar with its figures ("19:42 of 160 h"), with filters as chips above it.
- [Harvest, projects](https://mobbin.com/screens/fae467a6-1c45-4a54-acad-989d7a8b286c): the same table grouped under each client's name, with budget, spent, a bar and what remains as a figure and a percentage.
- [Harvest, one project](https://mobbin.com/screens/f86b014a-8836-4eaa-94b7-ab4ac2cb718c): hours per week as bars, then four figures: total hours split into billable and not, and what is left of the budget.

**Structure.** A ruled table grouped by client, the client's name as a row of its own. One "New project" action above it. A project opens to its own page: its figures first, then its entries.

**Hierarchy.** The project's name, then the hours as a figure. The bar is support for the figure and never replaces it; it is ink on a pale track, as in the week report on the home page, and turns to the error colour only when a budget is passed.

**Density.** One line a project, 48px, with at most four columns on a wide window: name, client or team, hours, bar. On a phone the columns fold to the name, the hours and the bar. No avatars, no coloured dots for projects, no per-row menu until there are three things to put in it.

### Weekly report

- [Toggl Track, reports summary](https://mobbin.com/screens/6512caea-44a6-4120-af89-29a83eff45c0): the week is chosen at the top left ("This week · W20"), four totals follow, then hours by day as bars, then a table of projects with duration and share.
- [Harvest, detailed time report](https://mobbin.com/screens/f1c84f2b-a306-4a83-800b-b7dfa3ad73b9): one large total, then every entry as a ruled row with its hours right-aligned, and an export.

**Structure.** The week and its total at the top; the timetable of projects by days, as drawn on the home page; under it, the entries behind any cell a person chooses. Export is an action on the page, and what it exports is exactly what is on the page.

**Hierarchy.** The week's total is the largest figure, then the row totals, then the cells. Today's column is yellow in the current week and nothing is in any other.

**Density.** A row a project, a column a day, hours and minutes to the minute. No donut and no pie: a share is a second column of figures if it is wanted. Every total on the page is the sum of what is shown under it, and a test holds it so, as `test/landing-example.test.ts` does for the example.

## Email

A message from Timesifier is the same product as the page that sent the person to their inbox. Every message the application sends, the platform's own (the sign-in code, the invitation, a budget alert, a webhook switched off) and an organisation's to its clients (an invoice, a reminder, an estimate), is built by one frame, `compose` in `app/auth/email-frame.ts`; a new message uses it, so it cannot drift. The privacy notice names each, with whom it goes to. What a mail program can render decides the rest.

- **The band.** An 8px rule at the top in the brand's colour, the amber for the platform's messages and the organisation's colour for its own, with nothing on it; then the logo and the name, ink on paper, with a 2px ink rule under them: the home page's top band, settled. The platform's messages carry its logo, 28px, with the product's name in the condensed heavy face beside it; an organisation's carry its logo, at most 40px tall and 200 wide, named for the organisation, or its name in type where it has none.
- **One column** of paper, at most 560px, 20px at the sides. Tables only where mail programs need them for layout.
- **Type.** No web font loads in a mail program, so each stack names Sofia Sans first, for a reader who has it, then the system faces nearest to it: a condensed grotesque for the name and the heading, a humanist sans for the text.
- **The heading** says what the message is ("Your sign-in code", "You are invited to …"). Under it, at most two short paragraphs.
- **A figure**, where there is one, sits in the day sheet's frame: 2px ink, 8px corners, a label above, the figure in large tabular type with space between characters, so a code can be read aloud and copied in one press.
- **At most one action**, drawn as a filled button, square-cornered, its words saying what it does: ink for the platform's messages, the organisation's colour with white words for its own. The sign-in code has none, and no link of any kind.
- **The footer**, under a 1px rule: why the person got the message, and what to do if they did not ask for it; for the platform, its footer line and tagline, and for an organisation, the mark beside "Made with Timesifier".
- **Colours** are literal values, because a mail program knows no custom properties. They are written from the light scheme's roles by `pnpm tokens` into `app/styles/email-colours.ts`, the one file of raw colours `pnpm check:tokens` lets through besides the tokens, and a test holds them equal. Every cell that sets a colour of type also sets the ground it stands on, so a mail program that forces a dark scheme inverts the pair together and loses nothing.
- **Nothing is fetched**: no remote image, font, style sheet or tracking. Each image a message shows is attached to it, inline, a PNG or a JPEG, and named by its Content-ID (`cid:`), so a mail program shows it without asking anybody, and an opened message tells nobody (`docs/security.md`, "Email"). The only addresses in a message are its one action's link and, in mail to account holders, the link that stops that mail (TS-099). The plain-text part says everything the HTML part says, in the same order. `test/auth/email-frame.test.ts` holds all of this.

Screenshots of both messages at 390px and 600px, light and forced dark: `email-code-*.png` and `email-invitation-*.png` in the session's browser assets.

## Sketches of the signed-in product

Before a signed-in page is redrawn, it is drawn: one static sketch per pattern of "For the product screens", in this direction's type, the tokens' colours and line weights, generated by `scripts/signed-in-sketches.ts` into `docs/design/`. They are what the owner looks at first.

| Pattern                                       | Sketch                                                                  |
| --------------------------------------------- | ----------------------------------------------------------------------- |
| The shell at 1280px, Settings, light and dark | `docs/design/signed-in-shell-1280.svg`, `signed-in-shell-1280-dark.svg` |
| The shell at 390px                            | `docs/design/signed-in-shell-390.svg`                                   |
| A form page (creating an organisation)        | `docs/design/signed-in-form.svg`                                        |
| A list page (members)                         | `docs/design/signed-in-list.svg`                                        |
| A sheet over a page                           | `docs/design/signed-in-sheet.svg`                                       |
| An empty state                                | `docs/design/signed-in-empty.svg`                                       |
| An error state                                | `docs/design/signed-in-error.svg`                                       |

## What follows from this in the product

The shell, the sign-in page and every component take the same tokens, so they already have the type, the colours and the corners: a filled button in the application is the same ink-and-amber button as the one on the home page. The sign-in page follows the convention above since TS-036. What the signed-in pages do not have yet is that convention: the shell's surfaces are still laid out as a default Material application, its lists are not yet `Ledger`s, and its headers do not carry the lockup. Restyling them is the cards that follow this one; the signed-in product screens (today, projects, the week, reports) are the owner's to design and build.
