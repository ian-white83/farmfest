# Farm Fest site

A one-page, phone-first site for Farm Fest. People RSVP, claim jobs that earn points, or chip in money for any points they're short. It runs free on Netlify: a static page, one serverless function, and Netlify Blobs for storage. Nobody needs an account.

## What people see

- **Coming:** an RSVP with adults, kids, nights, diet and sponsor. Below it, a live headcount per night and a list of who's coming, each with a green, amber or red status dot.
- **Jobs:** jobs split into Before, During and After, each showing its points and open slots. Tap "I'll do it" to claim one, and "Share" to post it to WhatsApp. Anyone can use "+ Add a job"; a guest's job shows as "points pending" until an organiser approves it.
- **Chip in:** shows what you still owe, the treasurer's payment details and meal costs. You record a payment as either buy-in or a meal, and only buy-in counts toward points.
- **Organise:** unlocked with a code.
  - The organiser code lets you edit, approve or delete jobs and untick a claim that didn't get done. It also covers the event settings (name, dates, WhatsApp link, points rules), marking hosts, the CSV headcount and "Start a new event".
  - The treasurer code lets you edit the payment details and confirm payments as they arrive.

Each overnight adult needs 3 points, and each day-visit adult needs 2. A missing point costs $20. Hosts need nothing. Organisers can change all of these in the app.

## Deploy (about 10 minutes, free)

1. Put this folder in a GitHub repository.
2. On [Netlify](https://app.netlify.com), click **Add new site → Import an existing project → GitHub** and pick the repository. Leave the build settings as they are, because `netlify.toml` already sets them.
3. Go to **Site configuration → Environment variables** and add three variables:
   - `EVENT_CODE`: the code you post in WhatsApp, for example `FF27`. It isn't case sensitive.
   - `ADMIN_CODE`: the organiser code, which only Paul, Ian and captains should know.
   - `TREASURER_CODE`: the treasurer's code.
4. Click **Deploys → Trigger deploy**.
5. Open the site, enter the event code, then open **Organise** and unlock it with the organiser code. Set the dates and paste the WhatsApp group invite link.
6. Pin the link in the WhatsApp group. Adding `?code=FF27` to the end skips the code screen.

Optional: under **Domain management** you can rename the free address (for example `farmfest-capertee.netlify.app`) or add your own domain.

## Run it locally

```
npm install
npm test        # API tests
npm run dev     # http://localhost:8888, codes FF27 / ORG / CASH
```

## Files

- `public/`: the page (`index.html`, `app.js`, `style.css`), with no build step.
- `netlify/functions/api.mjs`: the API endpoint at `/api`.
- `lib/core.mjs`: the data model, the seeded jobs and every action.
- `lib/handler.mjs`: code checks, plus safe saving when two people tap at once.
- `test/`: tests and a local dev server.

## Notes

- Everything is stored as one JSON record in Netlify Blobs. Saves are conditional and retried, so two people claiming at once won't overwrite each other.
- The event code stops casual visitors, but it is shared, so don't treat it as strong security. Payment details can only be edited with the treasurer code, and anyone with the event code can read them.
- "Start a new event" clears RSVPs, claims and payments. It keeps the job list and the payment details.
